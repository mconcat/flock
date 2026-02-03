# Flock Live — Standalone OpenClaw + Flock Plugin
#
# Persistent agent swarm environment, fully isolated from host Clawdbot.
#
# Build:
#   docker compose -f docker-compose.live.yml build
# Run:
#   docker compose -f docker-compose.live.yml up -d
# Logs:
#   docker compose -f docker-compose.live.yml logs -f
# Stop:
#   docker compose -f docker-compose.live.yml down

FROM node:22-slim

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates curl gettext-base && \
    rm -rf /var/lib/apt/lists/*

# Git HTTPS fallback
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install openclaw globally
RUN npm install -g openclaw@2026.1.30

# Create directory structure
RUN mkdir -p \
    /root/.openclaw/agents/main/agent \
    /workspace/.openclaw/extensions/flock \
    /data/flock-homes \
    /data/flock-db

# --- Flock plugin build (layer-optimized) ---
WORKDIR /workspace/.openclaw/extensions/flock

# 1) Package files (cached unless deps change)
COPY package.json package-lock.json ./
RUN npm install

# 2) Source + config
COPY . .

# 3) Build TypeScript
RUN npx tsc

# 4) Prune dev deps
RUN npm prune --omit=dev

# --- Live environment config ---
WORKDIR /workspace

# Copy live-specific files
COPY live/openclaw.json /root/.openclaw/openclaw.json
COPY live/workspace/ /workspace/
COPY live/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 4000

ENTRYPOINT ["/entrypoint.sh"]
