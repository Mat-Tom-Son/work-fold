/**
 * The frozen bounds Settings → Automations → Limits presents, in the one place
 * both the enforcing module and the read-only pane read them from.
 *
 * These are resource guards, not capability limits: each is sized so ordinary
 * agent work never meets it, and exists only to stop a runaway process from
 * exhausting memory or disk. Every limit hit names the limit, and a person can
 * see the number without reading source.
 * This file carries no runtime code and imports nothing from `src/local`, so
 * the desktop renderer can display exactly what the host enforces.
 *
 * Numbers that already live in a browser-safe contract stay there:
 * `restrictedAppAssistantLimits` (src/shared/restricted-app-tasks.ts) and
 * `restrictedAppInferenceLimits` (src/shared/restricted-app-inference.ts).
 * This module covers the routing and automation bounds whose enforcing
 * modules cannot be loaded in a browser.
 */

/**
 * The declaration bounds that are pure numbers. `workFoldRoutingBounds` in
 * src/local/routings/routing-declarations.ts spreads these and adds the
 * bounds it inherits from the automation cadence and the Check target
 * resolver, so parsing and the Limits pane can never disagree.
 */
export const workFoldRoutingDeclarationBounds = Object.freeze({
  /** A dispatch message; the model's context window is the practical bound. */
  maxChatMessageBytes: 4 * 1024 * 1024,
  /** One filled-in placeholder; a longer list is cut and says so. */
  maxPlaceholderTextBytes: 1024 * 1024,
  /** Items in one filled-in list placeholder (paths, findings). */
  maxPlaceholderListItems: 10_000,
  /** The whole message after every placeholder is filled in. */
  maxResolvedMessageBytes: 8 * 1024 * 1024,
  /** Changed paths a folder-change run cause records for its placeholders. */
  maxChangedPathsRecorded: 10_000,
  minAtAdvanceMs: 1_000,
  maxAtAdvanceMs: 10 * 366 * 24 * 60 * 60 * 1_000,
});

/** Routing runs this machine executes at once before the rest queue. */
export const workFoldRoutingMaxConcurrentRuns = 64;

/**
 * Named app automations this machine runs at once. A host may configure a
 * different ceiling; this is the number the product ships and documents
 * (docs/restricted-app-runtime.md).
 */
export const workFoldAutomationDefaultConcurrency = 32;

/** Days a Recently deleted item is kept before retention purges it. */
export const workFoldTrashDefaultRetentionDays = 30;
export const workFoldTrashMinRetentionDays = 1;
export const workFoldTrashMaxRetentionDays = 365;

/**
 * Durable request bounds (docs/collaboration-contract.md, F25 and the Limits
 * table; docs/receipts-not-gates.md principle 6). Every request the fold, a
 * Space Assistant, an app, a routing, or an outside harness starts is one
 * record with these bounds, and every refusal names the number plus
 * "Settings → Automations → Limits".
 *
 * Requests have no fixed lifetime or total-work quotas. The remaining values
 * bound transport envelopes and retained history, with an optional spending cap.
 */
export const workFoldRequestLimits = Object.freeze({
  /** Shipped default is no cap; a host may set one, and reaching it fails the request. */
  providerBudgetUsd: null as number | null,
  maxQuestionTextBytes: 4 * 1024 * 1024,
  maxAnswerTextBytes: 4 * 1024 * 1024,
  maxResultSummaryBytes: 4 * 1024 * 1024,
  maxResultDataBytes: 16 * 1024 * 1024,
  /** UI page size; further questions follow as earlier answers are delivered. */
  questionsPerPresentation: 4,
  /**
   * The assignment text a request record keeps for its own projection. The
   * record is appended whole on every update, so this stays at a size a model
   * could actually use (about 250k tokens) rather than following the message.
   */
  maxRequestContentBytes: 1024 * 1024,
  /** Days a settled request graph is kept before retention removes it. */
  retentionDays: 30,
});

/** F28: continuation turns are on by default and a person can turn them off. */
export const workFoldRequestContinuationsDefaultEnabled = true;

/** Live native Pi callbacks, distinct from durable request questions. */
export const workFoldExtensionUiLimits = Object.freeze({
  pendingPerChat: 64,
  pendingTotal: 1024,
  requestBytes: 4 * 1024 * 1024,
  answerBytes: 4 * 1024 * 1024,
  options: 10_000,
});

/** Optional, memory-only model context diagnostics; never model input limits. */
export const workFoldModelContextLimits = Object.freeze({
  records: 24,
  recordBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  retentionMs: 30 * 60 * 1000,
  payloadSamples: 2,
  depth: 12,
  nodes: 4000,
  digestBytes: 256 * 1024,
});
