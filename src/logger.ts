/**
 * Flock standalone logger.
 *
 * Provides a PluginLogger-compatible factory that works without OpenClaw.
 * When running as an OpenClaw plugin, the host logger is used instead.
 */

import type { PluginLogger } from "./types.js";

export interface FlockLoggerOptions {
  /** Prefix for all log lines. Default: "flock". */
  prefix?: string;
  /** Minimum log level. Default: "info". */
  level?: "debug" | "info" | "warn" | "error";
}

const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Create a standalone logger satisfying PluginLogger.
 * Keeps the same interface OpenClaw provides, so all Flock code
 * works identically regardless of runtime.
 */
export function createFlockLogger(opts?: FlockLoggerOptions): PluginLogger {
  const prefix = opts?.prefix ?? "flock";
  const minLevel = LEVEL_PRIORITY[opts?.level ?? "info"] ?? 1;

  const timestamp = (): string => new Date().toISOString();

  return {
    info(msg: string): void {
      if (minLevel <= LEVEL_PRIORITY.info) {
        console.log(`${timestamp()} [${prefix}] ${msg}`);
      }
    },
    warn(msg: string): void {
      if (minLevel <= LEVEL_PRIORITY.warn) {
        console.warn(`${timestamp()} [${prefix}:warn] ${msg}`);
      }
    },
    error(msg: string): void {
      if (minLevel <= LEVEL_PRIORITY.error) {
        console.error(`${timestamp()} [${prefix}:error] ${msg}`);
      }
    },
    debug(msg: string): void {
      if (minLevel <= LEVEL_PRIORITY.debug) {
        console.debug(`${timestamp()} [${prefix}:debug] ${msg}`);
      }
    },
  };
}
