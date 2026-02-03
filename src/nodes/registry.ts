/**
 * Node Registry
 *
 * Tracks known Flock nodes and their A2A endpoints.
 * Used for cross-node agent routing: given an agentId,
 * find which node hosts it and how to reach it.
 *
 * Supports hierarchical lookup via a parent registry reference:
 * if an agent isn't found locally, the query cascades to the parent
 * (like DNS resolution through ISP layers).
 *
 * Central/Worker architecture:
 *   Worker node registry → parent: Central node registry
 *   Worker doesn't need to know every node — just asks central.
 */

/** Status of a known node. */
export type NodeStatus = "online" | "offline" | "unknown";

/** A registered remote node. */
export interface NodeEntry {
  /** Unique node identifier. */
  nodeId: string;
  /** A2A endpoint URL (e.g. "http://node2:3779/flock"). */
  a2aEndpoint: string;
  /** Current known status. */
  status: NodeStatus;
  /** Epoch ms when the node was last seen healthy. */
  lastSeen: number;
  /** Agent IDs known to be hosted on this node. */
  agentIds: string[];
}

/**
 * Remote registry reference for hierarchical lookups.
 * When the local registry can't resolve an agent, it queries the parent.
 */
export interface ParentRegistryRef {
  /** A2A endpoint of the parent node (e.g. "http://central:3779/flock"). */
  endpoint: string;
  /** Timeout for remote lookups (ms). Default: 5000. */
  timeoutMs?: number;
  /** TTL for cached parent results (ms). Default: 300000 (5 minutes). */
  cacheTtlMs?: number;
}

/** Metadata for a cached parent lookup result. */
interface CacheEntry {
  /** When this entry was cached (epoch ms). */
  cachedAt: number;
  /** The node ID where the agent was found. */
  nodeId: string;
}

/** Result of a remote registry lookup. */
export interface RegistryLookupResult {
  /** The node entry hosting the agent, or null if not found. */
  entry: NodeEntry | null;
  /** Whether this result came from the parent registry. */
  fromParent: boolean;
}

/**
 * In-memory registry of Flock nodes.
 *
 * Provides CRUD for node entries and agent-to-node lookups
 * used by the AgentRouter for cross-node message delivery.
 *
 * Supports an optional parent registry: when `findNodeForAgent`
 * misses locally, it queries the parent via HTTP and caches the result.
 */
export class NodeRegistry {
  private nodes = new Map<string, NodeEntry>();
  private parentRef: ParentRegistryRef | null = null;
  /** Tracks which agent→node mappings came from parent lookups, with timestamps. */
  private parentCache = new Map<string, CacheEntry>();

  private get cacheTtlMs(): number {
    return this.parentRef?.cacheTtlMs ?? 300_000; // 5 minutes default
  }

  /** Set a parent registry for hierarchical lookups. */
  setParent(ref: ParentRegistryRef): void {
    this.parentRef = { ...ref };
  }

  /** Get the current parent registry reference, or null. */
  getParent(): ParentRegistryRef | null {
    return this.parentRef ? { ...this.parentRef } : null;
  }

  /** Remove the parent registry reference. */
  clearParent(): void {
    this.parentRef = null;
  }

  /** Register or replace a node entry. */
  register(entry: NodeEntry): void {
    this.nodes.set(entry.nodeId, { ...entry });
  }

  /** Remove a node by ID. Returns true if it existed. */
  remove(nodeId: string): boolean {
    return this.nodes.delete(nodeId);
  }

  /** Get a node entry by ID, or null if not found. */
  get(nodeId: string): NodeEntry | null {
    const entry = this.nodes.get(nodeId);
    return entry ? { ...entry, agentIds: [...entry.agentIds] } : null;
  }

  /** List all locally registered nodes. */
  list(): NodeEntry[] {
    return Array.from(this.nodes.values()).map((e) => ({
      ...e,
      agentIds: [...e.agentIds],
    }));
  }

  /** Find which node hosts a given agent (local only, synchronous). */
  findNodeForAgent(agentId: string): NodeEntry | null {
    for (const entry of this.nodes.values()) {
      if (entry.agentIds.includes(agentId)) {
        return { ...entry, agentIds: [...entry.agentIds] };
      }
    }
    return null;
  }

  /**
   * Find which node hosts a given agent, with parent fallback.
   *
   * Resolution order:
   * 1. Local registry lookup (synchronous)
   *    - If found via previous parent cache: check TTL, refresh if stale
   * 2. If not found and parent is set → HTTP query to parent
   * 3. If parent returns a result → cache it locally for future lookups
   */
  async findNodeForAgentWithParent(agentId: string): Promise<RegistryLookupResult> {
    // 1. Local lookup
    const local = this.findNodeForAgent(agentId);
    if (local) {
      // Check if this was a cached parent result that might be stale
      const cacheEntry = this.parentCache.get(agentId);
      if (cacheEntry) {
        const age = Date.now() - cacheEntry.cachedAt;
        if (age > this.cacheTtlMs) {
          // TTL expired — re-validate with parent
          return this.revalidateWithParent(agentId, local);
        }
      }
      return { entry: local, fromParent: !!cacheEntry };
    }

    // 2. Parent lookup
    if (!this.parentRef) {
      return { entry: null, fromParent: false };
    }

    const remote = await this.queryParent(agentId);
    if (remote) {
      // 3. Cache in local registry
      this.cacheParentResult(remote, agentId);
      return { entry: { ...remote, agentIds: [...remote.agentIds] }, fromParent: true };
    }

    return { entry: null, fromParent: false };
  }

  /**
   * Validate a cached agent→node mapping against the current agent.
   *
   * Call this when you contact a node and the expected agent
   * isn't there (e.g., agent migrated). Marks the cache as stale,
   * re-queries parent, and returns the fresh result.
   */
  async validateAgent(agentId: string, expectedNodeId: string): Promise<RegistryLookupResult> {
    const cacheEntry = this.parentCache.get(agentId);

    // If cached node matches expectation, the mapping is still good
    if (cacheEntry && cacheEntry.nodeId === expectedNodeId) {
      const local = this.findNodeForAgent(agentId);
      if (local) {
        return { entry: local, fromParent: true };
      }
    }

    // Stale — evict and re-query parent
    this.evictCachedAgent(agentId);
    return this.findNodeForAgentWithParent(agentId);
  }

  /** Update the agent list for a node (e.g. after remote card discovery). */
  updateAgents(nodeId: string, agentIds: string[]): void {
    const entry = this.nodes.get(nodeId);
    if (entry) {
      entry.agentIds = [...agentIds];
    }
  }

  /** Mark a node as online/offline/unknown. */
  updateStatus(nodeId: string, status: NodeStatus): void {
    const entry = this.nodes.get(nodeId);
    if (entry) {
      entry.status = status;
      if (status === "online") {
        entry.lastSeen = Date.now();
      }
    }
  }

  /** Check whether any node is registered with the given ID. */
  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  /** Total number of locally registered nodes. */
  get size(): number {
    return this.nodes.size;
  }

  /** Remove a cached parent lookup for an agent. */
  private evictCachedAgent(agentId: string): void {
    const cacheEntry = this.parentCache.get(agentId);
    if (!cacheEntry) return;

    this.parentCache.delete(agentId);

    // Remove agent from the cached node entry
    const node = this.nodes.get(cacheEntry.nodeId);
    if (node) {
      node.agentIds = node.agentIds.filter((id) => id !== agentId);
      // If no agents left on this node entry and it was parent-resolved, clean it up
      if (node.agentIds.length === 0 && cacheEntry.nodeId.startsWith("parent-resolved-")) {
        this.nodes.delete(cacheEntry.nodeId);
      }
    }
  }

  /**
   * Re-validate a cached entry by querying the parent.
   * If the parent returns a different node, update the cache.
   */
  private async revalidateWithParent(
    agentId: string,
    cachedEntry: NodeEntry,
  ): Promise<RegistryLookupResult> {
    if (!this.parentRef) {
      // No parent — use cached entry as-is
      return { entry: cachedEntry, fromParent: true };
    }

    const fresh = await this.queryParent(agentId);
    if (!fresh) {
      // Parent doesn't know this agent anymore — evict cache
      this.evictCachedAgent(agentId);
      return { entry: null, fromParent: false };
    }

    // Check if the agent moved to a different node
    const oldCache = this.parentCache.get(agentId);
    if (oldCache && fresh.nodeId !== oldCache.nodeId) {
      // Agent migrated — evict old, cache new
      this.evictCachedAgent(agentId);
    }

    this.cacheParentResult(fresh, agentId);
    return { entry: { ...fresh, agentIds: [...fresh.agentIds] }, fromParent: true };
  }

  // --- Parent registry communication ---

  /**
   * Query the parent registry for an agent's node.
   * Uses the parent's agent card directory to find which node hosts the agent.
   */
  private async queryParent(agentId: string): Promise<NodeEntry | null> {
    if (!this.parentRef) return null;

    const timeoutMs = this.parentRef.timeoutMs ?? 5000;
    const url = `${this.parentRef.endpoint}/.well-known/agent-card.json`;

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) return null;

      const data: unknown = await res.json();
      if (!isAgentCardDirectory(data)) return null;

      // Find the agent in the directory
      const agentEntry = data.agents.find((a) => a.id === agentId);
      if (!agentEntry) return null;

      // Extract the node endpoint from the agent's URL
      // Agent URL format: "http://host:port/flock/a2a/{agentId}"
      // We need the base: "http://host:port/flock"
      const agentUrl = typeof agentEntry.url === "string" ? agentEntry.url : "";
      const a2aEndpoint = extractBaseEndpoint(agentUrl);
      if (!a2aEndpoint) return null;

      // Build a node entry from the parent's response
      // Use the endpoint as a synthetic nodeId if no explicit one
      const nodeId = `parent-resolved-${a2aEndpoint}`;

      return {
        nodeId,
        a2aEndpoint,
        status: "online",
        lastSeen: Date.now(),
        agentIds: [agentId],
      };
    } catch {
      // Network error, timeout, parse error — silently fail
      return null;
    }
  }

  /** Cache a parent lookup result in the local registry. */
  private cacheParentResult(entry: NodeEntry, agentId: string): void {
    const existing = this.nodes.get(entry.nodeId);
    if (existing) {
      // Merge agent IDs rather than replacing
      const mergedIds = new Set([...existing.agentIds, ...entry.agentIds]);
      existing.agentIds = [...mergedIds];
      existing.status = entry.status;
      existing.lastSeen = entry.lastSeen;
    } else {
      this.register(entry);
    }

    // Track cache metadata
    this.parentCache.set(agentId, {
      cachedAt: Date.now(),
      nodeId: entry.nodeId,
    });
  }
}

// --- Helpers ---

/** Type guard for the agent card directory response. */
function isAgentCardDirectory(v: unknown): v is { agents: Array<{ id: string; url?: string }> } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.agents)) return false;
  return obj.agents.every(
    (a: unknown) => typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).id === "string",
  );
}

/**
 * Extract the base Flock endpoint from an agent URL.
 * "http://node2:3002/flock/a2a/worker-beta" → "http://node2:3002/flock"
 * "http://node:3000/deep/flock/a2a/worker" → "http://node:3000/deep/flock"
 */
function extractBaseEndpoint(agentUrl: string): string | null {
  const match = agentUrl.match(/^(https?:\/\/.+?)\/a2a\//);
  return match?.[1] ?? null;
}
