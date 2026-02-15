import { describe, it, expect, vi } from "vitest";
import { createFlockLogger } from "../src/logger.js";

describe("createFlockLogger", () => {
  it("returns a PluginLogger-compatible object", () => {
    const logger = createFlockLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("logs info messages", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createFlockLogger({ prefix: "test" });
    logger.info("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[test]");
    expect(spy.mock.calls[0][0]).toContain("hello");
    spy.mockRestore();
  });

  it("logs warn messages", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createFlockLogger({ prefix: "test" });
    logger.warn("caution");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[test:warn]");
    spy.mockRestore();
  });

  it("logs error messages", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createFlockLogger({ prefix: "test" });
    logger.error("failure");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[test:error]");
    spy.mockRestore();
  });

  it("respects level filter — warn level suppresses info", () => {
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = createFlockLogger({ level: "warn" });
    logger.info("should be suppressed");
    logger.warn("should appear");
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("debug level shows everything", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createFlockLogger({ level: "debug" });
    logger.debug("dbg");
    logger.info("inf");
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("uses default prefix 'flock'", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createFlockLogger();
    logger.info("msg");
    expect(spy.mock.calls[0][0]).toContain("[flock]");
    spy.mockRestore();
  });

  it("includes ISO timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createFlockLogger();
    logger.info("msg");
    // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss
    expect(spy.mock.calls[0][0]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    spy.mockRestore();
  });
});
