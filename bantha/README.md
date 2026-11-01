# Bantha (`bantha`)

> **The resilient beast of burden navigating the harsh digital sands, carrying nomadic AI agents (Tuskens) in a secure, hermetic container sandbox.**

Bantha is a hermetic container sandbox runner for autonomous AI coding agents (**Tuskens**: `hermes`, `goose`, `pi`, `crush`) featuring Linux kernel VFS mount namespace masking, Netfilter packet filtering, and zero host intrusion.

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
  - [Unified Pattern Syntax (`PATTERN_SYNTAX.md`)](docs/config/PATTERN_SYNTAX.md)
