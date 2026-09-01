import { foldDecisionSurfaceRestrictions } from "./fold-decisions.js";
import type {
  FoldDecisionSurface,
  FoldStagedAct,
  FoldStagedActCategory,
  FoldStagedActExecutionOutcome,
  FoldStagedActFieldValue,
  FoldStagedActKind,
  FoldStagedActStagedVia,
  FoldStagedActState,
} from "./fold-staged-acts.js";

/**
 * The one needs-you card contract (docs/fold-consecrations.md; fold
 * integration reconciliation 6). Every line a person reads before clicking is
 * composed here, by app code, from the staged act's typed `parameters` and
 * `pins` plus exact host-verified held artifacts — model narration never
 * becomes card copy. The popover stack, the
 * main-window flyout, and the remote client's Needs you screen all render this
 * projection;
 * none of them composes copy of its own, so a persuasive paragraph cannot
 * dress up a destructive act on any surface.
 *
 * Person-facing copy says "Needs you" and plain words; it never says
 * "consecration" — that word is a contract term, not card copy.
 */

export interface FoldDecisionCardFact {
  label: string;
  value: string;
}

export interface FoldDecisionCardProvenance {
  stagedVia: FoldStagedActStagedVia;
  stagedAt: string;
  /** The transcript that holds the fold's reasoning, when a conversation staged it. */
  conversationId?: string;
  parentTaskId?: string;
  requestId: string;
  browserId?: string;
  grantId?: string;
}

export interface FoldDecisionCardDecision {
  decision: "approved" | "denied";
  surface: FoldDecisionSurface;
  browserId?: string;
  grantId?: string;
  policyId?: string;
  note?: string;
}

export interface FoldDecisionCardExecution {
  outcome: FoldStagedActExecutionOutcome;
  at: string;
  errorDetail?: string;
}

export interface FoldDecisionCard {
  id: string;
  kind: FoldStagedActKind;
  category: FoldStagedActCategory;
  state: FoldStagedActState;
  /** The plain-words category line; scope joins it for make-runnable kinds. */
  categoryLine: string;
  /** Host-composed act title over exact pinned identities. */
  title: string;
  /** The same facts the pins hold, labeled for a person; digests as short ids. */
  facts: FoldDecisionCardFact[];
  spaceId?: string;
  spaceName?: string;
  provenance: FoldDecisionCardProvenance;
  createdAt: string;
  expiresAt: string;
  /** Denial memory: quiet nagging is visible for what it is. */
  priorDenialAt?: string;
  /** Destroy-category cards require a second explicit confirmation inside the card. */
  secondConfirmation: boolean;
  /** Personal-scope make-runnable: the decision belongs to a desktop surface. */
  desktopOnly: boolean;
  /**
   * A rootless `app.grant.files` card: approval binds the grant to a
   * person-chosen folder, and the folder picker lives only behind the main
   * window's preload (`workFoldDesktop.decisions`), so Approve belongs to the
   * main window's needs-you flyout. Surfaces without the picker state that up
   * front and keep Approve unavailable instead of discovering the typed
   * refusal at click time; denial stays available everywhere.
   */
  needsDesktopChosenFolder: boolean;
  /** The remote grant whose request staged this act can never decide it. */
  stagedByGrantId?: string;
  decidedAt?: string;
  decision?: FoldDecisionCardDecision;
  execution?: FoldDecisionCardExecution;
  invalidationReason?: string;
  cancellationReason?: string;
}

export interface FoldDecisionCardOptions {
  /** Registered Space names; an unknown id renders as "<id> (removed)". */
  spaceNames?: ReadonlyMap<string, string>;
  /**
   * Exact host-composed routing review facts, keyed by staged-act id. The
   * declaration remains in the digest-addressed holding area; this projection
   * gives every decision surface the same complete review without widening
   * the staged-act field schema or accepting model-authored card copy.
   */
  routingFacts?: ReadonlyMap<string, readonly FoldDecisionCardFact[]>;
}

/** Working category copy from docs/fold-consecrations.md; final wording is owned by docs/fold.md. */
const CATEGORY_COPY: Record<FoldStagedActCategory, string> = {
  "make-runnable": "Installs code that can run as you",
  "widen-power": "Grants a standing power",
  "destroy": "Deletes something for good",
};

const FACT_LABELS: Record<string, string> = {
  proposalId: "App review",
  reviewDigest: "Reviewed digest",
  packageId: "Package",
  version: "Version",
  source: "Source",
  scope: "Scope",
  resourceSummary: "Contents",
  contentDigest: "Content digest",
  skillNames: "Skills",
  appInstanceId: "App Instance",
  declarationId: "Declaration",
  releaseDigest: "Installed release digest",
  target: "Target",
  adapterKind: "Connection kind",
  automationId: "Automation",
  reviewedDigest: "Reviewed digest",
  scheduleSummary: "Schedule",
  routingId: "Routing",
  declarationDigest: "Declaration digest",
  exposure: "Exposure",
  relativePath: "File",
  title: "Title",
  snapshotEnabled: "Snapshot while asleep",
  byteBudget: "Byte budget per day",
  serveBudget: "Serves per minute",
  viewerEntry: "Viewer entry",
  viewerSurface: "Viewer-readable surface",
  priorBindingSummary: "Current binding",
  priorByteBudget: "Current byte budget per day",
  priorServeBudget: "Current serves per minute",
  priorReleaseDigest: "Current release digest",
  priorViewerSurface: "Current viewer-readable surface",
  spaceId: "Space",
  spaceRoot: "Folder",
  dataNamespaceIds: "Data namespaces",
  observedBytes: "Observed bytes",
  paths: "Paths",
  contentIdentities: "Observed content identities",
  catalogId: "Catalog entry",
  destinationId: "Destination",
};

const DIGEST_FIELDS = new Set([
  "reviewDigest",
  "contentDigest",
  "releaseDigest",
  "reviewedDigest",
  "declarationDigest",
  "priorReleaseDigest",
  "contentIdentities",
]);

const MAX_LIST_FACT_ITEMS = 8;

/**
 * Composes the host-owned card for one staged act. Deterministic over the
 * typed record: the same act always renders the same card on every surface.
 */
export function foldDecisionCard(act: FoldStagedAct, options: FoldDecisionCardOptions = {}): FoldDecisionCard {
  const spaceId = stringOrUndefined(act.parameters.spaceId ?? act.pins.spaceId);
  const spaceName = spaceId !== undefined
    ? options.spaceNames?.get(spaceId) ?? `${spaceId} (removed)`
    : undefined;
  const restrictions = foldDecisionSurfaceRestrictions(act);
  return {
    id: act.id,
    kind: act.kind,
    category: act.category,
    state: act.state,
    categoryLine: categoryLine(act),
    title: cardTitle(act),
    facts: cardFacts(act, spaceName, options.routingFacts?.get(act.id)),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(spaceName !== undefined ? { spaceName } : {}),
    provenance: {
      stagedVia: act.provenance.stagedVia,
      stagedAt: act.createdAt,
      requestId: act.provenance.requestId,
      ...(act.provenance.conversationId !== undefined ? { conversationId: act.provenance.conversationId } : {}),
      ...(act.provenance.parentTaskId !== undefined ? { parentTaskId: act.provenance.parentTaskId } : {}),
      ...(act.provenance.browserId !== undefined ? { browserId: act.provenance.browserId } : {}),
      ...(act.provenance.grantId !== undefined ? { grantId: act.provenance.grantId } : {}),
    },
    createdAt: act.createdAt,
    expiresAt: act.expiresAt,
    ...(act.priorDenialAt !== undefined ? { priorDenialAt: act.priorDenialAt } : {}),
    secondConfirmation: act.category === "destroy",
    desktopOnly: restrictions.desktopOnly,
    // The staging contract carries no root today, so every staged
    // app.grant.files card is rootless; the field check keeps the projection
    // honest if the contract ever pins a person-visible root at staging.
    needsDesktopChosenFolder: act.kind === "app.grant.files"
      && stringOrUndefined(act.pins.root ?? act.parameters.root) === undefined,
    ...(restrictions.stagedByGrantId !== undefined ? { stagedByGrantId: restrictions.stagedByGrantId } : {}),
    ...(act.decidedAt !== undefined ? { decidedAt: act.decidedAt } : {}),
    ...(act.decision !== undefined
      ? {
        decision: {
          decision: act.decision.decision,
          surface: act.decision.surface,
          ...(act.decision.browserId !== undefined ? { browserId: act.decision.browserId } : {}),
          ...(act.decision.grantId !== undefined ? { grantId: act.decision.grantId } : {}),
          ...(act.decision.policyId !== undefined ? { policyId: act.decision.policyId } : {}),
          ...(act.decision.note !== undefined ? { note: act.decision.note } : {}),
        },
      }
      : {}),
    ...(act.execution !== undefined
      ? {
        execution: {
          outcome: act.execution.outcome,
          at: act.execution.at,
          ...(act.execution.errorDetail !== undefined ? { errorDetail: act.execution.errorDetail } : {}),
        },
      }
      : {}),
    ...(act.invalidationReason !== undefined ? { invalidationReason: act.invalidationReason } : {}),
    ...(act.cancellationReason !== undefined ? { cancellationReason: act.cancellationReason } : {}),
  };
}

/**
 * The category line. Make-runnable cards carry the scope, and Personal scope
 * is named for what it is: code that loads into the fold's own runtime on
 * next start.
 */
function categoryLine(act: FoldStagedAct): string {
  const base = CATEGORY_COPY[act.category];
  if (act.category !== "make-runnable") return base;
  const scope = act.pins.scope ?? act.parameters.scope;
  if (scope === "personal") return `${base} · Personal — loads into the fold's own runtime`;
  return `${base} · This Space`;
}

function cardTitle(act: FoldStagedAct): string {
  const field = (name: string): string => stringField(act, name);
  switch (act.kind) {
    case "app.review.approve":
      return `Approve the app review and install (review ${shortIdentity(field("proposalId"))})`;
    case "capability.package.install":
      return `Install ${field("packageId")}@${field("version")} from ${field("source")}`;
    case "capability.package.update":
      return `Update ${field("packageId")} to ${field("version")} from ${field("source")}`;
    case "capability.skills.import": {
      const names = listField(act, "skillNames");
      return names.length === 1
        ? `Import the skill "${names[0]}"`
        : `Import ${names.length} skills`;
    }
    case "app.grant.network":
      return `Grant the network destination "${field("declarationId")}" to ${field("appInstanceId")}`;
    case "app.grant.files":
      return `Grant Space file access "${field("declarationId")}" to ${field("appInstanceId")}`;
    case "app.grant.notifications":
      return `Grant the notification category "${field("declarationId")}" to ${field("appInstanceId")}`;
    case "app.connection.save":
      return `Save the "${field("declarationId")}" connection for ${field("appInstanceId")}`;
    case "app.automation.enable":
      return `Enable the automation "${field("automationId")}" for ${field("appInstanceId")}`;
    case "routing.enable":
      return `Enable the routing ${field("routingId")}`;
    case "publish.viewer.expose":
      // Copy rule (docs/fold-publishing.md): the outward act is "Put this
      // app at your address" — "host" and "website" never appear in product
      // copy.
      return act.pins.exposure === "page"
        ? `Share "${field("title")}" on the web`
        : `Put the app ${field("appInstanceId")} at your address`;
    case "space.delete-folder":
      return `Delete the Space folder ${field("spaceRoot")}`;
    case "app.data.purge":
      return `Purge retained app data of ${field("appInstanceId")}`;
    case "app.storage.clear":
      return `Clear the live storage of ${field("appInstanceId")}`;
    case "files.destroy": {
      const paths = listField(act, "paths");
      return paths.length === 1
        ? `Permanently delete ${paths[0]}`
        : `Permanently delete ${paths.length} files`;
    }
  }
}

/**
 * The exact facts the pins hold, plus staging parameters the pins do not
 * repeat and any exact host-verified held routing review, labeled for a
 * person. Values are typed and bounded; digest-shaped identities render as
 * short ids (the complete values stay inspectable through `staged show`).
 */
function cardFacts(
  act: FoldStagedAct,
  spaceName: string | undefined,
  routingFacts: readonly FoldDecisionCardFact[] | undefined,
): FoldDecisionCardFact[] {
  const facts: FoldDecisionCardFact[] = [];
  const seen = new Set<string>();
  const add = (name: string, value: FoldStagedActFieldValue): void => {
    if (seen.has(name) || value === undefined) return;
    seen.add(name);
    facts.push({ label: FACT_LABELS[name] ?? name, value: factValue(name, value, spaceName) });
  };
  for (const [name, value] of Object.entries(act.pins)) add(name, value);
  for (const [name, value] of Object.entries(act.parameters)) add(name, value);
  if (act.kind === "routing.enable" && routingFacts) {
    for (const fact of routingFacts) facts.push({ ...fact });
  }
  if (act.kind === "app.connection.save") {
    facts.push({
      label: "Credential",
      value: "Entered in the trusted connection flow after approval — never carried by this card",
    });
  }
  return facts;
}

function factValue(name: string, value: FoldStagedActFieldValue, spaceName: string | undefined): string {
  if (name === "spaceId" && typeof value === "string") return spaceName ?? value;
  if (name === "scope") {
    return value === "personal" ? "Personal — loads into the fold's own runtime" : "This Space";
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const rendered = value.map((entry) => DIGEST_FIELDS.has(name) ? shortIdentity(entry) : entry);
    return rendered.length > MAX_LIST_FACT_ITEMS
      ? `${rendered.slice(0, MAX_LIST_FACT_ITEMS).join(", ")}, +${rendered.length - MAX_LIST_FACT_ITEMS} more`
      : rendered.join(", ");
  }
  const text = String(value);
  return DIGEST_FIELDS.has(name) ? shortIdentity(text) : text;
}

/** Digest short ids for card display, like a short commit hash. */
function shortIdentity(value: string): string {
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  if (hex.length > 20 && /^[A-Fa-f0-9]+$/.test(hex)) return `${hex.slice(0, 12)}…`;
  return value;
}

function stringField(act: FoldStagedAct, name: string): string {
  return stringOrUndefined(act.pins[name] ?? act.parameters[name]) ?? "";
}

function stringOrUndefined(value: FoldStagedActFieldValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function listField(act: FoldStagedAct, name: string): readonly string[] {
  const value = act.pins[name] ?? act.parameters[name];
  return Array.isArray(value) ? value : [];
}
