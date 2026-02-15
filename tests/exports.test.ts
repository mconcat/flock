/**
 * Verify that all public API exports are accessible from the main entry point.
 * This ensures the standalone runtime is properly re-exported.
 */
import { describe, it, expect } from "vitest";

describe("public API exports", () => {
  it("exports startFlock", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.startFlock).toBe("function");
  });

  it("exports SessionManager", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.SessionManager).toBe("function");
  });

  it("exports createDirectSend", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.createDirectSend).toBe("function");
  });

  it("exports createFlockLogger", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.createFlockLogger).toBe("function");
  });

  it("exports loadFlockConfig", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.loadFlockConfig).toBe("function");
  });

  it("exports resolveFlockConfig", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.resolveFlockConfig).toBe("function");
  });

  it("exports createApiKeyResolver", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.createApiKeyResolver).toBe("function");
  });

  it("exports loadAuthStore", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.loadAuthStore).toBe("function");
  });

  it("exports startFlockHttpServer", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.startFlockHttpServer).toBe("function");
  });

  it("exports stopFlockHttpServer", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.stopFlockHttpServer).toBe("function");
  });

  it("exports createFlockTools", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.createFlockTools).toBe("function");
  });

  it("exports toResult", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.toResult).toBe("function");
  });
});
