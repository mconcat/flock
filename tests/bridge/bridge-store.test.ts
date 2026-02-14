/**
 * Tests for BridgeStore — both memory and SQLite implementations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase } from "../../src/db/memory.js";
import { createSqliteDatabase } from "../../src/db/sqlite.js";
import type { BridgeStore, FlockDatabase } from "../../src/db/interface.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function makeBridge(overrides: Partial<import("../../src/db/interface.js").BridgeMapping> = {}) {
  return {
    bridgeId: overrides.bridgeId ?? "bridge-1",
    channelId: overrides.channelId ?? "project-alpha",
    platform: overrides.platform ?? ("discord" as const),
    externalChannelId: overrides.externalChannelId ?? "discord-ch-123",
    accountId: overrides.accountId ?? null,
    webhookUrl: overrides.webhookUrl ?? null,
    createdBy: overrides.createdBy ?? "orchestrator",
    createdAt: overrides.createdAt ?? 1000,
    active: overrides.active ?? true,
  };
}

function runBridgeStoreTests(name: string, createDb: () => FlockDatabase) {
  describe(`BridgeStore (${name})`, () => {
    let db: FlockDatabase;
    let store: BridgeStore;

    beforeEach(() => {
      db = createDb();
      db.migrate();
      store = db.bridges;
    });

    it("inserts and retrieves a bridge", () => {
      const bridge = makeBridge();
      store.insert(bridge);
      const got = store.get("bridge-1");
      expect(got).toEqual(bridge);
    });

    it("returns null for non-existent bridge", () => {
      expect(store.get("nonexistent")).toBeNull();
    });

    it("getByChannel returns active bridges for a channel", () => {
      store.insert(makeBridge({ bridgeId: "b1", channelId: "ch-a" }));
      store.insert(makeBridge({ bridgeId: "b2", channelId: "ch-b" }));
      store.insert(makeBridge({ bridgeId: "b3", channelId: "ch-a", platform: "slack", externalChannelId: "slack-1", active: false }));

      const results = store.getByChannel("ch-a");
      expect(results).toHaveLength(1);
      expect(results[0].bridgeId).toBe("b1");
    });

    it("getByExternal finds bridge by platform + external channel ID", () => {
      store.insert(makeBridge({ bridgeId: "b1", externalChannelId: "dc-111" }));
      store.insert(makeBridge({ bridgeId: "b2", platform: "slack", externalChannelId: "sl-222" }));

      const found = store.getByExternal("discord", "dc-111");
      expect(found?.bridgeId).toBe("b1");

      const found2 = store.getByExternal("slack", "sl-222");
      expect(found2?.bridgeId).toBe("b2");

      expect(store.getByExternal("discord", "nonexistent")).toBeNull();
    });

    it("list with filters", () => {
      store.insert(makeBridge({ bridgeId: "b1", channelId: "ch-a", platform: "discord" }));
      store.insert(makeBridge({ bridgeId: "b2", channelId: "ch-b", platform: "slack", externalChannelId: "sl-1" }));
      store.insert(makeBridge({ bridgeId: "b3", channelId: "ch-a", platform: "slack", externalChannelId: "sl-2", active: false }));

      expect(store.list()).toHaveLength(3);
      expect(store.list({ channelId: "ch-a" })).toHaveLength(2);
      expect(store.list({ platform: "slack" })).toHaveLength(2);
      expect(store.list({ active: true })).toHaveLength(2);
      expect(store.list({ active: false })).toHaveLength(1);
      expect(store.list({ limit: 1 })).toHaveLength(1);
    });

    it("update toggles active state", () => {
      store.insert(makeBridge({ bridgeId: "b1", active: true }));
      store.update("b1", { active: false });
      expect(store.get("b1")?.active).toBe(false);
      store.update("b1", { active: true });
      expect(store.get("b1")?.active).toBe(true);
    });

    it("delete removes a bridge", () => {
      store.insert(makeBridge({ bridgeId: "b1" }));
      expect(store.get("b1")).not.toBeNull();
      store.delete("b1");
      expect(store.get("b1")).toBeNull();
    });

    it("stores and retrieves webhookUrl", () => {
      store.insert(makeBridge({ bridgeId: "b-wh", webhookUrl: "https://discord.com/api/webhooks/123/abc" }));
      const got = store.get("b-wh");
      expect(got?.webhookUrl).toBe("https://discord.com/api/webhooks/123/abc");
    });

    it("update sets webhookUrl", () => {
      store.insert(makeBridge({ bridgeId: "b-wh2" }));
      expect(store.get("b-wh2")?.webhookUrl).toBeNull();
      store.update("b-wh2", { webhookUrl: "https://discord.com/api/webhooks/456/def" });
      expect(store.get("b-wh2")?.webhookUrl).toBe("https://discord.com/api/webhooks/456/def");
    });

    it("update throws for nonexistent bridge (memory)", () => {
      if (name === "memory") {
        expect(() => store.update("nonexistent", { active: false })).toThrow("bridge not found");
      }
    });
  });
}

// Run tests for both backends
runBridgeStoreTests("memory", createMemoryDatabase);

runBridgeStoreTests("sqlite", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flock-bridge-test-"));
  return createSqliteDatabase(tmpDir);
});
