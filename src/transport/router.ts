/**
 * Route Result Types
 *
 * Discriminated union for agent delivery targets.
 * Used by topology resolvers and A2AClient.
 */

/** The agent is hosted locally. */
export interface LocalRoute {
  local: true;
}

/** The agent is hosted on a remote node. */
export interface RemoteRoute {
  local: false;
  /** Remote A2A endpoint URL (e.g. "http://node2:3002/flock"). */
  endpoint: string;
  /** Node ID that hosts the agent. */
  nodeId: string;
}

/** Result of resolving an agent's location. */
export type RouteResult = LocalRoute | RemoteRoute;
