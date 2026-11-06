import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ServiceDefinition } from '../config/loader';

export interface ActiveGatewayService {
  name: string;
  originalPort: number;
  proxyPort: number;
  upstream: string;
}

export interface ActiveGateway {
  services: ActiveGatewayService[];
  stop: () => Promise<void>;
}

/**
 * Starts the Bantha Service Gateway as a host process (or container helper)
 * bound to the Docker gateway IP. Rewires service listener ports so the agent container
 * connects to the gateway, which filters and drops unauthorized endpoints before
 * forwarding allowed requests to the real upstream service.
 */
export async function startServiceGateway(
  services: ServiceDefinition[] | undefined,
  gatewayIp: string,
  dockerDir?: string
): Promise<ActiveGateway | undefined> {
  if (!services || services.length === 0) {
    return undefined;
  }

  const activeServices: ActiveGatewayService[] = [];
  const gatewayConfigs: any[] = [];

  // Find python gateway script path
  const gatewayScript = dockerDir
    ? path.join(dockerDir, 'gateway', 'gateway.py')
    : path.resolve(__dirname, '../../docker/gateway/gateway.py');

  if (!fs.existsSync(gatewayScript)) {
    return undefined;
  }

  // Allocate an ephemeral or offset proxy port for each service on gatewayIp
  let basePort = 18080;
  for (const s of services) {
    const origPort = s.listen_port;
    const proxyPort = basePort++;

    activeServices.push({
      name: s.name,
      originalPort: origPort,
      proxyPort,
      upstream: s.upstream
    });

    gatewayConfigs.push({
      name: s.name,
      listen_port: proxyPort,
      upstream: s.upstream,
      allowed_endpoints: s.allowed_endpoints || ['/v1/*', '/health'],
      blocked_endpoints: s.blocked_endpoints || ['/web/*', '/metrics', '/config', '/mcp', '/api/*'],
      block_action: s.block_action || 'drop',
      request_rules: s.request_rules,
      response_rules: s.response_rules
    });
  }

  const tmpConfig = path.join(os.tmpdir(), `bantha-gw-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpConfig, JSON.stringify(gatewayConfigs, null, 2), 'utf-8');

  const proc: ChildProcess = spawn('python3', [gatewayScript, tmpConfig], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Wait briefly for gateway to bind
  await new Promise<void>((resolve) => {
    let resolved = false;
    const onData = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, 400);
  });

  return {
    services: activeServices,
    stop: async () => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      try {
        if (fs.existsSync(tmpConfig)) {
          fs.unlinkSync(tmpConfig);
        }
      } catch {}
    }
  };
}
