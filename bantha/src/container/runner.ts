import { spawn, SpawnOptions, execSync } from 'child_process';
import * as os from 'os';
import { LoadedSandboxConfig } from '../config/loader';
import { MountPlanner, PlannedMount } from './mounts';
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

  public run(agent: string, agentArgs: string[], currentHostWorkdir: string): Promise<number> {
    return new Promise((resolve, reject) => {
      // 1. Plan Mounts & Workdir
      const { mounts, containerWorkdir } = this.mountPlanner.planMounts(currentHostWorkdir, agent);

      // 2. Compile Network rules
      const netPlan = this.netCompiler.compile();
      const gatewayIp = this.getDockerGatewayIp();

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
      if (this.config.container.runtime.cap_add) {
        for (const cap of this.config.container.runtime.cap_add) {
          dockerArgs.push(`--cap-add=${cap}`);
        }
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
      const allowedEnvNames = this.injectAllowedEnvironment(dockerArgs);

      // Generate and pass Positive-Only Sandbox Awareness Resources Payload
      const awarenessPayload = this.buildAwarenessPayload(mounts, netPlan, allowedEnvNames);
      dockerArgs.push('-e', `AGENT_RESOURCES_PAYLOAD=${Buffer.from(JSON.stringify(awarenessPayload)).toString('base64')}`);
      dockerArgs.push('-e', 'SANDBOX=1');
      dockerArgs.push('-e', 'AGENT_SANDBOX=1');

      // Mounts
      for (const m of mounts) {
        if (m.type === 'bind' && m.source) {
          dockerArgs.push('-v', `${m.source}:${m.destination}:${m.mode}`);
        } else if (m.type === 'tmpfs') {
          dockerArgs.push('--mount', `type=tmpfs,destination=${m.destination},readonly`);
        }
      }

      // Network isolation mode
      if (netPlan.mode === 'none') {
        dockerArgs.push('--network=none');
      }

      // Image
      dockerArgs.push(this.config.container.image || 'agent-sandbox:latest');

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
        resolve(code ?? 0);
      });
    });
  }

  private injectAllowedEnvironment(dockerArgs: string[]): string[] {
    const envRules = this.config.envMatcher;
    const allowedNames: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (!value) continue;
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

  private buildAwarenessPayload(
    mounts: PlannedMount[],
    netPlan: CompiledNetworkPlan,
    allowedEnvNames: string[]
  ): {
    json: any;
    markdown: string;
  } {
    // 1. Filesystem Mappings (positive allowances only, no mention of masks or blocks)
    const fsMappings: { host_path: string; path: string; access: string }[] = [];
    for (const m of mounts) {
      if (m.type === 'bind' && m.source) {
        fsMappings.push({
          host_path: m.source,
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
      filesystem_mappings: fsMappings,
      home: '/home/sandbox',
      network_destinations: netDests,
      environment_variables: allowedEnvNames
    };

    // 3. Build Markdown
    let md = `# Available Resources for This Session\n\n`;
    md += `## Available Filesystem Mappings:\n`;
    md += `| Host Resource | Accessible Path in Your Environment | Permissions |\n`;
    md += `| :--- | :--- | :--- |\n`;
    for (const f of fsMappings) {
      md += `| \`${f.host_path}\` | \`${f.path}\` | ${f.access === 'read-write' ? 'Read-Write' : 'Read-Only'} |\n`;
    }
    md += `\n- Your Home Directory: \`/home/sandbox\`\n\n`;

    md += `## Available Network Destinations:\n`;
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

    md += `\n## Available Environment Variables:\n`;
    if (allowedEnvNames.length > 0) {
      md += `- ${allowedEnvNames.map(e => `\`${e}\``).join(', ')}\n`;
    } else {
      md += `- None\n`;
    }

    return {
      json: payloadJson,
      markdown: md
    };
  }
}
