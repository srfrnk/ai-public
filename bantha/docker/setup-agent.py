#!/usr/bin/env python3
"""
Configures all agents (goose, crush, pi, hermes) inside the container
to use the configured inference provider and model (generic by default,
or user-specified via INFERENCE_* env vars), and syncs shared MCP and skills.
"""

import os
import sys
import json
import re
from pathlib import Path

# Plain YAML scalars are emitted bare; anything else is quoted (always valid YAML).
_SAFE_SCALAR = re.compile(r"^[A-Za-z_][A-Za-z0-9_./@ -]*$")

def setup_shared(home: Path):
    shared_dir = home / ".shared"
    shared_skills = shared_dir / "skills"
    shared_rules = shared_dir / "rules" / "AGENTS.md"
    shared_mcp = shared_dir / "mcp" / "servers.json"

    # 1. Wire shared rules into /home/sandbox/AGENTS.md
    if not shared_rules.exists():
        shared_rules.parent.mkdir(parents=True, exist_ok=True)
        shared_rules.write_text("# Shared Agent Rules\n# Add universal instructions and workflows here.\n")

    sandbox_agents_md = home / "AGENTS.md"
    if not sandbox_agents_md.exists() or sandbox_agents_md.is_symlink():
        try:
            if sandbox_agents_md.is_symlink():
                sandbox_agents_md.unlink()
            sandbox_agents_md.symlink_to(shared_rules)
        except OSError:
            pass

    # 2. Wire shared skills into the active agent.
    # The real wiring is a bind mount (hub skills -> <agent home>/skills/shared), which
    # is in place before this script runs, so the path below already exists as a
    # directory and nothing is created here. The fallback link is authored for THIS
    # view (absolute, into the mounted hub) rather than a host-relative depth that
    # a container's shallower home cannot resolve; a dangling link is replaced.
    target_agent = os.environ.get("TARGET_AGENT", "").strip().lower()
    agent_skill_dirs = {
        "hermes": home / ".hermes" / "skills",
        "pi": home / ".pi" / "agent" / "skills",
        "goose": home / ".config" / "goose" / "skills",
    }

    if target_agent in agent_skill_dirs:
        skills_dir = agent_skill_dirs[target_agent]
        if skills_dir.is_symlink():
            try:
                skills_dir.unlink()
            except OSError:
                pass
        skills_dir.mkdir(parents=True, exist_ok=True)
        shared_link = skills_dir / "shared"
        if shared_link.is_symlink() and not shared_link.resolve().exists():
            try:
                shared_link.unlink()
            except OSError:
                pass
        if not shared_link.exists() and not shared_link.is_symlink() and shared_skills.exists():
            try:
                shared_link.symlink_to(shared_skills)
            except OSError:
                pass

    # 3. Read shared MCP definitions. Hermes reads servers from its own config.yaml
    # (the mcp_servers key), so the hub set is returned and merged there once the
    # profile config exists; other agents keep their own file formats.
    hub_servers = {}
    if shared_mcp.exists():
        try:
            hub_servers = json.loads(shared_mcp.read_text()).get("mcpServers", {}) or {}
        except Exception:
            hub_servers = {}

    if hub_servers:
        # Pi settings.json
        pi_settings_file = home / ".pi" / "agent" / "settings.json"
        if pi_settings_file.exists():
            try:
                p_data = json.loads(pi_settings_file.read_text())
                p_data.setdefault("mcp", {}).update(hub_servers)
                pi_settings_file.write_text(json.dumps(p_data, indent=2))
            except Exception:
                pass

    return hub_servers


def yaml_scalar(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) or value is None:
        return json.dumps(value)
    s = str(value)
    # Quote anything that is not a plain word-ish scalar: quoting is always valid YAML.
    if not _SAFE_SCALAR.match(s) or s in ("true", "false", "null", "yes", "no", "~"):
        return json.dumps(s)
    return s


def yaml_lines(value, indent):
    """Minimal YAML emitter for the JSON shapes used in MCP server definitions."""
    pad = " " * indent
    out = []
    for key, val in value.items():
        if isinstance(val, dict) and val:
            out.append(f"{pad}{key}:")
            out.extend(yaml_lines(val, indent + 2))
        elif isinstance(val, list) and val:
            out.append(f"{pad}{key}:")
            out.extend(f"{pad}  - {yaml_scalar(item)}" for item in val)
        elif isinstance(val, dict):
            out.append(f"{pad}{key}: {{}}")
        elif isinstance(val, list):
            out.append(f"{pad}{key}: []")
        else:
            out.append(f"{pad}{key}: {yaml_scalar(val)}")
    return out


def merge_mcp_servers(config_path: Path, servers: dict):
    """Insert hub servers under config.yaml's mcp_servers key.

    Profile-authored servers already in the file win and are never rewritten, and
    a server present by name is never written twice, so the merge is idempotent
    across launches.
    """
    if not servers:
        return
    text = config_path.read_text() if config_path.exists() else ""
    lines = text.splitlines()

    existing = set()
    in_block = False
    anchor = None
    for i, line in enumerate(lines):
        if line.rstrip().startswith("mcp_servers:"):
            in_block = True
            if anchor is None:
                anchor = i
            continue
        if not in_block:
            continue
        if line.strip() and not line.startswith(" "):
            in_block = False
            continue
        if line.startswith("  ") and line[2:3] != " " and line.rstrip().endswith(":"):
            existing.add(line.strip().rstrip(":"))

    chunk = []
    for name, cfg in servers.items():
        if name in existing:
            continue
        chunk.append(f"  {name}:")
        if isinstance(cfg, dict):
            chunk.extend(yaml_lines(cfg, 4))
    if not chunk:
        return

    if anchor is not None:
        lines[anchor + 1:anchor + 1] = chunk
    else:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("mcp_servers:")
        lines.extend(chunk)
    config_path.write_text("\n".join(lines) + "\n")

def main():
    provider = os.environ.get("INFERENCE_PROVIDER", sys.argv[1] if len(sys.argv) > 1 else "default")
    model = os.environ.get("INFERENCE_MODEL", sys.argv[2] if len(sys.argv) > 2 else "default")
    base_url = os.environ.get("INFERENCE_BASE_URL", sys.argv[3] if len(sys.argv) > 3 else "http://172.17.0.1:8080/v1")
    context_window = os.environ.get("INFERENCE_CONTEXT_WINDOW", sys.argv[4] if len(sys.argv) > 4 else "131072")
    max_tokens = os.environ.get("INFERENCE_MAX_TOKENS", sys.argv[5] if len(sys.argv) > 5 else "4096")
    api_key = os.environ.get("INFERENCE_API_KEY", sys.argv[6] if len(sys.argv) > 6 else "none")

    home = Path(os.environ.get("HOME", "/home/sandbox"))

    # Setup shared resources (skills, rules, MCP); returns the hub MCP servers
    hub_servers = setup_shared(home)

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
        "name": provider,
        "engine": "openai",
        "display_name": f"AI ({provider})",
        "description": "Configured Inference Service",
        "api_key_env": "INFERENCE_API_KEY",
        "base_url": base_url,
        "models": [
            {
                "name": model,
                "context_limit": int(context_window)
            }
        ],
        "supports_streaming": True
    }
    with open(goose_dir / "custom_providers" / f"{provider}.json", "w") as f:
        json.dump(goose_provider, f, indent=2)

    # 2. Configure Crush
    crush_dir = home / ".config" / "crush"
    crush_dir.mkdir(parents=True, exist_ok=True)
    crushrc_content = f"""provider add {provider} --type openai-compat \\
  --base-url "{base_url}" \\
  --api-key "{api_key}"

model add {provider}/{model} \\
  --name "{model}" \\
  --context-window {context_window} \\
  --default-max-tokens {max_tokens}

model large {provider}/{model}
model small {provider}/{model}
"""
    with open(crush_dir / "crushrc", "w") as f:
        f.write(crushrc_content)

    # 3. Configure Pi
    pi_dir = home / ".pi" / "agent"
    pi_dir.mkdir(parents=True, exist_ok=True)
    
    pi_models = {
        "providers": {
            provider: {
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
                        "name": model,
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
        "defaultProvider": provider,
        "defaultModel": model
    }
    with open(pi_dir / "settings.json", "w") as f:
        json.dump(pi_settings, f, indent=2)

    # 4. Configure Hermes
    hermes_dir = home / ".hermes"
    hermes_dir.mkdir(parents=True, exist_ok=True)
    hermes_config_file = hermes_dir / "config.yaml"

    default_hermes_config = f"""model:
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

    if not hermes_config_file.exists():
        with open(hermes_config_file, "w") as f:
            f.write(default_hermes_config)
    else:
        try:
            content = hermes_config_file.read_text()
            if not content.strip():
                hermes_config_file.write_text(default_hermes_config)
            else:
                if "model:" in content:
                    content = re.sub(r'(\n\s*default:\s*).*', rf'\g<1>{model}', content)
                    content = re.sub(r'(\n\s*provider:\s*).*', r'\g<1>custom', content)
                    content = re.sub(r'(\n\s*base_url:\s*).*', rf'\g<1>{base_url}', content)
                    content = re.sub(r'(\n\s*context_length:\s*).*', rf'\g<1>{context_window}', content)
                else:
                    content = f"model:\n  default: {model}\n  provider: custom\n  base_url: {base_url}\n  context_length: {context_window}\n" + content

                if "telemetry:" not in content:
                    content += """\ntelemetry:
  shared_metrics:
    enabled: false
    send: false
    offer_version: 2
"""
                hermes_config_file.write_text(content)
        except Exception:
            hermes_config_file.write_text(default_hermes_config)

    # 5. Merge hub MCP servers into the Hermes profile config (Hermes reads servers
    # from config.yaml, not from a separate file), after the config is in place.
    try:
        merge_mcp_servers(hermes_config_file, hub_servers)
    except Exception:
        pass

if __name__ == "__main__":
    main()
