# Environment Configuration: `environment.yaml`

The `environment.yaml` file controls which host environment variables and API keys may be forwarded to the agent inside the sandbox, and which secrets are strictly blocked.

---

## 1. File Location
```
~/.bantha/environment.yaml
```

---

## 2. Full Schema & Default Values

```yaml
version: "1.0"

# Unified pattern list:
# Positive entries allow matching environment variables to be passed into the container.
# Negative entries prefixed with '!' strictly block matching variables.
rules:
  # Terminal & locale variables
  - "TERM"
  - "COLORTERM"
  - "LANG"
  - "LC_ALL"

  # Allowed LLM API keys
  - "ANTHROPIC_*"
  - "OPENAI_*"
  - "HF_TOKEN"

  # Strictly blacklisted secrets & identity variables
  - "!AWS_*"
  - "!*_SECRET*"
  - "!ANTIGRAVITY_*"
```

---

## 3. Behavior & Safety

1. Host system identity variables such as `HOME`, `PATH`, and internal runner variables (`AGENT_*`) are never passed directly through `environment.yaml`.
2. Any variable matching a blacklist pattern (e.g. `AWS_ACCESS_KEY_ID`, `MY_SECRET_KEY`) is completely stripped before invoking Docker.
3. Only variables present in the host environment matching positive rules and not matching negative rules are passed via `-e KEY=VALUE`.
