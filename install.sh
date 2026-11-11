#!/usr/bin/env bash
# Installs Split it on this Linux machine as a service that starts on boot.
# Run from the unpacked folder:  bash install.sh
# Safe to run again to update: your data/ folder and split-it.env are kept.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/split-it"
OLD="$HOME/house-split"          # where versions before 2.2 lived
UNITS="$HOME/.config/systemd/user"
[ "$SRC" = "$OLD" ] && DEST="$OLD"   # updated in place (git pull in the old folder): it stays where it is

# 1. Node.js 22 or newer (older ones no longer get security fixes)
need_node=1
if command -v node >/dev/null; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  if command -v apt-get >/dev/null; then
    echo "Installing Node.js 24..."
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Please install Node.js 22 or newer with your package manager, then run this again."; exit 1
  fi
fi
echo "Node $(node -v)"

# 2. Coming from an older version? It was called House Split and lived in ~/house-split.
#    Move it over once, data and settings included, and retire the old service.
if [ -d "$OLD" ] && [ ! -e "$DEST" ]; then
  echo "Moving $OLD to $DEST (your data comes along)..."
  systemctl --user stop house-split 2>/dev/null || true
  mv "$OLD" "$DEST"
elif [ -d "$OLD/data" ] && [ "$DEST" != "$OLD" ] && [ ! -d "$DEST/data" ]; then
  echo "Heads-up: $OLD/data holds data from an older version, and $DEST has none."
  echo "To keep it: stop here (Ctrl+C), run  mv $OLD/data $DEST/data  and run this again."
  sleep 5
fi
if [ -f "$UNITS/house-split.service" ]; then
  systemctl --user disable --now house-split >/dev/null 2>&1 || true
  rm -f "$UNITS/house-split.service"
fi

# 3. Copy the app, keeping any existing data and settings
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  tar -C "$SRC" --exclude=./data --exclude=./split-it.env --exclude=./.git -cf - . | tar -C "$DEST" -xf -
  [ -f "$SRC/split-it.env" ] && [ ! -f "$DEST/split-it.env" ] && cp "$SRC/split-it.env" "$DEST/split-it.env"
fi
rm -f "$DEST/house-split.service"
echo "App files in $DEST"
(cd "$DEST" && node --test test/split.test.js test/parse.test.js >/dev/null 2>&1 && echo "Self-check passed") || echo "Self-check had a problem (node --test test/*.test.js shows it). Carrying on."

# 4. Start on boot
mkdir -p "$UNITS"
sed "s#%h/split-it#$DEST#g" "$DEST/split-it.service" > "$UNITS/split-it.service"
systemctl --user daemon-reload
systemctl --user enable split-it >/dev/null
systemctl --user restart split-it
sudo loginctl enable-linger "$USER"
sleep 1
systemctl --user --no-pager status split-it | head -5 || true

# 5. Next steps
if ! node -e "process.exit(Object.keys(require('$DEST/data/users.json').users||{}).length?0:1)" 2>/dev/null; then
  echo
  echo "Now add yourself (the first person added runs the house). No restart needed:"
  echo "  cd $DEST && node server.js add-user YOURNAME"
fi
echo
echo "Open http://localhost:8080 on this computer."
echo "For phones away from home, see step 6 (Tailscale) in README.md."
