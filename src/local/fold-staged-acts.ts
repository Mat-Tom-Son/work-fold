import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { WORKFOLD_CLI_ACT_SURFACES, type WorkFoldCliActSurface } from "./cli/act-receipts.js";
import { workFoldStateRoot } from "./state-paths.js";

export const FOLD_STAGED_ACT_SCHEMA_VERSION = 2;

/** 24 hours from staging, matching the remote upload-staging precedent. */
export const FOLD_STAGED_ACT_TTL_MS = 24 * 60 * 60 * 1000;

/** Machine-wide bound on undecided cards; staged noise cannot bury the one card that matters. */
export const FOLD_STAGED_ACT_PENDING_CAP = 32;

/** Bounded retention of settled records, following the proposal-registry discipline. */
export const FOLD_STAGED_ACT_SETTLED_RETENTION = 100;

export const FOLD_STAGED_ACT_CATEGORIES = ["make-runnable", "widen-power", "destroy"] as const;

export type FoldStagedActCategory = (typeof FOLD_STAGED_ACT_CATEGORIES)[number];

export const FOLD_STAGED_ACT_STATES = [
  "staged",
  "approved",
  "denied",
  "expired",
  "canceled",
  "invalidated",
] as const;

export type FoldStagedActState = (typeof FOLD_STAGED_ACT_STATES)[number];

export const FOLD_STAGED_ACT_EXECUTION_OUTCOMES = ["executed", "failed", "interrupted"] as const;

export type FoldStagedActExecutionOutcome = (typeof FOLD_STAGED_ACT_EXECUTION_OUTCOMES)[number];

export const FOLD_STAGED_ACT_STAGED_VIA = ["management-conversation", "act-cli", "desktop-settings"] as const;

export type FoldStagedActStagedVia = (typeof FOLD_STAGED_ACT_STAGED_VIA)[number];

/**
 * Decision surfaces are the act-receipt surface vocabulary minus `cli`:
 * deciding is never an act-lane verb, so the one surface the act lane owns can
 * never appear on a decision record. The click is not a command.
 */
export type FoldDecisionSurface = Exclude<WorkFoldCliActSurface, "cli">;

export const FOLD_DECISION_SURFACES: readonly FoldDecisionSurface[] =
  WORKFOLD_CLI_ACT_SURFACES.filter((surface): surface is FoldDecisionSurface => surface !== "cli");

/**
 * Staged-act fields are closed, flat, and typed — exact ids, paths, digests,
 * scopes, and host-composed one-line summaries. No free-form payloads, no
 * nesting, no secrets: `app.connection.save` stages only the connection's
 * shape, and the field vocabulary simply has nowhere to put a credential.
 */
export type FoldStagedActFieldValue = string | number | boolean | readonly string[];

export type FoldStagedActFields = Readonly<Record<string, FoldStagedActFieldValue>>;

export type FoldStagedActFieldType = "string" | "number" | "boolean" | "string-list";

export interface FoldStagedActFieldSpec {
  type: FoldStagedActFieldType;
  required: boolean;
  values?: readonly string[];
}

export interface FoldStagedActKindDescriptor {
  category: FoldStagedActCategory;
  parameters: Readonly<Record<string, FoldStagedActFieldSpec>>;
  pins: Readonly<Record<string, FoldStagedActFieldSpec>>;
}

const CAPABILITY_SCOPES = ["personal", "space"] as const;
const VIEWER_EXPOSURES = ["page", "hosted-app"] as const;

function req(type: FoldStagedActFieldType, values?: readonly string[]): FoldStagedActFieldSpec {
  return values ? { type, required: true, values } : { type, required: true };
}

function opt(type: FoldStagedActFieldType, values?: readonly string[]): FoldStagedActFieldSpec {
  return values ? { type, required: false, values } : { type, required: false };
}

/**
 * The closed kind vocabulary of docs/fold-consecrations.md, one descriptor per
 * kind: its consecration category, the typed parameters the staging path
 * supplies, and the pinned identities decision-time recheck verifies. Unknown
 * kinds fail closed, so adding one is a deliberate contract change reviewed
 * against the setup-only authority boundary.
 */
const KIND_DESCRIPTORS = {
  "app.review.approve": {
    category: "make-runnable",
    parameters: { spaceId: req("string"), proposalId: req("string") },
    pins: { proposalId: req("string"), reviewDigest: req("string") },
  },
  "capability.package.install": {
    category: "make-runnable",
    parameters: {
      source: opt("string"),
      catalogId: opt("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      packageId: req("string"),
      version: req("string"),
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      resourceSummary: req("string"),
    },
  },
  "capability.package.update": {
    category: "make-runnable",
    parameters: {
      source: opt("string"),
      catalogId: opt("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      packageId: req("string"),
      version: req("string"),
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      resourceSummary: req("string"),
    },
  },
  "capability.skills.import": {
    category: "make-runnable",
    parameters: {
      source: req("string"),
      scope: req("string", CAPABILITY_SCOPES),
      spaceId: opt("string"),
    },
    pins: {
      source: req("string"),
      contentDigest: req("string"),
      skillNames: req("string-list"),
    },
  },
  "app.grant.network": {
    category: "widen-power",
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.files": {
    category: "widen-power",
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.grant.notifications": {
    category: "widen-power",
    parameters: { spaceId: req("string"), appInstanceId: req("string"), declarationId: req("string") },
    pins: { appInstanceId: req("string"), declarationId: req("string"), releaseDigest: req("string") },
  },
  "app.connection.save": {
    category: "widen-power",
    parameters: { spaceId: req("string"), appInstanceId: req("string"), destinationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      declarationId: req("string"),
      target: req("string"),
      adapterKind: req("string"),
    },
  },
  "app.automation.enable": {
    category: "widen-power",
    parameters: { spaceId: req("string"), appInstanceId: req("string"), automationId: req("string") },
    pins: {
      appInstanceId: req("string"),
      automationId: req("string"),
      reviewedDigest: req("string"),
      scheduleSummary: req("string"),
    },
  },
  "routing.enable": {
    category: "widen-power",
    parameters: { routingId: req("string") },
    pins: { routingId: req("string"), declarationDigest: req("string") },
  },
  "publish.viewer.expose": {
    category: "widen-power",
    parameters: {
      exposure: req("string", VIEWER_EXPOSURES),
      spaceId: opt("string"),
      appInstanceId: opt("string"),
    },
    pins: {
      exposure: req("string", VIEWER_EXPOSURES),
      spaceId: opt("string"),
      relativePath: opt("string"),
      title: opt("string"),
      snapshotEnabled: opt("boolean"),
      byteBudget: opt("number"),
      serveBudget: opt("number"),
      appInstanceId: opt("string"),
      releaseDigest: opt("string"),
      viewerEntry: opt("string"),
      viewerSurface: opt("string-list"),
      priorBindingSummary: opt("string"),
      priorByteBudget: opt("number"),
      priorServeBudget: opt("number"),
      priorReleaseDigest: opt("string"),
      priorViewerSurface: opt("string-list"),
    },
  },
  "space.delete-folder": {
    category: "destroy",
    parameters: { spaceId: req("string") },
    pins: { spaceId: req("string"), spaceRoot: req("string") },
  },
  "app.data.purge": {
    category: "destroy",
    parameters: {
      spaceId: req("string"),
      appInstanceId: req("string"),
      purgeTarget: opt("string", ["retained", "runtime-instance"]),
    },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      retainedDataId: opt("string"),
      runtimeInstanceId: opt("string"),
      sourceSpaceId: opt("string"),
    },
  },
  "app.storage.clear": {
    category: "destroy",
    parameters: { spaceId: req("string"), appInstanceId: req("string") },
    pins: {
      appInstanceId: req("string"),
      dataNamespaceIds: req("string-list"),
      observedBytes: req("number"),
    },
  },
  "files.destroy": {
    category: "destroy",
    parameters: { spaceId: req("string"), paths: req("string-list") },
    pins: { spaceId: req("string"), paths: req("string-list"), contentIdentities: req("string-list") },
  },
} satisfies Record<string, FoldStagedActKindDescriptor>;

export type FoldStagedActKind = keyof typeof KIND_DESCRIPTORS;

export const FOLD_STAGED_ACT_KINDS = Object.keys(KIND_DESCRIPTORS) as readonly FoldStagedActKind[];

export const FOLD_STAGED_ACT_KIND_DESCRIPTORS: Readonly<Record<FoldStagedActKind, FoldStagedActKindDescriptor>> =
  KIND_DESCRIPTORS;

export function foldStagedActCategory(kind: FoldStagedActKind): FoldStagedActCategory {
  const descriptor = descriptorFor(kind);
  if (!descriptor) {
    throw new FoldStagedActError("KIND_UNKNOWN", `work-fold does not know the staged-act kind "${String(kind)}".`);
  }
  return descriptor.category;
}

export interface FoldStagedActProvenance {
  stagedVia: FoldStagedActStagedVia;
  /** The transcript that holds the fold's reasoning, when a conversation staged it. */
  conversationId?: string;
  /** Management request lineage, as on act receipts. */
  parentTaskId?: string;
  /** The staging act's journal id. */
  requestId: string;
  /** Recorded together when the staging request was accepted from an approved remote browser. */
  browserId?: string;
  grantId?: string;
}

export interface FoldDecisionRecord {
  decision: "approved" | "denied";
  surface: FoldDecisionSurface;
  browserId?: string;
  grantId?: string;
  /** Present exactly when a standing policy, not a click or Unrestricted mode, satisfied the act. */
  policyId?: string;
  /** Optional person-authored denial note; offered, never required. */
  note?: string;
}

export interface FoldStagedActExecution {
  outcome: FoldStagedActExecutionOutcome;
  at: string;
  /** Host-observed error text for a failed execution, scrubbed and bounded. */
  errorDetail?: string;
}

/**
 * One staged consecration (docs/fold-consecrations.md): fully prepared,
 * inspectable, inert. The fold stages; a person consecrates. Every line a
 * person reads before clicking is host-composed from the typed `parameters`
 * and `pins` — model prose never becomes card copy — and the id is single-use,
 * so approval never survives restaging.
 */
export interface FoldStagedAct {
  schemaVersion: typeof FOLD_STAGED_ACT_SCHEMA_VERSION;
  id: string;
  category: FoldStagedActCategory;
  kind: FoldStagedActKind;
  parameters: FoldStagedActFields;
  pins: FoldStagedActFields;
  provenance: FoldStagedActProvenance;
  state: FoldStagedActState;
  createdAt: string;
  expiresAt: string;
  /** Set on every transition out of `staged`; orders the bounded terminal history. */
  settledAt?: string;
  decidedAt?: string;
  decision?: FoldDecisionRecord;
  /** Only an `approved` act carries an execution outcome. */
  execution?: FoldStagedActExecution;
  /** Denial memory: the most recent denial of identical kind and pins at staging time. */
  priorDenialAt?: string;
  /** Host-composed explanation for `invalidated`, shown on the card. */
  invalidationReason?: string;
  /** Host-composed explanation for `canceled`, shown on the card. */
  cancellationReason?: string;
}

export interface FoldStagedActInput {
  kind: FoldStagedActKind;
  parameters: FoldStagedActFields;
  pins: FoldStagedActFields;
  provenance: FoldStagedActProvenance;
}

export interface FoldStagedActAdmission {
  act: FoldStagedAct;
  /** True when an identical pending act (same kind, same pins) already existed. */
  deduplicated: boolean;
}

export interface FoldStagedActDecisionInput {
  decision: "approved" | "denied";
  surface: FoldDecisionSurface;
  browserId?: string;
  grantId?: string;
  policyId?: string;
  note?: string;
}

export interface FoldStagedActDecideHooks {
  /**
   * Journal-first consumption: awaited inside the store's serialized critical
   * section, after the staged-state recheck and before the transition commits.
   * A throw refuses the decision and leaves the act `staged`.
   */
  journal?: (act: FoldStagedAct, decision: FoldDecisionRecord) => Promise<void> | void;
}

export interface FoldStagedActFilter {
  state?: FoldStagedActState;
  kind?: FoldStagedActKind;
  category?: FoldStagedActCategory;
  spaceId?: string;
}

export interface FoldStagedActCardRef {
  id: string;
  kind: FoldStagedActKind;
}

export interface FoldStagedActStoreStatus {
  damaged: boolean;
  damageReason?: string;
  pendingCount: number;
}

export type FoldStagedActErrorCode =
  | "STORE_DAMAGED"
  | "KIND_UNKNOWN"
  | "INPUT_INVALID"
  | "PENDING_CAP"
  | "NOT_FOUND"
  | "ALREADY_SETTLED"
  | "EXPIRED"
  | "JOURNAL_UNAVAILABLE"
  | "EXECUTION_INVALID";

export class FoldStagedActError extends Error {
  readonly code: FoldStagedActErrorCode;
  /** The settled state a refused transition found, when one exists. */
  readonly state?: FoldStagedActState;
  /** The pending cards a cap refusal names. */
  readonly pending?: readonly FoldStagedActCardRef[];

  constructor(
    code: FoldStagedActErrorCode,
    message: string,
    options: { state?: FoldStagedActState; pending?: readonly FoldStagedActCardRef[]; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FoldStagedActError";
    this.code = code;
    if (options.state !== undefined) this.state = options.state;
    if (options.pending !== undefined) this.pending = options.pending;
  }
}

export interface FoldStagedActStoreOptions {
  /** Defaults to `fold/staged-acts.json` under the work-fold state root. */
  path?: string;
  now?: () => Date;
}

/**
 * Machine-local staged acts awaiting a person's decision. Never portable,
 * never inside a Space folder: a file claiming to be a staged act is inert
 * bytes, because acts enter this store only through the journaled staging
 * path.
 */
export function foldStagedActsFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "staged-acts.json");
}

interface FoldStagedActsFileShape {
  schemaVersion: typeof FOLD_STAGED_ACT_SCHEMA_VERSION;
  acts: FoldStagedAct[];
}

/**
 * The staged-act store for fold consecrations (docs/fold-consecrations.md):
 * the three verb families the fold may fully prepare — staged, inspectable,
 * inert — but only a person decides. The store follows the proposal-registry
 * disciplines (src/local/agent/restricted-app-proposals.ts): schema-versioned,
 * normalized fail-closed on read, atomic temp-file-and-rename writes with 0600
 * modes, serialized mutations, and bounded retention of settled records.
 * Damaged or future-versioned state disables staging and deciding rather than
 * guessing, and is never overwritten. Expiry is lazy — evaluated when the
 * store is read and rechecked when a decision arrives — so an expired act can
 * never be approved, even from a stale card. Staged acts survive app restarts;
 * an `approved` act whose execution never reported a terminal outcome is
 * marked `interrupted` at the next open and is never replayed.
 */
export class FoldStagedActStore extends EventEmitter {
  readonly path: string;
  readonly #now: () => Date;
  readonly #damageReason: string | null;
  #file: FoldStagedActsFileShape;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, now: () => Date, file: FoldStagedActsFileShape, damageReason: string | null) {
    super();
    this.path = path;
    this.#now = now;
    this.#file = file;
    this.#damageReason = damageReason;
  }

  static async create(options: FoldStagedActStoreOptions = {}): Promise<FoldStagedActStore> {
    const path = resolve(options.path ?? foldStagedActsFile());
    const now = options.now ?? (() => new Date());
    const loaded = await loadStagedActsFile(path);
    const store = new FoldStagedActStore(path, now, loaded.file, loaded.damageReason);
    if (loaded.damageReason === null) await store.#recoverAtStartup();
    return store;
  }

  status(): FoldStagedActStoreStatus {
    if (this.#damageReason !== null) {
      return { damaged: true, damageReason: this.#damageReason, pendingCount: 0 };
    }
    const cutoff = this.#now().getTime();
    const pendingCount = this.#file.acts
      .filter((act) => act.state === "staged" && Date.parse(act.expiresAt) > cutoff)
      .length;
    return { damaged: false, pendingCount };
  }

  async stage(input: FoldStagedActInput): Promise<FoldStagedActAdmission> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const descriptor = descriptorFor(input.kind);
      if (!descriptor) {
        throw new FoldStagedActError(
          "KIND_UNKNOWN",
          `work-fold does not stage "${String(input.kind)}" acts; the kind vocabulary is closed and unknown kinds fail closed.`,
        );
      }
      const inputIssue = fieldsIssue(input.kind, "parameters", input.parameters)
        ?? fieldsIssue(input.kind, "pins", input.pins)
        ?? provenanceIssue(input.provenance);
      if (inputIssue) {
        throw new FoldStagedActError("INPUT_INVALID", `work-fold refused to stage this act: ${inputIssue}`);
      }
      const parameters = cloneFields(input.parameters);
      const pins = cloneFields(input.pins);
      const sharedIssue = sharedFieldIssue(parameters, pins);
      if (sharedIssue) {
        throw new FoldStagedActError("INPUT_INVALID", `work-fold refused to stage this act: ${sharedIssue}`);
      }
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const identity = pinIdentity(input.kind, pins);
      const existing = draft.acts.find((act) => act.state === "staged" && pinIdentity(act.kind, act.pins) === identity);
      if (existing) {
        if (expired.length) await this.#commit(draft, expired);
        return { act: structuredClone(existing), deduplicated: true };
      }
      const pending = draft.acts.filter((act) => act.state === "staged");
      if (pending.length >= FOLD_STAGED_ACT_PENDING_CAP) {
        if (expired.length) await this.#commit(draft, expired);
        const cards = pending.map((act) => ({ id: act.id, kind: act.kind }));
        throw new FoldStagedActError(
          "PENDING_CAP",
          `${FOLD_STAGED_ACT_PENDING_CAP} staged acts are already pending a decision; decide, cancel, or let one expire first. `
            + `Pending: ${cards.map((card) => `${card.kind} (${card.id})`).join(", ")}.`,
          { pending: cards },
        );
      }
      const created = this.#now();
      const priorDenial = draft.acts
        .filter((act) => act.state === "denied"
          && typeof act.decidedAt === "string"
          && pinIdentity(act.kind, act.pins) === identity)
        .sort((left, right) => compareStrings(left.decidedAt as string, right.decidedAt as string))
        .at(-1);
      const act: FoldStagedAct = {
        schemaVersion: FOLD_STAGED_ACT_SCHEMA_VERSION,
        id: randomUUID(),
        category: descriptor.category,
        kind: input.kind,
        parameters,
        pins,
        provenance: cloneProvenance(input.provenance),
        state: "staged",
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + FOLD_STAGED_ACT_TTL_MS).toISOString(),
        ...(priorDenial ? { priorDenialAt: priorDenial.decidedAt as string } : {}),
      };
      draft.acts.push(act);
      await this.#commit(draft, expired);
      this.emit("staged", structuredClone(act));
      return { act: structuredClone(act), deduplicated: false };
    });
  }

  async list(filter: FoldStagedActFilter = {}): Promise<FoldStagedAct[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      await this.#sweepAndPersist();
      return this.#file.acts
        .filter((act) => (!filter.state || act.state === filter.state)
          && (!filter.kind || act.kind === filter.kind)
          && (!filter.category || act.category === filter.category)
          && (!filter.spaceId || referencesField(act, "spaceId", filter.spaceId)))
        .sort((left, right) => compareStrings(right.createdAt, left.createdAt) || compareStrings(right.id, left.id))
        .map((act) => structuredClone(act));
    });
  }

  async get(id: string): Promise<FoldStagedAct | undefined> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      await this.#sweepAndPersist();
      const act = this.#file.acts.find((candidate) => candidate.id === id);
      return act ? structuredClone(act) : undefined;
    });
  }

  /**
   * The staged→decided transition: an atomic check-and-set inside the store's
   * serialized critical section. Expiry is rechecked first, the record must
   * still be `staged`, the journal hook is the only awaited work before the
   * commit, and of two concurrent decides exactly one consumes the act — the
   * other is refused with the settled outcome.
   */
  async decide(
    id: string,
    input: FoldStagedActDecisionInput,
    hooks?: FoldStagedActDecideHooks,
  ): Promise<FoldStagedAct> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const inputIssue = decisionInputIssue(input);
      if (inputIssue) throw new FoldStagedActError("INPUT_INVALID", `work-fold refused this decision: ${inputIssue}`);
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const act = draft.acts.find((candidate) => candidate.id === id);
      if (!act) {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError("NOT_FOUND", "No staged act has this id; approval never survives restaging.");
      }
      if (act.state !== "staged") {
        if (expired.length) await this.#commit(draft, expired);
        if (act.state === "expired") {
          throw new FoldStagedActError(
            "EXPIRED",
            "This staged act expired undecided. Expiry is not approval; restaging issues a fresh card.",
            { state: act.state },
          );
        }
        throw new FoldStagedActError(
          "ALREADY_SETTLED",
          `This staged act was already ${act.state}; a staged act is decided at most once.`,
          { state: act.state },
        );
      }
      const decision: FoldDecisionRecord = {
        decision: input.decision,
        surface: input.surface,
        ...(input.browserId !== undefined ? { browserId: input.browserId } : {}),
        ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
        ...(input.policyId !== undefined ? { policyId: input.policyId } : {}),
        ...(input.note !== undefined ? { note: boundedProse(input.note) } : {}),
      };
      if (hooks?.journal) {
        try {
          await hooks.journal(structuredClone(act), structuredClone(decision));
        } catch (caught) {
          if (expired.length) await this.#commit(draft, expired);
          throw new FoldStagedActError(
            "JOURNAL_UNAVAILABLE",
            "work-fold could not journal this decision, so the act remains staged and nothing was consumed.",
            { cause: caught },
          );
        }
      }
      const nowIso = this.#now().toISOString();
      act.state = input.decision;
      act.decidedAt = nowIso;
      act.settledAt = nowIso;
      act.decision = decision;
      await this.#commit(draft, [...expired, act]);
      return structuredClone(act);
    });
  }

  /**
   * Terminal execution outcome for an approved act. Approval was consumed at
   * journal time, so a failed execution stays `approved` with outcome
   * `failed` and is never auto-retried; another attempt means restaging.
   */
  async recordExecution(
    id: string,
    outcome: FoldStagedActExecutionOutcome,
    errorDetail?: string,
  ): Promise<FoldStagedAct> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      if (!FOLD_STAGED_ACT_EXECUTION_OUTCOMES.includes(outcome)) {
        throw new FoldStagedActError("INPUT_INVALID", "work-fold refused this execution outcome: the outcome vocabulary is closed.");
      }
      if (errorDetail !== undefined && (typeof errorDetail !== "string" || outcome !== "failed")) {
        throw new FoldStagedActError("INPUT_INVALID", "work-fold refused this execution outcome: error detail accompanies only a failed execution.");
      }
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const act = draft.acts.find((candidate) => candidate.id === id);
      if (!act) {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError("NOT_FOUND", "No staged act has this id; approval never survives restaging.");
      }
      if (act.state !== "approved" || act.decision?.decision !== "approved") {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError(
          "EXECUTION_INVALID",
          `Only an approved act records an execution outcome; this act is ${act.state}.`,
          { state: act.state },
        );
      }
      if (act.execution) {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError(
          "EXECUTION_INVALID",
          `This act's execution already settled as ${act.execution.outcome}; approval is consumed exactly once and never replayed.`,
          { state: act.state },
        );
      }
      act.execution = {
        outcome,
        at: this.#now().toISOString(),
        ...(errorDetail !== undefined ? { errorDetail: boundedProse(errorDetail) } : {}),
      };
      await this.#commit(draft, expired);
      this.emit("execution", structuredClone(act));
      return structuredClone(act);
    });
  }

  /** The act-lane cancel verb: the stager withdrew a pending act. */
  async cancel(id: string): Promise<FoldStagedAct> {
    return await this.#settle(id, "canceled", { cancellationReason: "Withdrawn by the stager before any decision." });
  }

  /** Decision-time pin mismatch, or an underlying service's refusal observed early. */
  async invalidate(id: string, reason: string): Promise<FoldStagedAct> {
    if (typeof reason !== "string" || !reason.trim()) {
      throw new FoldStagedActError("INPUT_INVALID", "work-fold refused this invalidation: the card needs a host-composed reason.");
    }
    return await this.#settle(id, "invalidated", { invalidationReason: boundedProse(reason) });
  }

  /** Space removal cancels pending acts pinned to that Space. */
  async cancelForSpace(spaceId: string): Promise<FoldStagedAct[]> {
    assertCascadeReference(spaceId, "spaceId");
    return await this.#cascade(
      (act) => referencesField(act, "spaceId", spaceId),
      "The Space this act was staged for was removed.",
    );
  }

  /** App uninstall cancels pending acts dependent on that App Instance. */
  async cancelForAppInstance(appInstanceId: string): Promise<FoldStagedAct[]> {
    assertCascadeReference(appInstanceId, "appInstanceId");
    return await this.#cascade(
      (act) => referencesField(act, "appInstanceId", appInstanceId),
      "The installed app this act was staged for was removed.",
    );
  }

  /** Review supersession cancels pending acts pinned to the superseded proposal. */
  async cancelForReviewProposal(proposalId: string): Promise<FoldStagedAct[]> {
    assertCascadeReference(proposalId, "proposalId");
    return await this.#cascade(
      (act) => referencesField(act, "proposalId", proposalId),
      "The app review this act was staged for was superseded.",
    );
  }

  /**
   * Browser revocation cancels pending acts staged at that browser's behest —
   * a compromised browser cannot leave a card behind as a time bomb. Decided
   * acts stand: they were authorized when clicked, and their receipts name
   * the browser that made them.
   */
  async cancelForBrowserGrant(reference: { browserId?: string; grantId?: string }): Promise<FoldStagedAct[]> {
    const browserId = reference.browserId;
    const grantId = reference.grantId;
    if (browserId === undefined && grantId === undefined) {
      throw new FoldStagedActError("INPUT_INVALID", "work-fold refused this cascade: a browserId or grantId is required.");
    }
    if (browserId !== undefined) assertCascadeReference(browserId, "browserId");
    if (grantId !== undefined) assertCascadeReference(grantId, "grantId");
    return await this.#cascade(
      (act) => (browserId !== undefined && act.provenance.browserId === browserId)
        || (grantId !== undefined && act.provenance.grantId === grantId),
      "The remote browser whose request staged this act was revoked.",
    );
  }

  async #settle(
    id: string,
    state: "canceled" | "invalidated",
    extra: { cancellationReason?: string; invalidationReason?: string },
  ): Promise<FoldStagedAct> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const act = draft.acts.find((candidate) => candidate.id === id);
      if (!act) {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError("NOT_FOUND", "No staged act has this id; approval never survives restaging.");
      }
      if (act.state !== "staged") {
        if (expired.length) await this.#commit(draft, expired);
        throw new FoldStagedActError(
          "ALREADY_SETTLED",
          `This staged act was already ${act.state}; settling it again is a refusal, not a second transition.`,
          { state: act.state },
        );
      }
      act.state = state;
      act.settledAt = this.#now().toISOString();
      Object.assign(act, extra);
      await this.#commit(draft, [...expired, act]);
      return structuredClone(act);
    });
  }

  async #cascade(match: (act: FoldStagedAct) => boolean, reason: string): Promise<FoldStagedAct[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const canceled = draft.acts.filter((act) => act.state === "staged" && match(act));
      const nowIso = this.#now().toISOString();
      for (const act of canceled) {
        act.state = "canceled";
        act.settledAt = nowIso;
        act.cancellationReason = reason;
      }
      if (expired.length || canceled.length) await this.#commit(draft, [...expired, ...canceled]);
      return canceled.map((act) => structuredClone(act));
    });
  }

  async #recoverAtStartup(): Promise<void> {
    await this.#mutate(async () => {
      const draft = structuredClone(this.#file);
      const expired = this.#sweepExpired(draft);
      const interrupted = draft.acts.filter((act) => act.state === "approved"
        && act.decision?.decision === "approved"
        && act.execution === undefined);
      const nowIso = this.#now().toISOString();
      for (const act of interrupted) act.execution = { outcome: "interrupted", at: nowIso };
      if (expired.length || interrupted.length) await this.#commit(draft, expired);
    });
  }

  async #sweepAndPersist(): Promise<void> {
    const draft = structuredClone(this.#file);
    const expired = this.#sweepExpired(draft);
    if (expired.length) await this.#commit(draft, expired);
  }

  #sweepExpired(draft: FoldStagedActsFileShape): FoldStagedAct[] {
    const cutoff = this.#now().getTime();
    const nowIso = this.#now().toISOString();
    const expired: FoldStagedAct[] = [];
    for (const act of draft.acts) {
      if (act.state !== "staged" || Date.parse(act.expiresAt) > cutoff) continue;
      act.state = "expired";
      act.settledAt = nowIso;
      expired.push(act);
    }
    return expired;
  }

  #assertOperational(): void {
    if (this.#damageReason === null) return;
    throw new FoldStagedActError(
      "STORE_DAMAGED",
      `work-fold disabled staging and deciding: ${this.#damageReason} Nothing is guessed from damaged authority state.`,
    );
  }

  async #commit(draft: FoldStagedActsFileShape, settledNow: FoldStagedAct[]): Promise<void> {
    trimSettled(draft);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
    this.#file = draft;
    for (const act of settledNow) this.emit("settled", structuredClone(act));
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

const MAX_TEXT_CHARS = 2048;
const MAX_LIST_ITEMS = 256;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

type FieldSection = "parameters" | "pins";

function descriptorFor(kind: string): FoldStagedActKindDescriptor | undefined {
  return Object.prototype.hasOwnProperty.call(KIND_DESCRIPTORS, kind)
    ? KIND_DESCRIPTORS[kind as FoldStagedActKind]
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textIssue(value: unknown, label: string): string | null {
  if (typeof value !== "string") return `${label} must be a string.`;
  if (!value.trim() || value.length > MAX_TEXT_CHARS) return `${label} must be 1-${MAX_TEXT_CHARS} characters.`;
  if (FORBIDDEN_TEXT.test(value)) return `${label} must not contain control or direction-override characters.`;
  return null;
}

function fieldValueIssue(value: unknown, spec: FoldStagedActFieldSpec, label: string): string | null {
  switch (spec.type) {
    case "string": {
      const issue = textIssue(value, label);
      if (issue) return issue;
      if (spec.values && !spec.values.includes(value as string)) {
        return `${label} must be one of: ${spec.values.join(", ")}.`;
      }
      return null;
    }
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? null
        : `${label} must be a non-negative integer.`;
    case "boolean":
      return typeof value === "boolean" ? null : `${label} must be a boolean.`;
    case "string-list": {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
        return `${label} must list 1-${MAX_LIST_ITEMS} entries.`;
      }
      for (const entry of value) {
        const issue = textIssue(entry, `each ${label} entry`);
        if (issue) return issue;
      }
      return null;
    }
  }
}

function fieldsIssue(kind: FoldStagedActKind, section: FieldSection, value: unknown): string | null {
  const descriptor = descriptorFor(kind);
  if (!descriptor) return `unknown kind ${String(kind)}.`;
  const spec = descriptor[section];
  if (!isPlainRecord(value)) return `${section} must be an object of typed fields.`;
  for (const name of Object.keys(value)) {
    if (value[name] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(spec, name)) {
      return `${section}.${name} is not a typed field of ${kind}; the field vocabulary is closed.`;
    }
  }
  for (const [name, fieldSpec] of Object.entries(spec)) {
    if (value[name] === undefined) {
      if (fieldSpec.required) return `${section}.${name} is required for ${kind}.`;
      continue;
    }
    const issue = fieldValueIssue(value[name], fieldSpec, `${section}.${name}`);
    if (issue) return issue;
  }
  return crossFieldIssue(kind, section, value as Record<string, FoldStagedActFieldValue>);
}

function crossFieldIssue(
  kind: FoldStagedActKind,
  section: FieldSection,
  fields: Record<string, FoldStagedActFieldValue>,
): string | null {
  if (kind === "capability.package.install" || kind === "capability.package.update") {
    if (section !== "parameters") return null;
    if ((fields.source === undefined) === (fields.catalogId === undefined)) {
      return `${section} must name exactly one of source or catalogId.`;
    }
    return scopedSpaceIssue(section, fields);
  }
  if (kind === "capability.skills.import" && section === "parameters") {
    return scopedSpaceIssue(section, fields);
  }
  if (kind === "publish.viewer.expose") return exposureIssue(section, fields);
  if (kind === "files.destroy" && section === "pins") {
    const paths = fields.paths as readonly string[];
    const identities = fields.contentIdentities as readonly string[];
    if (paths.length !== identities.length) {
      return "pins.contentIdentities must record exactly one observed identity per pinned path.";
    }
  }
  return null;
}

function scopedSpaceIssue(section: FieldSection, fields: Record<string, FoldStagedActFieldValue>): string | null {
  if (fields.scope === "space" && fields.spaceId === undefined) {
    return `${section}.spaceId is required at Space scope.`;
  }
  if (fields.scope === "personal" && fields.spaceId !== undefined) {
    return `${section}.spaceId must be absent at Personal scope.`;
  }
  return null;
}

function exposureIssue(section: FieldSection, fields: Record<string, FoldStagedActFieldValue>): string | null {
  const page = fields.exposure === "page";
  const required = section === "parameters"
    ? (page ? ["spaceId"] : ["appInstanceId"])
    : (page
      ? ["spaceId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget"]
      : ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface"]);
  const foreign = section === "parameters"
    ? (page ? ["appInstanceId"] : ["spaceId"])
    : (page
      ? ["appInstanceId", "releaseDigest", "viewerEntry", "viewerSurface", "priorReleaseDigest", "priorViewerSurface"]
      : ["spaceId", "relativePath", "title", "snapshotEnabled", "byteBudget", "serveBudget", "priorByteBudget", "priorServeBudget"]);
  const exposure = String(fields.exposure);
  for (const name of required) {
    if (fields[name] === undefined) return `${section}.${name} is required for ${exposure} exposure.`;
  }
  for (const name of foreign) {
    if (fields[name] !== undefined) return `${section}.${name} does not belong to ${exposure} exposure.`;
  }
  return null;
}

/** Fields present in both sections must pin the same identity. */
function sharedFieldIssue(parameters: FoldStagedActFields, pins: FoldStagedActFields): string | null {
  for (const [name, value] of Object.entries(parameters)) {
    const pinned = pins[name];
    if (value === undefined || pinned === undefined) continue;
    if (JSON.stringify(value) !== JSON.stringify(pinned)) {
      return `parameters.${name} and pins.${name} must name the same identity.`;
    }
  }
  return null;
}

const PROVENANCE_KEYS = ["stagedVia", "conversationId", "parentTaskId", "requestId", "browserId", "grantId"];

function provenanceIssue(value: unknown): string | null {
  if (!isPlainRecord(value)) return "provenance must be an object.";
  const unknown = Object.keys(value).find((key) => !PROVENANCE_KEYS.includes(key));
  if (unknown) return `provenance.${unknown} is not part of the staged-act contract.`;
  if (!FOLD_STAGED_ACT_STAGED_VIA.includes(value.stagedVia as FoldStagedActStagedVia)) {
    return "provenance.stagedVia must be management-conversation, act-cli, or desktop-settings.";
  }
  const requestIssue = textIssue(value.requestId, "provenance.requestId");
  if (requestIssue) return requestIssue;
  for (const key of ["conversationId", "parentTaskId", "browserId", "grantId"]) {
    if (value[key] === undefined) continue;
    const issue = textIssue(value[key], `provenance.${key}`);
    if (issue) return issue;
  }
  if ((value.browserId === undefined) !== (value.grantId === undefined)) {
    return "provenance.browserId and provenance.grantId record a remote staging together or not at all.";
  }
  return null;
}

function decisionInputIssue(input: FoldStagedActDecisionInput): string | null {
  if (input.decision !== "approved" && input.decision !== "denied") {
    return "the decision must be approved or denied.";
  }
  if (!FOLD_DECISION_SURFACES.includes(input.surface)) {
    return "the surface must be a decision surface; the act lane never decides.";
  }
  if (input.surface === "policy") {
    if (input.policyId === undefined) return "a policy decision must name the exercised policy.";
    const issue = textIssue(input.policyId, "policyId");
    if (issue) return issue;
  } else if (input.policyId !== undefined) {
    return "policyId belongs only to policy decisions.";
  }
  if (input.surface === "remote_web") {
    if (input.browserId === undefined || input.grantId === undefined) {
      return "a remote decision must record the approving browserId and grantId.";
    }
    for (const [label, value] of [["browserId", input.browserId], ["grantId", input.grantId]] as const) {
      const issue = textIssue(value, label);
      if (issue) return issue;
    }
  } else if (input.surface === "unrestricted") {
    if ((input.browserId === undefined) !== (input.grantId === undefined)) {
      return "an Unrestricted decision records both remote browserId and grantId, or neither.";
    }
    for (const [label, value] of [["browserId", input.browserId], ["grantId", input.grantId]] as const) {
      if (value === undefined) continue;
      const issue = textIssue(value, label);
      if (issue) return issue;
    }
  } else if (input.browserId !== undefined || input.grantId !== undefined) {
    return "browser identity belongs only to remote or inherited Unrestricted decisions.";
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") return "the note must be a string.";
    if (input.decision !== "denied") return "a note is offered only with a denial.";
  }
  return null;
}

function referencesField(act: FoldStagedAct, name: string, value: string): boolean {
  return act.parameters[name] === value || act.pins[name] === value;
}

function assertCascadeReference(value: string, label: string): void {
  const issue = textIssue(value, label);
  if (issue) throw new FoldStagedActError("INPUT_INVALID", `work-fold refused this cascade: ${issue}`);
}

function cloneFields(fields: FoldStagedActFields): FoldStagedActFields {
  const clean: Record<string, FoldStagedActFieldValue> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    clean[name] = Array.isArray(value) ? [...value] : value;
  }
  return clean;
}

function cloneProvenance(provenance: FoldStagedActProvenance): FoldStagedActProvenance {
  return {
    stagedVia: provenance.stagedVia,
    requestId: provenance.requestId,
    ...(provenance.conversationId !== undefined ? { conversationId: provenance.conversationId } : {}),
    ...(provenance.parentTaskId !== undefined ? { parentTaskId: provenance.parentTaskId } : {}),
    ...(provenance.browserId !== undefined ? { browserId: provenance.browserId } : {}),
    ...(provenance.grantId !== undefined ? { grantId: provenance.grantId } : {}),
  };
}

/** Canonical identity for dedupe and denial memory: the kind plus its sorted pins. */
function pinIdentity(kind: string, pins: FoldStagedActFields): string {
  const canonical = Object.fromEntries(
    Object.entries(pins)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => compareStrings(left, right)),
  );
  return `${kind}\n${JSON.stringify(canonical)}`;
}

function boundedProse(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD")
    .slice(0, MAX_TEXT_CHARS);
}

function trimSettled(draft: FoldStagedActsFileShape): void {
  const trimmable = draft.acts.filter((act) => act.state !== "staged"
    && !(act.state === "approved" && act.execution === undefined));
  const excess = trimmable.length - FOLD_STAGED_ACT_SETTLED_RETENTION;
  if (excess <= 0) return;
  // A record's history clock starts when its story fully ends: an approved
  // act ages from its execution outcome, everything else from settlement.
  const finalAt = (act: FoldStagedAct): string => String(act.execution?.at ?? act.settledAt);
  const dropped = new Set(
    trimmable
      .sort((left, right) => compareStrings(finalAt(left), finalAt(right)))
      .slice(0, excess)
      .map((act) => act.id),
  );
  draft.acts = draft.acts.filter((act) => !dropped.has(act.id));
}

const ACT_KEYS = [
  "schemaVersion",
  "id",
  "category",
  "kind",
  "parameters",
  "pins",
  "provenance",
  "state",
  "createdAt",
  "expiresAt",
  "settledAt",
  "decidedAt",
  "decision",
  "execution",
  "priorDenialAt",
  "invalidationReason",
  "cancellationReason",
];
const DECISION_KEYS = ["decision", "surface", "browserId", "grantId", "policyId", "note"];
const EXECUTION_KEYS = ["outcome", "at", "errorDetail"];

function isoIssue(value: unknown, label: string): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? null
    : `${label} must be a parseable timestamp.`;
}

function decisionRecordIssue(value: unknown, state: "approved" | "denied"): string | null {
  if (!isPlainRecord(value)) return "the decision must be an object.";
  const unknown = Object.keys(value).find((key) => !DECISION_KEYS.includes(key));
  if (unknown) return `decision.${unknown} is not part of the decision contract.`;
  const inputIssue = decisionInputIssue(value as unknown as FoldStagedActDecisionInput);
  if (inputIssue) return inputIssue;
  if (value.decision !== state) return `a ${state} act must carry a ${state} decision.`;
  return null;
}

function executionIssue(value: unknown): string | null {
  if (!isPlainRecord(value)) return "the execution record must be an object.";
  const unknown = Object.keys(value).find((key) => !EXECUTION_KEYS.includes(key));
  if (unknown) return `execution.${unknown} is not part of the execution contract.`;
  if (!FOLD_STAGED_ACT_EXECUTION_OUTCOMES.includes(value.outcome as FoldStagedActExecutionOutcome)) {
    return "execution.outcome must be executed, failed, or interrupted.";
  }
  const atIssue = isoIssue(value.at, "execution.at");
  if (atIssue) return atIssue;
  if (value.errorDetail !== undefined) {
    if (value.outcome !== "failed") return "execution.errorDetail accompanies only a failed execution.";
    const issue = textIssue(value.errorDetail, "execution.errorDetail");
    if (issue) return issue;
  }
  return null;
}

function stagedActIssue(value: unknown): string | null {
  if (!isPlainRecord(value)) return "a staged act must be an object.";
  const unknown = Object.keys(value).find((key) => !ACT_KEYS.includes(key));
  if (unknown) return `${unknown} is not part of the staged-act contract.`;
  if (value.schemaVersion !== FOLD_STAGED_ACT_SCHEMA_VERSION) {
    return `schemaVersion ${String(value.schemaVersion)} is not supported.`;
  }
  const idIssue = textIssue(value.id, "id");
  if (idIssue) return idIssue;
  const kind = value.kind;
  const descriptor = typeof kind === "string" ? descriptorFor(kind) : undefined;
  if (!descriptor) return `kind ${String(kind)} is unknown; unknown kinds fail closed.`;
  if (value.category !== descriptor.category) {
    return `category ${String(value.category)} does not match the ${String(kind)} kind.`;
  }
  const shapeIssue = fieldsIssue(kind as FoldStagedActKind, "parameters", value.parameters)
    ?? fieldsIssue(kind as FoldStagedActKind, "pins", value.pins)
    ?? sharedFieldIssue(value.parameters as FoldStagedActFields, value.pins as FoldStagedActFields)
    ?? provenanceIssue(value.provenance)
    ?? isoIssue(value.createdAt, "createdAt")
    ?? isoIssue(value.expiresAt, "expiresAt");
  if (shapeIssue) return shapeIssue;
  const state = value.state;
  if (!FOLD_STAGED_ACT_STATES.includes(state as FoldStagedActState)) {
    return `state ${String(state)} is not part of the staged-act contract.`;
  }
  if (state === "staged") {
    for (const key of ["settledAt", "decidedAt", "decision", "execution", "invalidationReason", "cancellationReason"]) {
      if (value[key] !== undefined) return `a staged act cannot carry ${key}.`;
    }
  } else {
    const settledIssue = isoIssue(value.settledAt, "settledAt");
    if (settledIssue) return settledIssue;
  }
  if (state === "approved" || state === "denied") {
    const decidedIssue = isoIssue(value.decidedAt, "decidedAt");
    if (decidedIssue) return decidedIssue;
    const decisionIssue = decisionRecordIssue(value.decision, state);
    if (decisionIssue) return decisionIssue;
  } else if (value.decision !== undefined || value.decidedAt !== undefined) {
    return "only an approved or denied act carries a decision.";
  }
  if (value.execution !== undefined) {
    if (state !== "approved") return "only an approved act carries an execution outcome.";
    const issue = executionIssue(value.execution);
    if (issue) return issue;
  }
  if (value.priorDenialAt !== undefined) {
    const issue = isoIssue(value.priorDenialAt, "priorDenialAt");
    if (issue) return issue;
  }
  if (value.invalidationReason !== undefined) {
    if (state !== "invalidated") return "invalidationReason belongs only to invalidated acts.";
    const issue = textIssue(value.invalidationReason, "invalidationReason");
    if (issue) return issue;
  }
  if (value.cancellationReason !== undefined) {
    if (state !== "canceled") return "cancellationReason belongs only to canceled acts.";
    const issue = textIssue(value.cancellationReason, "cancellationReason");
    if (issue) return issue;
  }
  return null;
}

function emptyFile(): FoldStagedActsFileShape {
  return { schemaVersion: FOLD_STAGED_ACT_SCHEMA_VERSION, acts: [] };
}

async function loadStagedActsFile(
  path: string,
): Promise<{ file: FoldStagedActsFileShape; damageReason: string | null }> {
  const damaged = (reason: string) => ({
    file: emptyFile(),
    damageReason: `The staged-act store at ${path} ${reason}.`,
  });
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { file: emptyFile(), damageReason: null };
    }
    return damaged(`could not be read (${caught instanceof Error ? caught.message : String(caught)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return damaged("is not readable JSON");
  }
  if (!isPlainRecord(parsed)) return damaged("is not a staged-act record");
  const unknown = Object.keys(parsed).find((key) => key !== "schemaVersion" && key !== "acts");
  if (unknown) return damaged(`carries the unknown field ${unknown}`);
  const sourceSchemaVersion = parsed.schemaVersion;
  if (sourceSchemaVersion !== 1 && sourceSchemaVersion !== FOLD_STAGED_ACT_SCHEMA_VERSION) {
    return typeof sourceSchemaVersion === "number" && sourceSchemaVersion > FOLD_STAGED_ACT_SCHEMA_VERSION
      ? damaged(`was written by a newer work-fold (schema version ${parsed.schemaVersion})`)
      : damaged(`uses the unsupported schema version ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.acts)) return damaged("does not list its acts");
  const acts: FoldStagedAct[] = [];
  const ids = new Set<string>();
  const pendingIdentities = new Set<string>();
  for (const [index, candidate] of parsed.acts.entries()) {
    const migrated = sourceSchemaVersion === 1 && isPlainRecord(candidate)
      ? { ...candidate, schemaVersion: FOLD_STAGED_ACT_SCHEMA_VERSION }
      : candidate;
    const issue = stagedActIssue(migrated);
    if (issue) return damaged(`holds an invalid act at index ${index}: ${issue}`);
    const act = migrated as FoldStagedAct;
    if (ids.has(act.id)) return damaged(`holds the duplicate act id ${act.id}`);
    ids.add(act.id);
    if (act.state === "staged") {
      const identity = pinIdentity(act.kind, act.pins);
      if (pendingIdentities.has(identity)) {
        return damaged("holds duplicate pending acts for the same kind and pins");
      }
      pendingIdentities.add(identity);
    }
    acts.push(structuredClone(act));
  }
  if (acts.filter((act) => act.state === "staged").length > FOLD_STAGED_ACT_PENDING_CAP) {
    return damaged(`holds more than ${FOLD_STAGED_ACT_PENDING_CAP} pending acts`);
  }
  return { file: { schemaVersion: FOLD_STAGED_ACT_SCHEMA_VERSION, acts }, damageReason: null };
}
