import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";
import { startFlockHttpServer, stopFlockHttpServer, readJsonBody } from "../src/server.js";
import type { PluginLogger } from "../src/types.js";

const silentLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    await stopFlockHttpServer(server);
    server = null;
  }
});

/** Helper to make HTTP requests to the test server. */
async function request(
  port: number,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const method = opts?.method ?? "GET";
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: bodyStr,
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe("FlockHttpServer", () => {
  it("starts and handles requests", async () => {
    server = startFlockHttpServer(
      async (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return true;
      },
      { port: 0, logger: silentLogger },
    );

    // Wait for listen
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");
    const port = addr.port;

    const res = await request(port, "/test");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 404 for unhandled routes", async () => {
    server = startFlockHttpServer(
      async () => false, // never handles
      { port: 0, logger: silentLogger },
    );
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");

    const res = await request(addr.port, "/nope");
    expect(res.status).toBe(404);
  });

  it("returns 500 on handler error", async () => {
    server = startFlockHttpServer(
      async () => { throw new Error("boom"); },
      { port: 0, logger: silentLogger },
    );
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("unexpected address");

    const res = await request(addr.port, "/error");
    expect(res.status).toBe(500);
  });

  it("stopFlockHttpServer closes the server", async () => {
    server = startFlockHttpServer(
      async () => false,
      { port: 0, logger: silentLogger },
    );
    await new Promise<void>((resolve) => server!.once("listening", resolve));

    await stopFlockHttpServer(server);
    const addr = server.address();
    // After close, address() returns null
    expect(addr).toBeNull();
    server = null; // prevent afterEach from double-closing
  });
});

describe("readJsonBody", () => {
  it("returns pre-parsed body if present", async () => {
    const fakeReq = { body: { already: "parsed" } } as any;
    const result = await readJsonBody(fakeReq);
    expect(result).toEqual({ already: "parsed" });
  });
});
