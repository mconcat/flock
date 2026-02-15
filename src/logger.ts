/**
 * Flock standalone logger.
 *
 * Provides a PluginLogger-compatible factory backed by Winston.
 * When running as an OpenClaw plugin, the host logger is used instead.
 */

import winston from "winston";
import type { PluginLogger } from "./types.js";

export interface FlockLoggerOptions {
  /** Prefix for all log lines. Default: "flock". */
  prefix?: string;
  /** Minimum log level. Default: "info". */
  level?: "debug" | "info" | "warn" | "error";
}

/**
 * Create a standalone logger satisfying PluginLogger.
 * Keeps the same interface OpenClaw provides, so all Flock code
 * works identically regardless of runtime.
 */
export function createFlockLogger(opts?: FlockLoggerOptions): PluginLogger {
  const prefix = opts?.prefix ?? "flock";
  const minLevel = opts?.level ?? "info";

  const winstonLogger = winston.createLogger({
    level: minLevel,
    format: winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
      winston.format.printf(({ timestamp, level, message }) =>
        `${timestamp} [${prefix}:${level}] ${message}`
      ),
    ),
    transports: [
      new winston.transports.Console({ forceConsole: true }),
    ],
  });

  return {
    info: (msg: string) => winstonLogger.info(msg),
    warn: (msg: string) => winstonLogger.warn(msg),
    error: (msg: string) => winstonLogger.error(msg),
    debug: (msg: string) => winstonLogger.debug(msg),
  };
}
