#!/usr/bin/env bash
# Installs Split it on this Linux machine as a service that starts on boot.
# Run from the unpacked folder:  bash install.sh
# Safe to run again to update: your data/ folder is kept.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/house-split"

# 1. Node.js 18+
need_node=1
if command -v node >/dev/null; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  if command -v apt-get >/dev/null; then
    echo "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Please install Node.js 18 or newer with your package manager, then run this again."; exit 1
  fi
fi
echo "Node $(node -v)"

# 2. Copy the app, keeping any existing data
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  tar -C "$SRC" --exclude=./data -cf - . | tar -C "$DEST" -xf -
fi
echo "App files in $DEST"
(cd "$DEST" && node --test test/*.test.js >/dev/null 2>&1 && echo "Self-check passed") || echo "Self-check had a problem (node --test test/*.test.js shows it). Carrying on."

# 3. Start on boot
mkdir -p "$HOME/.config/systemd/user"
cp "$DEST/house-split.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable house-split >/dev/null
systemctl --user restart house-split
sudo loginctl enable-linger "$USER"
sleep 1
systemctl --user --no-pager status house-split | head -5 || true

# 4. Next steps
if ! node -e "process.exit(Object.keys(require('$DEST/data/users.json').users||{}).length?0:1)" 2>/dev/null; then
  echo
  echo "Now add yourself and housemates, then restart:"
  echo "  cd $DEST && node server.js add-user YOURNAME"
  echo "  systemctl --user restart house-split"
fi
echo
echo "Open http://localhost:8080 on this computer."
echo "For phones away from home, see step 6 (Tailscale) in README.md."
