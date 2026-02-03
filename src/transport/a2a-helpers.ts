/**
 * A2A Object Construction Helpers
 *
 * The A2A SDK v0.3.9 types use `kind` discriminators and require
 * various mandatory fields. These helpers provide concise constructors
 * so the rest of the codebase doesn't need to deal with boilerplate.
 */

import type {
  Message,
  TextPart,
  DataPart,
  Artifact,
  Task,
  TaskStatus,
  Part,
} from "@a2a-js/sdk";

let _msgCounter = 0;

/** Create a unique message ID. */
export function newMessageId(): string {
  return `flock-msg-${Date.now()}-${++_msgCounter}`;
}

/** Create a unique artifact ID. */
export function newArtifactId(): string {
  return `flock-art-${Date.now()}-${++_msgCounter}`;
}

/** Create a TextPart. */
export function textPart(text: string, metadata?: Record<string, unknown>): TextPart {
  return { kind: "text", text, ...(metadata ? { metadata } : {}) };
}

/**
 * Create a DataPart.
 * Accepts any plain object — converts to `{ [k: string]: unknown }`
 * internally so callers don't need `as unknown as` casts.
 */
export function dataPart(data: object, metadata?: Record<string, unknown>): DataPart {
  // Structurally compatible — DataPart.data is { [k: string]: unknown }
  const record: { [k: string]: unknown } = { ...data };
  return { kind: "data", data: record, ...(metadata ? { metadata } : {}) };
}

/** Create a Message from text. */
export function agentMessage(text: string): Message {
  return {
    kind: "message",
    messageId: newMessageId(),
    role: "agent",
    parts: [textPart(text)],
  };
}

/** Create a user Message from text. */
export function userMessage(text: string, extraParts?: Part[]): Message {
  const parts: Part[] = [textPart(text)];
  if (extraParts) parts.push(...extraParts);
  return {
    kind: "message",
    messageId: newMessageId(),
    role: "user",
    parts,
  };
}

/** Create an Artifact. */
export function artifact(
  name: string,
  parts: Part[],
  description?: string,
): Artifact {
  return {
    artifactId: newArtifactId(),
    name,
    parts,
    ...(description ? { description } : {}),
  };
}

/** Create a TaskStatus. */
export function taskStatus(
  state: Task["status"]["state"],
  messageText?: string,
): TaskStatus {
  return {
    state,
    ...(messageText ? { message: agentMessage(messageText) } : {}),
  };
}

/** Create a Task object. */
export function task(
  id: string,
  contextId: string,
  status: TaskStatus,
  artifacts?: Artifact[],
): Task {
  return {
    kind: "task",
    id,
    contextId,
    status,
    ...(artifacts ? { artifacts } : {}),
  };
}

/** Extract text from all TextParts in a message. */
export function extractText(message: Message): string {
  return (message.parts ?? [])
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Extract the first DataPart from a message, if any. */
export function extractData(message: Message): Record<string, unknown> | null {
  const part = (message.parts ?? []).find(
    (p): p is DataPart => p.kind === "data",
  );
  return part?.data ?? null;
}

/** Check if an unknown value is a DataPart-like object ({ kind: "data", data: object }). */
export function isDataPart(v: unknown): v is DataPart {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return obj.kind === "data" && typeof obj.data === "object" && obj.data !== null;
}

/** Extract text from a Task's status message and artifacts. */
export function extractTaskText(t: Task): string {
  // Try status message
  if (t.status.message) {
    const text = extractText(t.status.message);
    if (text) return text;
  }

  // Try artifacts
  if (t.artifacts) {
    for (const art of t.artifacts) {
      const text = (art.parts ?? [])
        .filter((p): p is TextPart => p.kind === "text")
        .map((p) => p.text)
        .join("\n");
      if (text) return text;
    }
  }

  return `Task ${t.id} [${t.status.state}]`;
}
