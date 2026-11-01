#!/usr/bin/env python3
"""
Configures all agents (goose, crush, pi, hermes) inside the container
to use the local Strata inference server via the Docker bridge gateway IP.
"""

import os
import sys
import json
import string
from pathlib import Path

def main():
    gateway_ip = sys.argv[1] if len(sys.argv) > 1 else "172.17.0.1"
    port = sys.argv[2] if len(sys.argv) > 2 else "8080"
    model = sys.argv[3] if len(sys.argv) > 3 else "qwen3.8-flash-next-coder-iq1_m"
    context_window = sys.argv[4] if len(sys.argv) > 4 else "131072"
    max_tokens = sys.argv[5] if len(sys.argv) > 5 else "4096"
    api_key = sys.argv[6] if len(sys.argv) > 6 else "none"

    base_url = f"http://{gateway_ip}:{port}/v1"
    home = Path(os.environ.get("HOME", "/home/sandbox"))

    env_map = {
        "STRATA_HOST": gateway_ip,
        "STRATA_PORT": str(port),
        "STRATA_BASE_URL": base_url,
        "STRATA_MODEL": model,
        "STRATA_CONTEXT_WINDOW": str(context_window),
        "STRATA_MAX_TOKENS": str(max_tokens),
        "STRATA_API_KEY": api_key
    }

    # 1. Configure Goose
    goose_dir = home / ".config" / "goose"
    (goose_dir / "custom_providers").mkdir(parents=True, exist_ok=True)
    
    goose_config = f"""GOOSE_PROVIDER: openai
GOOSE_MODEL: {model}
OPENAI_BASE_URL: {base_url}
OPENAI_API_KEY: {api_key}
"""
    with open(goose_dir / "config.yaml", "w") as f:
        f.write(goose_config)

    goose_provider = {
        "name": "strata",
        "engine": "openai",
        "display_name": "Strata Local",
        "description": "Local Strata Inference Service",
        "api_key_env": "STRATA_API_KEY",
        "base_url": base_url,
        "models": [
            {
                "name": model,
                "context_limit": int(context_window)
            }
        ],
        "supports_streaming": True
    }
    with open(goose_dir / "custom_providers" / "strata.json", "w") as f:
        json.dump(goose_provider, f, indent=2)

    # 2. Configure Crush
    crush_dir = home / ".config" / "crush"
    crush_dir.mkdir(parents=True, exist_ok=True)
    crushrc_content = f"""provider add strata --type openai-compat \\
  --base-url "{base_url}" \\
  --api-key "{api_key}"

model add strata/{model} \\
  --name "Strata {model}" \\
  --context-window {context_window} \\
  --default-max-tokens {max_tokens}

model large strata/{model}
model small strata/{model}
"""
    with open(crush_dir / "crushrc", "w") as f:
        f.write(crushrc_content)

    # 3. Configure Pi
    pi_dir = home / ".pi" / "agent"
    pi_dir.mkdir(parents=True, exist_ok=True)
    
    pi_models = {
        "providers": {
            "strata": {
                "baseUrl": base_url,
                "api": "openai-completions",
                "apiKey": api_key,
                "compat": {
                    "supportsDeveloperRole": False,
                    "supportsReasoningEffort": False
                },
                "models": [
                    {
                        "id": model,
                        "name": f"Strata {model}",
                        "contextWindow": int(context_window),
                        "maxTokens": int(max_tokens),
                        "toolCalling": True
                    }
                ]
            }
        }
    }
    with open(pi_dir / "models.json", "w") as f:
        json.dump(pi_models, f, indent=2)

    pi_settings = {
        "defaultProvider": "strata",
        "defaultModel": model
    }
    with open(pi_dir / "settings.json", "w") as f:
        json.dump(pi_settings, f, indent=2)

    # 4. Configure Hermes
    hermes_dir = home / ".hermes"
    hermes_dir.mkdir(parents=True, exist_ok=True)
    
    hermes_config = f"""model:
  default: {model}
  provider: custom
  base_url: {base_url}
  context_length: {context_window}
telemetry:
  shared_metrics:
    enabled: false
    send: false
    offer_version: 2
"""
    with open(hermes_dir / "config.yaml", "w") as f:
        f.write(hermes_config)

if __name__ == "__main__":
    main()
