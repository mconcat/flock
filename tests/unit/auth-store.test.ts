/**
 * Tests for Flock Auth Store (src/auth/store.ts)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAuthStore,
  saveAuthStore,
  getCredentials,
  setCredentials,
  removeCredentials,
  listProviders,
} from "../../src/auth/store.js";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

describe("Auth Store", () => {
  let tmpDir: string;
  let storePath: string;

  const sampleCred: OAuthCredentials = {
    refresh: "rt_test_refresh_token",
    access: "at_test_access_token",
    expires: Date.now() + 3600_000,
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flock-auth-test-"));
    storePath = join(tmpDir, "auth.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadAuthStore", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadAuthStore(storePath);
      expect(store.version).toBe(1);
      expect(store.credentials).toEqual({});
    });

    it("loads existing credentials", () => {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        credentials: { anthropic: sampleCred },
      }));

      const store = loadAuthStore(storePath);
      expect(store.version).toBe(1);
      expect(store.credentials.anthropic).toEqual(sampleCred);
    });

    it("resets on incompatible version", () => {
      writeFileSync(storePath, JSON.stringify({
        version: 99,
        credentials: { anthropic: sampleCred },
      }));

      const store = loadAuthStore(storePath);
      expect(store.version).toBe(1);
      expect(store.credentials).toEqual({});
    });

    it("handles malformed credentials field", () => {
      writeFileSync(storePath, JSON.stringify({
        version: 1,
        credentials: null,
      }));

      const store = loadAuthStore(storePath);
      expect(store.credentials).toEqual({});
    });
  });

  describe("saveAuthStore", () => {
    it("creates parent directories", () => {
      const deepPath = join(tmpDir, "a", "b", "auth.json");
      const store = { version: 1 as const, credentials: { anthropic: sampleCred } };

      saveAuthStore(store, deepPath);

      const raw = readFileSync(deepPath, "utf-8");
      const loaded = JSON.parse(raw);
      expect(loaded.credentials.anthropic.refresh).toBe(sampleCred.refresh);
    });

    it("writes with restrictive permissions", () => {
      const store = { version: 1 as const, credentials: {} };
      saveAuthStore(store, storePath);

      const stats = statSync(storePath);
      // 0o600 = owner read/write only
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("creates directory with 0o700", () => {
      const subDir = join(tmpDir, "secure-dir");
      const deepPath = join(subDir, "auth.json");
      const store = { version: 1 as const, credentials: {} };

      saveAuthStore(store, deepPath);

      const stats = statSync(subDir);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o700);
    });
  });

  describe("getCredentials", () => {
    it("returns credential for known provider", () => {
      const store = { version: 1 as const, credentials: { anthropic: sampleCred } };
      expect(getCredentials(store, "anthropic")).toEqual(sampleCred);
    });

    it("returns undefined for unknown provider", () => {
      const store = { version: 1 as const, credentials: {} };
      expect(getCredentials(store, "anthropic")).toBeUndefined();
    });
  });

  describe("setCredentials", () => {
    it("persists new credentials", () => {
      setCredentials("anthropic", sampleCred, storePath);

      const store = loadAuthStore(storePath);
      expect(store.credentials.anthropic).toEqual(sampleCred);
    });

    it("overwrites existing credentials", () => {
      setCredentials("anthropic", sampleCred, storePath);

      const updated: OAuthCredentials = { ...sampleCred, access: "new_access" };
      setCredentials("anthropic", updated, storePath);

      const store = loadAuthStore(storePath);
      expect(store.credentials.anthropic.access).toBe("new_access");
    });

    it("preserves other providers when adding", () => {
      setCredentials("anthropic", sampleCred, storePath);
      const codexCred: OAuthCredentials = { ...sampleCred, refresh: "codex_refresh" };
      setCredentials("openai-codex", codexCred, storePath);

      const store = loadAuthStore(storePath);
      expect(Object.keys(store.credentials)).toEqual(["anthropic", "openai-codex"]);
    });
  });

  describe("removeCredentials", () => {
    it("removes existing credentials and returns true", () => {
      setCredentials("anthropic", sampleCred, storePath);
      const removed = removeCredentials("anthropic", storePath);

      expect(removed).toBe(true);
      const store = loadAuthStore(storePath);
      expect(store.credentials.anthropic).toBeUndefined();
    });

    it("returns false for non-existent provider", () => {
      const removed = removeCredentials("anthropic", storePath);
      expect(removed).toBe(false);
    });

    it("preserves other providers", () => {
      setCredentials("anthropic", sampleCred, storePath);
      setCredentials("openai-codex", sampleCred, storePath);
      removeCredentials("anthropic", storePath);

      const store = loadAuthStore(storePath);
      expect(Object.keys(store.credentials)).toEqual(["openai-codex"]);
    });
  });

  describe("listProviders", () => {
    it("returns empty array when no credentials", () => {
      expect(listProviders(storePath)).toEqual([]);
    });

    it("returns stored provider IDs", () => {
      setCredentials("anthropic", sampleCred, storePath);
      setCredentials("openai-codex", sampleCred, storePath);

      const providers = listProviders(storePath);
      expect(providers).toEqual(["anthropic", "openai-codex"]);
    });
  });
});
