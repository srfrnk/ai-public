import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse } from 'yaml';
import { PatternMatcher } from './pattern-matcher';
import { PathValidator } from './validator';

export interface ContainerConfig {
  version: string;
  image: string;
  runtime: {
    memory_limit: string;
    cpu_limit: number;
    run_as_user: boolean;
    workdir: string;
    cap_add: string[];
    security_opts: string[];
  };
}

export interface MountRuleObject {
  path: string;
  container_path?: string;
  mode?: 'ro' | 'rw';
}

export interface FilesystemConfig {
  version: string;
  mounts: {
    rules: (string | MountRuleObject)[];
    home?: {
      container_path?: string;
      mode?: 'ro' | 'rw';
    };
  };
}

export interface NetworkEgressRule {
  proto?: 'tcp' | 'udp';
  ips?: string[];
  ports?: number[];
  port?: number;
  domains?: string[];
}

export interface NetworkConfig {
  version: string;
  mode: 'hermetic' | 'none' | 'host';
  default_policy: 'DROP' | 'ACCEPT';
  dns: {
    enabled: boolean;
    upstream_servers: string[];
    block_plain_udp_dns: boolean;
    rules: string[];
  };
  sntp: {
    enabled: boolean;
    rules: string[];
  };
  egress: {
    rules: (string | NetworkEgressRule)[];
  };
  ingress: {
    rules: (string | any)[];
  };
}

export interface EnvironmentConfig {
  version: string;
  rules: string[];
}

export interface LoadedSandboxConfig {
  configDir: string;
  container: ContainerConfig;
  filesystem: FilesystemConfig;
  network: NetworkConfig;
  environment: EnvironmentConfig;
  filesystemMatcher: PatternMatcher;
  dnsMatcher: PatternMatcher;
  envMatcher: PatternMatcher;
  validator: PathValidator;
}

export class ConfigLoader {
  private configDir: string;
  private validator: PathValidator;

  constructor(customConfigDir?: string, sourceRepoDir?: string) {
    const home = os.homedir();
    this.configDir = customConfigDir ? path.resolve(customConfigDir) : path.join(home, '.bantha');
    this.validator = new PathValidator(sourceRepoDir);
  }

  public getConfigDir(): string {
    return this.configDir;
  }

  public loadAll(): LoadedSandboxConfig {
    if (!fs.existsSync(this.configDir)) {
      this.createDefaultConfigs(this.configDir);
    }

    const container = this.loadYaml<ContainerConfig>(path.join(this.configDir, 'container.yaml'), this.getDefaultContainerConfig());
    const filesystem = this.loadYaml<FilesystemConfig>(path.join(this.configDir, 'filesystem.yaml'), this.getDefaultFilesystemConfig());
    const network = this.loadYaml<NetworkConfig>(path.join(this.configDir, 'network.yaml'), this.getDefaultNetworkConfig());
    const environment = this.loadYaml<EnvironmentConfig>(path.join(this.configDir, 'environment.yaml'), this.getDefaultEnvironmentConfig());

    // Initialize pattern matchers
    const fsRuleStrings: string[] = [];
    for (const rule of filesystem.mounts.rules || []) {
      if (typeof rule === 'string') {
        fsRuleStrings.push(rule);
      } else if (rule && rule.path) {
        fsRuleStrings.push(rule.path);
      }
    }
    const filesystemMatcher = new PatternMatcher(fsRuleStrings);

    // Hardcode deny rules for ~/.bantha, legacy ~/.agent-sandbox and expanded ancestors
    const home = os.homedir();
    const sandboxDir = path.resolve(home, '.bantha');
    const legacyDir = path.resolve(home, '.agent-sandbox');
    filesystemMatcher.addExplicitDeny(`!${sandboxDir}/**`);
    filesystemMatcher.addExplicitDeny(`!${sandboxDir}`);
    filesystemMatcher.addExplicitDeny(`!${legacyDir}/**`);
    filesystemMatcher.addExplicitDeny(`!${legacyDir}`);
    filesystemMatcher.addExplicitDeny(`!${home}/.config/bantha/**`);
    filesystemMatcher.addExplicitDeny(`!${home}/.config/bantha`);

    const dnsMatcher = new PatternMatcher(network.dns?.rules || []);
    const envMatcher = new PatternMatcher(environment.rules || []);

    return {
      configDir: this.configDir,
      container,
      filesystem,
      network,
      environment,
      filesystemMatcher,
      dnsMatcher,
      envMatcher,
      validator: this.validator
    };
  }

  private loadYaml<T>(filePath: string, fallback: T): T {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return parse(content) as T;
      }
    } catch (err: any) {
      console.warn(`[WARN] Failed to load ${filePath}: ${err?.message}. Using default.`);
    }
    return fallback;
  }

  public createDefaultConfigs(targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });

    // Initialize data/shared and data/agents directories
    const sharedDir = path.join(targetDir, 'data', 'shared');
    fs.mkdirSync(path.join(sharedDir, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(sharedDir, 'mcp'), { recursive: true });
    fs.mkdirSync(path.join(sharedDir, 'rules'), { recursive: true });

    const agentsDir = path.join(targetDir, 'data', 'agents');
    for (const ag of ['pi', 'goose', 'crush', 'hermes']) {
      fs.mkdirSync(path.join(agentsDir, ag), { recursive: true });
    }

    const defaultRules = path.join(sharedDir, 'rules', 'AGENTS.md');
    if (!fs.existsSync(defaultRules)) {
      fs.writeFileSync(defaultRules, '# Shared Agent Rules\n# Add universal instructions and workflows here.\n');
    }

    const defaultMcp = path.join(sharedDir, 'mcp', 'servers.json');
    if (!fs.existsSync(defaultMcp)) {
      fs.writeFileSync(defaultMcp, JSON.stringify({ mcpServers: {} }, null, 2));
    }

    const cPath = path.join(targetDir, 'container.yaml');
    if (!fs.existsSync(cPath)) {
      fs.writeFileSync(cPath, this.getYamlContainerDefault());
    }

    const fPath = path.join(targetDir, 'filesystem.yaml');
    if (!fs.existsSync(fPath)) {
      fs.writeFileSync(fPath, this.getYamlFilesystemDefault());
    }

    const nPath = path.join(targetDir, 'network.yaml');
    if (!fs.existsSync(nPath)) {
      fs.writeFileSync(nPath, this.getYamlNetworkDefault());
    }

    const ePath = path.join(targetDir, 'environment.yaml');
    if (!fs.existsSync(ePath)) {
      fs.writeFileSync(ePath, this.getYamlEnvironmentDefault());
    }
  }

  public getDefaultContainerConfig(): ContainerConfig {
    return {
      version: '1.0',
      image: 'bantha:latest',
      runtime: {
        memory_limit: '16g',
        cpu_limit: 8.0,
        run_as_user: true,
        workdir: 'auto',
        cap_add: ['NET_ADMIN'],
        security_opts: ['no-new-privileges:true']
      }
    };
  }

  public getDefaultFilesystemConfig(): FilesystemConfig {
    return {
      version: '1.0',
      mounts: {
        rules: [
          '!regex:^.*\\.pem$',
          '!regex:^.*\\.key$',
          '!**/.git/config',
          '!**/private-*'
        ],
        home: {
          container_path: '/home/sandbox',
          mode: 'rw'
        }
      }
    };
  }

  public getDefaultNetworkConfig(): NetworkConfig {
    return {
      version: '1.0',
      mode: 'hermetic',
      default_policy: 'DROP',
      dns: {
        enabled: true,
        upstream_servers: ['1.1.1.1', '8.8.8.8'],
        block_plain_udp_dns: true,
        rules: [
          'api.anthropic.com',
          'api.openai.com',
          '*.huggingface.co',
          'registry.npmjs.org',
          'pypi.org',
          'files.pythonhosted.org',
          '!*.internal.corp',
          '!regex:^.*telemetry.*$'
        ]
      },
      sntp: {
        enabled: false,
        rules: ['!*']
      },
      egress: {
        rules: [
          {
            proto: 'tcp',
            ips: ['127.0.0.1', '172.17.0.1'],
            ports: [8080, 11434]
          },
          {
            proto: 'tcp',
            port: 443,
            domains: ['api.anthropic.com', 'api.openai.com', '*.huggingface.co']
          },
          '!proto:tcp ports:[22, 23, 25, 3389]',
          '!ips:[\'10.0.0.0/8\', \'192.168.0.0/16\']'
        ]
      },
      ingress: {
        rules: ['!*']
      }
    };
  }

  public getDefaultEnvironmentConfig(): EnvironmentConfig {
    return {
      version: '1.0',
      rules: [
        'TERM',
        'COLORTERM',
        'LANG',
        'LC_ALL',
        'ANTHROPIC_*',
        'OPENAI_*',
        'HF_TOKEN',
        '!AWS_*',
        '!*_SECRET*',
        '!ANTIGRAVITY_*'
      ]
    };
  }

  private getYamlContainerDefault(): string {
    return `# container.yaml - Container Runtime Configuration
version: "1.0"
image: "agent-sandbox:latest"
runtime:
  memory_limit: "16g"    # Default: 16 GB RAM
  cpu_limit: 8.0          # Default: 8 CPU cores
  run_as_user: true       # Run with host UID:GID
  workdir: "auto"         # Mounts and sets current working directory if allowed
  cap_add:
    - "NET_ADMIN"         # For container iptables / netfilter
  security_opts:
    - "no-new-privileges:true"
`;
  }

  private getYamlFilesystemDefault(): string {
    return `# filesystem.yaml - Filesystem Access Rules (Gitignore-style syntax)
# Leading '!' denotes a blacklist / deny rule with strict precedence.
# ~/.agent-sandbox and all ancestors (~, /home) are hardcoded blacklisted.
version: "1.0"

mounts:
  rules:
    - "!regex:^.*\\\\.pem$"
    - "!regex:^.*\\\\.key$"
    - "!**/.git/config"
    - "!**/private-*"
  home:
    container_path: "/home/sandbox"
    mode: "rw"
`;
  }

  private getYamlNetworkDefault(): string {
    return `# network.yaml - Hermetic Ingress/Egress, DNS, and SNTP Controls
version: "1.0"
mode: "hermetic"
default_policy: "DROP"

dns:
  enabled: true
  upstream_servers:
    - "1.1.1.1"
    - "8.8.8.8"
  block_plain_udp_dns: true
  rules:
    - "api.anthropic.com"
    - "api.openai.com"
    - "*.huggingface.co"
    - "registry.npmjs.org"
    - "pypi.org"
    - "files.pythonhosted.org"
    - "!*.internal.corp"
    - "!regex:^.*telemetry.*$"

sntp:
  enabled: false
  rules:
    - "!*"

egress:
  rules:
    - proto: "tcp"
      ips: ["127.0.0.1", "172.17.0.1"]
      ports: [8080, 11434]
    - proto: "tcp"
      port: 443
      domains:
        - "api.anthropic.com"
        - "api.openai.com"
        - "*.huggingface.co"
    - "!proto:tcp ports:[22, 23, 25, 3389]"
    - "!ips:['10.0.0.0/8', '192.168.0.0/16']"

ingress:
  rules:
    - "!*"
`;
  }

  private getYamlEnvironmentDefault(): string {
    return `# environment.yaml - Environment Variable Whitelist / Blacklist
version: "1.0"
rules:
  - "TERM"
  - "COLORTERM"
  - "LANG"
  - "LC_ALL"
  - "ANTHROPIC_*"
  - "OPENAI_*"
  - "HF_TOKEN"
  - "!AWS_*"
  - "!*_SECRET*"
  - "!ANTIGRAVITY_*"
`;
  }
}
