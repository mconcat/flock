import { describe, it, expect, vi, afterEach } from "vitest";
import { createFlockLogger } from "../src/logger.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFlockLogger", () => {
  it("returns a PluginLogger-compatible object", () => {
    const logger = createFlockLogger();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("info/warn/error/debug do not throw", () => {
    const logger = createFlockLogger({ prefix: "test", level: "debug" });
    expect(() => logger.info("hello")).not.toThrow();
    expect(() => logger.warn("caution")).not.toThrow();
    expect(() => logger.error("failure")).not.toThrow();
    expect(() => logger.debug("detail")).not.toThrow();
  });

  it("respects level filter — warn level suppresses debug and info", () => {
    // Spy on console methods BEFORE creating the logger, since Winston
    // binds console.log/warn/error in the Console transport constructor.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const logger = createFlockLogger({ level: "warn", prefix: "test" });
    logger.debug("dbg-suppressed");
    logger.info("info-suppressed");

    // debug and info should be suppressed — no calls to any console method
    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls];
    const hasDebug = allCalls.some((args) => String(args).includes("dbg-suppressed"));
    const hasInfo = allCalls.some((args) => String(args).includes("info-suppressed"));
    expect(hasDebug).toBe(false);
    expect(hasInfo).toBe(false);

    logger.warn("warn-visible");
    logger.error("error-visible");

    // After the new calls, check combined output
    const allCalls2 = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls];
    const hasWarn = allCalls2.some((args) => String(args).includes("warn-visible"));
    const hasError = allCalls2.some((args) => String(args).includes("error-visible"));
    expect(hasWarn).toBe(true);
    expect(hasError).toBe(true);
  });

  it("debug level shows everything", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const logger = createFlockLogger({ level: "debug", prefix: "test" });
    logger.debug("dbg-msg");
    logger.info("inf-msg");
    logger.warn("wrn-msg");
    logger.error("err-msg");

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls, ...debugSpy.mock.calls];
    const stringify = (args: unknown[]) => args.map(String).join(" ");
    const hasDebug = allCalls.some((args) => stringify(args).includes("dbg-msg"));
    const hasInfo = allCalls.some((args) => stringify(args).includes("inf-msg"));
    const hasWarn = allCalls.some((args) => stringify(args).includes("wrn-msg"));
    const hasError = allCalls.some((args) => stringify(args).includes("err-msg"));

    expect(hasDebug).toBe(true);
    expect(hasInfo).toBe(true);
    expect(hasWarn).toBe(true);
    expect(hasError).toBe(true);
  });

  it("uses provided prefix in output", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createFlockLogger({ prefix: "myprefix" });
    logger.info("msg");

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const hasPrefix = allCalls.some((args) => String(args).includes("[myprefix:"));
    expect(hasPrefix).toBe(true);
  });

  it("uses default prefix 'flock'", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createFlockLogger();
    logger.info("msg");

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const hasPrefix = allCalls.some((args) => String(args).includes("[flock:"));
    expect(hasPrefix).toBe(true);
  });

  it("includes timestamp in output", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createFlockLogger();
    logger.info("msg");

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    // ISO 8601 pattern: YYYY-MM-DDTHH:mm:ss
    const hasTimestamp = allCalls.some((args) => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(args)));
    expect(hasTimestamp).toBe(true);
  });
});
