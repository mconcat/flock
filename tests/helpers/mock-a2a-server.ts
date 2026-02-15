/**
 * Test helper — creates a properly typed A2AServer for use in tests.
 *
 * Uses a real A2AServer instance with a silent logger. Agents can be
 * pre-registered via the `agents` option. This avoids double-casting
 * (`as unknown as`) in test code.
 */

import { vi } from "vitest";
import { A2AServer } from "../../src/transport/server.js";
import type { PluginLogger } from "../../src/types.js";
import type { FlockCardMetadata } from "../../src/transport/types.js";

const silentLogger: PluginLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

export interface MockAgentEntry {
  role: string;
}

/**
 * Create a properly typed A2AServer instance for tests.
 *
 * Pre-registers agents with minimal cards so that `hasAgent()`,
 * `getAgentMeta()`, `registerAgent()`, and `unregisterAgent()` work.
 */
export function createMockA2AServer(
  agents: Record<string, MockAgentEntry> = {},
): A2AServer {
  const server = new A2AServer({
    basePath: "/flock",
    logger: silentLogger,
  });

  for (const [agentId, entry] of Object.entries(agents)) {
    const card = {
      name: agentId,
      url: `http://localhost:0/flock/a2a/${agentId}`,
      version: "0.0.1",
      capabilities: { streaming: false, pushNotifications: false },
      skills: [],
    };

    const meta: FlockCardMetadata = {
      role: entry.role as FlockCardMetadata["role"],
      nodeId: "test-node",
      archetype: undefined,
    };

    // Minimal executor satisfying AgentExecutor interface
    const executor = {
      execute: vi.fn().mockResolvedValue(undefined),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    };

    server.registerAgent(agentId, card, meta, executor);
  }

  return server;
}
