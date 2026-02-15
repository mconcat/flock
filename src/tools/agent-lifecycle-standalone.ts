/**
 * Agent Lifecycle Tools — standalone mode.
 *
 * Replaces the OpenClaw-dependent agent-lifecycle.ts for standalone operation.
 * Key differences from plugin mode:
 *   - Config persisted to ~/.flock/flock.json (not ~/.openclaw/openclaw.json)
 *   - Workspaces at ~/.flock/agents/{id}/ (not ~/.openclaw/workspace-{id}/)
 *   - Uses createDirectSend() instead of createGatewaySessionSend()
 *   - Restart sends SIGUSR2 to Flock process (not SIGUSR1 to OpenClaw gateway)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ToolDefinition, ToolResultOC } from "../types.js";
import { toOCResult } from "../types.js";
import { validateId } from "../homes/utils.js";
import { uniqueId } from "../utils/id.js";
import { createWorkerCard, createSysadminCard, createOrchestratorCard } from "../transport/agent-card.js";
import { createFlockExecutor } from "../transport/executor.js";
import type { ToolDeps } from "./index.js";
import type { SessionSendFn } from "../transport/executor.js";
import type { FlockAgentRole } from "../transport/types.js";

/**
 * Resolve the Flock config file path for persistence.
 */
function getFlockConfigPath(): string {
  return process.env.FLOCK_CONFIG ?? path.join(os.homedir(), ".flock", "flock.json");
}

/**
 * Resolve the caller agent ID from params.
 */
function resolveCallerAgentId(callerFromCtx: string | undefined, params: Record<string, unknown>): string {
  if (callerFromCtx && callerFromCtx !== "unknown") return callerFromCtx;
  if (typeof params._callerAgentId === "string") return params._callerAgentId;
  return "unknown";
}

/**
 * Check if a caller has the required privileged role.
 */
function isCallerPrivileged(
  callerAgentId: string,
  a2aServer: ToolDeps["a2aServer"],
  allowedRoles: string[],
): boolean {
  if (!a2aServer) return false;
  const callerMeta = a2aServer.getAgentMeta(callerAgentId);
  if (callerMeta?.role && allowedRoles.includes(callerMeta.role)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// flock_create_agent (standalone)
// ---------------------------------------------------------------------------

export function createStandaloneCreateAgentTool(
  deps: ToolDeps,
  sessionSend: SessionSendFn,
): ToolDefinition {
  return {
    name: "flock_create_agent",
    description:
      "Create a new agent on the current node. Only orchestrator role agents can use this tool.",
    parameters: {
      type: "object",
      required: ["newAgentId", "role"],
      properties: {
        newAgentId: {
          type: "string",
          description: "Unique agent ID for the new agent",
        },
        role: {
          type: "string",
          enum: ["worker", "sysadmin", "system", "orchestrator"],
          description: "Agent role",
        },
        archetype: { type: "string", description: "Soul archetype name" },
        model: { type: "string", description: "LLM model (e.g. 'anthropic/claude-sonnet-4-20250514')" },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(undefined, params);
      const newAgentId = typeof params.newAgentId === "string" ? params.newAgentId.trim() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const archetype = typeof params.archetype === "string" ? params.archetype.trim() : "";
      const model = typeof params.model === "string" ? params.model.trim() : "";

      if (!newAgentId) return toOCResult({ ok: false, error: "newAgentId is required." });
      if (newAgentId.startsWith("human:")) return toOCResult({ ok: false, error: "Agent IDs cannot start with 'human:'." });

      const validRoles = ["worker", "sysadmin", "system", "orchestrator"];
      if (!validRoles.includes(role)) {
        return toOCResult({ ok: false, error: `role must be one of: ${validRoles.join(", ")}` });
      }

      try { validateId(newAgentId, "newAgentId"); }
      catch (err) { return toOCResult({ ok: false, error: String(err) }); }

      if (!deps.a2aServer) return toOCResult({ ok: false, error: "A2A server not initialized." });
      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        return toOCResult({ ok: false, error: `Permission denied: only orchestrator agents can create agents.` });
      }
      if (deps.a2aServer.hasAgent(newAgentId)) {
        return toOCResult({ ok: false, error: `Agent '${newAgentId}' already exists.` });
      }

      // Create agent card
      const nodeId = deps.config.nodeId;
      const endpointUrl = `http://localhost:${deps.config.gateway.port + 1}/flock/a2a/${newAgentId}`;
      const { card, meta } = role === "orchestrator"
        ? createOrchestratorCard(nodeId, endpointUrl, newAgentId)
        : role === "sysadmin"
          ? createSysadminCard(nodeId, endpointUrl, newAgentId)
          : createWorkerCard(newAgentId, nodeId, endpointUrl);

      // Create executor with direct LLM send
      const executor = createFlockExecutor({
        flockMeta: meta,
        sessionSend,
        audit: deps.audit,
        taskStore: deps.taskStore,
        logger: deps.logger!,
      });
      deps.a2aServer.registerAgent(newAgentId, card, meta, executor);

      // Create workspace directory
      const workspaceDir = path.join(os.homedir(), ".flock", "agents", newAgentId);
      try {
        fs.mkdirSync(workspaceDir, { recursive: true });
      } catch {
        // Non-fatal
      }

      // Persist to flock.json
      let configWarning: string | undefined;
      try {
        const configPath = getFlockConfigPath();
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          if (!Array.isArray(raw.gatewayAgents)) raw.gatewayAgents = [];

          const entry: Record<string, unknown> = { id: newAgentId };
          if (role !== "worker") entry.role = role;
          if (archetype) entry.archetype = archetype;
          if (model) entry.model = model;
          raw.gatewayAgents.push(entry);

          fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
        } else {
          configWarning = `Config file not found at ${configPath} — agent not persisted.`;
        }
      } catch (err) {
        configWarning = `Config persistence failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Audit
      deps.audit.append({
        id: uniqueId(`agent-create-${newAgentId}`),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-create",
        level: "GREEN",
        detail: `Created ${role} agent '${newAgentId}' on node '${nodeId}'`,
        result: "success",
      });

      const lines = [
        `## Agent Created: ${newAgentId}`,
        `Role: ${role}`,
        `Node: ${nodeId}`,
      ];
      if (model) lines.push(`Model: ${model}`);
      if (configWarning) lines.push("", `⚠️ ${configWarning}`);

      return toOCResult({ ok: true, output: lines.join("\n") });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_decommission_agent (standalone)
// ---------------------------------------------------------------------------

export function createStandaloneDecommissionAgentTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_decommission_agent",
    description: "Decommission an agent from the current node. Orchestrator only.",
    parameters: {
      type: "object",
      required: ["targetAgentId", "reason"],
      properties: {
        targetAgentId: { type: "string", description: "Agent ID to decommission" },
        reason: { type: "string", description: "Reason for decommissioning" },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(undefined, params);
      const targetAgentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";

      if (!targetAgentId) return toOCResult({ ok: false, error: "targetAgentId is required." });
      if (!reason) return toOCResult({ ok: false, error: "reason is required." });
      if (!deps.a2aServer) return toOCResult({ ok: false, error: "A2A server not initialized." });

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        return toOCResult({ ok: false, error: "Permission denied: only orchestrator agents can decommission agents." });
      }
      if (!deps.a2aServer.hasAgent(targetAgentId)) {
        return toOCResult({ ok: false, error: `Agent '${targetAgentId}' not found.` });
      }
      if (targetAgentId === callerAgentId) {
        return toOCResult({ ok: false, error: "Cannot decommission yourself." });
      }

      deps.a2aServer.unregisterAgent(targetAgentId);

      // Update home state
      const homeId = `${targetAgentId}@${deps.config.nodeId}`;
      try {
        const home = deps.homes.get(homeId);
        if (home) deps.homes.transition(homeId, "RETIRED", reason, callerAgentId);
      } catch { /* non-fatal */ }

      // Remove from flock.json
      try {
        const configPath = getFlockConfigPath();
        if (fs.existsSync(configPath)) {
          const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          if (Array.isArray(raw.gatewayAgents)) {
            raw.gatewayAgents = raw.gatewayAgents.filter((a: unknown) => {
              if (typeof a === "string") return a !== targetAgentId;
              if (typeof a === "object" && a !== null) return (a as Record<string, unknown>).id !== targetAgentId;
              return true;
            });
            fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
          }
        }
      } catch { /* non-fatal */ }

      deps.audit.append({
        id: uniqueId(`agent-decommission-${targetAgentId}`),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "agent-decommission",
        level: "YELLOW",
        detail: `Decommissioned '${targetAgentId}'. Reason: ${reason}`,
        result: "success",
      });

      return toOCResult({
        ok: true,
        output: `## Agent Decommissioned: ${targetAgentId}\nReason: ${reason}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_restart (standalone — restarts Flock process)
// ---------------------------------------------------------------------------

export function createStandaloneRestartTool(deps: ToolDeps): ToolDefinition {
  return {
    name: "flock_restart",
    description: "Restart the Flock process. Sysadmin only.",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const callerAgentId = resolveCallerAgentId(undefined, params);

      if (!deps.a2aServer) return toOCResult({ ok: false, error: "A2A server not initialized." });
      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["sysadmin"])) {
        return toOCResult({ ok: false, error: "Permission denied: only sysadmin agents can restart." });
      }

      deps.audit.append({
        id: uniqueId("flock-restart"),
        timestamp: Date.now(),
        agentId: callerAgentId,
        action: "flock-restart",
        level: "YELLOW",
        detail: `Restart requested by '${callerAgentId}'`,
        result: "success",
      });

      // Schedule exit after response is sent
      setTimeout(() => { process.exit(0); }, 500);

      return toOCResult({
        ok: true,
        output: "Flock restart initiated. Process will exit and should be restarted by the process manager.",
      });
    },
  };
}
