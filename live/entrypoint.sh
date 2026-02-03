#!/bin/sh
set -e

echo "=== Flock Live Environment ==="
echo "Port: 4000"
echo "Topology: central"

# Copy host auth credentials if mounted (read-only mount → writable copy)
if [ -f /tmp/host-auth-profiles.json ]; then
  cp /tmp/host-auth-profiles.json /root/.openclaw/agents/main/agent/auth-profiles.json
  echo "Auth: copied from host mount"
else
  echo "Auth: ⚠️  No auth-profiles.json mounted — LLM calls will fail"
  echo "       Mount with: -v \$HOME/.clawdbot/agents/main/agent/auth-profiles.json:/tmp/host-auth-profiles.json:ro"
fi

# Ensure data directories exist
mkdir -p /data/flock-homes /data/flock-db

# Substitute environment variables in config (e.g., FLOCK_GATEWAY_TOKEN)
if command -v envsubst >/dev/null 2>&1; then
  envsubst < /root/.openclaw/openclaw.json > /tmp/openclaw-resolved.json
  mv /tmp/openclaw-resolved.json /root/.openclaw/openclaw.json
  echo "Config: environment variables resolved"
else
  echo "Config: ⚠️  envsubst not found, using config as-is"
fi

echo "Starting gateway..."
echo ""

# Start openclaw gateway in foreground
exec openclaw gateway run --dev --verbose
