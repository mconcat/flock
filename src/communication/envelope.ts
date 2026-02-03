/**
 * Flock A2A Message Envelope Helpers
 *
 * Thin wrappers around A2A-native types — no separate FlockMessage type.
 * Uses FlockTaskMetadata from transport/types.ts for structured metadata,
 * attached as DataPart so it flows naturally through the A2A protocol.
 */

import type { MessageSendParams, Part, DataPart } from "@a2a-js/sdk";
import type { FlockTaskMetadata } from "../transport/types.js";
import { userMessage, dataPart, isDataPart } from "../transport/a2a-helpers.js";

/** Shape of the Flock metadata payload inside a DataPart. */
interface FlockDataPayload {
  flockMeta?: Partial<FlockTaskMetadata>;
  [key: string]: unknown;
}

/**
 * Build A2A MessageSendParams with optional Flock metadata.
 * Uses A2A native types — no separate FlockMessage type.
 *
 * @param text  - The user-facing message text.
 * @param meta  - Optional Flock-specific metadata (urgency, project, etc.).
 * @param extraData - Additional arbitrary data to include in the DataPart.
 * @returns A2A-native MessageSendParams ready for `tasks/send`.
 */
export function buildFlockMessage(
  text: string,
  meta?: Partial<FlockTaskMetadata>,
  extraData?: Record<string, unknown>,
): MessageSendParams {
  const parts: Part[] = [];

  if (meta || extraData) {
    const payload: Record<string, unknown> = {};
    if (meta) {
      payload.flockMeta = meta;
    }
    if (extraData) {
      Object.assign(payload, extraData);
    }
    parts.push(dataPart(payload));
  }

  return {
    message: userMessage(text, parts.length > 0 ? parts : undefined),
  };
}

/**
 * Type guard: checks if a value looks like a FlockDataPayload
 * (has a flockMeta property that is an object).
 */
function isFlockDataPayload(v: unknown): v is FlockDataPayload {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    "flockMeta" in obj &&
    typeof obj.flockMeta === "object" &&
    obj.flockMeta !== null
  );
}

/**
 * Extract Flock metadata from an A2A task's message parts, if present.
 *
 * Scans through parts looking for a DataPart whose data contains
 * a `flockMeta` field. Returns the first match or null.
 *
 * @param parts - Array of A2A Part objects from a Message.
 * @returns The FlockTaskMetadata if found, null otherwise.
 */
export function extractFlockMeta(
  parts: readonly Part[],
): Partial<FlockTaskMetadata> | null {
  for (const part of parts) {
    if (!isDataPart(part)) continue;
    const dp = part as DataPart;
    if (isFlockDataPayload(dp.data)) {
      return dp.data.flockMeta ?? null;
    }
  }
  return null;
}
