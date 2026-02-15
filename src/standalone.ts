/**
 * Flock Standalone Runtime
 *
 * Boots Flock without OpenClaw — uses pi-ai for LLM calls, pi-agent-core
 * for agent loops, and Flock's own HTTP server for A2A endpoints.
 *
 * This is the migration target: eventually replaces `register(api)` in index.ts.
 * During migration, both modes coexist.
 *
 * Usage:
 *   import { startFlock } from "./standalone.js";
 *   await startFlock();                    // load config from file
 *   await startFlock(customConfig);        // explicit config
 */

import type { Server } from "node:http";
import { loadFlockConfig, resolveFlockConfig, type FlockConfig } from "./config.js";
import { createFlockLogger, type FlockLoggerOptions } from "./logger.js";
import { createDatabase } from "./db/index.js";
import { createHomeManager } from "./homes/manager.js";
import { createHomeProvisioner } from "./homes/provisioner.js";
import { createAuditLog } from "./audit/log.js";
import { A2AServer } from "./transport/server.js";
import { createA2AClient } from "./transport/client.js";
import { createPeerResolver, createPeerSysadminResolver } from "./transport/topologies/peer.js";
import { createCentralResolver, createCentralSysadminResolver } from "./transport/topologies/central.js";
import { createAssignmentStore } from "./nodes/assignment.js";
import { createWorkerCard, createSysadminCard, createOrchestratorCard } from "./transport/agent-card.js";
import { createFlockExecutor } from "./transport/executor.js";
import { createDirectSend } from "./transport/direct-send.js";
import type { FlockAgentRole } from "./transport/types.js";
import { createTriageDecisionTool } from "./sysadmin/triage-tool.js";
import { NodeRegistry } from "./nodes/registry.js";
import { SessionManager } from "./session/manager.js";
import { startFlockHttpServer, stopFlockHttpServer, readJsonBody } from "./server.js";
import { assembleAgentsMd } from "./prompts/assembler.js";
import { toAgentTool } from "./tool-adapter.js";
import type { ToolDeps } from "./tools/index.js";
import type { PluginLogger } from "./types.js";
import { EchoTracker, type BridgeDeps } from "./bridge/index.js";
import { handleInbound } from "./bridge/inbound.js";
import { handleOutbound } from "./bridge/outbound.js";
import { createDiscordSendExternal, discordMessageToInbound } from "./bridge/discord-client.js";
import {
  createStandaloneCreateAgentTool,
  createStandaloneDecommissionAgentTool,
  createStandaloneRestartTool,
} from "./tools/agent-lifecycle-standalone.js";

// Re-export for external use
export { SessionManager } from "./session/manager.js";
export { createDirectSend } from "./transport/direct-send.js";
export { createFlockLogger } from "./logger.js";
export { loadFlockConfig, resolveFlockConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlockInstance {
  /** Flock configuration. */
  config: FlockConfig;
  /** Session manager for direct LLM calls. */
  sessionManager: SessionManager;
  /** HTTP server (if started). */
  httpServer?: Server;
  /** A2A server for agent communication. */
  a2aServer: A2AServer;
  /** Bridge dependencies (for direct outbound calls). */
  bridgeDeps?: BridgeDeps;
  /** Logger instance. */
  logger: PluginLogger;
  /** Graceful shutdown. */
  stop: () => Promise<void>;
}

export interface StartFlockOptions {
  /** Config override. If not provided, loaded from file. */
  config?: FlockConfig;
  /** Logger options. */
  loggerOptions?: FlockLoggerOptions;
  /** HTTP server port. If not set, uses config.gateway.port + 1. */
  httpPort?: number;
  /** Skip HTTP server startup. */
  noHttp?: boolean;
  /** Discord bot token for standalone bridge. If set, enables Discord bridge. */
  discordBotToken?: string;
}

// ---------------------------------------------------------------------------
// Standalone boot
// ---------------------------------------------------------------------------

/**
 * Start Flock in standalone mode.
 *
 * This is the pi-mono equivalent of `register(api: PluginApi)`.
 * It initializes all Flock subsystems with direct LLM access.
 */
export async function startFlock(opts?: StartFlockOptions): Promise<FlockInstance> {
  const config = opts?.config ?? loadFlockConfig();
  const logger = createFlockLogger(opts?.loggerOptions);

  logger.info(`[flock:standalone] starting v0.3.0 (db: ${config.dbBackend}, topology: ${config.topology})`);

  // --- Database ---
  const db = createDatabase(config);
  db.migrate();

  // --- Core modules ---
  const homeManager = createHomeManager({ db, logger });
  const audit = createAuditLog({ db, logger });
  const provisioner = createHomeProvisioner({ config, logger });

  // --- Node management ---
  const nodeId = config.nodeId;
  const assignments = createAssignmentStore();
  const nodeRegistry = new NodeRegistry();

  // --- A2A transport ---
  const httpPort = opts?.httpPort ?? config.gateway.port + 1;
  const baseUrl = `http://127.0.0.1:${httpPort}`;

  const a2aServer = new A2AServer({ basePath: "/flock", logger });

  const resolver = config.topology === "central"
    ? createCentralResolver()
    : createPeerResolver(a2aServer, nodeRegistry);

  const sysadminResolver = config.topology === "central"
    ? createCentralSysadminResolver(assignments, nodeRegistry)
    : createPeerSysadminResolver(a2aServer);

  const a2aClient = createA2AClient({
    localServer: a2aServer,
    resolve: resolver,
    resolveSysadmin: sysadminResolver,
    logger,
  });

  // --- Session Manager ---
  const sessionManager = new SessionManager(logger);

  // --- Tool deps ---
  const toolDeps: ToolDeps = {
    config,
    homes: homeManager,
    audit,
    provisioner,
    a2aClient,
    a2aServer,
    taskStore: db.tasks,
    channelStore: db.channels,
    channelMessages: db.channelMessages,
    bridgeStore: db.bridges,
    logger,
    vaultsBasePath: config.vaultsBasePath,
    agentLoop: db.agentLoop,
  };

  // --- Register gateway agents ---
  if (config.gatewayAgents.length > 0 && config.gateway.token) {
    const resolveAgentConfig = (agentId: string) => {
      const agentDef = config.gatewayAgents.find((a) => a.id === agentId);
      let role: FlockAgentRole = agentDef?.role ?? "worker";
      if (config.orchestratorIds.includes(agentId)) role = "orchestrator";

      // Assemble system prompt from Flock templates
      const systemPrompt = assembleAgentsMd(role);

      // Build tools for this agent (triage tool for sysadmin, extendable per role)
      const tools = [
        createTriageDecisionTool(),
      ].map(toAgentTool);

      // Model: per-agent config → fallback to default
      const model = agentDef?.model ?? "anthropic/claude-sonnet-4-20250514";

      return { model, systemPrompt, tools };
    };

    const sessionSend = createDirectSend({
      sessionManager,
      resolveAgentConfig,
      logger,
    });

    for (const agent of config.gatewayAgents) {
      let role: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) role = "orchestrator";

      const endpointUrl = `${baseUrl}/a2a/${agent.id}`;
      const { card, meta } = role === "orchestrator"
        ? createOrchestratorCard(nodeId, endpointUrl, agent.id)
        : role === "sysadmin"
          ? createSysadminCard(nodeId, endpointUrl, agent.id)
          : createWorkerCard(agent.id, nodeId, endpointUrl);

      const executor = createFlockExecutor({
        flockMeta: meta,
        sessionSend,
        audit,
        taskStore: db.tasks,
        logger,
      });

      a2aServer.registerAgent(agent.id, card, meta, executor);

      // Initialize agent loop state
      const initialState = role === "sysadmin" ? "REACTIVE" as const : "AWAKE" as const;
      db.agentLoop.init(agent.id, initialState);
    }

    logger.info(`[flock:standalone] registered ${config.gatewayAgents.length} agent(s): ${config.gatewayAgents.map((a) => a.id).join(", ")}`);
  }

  // --- HTTP Server ---
  let httpServer: Server | undefined;
  if (!opts?.noHttp) {
    const httpPort = opts?.httpPort ?? config.gateway.port + 1;
    const routeHandlers = a2aServer.buildRouteHandlers();

    const httpHandler = async (req: any, res: any): Promise<boolean> => {
      const url = req.url || req.path || "";
      const method = req.method || "GET";
      const parsedUrl = new URL(url, "http://localhost");

      if (!parsedUrl.pathname.startsWith("/flock")) {
        return false;
      }

      let body: unknown;
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        try {
          body = await readJsonBody(req);
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return true;
        }
      }

      const pathname = parsedUrl.pathname;
      const agentIdMatch = pathname.match(/\/a2a\/([^/]+)/);
      const agentId = agentIdMatch?.[1];

      for (const [key, routeHandler] of routeHandlers) {
        const [routeMethod, routePath] = key.split(" ", 2);
        const pattern = routePath.replace(/:agentId/g, "([^/]+)");
        const regex = new RegExp(`^${pattern}$`);

        if (method === routeMethod && regex.test(pathname)) {
          const result = await routeHandler({
            params: { agentId },
            body,
            headers: req.headers ?? {},
          });

          res.statusCode = result.status;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result.body));
          return true;
        }
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "not found" }));
      return true;
    };

    httpServer = startFlockHttpServer(httpHandler, {
      port: httpPort,
      logger,
    });
  }

  // --- Bridge (Discord) ---
  let bridgeDeps: BridgeDeps | undefined;
  let echoTracker: EchoTracker | undefined;

  if (opts?.discordBotToken) {
    const sendExternal = createDiscordSendExternal({
      botToken: opts.discordBotToken,
      logger,
    });

    echoTracker = new EchoTracker();

    bridgeDeps = {
      bridgeStore: db.bridges,
      channelStore: db.channels,
      channelMessages: db.channelMessages,
      audit,
      logger,
      sendExternal,
      agentLoop: db.agentLoop,
    };

    // Make sendExternal available to tools
    toolDeps.sendExternal = sendExternal;

    logger.info("[flock:standalone] Discord bridge configured");
  }

  // --- Shutdown ---
  const stop = async () => {
    logger.info("[flock:standalone] shutting down...");
    echoTracker?.dispose();
    sessionManager.destroyAll();
    if (httpServer) {
      await stopFlockHttpServer(httpServer);
    }
    logger.info("[flock:standalone] shutdown complete");
  };

  return {
    config,
    sessionManager,
    httpServer,
    a2aServer,
    bridgeDeps,
    logger,
    stop,
  };
}
