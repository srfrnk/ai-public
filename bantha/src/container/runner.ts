import { spawn, SpawnOptions, execSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { LoadedSandboxConfig } from '../config/loader';
import { MountPlanner, PlannedMount } from './mounts';
import { startBroker, ActiveBroker } from '../secrets/broker';
import { NetworkRulesCompiler, CompiledNetworkPlan } from '../network/rules-compiler';

export class ContainerRunner {
  private config: LoadedSandboxConfig;
  private mountPlanner: MountPlanner;
  private netCompiler: NetworkRulesCompiler;

  constructor(config: LoadedSandboxConfig) {
    this.config = config;
    this.mountPlanner = new MountPlanner(config);
    this.netCompiler = new NetworkRulesCompiler(config);
  }

  private getDockerGatewayIp(): string {
    try {
      const out = execSync("docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'", {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out)) {
        return out;
      }
    } catch {}
    return '172.17.0.1';
  }

  private syncHostToVolume(hostDir: string, volumeName: string): void {
    if (!fs.existsSync(hostDir)) {
      fs.mkdirSync(hostDir, { recursive: true });
    }
    try {
      execSync(`docker volume inspect ${volumeName}`, { stdio: 'ignore' });
    } catch {
      execSync(`docker volume create ${volumeName}`, { stdio: 'ignore' });
    }
    try {
      // Pipe tar from host directory into container volume mount
      execSync(`tar -C "${hostDir}" -cf - . | docker run --rm -i -v "${volumeName}:/dest" ${this.config.container.image || 'bantha:latest'} tar -C /dest -xf -`, {
        stdio: ['pipe', 'ignore', 'ignore']
      });
    } catch (err: any) {
      // Non-fatal if empty directory
    }
  }

  private syncVolumeToHost(volumeName: string, hostDir: string): void {
    if (!fs.existsSync(hostDir)) {
      fs.mkdirSync(hostDir, { recursive: true });
    }
    try {
      execSync(`docker run --rm -v "${volumeName}:/src" ${this.config.container.image || 'bantha:latest'} tar -C /src -cf - . | tar -C "${hostDir}" -xf -`, {
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err: any) {
      // Non-fatal
    }
  }

  public async run(agent: string, agentArgs: string[], currentHostWorkdir: string): Promise<number> {
    const gatewayIp = this.getDockerGatewayIp();
    let broker: ActiveBroker | undefined;
    try {
      broker = await startBroker(this.config.secrets, gatewayIp);
    } catch (err: any) {
      throw new Error(`Failed to start secret broker on ${gatewayIp}: ${err?.message || err}`);
    }
    try {
      return await this.runContainer(agent, agentArgs, currentHostWorkdir, gatewayIp, broker);
    } finally {
      await broker?.stop();
    }
  }

  private runContainer(agent: string, agentArgs: string[], currentHostWorkdir: string, gatewayIp: string, broker?: ActiveBroker): Promise<number> {
    return new Promise((resolve, reject) => {
      // 1. Plan Mounts & Workdir
      const { mounts, containerWorkdir } = this.mountPlanner.planMounts(currentHostWorkdir, agent);

      // 2. Compile Network rules
      const netPlan = this.netCompiler.compile();

      // Allow the container to reach the host secret broker
      if (broker) {
        netPlan.egressRules.push({ proto: 'tcp', ips: [broker.host], ports: [broker.port] });
      }

      // Ensure Gateway IP on port 8080 (Strata) is in egress rules
      if (!netPlan.egressRules.some(r => r.ips && r.ips.includes(gatewayIp) && r.ports && r.ports.includes(8080))) {
        netPlan.egressRules.push({
          proto: 'tcp',
          ips: [gatewayIp],
          ports: [8080]
        });
      }

      const netPlanJson = JSON.stringify(netPlan);

      // 3. Assemble Docker Arguments
      const dockerArgs: string[] = ['run', '--rm', '--init'];

      // Interactive terminal if attached
      if (process.stdin.isTTY && process.stdout.isTTY) {
        dockerArgs.push('-it');
      } else {
        dockerArgs.push('-i');
      }

      // Memory and CPU constraints
      if (this.config.container.runtime.memory_limit) {
        dockerArgs.push(`--memory=${this.config.container.runtime.memory_limit}`);
      }
      if (this.config.container.runtime.cpu_limit) {
        dockerArgs.push(`--cpus=${this.config.container.runtime.cpu_limit}`);
      }

      // Linux capabilities (NET_ADMIN is required for netfilter rules inside container)
      // Drop everything first, then add back only what the entrypoint needs
      // (user setup, chown, gosu) plus any configured capabilities.
      dockerArgs.push('--cap-drop=ALL');
      const entrypointCaps = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];
      const caps = new Set([...entrypointCaps, ...(this.config.container.runtime.cap_add || [])]);
      for (const cap of caps) {
        dockerArgs.push(`--cap-add=${cap}`);
      }

      // Security options
      if (this.config.container.runtime.security_opts) {
        for (const opt of this.config.container.runtime.security_opts) {
          dockerArgs.push(`--security-opt=${opt}`);
        }
      }

      // User ID & GID mapping
      if (this.config.container.runtime.run_as_user) {
        const uid = process.getuid ? process.getuid() : 1000;
        const gid = process.getgid ? process.getgid() : 1000;
        if (uid === 0) {
          throw new Error('Refusing to run as root: the agent would keep NET_ADMIN and could flush the firewall. Run bantha as a non-root user.');
        }
        dockerArgs.push('-e', `HOST_UID=${uid}`, '-e', `HOST_GID=${gid}`);
      }

      // Workdir
      dockerArgs.push('-w', containerWorkdir);

      // Pass Strata Gateway & inference details
      dockerArgs.push('-e', `STRATA_GATEWAY_IP=${gatewayIp}`);
      dockerArgs.push('-e', 'STRATA_PORT=8080');
      dockerArgs.push('-e', 'STRATA_MODEL=qwen3.8-flash-next-coder-iq1_m');
      dockerArgs.push('-e', 'STRATA_CONTEXT_WINDOW=131072');
      dockerArgs.push('-e', 'STRATA_MAX_TOKENS=4096');

      // Pass Network Plan via ENV
      dockerArgs.push('-e', `AGENT_NET_PLAN=${netPlanJson}`);
      dockerArgs.push('-e', `TARGET_AGENT=${agent}`);

      // Pass Allowed Host Environment Variables
      const allowedEnvNames = this.injectAllowedEnvironment(dockerArgs, broker?.withheldHostEnv || []);
      // Brokered credentials (placeholder token + proxy URL); passed after forwarded env so they win
      if (broker) {
        for (const [k, v] of Object.entries(broker.containerEnv)) {
          dockerArgs.push('-e', `${k}=${v}`);
          if (!allowedEnvNames.includes(k)) allowedEnvNames.push(k);
        }
      }

      // Sync host persistent hubs into isolated Docker volumes prior to execution
      for (const m of mounts) {
        if (m.type === 'volume' && m.volumeName && m.hostSyncDir) {
          this.syncHostToVolume(m.hostSyncDir, m.volumeName);
        }
      }

      // Generate and pass Positive-Only Sandbox Awareness Resources Payload
      const awarenessPayload = this.buildAwarenessPayload(mounts, netPlan, allowedEnvNames);
      dockerArgs.push('-e', `AGENT_RESOURCES_PAYLOAD=${Buffer.from(JSON.stringify(awarenessPayload)).toString('base64')}`);
      dockerArgs.push('-e', 'SANDBOX=1');
      dockerArgs.push('-e', 'AGENT_SANDBOX=1');

      // Mounts
      for (const m of mounts) {
        if (m.type === 'bind' && m.source) {
          dockerArgs.push('-v', `${m.source}:${m.destination}:${m.mode}`);
        } else if (m.type === 'volume' && m.volumeName) {
          dockerArgs.push('-v', `${m.volumeName}:${m.destination}:${m.mode}`);
        } else if (m.type === 'tmpfs') {
          dockerArgs.push('--mount', `type=tmpfs,destination=${m.destination},readonly`);
        }
      }

      // Network isolation mode
      if (netPlan.mode === 'none') {
        dockerArgs.push('--network=none');
      }

      // Image
      dockerArgs.push(this.config.container.image || 'bantha:latest');

      // Command & arguments to agent inside container
      dockerArgs.push(agent, ...agentArgs);

      // 4. Spawn Docker process
      const child = spawn('docker', dockerArgs, {
        stdio: 'inherit'
      });

      const forwardSignal = (signal: NodeJS.Signals) => {
        if (!child.killed) {
          child.kill(signal);
        }
      };

      process.on('SIGINT', forwardSignal);
      process.on('SIGTERM', forwardSignal);
      process.on('SIGHUP', forwardSignal);

      child.on('error', err => {
        process.off('SIGINT', forwardSignal);
        process.off('SIGTERM', forwardSignal);
        process.off('SIGHUP', forwardSignal);
        reject(err);
      });

      child.on('close', code => {
        process.off('SIGINT', forwardSignal);
        process.off('SIGTERM', forwardSignal);
        process.off('SIGHUP', forwardSignal);

        // Sync volume updates back to host directories for git tracking
        for (const m of mounts) {
          if (m.type === 'volume' && m.volumeName && m.hostSyncDir && m.mode === 'rw') {
            this.syncVolumeToHost(m.volumeName, m.hostSyncDir);
          }
        }

        resolve(code ?? 0);
      });
    });
  }

  private injectAllowedEnvironment(dockerArgs: string[], withheld: string[] = []): string[] {
    const envRules = this.config.envMatcher;
    const allowedNames: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
      // Real secrets handled by the broker never enter the container
      if (withheld.includes(key)) continue;
      // Do not pass internal tokens or protected host paths
      if (key === 'HOME' || key === 'PATH' || key.startsWith('AGENT_')) continue;

      const testRes = envRules.test(key);
      if (testRes.allowed) {
        dockerArgs.push('-e', `${key}=${value}`);
        allowedNames.push(key);
      }
    }
    return allowedNames;
  }

  private virtualizeHostSource(source: string, destination: string): string {
    if (destination === '/workspace' || destination.startsWith('/workspace/')) {
      return '<workspace>';
    }
    if (destination === '/home/sandbox/.shared' || source.includes('/.bantha/data/shared')) {
      return '~/.bantha/shared';
    }
    if (destination.startsWith('/home/sandbox/.agent-state') || source.includes('/.bantha/data/agents/')) {
      return '~/.bantha/agent-state';
    }
    // Generic fallback: sanitize username in home paths
    return source.replace(/^\/home\/[^/]+/, '~');
  }

  private buildAwarenessPayload(
    mounts: PlannedMount[],
    netPlan: CompiledNetworkPlan,
    allowedEnvNames: string[]
  ): {
    json: any;
    markdown: string;
  } {
    // 1. Filesystem Mappings (positive allowances only, virtualized host labels)
    const fsMappings: { host_path: string; host_label: string; path: string; access: string }[] = [];
    for (const m of mounts) {
      if (m.type === 'bind' && m.source) {
        fsMappings.push({
          host_path: m.source,
          host_label: this.virtualizeHostSource(m.source, m.destination),
          path: m.destination,
          access: m.mode === 'rw' ? 'read-write' : 'read-only'
        });
      } else if (m.type === 'volume' && m.volumeName) {
        fsMappings.push({
          host_path: m.hostSyncDir || m.volumeName,
          host_label: this.virtualizeHostSource(m.hostSyncDir || m.volumeName, m.destination),
          path: m.destination,
          access: m.mode === 'rw' ? 'read-write' : 'read-only'
        });
      }
    }

    // 2. Network Destinations (positive allowances only)
    const netDests: any[] = [];
    if (netPlan.dns?.allowedDomains?.length) {
      for (const d of netPlan.dns.allowedDomains) {
        netDests.push({ destination: d, port: 443, proto: 'tcp' });
      }
    }
    for (const eg of netPlan.egressRules) {
      if (eg.ips && eg.ports) {
        for (const ip of eg.ips) {
          netDests.push({ destination: ip, ports: eg.ports, proto: eg.proto });
        }
      }
    }

    const payloadJson = {
      filesystem_mappings: fsMappings.map(f => ({
        resource: f.host_label,
        path: f.path,
        access: f.access
      })),
      home: '/home/sandbox',
      network_destinations: netDests,
      environment_variables: allowedEnvNames
    };

    // 3. Build Markdown
    let md = `# Bantha Sandbox Resource & Security Notice\n\n`;
    md += `> **NOTICE FOR USER & AGENT:** This document lists the exact resources, filesystems, network endpoints, and environment variables exposed to the agent inside this sandbox session.\n\n`;
    md += `## 1. Filesystem Mappings:\n`;
    md += `| Host Resource | Accessible Path in Your Environment | Permissions | Notes |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;
    for (const f of fsMappings) {
      const note = f.host_label === '<workspace>' ? 'Current project workspace' : 'Shared persistence hub';
      md += `| \`${f.host_label}\` | \`${f.path}\` | ${f.access === 'read-write' ? 'Read-Write' : 'Read-Only'} | ${note} |\n`;
    }
    md += `\n- Your Home Directory: \`/home/sandbox\`\n\n`;

    md += `## 2. Network Destinations:\n`;
    md += `### External Network Destinations:\n`;
    if (netDests.length > 0) {
      for (const nd of netDests) {
        if (nd.port) {
          md += `- \`${nd.destination}\` (Port ${nd.port} ${nd.proto.toUpperCase()})\n`;
        } else if (nd.ports) {
          md += `- \`${nd.destination}\` (Ports: ${nd.ports.join(', ')} ${nd.proto.toUpperCase()})\n`;
        }
      }
    } else {
      md += `- None (No outbound network destinations available)\n`;
    }

    md += `\n## 3. Environment Variables Exposed to Agent:\n`;
    if (allowedEnvNames.length > 0) {
      md += `The following host environment variables were passed into the sandbox:\n`;
      md += `- ${allowedEnvNames.map(e => `\`${e}\``).join(', ')}\n`;
    } else {
      md += `- None (No host environment variables were passed into the sandbox)\n`;
    }

    return {
      json: payloadJson,
      markdown: md
    };
  }
}
