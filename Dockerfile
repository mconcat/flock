# Flock — Test & Development Container
#
# Usage:
#   docker compose -f docker-compose.test.yml up --build
#   docker compose -f docker-compose.test.yml run --rm test npx vitest run
#
# This image contains everything needed to build and test Flock
# without affecting the host system.

FROM node:22-slim

WORKDIR /flock

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ git && \
    rm -rf /var/lib/apt/lists/*

# Copy package files first (layer caching)
COPY package.json package-lock.json* ./

# Install all deps including devDependencies
RUN npm install

# Copy source and tests
COPY tsconfig.json vitest.config.ts vitest.integration.config.ts ./
COPY src/ src/
COPY tests/ tests/

# Default: run all tests
CMD ["npx", "vitest", "run"]
