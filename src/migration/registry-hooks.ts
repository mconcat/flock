/**
 * Migration Registry Hooks — NodeRegistry integration for migration lifecycle.
 *
 * Updates the node registry when a migration completes, moving the agent's
 * routing entry from the source node to the target node.
 */

import type { NodeRegistry } from "../nodes/registry.js";
import type { MigrationTicket } from "./types.js";

/**
 * Update the node registry after a migration completes.
 *
 * Removes the agent from the source node's agent list and adds it to
 * the target node's agent list. If the target node isn't registered yet,
 * registers it with the endpoint from the migration ticket.
 *
 * @param ticket - The completed migration ticket
 * @param registry - The node registry to update
 */
export function onMigrationComplete(ticket: MigrationTicket, registry: NodeRegistry): void {
  const { agentId } = ticket;
  const sourceNodeId = ticket.source.nodeId;
  const targetNodeId = ticket.target.nodeId;

  // Remove agent from source node
  const sourceNode = registry.get(sourceNodeId);
  if (sourceNode) {
    const updatedSourceAgents = sourceNode.agentIds.filter((id) => id !== agentId);
    registry.updateAgents(sourceNodeId, updatedSourceAgents);
  }

  // Add agent to target node
  const targetNode = registry.get(targetNodeId);
  if (targetNode) {
    if (!targetNode.agentIds.includes(agentId)) {
      registry.updateAgents(targetNodeId, [...targetNode.agentIds, agentId]);
    }
  } else {
    // Target node not in registry — register it
    registry.register({
      nodeId: targetNodeId,
      a2aEndpoint: ticket.target.endpoint,
      status: "online",
      lastSeen: Date.now(),
      agentIds: [agentId],
    });
  }
}
