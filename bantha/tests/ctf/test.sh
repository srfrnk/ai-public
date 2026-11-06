#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_FILE="$DIR/result.txt"
RAW_FILE="$(mktemp)"

trap 'rm -f "$RAW_FILE"' EXIT

rm -rf ~/.bantha/data
rm -rf /tmp/ttt
mkdir -p /tmp/ttt
cd /tmp/ttt

export GOAL="$(cat "$DIR/goal.md")"

# Using single quotes around the command string so '$GOAL' is evaluated inside script's subshell,
# safely preserving the multi-line prompt and inner double quotes.
# -f forces flushing after each write so the log file is always complete and real-time.
script -q -e -f -c 'bantha hermes chat --cli --yolo -q "$GOAL"' "$RAW_FILE"

# Clean ANSI escapes, spinner animations, and repetitive status bar lines
python3 - "$RAW_FILE" "$RESULT_FILE" << 'EOF'
import sys, re

raw_path, out_path = sys.argv[1], sys.argv[2]
with open(raw_path, "rb") as f:
    raw = f.read()

# 1. Strip all ANSI escape sequences (CSI, OSC, DEC, cursor controls) and control bytes
clean = re.sub(rb'\x1b\[[0-9;?><=]*[ -/]*[@-~]', b'', raw)
clean = re.sub(rb'\x1b\([B0]', b'', clean)
clean = re.sub(rb'\x1b\][^\x07\x1b]*(\x07|\x1b\\\\)', b'', clean)
clean = re.sub(rb'\x1b[@-Z\\-_]', b'', clean)
clean = re.sub(rb'[\x00-\x08\x0b-\x1f\x7f]', b'', clean)
text = clean.decode("utf-8", errors="ignore")

# 2. Filter out TUI spinners, token status bars, animation frames, and redundant dividers
lines = []
prev = None
for line in text.splitlines():
    s = line.strip()
    if not s:
        continue

    # Drop horizontal divider bars completely
    if re.fullmatch(r'[─═━┄┅┈┉\-_]+', s):
        continue

    # Drop status bars & hotkey legends
    if any(k in s for k in ['enter interrupt', 'tab queue', 'ctrl+c stop', '☤ default', 'pinned']):
        continue

    # Drop TUI header/goal banners
    if 'you are a security and devops expert taking' in s and ('─' in s or 'tok' in s or '·' in s):
        continue

    # Drop spinner phrases & deliberation states
    if any(k in s for k in ['Working…', 'ruminating...', 'mulling...', 'brainstorming...', 'formulating...', 'synthesizing...', 'reasoning..', 'musing...', 'pondering...', 'reflecting...', 'deliberating...', 'cnemplating...', 'contemplating...']):
        continue

    # Drop standalone braille spinners / numbers / timer fragments (e.g. 9⏱⠋, 1⠦, etc.)
    if re.fullmatch(r'[\u2800-\u28ff0-9\s·⏱]+', s):
        continue
    if re.search(r'[\u2800-\u28ff]', s) and any(k in s for k in ['tok', 'YOLO', 'cmd', 'command', '·', 'taking…', 's ']):
        continue

    # Drop interactive TUI prompts
    if any(k in s for k in ['Type / to browse commands', 'type to redirect this turn', 'Find and fix a failing test', 'Admit fail if no new direction']):
        continue

    # Insert a clean blank line separator before new commands or agent answers
    if (s.startswith('💻 $') or s.startswith('✗ $') or s == '☤ Hermes') and prev != '':
        lines.append('')

    # Deduplicate consecutive identical lines
    if line == prev:
        continue

    lines.append(line)
    prev = line

with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
EOF

