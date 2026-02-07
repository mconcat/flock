/**
 * Flock Communication Schema — Prompt-based expectations
 *
 * Instead of runtime field validation, this module provides
 * natural-language descriptions of message type expectations
 * that are injected into agent base prompts.
 *
 * Expectations are loaded from COMMUNICATION.md template file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Message type identifiers (for TaskStore categorization, not validation). */
export type FlockMessageType =
  | "task"
  | "review"
  | "info"
  | "status-update"
  | "general";

/** Per-type expectations describing sender/receiver contracts. */
export interface MessageExpectation {
  description: string;
  senderGuidance: string;
  receiverGuidance: string;
}

/**
 * Parse the COMMUNICATION.md markdown file to extract message type expectations.
 */
function parseExpectationsFromMarkdown(): Record<FlockMessageType, MessageExpectation> {
  const templatePath = path.join(__dirname, "..", "prompts", "templates", "COMMUNICATION.md");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Communication template missing: ${templatePath}`);
  }
  
  const content = fs.readFileSync(templatePath, "utf-8");
  const expectations: Partial<Record<FlockMessageType, MessageExpectation>> = {};
  
  // Split by message type sections (### {type})
  const sections = content.split(/^### /m).filter((s: string) => s.trim());
  
  for (const section of sections) {
    const lines = section.split("\n");
    const firstLine = lines[0]?.trim();
    
    // Extract message type
    const msgType = firstLine as FlockMessageType;
    if (!["task", "review", "info", "status-update", "general"].includes(msgType)) continue;
    
    // Extract description (line starting with >)
    const descLine = lines.find((l: string) => l.trim().startsWith(">"));
    const description = descLine ? descLine.replace(/^>\s*/, "").trim() : "";
    
    // Extract sender guidance (between **As Sender:** and **As Receiver:**)
    const senderStart = lines.findIndex((l: string) => l.includes("**As Sender:**"));
    const receiverStart = lines.findIndex((l: string) => l.includes("**As Receiver:**"));
    const senderGuidance = senderStart >= 0 && receiverStart > senderStart
      ? lines.slice(senderStart + 1, receiverStart)
          .filter((l: string) => !l.trim().startsWith("**") && l.trim() !== "")
          .join("\n")
          .trim()
      : "";
    
    // Extract receiver guidance (between **As Receiver:** and ---)
    const sectionEnd = lines.findIndex((l: string, i: number) => i > receiverStart && l.trim() === "---");
    const receiverGuidance = receiverStart >= 0
      ? lines.slice(receiverStart + 1, sectionEnd >= 0 ? sectionEnd : undefined)
          .filter((l: string) => !l.trim().startsWith("**") && l.trim() !== "" && l.trim() !== "---")
          .join("\n")
          .trim()
      : "";
    
    expectations[msgType] = {
      description,
      senderGuidance,
      receiverGuidance,
    };
  }
  
  return expectations as Record<FlockMessageType, MessageExpectation>;
}

/**
 * Expectations per message type. These describe what sender and receiver
 * should expect from each other — used in agent prompts.
 *
 * Loaded from COMMUNICATION.md template file.
 */
export const MESSAGE_EXPECTATIONS: Record<FlockMessageType, MessageExpectation> = 
  parseExpectationsFromMarkdown();

/** All known message type keys. */
export const MESSAGE_TYPES = Object.keys(MESSAGE_EXPECTATIONS) as FlockMessageType[];

/**
 * Generate the communication expectations section for an agent's base prompt.
 * This gets injected into communication.md or agent system prompts.
 *
 * @returns A formatted markdown string with all message type expectations.
 */
export function generateExpectationsPrompt(): string {
  // Simply load and return the markdown file content
  const templatePath = path.join(__dirname, "..", "prompts", "templates", "COMMUNICATION.md");
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Communication template missing: ${templatePath}`);
  }
  return fs.readFileSync(templatePath, "utf-8");
}
