/**
 * Agent Lifecycle Tools — standalone mode.
 *
 * Replaces the OpenClaw-dependent agent-lifecycle.ts for standalone operation.
 * Key differences from plugin mode:
 *   - Config persisted to ~/.flock/flock.json (not ~/.openclaw/openclaw.json)
 *   - Workspaces at ~/.flock/agents/{id}/ (not ~/.openclaw/workspace-{id}/)
 *   - Uses createDirectSend() instead of createGatewaySessionSend()
 *   - Restart sends SIGTERM to Flock process (not SIGUSR1 to OpenClaw gateway)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { toResult } from "./result.js";
import { createFlockLogger } from "../logger.js";
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

// --- TypeBox Schemas ---

const StandaloneCreateAgentParams = Type.Object({
  newAgentId: Type.String({ description: "Unique agent ID for the new agent" }),
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("sysadmin"),
    Type.Literal("system"),
    Type.Literal("orchestrator"),
  ], { description: "Agent role" }),
  archetype: Type.Optional(Type.String({ description: "Soul archetype name" })),
  model: Type.Optional(Type.String({ description: "LLM model (e.g. 'anthropic/claude-sonnet-4-20250514')" })),
});

const StandaloneDecommissionAgentParams = Type.Object({
  targetAgentId: Type.String({ description: "Agent ID to decommission" }),
  reason: Type.String({ description: "Reason for decommissioning" }),
});

const StandaloneRestartParams = Type.Object({});

// ---------------------------------------------------------------------------
// flock_create_agent (standalone)
// ---------------------------------------------------------------------------

export function createStandaloneCreateAgentTool(
  deps: ToolDeps,
  sessionSend: SessionSendFn,
): AgentTool<typeof StandaloneCreateAgentParams, Record<string, unknown>> {
  return {
    name: "flock_create_agent",
    label: "Create Agent (Standalone)",
    description:
      "Create a new agent on the current node. Only orchestrator role agents can use this tool.",
    parameters: StandaloneCreateAgentParams,
    async execute(_toolCallId: string, params: Static<typeof StandaloneCreateAgentParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(undefined, rawParams);
      const newAgentId = typeof params.newAgentId === "string" ? params.newAgentId.trim() : "";
      const role = typeof params.role === "string" ? params.role.trim() : "";
      const archetype = typeof params.archetype === "string" ? params.archetype.trim() : "";
      const model = typeof params.model === "string" ? params.model.trim() : "";

      if (!newAgentId) return toResult({ ok: false, error: "newAgentId is required." });
      if (newAgentId.startsWith("human:")) return toResult({ ok: false, error: "Agent IDs cannot start with 'human:'." });

      const validRoles = ["worker", "sysadmin", "system", "orchestrator"];
      if (!validRoles.includes(role)) {
        return toResult({ ok: false, error: `role must be one of: ${validRoles.join(", ")}` });
      }

      try { validateId(newAgentId, "newAgentId"); }
      catch (err) { return toResult({ ok: false, error: String(err) }); }

      if (!deps.a2aServer) return toResult({ ok: false, error: "A2A server not initialized." });
      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        return toResult({ ok: false, error: `Permission denied: only orchestrator agents can create agents.` });
      }
      if (deps.a2aServer.hasAgent(newAgentId)) {
        return toResult({ ok: false, error: `Agent '${newAgentId}' already exists.` });
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
      const logger = deps.logger ?? createFlockLogger({ prefix: "flock:lifecycle" });
      const executor = createFlockExecutor({
        flockMeta: meta,
        sessionSend,
        audit: deps.audit,
        taskStore: deps.taskStore,
        logger,
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

      return toResult({ ok: true, output: lines.join("\n") });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_decommission_agent (standalone)
// ---------------------------------------------------------------------------

export function createStandaloneDecommissionAgentTool(deps: ToolDeps): AgentTool<typeof StandaloneDecommissionAgentParams, Record<string, unknown>> {
  return {
    name: "flock_decommission_agent",
    label: "Decommission Agent (Standalone)",
    description: "Decommission an agent from the current node. Orchestrator only.",
    parameters: StandaloneDecommissionAgentParams,
    async execute(_toolCallId: string, params: Static<typeof StandaloneDecommissionAgentParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(undefined, rawParams);
      const targetAgentId = typeof params.targetAgentId === "string" ? params.targetAgentId.trim() : "";
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";

      if (!targetAgentId) return toResult({ ok: false, error: "targetAgentId is required." });
      if (!reason) return toResult({ ok: false, error: "reason is required." });
      if (!deps.a2aServer) return toResult({ ok: false, error: "A2A server not initialized." });

      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator"])) {
        return toResult({ ok: false, error: "Permission denied: only orchestrator agents can decommission agents." });
      }
      if (!deps.a2aServer.hasAgent(targetAgentId)) {
        return toResult({ ok: false, error: `Agent '${targetAgentId}' not found.` });
      }
      if (targetAgentId === callerAgentId) {
        return toResult({ ok: false, error: "Cannot decommission yourself." });
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

      return toResult({
        ok: true,
        output: `## Agent Decommissioned: ${targetAgentId}\nReason: ${reason}`,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// flock_restart (standalone — restarts Flock process)
// ---------------------------------------------------------------------------

export function createStandaloneRestartTool(deps: ToolDeps): AgentTool<typeof StandaloneRestartParams, Record<string, unknown>> {
  return {
    name: "flock_restart",
    label: "Restart Flock (Standalone)",
    description: "Restart the Flock process. Sysadmin only.",
    parameters: StandaloneRestartParams,
    async execute(_toolCallId: string, params: Static<typeof StandaloneRestartParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const rawParams = params as Record<string, unknown>;
      const callerAgentId = resolveCallerAgentId(undefined, rawParams);

      if (!deps.a2aServer) return toResult({ ok: false, error: "A2A server not initialized." });
      if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["sysadmin"])) {
        return toResult({ ok: false, error: "Permission denied: only sysadmin agents can restart." });
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

      // Schedule graceful shutdown via SIGTERM (lets the CLI's handler run instance.stop())
      setTimeout(() => { process.kill(process.pid, "SIGTERM"); }, 500);

      return toResult({
        ok: true,
        output: "Flock restart initiated. Process will exit and should be restarted by the process manager.",
      });
    },
  };
}
