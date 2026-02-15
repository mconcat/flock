/**
 * Tests for Flock Auth Resolver (src/auth/resolver.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OAuthCredentials } from "@mariozechner/pi-ai";

// Mock pi-ai OAuth functions
vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    getEnvApiKey: vi.fn(),
  };
});

import { getOAuthApiKey, getEnvApiKey } from "@mariozechner/pi-ai";
import { createApiKeyResolver } from "../../src/auth/resolver.js";
import type { PluginLogger } from "../../src/types.js";

const mockGetOAuthApiKey = vi.mocked(getOAuthApiKey);
const mockGetEnvApiKey = vi.mocked(getEnvApiKey);

describe("Auth Resolver", () => {
  let tmpDir: string;
  let storePath: string;

  const sampleCred: OAuthCredentials = {
    refresh: "rt_test",
    access: "at_test",
    expires: Date.now() + 3600_000,
  };

  const mockLogger: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "flock-auth-resolver-"));
    storePath = join(tmpDir, "auth.json");
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns OAuth API key when credentials exist", async () => {
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { anthropic: sampleCred },
    }));

    mockGetOAuthApiKey.mockResolvedValueOnce({
      newCredentials: sampleCred,
      apiKey: "sk-ant-test-key",
    });

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBe("sk-ant-test-key");
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith("anthropic", { anthropic: sampleCred });
  });

  it("persists refreshed credentials", async () => {
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { anthropic: sampleCred },
    }));

    const refreshedCred: OAuthCredentials = {
      ...sampleCred,
      access: "new_access_token",
      expires: Date.now() + 7200_000,
    };

    mockGetOAuthApiKey.mockResolvedValueOnce({
      newCredentials: refreshedCred,
      apiKey: "sk-ant-refreshed-key",
    });

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBe("sk-ant-refreshed-key");

    // Verify it was persisted
    const { loadAuthStore } = await import("../../src/auth/store.js");
    const store = loadAuthStore(storePath);
    expect(store.credentials.anthropic.access).toBe("new_access_token");
  });

  it("falls back to environment variable when no OAuth credentials", async () => {
    // Empty store (no credentials)
    mockGetEnvApiKey.mockReturnValueOnce("env-anthropic-key");

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBe("env-anthropic-key");
    expect(mockGetOAuthApiKey).not.toHaveBeenCalled();
  });

  it("falls back to env var when OAuth fails", async () => {
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { anthropic: sampleCred },
    }));

    mockGetOAuthApiKey.mockRejectedValueOnce(new Error("Token refresh failed"));
    mockGetEnvApiKey.mockReturnValueOnce("env-fallback-key");

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBe("env-fallback-key");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Token refresh failed"),
    );
  });

  it("returns undefined when no credentials and no env var", async () => {
    mockGetEnvApiKey.mockReturnValueOnce(undefined);

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBeUndefined();
  });

  it("maps openai provider to openai-codex OAuth", async () => {
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { "openai-codex": sampleCred },
    }));

    mockGetOAuthApiKey.mockResolvedValueOnce({
      newCredentials: sampleCred,
      apiKey: "sk-openai-test",
    });

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("openai");

    expect(key).toBe("sk-openai-test");
    expect(mockGetOAuthApiKey).toHaveBeenCalledWith("openai-codex", { "openai-codex": sampleCred });
  });

  it("tries multiple OAuth provider mappings", async () => {
    // Google maps to both google-gemini-cli and google-antigravity
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { "google-antigravity": sampleCred },
    }));

    // First call (google-gemini-cli) returns null (no credentials)
    // Second call (google-antigravity) returns the key
    mockGetOAuthApiKey.mockResolvedValueOnce({
      newCredentials: sampleCred,
      apiKey: "google-ag-key",
    });

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("google");

    expect(key).toBe("google-ag-key");
  });

  it("falls back to env when OAuth returns null", async () => {
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      credentials: { anthropic: sampleCred },
    }));

    mockGetOAuthApiKey.mockResolvedValueOnce(null);
    mockGetEnvApiKey.mockReturnValueOnce("env-key");

    const resolve = createApiKeyResolver({ storePath, logger: mockLogger });
    const key = await resolve("anthropic");

    expect(key).toBe("env-key");
  });

  it("works without logger", async () => {
    mockGetEnvApiKey.mockReturnValueOnce("key-no-logger");

    const resolve = createApiKeyResolver({ storePath });
    const key = await resolve("anthropic");

    expect(key).toBe("key-no-logger");
  });
});
