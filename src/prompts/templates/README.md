# Flock Prompt Templates — OpenClaw Native Structure

These templates map to OpenClaw's workspace file structure. At provisioning time, the orchestrator assembles these into an agent's workspace.

**All prompts are defined as markdown files** in this directory, following a consistent pattern:
- Agent role instructions: `agents/*.md`
- Soul archetypes: `soul/*.md`
- Communication protocol: `COMMUNICATION.md`
- System context templates: `USER.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md`, `TOOLS.md`

Code modules load these markdown files at runtime rather than embedding prompts as inline strings, ensuring a single source of truth and easier maintenance.

## File Mapping

### Immutable Layer (agent cannot modify)

| Workspace File | Source | Notes |
|---|---|---|
| `AGENTS.md` | `agents/base.md` + `agents/{role}.md` | Layer 1 + Layer 2 merged. Role = sysadmin, worker, or orchestrator. |
| `USER.md` | `USER.md` | Flock system context + human operator info. Template vars filled at provision time. |
| `TOOLS.md` | `TOOLS.md` | Available tools and node info. Programmatically generated. |
| `COMMUNICATION.md` | `COMMUNICATION.md` | Message type expectations and communication protocol. Loaded programmatically. |

### Mutable Layer (agent can modify, lives in sandbox)

| Workspace File | Source | Notes |
|---|---|---|
| `SOUL.md` | `soul/{archetype}.md` | Initial seed from archetype template. Agent evolves freely. |
| `IDENTITY.md` | `IDENTITY.md` | Template vars filled, then agent maintains. |
| `MEMORY.md` | `MEMORY.md` | Starts near-empty. Agent's long-term memory. |
| `HEARTBEAT.md` | `HEARTBEAT.md` | Starts empty. Agent defines periodic tasks. |

### Symlink Structure

Mutable files live inside the sandbox. The workspace references them via symlink:

```
~/.openclaw/workspace/          ← OpenClaw reads bootstrap files from here
├── AGENTS.md                   ← immutable, direct file
├── USER.md                     ← immutable, direct file
├── TOOLS.md                    ← immutable, direct file
├── SOUL.md → /workspace/SOUL.md         ← symlink → sandbox
├── IDENTITY.md → /workspace/IDENTITY.md
├── MEMORY.md → /workspace/MEMORY.md
└── HEARTBEAT.md → /workspace/HEARTBEAT.md
```

## Provisioning Flow

1. **Select role** → determines which `agents/{role}.md` to append to `agents/base.md`
2. **Select archetype** → determines which `soul/{archetype}.md` becomes initial `SOUL.md`
3. **Fill template vars** → `{{AGENT_ID}}`, `{{NODE_ID}}`, etc.
4. **Write immutable files** → `AGENTS.md`, `USER.md`, `TOOLS.md` to workspace
5. **Write mutable seeds** → `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md` into sandbox
6. **Create symlinks** → workspace → sandbox for mutable files

## Archetypes

| Archetype | File | Focus |
|---|---|---|
| Code-First Developer | `soul/code-first-developer.md` | Fast iteration, no fallbacks, FP, real implementations only |
| Production-First Developer | `soul/production-first-developer.md` | Backward compat, defensive coding, security, observability |
| Code Reviewer | `soul/code-reviewer.md` | Code quality, DRY, fallback detection, type safety |
| QA | `soul/qa.md` | End product verification, live testing, user perspective |
| Deep Researcher | `soul/deep-researcher.md` | Thorough investigation, source-driven, synthesis |
| Ideation | `soul/ideation.md` | Generative thinking, lateral connections, brainstorming |
| Product Developer | `soul/product-developer.md` | User-centric, pragmatic tradeoffs, iterative |
| Project Manager | `soul/project-manager.md` | Coordination, planning, unblocking |
| Security Adviser | `soul/security-adviser.md` | Risk assessment, threat modeling, defense in depth |
