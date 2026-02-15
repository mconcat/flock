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
import { mkdirSync, writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
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
import { createFlockExecutor, type SessionSendFn } from "./transport/executor.js";
import { createDirectSend } from "./transport/direct-send.js";
import type { FlockAgentRole } from "./transport/types.js";
import { createTriageDecisionTool } from "./sysadmin/triage-tool.js";
import { WorkLoopScheduler } from "./loop/scheduler.js";
import { NodeRegistry } from "./nodes/registry.js";
import { SessionManager } from "./session/manager.js";
import { startFlockHttpServer, stopFlockHttpServer, readJsonBody } from "./server.js";
import { assembleAgentsMd, loadSoulTemplate, loadTemplate } from "./prompts/assembler.js";
import { createFlockTools, type ToolDeps } from "./tools/index.js";
import { createWorkspaceTools } from "./tools/workspace.js";
import { createNodesTool } from "./nodes/tools.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
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
import { createApiKeyResolver } from "./auth/resolver.js";

// Re-export for external use
export { SessionManager } from "./session/manager.js";
export { createDirectSend } from "./transport/direct-send.js";
export { createFlockLogger } from "./logger.js";
export { loadFlockConfig, resolveFlockConfig } from "./config.js";
export { createApiKeyResolver } from "./auth/resolver.js";
export * from "./auth/index.js";

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
  /** Tool dependencies (for building tools outside the boot path). */
  toolDeps: ToolDeps;
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
  /** Override work loop tick interval (ms). Default: 60_000. Useful for tests. */
  tickIntervalMs?: number;
  /** Override slow-tick interval for SLEEP agents (ms). Default: 300_000. Useful for tests. */
  slowTickIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Per-agent workspace management
// ---------------------------------------------------------------------------

/** Workspace files: immutable (always overwritten) vs mutable (seed once). */
const IMMUTABLE_FILES = ["AGENTS.md", "TOOLS.md"] as const;
const MUTABLE_FILES = ["SOUL.md", "IDENTITY.md", "MEMORY.md", "USER.md", "HEARTBEAT.md"] as const;

interface AgentWorkspaceOpts {
  agentId: string;
  role: FlockAgentRole;
  archetype?: string;
  nodeId: string;
  dataDir: string;
}

/**
 * Resolve the workspace directory for an agent.
 */
function agentWorkspaceDir(dataDir: string, agentId: string): string {
  return join(dataDir, "agents", agentId);
}

/**
 * Seed an agent's workspace with template files.
 *
 * - Immutable files (AGENTS.md, TOOLS.md) are always overwritten from templates.
 * - Mutable files (SOUL.md, IDENTITY.md, MEMORY.md, USER.md, HEARTBEAT.md)
 *   are only written if they don't already exist — agents own these files.
 */
function seedAgentWorkspace(opts: AgentWorkspaceOpts, logger: PluginLogger): string {
  const wsDir = agentWorkspaceDir(opts.dataDir, opts.agentId);
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(join(wsDir, "memory"), { recursive: true });

  // --- Immutable: AGENTS.md ---
  const agentsMd = assembleAgentsMd(opts.role);
  writeFileSync(join(wsDir, "AGENTS.md"), agentsMd, "utf-8");

  // --- Immutable: TOOLS.md ---
  const toolsTemplate = loadTemplate("TOOLS") ?? "";
  const toolsMd = toolsTemplate
    .replace(/\{\{NODE_ID\}\}/g, opts.nodeId)
    .replace(/\{\{NODE_SPECS\}\}/g, `${os.cpus().length} CPU, ${Math.round(os.totalmem() / 1e9)}GB RAM`);
  writeFileSync(join(wsDir, "TOOLS.md"), toolsMd, "utf-8");

  // --- Mutable: SOUL.md (from archetype template) ---
  seedIfMissing(wsDir, "SOUL.md", () => {
    return opts.archetype ? loadSoulTemplate(opts.archetype) ?? "" : "";
  });

  // --- Mutable: IDENTITY.md ---
  seedIfMissing(wsDir, "IDENTITY.md", () => {
    const tpl = loadTemplate("IDENTITY") ?? "";
    return tpl
      .replace(/\{\{AGENT_ID\}\}/g, opts.agentId)
      .replace(/\{\{AGENT_NAME\}\}/g, opts.agentId)
      .replace(/\{\{ARCHETYPE\}\}/g, opts.archetype ?? "(none)")
      .replace(/\{\{NODE_ID\}\}/g, opts.nodeId)
      .replace(/\{\{CREATED_AT\}\}/g, new Date().toISOString());
  });

  // --- Mutable: MEMORY.md ---
  seedIfMissing(wsDir, "MEMORY.md", () => loadTemplate("MEMORY") ?? "# MEMORY.md\n");

  // --- Mutable: USER.md ---
  seedIfMissing(wsDir, "USER.md", () => {
    const tpl = loadTemplate("USER") ?? "";
    return tpl
      .replace(/\{\{FLOCK_VERSION\}\}/g, "0.3.0")
      .replace(/\{\{ORCHESTRATOR_NODE\}\}/g, opts.nodeId)
      .replace(/\{\{USER_TIMEZONE\}\}/g, Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  // --- Mutable: HEARTBEAT.md ---
  seedIfMissing(wsDir, "HEARTBEAT.md", () => loadTemplate("HEARTBEAT") ?? "");

  logger.debug?.(`[flock:workspace] seeded workspace for "${opts.agentId}" at ${wsDir}`);
  return wsDir;
}

function seedIfMissing(dir: string, filename: string, content: () => string): void {
  const filePath = join(dir, filename);
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content(), "utf-8");
  }
}

/**
 * Read all workspace files and assemble the full system prompt.
 *
 * Order follows OpenClaw convention:
 *   AGENTS.md → SOUL.md → IDENTITY.md → USER.md → TOOLS.md → MEMORY.md → HEARTBEAT.md
 */
function assembleSystemPrompt(wsDir: string): string {
  const sections: string[] = [];

  for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"]) {
    const filePath = join(wsDir, name);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        sections.push(`# ${name}\n\n${content}`);
      }
    }
  }

  return sections.join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Tool caller ID injection
// ---------------------------------------------------------------------------

/**
 * Wrap tools to inject `_callerAgentId` into every tool call's params.
 *
 * Many Flock tools (channel_create, channel_post, sysadmin_request, etc.)
 * read `_callerAgentId` from params to identify which agent made the call.
 * In standalone mode, tools are shared across agents — this wrapper binds
 * them to a specific caller so attribution and permissions work correctly.
 *
 * This is the standalone equivalent of the deleted `wrapToolWithAgentId()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool<any> for heterogeneous arrays
function wrapToolsWithCallerId(tools: AgentTool<any>[], agentId: string, logger?: PluginLogger): AgentTool<any>[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId: string, params: Record<string, unknown>) {
      logger?.debug?.(`[flock:tool-call] ${agentId} → ${tool.name}(${JSON.stringify(params).slice(0, 500)})`);
      const result = await tool.execute(toolCallId, { ...params, _callerAgentId: agentId });
      logger?.debug?.(`[flock:tool-call] ${agentId} ← ${tool.name}: ${JSON.stringify((result as Record<string, unknown>).details).slice(0, 300)}`);
      return result;
    },
  }));
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

  // --- Auth resolver ---
  const getApiKey = createApiKeyResolver({ logger });

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
  // --- Work Loop Scheduler ---
  const scheduler = new WorkLoopScheduler({
    agentLoop: db.agentLoop,
    a2aClient,
    channelMessages: db.channelMessages,
    channelStore: db.channels,
    audit,
    logger,
    tickIntervalMs: opts?.tickIntervalMs,
    slowTickIntervalMs: opts?.slowTickIntervalMs,
  });

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
    workLoopScheduler: scheduler,
  };

  // --- Register gateway agents ---
  if (config.gatewayAgents.length > 0 && config.gateway.token) {
    // Late-binding: sessionSend is captured by closure in resolveAgentConfig.
    // It will be assigned before the first call (resolveAgentConfig is only
    // invoked when an agent message arrives, not during boot).
    let sessionSend: SessionSendFn;

    // Seed per-agent workspaces (creates dirs + initial files)
    const agentWorkspaces = new Map<string, string>();
    for (const agent of config.gatewayAgents) {
      let role: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) role = "orchestrator";
      const wsDir = seedAgentWorkspace({
        agentId: agent.id,
        role,
        archetype: agent.archetype,
        nodeId,
        dataDir: config.dataDir,
      }, logger);
      agentWorkspaces.set(agent.id, wsDir);
    }

    const resolveAgentConfig = (agentId: string) => {
      const agentDef = config.gatewayAgents.find((a) => a.id === agentId);
      let role: FlockAgentRole = agentDef?.role ?? "worker";
      if (config.orchestratorIds.includes(agentId)) role = "orchestrator";

      // Assemble system prompt from per-agent workspace files.
      // Immutable files (AGENTS.md, TOOLS.md) are regenerated each boot.
      // Mutable files (SOUL.md, MEMORY.md, etc.) are read from disk — agents own them.
      const wsDir = agentWorkspaces.get(agentId);
      const systemPrompt = wsDir
        ? assembleSystemPrompt(wsDir)
        : assembleAgentsMd(role); // fallback for dynamically created agents

      // Build tools for this agent:
      //   1. Flock standard tools (channels, discovery, tasks, messaging, etc.)
      //   2. Workspace tools (vault file read/write — when vaultsBasePath configured)
      //   3. Nodes tool (node discovery)
      //   4. Lifecycle tools (agent create/decommission/restart)
      //   5. Triage decision tool
      const flockTools = createFlockTools(toolDeps);
      const workspaceTools = toolDeps.vaultsBasePath
        ? createWorkspaceTools({ ...toolDeps, vaultsBasePath: toolDeps.vaultsBasePath })
        : [];
      const nodesTool = createNodesTool({ nodeRegistry, logger });
      const lifecycleTools = [
        createStandaloneCreateAgentTool(toolDeps, sessionSend),
        createStandaloneDecommissionAgentTool(toolDeps),
        createStandaloneRestartTool(toolDeps),
      ];
      const allTools = [
        ...flockTools,
        ...workspaceTools,
        nodesTool,
        ...lifecycleTools,
        createTriageDecisionTool(),
      ];

      // Inject _callerAgentId into all tool calls so tools know which
      // agent is invoking them (for channel attribution, permissions, etc.)
      const tools = wrapToolsWithCallerId(allTools, agentId, logger);

      // Model: per-agent config → fallback to default
      const model = agentDef?.model ?? "anthropic/claude-sonnet-4-20250514";

      return { model, systemPrompt, tools, getApiKey };
    };

    sessionSend = createDirectSend({
      sessionManager,
      resolveAgentConfig,
      logger,
    });

    for (const agent of config.gatewayAgents) {
      let role: FlockAgentRole = agent.role ?? "worker";
      if (config.orchestratorIds.includes(agent.id)) role = "orchestrator";

      const endpointUrl = `${baseUrl}/a2a/${agent.id}`;
      const archetypeContent = agent.archetype ? loadSoulTemplate(agent.archetype) : null;
      const { card, meta } = role === "orchestrator"
        ? createOrchestratorCard(nodeId, endpointUrl, agent.id)
        : role === "sysadmin"
          ? createSysadminCard(nodeId, endpointUrl, agent.id)
          : createWorkerCard(
              agent.id, nodeId, endpointUrl,
              [], // skills — extracted from archetype if available
              agent.archetype,
              archetypeContent ?? undefined,
            );

      const executor = createFlockExecutor({
        flockMeta: meta,
        sessionSend,
        audit,
        taskStore: db.tasks,
        logger,
      });

      a2aServer.registerAgent(agent.id, card, meta, executor);

      // Initialize agent loop state
      const initialState = (role === "sysadmin" || role === "orchestrator") ? "REACTIVE" as const : "AWAKE" as const;
      db.agentLoop.init(agent.id, initialState);
    }

    logger.info(`[flock:standalone] registered ${config.gatewayAgents.length} agent(s): ${config.gatewayAgents.map((a) => a.id).join(", ")}`);

    // Start the work loop scheduler — ticks AWAKE agents periodically
    scheduler.start();
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

  // --- PID file ---
  const pidPath = opts?.config ? undefined : join(config.dataDir, "flock.pid");
  if (pidPath) {
    try {
      mkdirSync(dirname(pidPath), { recursive: true });
      writeFileSync(pidPath, String(process.pid), "utf-8");
    } catch (e) {
      logger.warn(`[flock:standalone] failed to write PID file: ${e}`);
    }
  }

  // --- Shutdown ---
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("[flock:standalone] shutting down...");
    scheduler.stop();
    echoTracker?.dispose();
    sessionManager.destroyAll();
    if (httpServer) {
      await stopFlockHttpServer(httpServer);
    }
    try { db.close(); } catch (e) { logger.warn(`[flock:standalone] db close error: ${e}`); }
    if (pidPath) {
      try { unlinkSync(pidPath); } catch { /* already gone */ }
    }
    logger.info("[flock:standalone] shutdown complete");
  };

  // --- Signal handling ---
  const onSignal = () => { void stop().then(() => process.exit(0)); };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  return {
    config,
    sessionManager,
    httpServer,
    a2aServer,
    bridgeDeps,
    logger,
    toolDeps,
    stop,
  };
}
