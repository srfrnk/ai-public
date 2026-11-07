import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { ConfigLoader } from './config/loader';
import { ContainerBuilder } from './container/builder';
import { ContainerRunner } from './container/runner';
import { CompletionGenerator } from './completion/generator';

import * as readline from 'readline';
import { activeSecretRules } from './secrets/broker';

function askApproval(skipPrompt: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (skipPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
      resolve(true);
      return;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('\x1b[33mPress [Enter] to approve and start the agent (or Ctrl+C to abort)...\x1b[0m', () => {
      rl.close();
      console.log();
      resolve(true);
    });
  });
}

function checkInferenceHealth(config: any): Promise<{ running: boolean; model?: string; error?: string; endpoint?: string }> {
  return new Promise((resolve) => {
    const infConfig = config.container?.inference || {};
    const baseUrl = infConfig.base_url || 'http://127.0.0.1:8080/v1';
    let healthUrl: string;
    try {
      const parsed = new URL(baseUrl);
      // Only health-check local loopback endpoints (remote cloud endpoints like api.anthropic.com don't have /health)
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '172.17.0.1') {
        resolve({ running: true, endpoint: baseUrl });
        return;
      }
      healthUrl = `${parsed.protocol}//${parsed.host}/health`;
    } catch {
      resolve({ running: true, endpoint: baseUrl });
      return;
    }

    const req = http.get(healthUrl, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'ok') {
            resolve({ running: true, model: json.model, endpoint: healthUrl });
            return;
          }
        } catch {}
        resolve({ running: res.statusCode === 200, endpoint: healthUrl });
      });
    });

    req.on('error', (err) => resolve({ running: false, error: err.message, endpoint: healthUrl }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, error: 'Connection timed out', endpoint: healthUrl });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Resolve directories
  const home = os.homedir();
  const sandboxDir = path.join(home, '.bantha');
  const sourceRepoDir = path.resolve(__dirname, '..');
  const dockerContextDir = path.join(sourceRepoDir, 'docker');

  // Handle help
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  // Handle shell completion
  if (command === 'completion') {
    const shell = args[1] || 'bash';
    if (shell === 'bash') {
      console.log(CompletionGenerator.getBashCompletion());
    } else if (shell === 'zsh') {
      console.log(CompletionGenerator.getZshCompletion());
    } else if (shell === 'fish') {
      console.log(CompletionGenerator.getFishCompletion());
    } else {
      console.error(`Unsupported shell: ${shell}. Supported: bash, zsh, fish`);
      process.exit(1);
    }
    process.exit(0);
  }

  // Load configuration
  const loader = new ConfigLoader(sandboxDir, sourceRepoDir);
  const config = loader.loadAll();

  // Handle status
  if (command === 'status') {
    const infInfo = await checkInferenceHealth(config);
    printStatus(config, infInfo);
    process.exit(0);
  }

  // Handle inspect / dry-run
  if (command === 'inspect') {
    const currentWorkdir = process.cwd();
    printExposureSummary(currentWorkdir, config);
    process.exit(0);
  }

  // Handle tuskens list
  if (command === 'tuskens') {
    printTuskens();
    process.exit(0);
  }

  // Builder instance
  const builder = new ContainerBuilder(dockerContextDir, config.container.image || 'bantha:latest');

  // Handle build
  if (command === 'build') {
    const force = args.includes('--force');
    builder.ensureImage(force);
    process.exit(0);
  }

  // Supported agent commands (tuskens)
  const knownAgents = ['pi', 'goose', 'crush', 'hermes'];
  if (!knownAgents.includes(command)) {
    console.error(`Unknown tusken or command: "${command}". Available tuskens: ${knownAgents.join(', ')}`);
    console.error(`Run "bantha help" or "bantha tuskens" for full usage information.`);
    process.exit(1);
  }

  // Ensure image exists automatically
  builder.ensureImage(false);

  // Check inference health before starting agent
  const infInfo = await checkInferenceHealth(config);
  if (!infInfo.running) {
    console.warn(`[WARN] Configured local inference service is NOT reachable at ${infInfo.endpoint || '127.0.0.1:8080'}.`);
  }

  // Run the agent inside the sandbox
  const runner = new ContainerRunner(config, dockerContextDir);
  const agentArgs = args.slice(1);
  const currentWorkdir = process.cwd();

  // Print exposure summary banner before launching
  printExposureSummary(currentWorkdir, config);

  // Require user approval before starting agent container
  // Everything after tusken name belongs to the agent
  await askApproval(false);

  try {
    const exitCode = await runner.run(command, agentArgs, currentWorkdir);
    process.exit(exitCode);
  } catch (err: any) {
    console.error(`\n[AGENT RUNNER ERROR] ${err?.message || err}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
bantha - Heavy Carrier Runner for AI Agents in an Isolated Sandbox

The Bantha is the resilient beast of burden navigating the harsh digital sands,
carrying nomadic AI agents (Tuskens: pi, goose, crush, hermes) in a securely
isolated, hermetic environment.

USAGE:
  bantha <tusken> [args...]       Launch a tusken (hermes, goose, pi, crush) inside the sandbox
  bantha inspect                 Display the exact resource exposure summary for the current directory
  bantha tuskens                 List available tuskens and their status
  bantha build [--force]         Build or force-rebuild the sandbox Docker image
  bantha status                  Display active configurations and isolation policies
  bantha completion [shell]      Output shell auto-completion script (bash, zsh, fish)
  bantha help                    Show this help message

TUSKENS (AGENTS):
  hermes     Hermes autonomous agent (memory, skills, reasoning)
  goose      Goose developer agent (recipes, coding, tool use)
  pi         Pi coding assistant (fast, read/write/edit/bash)
  crush      Crush developer agent

CONFIGURATION:
  Configs reside in ~/.bantha/
    - container.yaml    Container runtime, memory (16g), CPU (8.0), security
    - filesystem.yaml   VFS mounts, whitelist/blacklist rules, tmpfs masks
    - network.yaml      Hermetic drop-all policy, DNS proxy, SNTP block, egress/ingress
    - environment.yaml  Environment variable whitelist/blacklist
    - data/             Persistent storage:
        shared/         Common skills, MCP servers, and rules across all tuskens
        agents/         Per-tusken private state (sessions, memory DBs)

DOCS:
  See docs/CLI_REFERENCE.md and docs/config/ for full reference.
`);
}

function printTuskens() {
  console.log(`
AVAILABLE TUSKENS (AGENTS):
  hermes     Autonomous agent with reasoning, memory graph, and skills
  goose      Open-source developer agent with recipe & extension support
  pi         Lightweight coding agent with tools for read, bash, edit, write
  crush      CLI coding agent

Usage: bantha <tusken> [options/prompts...]
Example: bantha hermes chat -q "Hello"
`);
}

function printExposureSummary(workdir: string, config: any) {
  const allowedEnv: string[] = [];
  let blockedEnvCount = 0;
  const brokered = activeSecretRules(config.secrets);
  const withheld = new Set<string>(brokered.map(r => r.env).filter((e): e is string => !!e));
  for (const k of Object.keys(process.env)) {
    if (k === 'HOME' || k === 'PATH' || k.startsWith('AGENT_')) continue;
    if (withheld.has(k)) {
      blockedEnvCount++;
    } else if (config.envMatcher.test(k).allowed) {
      allowedEnv.push(k);
    } else {
      blockedEnvCount++;
    }
  }

  // Extract explicit network egress allowances
  const egressList: string[] = [];
  for (const r of config.network.egress?.rules || []) {
    if (typeof r === 'object') {
      const proto = (r.proto || 'tcp').toUpperCase();
      if (r.ips && (r.ports || r.port)) {
        const ports = r.ports ? r.ports.join(', ') : r.port;
        egressList.push(`${r.ips.join(', ')} (Port ${ports} ${proto})`);
      } else if (r.domains && (r.ports || r.port)) {
        const ports = r.ports ? r.ports.join(', ') : r.port;
        egressList.push(`${r.domains.join(', ')} (Port ${ports} ${proto})`);
      }
    }
  }

  // Extract explicit network ingress allowances
  const ingressList: string[] = [];
  for (const r of config.network.ingress?.rules || []) {
    if (typeof r === 'object') {
      const proto = (r.proto || 'tcp').toUpperCase();
      if (r.ips && (r.ports || r.port)) {
        const ports = r.ports ? r.ports.join(', ') : r.port;
        ingressList.push(`From ${r.ips.join(', ')} -> Port ${ports} ${proto}`);
      } else if (r.ports || r.port) {
        const ports = r.ports ? r.ports.join(', ') : r.port;
        ingressList.push(`Port ${ports} ${proto}`);
      }
    }
  }

  const dnsRules = (config.network.dns?.rules || [])
    .filter((r: string) => !r.startsWith('!'));

  console.log(`\x1b[36mSecurity & Resource Agent Exposure Report:\x1b[0m`);
  
  // Filesystems
  console.log(`  ├─ Filesystem Mappings:`);
  console.log(`  │   ├─ Workspace:     ${workdir} -> /workspace (rw)`);
  console.log(`  │   └─ Shared Hub:    ~/.bantha/data/shared -> ~/.shared (rw)`);

  // Proxied Gateway Services
  const services = config.network.services || [];
  console.log(`  ├─ Proxied Gateway Services (${services.length}):`);
  if (services.length > 0) {
    services.forEach((s: any, idx: number) => {
      const isLast = idx === services.length - 1;
      const branch = isLast ? '└─' : '├─';
      const pipe = isLast ? ' ' : '│';
      console.log(`  │   ${branch} ${s.name} (Port ${s.listen_port} -> ${s.upstream}):`);
      const allowed = s.allowed_endpoints && s.allowed_endpoints.length > 0 ? s.allowed_endpoints.join(', ') : 'all';
      const blocked = s.blocked_endpoints && s.blocked_endpoints.length > 0 ? s.blocked_endpoints.join(', ') : 'none';
      const action = s.block_action || 'drop';
      console.log(`  │   ${pipe}   ├─ Allowed: ${allowed}`);
      console.log(`  │   ${pipe}   ├─ Blocked: ${blocked}`);
      console.log(`  │   ${pipe}   └─ Action:  ${action}`);
    });
  } else {
    console.log(`  │   └─ none`);
  }

  // Configured Inference Exposure (Presented to Agent vs Protected)
  const inf = config.container.inference || {};
  const infProvider = inf.provider_name || 'default';
  const infModel = inf.model_name || 'default';
  const infEndpoint = inf.base_url || 'http://172.17.0.1:8080/v1 (local default)';
  const infCtx = inf.context_window || 131072;
  console.log(`  ├─ Inference Service Exposure (Anonymized to Agent):`);
  console.log(`  │   ├─ Exposed Provider: ${infProvider}`);
  console.log(`  │   ├─ Exposed Model:    ${infModel}`);
  console.log(`  │   ├─ Target Endpoint:  ${infEndpoint}`);
  console.log(`  │   └─ Context Window:   ${infCtx}`);

  // Brokered secrets (real keys stay on the host)
  console.log(`  ├─ Brokered Secrets (${brokered.length}, real keys never enter the container):`);
  if (brokered.length > 0) {
    brokered.forEach((r, idx) => {
      const branch = idx === brokered.length - 1 ? '└─' : '├─';
      console.log(`  │   ${branch} ${r.name}: ${Object.keys(r.container_env || {}).join(', ') || '(no container env)'} -> ${r.upstream}`);
    });
  } else {
    console.log(`  │   └─ none`);
  }

  // Allowed Host Env
  console.log(`  ├─ Allowed Host Env (${allowedEnv.length} allowed, ${blockedEnvCount} blocked):`);
  if (allowedEnv.length > 0) {
    // Print in rows of up to 4 variables
    const chunkSize = 4;
    for (let i = 0; i < allowedEnv.length; i += chunkSize) {
      const chunk = allowedEnv.slice(i, i + chunkSize);
      const isLast = i + chunkSize >= allowedEnv.length;
      const branch = isLast ? '└─' : '├─';
      console.log(`  │   ${branch} ${chunk.join(', ')}`);
    }
  } else {
    console.log(`  │   └─ none`);
  }

  // Network Egress
  console.log(`  ├─ Allowed Network Egress:`);
  if (egressList.length > 0) {
    egressList.forEach((e: string, idx: number) => {
      const isLast = idx === egressList.length - 1;
      const branch = isLast ? '└─' : '├─';
      console.log(`  │   ${branch} ${e}`);
    });
  } else {
    console.log(`  │   └─ none (Drop all outbound traffic)`);
  }

  // Network Ingress
  console.log(`  ├─ Allowed Network Ingress:`);
  if (ingressList.length > 0) {
    ingressList.forEach((ing: string, idx: number) => {
      const isLast = idx === ingressList.length - 1;
      const branch = isLast ? '└─' : '├─';
      console.log(`  │   ${branch} ${ing}`);
    });
  } else {
    console.log(`  │   └─ none (Drop all inbound traffic)`);
  }

  // Whitelisted DNS
  console.log(`  └─ Whitelisted DNS (Mode: ${config.network.mode}):`);
  if (dnsRules.length > 0) {
    const chunkSize = 3;
    for (let i = 0; i < dnsRules.length; i += chunkSize) {
      const chunk = dnsRules.slice(i, i + chunkSize);
      const isLast = i + chunkSize >= dnsRules.length;
      const branch = isLast ? '└─' : '├─';
      console.log(`      ${branch} ${chunk.join(', ')}`);
    }
  } else {
    console.log(`      └─ none (All DNS queries blocked)`);
  }
  console.log();
}

function printStatus(config: any, infInfo?: { running: boolean; model?: string; error?: string; endpoint?: string }) {
  console.log(`=== BANTHA SANDBOX STATUS ===`);
  console.log(`Config Directory:    ${config.configDir}`);
  console.log(`Container Image:     ${config.container.image}`);
  console.log(`Available Tuskens:   hermes, goose, pi, crush`);
  console.log(`Memory Limit:        ${config.container.runtime.memory_limit}`);
  console.log(`CPU Limit:           ${config.container.runtime.cpu_limit}`);
  console.log(`Network Mode:        ${config.network.mode} (Default: ${config.network.default_policy})`);
  console.log(`SNTP Blocked:        ${!config.network.sntp?.enabled}`);
  console.log(`DNS Filtering:       ${config.network.dns?.enabled ? 'ACTIVE' : 'DISABLED'}`);

  if (infInfo) {
    if (infInfo.running) {
      console.log(`Inference Service:   RUNNING (Model: ${infInfo.model || 'loaded'}) at ${infInfo.endpoint || '127.0.0.1:8080'}`);
    } else {
      console.log(`Inference Service:   NOT REACHABLE (${infInfo.error || 'stopped'}) at ${infInfo.endpoint || '127.0.0.1:8080'}`);
    }
  }
  console.log(`\nProtected Directories (Never mounted):`);
  for (const dir of config.validator.getProtectedDirectories().slice(0, 5)) {
    console.log(`  - ${dir}`);
  }
  console.log(`  ... and all ancestor directories`);
}

main().catch(err => {
  console.error(`Fatal: ${err?.message || err}`);
  process.exit(1);
});
