/**
 * Durable request records: the types, closed-shape parsers, pure state rules,
 * and limit refusals behind F25 (docs/collaboration-contract.md).
 *
 * A request is the machine-local record of one thing a person asked for and
 * everything the fold, a Space Assistant, an app, a routing, or an outside
 * harness on the CLI did about it: the accepted turns, the questions they
 * asked, the results they reported, and the child requests they started. It
 * is attribution and recovery machinery, never a gate — nothing here waits
 * for a click, and nothing here is ever replayed.
 *
 * This module is pure: no filesystem, no clock, no server imports. The store
 * (request-store.ts) owns persistence; the projections in the local API read
 * these shapes. Keeping the rules here means the eleven-step state ladder can
 * be driven directly in tests without a temporary directory.
 *
 * Payload boundary: a request record carries identifiers, counters, enums,
 * the assignment text, and the attachment references it was given. Result
 * envelopes — the part that can reach 288 KB — live in their own files and
 * are referenced from here by id, outcome, and file count only.
 */
import { Buffer } from "node:buffer";

import { workFoldRequestLimits } from "../../shared/fold-limits.js";
import {
  validateRestrictedAppValue,
  type RestrictedAppJsonSchema,
} from "../agent/restricted-app-manifest.js";
import { maxManagementAttachments, type ManagementAttachmentRef } from "../management-attachments.js";
import { containsReservedSpacePathSegment } from "../space-path-policy.js";

export const workFoldRequestRecordSchema = "work-fold.request.v1" as const;
export const workFoldQuestionRecordSchema = "work-fold.request-question.v1" as const;
export const workFoldResultRecordSchema = "work-fold.request-result.v1" as const;

export const workFoldRequestIdPattern = /^req-\d{14}-[0-9a-f]{8}$/;
export const workFoldQuestionIdPattern = /^q-\d{14}-[0-9a-f]{8}$/;
export const workFoldResultIdPattern = /^res-\d{14}-[0-9a-f]{8}$/;

/** The one spelling every request refusal names, shared with the app-facing refusals. */
export const workFoldRequestLimitsSection = "Settings → Desktop → Limits";

const forbiddenTextPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const maximumResultFilePathLength = 1_024;
const maximumErrorLength = 2_048;
const maximumStableIdLength = 160;
const stableIdPattern = /^[A-Za-z0-9._:-]+$/;

export type WorkFoldRequestKind = "management" | "space" | "app" | "routing" | "cli";

export type WorkFoldRequestState =
  | "working"
  | "waiting"
  | "handed_off"
  | "done"
  | "partial"
  | "failed"
  | "stopped"
  | "expired";

/** No outstanding work. Done/partial/failed may reopen through explicit continuation; stop and expiry do not. */
export const workFoldRequestTerminalStates = ["done", "partial", "failed", "stopped", "expired"] as const;

export function isWorkFoldRequestTerminalState(state: WorkFoldRequestState): boolean {
  return (workFoldRequestTerminalStates as readonly string[]).includes(state);
}

/** Where the turn came from. `system` covers routings and app-started work. */
export type WorkFoldRequestSurface =
  | "cli"
  | "popover"
  | "main-window"
  | "remote_web"
  | "renderer"
  | "system";

/** The turn-journal statuses a request aggregates. The journal stays the outcome authority. */
export type WorkFoldRequestTurnState =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";

export type WorkFoldResultOutcome = "succeeded" | "partial" | "failed";

export interface WorkFoldRequestOwner {
  /** Absent exactly for the management scope; present for every Space-owned request. */
  spaceId?: string;
  /** Display snapshot, so an unregistered Space still renders its name. */
  spaceName?: string;
  conversationId: string;
}

export interface WorkFoldRequestAppRef {
  spaceId: string;
  appId: string;
  featureInstallationId: string;
  digest: string;
}

/**
 * Rolled up from every settled turn of this request; attribution only.
 * `amountUsd` sums the costs that were actually reported, and
 * `amountUsdComplete` is false when at least one counted turn ran on a model
 * with no published rates — an unknown cost stays unknown rather than zero.
 */
export interface WorkFoldRequestUsage {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  amountUsd?: number;
  amountUsdComplete: boolean;
}

/** One accepted turn belonging to this request, with its own settled outcome. */
export interface WorkFoldRequestTurnRef {
  taskId: string;
  acceptedAt: string;
  /** `continuation` marks a turn started by an answer or a settle batch. */
  role: "origin" | "continuation";
  state: WorkFoldRequestTurnState;
  settledAt: string | null;
  messageId: string | null;
  error: string | null;
}

/** A recorded result, by reference. The envelope itself lives in its own file. */
export interface WorkFoldRequestResultRef {
  resultId: string;
  taskId: string;
  outcome: WorkFoldResultOutcome;
  recordedAt: string;
  receiptId: string;
  fileCount: number;
}

export type WorkFoldRequestLimitName =
  | "deadline"
  | "childTasks"
  | "depth"
  | "concurrentChildren"
  | "continuations"
  | "providerBudget"
  | "questionLifetime"
  | "questionText"
  | "answerText"
  | "resultSummary"
  | "resultData"
  | "resultFiles"
  | "questionsPerRequest"
  | "resultsPerRequest"
  | "turnsPerRequest"
  | "actionsPerRequest";

export interface WorkFoldRequestLimitHit {
  limit: WorkFoldRequestLimitName;
  at: string;
}

/**
 * Every landed act-lane mutation verb (docs/fold-act-ledger.md). One entry per
 * explicitly attributed act, so a request's story stays complete; consumers
 * render the commands they understand and fall back to the command token for
 * the rest. Act reads carry no lineage and are deliberately absent.
 */
export const workFoldRequestActionCommands = [
  "spaces.assistant.model",
  "spaces.assistant.instructions",
  "chat.send",
  "chat.rename",
  "chat.snooze",
  "chat.archive",
  "chat.resume",
  "chat.compact",
  // The collaboration verbs (F27): attributed like every other act, and
  // recorded by identifiers only — the report, question, and answer text
  // live in their own records, never in the action trail.
  "chat.report",
  "chat.ask",
  "chat.answer",
  "chat.handoff",
  "history.save",
  "history.restore",
  "history.restore-file",
  "files.add",
  "files.move",
  "files.rename",
  "files.delete",
  "files.mkdir",
  "files.create",
  "library.add",
  "library.folder.create",
  "library.copy",
  "spaces.create",
  "spaces.register",
  "spaces.rename",
  "spaces.unregister",
  "spaces.delete",
  "spaces.appearance.apply",
  "spaces.appearance.reset",
  "spaces.appearance.undo",
  "tools.import-skill",
  "tools.install",
  "tools.update",
  "tools.enable",
  "tools.disable",
  "tools.remove",
  "apps.proposals.dismiss",
  "apps.install-proposal",
  "apps.install-preview",
  "apps.remove",
  "apps.grant",
  "apps.revoke",
  "apps.connect",
  "apps.disconnect",
  "apps.automation.enable",
  "apps.automation.disable",
  "apps.automation.run",
  "apps.invoke",
  "apps.storage.clear",
  "apps.retained.purge",
  "apps.project.declare",
  "apps.release.prepare",
  "apps.release.publish",
  "apps.release.delete",
  "apps.install.prepare",
  "apps.update.prepare",
  "apps.operation.activate",
  "apps.operation.cancel",
  "apps.uninstall",
  "routings.enable",
  "pages.share",
  "pages.share-app",
  "trash.restore",
] as const;

export type WorkFoldRequestActionCommand = (typeof workFoldRequestActionCommands)[number];

export interface WorkFoldRequestAction {
  command: WorkFoldRequestActionCommand;
  at: string;
  /**
   * Absent exactly for Space-free acts: the personal Library verbs and
   * personal-scope tools removal. Every Space-bound act names its Space.
   */
  spaceId?: string;
  spaceName?: string;
  /** Resolved absolute source paths for files.add; used to match dispositions. */
  sources?: string[];
  /** Space-relative destinations reported by files.add. */
  copied?: string[];
  checkpointId?: string | null;
  /** Registered or created Space root. */
  spaceRoot?: string;
  conversationId?: string;
  taskId?: string;
  /** Exact installation produced by a completed app operation. Never resolved by display name. */
  apps?: Array<{
    spaceId: string;
    appId: string;
    featureInstallationId: string;
    digest: string;
    title: string;
    version: string;
  }>;
}

export interface WorkFoldRequestRemoteRef {
  principalId: string;
  grantId: string;
  requestId: string;
}

export interface WorkFoldRequestRecord {
  schema: typeof workFoldRequestRecordSchema;
  requestId: string;
  kind: WorkFoldRequestKind;
  /** Equal to `requestId` for a root. */
  rootId: string;
  parentRequestId: string | null;
  /** The exact parent task id the caller named, kept for attribution. */
  parentTaskId: string | null;
  /** 0 for a root. */
  depth: number;
  owner: WorkFoldRequestOwner;
  app?: WorkFoldRequestAppRef;
  surface: WorkFoldRequestSurface;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  /** A legacy request window, or `null` for work that does not expire on a timer. */
  deadline: string | null;
  state: WorkFoldRequestState;
  /** `turns[0].role` is always `origin`. */
  turns: WorkFoldRequestTurnRef[];
  childRequestIds: string[];
  questionIds: string[];
  results: WorkFoldRequestResultRef[];
  usage: WorkFoldRequestUsage;
  continuationCount: number;
  /** Settled child turns already reserved for delivery, independent of timing. */
  deliveredChildTaskIds: string[];
  continuationState: "pending" | "failed" | null;
  stopRequestedAt: string | null;
  limitHit: WorkFoldRequestLimitHit | null;
  /** Set when startup reconciliation settled this request, so no one continues it. */
  reconciledAt: string | null;
  remote: WorkFoldRequestRemoteRef | null;
  /** The original assignment, retained when answers and follow-ups join. */
  assignment: string;
  /** The newest turn's message text, bounded. */
  content: string;
  attachments: ManagementAttachmentRef[];
  actions: WorkFoldRequestAction[];
  continuedFromTaskId: string | null;
}

export interface WorkFoldQuestionRecord {
  schema: typeof workFoldQuestionRecordSchema;
  questionId: string;
  requestId: string;
  /** Denormalized so "any open question under this root" is one index hit. */
  rootId: string;
  /** The asking turn. */
  taskId: string;
  respondent: "person" | "parent";
  text: string;
  askedAt: string;
  updatedAt: string;
  /** A question lives exactly as long as its request. */
  expiresAt: string | null;
  state: "open" | "answered" | "expired" | "cancelled";
  answer: string | null;
  answeredAt: string | null;
  /** The single linked continuation turn an answer starts; set once, never twice. */
  continuationTaskId: string | null;
  /** Enforces the refusal of an answer from a Space that does not own the question. */
  answeredBySpaceId: string | null;
}

export interface WorkFoldResultFileRef {
  /** Space-relative deliverable path. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkFoldResultEnvelope {
  summary: string;
  data?: unknown;
  files?: WorkFoldResultFileRef[];
  outcome: WorkFoldResultOutcome;
}

export interface WorkFoldResultRecord {
  schema: typeof workFoldResultRecordSchema;
  resultId: string;
  requestId: string;
  rootId: string;
  taskId: string;
  recordedAt: string;
  /** The act receipt id the reporting verb journaled. */
  receiptId: string;
  envelope: WorkFoldResultEnvelope;
}

/**
 * A bound was reached. The message always names the number and the Settings
 * section that shows it, because a bound a person cannot find is a gate in
 * disguise (docs/receipts-not-gates.md, principle 6).
 */
export class WorkFoldRequestLimitError extends Error {
  readonly limit: WorkFoldRequestLimitName;

  constructor(limit: WorkFoldRequestLimitName, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkFoldRequestLimitError";
    this.limit = limit;
  }
}

/** Something about the request graph itself is wrong; not a bound, so not a limit error. */
export class WorkFoldRequestLineageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkFoldRequestLineageError";
  }
}

function kilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * The person-facing text for one bound. `cap` is the number actually
 * enforced, so a host that raises a default cannot leave a stale number in
 * the refusal.
 */
export function workFoldRequestLimitMessage(limit: WorkFoldRequestLimitName, cap: number): string {
  const shows = `${workFoldRequestLimitsSection} shows this number.`;
  switch (limit) {
    case "deadline":
      return `This request passed its ${Math.round(cap / 3_600_000)}-hour window, so work-fold stopped it. ${shows}`;
    case "childTasks":
      return `This request has already started ${cap} Space turns, the most one request may start. ${shows}`;
    case "depth":
      return `This request is already ${cap} levels deep, as deep as one request may go. ${shows}`;
    case "concurrentChildren":
      return `This request already has ${cap} Space turns running at once, the most it may run together. ${shows}`;
    case "continuations":
      return `This request already got ${cap} follow-up turns, so work-fold recorded this result without starting another. ${shows}`;
    case "providerBudget":
      return `This request reached its model spending limit of $${cap}, so work-fold stopped it. ${shows}`;
    case "questionLifetime":
      return `This question's request passed its ${Math.round(cap / 3_600_000)}-hour window, so it can no longer be answered. ${shows}`;
    case "questionText":
      return `A question may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "answerText":
      return `An answer may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "resultSummary":
      return `A result summary may be at most ${kilobytes(cap)} of text. ${shows}`;
    case "resultData":
      return `Result details may be at most ${kilobytes(cap)} of JSON. ${shows}`;
    case "resultFiles":
      return `A result may name at most ${cap} files. ${shows}`;
    case "questionsPerRequest":
      return `This request already holds ${cap} questions, the most one request may hold. ${shows}`;
    case "resultsPerRequest":
      return `This request already holds ${cap} results, the most one request may hold. ${shows}`;
    case "turnsPerRequest":
      return `This request already holds ${cap} turns, the most one request may hold. ${shows}`;
    case "actionsPerRequest":
      return `This request already recorded ${cap} actions, the most one request may record. ${shows}`;
  }
}

export function workFoldRequestLimitError(limit: WorkFoldRequestLimitName, cap: number): WorkFoldRequestLimitError {
  return new WorkFoldRequestLimitError(limit, workFoldRequestLimitMessage(limit, cap));
}

export interface WorkFoldRequestStateInput {
  stopRequestedAt: string | null;
  deadline: string | null;
  now: Date;
  /** This request's own turns, in acceptance order. */
  turnStates: readonly WorkFoldRequestTurnState[];
  /** Open questions this request asked itself. */
  openQuestions: number;
  /** Open questions anywhere below this request. */
  openDescendantQuestions: number;
  /** One entry per recorded child id; `null` when that id resolves to no record. */
  childStates: readonly (WorkFoldRequestState | null)[];
  resultOutcomes: readonly WorkFoldResultOutcome[];
  limitHit: WorkFoldRequestLimitHit | null;
}

/**
 * The one place a request's state is decided, in a fixed precedence so the
 * same facts always read the same way:
 *
 *  1. a stop was asked for                        → stopped
 *  2. one of this request's turns was stopped     → stopped
 *  3. the model spending bound was reached        → failed
 *  4. the window closed with work outstanding     → expired
 *  5. a question this request asked is open       → waiting
 *  6. one of this request's turns is running      → working
 *  7. a question below this request is open       → waiting
 *  8. a child is still working                    → handed_off
 *  9. a turn failed, a child failed, or a child id resolves to nothing → failed
 * 10. a child was stopped or ran out of time      → stopped
 * 11. a recorded result came back partial or failed → partial
 * 12. otherwise                                   → done
 *
 * Rules 1-3 dominate so a stop or a spending stop is never narrated as done.
 * Rule 5 above rule 6 is F27: asking puts the asking task in `waiting`, even
 * while its turn is still live, so the question reaches Needs you. Rule 6
 * above rule 7 is F28: a parent is working while its own turn runs, and only
 * once that turn ends does a child's open question make the parent report
 * `waiting` rather than blocking on it. Rules 6-8 keep the older promise that
 * a request never claims `done` while work it started is still running. Rule
 * 10 above rule 11 means a mixed set of stopped and finished children reads as
 * `stopped` rather than as partial success.
 */
export function computeWorkFoldRequestState(input: WorkFoldRequestStateInput): WorkFoldRequestState {
  if (input.stopRequestedAt !== null) return "stopped";
  if (input.turnStates.includes("aborted")) return "stopped";
  if (input.limitHit?.limit === "providerBudget") return "failed";

  const running = input.turnStates.some((state) => state === "accepted" || state === "running");
  const outstanding = running
    || input.openQuestions > 0
    || input.openDescendantQuestions > 0
    || input.childStates.some((state) => state === "working" || state === "waiting" || state === "handed_off");
  const deadlineAt = input.deadline ? Date.parse(input.deadline) : Number.NaN;
  if (outstanding && Number.isFinite(deadlineAt) && input.now.getTime() >= deadlineAt) return "expired";

  if (input.openQuestions > 0) return "waiting";
  if (running) return "working";
  if (input.openDescendantQuestions > 0) return "waiting";
  if (input.childStates.some((state) => state === "working" || state === "waiting" || state === "handed_off")) {
    return "handed_off";
  }
  if (input.turnStates.some((state) => state === "failed" || state === "interrupted")) return "failed";
  if (input.childStates.some((state) => state === null || state === "failed")) return "failed";
  if (input.childStates.some((state) => state === "stopped" || state === "expired")) return "stopped";
  if (input.resultOutcomes.some((outcome) => outcome === "partial" || outcome === "failed")) return "partial";
  if (input.childStates.some((state) => state === "partial")) return "partial";
  return "done";
}

/**
 * The phase vocabulary `manage status` and the popover already speak. The
 * true F25 state travels beside it, so those surfaces keep compiling while
 * the richer vocabulary reaches the ones that want it.
 */
export type WorkFoldRequestManagementPhase =
  | "working"
  | "needs_you"
  | "handed_off"
  | "done"
  | "failed"
  | "stopped";

export function workFoldRequestStateToManagementPhase(
  state: WorkFoldRequestState,
  _legacyReplyAsksQuestion = false,
): WorkFoldRequestManagementPhase {
  const phase = ((): WorkFoldRequestManagementPhase => {
    switch (state) {
      case "working":
        return "working";
      case "waiting":
        return "needs_you";
      case "handed_off":
        return "handed_off";
      case "done":
      case "partial":
        return "done";
      case "failed":
        return "failed";
      case "stopped":
      case "expired":
        return "stopped";
    }
  })();
  return phase;
}

/** `local` or `remote_web`, derived rather than stored twice. */
export function workFoldRequestSource(record: WorkFoldRequestRecord): "local" | "remote_web" {
  return record.remote ? "remote_web" : "local";
}

// --- parsers -------------------------------------------------------------

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertClosedShape(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${label} has an unexpected field: ${unexpected}.`);
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length || value.length > maximumStableIdLength || !stableIdPattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function nullableIsoDate(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return isoDate(value, label);
}

function boundedText(value: unknown, label: string, maxBytes: number, limit?: WorkFoldRequestLimitName): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    if (limit) throw workFoldRequestLimitError(limit, maxBytes);
    throw new Error(`${label} is longer than ${maxBytes} bytes.`);
  }
  if (forbiddenTextPattern.test(value.replace(/[\n\r\t]/g, " "))) {
    throw new Error(`${label} contains unsupported control characters.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function stringArray(value: unknown, label: string, maxItems?: number): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  if (maxItems !== undefined && value.length > maxItems) throw new Error(`${label} holds more than ${maxItems} entries.`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.length || item.length > maximumResultFilePathLength) {
      throw new Error(`${label} entry ${index + 1} is invalid.`);
    }
    return item;
  });
}

export function parseWorkFoldAttachmentRef(value: unknown, label: string): ManagementAttachmentRef {
  const record = objectValue(value, label);
  assertClosedShape(record, ["kind", "target", "name"], label);
  return {
    kind: enumValue(record.kind, ["file", "folder", "url"] as const, `${label} kind`),
    target: boundedText(record.target, `${label} target`, 4_096),
    name: boundedText(record.name, `${label} name`, 1_024),
  };
}

export function parseWorkFoldRequestAction(value: unknown, label = "Request action"): WorkFoldRequestAction {
  const record = objectValue(value, label);
  assertClosedShape(
    record,
    ["command", "at", "spaceId", "spaceName", "sources", "copied", "checkpointId", "spaceRoot", "conversationId", "taskId", "apps"],
    label,
  );
  const action: WorkFoldRequestAction = {
    command: enumValue(record.command, workFoldRequestActionCommands, `${label} command`),
    at: isoDate(record.at, `${label} time`),
  };
  if (record.spaceId !== undefined) action.spaceId = stableId(record.spaceId, `${label} Space id`);
  if (record.spaceName !== undefined) action.spaceName = boundedText(record.spaceName, `${label} Space name`, 1_024);
  if (record.sources !== undefined) action.sources = stringArray(record.sources, `${label} sources`, 256);
  if (record.copied !== undefined) action.copied = stringArray(record.copied, `${label} destinations`, 256);
  if (record.checkpointId !== undefined) {
    action.checkpointId = record.checkpointId === null ? null : stableId(record.checkpointId, `${label} restore point`);
  }
  if (record.spaceRoot !== undefined) action.spaceRoot = boundedText(record.spaceRoot, `${label} Space folder`, 4_096);
  if (record.conversationId !== undefined) action.conversationId = stableId(record.conversationId, `${label} conversation id`);
  if (record.taskId !== undefined) action.taskId = stableId(record.taskId, `${label} task id`);
  if (record.apps !== undefined) {
    if (!Array.isArray(record.apps) || record.apps.length > 64) throw new Error(`${label} apps are invalid.`);
    action.apps = record.apps.map((item, index) => {
      const app = objectValue(item, `${label} app ${index + 1}`);
      assertClosedShape(app, ["spaceId", "appId", "featureInstallationId", "digest", "title", "version"], `${label} app ${index + 1}`);
      return {
        spaceId: stableId(app.spaceId, `${label} app Space id`),
        appId: stableId(app.appId, `${label} app id`),
        featureInstallationId: stableId(app.featureInstallationId, `${label} app installation id`),
        digest: stableId(app.digest, `${label} app fingerprint`),
        title: boundedText(app.title, `${label} app title`, 1_024),
        version: boundedText(app.version, `${label} app version`, 128),
      };
    });
  }
  return action;
}

function parseTurnRef(value: unknown, index: number): WorkFoldRequestTurnRef {
  const label = `Request turn ${index + 1}`;
  const record = objectValue(value, label);
  assertClosedShape(record, ["taskId", "acceptedAt", "role", "state", "settledAt", "messageId", "error"], label);
  return {
    taskId: stableId(record.taskId, `${label} task id`),
    acceptedAt: isoDate(record.acceptedAt, `${label} acceptance time`),
    role: enumValue(record.role, ["origin", "continuation"] as const, `${label} role`),
    state: enumValue(
      record.state,
      ["accepted", "running", "succeeded", "failed", "aborted", "interrupted"] as const,
      `${label} state`,
    ),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    messageId: record.messageId === null || record.messageId === undefined
      ? null
      : stableId(record.messageId, `${label} reply id`),
    error: record.error === null || record.error === undefined
      ? null
      : boundedText(record.error, `${label} error`, maximumErrorLength),
  };
}

function parseResultRef(value: unknown, index: number): WorkFoldRequestResultRef {
  const label = `Request result ${index + 1}`;
  const record = objectValue(value, label);
  assertClosedShape(record, ["resultId", "taskId", "outcome", "recordedAt", "receiptId", "fileCount"], label);
  const resultId = stableId(record.resultId, `${label} id`);
  if (!workFoldResultIdPattern.test(resultId)) throw new Error(`${label} id is invalid.`);
  return {
    resultId,
    taskId: stableId(record.taskId, `${label} task id`),
    outcome: enumValue(record.outcome, ["succeeded", "partial", "failed"] as const, `${label} outcome`),
    recordedAt: isoDate(record.recordedAt, `${label} time`),
    receiptId: stableId(record.receiptId, `${label} receipt id`),
    fileCount: nonNegativeInteger(record.fileCount, `${label} file count`),
  };
}

function parseUsage(value: unknown): WorkFoldRequestUsage {
  const record = objectValue(value, "Request usage");
  assertClosedShape(record, ["turns", "inputTokens", "outputTokens", "amountUsd", "amountUsdComplete"], "Request usage");
  if (typeof record.amountUsdComplete !== "boolean") throw new Error("Request usage completeness is invalid.");
  const usage: WorkFoldRequestUsage = {
    turns: nonNegativeInteger(record.turns, "Request usage turn count"),
    inputTokens: nonNegativeInteger(record.inputTokens, "Request usage input tokens"),
    outputTokens: nonNegativeInteger(record.outputTokens, "Request usage output tokens"),
    amountUsdComplete: record.amountUsdComplete,
  };
  if (record.amountUsd !== undefined) {
    if (typeof record.amountUsd !== "number" || !Number.isFinite(record.amountUsd) || record.amountUsd < 0) {
      throw new Error("Request usage cost is invalid.");
    }
    usage.amountUsd = record.amountUsd;
  }
  return usage;
}

export function parseWorkFoldRequestRecord(value: unknown): WorkFoldRequestRecord {
  const label = "Request record";
  const record = objectValue(value, label);
  if (record.schema !== workFoldRequestRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(
    record,
    [
      "schema", "requestId", "kind", "rootId", "parentRequestId", "parentTaskId", "depth", "owner", "app", "surface",
      "createdAt", "updatedAt", "settledAt", "deadline", "state", "turns", "childRequestIds", "questionIds", "results",
      "usage", "continuationCount", "stopRequestedAt", "limitHit", "reconciledAt", "remote", "content", "attachments",
      "actions", "continuedFromTaskId", "assignment", "deliveredChildTaskIds", "continuationState",
    ],
    label,
  );
  const requestId = stableId(record.requestId, `${label} id`);
  if (!workFoldRequestIdPattern.test(requestId)) throw new Error(`${label} id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!workFoldRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);

  const ownerRecord = objectValue(record.owner, `${label} owner`);
  assertClosedShape(ownerRecord, ["spaceId", "spaceName", "conversationId"], `${label} owner`);
  const owner: WorkFoldRequestOwner = { conversationId: stableId(ownerRecord.conversationId, `${label} conversation id`) };
  if (ownerRecord.spaceId !== undefined) owner.spaceId = stableId(ownerRecord.spaceId, `${label} Space id`);
  if (ownerRecord.spaceName !== undefined) owner.spaceName = boundedText(ownerRecord.spaceName, `${label} Space name`, 1_024);

  const turns = Array.isArray(record.turns) ? record.turns.map(parseTurnRef) : null;
  if (!turns || !turns.length) {
    throw new Error(`${label} turns are invalid.`);
  }
  if (turns[0]!.role !== "origin") throw new Error(`${label} does not start with its own turn.`);

  const parsed: WorkFoldRequestRecord = {
    schema: workFoldRequestRecordSchema,
    requestId,
    kind: enumValue(record.kind, ["management", "space", "app", "routing", "cli"] as const, `${label} kind`),
    rootId,
    parentRequestId: record.parentRequestId === null || record.parentRequestId === undefined
      ? null
      : stableId(record.parentRequestId, `${label} parent id`),
    parentTaskId: record.parentTaskId === null || record.parentTaskId === undefined
      ? null
      : stableId(record.parentTaskId, `${label} parent task id`),
    depth: nonNegativeInteger(record.depth, `${label} depth`),
    owner,
    surface: enumValue(
      record.surface,
      ["cli", "popover", "main-window", "remote_web", "renderer", "system"] as const,
      `${label} surface`,
    ),
    createdAt: isoDate(record.createdAt, `${label} creation time`),
    updatedAt: isoDate(record.updatedAt, `${label} update time`),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    deadline: nullableIsoDate(record.deadline, `${label} window`),
    state: enumValue(
      record.state,
      ["working", "waiting", "handed_off", "done", "partial", "failed", "stopped", "expired"] as const,
      `${label} state`,
    ),
    turns,
    childRequestIds: stringArray(record.childRequestIds, `${label} child ids`)
      .map((id) => {
        if (!workFoldRequestIdPattern.test(id)) throw new Error(`${label} child id is invalid.`);
        return id;
      }),
    questionIds: stringArray(record.questionIds, `${label} question ids`)
      .map((id) => {
        if (!workFoldQuestionIdPattern.test(id)) throw new Error(`${label} question id is invalid.`);
        return id;
      }),
    results: Array.isArray(record.results)
      ? record.results.map(parseResultRef)
      : (() => { throw new Error(`${label} results are invalid.`); })(),
    usage: parseUsage(record.usage),
    continuationCount: nonNegativeInteger(record.continuationCount, `${label} follow-up count`),
    deliveredChildTaskIds: stringArray(record.deliveredChildTaskIds ?? [], `${label} delivered children`),
    continuationState: record.continuationState === null || record.continuationState === undefined ? null
      : enumValue(record.continuationState, ["pending", "failed"] as const, `${label} continuation`),
    stopRequestedAt: nullableIsoDate(record.stopRequestedAt, `${label} stop time`),
    limitHit: record.limitHit === null || record.limitHit === undefined ? null : parseLimitHit(record.limitHit, label),
    reconciledAt: nullableIsoDate(record.reconciledAt, `${label} recovery time`),
    remote: record.remote === null || record.remote === undefined ? null : parseRemoteRef(record.remote, label),
    content: boundedText(record.content, `${label} message`, workFoldRequestLimits.maxRequestContentBytes),
    assignment: boundedText(record.assignment ?? record.content, `${label} assignment`, workFoldRequestLimits.maxRequestContentBytes),
    attachments: Array.isArray(record.attachments) && record.attachments.length <= maxManagementAttachments
      ? record.attachments.map((item, index) => parseWorkFoldAttachmentRef(item, `${label} attachment ${index + 1}`))
      : (() => { throw new Error(`${label} attachments are invalid.`); })(),
    actions: Array.isArray(record.actions)
      ? record.actions.map((item, index) => parseWorkFoldRequestAction(item, `${label} action ${index + 1}`))
      : (() => { throw new Error(`${label} actions are invalid.`); })(),
    continuedFromTaskId: record.continuedFromTaskId === null || record.continuedFromTaskId === undefined
      ? null
      : stableId(record.continuedFromTaskId, `${label} earlier task id`),
  };
  if (record.app !== undefined) {
    const app = objectValue(record.app, `${label} app`);
    assertClosedShape(app, ["spaceId", "appId", "featureInstallationId", "digest"], `${label} app`);
    parsed.app = {
      spaceId: stableId(app.spaceId, `${label} app Space id`),
      appId: stableId(app.appId, `${label} app id`),
      featureInstallationId: stableId(app.featureInstallationId, `${label} app installation id`),
      digest: stableId(app.digest, `${label} app fingerprint`),
    };
  }
  if (parsed.parentRequestId === null && parsed.rootId !== parsed.requestId) {
    throw new Error(`${label} claims a root it does not belong to.`);
  }
  return parsed;
}

function parseLimitHit(value: unknown, label: string): WorkFoldRequestLimitHit {
  const record = objectValue(value, `${label} limit`);
  assertClosedShape(record, ["limit", "at"], `${label} limit`);
  return {
    limit: enumValue(
      record.limit,
      [
        "deadline", "childTasks", "depth", "concurrentChildren", "continuations", "providerBudget", "questionLifetime",
        "questionText", "answerText", "resultSummary", "resultData", "resultFiles", "questionsPerRequest",
        "resultsPerRequest", "turnsPerRequest", "actionsPerRequest",
      ] as const,
      `${label} limit name`,
    ),
    at: isoDate(record.at, `${label} limit time`),
  };
}

function parseRemoteRef(value: unknown, label: string): WorkFoldRequestRemoteRef {
  const record = objectValue(value, `${label} remote reference`);
  assertClosedShape(record, ["principalId", "grantId", "requestId"], `${label} remote reference`);
  return {
    principalId: stableId(record.principalId, `${label} remote principal id`),
    grantId: stableId(record.grantId, `${label} remote grant id`),
    requestId: stableId(record.requestId, `${label} remote request id`),
  };
}

export function parseWorkFoldQuestionRecord(value: unknown): WorkFoldQuestionRecord {
  const label = "Question record";
  const record = objectValue(value, label);
  if (record.schema !== workFoldQuestionRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(
    record,
    [
      "schema", "questionId", "requestId", "rootId", "taskId", "respondent", "text", "askedAt", "updatedAt",
      "expiresAt", "state", "answer", "answeredAt", "continuationTaskId", "answeredBySpaceId",
    ],
    label,
  );
  const questionId = stableId(record.questionId, `${label} id`);
  if (!workFoldQuestionIdPattern.test(questionId)) throw new Error(`${label} id is invalid.`);
  const requestId = stableId(record.requestId, `${label} request id`);
  if (!workFoldRequestIdPattern.test(requestId)) throw new Error(`${label} request id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!workFoldRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);
  return {
    schema: workFoldQuestionRecordSchema,
    questionId,
    requestId,
    rootId,
    taskId: stableId(record.taskId, `${label} task id`),
    respondent: enumValue(record.respondent, ["person", "parent"] as const, `${label} respondent`),
    text: boundedText(record.text, `${label} text`, workFoldRequestLimits.maxQuestionTextBytes, "questionText"),
    askedAt: isoDate(record.askedAt, `${label} time`),
    updatedAt: isoDate(record.updatedAt, `${label} update time`),
    expiresAt: nullableIsoDate(record.expiresAt, `${label} window`),
    state: enumValue(record.state, ["open", "answered", "expired", "cancelled"] as const, `${label} state`),
    answer: record.answer === null || record.answer === undefined
      ? null
      : boundedText(record.answer, `${label} answer`, workFoldRequestLimits.maxAnswerTextBytes, "answerText"),
    answeredAt: nullableIsoDate(record.answeredAt, `${label} answer time`),
    continuationTaskId: record.continuationTaskId === null || record.continuationTaskId === undefined
      ? null
      : stableId(record.continuationTaskId, `${label} follow-up task id`),
    answeredBySpaceId: record.answeredBySpaceId === null || record.answeredBySpaceId === undefined
      ? null
      : stableId(record.answeredBySpaceId, `${label} answering Space id`),
  };
}

/**
 * The one result shape (F29). Sizes are bounds, so a refusal here is a
 * `WorkFoldRequestLimitError` that names its number; anything else about the
 * shape is an ordinary error.
 */
export function parseWorkFoldResultEnvelope(
  value: unknown,
  options: { schema?: RestrictedAppJsonSchema } = {},
): WorkFoldResultEnvelope {
  const label = "Result";
  const record = objectValue(value, label);
  assertClosedShape(record, ["summary", "data", "files", "outcome"], label);
  const summary = boundedText(record.summary, `${label} summary`, workFoldRequestLimits.maxResultSummaryBytes, "resultSummary");
  if (!summary.trim()) throw new Error(`${label} summary cannot be empty.`);
  const envelope: WorkFoldResultEnvelope = {
    summary,
    outcome: enumValue(record.outcome, ["succeeded", "partial", "failed"] as const, `${label} outcome`),
  };
  if (record.data !== undefined) {
    const serialized = JSON.stringify(record.data);
    if (serialized === undefined) throw new Error(`${label} details must be JSON.`);
    if (Buffer.byteLength(serialized, "utf8") > workFoldRequestLimits.maxResultDataBytes) {
      throw workFoldRequestLimitError("resultData", workFoldRequestLimits.maxResultDataBytes);
    }
    if (options.schema) validateRestrictedAppValue(options.schema, record.data, `${label} details`);
    envelope.data = JSON.parse(serialized) as unknown;
  }
  if (record.files !== undefined) {
    if (!Array.isArray(record.files)) throw new Error(`${label} files must be a list.`);
    envelope.files = record.files.map((item, index) => parseResultFileRef(item, `${label} file ${index + 1}`));
  }
  return envelope;
}

function parseResultFileRef(value: unknown, label: string): WorkFoldResultFileRef {
  const record = objectValue(value, label);
  assertClosedShape(record, ["path", "sha256", "sizeBytes"], label);
  const path = boundedText(record.path, `${label} path`, maximumResultFilePathLength);
  assertSpaceRelativeResultPath(path, label);
  if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`${label} fingerprint is invalid.`);
  return { path, sha256: record.sha256, sizeBytes: nonNegativeInteger(record.sizeBytes, `${label} size`) };
}

/**
 * A deliverable is named relative to the Space that produced it. Absolute
 * paths, parent traversal, and the reserved work-fold, Pi, and legacy product
 * folders are never valid endpoints (AGENTS.md, portable identity).
 */
export function assertSpaceRelativeResultPath(path: string, label = "Result file"): void {
  if (!path.length) throw new Error(`${label} path cannot be empty.`);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`${label} path must be relative to the Space.`);
  }
  const segments = path.split(/[\\/]+/u);
  if (segments.some((segment) => segment === ".." || segment === "." || !segment.length)) {
    throw new Error(`${label} path must be relative to the Space.`);
  }
  if (containsReservedSpacePathSegment(path)) {
    throw new Error(`${label} path names reserved work-fold, Pi, or legacy product metadata.`);
  }
}

export function parseWorkFoldResultRecord(value: unknown): WorkFoldResultRecord {
  const label = "Result record";
  const record = objectValue(value, label);
  if (record.schema !== workFoldResultRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(record, ["schema", "resultId", "requestId", "rootId", "taskId", "recordedAt", "receiptId", "envelope"], label);
  const resultId = stableId(record.resultId, `${label} id`);
  if (!workFoldResultIdPattern.test(resultId)) throw new Error(`${label} id is invalid.`);
  const requestId = stableId(record.requestId, `${label} request id`);
  if (!workFoldRequestIdPattern.test(requestId)) throw new Error(`${label} request id is invalid.`);
  const rootId = stableId(record.rootId, `${label} root id`);
  if (!workFoldRequestIdPattern.test(rootId)) throw new Error(`${label} root id is invalid.`);
  return {
    schema: workFoldResultRecordSchema,
    resultId,
    requestId,
    rootId,
    taskId: stableId(record.taskId, `${label} task id`),
    recordedAt: isoDate(record.recordedAt, `${label} time`),
    receiptId: stableId(record.receiptId, `${label} receipt id`),
    envelope: parseWorkFoldResultEnvelope(record.envelope),
  };
}
