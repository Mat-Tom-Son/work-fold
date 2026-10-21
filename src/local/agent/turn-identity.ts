import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { describeChecklist } from "./checklist-tool.js";
import type { WorkFoldChecklistItem } from "../requests/request-records.js";
import type { PiWorkFolderTurnContext } from "./work-folder-turn-context.js";

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
 * ids; the request's original assignment and this turn's message when no
 * longer visible; and evidence-aware recovery and verification guidance.
 * Later answers still apply to the original assignment. Nothing is written to the session, and the note sits
 * right after the summary, so its position is stable from request to request.
 */

/** The hidden message every accepted turn sends before its prompt. */
export const workFoldTurnContextCustomType = "work-fold-turn-context";
/** The request-local restatement added after a compaction summary. */
export const workFoldTurnIdentityCustomType = "work-fold-turn-identity";

export interface WorkFoldTurnIdentityInput {
  workFolderTurn?: Pick<PiWorkFolderTurnContext, "workFolderId" | "taskId" | "requestId" | "assignment" | "delegated">;
  workFoldAgentTaskId?: string;
  /** The person's message for this turn. */
  request?: string;
}

export interface WorkFoldTurnIdentity {
  taskId: string;
  text: string;
  request?: string;
  /** This request's own original assignment, distinct from a later answer. */
  assignment?: string;
  assignmentTruncated?: boolean;
  /** The request's checklist as it stands now, so the plan survives the summary too (2026-10-18). */
  checklist?: readonly WorkFoldChecklistItem[];
}

/**
 * A request restated after compaction is sent with every later request of the
 * turn, so a very long message is restated in part and points to the rest.
 */
export const restatedRequestMaxChars = 32_000;

const recheckReminder = "Earlier work in this turn is summarized above; the summary can omit completed results or checks. Recover applicable observations and findings with progress first, including their coverage and freshness. Keep completed verification when its evidence still applies. Recheck changed sources, dynamic state, missing coverage or unresolved concerns with the appropriate tools; compaction alone is not a reason to repeat every check. Never replay a mutation to recover its result. Finish when the requested outcome has supporting evidence, and say plainly if anything is still incomplete.";

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
  const assignment = turn?.assignment ?? turn?.delegated?.assignment;
  return { taskId, text: lines.join("\n"), ...(request ? { request } : {}),
    ...(assignment?.trim() && assignment.trim() !== request ? { assignment, assignmentTruncated: !!turn?.delegated?.assignmentTruncated } : {}) };
}

function restatedRequest(request: string): string {
  const shown = request.length > restatedRequestMaxChars
    ? `${request.slice(0, restatedRequestMaxChars)}\n[The message continues for ${request.length - restatedRequestMaxChars} more characters; it is this turn's message in the Chat.]`
    : request;
  return `This turn's request (the person's message, restated because the summary above may not include it):\n<request>\n${shown}\n</request>`;
}

function restatedAssignment(identity: WorkFoldTurnIdentity): string {
  const assignment = identity.assignment!;
  const shown = assignment.length > restatedRequestMaxChars
    ? `${assignment.slice(0, restatedRequestMaxChars)}\n[The original assignment continues for ${assignment.length - restatedRequestMaxChars} more characters; the full text is in this Chat's original assignment.]`
    : assignment;
  return `Original assignment for this request (host-kept, restated because the summary may omit exact requirements; later answers and corrections still apply):\n<assignment>\n${shown}${identity.assignmentTruncated ? "\n[The host's original assignment context was already truncated; consult the full assignment in this Chat.]" : ""}\n</assignment>`;
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
  const requestVisible = identity.request !== undefined
    && messages.some((message) => message.role === "user" && messageText(message).includes(identity.request!));
  const assignmentVisible = identity.assignment !== undefined
    && messages.some((message) => message.role === "user" && messageText(message).includes(identity.assignment!));
  const note = {
    role: "custom",
    customType: workFoldTurnIdentityCustomType,
    content: [
      identity.text,
      ...(identity.assignment && !assignmentVisible ? [restatedAssignment(identity)] : []),
      ...(identity.request && !requestVisible ? [restatedRequest(identity.request)] : []),
      ...(identity.checklist?.length ? [`Your checklist for this request as it stands (host-kept; [x] done, [~] doing, [ ] to do):\n${describeChecklist(identity.checklist)}`] : []),
      recheckReminder,
    ].join("\n\n"),
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
