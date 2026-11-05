import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { URL } from 'url';

export interface SecretRule {
  name: string;
  /** Host environment variable holding the real secret. */
  env?: string;
  /** Alternatively, a host file whose trimmed contents are the secret. */
  file?: string;
  /** Upstream base URL requests are forwarded to (e.g. https://api.anthropic.com). */
  upstream: string;
  inject: { header: string; prefix?: string };
  /** Env vars set inside the container. Placeholders: {token}, {proxy}. */
  container_env?: Record<string, string>;
}

export interface SecretsConfig {
  version: string;
  secrets: SecretRule[];
}

export interface ActiveBroker {
  host: string;
  port: number;
  token: string;
  /** Env vars to set in the container (placeholders already resolved). */
  containerEnv: Record<string, string>;
  /** Host env var names whose real values must NOT be forwarded. */
  withheldHostEnv: string[];
  stop(): Promise<void>;
}

const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'api-key'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];

/** Secret rules whose real value is currently available on the host. */
export function activeSecretRules(config: SecretsConfig | undefined): SecretRule[] {
  return (config?.secrets || []).filter(r => r?.name && r.upstream && r.inject?.header && readSecret(r));
}

function readSecret(rule: SecretRule): string | undefined {
  try {
    if (rule.env && process.env[rule.env]) return process.env[rule.env];
    if (rule.file && fs.existsSync(rule.file)) return fs.readFileSync(rule.file, 'utf-8').trim() || undefined;
  } catch {}
  return undefined;
}

function tokenOk(provided: string | undefined, token: string): boolean {
  if (!provided) return false;
  const v = provided.replace(/^Bearer\s+/i, '');
  const a = Buffer.from(v);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Starts a host-side reverse proxy bound to the Docker gateway address. The container only
 * ever sees a random per-session token; the proxy verifies it, strips client credentials,
 * injects the real secret for the matching upstream and streams the response back.
 * Returns undefined if no configured secret is available on the host.
 */
export async function startBroker(config: SecretsConfig | undefined, bindHost: string): Promise<ActiveBroker | undefined> {
  const active = new Map<string, { rule: SecretRule; secret: string; upstream: URL }>();
  for (const rule of config?.secrets || []) {
    if (!rule?.name || !/^[a-z0-9_-]+$/i.test(rule.name) || !rule.upstream || !rule.inject?.header) continue;
    const secret = readSecret(rule);
    if (!secret) continue;
    const upstream = new URL(rule.upstream);
    if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') continue;
    active.set(rule.name, { rule, secret, upstream });
  }
  if (active.size === 0) return undefined;

  const token = 'bantha-' + crypto.randomBytes(24).toString('hex');

  const server = http.createServer((req, res) => {
    const fail = (code: number, msg: string) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(msg + '\n');
    };
    const provided = AUTH_HEADERS.map(h => req.headers[h]).find(v => typeof v === 'string') as string | undefined;
    if (!tokenOk(provided, token)) return fail(401, 'bantha broker: invalid session token');

    const m = /^\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url || '');
    const entry = m && active.get(m[1]);
    if (!m || !entry) return fail(404, 'bantha broker: unknown secret route');

    const { rule, secret, upstream } = entry;
    const basePath = upstream.pathname.replace(/\/$/, '');
    const target = new URL(basePath + (m[2] || '/') + (m[3] || ''), upstream.origin);

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.includes(key) || AUTH_HEADERS.includes(key) || key === rule.inject.header.toLowerCase()) continue;
      headers[key] = v;
    }
    headers['host'] = target.host;
    headers[rule.inject.header.toLowerCase()] = (rule.inject.prefix || '') + secret;

    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(target, { method: req.method, headers }, upRes => {
      const outHeaders = { ...upRes.headers };
      delete outHeaders['transfer-encoding'];
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    });
    up.on('error', () => fail(502, 'bantha broker: upstream request failed'));
    res.on('close', () => up.destroy());
    req.pipe(up);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => resolve());
  });
  const port = (server.address() as import('net').AddressInfo).port;

  const containerEnv: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [name, { rule }] of active) {
    if (rule.env) withheld.push(rule.env);
    const proxyUrl = `http://${bindHost}:${port}/${name}`;
    for (const [k, v] of Object.entries(rule.container_env || {})) {
      containerEnv[k] = v.split('{token}').join(token).split('{proxy}').join(proxyUrl);
    }
  }

  return {
    host: bindHost,
    port,
    token,
    containerEnv,
    withheldHostEnv: withheld,
    stop: () => new Promise<void>(r => { server.close(() => r()); (server as any).closeAllConnections?.(); })
  };
}
