/**
 * Flock standalone HTTP server.
 *
 * Hosts the A2A endpoints and bridge routes without OpenClaw's registerHttpHandler.
 * In plugin mode, OpenClaw's HTTP server is used instead (via registerHttpHandler).
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { PluginLogger } from "./types.js";

export type FlockHttpHandler = (
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) => Promise<boolean>;

export interface FlockHttpServerOptions {
  port: number;
  host?: string;
  logger: PluginLogger;
}

/**
 * Read and parse JSON body from a Node.js IncomingMessage.
 * If body was already parsed (e.g. by middleware), returns it directly.
 */
export function readJsonBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      resolve(req.body);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/**
 * Create and start a standalone HTTP server for Flock routes.
 *
 * The handler receives the request and returns true if it handled it.
 * Unhandled requests get a 404.
 */
export function startFlockHttpServer(
  handler: FlockHttpHandler,
  opts: FlockHttpServerOptions,
): Server {
  const { port, host = "127.0.0.1", logger } = opts;

  const server = createServer(async (req, res) => {
    try {
      const handled = await handler(req as IncomingMessage & { body?: unknown }, res);
      if (!handled) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[flock:http] unhandled error: ${msg}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  server.listen(port, host, () => {
    logger.info(`[flock:http] server listening on ${host}:${port}`);
  });

  return server;
}

/**
 * Stop the HTTP server gracefully.
 */
export function stopFlockHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
