/**
 * Migration Retry — exponential backoff retry logic for migration operations.
 *
 * Two retry categories:
 * - **RETRY_NETWORK**: Network/timeout errors (longer delays, more attempts)
 * - **RETRY_LOCAL**: Local I/O errors (shorter delays, fewer attempts)
 *
 * Non-retryable errors return null from `getRetryPolicy()` — the caller
 * should rollback or escalate to manual intervention.
 *
 * Backoff formula: delay = min(baseDelayMs * backoffFactor^attempt, maxDelayMs)
 */

import type { PluginLogger } from "../types.js";
import type { RetryPolicy } from "./types.js";
import { MigrationErrorCode } from "./types.js";

/** Default backoff factor if not specified in the policy. */
const DEFAULT_BACKOFF_FACTOR = 2;

/** Default maximum delay if not specified in the policy. */
const DEFAULT_MAX_DELAY_MS = 300_000; // 5 minutes

/** Network-related retries (longer delays, more attempts). */
export const RETRY_NETWORK: RetryPolicy = { maxAttempts: 3, baseDelayMs: 30_000 };

/** Local operation retries (shorter delays, fewer attempts). */
export const RETRY_LOCAL: RetryPolicy = { maxAttempts: 2, baseDelayMs: 5_000 };

/** Error codes classified as network/timeout — use RETRY_NETWORK. */
const NETWORK_ERRORS: ReadonlySet<MigrationErrorCode> = new Set([
  MigrationErrorCode.AUTH_TIMEOUT,
  MigrationErrorCode.TRANSFER_NETWORK_FAILED,
  MigrationErrorCode.TRANSFER_TIMEOUT,
  MigrationErrorCode.VERIFY_ACK_TIMEOUT,
  MigrationErrorCode.FINALIZE_NOTIFICATION_FAILED,
  MigrationErrorCode.FINALIZE_REGISTRY_UPDATE_FAILED,
  MigrationErrorCode.REHYDRATE_GIT_CLONE_FAILED,
]);

/** Error codes classified as local I/O — use RETRY_LOCAL. */
const LOCAL_ERRORS: ReadonlySet<MigrationErrorCode> = new Set([
  MigrationErrorCode.FREEZE_ACK_TIMEOUT,
  MigrationErrorCode.SNAPSHOT_ARCHIVE_FAILED,
  MigrationErrorCode.SNAPSHOT_CHECKSUM_FAILED,
  MigrationErrorCode.VERIFY_CHECKSUM_MISMATCH,
  MigrationErrorCode.VERIFY_SIZE_MISMATCH,
  MigrationErrorCode.VERIFY_ARCHIVE_CORRUPT,
]);

/**
 * Sleep for the specified number of milliseconds.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry and exponential backoff.
 *
 * On each failure, logs a warning with the attempt count. On final failure,
 * throws the last error. Backoff is calculated as:
 *   delay = min(baseDelayMs * backoffFactor^attempt, maxDelayMs)
 *
 * @param fn - Async function to execute
 * @param policy - Retry policy configuration
 * @param logger - Logger for retry attempt warnings
 * @returns The result of the function on success
 * @throws The last error if all retry attempts are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  logger: PluginLogger,
): Promise<T> {
  const { maxAttempts, baseDelayMs } = policy;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const backoffFactor = policy.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxAttempts) {
        const delay = Math.min(
          baseDelayMs * Math.pow(backoffFactor, attempt),
          maxDelayMs,
        );
        logger.warn(
          `[flock:migration:retry] Attempt ${attempt + 1}/${maxAttempts + 1} failed: ${lastError.message}. ` +
          `Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      } else {
        logger.warn(
          `[flock:migration:retry] All ${maxAttempts + 1} attempts exhausted. Last error: ${lastError.message}`,
        );
      }
    }
  }

  // TypeScript needs this — lastError is always set when we reach here
  throw lastError;
}

/**
 * Classify an error code as retryable and return the appropriate policy, or null.
 *
 * - Network/timeout errors → {@link RETRY_NETWORK}
 * - Local I/O errors → {@link RETRY_LOCAL}
 * - Everything else → `null` (rollback or manual intervention)
 *
 * @param errorCode - Migration error code to classify
 * @returns RetryPolicy if the error is retryable, null otherwise
 */
export function getRetryPolicy(errorCode: MigrationErrorCode): RetryPolicy | null {
  if (NETWORK_ERRORS.has(errorCode)) return RETRY_NETWORK;
  if (LOCAL_ERRORS.has(errorCode)) return RETRY_LOCAL;
  return null;
}
