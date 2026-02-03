/**
 * Flock Transport Layer — A2A protocol based agent communication.
 *
 * Public API:
 * - A2AServer: mounts JSON-RPC endpoints for receiving agent messages
 * - createA2AClient: factory for sending messages to other agents
 * - CardRegistry: manages Agent Card discovery
 * - Agent Card factories: create cards for workers/sysadmin
 * - FlockExecutor: bridges A2A tasks to Clawdbot sessions
 * - Routing: topology-agnostic resolver function types
 * - Topologies: peer (P2P) resolver factories
 */

// Types
export type {
  FlockAgentRole,
  FlockCardMetadata,
  FlockTaskMetadata,
  TriageResult,
  TransportConfig,
  CardRegistryEntry,
} from "./types.js";
export { DEFAULT_TRANSPORT_CONFIG } from "./types.js";

// A2A Helpers
export {
  textPart,
  dataPart,
  agentMessage,
  userMessage,
  artifact,
  taskStatus,
  task,
  extractText,
  extractData,
  extractTaskText,
  isDataPart,
} from "./a2a-helpers.js";

// Agent Cards
export {
  createAgentCard,
  createSysadminCard,
  createWorkerCard,
  buildFlockMetadata,
  CardRegistry,
} from "./agent-card.js";
export type { CreateCardParams } from "./agent-card.js";

// Executor
export { createFlockExecutor } from "./executor.js";
export type { SessionSendFn, FlockExecutorParams } from "./executor.js";

// Server
export { A2AServer } from "./server.js";
export type { A2AServerConfig, RouteHandler, RouteRequest } from "./server.js";

// Client (factory function)
export { createA2AClient } from "./client.js";
export type { A2AClient, A2AClientConfig, A2AClientResult } from "./client.js";

// Route types
export type { RouteResult, LocalRoute, RemoteRoute } from "./router.js";

// Routing (functional topology abstraction)
export type { ResolveAgent, ResolveSysadmin, GetExecutionNode, Reassign } from "./routing.js";

// Topologies
export { createPeerResolver, createPeerSysadminResolver } from "./topologies/peer.js";
