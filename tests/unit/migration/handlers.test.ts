import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createMigrationHandlers } from "../../../src/migration/handlers.js";
import type {
  MigrationHandlerContext,
  MigrationHandlerMap,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
} from "../../../src/migration/handlers.js";
import { createTicketStore } from "../../../src/migration/ticket-store.js";
import type { MigrationTicketStore } from "../../../src/migration/ticket-store.js";
import { createMemoryDatabase } from "../../../src/db/memory.js";
import { createAuditLog } from "../../../src/audit/log.js";
import type { AuditLog } from "../../../src/audit/log.js";
import type { PluginLogger } from "../../../src/types.js";
import type { MigrationPhase } from "../../../src/migration/types.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function isSuccess(resp: unknown): resp is JsonRpcSuccessResponse {
  return typeof resp === "object" && resp !== null && "result" in resp;
}

function isError(resp: unknown): resp is JsonRpcErrorResponse {
  return typeof resp === "object" && resp !== null && "error" in resp;
}

/** Walk a ticket to the given phase. */
function walkToPhase(store: MigrationTicketStore, migrationId: string, targetPhase: MigrationPhase): void {
  const orderedPhases: MigrationPhase[] = [
    "AUTHORIZED",
    "FREEZING",
    "FROZEN",
    "SNAPSHOTTING",
    "TRANSFERRING",
    "VERIFYING",
    "REHYDRATING",
    "FINALIZING",
    "COMPLETED",
  ];

  for (const phase of orderedPhases) {
    store.updatePhase(migrationId, phase);
    if (phase === targetPhase) break;
  }
}

describe("MigrationHandlers", () => {
  let ticketStore: MigrationTicketStore;
  let auditLog: AuditLog;
  let logger: PluginLogger;
  let ctx: MigrationHandlerContext;
  let handlers: MigrationHandlerMap;

  beforeEach(() => {
    const db = createMemoryDatabase();
    logger = makeLogger();
    ticketStore = createTicketStore({ logger });
    auditLog = createAuditLog({ db, logger });

    ctx = {
      ticketStore,
      auditLog,
      logger,
      nodeId: "node-2",
    };

    handlers = createMigrationHandlers(ctx);
  });

  describe("migration/request", () => {
    it("creates a ticket on valid request", async () => {
      const handler = handlers.get("migration/request")!;
      const resp = await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-2",
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.migrationId).toBe("mig-1");
        expect(resp.result.phase).toBe("REQUESTED");
      }
    });

    it("rejects missing required fields", async () => {
      const handler = handlers.get("migration/request")!;
      const resp = await handler({
        migrationId: "mig-1",
        // Missing other fields
      }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.code).toBe(-32602);
        expect(resp.error.message).toContain("Missing required fields");
      }
    });

    it("rejects invalid migration reason", async () => {
      const handler = handlers.get("migration/request")!;
      const resp = await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-2",
        reason: "invalid_reason",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.code).toBe(-32602);
        expect(resp.error.message).toContain("Invalid migration reason");
      }
    });

    it("rejects request for wrong target node", async () => {
      const handler = handlers.get("migration/request")!;
      const resp = await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-99", // Wrong target
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("node-2");
      }
    });

    it("rejects requests from unknown nodes when knownNodeIds set", async () => {
      const ctxWithKnown: MigrationHandlerContext = {
        ...ctx,
        knownNodeIds: new Set(["node-3"]),
      };
      const localHandlers = createMigrationHandlers(ctxWithKnown);
      const handler = localHandlers.get("migration/request")!;

      const resp = await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1", // Not in knownNodeIds
        targetNodeId: "node-2",
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctxWithKnown);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("Unknown source node");
      }
    });

    it("rejects when capacity check fails", async () => {
      const ctxWithCapacity: MigrationHandlerContext = {
        ...ctx,
        checkCapacity: () => ({ ok: false, reason: "DISK_FULL" }),
      };
      const localHandlers = createMigrationHandlers(ctxWithCapacity);
      const handler = localHandlers.get("migration/request")!;

      const resp = await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-2",
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctxWithCapacity);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.approved).toBe(false);
        expect(resp.result.reason).toBe("DISK_FULL");
      }
    });

    it("rejects duplicate active migration for same agent", async () => {
      const handler = handlers.get("migration/request")!;

      // First request succeeds
      await handler({
        migrationId: "mig-1",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-2",
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctx);

      // Second request for same agent
      const resp = await handler({
        migrationId: "mig-2",
        agentId: "agent-1",
        sourceNodeId: "node-1",
        targetNodeId: "node-2",
        reason: "agent_request",
        sourceEndpoint: "http://node-1:3779/flock",
      }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("already has an active migration");
      }
    });
  });

  describe("migration/approve", () => {
    it("advances ticket to AUTHORIZED", async () => {
      // Create a ticket first
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "http://node-1:3779/flock" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });

      const handler = handlers.get("migration/approve")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("AUTHORIZED");
      }
    });

    it("returns error for unknown migration", async () => {
      const handler = handlers.get("migration/approve")!;
      const resp = await handler({ migrationId: "nonexistent" }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("not found");
      }
    });

    it("returns error for missing migrationId", async () => {
      const handler = handlers.get("migration/approve")!;
      const resp = await handler({}, ctx);

      expect(isError(resp)).toBe(true);
    });
  });

  describe("migration/reject", () => {
    it("moves ticket to ABORTED", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });

      const handler = handlers.get("migration/reject")!;
      const resp = await handler({
        migrationId: "mig-1",
        reason: "No capacity",
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });
  });

  describe("migration/verify", () => {
    it("transfers ownership on successful verification", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "VERIFYING");

      const handler = handlers.get("migration/verify")!;
      const resp = await handler({
        migrationId: "mig-1",
        verified: true,
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("REHYDRATING");
        expect(resp.result.ownershipHolder).toBe("target");
      }

      // Verify atomic update — both phase and ownership changed together
      const ticket = ticketStore.get("mig-1")!;
      expect(ticket.phase).toBe("REHYDRATING");
      expect(ticket.ownershipHolder).toBe("target");
    });

    it("rolls back on failed verification", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "VERIFYING");

      const handler = handlers.get("migration/verify")!;
      const resp = await handler({
        migrationId: "mig-1",
        verified: false,
        failureReason: "CHECKSUM_MISMATCH",
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ROLLING_BACK");
      }
    });

    it("rejects missing fields", async () => {
      const handler = handlers.get("migration/verify")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isError(resp)).toBe(true);
    });
  });

  describe("migration/status", () => {
    it("returns current migration state", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });

      const handler = handlers.get("migration/status")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.migrationId).toBe("mig-1");
        expect(resp.result.phase).toBe("REQUESTED");
        expect(resp.result.ownershipHolder).toBe("source");
      }
    });

    it("returns error for unknown migration", async () => {
      const handler = handlers.get("migration/status")!;
      const resp = await handler({ migrationId: "nonexistent" }, ctx);

      expect(isError(resp)).toBe(true);
    });
  });

  describe("migration/abort", () => {
    it("aborts from early phase (REQUESTED) without ROLLING_BACK", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({
        migrationId: "mig-1",
        reason: "Changed mind",
        initiator: "user",
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });

    it("aborts from AUTHORIZED without ROLLING_BACK", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "AUTHORIZED");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({
        migrationId: "mig-1",
        reason: "Cancelled",
      }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });

    it("aborts from FREEZING without ROLLING_BACK", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "FREEZING");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });

    it("aborts from FROZEN via ROLLING_BACK → ABORTED", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "FROZEN");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });

    it("aborts from TRANSFERRING via ROLLING_BACK → ABORTED", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "TRANSFERRING");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });

    it("rejects abort for COMPLETED migration", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "COMPLETED");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("terminal state");
      }
    });

    it("rejects abort for ABORTED migration", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      ticketStore.updatePhase("mig-1", "ABORTED");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("terminal state");
      }
    });

    it("rejects abort for unknown migration", async () => {
      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "nonexistent" }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("not found");
      }
    });

    it("handles abort from ROLLING_BACK → ABORTED", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "FROZEN");
      ticketStore.updatePhase("mig-1", "ROLLING_BACK");

      const handler = handlers.get("migration/abort")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.phase).toBe("ABORTED");
      }
    });
  });

  describe("migration/complete", () => {
    it("errors without migration engine", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });
      walkToPhase(ticketStore, "mig-1", "FINALIZING");

      const handler = handlers.get("migration/complete")!;
      // ctx has no migrationEngine — should error, not silently fall back
      const resp = await handler({
        migrationId: "mig-1",
        newHomeId: "agent-1@node-2",
      }, ctx);

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("engine not available");
      }
    });
  });

  describe("migration/transfer", () => {
    it("acknowledges transfer receipt", async () => {
      ticketStore.create({
        migrationId: "mig-1",
        agentId: "agent-1",
        source: { nodeId: "node-1", homeId: "agent-1@node-1", endpoint: "" },
        target: { nodeId: "node-2", homeId: "agent-1@node-2", endpoint: "" },
        reason: "agent_request",
      });

      const handler = handlers.get("migration/transfer")!;
      const resp = await handler({ migrationId: "mig-1" }, ctx);

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.message).toBe("Transfer received");
      }
    });
  });

  describe("migration/run", () => {
    it("returns error when orchestrator is not available", async () => {
      // Default ctx has no migrationOrchestrator, handlers capture ctx at creation
      const handler = handlers.get("migration/run")!;
      const resp = await handler(
        { agentId: "test-agent", targetNodeId: "target-node", reason: "orchestrator_rebalance", _id: "run-1" },
        ctx,
      );

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("orchestrator not available");
      }
    });

    it("returns error for missing agentId", async () => {
      // Create handlers with orchestrator in context
      const ctxWithOrch: MigrationHandlerContext = {
        ...ctx,
        migrationOrchestrator: { run: vi.fn() },
      };
      const orchHandlers = createMigrationHandlers(ctxWithOrch);
      const handler = orchHandlers.get("migration/run")!;

      const resp = await handler(
        { targetNodeId: "target-node", _id: "run-2" },
        ctxWithOrch,
      );

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("agentId");
      }
    });

    it("returns error for invalid reason", async () => {
      const ctxWithOrch: MigrationHandlerContext = {
        ...ctx,
        migrationOrchestrator: { run: vi.fn() },
      };
      const orchHandlers = createMigrationHandlers(ctxWithOrch);
      const handler = orchHandlers.get("migration/run")!;

      const resp = await handler(
        { agentId: "test-agent", targetNodeId: "target-node", reason: "invalid_reason", _id: "run-3" },
        ctxWithOrch,
      );

      expect(isError(resp)).toBe(true);
      if (isError(resp)) {
        expect(resp.error.message).toContain("Invalid migration reason");
      }
    });

    it("delegates to orchestrator and returns success", async () => {
      const mockOrch = {
        run: vi.fn().mockResolvedValue({
          success: true,
          migrationId: "mig-123",
          finalPhase: "COMPLETED",
          warnings: [],
        }),
      };
      const ctxWithOrch: MigrationHandlerContext = {
        ...ctx,
        migrationOrchestrator: mockOrch,
      };
      const orchHandlers = createMigrationHandlers(ctxWithOrch);
      const handler = orchHandlers.get("migration/run")!;

      const resp = await handler(
        { agentId: "test-agent", targetNodeId: "target-node", reason: "orchestrator_rebalance", _id: "run-4" },
        ctxWithOrch,
      );

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.success).toBe(true);
        expect(resp.result.migrationId).toBe("mig-123");
        expect(resp.result.finalPhase).toBe("COMPLETED");
      }
      expect(mockOrch.run).toHaveBeenCalledWith("test-agent", "target-node", "orchestrator_rebalance");
    });

    it("delegates to orchestrator and returns failure", async () => {
      const mockOrch = {
        run: vi.fn().mockResolvedValue({
          success: false,
          migrationId: "mig-456",
          finalPhase: "ABORTED",
          error: "No home found",
        }),
      };
      const ctxWithOrch: MigrationHandlerContext = {
        ...ctx,
        migrationOrchestrator: mockOrch,
      };
      const orchHandlers = createMigrationHandlers(ctxWithOrch);
      const handler = orchHandlers.get("migration/run")!;

      const resp = await handler(
        { agentId: "test-agent", targetNodeId: "target-node", reason: "agent_request", _id: "run-5" },
        ctxWithOrch,
      );

      expect(isSuccess(resp)).toBe(true);
      if (isSuccess(resp)) {
        expect(resp.result.success).toBe(false);
        expect(resp.result.error).toBe("No home found");
        expect(resp.result.finalPhase).toBe("ABORTED");
      }
    });
  });

  describe("handler registration", () => {
    it("registers all 8 migration handlers", () => {
      const expectedMethods = [
        "migration/request",
        "migration/approve",
        "migration/reject",
        "migration/transfer",
        "migration/verify",
        "migration/complete",
        "migration/status",
        "migration/abort",
        "migration/transfer-and-verify",
        "migration/rehydrate",
        "migration/run",
      ];

      for (const method of expectedMethods) {
        expect(handlers.has(method)).toBe(true);
      }
      expect(handlers.size).toBe(11);
    });
  });
});
