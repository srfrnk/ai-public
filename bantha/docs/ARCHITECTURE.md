# System Architecture & Kernel Isolation (`bantha`)

This document explains the technical architecture of **Bantha** and how the Linux kernel guarantees hermetic isolation for both filesystem and network layers.

---

## 1. High-Level Architecture

```mermaid
flowchart TD
    UserCLI["User / Shell Command: bantha <tusken> [args...]"] --> Runner["Runner: ~/.bantha/bantha (Node.js / TypeScript)"]
    
    subgraph Host Config State ["~/.bantha/ (Host Only)"]
        containerYaml["container.yaml"]
        fsYaml["filesystem.yaml"]
        netYaml["network.yaml"]
        envYaml["environment.yaml"]
        persistentData["data/ (agents/ & shared/)"]
    end
    
    Runner -->|Load & Validate| HostConfigState
    Runner -->|Enforce Protected Ancestor Check| SafetyGate{Safety Gate}
    SafetyGate -- Violation --> Abort[Abort Execution]
    SafetyGate -- Validated --> Plan[Mount Planner & Netfilter Compiler]
    
    Plan --> DockerRun["docker run --rm --init --cap-add=NET_ADMIN ..."]
    
    subgraph Container Mount Namespace ["CLONE_NEWNS (Kernel VFS)"]
        BindMounts["Whitelisted Bind Mounts\n(e.g., /workspace:rw)"]
        SharedHub["Shared Hub\n(~/.shared: skills, mcp, rules)"]
        AgentStore["Tusken Private Store\n(~/.agent-state/<tusken>)"]
        TmpfsMasks["Blacklist tmpfs Masks\n(type=tmpfs,destination=/path/to/blacklisted,readonly)"]
        BindMounts --- TmpfsMasks
        BindMounts --- SharedHub
        BindMounts --- AgentStore
    end

    subgraph Container Network Namespace ["CLONE_NEWNET (Kernel Netfilter)"]
        IPTables["iptables Rules\n- DROP ALL\n- SNTP UDP 123 DROP\n- Port Whitelist ACCEPT"]
        DNSGate["127.0.0.1:5300 (DNS-Gate Proxy)\nResolves Whitelisted Domains Only"]
        IPTables --> DNSGate
    end

    DockerRun --> ContainerMountNamespace
    DockerRun --> ContainerNetworkNamespace
    ContainerMountNamespace --> Agent["Tusken Process: hermes / goose / pi / crush"]
    ContainerNetworkNamespace --> Agent
```

---

## 2. Linux Kernel Virtual File System (VFS) Masking

### Why standard blacklist checking is insufficient
If a runner simply checks paths at startup and allows mounting a parent directory like `/workspace`, an agent process could walk the directory tree (`find /workspace` or `open("/workspace/private/key.pem")`) and access sensitive data.

### How Mount Masking Guarantees Isolation
Linux kernel mount namespaces (`CLONE_NEWNS`) allow mounting filesystems over existing paths:
1. Docker mounts the parent directory into the container.
2. The `agents` runner inspects the configured blacklist patterns and applies a dedicated mount:
   ```bash
   --mount type=tmpfs,destination=/workspace/private,readonly
   ```
3. When the container process calls `stat()`, `open()`, or `getdents64()` on `/workspace/private`, the Linux kernel resolves path resolution to the `tmpfs` mount point.
4. The underlying host files are completely shadowed and inaccessible. The process sees an empty directory, and any write attempts fail with `EROFS` (Read-only file system).

---

## 3. Netfilter & DNS Isolation

### Netfilter (iptables) in `CLONE_NEWNET`
Each container runs in its own network namespace. The entrypoint sets default packet drop policies:
```bash
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
```
All packets are rejected unless explicitly matched:
- **SNTP / NTP**: All outbound UDP packets to port 123 are explicitly dropped (`iptables -A OUTPUT -p udp --dport 123 -j DROP`).
- **Egress & Ingress**: Rules are created for configured IP addresses, CIDR blocks, and ports.

### Application-Layer DNS Gate
DNS resolution (UDP/TCP 53) is intercepted via NAT redirection:
```bash
iptables -t nat -A OUTPUT -p udp --dport 53 -j REDIRECT --to-ports 5300
```
An internal DNS gate daemon (`dns-gate.py`) inspects queries:
- Whitelisted domains are forwarded to authorized upstream DNS servers (e.g. `1.1.1.1`).
- Disallowed or blacklisted domains return `NXDOMAIN` immediately.
- Direct outbound DNS packets outside the gate are dropped by kernel netfilter rules.
