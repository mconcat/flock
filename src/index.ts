/**
 * Flock — Agent Swarm Orchestration
 *
 * Two operation modes:
 *   1. Plugin mode:     register(api) — runs as OpenClaw plugin (legacy)
 *   2. Standalone mode: startFlock(opts) — runs independently with pi-ai/pi-agent-core
 *
 * Provides:
 * - Home state machine (UNASSIGNED → ... → ACTIVE → FROZEN → ...)
 * - Lease management (expiry, renewal, forced reclamation)
 * - Sysadmin protocol (GREEN/YELLOW/RED prompt-based triage)
 * - A2A transport layer (Agent Cards, JSON-RPC server/client)
 * - Directory conventions (/flock/base, /flock/node, /flock/agent, ...)
 * - Audit logging (append-only structured events)
 * - Agent tools for swarm interaction
 */

import type { PluginApi } from "./types.js";

// Re-export standalone runtime for direct use
export { startFlock, type FlockInstance, type StartFlockOptions } from "./standalone.js";
export { SessionManager, type AgentSessionConfig } from "./session/manager.js";
export { createDirectSend } from "./transport/direct-send.js";
export { createFlockLogger, type FlockLoggerOptions } from "./logger.js";
export { loadFlockConfig, resolveFlockConfig, type FlockConfig } from "./config.js";
export { toAgentTool, toAgentTools } from "./tool-adapter.js";
export { startFlockHttpServer, stopFlockHttpServer } from "./server.js";
import { createDatabase } from "./db/index.js";
import { createHomeManager } from "./homes/manager.js";
import { createHomeProvisioner } from "./homes/provisioner.js";
import { createAuditLog } from "./audit/log.js";
import { registerFlockTools, type ToolDeps } from "./tools/index.js";
import { resolveFlockConfig } from "./config.js";
import { A2AServer } from "./transport/server.js";
import { createA2AClient } from "./transport/client.js";
import type { A2AClient } from "./transport/client.js";
import { createPeerResolver, createPeerSysadminResolver } from "./transport/topologies/peer.js";
import { createCentralResolver, createCentralSysadminResolver } from "./transport/topologies/central.js";
import { createAssignmentStore } from "./nodes/assignment.js";
import { createWorkerCard, createSysadminCard, createOrchestratorCard } from "./transport/agent-card.js";
import { createEchoExecutor } from "./transport/echo-executor.js";
import { createFlockExecutor } from "./transport/executor.js";
import { createGatewaySessionSend } from "./transport/gateway-send.js";
import type { FlockAgentRole } from "./transport/types.js";
import { createTriageDecisionTool } from "./sysadmin/triage-tool.js";
import { NodeRegistry } from "./nodes/registry.js";
import { discoverRemoteAgents } from "./nodes/discovery.js";
import { createMigrationEngine } from "./migration/engine.js";
import { createTicketStore } from "./migration/ticket-store.js";
import { createMigrationHandlers } from "./migration/handlers.js";
import type { MigrationHandlerContext } from "./migration/handlers.js";
import { createA2ATransport, createLocalDispatch, createHttpDispatch } from "./migration/a2a-transport.js";
import type { HandlerDispatch } from "./migration/a2a-transport.js";
import { createMigrationOrchestrator } from "./migration/orchestrator.js";
import { WorkLoopScheduler } from "./loop/scheduler.js";
import { EchoTracker } from "./bridge/index.js";
import type { BridgeDeps } from "./bridge/index.js";
import { handleInbound } from "./bridge/inbound.js";
import type { InboundEvent, InboundContext } from "./bridge/inbound.js";
import { handleOutbound } from "./bridge/outbound.js";
import { sendViaWebhook } from "./bridge/discord-webhook.js";
import type { BridgePlatform } from "./db/interface.js";
import { readJsonBody } from "./server.js";

/**
 * Safely access an extended method on PluginApi that may not be
 * in the base interface (e.g. registerHttpHandler from OpenClaw runtime).
 */
function getPluginMethod<T>(api: PluginApi, name: string): T | null {
  // OpenClaw's runtime PluginApi may have methods beyond the base interface.
  // We check at runtime rather than casting the whole object.
  if (name in api) {
    const method = (api as unknown as Record<string, unknown>)[name];
    return typeof method === "function" ? (method.bind(api) as T) : null;
  }
  return null;
}
import { createNodesTool } from "./nodes/tools.js";

export function register(api: PluginApi) {
  const logger = api.logger;
  const rawPluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
  logger.info(`[flock:debug] raw pluginConfig keys: ${rawPluginConfig ? Object.keys(rawPluginConfig).join(", ") : "undefined"}`);
  if (rawPluginConfig?.gatewayAgents) {
    logger.info(`[flock:debug] pluginConfig.gatewayAgents: ${JSON.stringify(rawPluginConfig.gatewayAgents)}`);
  }
  const config = resolveFlockConfig(rawPluginConfig);

  logger.info(`[flock] initializing v${api.version ?? "0.2.0"} (db: ${config.dbBackend})`);
  logger.info(`[flock:debug] resolved gatewayAgents: ${config.gatewayAgents.map(a => a.id).join(", ") || "none"}`);

  // Initialize database
  const db = createDatabase(config);
  db.migrate();

  // Initialize core subsystems
  const audit = createAuditLog({ db, logger });
  const homes = createHomeManager({ db, logger });
  const provisioner = createHomeProvisioner({ config, logger });

  // Initialize node registry and topology-specific stores
  const nodeRegistry = new NodeRegistry();
  const assignments = config.topology === "central"
    ? createAssignmentStore()
    : null;

  // Initialize migration subsystem
  const migrationTicketStore = createTicketStore({ logger });
  const migrationContext: MigrationHandlerContext = {
    ticketStore: migrationTicketStore,
    auditLog: audit,
    logger,
    nodeId: config.nodeId,
  };

  // Initialize A2A transport
  const a2aServer = new A2AServer({
    basePath: "/flock",
    logger,
    migrationContext,
  });

  // Initialize migration engine (needs assignments for auto-update hook)
  const migrationEngine = createMigrationEngine({
    ticketStore: migrationTicketStore,
    homeManager: homes,
    auditLog: audit,
    logger,
    nodeId: config.nodeId,
    endpoint: `http://localhost:${config.gateway.port}/flock`,
    mode: config.topology === "central" ? "central" : "p2p",
    tmpDir: config.dataDir + "/tmp",
    registry: nodeRegistry,
    assignments: assignments ?? undefined,
  });

  // Wire migration engine back to handler context (for A2A handler hooks)
  migrationContext.migrationEngine = migrationEngine;

  // Extend migration context with paths for production transport handlers
  migrationContext.tmpDir = config.dataDir + "/tmp";
  migrationContext.resolveHomePath = (agentId: string) => `${config.dataDir}/homes/${agentId}`;
  migrationContext.resolveWorkPath = (agentId: string) => `${config.dataDir}/work/${agentId}`;

  // Create combined dispatch: local for this node, HTTP for remote nodes
  const localMigrationHandlers = createMigrationHandlers(migrationContext);
  const nodeHandlerMap = new Map<string, { handlers: typeof localMigrationHandlers; context: MigrationHandlerContext }>();
  nodeHandlerMap.set(config.nodeId, { handlers: localMigrationHandlers, context: migrationContext });

  const localDispatch = createLocalDispatch(nodeHandlerMap);
  const httpDispatch = createHttpDispatch(nodeRegistry, logger);

  // Combined dispatch: try local first, fall back to HTTP for remote nodes
  const migrationDispatch: HandlerDispatch = async (targetNodeId, method, params) => {
    if (nodeHandlerMap.has(targetNodeId)) {
      return localDispatch(targetNodeId, method, params);
    }
    return httpDispatch(targetNodeId, method, params);
  };

  const migrationTransport = createA2ATransport(migrationDispatch, logger);

  const migrationOrchestrator = createMigrationOrchestrator({
    engine: migrationEngine,
    transport: migrationTransport,
    sourceNodeId: config.nodeId,
    sourceEndpoint: `http://localhost:${config.gateway.port}/flock`,
    resolveSourceHome: (agentId) => `${config.dataDir}/homes/${agentId}`,
    resolveSourceWork: (agentId) => `${config.dataDir}/work/${agentId}`,
    resolveTargetHome: (agentId) => `${config.dataDir}/homes/${agentId}`,
    resolveTargetWork: (agentId) => `${config.dataDir}/work/${agentId}`,
    resolveTargetEndpoint: (nodeId) => nodeRegistry.get(nodeId)?.a2aEndpoint ?? "",
    tmpDir: config.dataDir + "/tmp",
    logger,
  });

  // Wire migration orchestrator back to handler context (for migration/run API)
  migrationContext.migrationOrchestrator = migrationOrchestrator;

  // Register configured remote nodes
  for (const remote of config.remoteNodes) {
    nodeRegistry.register({
      nodeId: remote.nodeId,
      a2aEndpoint: remote.a2aEndpoint,
      status: "unknown",
      lastSeen: 0,
      agentIds: [],
    });
    logger.info(`[flock] registered remote node: ${remote.nodeId} at ${remote.a2aEndpoint}`);
  }

  // Select topology-specific resolvers (after a2aServer is created)
  const resolve = config.topology === "central"
    ? createCentralResolver()
    : createPeerResolver(a2aServer, nodeRegistry);

  const resolveSysadmin = config.topology === "central" && assignments
    ? createCentralSysadminResolver(assignments, nodeRegistry)
    : undefined;

  const a2aClient = createA2AClient({
    localServer: a2aServer,
    resolve,
    resolveSysadmin,
    logger,
  });

  if (config.topology === "central") {
    logger.info(`[flock] topology: central — all workers local, sysadmin via assignment`);
  }

  // Background: discover agents on remote nodes (non-blocking)
  if (config.remoteNodes.length > 0) {
    void (async () => {
      for (const remote of config.remoteNodes) {
        try {
          const agents = await discoverRemoteAgents(remote.a2aEndpoint, logger);
          if (agents.length > 0) {
            const agentIds = agents.map((a) => a.agentId);
            nodeRegistry.updateAgents(remote.nodeId, agentIds);
            nodeRegistry.updateStatus(remote.nodeId, "online");
            logger.info(
              `[flock] discovered ${agents.length} agent(s) on ${remote.nodeId}: ${agentIds.join(", ")}`,
            );
          } else {
            nodeRegistry.updateStatus(remote.nodeId, "offline");
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[flock] discovery failed for ${remote.nodeId}: ${msg}`);
          nodeRegistry.updateStatus(remote.nodeId, "offline");
        }
      }
    })();
  }

  // Register triage_decision tool (sysadmin agents call this for structured classification)
  api.registerTool(createTriageDecisionTool());

  // Register flock_nodes tool (Phase 3 — node management)
  api.registerTool(createNodesTool({ nodeRegistry, logger }));

  // Resolve Discord bot token for webhook auto-creation.
  // Try OpenClaw runtime config first, then fall back to env var.
  let discordBotToken: string | undefined;
  try {
    const runtimeAny = (api as unknown as Record<string, unknown>).runtime as Record<string, unknown> | undefined;
    const configNs = runtimeAny?.config as { loadConfig?: () => Record<string, unknown> } | undefined;
    const ocConfig = configNs?.loadConfig?.();
    const discordCfg = (ocConfig?.channels as Record<string, unknown> | undefined)?.discord as Record<string, unknown> | undefined;
    const cfgToken = discordCfg?.token;
    if (typeof cfgToken === "string" && cfgToken.trim()) {
      discordBotToken = cfgToken.trim().replace(/^Bot\s+/i, "");
    }
  } catch { /* config not available */ }
  if (!discordBotToken && process.env.DISCORD_BOT_TOKEN) {
    discordBotToken = process.env.DISCORD_BOT_TOKEN.trim().replace(/^Bot\s+/i, "");
  }
  if (discordBotToken) {
    logger.info(`[flock] Discord bot token resolved — webhook bridge mode available`);
  }

  // Register agent-facing tools
  // Keep a reference to deps so we can set sysadminAgentId after gateway agents register
  const toolDeps: ToolDeps = {
    config,
    homes,
    audit,
    provisioner,
    a2aClient,
    a2aServer,
    taskStore: db.tasks,
    channelStore: db.channels,
    channelMessages: db.channelMessages,
    migrationEngine,
    migrationOrchestrator,
    logger,
    vaultsBasePath: config.vaultsBasePath,
    bridgeStore: db.bridges,
    discordBotToken,
  };
  registerFlockTools(api, toolDeps);

  // Log registered tool count
  logger.info(`[flock] tools registered, initializing HTTP routes`);

  // Register A2A HTTP handler — single handler for all /flock/* routes
  // Using registerHttpHandler for prefix-based matching since registerHttpRoute
  // may not support Express-style :param paths.
  const routeHandlers = a2aServer.buildRouteHandlers();
  logger.info(`[flock] registering ${routeHandlers.size} route handlers: ${[...routeHandlers.keys()].join(', ')}`);

  // Use registerHttpHandler for prefix-based matching
  // Gateway stores entry as object, invokes entry.handler(req, res)
  logger.info(`[flock] using registerHttpHandler for HTTP routes`);

  const httpHandler = async (req: any, res: any): Promise<boolean> => {
      const url = req.url || req.path || "";
      const method = req.method || "GET";

      // Only handle /flock/* URLs — return false for everything else
      const parsedUrl = new URL(url, "http://localhost");
      if (!parsedUrl.pathname.startsWith("/flock")) {
        return false;
      }

      // Read body for POST/PUT/PATCH requests
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

      // Extract agentId from URL
      const pathname = parsedUrl.pathname;
      const agentIdMatch = pathname.match(/\/a2a\/([^/]+)/);
      const agentId = agentIdMatch?.[1];

      // Find matching route handler
      let matched = false;
      for (const [key, routeHandler] of routeHandlers) {
        const [routeMethod, routePath] = key.split(" ", 2);

        // Convert :agentId to regex
        const pattern = routePath.replace(/:agentId/g, "([^/]+)");
        const regex = new RegExp(`^${pattern}$`);

        if (method === routeMethod && regex.test(pathname)) {
          const result = await routeHandler({
            params: { agentId },
            body,
            headers: req.headers ?? {},
          });

          if (typeof res.status === "function") {
            res.status(result.status).json(result.body);
          } else {
            res.statusCode = result.status;
            res.setHeader?.("Content-Type", "application/json");
            res.end?.(JSON.stringify(result.body));
          }
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Route is under /flock but no matching handler — return 404
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
      }
      return true;  // We handled it (even 404 for /flock/* is our domain)
    };

  // registerHttpHandler is a catch-all prefix handler provided by OpenClaw's PluginApi.
  // It's not in the base PluginApi interface (it's an extended runtime method).
  // We access it via the typed helper to avoid `as any`.
  const registerHttpHandler = getPluginMethod<(handler: typeof httpHandler) => void>(api, "registerHttpHandler");
  if (registerHttpHandler) {
    registerHttpHandler(httpHandler);
    logger.info(`[flock] registered HTTP handler for /flock/* routes`);
  } else {
    logger.warn(`[flock] registerHttpHandler not available — HTTP routes disabled`);
  }

  // Register test agents (E2E / development only)
  if (config.testAgents.length > 0) {
    const nodeId = "test-node";
    const baseUrl = "http://localhost:3779/flock";
    for (const agentId of config.testAgents) {
      const endpointUrl = `${baseUrl}/a2a/${agentId}`;
      const { card, meta } = createWorkerCard(agentId, nodeId, endpointUrl);
      const executor = createEchoExecutor({ agentId, logger });
      a2aServer.registerAgent(agentId, card, meta, executor);
    }
    logger.info(`[flock] registered ${config.testAgents.length} test agent(s): ${config.testAgents.join(", ")}`);
  }

  // Register gateway-backed agents (backed by OpenClaw agent sessions)
  if (config.gatewayAgents.length > 0 && config.gateway.token) {
    const nodeId = "test-node";
    const baseUrl = `http://localhost:${config.gateway.port}/flock`;
    for (const agent of config.gatewayAgents) {
      // Determine role: use explicit role from config, default to "worker".
      // If the agent ID is in orchestratorIds, promote to orchestrator regardless
      // of the gatewayAgents role. This handles environments where the config
      // schema doesn't accept "orchestrator" as a direct role value.
      // NOTE: Do NOT infer role from agent ID — that would be an attack vector.
      let role: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) {
        role = "orchestrator";
      }

      // System prompts are now managed by OpenClaw natively via workspace files
      // (AGENTS.md, SOUL.md, etc.). No need to inject them here — the gateway
      // resolves the agent's session and applies its prompt stack automatically.

      const sessionSend = createGatewaySessionSend({
        port: config.gateway.port,
        token: config.gateway.token,
        logger,
      });
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

      // Sync flock workspace files to OpenClaw workspace directory.
      // This ensures agents get flock-assembled prompts (AGENTS.md with role-specific
      // content, SOUL.md from archetypes) instead of generic OpenClaw defaults.
      // Deferred to after all agents are registered (need full agent list for USER.md).
      

      // Wire up sysadmin routing so worker tools can find the sysadmin agent
      if (agent.role === "sysadmin") {
        toolDeps.sysadminAgentId = agent.id;
        logger.info(`[flock:a2a] sysadmin agent registered: ${agent.id}`);
      }
    }
    logger.info(`[flock] registered ${config.gatewayAgents.length} gateway agent(s): ${config.gatewayAgents.map(a => a.id).join(", ")}`);

    // Sync workspace files for all gateway agents (deferred to here so
    // USER.md can include the full list of co-resident agents).
    const allAgentInfos = config.gatewayAgents.map((a) => {
      let agentRole: FlockAgentRole = a.role ?? "worker";
      if (config.orchestratorIds.includes(a.id)) agentRole = "orchestrator";
      return { id: a.id, role: agentRole, archetype: a.archetype };
    });

    for (const agent of config.gatewayAgents) {
      let agentRole: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) agentRole = "orchestrator";

      try {
        provisioner.syncToOpenClawWorkspace(
          agent.id,
          { role: agentRole, archetype: agent.archetype || undefined },
          allAgentInfos,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`[flock] workspace sync failed for ${agent.id}: ${msg}`);
      }
    }
  } else if (config.gatewayAgents.length > 0) {
    logger.warn(`[flock] gateway agents configured but no gateway token provided`);
  }

  // Expose the A2A server/client via module-level singleton.
  // Other modules (hooks, gateway methods) can import and access these.
  setFlockTransport(a2aServer, a2aClient);

  // --- Work Loop Scheduler ---
  // Initialize agent loop states for all gateway agents.
  // Sysadmin agents start as REACTIVE (no periodic ticks, @mention only).
  // All others start as AWAKE.
  if (config.gatewayAgents.length > 0) {
    for (const agent of config.gatewayAgents) {
      let agentRole: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) agentRole = "orchestrator";
      const initialState = agentRole === "sysadmin" ? "REACTIVE" as const : "AWAKE" as const;
      db.agentLoop.init(agent.id, initialState);
    }
    logger.info(`[flock] initialized loop state for ${config.gatewayAgents.length} agent(s)`);
  }

  // Wire agent loop store and scheduler into tool deps
  toolDeps.agentLoop = db.agentLoop;

  const workLoopScheduler = new WorkLoopScheduler({
    agentLoop: db.agentLoop,
    a2aClient,
    channelMessages: db.channelMessages,
    channelStore: db.channels,
    audit,
    logger,
  });
  toolDeps.workLoopScheduler = workLoopScheduler;

  // Start the work loop scheduler
  workLoopScheduler.start();
  logger.info(`[flock] work loop scheduler started`);

  // --- Bridge hooks (Discord/Slack ↔ Flock channels) ---
  const registerOn = getPluginMethod<(hookName: string, handler: Function, opts?: { priority?: number }) => void>(api, "on");
  if (registerOn) {
    const echoTracker = new EchoTracker();

    // Build sendExternal — Discord uses webhooks for per-agent display names,
    // falls back to OpenClaw runtime send. Slack always uses prefix.
    const runtime = (api as unknown as Record<string, unknown>).runtime as
      | { channel?: { discord?: { sendMessageDiscord?: Function }; slack?: { sendMessageSlack?: Function } } }
      | undefined;
    const sendDiscord = runtime?.channel?.discord?.sendMessageDiscord;
    const sendSlack = runtime?.channel?.slack?.sendMessageSlack;

    const sendExternal = async (
      platform: BridgePlatform,
      externalChannelId: string,
      text: string,
      opts?: { accountId?: string; displayName?: string; webhookUrl?: string },
    ): Promise<void> => {
      if (platform === "discord") {
        if (opts?.webhookUrl) {
          // Send via webhook with per-agent display name
          await sendViaWebhook(opts.webhookUrl, text, opts.displayName);
        } else if (sendDiscord) {
          // Fallback: bot API with prefix
          const prefixed = opts?.displayName ? `**[${opts.displayName}]** ${text}` : text;
          await (sendDiscord as Function)(externalChannelId, prefixed, { verbose: false, accountId: opts?.accountId });
        } else {
          logger.warn(`[flock:bridge] No send function available for platform "discord"`);
        }
      } else if (platform === "slack") {
        // Slack: always prefix with agent name (no display name switching)
        const prefixed = opts?.displayName ? `**[${opts.displayName}]** ${text}` : text;
        if (sendSlack) {
          await (sendSlack as Function)(externalChannelId, prefixed, { accountId: opts?.accountId });
        } else {
          logger.warn(`[flock:bridge] No send function available for platform "slack"`);
        }
      } else {
        logger.warn(`[flock:bridge] No send function available for platform "${platform}"`);
      }
    };

    const bridgeDeps: BridgeDeps = {
      bridgeStore: db.bridges,
      channelStore: db.channels,
      channelMessages: db.channelMessages,
      audit,
      logger,
      sendExternal,
      agentLoop: db.agentLoop,
      scheduler: workLoopScheduler,
    };

    // Make sendExternal available to tools (late-binding — tools run at call time)
    toolDeps.sendExternal = sendExternal;

    // Inbound: external platform message → Flock channel
    registerOn("message_received", (event: InboundEvent, ctx: InboundContext) => {
      try {
        handleInbound(bridgeDeps, echoTracker, event, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[flock:bridge:in] Error handling inbound: ${msg}`);
      }
    }, { priority: 100 });

    // Outbound: flock_channel_post → external platform
    registerOn("after_tool_call", (
      event: { toolName: string; params: Record<string, unknown>; result?: unknown; error?: unknown },
      ctx: { agentId?: string },
    ) => {
      if (event.toolName !== "flock_channel_post" || event.error) return;
      const p = event.params;
      const channelId = String(p.channelId ?? "");
      const message = String(p.message ?? "");
      const agentId = ctx.agentId ?? String(p.agentId ?? "unknown");
      // Extract seq from result — toOCResult puts data in `details`
      const resultObj = event.result as { details?: { seq?: number }; data?: { seq?: number } } | undefined;
      const seq = resultObj?.details?.seq ?? resultObj?.data?.seq;
      void handleOutbound(bridgeDeps, echoTracker, { channelId, message, agentId, seq }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[flock:bridge:out] Error handling outbound: ${msg}`);
      });
    }, { priority: 100 });

    logger.info(`[flock] bridge hooks registered (message_received + after_tool_call)`);

    // Cleanup echo tracker on shutdown
    process.once("beforeExit", () => {
      echoTracker.dispose();
    });
  } else {
    logger.info(`[flock] bridge hooks not available (api.on not found) — bridge relay disabled`);
  }

  // Graceful shutdown (once: true to avoid accumulation on hot reload)
  process.once("beforeExit", () => {
    workLoopScheduler.stop();
    db.close();
  });

  logger.info(`[flock] ready — data: ${config.dataDir}, backend: ${db.backend}, a2a: active, workloop: active`);
}

export default { register };

// --- Module-level transport singleton ---

let _a2aServer: A2AServer | null = null;
let _a2aClient: A2AClient | null = null;

function setFlockTransport(server: A2AServer, client: A2AClient): void {
  _a2aServer = server;
  _a2aClient = client;
}

/** Get the Flock A2A server (available after plugin registration). */
export function getFlockA2AServer(): A2AServer | null {
  return _a2aServer;
}

/** Get the Flock A2A client (available after plugin registration). */
export function getFlockA2AClient(): A2AClient | null {
  return _a2aClient;
}
