import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import { ConfigLoader } from './config/loader';
import { ContainerBuilder } from './container/builder';
import { ContainerRunner } from './container/runner';
import { CompletionGenerator } from './completion/generator';

function checkStrataHealth(): Promise<{ running: boolean; model?: string; error?: string }> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8080/health', { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'ok') {
            resolve({ running: true, model: json.model });
            return;
          }
        } catch {}
        resolve({ running: res.statusCode === 200 });
      });
    });

    req.on('error', (err) => resolve({ running: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ running: false, error: 'Connection timed out' });
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
    const strataInfo = await checkStrataHealth();
    printStatus(config, strataInfo);
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

  // Check Strata inference health before starting agent
  const strataInfo = await checkStrataHealth();
  if (!strataInfo.running) {
    console.warn(`[WARN] Local Strata inference service is NOT reachable on 127.0.0.1:8080.`);
    console.warn(`       To start it, run: 'strata start'`);
  }

  // Run the agent inside the sandbox
  const runner = new ContainerRunner(config);
  const agentArgs = args.slice(1);
  const currentWorkdir = process.cwd();

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

function printStatus(config: any, strataInfo?: { running: boolean; model?: string; error?: string }) {
  console.log(`=== BANTHA SANDBOX STATUS ===`);
  console.log(`Config Directory:    ${config.configDir}`);
  console.log(`Container Image:     ${config.container.image}`);
  console.log(`Available Tuskens:   hermes, goose, pi, crush`);
  console.log(`Memory Limit:        ${config.container.runtime.memory_limit}`);
  console.log(`CPU Limit:           ${config.container.runtime.cpu_limit}`);
  console.log(`Network Mode:        ${config.network.mode} (Default: ${config.network.default_policy})`);
  console.log(`SNTP Blocked:        ${!config.network.sntp?.enabled}`);
  console.log(`DNS Filtering:       ${config.network.dns?.enabled ? 'ACTIVE' : 'DISABLED'}`);

  if (strataInfo) {
    if (strataInfo.running) {
      console.log(`Strata Service:      RUNNING (Model: ${strataInfo.model || 'loaded'}) on 127.0.0.1:8080`);
    } else {
      console.log(`Strata Service:      NOT REACHABLE (${strataInfo.error || 'stopped'})`);
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
