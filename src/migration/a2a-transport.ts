/**
 * A2A-based migration transport.
 *
 * Routes migration operations through the A2A handler layer.
 * Uses a dispatch function that can be:
 * - Direct handler calls (in-process, for tests and same-node)
 * - HTTP requests (for real multi-node deployment)
 */

import { basename } from "node:path";
import type { PluginLogger } from "../types.js";
import type { MigrationTransport } from "./orchestrator.js";
import type { VerificationResult } from "./types.js";
import type { RehydrateResult } from "./rehydrate.js";
import type { JsonRpcSuccessResponse, MigrationHandlerContext, MigrationHandlerMap } from "./handlers.js";
import type { NodeRegistry } from "../nodes/registry.js";

/** Response from a handler dispatch call. */
export interface DispatchResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Dispatch function type — routes a method call to the correct node's handler.
 *
 * For in-process: looks up the handler in a Map and calls it directly.
 * For HTTP: makes an HTTP request to the target node's A2A endpoint.
 */
export type HandlerDispatch = (
  targetNodeId: string,
  method: string,
  params: Record<string, unknown>,
) => Promise<DispatchResponse>;

/**
 * Create an in-process handler dispatch for testing/same-node scenarios.
 * Routes calls to the target node's handler map directly.
 */
export function createLocalDispatch(
  nodeHandlers: Map<string, { handlers: MigrationHandlerMap; context: MigrationHandlerContext }>,
): HandlerDispatch {
  return async (targetNodeId, method, params) => {
    const node = nodeHandlers.get(targetNodeId);
    if (!node) {
      return { error: { code: -32001, message: `Unknown node: ${targetNodeId}` } };
    }
    const handler = node.handlers.get(method);
    if (!handler) {
      return { error: { code: -32601, message: `Method not found: ${method}` } };
    }
    const response = await handler(params, node.context);
    if ("error" in response) {
      return { error: response.error };
    }
    return { result: (response as JsonRpcSuccessResponse).result };
  };
}

/**
 * Create an HTTP-based handler dispatch for multi-node scenarios.
 * Routes migration method calls to remote nodes via HTTP POST to their A2A endpoints.
 *
 * The A2AServer on the target node intercepts migration/* methods before agent routing,
 * so the agentId in the URL doesn't matter — we use "migration" as a convention.
 */
export function createHttpDispatch(
  nodeRegistry: NodeRegistry,
  logger: PluginLogger,
): HandlerDispatch {
  return async (targetNodeId, method, params) => {
    const node = nodeRegistry.get(targetNodeId);
    if (!node) {
      return { error: { code: -32001, message: `Unknown target node: ${targetNodeId}` } };
    }

    // A2A endpoint is like "http://host:port/flock"
    // Migration methods are handled by A2AServer.handleRequest regardless of agentId
    const url = `${node.a2aEndpoint}/a2a/migration`;
    const requestId = `mig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    logger.info(`[flock:migration:http-dispatch] ${method} → ${url}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id: requestId,
        }),
      });

      if (!response.ok) {
        return { error: { code: -32000, message: `HTTP ${response.status}: ${response.statusText}` } };
      }

      const body = await response.json() as Record<string, unknown>;
      if (body.error) {
        return { error: body.error as { code: number; message: string } };
      }
      return { result: body.result as Record<string, unknown> };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[flock:migration:http-dispatch] Failed: ${msg}`);
      return { error: { code: -32000, message: `HTTP dispatch failed: ${msg}` } };
    }
  };
}

/**
 * Create an A2A transport that routes through the handler dispatch layer.
 */
export function createA2ATransport(dispatch: HandlerDispatch, logger: PluginLogger): MigrationTransport {
  return {
    async notifyRequest(params) {
      const response = await dispatch(params.targetNodeId, "migration/request", {
        migrationId: params.migrationId,
        agentId: params.agentId,
        sourceNodeId: params.sourceNodeId,
        targetNodeId: params.targetNodeId,
        reason: params.reason,
        sourceEndpoint: params.sourceEndpoint,
      });
      if (response.error) {
        return { accepted: false, error: response.error.message };
      }
      return { accepted: true };
    },

    async transferAndVerify(params) {
      logger.info(`[flock:migration:transport] Transferring ${params.archiveBuffer.length} bytes to ${params.targetNodeId}`);
      const response = await dispatch(params.targetNodeId, "migration/transfer-and-verify", {
        migrationId: params.migrationId,
        archiveBase64: params.archiveBuffer.toString("base64"),
        checksum: params.checksum,
      });
      if (response.error) {
        return {
          verified: false,
          failureReason: "ARCHIVE_CORRUPT" as const,
          verifiedAt: Date.now(),
        };
      }
      // The handler returns VerificationResult fields in result
      const r = response.result!;
      return {
        verified: r.verified as boolean,
        failureReason: r.failureReason as VerificationResult["failureReason"],
        computedChecksum: r.computedChecksum as string | undefined,
        verifiedAt: r.verifiedAt as number,
      };
    },

    async rehydrate(params) {
      logger.info(`[flock:migration:transport] Rehydrating on ${params.targetNodeId}`);
      const { payload } = params;
      // Derive agentId from agentIdentity if available, else from targetHomePath basename
      const agentId = payload.agentIdentity?.agentId ?? basename(params.targetHomePath);
      const response = await dispatch(params.targetNodeId, "migration/rehydrate", {
        migrationId: params.migrationId,
        agentId,
        archiveBase64: payload.portable.archive.toString("base64"),
        checksum: payload.portable.checksum,
        sizeBytes: payload.portable.sizeBytes,
        agentIdentity: payload.agentIdentity,
        workState: payload.workState,
      });
      if (response.error) {
        return {
          success: false,
          homePath: params.targetHomePath,
          error: {
            code: 6001,
            message: response.error.message,
            phase: "REHYDRATING" as const,
            origin: "target" as const,
            recovery: { type: "auto_rollback" as const },
          },
          warnings: [],
          completedAt: Date.now(),
        };
      }
      const r = response.result!;
      return {
        success: r.success as boolean,
        homePath: r.homePath as string,
        error: r.error as RehydrateResult["error"],
        warnings: (r.warnings as string[]) ?? [],
        completedAt: r.completedAt as number,
      };
    },
  };
}
