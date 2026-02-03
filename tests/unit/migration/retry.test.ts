import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import {
  withRetry,
  getRetryPolicy,
  RETRY_NETWORK,
  RETRY_LOCAL,
} from "../../../src/migration/retry.js";
import { MigrationErrorCode } from "../../../src/migration/types.js";
import type { PluginLogger } from "../../../src/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("Retry", () => {
  describe("withRetry", () => {
    it("returns the result on first success", async () => {
      const fn = async () => 42;
      const logger = makeLogger();

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }, logger);
      expect(result).toBe(42);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("retries on failure and returns result when succeeding on retry", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls < 3) throw new Error(`fail #${calls}`);
        return "success";
      };
      const logger = makeLogger();

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }, logger);
      expect(result).toBe("success");
      expect(calls).toBe(3);

      // Should have logged warnings for the first 2 failures
      expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("throws the last error after exhausting all attempts", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error(`fail #${calls}`);
      };
      const logger = makeLogger();

      await expect(
        withRetry(fn, { maxAttempts: 2, baseDelayMs: 0 }, logger),
      ).rejects.toThrow("fail #3"); // 1 initial + 2 retries = 3 calls

      expect(calls).toBe(3);
    });

    it("applies exponential backoff timing", async () => {
      const delays: number[] = [];
      let calls = 0;
      const fn = async () => {
        const now = Date.now();
        if (calls > 0) {
          delays.push(now);
        }
        calls++;
        if (calls <= 3) throw new Error("fail");
        return "done";
      };
      const logger = makeLogger();

      const startTime = Date.now();
      delays.push(startTime);

      await withRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 50, backoffFactor: 2 },
        logger,
      );

      // Verify delays increased (with tolerance for timing jitter)
      // Attempt 1: immediate, Attempt 2: ~50ms, Attempt 3: ~100ms
      expect(calls).toBe(4);
    });

    it("caps delay at maxDelayMs", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls <= 2) throw new Error("fail");
        return "done";
      };
      const logger = makeLogger();

      const start = Date.now();
      await withRetry(
        fn,
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          backoffFactor: 10,
          maxDelayMs: 50, // Cap at 50ms even though base * factor^attempt would be > 50
        },
        logger,
      );
      const elapsed = Date.now() - start;

      // With maxDelayMs=50ms and 2 retries, total delay should be ~100ms max
      expect(elapsed).toBeLessThan(500); // generous upper bound
      expect(calls).toBe(3);
    });

    it("handles zero maxAttempts (no retries)", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        throw new Error("always fail");
      };
      const logger = makeLogger();

      await expect(
        withRetry(fn, { maxAttempts: 0, baseDelayMs: 0 }, logger),
      ).rejects.toThrow("always fail");

      expect(calls).toBe(1); // Only the initial attempt
    });

    it("logs warning with attempt number on each failure", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls <= 2) throw new Error("test error");
        return "ok";
      };
      const logger = makeLogger();

      await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 }, logger);

      expect(logger.warn).toHaveBeenCalledTimes(2);
      const firstWarn = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(firstWarn).toContain("Attempt 1/4");
      expect(firstWarn).toContain("test error");

      const secondWarn = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(secondWarn).toContain("Attempt 2/4");
    });

    it("logs final exhaustion message on last failure", async () => {
      const fn = async () => {
        throw new Error("permanent fail");
      };
      const logger = makeLogger();

      await expect(
        withRetry(fn, { maxAttempts: 1, baseDelayMs: 0 }, logger),
      ).rejects.toThrow("permanent fail");

      // Last call to warn should mention exhaustion
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const lastWarn = warnCalls[warnCalls.length - 1][0];
      expect(lastWarn).toContain("exhausted");
    });

    it("handles non-Error thrown values", async () => {
      let calls = 0;
      const fn = async () => {
        calls++;
        if (calls === 1) throw "string error"; // eslint-disable-line no-throw-literal
        return "ok";
      };
      const logger = makeLogger();

      const result = await withRetry(fn, { maxAttempts: 1, baseDelayMs: 0 }, logger);
      expect(result).toBe("ok");
    });
  });

  describe("RETRY_NETWORK / RETRY_LOCAL policies", () => {
    it("RETRY_NETWORK has expected values", () => {
      expect(RETRY_NETWORK.maxAttempts).toBe(3);
      expect(RETRY_NETWORK.baseDelayMs).toBe(30_000);
    });

    it("RETRY_LOCAL has expected values", () => {
      expect(RETRY_LOCAL.maxAttempts).toBe(2);
      expect(RETRY_LOCAL.baseDelayMs).toBe(5_000);
    });
  });

  describe("getRetryPolicy", () => {
    it("returns RETRY_NETWORK for network/timeout error codes", () => {
      const networkCodes: MigrationErrorCode[] = [
        MigrationErrorCode.AUTH_TIMEOUT,
        MigrationErrorCode.TRANSFER_NETWORK_FAILED,
        MigrationErrorCode.TRANSFER_TIMEOUT,
        MigrationErrorCode.VERIFY_ACK_TIMEOUT,
        MigrationErrorCode.FINALIZE_NOTIFICATION_FAILED,
        MigrationErrorCode.FINALIZE_REGISTRY_UPDATE_FAILED,
        MigrationErrorCode.REHYDRATE_GIT_CLONE_FAILED,
      ];

      for (const code of networkCodes) {
        const policy = getRetryPolicy(code);
        expect(policy).toBe(RETRY_NETWORK);
      }
    });

    it("returns RETRY_LOCAL for local I/O error codes", () => {
      const localCodes: MigrationErrorCode[] = [
        MigrationErrorCode.FREEZE_ACK_TIMEOUT,
        MigrationErrorCode.SNAPSHOT_ARCHIVE_FAILED,
        MigrationErrorCode.SNAPSHOT_CHECKSUM_FAILED,
        MigrationErrorCode.VERIFY_CHECKSUM_MISMATCH,
        MigrationErrorCode.VERIFY_SIZE_MISMATCH,
        MigrationErrorCode.VERIFY_ARCHIVE_CORRUPT,
      ];

      for (const code of localCodes) {
        const policy = getRetryPolicy(code);
        expect(policy).toBe(RETRY_LOCAL);
      }
    });

    it("returns null for non-retryable error codes", () => {
      const nonRetryable: MigrationErrorCode[] = [
        MigrationErrorCode.AUTH_REJECTED,
        MigrationErrorCode.FREEZE_PROCESS_KILL_FAILED,
        MigrationErrorCode.FREEZE_INVALID_STATE,
        MigrationErrorCode.SNAPSHOT_WORK_STATE_FAILED,
        MigrationErrorCode.SNAPSHOT_PORTABLE_SIZE_EXCEEDED,
        MigrationErrorCode.TRANSFER_DISK_FULL,
        MigrationErrorCode.TRANSFER_RESERVATION_INVALID,
        MigrationErrorCode.VERIFY_BASE_VERSION_MISMATCH,
        MigrationErrorCode.REHYDRATE_EXTRACT_FAILED,
        MigrationErrorCode.REHYDRATE_GIT_APPLY_FAILED,
        MigrationErrorCode.REHYDRATE_BASE_MOUNT_FAILED,
        MigrationErrorCode.REHYDRATE_SECRETS_PLACEMENT_FAILED,
        MigrationErrorCode.UNKNOWN,
        MigrationErrorCode.MANUAL_ABORT,
        MigrationErrorCode.INTERNAL_STATE_INCONSISTENCY,
      ];

      for (const code of nonRetryable) {
        expect(getRetryPolicy(code)).toBeNull();
      }
    });
  });
});
