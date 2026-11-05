import { SecretsConfig } from '../secrets/broker';
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

export interface SharedHubSubdirsConfig {
  rules?: 'ro' | 'rw';
  mcp?: 'ro' | 'rw';
  skills?: 'ro' | 'rw';
}

export interface SharedHubConfig {
  enabled?: boolean;
  mode?: 'ro' | 'rw';
  subdirs?: SharedHubSubdirsConfig;
}

export interface SharedAgentStateConfig {
  enabled?: boolean;
  mode?: 'ro' | 'rw';
}

export interface FilesystemSharedConfig {
  hub?: SharedHubConfig;
  agent_state?: SharedAgentStateConfig;
}

export interface FilesystemConfig {
  version: string;
  mounts: {
    rules: (string | MountRuleObject)[];
    home?: {
      container_path?: string;
      mode?: 'ro' | 'rw';
    };
    shared?: FilesystemSharedConfig;
  };
}

export interface NetworkEgressRule {
  proto?: 'tcp' | 'udp';
  ips?: string[];
  ports?: number[];
  port?: number;
  domains?: string[];
}

export interface ServiceRule {
  endpoint: string;
  methods?: string[];
  json_validators?: {
    path: string;
    allowed_schemes?: string[];
    action?: 'reject' | 'strip';
    error_message?: string;
  }[];
  redact_keys?: string[];
  replacement?: Record<string, any>;
}

export interface ServiceDefinition {
  name: string;
  listen_port: number;
  upstream: string;
  preset?: 'strata' | 'ollama' | 'generic-openai' | 'raw-proxy' | string;
  allowed_endpoints?: string[];
  blocked_endpoints?: string[];
  block_action?: 'drop' | 'reject';
  request_rules?: ServiceRule[];
  response_rules?: ServiceRule[];
}

export interface NetworkConfig {
  version: string;
  mode: 'hermetic' | 'none' | 'host';
  default_policy: 'DROP' | 'ACCEPT';
  services?: ServiceDefinition[];
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

export type { SecretsConfig };

export interface LoadedSandboxConfig {
  configDir: string;
  container: ContainerConfig;
  filesystem: FilesystemConfig;
  network: NetworkConfig;
  environment: EnvironmentConfig;
  secrets: SecretsConfig;
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

    const secrets = this.loadYaml<SecretsConfig>(path.join(this.configDir, 'secrets.yaml'), this.getDefaultSecretsConfig());

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

    // Hardcode deny rules for ~/.bantha, and expanded ancestors
    const home = os.homedir();
    const sandboxDir = path.resolve(home, '.bantha');
    filesystemMatcher.addExplicitDeny(`!${sandboxDir}/**`);
    filesystemMatcher.addExplicitDeny(`!${sandboxDir}`);
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
      secrets,
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

    const sPath = path.join(targetDir, 'secrets.yaml');
    if (!fs.existsSync(sPath)) {
      fs.writeFileSync(sPath, this.getYamlSecretsDefault());
    }

    const ePath = path.join(targetDir, 'environment.yaml');
    if (!fs.existsSync(ePath)) {
      fs.writeFileSync(ePath, this.getYamlEnvironmentDefault());
    }
  }

  public getDefaultSecretsConfig(): SecretsConfig {
    return {
      version: '1.0',
      secrets: [
        {
          name: 'anthropic',
          env: 'ANTHROPIC_API_KEY',
          upstream: 'https://api.anthropic.com',
          inject: { header: 'x-api-key' },
          container_env: { ANTHROPIC_API_KEY: '{token}', ANTHROPIC_BASE_URL: '{proxy}' }
        },
        {
          name: 'openai',
          env: 'OPENAI_API_KEY',
          upstream: 'https://api.openai.com',
          inject: { header: 'Authorization', prefix: 'Bearer ' },
          container_env: { OPENAI_API_KEY: '{token}', OPENAI_BASE_URL: '{proxy}/v1' }
        }
      ]
    };
  }

  private getYamlSecretsDefault(): string {
    return `# secrets.yaml - Host-side secret brokering
# Real keys stay on the host. The container receives a random per-session token and a
# base URL pointing at a host proxy that injects the real key for the matching upstream.
version: "1.0"
secrets:
  - name: anthropic
    env: ANTHROPIC_API_KEY          # host env var (or use: file: /path/to/key)
    upstream: https://api.anthropic.com
    inject: { header: x-api-key }
    container_env:
      ANTHROPIC_API_KEY: "{token}"
      ANTHROPIC_BASE_URL: "{proxy}"
  - name: openai
    env: OPENAI_API_KEY
    upstream: https://api.openai.com
    inject: { header: Authorization, prefix: "Bearer " }
    container_env:
      OPENAI_API_KEY: "{token}"
      OPENAI_BASE_URL: "{proxy}/v1"
`;
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
        },
        shared: {
          hub: {
            enabled: true,
            mode: 'rw',
            subdirs: {
              rules: 'rw',
              mcp: 'rw',
              skills: 'rw'
            }
          },
          agent_state: {
            enabled: true,
            mode: 'rw'
          }
        }
      }
    };
  }

  public getDefaultNetworkConfig(): NetworkConfig {
    return {
      version: '1.0',
      mode: 'hermetic',
      default_policy: 'DROP',
      services: [
        {
          name: 'strata',
          listen_port: 8080,
          upstream: 'http://172.17.0.1:8080',
          allowed_endpoints: [
            '/v1/*',
            '/health'
          ],
          blocked_endpoints: [
            '/web/*',
            '/metrics',
            '/config',
            '/mcp'
          ],
          block_action: 'drop'
        }
      ],
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
image: "bantha:latest"
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
# ~/.bantha and all ancestors (~, /home) are hardcoded blacklisted.
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
  # Shared data access control: configure visibility and permissions (rw, ro, or disabled)
  shared:
    hub:
      enabled: true
      mode: "rw"
      subdirs:
        rules: "rw"
        mcp: "rw"
        skills: "rw"
    agent_state:
      enabled: true
      mode: "rw"
`;
  }

  private getYamlNetworkDefault(): string {
    return `# network.yaml - Hermetic Ingress/Egress, DNS, and SNTP Controls
version: "1.0"
mode: "hermetic"
default_policy: "DROP"

# Services proxy definition and endpoint access controls
services:
  - name: "strata"
    listen_port: 8080
    upstream: "http://172.17.0.1:8080"
    allowed_endpoints:
      - "/v1/*"
      - "/health"
    blocked_endpoints:
      - "/web/*"
      - "/metrics"
      - "/config"
      - "/mcp"
    block_action: "drop" # 'drop' (silent drop/hangup) or 'reject' (403 error response)

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
