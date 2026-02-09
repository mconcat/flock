import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFlockExecutor } from "../../src/transport/executor.js";
import type { SessionSendFn, FlockExecutorParams } from "../../src/transport/executor.js";
import type { FlockCardMetadata } from "../../src/transport/types.js";
import type { PluginLogger } from "../../src/types.js";
import { userMessage, dataPart } from "../../src/transport/a2a-helpers.js";
import type { RequestContext, ExecutionEventBus } from "@a2a-js/sdk/server";
import type { Task, Message } from "@a2a-js/sdk";

// Import the capture store for simulating tool calls
import { popTriageCapture, _getCaptureStoreSize } from "../../src/sysadmin/triage-tool.js";

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

type AgentExecutionEvent = Message | Task;

function makeEventBus(): ExecutionEventBus & { events: AgentExecutionEvent[]; done: boolean } {
  const events: AgentExecutionEvent[] = [];
  let done = false;
  return {
    events,
    get done() { return done; },
    publish(event: AgentExecutionEvent) { events.push(event); },
    finished() { done = true; },
    on() { return this; },
    off() { return this; },
    once() { return this; },
    removeAllListeners() { return this; },
  };
}

function makeRequestContext(text: string, extraData?: object): RequestContext {
  const msg = extraData
    ? userMessage(text, [dataPart(extraData)])
    : userMessage(text);

  return {
    userMessage: msg,
    taskId: "test-task-1",
    contextId: "test-ctx-1",
  } as RequestContext;
}

/**
 * Simulate the triage_decision tool being called by the agent.
 * In production, the LLM calls the tool which populates the capture store.
 * In tests, we populate it directly via the tool's execute function.
 */
async function simulateTriageToolCall(
  requestId: string,
  level: "GREEN" | "YELLOW" | "RED",
  reasoning: string,
  action_plan: string,
  risk_factors: string[] = [],
): Promise<void> {
  // Import the tool creator and call execute directly
  const { createTriageDecisionTool } = await import("../../src/sysadmin/triage-tool.js");
  const tool = createTriageDecisionTool();
  await tool.execute(
    "test-call-id",
    { request_id: requestId, level, reasoning, action_plan, risk_factors }
  );
}

describe("executor", () => {
  const workerMeta: FlockCardMetadata = {
    role: "worker",
    nodeId: "node-1",
    homeId: "worker-1@node-1",
  };

  const sysadminMeta: FlockCardMetadata = {
    role: "sysadmin",
    nodeId: "node-1",
    homeId: "sysadmin@node-1",
  };

  describe("execute with text message", () => {
    it("completes task with response artifact", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("Hello from agent!");
      const logger = makeLogger();
      const executor = createFlockExecutor({ flockMeta: workerMeta, sessionSend, logger });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("Do something");

      await executor.execute(ctx, eventBus);

      // Should have published: working + completed
      expect(eventBus.events.length).toBeGreaterThanOrEqual(2);
      expect(eventBus.done).toBe(true);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("completed");
      expect(lastEvent.artifacts).toBeDefined();
      expect(lastEvent.artifacts!.length).toBeGreaterThanOrEqual(1);
      expect(lastEvent.artifacts![0].name).toBe("response");
    });

    it("calls sessionSend with the agent ID", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(makeRequestContext("hello"), makeEventBus());
      expect(sessionSend).toHaveBeenCalledWith("worker-1", expect.any(String), undefined);
    });
  });

  describe("session routing", () => {
    it("passes sessionKey when sessionRouting is in DataPart", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("hello", {
          sessionRouting: { chatType: "channel", peerId: "project-alpha" },
        }),
        makeEventBus(),
      );

      expect(sessionSend).toHaveBeenCalledWith(
        "worker-1",
        expect.any(String),
        "agent:worker-1:flock:channel:project-alpha",
      );
    });

    it("passes DM session key for dm chatType", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("hey", {
          sessionRouting: { chatType: "dm", peerId: "pm" },
        }),
        makeEventBus(),
      );

      expect(sessionSend).toHaveBeenCalledWith(
        "worker-1",
        expect.any(String),
        "agent:worker-1:flock:dm:pm",
      );
    });

    it("passes undefined sessionKey when no sessionRouting", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(makeRequestContext("hello"), makeEventBus());

      expect(sessionSend).toHaveBeenCalledWith("worker-1", expect.any(String), undefined);
    });

    it("ignores invalid sessionRouting (missing fields)", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("hello", {
          sessionRouting: { chatType: "channel" }, // missing peerId
        }),
        makeEventBus(),
      );

      expect(sessionSend).toHaveBeenCalledWith("worker-1", expect.any(String), undefined);
    });

    it("ignores non-object sessionRouting", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("hello", {
          sessionRouting: "not-an-object" as any,
        }),
        makeEventBus(),
      );

      expect(sessionSend).toHaveBeenCalledWith("worker-1", expect.any(String), undefined);
    });

    it("sessionRouting coexists with flockType metadata", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("do work", {
          flockType: "worker-task",
          sessionRouting: { chatType: "channel", peerId: "builds" },
        }),
        makeEventBus(),
      );

      expect(sessionSend).toHaveBeenCalledWith(
        "worker-1",
        expect.any(String),
        "agent:worker-1:flock:channel:builds",
      );
    });
  });

  describe("execute with sysadmin triage (tool-based capture)", () => {
    it("creates triage-result artifact when tool was called", async () => {
      // sessionSend simulates the agent calling triage_decision tool
      // by populating the capture store before returning
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          // Extract request-id from metadata header
          const match = message.match(/request-id: (triage-[^\s\]]+)/);
          const requestId = match?.[1];
          if (requestId) {
            await simulateTriageToolCall(
              requestId, "GREEN",
              "Read-only disk check. Zero blast radius.",
              "Execute df -h /tmp and return results.",
            );
          }
          return "🟢 Triage classification recorded: GREEN\n\nDisk usage on /tmp: 45% used.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("Check disk usage on /tmp", {
        flockType: "sysadmin-request",
        urgency: "normal",
      });

      await executor.execute(ctx, eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("completed");
      expect(lastEvent.artifacts).toBeDefined();
      expect(lastEvent.artifacts![0].name).toBe("triage-result");
    });

    it("triage-result artifact contains structured data", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          const match = message.match(/request-id: (triage-[^\s\]]+)/);
          if (match?.[1]) {
            await simulateTriageToolCall(
              match[1], "GREEN",
              "Safe read-only operation.",
              "List running processes.",
            );
          }
          return "Done.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("List processes", {
        flockType: "sysadmin-request",
      });

      await executor.execute(ctx, eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      const triageArt = lastEvent.artifacts!.find(a => a.name === "triage-result")!;
      const data = triageArt.parts.find(p => (p as any).kind === "data") as any;

      expect(data.data.level).toBe("GREEN");
      expect(data.data.action).toBe("List running processes.");
      expect(data.data.reasoning).toBe("Safe read-only operation.");
      expect(data.data.requiresHumanApproval).toBe(false);
    });

    it("RED triage sets requiresHumanApproval and riskFactors", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          const match = message.match(/request-id: (triage-[^\s\]]+)/);
          if (match?.[1]) {
            await simulateTriageToolCall(
              match[1], "RED",
              "Destructive and irreversible. Targets system-critical paths.",
              "Human must evaluate before any action.",
              ["data-loss", "security-degradation", "irreversible"],
            );
          }
          return "🔴 Blocked. Awaiting human approval.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("Delete /var/lib and disable firewall", {
        flockType: "sysadmin-request",
      });

      await executor.execute(ctx, eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      const data = lastEvent.artifacts![0].parts.find(p => (p as any).kind === "data") as any;

      expect(data.data.level).toBe("RED");
      expect(data.data.requiresHumanApproval).toBe(true);
      expect(data.data.riskFactors).toEqual(["data-loss", "security-degradation", "irreversible"]);
    });

    it("succeeds as White when agent does not call triage_decision tool", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue(
        "Your node has 16 cores, 64GB RAM, and 2 GPUs available.",
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("What are the node specs?", {
        flockType: "sysadmin-request",
      });

      await executor.execute(ctx, eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("completed");
      // White: normal response artifact, not triage-result
      expect(lastEvent.artifacts).toBeDefined();
      expect(lastEvent.artifacts![0].name).toBe("response");
    });

    it("prompt includes metadata context with request-id for sysadmin-request", async () => {
      let capturedMessage = "";
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          capturedMessage = message;
          // Agent decides to triage — extract request-id from metadata header
          const match = message.match(/request-id: (triage-[^\s\]]+)/);
          if (match?.[1]) {
            await simulateTriageToolCall(match[1], "GREEN", "ok", "ok");
          }
          return "Done.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("test", {
          flockType: "sysadmin-request",
          fromHome: "worker-alpha@node-2",
          urgency: "normal",
        }),
        makeEventBus(),
      );

      // Metadata header with request-id (no triage instructions)
      expect(capturedMessage).toContain("request-id: triage-");
      expect(capturedMessage).toContain("from: worker-alpha@node-2");
      expect(capturedMessage).toContain("urgency: normal");
      // No triage instructions in the prompt
      expect(capturedMessage).not.toContain("triage_decision");
      expect(capturedMessage).not.toContain("SYSADMIN TRIAGE REQUEST");
      expect(capturedMessage).toContain("test"); // original message preserved
    });

    it("sysadmin receives raw text for non-sysadmin-request messages", async () => {
      let capturedMessage = "";
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          capturedMessage = message;
          return "I am the sysadmin for node-1.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();
      // No flockType — direct user message
      const ctx = makeRequestContext("Who are you?");

      await executor.execute(ctx, eventBus);

      // Raw text, no metadata header, no triage wrapper
      expect(capturedMessage).toBe("Who are you?");
      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("completed");
      expect(lastEvent.artifacts![0].name).toBe("response");
    });
  });

  describe("timeout handling", () => {
    it("fails task when sessionSend never resolves", async () => {
      const neverResolve: SessionSendFn = () => new Promise(() => {});
      const logger = makeLogger();
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend: neverResolve,
        logger,
        responseTimeoutMs: 50,
      });
      const eventBus = makeEventBus();
      const ctx = makeRequestContext("do something");

      await executor.execute(ctx, eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("failed");
      expect(eventBus.done).toBe(true);
    });

    it("fails task when sessionSend returns null", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue(null);
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
        responseTimeoutMs: 100,
      });
      const eventBus = makeEventBus();

      await executor.execute(makeRequestContext("test"), eventBus);

      const lastEvent = eventBus.events[eventBus.events.length - 1] as Task;
      expect(lastEvent.status.state).toBe("failed");
    });
  });

  describe("cancelTask", () => {
    it("publishes canceled task", async () => {
      const sessionSend: SessionSendFn = vi.fn().mockResolvedValue("ok");
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend,
        logger: makeLogger(),
      });
      const eventBus = makeEventBus();

      await executor.cancelTask!("cancel-task-1", eventBus);

      expect(eventBus.events).toHaveLength(1);
      const event = eventBus.events[0] as Task;
      expect(event.status.state).toBe("canceled");
      expect(eventBus.done).toBe(true);
    });
  });

  describe("audit integration", () => {
    function makeAudit() {
      const entries: Array<Record<string, unknown>> = [];
      return {
        entries,
        append: vi.fn((entry: Record<string, unknown>) => entries.push(entry)),
        query: vi.fn().mockReturnValue([]),
        recent: vi.fn().mockReturnValue([]),
        count: vi.fn().mockReturnValue(0),
      };
    }

    it("records GREEN audit entry on successful worker task", async () => {
      const audit = makeAudit();
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend: vi.fn().mockResolvedValue("Done."),
        audit,
        logger: makeLogger(),
      });

      await executor.execute(makeRequestContext("do something"), makeEventBus());

      expect(audit.append).toHaveBeenCalledOnce();
      const entry = audit.entries[0];
      expect(entry.level).toBe("GREEN");
      expect(entry.result).toBe("completed");
      expect(entry.action).toBe("a2a-message");
      expect(entry.duration).toBeGreaterThanOrEqual(0);
    });

    it("records triage level in audit for sysadmin requests", async () => {
      const audit = makeAudit();
      const sessionSend: SessionSendFn = vi.fn().mockImplementation(
        async (_agentId: string, message: string) => {
          const match = message.match(/request-id: (triage-[^\s\]]+)/);
          if (match?.[1]) {
            await simulateTriageToolCall(
              match[1], "RED",
              "Dangerous operation",
              "Blocked",
              ["data-loss"],
            );
          }
          return "Blocked.";
        },
      );

      const executor = createFlockExecutor({
        flockMeta: sysadminMeta,
        sessionSend,
        audit,
        logger: makeLogger(),
      });

      await executor.execute(
        makeRequestContext("delete everything", {
          flockType: "sysadmin-request",
          fromHome: "alice@node-1",
        }),
        makeEventBus(),
      );

      expect(audit.append).toHaveBeenCalledOnce();
      const entry = audit.entries[0];
      expect(entry.level).toBe("RED");
      expect(entry.result).toBe("completed");
      expect(entry.agentId).toBe("alice@node-1");
      expect(entry.action).toBe("sysadmin-request");
    });

    it("records RED audit entry on task failure", async () => {
      const audit = makeAudit();
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend: vi.fn().mockResolvedValue(null),
        audit,
        logger: makeLogger(),
        responseTimeoutMs: 100,
      });

      await executor.execute(makeRequestContext("test"), makeEventBus());

      expect(audit.append).toHaveBeenCalledOnce();
      const entry = audit.entries[0];
      expect(entry.level).toBe("RED");
      expect(entry.result).toBe("failed");
      expect(entry.detail).toContain("FAILED");
    });

    it("records YELLOW audit entry on task cancellation", async () => {
      const audit = makeAudit();
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend: vi.fn(),
        audit,
        logger: makeLogger(),
      });

      await executor.cancelTask!("cancel-1", makeEventBus());

      expect(audit.append).toHaveBeenCalledOnce();
      const entry = audit.entries[0];
      expect(entry.level).toBe("YELLOW");
      expect(entry.result).toBe("canceled");
    });

    it("works fine without audit (optional)", async () => {
      const executor = createFlockExecutor({
        flockMeta: workerMeta,
        sessionSend: vi.fn().mockResolvedValue("ok"),
        // no audit
        logger: makeLogger(),
      });

      // Should not throw
      await executor.execute(makeRequestContext("test"), makeEventBus());
    });
  });
});
