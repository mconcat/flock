/**
 * Assignment Store — tracks which physical node each agent is assigned to.
 *
 * In central topology, ALL worker agents run on the central node, but each
 * is logically "assigned" to a physical node (for sysadmin routing and
 * portable storage paths). Migration = changing the assignment + moving storage.
 *
 * Functional factory pattern matching createHomeManager, createAuditLog, etc.
 */

/** A single agent→node assignment record. */
export interface NodeAssignment {
  /** The agent being assigned. */
  agentId: string;
  /** The physical node this agent is assigned to. */
  nodeId: string;
  /** Epoch ms when the assignment was created/updated. */
  assignedAt: number;
  /** Portable storage path on the assigned node. */
  portablePath: string;
}

/** CRUD interface for agent→node assignments. */
export interface AssignmentStore {
  /** Get a single assignment, or null if not assigned. */
  get(agentId: string): NodeAssignment | null;
  /** Async lookup of just the nodeId (convenience for resolvers). */
  getNodeId(agentId: string): Promise<string | null>;
  /** Create or update an assignment. */
  set(agentId: string, nodeId: string, portablePath?: string): Promise<void>;
  /** Remove an assignment. */
  remove(agentId: string): Promise<void>;
  /** List all assignments for a given physical node. */
  listByNode(nodeId: string): NodeAssignment[];
  /** List all assignments. */
  list(): NodeAssignment[];
}

/**
 * Create an in-memory assignment store.
 *
 * No external dependencies — pure in-memory Map, matching the pattern
 * used by createMemoryDatabase stores in db/memory.ts.
 */
export function createAssignmentStore(): AssignmentStore {
  const assignments = new Map<string, NodeAssignment>();

  function get(agentId: string): NodeAssignment | null {
    const entry = assignments.get(agentId);
    return entry ? { ...entry } : null;
  }

  async function getNodeId(agentId: string): Promise<string | null> {
    return assignments.get(agentId)?.nodeId ?? null;
  }

  async function set(
    agentId: string,
    nodeId: string,
    portablePath?: string,
  ): Promise<void> {
    const existing = assignments.get(agentId);
    assignments.set(agentId, {
      agentId,
      nodeId,
      assignedAt: Date.now(),
      portablePath: portablePath ?? existing?.portablePath ?? "",
    });
  }

  async function remove(agentId: string): Promise<void> {
    assignments.delete(agentId);
  }

  function listByNode(nodeId: string): NodeAssignment[] {
    const results: NodeAssignment[] = [];
    for (const entry of assignments.values()) {
      if (entry.nodeId === nodeId) {
        results.push({ ...entry });
      }
    }
    return results;
  }

  function list(): NodeAssignment[] {
    return Array.from(assignments.values()).map((e) => ({ ...e }));
  }

  return { get, getNodeId, set, remove, listByNode, list };
}
