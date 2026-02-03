/**
 * Shared home utilities — ID construction and input validation.
 */

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that an ID contains only safe characters (alphanumeric, dash, underscore).
 * Prevents path traversal attacks when IDs are used in filesystem paths.
 */
export function validateId(value: string, label: string): void {
  if (!value || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `invalid ${label}: "${value}" — must match /^[a-zA-Z0-9_-]+$/`,
    );
  }
}

/** Construct a canonical homeId from agentId and nodeId. */
export function makeHomeId(agentId: string, nodeId: string): string {
  return `${agentId}@${nodeId}`;
}
