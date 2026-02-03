/**
 * Frozen Guard — checks if an agent is currently frozen/migrating.
 *
 * When an agent is in the middle of migration, incoming A2A messages should
 * be rejected with an informative response. This module provides a simple
 * lookup function — the caller (A2A server or handler) decides how to use it.
 */

import type { MigrationPhase } from "./types.js";
import { isTerminalPhase } from "./types.js";
import type { MigrationTicketStore } from "./ticket-store.js";

/** Phases during which an agent is frozen and should reject messages. */
const FROZEN_PHASES: ReadonlySet<MigrationPhase> = new Set([
  "FREEZING",
  "FROZEN",
  "SNAPSHOTTING",
  "TRANSFERRING",
  "VERIFYING",
  "REHYDRATING",
]);

/** Rough downtime estimates per phase (milliseconds). */
const PHASE_DOWNTIME_ESTIMATES: Readonly<Record<string, number>> = {
  FREEZING: 600_000,    // ~10 min remaining
  FROZEN: 540_000,      // ~9 min
  SNAPSHOTTING: 480_000, // ~8 min
  TRANSFERRING: 300_000, // ~5 min
  VERIFYING: 180_000,    // ~3 min
  REHYDRATING: 120_000,  // ~2 min
};

/** Result of checking an agent's frozen status. */
export interface FrozenGuardResult {
  /** Whether the agent is frozen and should reject messages. */
  rejected: boolean;
  /** Human-readable reason for rejection. */
  reason?: string;
  /** Estimated remaining downtime in milliseconds. */
  estimatedDowntimeMs?: number;
}

/**
 * Check if an agent is currently frozen/migrating and should reject messages.
 *
 * Looks up active migration tickets for the agent and checks if any are in
 * a frozen phase. Returns a result indicating whether to reject and why.
 *
 * @param agentId - Agent to check
 * @param ticketStore - Ticket store for migration state lookups
 * @returns FrozenGuardResult with rejection status and details
 */
export function checkFrozenStatus(
  agentId: string,
  ticketStore: MigrationTicketStore,
): FrozenGuardResult {
  const tickets = ticketStore.getByAgent(agentId);

  for (const ticket of tickets) {
    // Skip terminal tickets
    if (isTerminalPhase(ticket.phase)) {
      continue;
    }

    if (FROZEN_PHASES.has(ticket.phase)) {
      const estimatedDowntimeMs = PHASE_DOWNTIME_ESTIMATES[ticket.phase];

      return {
        rejected: true,
        reason: `Agent ${agentId} is currently migrating (phase: ${ticket.phase}, migration: ${ticket.migrationId})`,
        estimatedDowntimeMs,
      };
    }
  }

  return { rejected: false };
}
