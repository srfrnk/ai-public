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

### `agents help`
Prints the help and usage overview.

---

## 5. Exit Codes

- `0`: Success / Target agent exited cleanly.
- `1`: Sandbox execution error, security violation, or agent error.
- Other positive integers: Exit code forwarded directly from the agent process inside the container.
