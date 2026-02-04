/**
 * Flock configuration resolution.
 * Merges plugin config with sensible defaults.
 */

export type DatabaseBackend = "memory" | "sqlite" | "postgres";

/** Network topology for agent routing. */
export type Topology = "peer" | "central";

/** Configuration for a remote Flock node. */
export interface RemoteNodeConfig {
  nodeId: string;
  a2aEndpoint: string;
}

export interface FlockConfig {
  dataDir: string;
  dbBackend: DatabaseBackend;
  /** Network topology: "peer" (default) or "central". */
  topology: Topology;
  homes: {
    rootDir: string;
    baseDir: string;
  };
  sysadmin: {
    enabled: boolean;
    autoGreen: boolean;
  };
  economy: {
    enabled: boolean;
    initialBalance: number;
  };
  /** This node's identity. Defaults to "local". */
  nodeId: string;
  /** Remote Flock nodes to connect to on startup. */
  remoteNodes: RemoteNodeConfig[];
  /** Test-only: register echo agents on startup for E2E testing. */
  testAgents: string[];
  /** Agents backed by gateway sessions (registered in OpenClaw agents.list). */
  gatewayAgents: Array<{
    id: string;
    systemPrompt?: string;
    role?: "worker" | "sysadmin" | "system" | "orchestrator";
    archetype?: string;
  }>;
  /**
   * Agent IDs that should be promoted to orchestrator role regardless of
   * their gatewayAgents role setting. This handles environments where the
   * config schema doesn't accept "orchestrator" as a role value.
   * Secure: only admin-controlled config can set this.
   */
  orchestratorIds: string[];
  /** Gateway connection settings for session-send calls. */
  gateway: {
    port: number;
    token: string;
  };
  /** Base directory for shared workspace vaults. */
  vaultsBasePath: string;
  /**
   * Channel-to-agent routing map. Maps Discord channel IDs to arrays of
   * agent IDs that should receive broadcasts from that channel.
   * When orchestrator calls flock_broadcast from a Discord channel session,
   * targets are automatically filtered to only include agents in this mapping.
   */
  channelRouting: Record<string, string[]>;
}

/** Safely coerce an unknown value to a string-keyed record. */
function toRecord(v: unknown): Record<string, unknown> {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return {};
}

export function resolveFlockConfig(raw?: Record<string, unknown> | null): FlockConfig {
  const r = raw ?? {};
  const dataDir = typeof r.dataDir === "string" ? r.dataDir : ".flock";

  const homesRaw = toRecord(r.homes);
  const sysadminRaw = toRecord(r.sysadmin);
  const economyRaw = toRecord(r.economy);
  const gatewayRaw = toRecord(r.gateway);

  const dbBackend = (
    typeof r.dbBackend === "string" &&
    ["memory", "sqlite", "postgres"].includes(r.dbBackend)
  ) ? r.dbBackend as DatabaseBackend : "memory";

  const topology: Topology = (
    typeof r.topology === "string" &&
    (r.topology === "peer" || r.topology === "central")
  ) ? r.topology : "peer";

  const nodeId = typeof r.nodeId === "string" ? r.nodeId : "local";

  const remoteNodes: RemoteNodeConfig[] = Array.isArray(r.remoteNodes)
    ? r.remoteNodes
        .map((n): RemoteNodeConfig | null => {
          if (typeof n !== "object" || n === null) return null;
          const obj = n as Record<string, unknown>;
          if (typeof obj.nodeId !== "string" || typeof obj.a2aEndpoint !== "string") return null;
          return { nodeId: obj.nodeId, a2aEndpoint: obj.a2aEndpoint };
        })
        .filter((n): n is RemoteNodeConfig => n !== null)
    : [];

  return {
    dataDir,
    dbBackend,
    topology,
    nodeId,
    remoteNodes,
    homes: {
      rootDir:
        typeof homesRaw.rootDir === "string"
          ? homesRaw.rootDir
          : "/data/flock-homes",
      baseDir:
        typeof homesRaw.baseDir === "string"
          ? homesRaw.baseDir
          : `${dataDir}/base`,
    },
    sysadmin: {
      enabled: sysadminRaw.enabled === true,
      autoGreen: sysadminRaw.autoGreen !== false, // default true
    },
    economy: {
      enabled: economyRaw.enabled === true,
      initialBalance:
        typeof economyRaw.initialBalance === "number"
          ? economyRaw.initialBalance
          : 1000,
    },
    testAgents: Array.isArray(r.testAgents)
      ? r.testAgents.filter((a): a is string => typeof a === "string")
      : [],
    gatewayAgents: Array.isArray(r.gatewayAgents)
      ? r.gatewayAgents
          .map((a): {
            id: string;
            systemPrompt?: string;
            role?: "worker" | "sysadmin" | "system" | "orchestrator";
            archetype?: string;
          } | null => {
            // Accept both string shorthand and { id, systemPrompt? } objects
            if (typeof a === "string") return { id: a };
            if (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).id === "string") {
              const obj = a as Record<string, unknown>;
              const validRoles = ["worker", "sysadmin", "system", "orchestrator"] as const;
              const role = (
                typeof obj.role === "string" &&
                (validRoles as readonly string[]).includes(obj.role)
              ) ? obj.role as "worker" | "sysadmin" | "system" | "orchestrator" : undefined;
              return {
                id: obj.id as string,
                systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : undefined,
                role,
                archetype: typeof obj.archetype === "string" ? obj.archetype : undefined,
              };
            }
            return null;
          })
          .filter((a): a is {
            id: string;
            systemPrompt?: string;
            role?: "worker" | "sysadmin" | "system" | "orchestrator";
            archetype?: string;
          } => a !== null)
      : [],
    orchestratorIds: Array.isArray(r.orchestratorIds)
      ? r.orchestratorIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(s => s.trim())
      : [],
    gateway: {
      port: typeof gatewayRaw.port === "number" ? gatewayRaw.port : 3779,
      token: typeof gatewayRaw.token === "string" ? gatewayRaw.token : "",
    },
    vaultsBasePath: typeof r.vaultsBasePath === "string" ? r.vaultsBasePath : `${dataDir}/vaults`,
    channelRouting: parseChannelRouting(r.channelRouting),
  };
}

/** Parse channelRouting from config, returning Record<channelId, agentIds[]>. */
function parseChannelRouting(raw: unknown): Record<string, string[]> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [channelId, agents] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(agents)) {
      const validAgents = agents.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
      if (validAgents.length > 0) {
        result[channelId] = validAgents;
      }
    }
  }
  return result;
}
