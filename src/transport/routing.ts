/**
 * Routing — functional topology abstraction.
 *
 * Instead of a class hierarchy (RoutingStrategy → PeerStrategy, CentralStrategy),
 * topologies are represented as plain functions. A2AClient receives a single
 * `ResolveAgent` function — it doesn't know or care which topology created it.
 *
 * New topology = new factory function. No interfaces to implement.
 */

import type { RouteResult } from "./router.js";

/**
 * Resolve an agent's delivery target.
 * Returns LocalRoute (in-process) or RemoteRoute (HTTP).
 */
export type ResolveAgent = (agentId: string) => Promise<RouteResult>;

/**
 * Resolve which sysadmin to contact for a given agent.
 * In P2P, sysadmin is always local. In central, it's on the agent's assigned node.
 */
export type ResolveSysadmin = (agentId: string) => Promise<RouteResult>;

/**
 * Look up which physical node an agent is currently executing on.
 * Returns null if the agent has no node assignment.
 */
export type GetExecutionNode = (agentId: string) => Promise<string | null>;

/**
 * Change an agent's physical node assignment (migration core operation).
 */
export type Reassign = (agentId: string, newNodeId: string) => Promise<void>;
