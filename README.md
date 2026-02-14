# Flock

**Multi-agent swarm orchestration for [OpenClaw](https://github.com/mconcat/openclaw).**

Flock turns a set of OpenClaw agents into a self-organizing team. Give a project to the orchestrator, and the workers plan, build, review, and test it autonomously — communicating through named channels with persistent history.

---

## Quick Start

### Install

```bash
npm install -g @flock-org/flock
```

### Initialize

```bash
flock init
```

This will:
1. Clone the OpenClaw fork into `~/.flock/openclaw/` and build it
2. Create a config at `~/.flock/config.json`
3. Set up an orchestrator agent
4. Prompt for model choice and gateway token

### Start

```bash
flock start
```

You now have a running gateway with an orchestrator agent. Next, add workers.

### Add Worker Agents

```bash
flock add architect --archetype code-first-developer --model anthropic/claude-opus-4-6
flock add coder    --archetype code-first-developer --model anthropic/claude-opus-4-6
flock add reviewer --archetype code-reviewer        --model anthropic/claude-sonnet-4-5
```

Restart the gateway to load new agents:

```bash
flock stop && flock start
```

### Give Them a Project

Send a chat completion request to the orchestrator:

```bash
curl http://localhost:3779/v1/chat/completions \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "orchestrator",
    "messages": [{"role": "user", "content": "Build a FizzBuzz implementation in Python. Create a channel, assign an architect and a coder."}]
  }'
```

The orchestrator creates a channel, assigns workers, and kicks off the project. Workers self-organize within the channel.

---

## CLI Reference

```bash
flock init                    # Set up Flock (~/.flock/)
flock start                   # Start the gateway
flock stop                    # Stop the running gateway
flock update                  # Update bundled OpenClaw to latest
flock add <id> [options]      # Add a new agent
flock remove <id>             # Remove an agent
flock list                    # List configured agents
flock status                  # Show Flock status
flock help                    # Show help
```

**Agent options:**
- `--role <role>` — worker, sysadmin, orchestrator (default: worker)
- `--model <model>` — e.g., `anthropic/claude-opus-4-6`
- `--archetype <name>` — e.g., code-reviewer, qa, code-first-developer

**Examples:**

```bash
# Add a code reviewer
flock add reviewer --archetype code-reviewer --model anthropic/claude-sonnet-4-5

# Add a developer
flock add dev-code --archetype code-first-developer --model anthropic/claude-opus-4-6

# Remove an agent
flock remove dev-code
```

---

## How It Works

### Architecture

```
~/.flock/
├── openclaw/               Bundled OpenClaw (git clone)
├── config.json             OpenClaw-format config
├── extensions/flock → ...  Symlink to Flock plugin
├── data/flock.db           SQLite database
└── workspaces/             Per-agent workspaces
    ├── orchestrator/
    ├── dev-code/
    └── ...
```

```
Human Operator (or Discord/Slack via Bridge)
      │
      ▼
┌─────────────┐
│ Orchestrator │ ← creates channels, assigns agents
└──────┬──────┘
       │ flock_channel_create / flock_channel_post
       ▼
┌──────────────────────────────────┐
│         Named Channels           │
│  (persistent, topic-based)       │
│  e.g. #project-logging           │
│       #bug-triage                │
├──────────────────────────────────┤
│  pm  │ dev-code │ reviewer │ qa  │  ← workers read/write channels
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│          Work Loop Scheduler     │
│  AWAKE: ticks every ~60s        │
│  SLEEP: slow poll every ~5min   │
│  Delta notifications per channel │
│  @mention auto-wake             │
└──────────────────────────────────┘
```

### Channels

Channels are the core communication primitive — named, topic-based conversation spaces with membership tracking:

```
Channel {
  channelId: "project-logging"
  name: "Project Logging"
  topic: "TypeScript structured logging library"
  members: ["pm", "dev-code", "reviewer", "human:alice"]
  archived: false
}
```

- **All channels are readable by all agents.** Membership determines who gets notified, not who can read.
- **Per-channel sessions**: Each agent gets an isolated LLM session per channel, preventing context pollution.
- **Delta notifications**: Only new messages are delivered, not full history.
- **Archive protocol**: 3-state machine (Active → Archiving → Archived) with agent readiness signaling.

### Agent Roles

| Role | Responsibility | Scope |
|------|---------------|-------|
| **Orchestrator** | Channel creation, agent assignment, swarm health, human communication | Organizational layer |
| **Sysadmin** | Sandbox permissions, resource triage (GREEN/YELLOW/RED), system operations | Infrastructure layer |
| **Worker** | Actual work — code, review, QA, planning. Archetype-based personality. | Channel work |

The orchestrator and sysadmin are **fully separated**: the orchestrator manages team structure, the sysadmin manages system permissions. This separation is the security model's foundation.

### Archetypes

Each worker gets a personality from its archetype template:

| Archetype | Focus |
|-----------|-------|
| `project-manager` | Planning, task breakdown, coordination |
| `code-first-developer` | Implementation, code quality, APIs |
| `production-first-developer` | Reliability, performance, ops |
| `code-reviewer` | Design review, correctness, standards |
| `qa` | Testing strategy, validation, edge cases |
| `deep-researcher` | In-depth research, analysis |
| `security-adviser` | Security review, threat modeling |

Custom archetypes can be added in `src/prompts/templates/soul/`.

### Agent Lifecycle

1. **AWAKE** — Agent receives work loop ticks (~60s), reads channels, responds
2. **SLEEP** — No pending work; slow-polled (~5min) to save cost
3. **@mention or DM** — Auto-wakes sleeping agents

### Tools

| Tool | Who | Purpose |
|------|-----|---------|
| `flock_channel_create` | orchestrator | Create a named channel with topic and members |
| `flock_channel_post` | any | Post to a channel |
| `flock_channel_read` | any | Read channel history |
| `flock_channel_list` | any | List channels (with filters) |
| `flock_channel_archive` | orchestrator | Start archive protocol or force-archive |
| `flock_archive_ready` | any | Signal readiness for channel archive |
| `flock_assign_members` | orchestrator | Add/remove channel members |
| `flock_message` | any | Send a direct message to another agent |
| `flock_discover` | any | List agents and their A2A Cards |
| `flock_status` | any | Query agent states and swarm health |
| `flock_bridge` | orchestrator | Bridge a channel to Discord/Slack |
| `flock_sleep` | any | Enter sleep state |
| `flock_update_card` | any | Update own A2A agent card |
| `flock_workspace_*` | any | Read/write/list shared workspace files |
| `flock_create_agent` | orchestrator | Create a new agent (human approval required) |
| `flock_decommission_agent` | orchestrator | Remove an agent |
| `flock_restart_gateway` | sysadmin | Restart to pick up config changes |
| `flock_migrate` | orchestrator | Multi-node agent migration |
| `flock_tasks` / `flock_task_respond` | any | Task management |
| `flock_audit` | any | Audit log queries |
| `flock_history` | any | Agent activity history |

### Discord / Slack Bridge

Flock channels can be bridged to external platforms:

- **Single-bot model**: One bot per platform represents all agents.
- **Discord**: Webhooks send messages with per-agent display names. Auto-created at bridge setup.
- **Slack**: `**[agentId]**` prefix for agent identification.
- **Bidirectional relay**: External messages → Flock channel, agent posts → external channel.
- **@mention detection**: `@agentId` in external messages auto-wakes sleeping agents.
- **Echo prevention**: In-memory TTL tracker prevents relay loops.
- **Archive sync**: Channel archive automatically deactivates bridges and notifies external channels.

---

## Configuration

Flock stores everything under `~/.flock/`:

```jsonc
{
  "plugins": {
    "load": { "paths": ["~/.flock/extensions/flock"] },
    "entries": {
      "flock": {
        "enabled": true,
        "config": {
          "dataDir": "~/.flock/data",
          "dbBackend": "sqlite",
          "gatewayAgents": [
            { "id": "orchestrator", "role": "orchestrator" },
            { "id": "dev-code", "archetype": "code-first-developer" }
          ],
          "gateway": { "port": 3779, "token": "<auto-generated>" }
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "dev-code",
        "model": { "primary": "anthropic/claude-opus-4-6" },
        "tools": {
          "alsoAllow": ["group:plugins"],
          "sandbox": {
            "tools": {
              "allow": ["exec", "process", "read", "write", "edit", "apply_patch",
                        "image", "sessions_*", "flock_*"]
            }
          }
        },
        "workspace": "~/.flock/workspaces/dev-code"
      }
    ]
  },
  "gateway": { "auth": { "token": "<same>" } }
}
```

### Model Flexibility

Each agent can use a different LLM provider/model:

```jsonc
{ "id": "orchestrator", "model": { "primary": "anthropic/claude-opus-4-6" } }
{ "id": "dev-code",     "model": { "primary": "anthropic/claude-opus-4-6" } }
{ "id": "reviewer",     "model": { "primary": "anthropic/claude-sonnet-4-5" } }
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
npm run test:e2e            # Gateway E2E (Docker, real LLM)
npm run test:e2e:crossnode  # Multi-container cross-node (Docker)
npm run test:standalone     # Full standalone lifecycle E2E (Docker, real LLM)
npm test                    # Unit + integration + e2e
```

### Standalone E2E Test

The standalone test validates the complete user-facing lifecycle inside Docker:

```
flock init → flock add → flock start → chat completion → multi-agent workflow → flock stop
```

Agents run inside OpenClaw sandbox containers (Docker-in-Docker via socket mount) with full isolation. The test verifies:
- CLI commands work end-to-end
- Multi-agent orchestration (channel creation, agent assignment)
- Sandbox containerization (agents run in Docker isolation)
- FizzBuzz workflow: orchestrator delegates to architect + coder, code is written and executed

```bash
# Infrastructure tests only (no LLM credentials needed):
docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit

# With LLM tests (setup token):
SETUP_TOKEN=sk-ant-oat01-... \
  docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit

# With LLM tests (auth-profiles.json):
AUTH_PROFILES=~/.openclaw/agents/main/agent/auth-profiles.json \
  docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit
```

### Project Structure

```
src/
├── bridge/              # Discord/Slack bidirectional relay
│   ├── index.ts         #   BridgeDeps, EchoTracker
│   ├── inbound.ts       #   External → Flock channel
│   ├── outbound.ts      #   Flock channel → external
│   └── discord-webhook.ts  Discord webhook utilities
├── cli/
│   └── index.ts         # Standalone CLI (init, start, stop, add, remove, ...)
├── db/                  # SQLite + in-memory persistence
│   ├── interface.ts     #   Types: Channel, Bridge, AgentLoop, etc.
│   ├── sqlite.ts        #   SQLite implementation
│   └── memory.ts        #   In-memory implementation (tests)
├── loop/
│   └── scheduler.ts     # AWAKE (60s) + SLEEP (5min) work loop
├── prompts/
│   └── templates/
│       ├── agents/      #   orchestrator.md, worker.md, sysadmin.md
│       └── soul/        #   Archetype personality templates
├── sysadmin/            # Sysadmin triage knowledge base
├── tools/
│   └── index.ts         # All flock_* tool definitions (~2400 lines)
├── transport/           # A2A executor + gateway integration
└── index.ts             # Plugin entry point + bridge hook registration

standalone/              # Standalone E2E test
├── Dockerfile           # Docker image with bundled OpenClaw
├── entrypoint.sh        # Auth + sandbox image setup
└── test-harness.mjs     # Full lifecycle test harness

tests/
├── db/                  # SQLite store tests
├── tools/               # Tool unit tests
│   ├── phase2-tools.test.ts
│   └── archive-protocol.test.ts
└── bridge/              # Bridge relay tests
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite persistence for channels, messages, agents, bridges |
| `@a2a-js/sdk` | Agent-to-Agent communication protocol |

---

## License

MIT
