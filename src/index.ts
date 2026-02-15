/**
 * Flock — Multi-agent swarm orchestration.
 *
 * Public API re-exports for standalone mode.
 * The OpenClaw plugin mode (register(api)) has been removed.
 * Use startFlock() for standalone operation.
 */

// Runtime
export { startFlock, type FlockInstance, type StartFlockOptions } from "./standalone.js";
export { SessionManager, type AgentSessionConfig } from "./session/manager.js";
export { createDirectSend } from "./transport/direct-send.js";

// Config & Logger
export { createFlockLogger, type FlockLoggerOptions } from "./logger.js";
export { loadFlockConfig, resolveFlockConfig, type FlockConfig } from "./config.js";

// Auth
export { createApiKeyResolver, type ApiKeyResolverOptions } from "./auth/resolver.js";
export { loadAuthStore, saveAuthStore, listProviders, defaultAuthStorePath, type AuthStore } from "./auth/store.js";

// HTTP Server
export { startFlockHttpServer, stopFlockHttpServer } from "./server.js";

// Tools (creator functions for building tool sets)
export { createFlockTools, type ToolDeps } from "./tools/index.js";
export { createWorkspaceTools, type WorkspaceToolDeps } from "./tools/workspace.js";
export {
  createStandaloneCreateAgentTool,
  createStandaloneDecommissionAgentTool,
  createStandaloneRestartTool,
} from "./tools/agent-lifecycle-standalone.js";
export { createTriageDecisionTool } from "./sysadmin/triage-tool.js";
export { createNodesTool } from "./nodes/tools.js";

// Tool result helper
export { toResult, type FlockToolInput } from "./tools/result.js";

// Types
export type { PluginLogger, AuditLevel } from "./types.js";
export { isAuditLevel } from "./types.js";

// Transport
export { A2AServer } from "./transport/server.js";
export { createA2AClient } from "./transport/client.js";
