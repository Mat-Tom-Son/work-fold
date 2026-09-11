/**
 * The frozen bounds Settings → The fold → Limits presents, in the one place
 * both the enforcing module and the read-only pane read them from.
 *
 * Bounds are defaults, not caps (docs/receipts-not-gates.md, principle 6):
 * they exist so a runaway stops and so envelopes stay sane, every limit hit
 * names the limit, and a person can see the number without reading source.
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
  /** Machine-wide declaration budget; the routing store enforces it at enablement. */
  maxRoutingsPerMachine: 32,
  /** A generous default, not a cap: a routing is glue, not a job system. */
  maxSteps: 16,
  maxExactPathsPerFilesStep: 25,
  /** A fixed dispatch message, not a document. */
  maxChatMessageBytes: 16 * 1024,
  /** One filled-in placeholder; a longer list is cut and says so. */
  maxPlaceholderTextBytes: 8 * 1024,
  /** Items in one filled-in list placeholder (paths, findings). */
  maxPlaceholderListItems: 100,
  /** The whole message after every placeholder is filled in. */
  maxResolvedMessageBytes: 64 * 1024,
  /** Changed paths a folder-change run cause records for its placeholders. */
  maxChangedPathsRecorded: 100,
  minAtAdvanceMs: 60_000,
  maxAtAdvanceMs: 366 * 24 * 60 * 60 * 1_000,
});

/** Routing runs this machine executes at once before the rest queue. */
export const workFoldRoutingMaxConcurrentRuns = 8;

/**
 * Named app automations this machine runs at once. A host may configure a
 * different ceiling; this is the number the product ships and documents
 * (docs/restricted-app-runtime.md).
 */
export const workFoldAutomationDefaultConcurrency = 4;

/** Days a Recently deleted item is kept before retention purges it. */
export const workFoldTrashDefaultRetentionDays = 30;
export const workFoldTrashMinRetentionDays = 1;
export const workFoldTrashMaxRetentionDays = 365;
