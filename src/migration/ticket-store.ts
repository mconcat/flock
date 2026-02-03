/**
 * Migration Ticket Store — in-memory storage for migration tickets.
 *
 * Follows the factory function pattern (like createHomeManager, createAuditLog).
 * Manages ticket lifecycle: create → update phases → complete/abort.
 * Validates phase transitions against VALID_PHASE_TRANSITIONS.
 */

import type { PluginLogger } from "../types.js";
import type {
  MigrationTicket,
  MigrationPhase,
  MigrationReason,
  MigrationEndpoint,
  MigrationError,
} from "./types.js";
import { VALID_PHASE_TRANSITIONS } from "./types.js";

// --- Ticket Store Interface ---

/** Interface for migration ticket persistence. */
export interface MigrationTicketStore {
  /** Create a new migration ticket in REQUESTED phase. */
  create(params: CreateTicketParams): MigrationTicket;

  /** Get a ticket by migration ID. */
  get(migrationId: string): MigrationTicket | null;

  /** Get all tickets for a specific agent. */
  getByAgent(agentId: string): MigrationTicket[];

  /** Update a ticket's phase (validates transition), optionally with additional field updates atomically. */
  updatePhase(migrationId: string, toPhase: MigrationPhase, additionalUpdates?: Omit<TicketUpdateFields, "phase">): MigrationTicket;

  /** Update a ticket's fields. */
  update(migrationId: string, fields: TicketUpdateFields): MigrationTicket;

  /** List all tickets, optionally filtered. */
  list(filter?: TicketFilter): MigrationTicket[];

  /** Remove a ticket from the store. */
  remove(migrationId: string): boolean;
}

/** Parameters for creating a new migration ticket. */
export interface CreateTicketParams {
  migrationId: string;
  agentId: string;
  source: MigrationEndpoint;
  target: MigrationEndpoint;
  reason: MigrationReason;
}

/** Updatable fields on a migration ticket. */
export interface TicketUpdateFields {
  phase?: MigrationPhase;
  ownershipHolder?: "source" | "target";
  reservationId?: string | null;
  error?: MigrationError | null;
}

/** Filter criteria for listing tickets. */
export interface TicketFilter {
  agentId?: string;
  phase?: MigrationPhase;
  sourceNodeId?: string;
  targetNodeId?: string;
}

// --- Ticket Store Params ---

/** Parameters for createTicketStore factory. */
export interface TicketStoreParams {
  logger: PluginLogger;
}

// --- Factory Function ---

/**
 * Create an in-memory migration ticket store.
 *
 * @param params - Store configuration with logger
 * @returns MigrationTicketStore instance
 */
export function createTicketStore(params: TicketStoreParams): MigrationTicketStore {
  const { logger } = params;
  const store = new Map<string, MigrationTicket>();

  function create(createParams: CreateTicketParams): MigrationTicket {
    const { migrationId, agentId, source, target, reason } = createParams;

    if (store.has(migrationId)) {
      throw new Error(`Migration ticket already exists: ${migrationId}`);
    }

    const now = Date.now();
    const ticket: MigrationTicket = {
      migrationId,
      agentId,
      source,
      target,
      phase: "REQUESTED",
      ownershipHolder: "source",
      reason,
      reservationId: null,
      timestamps: { REQUESTED: now },
      createdAt: now,
      updatedAt: now,
      error: null,
    };

    store.set(migrationId, ticket);
    logger.info(`[flock:migration] Created ticket ${migrationId} for agent ${agentId}`);
    return cloneTicket(ticket);
  }

  function get(migrationId: string): MigrationTicket | null {
    const ticket = store.get(migrationId);
    return ticket ? cloneTicket(ticket) : null;
  }

  function getByAgent(agentId: string): MigrationTicket[] {
    const results: MigrationTicket[] = [];
    for (const ticket of store.values()) {
      if (ticket.agentId === agentId) {
        results.push(cloneTicket(ticket));
      }
    }
    return results;
  }

  function updatePhase(
    migrationId: string,
    toPhase: MigrationPhase,
    additionalUpdates?: Omit<TicketUpdateFields, "phase">,
  ): MigrationTicket {
    const ticket = store.get(migrationId);
    if (!ticket) {
      throw new Error(`Migration ticket not found: ${migrationId}`);
    }

    const currentPhase = ticket.phase;
    const allowed = VALID_PHASE_TRANSITIONS[currentPhase];

    if (!allowed.includes(toPhase)) {
      throw new Error(
        `Invalid phase transition: ${currentPhase} → ${toPhase} for migration ${migrationId}. ` +
        `Allowed: ${allowed.join(", ") || "(none — terminal state)"}`,
      );
    }

    const now = Date.now();
    ticket.phase = toPhase;
    ticket.updatedAt = now;
    ticket.timestamps = { ...ticket.timestamps, [toPhase]: now };

    // Apply additional field updates atomically with the phase transition
    if (additionalUpdates) {
      if (additionalUpdates.ownershipHolder !== undefined) {
        ticket.ownershipHolder = additionalUpdates.ownershipHolder;
      }
      if (additionalUpdates.reservationId !== undefined) {
        ticket.reservationId = additionalUpdates.reservationId;
      }
      if (additionalUpdates.error !== undefined) {
        ticket.error = additionalUpdates.error;
      }
    }

    logger.info(`[flock:migration] ${migrationId}: ${currentPhase} → ${toPhase}`);
    return cloneTicket(ticket);
  }

  function update(migrationId: string, fields: TicketUpdateFields): MigrationTicket {
    const ticket = store.get(migrationId);
    if (!ticket) {
      throw new Error(`Migration ticket not found: ${migrationId}`);
    }

    // If phase update is included, validate the transition
    if (fields.phase !== undefined && fields.phase !== ticket.phase) {
      const allowed = VALID_PHASE_TRANSITIONS[ticket.phase];
      if (!allowed.includes(fields.phase)) {
        throw new Error(
          `Invalid phase transition: ${ticket.phase} → ${fields.phase} for migration ${migrationId}. ` +
          `Allowed: ${allowed.join(", ") || "(none — terminal state)"}`,
        );
      }
      ticket.phase = fields.phase;
      ticket.timestamps = { ...ticket.timestamps, [fields.phase]: Date.now() };
    }

    if (fields.ownershipHolder !== undefined) {
      ticket.ownershipHolder = fields.ownershipHolder;
    }
    if (fields.reservationId !== undefined) {
      ticket.reservationId = fields.reservationId;
    }
    if (fields.error !== undefined) {
      ticket.error = fields.error;
    }

    ticket.updatedAt = Date.now();

    return cloneTicket(ticket);
  }

  function list(filter?: TicketFilter): MigrationTicket[] {
    const results: MigrationTicket[] = [];
    for (const ticket of store.values()) {
      if (matchesFilter(ticket, filter)) {
        results.push(cloneTicket(ticket));
      }
    }
    return results;
  }

  function remove(migrationId: string): boolean {
    const existed = store.delete(migrationId);
    if (existed) {
      logger.info(`[flock:migration] Removed ticket ${migrationId}`);
    }
    return existed;
  }

  return { create, get, getByAgent, updatePhase, update, list, remove };
}

// --- Helpers ---

/** Clone a ticket to prevent external mutation of store internals. */
function cloneTicket(ticket: MigrationTicket): MigrationTicket {
  return {
    ...ticket,
    source: { ...ticket.source },
    target: { ...ticket.target },
    timestamps: { ...ticket.timestamps },
    error: ticket.error ? { ...ticket.error } : null,
  };
}

/** Check if a ticket matches a filter. */
function matchesFilter(ticket: MigrationTicket, filter: TicketFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.agentId !== undefined && ticket.agentId !== filter.agentId) return false;
  if (filter.phase !== undefined && ticket.phase !== filter.phase) return false;
  if (filter.sourceNodeId !== undefined && ticket.source.nodeId !== filter.sourceNodeId) return false;
  if (filter.targetNodeId !== undefined && ticket.target.nodeId !== filter.targetNodeId) return false;
  return true;
}
