#!/bin/bash
set -e

# ==============================================================================
# Agent Sandbox Container Entrypoint
# Applies Linux kernel netfilter (iptables) rules and starts the DNS filtering gate.
# Sets up non-root host user matching UID/GID, then executes target agent.
# ==============================================================================

# Parse configuration JSON passed via AGENT_NET_PLAN
NET_PLAN="${AGENT_NET_PLAN:-}"

if [ -n "$NET_PLAN" ]; then
    # 1. Flush existing iptables
    iptables -F
    iptables -X
    iptables -t nat -F
    iptables -t nat -X

    # 2. Extract Mode
    MODE=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('mode', 'hermetic'))" "$NET_PLAN")

    if [ "$MODE" = "hermetic" ]; then
        # Default policy DROP ALL
        iptables -P INPUT DROP
        iptables -P FORWARD DROP
        iptables -P OUTPUT DROP

        # Loopback interface always allowed
        iptables -A INPUT -i lo -j ACCEPT
        iptables -A OUTPUT -o lo -j ACCEPT

        # Established and related traffic
        iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
        iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

        # 3. Block SNTP (UDP port 123)
        BLOCK_SNTP=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('sntp', {}).get('blockAll', True))" "$NET_PLAN")
        if [ "$BLOCK_SNTP" = "True" ]; then
            iptables -A OUTPUT -p udp --dport 123 -j DROP
        fi

        # 4. Start DNS filter gate & configure redirection
        DNS_ENABLED=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('dns', {}).get('enabled', True))" "$NET_PLAN")
        if [ "$DNS_ENABLED" = "True" ]; then
            python3 /opt/sandbox/dns-gate.py "$NET_PLAN" >/dev/null 2>&1 &
            DNS_PID=$!

            # Redirect local outbound UDP 53 to 127.0.0.1:5300 (DNS gate)
            iptables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports 5300

            # Allow DNS gate process to make outbound UDP 53 to configured upstream DNS servers
            UPSTREAMS=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(' '.join(d.get('dns', {}).get('upstreamServers', [])))" "$NET_PLAN")
            for up in $UPSTREAMS; do
                iptables -A OUTPUT -p udp -d "$up" --dport 53 -j ACCEPT
            done

            # Drop any direct plain UDP DNS queries not redirected
            BLOCK_OTHER_DNS=$(python3 -c "import json, sys; d=json.loads(sys.argv[1]); print(d.get('dns', {}).get('blockPlainUdpDns', True))" "$NET_PLAN")
            if [ "$BLOCK_OTHER_DNS" = "True" ]; then
                iptables -A OUTPUT -p udp --dport 53 -j DROP
                iptables -A OUTPUT -p tcp --dport 53 -j DROP
            fi
        fi

        # 5. Apply whitelisted Egress rules (TCP/UDP to IPs and ports)
        # Parses allowed IPs and ports from json
        python3 -c "
import json, sys, subprocess

plan = json.loads(sys.argv[1])
egress = plan.get('egressRules', [])

for rule in egress:
    proto = rule.get('proto', 'tcp')
    ips = rule.get('ips', [])
    ports = rule.get('ports', [])
    
    if ips and ports:
        for ip in ips:
            for port in ports:
                subprocess.run(['iptables', '-A', 'OUTPUT', '-p', proto, '-d', str(ip), '--dport', str(port), '-j', 'ACCEPT'], check=False)
    elif ports:
        for port in ports:
            subprocess.run(['iptables', '-A', 'OUTPUT', '-p', proto, '--dport', str(port), '-j', 'ACCEPT'], check=False)
    elif ips:
        for ip in ips:
            subprocess.run(['iptables', '-A', 'OUTPUT', '-p', proto, '-d', str(ip), '-j', 'ACCEPT'], check=False)
" "$NET_PLAN"

        # 6. Apply Ingress rules
        python3 -c "
import json, sys, subprocess

plan = json.loads(sys.argv[1])
ingress = plan.get('ingressRules', [])

for rule in ingress:
    proto = rule.get('proto', 'tcp')
    ips = rule.get('ips', [])
    ports = rule.get('ports', [])
    if ports:
        for port in ports:
            if ips:
                for ip in ips:
                    subprocess.run(['iptables', '-A', 'INPUT', '-p', proto, '-s', str(ip), '--dport', str(port), '-j', 'ACCEPT'], check=False)
            else:
                subprocess.run(['iptables', '-A', 'INPUT', '-p', proto, '--dport', str(port), '-j', 'ACCEPT'], check=False)
" "$NET_PLAN"
    fi
fi

# Ensure sandbox user exists with host UID/GID
HOST_UID="${HOST_UID:-1000}"
HOST_GID="${HOST_GID:-1000}"

# If ubuntu user exists with 1000, remove or reuse it to prevent HOME=/home/ubuntu
if id "ubuntu" >/dev/null 2>&1; then
    userdel -r ubuntu >/dev/null 2>&1 || true
fi

if ! getent group "$HOST_GID" >/dev/null 2>&1; then
    groupadd -g "$HOST_GID" sandbox 2>/dev/null || true
fi

if ! getent passwd "$HOST_UID" >/dev/null 2>&1; then
    useradd -u "$HOST_UID" -g "$HOST_GID" -m -d /home/sandbox -s /bin/bash sandbox 2>/dev/null || true
fi

export HOME=/home/sandbox
export USER=sandbox

# Fix ownership of container home directory if mounted or created
chown -R "$HOST_UID:$HOST_GID" /home/sandbox 2>/dev/null || true

# Setup Sandbox Awareness layer (Positive-Only disclosure)
mkdir -p /etc/sandbox-awareness /home/sandbox

# Unpack runtime awareness resources if provided
if [ -n "$AGENT_RESOURCES_PAYLOAD" ]; then
    python3 -c "
import base64, json, sys, os

try:
    raw = base64.b64decode(sys.argv[1]).decode('utf-8')
    payload = json.loads(raw)
    
    os.makedirs('/etc/sandbox-awareness', exist_ok=True)
    with open('/etc/sandbox-awareness/available-resources.json', 'w') as f:
        json.dump(payload.get('json', {}), f, indent=2)
        
    with open('/etc/sandbox-awareness/AVAILABLE_RESOURCES.md', 'w') as f:
        f.write(payload.get('markdown', ''))
except Exception as e:
    pass
" "$AGENT_RESOURCES_PAYLOAD"
fi

# Ensure AGENTS.md exists in /home/sandbox
if [ -f /etc/sandbox-awareness/AGENTS.md ]; then
    cp /etc/sandbox-awareness/AGENTS.md /home/sandbox/AGENTS.md
fi

# Link AVAILABLE_RESOURCES.md into /home/sandbox for convenience
if [ -f /etc/sandbox-awareness/AVAILABLE_RESOURCES.md ]; then
    cp /etc/sandbox-awareness/AVAILABLE_RESOURCES.md /home/sandbox/AVAILABLE_RESOURCES.md
fi

# Configure Strata inference integration if gateway IP is present
if [ -f /opt/sandbox/setup-strata.py ]; then
    python3 /opt/sandbox/setup-strata.py \
        "${STRATA_GATEWAY_IP:-172.17.0.1}" \
        "${STRATA_PORT:-8080}" \
        "${STRATA_MODEL:-qwen3.8-flash-next-coder-iq1_m}" \
        "${STRATA_CONTEXT_WINDOW:-131072}" \
        "${STRATA_MAX_TOKENS:-4096}" \
        "${STRATA_API_KEY:-none}" || true
fi

# Sync and link persistent agent state & shared skills/mcp/rules
if [ -f /opt/sandbox/sync-agent-storage.py ]; then
    python3 /opt/sandbox/sync-agent-storage.py || true
fi

chown -R "$HOST_UID:$HOST_GID" /home/sandbox 2>/dev/null || true

# Execute target command as non-root user matching host
if [ $# -gt 0 ]; then
    exec /usr/sbin/gosu "$HOST_UID:$HOST_GID" "$@"
else
    exec /usr/sbin/gosu "$HOST_UID:$HOST_GID" /bin/bash
fi
