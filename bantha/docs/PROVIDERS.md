# Inference Providers Guide

Bantha is backend-agnostic. While it pre-wires local **Strata** out of the box for zero-setup offline inference, it fully supports other local inference engines (Ollama, vLLM, llama.cpp) as well as cloud API providers (Anthropic, OpenAI, OpenRouter, DeepSeek, etc.).

---

## 1. Local Inference Backends

Local inference engines running on the host machine are reached across the Docker bridge gateway (`172.17.0.1` or `127.0.0.1`).

### 1.1 Strata (Default Zero-Configuration)
- **Host Endpoint**: `http://127.0.0.1:8080/v1`
- **Container Gateway**: `http://172.17.0.1:8080/v1`
- **Default Port**: `8080` (pre-whitelisted in `network.yaml`)
- When no API keys or custom configs are provided, Bantha auto-wires all four Tuskens (`hermes`, `goose`, `pi`, `crush`) to Strata.

### 1.2 Ollama
- **Host Endpoint**: `http://127.0.0.1:11434`
- **Container Gateway**: `http://172.17.0.1:11434`
- **Default Port**: `11434` (pre-whitelisted in `network.yaml`)
- **Connecting a Tusken**:
  ```bash
  # Tell Goose to use Ollama
  bantha goose configure  # choose ollama provider and model
  
  # Tell Pi to use Ollama
  bantha pi --provider ollama --model llama3.3
  
  # Tell Hermes to use Ollama
  bantha hermes model
  ```

### 1.3 Other Local Engines (vLLM, llama.cpp, LM Studio)
If your local engine runs on another port (e.g. `8000` or `1234`), ensure the port is listed in `~/.bantha/network.yaml`:
```yaml
egress:
  rules:
    - proto: "tcp"
      ips: ["127.0.0.1", "172.17.0.1"]
      ports: [8080, 11434, 8000, 1234]
```

---

## 2. Cloud Model Providers (Anthropic, OpenAI, OpenRouter, etc.)

Because Bantha defaults to a hermetic `DROP ALL` network policy, connecting to cloud providers requires two steps:

### Step 1: Forward the API Key (`environment.yaml`)
In `~/.bantha/environment.yaml`, ensure your provider's environment variable pattern is allowed:
```yaml
rules:
  - "ANTHROPIC_*"       # For Claude (e.g. ANTHROPIC_API_KEY)
  - "OPENAI_*"          # For OpenAI (e.g. OPENAI_API_KEY)
  - "OPENROUTER_API_KEY" # For OpenRouter
  - "DEEPSEEK_API_KEY"  # For DeepSeek
  - "GEMINI_API_KEY"    # For Google Gemini
```

### Step 2: Whitelist Provider Domains (`network.yaml`)
In `~/.bantha/network.yaml`, whitelist the provider's API endpoint under both `dns.rules` and `egress.rules`:

```yaml
dns:
  rules:
    - "api.anthropic.com"
    - "api.openai.com"
    - "openrouter.ai"
    - "api.deepseek.com"

egress:
  rules:
    - proto: "tcp"
      port: 443
      domains:
        - "api.anthropic.com"
        - "api.openai.com"
        - "openrouter.ai"
        - "api.deepseek.com"
```

Once whitelisted, you can run:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
bantha pi --model claude-3-7-sonnet-20250219

export OPENAI_API_KEY="sk-..."
bantha hermes -m gpt-4o
```

---

## 3. Provider Configurations Summary Table

| Provider | Type | Gateway / Endpoint | Required Whitelist in `network.yaml` | Key Env in `environment.yaml` |
| :--- | :--- | :--- | :--- | :--- |
| **Strata** | Local | `http://172.17.0.1:8080/v1` | Pre-configured (`port 8080`) | None (auto-configured) |
| **Ollama** | Local | `http://172.17.0.1:11434` | Pre-configured (`port 11434`) | `OLLAMA_HOST` (optional) |
| **vLLM / llama.cpp** | Local | `http://172.17.0.1:<port>/v1` | Add `<port>` to `egress.rules` | None |
| **Anthropic** | Cloud | `https://api.anthropic.com` | `api.anthropic.com` on port `443` | `ANTHROPIC_API_KEY` |
| **OpenAI** | Cloud | `https://api.openai.com` | `api.openai.com` on port `443` | `OPENAI_API_KEY` |
| **OpenRouter** | Cloud | `https://openrouter.ai` | `openrouter.ai` on port `443` | `OPENROUTER_API_KEY` |
| **DeepSeek** | Cloud | `https://api.deepseek.com` | `api.deepseek.com` on port `443` | `DEEPSEEK_API_KEY` |
