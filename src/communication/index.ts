/**
 * Flock Communication Layer
 *
 * Prompt-based expectations + A2A-native envelope helpers + system failure handling.
 */

// Schema — prompt-based message type expectations
export type { FlockMessageType, MessageExpectation } from "./schema.js";
export {
  MESSAGE_EXPECTATIONS,
  MESSAGE_TYPES,
  generateExpectationsPrompt,
} from "./schema.js";

// Envelope — A2A-native message construction/extraction
export { buildFlockMessage, extractFlockMeta } from "./envelope.js";

// Failure — system-level failure handling
export type {
  SystemFailureKind,
  SystemFailureContext,
  SystemFailureResult,
} from "./failure.js";
export { handleSystemFailure } from "./failure.js";
