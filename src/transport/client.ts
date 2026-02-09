/**
 * Flock A2A Client
 *
 * Sends A2A messages to other Flock agents.
 * Routing is topology-agnostic: a `resolve` function decides
 * local vs remote delivery. Swap the function to change topology.
 *
 * Factory function pattern matching createHomeManager, createAuditLog, etc.
 */

import type { AgentCard, Task, Message, MessageSendParams } from "@a2a-js/sdk";
import type { A2AServer } from "./server.js";
import type { FlockTaskMetadata } from "./types.js";
import type { PluginLogger } from "../types.js";
import type { ResolveAgent, ResolveSysadmin } from "./routing.js";
import { userMessage, dataPart, extractText, extractTaskText } from "./a2a-helpers.js";

export interface A2AClientConfig {
  /** Local A2A server (for same-node shortcut). */
  localServer?: A2AServer;
  /** Topology-agnostic resolver. If not provided, everything is local. */
  resolve?: ResolveAgent;
  /** Optional sysadmin resolver. Used in central topology where sysadmin is remote. */
  resolveSysadmin?: ResolveSysadmin;
  /** Logger. */
  logger: PluginLogger;
  /** Default timeout for remote requests (ms). */
  defaultTimeoutMs?: number;
}

export interface A2AClient {
  /** Send a text message to an agent and return the completed task. */
  sendMessage(
    targetAgentId: string,
    text: string,
    metadata?: FlockTaskMetadata,
  ): Promise<A2AClientResult>;

  /** Send a sysadmin request. Convenience wrapper with triage metadata. */
  sendSysadminRequest(
    sysadminAgentId: string,
    request: string,
    options?: {
      urgency?: "low" | "normal" | "high";
      project?: string;
      fromHome?: string;
      context?: string;
    },
  ): Promise<A2AClientResult>;

  /** Get an agent's card from the local registry. */
  getAgentCard(agentId: string): AgentCard | null;

  /** List all known agents. */
  listAgents(): Array<{ agentId: string; card: AgentCard }>;

  /**
   * Send pre-built A2A MessageSendParams to an agent.
   * Use when the caller already constructed the params.
   */
  sendA2A(
    targetAgentId: string,
    params: MessageSendParams,
  ): Promise<A2AClientResult>;
}

export interface A2AClientResult {
  taskId: string;
  state: string;
  response: string;
  artifacts: Array<{ name?: string; parts: unknown[] }>;
  raw: Task | Message;
}

/**
 * Create an A2A client.
 *
 * @param config - Client configuration with optional resolver
 * @returns A2AClient interface
 */
export function createA2AClient(config: A2AClientConfig): A2AClient {
  const { localServer, resolve, resolveSysadmin, logger, defaultTimeoutMs = 120_000 } = config;

  // --- Internal helpers ---

  async function send(
    targetAgentId: string,
    params: MessageSendParams,
  ): Promise<A2AClientResult> {
    // 1. If we have a resolver, use it to determine local vs remote
    if (resolve) {
      const route = await resolve(targetAgentId);
      if (!route.local) {
        return sendRemote(route.endpoint, targetAgentId, params);
      }
      // Route is local — fall through to sendLocal
    }

    // 2. Send locally
    if (localServer) {
      return sendLocal(targetAgentId, params);
    }

    throw new Error(
      `No local server configured. Cannot reach agent: ${targetAgentId}`,
    );
  }

  async function sendLocal(
    targetAgentId: string,
    params: MessageSendParams,
  ): Promise<A2AClientResult> {
    const server = localServer!;

    const jsonRpcRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params,
      id: `flock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    logger.debug?.(
      `[flock:client] Sending to ${targetAgentId}`,
    );

    const { status, body } = await server.handleRequest(targetAgentId, jsonRpcRequest);
    return parseResponse(body, status);
  }

  async function sendRemote(
    endpoint: string,
    targetAgentId: string,
    params: MessageSendParams,
  ): Promise<A2AClientResult> {
    const url = `${endpoint}/a2a/${targetAgentId}`;
    const jsonRpcRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params,
      id: `flock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    logger.debug?.(
      `[flock:client] Sending remote to ${targetAgentId} at ${url}`,
    );

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonRpcRequest),
      signal: AbortSignal.timeout(defaultTimeoutMs),
    });

    const body: unknown = await res.json();
    return parseResponse(body, res.status);
  }

  // --- Public interface ---

  async function sendMessage(
    targetAgentId: string,
    text: string,
    metadata?: FlockTaskMetadata,
  ): Promise<A2AClientResult> {
    const msg = metadata
      ? userMessage(text, [dataPart(metadata)])
      : userMessage(text);

    return send(targetAgentId, { message: msg });
  }

  async function sendSysadminRequest(
    sysadminAgentId: string,
    request: string,
    options?: {
      urgency?: "low" | "normal" | "high";
      project?: string;
      fromHome?: string;
      context?: string;
    },
  ): Promise<A2AClientResult> {
    const fullRequest = options?.context
      ? `${request}\n\nContext: ${options.context}`
      : request;

    const metadata: FlockTaskMetadata = {
      flockType: "sysadmin-request",
      urgency: options?.urgency ?? "normal",
      project: options?.project,
      fromHome: options?.fromHome,
    };

    const fromAgent = options?.fromHome ?? "unknown";
    const msg = userMessage(fullRequest, [dataPart({
      ...metadata,
      sessionRouting: { chatType: "request", peerId: fromAgent },
    })]);
    const params: MessageSendParams = { message: msg };

    // If we have a sysadmin resolver and a requesting agent, use it to
    // determine the correct sysadmin endpoint (central topology).
    if (resolveSysadmin && options?.fromHome) {
      const route = await resolveSysadmin(options.fromHome);
      if (!route.local) {
        return sendRemote(route.endpoint, sysadminAgentId, params);
      }
    }

    return send(sysadminAgentId, params);
  }

  function getAgentCard(agentId: string): AgentCard | null {
    return localServer?.getAgentCard(agentId) ?? null;
  }

  function listAgents(): Array<{ agentId: string; card: AgentCard }> {
    return localServer?.listAgentCards() ?? [];
  }

  async function sendA2A(
    targetAgentId: string,
    params: MessageSendParams,
  ): Promise<A2AClientResult> {
    return send(targetAgentId, params);
  }

  return { sendMessage, sendSysadminRequest, getAgentCard, listAgents, sendA2A };
}

// --- Type guards and runtime validators ---

/** Parse a JSON-RPC response body into an A2AClientResult. */
function parseResponse(body: unknown, httpStatus: number): A2AClientResult {
  if (httpStatus !== 200) {
    const errMsg = extractJsonRpcError(body) ?? JSON.stringify(body);
    throw new Error(`A2A request failed (${httpStatus}): ${errMsg}`);
  }

  const rpcError = extractJsonRpcError(body);
  if (rpcError) {
    throw new Error(`A2A RPC error: ${rpcError}`);
  }

  const result = extractJsonRpcResult(body);
  if (!result) {
    throw new Error("A2A response missing result");
  }

  if (isA2ATask(result)) {
    return {
      taskId: result.id,
      state: result.status.state,
      response: extractTaskText(result),
      artifacts: result.artifacts ?? [],
      raw: result,
    };
  }

  if (isA2AMessage(result)) {
    const text = extractText(result);
    return {
      taskId: "",
      state: "completed",
      response: text,
      artifacts: [],
      raw: result,
    };
  }

  throw new Error(
    `Unexpected A2A response shape: ${JSON.stringify(result).slice(0, 200)}`,
  );
}

/** Check if an unknown value is an A2A Task. */
function isA2ATask(v: unknown): v is Task {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    obj.kind === "task" &&
    typeof obj.id === "string" &&
    typeof obj.contextId === "string" &&
    typeof obj.status === "object" && obj.status !== null
  );
}

/** Check if an unknown value is an A2A Message. */
function isA2AMessage(v: unknown): v is Message {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    obj.kind === "message" &&
    typeof obj.messageId === "string" &&
    typeof obj.role === "string" &&
    Array.isArray(obj.parts)
  );
}

/** Safely extract a JSON-RPC error string from an unknown response body. */
function extractJsonRpcError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.error !== "object" || obj.error === null) return null;
  const err = obj.error as Record<string, unknown>;
  const code = typeof err.code === "number" ? err.code : -1;
  const msg = typeof err.message === "string" ? err.message : "Unknown error";
  return `[${code}] ${msg}`;
}

/** Safely extract the result field from a JSON-RPC response. */
function extractJsonRpcResult(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return null;
  return (body as Record<string, unknown>).result ?? null;
}
