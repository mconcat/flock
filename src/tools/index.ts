/**
 * Flock tools — agent-facing tools for swarm interaction.
 *
 * Tools:
 * - flock_status: Query home status and swarm overview
 * - flock_lease: Request/renew/release a home lease
 * - flock_audit: Query audit log
 * - flock_provision: Provision a new home directory
 * - flock_sysadmin_protocol: Load sysadmin protocol documents
 * - flock_sysadmin_request: Send a request to sysadmin via A2A
 * - flock_message: Send messages to other agents via A2A
 */

import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { toResult } from "./result.js";

import type { PluginApi, ToolDefinition, ToolResultOC, AuditLevel, PluginLogger } from "../types.js";
import { isAuditLevel } from "../types.js";
import type { FlockConfig } from "../config.js";
import type { HomeManager } from "../homes/manager.js";
import type { HomeProvisioner } from "../homes/provisioner.js";
import { formatBindMountsForConfig } from "../homes/provisioner.js";
import type { AuditLog } from "../audit/log.js";
import type { HomeFilter, AuditFilter, TaskStore, TaskFilter, TaskRecord, ChannelStore, ChannelMessageStore, BridgeStore, BridgePlatform, BridgeFilter } from "../db/index.js";
import { isTaskState, TASK_STATES } from "../db/index.js";
import { validateId } from "../homes/utils.js";
import { uniqueId } from "../utils/id.js";
import { getSysadminPrompt, loadSysadminProtocol } from "../sysadmin/loader.js";
import type { A2AClient } from "../transport/client.js";
import type { A2AServer } from "../transport/server.js";
import type { TriageResult } from "../transport/types.js";
import { isDataPart, userMessage, dataPart } from "../transport/a2a-helpers.js";
import type { MigrationEngine } from "../migration/engine.js";
import type { MigrationOrchestrator } from "../migration/orchestrator.js";
import type { MigrationReason } from "../migration/types.js";
import type { AgentSkill } from "../transport/types.js";
import { createCreateAgentTool, createDecommissionAgentTool, createRestartGatewayTool } from "./agent-lifecycle.js";
import { createWorkspaceTools } from "./workspace.js";
import type { AgentLoopStore } from "../db/index.js";
import type { WorkLoopScheduler } from "../loop/scheduler.js";
import { createChannelWebhook, createDiscordChannel } from "../bridge/discord-webhook.js";
import type { SendExternalFn } from "../bridge/index.js";

/** Maximum number of rows any query tool will return. */
const QUERY_LIMIT_MAX = 100;

export interface ToolDeps {
  config: FlockConfig;
  homes: HomeManager;
  audit: AuditLog;
  provisioner: HomeProvisioner;
  /** A2A client for agent communication. */
  a2aClient?: A2AClient;
  /** A2A server (for card registry access). */
  a2aServer?: A2AServer;
  /** The agentId of the sysadmin on this node. */
  sysadminAgentId?: string;
  /** Task store for async task lifecycle tracking. */
  taskStore?: TaskStore;
  /** Channel metadata store for named conversation spaces. */
  channelStore?: ChannelStore;
  /** Channel message store for shared channel history. */
  channelMessages?: ChannelMessageStore;
  /** Migration engine for triggering migrations. */
  migrationEngine?: MigrationEngine;
  /** Migration orchestrator for running complete migrations. */
  migrationOrchestrator?: MigrationOrchestrator;
  /** Logger instance for gateway session creation. */
  logger?: PluginLogger;
  /** Base directory for shared workspace vaults (enables workspace tools when set). */
  vaultsBasePath?: string;
  /** Agent loop state store for AWAKE/SLEEP management. */
  agentLoop?: AgentLoopStore;
  /** Work loop scheduler for channel tracking. */
  workLoopScheduler?: WorkLoopScheduler;
  /** Bridge store for Discord/Slack channel mappings. */
  bridgeStore?: BridgeStore;
  /** Discord bot token — used to auto-create webhooks for bridge channels. */
  discordBotToken?: string;
  /** Send function for bridged external platforms (wired at runtime). */
  sendExternal?: SendExternalFn;
}

// ============================================================================
// TypeBox Schemas — one per tool
// ============================================================================

const FlockStatusParams = Type.Object({
  homeId: Type.Optional(Type.String({ description: "Specific home to query (format: agentId@nodeId)" })),
  nodeId: Type.Optional(Type.String({ description: "Filter homes by node" })),
  state: Type.Optional(Type.String({ description: "Filter homes by state (IDLE, LEASED, ACTIVE, FROZEN, etc.)" })),
});

const FlockLeaseParams = Type.Object({
  action: Type.Union([
    Type.Literal("request"),
    Type.Literal("renew"),
    Type.Literal("release"),
    Type.Literal("freeze"),
  ], { description: "Lease action to perform" }),
  agentId: Type.Optional(Type.String({ description: "Agent requesting the lease" })),
  nodeId: Type.Optional(Type.String({ description: "Target node for the home" })),
  homeId: Type.Optional(Type.String({ description: "Existing home ID (for renew/release/freeze)" })),
  durationMs: Type.Optional(Type.Number({ description: "Lease duration in milliseconds. Default: 1 hour" })),
  reason: Type.Optional(Type.String({ description: "Reason for the action" })),
});

const FlockAuditParams = Type.Object({
  agentId: Type.Optional(Type.String({ description: "Filter by agent" })),
  homeId: Type.Optional(Type.String({ description: "Filter by home" })),
  level: Type.Optional(Type.Union([
    Type.Literal("GREEN"),
    Type.Literal("YELLOW"),
    Type.Literal("RED"),
  ], { description: "Filter by risk level" })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return. Default: 20" })),
});

const FlockProvisionParams = Type.Object({
  agentId: Type.String({ description: "Agent ID for the new home" }),
  nodeId: Type.String({ description: "Node ID where the home will be created" }),
});

const FlockSysadminProtocolParams = Type.Object({
  section: Type.Optional(Type.Union([
    Type.Literal("triage"),
    Type.Literal("knowledge"),
    Type.Literal("meta"),
    Type.Literal("all"),
  ], { description: "Which section to load. Default: all" })),
});

const FlockSysadminRequestParams = Type.Object({
  request: Type.String({ description: "Natural language description of what you need (what + why)" }),
  context: Type.Optional(Type.String({ description: "Additional context (project, environment, etc.)" })),
  urgency: Type.Optional(Type.Union([
    Type.Literal("low"),
    Type.Literal("normal"),
    Type.Literal("high"),
  ], { description: "Urgency level. Default: normal" })),
  project: Type.Optional(Type.String({ description: "Related project identifier" })),
});

const FlockMessageParams = Type.Object({
  to: Type.String({ description: "Target agent ID. Use flock_discover to find available agents." }),
  message: Type.String({ description: "Natural language message to send to the agent." }),
  contextData: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional structured data to attach alongside the message as an A2A DataPart." })),
});

const FlockChannelCreateParams = Type.Object({
  channelId: Type.String({ description: "Human-readable channel ID (alphanumeric + dashes, e.g. 'project-logging-lib')." }),
  topic: Type.String({ description: "Channel purpose description (injected into agent prompts for context)." }),
  members: Type.Array(Type.String(), { description: "Initial member agent IDs. The caller is automatically included." }),
  message: Type.Optional(Type.String({ description: "Optional first message to post after channel creation." })),
});

const FlockChannelPostParams = Type.Object({
  channelId: Type.String({ description: "Channel ID to post to." }),
  message: Type.String({ description: "Message to post." }),
  notify: Type.Optional(Type.Boolean({ description: "If true (default), notify other channel members. Set to false to post silently." })),
});

const FlockChannelReadParams = Type.Object({
  channelId: Type.String({ description: "Channel ID to read." }),
  after: Type.Optional(Type.Number({ description: "Only return messages with seq greater than this value (for delta reading)." })),
});

const FlockChannelListParams = Type.Object({
  member: Type.Optional(Type.String({ description: "Filter channels containing this member agent ID." })),
  archived: Type.Optional(Type.Boolean({ description: "Filter by archive state. Omit for all channels." })),
});

const FlockAssignMembersParams = Type.Object({
  channelId: Type.String({ description: "Channel to modify membership of." }),
  add: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to add to the channel." })),
  remove: Type.Optional(Type.Array(Type.String(), { description: "Agent IDs to remove from the channel." })),
});

const FlockChannelArchiveParams = Type.Object({
  channelId: Type.String({ description: "Channel ID to archive." }),
  force: Type.Optional(Type.Boolean({ description: "If true, archive immediately without waiting for members. Default: false." })),
});

const FlockArchiveReadyParams = Type.Object({
  channelId: Type.String({ description: "Channel ID to signal readiness for." }),
});

const FlockDiscoverParams = Type.Object({
  query: Type.Optional(Type.String({ description: "Free-text search across agent names, descriptions, and skills" })),
  role: Type.Optional(Type.Union([
    Type.Literal("worker"),
    Type.Literal("sysadmin"),
    Type.Literal("orchestrator"),
  ], { description: "Filter by agent role" })),
  skill: Type.Optional(Type.String({ description: "Filter by skill tag (e.g. 'implement', 'review', 'research')" })),
  limit: Type.Optional(Type.Number({ description: "Max results to return. Default: 20" })),
});

const FlockHistoryParams = Type.Object({
  agentId: Type.Optional(Type.String({ description: "Filter by agent (as sender or receiver)" })),
  messageType: Type.Optional(Type.String({ description: "Filter by message type" })),
  state: Type.Optional(Type.Union([
    Type.Literal("submitted"),
    Type.Literal("working"),
    Type.Literal("input-required"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("canceled"),
  ], { description: "Filter by task state" })),
  since: Type.Optional(Type.Number({ description: "Only tasks created after this epoch ms timestamp" })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return. Default: 20" })),
});

const FlockTasksParams = Type.Object({
  direction: Type.Optional(Type.Union([
    Type.Literal("sent"),
    Type.Literal("received"),
    Type.Literal("all"),
  ], { description: "Filter by direction: sent (tasks you created), received (tasks assigned to you), all (both). Default: all" })),
  state: Type.Optional(Type.Union([
    Type.Literal("submitted"),
    Type.Literal("working"),
    Type.Literal("input-required"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("canceled"),
  ], { description: "Filter by task state" })),
  limit: Type.Optional(Type.Number({ description: "Max tasks to return. Default: 20" })),
});

const FlockTaskRespondParams = Type.Object({
  taskId: Type.String({ description: "The task ID to respond to" }),
  response: Type.String({ description: "Your response to the clarification question" }),
});

const FlockMigrateParams = Type.Object({
  targetAgentId: Type.String({ description: "The agent to migrate (format: agentId, not homeId)" }),
  targetNodeId: Type.String({ description: "The destination node ID" }),
  reason: Type.Optional(Type.String({ description: "Reason for migration (default: 'orchestrator_rebalance')" })),
});

const FlockUpdateCardParams = Type.Object({
  name: Type.Optional(Type.String({ description: "New display name for the agent" })),
  description: Type.Optional(Type.String({ description: "New description of the agent's capabilities" })),
  skills: Type.Optional(Type.String({
    description:
      "JSON array of AgentSkill objects. Each skill: { id, name, description?, tags?: string[] }. " +
      "Replaces the entire skill set.",
  })),
});

const FlockSleepParams = Type.Object({
  reason: Type.Optional(Type.String({ description: "Why you're going to sleep (e.g. 'no pending work', 'waiting for external input')" })),
});

const FlockBridgeParams = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("remove"),
    Type.Literal("list"),
    Type.Literal("pause"),
    Type.Literal("resume"),
  ], { description: "Action to perform." }),
  channelId: Type.Optional(Type.String({ description: "Flock channel ID (required for create)." })),
  platform: Type.Optional(Type.Union([
    Type.Literal("discord"),
    Type.Literal("slack"),
  ], { description: "External platform (required for create)." })),
  externalChannelId: Type.Optional(Type.String({ description: "Discord/Slack channel ID to bridge to (required for create, unless createChannel is true)." })),
  createChannel: Type.Optional(Type.Boolean({ description: "If true, auto-create a Discord text channel in the specified guild. Requires guildId and platform='discord'." })),
  guildId: Type.Optional(Type.String({ description: "Discord guild (server) ID. Required when createChannel is true." })),
  channelName: Type.Optional(Type.String({ description: "Name for the auto-created Discord channel. Defaults to the Flock channelId. Only used with createChannel=true." })),
  categoryId: Type.Optional(Type.String({ description: "Discord category ID to place the auto-created channel in. Only used with createChannel=true." })),
  accountId: Type.Optional(Type.String({ description: "Optional: specific bot account ID for sending messages." })),
  bridgeId: Type.Optional(Type.String({ description: "Bridge ID (required for remove/pause/resume)." })),
});

// ============================================================================
// Adapter: AgentTool → ToolDefinition for OpenClaw plugin registration
// ============================================================================

/**
 * Adapt an AgentTool to the legacy ToolDefinition interface expected by
 * OpenClaw's `api.registerTool()`. The execute signature is compatible since
 * AgentToolResult's content type is structurally assignable to ToolResultOC's
 * widened content type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool array element
function agentToolToDefinition(tool: AgentTool<any>): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (data: unknown) => void): Promise<ToolResultOC> {
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

/**
 * Wrap a tool definition so that the caller's agentId (from OpenClaw context)
 * is injected into every tool call's params as `agentId`. This way tools don't
 * need to rely on the LLM passing agentId — it comes from the session identity.
 */
function wrapToolWithAgentId(tool: ToolDefinition, agentId: string | undefined): ToolDefinition {
  const resolvedId = agentId ?? "unknown";
  return {
    ...tool,
    async execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      // Inject _callerAgentId from session context — uses underscore prefix
      // to avoid collisions with user-facing params like agentId (used as filter in flock_history).
      // Tools should read _callerAgentId first, then fall back to params.agentId.
      params._callerAgentId = resolvedId;
      return tool.execute(toolCallId, params);
    },
  };
}

/**
 * Resolve the effective agent ID from OpenClaw context.
 * Falls back to parsing the session key if agentId is "main".
 */
function resolveCtxAgentId(ctx: { agentId?: string; sessionKey?: string }): string {
  if (ctx.agentId && ctx.agentId !== "main") return ctx.agentId;
  // Parse session key: "agent:{id}:{rest}"
  if (ctx.sessionKey) {
    const parts = ctx.sessionKey.split(":");
    if (parts[0] === "agent" && parts[1] && parts[1] !== "main") return parts[1];
  }
  return ctx.agentId ?? "unknown";
}

export function registerFlockTools(api: PluginApi, deps: ToolDeps): void {
  // All tools are registered as factories so OpenClaw provides per-request
  // ctx.agentId — injected into tool params for caller identification.
  const agentTools = [
    createStatusTool(deps),
    createLeaseTool(deps),
    createAuditTool(deps),
    createProvisionTool(deps),
    createSysadminProtocolTool(),
    createSysadminRequestTool(deps),
    createMessageTool(deps),
    createChannelCreateTool(deps),
    createChannelPostTool(deps),
    createChannelReadTool(deps),
    createChannelListTool(deps),
    createAssignMembersTool(deps),
    createChannelArchiveTool(deps),
    createArchiveReadyTool(deps),
    createDiscoverTool(deps),
    createHistoryTool(deps),
    createTasksTool(deps),
    createTaskRespondTool(deps),
    createMigrateTool(deps),
    createUpdateCardTool(deps),
    createSleepTool(deps),
    createBridgeTool(deps),
  ];

  for (const tool of agentTools) {
    const def = agentToolToDefinition(tool);
    api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => {
      console.log(`[FLOCK-FACTORY] tool="${def.name}" ctx.agentId="${ctx.agentId}" ctx.sessionKey="${ctx.sessionKey}"`);
      return wrapToolWithAgentId(def, resolveCtxAgentId(ctx));
    });
  }

  // Lifecycle tools need the full ctx for authorization checks
  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => createCreateAgentTool(deps, ctx.agentId, ctx.sessionKey));
  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => createDecommissionAgentTool(deps, ctx.agentId, ctx.sessionKey));
  api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => createRestartGatewayTool(deps, ctx.agentId, ctx.sessionKey));

  // Workspace tools — shared vault access for agents (enabled when vaultsBasePath is configured)
  if (deps.vaultsBasePath) {
    const workspaceTools = createWorkspaceTools({
      ...deps,
      vaultsBasePath: deps.vaultsBasePath,
    });
    for (const tool of workspaceTools) {
      const def = agentToolToDefinition(tool);
      api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => {
        console.log(`[FLOCK-FACTORY] tool="${def.name}" ctx.agentId="${ctx.agentId}" ctx.sessionKey="${ctx.sessionKey}"`);
        return wrapToolWithAgentId(def, resolveCtxAgentId(ctx));
      });
    }
  }
}

// ============================================================================
// Tool implementations
// ============================================================================

// --- flock_status ---

function createStatusTool(deps: ToolDeps): AgentTool<typeof FlockStatusParams, Record<string, unknown>> {
  return {
    name: "flock_status",
    label: "Flock Status",
    description:
      "Query the swarm status. Returns home states, active leases, and overview. " +
      "Use without arguments for a full overview, or filter by homeId/nodeId/state.",
    parameters: FlockStatusParams,
    async execute(_toolCallId: string, params: Static<typeof FlockStatusParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const homeId = typeof params.homeId === "string" ? params.homeId.trim() : "";
      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
      const state = typeof params.state === "string" ? params.state.trim().toUpperCase() : "";

      if (homeId) {
        const home = deps.homes.get(homeId);
        if (!home) {
          return toResult({ ok: false, error: `home not found: ${homeId}` });
        }
        return toResult({
          ok: true,
          output: formatHome(home),
          data: { home },
        });
      }

      const filter: HomeFilter = {};
      if (nodeId) filter.nodeId = nodeId;
      if (state) {
        if (!isValidHomeState(state)) {
          return toResult({ ok: false, error: `Invalid state: ${state}. Valid: ${VALID_HOME_STATES.join(", ")}` });
        }
        filter.state = state;
      }

      const homes = deps.homes.list(filter);
      const lines = [
        `## Flock Status`,
        `Homes: ${homes.length} | Audit entries: ${deps.audit.count()}`,
        "",
        ...homes.map(formatHome),
      ];

      return toResult({ ok: true, output: lines.join("\n"), data: { homes } });
    },
  };
}

function formatHome(home: { homeId: string; state: string; agentId: string; nodeId: string; leaseExpiresAt: number | null }): string {
  const lease = home.leaseExpiresAt
    ? `expires ${new Date(home.leaseExpiresAt).toISOString()}`
    : "no lease";
  return `- **${home.homeId}** [${home.state}] — ${lease}`;
}

// --- flock_lease ---

function createLeaseTool(deps: ToolDeps): AgentTool<typeof FlockLeaseParams, Record<string, unknown>> {
  return {
    name: "flock_lease",
    label: "Flock Lease",
    description:
      "Manage home leases. Actions: request (create/lease a home), renew (extend lease), " +
      "release (give up lease), freeze (emergency freeze).",
    parameters: FlockLeaseParams,
    async execute(_toolCallId: string, params: Static<typeof FlockLeaseParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const action = typeof params.action === "string" ? params.action.trim() : "";

      // Since context is not available in OpenClaw interface, we use agentId from params
      // Authorization is expected to be handled at a higher level
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "unknown";
      const callerAgentId = agentId;

      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
      const homeId = typeof params.homeId === "string" ? params.homeId.trim() : "";
      const MIN_LEASE_MS = 60_000;          // 1 minute
      const MAX_LEASE_MS = 24 * 3_600_000;  // 24 hours
      const DEFAULT_LEASE_MS = 3_600_000;    // 1 hour
      const rawDuration = typeof params.durationMs === "number" ? params.durationMs : DEFAULT_LEASE_MS;
      const durationMs = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, rawDuration));
      const reason = typeof params.reason === "string" ? params.reason.trim() : action;

      /**
       * Verify that the caller owns the given homeId.
       * homeId format is "agentId@nodeId" — the agentId portion must match.
       */
      function assertOwnership(hid: string): AgentToolResult<Record<string, unknown>> | null {
        const ownerPart = hid.split("@")[0];
        if (ownerPart !== callerAgentId) {
          return toResult({ ok: false, error: `permission denied: home ${hid} belongs to ${ownerPart}, not ${callerAgentId}` });
        }
        return null;
      }

      switch (action) {
        case "request": {
          if (!nodeId) return toResult({ ok: false, error: "nodeId required for lease request" });

          let home = deps.homes.get(`${agentId}@${nodeId}`);
          if (!home) {
            home = deps.homes.create(agentId, nodeId);
            deps.homes.transition(home.homeId, "PROVISIONING", "lease request", agentId);
            deps.homes.transition(home.homeId, "IDLE", "provisioning complete", "system");
          }

          deps.homes.transition(home.homeId, "LEASED", reason, agentId);
          // Persist lease expiry to DB (not just in-memory object)
          const expiresAt = Date.now() + durationMs;
          deps.homes.setLeaseExpiry(home.homeId, expiresAt);
          // Re-read from DB to return the authoritative record
          const updated = deps.homes.get(home.homeId)!;

          return toResult({
            ok: true,
            output: `Home ${updated.homeId} leased until ${new Date(expiresAt).toISOString()}`,
            data: { home: updated },
          });
        }

        case "renew": {
          if (!homeId) return toResult({ ok: false, error: "homeId required for renewal" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          const home = deps.homes.get(homeId);
          if (!home) return toResult({ ok: false, error: `home not found: ${homeId}` });
          if (home.state !== "LEASED" && home.state !== "ACTIVE") {
            return toResult({ ok: false, error: `cannot renew: home is ${home.state}` });
          }

          // Persist lease expiry to DB
          const expiresAt = Date.now() + durationMs;
          deps.homes.setLeaseExpiry(homeId, expiresAt);
          const updated = deps.homes.get(homeId)!;

          return toResult({
            ok: true,
            output: `Lease renewed: ${homeId} until ${new Date(expiresAt).toISOString()}`,
            data: { home: updated },
          });
        }

        case "release": {
          if (!homeId) return toResult({ ok: false, error: "homeId required for release" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          deps.homes.transition(homeId, "IDLE", reason, agentId);
          return toResult({ ok: true, output: `Home ${homeId} released to IDLE` });
        }

        case "freeze": {
          if (!homeId) return toResult({ ok: false, error: "homeId required for freeze" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          deps.homes.transition(homeId, "FROZEN", reason, agentId);
          return toResult({ ok: true, output: `Home ${homeId} frozen: ${reason}` });
        }

        default:
          return toResult({ ok: false, error: `unknown action: ${action}` });
      }
    },
  };
}

// --- flock_audit ---

function createAuditTool(deps: ToolDeps): AgentTool<typeof FlockAuditParams, Record<string, unknown>> {
  return {
    name: "flock_audit",
    label: "Flock Audit",
    description: "Query the Flock audit log. Returns recent actions, filterable by agent/home/level.",
    parameters: FlockAuditParams,
    async execute(_toolCallId: string, params: Static<typeof FlockAuditParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const filter: AuditFilter = {};
      if (typeof params.agentId === "string") filter.agentId = params.agentId.trim();
      if (typeof params.homeId === "string") filter.homeId = params.homeId.trim();
      if (typeof params.level === "string") {
        const level = params.level.trim().toUpperCase();
        if (!isAuditLevel(level)) {
          return toResult({ ok: false, error: `Invalid level: ${level}. Valid: GREEN, YELLOW, RED` });
        }
        filter.level = level;
      }
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      filter.limit = Math.min(rawLimit, QUERY_LIMIT_MAX);

      const entries = deps.audit.query(filter);
      const lines = entries.map(
        (e) => `[${new Date(e.timestamp).toISOString()}] ${e.level} ${e.action} (${e.agentId}) — ${e.detail}`,
      );

      return toResult({
        ok: true,
        output: lines.length > 0 ? lines.join("\n") : "No audit entries found.",
        data: { entries, total: deps.audit.count() },
      });
    },
  };
}

// --- flock_provision ---

function createProvisionTool(deps: ToolDeps): AgentTool<typeof FlockProvisionParams, Record<string, unknown>> {
  return {
    name: "flock_provision",
    label: "Flock Provision",
    description:
      "Provision a new home directory on disk. Creates the workspace directory tree, " +
      "deploys workspace files (AGENTS.md, SOUL.md, etc.), and returns bind mount config for Clawdbot sandbox.",
    parameters: FlockProvisionParams,
    async execute(_toolCallId: string, params: Static<typeof FlockProvisionParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";

      if (!agentId || !nodeId) {
        return toResult({ ok: false, error: "agentId and nodeId are required" });
      }

      // Path traversal defense — validate IDs before they reach the filesystem
      try {
        validateId(agentId, "agentId");
        validateId(nodeId, "nodeId");
      } catch (err) {
        return toResult({ ok: false, error: String(err) });
      }

      try {
        const result = deps.provisioner.provision(agentId, nodeId);
        const binds = formatBindMountsForConfig(result.bindMounts);

        const lines = [
          `## Home Provisioned: ${result.homeId}`,
          `Path: ${result.homePath}`,
          `Directories: ${result.directories.length} created`,
          `Workspace files: ${result.workspaceFiles.join(", ")}`,
          `Immutable files: ${result.immutableFiles.join(", ")}`,
          "",
          "### Bind Mounts",
          "Add to agent's `docker.binds` in Clawdbot config:",
          "```json",
          JSON.stringify(binds, null, 2),
          "```",
        ];

        // Also register in state machine
        const home = deps.homes.create(agentId, nodeId);
        deps.homes.transition(home.homeId, "PROVISIONING", "disk provisioned", "system");
        deps.homes.transition(home.homeId, "IDLE", "provisioning complete", "system");

        return toResult({
          ok: true,
          output: lines.join("\n"),
          data: { ...result, binds },
        });
      } catch (err) {
        return toResult({ ok: false, error: String(err) });
      }
    },
  };
}

// --- flock_sysadmin_protocol ---

function createSysadminProtocolTool(): AgentTool<typeof FlockSysadminProtocolParams, Record<string, unknown>> {
  return {
    name: "flock_sysadmin_protocol",
    label: "Sysadmin Protocol",
    description:
      "Load the sysadmin protocol documents. Returns the triage classification guide, " +
      "agent knowledge management rules, and meta-governance framework. " +
      "Use 'section' to load a specific document, or omit for the full combined prompt.",
    parameters: FlockSysadminProtocolParams,
    async execute(_toolCallId: string, params: Static<typeof FlockSysadminProtocolParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const section = typeof params.section === "string" ? params.section.trim() : "all";

      try {
        if (section === "all") {
          return toResult({
            ok: true,
            output: getSysadminPrompt(),
            data: { version: loadSysadminProtocol().version, section: "all" },
          });
        }

        const protocol = loadSysadminProtocol();

        const sectionMap: Record<string, { title: string; content: string }> = {
          triage: { title: "Triage Protocol", content: protocol.triageProtocol },
          knowledge: { title: "Agent Knowledge Management", content: protocol.agentKnowledge },
          meta: { title: "Meta-Governance", content: protocol.metaGovernance },
        };

        const doc = sectionMap[section];
        if (!doc) {
          return toResult({ ok: false, error: `Unknown section: ${section}. Use: triage, knowledge, meta, all` });
        }

        return toResult({
          ok: true,
          output: doc.content,
          data: { version: protocol.version, section },
        });
      } catch (err) {
        return toResult({ ok: false, error: String(err) });
      }
    },
  };
}

// --- flock_sysadmin_request ---

function createSysadminRequestTool(deps: ToolDeps): AgentTool<typeof FlockSysadminRequestParams, Record<string, unknown>> {
  return {
    name: "flock_sysadmin_request",
    label: "Sysadmin Request",
    description:
      "[DEPRECATED — prefer @sysadmin mention in a channel instead] " +
      "Send a system-level request to the sysadmin agent via A2A protocol. " +
      "The sysadmin will triage the request as GREEN (auto-execute), " +
      "YELLOW (needs clarification), or RED (requires human approval). " +
      "Describe what you need and why.",
    parameters: FlockSysadminRequestParams,
    async execute(_toolCallId: string, params: Static<typeof FlockSysadminRequestParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const request = typeof params.request === "string" ? params.request.trim() : "";
      if (!request) {
        return toResult({ ok: false, error: "request is required — describe what you need and why" });
      }

      if (!deps.a2aClient) {
        return toResult({
          ok: false,
          error: "A2A transport not initialized. Sysadmin request requires the A2A transport layer.",
        });
      }

      const sysadminId = deps.sysadminAgentId;
      if (!sysadminId) {
        return toResult({
          ok: false,
          error: "No sysadmin agent registered on this node.",
        });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");
      const urgency = parseUrgency(params.urgency);
      const project = typeof params.project === "string" ? params.project.trim() : undefined;
      const extraContext = typeof params.context === "string" ? params.context.trim() : undefined;

      const startTime = Date.now();

      try {
        const result = await deps.a2aClient.sendSysadminRequest(
          sysadminId,
          request,
          {
            urgency,
            project,
            fromHome: callerAgentId,
            context: extraContext,
          },
        );

        const duration = Date.now() - startTime;

        // Extract triage result from artifact data if available
        const triageData = extractTriageFromArtifacts(result.artifacts);
        const level: AuditLevel = triageData?.level ?? "YELLOW";

        // Record in audit log
        deps.audit.append({
          id: result.taskId || uniqueId("sysreq"),
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "sysadmin-request",
          level,
          detail: request.slice(0, 500),
          result: result.state,
          duration,
        });

        return toResult({
          ok: true,
          output: formatSysadminResult(result.response, triageData),
          data: {
            taskId: result.taskId,
            state: result.state,
            level,
            response: result.response,
            duration,
          },
        });
      } catch (err) {
        const duration = Date.now() - startTime;
        const errorMsg = err instanceof Error ? err.message : String(err);

        // Audit the failure
        deps.audit.append({
          id: uniqueId("sysreq-err"),
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "sysadmin-request",
          level: "RED",
          detail: `FAILED: ${request.slice(0, 300)} — ${errorMsg}`,
          result: "error",
          duration,
        });

        return toResult({ ok: false, error: `Sysadmin request failed: ${errorMsg}` });
      }
    },
  };
}

// --- Sysadmin request helpers ---

function parseUrgency(raw: unknown): "low" | "normal" | "high" {
  if (raw === "low" || raw === "high") return raw;
  return "normal";
}

function extractTriageFromArtifacts(
  artifacts: Array<{ name?: string; parts: unknown[] }>,
): TriageResult | null {
  for (const art of artifacts) {
    if (art.name !== "triage-result") continue;
    for (const part of art.parts) {
      if (!isDataPart(part)) continue;
      const d = part.data as Record<string, unknown>;
      if (!isAuditLevel(d.level)) continue;
      return {
        level: d.level,
        action: typeof d.action === "string" ? d.action : "",
        reasoning: typeof d.reasoning === "string" ? d.reasoning : "",
        riskFactors: Array.isArray(d.riskFactors)
          ? d.riskFactors.filter((r): r is string => typeof r === "string")
          : undefined,
        requiresHumanApproval: typeof d.requiresHumanApproval === "boolean" ? d.requiresHumanApproval : false,
      };
    }
  }
  return null;
}

// --- flock_migrate ---

function createMigrateTool(deps: ToolDeps): AgentTool<typeof FlockMigrateParams, Record<string, unknown>> {
  return {
    name: "flock_migrate",
    label: "Flock Migrate",
    description:
      "Trigger a migration of an agent to a different node. " +
      "Only sysadmin role agents can use this tool. Initiates the full migration lifecycle " +
      "through the A2A protocol and automatically updates assignment routing.",
    parameters: FlockMigrateParams,
    async execute(_toolCallId: string, params: Static<typeof FlockMigrateParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      // Check if migration orchestrator is available (preferred), else fall back to engine
      if (!deps.migrationOrchestrator && !deps.migrationEngine) {
        return toResult({ ok: false, error: "Migration orchestrator not initialized." });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");

      // Role-based authorization: only sysadmin or orchestrator agents can trigger migrations
      const callerMeta = deps.a2aServer?.getAgentMeta(callerAgentId);
      if (callerMeta?.role !== "sysadmin" && callerMeta?.role !== "orchestrator") {
        return toResult({
          ok: false,
          error: `Permission denied: only sysadmin or orchestrator agents can trigger migrations. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      const agentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const targetNodeId = typeof params.targetNodeId === "string" ? params.targetNodeId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "orchestrator_rebalance";

      if (!agentId) {
        return toResult({ ok: false, error: "targetAgentId is required." });
      }
      if (!targetNodeId) {
        return toResult({ ok: false, error: "targetNodeId is required." });
      }

      // Validate reason is a valid MigrationReason
      const validReasons: MigrationReason[] = ["agent_request", "orchestrator_rebalance", "node_retiring", "lease_migration", "security_relocation", "resource_need"];
      if (!validReasons.includes(reason as MigrationReason)) {
        return toResult({
          ok: false,
          error: `Invalid reason: ${reason}. Valid: ${validReasons.join(", ")}`,
        });
      }

      const startTime = Date.now();

      // Use orchestrator if available (full lifecycle), else fall back to engine (initiate only)
      if (deps.migrationOrchestrator) {
        try {
          const result = await deps.migrationOrchestrator.run(
            agentId,
            targetNodeId,
            reason as MigrationReason,
          );

          const duration = Date.now() - startTime;

          if (result.success) {
            deps.audit.append({
              id: `migration-completed-${result.migrationId}`,
              timestamp: Date.now(),
              agentId: callerAgentId,
              action: "migration-complete",
              level: "GREEN",
              detail: `Migration ${result.migrationId}: ${agentId} → ${targetNodeId} completed`,
              result: "completed",
              duration,
            });

            return toResult({
              ok: true,
              output: `Migration completed: ${result.migrationId}\nAgent: ${agentId}\nTarget: ${targetNodeId}\nPhase: ${result.finalPhase}`,
              data: {
                migrationId: result.migrationId,
                finalPhase: result.finalPhase,
                warnings: result.warnings,
              },
            });
          } else {
            deps.audit.append({
              id: `migration-failed-${result.migrationId}`,
              timestamp: Date.now(),
              agentId: callerAgentId,
              action: "migration-failed",
              level: "RED",
              detail: `Migration ${result.migrationId} failed: ${result.error}`,
              result: "failed",
              duration,
            });

            return toResult({
              ok: false,
              error: `Migration failed: ${result.error}\nFinal phase: ${result.finalPhase}`,
              data: {
                migrationId: result.migrationId,
                finalPhase: result.finalPhase,
                error: result.error,
              },
            });
          }
        } catch (err) {
          const duration = Date.now() - startTime;
          const errorMsg = err instanceof Error ? err.message : String(err);

          deps.audit.append({
            id: uniqueId("migration-error"),
            timestamp: Date.now(),
            agentId: callerAgentId,
            action: "migration-failed",
            level: "RED",
            detail: `Migration of ${agentId} to ${targetNodeId} threw: ${errorMsg}`,
            result: "error",
            duration,
          });

          return toResult({ ok: false, error: `Migration error: ${errorMsg}` });
        }
      }

      // No orchestrator available — cannot run migration lifecycle
      return toResult({
        ok: false,
        error: "Migration orchestrator not available. Cannot execute migration without orchestrator.",
      });
    },
  };
}

// --- flock_update_card ---

function createUpdateCardTool(deps: ToolDeps): AgentTool<typeof FlockUpdateCardParams, Record<string, unknown>> {
  return {
    name: "flock_update_card",
    label: "Update Card",
    description:
      "Update your own Agent Card. You can change your name, description, and/or skills. " +
      "You can only update your own card — not other agents' cards.",
    parameters: FlockUpdateCardParams,
    async execute(_toolCallId: string, params: Static<typeof FlockUpdateCardParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.a2aServer) {
        return toResult({ ok: false, error: "A2A transport not initialized." });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "");
      if (!callerAgentId) {
        return toResult({ ok: false, error: "agentId is required — cannot determine which card to update." });
      }

      const registry = deps.a2aServer.cardRegistry;

      // Build the update params from provided fields
      const updates: { name?: string; description?: string; skills?: AgentSkill[] } = {};
      let hasUpdate = false;

      if (typeof params.name === "string" && params.name.trim()) {
        updates.name = params.name.trim();
        hasUpdate = true;
      }

      if (typeof params.description === "string" && params.description.trim()) {
        updates.description = params.description.trim();
        hasUpdate = true;
      }

      if (typeof params.skills === "string" && params.skills.trim()) {
        try {
          const parsed: unknown = JSON.parse(params.skills.trim());
          if (!Array.isArray(parsed)) {
            return toResult({ ok: false, error: "skills must be a JSON array of AgentSkill objects." });
          }
          // Validate each skill has at least id and name
          for (const s of parsed) {
            if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>).id !== "string" || typeof (s as Record<string, unknown>).name !== "string") {
              return toResult({ ok: false, error: "Each skill must have at least 'id' (string) and 'name' (string)." });
            }
          }
          updates.skills = parsed as AgentSkill[];
          hasUpdate = true;
        } catch {
          return toResult({ ok: false, error: "skills is not valid JSON." });
        }
      }

      if (!hasUpdate) {
        return toResult({ ok: false, error: "No updates provided. Specify at least one of: name, description, skills." });
      }

      const ok = registry.updateCard(callerAgentId, updates);
      if (!ok) {
        return toResult({ ok: false, error: `Agent card not found for '${callerAgentId}'. Cannot update a card that doesn't exist.` });
      }

      const updatedCard = registry.get(callerAgentId);
      return toResult({
        ok: true,
        output: `Agent card updated for ${callerAgentId}.`,
        data: {
          agentId: callerAgentId,
          name: updatedCard?.name,
          description: updatedCard?.description,
          skillCount: updatedCard?.skills?.length ?? 0,
        },
      });
    },
  };
}

// --- flock_sleep ---

function createSleepTool(deps: ToolDeps): AgentTool<typeof FlockSleepParams, Record<string, unknown>> {
  return {
    name: "flock_sleep",
    label: "Flock Sleep",
    description:
      "Enter SLEEP state. You stop receiving fast work loop ticks and channel notifications. " +
      "You will still receive slow-tick polls (~5 min) with a channel activity summary, " +
      "so you can self-wake by posting if you see something relevant. " +
      "Other agents can also wake you via @mention in a channel or direct message (flock_message). " +
      "Only call this when you have no pending work. Use sparingly — if you might have work soon, stay AWAKE.",
    parameters: FlockSleepParams,
    async execute(_toolCallId: string, params: Static<typeof FlockSleepParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const agentLoop = deps.agentLoop;
      if (!agentLoop) {
        return toResult({ ok: false, error: "Agent loop store not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "no reason given";

      const current = agentLoop.get(callerAgentId);
      if (!current) {
        return toResult({ ok: false, error: `Agent "${callerAgentId}" not found in loop state.` });
      }

      if (current.state === "SLEEP") {
        return toResult({ ok: true, output: `Already in SLEEP state.` });
      }

      agentLoop.setState(callerAgentId, "SLEEP", reason);

      deps.audit?.append({
        id: uniqueId(`sleep-${callerAgentId}`),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-sleep",
        level: "GREEN",
        detail: `Agent entered SLEEP: ${reason.slice(0, 200)}`,
        result: "completed",
      });

      return toResult({
        ok: true,
        output: `Entering SLEEP state. You will not receive ticks or channel notifications until woken. Reason: ${reason}`,
        data: { state: "SLEEP", reason },
      });
    },
  };
}

// --- Enum validators ---

import type { HomeState } from "../types.js";

const VALID_HOME_STATES: HomeState[] = [
  "UNASSIGNED", "PROVISIONING", "IDLE", "LEASED",
  "ACTIVE", "FROZEN", "MIGRATING", "ERROR", "RETIRED",
];

function isValidHomeState(v: string): v is HomeState {
  return VALID_HOME_STATES.includes(v as HomeState);
}

function formatSysadminResult(response: string, triage: TriageResult | null): string {
  if (!triage) return response;

  const icon = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" }[triage.level];
  const lines = [
    `## Sysadmin Response ${icon} ${triage.level}`,
    "",
  ];

  if (triage.requiresHumanApproval) {
    lines.push("⚠️ **This request requires human approval.**");
    lines.push("");
  }

  lines.push(response);
  return lines.join("\n");
}

// --- flock_message ---

function createMessageTool(deps: ToolDeps): AgentTool<typeof FlockMessageParams, Record<string, unknown>> {
  return {
    name: "flock_message",
    label: "Flock Message",
    description:
      "Send a message to another agent via A2A protocol. " +
      "Use flock_discover to find available agents, then send your message in natural language.",
    parameters: FlockMessageParams,
    async execute(_toolCallId: string, params: Static<typeof FlockMessageParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.a2aClient) {
        return toResult({ ok: false, error: "A2A transport not initialized." });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");
      const to = typeof params.to === "string" ? params.to.trim() : "";
      const message = typeof params.message === "string" ? params.message.trim() : "";

      if (!to) return toResult({ ok: false, error: "'to' is required — specify the target agent ID." });
      if (!message) return toResult({ ok: false, error: "'message' is required — describe what you need." });

      const contextData = typeof params.contextData === "object" && params.contextData !== null
        ? params.contextData as Record<string, unknown>
        : undefined;

      const startTime = Date.now();
      const contextId = uniqueId("ctx");
      const taskId = uniqueId("msg");

      // Record task in TaskStore (state: submitted)
      const taskStore = deps.taskStore;
      if (taskStore) {
        taskStore.insert({
          taskId,
          contextId,
          fromAgentId: callerAgentId,
          toAgentId: to,
          state: "submitted",
          messageType: "message",
          summary: message.slice(0, 200),
          payload: JSON.stringify({ message, contextData }),
          responseText: null,
          responsePayload: null,
          createdAt: startTime,
          updatedAt: startTime,
          completedAt: null,
        });
      }

      try {
        // Auto-wake: direct messages are explicit wake triggers for sleeping agents
        if (deps.agentLoop) {
          const targetState = deps.agentLoop.get(to);
          if (targetState?.state === "SLEEP") {
            deps.agentLoop.setState(to, "AWAKE");
            deps.logger?.info(`[flock:message] Auto-woke "${to}" on direct message from "${callerAgentId}"`);
          }
        }

        // Construct A2A message with DM session routing
        const routingData = { sessionRouting: { chatType: "dm", peerId: callerAgentId } };
        const mergedData = contextData ? { ...contextData, ...routingData } : routingData;
        const a2aParams = { message: userMessage(message, [dataPart(mergedData)]) };

        // Fire-and-forget: send A2A request in background (non-blocking)
        const sendPromise = deps.a2aClient.sendA2A(to, a2aParams);

        // Background: update TaskStore when the A2A call completes
        sendPromise.then((result) => {
          const now = Date.now();
          const completedState = result.state === "completed" ? "completed" as const : "failed" as const;

          if (taskStore) {
            taskStore.update(taskId, {
              state: completedState,
              responseText: result.response,
              responsePayload: null,
              updatedAt: now,
              completedAt: now,
            });
          }

          deps.audit.append({
            id: result.taskId || taskId,
            timestamp: now,
            agentId: callerAgentId,
            action: "message",
            level: "GREEN",
            detail: `→ ${to}: ${message.slice(0, 200)}`,
            result: result.state,
            duration: now - startTime,
          });
        }).catch((err: unknown) => {
          const now = Date.now();
          const errorMsg = err instanceof Error ? err.message : String(err);

          if (taskStore) {
            taskStore.update(taskId, {
              state: "failed",
              responseText: errorMsg,
              updatedAt: now,
              completedAt: now,
            });
          }

          deps.audit.append({
            id: uniqueId("msg-err"),
            timestamp: now,
            agentId: callerAgentId,
            action: "message",
            level: "YELLOW",
            detail: `FAILED → ${to}: ${errorMsg.slice(0, 200)}`,
            result: "error",
            duration: now - startTime,
          });
        });

        // Return immediately — caller uses flock_tasks to check progress
        return toResult({
          ok: true,
          output: `Task ${taskId} submitted to ${to}. Use flock_tasks to check progress.`,
          data: {
            taskId,
            state: "submitted",
            to,
          },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);

        if (taskStore) {
          taskStore.update(taskId, {
            state: "failed",
            responseText: errorMsg,
            updatedAt: Date.now(),
            completedAt: Date.now(),
          });
        }

        deps.audit.append({
          id: uniqueId("msg-err"),
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "message",
          level: "YELLOW",
          detail: `FAILED → ${to}: ${errorMsg.slice(0, 200)}`,
          result: "error",
          duration: Date.now() - startTime,
        });

        return toResult({ ok: false, error: `Message failed: ${errorMsg}` });
      }
    },
  };
}

// --- Channel tools ---
// Named, persistent conversation spaces with membership.
// Agents interact via channels: create, post, read, manage members.

/**
 * Extract @mentions from a message. Matches @agentId patterns where agentId
 * is a known channel member. Only returns members that are actually in the
 * provided members list to prevent false positives.
 */
function extractMentions(message: string, members: string[]): string[] {
  if (!message.includes("@")) return [];
  const mentioned: string[] = [];
  for (const member of members) {
    // Match @agentId at word boundary (handles @agent-name, @agent_name, etc.)
    if (message.includes(`@${member}`)) {
      mentioned.push(member);
    }
  }
  return mentioned;
}

// --- flock_channel_create ---

function createChannelCreateTool(deps: ToolDeps): AgentTool<typeof FlockChannelCreateParams, Record<string, unknown>> {
  return {
    name: "flock_channel_create",
    label: "Channel Create",
    description:
      "Create a new named channel for group discussion. Channels are persistent conversation " +
      "spaces with a topic, membership list, and message history. Optionally post the first " +
      "message and notify all members. Members are auto-woken if sleeping.",
    parameters: FlockChannelCreateParams,
    async execute(_toolCallId: string, params: Static<typeof FlockChannelCreateParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore || !deps.channelMessages) {
        return toResult({ ok: false, error: "Channel stores not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp._callerAgentId === "string") ? rp._callerAgentId as string : "unknown";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
      const topic = typeof params.topic === "string" ? params.topic.trim() : "";
      const membersRaw = params.members;
      const members: string[] = Array.isArray(membersRaw)
        ? membersRaw.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map(s => s.trim())
        : [];
      const message = typeof params.message === "string" ? params.message.trim() : "";

      // Validate channelId format
      if (!channelId || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(channelId)) {
        return toResult({ ok: false, error: "'channelId' must be alphanumeric with dashes (e.g. 'project-logging')." });
      }
      if (!topic) {
        return toResult({ ok: false, error: "'topic' is required." });
      }

      // Check channel doesn't already exist
      if (deps.channelStore.get(channelId)) {
        return toResult({ ok: false, error: `Channel '${channelId}' already exists.` });
      }

      const now = Date.now();
      const allMembers = [...new Set([callerAgentId, ...members])].filter(m => m !== "main" && m !== "unknown");

      // Create the channel record
      deps.channelStore.insert({
        channelId,
        name: channelId,
        topic,
        createdBy: callerAgentId,
        members: allMembers,
        archived: false,
        archiveReadyMembers: [],
        archivingStartedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      // SLEEP members are NOT auto-woken — they will discover new channels
      // via slow-tick polling and self-wake if they find the topic relevant.

      let messageCount = 0;

      // Post first message if provided
      if (message) {
        const seq = deps.channelMessages.append({
          channelId,
          agentId: callerAgentId,
          content: message,
          timestamp: now,
        });
        messageCount = 1;

        // Track channel participation for work loop
        if (deps.workLoopScheduler) {
          for (const member of allMembers) {
            deps.workLoopScheduler.trackChannel(member, channelId, seq);
          }
        }
      }

      // Audit
      deps.audit.append({
        id: uniqueId(`channel-create-${channelId}`),
        timestamp: now,
        agentId: callerAgentId,
        action: "channel-create",
        level: "GREEN",
        detail: `Created channel #${channelId} (topic: ${topic}) with members: [${allMembers.join(", ")}]`,
        result: "completed",
      });

      return toResult({
        ok: true,
        output: [
          `Channel #${channelId} created.`,
          `Topic: ${topic}`,
          `Members: ${allMembers.join(", ")}`,
          messageCount > 0 ? `First message posted.` : null,
          `Post messages: flock_channel_post(channelId="${channelId}", message="...")`,
        ].filter(Boolean).join("\n"),
        data: { channelId, topic, members: allMembers, messageCount },
      });
    },
  };
}

// --- flock_channel_post ---

function createChannelPostTool(deps: ToolDeps): AgentTool<typeof FlockChannelPostParams, Record<string, unknown>> {
  return {
    name: "flock_channel_post",
    label: "Channel Post",
    description:
      "Post a message to a channel. Your message is appended to the channel history " +
      "and other members see it on their next tick. @mentioned agents get an immediate tick. " +
      "Cannot post to archived channels.",
    parameters: FlockChannelPostParams,
    async execute(_toolCallId: string, params: Static<typeof FlockChannelPostParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore || !deps.channelMessages) {
        return toResult({ ok: false, error: "Channel stores not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp._callerAgentId === "string") ? rp._callerAgentId as string : "unknown";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
      const message = typeof params.message === "string" ? params.message.trim() : "";
      const shouldNotify = params.notify !== false;

      if (!channelId) return toResult({ ok: false, error: "'channelId' is required." });
      if (!message) return toResult({ ok: false, error: "'message' is required." });

      const channel = deps.channelStore.get(channelId);
      if (!channel) return toResult({ ok: false, error: `Channel '${channelId}' not found.` });
      if (channel.archived) return toResult({ ok: false, error: `Channel '${channelId}' is archived (read-only).` });

      const now = Date.now();
      const newSeq = deps.channelMessages.append({ channelId, agentId: callerAgentId, content: message, timestamp: now });

      // Auto-wake: posting to a channel means the agent is actively engaged
      if (deps.agentLoop) {
        const loopState = deps.agentLoop.get(callerAgentId);
        if (loopState?.state === "SLEEP") {
          deps.agentLoop.setState(callerAgentId, "AWAKE");
          deps.logger?.info(`[flock:channel-post] Auto-woke "${callerAgentId}" — posted to #${channelId}`);
        }
      }

      // Track channel participation for work loop
      if (deps.workLoopScheduler) {
        deps.workLoopScheduler.trackChannel(callerAgentId, channelId, newSeq);
      }

      // Audit
      deps.audit.append({
        id: uniqueId(`channel-post-${channelId}-${callerAgentId}`),
        timestamp: now,
        agentId: callerAgentId,
        action: "channel-post",
        level: "GREEN",
        detail: `Posted to #${channelId}: ${message.slice(0, 200)}`,
        result: "completed",
      });

      const totalCount = deps.channelMessages.count(channelId);

      // Detect @mentions and trigger immediate ticks for mentioned agents.
      // SLEEP agents are woken (→ AWAKE). REACTIVE agents get a one-shot tick
      // but stay REACTIVE. Non-mentioned members see the message on their next
      // periodic tick via the scheduler's channel delta aggregation.
      if (shouldNotify && deps.agentLoop) {
        const mentionedAgents = extractMentions(message, channel.members);
        for (const mentioned of mentionedAgents) {
          if (mentioned === callerAgentId) continue;
          const loopState = deps.agentLoop.get(mentioned);
          if (!loopState) continue;

          if (loopState.state === "SLEEP") {
            deps.agentLoop.setState(mentioned, "AWAKE");
            deps.logger?.info(`[flock:channel-post] @mention woke "${mentioned}" in #${channelId}`);
            deps.audit?.append({
              id: uniqueId(`mention-wake-${mentioned}`),
              timestamp: now,
              agentId: callerAgentId,
              action: "agent-mention-wake",
              level: "GREEN",
              detail: `@mention in #${channelId} woke "${mentioned}" (by ${callerAgentId})`,
              result: "completed",
            });
          }

          // Trigger immediate tick for mentioned agents (SLEEP→AWAKE or REACTIVE)
          // so they see the message now rather than waiting for the next periodic tick.
          if (deps.workLoopScheduler) {
            deps.workLoopScheduler.requestImmediateTick(mentioned).catch((err) => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              deps.logger?.warn(`[flock:channel-post] Immediate tick for "${mentioned}" failed: ${errorMsg}`);
            });
          }
        }
      }

      return toResult({
        ok: true,
        output: `Message posted to #${channelId}. Channel now has ${totalCount} messages.`,
        data: { channelId, messageCount: totalCount, seq: newSeq },
      });
    },
  };
}

// --- flock_channel_read ---

function createChannelReadTool(deps: ToolDeps): AgentTool<typeof FlockChannelReadParams, Record<string, unknown>> {
  return {
    name: "flock_channel_read",
    label: "Channel Read",
    description:
      "Read the message history of a channel. Returns messages in chronological order " +
      "with channel metadata (name, topic, members). Use 'after' for delta reading.",
    parameters: FlockChannelReadParams,
    async execute(_toolCallId: string, params: Static<typeof FlockChannelReadParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore || !deps.channelMessages) {
        return toResult({ ok: false, error: "Channel stores not available." });
      }

      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
      const afterSeq = typeof params.after === "number" ? params.after : 0;

      if (!channelId) return toResult({ ok: false, error: "'channelId' is required." });

      const channel = deps.channelStore.get(channelId);
      if (!channel) return toResult({ ok: false, error: `Channel '${channelId}' not found.` });

      const totalCount = deps.channelMessages.count(channelId);
      const messages = afterSeq > 0
        ? deps.channelMessages.list({ channelId, since: afterSeq + 1 })
        : deps.channelMessages.list({ channelId });

      if (messages.length === 0) {
        return toResult({
          ok: true,
          output: afterSeq > 0
            ? `No new messages in #${channelId} after seq ${afterSeq}.`
            : `Channel #${channelId} has no messages yet.`,
          data: { channelId, messages: [], total: totalCount },
        });
      }

      const formatted = messages.map(m =>
        `[seq ${m.seq}] ${m.agentId}: ${m.content}`
      ).join("\n\n");

      return toResult({
        ok: true,
        output: [
          `## #${channelId} — ${channel.topic}`,
          `Members: ${channel.members.join(", ")}`,
          `${messages.length} messages${afterSeq > 0 ? ` (after seq ${afterSeq})` : ""} — ${totalCount} total`,
          channel.archived ? `[ARCHIVED — read-only]` : null,
          ``,
          formatted,
        ].filter(Boolean).join("\n"),
        data: { channelId, messages, total: totalCount, members: channel.members },
      });
    },
  };
}

// --- flock_channel_list ---

function createChannelListTool(deps: ToolDeps): AgentTool<typeof FlockChannelListParams, Record<string, unknown>> {
  return {
    name: "flock_channel_list",
    label: "Channel List",
    description:
      "List channels. Filter by membership or archive state.",
    parameters: FlockChannelListParams,
    async execute(_toolCallId: string, params: Static<typeof FlockChannelListParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore) {
        return toResult({ ok: false, error: "Channel store not available." });
      }

      const member = typeof params.member === "string" ? params.member.trim() || undefined : undefined;
      const archived = typeof params.archived === "boolean" ? params.archived : undefined;

      const channels = deps.channelStore.list({ member, archived });

      if (channels.length === 0) {
        return toResult({ ok: true, output: "No channels found.", data: { channels: [] } });
      }

      const lines = channels.map(ch => {
        const msgCount = deps.channelMessages?.count(ch.channelId) ?? 0;
        const status = ch.archived ? " [ARCHIVED]" : "";
        return `#${ch.channelId}${status} — ${ch.topic} (${ch.members.length} members, ${msgCount} msgs)`;
      });

      return toResult({
        ok: true,
        output: [`## Channels (${channels.length})`, ``, ...lines].join("\n"),
        data: { channels: channels.map(ch => ({ channelId: ch.channelId, topic: ch.topic, members: ch.members, archived: ch.archived })) },
      });
    },
  };
}

// --- flock_assign_members ---

function createAssignMembersTool(deps: ToolDeps): AgentTool<typeof FlockAssignMembersParams, Record<string, unknown>> {
  return {
    name: "flock_assign_members",
    label: "Assign Members",
    description:
      "Add or remove members from a channel. Newly added members are auto-woken if sleeping.",
    parameters: FlockAssignMembersParams,
    async execute(_toolCallId: string, params: Static<typeof FlockAssignMembersParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore) {
        return toResult({ ok: false, error: "Channel store not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp._callerAgentId === "string") ? rp._callerAgentId as string : "unknown";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
      const addRaw = params.add;
      const removeRaw = params.remove;
      const toAdd: string[] = Array.isArray(addRaw)
        ? addRaw.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map(s => s.trim()) : [];
      const toRemove = new Set<string>(
        Array.isArray(removeRaw)
          ? removeRaw.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map(s => s.trim()) : []
      );

      if (!channelId) return toResult({ ok: false, error: "'channelId' is required." });
      if (toAdd.length === 0 && toRemove.size === 0) {
        return toResult({ ok: false, error: "Provide 'add' and/or 'remove' arrays." });
      }

      const channel = deps.channelStore.get(channelId);
      if (!channel) return toResult({ ok: false, error: `Channel '${channelId}' not found.` });

      const updatedMembers = [...new Set([...channel.members, ...toAdd])].filter(m => !toRemove.has(m));
      const now = Date.now();

      deps.channelStore.update(channelId, { members: updatedMembers, updatedAt: now });

      // SLEEP members are NOT auto-woken — they will discover new channel
      // membership via slow-tick polling and self-wake if relevant.

      // Track newly added members in work loop scheduler
      if (deps.workLoopScheduler && deps.channelMessages) {
        const latestCount = deps.channelMessages.count(channelId);
        for (const member of toAdd) {
          if (!channel.members.includes(member)) {
            deps.workLoopScheduler.trackChannel(member, channelId, latestCount);
          }
        }
      }

      // Post system message about membership change
      if (deps.channelMessages) {
        const parts: string[] = [];
        const newlyAdded = toAdd.filter(m => !channel.members.includes(m));
        if (newlyAdded.length > 0) parts.push(`${newlyAdded.join(", ")} joined`);
        const actuallyRemoved = [...toRemove].filter(m => channel.members.includes(m));
        if (actuallyRemoved.length > 0) parts.push(`${actuallyRemoved.join(", ")} left`);
        if (parts.length > 0) {
          deps.channelMessages.append({
            channelId,
            agentId: "[system]",
            content: `[membership] ${parts.join("; ")}`,
            timestamp: now,
          });
        }
      }

      deps.audit.append({
        id: uniqueId(`assign-members-${channelId}`),
        timestamp: now,
        agentId: callerAgentId,
        action: "assign-members",
        level: "GREEN",
        detail: `Channel #${channelId}: add=[${toAdd.join(",")}] remove=[${[...toRemove].join(",")}]`,
        result: "completed",
      });

      return toResult({
        ok: true,
        output: `Updated #${channelId} members: ${updatedMembers.join(", ")}`,
        data: { channelId, members: updatedMembers },
      });
    },
  };
}

// --- Archive finalization helper ---

/** Finalize archive: set archived=true, post system message, bridge sync, audit. */
async function finalizeArchive(
  deps: ToolDeps,
  channelId: string,
  callerAgentId: string,
): Promise<{ bridgesDeactivated: number }> {
  const now = Date.now();
  deps.channelStore!.update(channelId, {
    archived: true,
    archivingStartedAt: null,
    updatedAt: now,
  });

  if (deps.channelMessages) {
    deps.channelMessages.append({
      channelId,
      agentId: "[system]",
      content: "[system] Channel archived. Read-only.",
      timestamp: now,
    });
  }

  // Notify bridged external channels and deactivate bridges
  let bridgesDeactivated = 0;
  if (deps.bridgeStore && deps.sendExternal) {
    const activeBridges = deps.bridgeStore.getByChannel(channelId);
    const archiveMsg = `Channel #${channelId} has been archived and is now read-only.\nBridge relay has been deactivated.`;

    for (const bridge of activeBridges) {
      try {
        await deps.sendExternal(bridge.platform, bridge.externalChannelId, archiveMsg, {
          accountId: bridge.accountId ?? undefined,
          displayName: "Flock System",
          webhookUrl: bridge.webhookUrl ?? undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.logger?.warn(`[flock:bridge] Failed to send archive notification to ${bridge.platform}/${bridge.externalChannelId}: ${msg}`);
      }

      deps.bridgeStore.update(bridge.bridgeId, { active: false });
      bridgesDeactivated++;
      deps.logger?.info(`[flock:bridge] Deactivated bridge ${bridge.bridgeId} (channel archived)`);
    }
  }

  deps.audit.append({
    id: uniqueId(`channel-archive-${channelId}`),
    timestamp: now,
    agentId: callerAgentId,
    action: "channel-archive",
    level: "GREEN",
    detail: `Archived channel #${channelId}${bridgesDeactivated > 0 ? ` (${bridgesDeactivated} bridge(s) deactivated)` : ""}`,
    result: "completed",
  });

  return { bridgesDeactivated };
}

/** Get agent members (excluding human: prefix and synthetic IDs like "main"/"unknown"). */
function getAgentMembers(members: string[]): string[] {
  return members.filter(m => !m.startsWith("human:") && m !== "main" && m !== "unknown");
}

// --- flock_channel_archive ---

function createChannelArchiveTool(deps: ToolDeps): AgentTool<typeof FlockChannelArchiveParams, Record<string, unknown>> {
  return {
    name: "flock_channel_archive",
    label: "Channel Archive",
    description:
      "Start the archive protocol for a channel. By default, initiates a graceful wind-down: " +
      "members review history, record learnings, then call flock_archive_ready. " +
      "Use force=true for immediate archive (admin/emergency).",
    parameters: FlockChannelArchiveParams,
    async execute(_toolCallId: string, params: Static<typeof FlockChannelArchiveParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore) {
        return toResult({ ok: false, error: "Channel store not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp._callerAgentId === "string") ? rp._callerAgentId as string : "unknown";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";
      const force = params.force === true;

      if (!channelId) return toResult({ ok: false, error: "'channelId' is required." });

      const channel = deps.channelStore.get(channelId);
      if (!channel) return toResult({ ok: false, error: `Channel '${channelId}' not found.` });
      if (channel.archived) return toResult({ ok: true, output: `Channel #${channelId} is already archived.` });

      // --- Force archive: immediate ---
      if (force) {
        const { bridgesDeactivated } = await finalizeArchive(deps, channelId, callerAgentId);
        const bridgeNote = bridgesDeactivated > 0 ? ` ${bridgesDeactivated} bridge(s) notified and deactivated.` : "";
        return toResult({
          ok: true,
          output: `Channel #${channelId} archived (forced). No new messages can be posted.${bridgeNote}`,
          data: { channelId, archived: true, bridgesDeactivated },
        });
      }

      // --- Graceful archive protocol ---

      // Already in archiving state — return current status
      if (channel.archivingStartedAt !== null) {
        const agentMembers = getAgentMembers(channel.members);
        const ready = channel.archiveReadyMembers;
        return toResult({
          ok: true,
          output: `Archive protocol already in progress for #${channelId}. ` +
            `Ready: ${ready.length}/${agentMembers.length} agent members. ` +
            `Ready: [${ready.join(", ")}]. Waiting: [${agentMembers.filter(m => !ready.includes(m)).join(", ")}].`,
          data: { channelId, archiving: true, ready: ready.length, total: agentMembers.length },
        });
      }

      // Start the archive protocol
      const now = Date.now();
      deps.channelStore.update(channelId, {
        archivingStartedAt: now,
        archiveReadyMembers: [],
        updatedAt: now,
      });

      const agentMembers = getAgentMembers(channel.members);

      // Post system announcement
      if (deps.channelMessages) {
        deps.channelMessages.append({
          channelId,
          agentId: "[system]",
          content: `[system] Archive protocol started. All agent members should:\n` +
            `1. Review channel history\n` +
            `2. Record important learnings to memory\n` +
            `3. Update your A2A Card if needed\n` +
            `4. Call flock_archive_ready(channelId="${channelId}") when done`,
          timestamp: now,
        });
      }

      deps.audit.append({
        id: uniqueId(`channel-archive-start-${channelId}`),
        timestamp: now,
        agentId: callerAgentId,
        action: "channel-archive-start",
        level: "GREEN",
        detail: `Started archive protocol for #${channelId} (${agentMembers.length} agent members)`,
        result: "completed",
      });

      return toResult({
        ok: true,
        output: `Archive protocol started for #${channelId}. ` +
          `${agentMembers.length} agent member(s) need to call flock_archive_ready. ` +
          `Agent members: [${agentMembers.join(", ")}]. ` +
          `Use force=true for immediate archive.`,
        data: { channelId, archiving: true, agentMembers },
      });
    },
  };
}

// --- flock_archive_ready ---

function createArchiveReadyTool(deps: ToolDeps): AgentTool<typeof FlockArchiveReadyParams, Record<string, unknown>> {
  return {
    name: "flock_archive_ready",
    label: "Archive Ready",
    description:
      "Signal that you have finished reviewing channel history and recording learnings. " +
      "When all agent members signal ready, the channel is automatically archived.",
    parameters: FlockArchiveReadyParams,
    async execute(_toolCallId: string, params: Static<typeof FlockArchiveReadyParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.channelStore) {
        return toResult({ ok: false, error: "Channel store not available." });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp._callerAgentId === "string") ? rp._callerAgentId as string : "unknown";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";

      if (!channelId) return toResult({ ok: false, error: "'channelId' is required." });

      const channel = deps.channelStore.get(channelId);
      if (!channel) return toResult({ ok: false, error: `Channel '${channelId}' not found.` });
      if (channel.archived) return toResult({ ok: true, output: `Channel #${channelId} is already archived.` });

      if (channel.archivingStartedAt === null) {
        return toResult({ ok: false, error: `Channel #${channelId} is not in archive protocol. Call flock_channel_archive first.` });
      }

      if (!channel.members.includes(callerAgentId)) {
        return toResult({ ok: false, error: `You (${callerAgentId}) are not a member of #${channelId}.` });
      }

      if (channel.archiveReadyMembers.includes(callerAgentId)) {
        const agentMembers = getAgentMembers(channel.members);
        return toResult({
          ok: true,
          output: `You already signaled ready for #${channelId}. (${channel.archiveReadyMembers.length}/${agentMembers.length} ready)`,
        });
      }

      // Add caller to ready list
      const now = Date.now();
      const newReady = [...channel.archiveReadyMembers, callerAgentId];
      deps.channelStore.update(channelId, {
        archiveReadyMembers: newReady,
        updatedAt: now,
      });

      const agentMembers = getAgentMembers(channel.members);
      const readyCount = newReady.length;
      const totalAgents = agentMembers.length;

      // Post system message about readiness
      if (deps.channelMessages) {
        deps.channelMessages.append({
          channelId,
          agentId: "[system]",
          content: `[system] ${callerAgentId} is ready for archive. (${readyCount}/${totalAgents} agent members ready)`,
          timestamp: now,
        });
      }

      deps.audit.append({
        id: uniqueId(`archive-ready-${channelId}-${callerAgentId}`),
        timestamp: now,
        agentId: callerAgentId,
        action: "archive-ready",
        level: "GREEN",
        detail: `${callerAgentId} ready for archive on #${channelId} (${readyCount}/${totalAgents})`,
        result: "completed",
      });

      // Check if all agent members are ready
      const allReady = agentMembers.every(m => newReady.includes(m));
      if (allReady) {
        const { bridgesDeactivated } = await finalizeArchive(deps, channelId, callerAgentId);
        const bridgeNote = bridgesDeactivated > 0 ? ` ${bridgesDeactivated} bridge(s) deactivated.` : "";
        return toResult({
          ok: true,
          output: `All ${totalAgents} agent member(s) ready. Channel #${channelId} has been archived.${bridgeNote}`,
          data: { channelId, archived: true, readyCount, totalAgents, bridgesDeactivated },
        });
      }

      const waiting = agentMembers.filter(m => !newReady.includes(m));
      return toResult({
        ok: true,
        output: `Readiness recorded. ${readyCount}/${totalAgents} agent members ready. Waiting: [${waiting.join(", ")}].`,
        data: { channelId, readyCount, totalAgents, waiting },
      });
    },
  };
}

// --- flock_discover ---

function createDiscoverTool(deps: ToolDeps): AgentTool<typeof FlockDiscoverParams, Record<string, unknown>> {
  return {
    name: "flock_discover",
    label: "Flock Discover",
    description:
      "Discover available agents in the swarm. Query by role, skill, or free-text. " +
      "Returns agent profiles with capabilities and recent task completion stats.",
    parameters: FlockDiscoverParams,
    async execute(_toolCallId: string, params: Static<typeof FlockDiscoverParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.a2aServer) {
        return toResult({ ok: false, error: "A2A transport not initialized." });
      }

      const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const skill = typeof params.skill === "string" ? params.skill.trim() : "";
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      const registry = deps.a2aServer.cardRegistry;
      let entries = registry.list();

      // Filter by role
      if (role === "worker" || role === "sysadmin" || role === "orchestrator") {
        entries = entries.filter((e) => e.meta.role === role);
      }

      // Filter by skill tag
      if (skill) {
        entries = entries.filter((e) =>
          e.card.skills?.some((s) => s.tags?.includes(skill)),
        );
      }

      // Filter by free-text query
      if (query) {
        entries = entries.filter((e) => {
          const name = e.card.name.toLowerCase();
          const desc = (e.card.description ?? "").toLowerCase();
          const skillTexts = (e.card.skills ?? []).map((s) =>
            `${s.name} ${s.description ?? ""} ${(s.tags ?? []).join(" ")}`.toLowerCase(),
          ).join(" ");
          return name.includes(query) || desc.includes(query) || skillTexts.includes(query);
        });
      }

      // Apply limit
      entries = entries.slice(0, limit);

      // Build output with task stats if TaskStore is available
      const taskStore = deps.taskStore;
      const rp = params as Record<string, unknown>;
      const _callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");

      const agents = entries.map((e) => {
        const skills = (e.card.skills ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          tags: s.tags ?? [],
        }));

        let stats: Record<string, unknown> | undefined;
        if (taskStore) {
          const completed = taskStore.count({ toAgentId: e.agentId, state: "completed" });
          const failed = taskStore.count({ toAgentId: e.agentId, state: "failed" });
          const total = taskStore.count({ toAgentId: e.agentId });
          stats = { completed, failed, total };
        }

        return {
          agentId: e.agentId,
          name: e.card.name,
          description: e.card.description ?? "",
          role: e.meta.role,
          nodeId: e.meta.nodeId,
          homeId: e.meta.homeId,
          skills,
          stats,
        };
      });

      if (agents.length === 0) {
        return toResult({ ok: true, output: "No agents found matching the query.", data: { agents: [] } });
      }

      const lines = [
        `## Discovered Agents (${agents.length})`,
        "",
        ...agents.map((a) => {
          const skillStr = a.skills.map((s) => s.name).join(", ") || "none";
          const statsStr = a.stats
            ? ` | Tasks: ${a.stats.completed}✅ ${a.stats.failed}❌ / ${a.stats.total} total`
            : "";
          return `- **${a.agentId}** [${a.role}] — ${a.description.slice(0, 80)} | Skills: ${skillStr}${statsStr}`;
        }),
      ];

      return toResult({
        ok: true,
        output: lines.join("\n"),
        data: { agents },
      });
    },
  };
}

// --- flock_history ---

function createHistoryTool(deps: ToolDeps): AgentTool<typeof FlockHistoryParams, Record<string, unknown>> {
  return {
    name: "flock_history",
    label: "Flock History",
    description:
      "Query past task completions and collaboration patterns. " +
      "Shows who worked with whom, what tasks completed or failed, and patterns over time.",
    parameters: FlockHistoryParams,
    async execute(_toolCallId: string, params: Static<typeof FlockHistoryParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toResult({ ok: false, error: "Task store not available." });
      }

      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const messageType = typeof params.messageType === "string" ? params.messageType.trim() : "";
      const stateParam = typeof params.state === "string" ? params.state.trim() : "";
      const since = typeof params.since === "number" ? params.since : undefined;
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      // Validate state if provided
      if (stateParam && !isTaskState(stateParam)) {
        return toResult({ ok: false, error: `Invalid state: ${stateParam}. Valid: ${TASK_STATES.join(", ")}` });
      }

      // If agentId provided, query both directions and merge
      let records: TaskRecord[];
      if (agentId) {
        const filter: TaskFilter = {
          messageType: messageType || undefined,
          state: stateParam ? stateParam as TaskRecord["state"] : undefined,
          since,
          limit,
        };
        const sent = taskStore.list({ ...filter, fromAgentId: agentId });
        const received = taskStore.list({ ...filter, toAgentId: agentId });

        // Merge and deduplicate by taskId
        const seen = new Set<string>();
        records = [];
        for (const r of [...sent, ...received]) {
          if (!seen.has(r.taskId)) {
            seen.add(r.taskId);
            records.push(r);
          }
        }
        // Sort by createdAt descending
        records.sort((a, b) => b.createdAt - a.createdAt);
        records = records.slice(0, limit);
      } else {
        const filter: TaskFilter = {
          messageType: messageType || undefined,
          state: stateParam ? stateParam as TaskRecord["state"] : undefined,
          since,
          limit,
        };
        records = taskStore.list(filter);
      }

      if (records.length === 0) {
        return toResult({ ok: true, output: "No task history found matching the query.", data: { tasks: [] } });
      }

      const lines = [
        `## Task History (${records.length} tasks)`,
        "",
        ...records.map((r) => {
          const date = new Date(r.createdAt).toISOString().slice(0, 16);
          const stateIcon = r.state === "completed" ? "✅" : r.state === "failed" ? "❌" : "⏳";
          const duration = r.completedAt ? `${r.completedAt - r.createdAt}ms` : "pending";
          return `- ${stateIcon} **${r.messageType}** ${r.fromAgentId} → ${r.toAgentId} [${date}] ${r.summary.slice(0, 60)} (${duration})`;
        }),
      ];

      return toResult({
        ok: true,
        output: lines.join("\n"),
        data: {
          tasks: records.map((r) => ({
            taskId: r.taskId,
            fromAgentId: r.fromAgentId,
            toAgentId: r.toAgentId,
            state: r.state,
            messageType: r.messageType,
            summary: r.summary,
            createdAt: r.createdAt,
            completedAt: r.completedAt,
          })),
        },
      });
    },
  };
}

// --- flock_tasks ---

function createTasksTool(deps: ToolDeps): AgentTool<typeof FlockTasksParams, Record<string, unknown>> {
  return {
    name: "flock_tasks",
    label: "Flock Tasks",
    description:
      "List tasks for the calling agent. Shows both sent and received tasks " +
      "with their current state. Use to track pending work and check on requests you've made.",
    parameters: FlockTasksParams,
    async execute(_toolCallId: string, params: Static<typeof FlockTasksParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toResult({ ok: false, error: "Task store not available." });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");
      const direction = typeof params.direction === "string" ? params.direction.trim() : "all";
      const stateParam = typeof params.state === "string" ? params.state.trim() : "";
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      if (stateParam && !isTaskState(stateParam)) {
        return toResult({ ok: false, error: `Invalid state: ${stateParam}. Valid: ${TASK_STATES.join(", ")}` });
      }

      const baseFilter: TaskFilter = {
        state: stateParam ? stateParam as TaskRecord["state"] : undefined,
        limit,
      };

      let records: TaskRecord[];
      if (direction === "sent") {
        records = taskStore.list({ ...baseFilter, fromAgentId: callerAgentId });
      } else if (direction === "received") {
        records = taskStore.list({ ...baseFilter, toAgentId: callerAgentId });
      } else {
        // "all" — get both directions and merge
        const sent = taskStore.list({ ...baseFilter, fromAgentId: callerAgentId });
        const received = taskStore.list({ ...baseFilter, toAgentId: callerAgentId });
        const seen = new Set<string>();
        records = [];
        for (const r of [...sent, ...received]) {
          if (!seen.has(r.taskId)) {
            seen.add(r.taskId);
            records.push(r);
          }
        }
        records.sort((a, b) => b.createdAt - a.createdAt);
        records = records.slice(0, limit);
      }

      if (records.length === 0) {
        return toResult({ ok: true, output: "No tasks found.", data: { tasks: [] } });
      }

      const lines = [
        `## Your Tasks (${records.length})`,
        "",
        ...records.map((r) => {
          const date = new Date(r.createdAt).toISOString().slice(0, 16);
          const stateIcon = r.state === "completed" ? "✅"
            : r.state === "failed" ? "❌"
            : r.state === "working" ? "🔨"
            : r.state === "input-required" ? "❓"
            : "⏳";
          const dir = r.fromAgentId === callerAgentId ? "→ sent to " + r.toAgentId : "← from " + r.fromAgentId;
          return `- ${stateIcon} [${r.state}] **${r.messageType}** ${dir} [${date}] ${r.summary.slice(0, 50)}`;
        }),
      ];

      return toResult({
        ok: true,
        output: lines.join("\n"),
        data: {
          tasks: records.map((r) => ({
            taskId: r.taskId,
            fromAgentId: r.fromAgentId,
            toAgentId: r.toAgentId,
            state: r.state,
            messageType: r.messageType,
            summary: r.summary,
            responseText: r.responseText,
            createdAt: r.createdAt,
            completedAt: r.completedAt,
          })),
        },
      });
    },
  };
}

// --- flock_task_respond ---

function createTaskRespondTool(deps: ToolDeps): AgentTool<typeof FlockTaskRespondParams, Record<string, unknown>> {
  return {
    name: "flock_task_respond",
    label: "Task Respond",
    description:
      "Respond to a task that requires your input (state: input-required). " +
      "Use when another agent has asked you a clarification question during task processing.",
    parameters: FlockTaskRespondParams,
    async execute(_toolCallId: string, params: Static<typeof FlockTaskRespondParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toResult({ ok: false, error: "Task store not available." });
      }

      // Read injected caller from _callerAgentId (set by wrapToolWithAgentId)
      const rp = params as Record<string, unknown>;
      const callerAgentId = (typeof rp.agentId === "string" && (rp.agentId as string).trim()) ? (rp.agentId as string).trim() : (typeof rp._callerAgentId === "string" ? rp._callerAgentId as string : "unknown");
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      const response = typeof params.response === "string" ? params.response.trim() : "";

      if (!taskId) {
        return toResult({ ok: false, error: "taskId is required." });
      }
      if (!response) {
        return toResult({ ok: false, error: "response is required." });
      }

      // Look up the task
      const task = taskStore.get(taskId);
      if (!task) {
        return toResult({ ok: false, error: `Task not found: ${taskId}` });
      }

      // Verify the caller is the intended recipient
      if (task.toAgentId !== callerAgentId) {
        return toResult({
          ok: false,
          error: `Permission denied: task ${taskId} is addressed to ${task.toAgentId}, not ${callerAgentId}.`,
        });
      }

      // Verify the task is in input-required state
      if (task.state !== "input-required") {
        return toResult({
          ok: false,
          error: `Task ${taskId} is in state "${task.state}", not "input-required". Only input-required tasks can be responded to.`,
        });
      }

      const now = Date.now();

      // Update the task with the response
      taskStore.update(taskId, {
        state: "working",
        responseText: response,
        updatedAt: now,
      });

      // Send follow-up A2A message to the original requester (fire-and-forget)
      if (deps.a2aClient) {
        const followUpMessage = userMessage(`Response to task ${taskId}: ${response}`, [
          dataPart({ sessionRouting: { chatType: "dm", peerId: callerAgentId } }),
        ]);

        deps.a2aClient.sendA2A(task.fromAgentId, { message: followUpMessage }).catch((err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          deps.audit.append({
            id: uniqueId("task-respond-err"),
            timestamp: Date.now(),
            agentId: callerAgentId,
            action: "task-respond-followup",
            level: "YELLOW",
            detail: `Follow-up to ${task.fromAgentId} failed: ${errorMsg.slice(0, 200)}`,
            result: "error",
          });
        });
      }

      // Audit the response
      deps.audit.append({
        id: uniqueId("task-respond"),
        timestamp: now,
        agentId: callerAgentId,
        action: "task-respond",
        level: "GREEN",
        detail: `Responded to task ${taskId}: ${response.slice(0, 200)}`,
        result: "working",
      });

      return toResult({
        ok: true,
        output: `Response recorded for task ${taskId}. Task state updated to "working".`,
        data: {
          taskId,
          state: "working",
          respondedAt: now,
        },
      });
    },
  };
}

// --- Bridge tool ---

const VALID_BRIDGE_PLATFORMS: ReadonlySet<BridgePlatform> = new Set<BridgePlatform>(["discord", "slack"]);
const VALID_BRIDGE_ACTIONS = new Set(["create", "remove", "list", "pause", "resume"]);

function isBridgePlatform(v: string): v is BridgePlatform {
  return VALID_BRIDGE_PLATFORMS.has(v as BridgePlatform);
}

function createBridgeTool(deps: ToolDeps): AgentTool<typeof FlockBridgeParams, Record<string, unknown>> {
  return {
    name: "flock_bridge",
    label: "Flock Bridge",
    description: "Manage bridges between Flock channels and external platforms (Discord/Slack). " +
      "Bridges relay messages bidirectionally: external platform messages appear in the Flock channel, " +
      "and agent posts in the Flock channel are sent to the external platform.",
    parameters: FlockBridgeParams,
    async execute(_toolCallId: string, params: Static<typeof FlockBridgeParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      if (!deps.bridgeStore) {
        return toResult({ ok: false, error: "Bridge store not available." });
      }

      const action = String(params.action ?? "");
      if (!VALID_BRIDGE_ACTIONS.has(action)) {
        return toResult({ ok: false, error: `Invalid action: "${action}". Must be one of: ${[...VALID_BRIDGE_ACTIONS].join(", ")}` });
      }

      const rp = params as Record<string, unknown>;
      const callerAgentId = String(rp.agentId ?? "unknown");
      const store = deps.bridgeStore;

      if (action === "list") {
        const filter: BridgeFilter = {};
        if (params.channelId) filter.channelId = String(params.channelId);
        if (params.platform && isBridgePlatform(String(params.platform))) {
          filter.platform = String(params.platform) as BridgePlatform;
        }
        const bridges = store.list(filter);
        return toResult({
          ok: true,
          output: bridges.length === 0
            ? "No bridge mappings found."
            : `Found ${bridges.length} bridge mapping(s).`,
          data: { bridges },
        });
      }

      if (action === "create") {
        const channelId = String(params.channelId ?? "");
        const platform = String(params.platform ?? "");
        let externalChannelId = String(params.externalChannelId ?? "");
        const shouldCreateChannel = params.createChannel === true;
        const guildId = String(params.guildId ?? "");
        const channelName = String(params.channelName ?? "") || channelId;
        const categoryId = typeof params.categoryId === "string" ? params.categoryId : undefined;

        if (!channelId) return toResult({ ok: false, error: "channelId is required for create." });
        if (!isBridgePlatform(platform)) {
          return toResult({ ok: false, error: `Invalid platform: "${platform}". Must be "discord" or "slack".` });
        }

        // Verify channel exists
        const flockChannel = deps.channelStore?.get(channelId);
        if (deps.channelStore) {
          if (!flockChannel) return toResult({ ok: false, error: `Flock channel "${channelId}" not found.` });
          if (flockChannel.archived) return toResult({ ok: false, error: `Flock channel "${channelId}" is archived.` });
        }

        // Auto-create external channel if requested
        let createdChannelName: string | undefined;
        if (shouldCreateChannel) {
          if (platform !== "discord") {
            return toResult({ ok: false, error: "createChannel is only supported for platform 'discord'. Slack channel creation is not yet supported." });
          }
          if (!guildId) {
            return toResult({ ok: false, error: "guildId is required when createChannel is true." });
          }
          if (!deps.discordBotToken) {
            return toResult({ ok: false, error: "Discord bot token not configured. Cannot create channels." });
          }
          try {
            const result = await createDiscordChannel(deps.discordBotToken, guildId, channelName, {
              topic: flockChannel?.topic,
              categoryId,
            });
            externalChannelId = result.channelId;
            createdChannelName = result.channelName;
            deps.logger?.info(`[flock:bridge] Auto-created Discord channel "${result.channelName}" (${result.channelId}) in guild ${guildId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return toResult({ ok: false, error: `Failed to create Discord channel: ${msg}` });
          }
        } else {
          if (!externalChannelId) return toResult({ ok: false, error: "externalChannelId is required for create (or use createChannel=true to auto-create)." });
        }

        // Check for duplicate
        const existing = store.getByExternal(platform, externalChannelId);
        if (existing) {
          return toResult({
            ok: false,
            error: `External channel ${platform}/${externalChannelId} is already bridged to flock/${existing.channelId} (bridge: ${existing.bridgeId}).`,
          });
        }

        const bridgeId = uniqueId("bridge");
        const now = Date.now();

        // Auto-create Discord webhook for per-agent display names
        let webhookUrl: string | null = null;
        if (platform === "discord" && deps.discordBotToken) {
          try {
            const result = await createChannelWebhook(deps.discordBotToken, externalChannelId);
            webhookUrl = result.webhookUrl;
            deps.logger?.info(`[flock:bridge] Auto-created Discord webhook for ${externalChannelId}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            deps.logger?.warn(`[flock:bridge] Failed to auto-create webhook (will use prefix fallback): ${msg}`);
          }
        }

        store.insert({
          bridgeId,
          channelId,
          platform,
          externalChannelId,
          accountId: params.accountId ? String(params.accountId) : null,
          webhookUrl,
          createdBy: callerAgentId,
          createdAt: now,
          active: true,
        });

        const createdNote = createdChannelName ? ` (created channel "${createdChannelName}")` : "";
        deps.audit.append({
          id: uniqueId("bridge-create"),
          timestamp: now,
          agentId: callerAgentId,
          action: "bridge-create",
          level: "GREEN",
          detail: `Created bridge ${bridgeId}: flock/${channelId} ↔ ${platform}/${externalChannelId}${createdNote}${webhookUrl ? " (webhook)" : " (prefix fallback)"}`,
          result: "created",
        });

        return toResult({
          ok: true,
          output: `Bridge created: flock/${channelId} ↔ ${platform}/${externalChannelId}${createdNote}${webhookUrl ? " (webhook enabled — per-agent display names)" : " (prefix mode)"}`,
          data: { bridgeId, channelId, platform, externalChannelId, webhookUrl: !!webhookUrl, channelCreated: !!createdChannelName },
        });
      }

      // remove / pause / resume require bridgeId
      const bridgeId = String(params.bridgeId ?? "");
      if (!bridgeId) return toResult({ ok: false, error: `bridgeId is required for ${action}.` });

      const bridge = store.get(bridgeId);
      if (!bridge) return toResult({ ok: false, error: `Bridge "${bridgeId}" not found.` });

      if (action === "remove") {
        store.delete(bridgeId);
        deps.audit.append({
          id: uniqueId("bridge-remove"),
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "bridge-remove",
          level: "YELLOW",
          detail: `Removed bridge ${bridgeId}: flock/${bridge.channelId} ↔ ${bridge.platform}/${bridge.externalChannelId}`,
          result: "removed",
        });
        return toResult({ ok: true, output: `Bridge "${bridgeId}" removed.` });
      }

      if (action === "pause") {
        if (!bridge.active) return toResult({ ok: true, output: `Bridge "${bridgeId}" is already paused.` });
        store.update(bridgeId, { active: false });
        return toResult({ ok: true, output: `Bridge "${bridgeId}" paused.` });
      }

      if (action === "resume") {
        if (bridge.active) return toResult({ ok: true, output: `Bridge "${bridgeId}" is already active.` });
        store.update(bridgeId, { active: true });
        return toResult({ ok: true, output: `Bridge "${bridgeId}" resumed.` });
      }

      return toResult({ ok: false, error: `Unknown action: "${action}"` });
    },
  };
}
