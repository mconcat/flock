#!/bin/sh
# Flock Standalone E2E — set up auth credentials for LLM tests
#
# Supports two methods (checked in priority order):
#   1. SETUP_TOKEN env var — raw Claude setup token (sk-ant-oat01-...)
#   2. AUTH_PROFILES volume — mounted auth-profiles.json file

AUTH_DIR="/root/.flock/agents/main/agent"
AUTH_FILE="$AUTH_DIR/auth-profiles.json"

if [ -n "$SETUP_TOKEN" ]; then
  # Method 1: Generate auth-profiles.json from raw setup token
  mkdir -p "$AUTH_DIR"
  cat > "$AUTH_FILE" <<AUTHEOF
{
  "version": 1,
  "profiles": {
    "anthropic:default": {
      "type": "token",
      "provider": "anthropic",
      "token": "$SETUP_TOKEN"
    }
  }
}
AUTHEOF
  echo "[entrypoint] Auth profiles generated from SETUP_TOKEN"
elif [ -f /tmp/host-auth-profiles.json ] && [ -s /tmp/host-auth-profiles.json ]; then
  # Method 2: Copy mounted auth-profiles.json
  # -s checks non-empty (handles /dev/null fallback from docker-compose)
  mkdir -p "$AUTH_DIR"
  cp /tmp/host-auth-profiles.json "$AUTH_FILE"
  echo "[entrypoint] Auth profiles installed from mounted file"
else
  echo "[entrypoint] No credentials provided — LLM tests will be skipped"
  echo "[entrypoint]   Pass SETUP_TOKEN=sk-ant-oat01-... or mount AUTH_PROFILES"
fi

# Build sandbox image with Python3 — needed for agents to run scripts inside
# sandbox containers.  The default image (debian:bookworm-slim) has no Python.
# This image is named to match OpenClaw's default so it won't try to pull.
if docker info > /dev/null 2>&1; then
  echo "[entrypoint] Building sandbox image (openclaw-sandbox:bookworm-slim) ..."
  docker build -q -t openclaw-sandbox:bookworm-slim - <<'SBXEOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
SBXEOF
  echo "[entrypoint] Sandbox image ready"

  # Prepare shared directory for sandbox bind mounts
  mkdir -p /tmp/flock-e2e/shared
  mkdir -p /tmp/flock-e2e/sandboxes
else
  echo "[entrypoint] WARNING: Docker not available — sandbox tests will fail"
fi

exec "$@"
