/**
 * Central Topology — all worker agents on one node.
 *
 * Central node hosts ALL worker LLM sessions. Worker nodes only run
 * their local sysadmin agent. This simplifies worker↔worker communication
 * (always local) and makes migration a metadata + storage operation
 * (no LLM session migration needed).
 *
 * Resolution rules:
 *   Worker→Worker: always local (they're all co-located on central)
 *   Worker→Sysadmin: look up the agent's assigned physical node,
 *                     route to that node's sysadmin via A2A HTTP
 */

import type { AssignmentStore } from "../../nodes/assignment.js";
import type { NodeRegistry } from "../../nodes/registry.js";
import type {
  ResolveAgent,
  ResolveSysadmin,
  GetExecutionNode,
  Reassign,
} from "../routing.js";
import type { RouteResult } from "../router.js";

/**
 * Create a central-mode agent resolver.
 *
 * In central topology, ALL worker agents are hosted on the central node,
 * so every worker→worker message is local. No remote routing needed.
 */
export function createCentralResolver(): ResolveAgent {
  return async (_agentId: string): Promise<RouteResult> => {
    // All workers are local on the central node
    return { local: true };
  };
}

/**
 * Create a central-mode sysadmin resolver.
 *
 * When a worker agent needs its sysadmin, we look up which physical
 * node the worker is assigned to, then route to that node's sysadmin
 * endpoint via the node registry.
 *
 * Resolution:
 * 1. Look up agent's assigned nodeId in the assignment store
 * 2. Look up that node's A2A endpoint in the registry
 * 3. Return remote route to the sysadmin on that node
 * 4. If no assignment or node not found, fall back to local
 */
export function createCentralSysadminResolver(
  assignments: AssignmentStore,
  registry: NodeRegistry,
): ResolveSysadmin {
  return async (agentId: string): Promise<RouteResult> => {
    // 1. Which physical node is this agent assigned to?
    const nodeId = await assignments.getNodeId(agentId);
    if (!nodeId) {
      // No assignment — fall back to local sysadmin
      return { local: true };
    }

    // 2. Look up the node's endpoint
    const node = registry.get(nodeId);
    if (!node || node.status === "offline") {
      // Node unknown or offline — fall back to local
      return { local: true };
    }

    // 3. Route to the sysadmin on that physical node
    return {
      local: false,
      endpoint: node.a2aEndpoint,
      nodeId: node.nodeId,
    };
  };
}

/**
 * Create central-mode execution node queries.
 *
 * These support the migration workflow:
 * - getNode: which physical node is an agent currently on?
 * - reassign: move an agent's assignment to a different node
 */
export function createCentralExecution(assignments: AssignmentStore): {
  getNode: GetExecutionNode;
  reassign: Reassign;
} {
  const getNode: GetExecutionNode = async (agentId) => {
    return assignments.getNodeId(agentId);
  };

  const reassign: Reassign = async (agentId, newNodeId) => {
    const existing = assignments.get(agentId);
    await assignments.set(
      agentId,
      newNodeId,
      existing?.portablePath,
    );
  };

  return { getNode, reassign };
}
