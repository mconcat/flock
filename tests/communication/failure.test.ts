import { describe, it, expect } from "vitest";
import { handleSystemFailure } from "../../src/communication/failure.js";
import type {
  SystemFailureContext,
  SystemFailureResult,
} from "../../src/communication/failure.js";

describe("communication/failure", () => {
  describe("timeout", () => {
    it("retries on first timeout (attemptCount < maxRetries)", () => {
      const result = handleSystemFailure({
        kind: "timeout",
        targetAgentId: "worker-alpha",
        attemptCount: 1,
        maxRetries: 2,
      });

      expect(result.shouldRetry).toBe(true);
      expect(result.callerNotification).toBeUndefined();
      expect(result.auditLevel).toBe("YELLOW");
      expect(result.auditDetail).toContain("worker-alpha");
      expect(result.auditDetail).toContain("retrying");
    });

    it("gives up after reaching maxRetries", () => {
      const result = handleSystemFailure({
        kind: "timeout",
        targetAgentId: "worker-alpha",
        attemptCount: 2,
        maxRetries: 2,
      });

      expect(result.shouldRetry).toBe(false);
      expect(result.callerNotification).toBeDefined();
      expect(result.callerNotification).toContain("worker-alpha");
      expect(result.callerNotification).toContain("timed out");
      expect(result.callerNotification).toContain("flock_discover");
      expect(result.auditLevel).toBe("YELLOW");
    });

    it("uses default maxRetries of 2 when not specified", () => {
      // attemptCount 1 < default 2 → should retry
      const result1 = handleSystemFailure({
        kind: "timeout",
        targetAgentId: "agent-1",
        attemptCount: 1,
      });
      expect(result1.shouldRetry).toBe(true);

      // attemptCount 2 >= default 2 → should give up
      const result2 = handleSystemFailure({
        kind: "timeout",
        targetAgentId: "agent-1",
        attemptCount: 2,
      });
      expect(result2.shouldRetry).toBe(false);
    });
  });

  describe("agent-unavailable", () => {
    it("never retries — notifies caller immediately", () => {
      const result = handleSystemFailure({
        kind: "agent-unavailable",
        targetAgentId: "worker-beta",
        attemptCount: 1,
      });

      expect(result.shouldRetry).toBe(false);
      expect(result.callerNotification).toBeDefined();
      expect(result.callerNotification).toContain("worker-beta");
      expect(result.callerNotification).toContain("unavailable");
      expect(result.auditLevel).toBe("RED");
    });

    it("includes error detail when provided", () => {
      const result = handleSystemFailure({
        kind: "agent-unavailable",
        targetAgentId: "worker-beta",
        errorDetail: "ECONNREFUSED",
        attemptCount: 1,
      });

      expect(result.callerNotification).toContain("ECONNREFUSED");
      expect(result.auditDetail).toContain("ECONNREFUSED");
    });
  });

  describe("internal-error", () => {
    it("never retries — notifies caller and logs", () => {
      const result = handleSystemFailure({
        kind: "internal-error",
        targetAgentId: "sysadmin",
        errorDetail: "JSON parse failure",
        attemptCount: 1,
      });

      expect(result.shouldRetry).toBe(false);
      expect(result.callerNotification).toBeDefined();
      expect(result.callerNotification).toContain("sysadmin");
      expect(result.callerNotification).toContain("Internal error");
      expect(result.callerNotification).toContain("JSON parse failure");
      expect(result.auditLevel).toBe("RED");
      expect(result.auditDetail).toContain("JSON parse failure");
    });

    it("works without error detail", () => {
      const result = handleSystemFailure({
        kind: "internal-error",
        targetAgentId: "sysadmin",
        attemptCount: 1,
      });

      expect(result.shouldRetry).toBe(false);
      expect(result.callerNotification).toBeDefined();
      expect(result.auditLevel).toBe("RED");
    });
  });

  describe("max-retries", () => {
    it("never retries — notifies caller target is unresponsive", () => {
      const result = handleSystemFailure({
        kind: "max-retries",
        targetAgentId: "worker-gamma",
        attemptCount: 5,
      });

      expect(result.shouldRetry).toBe(false);
      expect(result.callerNotification).toBeDefined();
      expect(result.callerNotification).toContain("worker-gamma");
      expect(result.callerNotification).toContain("Maximum retries");
      expect(result.callerNotification).toContain("5");
      expect(result.auditLevel).toBe("RED");
    });
  });

  describe("common properties", () => {
    it("all non-retry results include callerNotification", () => {
      const cases: SystemFailureContext[] = [
        { kind: "timeout", targetAgentId: "a", attemptCount: 2, maxRetries: 2 },
        { kind: "agent-unavailable", targetAgentId: "b", attemptCount: 1 },
        { kind: "internal-error", targetAgentId: "c", attemptCount: 1 },
        { kind: "max-retries", targetAgentId: "d", attemptCount: 3 },
      ];

      for (const ctx of cases) {
        const result = handleSystemFailure(ctx);
        if (!result.shouldRetry) {
          expect(result.callerNotification).toBeDefined();
          expect(result.callerNotification!.length).toBeGreaterThan(0);
        }
      }
    });

    it("all results have auditLevel and auditDetail", () => {
      const cases: SystemFailureContext[] = [
        { kind: "timeout", targetAgentId: "a", attemptCount: 1 },
        { kind: "agent-unavailable", targetAgentId: "b", attemptCount: 1 },
        { kind: "internal-error", targetAgentId: "c", attemptCount: 1 },
        { kind: "max-retries", targetAgentId: "d", attemptCount: 3 },
      ];

      const validLevels = ["GREEN", "YELLOW", "RED"];
      for (const ctx of cases) {
        const result = handleSystemFailure(ctx);
        expect(validLevels).toContain(result.auditLevel);
        expect(result.auditDetail.length).toBeGreaterThan(0);
      }
    });
  });
});
