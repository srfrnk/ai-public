#!/usr/bin/env python3
"""
Syncs and symlinks per-agent persistent storage and shared skills/mcp/rules.
Ensures that:
1. Agent persistent state in /home/sandbox/.agent-state/<agent> is linked to native paths:
   - hermes: /home/sandbox/.hermes
   - pi:     /home/sandbox/.pi
   - goose:  /home/sandbox/.config/goose and /home/sandbox/.local/share/goose
   - crush:  /home/sandbox/.config/crush
2. Shared skills in /home/sandbox/.shared/skills are linked into agent skill paths.
3. Shared MCP definitions in /home/sandbox/.shared/mcp/servers.json are synced into
   hermes, goose, and pi configurations.
4. Shared rules in /home/sandbox/.shared/rules/AGENTS.md are linked into AGENTS.md paths.
"""

import os
import sys
import json
import shutil
from pathlib import Path

def setup_links():
    home = Path("/home/sandbox")
    shared_dir = home / ".shared"
    state_dir = home / ".agent-state"
    target_agent = os.environ.get("TARGET_AGENT", "").strip().lower()

    # Ensure shared subdirectories exist
    (shared_dir / "skills").mkdir(parents=True, exist_ok=True)
    (shared_dir / "mcp").mkdir(parents=True, exist_ok=True)
    (shared_dir / "rules").mkdir(parents=True, exist_ok=True)

    # 1. Wire Per-Agent State
    if target_agent:
        agent_store = state_dir / target_agent
        if agent_store.exists():
            if target_agent == "hermes":
                # Link /home/sandbox/.hermes -> /home/sandbox/.agent-state/hermes
                hermes_target = home / ".hermes"
                if hermes_target.exists() and not hermes_target.is_symlink():
                    for item in hermes_target.iterdir():
                        dest = agent_store / item.name
                        if not dest.exists():
                            if item.is_dir(): shutil.copytree(item, dest)
                            else: shutil.copy2(item, dest)
                    shutil.rmtree(hermes_target)
                if not hermes_target.exists():
                    hermes_target.symlink_to(agent_store)

            elif target_agent == "pi":
                # Link /home/sandbox/.pi -> /home/sandbox/.agent-state/pi
                pi_target = home / ".pi"
                if pi_target.exists() and not pi_target.is_symlink():
                    for item in pi_target.iterdir():
                        dest = agent_store / item.name
                        if not dest.exists():
                            if item.is_dir(): shutil.copytree(item, dest)
                            else: shutil.copy2(item, dest)
                    shutil.rmtree(pi_target)
                if not pi_target.exists():
                    pi_target.symlink_to(agent_store)

            elif target_agent == "goose":
                goose_conf = home / ".config" / "goose"
                goose_conf.parent.mkdir(parents=True, exist_ok=True)
                (agent_store / "config").mkdir(parents=True, exist_ok=True)
                (agent_store / "data").mkdir(parents=True, exist_ok=True)
                if goose_conf.exists() and not goose_conf.is_symlink():
                    for item in goose_conf.iterdir():
                        dest = agent_store / "config" / item.name
                        if not dest.exists():
                            if item.is_dir(): shutil.copytree(item, dest)
                            else: shutil.copy2(item, dest)
                    shutil.rmtree(goose_conf)
                if not goose_conf.exists():
                    goose_conf.symlink_to(agent_store / "config")
                
                goose_data = home / ".local" / "share" / "goose"
                goose_data.parent.mkdir(parents=True, exist_ok=True)
                if not goose_data.exists():
                    goose_data.symlink_to(agent_store / "data")

            elif target_agent == "crush":
                crush_conf = home / ".config" / "crush"
                crush_conf.parent.mkdir(parents=True, exist_ok=True)
                if crush_conf.exists() and not crush_conf.is_symlink():
                    for item in crush_conf.iterdir():
                        dest = agent_store / item.name
                        if not dest.exists():
                            if item.is_dir(): shutil.copytree(item, dest)
                            else: shutil.copy2(item, dest)
                    shutil.rmtree(crush_conf)
                if not crush_conf.exists():
                    crush_conf.symlink_to(agent_store)

    # 2. Wire Shared Skills into each agent
    shared_skills = shared_dir / "skills"
    
    # Hermes shared skills
    hermes_skills = home / ".hermes" / "skills"
    hermes_skills.mkdir(parents=True, exist_ok=True)
    shared_hermes_link = hermes_skills / "shared"
    if not shared_hermes_link.exists():
        try: shared_hermes_link.symlink_to(shared_skills)
        except OSError: pass

    # Pi shared skills
    pi_skills = home / ".pi" / "agent" / "skills"
    pi_skills.parent.mkdir(parents=True, exist_ok=True)
    if not pi_skills.exists():
        try: pi_skills.symlink_to(shared_skills)
        except OSError: pass

    # Goose shared skills
    goose_skills = home / ".config" / "goose" / "skills"
    goose_skills.parent.mkdir(parents=True, exist_ok=True)
    if not goose_skills.exists():
        try: goose_skills.symlink_to(shared_skills)
        except OSError: pass

    # 3. Wire Shared Rules
    shared_rules_agents = shared_dir / "rules" / "AGENTS.md"
    if not shared_rules_agents.exists():
        shared_rules_agents.write_text("# Shared Agent Rules\n# Add universal instructions and workflows here.\n")

    # Link /home/sandbox/AGENTS.md to shared rules if not already present
    sandbox_agents_md = home / "AGENTS.md"
    if not sandbox_agents_md.exists() or sandbox_agents_md.is_symlink():
        try:
            if sandbox_agents_md.is_symlink(): sandbox_agents_md.unlink()
            sandbox_agents_md.symlink_to(shared_rules_agents)
        except OSError: pass

    # 4. Sync Shared MCP definitions into configs
    mcp_json_path = shared_dir / "mcp" / "servers.json"
    if not mcp_json_path.exists():
        mcp_json_path.write_text(json.dumps({"mcpServers": {}}, indent=2))
    else:
        try:
            shared_mcp = json.loads(mcp_json_path.read_text())
            servers = shared_mcp.get("mcpServers", {})
            if servers:
                # Sync into Hermes mcp.json
                hermes_mcp = home / ".hermes" / "mcp.json"
                h_data = json.loads(hermes_mcp.read_text()) if hermes_mcp.exists() else {"mcpServers": {}}
                h_data.setdefault("mcpServers", {}).update(servers)
                hermes_mcp.write_text(json.dumps(h_data, indent=2))

                # Sync into Pi settings.json
                pi_settings_file = home / ".pi" / "agent" / "settings.json"
                if pi_settings_file.exists():
                    p_data = json.loads(pi_settings_file.read_text())
                    p_data.setdefault("mcp", {}).update(servers)
                    pi_settings_file.write_text(json.dumps(p_data, indent=2))
        except Exception:
            pass

if __name__ == "__main__":
    setup_links()
