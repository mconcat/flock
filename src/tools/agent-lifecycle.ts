/**
 * Agent Lifecycle Tools — create and decommission agents at runtime.
 *
 * Tools:
 * - flock_create_agent: Create a new agent on the current node (orchestrator only)
 * - flock_decommission_agent: Remove an agent from the current node (orchestrator only)
 * - flock_restart_gateway: Restart the gateway process (sysadmin only)
 *
 * These tools enable the orchestrator to manage the agent fleet
 * programmatically without manual config editing.
 *
 * NOTE: These tools are registered as OpenClaw tool factories (not static tools).
 * OpenClaw calls the factory per-request with ctx.agentId, which we capture
 * as the caller identity for authorization checks.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { toResult } from "./result.js";
import { validateId } from "../homes/utils.js";
import { uniqueId } from "../utils/id.js";
import { createGatewaySessionSend } from "../transport/gateway-send.js";
import { createWorkerCard, createSysadminCard, createOrchestratorCard } from "../transport/agent-card.js";
import { createFlockExecutor } from "../transport/executor.js";
import type { ToolDeps } from "./index.js";

/**
 * Resolve the caller agent ID from multiple sources (in priority order):
 * 1. OpenClaw per-request context (callerAgentId from factory)
 * 2. params.agentId (legacy: in case OpenClaw injects it in the future)
 * 3. Session key parsing: extract agentId from "agent:{id}:..." pattern
 * 4. "unknown" fallback
 */
function resolveCallerAgentId(callerFromCtx: string | undefined, params: Record<string, unknown>, sessionKey?: string): string {
  if (callerFromCtx && callerFromCtx !== "main") return callerFromCtx;
  if (typeof params.agentId === "string" && params.agentId.trim()) return params.agentId.trim();
  // Fallback: parse session key if available (pattern: "agent:{agentId}:{rest}")
  const sk = sessionKey || (typeof (params as Record<string, unknown>).sessionKey === "string" ? (params as Record<string, unknown>).sessionKey as string : undefined);
  if (sk) {
    const parts = sk.split(":");
    if (parts[0] === "agent" && parts[1]) return parts[1];
  }
  // If ctx gave us "main", still use it (better than "unknown")
  if (callerFromCtx) return callerFromCtx;
  return "unknown";
}

/**
 * Check if a caller has the required privileged role.
 * @param allowedRoles - roles that grant access (e.g. ["orchestrator"] or ["orchestrator", "sysadmin"])
 */
function isCallerPrivileged(
  callerAgentId: string,
  a2aServer: ToolDeps["a2aServer"],
  allowedRoles: string[],
): boolean {
  if (!a2aServer) return false;

  // Direct match: caller is registered with an allowed role
  const callerMeta = a2aServer.getAgentMeta(callerAgentId);
  if (callerMeta?.role && allowedRoles.includes(callerMeta.role)) return true;

  // Fallback: if caller is "main" (OpenClaw default identity when agent header
  // isn't propagated), check if there's a registered agent with an allowed role.
  if (callerAgentId === "main") {
    const cards = a2aServer.listAgentCards?.() ?? [];
    const hasPrivileged = cards.some((entry) => {
      const meta = a2aServer.getAgentMeta(entry.agentId);
      return meta?.role ? allowedRoles.includes(meta.role) : false;
    });
    if (hasPrivileged) return true;
  }

  return false;
}

// --- TypeBox Schemas ---

const CreateAgentParams = Type.Object({
  newAgentId: Type.String({
    description: "Unique agent ID for the new agent (alphanumeric, dash, underscore only)",
  }),
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("sysadmin"),
    Type.Literal("system"),
    Type.Literal("orchestrator"),
  ], { description: "Agent role: worker, sysadmin, system, or orchestrator" }),
  mutableLayer: Type.Optional(Type.String({
    description: "Layer 3 content (SOUL.md, IDENTITY.md, etc.) for prompt assembly",
  })),
  archetype: Type.Optional(Type.String({
    description: "Archetype name to use as Layer 3 base (e.g. 'researcher', 'coder')",
  })),
  model: Type.Optional(Type.String({
    description: "Primary model for this agent (e.g. 'anthropic/claude-opus-4-5', 'openai-codex/gpt-5.2'). If omitted, the node default model is used.",
  })),
  systemPrompt: Type.Optional(Type.String({
    description: "Full system prompt (overrides layer assembly if provided)",
  })),
});

const DecommissionAgentParams = Type.Object({
  targetAgentId: Type.String({ description: "Agent ID to decommission" }),
  reason: Type.String({ description: "Reason for decommissioning the agent" }),
});

const RestartGatewayParams = Type.Object({});

// ---------------------------------------------------------------------------
// flock_create_agent
// ---------------------------------------------------------------------------

export function createCreateAgentTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): AgentTool<typeof CreateAgentParams, Record<string, unknown>> {
  return {
    name: "flock_create_agent",
    label: "Create Agent",
    description:
      "Create a new agent on the current node. Only orchestrator role agents can use this tool. " +
      "The agent will be registered in the A2A server, provisioned on disk, and persisted to config.",
    parameters: CreateAgentParams,
    async execute(_toolCallId: string, params: Static<typeof CreateAgentParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      // Widen params to allow runtime-injected fields (agentId, sessionKey, _callerAgentId)
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, rawParams, sessionKeyFromCtx);
      const newAgentId = typeof params.newAgentId === "string" ? params.newAgentId.trim() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const archetype = typeof params.archetype === "string" ? params.archetype.trim() : "";
      const model = typeof params.model === "string" ? params.model.trim() : "";
      const systemPromptParam = typeof params.systemPrompt === "string" ? params.systemPrompt.trim() : "";

      // Validate required params
      if (!newAgentId) {
        return toResult({ ok: false, error: "newAgentId is required — the ID for the new agent to create." });
      }
      if (newAgentId.startsWith("human:")) {
        return toResult({ ok: false, error: "Agent IDs cannot start with 'human:' — this prefix is reserved for human participants." });
      }
      const validRoles = ["worker", "sysadmin", "system", "orchestrator"];
      if (!validRoles.includes(role)) {
        return toResult({ ok: false, error: `role must be one of: ${validRoles.join(", ")}. Got: '${role}'` });
      }

      // Validate ID format (path traversal protection)
      try {
        validateId(newAgentId, "newAgentId");
      } catch (err) {
        return toResult({ ok: false, error: String(err) });
      }

      // Authorization: only orchestrator agents can create agents
      if (!deps.a2aServer) {
        return toResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toResult({
          ok: false,
          error: `Permission denied: only orchestrator agents can create agents. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      // Check agent doesn't already exist
      if (deps.a2aServer.hasAgent(newAgentId)) {
        return toResult({
          ok: false,
          error: `Agent '${newAgentId}' already exists on this node. Use flock_discover to check existing agents.`,
        });
      }

      // Create gateway session send function
      if (!deps.config.gateway.token) {
        return toResult({ ok: false, error: "Gateway token not configured. Cannot create agent session." });
      }
      if (!deps.logger) {
        return toResult({ ok: false, error: "Logger not available. Cannot create gateway session send." });
      }

      const sessionSend = createGatewaySessionSend({
        port: deps.config.gateway.port,
        token: deps.config.gateway.token,
        logger: deps.logger,
      });

      // Create agent card — each role gets its own card type
      const nodeId = deps.config.nodeId;
      const endpointUrl = `http://localhost:${deps.config.gateway.port}/flock/a2a/${newAgentId}`;
      const { card, meta } = role === "orchestrator"
        ? createOrchestratorCard(nodeId, endpointUrl, newAgentId)
        : role === "sysadmin"
          ? createSysadminCard(nodeId, endpointUrl, newAgentId)
          : createWorkerCard(newAgentId, nodeId, endpointUrl);

      // Create executor
      const executor = createFlockExecutor({
        flockMeta: meta,
        sessionSend,
        audit: deps.audit,
        taskStore: deps.taskStore,
        logger: deps.logger,
      });

      // Register on A2A server
      deps.a2aServer.registerAgent(newAgentId, card, meta, executor);

      // Provision home directory (non-fatal if fails)
      let provisionWarning: string | undefined;
      let provisionResult: import("../homes/provisioner.js").ProvisionResult | undefined;
      try {
        provisionResult = deps.provisioner.provision(newAgentId, nodeId, {
          role: role as import("../transport/types.js").FlockAgentRole,
          archetype: archetype || undefined,
        });
      } catch (err) {
        provisionWarning = `Home provisioning failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
      }

      // Sync flock workspace files to OpenClaw workspace directory
      // Gather co-resident agents for USER.md context
      const coResidentAgents = deps.a2aServer
        ? (deps.a2aServer.listAgentCards?.() ?? []).map((entry) => {
            const entryMeta = deps.a2aServer!.getAgentMeta(entry.agentId);
            return {
              id: entry.agentId,
              role: (entryMeta?.role ?? "worker") as import("../transport/types.js").FlockAgentRole,
              archetype: undefined as string | undefined,
            };
          })
        : [];
      try {
        deps.provisioner.syncToOpenClawWorkspace(
          newAgentId,
          { role: role as import("../transport/types.js").FlockAgentRole, archetype: archetype || undefined },
          coResidentAgents,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (provisionWarning) {
          provisionWarning += `; OpenClaw workspace sync also failed: ${msg}`;
        } else {
          provisionWarning = `OpenClaw workspace sync failed: ${msg}`;
        }
      }

      // Persist to config file — both flock gatewayAgents AND openclaw agents.list
      let configWarning: string | undefined;
      try {
        const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const flockConfig = raw?.plugins?.entries?.flock?.config;
          if (flockConfig) {
            // 1. Add to flock gatewayAgents
            if (!Array.isArray(flockConfig.gatewayAgents)) {
              flockConfig.gatewayAgents = [];
            }
            const entry: Record<string, unknown> = { id: newAgentId };
            if (role !== "worker") entry.role = role;
            if (archetype) entry.archetype = archetype;
            if (systemPromptParam) entry.systemPrompt = systemPromptParam;
            flockConfig.gatewayAgents.push(entry);

            // 2. Add to OpenClaw agents.list
            if (!raw.agents) raw.agents = {};
            if (!Array.isArray(raw.agents.list)) raw.agents.list = [];
            const existsInAgentsList = raw.agents.list.some(
              (a: Record<string, unknown>) => a && a.id === newAgentId,
            );
            if (!existsInAgentsList) {
              const agentEntry: Record<string, unknown> = {
                id: newAgentId,
                workspace: `~/.openclaw/workspace-${newAgentId}`,
                tools: {
                  alsoAllow: ["group:plugins"],
                  sandbox: {
                    tools: {
                      allow: [
                        "exec", "process", "read", "write", "edit", "apply_patch",
                        "image", "sessions_list", "sessions_history", "sessions_send",
                        "sessions_spawn", "session_status", "flock_*",
                      ],
                    },
                  },
                },
                sandbox: { mode: "all", scope: "agent" },
              };
              if (model) {
                agentEntry.model = { primary: model };
              }
              raw.agents.list.push(agentEntry);
            }

            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
          } else {
            configWarning = "Flock config section not found in openclaw.json — agent not persisted to config.";
          }
        } else {
          configWarning = "openclaw.json not found — agent not persisted to config.";
        }
      } catch (err) {
        configWarning = `Config persistence failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Audit log
      deps.audit.append({
        id: uniqueId(`agent-create-${newAgentId}`),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-create",
        level: "GREEN",
        detail: `Created ${role} agent '${newAgentId}' on node '${nodeId}'`,
        result: "success",
      });

      // Build response
      const warnings: string[] = [];
      if (provisionWarning) warnings.push(provisionWarning);
      if (configWarning) warnings.push(configWarning);

      const outputLines = [
        `## Agent Created: ${newAgentId}`,
        `Role: ${role}`,
        `Node: ${nodeId}`,
        `Endpoint: ${endpointUrl}`,
      ];
      if (archetype) outputLines.push(`Archetype: ${archetype}`);
      if (model) outputLines.push(`Model: ${model}`);
      if (warnings.length > 0) {
        outputLines.push("", "### Warnings", ...warnings.map(w => `- ⚠️ ${w}`));
      }

      return toResult({
        ok: true,
        output: outputLines.join("\n"),
        data: {
          agentId: newAgentId,
          role,
          nodeId,
          endpointUrl,
          cardName: card.name,
          warnings,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_decommission_agent
// ---------------------------------------------------------------------------

export function createDecommissionAgentTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): AgentTool<typeof DecommissionAgentParams, Record<string, unknown>> {
  return {
    name: "flock_decommission_agent",
    label: "Decommission Agent",
    description:
      "Decommission (remove) an agent from the current node. Only orchestrator role agents can use this tool. " +
      "The agent will be unregistered from A2A, its home marked RETIRED, and removed from config.",
    parameters: DecommissionAgentParams,
    async execute(_toolCallId: string, params: Static<typeof DecommissionAgentParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, rawParams, sessionKeyFromCtx);
      const targetAgentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";

      // Validate required params
      if (!targetAgentId) {
        return toResult({ ok: false, error: "targetAgentId is required — the agent to decommission." });
      }
      if (!reason) {
        return toResult({ ok: false, error: "reason is required — explain why the agent is being decommissioned." });
      }

      // Authorization: only orchestrator agents can decommission agents
      if (!deps.a2aServer) {
        return toResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toResult({
          ok: false,
          error: `Permission denied: only orchestrator agents can decommission agents. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      // Check agent exists
      if (!deps.a2aServer.hasAgent(targetAgentId)) {
        return toResult({
          ok: false,
          error: `Agent '${targetAgentId}' not found on this node.`,
        });
      }

      // Prevent self-decommissioning
      if (targetAgentId === callerAgentId) {
        return toResult({
          ok: false,
          error: "Cannot decommission yourself. Another sysadmin agent must do this.",
        });
      }

      const nodeId = deps.config.nodeId;

      // Remove from A2A server
      deps.a2aServer.unregisterAgent(targetAgentId);

      // Update home state to RETIRED if it exists
      const homeId = `${targetAgentId}@${nodeId}`;
      try {
        const home = deps.homes.get(homeId);
        if (home) {
          deps.homes.transition(homeId, "RETIRED", reason, callerAgentId);
        }
      } catch {
        // Non-fatal — home may not exist
      }

      // Remove from config file
      let configWarning: string | undefined;
      try {
        const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          const flockConfig = raw?.plugins?.entries?.flock?.config;
          if (flockConfig && Array.isArray(flockConfig.gatewayAgents)) {
            const before = flockConfig.gatewayAgents.length;
            flockConfig.gatewayAgents = flockConfig.gatewayAgents.filter(
              (a: unknown) => {
                if (typeof a === "string") return a !== targetAgentId;
                if (typeof a === "object" && a !== null) {
                  return (a as Record<string, unknown>).id !== targetAgentId;
                }
                return true;
              },
            );
            if (flockConfig.gatewayAgents.length < before) {
              fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
            }
          }
        }
      } catch (err) {
        configWarning = `Config update failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Audit log
      deps.audit.append({
        id: uniqueId(`agent-decommission-${targetAgentId}`),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-decommission",
        level: "YELLOW",
        detail: `Decommissioned agent '${targetAgentId}' from node '${nodeId}'. Reason: ${reason}`,
        result: "success",
      });

      const outputLines = [
        `## Agent Decommissioned: ${targetAgentId}`,
        `Reason: ${reason}`,
        `Node: ${nodeId}`,
        `Decommissioned by: ${callerAgentId}`,
      ];
      if (configWarning) {
        outputLines.push("", `⚠️ ${configWarning}`);
      }

      return toResult({
        ok: true,
        output: outputLines.join("\n"),
        data: {
          agentId: targetAgentId,
          nodeId,
          reason,
          decommissionedBy: callerAgentId,
          configWarning,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_restart_gateway
// ---------------------------------------------------------------------------

export function createRestartGatewayTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): AgentTool<typeof RestartGatewayParams, Record<string, unknown>> {
  return {
    name: "flock_restart_gateway",
    label: "Restart Gateway",
    description:
      "Restart the gateway process. Only sysadmin role agents can use this tool. " +
      "Sends SIGUSR1 to trigger a graceful gateway restart.",
    parameters: RestartGatewayParams,
    async execute(_toolCallId: string, params: Static<typeof RestartGatewayParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, rawParams, sessionKeyFromCtx);

      // Authorization: sysadmin only (infrastructure operation)
      if (!deps.a2aServer) {
        return toResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["sysadmin"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toResult({
          ok: false,
          error: `Permission denied: only sysadmin agents can restart the gateway. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      // Audit log
      deps.audit.append({
        id: uniqueId("gateway-restart"),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "gateway-restart",
        level: "YELLOW",
        detail: `Gateway restart requested by '${callerAgentId}'`,
        result: "success",
      });

      // Send SIGUSR1 to trigger gateway restart
      process.kill(process.pid, "SIGUSR1");

      return toResult({
        ok: true,
        output: `Gateway restart signal (SIGUSR1) sent. The gateway will restart shortly.`,
        data: {
          signal: "SIGUSR1",
          pid: process.pid,
          requestedBy: callerAgentId,
        },
      });
    },
  };
}
