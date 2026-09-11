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

/** Public projection of one app-requested Space Assistant task. */
export interface RestrictedAppAssistantTask {
  id: string;
  requestId: string;
  actionId: string;
  title: string;
  status: "dispatching" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  /** Dispatch time. A request is journaled and dispatched in the same call. */
  startedAt: string;
  cancellationRequested?: true;
  /** Present only after a successful turn. No other Chat messages are exposed. */
  result?: { text: string; truncated: boolean };
  /** The model that ran the dispatched Chat turn; present once that turn settles. */
  model?: RestrictedAppAssistantModelRef;
  /** What Pi reported for that turn; present once it settles and reported usage. */
  usage?: RestrictedAppAssistantUsage;
}

/** Trusted Apps-tab detail: the exact instructions and input the Chat received. */
export interface RestrictedAppTaskDetail {
  task: RestrictedAppAssistantTask;
  instructions: string;
  inputJson: string;
  conversationId: string;
}

/**
 * These bounds keep app input and delivery envelopes sane; they are not a
 * filesystem or tool sandbox for the Assistant. Settings → The fold → Limits
 * presents these numbers, and every limit hit names that section.
 */
export const restrictedAppAssistantLimits = Object.freeze({
  actions: 8,
  instructions: 4_096,
  inputBytes: 65_536,
  resultBytes: 262_144,
  records: 1_000,
  listItems: 50,
  /** Counts dispatching and running tasks for one installation. */
  runningPerInstallation: 4,
  /** Replay window for a retained request envelope. */
  requestAgeMs: 15 * 60_000,
  /** Terminal receipts older than this prune on the next submission. */
  receiptRetentionMs: 24 * 60 * 60_000,
});
