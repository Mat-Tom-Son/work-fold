import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ChatMessage, ConversationSummary } from "./agent/chat-store.js";
import type { WorkFoldActAgentRequestPhase } from "./cli/act-facade.js";
import type { WorkFoldRequestKind, WorkFoldRequestState } from "./requests/request-records.js";
import type { WorkFoldCliActReceipt } from "./cli/act-receipts.js";
import type {
  WorkFoldCheckAggregateState,
  WorkFoldCheckStatusSnapshot,
} from "./checks/check-types.js";
import { workFoldStateRoot } from "./state-paths.js";

/**
 * The overview: a deterministic digest composed by app code from state the
 * product already records. It is a projection, not a store — every item points
 * back at a record that exists for its own reasons, the digest can always be
 * recomputed, and it is never the authority for anything. No model composes
 * it and no watcher exists just to feed it. Source readers may re-verify
 * explicitly designated Check inputs locally; the digest contains only their
 * aggregate status, never those file bytes.
 *
 * The source inventory is closed: one typed reader per row of the inventory
 * table in docs/work-fold-agent-overview.md. An absent reader renders its
 * kinds as absent, never as empty-and-clear; a reader that fails is reported
 * in `unavailable`, never rendered as quiet. Composition is deterministic —
 * the same recorded state and the same clock reading produce a
 * byte-identical digest.
 */

export const workFoldOverviewExperimentalSnapshotVersion = 0 as const;

export const WORKFOLD_OVERVIEW_SOURCES = [
  "kernel-tasks",
  "settled-turns",
  "agent-requests",
  "chats",
  "history-checkpoints",
  "checks",
  "act-receipts",
  "app-automation-receipts",
  "app-automation-schedule",
  "automation-runs",
  "viewer-grants",
] as const;

export type WorkFoldOverviewSource = (typeof WORKFOLD_OVERVIEW_SOURCES)[number];

export type WorkFoldOverviewItemKind =
  // Running now
  | "assistant-turn"
  | "compaction"
  | "agent-request"
  | "check-run"
  | "app-automation-run"
  | "automation-run"
  // Needs you: questions and due snoozes only (docs/receipts-not-gates.md,
  // F24). Nothing here is an approval.
  | "request-question"
  | "chat-question"
  | "due-snooze"
  // Since you last looked
  | "checkpoint-saved"
  | "turn-settled"
  | "request-settled"
  | "chat-lifecycle"
  | "chat-renamed"
  | "check-run-settled"
  | "act-performed"
  | "app-automation-run-settled"
  | "automation-run-settled"
  | "viewer-grant-changed"
  | "publication-state";

export interface WorkFoldOverviewItemRef {
  taskId?: string;
  conversationId?: string;
  checkpointId?: string;
  /** An act receipt's request id, or a durable request's id (F25). */
  requestId?: string;
  /** The open question a needs-you item points at (F27). */
  questionId?: string;
  automationId?: string;
  runId?: string;
  publicationId?: string;
}

export interface WorkFoldOverviewItem {
  /** Stable `<source>:<recordId>` dedupe identity. */
  id: string;
  /** ISO time of the underlying record. */
  at: string;
  kind: WorkFoldOverviewItemKind;
  workFolderId?: string;
  /** Resolved at composition; an unregistered work-folder renders the id plus "(removed)". */
  workFolderName?: string;
  /** Deterministic template over typed record fields, never model output. */
  headline: string;
  ref?: WorkFoldOverviewItemRef;
}

export interface WorkFoldOverviewCheckRow {
  workFolderId: string;
  workFolderName: string;
  state: WorkFoldCheckAggregateState;
  needsAttention: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  lastRunAt: string | null;
}

export interface WorkFoldOverviewSnapshot {
  kind: "work-fold.overview.experimental";
  version: typeof workFoldOverviewExperimentalSnapshotVersion;
  /** The single clock reading used for every due-snooze and expiry comparison. */
  composedAt: string;
  /** `"<at>/<id>"` of the newest change item; empty while nothing has changed. */
  cursor: string;
  running: WorkFoldOverviewItem[];
  needsYou: WorkFoldOverviewItem[];
  changes: WorkFoldOverviewItem[];
  checks: WorkFoldOverviewCheckRow[];
  /** surfaceId -> acknowledged cursor, from the seen-marker store. */
  seen: Record<string, string>;
  truncated: { running: boolean; needsYou: boolean; changes: boolean; checks: boolean };
  /**
   * Sources that exist but could not be read this composition. Their kinds are
   * omitted, and the omission is disclosed instead of rendered as quiet.
   */
  unavailable: WorkFoldOverviewSource[];
}

// Section bounds. Bounds are disclosure, not curation: overflow sets the
// section's truncated flag instead of pretending completeness.
export const workFoldOverviewRunningCap = 256;
export const workFoldOverviewNeedsYouCap = 256;
export const workFoldOverviewChangesPerKindCap = 128;
export const workFoldOverviewChangesTotalCap = 512;
export const workFoldOverviewChecksCap = 512;

const maxHeadlineLength = 200;
const maxTitleInHeadline = 80;
const maxSourceRecords = 2_048;
const maxStoreBytes = 4 * 1024 * 1024;
const maxStoreRecords = 512;
const maxRecordIdLength = 200;

/** Registered work-folder identity handed to the per-work-folder source readers. */
export interface WorkFoldOverviewWorkFolderRef {
  id: string;
  name: string;
  workFolderRoot: string;
}

// --- Source record shapes (one row of the inventory table each) ---

export interface WorkFoldOverviewTaskRecord {
  id: string;
  kind: "assistant_turn" | "compaction" | "check_run";
  workFolderId: string;
  conversationId?: string;
  startedAt: string;
}

export interface WorkFoldOverviewSettledTurnRecord {
  taskId: string;
  workFolderId?: string;
  conversationId?: string;
  outcome: "succeeded" | "failed" | "aborted";
  endedAt: string;
}

/**
 * One durable request (docs/collaboration-contract.md, F25) as the overview
 * reads it: its state, the vocabulary `agent status` speaks beside it, the
 * turns it started, and its open questions by id — never a question's text,
 * a result's summary, or any work-folder content.
 */
export interface WorkFoldOverviewAgentRequestRecord {
  /** Stable across continuations, unlike the task id; item ids key on it. */
  requestId: string;
  kind: WorkFoldRequestKind;
  state: WorkFoldRequestState;
  /** The request's newest turn. */
  taskId: string;
  conversationId: string;
  /** Absent exactly for the work-fold agent scope. */
  workFolderId?: string;
  phase: WorkFoldActAgentRequestPhase;
  startedAt: string;
  endedAt: string | null;
  /** Every turn under this request's descendants, for running-item folding. */
  childTaskIds: string[];
  /** Questions still open on this request, by id and respondent (needs you). */
  openQuestions: Array<{ questionId: string; respondent: "person" | "parent"; askedAt: string }>;
  questionCount: number;
  resultCount: number;
}

/**
 * Work above a single turn: the work-fold agent's own requests, and any
 * request that delegated, asked, or reported. A plain Worker turn is one
 * kernel task and one settled turn already; rendering its root request as
 * well would list the same work twice.
 */
function requestIsAboveSingleTurn(request: WorkFoldOverviewAgentRequestRecord): boolean {
  return request.kind === "agent"
    || request.childTaskIds.length > 0
    || request.questionCount > 0
    || request.resultCount > 0;
}

const requestSettledHeadlines: Record<WorkFoldRequestState, string | null> = {
  working: null,
  waiting: null,
  handed_off: null,
  done: "Request done",
  partial: "Request partly done",
  failed: "Request failed",
  stopped: "Request stopped",
  expired: "Request ran out of time",
};

export interface WorkFoldOverviewChatLifecycleEvent {
  messageId: string;
  createdAt: string;
  change: "archived" | "restored" | "snoozed" | "snooze-cleared";
  snoozedUntil?: string;
}

export interface WorkFoldOverviewChatTitleEvent {
  messageId: string;
  createdAt: string;
  title: string;
  source: "manual" | "generated";
}

export interface WorkFoldOverviewChatRecord {
  conversationId: string;
  title: string;
  archivedAt: string | null;
  snoozedUntil: string | null;
  /** Newest user/assistant message; lifecycle and title bookkeeping is skipped. */
  newestMessage: { role: "user" | "assistant"; createdAt: string; followUpPrompt: string | null } | null;
  lifecycleEvents: WorkFoldOverviewChatLifecycleEvent[];
  titleEvents: WorkFoldOverviewChatTitleEvent[];
}

export interface WorkFoldOverviewCheckpointRecord {
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
}

export interface WorkFoldOverviewCheckRunRecord {
  runId: string;
  taskId?: string;
  state: "succeeded" | "failed" | "aborted" | "interrupted";
  startedAt: string;
  endedAt?: string;
  admittedCount: number;
}

export interface WorkFoldOverviewCheckSource {
  status: WorkFoldCheckStatusSnapshot;
  settledRuns: WorkFoldOverviewCheckRunRecord[];
}

export interface WorkFoldOverviewAppAutomationRunRecord {
  runId: string;
  appAutomationId: string;
  workFolderId?: string;
  startedAt: string;
}

export type WorkFoldOverviewAppAutomationOutcome =
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "interrupted";

export interface WorkFoldOverviewAppAutomationReceiptRecord {
  receiptId: string;
  runId: string;
  appAutomationId: string;
  workFolderId?: string;
  outcome: WorkFoldOverviewAppAutomationOutcome;
  finishedAt: string;
}

export type WorkFoldOverviewAutomationRunState =
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";

export interface WorkFoldOverviewAutomationRunRecord {
  runId: string;
  automationId: string;
  title?: string;
  state: WorkFoldOverviewAutomationRunState;
  startedAt: string;
  endedAt?: string;
  hops: Array<{ id: string; state: string }>;
}

/**
 * One event from the publication grant store. `created`/`revoked` are the
 * grant-lifecycle events; `not-available` and `resting` project the record's
 * bounded publisher-facing health note (docs/shared-pages.md, "Honest
 * states"): the viewer saw a deliberately vague page, and the precise reason
 * belongs here — to the publisher — as a change item. A health event carries
 * the recorded page title and reason for its deterministic headline.
 */
export interface WorkFoldOverviewViewerGrantEventRecord {
  publicationId: string;
  event: "created" | "revoked" | "not-available" | "resting";
  at: string;
  workFolderId?: string;
  title?: string;
  reason?: string;
}

/**
 * The closed source-reader interface. Every method is optional: an absent
 * reader renders its item kinds as absent. A reader that throws marks its
 * source unavailable for this composition; its kinds are omitted and the
 * omission is disclosed. Readers read recorded state only — composing the
 * digest must never execute a sensor, run a model, or open work-folder content.
 */
export interface WorkFoldOverviewSourceReaders {
  runningTasks?(): Promise<WorkFoldOverviewTaskRecord[]>;
  settledTurns?(): Promise<WorkFoldOverviewSettledTurnRecord[]>;
  workFoldAgentRequests?(): Promise<WorkFoldOverviewAgentRequestRecord[]>;
  chats?(workFolder: WorkFoldOverviewWorkFolderRef): Promise<WorkFoldOverviewChatRecord[]>;
  checkpoints?(workFolder: WorkFoldOverviewWorkFolderRef): Promise<WorkFoldOverviewCheckpointRecord[]>;
  checks?(workFolder: WorkFoldOverviewWorkFolderRef): Promise<WorkFoldOverviewCheckSource | null>;
  actReceipts?(): Promise<WorkFoldCliActReceipt[]>;
  appAutomationRunReceipts?(): Promise<WorkFoldOverviewAppAutomationReceiptRecord[]>;
  appAutomationRuns?(): Promise<WorkFoldOverviewAppAutomationRunRecord[]>;
  automationRuns?(): Promise<WorkFoldOverviewAutomationRunRecord[]>;
  viewerGrants?(): Promise<WorkFoldOverviewViewerGrantEventRecord[]>;
}

export interface WorkFoldOverviewComposeInput {
  /** One clock reading, used for every timestamp comparison in this digest. */
  now: Date;
  workFolders: WorkFoldOverviewWorkFolderRef[];
  sources: WorkFoldOverviewSourceReaders;
  seen?: Record<string, string>;
}

// --- Cursor helpers ---

export function workFoldOverviewCursor(at: string, id: string): string {
  return `${at}/${id}`;
}

export function parseWorkFoldOverviewCursor(cursor: unknown): { at: string; id: string } | null {
  if (typeof cursor !== "string" || !cursor || cursor.length > 720) return null;
  if (/[\u0000-\u001f\u007f]/.test(cursor)) return null;
  const separator = cursor.indexOf("/");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  return { at: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
}

/** Total order over cursors: timestamp first, then item id. */
export function compareWorkFoldOverviewCursors(left: string, right: string): number {
  const parsedLeft = parseWorkFoldOverviewCursor(left);
  const parsedRight = parseWorkFoldOverviewCursor(right);
  if (!parsedLeft || !parsedRight) return compareStrings(left, right);
  return compareTimestamps(parsedLeft.at, parsedRight.at) || compareStrings(parsedLeft.id, parsedRight.id);
}

// --- Composition ---

export async function composeWorkFoldOverview(input: WorkFoldOverviewComposeInput): Promise<WorkFoldOverviewSnapshot> {
  const composedAt = input.now.toISOString();
  const composedAtMs = input.now.getTime();
  const workFolders = [...input.workFolders].sort((left, right) => compareStrings(left.id, right.id));
  const workFolderNames = new Map(workFolders.map((workFolder) => [workFolder.id, workFolder.name]));
  const unavailable = new Set<WorkFoldOverviewSource>();
  const sources = input.sources;

  const tasks = await readSource("kernel-tasks", sources.runningTasks, unavailable);
  const settledTurns = await readSource("settled-turns", sources.settledTurns, unavailable);
  const requests = await readSource("agent-requests", sources.workFoldAgentRequests, unavailable);
  const chats = await readWorkFolderSource("chats", workFolders, sources.chats, unavailable);
  const checkpoints = await readWorkFolderSource("history-checkpoints", workFolders, sources.checkpoints, unavailable);
  const checks = await readWorkFolderSource("checks", workFolders, sources.checks, unavailable);
  const actReceipts = await readSource("act-receipts", sources.actReceipts, unavailable);
  const appAutomationReceipts = await readSource("app-automation-receipts", sources.appAutomationRunReceipts, unavailable);
  const appAutomationRuns = await readSource("app-automation-schedule", sources.appAutomationRuns, unavailable);
  const automationRuns = await readSource("automation-runs", sources.automationRuns, unavailable);
  const viewerGrants = await readSource("viewer-grants", sources.viewerGrants, unavailable);

  // A request in `waiting` is not running: what it waits on is in Needs you.
  const runningRequests = (requests ?? []).filter(
    (request) => requestIsAboveSingleTurn(request) && (request.state === "working" || request.state === "handed_off"),
  );
  // One item per request: the request's own turn task and its running child
  // turns fold into that item's headline count instead of listing twice.
  const foldedTaskIds = new Set<string>();
  for (const request of runningRequests) {
    foldedTaskIds.add(request.taskId);
    for (const childTaskId of request.childTaskIds) foldedTaskIds.add(childTaskId);
  }
  const runningTaskIds = new Set((tasks ?? []).map((task) => task.id));
  const runningConversationIds = new Set(
    (tasks ?? []).flatMap((task) => task.conversationId ? [task.conversationId] : []),
  );

  const running = composeRunning({
    tasks: tasks ?? [],
    runningRequests,
    foldedTaskIds,
    runningTaskIds,
    appAutomationRuns: appAutomationRuns ?? [],
    automationRuns: automationRuns ?? [],
    workFolderNames,
  });
  const needsYou = composeNeedsYou({
    composedAtMs,
    requests: requests ?? [],
    chats,
    runningConversationIds,
    workFolderNames,
  });
  const changes = composeChanges({
    composedAtMs,
    settledTurns: settledTurns ?? [],
    requests: requests ?? [],
    chats,
    checkpoints,
    checks,
    actReceipts: actReceipts ?? [],
    appAutomationReceipts: appAutomationReceipts ?? [],
    automationRuns: automationRuns ?? [],
    viewerGrants: viewerGrants ?? [],
    workFolderNames,
  });
  const checkRows = composeCheckRows(checks);

  const seen: Record<string, string> = {};
  const seenInput = input.seen ?? {};
  for (const key of Object.keys(seenInput).sort(compareStrings)) seen[key] = seenInput[key];

  const newestChange = changes.items[0];
  return {
    kind: "work-fold.overview.experimental",
    version: workFoldOverviewExperimentalSnapshotVersion,
    composedAt,
    cursor: newestChange ? workFoldOverviewCursor(newestChange.at, newestChange.id) : "",
    running: running.items,
    needsYou: needsYou.items,
    changes: changes.items,
    checks: checkRows.rows,
    seen,
    truncated: {
      running: running.truncated,
      needsYou: needsYou.truncated,
      changes: changes.truncated,
      checks: checkRows.truncated,
    },
    unavailable: [...unavailable].sort(compareStrings),
  };
}

function composeRunning(input: {
  tasks: WorkFoldOverviewTaskRecord[];
  runningRequests: WorkFoldOverviewAgentRequestRecord[];
  foldedTaskIds: Set<string>;
  runningTaskIds: Set<string>;
  appAutomationRuns: WorkFoldOverviewAppAutomationRunRecord[];
  automationRuns: WorkFoldOverviewAutomationRunRecord[];
  workFolderNames: Map<string, string>;
}): { items: WorkFoldOverviewItem[]; truncated: boolean } {
  const items: WorkFoldOverviewItem[] = [];
  for (const request of input.runningRequests.slice(0, maxSourceRecords)) {
    const runningChildren = request.childTaskIds.filter((taskId) => input.runningTaskIds.has(taskId)).length;
    const base = request.state === "handed_off" ? "Handed off" : "Handling your request";
    const suffix = runningChildren > 0
      ? ` — ${runningChildren} Worker turn${runningChildren === 1 ? "" : "s"} running`
      : "";
    items.push(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.startedAt,
      kind: "agent-request",
      ...(request.workFolderId ? { workFolderId: request.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline: `${base}${suffix}`,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const task of input.tasks.slice(0, maxSourceRecords)) {
    if (input.foldedTaskIds.has(task.id)) continue;
    const kind = task.kind === "assistant_turn"
      ? "assistant-turn" as const
      : task.kind === "compaction"
        ? "compaction" as const
        : task.kind === "check_run"
          ? "check-run" as const
          : null;
    if (!kind) continue;
    const headline = kind === "assistant-turn"
      ? "Worker turn running"
      : kind === "compaction"
        ? "Chat compaction running"
        : "Check run in progress";
    items.push(overviewItem({
      id: `kernel-tasks:${task.id}`,
      at: task.startedAt,
      kind,
      workFolderId: task.workFolderId,
      workFolderNames: input.workFolderNames,
      headline,
      ref: { taskId: task.id, ...(task.conversationId ? { conversationId: task.conversationId } : {}) },
    }));
  }
  for (const run of input.appAutomationRuns.slice(0, maxSourceRecords)) {
    items.push(overviewItem({
      id: `app-automation-schedule:${run.runId}`,
      at: run.startedAt,
      kind: "app-automation-run",
      ...(run.workFolderId ? { workFolderId: run.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline: `Automation "${clampText(run.appAutomationId, maxTitleInHeadline)}" running`,
      ref: { runId: run.runId },
    }));
  }
  for (const run of input.automationRuns.slice(0, maxSourceRecords)) {
    if (run.state !== "running") continue;
    items.push(overviewItem({
      id: `automation-runs:${run.runId}`,
      at: run.startedAt,
      kind: "automation-run",
      headline: run.title
        ? `Automation "${clampText(run.title, maxTitleInHeadline)}" running`
        : "Automation run in progress",
      ref: { automationId: run.automationId, runId: run.runId },
    }));
  }
  // Longest-running first; overflow drops the newest, never the oldest — a
  // long-running turn must not be hidden by churn.
  items.sort((left, right) => compareTimestamps(left.at, right.at) || compareStrings(left.id, right.id));
  return {
    items: items.slice(0, workFoldOverviewRunningCap),
    truncated: items.length > workFoldOverviewRunningCap,
  };
}

/**
 * Needs you means questions (docs/receipts-not-gates.md, F24): a work-fold
 * agent request waiting on the person's answer, a Worker Chat whose newest
 * message is a question from the Worker, and a due snooze. Newest first;
 * overflow keeps the newest and states truncation. Nothing here is an
 * approval.
 */
function composeNeedsYou(input: {
  composedAtMs: number;
  requests: WorkFoldOverviewAgentRequestRecord[];
  chats: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: WorkFoldOverviewChatRecord[] }>;
  runningConversationIds: Set<string>;
  workFolderNames: Map<string, string>;
}): { items: WorkFoldOverviewItem[]; truncated: boolean } {
  const others: WorkFoldOverviewItem[] = [];
  for (const request of input.requests.slice(0, maxSourceRecords)) {
    // One item per open question addressed to the person
    // (docs/work-fold-agent-overview.md). A question addressed to the parent
    // request belongs to that request's agent, never to the person. The
    // question's text is model output and stays out of the digest; the ref
    // carries the ids a surface reads by.
    const personQuestions = request.openQuestions.filter((question) => question.respondent === "person");
    const workFolderName = request.workFolderId ? input.workFolderNames.get(request.workFolderId) ?? `${request.workFolderId} (removed)` : null;
    const headline = workFolderName
      ? `"${clampText(workFolderName, maxTitleInHeadline)}" is waiting on your answer`
      : "Your request is waiting on your answer";
    for (const question of personQuestions.slice(0, maxSourceRecords)) {
      others.push(overviewItem({
        id: `agent-requests:${request.requestId}:question:${question.questionId}`,
        at: question.askedAt,
        kind: "request-question",
        ...(request.workFolderId ? { workFolderId: request.workFolderId, workFolderNames: input.workFolderNames } : {}),
        headline,
        ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId, questionId: question.questionId },
      }));
    }
    // The closing-question heuristic on a FINISHED work-fold agent reply, and
    // nothing else. Only a work-fold agent request's phase comes from that
    // heuristic; every other kind derives `needs_you` straight from state
    // `waiting`, which a request also reaches on a question addressed to its
    // parent agent — a question that belongs to that parent and never to the
    // person (docs/work-fold-agent-overview.md, F24/F27). A request that is
    // still waiting has a recorded question somewhere, and that question's own
    // record carries the item with its question id, so the generic form would
    // only double-list it.
    if (personQuestions.length
      || request.kind !== "agent"
      || request.state === "waiting"
      || request.phase !== "needs_you") continue;
    others.push(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.endedAt ?? request.startedAt,
      kind: "request-question",
      ...(request.workFolderId ? { workFolderId: request.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const { workFolder, records } of input.chats) {
    for (const chat of records.slice(0, maxSourceRecords)) {
      if (chat.archivedAt !== null) continue;
      if (chat.snoozedUntil !== null) {
        if (isAtOrBefore(chat.snoozedUntil, input.composedAtMs)) {
          others.push(overviewItem({
            id: `chats:${chat.conversationId}:due-snooze:${chat.snoozedUntil}`,
            at: chat.snoozedUntil,
            kind: "due-snooze",
            workFolderId: workFolder.id,
            workFolderNames: input.workFolderNames,
            headline: `"${clampText(chat.title, maxTitleInHeadline)}" snooze is due`,
            ref: { conversationId: chat.conversationId },
          }));
        }
        continue;
      }
      const newest = chat.newestMessage;
      if (!newest || newest.role !== "assistant" || !newest.followUpPrompt) continue;
      if (input.runningConversationIds.has(chat.conversationId)) continue;
      others.push(overviewItem({
        id: `chats:${chat.conversationId}:question`,
        at: newest.createdAt,
        kind: "chat-question",
        workFolderId: workFolder.id,
        workFolderNames: input.workFolderNames,
        headline: `"${clampText(chat.title, maxTitleInHeadline)}" is waiting on your reply`,
        ref: { conversationId: chat.conversationId },
      }));
    }
  }
  others.sort(newestFirst);
  return {
    items: others.slice(0, workFoldOverviewNeedsYouCap),
    truncated: others.length > workFoldOverviewNeedsYouCap,
  };
}

function composeChanges(input: {
  composedAtMs: number;
  settledTurns: WorkFoldOverviewSettledTurnRecord[];
  requests: WorkFoldOverviewAgentRequestRecord[];
  chats: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: WorkFoldOverviewChatRecord[] }>;
  checkpoints: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: WorkFoldOverviewCheckpointRecord[] }>;
  checks: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: WorkFoldOverviewCheckSource | null }>;
  actReceipts: WorkFoldCliActReceipt[];
  appAutomationReceipts: WorkFoldOverviewAppAutomationReceiptRecord[];
  automationRuns: WorkFoldOverviewAutomationRunRecord[];
  viewerGrants: WorkFoldOverviewViewerGrantEventRecord[];
  workFolderNames: Map<string, string>;
}): { items: WorkFoldOverviewItem[]; truncated: boolean } {
  const byKind = new Map<WorkFoldOverviewItemKind, WorkFoldOverviewItem[]>();
  const add = (item: WorkFoldOverviewItem): void => {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  };

  for (const { workFolder, records } of input.checkpoints) {
    for (const checkpoint of records.slice(0, maxSourceRecords)) {
      add(overviewItem({
        id: `history-checkpoints:${workFolder.id}:${checkpoint.checkpointId}`,
        at: checkpoint.createdAt,
        kind: "checkpoint-saved",
        workFolderId: workFolder.id,
        workFolderNames: input.workFolderNames,
        headline: `Restore point saved — ${clampText(checkpoint.label ?? checkpoint.reason, maxTitleInHeadline)}`,
        ref: { checkpointId: checkpoint.checkpointId },
      }));
    }
  }
  for (const turn of input.settledTurns.slice(0, maxSourceRecords)) {
    add(overviewItem({
      id: `settled-turns:${turn.taskId}`,
      at: turn.endedAt,
      kind: "turn-settled",
      ...(turn.workFolderId ? { workFolderId: turn.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline: `Worker turn ${turn.outcome}`,
      ref: { taskId: turn.taskId, ...(turn.conversationId ? { conversationId: turn.conversationId } : {}) },
    }));
  }
  for (const request of input.requests.slice(0, maxSourceRecords)) {
    // Every terminal state names its outcome honestly; the ref carries the
    // request id so a surface reads what came back through `requests show`.
    // A finished request whose reply still asks the person something is in
    // Needs you, not here, exactly as before the durable store.
    const headline = requestSettledHeadlines[request.state];
    if (!headline || request.phase === "needs_you" || !requestIsAboveSingleTurn(request)) continue;
    add(overviewItem({
      id: `agent-requests:${request.requestId}`,
      at: request.endedAt ?? request.startedAt,
      kind: "request-settled",
      ...(request.workFolderId ? { workFolderId: request.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline,
      ref: { taskId: request.taskId, conversationId: request.conversationId, requestId: request.requestId },
    }));
  }
  for (const { workFolder, records } of input.chats) {
    for (const chat of records.slice(0, maxSourceRecords)) {
      const title = clampText(chat.title, maxTitleInHeadline);
      for (const event of chat.lifecycleEvents.slice(0, maxSourceRecords)) {
        add(overviewItem({
          id: `chats:${chat.conversationId}:${event.messageId}`,
          at: event.createdAt,
          kind: "chat-lifecycle",
          workFolderId: workFolder.id,
          workFolderNames: input.workFolderNames,
          headline: chatLifecycleHeadline(title, event),
          ref: { conversationId: chat.conversationId },
        }));
      }
      for (const event of chat.titleEvents.slice(0, maxSourceRecords)) {
        add(overviewItem({
          id: `chats:${chat.conversationId}:${event.messageId}`,
          at: event.createdAt,
          kind: "chat-renamed",
          workFolderId: workFolder.id,
          workFolderNames: input.workFolderNames,
          headline: `Chat renamed to "${clampText(event.title, maxTitleInHeadline)}"`,
          ref: { conversationId: chat.conversationId },
        }));
      }
    }
  }
  for (const { workFolder, records } of input.checks) {
    if (!records) continue;
    for (const run of records.settledRuns.slice(0, maxSourceRecords)) {
      add(overviewItem({
        id: `checks:${workFolder.id}:${run.runId}`,
        at: run.endedAt ?? run.startedAt,
        kind: "check-run-settled",
        workFolderId: workFolder.id,
        workFolderNames: input.workFolderNames,
        headline: `Check run ${run.state} — ${run.admittedCount} finding${run.admittedCount === 1 ? "" : "s"} admitted`,
        ref: { ...(run.taskId ? { taskId: run.taskId } : {}), runId: run.runId },
      }));
    }
  }
  for (const receipt of input.actReceipts.slice(0, maxSourceRecords)) {
    // Terminal records only: `accepted` without a terminal line is the honest
    // interrupted signal, and `rejected` refusals never performed anything.
    if (receipt.outcome !== "ok" && receipt.outcome !== "error") continue;
    const headline = receipt.outcome === "ok"
      ? `Performed ${clampText(receipt.command, maxTitleInHeadline)}${receipt.checkpointId ? " — restore point saved" : ""}`
      : `${clampText(receipt.command, maxTitleInHeadline)} failed`;
    add(overviewItem({
      id: `act-receipts:${receipt.requestId}`,
      at: receipt.at,
      kind: "act-performed",
      ...(receipt.workFolderId ? { workFolderId: receipt.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline,
      ref: {
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
        ...(receipt.conversationId ? { conversationId: receipt.conversationId } : {}),
        ...(receipt.checkpointId ? { checkpointId: receipt.checkpointId } : {}),
        requestId: receipt.requestId,
      },
    }));
  }
  for (const receipt of input.appAutomationReceipts.slice(0, maxSourceRecords)) {
    add(overviewItem({
      id: `app-automation-receipts:${receipt.receiptId}`,
      at: receipt.finishedAt,
      kind: "app-automation-run-settled",
      ...(receipt.workFolderId ? { workFolderId: receipt.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline: `Automation "${clampText(receipt.appAutomationId, maxTitleInHeadline)}" ${appAutomationOutcomeLabel(receipt.outcome)}`,
      ref: { runId: receipt.runId },
    }));
  }
  for (const run of input.automationRuns.slice(0, maxSourceRecords)) {
    if (run.state === "running") continue;
    const subject = run.title ? `Automation "${clampText(run.title, maxTitleInHeadline)}"` : "Automation run";
    const completed = run.hops.filter((hop) => hop.state === "succeeded").length;
    const hopSummary = run.hops.length > 0 ? ` — ${completed}/${run.hops.length} steps completed` : "";
    add(overviewItem({
      id: `automation-runs:${run.runId}`,
      at: run.endedAt ?? run.startedAt,
      kind: "automation-run-settled",
      headline: `${subject} ${run.state}${hopSummary}`,
      ref: { automationId: run.automationId, runId: run.runId },
    }));
  }
  for (const event of input.viewerGrants.slice(0, maxSourceRecords)) {
    if (event.event === "not-available" || event.event === "resting") {
      // The audience got the vague page; the publisher gets the precise
      // reason. The item id carries the note's timestamp so a recurrence
      // after recovery is a new item, while an unchanged note stays one.
      add(overviewItem({
        id: `viewer-grants:${event.publicationId}:problem:${event.at}`,
        at: event.at,
        kind: "publication-state",
        ...(event.workFolderId ? { workFolderId: event.workFolderId, workFolderNames: input.workFolderNames } : {}),
        headline: publicationStateHeadline(event),
        ref: { publicationId: event.publicationId },
      }));
      continue;
    }
    add(overviewItem({
      id: `viewer-grants:${event.publicationId}:${event.event}`,
      at: event.at,
      kind: "viewer-grant-changed",
      ...(event.workFolderId ? { workFolderId: event.workFolderId, workFolderNames: input.workFolderNames } : {}),
      headline: event.event === "created" ? "Started sharing a page" : "Stopped sharing a page",
    }));
  }

  // Bounded twice: per kind first so one chatty source cannot evict every
  // other kind, then in total, newest first.
  let truncated = false;
  const merged: WorkFoldOverviewItem[] = [];
  for (const list of byKind.values()) {
    list.sort(newestFirst);
    if (list.length > workFoldOverviewChangesPerKindCap) truncated = true;
    merged.push(...list.slice(0, workFoldOverviewChangesPerKindCap));
  }
  merged.sort(newestFirst);
  if (merged.length > workFoldOverviewChangesTotalCap) truncated = true;
  return { items: merged.slice(0, workFoldOverviewChangesTotalCap), truncated };
}

function composeCheckRows(
  checks: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: WorkFoldOverviewCheckSource | null }>,
): { rows: WorkFoldOverviewCheckRow[]; truncated: boolean } {
  const rows: WorkFoldOverviewCheckRow[] = [];
  for (const { workFolder, records } of checks) {
    if (!records) continue;
    const status = records.status;
    // Unconfigured means unknown: a work-folder with no configured Checks is absent,
    // never implied healthy.
    if (status.state === "not-configured") continue;
    rows.push({
      workFolderId: workFolder.id,
      workFolderName: workFolder.name,
      state: status.state,
      needsAttention: status.needsAttention,
      neverRun: status.neverRun,
      stale: status.stale,
      blocked: status.blocked,
      errors: status.errors,
      lastRunAt: status.lastRunAt,
    });
  }
  rows.sort((left, right) =>
    checkStatePriority(left.state) - checkStatePriority(right.state)
    || compareStrings(left.workFolderName, right.workFolderName)
    || compareStrings(left.workFolderId, right.workFolderId));
  return {
    rows: rows.slice(0, workFoldOverviewChecksCap),
    truncated: rows.length > workFoldOverviewChecksCap,
  };
}

// --- Chat record derivation ---

/**
 * Derives the overview's typed chat record from a transcript's already-parsed
 * messages plus the summary the Chat list already computes. This is overview
 * semantics over recorded state — which appended events count as lifecycle
 * changes and renames, and which message is "newest" for the question rule
 * (bookkeeping system messages never answer a question, so they are skipped).
 */
export function workFoldOverviewChatRecordFromMessages(
  summary: ConversationSummary,
  messages: ChatMessage[],
): WorkFoldOverviewChatRecord {
  let newestMessage: WorkFoldOverviewChatRecord["newestMessage"] = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    newestMessage = {
      role: message.role,
      createdAt: message.createdAt,
      followUpPrompt: message.landing?.followUpPrompt ?? null,
    };
    break;
  }
  const lifecycleEvents: WorkFoldOverviewChatLifecycleEvent[] = [];
  const titleEvents: WorkFoldOverviewChatTitleEvent[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.kind === "conversation_lifecycle" && message.lifecycle) {
      const patch = message.lifecycle;
      if (patch.archived !== undefined) {
        lifecycleEvents.push({
          messageId: message.id,
          createdAt: message.createdAt,
          change: patch.archived ? "archived" : "restored",
        });
      } else if (patch.snoozedUntil !== undefined) {
        lifecycleEvents.push({
          messageId: message.id,
          createdAt: message.createdAt,
          change: patch.snoozedUntil === null ? "snooze-cleared" : "snoozed",
          ...(patch.snoozedUntil === null ? {} : { snoozedUntil: patch.snoozedUntil }),
        });
      }
      continue;
    }
    // The seed title at creation is not a rename; only later appended manual
    // or generated title events are.
    if (index === 0 || message.kind !== "conversation_title") continue;
    if (message.titleSource !== "manual" && message.titleSource !== "generated") continue;
    titleEvents.push({
      messageId: message.id,
      createdAt: message.createdAt,
      title: message.content,
      source: message.titleSource,
    });
  }
  return {
    conversationId: summary.id,
    title: summary.title,
    archivedAt: summary.archivedAt,
    snoozedUntil: summary.snoozedUntil,
    newestMessage,
    lifecycleEvents,
    titleEvents,
  };
}

// --- Tolerant readers over recorded stores ---
//
// The automation receipts journal and the publication store are read from
// their documented machine-local locations. These readers tolerate a missing file, a
// damaged file, or an unknown version by omission, never by error: while a
// store does not exist, its kinds are simply absent from the digest. The
// local-API wiring may replace a file reader with a service-backed one.

export interface WorkFoldOverviewStoreReaderOptions {
  stateRoot?: string;
}

export function workFoldOverviewAutomationReceiptsFile(stateRoot = workFoldStateRoot()): string {
  return join(stateRoot, "automations", "receipts.jsonl");
}

export function workFoldOverviewAutomationReceiptsRotatedFile(stateRoot = workFoldStateRoot()): string {
  return join(stateRoot, "automations", "receipts.1.jsonl");
}

export function workFoldOverviewPublicationsFile(stateRoot = workFoldStateRoot()): string {
  return join(stateRoot, "shared-pages", "publications.json");
}

export function createWorkFoldOverviewAutomationRunReader(
  options: WorkFoldOverviewStoreReaderOptions = {},
): () => Promise<WorkFoldOverviewAutomationRunRecord[]> {
  const rotatedPath = workFoldOverviewAutomationReceiptsRotatedFile(options.stateRoot);
  const livePath = workFoldOverviewAutomationReceiptsFile(options.stateRoot);
  return async () => {
    const runs = new Map<string, WorkFoldOverviewAutomationRunRecord>();
    for (const path of [rotatedPath, livePath]) {
      const text = await readStoreText(path);
      if (text === null) continue;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        applyAutomationReceiptLine(runs, line);
        // Bound the working set: the journal is rotation-bounded, but a
        // damaged file must not grow an unbounded map here.
        if (runs.size > maxStoreRecords) {
          const oldest = runs.keys().next().value;
          if (oldest !== undefined) runs.delete(oldest);
        }
      }
    }
    return [...runs.values()];
  };
}

export function createWorkFoldOverviewViewerGrantReader(
  options: WorkFoldOverviewStoreReaderOptions = {},
): () => Promise<WorkFoldOverviewViewerGrantEventRecord[]> {
  const path = workFoldOverviewPublicationsFile(options.stateRoot);
  return async () => {
    const parsed = await readJsonStore(path);
    if (parsed === null) return [];
    const entries = Array.isArray(parsed)
      ? parsed
      : storeRecordArray(parsed, "publications");
    if (!entries) return [];
    const events: WorkFoldOverviewViewerGrantEventRecord[] = [];
    for (const entry of entries.slice(0, maxStoreRecords)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as {
        publicationId?: unknown;
        workFolderId?: unknown;
        title?: unknown;
        createdAt?: unknown;
        revokedAt?: unknown;
        lastProblem?: unknown;
      };
      if (!isRecordId(record.publicationId) || !isIsoTimestamp(record.createdAt)) continue;
      const workFolderId = isRecordId(record.workFolderId) ? { workFolderId: record.workFolderId } : {};
      events.push({ publicationId: record.publicationId, event: "created", at: record.createdAt, ...workFolderId });
      if (isIsoTimestamp(record.revokedAt)) {
        events.push({ publicationId: record.publicationId, event: "revoked", at: record.revokedAt, ...workFolderId });
      }
      // The record's one bounded health note (docs/shared-pages.md,
      // "Honest states"): the publisher-facing side of a vague viewer page.
      const problem = record.lastProblem as { state?: unknown; reason?: unknown; at?: unknown } | null | undefined;
      if (
        problem && typeof problem === "object" && !Array.isArray(problem)
        && (problem.state === "not-available" || problem.state === "resting")
        && isIsoTimestamp(problem.at)
      ) {
        events.push({
          publicationId: record.publicationId,
          event: problem.state,
          at: problem.at,
          ...workFolderId,
          ...(typeof record.title === "string" && record.title.length > 0 && record.title.length <= 512
            ? { title: record.title }
            : {}),
          ...(typeof problem.reason === "string" && problem.reason.length > 0 && problem.reason.length <= 512
            ? { reason: problem.reason }
            : {}),
        });
      }
    }
    return events;
  };
}

// --- Internal helpers ---

async function readSource<T>(
  source: WorkFoldOverviewSource,
  reader: (() => Promise<T[]>) | undefined,
  unavailable: Set<WorkFoldOverviewSource>,
): Promise<T[] | null> {
  if (!reader) return null;
  try {
    return (await reader()).slice(0, maxSourceRecords);
  } catch {
    unavailable.add(source);
    return null;
  }
}

async function readWorkFolderSource<T>(
  source: WorkFoldOverviewSource,
  workFolders: WorkFoldOverviewWorkFolderRef[],
  reader: ((workFolder: WorkFoldOverviewWorkFolderRef) => Promise<T>) | undefined,
  unavailable: Set<WorkFoldOverviewSource>,
): Promise<Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: T }>> {
  if (!reader) return [];
  const results: Array<{ workFolder: WorkFoldOverviewWorkFolderRef; records: T }> = [];
  for (const workFolder of workFolders) {
    try {
      results.push({ workFolder, records: await reader(workFolder) });
    } catch {
      // Keep the work-folders that could be read and disclose the failure instead
      // of rendering the whole source as quiet.
      unavailable.add(source);
    }
  }
  return results;
}

function overviewItem(input: {
  id: string;
  at: string;
  kind: WorkFoldOverviewItemKind;
  workFolderId?: string;
  workFolderNames?: Map<string, string>;
  headline: string;
  ref?: WorkFoldOverviewItemRef;
}): WorkFoldOverviewItem {
  const ref = input.ref ? pruneRef(input.ref) : undefined;
  return {
    id: input.id,
    at: input.at,
    kind: input.kind,
    ...(input.workFolderId
      ? {
        workFolderId: input.workFolderId,
        workFolderName: input.workFolderNames?.get(input.workFolderId) ?? `${input.workFolderId} (removed)`,
      }
      : {}),
    headline: clampText(input.headline, maxHeadlineLength),
    ...(ref ? { ref } : {}),
  };
}

function pruneRef(ref: WorkFoldOverviewItemRef): WorkFoldOverviewItemRef | undefined {
  const pruned: WorkFoldOverviewItemRef = {
    ...(ref.taskId ? { taskId: ref.taskId } : {}),
    ...(ref.conversationId ? { conversationId: ref.conversationId } : {}),
    ...(ref.checkpointId ? { checkpointId: ref.checkpointId } : {}),
    ...(ref.requestId ? { requestId: ref.requestId } : {}),
    ...(ref.questionId ? { questionId: ref.questionId } : {}),
    ...(ref.automationId ? { automationId: ref.automationId } : {}),
    ...(ref.runId ? { runId: ref.runId } : {}),
    ...(ref.publicationId ? { publicationId: ref.publicationId } : {}),
  };
  return Object.keys(pruned).length ? pruned : undefined;
}

function newestFirst(left: WorkFoldOverviewItem, right: WorkFoldOverviewItem): number {
  return compareTimestamps(right.at, left.at) || compareStrings(left.id, right.id);
}

function publicationStateHeadline(event: WorkFoldOverviewViewerGrantEventRecord): string {
  const subject = event.title !== undefined
    ? `"${clampText(event.title, maxTitleInHeadline)}"`
    : "A shared page";
  if (event.event === "resting") {
    return `${subject} is resting${event.reason ? ` — ${event.reason}` : " — its viewer budget is used up"}`;
  }
  return `${subject} isn't reaching viewers${event.reason ? ` — ${event.reason}` : ""}`;
}

function chatLifecycleHeadline(title: string, event: WorkFoldOverviewChatLifecycleEvent): string {
  if (event.change === "archived") return `"${title}" archived`;
  if (event.change === "restored") return `"${title}" restored`;
  if (event.change === "snoozed") return `"${title}" snoozed${event.snoozedUntil ? ` until ${event.snoozedUntil}` : ""}`;
  return `"${title}" snooze cleared`;
}

function appAutomationOutcomeLabel(outcome: WorkFoldOverviewAppAutomationOutcome): string {
  if (outcome === "success") return "succeeded";
  if (outcome === "failure") return "failed";
  return outcome;
}

function checkStatePriority(state: WorkFoldCheckAggregateState): number {
  if (state === "needs-attention") return 0;
  if (state === "check-error") return 1;
  if (state === "blocked") return 2;
  if (state === "stale") return 3;
  if (state === "current-clear") return 4;
  return 5;
}

function isAtOrBefore(timestamp: string, referenceMs: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed <= referenceMs;
}

function compareTimestamps(left: string, right: string): number {
  const parsedLeft = Date.parse(left);
  const parsedRight = Date.parse(right);
  if (Number.isFinite(parsedLeft) && Number.isFinite(parsedRight)) {
    return parsedLeft < parsedRight ? -1 : parsedLeft > parsedRight ? 1 : 0;
  }
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clampText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

async function readStoreText(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > maxStoreBytes ? null : text;
  } catch {
    return null;
  }
}

async function readJsonStore(path: string): Promise<unknown | null> {
  const text = await readStoreText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Accepts `{ version: 1, <key>: [...] }`; an unknown store version is omitted whole. */
function storeRecordArray(parsed: unknown, key: string): unknown[] | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) return null;
  const entries = record[key];
  return Array.isArray(entries) ? entries : null;
}

const automationRunTerminalOutcomes = new Map<string, WorkFoldOverviewAutomationRunState>([
  ["ok", "succeeded"],
  ["succeeded", "succeeded"],
  ["error", "failed"],
  ["failed", "failed"],
  ["stopped", "stopped"],
  ["interrupted", "interrupted"],
  ["skipped", "skipped"],
]);

function applyAutomationReceiptLine(runs: Map<string, WorkFoldOverviewAutomationRunRecord>, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as {
    v?: unknown;
    at?: unknown;
    runId?: unknown;
    automationId?: unknown;
    scope?: unknown;
    outcome?: unknown;
    hopId?: unknown;
    title?: unknown;
  };
  if (record.v !== 1) return;
  if (!isIsoTimestamp(record.at) || !isRecordId(record.runId) || !isRecordId(record.automationId)) return;
  if (typeof record.outcome !== "string") return;
  const title = typeof record.title === "string" && record.title.length <= 512 ? { title: record.title } : {};
  const existing = runs.get(record.runId);
  if (record.scope === "run") {
    if (record.outcome === "accepted") {
      runs.set(record.runId, {
        runId: record.runId,
        automationId: record.automationId,
        ...title,
        state: "running",
        startedAt: record.at,
        hops: existing?.hops ?? [],
      });
      return;
    }
    const terminal = automationRunTerminalOutcomes.get(record.outcome);
    if (!terminal) return;
    runs.set(record.runId, {
      runId: record.runId,
      automationId: record.automationId,
      ...(existing?.title ? { title: existing.title } : title),
      state: terminal,
      startedAt: existing?.startedAt ?? record.at,
      endedAt: record.at,
      hops: existing?.hops ?? [],
    });
    return;
  }
  if (record.scope !== "hop" || !isRecordId(record.hopId)) return;
  const hopState = record.outcome === "accepted"
    ? "running"
    : automationRunTerminalOutcomes.get(record.outcome);
  if (!hopState || !existing) return;
  const hops = existing.hops.filter((hop) => hop.id !== record.hopId);
  hops.push({ id: record.hopId, state: hopState });
  runs.set(record.runId, { ...existing, hops });
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxRecordIdLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64
    && Number.isFinite(Date.parse(value));
}
