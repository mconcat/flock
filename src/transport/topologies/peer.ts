/**
 * Peer Topology — P2P routing.
 *
 * Every node is equal. Agents live on the node where they were created.
 * Resolution: local server → local registry → parent registry → fallback local.
 *
 * This is the extracted logic from the former AgentRouter class.
 */

import type { A2AServer } from "../server.js";
import type { NodeRegistry } from "../../nodes/registry.js";
import type { ResolveAgent, ResolveSysadmin } from "../routing.js";

/**
 * Create a P2P agent resolver.
 *
 * Resolution order:
 * 1. Local A2A server has the agent → local
 * 2. Local node registry knows a remote node → remote
 * 3. Parent registry lookup (HTTP, cached) → remote
 * 4. Fallback to local (let the server 404)
 */
export const createPeerResolver = (
  server: A2AServer,
  registry: NodeRegistry,
): ResolveAgent =>
  async (agentId) => {
    // 1. Local agent?
    if (server.hasAgent(agentId)) {
      return { local: true };
    }

    // 2. Local registry knows which remote node hosts it?
    const localHit = registry.findNodeForAgent(agentId);
    if (localHit && localHit.status !== "offline") {
      return {
        local: false,
        endpoint: localHit.a2aEndpoint,
        nodeId: localHit.nodeId,
      };
    }

    // 3. Parent registry lookup (HTTP, async)
    if (registry.getParent()) {
      const { entry } = await registry.findNodeForAgentWithParent(agentId);
      if (entry && entry.status !== "offline") {
        return {
          local: false,
          endpoint: entry.a2aEndpoint,
          nodeId: entry.nodeId,
        };
      }
    }

    // 4. Fallback: treat as local (will 404 at the server level)
    return { local: true };
  };

/**
 * Create a P2P sysadmin resolver.
 *
 * In P2P topology, sysadmin is always on the same node.
 */
export const createPeerSysadminResolver = (
  server: A2AServer,
): ResolveSysadmin =>
  async (_agentId) => {
    if (server.hasAgent("sysadmin")) {
      return { local: true };
    }
    return { local: true };
  };
