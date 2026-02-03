/**
 * Flock Communication Schema — Prompt-based expectations
 *
 * Instead of runtime field validation, this module provides
 * natural-language descriptions of message type expectations
 * that are injected into agent base prompts.
 */

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
 * Expectations per message type. These describe what sender and receiver
 * should expect from each other — used in agent prompts.
 */
export const MESSAGE_EXPECTATIONS: Record<FlockMessageType, MessageExpectation> =
  {
    task: {
      description: "Request another agent to perform work",
      senderGuidance: `When sending a task request:
- Clearly state what needs to be done
- Specify acceptance criteria and what "done" means
- Indicate priority and any deadlines
- If acceptance criteria is "working first" (작동 우선): workarounds and TODOs are acceptable, but must be explicitly documented in the response
- If acceptance criteria is "completeness first" (완성도 우선): no workarounds — report failure rather than delivering incomplete work`,
      receiverGuidance: `When receiving a task request:
- Read the acceptance criteria carefully — it defines your quality bar
- "Working first": deliver something functional, document any shortcuts taken
- "Completeness first": deliver polished work or report failure with specifics
- Always include: what was done, what wasn't, any known issues
- Use flock_task_respond to report back when done`,
    },
    review: {
      description: "Request a review of delivered work",
      senderGuidance: `When requesting a review:
- Point to the specific deliverable (commit, file, PR)
- State what aspects need focus (correctness, security, style, etc.)
- Provide context on constraints or trade-offs made`,
      receiverGuidance: `When reviewing:
- Focus on requested areas first, then general observations
- Distinguish blocking issues from suggestions
- Be specific — reference exact lines, functions, or patterns
- Approve, request changes, or reject with clear reasoning`,
    },
    info: {
      description: "Ask another agent for information",
      senderGuidance: `When requesting information:
- Ask a clear, specific question
- Provide relevant context so the responder can give useful answers
- State what you plan to do with the information`,
      receiverGuidance: `When answering:
- Answer directly, then elaborate
- Cite sources when possible
- Say "I don't know" rather than guessing
- Suggest who else might know if you can't help`,
    },
    "status-update": {
      description: "Report progress on ongoing work",
      senderGuidance: `When sending status updates:
- Reference the original task ID
- State current status clearly (in progress, blocked, done, failed)
- If blocked, describe what's needed to unblock
- Estimate remaining time/effort when possible`,
      receiverGuidance: `When receiving status updates:
- Acknowledge receipt
- If blocked, help unblock or escalate
- Adjust plans based on new information`,
    },
    general: {
      description: "General communication between agents",
      senderGuidance: "Communicate naturally. Be clear about intent.",
      receiverGuidance: "Respond helpfully. Ask for clarification if needed.",
    },
  };

/** All known message type keys. */
export const MESSAGE_TYPES = Object.keys(MESSAGE_EXPECTATIONS) as FlockMessageType[];

/**
 * Generate the communication expectations section for an agent's base prompt.
 * This gets injected into communication.md or agent system prompts.
 *
 * @returns A formatted markdown string with all message type expectations.
 */
export function generateExpectationsPrompt(): string {
  const lines: string[] = [
    "## Message Type Expectations",
    "",
    "When communicating with other agents, follow these conventions based on message type:",
    "",
  ];

  for (const msgType of MESSAGE_TYPES) {
    const exp = MESSAGE_EXPECTATIONS[msgType];
    lines.push(`### ${msgType}`);
    lines.push("");
    lines.push(`> ${exp.description}`);
    lines.push("");
    lines.push("**As Sender:**");
    lines.push("");
    lines.push(exp.senderGuidance);
    lines.push("");
    lines.push("**As Receiver:**");
    lines.push("");
    lines.push(exp.receiverGuidance);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
