/**
 * Directory convention constants and utilities.
 *
 * Standard home layout (single-directory workspace model):
 *
 *   workspace/         (RW*)  OpenClaw workspace — all files live here
 *   node/              (RW)   Node-specific state
 *   agent/             (RW)   Agent-portable knowledge/toolkit
 *   work/              (RW)   Project workspace
 *   run/               (RW)   Runtime temp (cleaned on freeze)
 *   log/               (RW)   Local logs
 *   audit/             (AO)   Append-only audit
 *   secrets/           (RW)   Access-restricted credentials
 *
 * *workspace/ is mounted rw so the agent can modify mutable files (SOUL.md, etc.).
 *  Immutable files (AGENTS.md, USER.md) are individually bind-mounted ro
 *  on top, so Docker overlays them as read-only within the rw directory.
 *
 * Communication is handled via A2A protocol (HTTP/JSON-RPC),
 * not file-based inbox/outbox.
 */

/** Container-internal paths (what the agent sees). */
export const CONTAINER_PATHS = {
  /** OpenClaw workspace — all files (immutable + mutable) live here. */
  openclawWorkspace: "~/.openclaw/workspace",
  node: "/flock/node",
  agent: "/flock/agent",
  work: "/flock/work",
  run: "/flock/run",
  log: "/flock/log",
  audit: "/flock/audit",
  secrets: "/flock/secrets",
} as const;

/** Immutable workspace files — written at provisioning, agent cannot modify. */
export const IMMUTABLE_WORKSPACE_FILES = [
  "AGENTS.md",
  "USER.md",
] as const;

/** Mutable workspace files — seeded at provisioning, agent can modify.
 *  These live in workspace/ alongside immutable files but are not ro-mounted. */
export const MUTABLE_WORKSPACE_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "MEMORY.md",
  "HEARTBEAT.md",
  "TOOLS.md",
] as const;

/** Sub-directories within the agent layer. */
export const AGENT_SUBDIRS = [
  "toolkit",
  "playbooks",
  "knowledge/active",
  "knowledge/archive",
] as const;

/** Sub-directories within the node layer. */
export const NODE_SUBDIRS = [
  "notes",
] as const;

/** All top-level directories to create for a new home. */
export const HOME_DIRECTORIES = [
  "workspace",
  "node",
  "node/notes",
  "agent",
  "agent/toolkit",
  "agent/playbooks",
  "agent/knowledge",
  "agent/knowledge/active",
  "agent/knowledge/archive",
  "work",
  "run",
  "log",
  "audit",
  "secrets",
] as const;
