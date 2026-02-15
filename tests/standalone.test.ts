import { describe, it, expect, afterEach } from "vitest";
import { startFlock, type FlockInstance } from "../src/standalone.js";
import { resolveFlockConfig } from "../src/config.js";

let instance: FlockInstance | null = null;

afterEach(async () => {
  if (instance) {
    await instance.stop();
    instance = null;
  }
});

describe("startFlock (standalone)", () => {
  it("boots with default in-memory config", async () => {
    const config = resolveFlockConfig({
      dbBackend: "memory",
      nodeId: "test-node",
    });

    instance = await startFlock({ config, noHttp: true });

    expect(instance.config.dbBackend).toBe("memory");
    expect(instance.config.nodeId).toBe("test-node");
    expect(instance.sessionManager).toBeDefined();
    expect(instance.a2aServer).toBeDefined();
    expect(instance.logger).toBeDefined();
  });

  it("registers gateway agents", async () => {
    const config = resolveFlockConfig({
      dbBackend: "memory",
      nodeId: "test-node",
      gateway: { port: 3779, token: "test-token" },
      gatewayAgents: [
        { id: "dev-code", role: "worker" },
        { id: "qa", role: "worker" },
      ],
    });

    instance = await startFlock({ config, noHttp: true });

    // A2A server should have the agents registered
    expect(instance.a2aServer.hasAgent("dev-code")).toBe(true);
    expect(instance.a2aServer.hasAgent("qa")).toBe(true);
  });

  it("starts HTTP server when not disabled", async () => {
    const config = resolveFlockConfig({
      dbBackend: "memory",
      nodeId: "test-node",
    });

    instance = await startFlock({ config, httpPort: 0 });

    expect(instance.httpServer).toBeDefined();
    // Wait for server to start listening
    await new Promise<void>((resolve) => {
      if (instance!.httpServer!.listening) {
        resolve();
      } else {
        instance!.httpServer!.once("listening", resolve);
      }
    });
    const addr = instance.httpServer!.address();
    expect(addr).not.toBeNull();
  });

  it("skips HTTP server when noHttp is true", async () => {
    const config = resolveFlockConfig({ dbBackend: "memory" });
    instance = await startFlock({ config, noHttp: true });
    expect(instance.httpServer).toBeUndefined();
  });

  it("stop() cleans up resources", async () => {
    const config = resolveFlockConfig({ dbBackend: "memory" });
    instance = await startFlock({ config, noHttp: true });

    await instance.stop();
    // SessionManager should be emptied
    expect(instance.sessionManager.listAgents()).toEqual([]);
    instance = null; // Prevent double-stop in afterEach
  });

  it("creates session manager with direct LLM send", async () => {
    const config = resolveFlockConfig({
      dbBackend: "memory",
      gateway: { port: 3779, token: "test-token" },
      gatewayAgents: [{ id: "agent-1", role: "worker" }],
    });

    instance = await startFlock({ config, noHttp: true });

    // Session manager should be initialized (but no sessions yet —
    // sessions are created lazily on first message)
    expect(instance.sessionManager.listAgents()).toEqual([]);
  });
});
