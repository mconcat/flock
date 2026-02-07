# 🐦 Flock

**Multi-agent swarm orchestration plugin for [OpenClaw](https://github.com/clawdbot/clawdbot).**

Flock turns a set of OpenClaw agents into a self-organizing team. Give a project to the orchestrator, and the workers plan, build, review, and test it autonomously — communicating through shared threads.

---

## Quick Start

### Option A: One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/effortprogrammer/flock/main/install.sh | bash
```

Then initialize:

```bash
flock init
```

### Option B: Manual Install

```bash
# Clone to OpenClaw extensions
mkdir -p ~/.openclaw/extensions
git clone https://github.com/effortprogrammer/flock.git ~/.openclaw/extensions/flock
cd ~/.openclaw/extensions/flock

# Install and build
npm install
npm run build

# Initialize (auto-configures openclaw.json)
node dist/cli/index.js init
```

### Start the Gateway

```bash
openclaw gateway start
```

You now have a single orchestrator agent. Next, let's give it a team.

---

## CLI Reference

Flock includes a CLI for easy agent management — no manual JSON editing required.

```bash
flock init                    # Initialize Flock, auto-configure openclaw.json
flock add <id> [options]      # Add a new agent
flock remove <id>             # Remove an agent
flock list                    # List configured agents
flock status                  # Show configuration status
```

**Add agent options:**
- `--role <role>` — worker, sysadmin, orchestrator (default: worker)
- `--model <model>` — e.g., anthropic/claude-opus-4-5
- `--archetype <name>` — e.g., code-reviewer, qa, code-first-developer

**Examples:**

```bash
# Add a code reviewer with Gemini
flock add reviewer --role worker --model google-gemini-cli/gemini-3-flash-preview --archetype code-reviewer

# Add a developer with GPT
flock add dev-code --model openai-codex/gpt-5.2 --archetype code-first-developer

# Remove an agent
flock remove dev-code
```

---

### Create Worker Agents

**Option A: Using the CLI (no gateway restart needed after each add)**

```bash
flock add pm        --archetype project-manager              --model anthropic/claude-opus-4-5
flock add reviewer  --archetype code-reviewer                --model google-gemini-cli/gemini-3-flash-preview
flock add dev-code  --archetype code-first-developer         --model openai-codex/gpt-5.2
flock add dev-prod  --archetype production-first-developer   --model anthropic/claude-opus-4-5
flock add qa        --archetype qa                           --model google-gemini-cli/gemini-3-flash-preview

# Restart once to load all agents
openclaw gateway restart
```

**Option B: Ask the orchestrator**

Send a message to the orchestrator:

```
Create 5 worker agents:
1. pm        — archetype: project-manager,              model: anthropic/claude-opus-4-5
2. reviewer  — archetype: code-reviewer,                model: google-gemini-cli/gemini-3-flash-preview
3. dev-code  — archetype: code-first-developer,         model: openai-codex/gpt-5.2
4. dev-prod  — archetype: production-first-developer,   model: anthropic/claude-opus-4-5
5. qa        — archetype: qa,                           model: google-gemini-cli/gemini-3-flash-preview

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
          "dataDir": ".flock",

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
        "model": { "primary": "openai-codex/gpt-5.2" },
        "tools": {
          "alsoAllow": ["group:plugins"],
          "sandbox": {
            "tools": {
              "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "image", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status", "flock_*"]
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
{ "id": "pm",           "model": { "primary": "anthropic/claude-opus-4-5" } }
{ "id": "dev-code",     "model": { "primary": "openai-codex/gpt-5.2" } }
{ "id": "dev-prod",     "model": { "primary": "anthropic/claude-opus-4-5" } }
{ "id": "qa",           "model": { "primary": "google-gemini-cli/gemini-3-flash-preview" } }
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
