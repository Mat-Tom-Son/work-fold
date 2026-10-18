import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * A turn's work-fold identity survives compaction.
 *
 * Each accepted turn's ids reach the model once, in the hidden turn-context
 * message sent before its prompt. When Pi compacts in the middle of a long
 * turn, that message can be folded into the summary, and a summary can carry
 * the wrong id: in a measured run (docs/archive/helper-tool-experiment.md) the
 * summary named the previous turn's task id as the current one, the Worker's
 * `chat report` was refused, and its result was never recorded.
 *
 * This hook restates the running turn's exact ids, request-locally, whenever
 * the model would otherwise see a compaction summary without this turn's own
 * context message. Nothing is written to the session, and the note sits right
 * after the summary, so its position is stable from request to request.
 */

/** The hidden message every accepted turn sends before its prompt. */
export const workFoldTurnContextCustomType = "work-fold-turn-context";
/** The request-local restatement added after a compaction summary. */
export const workFoldTurnIdentityCustomType = "work-fold-turn-identity";

export interface WorkFoldTurnIdentityInput {
  workFolderTurn?: { workFolderId: string; taskId: string; requestId: string };
  workFoldAgentTaskId?: string;
}

export interface WorkFoldTurnIdentity {
  taskId: string;
  text: string;
}

/** The identity lines a Worker turn's context opens with. */
export function workFolderTurnIdentityLines(turn: { workFolderId: string; taskId: string; requestId: string }): string[] {
  return [
    "This turn's work-fold identity (host-owned; use these exact ids):",
    JSON.stringify({ workFolderId: turn.workFolderId, taskId: turn.taskId, requestId: turn.requestId }, null, 2),
    "Pass --work-folder with that work-folder id and --task with that task id on chat report, chat ask, and chat handoff. A task id is accepted only while that exact turn is yours and running.",
  ];
}

/** The lines that give a work-fold agent request its own task id. */
export function workFoldAgentTaskLines(taskId: string): string[] {
  return [
    "This work-fold agent request's task id is:",
    taskId,
    "Add --parent-task with that exact id to each chat send, work-folders create/register, or files add command you run for this request. Do not reuse it in a later request.",
  ];
}

/** What to restate after compaction for this turn, or null when it carries no work-fold ids. */
export function buildTurnIdentity(input: WorkFoldTurnIdentityInput): WorkFoldTurnIdentity | null {
  const turn = input.workFolderTurn;
  const taskId = turn?.taskId ?? input.workFoldAgentTaskId;
  if (!taskId) return null;
  const lines = [
    "The conversation above was compacted while this turn was running, so work-fold restates this turn's identity here. It replaces any task id, request id, or work-folder id named in the summary or in earlier messages.",
    ...(turn ? workFolderTurnIdentityLines(turn) : []),
    ...(input.workFoldAgentTaskId ? workFoldAgentTaskLines(input.workFoldAgentTaskId) : []),
  ];
  return { taskId, text: lines.join("\n") };
}

type ContextMessage = { role: string; customType?: string; content?: unknown; timestamp?: number };

function messageText(message: ContextMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}

/**
 * Adds the running turn's identity after the latest compaction summary when the
 * turn's own context message is no longer among the messages the model sees.
 * Returns undefined (leaving the request untouched) in every other case.
 */
export function restateTurnIdentity<T extends ContextMessage>(messages: T[], identity: WorkFoldTurnIdentity | null): T[] | undefined {
  if (!identity) return undefined;
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0 && summaryIndex < 0; index -= 1) {
    if (messages[index]!.role === "compactionSummary") summaryIndex = index;
  }
  if (summaryIndex < 0) return undefined;
  const ownContextVisible = messages.some((message) => message.role === "custom"
    && message.customType === workFoldTurnContextCustomType && messageText(message).includes(identity.taskId));
  if (ownContextVisible) return undefined;
  const note = {
    role: "custom",
    customType: workFoldTurnIdentityCustomType,
    content: identity.text,
    display: false,
    timestamp: messages[summaryIndex]!.timestamp ?? Date.now(),
  } as unknown as T;
  return [...messages.slice(0, summaryIndex + 1), note, ...messages.slice(summaryIndex + 1)];
}

/** Built-in session extension; `current` returns the running turn's identity, or null between turns. */
export function turnIdentityAfterCompactionExtension(current: () => WorkFoldTurnIdentity | null): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const messages = restateTurnIdentity(event.messages as ContextMessage[], current());
      return messages ? { messages: messages as typeof event.messages } : undefined;
    });
  };
}
