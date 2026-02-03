# 🐦 Flock

**Multi-agent swarm orchestration plugin for [OpenClaw](https://github.com/clawdbot/clawdbot).**

Flock turns a set of OpenClaw agents into a self-organizing team. Give a project to the orchestrator, and the workers plan, build, review, and test it autonomously — communicating through shared threads.

---

## Quick Start

### 1. Install

```bash
cd /path/to/openclaw-workspace
mkdir -p .openclaw/extensions
cd .openclaw/extensions
git clone https://github.com/flock-org/flock.git
cd flock
npm install
npm run build
```

### 2. Configure

Add to your `openclaw.json`:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "orchestrator",
        "model": { "primary": "anthropic/claude-sonnet-4-20250514" },
        "tools": { "alsoAllow": ["group:plugins"] },
        "workspace": "~/.openclaw/workspace-orchestrator"
      }
    ]
  },
  "plugins": {
    "load": [".openclaw/extensions/flock"],
    "entries": {
      "flock": {
        "enabled": true,
        "config": {
          "gatewayAgents": [
            { "id": "orchestrator", "role": "orchestrator" }
          ]
        }
      }
    }
  }
}
```

### 3. Start the gateway

```bash
openclaw gateway start
```

You now have a single orchestrator agent. Next, let's give it a team.

### 4. Create worker agents

Send a message to the orchestrator and ask it to create agents:

```
Create 5 worker agents:
1. pm        — archetype: project-manager,              model: anthropic/claude-sonnet-4-20250514
2. reviewer  — archetype: code-reviewer,                model: anthropic/claude-sonnet-4-20250514
3. dev-code  — archetype: code-first-developer,         model: anthropic/claude-sonnet-4-20250514
4. dev-prod  — archetype: production-first-developer,   model: anthropic/claude-sonnet-4-20250514
5. qa        — archetype: qa,                           model: anthropic/claude-sonnet-4-20250514

After creating all 5, restart the gateway.
```

The orchestrator calls `flock_create_agent` for each one, updates the gateway config, and calls `flock_restart_gateway`. After restart, all 6 agents are live.

### 5. Give them a project

```
I want to build a simple structured logging library for our Node.js projects.
Requirements:
- TypeScript, structured JSON output
- Log levels: debug, info, warn, error
- Each entry: timestamp, level, message, optional context
- Child loggers with inherited context
- Pretty-print for dev, JSON for production
- Zero external dependencies

Broadcast this to the team.
```

The orchestrator calls `flock_broadcast`, creates a shared thread, and notifies all workers. From there, they self-organize:

- **pm** writes a project plan and assigns roles
- **dev-code** proposes the API design
- **reviewer** catches design pitfalls early
- **dev-prod** focuses on production concerns
- **qa** plans the test strategy

All communication happens in shared threads. The work loop ticks every ~60s, waking agents when there's new activity.

---

## How It Works

### Architecture

```
Human Operator
      │
      ▼
┌─────────────┐
│ Orchestrator │ ← broadcasts projects, relays status
└──────┬──────┘
       │ flock_broadcast / flock_message
       ▼
┌──────────────────────────────────┐
│         Shared Threads           │
│  (persistent, append-only)       │
├──────────────────────────────────┤
│  pm  │ dev-code │ reviewer │ qa  │  ← workers read/write threads
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│          Work Loop               │
│  Ticks every ~60s ± jitter       │
│  Wakes AWAKE agents              │
│  Delivers thread notifications   │
│  Agents SLEEP when idle          │
└──────────────────────────────────┘
```

### Agent Lifecycle

1. **AWAKE** — Agent receives work loop ticks, reads threads, responds
2. **SLEEP** — Agent has no pending work; skipped by the scheduler to save cost
3. Broadcasts and direct messages auto-wake sleeping agents

### Archetypes

Each worker gets a personality from its archetype template:

| Archetype | Focus |
|-----------|-------|
| `project-manager` | Planning, task breakdown, coordination |
| `code-first-developer` | Implementation, code quality, APIs |
| `production-first-developer` | Reliability, performance, ops |
| `code-reviewer` | Design review, correctness, standards |
| `qa` | Testing strategy, validation, edge cases |

Custom archetypes can be added in `src/prompts/templates/soul/`.

### Tools

Agents get these Flock-specific tools:

| Tool | Who | Purpose |
|------|-----|---------|
| `flock_broadcast` | orchestrator | Broadcast a message to all/specific workers via thread |
| `flock_message` | any | Send a direct message to another agent |
| `flock_thread_post` | any | Post to a shared thread |
| `flock_thread_read` | any | Read thread history |
| `flock_discover` | any | List all registered agents |
| `flock_status` | any | Query agent states and swarm health |
| `flock_create_agent` | orchestrator | Create a new worker agent |
| `flock_decommission_agent` | orchestrator | Remove an agent |
| `flock_restart_gateway` | orchestrator | Restart to pick up config changes |
| `flock_workspace_*` | any | Read/write/list shared workspace files |
| `flock_sleep` / `flock_wake` | any | Manually control agent sleep state |

---

## Configuration Reference

```jsonc
{
  "plugins": {
    "entries": {
      "flock": {
        "enabled": true,
        "config": {
          // Where Flock stores its SQLite DB and data
          "dataDir": ".flock-data",

          // Agents managed by Flock
          "gatewayAgents": [
            { "id": "orchestrator", "role": "orchestrator" },
            { "id": "pm", "archetype": "project-manager" },
            { "id": "dev-code", "archetype": "code-first-developer" }
          ],

          // Work loop settings
          "workLoop": {
            "intervalMs": 60000,    // Base tick interval
            "jitterMs": 10000       // ± random jitter
          }
        }
      }
    }
  }
}
```

Each agent also needs an entry in `agents.list` with model and workspace:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "dev-code",
        "model": { "primary": "anthropic/claude-sonnet-4-20250514" },
        "tools": {
          "alsoAllow": ["group:plugins"],
          "sandbox": {
            "tools": {
              "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "web_search", "web_fetch"]
            }
          }
        },
        "workspace": "~/.openclaw/workspace-dev-code"
      }
    ]
  }
}
```

---

## Model Flexibility

Each agent can use a different LLM provider/model. Mix and match based on cost and capability:

```jsonc
// Example: heavy reasoning for orchestrator, fast models for workers
{ "id": "orchestrator", "model": { "primary": "anthropic/claude-opus-4-5" } }
{ "id": "pm",           "model": { "primary": "anthropic/claude-sonnet-4-20250514" } }
{ "id": "dev-code",     "model": { "primary": "openai/gpt-4.1" } }
{ "id": "dev-prod",     "model": { "primary": "google/gemini-2.5-flash" } }
{ "id": "qa",           "model": { "primary": "google/gemini-2.5-flash" } }
```

---

## Development

```bash
# Build (compiles TypeScript + copies prompt templates)
npm run build

# Tests
npm run test:unit           # Unit tests (vitest, runs on host)
npm run test:integration    # Integration tests (Docker)
npm run test:e2e            # Full E2E with real LLM calls (Docker)
npm test                    # All of the above
```

### Project Structure

```
src/
├── db/                  # SQLite + in-memory persistence
├── loop/                # Work loop scheduler
├── prompts/
│   └── templates/
│       ├── agents/      # Role-based prompts (orchestrator, worker, sysadmin)
│       └── soul/        # Archetype personality templates
├── tools/               # Flock tool definitions
├── transport/           # A2A executor + gateway integration
└── index.ts             # Plugin entry point
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite persistence for threads, tasks, agent state |

---

## License

MIT
