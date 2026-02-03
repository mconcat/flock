# Flock E2E — openclaw + flock plugin, multi-node capable
#
# Supports running as:
#   - source-node: openclaw gateway with flock plugin (port 3779)
#   - target-node: openclaw gateway with flock plugin (port 3780)
#   - test-runner: executes the E2E test harness against both nodes

FROM node:22-slim

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Git: use HTTPS instead of SSH for GitHub (no SSH key in container)
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# Install openclaw globally
RUN npm install -g openclaw@2026.1.30

# Create openclaw state dir + workspace + agent auth dir
RUN mkdir -p /root/.openclaw/agents/main/agent /workspace/.openclaw/extensions/flock

# --- Layer-optimized flock install ---
# 1) Copy only package files first (npm install cached unless deps change)
WORKDIR /workspace/.openclaw/extensions/flock
COPY package.json package-lock.json ./
RUN npm install

# 2) Copy source + config (only this layer invalidates on code changes)
COPY . .

# 3) Build TypeScript → dist/
RUN npx tsc

# 4) Prune dev dependencies
RUN npm prune --omit=dev

# Copy E2E configs (source + target) and test harness
WORKDIR /workspace
COPY e2e/openclaw.json /root/.openclaw/openclaw.json
COPY e2e/openclaw-target.json /root/.openclaw/openclaw-target.json
COPY e2e/workspace/ /workspace/
COPY e2e/test-harness.mjs /workspace/test-harness.mjs
COPY e2e/entrypoint.sh /workspace/entrypoint.sh
RUN chmod +x /workspace/entrypoint.sh

ENTRYPOINT ["/workspace/entrypoint.sh"]
CMD ["node", "/workspace/test-harness.mjs"]
