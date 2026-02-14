# Nix Shared Store — Implementation Plan

## Problem

Flock sandbox containers are isolated per-agent. When agents need compilers, runtimes, or libraries:
- **RAM**: N identical installations × N containers = wasted memory
- **Persistence**: `readOnlyRoot: true` means root FS is immutable; agents can't `apt-get install`
- **Docker limitation**: Rebuilding images destroys writable layers; can't merge per-container state

## Solution: Nix Shared Store + Sysadmin-as-Sole-Installer

```
┌─────────────────────────────────────────────────────┐
│  flock-nix-daemon container (sole writer)           │
│  ┌──────────────────────────────────────────────┐   │
│  │  nix-daemon                                  │   │
│  │  /nix/store/  — content-addressed packages   │   │
│  │  /nix/var/nix/profiles/per-agent/            │   │
│  │    dev-code/   → symlink chain               │   │
│  │    qa/         → symlink chain               │   │
│  └──────────────────────────────────────────────┘   │
│        │ Docker volume (ro)                         │
│  ┌─────▼──────┐          ┌─────▼──────┐            │
│  │ dev-code   │          │ qa         │            │
│  │ sandbox    │          │ sandbox    │            │
│  │ /nix:ro    │          │ /nix:ro    │            │
│  │ PATH=.../  │          │ PATH=.../  │            │
│  │  dev-code/ │          │  qa/bin    │            │
│  │  bin:$PATH │          │  :$PATH    │            │
│  └────────────┘          └────────────┘            │
│                                                     │
│  sysadmin (unsandboxed) → docker exec nix-daemon    │
│    manages all profiles via exec                    │
└─────────────────────────────────────────────────────┘
```

### Why Docker Volume (not host bind mount)

- macOS Nix store contains Darwin binaries; Docker containers run Linux
- Docker volume managed by a Linux nix-daemon container works on both platforms
- No host-level Nix installation required

### Why Nix (not apt/apk)

- Content-addressed: same package = same hash = one copy in store
- Profiles: per-agent symlink chains from shared store = zero duplication
- Atomic: installs/rollbacks are instant symlink swaps
- GC-safe: profiles act as GC roots

## Feasibility (verified)

| Concern | Status | Detail |
|---------|--------|--------|
| Shared Docker volume (1 rw + N ro) | ✅ | Standard Docker feature |
| Nix symlinks resolve across containers | ✅ | Same mount path `/nix` → symlinks work |
| `nix profile install --profile <path>` | ✅ | Arbitrary profile paths supported |
| OpenClaw `docker.binds` | ✅ | Global + per-agent concatenated, `:ro` supported |
| OpenClaw `docker.env` | ✅ | Per-agent merged with global, can set PATH |
| OpenClaw `setupCommand` | ✅ | `docker exec sh -lc` after container start |
| `readOnlyRoot: true` compatibility | ✅ | `/nix` is bind mount, unaffected by readOnlyRoot |

## Changes

### 1. `src/cli/index.ts` — CLI changes

**New constants:**
```typescript
const NIX_COMPOSE = path.join(FLOCK_HOME, "docker-compose.nix.yml");
const NIX_VOLUME = "flock-nix";
const NIX_CONTAINER = "flock-nix-daemon";
```

**`flock init` (additions):**
1. Generate `~/.flock/docker-compose.nix.yml`
2. Run `docker compose -f ... up -d` to start nix-daemon
3. Add global `docker.binds: ["flock-nix:/nix:ro"]` to config
4. Save `nix: true` in flock plugin config

**`flock start` (additions):**
1. Before starting gateway, ensure nix-daemon container is running
2. If not, start it via docker compose

**`flock stop` (additions):**
1. After stopping gateway, stop nix-daemon container

**`flock add <id>` (additions):**
1. Create per-agent profile dir: `docker exec flock-nix-daemon mkdir -p /nix/var/nix/profiles/per-agent/<id>`
2. Add per-agent `docker.env.PATH` with nix profile bin dir prepended

**`flock update` (additions):**
1. Pull latest nix-daemon image: `docker compose -f ... pull`

### 2. `src/prompts/templates/agents/sysadmin.md` — Nix section

Add "Package Management via Nix" section:
- How to install: `docker exec flock-nix-daemon nix profile install --profile /nix/var/nix/profiles/per-agent/<id> nixpkgs#<pkg>`
- How to list: `nix profile list --profile ...`
- How to remove: `nix profile remove --profile ... <index>`
- Bulk installation pattern
- GC: `nix-collect-garbage --delete-older-than 7d`
- Triage classification (GREEN/YELLOW/RED)

### 3. `src/prompts/templates/agents/worker.md` — Infrastructure section update

Update to mention Nix:
- Packages are installed by sysadmin to your Nix profile
- They persist across sessions
- Shared efficiently when multiple agents need same tools

### 4. Generated file: `~/.flock/docker-compose.nix.yml`

```yaml
services:
  nix-daemon:
    image: nixos/nix:latest
    container_name: flock-nix-daemon
    command: ["nix-daemon"]
    volumes:
      - flock-nix:/nix
    restart: unless-stopped
volumes:
  flock-nix:
    name: flock-nix
```

## File Summary

| File | Change | Scope |
|------|--------|-------|
| `src/cli/index.ts` | Nix daemon lifecycle, per-agent PATH, global binds | Major |
| `src/prompts/templates/agents/sysadmin.md` | Add Nix package management section | Medium |
| `src/prompts/templates/agents/worker.md` | Update infrastructure interaction | Minor |

## Workflow Example

```bash
$ flock init
  → Clones OpenClaw, builds...
  → Generates docker-compose.nix.yml
  → docker compose up -d (starts nix-daemon)
  → Config includes global Nix bind mount
  ✅ Ready

$ flock add dev-code --role worker
  → Creates profile dir in nix-daemon container
  → Sets PATH=/nix/var/nix/profiles/per-agent/dev-code/bin:...

$ flock start
  → Ensures nix-daemon running → starts gateway

# Agent workflow:
dev-code: "@sysadmin I need gcc and Python 3.12"
sysadmin: (docker exec flock-nix-daemon nix profile install ...)
sysadmin: "✅ Installed. Available now."
# gcc already in /nix/store from dev-code install
qa: "@sysadmin I need gcc too"
sysadmin: (install → instant, just symlinks)
```

## Future Work (not in this PR)

- Declarative per-agent package sets via Nix flakes (`buildEnv`)
- `flock nix` subcommand for direct package management
- Custom binary cache (Cachix) for faster installs
- Auto-detection of commonly requested packages
