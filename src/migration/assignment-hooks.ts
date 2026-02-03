/**
 * Assignment Store Integration Hooks — Auto-update agent→node assignments after migration.
 *
 * When a migration completes, the agent's assignment should automatically
 * update to point to the new node. This eliminates manual assignment
 * updates and ensures sysadmin routing is automatically correct post-migration.
 */

import type { AssignmentStore } from "../nodes/assignment.js";
import type { MigrationTicket } from "./types.js";
import type { PluginLogger } from "../types.js";

/**
 * Update the assignment store after a migration completes.
 *
 * Moves the agent's assignment from the source node to the target node.
 * This ensures sysadmin routing automatically works for the migrated agent.
 *
 * @param ticket - The completed migration ticket
 * @param assignments - The assignment store to update
 * @param logger - Logger for audit trail
 */
export async function onMigrationCompleteAssignment(
  ticket: MigrationTicket,
  assignments: AssignmentStore,
  logger: PluginLogger,
): Promise<void> {
  const { agentId } = ticket;
  const sourceNodeId = ticket.source.nodeId;
  const targetNodeId = ticket.target.nodeId;

  try {
    // Get existing assignment (to preserve portable path if available)
    const existingAssignment = assignments.get(agentId);
    const portablePath = existingAssignment?.portablePath;

    // Update assignment to target node
    await assignments.set(agentId, targetNodeId, portablePath);

    logger.info(
      `[flock:migration:assignment] ${ticket.migrationId}: Updated assignment ${agentId} from ${sourceNodeId} → ${targetNodeId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[flock:migration:assignment] ${ticket.migrationId}: Failed to update assignment for ${agentId}: ${msg}`,
    );
    throw err;
  }
}