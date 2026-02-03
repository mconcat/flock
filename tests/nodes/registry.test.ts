/**
 * Tests for NodeRegistry — CRUD, agent lookup, status updates,
 * and hierarchical parent registry lookups.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import http from "node:http";
import { NodeRegistry } from "../../src/nodes/registry.js";
import type { NodeEntry } from "../../src/nodes/registry.js";

function makeEntry(overrides: Partial<NodeEntry> = {}): NodeEntry {
  return {
    nodeId: "node-1",
    a2aEndpoint: "http://node1:3001/flock",
    status: "unknown",
    lastSeen: 0,
    agentIds: [],
    ...overrides,
  };
}

describe("NodeRegistry", () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  // --- register / get ---

  it("registers and retrieves a node", () => {
    registry.register(makeEntry({ nodeId: "n1" }));
    const got = registry.get("n1");
    expect(got).not.toBeNull();
    expect(got!.nodeId).toBe("n1");
  });

  it("returns null for unknown node", () => {
    expect(registry.get("ghost")).toBeNull();
  });

  it("replaces existing entry on re-register", () => {
    registry.register(makeEntry({ nodeId: "n1", status: "unknown" }));
    registry.register(makeEntry({ nodeId: "n1", status: "online" }));
    expect(registry.get("n1")!.status).toBe("online");
  });

  it("get returns a copy (not mutable reference)", () => {
    registry.register(makeEntry({ nodeId: "n1", agentIds: ["a"] }));
    const copy = registry.get("n1")!;
    copy.agentIds.push("mutated");
    expect(registry.get("n1")!.agentIds).toEqual(["a"]);
  });

  // --- remove ---

  it("removes a node", () => {
    registry.register(makeEntry({ nodeId: "n1" }));
    expect(registry.remove("n1")).toBe(true);
    expect(registry.get("n1")).toBeNull();
  });

  it("remove returns false for unknown node", () => {
    expect(registry.remove("ghost")).toBe(false);
  });

  // --- list ---

  it("lists all registered nodes", () => {
    registry.register(makeEntry({ nodeId: "n1" }));
    registry.register(makeEntry({ nodeId: "n2" }));
    const list = registry.list();
    expect(list).toHaveLength(2);
    const ids = list.map((e) => e.nodeId).sort();
    expect(ids).toEqual(["n1", "n2"]);
  });

  it("list returns copies", () => {
    registry.register(makeEntry({ nodeId: "n1", agentIds: ["a"] }));
    const list = registry.list();
    list[0].agentIds.push("mutated");
    expect(registry.get("n1")!.agentIds).toEqual(["a"]);
  });

  // --- findNodeForAgent ---

  it("finds node hosting a given agent", () => {
    registry.register(makeEntry({ nodeId: "n1", agentIds: ["worker-1", "worker-2"] }));
    registry.register(makeEntry({ nodeId: "n2", agentIds: ["worker-3"] }));

    const node = registry.findNodeForAgent("worker-3");
    expect(node).not.toBeNull();
    expect(node!.nodeId).toBe("n2");
  });

  it("returns null when agent is not on any node", () => {
    registry.register(makeEntry({ nodeId: "n1", agentIds: ["worker-1"] }));
    expect(registry.findNodeForAgent("ghost")).toBeNull();
  });

  // --- updateAgents ---

  it("updates agent list for a node", () => {
    registry.register(makeEntry({ nodeId: "n1", agentIds: [] }));
    registry.updateAgents("n1", ["alpha", "beta"]);
    expect(registry.get("n1")!.agentIds).toEqual(["alpha", "beta"]);
  });

  it("updateAgents is a no-op for unknown node", () => {
    // Should not throw
    registry.updateAgents("ghost", ["x"]);
  });

  // --- updateStatus ---

  it("updates node status", () => {
    registry.register(makeEntry({ nodeId: "n1", status: "unknown" }));
    registry.updateStatus("n1", "online");
    const entry = registry.get("n1")!;
    expect(entry.status).toBe("online");
    expect(entry.lastSeen).toBeGreaterThan(0);
  });

  it("sets lastSeen only when status is 'online'", () => {
    registry.register(makeEntry({ nodeId: "n1", lastSeen: 0 }));
    registry.updateStatus("n1", "offline");
    expect(registry.get("n1")!.lastSeen).toBe(0);
  });

  it("updateStatus is a no-op for unknown node", () => {
    registry.updateStatus("ghost", "online"); // no throw
  });

  // --- has / size ---

  it("has returns true for registered nodes", () => {
    registry.register(makeEntry({ nodeId: "n1" }));
    expect(registry.has("n1")).toBe(true);
    expect(registry.has("ghost")).toBe(false);
  });

  it("size tracks registered count", () => {
    expect(registry.size).toBe(0);
    registry.register(makeEntry({ nodeId: "n1" }));
    registry.register(makeEntry({ nodeId: "n2" }));
    expect(registry.size).toBe(2);
    registry.remove("n1");
    expect(registry.size).toBe(1);
  });
});

// --- Parent registry (hierarchical lookup) ---

describe("NodeRegistry — parent registry", () => {
  let registry: NodeRegistry;
  let parentServer: http.Server;
  let parentUrl: string;

  // Spin up a real HTTP server simulating a parent node's agent card directory
  beforeEach(async () => {
    registry = new NodeRegistry();

    parentServer = http.createServer((req, res) => {
      if (req.url === "/flock/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          agents: [
            { id: "remote-worker", name: "remote-worker", url: "http://faraway-node:4000/flock/a2a/remote-worker" },
            { id: "another-agent", name: "another-agent", url: "http://faraway-node:4000/flock/a2a/another-agent" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    await new Promise<void>((resolve) => {
      parentServer.listen(0, "127.0.0.1", resolve);
    });

    const addr = parentServer.address();
    if (typeof addr === "object" && addr !== null) {
      parentUrl = `http://127.0.0.1:${addr.port}/flock`;
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      parentServer.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // --- setParent / getParent / clearParent ---

  it("setParent and getParent", () => {
    expect(registry.getParent()).toBeNull();
    registry.setParent({ endpoint: "http://central:3779/flock" });
    expect(registry.getParent()!.endpoint).toBe("http://central:3779/flock");
  });

  it("clearParent removes the reference", () => {
    registry.setParent({ endpoint: "http://central:3779/flock" });
    registry.clearParent();
    expect(registry.getParent()).toBeNull();
  });

  it("getParent returns a copy", () => {
    registry.setParent({ endpoint: "http://central:3779/flock", timeoutMs: 3000 });
    const ref = registry.getParent()!;
    ref.endpoint = "mutated";
    expect(registry.getParent()!.endpoint).toBe("http://central:3779/flock");
  });

  // --- findNodeForAgentWithParent ---

  it("returns local result without hitting parent", async () => {
    registry.register(makeEntry({ nodeId: "local-node", agentIds: ["local-worker"] }));
    registry.setParent({ endpoint: parentUrl });

    const result = await registry.findNodeForAgentWithParent("local-worker");
    expect(result.entry).not.toBeNull();
    expect(result.entry!.nodeId).toBe("local-node");
    expect(result.fromParent).toBe(false);
  });

  it("falls back to parent when agent not found locally", async () => {
    registry.setParent({ endpoint: parentUrl });

    const result = await registry.findNodeForAgentWithParent("remote-worker");
    expect(result.entry).not.toBeNull();
    expect(result.entry!.a2aEndpoint).toBe("http://faraway-node:4000/flock");
    expect(result.entry!.agentIds).toContain("remote-worker");
    expect(result.fromParent).toBe(true);
  });

  it("caches parent result in local registry", async () => {
    registry.setParent({ endpoint: parentUrl });

    // First call — hits parent
    await registry.findNodeForAgentWithParent("remote-worker");

    // Should now be in local registry
    const local = registry.findNodeForAgent("remote-worker");
    expect(local).not.toBeNull();
    expect(local!.a2aEndpoint).toBe("http://faraway-node:4000/flock");
  });

  it("returns null when agent not found locally or in parent", async () => {
    registry.setParent({ endpoint: parentUrl });

    const result = await registry.findNodeForAgentWithParent("nonexistent-agent");
    expect(result.entry).toBeNull();
    expect(result.fromParent).toBe(false);
  });

  it("returns null when no parent is set and agent not local", async () => {
    const result = await registry.findNodeForAgentWithParent("ghost");
    expect(result.entry).toBeNull();
    expect(result.fromParent).toBe(false);
  });

  it("handles parent server being unreachable", async () => {
    registry.setParent({ endpoint: "http://127.0.0.1:1/flock", timeoutMs: 500 });

    const result = await registry.findNodeForAgentWithParent("remote-worker");
    expect(result.entry).toBeNull();
    expect(result.fromParent).toBe(false);
  });

  it("merges agent IDs when caching into existing node entry", async () => {
    // Pre-register a node with the same endpoint but different agent
    registry.register({
      nodeId: "parent-resolved-http://faraway-node:4000/flock",
      a2aEndpoint: "http://faraway-node:4000/flock",
      status: "online",
      lastSeen: Date.now(),
      agentIds: ["existing-agent"],
    });
    registry.setParent({ endpoint: parentUrl });

    await registry.findNodeForAgentWithParent("remote-worker");

    const entry = registry.findNodeForAgent("remote-worker");
    expect(entry).not.toBeNull();
    // Both the existing and new agent should be present
    expect(entry!.agentIds).toContain("existing-agent");
    expect(entry!.agentIds).toContain("remote-worker");
  });

  it("re-queries parent when cached entry TTL expires", async () => {
    // Set very short TTL
    registry.setParent({ endpoint: parentUrl, cacheTtlMs: 1 });

    // First lookup — caches result
    const first = await registry.findNodeForAgentWithParent("remote-worker");
    expect(first.entry).not.toBeNull();
    expect(first.fromParent).toBe(true);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));

    // Second lookup — should re-query parent (TTL expired)
    const second = await registry.findNodeForAgentWithParent("remote-worker");
    expect(second.entry).not.toBeNull();
    expect(second.fromParent).toBe(true);
  });

  it("uses cache within TTL without hitting parent", async () => {
    registry.setParent({ endpoint: parentUrl, cacheTtlMs: 60_000 });

    // First lookup
    await registry.findNodeForAgentWithParent("remote-worker");

    // Kill parent server
    await new Promise<void>((resolve, reject) => {
      parentServer.close((err) => (err ? reject(err) : resolve()));
    });

    // Second lookup — should use cache (parent is down but TTL not expired)
    const second = await registry.findNodeForAgentWithParent("remote-worker");
    expect(second.entry).not.toBeNull();
    expect(second.entry!.a2aEndpoint).toBe("http://faraway-node:4000/flock");

    // Restart server for other tests
    parentServer = http.createServer((req, res) => {
      if (req.url === "/flock/.well-known/agent-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          agents: [
            { id: "remote-worker", name: "remote-worker", url: "http://faraway-node:4000/flock/a2a/remote-worker" },
            { id: "another-agent", name: "another-agent", url: "http://faraway-node:4000/flock/a2a/another-agent" },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      parentServer.listen(0, "127.0.0.1", resolve);
    });
  });

  it("evicts stale cache when parent says agent is gone", async () => {
    // Use a parent that initially has remote-worker, then doesn't
    let agentExists = true;
    await new Promise<void>((resolve, reject) => {
      parentServer.close((err) => (err ? reject(err) : resolve()));
    });

    parentServer = http.createServer((req, res) => {
      if (req.url === "/flock/.well-known/agent-card.json") {
        const agents = agentExists
          ? [{ id: "remote-worker", name: "remote-worker", url: "http://faraway-node:4000/flock/a2a/remote-worker" }]
          : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agents }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      parentServer.listen(0, "127.0.0.1", resolve);
    });
    const addr = parentServer.address();
    if (typeof addr === "object" && addr !== null) {
      parentUrl = `http://127.0.0.1:${addr.port}/flock`;
    }

    registry.setParent({ endpoint: parentUrl, cacheTtlMs: 1 });

    // Cache the agent
    const first = await registry.findNodeForAgentWithParent("remote-worker");
    expect(first.entry).not.toBeNull();

    // Agent disappears from parent
    agentExists = false;
    await new Promise((r) => setTimeout(r, 10));

    // TTL expired → re-query → agent gone → evicted
    const second = await registry.findNodeForAgentWithParent("remote-worker");
    expect(second.entry).toBeNull();

    // Local registry should also be cleaned up
    expect(registry.findNodeForAgent("remote-worker")).toBeNull();
  });

  it("validateAgent refreshes when node doesn't match", async () => {
    registry.setParent({ endpoint: parentUrl });

    // Cache the agent first
    await registry.findNodeForAgentWithParent("remote-worker");

    // Validate with wrong node — should refresh
    const result = await registry.validateAgent("remote-worker", "wrong-node-id");
    expect(result.entry).not.toBeNull();
    expect(result.fromParent).toBe(true);
  });

  it("validateAgent confirms when node matches", async () => {
    registry.setParent({ endpoint: parentUrl });

    // Cache the agent first
    const first = await registry.findNodeForAgentWithParent("remote-worker");
    const nodeId = first.entry!.nodeId;

    // Validate with correct node — should confirm
    const result = await registry.validateAgent("remote-worker", nodeId);
    expect(result.entry).not.toBeNull();
    expect(result.entry!.nodeId).toBe(nodeId);
  });
});
