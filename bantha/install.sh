#!/usr/bin/env bash
set -e

# ==============================================================================
# Installer for Bantha Runner
# ==============================================================================

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BANTHA_HOME="$HOME/.bantha"

echo "[INSTALL] Installing Bantha runner..."

# 1. Ensure build is up-to-date
echo "[INSTALL] Building TypeScript package..."
cd "$PROJECT_DIR"
npm install --silent
npm run build --silent

# 2. Create ~/.bantha directory
mkdir -p "$BANTHA_HOME" "$HOME/.local/bin"

# 3. Create symlinks for bantha binary
echo "[INSTALL] Symlinking runner to $BANTHA_HOME/bantha and $HOME/.local/bin/bantha..."
ln -sf "$PROJECT_DIR/bin/bantha" "$BANTHA_HOME/bantha"
ln -sf "$PROJECT_DIR/bin/bantha" "$HOME/.local/bin/bantha"
chmod +x "$PROJECT_DIR/bin/bantha" "$BANTHA_HOME/bantha"

# 4. Generate default config files if not already present
node "$PROJECT_DIR/bin/bantha" help >/dev/null 2>&1 || true

# 5. Install shell completions into standard autoload locations
echo "[INSTALL] Installing shell completion scripts from repo..."
mkdir -p "$HOME/.local/share/bash-completion/completions"
mkdir -p "$HOME/.local/share/zsh/site-functions"
mkdir -p "$HOME/.zsh/completions"
mkdir -p "$HOME/.config/fish/completions"

# Bash
cp "$PROJECT_DIR/completions/bantha.bash" "$HOME/.local/share/bash-completion/completions/bantha"

# Zsh
cp "$PROJECT_DIR/completions/bantha.zsh" "$HOME/.local/share/zsh/site-functions/_bantha"
cp "$PROJECT_DIR/completions/bantha.zsh" "$HOME/.zsh/completions/_bantha"
cp "$PROJECT_DIR/completions/bantha.zsh" "$HOME/.zsh/completion/_bantha" 2>/dev/null || true

# Fish
cp "$PROJECT_DIR/completions/bantha.fish" "$HOME/.config/fish/completions/bantha.fish"

# 6. Add ~/.bantha to PATH in user shell config
add_to_shell() {
    local rcfile="$1"
    if [ -f "$rcfile" ]; then
        if ! grep -q "bantha" "$rcfile"; then
            echo "" >> "$rcfile"
            echo "# Added by bantha installer" >> "$rcfile"
            echo 'export PATH="$HOME/.bantha:$PATH"' >> "$rcfile"
            echo "[INSTALL] Updated $rcfile with PATH."
        fi
    fi
}

add_to_shell "$HOME/.bashrc"
add_to_shell "$HOME/.zshrc"

echo ""
echo "[INSTALL SUCCESS] Bantha runner installed successfully!"
echo "Usage: bantha <hermes|goose|pi|crush> [args...]"
echo "Configs: ~/.bantha/ (container.yaml, filesystem.yaml, network.yaml, environment.yaml)"
