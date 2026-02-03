import { describe, it, expect } from "vitest";
import {
  MESSAGE_EXPECTATIONS,
  MESSAGE_TYPES,
  generateExpectationsPrompt,
} from "../../src/communication/schema.js";
import type { FlockMessageType } from "../../src/communication/schema.js";

describe("communication/schema", () => {
  describe("MESSAGE_EXPECTATIONS", () => {
    it("covers all declared message types", () => {
      const expectedTypes: FlockMessageType[] = [
        "task",
        "review",
        "info",
        "status-update",
        "general",
      ];
      for (const t of expectedTypes) {
        expect(MESSAGE_EXPECTATIONS[t]).toBeDefined();
        expect(MESSAGE_EXPECTATIONS[t].description).toBeTruthy();
        expect(MESSAGE_EXPECTATIONS[t].senderGuidance).toBeTruthy();
        expect(MESSAGE_EXPECTATIONS[t].receiverGuidance).toBeTruthy();
      }
    });

    it("has non-empty strings for every field", () => {
      for (const msgType of MESSAGE_TYPES) {
        const exp = MESSAGE_EXPECTATIONS[msgType];
        expect(exp.description.length).toBeGreaterThan(0);
        expect(exp.senderGuidance.length).toBeGreaterThan(0);
        expect(exp.receiverGuidance.length).toBeGreaterThan(0);
      }
    });
  });

  describe("MESSAGE_TYPES", () => {
    it("is an array of all message type keys", () => {
      expect(MESSAGE_TYPES).toEqual(
        expect.arrayContaining(["task", "review", "info", "status-update", "general"]),
      );
      expect(MESSAGE_TYPES).toHaveLength(5);
    });
  });

  describe("generateExpectationsPrompt()", () => {
    it("returns a non-empty string", () => {
      const prompt = generateExpectationsPrompt();
      expect(prompt.length).toBeGreaterThan(0);
    });

    it("starts with a markdown heading", () => {
      const prompt = generateExpectationsPrompt();
      expect(prompt).toMatch(/^## Message Type Expectations/);
    });

    it("includes all message type names as sub-headings", () => {
      const prompt = generateExpectationsPrompt();
      for (const msgType of MESSAGE_TYPES) {
        expect(prompt).toContain(`### ${msgType}`);
      }
    });

    it("includes sender and receiver labels", () => {
      const prompt = generateExpectationsPrompt();
      expect(prompt).toContain("**As Sender:**");
      expect(prompt).toContain("**As Receiver:**");
    });

    it("includes guidance text from expectations", () => {
      const prompt = generateExpectationsPrompt();
      // Check that actual guidance content appears
      expect(prompt).toContain("acceptance criteria");
      expect(prompt).toContain("flock_task_respond");
      expect(prompt).toContain("blocking issues");
    });

    it("produces valid markdown with section separators", () => {
      const prompt = generateExpectationsPrompt();
      // Each type section ends with ---
      const separators = prompt.match(/^---$/gm);
      expect(separators).not.toBeNull();
      expect(separators!.length).toBe(MESSAGE_TYPES.length);
    });
  });
});
