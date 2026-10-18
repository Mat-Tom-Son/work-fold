import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * A turn survives compaction: its ids, its request, and the care it needs.
 *
 * Each accepted turn's ids reach the model once, in the hidden turn-context
 * message sent before its prompt, and its request is the person's message
 * right after it. When Pi compacts in the middle of a long turn, both can be
 * folded into the summary. In measured runs (docs/archive/helper-tool-experiment.md)
 * the summary named the previous turn's task id as the current one, so the
 * Worker's `chat report` was refused; and the summary of the turn so far read
 * "The user's actual task is not included", after which the Worker narrowed
 * its search and reported a partial list as complete.
 *
 * This hook restates, request-locally, whenever the model would otherwise see a
 * compaction summary without this turn's own context message: the turn's exact
 * ids; the person's request for this turn when it is no longer visible; and a
 * reminder that earlier work is only summarized, so the answer is re-checked
 * against the sources. Nothing is written to the session, and the note sits
 * right after the summary, so its position is stable from request to request.
 */

/** The hidden message every accepted turn sends before its prompt. */
export const workFoldTurnContextCustomType = "work-fold-turn-context";
/** The request-local restatement added after a compaction summary. */
export const workFoldTurnIdentityCustomType = "work-fold-turn-identity";

export interface WorkFoldTurnIdentityInput {
  workFolderTurn?: { workFolderId: string; taskId: string; requestId: string };
  workFoldAgentTaskId?: string;
  /** The person's message for this turn. */
  request?: string;
}

export interface WorkFoldTurnIdentity {
  taskId: string;
  text: string;
  request?: string;
}

/**
 * A request restated after compaction is sent with every later request of the
 * turn, so a very long message is restated in part and points to the rest.
 */
export const restatedRequestMaxChars = 32_000;

const recheckReminder = "Earlier work in this turn is only summarized above, and a summary can leave out results or how thoroughly you had checked. Before you finish, re-check what your answer depends on against the files and tools themselves rather than the summary, and say plainly if anything is still incomplete.";

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
  const request = input.request?.trim();
  return { taskId, text: lines.join("\n"), ...(request ? { request } : {}) };
}

function restatedRequest(request: string): string {
  const shown = request.length > restatedRequestMaxChars
    ? `${request.slice(0, restatedRequestMaxChars)}\n[The message continues for ${request.length - restatedRequestMaxChars} more characters; it is this turn's message in the Chat.]`
    : request;
  return `This turn's request (the person's message, restated because the summary above may not include it):\n<request>\n${shown}\n</request>`;
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
  const requestHead = identity.request?.slice(0, 200);
  const requestVisible = requestHead !== undefined
    && messages.some((message) => message.role === "user" && messageText(message).includes(requestHead));
  const note = {
    role: "custom",
    customType: workFoldTurnIdentityCustomType,
    content: [identity.text, ...(identity.request && !requestVisible ? [restatedRequest(identity.request)] : []), recheckReminder].join("\n\n"),
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
