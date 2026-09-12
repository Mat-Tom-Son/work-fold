import { workFoldRequestLimits } from "./fold-limits.js";
import type { RestrictedAppInferenceModelRef, RestrictedAppInferenceUsage } from "./restricted-app-inference.js";

/**
 * The provider and model that actually ran the work, and what it used. Both
 * app AI lanes carry the same two fields under the same names so a request
 * receipt and a short-answer receipt read alike.
 */
export type RestrictedAppAssistantModelRef = RestrictedAppInferenceModelRef;

/**
 * `amountUsd` is present only when the effective model carries pricing work-fold
 * can apply. A model without published rates leaves the cost unknown; it is
 * never reported as zero.
 */
export type RestrictedAppAssistantUsage = RestrictedAppInferenceUsage & { amountUsd?: number };

/** How the Assistant itself described the outcome of the work it reported. */
export type RestrictedAppResultOutcome = "succeeded" | "partial" | "failed";

/** One deliverable the Assistant chose to hand back, named relative to the Space. */
export interface RestrictedAppResultFile {
  path: string;
  /** Lowercase hex SHA-256 of the file's bytes when the result was recorded. */
  sha256: string;
  sizeBytes: number;
}

/**
 * The one result shape (docs/collaboration-contract.md, F29): a bounded
 * `summary`, the Assistant's own `outcome`, optional `data` when the action
 * declared an output shape, and optional `files` the Assistant chose to hand
 * back. `truncated` is the app-side addition: it says the envelope did not fit
 * the published bound and what the app holds is the trimmed version.
 *
 * Field names match `WorkFoldResultEnvelope`
 * (src/local/requests/request-records.ts) exactly, so a report filed by a Space
 * Assistant projects onto an app task without translation. Turn `fileChanges`
 * evidence never becomes `files`: those are the deliverables the Assistant
 * named, not everything the turn happened to touch.
 */
export interface RestrictedAppTaskResult {
  summary: string;
  truncated: boolean;
  outcome: RestrictedAppResultOutcome;
  data?: unknown;
  files?: RestrictedAppResultFile[];
}

/** Public projection of one app-requested Space Assistant task. */
export interface RestrictedAppAssistantTask {
  id: string;
  requestId: string;
  actionId: string;
  title: string;
  status: "dispatching" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  /** Dispatch time. A request is journaled and dispatched in the same call. */
  startedAt: string;
  cancellationRequested?: true;
  /** Present after the request completes. No other Chat messages are exposed. */
  result?: RestrictedAppTaskResult;
  /** The latest reported model on the owned Chat; delegated models may differ. */
  model?: RestrictedAppAssistantModelRef;
  /** Settled usage across the request and its children, including continuations. */
  usage?: RestrictedAppAssistantUsage;
}

/** Trusted Apps-tab detail: the exact instructions and input the Chat received. */
export interface RestrictedAppTaskDetail {
  task: RestrictedAppAssistantTask;
  instructions: string;
  inputJson: string;
  conversationId: string;
  /** Original accepted turn, so the trusted UI follows this task, not a later request in its Chat. */
  taskId?: string;
}

/**
 * These bounds keep app input and delivery envelopes sane; they are not a
 * filesystem or tool sandbox for the Assistant. Settings → Desktop → Limits
 * presents these numbers, and every limit hit names that section.
 */
export const restrictedAppAssistantLimits = Object.freeze({
  inputBytes: 65_536,
  /** The whole serialized result envelope. `data` is dropped, then `files` trimmed, then `summary`. */
  resultBytes: 262_144,
  /** F29's summary bound, shared with the report verb so both lanes trim alike. */
  summaryBytes: workFoldRequestLimits.maxResultSummaryBytes,
  /** F29's `data` bound; only an action that declared an output shape can reach it. */
  dataBytes: workFoldRequestLimits.maxResultDataBytes,
  records: 1_000,
  listItems: 50,
  /** Counts dispatching, running and waiting tasks for one installation. */
  runningPerInstallation: 4,
  /** Replay window for a retained request envelope. */
  requestAgeMs: 15 * 60_000,
  /** Terminal receipts older than this prune on the next submission. */
  receiptRetentionMs: 24 * 60 * 60_000,
});

/**
 * `bridge.tasks.onChanged`: this installation's own Assistant tasks and
 * inference receipts moved. Ids only — the app re-reads with
 * `assistant.list()` or the Apps tab does.
 */
export interface RestrictedAppTasksChangedHint {
  revision: number;
  taskIds: string[];
  receiptIds: string[];
}

/**
 * `bridge.checks.onChanged`: a selected Check's result changed. The ids are
 * this app's own Check permission ids, ready to pass to `checks.read`.
 */
export interface RestrictedAppChecksChangedHint {
  revision: number;
  permissionIds: string[];
}

/**
 * `bridge.files.onChanged`: files under a granted root changed on disk. The
 * ids are this app's own file permission ids, which are also the grant ids
 * `files.list/read/write` take. `truncated` means the bounded observation hit
 * one of its own limits, so the app should re-read the whole root.
 */
export interface RestrictedAppFilesChangedHint {
  revision: number;
  permissionIds: string[];
  truncated: boolean;
}

/**
 * Bounds for the three change hints (docs/collaboration-contract.md, F30).
 *
 * A hint is never state: it carries ids and an ordering revision, never
 * content, and it is never replayed. These numbers keep a busy installation
 * from turning a view into a message pump, and the file numbers keep the
 * granted-root observation to a bounded metadata-only scan.
 */
export const restrictedAppSubscriptionLimits = Object.freeze({
  /** Ids carried by one `tasks` hint before the rest are dropped. */
  taskIds: 64,
  receiptIds: 64,
  /** Ten hints per second at most, the same cadence storage hints already use. */
  minHintIntervalMs: 100,
  /** How often a granted root is re-observed while an eligible mount is open. */
  filePollIntervalMs: 2_000,
  /** One stable observation this long before a `files` hint is emitted. */
  fileDebounceMs: 1_000,
  /** At most one `files` hint per root per second. */
  fileMinHintIntervalMs: 1_000,
  fileMaxFiles: 512,
  fileMaxVisitedEntries: 2_000,
  fileMaxDepth: 8,
});
