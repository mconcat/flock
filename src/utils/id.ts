/** Generate a unique ID with timestamp and random suffix to prevent collisions. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}
