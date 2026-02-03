/**
 * Home Manager — state machine for agent homes.
 *
 * A "home" is the persistent environment where an agent resides on a node.
 * Identified by homeId = agentId@nodeId.
 *
 * State transitions:
 *   UNASSIGNED → PROVISIONING → IDLE
 *   IDLE → LEASED → ACTIVE
 *   LEASED|ACTIVE → FROZEN (expiry / forced reclamation / security)
 *   FROZEN → LEASED (re-lease) | MIGRATING → PROVISIONING (on target node)
 *   ANY → ERROR | RETIRED
 */

import type {
  HomeRecord,
  HomeState,
  HomeTransition,
  PluginLogger,
} from "../types.js";
import type { FlockDatabase } from "../db/index.js";
import { makeHomeId } from "./utils.js";

// Valid state transitions
const VALID_TRANSITIONS: Record<HomeState, HomeState[]> = {
  UNASSIGNED: ["PROVISIONING", "RETIRED"],
  PROVISIONING: ["IDLE", "ERROR"],
  IDLE: ["LEASED", "FROZEN", "RETIRED", "ERROR"],
  LEASED: ["ACTIVE", "FROZEN", "IDLE", "ERROR"],
  ACTIVE: ["LEASED", "FROZEN", "IDLE", "ERROR"],
  FROZEN: ["LEASED", "MIGRATING", "IDLE", "RETIRED", "ERROR"],
  MIGRATING: ["PROVISIONING", "FROZEN", "ERROR"],
  ERROR: ["PROVISIONING", "RETIRED", "UNASSIGNED"],
  RETIRED: [], // terminal
};

export interface HomeManager {
  create(agentId: string, nodeId: string): HomeRecord;
  get(homeId: string): HomeRecord | null;
  list(filter?: { nodeId?: string; state?: HomeState }): HomeRecord[];
  transition(homeId: string, toState: HomeState, reason: string, triggeredBy: string): HomeTransition;
  setLeaseExpiry(homeId: string, expiresAt: number): void;
  checkLeaseExpiry(): HomeTransition[];
}

interface HomeManagerParams {
  db: FlockDatabase;
  logger: PluginLogger;
}

export function createHomeManager(params: HomeManagerParams): HomeManager {
  const { db, logger } = params;

  function create(agentId: string, nodeId: string): HomeRecord {
    const homeId = makeHomeId(agentId, nodeId);

    if (db.homes.get(homeId)) {
      throw new Error(`home already exists: ${homeId}`);
    }

    const now = Date.now();
    const record: HomeRecord = {
      homeId,
      agentId,
      nodeId,
      state: "UNASSIGNED",
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    db.homes.insert(record);

    db.audit.insert({
      id: `home-create-${homeId}-${now}`,
      timestamp: now,
      homeId,
      agentId,
      action: "home.create",
      level: "GREEN",
      detail: `Created home ${homeId}`,
    });

    logger.info(`[flock:homes] created ${homeId}`);
    return record;
  }

  function get(homeId: string): HomeRecord | null {
    return db.homes.get(homeId);
  }

  function list(filter?: { nodeId?: string; state?: HomeState }): HomeRecord[] {
    return db.homes.list(filter);
  }

  function transition(
    homeId: string,
    toState: HomeState,
    reason: string,
    triggeredBy: string,
  ): HomeTransition {
    const home = db.homes.get(homeId);
    if (!home) {
      throw new Error(`home not found: ${homeId}`);
    }

    const fromState = home.state;
    const allowed = VALID_TRANSITIONS[fromState];

    if (!allowed.includes(toState)) {
      throw new Error(
        `invalid transition: ${fromState} → ${toState} for ${homeId}. Allowed: ${allowed.join(", ")}`,
      );
    }

    const now = Date.now();
    const entry: HomeTransition = {
      homeId,
      fromState,
      toState,
      reason,
      triggeredBy,
      timestamp: now,
    };

    // Update home state
    const updates: Partial<Pick<HomeRecord, "state" | "leaseExpiresAt" | "updatedAt">> = {
      state: toState,
      updatedAt: now,
    };

    // Clear lease on freeze/retire
    if (toState === "FROZEN" || toState === "RETIRED") {
      updates.leaseExpiresAt = null;
    }

    db.homes.update(homeId, updates);
    db.transitions.insert(entry);

    db.audit.insert({
      id: `home-transition-${homeId}-${now}`,
      timestamp: now,
      homeId,
      agentId: home.agentId,
      action: "home.transition",
      level: toState === "FROZEN" || toState === "ERROR" ? "YELLOW" : "GREEN",
      detail: `${fromState} → ${toState}: ${reason}`,
    });

    logger.info(`[flock:homes] ${homeId}: ${fromState} → ${toState} (${reason})`);
    return entry;
  }

  function setLeaseExpiry(homeId: string, expiresAt: number): void {
    db.homes.update(homeId, { leaseExpiresAt: expiresAt, updatedAt: Date.now() });
  }

  function checkLeaseExpiry(): HomeTransition[] {
    const now = Date.now();
    const leased = db.homes.list({ state: "LEASED" });
    const active = db.homes.list({ state: "ACTIVE" });
    const candidates = [...leased, ...active];
    const expired: HomeTransition[] = [];

    for (const home of candidates) {
      if (home.leaseExpiresAt !== null && home.leaseExpiresAt <= now) {
        const entry = transition(home.homeId, "FROZEN", "lease expired", "system");
        expired.push(entry);
      }
    }

    return expired;
  }

  return { create, get, list, transition, setLeaseExpiry, checkLeaseExpiry };
}
