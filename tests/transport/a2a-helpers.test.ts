import { describe, it, expect } from "vitest";
import {
  textPart,
  dataPart,
  agentMessage,
  userMessage,
  artifact,
  task,
  taskStatus,
  extractText,
  extractData,
  extractTaskText,
} from "../../src/transport/a2a-helpers.js";

describe("a2a-helpers", () => {
  describe("textPart()", () => {
    it("creates TextPart with kind 'text'", () => {
      const p = textPart("hello");
      expect(p.kind).toBe("text");
      expect(p.text).toBe("hello");
    });

    it("includes metadata when provided", () => {
      const p = textPart("hi", { source: "test" });
      expect(p.metadata).toEqual({ source: "test" });
    });

    it("omits metadata when not provided", () => {
      const p = textPart("hi");
      expect(p).not.toHaveProperty("metadata");
    });
  });

  describe("dataPart()", () => {
    it("creates DataPart with kind 'data'", () => {
      const p = dataPart({ key: "value" });
      expect(p.kind).toBe("data");
      expect(p.data).toEqual({ key: "value" });
    });

    it("accepts plain objects (not just Record<string, unknown>)", () => {
      const obj = { flockType: "sysadmin-request", urgency: "high" };
      const p = dataPart(obj);
      expect(p.data).toEqual({ flockType: "sysadmin-request", urgency: "high" });
    });

    it("includes metadata when provided", () => {
      const p = dataPart({ a: 1 }, { tag: "test" });
      expect(p.metadata).toEqual({ tag: "test" });
    });

    it("omits metadata when not provided", () => {
      const p = dataPart({ a: 1 });
      expect(p).not.toHaveProperty("metadata");
    });
  });

  describe("agentMessage()", () => {
    it("creates Message with kind 'message' and role 'agent'", () => {
      const msg = agentMessage("hello from agent");
      expect(msg.kind).toBe("message");
      expect(msg.role).toBe("agent");
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0].kind).toBe("text");
    });

    it("has a unique messageId", () => {
      const msg1 = agentMessage("first");
      const msg2 = agentMessage("second");
      expect(msg1.messageId).toBeTruthy();
      expect(msg2.messageId).toBeTruthy();
      expect(msg1.messageId).not.toBe(msg2.messageId);
    });
  });

  describe("userMessage()", () => {
    it("creates Message with kind 'message' and role 'user'", () => {
      const msg = userMessage("hello from user");
      expect(msg.kind).toBe("message");
      expect(msg.role).toBe("user");
      expect(msg.parts).toHaveLength(1);
    });

    it("appends extraParts when provided", () => {
      const extra = dataPart({ info: true });
      const msg = userMessage("hello", [extra]);
      expect(msg.parts).toHaveLength(2);
      expect(msg.parts[0].kind).toBe("text");
      expect(msg.parts[1].kind).toBe("data");
    });

    it("has a unique messageId", () => {
      const a = userMessage("a");
      const b = userMessage("b");
      expect(a.messageId).not.toBe(b.messageId);
    });
  });

  describe("artifact()", () => {
    it("creates Artifact with unique artifactId", () => {
      const a1 = artifact("response", [textPart("hello")]);
      const a2 = artifact("response", [textPart("world")]);
      expect(a1.artifactId).toBeTruthy();
      expect(a2.artifactId).toBeTruthy();
      expect(a1.artifactId).not.toBe(a2.artifactId);
    });

    it("includes name and parts", () => {
      const a = artifact("my-artifact", [textPart("data")]);
      expect(a.name).toBe("my-artifact");
      expect(a.parts).toHaveLength(1);
    });

    it("includes description when provided", () => {
      const a = artifact("named", [textPart("x")], "A description");
      expect(a.description).toBe("A description");
    });

    it("omits description when not provided", () => {
      const a = artifact("named", [textPart("x")]);
      expect(a).not.toHaveProperty("description");
    });
  });

  describe("task()", () => {
    it("creates Task with kind 'task'", () => {
      const t = task("task-1", "ctx-1", taskStatus("completed", "done"));
      expect(t.kind).toBe("task");
      expect(t.id).toBe("task-1");
      expect(t.contextId).toBe("ctx-1");
      expect(t.status.state).toBe("completed");
    });

    it("includes artifacts when provided", () => {
      const arts = [artifact("result", [textPart("output")])];
      const t = task("task-2", "ctx-2", taskStatus("completed"), arts);
      expect(t.artifacts).toHaveLength(1);
      expect(t.artifacts![0].name).toBe("result");
    });

    it("omits artifacts when not provided", () => {
      const t = task("task-3", "ctx-3", taskStatus("working"));
      expect(t).not.toHaveProperty("artifacts");
    });
  });

  describe("extractText()", () => {
    it("extracts text from TextParts in a message", () => {
      const msg = agentMessage("line one");
      expect(extractText(msg)).toBe("line one");
    });

    it("joins multiple TextParts with newline", () => {
      const msg = userMessage("first", [textPart("second")]);
      expect(extractText(msg)).toBe("first\nsecond");
    });

    it("ignores DataParts", () => {
      const msg = userMessage("text", [dataPart({ x: 1 })]);
      expect(extractText(msg)).toBe("text");
    });
  });

  describe("extractData()", () => {
    it("extracts first DataPart from message", () => {
      const msg = userMessage("hello", [dataPart({ val: 42 })]);
      expect(extractData(msg)).toEqual({ val: 42 });
    });

    it("returns null when no DataPart present", () => {
      const msg = agentMessage("just text");
      expect(extractData(msg)).toBeNull();
    });
  });

  describe("extractTaskText()", () => {
    it("extracts text from task status message", () => {
      const t = task("t1", "c1", taskStatus("completed", "done!"));
      expect(extractTaskText(t)).toBe("done!");
    });

    it("extracts text from artifacts if no status message text", () => {
      const arts = [artifact("r", [textPart("from artifact")])];
      const t = task("t2", "c2", taskStatus("completed"), arts);
      expect(extractTaskText(t)).toBe("from artifact");
    });

    it("returns fallback when no text found", () => {
      const t = task("t3", "c3", taskStatus("working"));
      expect(extractTaskText(t)).toBe("Task t3 [working]");
    });
  });
});
