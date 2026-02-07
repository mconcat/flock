#!/bin/bash
# Flock Quick Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/effortprogrammer/flock/main/install.sh | bash

set -e

FLOCK_DIR="$HOME/.openclaw/extensions/flock"

echo "🐦 Installing Flock..."

# Create extensions directory
mkdir -p "$HOME/.openclaw/extensions"

# Clone or update
if [ -d "$FLOCK_DIR" ]; then
  echo "   Updating existing installation..."
  cd "$FLOCK_DIR"
  git pull --ff-only
else
  echo "   Cloning repository..."
  git clone https://github.com/effortprogrammer/flock.git "$FLOCK_DIR"
  cd "$FLOCK_DIR"
fi

# Install and build
echo "   Installing dependencies..."
npm install --silent

echo "   Building..."
npm run build --silent

# Link globally (optional, for 'flock' command)
echo "   Linking CLI..."
if npm link --silent 2>/dev/null; then
  LINK_OK=true
else
  LINK_OK=false
fi

echo ""
echo "✅ Flock installed successfully!"
echo ""
echo "🚀 Next steps:"
if [ "$LINK_OK" = true ]; then
  echo "   1. Run: flock init"
  echo "   2. Start gateway: openclaw gateway start"
else
  echo "   ⚠️ Global CLI link failed. You can still run Flock directly."
  echo "   1. Run: $FLOCK_DIR/dist/cli/index.js init"
  echo "   2. Start gateway: openclaw gateway start"
fi
echo ""
echo "   Or run directly: $FLOCK_DIR/dist/cli/index.js init"
