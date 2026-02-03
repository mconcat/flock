/**
 * Integration test: Plugin registration flow
 *
 * Tests the full register() path with a mock PluginApi.
 * Verifies that all tools are registered, HTTP routes are set up,
 * and the A2A server/client are accessible.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register, getFlockA2AServer, getFlockA2AClient } from "../../src/index.js";
import type { PluginApi, ToolDefinition, PluginLogger } from "../../src/types.js";

const logger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let tmpDir: string;
const registeredTools: Map<string, ToolDefinition> = new Map();
const registeredRoutes: Array<{ path: string }> = [];
let registeredHttpHandler = false;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-plugin-test-"));

  const mockApi: PluginApi = {
    id: "flock-test",
    name: "flock",
    version: "0.2.0",
    description: "test",
    source: tmpDir,
    config: {},
    pluginConfig: {
      dataDir: path.join(tmpDir, "data"),
      dbBackend: "memory",
      homes: {
        rootDir: path.join(tmpDir, "homes"),
        baseDir: path.join(tmpDir, "base"),
      },
    },
    logger,
    registerTool(tool: ToolDefinition | ((ctx: Record<string, unknown>) => ToolDefinition | ToolDefinition[] | null | undefined)) {
      if (typeof tool === "function") {
        const resolved = tool({ agentId: "test-agent" });
        if (resolved) {
          const list = Array.isArray(resolved) ? resolved : [resolved];
          for (const t of list) registeredTools.set(t.name, t);
        }
      } else {
        registeredTools.set(tool.name, tool);
      }
    },
    registerGatewayMethod() {},
    registerHttpRoute(params: { path: string }) {
      registeredRoutes.push(params);
    },
    registerHttpHandler() {
      registeredHttpHandler = true;
    },
  };

  register(mockApi);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Plugin registration", () => {
  it("registers all expected tools", () => {
    const expectedTools = [
      "flock_status",
      "flock_lease",
      "flock_audit",
      "flock_provision",
      "flock_sysadmin_protocol",
      "flock_sysadmin_request",
    ];

    for (const name of expectedTools) {
      expect(registeredTools.has(name), `Missing tool: ${name}`).toBe(true);
    }
  });

  it("registers HTTP handler for A2A", () => {
    // index.ts uses registerHttpHandler (catch-all) instead of registerHttpRoute
    // The handler processes all /flock/* routes internally
    expect(registeredHttpHandler).toBe(true);
  });

  it("A2A server is accessible via singleton", () => {
    const server = getFlockA2AServer();
    expect(server).not.toBeNull();
  });

  it("A2A client is accessible via singleton", () => {
    const client = getFlockA2AClient();
    expect(client).not.toBeNull();
  });

  describe("tool: flock_status", () => {
    it("returns overview with no homes", async () => {
      const tool = registeredTools.get("flock_status")!;
      const result = await tool.execute("test-call-id", {});
      expect(result.details?.ok).toBe(true);
      expect(result.content[0].text).toContain("Flock Status");
    });
  });

  describe("tool: flock_sysadmin_protocol", () => {
    it("loads full protocol", async () => {
      const tool = registeredTools.get("flock_sysadmin_protocol")!;
      const result = await tool.execute("test-call-id", {});
      expect(result.details?.ok).toBe(true);
      expect(result.content[0].text).toContain("Sysadmin Protocol");
      expect(result.content[0].text).toContain("GREEN");
      expect(result.content[0].text).toContain("YELLOW");
      expect(result.content[0].text).toContain("RED");
    });

    it("loads triage section only", async () => {
      const tool = registeredTools.get("flock_sysadmin_protocol")!;
      const result = await tool.execute("test-call-id", { section: "triage" });
      expect(result.details?.ok).toBe(true);
      expect(result.details?.section).toBe("triage");
    });
  });

  describe("tool: flock_sysadmin_request", () => {
    it("fails gracefully when no sysadmin agent registered", async () => {
      const tool = registeredTools.get("flock_sysadmin_request")!;
      const result = await tool.execute(
        "test-call-id",
        { agentId: "test-worker", request: "Install something" },
      );
      // Should fail because no sysadmin agent is registered yet
      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("sysadmin");
    });
  });

  describe("tool: flock_audit", () => {
    it("returns empty when no entries", async () => {
      const tool = registeredTools.get("flock_audit")!;
      const result = await tool.execute("test-call-id", {});
      expect(result.details?.ok).toBe(true);
      expect(result.content[0].text).toContain("No audit entries");
    });

    it("rejects invalid level", async () => {
      const tool = registeredTools.get("flock_audit")!;
      const result = await tool.execute("test-call-id", { level: "PURPLE" });
      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("Invalid level");
    });
  });

  describe("tool: flock_status with state filter", () => {
    it("rejects invalid state", async () => {
      const tool = registeredTools.get("flock_status")!;
      const result = await tool.execute("test-call-id", { state: "FLYING" });
      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("Invalid state");
    });
  });
});
