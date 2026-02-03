/**
 * Remote Agent Card Discovery
 *
 * Fetches the agent card directory from a remote node's
 * well-known endpoint and returns parsed agent entries.
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { PluginLogger } from "../types.js";

/** Result of discovering agents on a remote node. */
export interface DiscoveredAgent {
  agentId: string;
  card: AgentCard;
}

/**
 * Validate that an unknown value looks like an AgentCard.
 * Checks required fields without using `as any`.
 */
function isAgentCardLike(v: unknown): v is AgentCard {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.url === "string" &&
    typeof obj.version === "string"
  );
}

/**
 * Validate that an unknown value is a discovered agent entry
 * with an `id` field and card-like shape.
 */
function isAgentEntry(v: unknown): v is Record<string, unknown> & { id: string } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.id === "string" && typeof obj.name === "string";
}

/**
 * Fetch agent cards from a remote node's well-known directory endpoint.
 *
 * Makes GET {a2aEndpoint}/.well-known/agent-card.json and parses the
 * response. Returns an array of discovered agents (may be empty on failure).
 *
 * @param a2aEndpoint - Base A2A endpoint URL (e.g. "http://node2:3002/flock")
 * @param logger - Logger for diagnostics
 */
export async function discoverRemoteAgents(
  a2aEndpoint: string,
  logger: PluginLogger,
): Promise<DiscoveredAgent[]> {
  const url = `${a2aEndpoint}/.well-known/agent-card.json`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn(
        `[flock:discovery] Failed to fetch agent cards from ${url}: HTTP ${res.status}`,
      );
      return [];
    }

    const body: unknown = await res.json();

    if (typeof body !== "object" || body === null) {
      logger.warn(`[flock:discovery] Unexpected response shape from ${url}`);
      return [];
    }

    const data = body as Record<string, unknown>;
    if (!Array.isArray(data.agents)) {
      logger.warn(`[flock:discovery] No agents array in response from ${url}`);
      return [];
    }

    const results: DiscoveredAgent[] = [];

    for (const entry of data.agents) {
      if (!isAgentEntry(entry)) continue;

      // Reconstruct an AgentCard from the entry (the directory includes id + card fields)
      const entryObj = entry as Record<string, unknown>;
      const card: Record<string, unknown> = { ...entryObj };
      delete card.id; // Remove the directory-specific id field

      if (isAgentCardLike(card)) {
        results.push({
          agentId: entry.id,
          card: card as AgentCard,
        });
      }
    }

    logger.debug?.(
      `[flock:discovery] Discovered ${results.length} agent(s) at ${a2aEndpoint}`,
    );

    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[flock:discovery] Error discovering agents at ${url}: ${msg}`);
    return [];
  }
}
