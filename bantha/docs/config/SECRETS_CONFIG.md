# Secret Brokering: `secrets.yaml`

Real API keys never enter the container. For each configured secret that is set on the host, Bantha starts a reverse proxy bound to the Docker gateway address for the duration of the session. The container receives a random per-session token plus a base URL pointing at the proxy. The proxy checks the token, strips client credentials, injects the real key for the matching upstream and streams the response back.

## File Location
```
~/.bantha/secrets.yaml
```

## Schema
```yaml
version: "1.0"
secrets:
  - name: anthropic                 # route name: /<name>/... on the proxy
    env: ANTHROPIC_API_KEY          # host env var holding the real key (or `file: /path`)
    upstream: https://api.anthropic.com
    inject: { header: x-api-key }   # optional `prefix`, e.g. "Bearer "
    container_env:                  # env set inside the container
      ANTHROPIC_API_KEY: "{token}"  # {token} = per-session token
      ANTHROPIC_BASE_URL: "{proxy}" # {proxy} = http://<gateway>:<port>/<name>
```
Defaults for `anthropic` and `openai` are built in.

## Behavior
- A secret is active only if its `env`/`file` resolves on the host. Otherwise nothing changes for it.
- Host variables named by an active secret's `env` are **never** forwarded, regardless of `environment.yaml`.
- The proxy only forwards to the configured `upstream`, so it is not an open relay. Requests without the session token get `401`.
- The proxy port on the gateway IP is added to the container's egress allowlist automatically.

## Limits
- The agent must honor a base-URL setting (most SDKs do). Agents that hardcode the provider host will not work with that provider.
- The agent can still *use* the key through the proxy during the session, but it can't read or exfiltrate it.
- Plain HTTP between the container and the host proxy (on the local bridge).
