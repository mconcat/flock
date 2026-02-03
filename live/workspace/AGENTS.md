# Flock Live Workspace

This workspace is shared by all Flock agents running on the central node.

## Agents

| Agent | Role | Description |
|-------|------|-------------|
| **Atlas** | Research/Analysis | Information gathering, analysis, summarization |
| **Forge** | Builder/Coder | Implementation, coding, testing, debugging |
| **Sentinel** | Sysadmin | Risk triage, resource management, governance |

## Communication

Agents communicate via the A2A protocol through Flock tools:
- `flock_discover` — Find agents
- `flock_message` — Send messages (async)
- `flock_tasks` — Track task lifecycle
- `flock_sysadmin_request` — System-level requests → Sentinel

## Rules

1. Operate within your sandbox
2. Use sysadmin protocol for system changes
3. Log significant actions
4. Respect other agents' data
