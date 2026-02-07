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

import type { PluginApi, ToolDefinition, ToolResult, ToolResultOC, AuditLevel, PluginLogger } from "../types.js";
import { isAuditLevel, toOCResult } from "../types.js";
import type { FlockConfig } from "../config.js";
import type { HomeManager } from "../homes/manager.js";
import type { HomeProvisioner } from "../homes/provisioner.js";
import { formatBindMountsForConfig } from "../homes/provisioner.js";
import type { AuditLog } from "../audit/log.js";
import type { HomeFilter, AuditFilter, TaskStore, TaskFilter, TaskRecord } from "../db/index.js";
import { isTaskState, TASK_STATES } from "../db/index.js";
import { validateId } from "../homes/utils.js";
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
  /** Thread message store for shared thread history. */
  threadMessages?: import("../db/index.js").ThreadMessageStore;
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
  /** Work loop scheduler for thread tracking. */
  workLoopScheduler?: WorkLoopScheduler;
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
  const toolFactories = [
    createStatusTool(deps),
    createLeaseTool(deps),
    createAuditTool(deps),
    createProvisionTool(deps),
    createSysadminProtocolTool(),
    createSysadminRequestTool(deps),
    createMessageTool(deps),
    createBroadcastTool(deps),
    createThreadPostTool(deps),
    createThreadReadTool(deps),
    createDiscoverTool(deps),
    createHistoryTool(deps),
    createTasksTool(deps),
    createTaskRespondTool(deps),
    createMigrateTool(deps),
    createUpdateCardTool(deps),
    createSleepTool(deps),
    createWakeTool(deps),
  ];

  for (const tool of toolFactories) {
    api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => {
      console.log(`[FLOCK-FACTORY] tool="${tool.name}" ctx.agentId="${ctx.agentId}" ctx.sessionKey="${ctx.sessionKey}"`);
      return wrapToolWithAgentId(tool, resolveCtxAgentId(ctx));
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
      api.registerTool((ctx: { agentId?: string; sessionKey?: string }) => {
        console.log(`[FLOCK-FACTORY] tool="${tool.name}" ctx.agentId="${ctx.agentId}" ctx.sessionKey="${ctx.sessionKey}"`);
        return wrapToolWithAgentId(tool, resolveCtxAgentId(ctx));
      });
    }
  }
}

// --- flock_status ---

function createStatusTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_status",
    description:
      "Query the swarm status. Returns home states, active leases, and overview. " +
      "Use without arguments for a full overview, or filter by homeId/nodeId/state.",
    parameters: {
      type: "object",
      properties: {
        homeId: {
          type: "string",
          description: "Specific home to query (format: agentId@nodeId)",
        },
        nodeId: {
          type: "string",
          description: "Filter homes by node",
        },
        state: {
          type: "string",
          description: "Filter homes by state (IDLE, LEASED, ACTIVE, FROZEN, etc.)",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const homeId = typeof params.homeId === "string" ? params.homeId.trim() : "";
      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
      const state = typeof params.state === "string" ? params.state.trim().toUpperCase() : "";

      if (homeId) {
        const home = deps.homes.get(homeId);
        if (!home) {
          return toOCResult({ ok: false, error: `home not found: ${homeId}` });
        }
        return toOCResult({
          ok: true,
          output: formatHome(home),
          data: { home },
        });
      }

      const filter: HomeFilter = {};
      if (nodeId) filter.nodeId = nodeId;
      if (state) {
        if (!isValidHomeState(state)) {
          return toOCResult({ ok: false, error: `Invalid state: ${state}. Valid: ${VALID_HOME_STATES.join(", ")}` });
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

      return toOCResult({ ok: true, output: lines.join("\n"), data: { homes } });
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

function createLeaseTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_lease",
    description:
      "Manage home leases. Actions: request (create/lease a home), renew (extend lease), " +
      "release (give up lease), freeze (emergency freeze).",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["request", "renew", "release", "freeze"],
          description: "Lease action to perform",
        },
        agentId: {
          type: "string",
          description: "Agent requesting the lease",
        },
        nodeId: {
          type: "string",
          description: "Target node for the home",
        },
        homeId: {
          type: "string",
          description: "Existing home ID (for renew/release/freeze)",
        },
        durationMs: {
          type: "number",
          description: "Lease duration in milliseconds. Default: 1 hour",
        },
        reason: {
          type: "string",
          description: "Reason for the action",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
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
      function assertOwnership(hid: string): ToolResultOC | null {
        const ownerPart = hid.split("@")[0];
        if (ownerPart !== callerAgentId) {
          return toOCResult({ ok: false, error: `permission denied: home ${hid} belongs to ${ownerPart}, not ${callerAgentId}` });
        }
        return null;
      }

      switch (action) {
        case "request": {
          if (!nodeId) return toOCResult({ ok: false, error: "nodeId required for lease request" });

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

          return toOCResult({
            ok: true,
            output: `Home ${updated.homeId} leased until ${new Date(expiresAt).toISOString()}`,
            data: { home: updated },
          });
        }

        case "renew": {
          if (!homeId) return toOCResult({ ok: false, error: "homeId required for renewal" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          const home = deps.homes.get(homeId);
          if (!home) return toOCResult({ ok: false, error: `home not found: ${homeId}` });
          if (home.state !== "LEASED" && home.state !== "ACTIVE") {
            return toOCResult({ ok: false, error: `cannot renew: home is ${home.state}` });
          }

          // Persist lease expiry to DB
          const expiresAt = Date.now() + durationMs;
          deps.homes.setLeaseExpiry(homeId, expiresAt);
          const updated = deps.homes.get(homeId)!;

          return toOCResult({
            ok: true,
            output: `Lease renewed: ${homeId} until ${new Date(expiresAt).toISOString()}`,
            data: { home: updated },
          });
        }

        case "release": {
          if (!homeId) return toOCResult({ ok: false, error: "homeId required for release" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          deps.homes.transition(homeId, "IDLE", reason, agentId);
          return toOCResult({ ok: true, output: `Home ${homeId} released to IDLE` });
        }

        case "freeze": {
          if (!homeId) return toOCResult({ ok: false, error: "homeId required for freeze" });
          const denied = assertOwnership(homeId);
          if (denied) return denied;

          deps.homes.transition(homeId, "FROZEN", reason, agentId);
          return toOCResult({ ok: true, output: `Home ${homeId} frozen: ${reason}` });
        }

        default:
          return toOCResult({ ok: false, error: `unknown action: ${action}` });
      }
    },
  };
}

// --- flock_audit ---

function createAuditTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_audit",
    description: "Query the Flock audit log. Returns recent actions, filterable by agent/home/level.",
    parameters: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "Filter by agent" },
        homeId: { type: "string", description: "Filter by home" },
        level: { type: "string", enum: ["GREEN", "YELLOW", "RED"], description: "Filter by risk level" },
        limit: { type: "number", description: "Max entries to return. Default: 20" },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const filter: AuditFilter = {};
      if (typeof params.agentId === "string") filter.agentId = params.agentId.trim();
      if (typeof params.homeId === "string") filter.homeId = params.homeId.trim();
      if (typeof params.level === "string") {
        const level = params.level.trim().toUpperCase();
        if (!isAuditLevel(level)) {
          return toOCResult({ ok: false, error: `Invalid level: ${level}. Valid: GREEN, YELLOW, RED` });
        }
        filter.level = level;
      }
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      filter.limit = Math.min(rawLimit, QUERY_LIMIT_MAX);

      const entries = deps.audit.query(filter);
      const lines = entries.map(
        (e) => `[${new Date(e.timestamp).toISOString()}] ${e.level} ${e.action} (${e.agentId}) — ${e.detail}`,
      );

      return toOCResult({
        ok: true,
        output: lines.length > 0 ? lines.join("\n") : "No audit entries found.",
        data: { entries, total: deps.audit.count() },
      });
    },
  };
}

// --- flock_provision ---

function createProvisionTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_provision",
    description:
      "Provision a new home directory on disk. Creates the workspace directory tree, " +
      "deploys workspace files (AGENTS.md, SOUL.md, etc.), and returns bind mount config for Clawdbot sandbox.",
    parameters: {
      type: "object",
      required: ["agentId", "nodeId"],
      properties: {
        agentId: {
          type: "string",
          description: "Agent ID for the new home",
        },
        nodeId: {
          type: "string",
          description: "Node ID where the home will be created",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";

      if (!agentId || !nodeId) {
        return toOCResult({ ok: false, error: "agentId and nodeId are required" });
      }

      // Authorization: Since context is not available in OpenClaw interface,
      // authorization is expected to be handled at a higher level

      // Path traversal defense — validate IDs before they reach the filesystem
      try {
        validateId(agentId, "agentId");
        validateId(nodeId, "nodeId");
      } catch (err) {
        return toOCResult({ ok: false, error: String(err) });
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

        return toOCResult({
          ok: true,
          output: lines.join("\n"),
          data: { ...result, binds },
        });
      } catch (err) {
        return toOCResult({ ok: false, error: String(err) });
      }
    },
  };
}

// --- flock_sysadmin_protocol ---

function createSysadminProtocolTool(): ToolDefinition {
  return {
    name: "flock_sysadmin_protocol",
    description:
      "Load the sysadmin protocol documents. Returns the triage classification guide, " +
      "agent knowledge management rules, and meta-governance framework. " +
      "Use 'section' to load a specific document, or omit for the full combined prompt.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["triage", "knowledge", "meta", "all"],
          description: "Which section to load. Default: all",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const section = typeof params.section === "string" ? params.section.trim() : "all";

      try {
        if (section === "all") {
          return toOCResult({
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
          return toOCResult({ ok: false, error: `Unknown section: ${section}. Use: triage, knowledge, meta, all` });
        }

        return toOCResult({
          ok: true,
          output: doc.content,
          data: { version: protocol.version, section },
        });
      } catch (err) {
        return toOCResult({ ok: false, error: String(err) });
      }
    },
  };
}

// --- flock_sysadmin_request ---

function createSysadminRequestTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_sysadmin_request",
    description:
      "Send a system-level request to the sysadmin agent via A2A protocol. " +
      "The sysadmin will triage the request as GREEN (auto-execute), " +
      "YELLOW (needs clarification), or RED (requires human approval). " +
      "Describe what you need and why.",
    parameters: {
      type: "object",
      required: ["request"],
      properties: {
        request: {
          type: "string",
          description: "Natural language description of what you need (what + why)",
        },
        context: {
          type: "string",
          description: "Additional context (project, environment, etc.)",
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Urgency level. Default: normal",
        },
        project: {
          type: "string",
          description: "Related project identifier",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const request = typeof params.request === "string" ? params.request.trim() : "";
      if (!request) {
        return toOCResult({ ok: false, error: "request is required — describe what you need and why" });
      }

      if (!deps.a2aClient) {
        return toOCResult({
          ok: false,
          error: "A2A transport not initialized. Sysadmin request requires the A2A transport layer.",
        });
      }

      const sysadminId = deps.sysadminAgentId;
      if (!sysadminId) {
        return toOCResult({
          ok: false,
          error: "No sysadmin agent registered on this node.",
        });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
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
          id: result.taskId || `sysreq-${Date.now()}`,
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "sysadmin-request",
          level,
          detail: request.slice(0, 500),
          result: result.state,
          duration,
        });

        return toOCResult({
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
          id: `sysreq-err-${Date.now()}`,
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "sysadmin-request",
          level: "RED",
          detail: `FAILED: ${request.slice(0, 300)} — ${errorMsg}`,
          result: "error",
          duration,
        });

        return toOCResult({ ok: false, error: `Sysadmin request failed: ${errorMsg}` });
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

function createMigrateTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_migrate",
    description:
      "Trigger a migration of an agent to a different node. " +
      "Only sysadmin role agents can use this tool. Initiates the full migration lifecycle " +
      "through the A2A protocol and automatically updates assignment routing.",
    parameters: {
      type: "object",
      required: ["targetAgentId", "targetNodeId"],
      properties: {
        targetAgentId: {
          type: "string",
          description: "The agent to migrate (format: agentId, not homeId)",
        },
        targetNodeId: {
          type: "string",
          description: "The destination node ID",
        },
        reason: {
          type: "string",
          description: "Reason for migration (default: 'orchestrator_rebalance')",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      // Check if migration orchestrator is available (preferred), else fall back to engine
      if (!deps.migrationOrchestrator && !deps.migrationEngine) {
        return toOCResult({ ok: false, error: "Migration orchestrator not initialized." });
      }

      // params.agentId is injected by OpenClaw as the CALLER's agent ID.
      // params.targetAgentId is the user-specified agent to migrate.
      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");

      // Role-based authorization: only sysadmin or orchestrator agents can trigger migrations
      const callerMeta = deps.a2aServer?.getAgentMeta(callerAgentId);
      if (callerMeta?.role !== "sysadmin" && callerMeta?.role !== "orchestrator") {
        return toOCResult({
          ok: false,
          error: `Permission denied: only sysadmin or orchestrator agents can trigger migrations. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      const agentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const targetNodeId = typeof params.targetNodeId === "string" ? params.targetNodeId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "orchestrator_rebalance";

      if (!agentId) {
        return toOCResult({ ok: false, error: "targetAgentId is required." });
      }
      if (!targetNodeId) {
        return toOCResult({ ok: false, error: "targetNodeId is required." });
      }

      // Validate reason is a valid MigrationReason
      const validReasons: MigrationReason[] = ["agent_request", "orchestrator_rebalance", "node_retiring", "lease_migration", "security_relocation", "resource_need"];
      if (!validReasons.includes(reason as MigrationReason)) {
        return toOCResult({
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

            return toOCResult({
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

            return toOCResult({
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
            id: `migration-error-${Date.now()}`,
            timestamp: Date.now(),
            agentId: callerAgentId,
            action: "migration-failed",
            level: "RED",
            detail: `Migration of ${agentId} to ${targetNodeId} threw: ${errorMsg}`,
            result: "error",
            duration,
          });

          return toOCResult({ ok: false, error: `Migration error: ${errorMsg}` });
        }
      }

      // No orchestrator available — cannot run migration lifecycle
      return toOCResult({
        ok: false,
        error: "Migration orchestrator not available. Cannot execute migration without orchestrator.",
      });
    },
  };
}

// --- flock_update_card ---

function createUpdateCardTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_update_card",
    description:
      "Update your own Agent Card. You can change your name, description, and/or skills. " +
      "You can only update your own card — not other agents' cards.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "New display name for the agent",
        },
        description: {
          type: "string",
          description: "New description of the agent's capabilities",
        },
        skills: {
          type: "string",
          description:
            "JSON array of AgentSkill objects. Each skill: { id, name, description?, tags?: string[] }. " +
            "Replaces the entire skill set.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      if (!deps.a2aServer) {
        return toOCResult({ ok: false, error: "A2A transport not initialized." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "");
      if (!callerAgentId) {
        return toOCResult({ ok: false, error: "agentId is required — cannot determine which card to update." });
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
            return toOCResult({ ok: false, error: "skills must be a JSON array of AgentSkill objects." });
          }
          // Validate each skill has at least id and name
          for (const s of parsed) {
            if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>).id !== "string" || typeof (s as Record<string, unknown>).name !== "string") {
              return toOCResult({ ok: false, error: "Each skill must have at least 'id' (string) and 'name' (string)." });
            }
          }
          updates.skills = parsed as AgentSkill[];
          hasUpdate = true;
        } catch {
          return toOCResult({ ok: false, error: "skills is not valid JSON." });
        }
      }

      if (!hasUpdate) {
        return toOCResult({ ok: false, error: "No updates provided. Specify at least one of: name, description, skills." });
      }

      const ok = registry.updateCard(callerAgentId, updates);
      if (!ok) {
        return toOCResult({ ok: false, error: `Agent card not found for '${callerAgentId}'. Cannot update a card that doesn't exist.` });
      }

      const updatedCard = registry.get(callerAgentId);
      return toOCResult({
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

function createSleepTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_sleep",
    description:
      "Enter SLEEP state. You stop receiving work loop ticks and thread notifications. " +
      "Only call this when you have no pending work and nothing to contribute. " +
      "You will stay asleep until explicitly woken by another agent (direct message, " +
      "mention, or flock_wake). Use sparingly — if you might have work soon, stay AWAKE.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why you're going to sleep (e.g. 'no pending work', 'waiting for external input')",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const agentLoop = deps.agentLoop;
      if (!agentLoop) {
        return toOCResult({ ok: false, error: "Agent loop store not available." });
      }

      const callerAgentId = typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "no reason given";

      const current = agentLoop.get(callerAgentId);
      if (!current) {
        return toOCResult({ ok: false, error: `Agent "${callerAgentId}" not found in loop state.` });
      }

      if (current.state === "SLEEP") {
        return toOCResult({ ok: true, output: `Already in SLEEP state.` });
      }

      agentLoop.setState(callerAgentId, "SLEEP", reason);

      deps.audit?.append({
        id: `sleep-${callerAgentId}-${Date.now()}`,
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-sleep",
        level: "GREEN",
        detail: `Agent entered SLEEP: ${reason.slice(0, 200)}`,
        result: "completed",
      });

      return toOCResult({
        ok: true,
        output: `Entering SLEEP state. You will not receive ticks or thread notifications until woken. Reason: ${reason}`,
        data: { state: "SLEEP", reason },
      });
    },
  };
}

// --- flock_wake ---

function createWakeTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_wake",
    description:
      "Wake a sleeping agent. The target agent will transition from SLEEP to AWAKE " +
      "and start receiving work loop ticks again. Use when you need an agent's input " +
      "or want them to participate in a discussion.",
    parameters: {
      type: "object",
      required: ["targetAgentId"],
      properties: {
        targetAgentId: {
          type: "string",
          description: "Agent ID to wake up.",
        },
        reason: {
          type: "string",
          description: "Why you're waking them (included in the wake notification).",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const agentLoop = deps.agentLoop;
      if (!agentLoop) {
        return toOCResult({ ok: false, error: "Agent loop store not available." });
      }

      const callerAgentId = typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown";
      const targetAgentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "woken by another agent";

      if (!targetAgentId) {
        return toOCResult({ ok: false, error: "'targetAgentId' is required." });
      }

      const current = agentLoop.get(targetAgentId);
      if (!current) {
        return toOCResult({ ok: false, error: `Agent "${targetAgentId}" not found in loop state.` });
      }

      if (current.state === "AWAKE") {
        return toOCResult({ ok: true, output: `Agent "${targetAgentId}" is already AWAKE.` });
      }

      agentLoop.setState(targetAgentId, "AWAKE");

      deps.audit?.append({
        id: `wake-${targetAgentId}-${Date.now()}`,
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-wake",
        level: "GREEN",
        detail: `Agent "${targetAgentId}" woken by "${callerAgentId}": ${reason.slice(0, 200)}`,
        result: "completed",
      });

      // Send a wake notification to the agent via A2A
      if (deps.a2aClient) {
        const wakeMessage = [
          `[Wake Notification]`,
          `You were woken by ${callerAgentId}.`,
          `Reason: ${reason}`,
          ``,
          `You are now AWAKE. Check your threads and pending work.`,
        ].join("\n");

        deps.a2aClient.sendA2A(targetAgentId, {
          message: userMessage(wakeMessage),
        }).catch((err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          deps.logger?.warn(`[flock:wake] Wake notification to "${targetAgentId}" failed: ${errorMsg}`);
        });
      }

      return toOCResult({
        ok: true,
        output: `Agent "${targetAgentId}" woken up. They will start receiving work loop ticks.`,
        data: { targetAgentId, state: "AWAKE", wokenBy: callerAgentId },
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

function createMessageTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_message",
    description:
      "Send a message to another agent via A2A protocol. " +
      "Use flock_discover to find available agents, then send your message in natural language.",
    parameters: {
      type: "object",
      required: ["to", "message"],
      properties: {
        to: {
          type: "string",
          description: "Target agent ID. Use flock_discover to find available agents.",
        },
        message: {
          type: "string",
          description: "Natural language message to send to the agent.",
        },
        contextData: {
          type: "object",
          description: "Optional structured data to attach alongside the message as an A2A DataPart.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      if (!deps.a2aClient) {
        return toOCResult({ ok: false, error: "A2A transport not initialized." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
      const to = typeof params.to === "string" ? params.to.trim() : "";
      const message = typeof params.message === "string" ? params.message.trim() : "";

      if (!to) return toOCResult({ ok: false, error: "'to' is required — specify the target agent ID." });
      if (!message) return toOCResult({ ok: false, error: "'message' is required — describe what you need." });

      const contextData = typeof params.contextData === "object" && params.contextData !== null
        ? params.contextData as Record<string, unknown>
        : undefined;

      const startTime = Date.now();
      const contextId = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const taskId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

        // Construct A2A message directly
        const extraParts = contextData ? [dataPart(contextData)] : undefined;
        const a2aParams = { message: userMessage(message, extraParts) };

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
            id: `msg-err-${now}`,
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
        return toOCResult({
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
          id: `msg-err-${Date.now()}`,
          timestamp: Date.now(),
          agentId: callerAgentId,
          action: "message",
          level: "YELLOW",
          detail: `FAILED → ${to}: ${errorMsg.slice(0, 200)}`,
          result: "error",
          duration: Date.now() - startTime,
        });

        return toOCResult({ ok: false, error: `Message failed: ${errorMsg}` });
      }
    },
  };
}

// --- flock_broadcast ---
// Async fire-and-forget: posts to shared thread, notifies agents without
// waiting for responses. Agents respond via flock_thread_post. This mirrors
// the Clawdbot Discord/Telegram pattern where a channel is the shared medium
// and each agent reads history independently — no synchronous call chain.

/** Max messages included in a single thread notification (delta mode). */
const THREAD_NOTIFY_MAX_MESSAGES = 20;
/** Max chars per message included in a thread notification (snippets only). */
const THREAD_NOTIFY_MAX_CHARS = 400;

/**
 * Per-agent thread notification state.
 *
 * We track two seqs:
 * - sentSeq: highest seq successfully delivered to the agent
 * - scheduledSeq: highest seq currently scheduled/in-flight (prevents storms)
 */
const sentSeqs = new Map<string, Map<string, number>>();
const scheduledSeqs = new Map<string, Map<string, number>>();

function getSeq(map: Map<string, Map<string, number>>, threadId: string, agentId: string): number {
  return map.get(threadId)?.get(agentId) ?? 0;
}

function setSeq(map: Map<string, Map<string, number>>, threadId: string, agentId: string, seq: number): void {
  if (!map.has(threadId)) map.set(threadId, new Map());
  map.get(threadId)!.set(agentId, seq);
}

function buildThreadDeltaNotification(args: {
  threadId: string;
  participants: string[];
  fromSeq: number;
  toSeq: number;
  messages: Array<{ seq: number; agentId: string; content: string }>;
  truncated?: boolean;
}): string {
  const { threadId, participants, fromSeq, toSeq, messages, truncated } = args;

  const msgLines = messages.map((m) => {
    const raw = m.content ?? "";
    const snippet = raw.replace(/\s+/g, " ").slice(0, THREAD_NOTIFY_MAX_CHARS);
    const suffix = snippet.length < raw.length ? "…" : "";
    return `[seq ${m.seq}] ${m.agentId}: ${snippet}${suffix}`;
  });

  const truncNote = truncated
    ? `NOTE: Too many new messages to include inline; showing the most recent ${messages.length}. Use flock_thread_read(threadId="${threadId}") for full context.`
    : `If you need older context, use flock_thread_read(threadId="${threadId}") to read the full thread.`;

  return [
    `[Thread Notification — thread: ${threadId}]`,
    `Participants: ${participants.join(", ")}`,
    `New messages: seq ${fromSeq}..${toSeq} (${toSeq - fromSeq + 1})`,
    ``,
    `--- New Messages ---`,
    ...(msgLines.length > 0 ? msgLines : ["(no messages)"]),
    `--- End New Messages ---`,
    ``,
    truncNote,
    ``,
    `IMPORTANT — You do NOT have to respond to every message:`,
    `- If the discussion is converging and others have already covered your points, stay silent.`,
    `- If the message is not directed at you or your role, you may skip it.`,
    `- If you would only be confirming what someone else said ("I agree", "same here"), skip it.`,
    `- Respond ONLY when you have genuinely new information, a different perspective, or a decision that needs your role's input.`,
    `- It is perfectly fine to not respond. Silence is a valid and valuable choice.`,
    ``,
    `If you decide to respond, use flock_thread_post(threadId="${threadId}", message="your response").`,
    `Do NOT use flock_broadcast to respond — use flock_thread_post only.`,
    `If you have nothing new to add, simply acknowledge internally and do NOT call flock_thread_post.`,
  ].join("\n");
}

type NotifyAgentArgs = {
  deps: ToolDeps;
  target: string;
  threadId: string;
  taskId: string;
  currentMaxSeq: number;
  participants: string[];
  fallbackText?: string;
};

/** Fire-and-forget: send delta notification to an agent without awaiting response. */
function notifyAgent(args: NotifyAgentArgs): void {
  const { deps, target, threadId, taskId, currentMaxSeq, participants, fallbackText } = args;

  // Skip notification for SLEEP agents — they only wake on explicit triggers.
  // Thread notifications are not explicit triggers; direct messages and flock_wake are.
  if (deps.agentLoop) {
    const loopState = deps.agentLoop.get(target);
    if (loopState?.state === "SLEEP") {
      deps.logger?.debug?.(`[flock:notify] Skipping "${target}" for thread ${threadId} — agent is SLEEP`);
      return;
    }
  }

  // Track thread participation for the work loop scheduler
  if (deps.workLoopScheduler) {
    deps.workLoopScheduler.trackThread(target, threadId, currentMaxSeq);
  }

  // Delta dedup / storm prevention
  const sentSeq = getSeq(sentSeqs, threadId, target);
  const scheduledSeq = getSeq(scheduledSeqs, threadId, target);

  if (scheduledSeq >= currentMaxSeq) {
    deps.logger?.debug?.(`[flock:notify] Skipping "${target}" for thread ${threadId} — already scheduled up to seq ${scheduledSeq}`);
    return;
  }

  setSeq(scheduledSeqs, threadId, target, currentMaxSeq);

  // Random delay (1-5s) to prevent broadcast storm — like Ethernet collision avoidance.
  const delayMs = 1000 + Math.floor(Math.random() * 4000);
  deps.logger?.debug?.(`[flock:notify] Delaying notification to "${target}" for ${delayMs}ms (thread ${threadId}, seq ${currentMaxSeq})`);

  setTimeout(() => {
    const threadStore = deps.threadMessages;

    // Stale check: if new messages arrived during our delay, skip this notification.
    // The newer thread_post will trigger its own notification with updated context.
    if (threadStore) {
      const latest = threadStore.list({ threadId, since: currentMaxSeq });
      const latestMaxSeq = latest.length > 0 ? Math.max(...latest.map(m => m.seq)) : currentMaxSeq;
      if (latestMaxSeq > currentMaxSeq) {
        deps.logger?.debug?.(`[flock:notify] Skipping stale notification to "${target}" for thread ${threadId} — seq moved from ${currentMaxSeq} to ${latestMaxSeq}`);
        return;
      }
    }

    let notificationText = fallbackText ?? `[Thread Notification — thread: ${threadId}] (no thread store available)`;

    if (threadStore && currentMaxSeq > 0) {
      const fromSeq = sentSeq + 1;
      const tailStart = Math.max(fromSeq, currentMaxSeq - THREAD_NOTIFY_MAX_MESSAGES + 1);
      const delta = threadStore
        .list({ threadId, since: tailStart, limit: THREAD_NOTIFY_MAX_MESSAGES })
        .filter(m => m.seq <= currentMaxSeq);

      const truncated = tailStart > fromSeq;
      notificationText = buildThreadDeltaNotification({
        threadId,
        participants,
        fromSeq,
        toSeq: currentMaxSeq,
        messages: delta,
        truncated,
      });
    }

    const a2aParams = { message: userMessage(notificationText) };

    deps.a2aClient!.sendA2A(target, a2aParams).then((result) => {
      const now = Date.now();

      // Update sent seq only on success
      setSeq(sentSeqs, threadId, target, Math.max(getSeq(sentSeqs, threadId, target), currentMaxSeq));

      // Fire-and-forget: do NOT store inline responses in thread.
      if (result.response) {
        deps.audit.append({
          id: `notify-ack-${threadId}-${target}-${now}`,
          timestamp: now,
          agentId: target,
          action: "notify-ack",
          level: "GREEN",
          detail: `Agent "${target}" acknowledged thread ${threadId}: ${(result.response ?? "").slice(0, 200)}`,
          result: "completed",
        });
      }
      if (deps.taskStore) {
        deps.taskStore.update(taskId, {
          state: result.state === "completed" ? "completed" : "failed",
          responseText: result.response,
          updatedAt: now,
          completedAt: now,
        });
      }
    }).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.logger?.warn(`[flock:broadcast] Notification to "${target}" failed: ${errorMsg}`);

      // Allow retry on next notify: roll back scheduled seq to last sent seq
      setSeq(scheduledSeqs, threadId, target, getSeq(sentSeqs, threadId, target));

      // Do NOT store errors in thread_messages — only audit
      if (deps.taskStore) {
        deps.taskStore.update(taskId, {
          state: "failed",
          responseText: errorMsg,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        });
      }
      deps.audit.append({
        id: `notify-fail-${threadId}-${target}-${Date.now()}`,
        timestamp: Date.now(),
        agentId: target,
        action: "notify-failed",
        level: "YELLOW",
        detail: `Thread ${threadId}: notification to ${target} failed — ${errorMsg.slice(0, 200)}`,
        result: "failed",
      });
    });
  }, delayMs); // end setTimeout
}

function createBroadcastTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_broadcast",
    description:
      "Start or continue a group discussion thread. Posts your message to a shared thread and " +
      "notifies all recipients asynchronously (fire-and-forget). Recipients receive only NEW thread " +
      "messages since their last notification (delta mode) to avoid O(n²) prompt growth. " +
      "Use flock_thread_read to fetch full history when needed.",
    parameters: {
      type: "object",
      required: ["to", "message"],
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Array of target agent IDs. Use flock_discover to find available agents.",
        },
        message: {
          type: "string",
          description: "Message to post to the thread and broadcast to all participants.",
        },
        threadId: {
          type: "string",
          description: "Optional thread ID to continue an existing group conversation. " +
            "If omitted, a new thread is created. Pass the returned threadId in subsequent calls for continuity.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      if (!deps.a2aClient) {
        return toOCResult({ ok: false, error: "A2A transport not initialized." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
      const toRaw = params.to;
      const targets: string[] = Array.isArray(toRaw)
        ? toRaw.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map(s => s.trim())
        : typeof toRaw === "string" ? toRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
      const message = typeof params.message === "string" ? params.message.trim() : "";
      const threadId = typeof params.threadId === "string" && params.threadId.trim()
        ? params.threadId.trim()
        : `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (targets.length === 0) {
        return toOCResult({ ok: false, error: "'to' must contain at least one agent ID." });
      }
      if (!message) {
        return toOCResult({ ok: false, error: "'message' is required." });
      }

      const startTime = Date.now();
      const participants = [...new Set([callerAgentId, ...targets])];
      const threadStore = deps.threadMessages;

      // Auto-wake: broadcast targets are explicit wake triggers
      if (deps.agentLoop) {
        for (const target of targets) {
          const targetState = deps.agentLoop.get(target);
          if (targetState?.state === "SLEEP") {
            deps.agentLoop.setState(target, "AWAKE");
            deps.logger?.info(`[flock:broadcast] Auto-woke "${target}" as broadcast target`);
          }
        }
      }

      // --- Append sender's message to shared thread ---
      let currentMaxSeq = 0;
      if (threadStore) {
        currentMaxSeq = threadStore.append({
          threadId,
          agentId: callerAgentId,
          content: message,
          timestamp: startTime,
        });

        // Track thread participation for work loop
        if (deps.workLoopScheduler) {
          deps.workLoopScheduler.trackThread(callerAgentId, threadId, currentMaxSeq);
          // Also track all targets so the scheduler knows they're in this thread
          for (const t of targets) {
            deps.workLoopScheduler.trackThread(t, threadId, currentMaxSeq);
          }
        }
      }

      const messageCount = threadStore ? threadStore.count(threadId) : 0;
      const fallbackText = [
        `[Thread Notification — thread: ${threadId}]`,
        `Participants: ${participants.join(", ")}`,
        ``,
        `[${callerAgentId}]: ${message}`,
        ``,
        `Use flock_thread_read(threadId="${threadId}") for full history.`,
      ].join("\n");

      // Audit
      deps.audit.append({
        id: `broadcast-${threadId}-${Date.now()}`,
        timestamp: startTime,
        agentId: callerAgentId,
        action: "broadcast",
        level: "GREEN",
        detail: `Broadcast to [${targets.join(", ")}]: ${message.slice(0, 200)}`,
        result: "submitted",
      });

      // Record tasks + fire-and-forget notifications
      const taskStore = deps.taskStore;
      const taskIds: Record<string, string> = {};
      for (const target of targets) {
        const taskId = `bc-${threadId}-${target}-${Date.now()}`;
        taskIds[target] = taskId;
        if (taskStore) {
          taskStore.insert({
            taskId,
            contextId: threadId,
            fromAgentId: callerAgentId,
            toAgentId: target,
            state: "submitted",
            messageType: "broadcast",
            summary: message.slice(0, 200),
            payload: JSON.stringify({ message, threadId, participants }),
            responseText: null,
            responsePayload: null,
            createdAt: startTime,
            updatedAt: startTime,
            completedAt: null,
          });
        }

        // Fire-and-forget: notify agent without waiting (delta mode)
        notifyAgent({ deps, target, threadId, taskId, currentMaxSeq, participants, fallbackText });
      }

      return toOCResult({
        ok: true,
        output: [
          `Message posted to thread ${threadId} and ${targets.length} agents notified.`,
          `Thread history: ${messageCount} messages.`, 
          `Use flock_thread_read(threadId="${threadId}") to check for responses.`,
        ].join("\n"),
        data: { threadId, participants, messageCount, taskIds },
      });
    },
  };
}

// --- flock_thread_post ---
// Agents use this to respond to a thread. Appends to thread_messages and
// optionally notifies other participants (fire-and-forget).

function createThreadPostTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_thread_post",
    description:
      "Post a message to a shared discussion thread. Your message is appended to the thread " +
      "history and other participants are notified asynchronously. Use this to respond in " +
      "group discussions instead of flock_broadcast.",
    parameters: {
      type: "object",
      required: ["threadId", "message"],
      properties: {
        threadId: {
          type: "string",
          description: "Thread ID to post to (from a previous flock_broadcast or notification).",
        },
        message: {
          type: "string",
          description: "Your response message to post to the thread.",
        },
        notify: {
          type: "boolean",
          description: "If true (default), notify other thread participants of your new message. " +
            "Notifications are automatically deduplicated — agents won't be notified if they " +
            "already saw all current messages. Set to false to post silently.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const threadStore = deps.threadMessages;
      if (!threadStore) {
        return toOCResult({ ok: false, error: "Thread store not available." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const message = typeof params.message === "string" ? params.message.trim() : "";
      const shouldNotify = params.notify !== false;

      if (!threadId) {
        return toOCResult({ ok: false, error: "'threadId' is required." });
      }
      if (!message) {
        return toOCResult({ ok: false, error: "'message' is required." });
      }

      const now = Date.now();

      // Append to thread
      const newSeq = threadStore.append({ threadId, agentId: callerAgentId, content: message, timestamp: now });

      // Track thread participation for work loop
      if (deps.workLoopScheduler) {
        deps.workLoopScheduler.trackThread(callerAgentId, threadId, newSeq);
      }

      // Audit
      deps.audit.append({
        id: `thread-post-${threadId}-${callerAgentId}-${now}`,
        timestamp: now,
        agentId: callerAgentId,
        action: "thread-post",
        level: "GREEN",
        detail: `Posted to thread ${threadId}: ${message.slice(0, 200)}`,
        result: "completed",
      });

      const history = threadStore.list({ threadId });
      const messageCount = threadStore.count(threadId);

      // Notify other participants (fire-and-forget, delta mode)
      if (shouldNotify && deps.a2aClient) {
        const allAgents = [...new Set(history.map(m => m.agentId))];
        const otherParticipants = allAgents.filter(a => a !== callerAgentId);

        if (otherParticipants.length > 0) {
          const fallbackText = [
            `[Thread Notification — thread: ${threadId}]`,
            `Participants: ${allAgents.join(", ")}`,
            ``,
            `[${callerAgentId}]: ${message}`,
            ``,
            `Use flock_thread_read(threadId="${threadId}") for full history.`,
          ].join("\n");

          for (const target of otherParticipants) {
            const taskId = `tp-${threadId}-${target}-${now}`;
            notifyAgent({
              deps,
              target,
              threadId,
              taskId,
              currentMaxSeq: newSeq,
              participants: allAgents,
              fallbackText,
            });
          }
        }
      }

      return toOCResult({
        ok: true,
        output: `Message posted to thread ${threadId}. Thread now has ${messageCount} messages.`,
        data: { threadId, messageCount },
      });
    },
  };
}

// --- flock_thread_read ---

function createThreadReadTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_thread_read",
    description:
      "Read the message history of a shared discussion thread. Returns all messages " +
      "in chronological order with author and content.",
    parameters: {
      type: "object",
      required: ["threadId"],
      properties: {
        threadId: {
          type: "string",
          description: "Thread ID to read.",
        },
        after: {
          type: "number",
          description: "Only return messages with seq greater than this value (for polling new messages).",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const threadStore = deps.threadMessages;
      if (!threadStore) {
        return toOCResult({ ok: false, error: "Thread store not available." });
      }

      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      const afterSeq = typeof params.after === "number" ? params.after : 0;

      if (!threadId) {
        return toOCResult({ ok: false, error: "'threadId' is required." });
      }

      const allMessages = threadStore.list({ threadId });
      const messages = afterSeq > 0
        ? threadStore.list({ threadId, since: afterSeq + 1 })
        : allMessages;

      if (messages.length === 0) {
        return toOCResult({
          ok: true,
          output: afterSeq > 0
            ? `No new messages in thread ${threadId} after seq ${afterSeq}.`
            : `Thread ${threadId} is empty or does not exist.`,
          data: { threadId, messages: [], total: allMessages.length },
        });
      }

      const formatted = messages.map(m =>
        `[seq ${m.seq}] ${m.agentId}: ${m.content}`
      ).join("\n\n");

      const participants = [...new Set(allMessages.map(m => m.agentId))];

      return toOCResult({
        ok: true,
        output: [
          `## Thread ${threadId} — ${messages.length} messages${afterSeq > 0 ? ` (after seq ${afterSeq})` : ""}`,
          `Participants: ${participants.join(", ")}`,
          `Total messages: ${allMessages.length}`,
          ``,
          formatted,
        ].join("\n"),
        data: { threadId, messages, total: allMessages.length, participants },
      });
    },
  };
}

// --- flock_discover ---

function createDiscoverTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_discover",
    description:
      "Discover available agents in the swarm. Query by role, skill, or free-text. " +
      "Returns agent profiles with capabilities and recent task completion stats.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search across agent names, descriptions, and skills",
        },
        role: {
          type: "string",
          enum: ["worker", "sysadmin"],
          description: "Filter by agent role",
        },
        skill: {
          type: "string",
          description: "Filter by skill tag (e.g. 'implement', 'review', 'research')",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 20",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      if (!deps.a2aServer) {
        return toOCResult({ ok: false, error: "A2A transport not initialized." });
      }

      const query = typeof params.query === "string" ? params.query.trim().toLowerCase() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const skill = typeof params.skill === "string" ? params.skill.trim() : "";
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      const registry = deps.a2aServer.cardRegistry;
      let entries = registry.list();

      // Filter by role
      if (role === "worker" || role === "sysadmin") {
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
      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");

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
        return toOCResult({ ok: true, output: "No agents found matching the query.", data: { agents: [] } });
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

      return toOCResult({
        ok: true,
        output: lines.join("\n"),
        data: { agents },
      });
    },
  };
}

// --- flock_history ---

function createHistoryTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_history",
    description:
      "Query past task completions and collaboration patterns. " +
      "Shows who worked with whom, what tasks completed or failed, and patterns over time.",
    parameters: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Filter by agent (as sender or receiver)",
        },
        messageType: {
          type: "string",
          description: "Filter by message type",
        },
        state: {
          type: "string",
          enum: [...TASK_STATES],
          description: "Filter by task state",
        },
        since: {
          type: "number",
          description: "Only tasks created after this epoch ms timestamp",
        },
        limit: {
          type: "number",
          description: "Max entries to return. Default: 20",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toOCResult({ ok: false, error: "Task store not available." });
      }

      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      const messageType = typeof params.messageType === "string" ? params.messageType.trim() : "";
      const stateParam = typeof params.state === "string" ? params.state.trim() : "";
      const since = typeof params.since === "number" ? params.since : undefined;
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      // Validate state if provided
      if (stateParam && !isTaskState(stateParam)) {
        return toOCResult({ ok: false, error: `Invalid state: ${stateParam}. Valid: ${TASK_STATES.join(", ")}` });
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
        return toOCResult({ ok: true, output: "No task history found matching the query.", data: { tasks: [] } });
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

      return toOCResult({
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

function createTasksTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_tasks",
    description:
      "List tasks for the calling agent. Shows both sent and received tasks " +
      "with their current state. Use to track pending work and check on requests you've made.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["sent", "received", "all"],
          description: "Filter by direction: sent (tasks you created), received (tasks assigned to you), all (both). Default: all",
        },
        state: {
          type: "string",
          enum: [...TASK_STATES],
          description: "Filter by task state",
        },
        limit: {
          type: "number",
          description: "Max tasks to return. Default: 20",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toOCResult({ ok: false, error: "Task store not available." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
      const direction = typeof params.direction === "string" ? params.direction.trim() : "all";
      const stateParam = typeof params.state === "string" ? params.state.trim() : "";
      const rawLimit = typeof params.limit === "number" ? params.limit : 20;
      const limit = Math.min(Math.max(1, rawLimit), QUERY_LIMIT_MAX);

      if (stateParam && !isTaskState(stateParam)) {
        return toOCResult({ ok: false, error: `Invalid state: ${stateParam}. Valid: ${TASK_STATES.join(", ")}` });
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
        return toOCResult({ ok: true, output: "No tasks found.", data: { tasks: [] } });
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

      return toOCResult({
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

function createTaskRespondTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_task_respond",
    description:
      "Respond to a task that requires your input (state: input-required). " +
      "Use when another agent has asked you a clarification question during task processing.",
    parameters: {
      type: "object",
      required: ["taskId", "response"],
      properties: {
        taskId: {
          type: "string",
          description: "The task ID to respond to",
        },
        response: {
          type: "string",
          description: "Your response to the clarification question",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const taskStore = deps.taskStore;
      if (!taskStore) {
        return toOCResult({ ok: false, error: "Task store not available." });
      }

      const callerAgentId = (typeof params.agentId === "string" && params.agentId.trim()) ? params.agentId.trim() : (typeof params._callerAgentId === "string" ? params._callerAgentId : "unknown");
      const taskId = typeof params.taskId === "string" ? params.taskId.trim() : "";
      const response = typeof params.response === "string" ? params.response.trim() : "";

      if (!taskId) {
        return toOCResult({ ok: false, error: "taskId is required." });
      }
      if (!response) {
        return toOCResult({ ok: false, error: "response is required." });
      }

      // Look up the task
      const task = taskStore.get(taskId);
      if (!task) {
        return toOCResult({ ok: false, error: `Task not found: ${taskId}` });
      }

      // Verify the caller is the intended recipient
      if (task.toAgentId !== callerAgentId) {
        return toOCResult({
          ok: false,
          error: `Permission denied: task ${taskId} is addressed to ${task.toAgentId}, not ${callerAgentId}.`,
        });
      }

      // Verify the task is in input-required state
      if (task.state !== "input-required") {
        return toOCResult({
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
        const followUpMessage = userMessage(`Response to task ${taskId}: ${response}`);

        deps.a2aClient.sendA2A(task.fromAgentId, { message: followUpMessage }).catch((err: unknown) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          deps.audit.append({
            id: `task-respond-err-${Date.now()}`,
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
        id: `task-respond-${now}`,
        timestamp: now,
        agentId: callerAgentId,
        action: "task-respond",
        level: "GREEN",
        detail: `Responded to task ${taskId}: ${response.slice(0, 200)}`,
        result: "working",
      });

      return toOCResult({
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
