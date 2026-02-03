/**
 * flock_nodes tool — List and discover Flock nodes.
 */

import type { ToolDefinition, ToolResultOC, PluginLogger } from "../types.js";
import { toOCResult } from "../types.js";
import type { NodeRegistry } from "./registry.js";
import { discoverRemoteAgents } from "./discovery.js";

export interface FlockNodesToolDeps {
  nodeRegistry: NodeRegistry;
  logger: PluginLogger;
}

export function createNodesTool(deps: FlockNodesToolDeps): ToolDefinition {
  return {
    name: "flock_nodes",
    description:
      "List known Flock nodes and their agents, or trigger discovery on a specific node. " +
      "Use action 'list' to see all nodes, or 'discover' with a nodeId to refresh its agent list.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["list", "discover"],
          description: "Action to perform",
        },
        nodeId: {
          type: "string",
          description: "(discover only) Node ID to refresh",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const action = typeof params.action === "string" ? params.action.trim() : "";

      if (action === "list") {
        const nodes = deps.nodeRegistry.list();
        if (nodes.length === 0) {
          return toOCResult({
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

        return toOCResult({
          ok: true,
          output: lines.join("\n"),
          data: { nodes },
        });
      }

      if (action === "discover") {
        const nodeId = typeof params.nodeId === "string" ? params.nodeId.trim() : "";
        if (!nodeId) {
          return toOCResult({ ok: false, error: "nodeId is required for discover action" });
        }

        const node = deps.nodeRegistry.get(nodeId);
        if (!node) {
          return toOCResult({ ok: false, error: `Node not found: ${nodeId}` });
        }

        const agents = await discoverRemoteAgents(node.a2aEndpoint, deps.logger);
        const agentIds = agents.map((a) => a.agentId);
        deps.nodeRegistry.updateAgents(nodeId, agentIds);

        if (agents.length > 0) {
          deps.nodeRegistry.updateStatus(nodeId, "online");
        } else {
          deps.nodeRegistry.updateStatus(nodeId, "offline");
        }

        return toOCResult({
          ok: true,
          output: `Discovered ${agents.length} agent(s) on ${nodeId}: ${agentIds.join(", ") || "none"}`,
          data: { nodeId, agents: agentIds },
        });
      }

      return toOCResult({ ok: false, error: `Unknown action: ${action}. Use 'list' or 'discover'.` });
    },
  };
}
