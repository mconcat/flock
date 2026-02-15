/**
 * flock_nodes tool — List and discover Flock nodes.
 */

import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { toResult } from "../tools/result.js";
import type { PluginLogger } from "../types.js";
import type { NodeRegistry } from "./registry.js";
import { discoverRemoteAgents } from "./discovery.js";

export interface FlockNodesToolDeps {
  nodeRegistry: NodeRegistry;
  logger: PluginLogger;
}

// --- TypeBox Schema ---

const FlockNodesParams = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("discover")], {
    description: "Action to perform",
  }),
  nodeId: Type.Optional(Type.String({
    description: "(discover only) Node ID to refresh",
  })),
});

export function createNodesTool(deps: FlockNodesToolDeps): AgentTool<typeof FlockNodesParams, Record<string, unknown>> {
  return {
    name: "flock_nodes",
    label: "Flock Nodes",
    description:
      "List known Flock nodes and their agents, or trigger discovery on a specific node. " +
      "Use action 'list' to see all nodes, or 'discover' with a nodeId to refresh its agent list.",
    parameters: FlockNodesParams,
    async execute(_toolCallId: string, params: Static<typeof FlockNodesParams>): Promise<AgentToolResult<Record<string, unknown>>> {
      const action = typeof params.action === "string" ? params.action.trim() : "";

      if (action === "list") {
        const nodes = deps.nodeRegistry.list();
        if (nodes.length === 0) {
          return toResult({
            ok: true,
            output: "No remote nodes registered.",
            data: { nodes: [] },
          });
        }

        const lines = [
          `## Flock Nodes (${nodes.length})`,
          "",
          ...nodes.map((n) => {
            const statusIcon = n.status === "online" ? "🟢" : n.status === "offline" ? "🔴" : "⚪";
            const lastSeen = n.lastSeen > 0
              ? new Date(n.lastSeen).toISOString()
              : "never";
            const agents = n.agentIds.length > 0
              ? n.agentIds.join(", ")
              : "none discovered";
            return `- ${statusIcon} **${n.nodeId}** [${n.status}] — ${n.a2aEndpoint} | Agents: ${agents} | Last seen: ${lastSeen}`;
          }),
        ];

        return toResult({
          ok: true,
          output: lines.join("\n"),
          data: { nodes },
        });
      }

      if (action === "discover") {
        const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
        if (!nodeId) {
          return toResult({ ok: false, error: "nodeId is required for discover action" });
        }

        const node = deps.nodeRegistry.get(nodeId);
        if (!node) {
          return toResult({ ok: false, error: `Node not found: ${nodeId}` });
        }

        const agents = await discoverRemoteAgents(node.a2aEndpoint, deps.logger);
        const agentIds = agents.map((a) => a.agentId);
        deps.nodeRegistry.updateAgents(nodeId, agentIds);

        if (agents.length > 0) {
          deps.nodeRegistry.updateStatus(nodeId, "online");
        } else {
          deps.nodeRegistry.updateStatus(nodeId, "offline");
        }

        return toResult({
          ok: true,
          output: `Discovered ${agents.length} agent(s) on ${nodeId}: ${agentIds.join(", ") || "none"}`,
          data: { nodeId, agents: agentIds },
        });
      }

      return toResult({ ok: false, error: `Unknown action: ${action}. Use 'list' or 'discover'.` });
    },
  };
}
