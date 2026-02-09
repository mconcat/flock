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

import type { ToolDefinition, ToolResultOC } from "../types.js";
import { toOCResult } from "../types.js";
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
 * Check if a caller has orchestrator privileges.
 * First checks the A2A server agent registry. If the caller resolves to "main"
 * (common when OpenClaw doesn't propagate agent identity headers), falls back
 * to checking if ANY registered orchestrator agent exists AND the tool is
 * only available to orchestrator sessions via config (tools.alsoAllow).
 *
 * This handles the case where OpenClaw's X-Clawdbot-Agent-Id header isn't
 * propagated to the session key, causing ctx.agentId to be "main".
 */
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
  // This is safe because lifecycle tools are non-optional and only available
  // to sessions configured with tools.alsoAllow: ["group:plugins"].
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

// ---------------------------------------------------------------------------
// flock_create_agent
// ---------------------------------------------------------------------------

export function createCreateAgentTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): ToolDefinition {
  return {
    name: "flock_create_agent",
    description:
      "Create a new agent on the current node. Only orchestrator role agents can use this tool. " +
      "The agent will be registered in the A2A server, provisioned on disk, and persisted to config.",
    parameters: {
      type: "object",
      required: ["newAgentId", "role"],
      properties: {
        newAgentId: {
          type: "string",
          description: "Unique agent ID for the new agent (alphanumeric, dash, underscore only)",
        },
        role: {
          type: "string",
          enum: ["worker", "sysadmin", "system", "orchestrator"],
          description: "Agent role: worker, sysadmin, system, or orchestrator",
        },
        mutableLayer: {
          type: "string",
          description: "Layer 3 content (SOUL.md, IDENTITY.md, etc.) for prompt assembly",
        },
        archetype: {
          type: "string",
          description: "Archetype name to use as Layer 3 base (e.g. 'researcher', 'coder')",
        },
        model: {
          type: "string",
          description: "Primary model for this agent (e.g. 'anthropic/claude-opus-4-5', 'openai-codex/gpt-5.2', 'google-gemini-cli/gemini-3-flash-preview'). If omitted, the node default model is used.",
        },
        systemPrompt: {
          type: "string",
          description: "Full system prompt (overrides layer assembly if provided)",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, params, sessionKeyFromCtx);
      const newAgentId = typeof params.newAgentId === "string" ? params.newAgentId.trim() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const archetype = typeof params.archetype === "string" ? params.archetype.trim() : "";
      const model = typeof params.model === "string" ? params.model.trim() : "";
      const systemPromptParam = typeof params.systemPrompt === "string" ? params.systemPrompt.trim() : "";

      // Validate required params
      if (!newAgentId) {
        return toOCResult({ ok: false, error: "newAgentId is required — the ID for the new agent to create." });
      }
      const validRoles = ["worker", "sysadmin", "system", "orchestrator"];
      if (!validRoles.includes(role)) {
        return toOCResult({ ok: false, error: `role must be one of: ${validRoles.join(", ")}. Got: '${role}'` });
      }

      // Validate ID format (path traversal protection)
      try {
        validateId(newAgentId, "newAgentId");
      } catch (err) {
        return toOCResult({ ok: false, error: String(err) });
      }

      // Authorization: only orchestrator agents can create agents
      if (!deps.a2aServer) {
        return toOCResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toOCResult({
          ok: false,
          error: `Permission denied: only orchestrator agents can create agents. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      // Check agent doesn't already exist
      if (deps.a2aServer.hasAgent(newAgentId)) {
        return toOCResult({
          ok: false,
          error: `Agent '${newAgentId}' already exists on this node. Use flock_discover to check existing agents.`,
        });
      }

      // System prompts are now managed by OpenClaw natively via workspace files
      // (AGENTS.md, SOUL.md, etc.). No need to inject them here.

      // Create gateway session send function
      if (!deps.config.gateway.token) {
        return toOCResult({ ok: false, error: "Gateway token not configured. Cannot create agent session." });
      }
      if (!deps.logger) {
        return toOCResult({ ok: false, error: "Logger not available. Cannot create gateway session send." });
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
            const meta = deps.a2aServer!.getAgentMeta(entry.agentId);
            return {
              id: entry.agentId,
              role: (meta?.role ?? "worker") as import("../transport/types.js").FlockAgentRole,
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

            // 2. Add to OpenClaw agents.list so the agent gets a proper session,
            //    sandbox, and tool configuration as a first-class OpenClaw agent.
            if (!raw.agents) raw.agents = {};
            if (!Array.isArray(raw.agents.list)) raw.agents.list = [];
            const existsInAgentsList = raw.agents.list.some(
              (a: Record<string, unknown>) => a && a.id === newAgentId,
            );
            if (!existsInAgentsList) {
              const agentEntry: Record<string, unknown> = {
                id: newAgentId,
                // Explicit workspace path — OpenClaw resolves the default agent
                // (agents.list[0]) to ~/.openclaw/workspace/ instead of
                // ~/.openclaw/workspace-{id}/. Setting this explicitly ensures
                // flock-provisioned workspace files (AGENTS.md, SOUL.md, etc.)
                // are loaded into the system prompt correctly.
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
              // NOTE: docker.binds removed — OpenClaw config schema doesn't support
              // a top-level "docker" key in agents.list entries. Bind mounts for
              // sandbox mode should be configured via OpenClaw's native sandbox config.
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

      return toOCResult({
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

export function createDecommissionAgentTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): ToolDefinition {
  return {
    name: "flock_decommission_agent",
    description:
      "Decommission (remove) an agent from the current node. Only orchestrator role agents can use this tool. " +
      "The agent will be unregistered from A2A, its home marked RETIRED, and removed from config.",
    parameters: {
      type: "object",
      required: ["targetAgentId", "reason"],
      properties: {
        targetAgentId: {
          type: "string",
          description: "Agent ID to decommission",
        },
        reason: {
          type: "string",
          description: "Reason for decommissioning the agent",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, params, sessionKeyFromCtx);
      const targetAgentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";

      // Validate required params
      if (!targetAgentId) {
        return toOCResult({ ok: false, error: "targetAgentId is required — the agent to decommission." });
      }
      if (!reason) {
        return toOCResult({ ok: false, error: "reason is required — explain why the agent is being decommissioned." });
      }

      // Authorization: only orchestrator agents can decommission agents
      if (!deps.a2aServer) {
        return toOCResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toOCResult({
          ok: false,
          error: `Permission denied: only orchestrator agents can decommission agents. Caller '${callerAgentId}' has role: ${callerMeta?.role ?? "unknown"}`,
        });
      }

      // Check agent exists
      if (!deps.a2aServer.hasAgent(targetAgentId)) {
        return toOCResult({
          ok: false,
          error: `Agent '${targetAgentId}' not found on this node.`,
        });
      }

      // Prevent self-decommissioning
      if (targetAgentId === callerAgentId) {
        return toOCResult({
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

      return toOCResult({
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

export function createRestartGatewayTool(deps: ToolDeps, callerAgentIdFromCtx?: string, sessionKeyFromCtx?: string): ToolDefinition {
  return {
    name: "flock_restart_gateway",
    description:
      "Restart the gateway process. Only sysadmin role agents can use this tool. " +
      "Sends SIGUSR1 to trigger a graceful gateway restart.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(callerAgentIdFromCtx, params, sessionKeyFromCtx);

      // Authorization: sysadmin only (infrastructure operation)
      if (!deps.a2aServer) {
        return toOCResult({ ok: false, error: "A2A server not initialized." });
      }

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["sysadmin"])) {
        const callerMeta = deps.a2aServer.getAgentMeta(callerAgentId);
        return toOCResult({
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

      return toOCResult({
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
