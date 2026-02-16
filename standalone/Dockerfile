# Flock Standalone CLI — E2E Test Container
#
# Tests the complete user-facing lifecycle:
#   flock init → flock add → flock start → chat completions → flock stop
#
# Usage:
#   docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit
#
# Requires auth-profiles.json with valid LLM credentials for chat completion tests.

# Docker CLI only (no daemon) — needed for sandbox container management via host socket
FROM docker:27-cli AS docker-cli

FROM node:22-slim

WORKDIR /flock-src

# Build tools for native modules (better-sqlite3) + git for clone
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git ca-certificates sqlite3 && \
    rm -rf /var/lib/apt/lists/*

RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

# --- Build Flock from source ---
COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json openclaw.plugin.json ./
# Cache-bust: changes to src/ should invalidate everything below
ARG CACHE_BUST=0
COPY src/ src/
RUN npx tsc && cp -r src/prompts/templates dist/prompts/ && cp openclaw.plugin.json dist/ && chmod +x dist/cli/index.js

# Link flock CLI globally (makes `flock` command available in PATH)
RUN npm link

# --- Pre-cache: clone and build OpenClaw fork ---
# flock init will detect the existing .git directory and do `git pull`
# instead of a full clone, saving several minutes per test run.
RUN mkdir -p /root/.flock && \
    git clone --branch fix/wire-after-tool-call-hook --depth 1 \
      https://github.com/mconcat/openclaw.git /root/.flock/openclaw && \
    cd /root/.flock/openclaw && npm install --no-fund --no-audit && npm run build

# Docker CLI + compose plugin — talks to host daemon via mounted /var/run/docker.sock
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

# Test harness
COPY standalone/test-harness.mjs /test/test-harness.mjs
COPY standalone/entrypoint.sh /test/entrypoint.sh
RUN chmod +x /test/entrypoint.sh

ENTRYPOINT ["/test/entrypoint.sh"]
CMD ["node", "/test/test-harness.mjs"]
