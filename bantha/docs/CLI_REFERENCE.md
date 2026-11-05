# CLI Reference: `bantha` Runner

The `bantha` executable is the single entry point for running AI developer agents (**Tuskens**: `hermes`, `goose`, `pi`, `crush`) inside a strictly hermetic container sandbox.

---

## 1. Installation & Location

- **Binary Location**: `~/.bantha/bantha` (symlinked from the source directory via `./install.sh`).
- **Configuration Directory**: `~/.bantha/`
- **Tuskens Persistent Storage**: `~/.bantha/data/agents/<tusken>`
- **Shared Skills/MCP/Rules Hub**: `~/.bantha/data/shared/`

When installed via `./install.sh`, `~/.bantha` is automatically prepended to your `$PATH`. `agents` is also provided as a shell alias for backward compatibility.

---

## 2. Synopsis

```bash
bantha <tusken|subcommand> [flags...] [-- tusken-options...]
```

### Pre-Flight Due Diligence & Approval
When launching an agent (e.g. `bantha hermes`), Bantha prints a **Security & Resource Agent Exposure Report** displaying the exact workspace mount, proxied gateway services, brokered secrets, passed host environment variables, and outbound network rules. In interactive sessions, Bantha prompts for your approval before launching the container:
```text
Press [Enter] to approve and start the agent (or Ctrl+C to abort)...
```
This guarantees complete visibility into what is exposed to the agent before execution begins and ensures Hermes or other full-screen TUIs do not clear the banner before you have had a chance to review it. Use `-y` or `--yes` to bypass the prompt in automated scripts.

---

## 3. Supported Tuskens (Agents)

| Tusken Name | Description | Invocation Example |
| :--- | :--- | :--- |
| `hermes` | Hermes autonomous reasoning agent (Nous) | `bantha hermes chat -q "Hello"` |
| `goose` | Goose autonomous agent (Block) | `bantha goose run -t "Add unit test suite"` |
| `pi` | Pi coding agent (TypeScript/Node.js) | `bantha pi -p "Refactor memory allocation"` |
| `crush` | Crush developer agent (Charmbracelet) | `bantha crush` |

---

## 4. Subcommands

### `bantha inspect`
Displays the exact resource exposure summary for the current working directory without launching a container:
- Mounted workspace paths and shared persistent volumes
- Proxied gateway services and endpoint filtering policies
- Brokered secrets (keys that stay on the host) and the container variables that point at the proxy
- Whitelisted environment variables passed into the sandbox vs. blocked host variables
- Outbound network egress and DNS filtering rules

### `bantha tuskens`
Lists all available Tuskens (agents), their version, and their persistence status.

### `bantha build [--force]`
Builds or rebuilds the underlying `bantha:latest` container image.
- **`--force`**: Rebuilds the image even if it already exists or source hashes match.
- *Note*: If the image does not exist, `bantha` automatically triggers this build before launching an agent.

### `bantha status`
Displays the active configurations loaded from `~/.bantha/`, including:
- Config directory location
- Container memory and CPU limits
- Active network isolation mode (`hermetic`, `none`, or `host`)
- SNTP and DNS status
- List of protected directories that are guaranteed never to be mounted

### `bantha completion [shell]`
Outputs shell auto-completion code for the specified shell.
- **Supported shells**: `bash`, `zsh`, `fish`
- **Example**:
  ```bash
  source <(bantha completion bash)
  ```

---

## 5. Model Inference Providers

For instructions on configuring local engines (Strata, Ollama, vLLM) or cloud API providers (Anthropic Claude, OpenAI, OpenRouter, DeepSeek), see **[Inference Providers Guide](PROVIDERS.md)**.

### `bantha help`
Prints the help and usage overview.

---

## 5. Exit Codes

- `0`: Success / Target agent exited cleanly.
- `1`: Sandbox execution error, security violation, or agent error.
- Other positive integers: Exit code forwarded directly from the agent process inside the container.
