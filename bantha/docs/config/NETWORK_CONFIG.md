# Network Configuration: `network.yaml`

The `network.yaml` file defines the network isolation mode, the default firewall policy, DNS domain-filtering rules, SNTP (UDP 123) blocking, and explicit egress/ingress rules.

---

## 1. File Location
```
~/.bantha/network.yaml
```

---

## 2. Full Schema & Default Values

```yaml
version: "1.0"

# Isolation Mode:
# 'hermetic'  - Linux netfilter (iptables) enforced with whitelist/blacklist (Recommended)
# 'none'      - Complete disconnection; loopback only (offline mode)
# 'host'      - Unrestricted host networking
mode: "hermetic"

# Default firewall policy for all outbound and inbound packets
default_policy: "DROP"

# Services reverse proxy with endpoint access controls and connection dropping
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
    block_action: "drop" # 'drop' (silent socket hangup) or 'reject' (403 error)

# DNS filtering configuration
dns:
  enabled: true
  upstream_servers:
    - "1.1.1.1"
    - "8.8.8.8"
  # When true, raw uninspected UDP/TCP port 53 traffic to the internet is DROPPED by iptables
  block_plain_udp_dns: true
  rules:
    # Allowed domains (globs and regex supported)
    - "api.anthropic.com"
    - "api.openai.com"
    - "*.huggingface.co"
    - "registry.npmjs.org"
    - "pypi.org"
    - "files.pythonhosted.org"
    # Blacklisted domains (takes strict precedence)
    - "!*.internal.corp"
    - "!regex:^.*telemetry.*$"

# SNTP / NTP time sync controls (common exfiltration vector)
sntp:
  enabled: false # If false, all outbound UDP 123 packets are DROPPED
  rules:
    - "!*"

# Egress rules (outbound connections)
egress:
  rules:
    # Allow local connections (e.g., Strata on 8080, Ollama on 11434)
    - proto: "tcp"
      ips: ["127.0.0.1", "172.17.0.1"]
      ports: [8080, 11434]
    # Allow outbound HTTPS to whitelisted domains
    - proto: "tcp"
      port: 443
      domains:
        - "api.anthropic.com"
        - "api.openai.com"
        - "*.huggingface.co"
    # Explicitly blacklisted ports and networks
    - "!proto:tcp ports:[22, 23, 25, 3389]"
    - "!ips:['10.0.0.0/8', '192.168.0.0/16']"

# Ingress rules (inbound connections)
ingress:
  rules:
    - "!*" # Drop all incoming connections by default
```

---

## 3. Kernel Netfilter Enforcement

- Outbound packets are matched against Netfilter `OUTPUT` table rules inside the container network namespace.
- **Default Drop**: Packets not matching an explicit `ACCEPT` rule are immediately dropped at the Linux kernel level.
- **SNTP Blocking**: A dedicated rule `iptables -A OUTPUT -p udp --dport 123 -j DROP` guarantees that time synchronization packets cannot be sent or used for covert exfiltration.
- **DNS Gate**: Port 53 queries are redirected to the container-local DNS gate proxy (`127.0.0.1:5300`). Queries for whitelisted domains are forwarded to `upstream_servers`; queries for unlisted or blacklisted domains return `NXDOMAIN`.
