/**
 * Flock A2A Server
 *
 * Mounts an A2A-compliant HTTP endpoint on the Clawdbot plugin's
 * HTTP routing system. Handles JSON-RPC 2.0 requests for agent
 * communication within the same node.
 *
 * Endpoints:
 *   POST /flock/a2a/{agentId}                    — JSON-RPC
 *   GET  /flock/.well-known/agent-card.json       — Agent directory
 *   GET  /flock/a2a/{agentId}/agent-card.json     — Per-agent card
 */

import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
  type AgentExecutor,
  type TaskStore,
} from "@a2a-js/sdk/server";
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import type { AgentCard } from "@a2a-js/sdk";
import type { PluginLogger } from "../types.js";
import type { FlockCardMetadata } from "./types.js";
import { CardRegistry } from "./agent-card.js";
import type { MigrationHandlerContext, MigrationHandlerMap } from "../migration/handlers.js";
import { createMigrationHandlers } from "../migration/handlers.js";

export interface A2AServerConfig {
  basePath: string;
  logger: PluginLogger;
  /** Optional migration handler context for migration/* methods */
  migrationContext?: MigrationHandlerContext;
}

interface AgentHandler {
  agentCard: AgentCard;
  meta: FlockCardMetadata;
  executor: AgentExecutor;
  taskStore: TaskStore;
  requestHandler: DefaultRequestHandler;
  transportHandler: JsonRpcTransportHandler;
}

/**
 * The A2A server manages per-agent request handlers and routes
 * incoming JSON-RPC requests to the correct agent.
 */
export class A2AServer {
  private agents = new Map<string, AgentHandler>();
  private migrationHandlers: MigrationHandlerMap | null = null;
  private readonly config: A2AServerConfig;
  readonly cardRegistry: CardRegistry;

  constructor(config: A2AServerConfig) {
    this.config = config;
    this.cardRegistry = new CardRegistry();
    
    // Initialize migration handlers if context provided
    if (config.migrationContext) {
      this.migrationHandlers = createMigrationHandlers(config.migrationContext);
      this.config.logger.info(`[flock:a2a] Migration handlers registered: ${Array.from(this.migrationHandlers.keys()).join(', ')}`);
    }
  }

  /**
   * Register an agent with the A2A server.
   */
  registerAgent(
    agentId: string,
    agentCard: AgentCard,
    meta: FlockCardMetadata,
    executor: AgentExecutor,
  ): void {
    if (this.agents.has(agentId)) {
      this.config.logger.warn(`[flock:a2a] Agent ${agentId} already registered, replacing`);
    }

    const taskStore = new InMemoryTaskStore();
    const eventBusManager = new DefaultExecutionEventBusManager();
    const requestHandler = new DefaultRequestHandler(
      agentCard,
      taskStore,
      executor,
      eventBusManager,
    );
    const transportHandler = new JsonRpcTransportHandler(requestHandler);

    this.agents.set(agentId, {
      agentCard,
      meta,
      executor,
      taskStore,
      requestHandler,
      transportHandler,
    });
    this.cardRegistry.register(agentId, agentCard, meta);

    this.config.logger.info(`[flock:a2a] Registered agent: ${agentId} (${meta.role})`);
  }

  /**
   * Unregister an agent.
   */
  unregisterAgent(agentId: string): boolean {
    this.cardRegistry.remove(agentId);
    return this.agents.delete(agentId);
  }

  /**
   * Handle an incoming JSON-RPC request for a specific agent.
   */
  async handleRequest(
    agentId: string,
    requestBody: unknown,
  ): Promise<{ status: number; body: unknown }> {
    // Check if this is a migration request (migration/* methods)
    if (this.migrationHandlers && typeof requestBody === "object" && requestBody !== null) {
      const request = requestBody as Record<string, unknown>;
      const method = request.method;
      if (typeof method === "string" && method.startsWith("migration/")) {
        try {
          const handler = this.migrationHandlers.get(method);
          if (handler) {
            const rpcParams = (typeof request.params === "object" && request.params !== null)
              ? request.params as Record<string, unknown>
              : {};
            const params = { ...rpcParams, _id: request.id };
            const result = await handler(params, this.config.migrationContext!);
            return { status: 200, body: result };
          }
          // Fall through to agent handler if no migration handler found
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.config.logger.error(`[flock:a2a] Migration handler error: ${msg}`);
          return {
            status: 500,
            body: {
              jsonrpc: "2.0",
              error: { code: -32603, message: msg },
              id: request.id || null,
            },
          };
        }
      }
    }

    // Route to agent handler
    const handler = this.agents.get(agentId);
    if (!handler) {
      return {
        status: 404,
        body: {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Agent not found: ${agentId}` },
          id: null,
        },
      };
    }

    try {
      const result = await handler.transportHandler.handle(requestBody);

      // Handle streaming (AsyncGenerator) — collect all for Phase 1
      if (result && typeof result === "object" && Symbol.asyncIterator in result) {
        const events: unknown[] = [];
        for await (const event of result as AsyncGenerator) {
          events.push(event);
        }
        return { status: 200, body: events[events.length - 1] ?? null };
      }

      return { status: 200, body: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.config.logger.error(`[flock:a2a] Error for ${agentId}: ${msg}`);
      return {
        status: 500,
        body: {
          jsonrpc: "2.0",
          error: { code: -32603, message: msg },
          id: null,
        },
      };
    }
  }

  /**
   * Check whether an agent is registered locally.
   */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /**
   * Get an agent's card.
   */
  getAgentCard(agentId: string): AgentCard | null {
    return this.cardRegistry.get(agentId);
  }

  /**
   * Get an agent's Flock metadata.
   */
  getAgentMeta(agentId: string): FlockCardMetadata | null {
    return this.cardRegistry.getMeta(agentId);
  }

  /**
   * List all registered agent cards.
   */
  listAgentCards(): Array<{ agentId: string; card: AgentCard }> {
    return this.cardRegistry.list().map((e) => ({
      agentId: e.agentId,
      card: e.card,
    }));
  }

  /**
   * Build HTTP route handlers for Clawdbot plugin registration.
   */
  buildRouteHandlers(): Map<string, RouteHandler> {
    const routes = new Map<string, RouteHandler>();
    const basePath = this.config.basePath;

    // POST /flock/a2a/:agentId — JSON-RPC endpoint
    routes.set(`POST ${basePath}/a2a/:agentId`, async (req) => {
      const agentId = req.params.agentId;
      if (!agentId) {
        return { status: 400, body: { error: "Missing agentId" } };
      }
      return this.handleRequest(agentId, req.body);
    });

    // GET /flock/.well-known/agent-card.json — Directory
    routes.set(`GET ${basePath}/.well-known/agent-card.json`, async () => {
      const agents = this.listAgentCards();
      return {
        status: 200,
        body: {
          agents: agents.map((a) => ({
            id: a.agentId,
            ...a.card,
          })),
        },
      };
    });

    // GET /flock/a2a/:agentId/agent-card.json — Per-agent card
    routes.set(`GET ${basePath}/a2a/:agentId/agent-card.json`, async (req) => {
      const agentId = req.params.agentId;
      const card = this.getAgentCard(agentId ?? "");
      if (!card) {
        return { status: 404, body: { error: `Agent not found: ${agentId}` } };
      }
      return { status: 200, body: card };
    });

    return routes;
  }
}

/** Simple route handler interface. */
export interface RouteHandler {
  (req: RouteRequest): Promise<{ status: number; body: unknown }>;
}

export interface RouteRequest {
  params: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string>;
}
