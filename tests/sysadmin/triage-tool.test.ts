import { describe, it, expect, beforeEach } from "vitest";
import {
  createTriageDecisionTool,
  popTriageCapture,
  toTriageResult,
  _getCaptureStoreSize,
} from "../../src/sysadmin/triage-tool.js";

describe("triage-tool", () => {
  describe("createTriageDecisionTool", () => {
    const tool = createTriageDecisionTool();

    it("has correct name", () => {
      expect(tool.name).toBe("triage_decision");
    });

    it("requires request_id, level, reasoning, action_plan", () => {
      expect(tool.parameters.required).toEqual(
        ["request_id", "level", "reasoning", "action_plan"],
      );
    });

    it("captures GREEN triage in store", async () => {
      const result = await tool.execute("test-call-id", {
        request_id: "test-green-1",
        level: "GREEN",
        reasoning: "Read-only operation",
        action_plan: "Execute df -h /tmp",
        risk_factors: [],
      });

      expect(result.details?.ok).toBe(true);
      expect(result.content[0].text).toContain("GREEN");

      const captured = popTriageCapture("test-green-1");
      expect(captured).not.toBeNull();
      expect(captured!.level).toBe("GREEN");
      expect(captured!.reasoning).toBe("Read-only operation");
      expect(captured!.action_plan).toBe("Execute df -h /tmp");
    });

    it("captures RED triage with risk factors", async () => {
      await tool.execute("test-call-id", {
        request_id: "test-red-1",
        level: "RED",
        reasoning: "Destructive operation",
        action_plan: "Requires human approval",
        risk_factors: ["data-loss", "irreversible"],
      });

      const captured = popTriageCapture("test-red-1");
      expect(captured!.level).toBe("RED");
      expect(captured!.risk_factors).toEqual(["data-loss", "irreversible"]);
    });

    it("rejects missing request_id", async () => {
      const result = await tool.execute("test-call-id", {
        level: "GREEN",
        reasoning: "test",
        action_plan: "test",
      });

      expect(result.details?.ok).toBe(false);
      expect(result.content[0].text).toContain("request_id");
    });

    it("rejects invalid level", async () => {
      const result = await tool.execute("test-call-id", {
        request_id: "test-invalid-1",
        level: "BLUE",
        reasoning: "test",
        action_plan: "test",
      });

      expect(result.details?.ok).toBe(false);
    });

    it("normalizes level to uppercase", async () => {
      await tool.execute("test-call-id", {
        request_id: "test-case-1",
        level: "yellow",
        reasoning: "moderate risk",
        action_plan: "execute with logging",
      });

      const captured = popTriageCapture("test-case-1");
      expect(captured!.level).toBe("YELLOW");
    });

    it("handles missing optional risk_factors", async () => {
      await tool.execute("test-call-id", {
        request_id: "test-no-risk-1",
        level: "GREEN",
        reasoning: "safe",
        action_plan: "do it",
      });

      const captured = popTriageCapture("test-no-risk-1");
      expect(captured!.risk_factors).toEqual([]);
    });
  });

  describe("popTriageCapture", () => {
    const tool = createTriageDecisionTool();

    it("returns null for unknown request ID", () => {
      expect(popTriageCapture("nonexistent")).toBeNull();
    });

    it("removes capture after pop (single read)", async () => {
      await tool.execute("test-call-id", {
        request_id: "test-pop-1",
        level: "GREEN",
        reasoning: "test",
        action_plan: "test",
      });

      const first = popTriageCapture("test-pop-1");
      expect(first).not.toBeNull();

      const second = popTriageCapture("test-pop-1");
      expect(second).toBeNull();
    });
  });

  describe("toTriageResult", () => {
    it("converts GREEN to non-approval result", () => {
      const result = toTriageResult({
        level: "GREEN",
        reasoning: "Safe operation",
        action_plan: "Execute the command",
        risk_factors: [],
      });

      expect(result.level).toBe("GREEN");
      expect(result.action).toBe("Execute the command");
      expect(result.reasoning).toBe("Safe operation");
      expect(result.requiresHumanApproval).toBe(false);
      expect(result.riskFactors).toBeUndefined();
    });

    it("converts RED to approval-required result with risk factors", () => {
      const result = toTriageResult({
        level: "RED",
        reasoning: "Dangerous",
        action_plan: "Need human review",
        risk_factors: ["data-loss"],
      });

      expect(result.level).toBe("RED");
      expect(result.requiresHumanApproval).toBe(true);
      expect(result.riskFactors).toEqual(["data-loss"]);
    });

    it("YELLOW does not require human approval", () => {
      const result = toTriageResult({
        level: "YELLOW",
        reasoning: "Moderate risk",
        action_plan: "Execute with logging",
        risk_factors: ["config-change"],
      });

      expect(result.requiresHumanApproval).toBe(false);
    });
  });
});
