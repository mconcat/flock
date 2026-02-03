import { describe, it, expect } from "vitest";
import { buildFlockMessage, extractFlockMeta } from "../../src/communication/envelope.js";
import type { Part, DataPart, TextPart } from "@a2a-js/sdk";

describe("communication/envelope", () => {
  describe("buildFlockMessage()", () => {
    it("builds a message with text only (no meta, no extra)", () => {
      const params = buildFlockMessage("Hello agent");
      expect(params.message).toBeDefined();
      expect(params.message.role).toBe("user");
      expect(params.message.parts).toHaveLength(1);

      const textP = params.message.parts[0] as TextPart;
      expect(textP.kind).toBe("text");
      expect(textP.text).toBe("Hello agent");
    });

    it("includes Flock metadata as a DataPart when meta provided", () => {
      const params = buildFlockMessage("Implement feature X", {
        flockType: "worker-task",
        urgency: "high",
        project: "auth-service",
      });

      expect(params.message.parts).toHaveLength(2);

      const textP = params.message.parts[0] as TextPart;
      expect(textP.kind).toBe("text");
      expect(textP.text).toBe("Implement feature X");

      const dataP = params.message.parts[1] as DataPart;
      expect(dataP.kind).toBe("data");
      expect(dataP.data.flockMeta).toEqual({
        flockType: "worker-task",
        urgency: "high",
        project: "auth-service",
      });
    });

    it("includes extra data alongside flock metadata", () => {
      const params = buildFlockMessage(
        "Check this",
        { flockType: "review" },
        { commitSha: "abc123", branch: "main" },
      );

      const dataP = params.message.parts[1] as DataPart;
      expect(dataP.data.flockMeta).toEqual({ flockType: "review" });
      expect(dataP.data.commitSha).toBe("abc123");
      expect(dataP.data.branch).toBe("main");
    });

    it("includes extra data without flock metadata", () => {
      const params = buildFlockMessage("FYI", undefined, {
        ref: "doc-link",
      });

      expect(params.message.parts).toHaveLength(2);
      const dataP = params.message.parts[1] as DataPart;
      expect(dataP.data.ref).toBe("doc-link");
      expect(dataP.data.flockMeta).toBeUndefined();
    });

    it("does not add DataPart when both meta and extraData are undefined", () => {
      const params = buildFlockMessage("Plain message");
      expect(params.message.parts).toHaveLength(1);
      expect(params.message.parts[0].kind).toBe("text");
    });
  });

  describe("extractFlockMeta()", () => {
    it("extracts flock metadata from a DataPart", () => {
      const parts: Part[] = [
        { kind: "text", text: "Hello" },
        {
          kind: "data",
          data: {
            flockMeta: {
              flockType: "worker-task",
              urgency: "normal",
            },
          },
        },
      ];

      const meta = extractFlockMeta(parts);
      expect(meta).not.toBeNull();
      expect(meta!.flockType).toBe("worker-task");
      expect(meta!.urgency).toBe("normal");
    });

    it("returns null when no DataPart has flockMeta", () => {
      const parts: Part[] = [
        { kind: "text", text: "Hello" },
        { kind: "data", data: { someOtherField: true } },
      ];

      const meta = extractFlockMeta(parts);
      expect(meta).toBeNull();
    });

    it("returns null for empty parts array", () => {
      const meta = extractFlockMeta([]);
      expect(meta).toBeNull();
    });

    it("returns null when parts only contain TextParts", () => {
      const parts: Part[] = [
        { kind: "text", text: "Just text" },
      ];

      const meta = extractFlockMeta(parts);
      expect(meta).toBeNull();
    });

    it("returns the first matching flockMeta when multiple DataParts exist", () => {
      const parts: Part[] = [
        {
          kind: "data",
          data: { flockMeta: { flockType: "review" } },
        },
        {
          kind: "data",
          data: { flockMeta: { flockType: "worker-task" } },
        },
      ];

      const meta = extractFlockMeta(parts);
      expect(meta).not.toBeNull();
      expect(meta!.flockType).toBe("review");
    });

    it("roundtrips with buildFlockMessage", () => {
      const params = buildFlockMessage("Test roundtrip", {
        flockType: "sysadmin-request",
        urgency: "high",
        project: "infra",
        fromHome: "worker-1@node-a",
      });

      const meta = extractFlockMeta(params.message.parts);
      expect(meta).not.toBeNull();
      expect(meta!.flockType).toBe("sysadmin-request");
      expect(meta!.urgency).toBe("high");
      expect(meta!.project).toBe("infra");
      expect(meta!.fromHome).toBe("worker-1@node-a");
    });
  });
});
