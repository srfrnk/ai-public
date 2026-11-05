# Bantha (`bantha`)

> **The resilient beast of burden navigating the harsh digital sands, carrying nomadic AI agents (Tuskens) in a secure, hermetic container sandbox.**

Bantha is designed for **running autonomous AI coding agents locally in a secure, controlled environment—whether powered by cloud APIs or local inference engines—especially when models cannot be fully trusted**.

Autonomous agents need broad agency: executing shell commands, reading/writing files, installing dependencies, and interacting with network APIs. Running them directly on your bare-metal machine exposes your personal files, credentials, SSH keys, and local network to arbitrary tool execution, model hallucinations, or prompt injection. 

Bantha provides an **easy-to-configure, lightweight boundary** that lets locally running agents work productively with your workspace filesystem, persistent skills, and network while **minimizing risk to your host machine**.

---

## Why Bantha?

- **Untrusted Model Safety**: Safely run cutting-edge, experimental, or open-weights models (via Ollama, Strata, vLLM, or cloud providers) without worrying that an errant shell command or prompt injection will touch your personal files or host environment.
- **Easy, Declarative Local Configuration**: Configure what the agent can see through simple Gitignore-style rules for filesystems, environment variables, network endpoints, and brokered secrets.
- **Real Filesystem & Git Workflow**: Work directly in your project folder with correct host `UID:GID` file ownership. Agents update code, create skills, and configure tools that you can immediately inspect, test, and commit to Git.
- **Out-of-Band Secrets Brokering**: Cloud API keys (OpenAI, Anthropic) stay on the host. The agent only receives virtualized per-session proxy tokens, preventing credential scraping or exfiltration.
- **Pre-Flight Due Diligence**: Every run presents an upfront Security & Resource Exposure Report showing the exact workspace mounts, proxied services, brokered secrets, and network rules before prompting for your approval.

---

## The Naming Theme

- **The Bantha (`bantha`)**: Like the massive, thick-skinned creature carrying travelers through the unforgiving Dune Sea, **Bantha** is the armored container carrier that safely transports and isolates AI processes. It takes the brunt of the environment, enforces resource boundaries, and shields your system.
- **The Tuskens (Nomadic Agents)**: The Sand People riding the Bantha—our autonomous agents (`hermes`, `goose`, `pi`, `crush`). Inside the sandbox, they have full agency to analyze code, run commands, create skills, and build software, but they cannot stray beyond the boundaries of the carrier.
- **The Sandbox Sands**: The hermetic container environment with default-deny network rules (`DROP ALL`) and kernel-level `tmpfs` masks over blacklisted paths, leaving zero trace on the host.

---

## Features

- **Hermetic Isolation**: Zero network leakage by default (`DROP ALL` policy for ingress & egress).
- **Kernel-Level Mount Masking**: Blacklisted paths inside allowed workspaces are shadowed by empty read-only `tmpfs` mounts, preventing traversal during file tree walks.
- **Unified Gitignore-Style Configuration**: Negative rules (`!pattern`, `!regex:...`) have strict precedence across all config topics.
- **Config & Ancestor Protection**: The configuration directory `~/.bantha` and all its parent directories (`$HOME`, `/home`, etc.) are hard-blocked from container mounting.
- **Persistent Storage & Shared Hub**:
  - Per-tusken private persistence for sessions, SQLite databases, and memory graphs.
  - Universal shared hub for cross-agent skills, MCP server registries, and rules (`AGENTS.md`).
- **Embedded Agent Runtime**: `pi`, `goose`, `crush`, and `hermes` live exclusively inside the container image; no host installation required.
- **Shell Auto-Completion**: Full completion support for `bash`, `zsh`, and `fish` for both `bantha` and `agents`.

## Isolation Model & Trade-offs

Bantha runs agents in a hardened **Docker container**, which shares the host kernel. The agent runs as an unprivileged user with all capabilities dropped, `no-new-privileges`, a firewall it cannot modify, and kernel-level path masking. This is a smaller trust boundary than a hypervisor: a container-escape vulnerability in the host kernel would bypass it. Tools that run each agent in a microVM (for example Docker Sandboxes) trade a heavier setup for a stronger boundary and give the agent root inside it. If you run untrusted code and need that stronger boundary, consider a microVM-based sandbox, or a stronger container runtime such as gVisor or Kata (not yet supported by Bantha).

## Quick Start

```bash
# Clone the repository and navigate to bantha
git clone https://github.com/srfrnk/ai-public.git
cd ai-public/bantha
./install.sh

# List available Tuskens (agents)
bantha tuskens

# Launch a Tusken inside the sandbox
bantha hermes chat -q "Hello"
bantha pi -p "explain main function"
bantha goose run -t "run diagnostics"
bantha crush --help

# View active sandbox configuration status
bantha status
```

*(Note: `agents <agent>` is maintained as a transparent alias for `bantha <agent>`)*.

## Documentation

- [CLI Reference](docs/CLI_REFERENCE.md)
- [Inference Providers Guide (Strata, Ollama, Claude, OpenAI)](docs/PROVIDERS.md)
- [Architecture & Kernel Isolation](docs/ARCHITECTURE.md)
- **Configuration Guides**:
  - [Container Configuration (`container.yaml`)](docs/config/CONTAINER_CONFIG.md)
  - [Filesystem Configuration (`filesystem.yaml`)](docs/config/FILESYSTEM_CONFIG.md)
  - [Network Configuration (`network.yaml`)](docs/config/NETWORK_CONFIG.md)
  - [Environment Configuration (`environment.yaml`)](docs/config/ENVIRONMENT_CONFIG.md)
  - [Secret Brokering (`secrets.yaml`)](docs/config/SECRETS_CONFIG.md)
  - [Unified Pattern Syntax (`PATTERN_SYNTAX.md`)](docs/config/PATTERN_SYNTAX.md)

## TODO

- [ ] Wire in the gateway (`docker/gateway/`, `network.yaml: services`): nothing starts it today, and it is hidden from the reports. Harden it first: stream responses, cap request body size, fail closed on validation errors, and avoid listening on `0.0.0.0`.
- [ ] Support a stronger container runtime such as gVisor or Kata via `--runtime`.
- [ ] Add session convenience commands: list, stop, remove, and open a shell in a running session.
- [ ] Add a small agent/kit definition format so agents and policies can be shared. Consider reading sbx v2 kit specs directly to reuse the existing catalog.
- [ ] Add more secret-broker routes (OpenRouter, HuggingFace) and OAuth support if needed.
- [ ] Make image builds reproducible (replace `bin-cache` and the vendored hermes tree with pinned downloads) and add CI.
- [ ] Add an optional `sbx` backend (`backend: docker | sbx` in `container.yaml`):
  - Split `runner.ts` into a shared policy step and two launchers.
  - Translate `filesystem.yaml` into mounts, `network.yaml` domains into `sbx policy` rules, and `secrets.yaml` into `sbx secret set`.
  - Write a `goose` kit (`hermes-agent`, `pi` and `crush` kits already exist).
  - Warn about settings `sbx` cannot enforce (path masks, IP/port rules, NTP block).
  - Note the requirements: Docker sign-in, KVM or equivalent, and default CLI telemetry.
