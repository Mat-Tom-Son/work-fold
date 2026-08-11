import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  FOLD_STAGED_ACT_KINDS,
  foldStagedActCategory,
  type FoldStagedAct,
  type FoldStagedActCategory,
  type FoldStagedActDecisionInput,
  type FoldStagedActKind,
} from "./fold-staged-acts.js";
import { workFoldStateRoot } from "./state-paths.js";

/**
 * Standing policies — the friction dial of docs/fold-consecrations.md:
 * person-authored records that pre-approve one narrow consecration category so
 * a click is not demanded for acts the person deliberately decided to trust in
 * advance. The canonical example that sized the design: "skill-only imports
 * from the Anthropic marketplace need no click."
 *
 * Everything here is machine-local authority state beside the staged-act store
 * (`fold/policies.json` under the work-fold state root), never portable and
 * never inside a Space folder. Policies are inspectable and citable by the
 * fold, exercised host-side at decision time, and — per never-list entry 4 —
 * written only by a person in Settings: there is no act-lane verb, no remote
 * operation, and no popover control that writes one, and the store's API shape
 * enforces that (see {@link FoldPolicySettingsWriter}).
 */

export const FOLD_POLICY_SCHEMA_VERSION = 1;

/** Bounded store, following the fold's bounded-authority-state discipline. */
export const FOLD_POLICY_CAP = 64;

/** Person-authored names stay short; the label is snapshotted into receipts. */
export const FOLD_POLICY_LABEL_MAX_CHARS = 120;

export const FOLD_POLICY_CHANGES_MAX_BYTES = 1024 * 1024;

/** Policies pre-approve only these two categories; destroy has no policy vocabulary. */
export type FoldPolicyCategory = Exclude<FoldStagedActCategory, "destroy">;

/**
 * The closed classification of every staged-act kind. It is deliberately a
 * total record over {@link FoldStagedActKind}: adding a staged-act kind
 * without classifying it here is a compile error, so policy eligibility is
 * reviewed — against the never-list, per the consecrations doc — every time
 * the kind vocabulary grows. Admitting an ineligible kind later is its own
 * register decision, not a schema tweak.
 *
 * Ineligible, and why:
 * - The destroy category (`space.delete-folder`, `app.data.purge`,
 *   `app.storage.clear`, `files.destroy`): a standing pre-approval of
 *   irreversible destruction is exactly the standing behavior the click
 *   exists to interrupt, with the worst possible blast radius.
 * - `publish.viewer.expose`: outward exposure is the one category whose blast
 *   radius includes people who are not the person; every new exposure takes a
 *   click.
 * - `routing.enable`: a routing enablement is standing cross-Space behavior
 *   whose whole-declaration review is the point.
 */
const KIND_CLASSIFICATION = {
  "app.review.approve": "eligible",
  "capability.package.install": "eligible",
  "capability.package.update": "eligible",
  "capability.skills.import": "eligible",
  "app.grant.network": "eligible",
  "app.grant.files": "eligible",
  "app.grant.notifications": "eligible",
  "app.connection.save": "eligible",
  "app.automation.enable": "eligible",
  "routing.enable": "ineligible",
  "publish.viewer.expose": "ineligible",
  "space.delete-folder": "ineligible",
  "app.data.purge": "ineligible",
  "app.storage.clear": "ineligible",
  "files.destroy": "ineligible",
} as const satisfies Record<FoldStagedActKind, "eligible" | "ineligible">;

/** The strict subset of staged-act kinds a standing policy may name. */
export type FoldPolicyEligibleKind = {
  [K in FoldStagedActKind]: (typeof KIND_CLASSIFICATION)[K] extends "eligible" ? K : never;
}[FoldStagedActKind];

export type FoldPolicyIneligibleKind = Exclude<FoldStagedActKind, FoldPolicyEligibleKind>;

export const FOLD_POLICY_ELIGIBLE_KINDS: readonly FoldPolicyEligibleKind[] = FOLD_STAGED_ACT_KINDS
  .filter((kind): kind is FoldPolicyEligibleKind => KIND_CLASSIFICATION[kind] === "eligible");

export const FOLD_POLICY_INELIGIBLE_KINDS: readonly FoldPolicyIneligibleKind[] = FOLD_STAGED_ACT_KINDS
  .filter((kind): kind is FoldPolicyIneligibleKind => KIND_CLASSIFICATION[kind] === "ineligible");

/**
 * The short host-curated first-party registry allowlist for make-runnable
 * matchers. A registry-scoped make-runnable policy trusts that registry's
 * entire future contents, so only these curated first-party sources may be
 * named without per-item identity; both spellings of the Anthropic Skills
 * collection are listed because staged pins may carry the catalog id or the
 * install source. Growing this list is a deliberate contract change reviewed
 * against the consecrations threat model, not configuration.
 */
export const FOLD_POLICY_FIRST_PARTY_REGISTRIES = [
  "official:anthropics/skills",
  "git:github.com/anthropics/skills",
] as const;

/**
 * A matcher is a closed set of typed, exact-value fields — no patterns, no
 * free text, and never model-authored prose. Evaluation compares each field
 * against the staged act's typed fields (pins first, then parameters), and a
 * policy can never be broader than its kind.
 */
export type FoldPolicyMatch = Readonly<Record<string, string>>;

/**
 * One person-authored standing policy (docs/fold-consecrations.md §Standing
 * policies). `effect` has exactly one v1 value; an auto-deny effect would be a
 * new register decision.
 */
export interface FoldStandingPolicy {
  schemaVersion: typeof FOLD_POLICY_SCHEMA_VERSION;
  id: string;
  /** Person-authored name, snapshotted into receipts at exercise time. */
  label: string;
  category: FoldPolicyCategory;
  kind: FoldPolicyEligibleKind;
  match: FoldPolicyMatch;
  effect: "auto-approve";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const FOLD_POLICY_CHANGE_EVENTS = [
  "created",
  "updated",
  "enabled",
  "disabled",
  "deleted",
  "attestation-mismatch",
  "reattested",
] as const;

export type FoldPolicyChangeEvent = (typeof FOLD_POLICY_CHANGE_EVENTS)[number];

/**
 * One line of the policy store's append-only change journal
 * (`fold/policy-changes.jsonl`). Every Settings write journals before the
 * store file commits, carrying the new attestation digest; the glance's
 * tolerant readers consume this trail to report policy-store changes. Lines
 * carry identifiers, typed matcher fields, and digests — never secrets or
 * model prose.
 */
export interface FoldPolicyChangeRecordV1 {
  v: 1;
  at: string;
  event: FoldPolicyChangeEvent;
  /**
   * For authoring events and `reattested`: the digest recorded by this write.
   * For `attestation-mismatch`: the observed out-of-band content digest, or
   * the literal `absent` when the store file disappeared.
   */
  attestation: string;
  /** On `attestation-mismatch`, the last blessed digest when one existed. */
  expectedAttestation?: string;
  policyId?: string;
  label?: string;
  category?: FoldPolicyCategory;
  kind?: FoldPolicyEligibleKind;
  match?: FoldPolicyMatch;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export type FoldPolicyErrorCode =
  | "STORE_DAMAGED"
  | "SETTINGS_ONLY"
  | "KIND_INELIGIBLE"
  | "OPEN_REGISTRY"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "POLICY_CAP"
  | "JOURNAL_UNAVAILABLE";

export class FoldPolicyError extends Error {
  readonly code: FoldPolicyErrorCode;

  constructor(code: FoldPolicyErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FoldPolicyError";
    this.code = code;
  }
}

/**
 * The Settings-only authoring seam. Policy authoring is a desktop-human act —
 * never-list entry 4 — so every mutating store method demands this capability
 * marker, and the marker is mintable only through
 * {@link mintFoldPolicySettingsWriter}. The desktop wiring mints exactly one
 * writer at startup and hands it only to the renderer-session Settings routes
 * in src/local/server.ts (Settings → The fold). The act facade, the remote
 * operation vocabulary, the popover routes, and every model-reachable path
 * must never receive or mint one; a plain object with the same shape is
 * refused, so holding a writer is an explicit, greppable act.
 *
 * This is an in-process API-shape boundary, not same-user tamper-proofing:
 * the consecrations threat model records that a hostile same-user process is
 * outside the boundary, and the attestation digest below is what makes a
 * quiet out-of-band edit visible.
 */
export interface FoldPolicySettingsWriter {
  readonly lane: "desktop-settings";
}

const SETTINGS_WRITERS = new WeakSet<FoldPolicySettingsWriter>();

export function mintFoldPolicySettingsWriter(): FoldPolicySettingsWriter {
  const writer: FoldPolicySettingsWriter = Object.freeze({ lane: "desktop-settings" });
  SETTINGS_WRITERS.add(writer);
  return writer;
}

export interface FoldPolicyCreateInput {
  label: string;
  kind: FoldPolicyEligibleKind;
  match: FoldPolicyMatch;
  enabled?: boolean;
}

export interface FoldPolicyUpdatePatch {
  label?: string;
  match?: FoldPolicyMatch;
}

/**
 * The outcome of host-side evaluation at staged-act admission. Evaluation
 * never throws: a damaged or unattested store means no auto-approval and the
 * card falls through to a click, which is the fail-closed direction.
 */
export type FoldPolicyEvaluation =
  | {
      matched: true;
      policy: FoldStandingPolicy;
      /**
       * Ready for the decision path: `surface: "policy"` plus the exercised
       * policy id, so the accepted and terminal receipts carry both per
       * receipts v2 (`WorkFoldCliActReceiptV2.surface` / `.policyId`).
       */
      decisionInput: FoldStagedActDecisionInput;
      /** The policy's label at exercise time, for the receipt's detail line. */
      labelSnapshot: string;
    }
  | { matched: false; reason?: "damaged" | "unattested" };

export interface FoldPolicyStoreStatus {
  damaged: boolean;
  damageReason?: string;
  /** False while damaged or while an out-of-band edit awaits a Settings re-save. */
  attested: boolean;
  attestationIssue?: string;
  policyCount: number;
  enabledCount: number;
}

export interface FoldStandingPolicyStoreOptions {
  /** Defaults to `fold/policies.json` under the work-fold state root. */
  path?: string;
  /** Defaults to `fold/policy-changes.jsonl` beside the store file. */
  journalPath?: string;
  now?: () => Date;
  maxJournalBytes?: number;
}

export function foldPoliciesFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "policies.json");
}

export function foldPolicyChangesFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "policy-changes.jsonl");
}

export function foldPolicyChangesRotatedFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "policy-changes.1.jsonl");
}

interface FoldPoliciesFileShape {
  schemaVersion: typeof FOLD_POLICY_SCHEMA_VERSION;
  /** Content-attestation digest over the canonical `policies` serialization. */
  attestation: string;
  policies: FoldStandingPolicy[];
}

type StoreView = "attested" | "unattested" | "damaged";

/**
 * The person-authored standing-policy store. Follows the fold's
 * authority-store disciplines — schema-versioned, fail-closed on read, atomic
 * temp-file-and-rename writes with 0600 modes, serialized operations, bounded
 * record count — plus one discipline of its own: a content-attestation digest
 * recorded on each Settings write.
 *
 * Every operation re-checks the store file first. A mismatch — an out-of-band
 * edit, a recomputed seal, a vanished file — disables ALL policies (evaluation
 * answers no-match) until a person re-saves them in Settings: any authoring
 * write, or {@link reattest} for the no-change case, records a fresh digest
 * over the records the person just reviewed. The mismatch is journaled so the
 * glance can report it. This is tamper-evidence against a quiet file edit,
 * not tamper-proofing against the same-user shell; the consecrations threat
 * model records what that is worth.
 *
 * A damaged file (unreadable, future-versioned, invalid or ineligible
 * records) fails closed harder: evaluation answers no-match, listing and
 * every mutation refuse, and the store never overwrites damaged authority
 * state — recovery means removing the damaged file outside the product,
 * after which the store treats the restored content as unattested until a
 * person re-saves it in Settings.
 */
export class FoldStandingPolicyStore extends EventEmitter {
  readonly path: string;
  readonly journalPath: string;
  readonly rotatedJournalPath: string;
  readonly #now: () => Date;
  readonly #maxJournalBytes: number;
  #policies: FoldStandingPolicy[] = [];
  #view: StoreView = "attested";
  #viewIssue: string | undefined;
  /** Digest of the records last written by Settings or trusted at open. */
  #blessedDigest: string | null = null;
  /** Last journaled out-of-band observation, so one edit journals once. */
  #observedDigest: string | null = null;
  #fileExpected = false;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, journalPath: string, rotatedJournalPath: string, options: {
    now: () => Date;
    maxJournalBytes: number;
  }) {
    super();
    this.path = path;
    this.journalPath = journalPath;
    this.rotatedJournalPath = rotatedJournalPath;
    this.#now = options.now;
    this.#maxJournalBytes = options.maxJournalBytes;
  }

  static async create(options: FoldStandingPolicyStoreOptions = {}): Promise<FoldStandingPolicyStore> {
    const path = resolve(options.path ?? foldPoliciesFile());
    const journalPath = resolve(options.journalPath ?? foldPolicyChangesFile());
    const rotatedJournalPath = options.journalPath !== undefined
      ? rotatedSibling(journalPath)
      : resolve(foldPolicyChangesRotatedFile());
    const store = new FoldStandingPolicyStore(path, journalPath, rotatedJournalPath, {
      now: options.now ?? (() => new Date()),
      maxJournalBytes: options.maxJournalBytes ?? FOLD_POLICY_CHANGES_MAX_BYTES,
    });
    await store.#run(async () => {
      await store.#sync({ atOpen: true });
    });
    return store;
  }

  /** As of the last operation; call {@link list} or {@link evaluate} to re-check the file. */
  status(): FoldPolicyStoreStatus {
    if (this.#view === "damaged") {
      return {
        damaged: true,
        ...(this.#viewIssue !== undefined ? { damageReason: this.#viewIssue } : {}),
        attested: false,
        policyCount: 0,
        enabledCount: 0,
      };
    }
    return {
      damaged: false,
      attested: this.#view === "attested",
      ...(this.#view === "unattested" && this.#viewIssue !== undefined
        ? { attestationIssue: this.#viewIssue }
        : {}),
      policyCount: this.#policies.length,
      enabledCount: this.#policies.filter((policy) => policy.enabled).length,
    };
  }

  /**
   * Lists policies for Settings and for the fold to cite. Needs no writer —
   * citing is not writing. While unattested, the list shows the adopted
   * on-disk records so the person reviews exactly what a re-save would bless.
   */
  async list(): Promise<FoldStandingPolicy[]> {
    return await this.#run(async () => {
      await this.#sync();
      this.#assertNotDamaged();
      return this.#sorted().map((policy) => structuredClone(policy));
    });
  }

  async get(id: string): Promise<FoldStandingPolicy | undefined> {
    return await this.#run(async () => {
      await this.#sync();
      this.#assertNotDamaged();
      const policy = this.#policies.find((candidate) => candidate.id === id);
      return policy ? structuredClone(policy) : undefined;
    });
  }

  /**
   * Host-side evaluation at staged-act admission (docs/fold-consecrations.md):
   * never in the model, never over prose. The store file is re-checked first;
   * a mismatch disables every policy and this answers no-match. A match
   * returns the decision input the caller feeds to the decision path
   * (FoldDecisionService), which then runs the same eligibility precheck, pin
   * recheck, journal-first consumption, and execution a click runs — so an
   * exercised policy's receipts contain everything a clicked decision's
   * receipts contain, with `surface: "policy"` and the policy id.
   *
   * Evaluation is deterministic: policies are considered oldest-first
   * (createdAt, then id), and the first enabled exact match wins, so one
   * staged act exercises at most one policy.
   */
  async evaluate(act: FoldStagedAct): Promise<FoldPolicyEvaluation> {
    return await this.#run(async () => {
      await this.#sync();
      if (this.#view === "damaged") return { matched: false, reason: "damaged" } as const;
      if (this.#view === "unattested") return { matched: false, reason: "unattested" } as const;
      if (act.state !== "staged") return { matched: false } as const;
      if (KIND_CLASSIFICATION[act.kind] !== "eligible") return { matched: false } as const;
      for (const policy of this.#sorted()) {
        if (!policy.enabled || policy.kind !== act.kind) continue;
        if (!matcherMatchesAct(policy.match, act)) continue;
        return {
          matched: true,
          policy: structuredClone(policy),
          decisionInput: {
            decision: "approved",
            surface: "policy",
            policyId: policy.id,
          },
          labelSnapshot: policy.label,
        } as const;
      }
      return { matched: false } as const;
    });
  }

  async createPolicy(writer: FoldPolicySettingsWriter, input: FoldPolicyCreateInput): Promise<FoldStandingPolicy> {
    return await this.#authoring(writer, (policies) => {
      const issue = createInputIssue(input);
      if (issue) throw issue;
      if (policies.length >= FOLD_POLICY_CAP) {
        throw new FoldPolicyError(
          "POLICY_CAP",
          `${FOLD_POLICY_CAP} standing policies already exist; delete one in Settings before adding another.`,
        );
      }
      const nowIso = this.#now().toISOString();
      const policy: FoldStandingPolicy = {
        schemaVersion: FOLD_POLICY_SCHEMA_VERSION,
        id: randomUUID(),
        label: input.label,
        category: foldStagedActCategory(input.kind) as FoldPolicyCategory,
        kind: input.kind,
        match: cloneMatch(input.match),
        effect: "auto-approve",
        enabled: input.enabled ?? true,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      policies.push(policy);
      return { event: "created", policy };
    });
  }

  /** Edits label and/or matcher. A kind change is a different policy: delete and create. */
  async updatePolicy(
    writer: FoldPolicySettingsWriter,
    id: string,
    patch: FoldPolicyUpdatePatch,
  ): Promise<FoldStandingPolicy> {
    return await this.#authoring(writer, (policies) => {
      const patchIssue = updatePatchShapeIssue(patch);
      if (patchIssue) throw new FoldPolicyError("INPUT_INVALID", `work-fold refused this policy edit: ${patchIssue}`);
      const policy = findPolicy(policies, id);
      if (patch.label !== undefined) {
        const labelIssue = labelTextIssue(patch.label);
        if (labelIssue) throw new FoldPolicyError("INPUT_INVALID", `work-fold refused this policy edit: ${labelIssue}`);
        policy.label = patch.label;
      }
      if (patch.match !== undefined) {
        const matchIssue = matcherIssue(policy.kind, patch.match);
        if (matchIssue) throw new FoldPolicyError(matchIssue.code, `work-fold refused this policy edit: ${matchIssue.message}`);
        policy.match = cloneMatch(patch.match);
      }
      policy.updatedAt = this.#now().toISOString();
      return { event: "updated", policy };
    });
  }

  /** Enabling and disabling are their own journaled events; a no-op change writes nothing. */
  async setPolicyEnabled(
    writer: FoldPolicySettingsWriter,
    id: string,
    enabled: boolean,
  ): Promise<FoldStandingPolicy> {
    if (typeof enabled !== "boolean") {
      throw new FoldPolicyError("INPUT_INVALID", "work-fold refused this policy change: enabled must be a boolean.");
    }
    return await this.#authoring(writer, (policies) => {
      const policy = findPolicy(policies, id);
      if (policy.enabled === enabled) return { event: null, policy };
      policy.enabled = enabled;
      policy.updatedAt = this.#now().toISOString();
      return { event: enabled ? "enabled" : "disabled", policy };
    });
  }

  /**
   * Deletes one policy. Disabling or deleting affects only future staged
   * acts; exercised receipts stand, and nothing is un-executed.
   */
  async removePolicy(writer: FoldPolicySettingsWriter, id: string): Promise<FoldStandingPolicy> {
    return await this.#authoring(writer, (policies) => {
      const policy = findPolicy(policies, id);
      policies.splice(policies.indexOf(policy), 1);
      return { event: "deleted", policy };
    });
  }

  /**
   * The explicit re-save for the no-change case: after reviewing the adopted
   * records in Settings, the person blesses them as-is. Any authoring write
   * re-attests implicitly; this exists so review-without-edit is one act.
   */
  async reattest(writer: FoldPolicySettingsWriter): Promise<FoldPolicyStoreStatus> {
    return await this.#run(async () => {
      this.#assertWriter(writer);
      await this.#sync();
      this.#assertNotDamaged();
      if (this.#view === "attested") return this.status();
      await this.#commit(this.#policies, { event: "reattested" });
      return this.status();
    });
  }

  // -------------------------------------------------------------------------

  async #authoring(
    writer: FoldPolicySettingsWriter,
    operate: (policies: FoldStandingPolicy[]) => { event: Exclude<FoldPolicyChangeEvent, "attestation-mismatch" | "reattested"> | null; policy: FoldStandingPolicy },
  ): Promise<FoldStandingPolicy> {
    return await this.#run(async () => {
      this.#assertWriter(writer);
      await this.#sync();
      this.#assertNotDamaged();
      const next = this.#policies.map((policy) => structuredClone(policy));
      const { event, policy } = operate(next);
      if (event === null) return structuredClone(policy);
      await this.#commit(next, { event, policy });
      return structuredClone(policy);
    });
  }

  /**
   * Journal-first commit: the change line (carrying the new attestation
   * digest) must append before the store file is replaced. An unwritable
   * journal refuses the whole mutation and leaves state unchanged; a crash
   * between the two leaves a journaled change whose digest the store file
   * never recorded — the honest torn-write signal, mirroring the act lane's
   * accepted-without-terminal discipline.
   */
  async #commit(
    next: FoldStandingPolicy[],
    change: { event: Exclude<FoldPolicyChangeEvent, "attestation-mismatch">; policy?: FoldStandingPolicy },
  ): Promise<void> {
    const digest = attestationDigest(next);
    const record: FoldPolicyChangeRecordV1 = {
      v: 1,
      at: this.#now().toISOString(),
      event: change.event,
      attestation: digest,
      ...(change.policy !== undefined
        ? {
            policyId: change.policy.id,
            label: change.policy.label,
            category: change.policy.category,
            kind: change.policy.kind,
            match: cloneMatch(change.policy.match),
            enabled: change.policy.enabled,
            createdAt: change.policy.createdAt,
            updatedAt: change.policy.updatedAt,
          }
        : {}),
    };
    try {
      await this.#appendJournal(record);
    } catch (caught) {
      throw new FoldPolicyError(
        "JOURNAL_UNAVAILABLE",
        "work-fold could not journal this policy change, so nothing was changed.",
        { cause: caught },
      );
    }
    const file: FoldPoliciesFileShape = {
      schemaVersion: FOLD_POLICY_SCHEMA_VERSION,
      attestation: digest,
      policies: next,
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
    this.#policies = next;
    this.#blessedDigest = digest;
    this.#fileExpected = true;
    this.#view = "attested";
    this.#viewIssue = undefined;
    this.#observedDigest = null;
    this.emit("changed", structuredClone(record));
  }

  /**
   * Re-checks the store file against the last blessed digest. At open, a
   * valid file whose own attestation seals its content is trusted — the
   * restart story — while during a session any rewrite, even one that
   * recomputed the in-file seal, is an out-of-band edit.
   */
  async #sync(options: { atOpen?: boolean } = {}): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException)?.code === "ENOENT") {
        if (!this.#fileExpected) {
          this.#policies = [];
          this.#view = "attested";
          this.#viewIssue = undefined;
          this.#blessedDigest = null;
          return;
        }
        await this.#becomeUnattested([], "absent", "the standing-policy store file disappeared outside Settings");
        return;
      }
      this.#becomeDamaged(`could not be read (${caught instanceof Error ? caught.message : String(caught)})`);
      return;
    }
    this.#fileExpected = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#becomeDamaged("is not readable JSON");
      return;
    }
    const loaded = policiesFileIssue(parsed);
    if (typeof loaded === "string") {
      this.#becomeDamaged(loaded);
      return;
    }
    const contentDigest = attestationDigest(loaded.policies);
    if (loaded.attestation !== contentDigest) {
      await this.#becomeUnattested(
        loaded.policies,
        contentDigest,
        "the store file's content does not match its recorded attestation digest",
      );
      return;
    }
    if (options.atOpen === true || this.#blessedDigest === contentDigest) {
      this.#policies = loaded.policies;
      this.#blessedDigest = contentDigest;
      this.#view = "attested";
      this.#viewIssue = undefined;
      this.#observedDigest = null;
      return;
    }
    if (this.#view === "unattested" && this.#observedDigest === contentDigest) {
      this.#policies = loaded.policies;
      return;
    }
    await this.#becomeUnattested(loaded.policies, contentDigest, "the store file was rewritten outside Settings");
  }

  async #becomeUnattested(policies: FoldStandingPolicy[], observed: string, reason: string): Promise<void> {
    const previousObserved = this.#observedDigest;
    const expected = this.#blessedDigest;
    this.#policies = policies;
    this.#view = "unattested";
    this.#viewIssue = `${reason}; every policy is disabled until a person re-saves them in Settings.`;
    this.#blessedDigest = null;
    this.#observedDigest = observed;
    if (previousObserved === observed) return;
    if (await this.#journalTailMatchesMismatch(observed)) return;
    const record: FoldPolicyChangeRecordV1 = {
      v: 1,
      at: this.#now().toISOString(),
      event: "attestation-mismatch",
      attestation: observed,
      ...(expected !== null ? { expectedAttestation: expected } : {}),
    };
    try {
      await this.#appendJournal(record);
    } catch {
      // Observation journaling is best-effort; the disabled state never is.
    }
    this.emit("changed", structuredClone(record));
  }

  #becomeDamaged(reason: string): void {
    this.#policies = [];
    this.#view = "damaged";
    this.#viewIssue = `The standing-policy store at ${this.path} ${reason}.`;
    this.#blessedDigest = null;
  }

  /** One out-of-band edit journals once, across restarts too. */
  async #journalTailMatchesMismatch(observed: string): Promise<boolean> {
    const text = await readFile(this.journalPath, "utf8").catch(() => null);
    if (!text) return false;
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    const tail = lines.at(-1);
    if (!tail) return false;
    try {
      const record = JSON.parse(tail) as Partial<FoldPolicyChangeRecordV1>;
      return record.event === "attestation-mismatch" && record.attestation === observed;
    } catch {
      return false;
    }
  }

  async #appendJournal(record: FoldPolicyChangeRecordV1): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const info = await stat(this.journalPath).catch(() => null);
    if (info && info.size > this.#maxJournalBytes) {
      await rm(this.rotatedJournalPath, { force: true });
      await rename(this.journalPath, this.rotatedJournalPath);
    }
    await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
  }

  #assertWriter(writer: FoldPolicySettingsWriter): void {
    if (SETTINGS_WRITERS.has(writer)) return;
    throw new FoldPolicyError(
      "SETTINGS_ONLY",
      "Standing policies are authored only in Settings by a person. No act-lane verb, remote operation, or "
        + "assistant path can write one; the fold may cite policies, never write them.",
    );
  }

  #assertNotDamaged(): void {
    if (this.#view !== "damaged") return;
    throw new FoldPolicyError(
      "STORE_DAMAGED",
      `work-fold disabled standing policies: ${this.#viewIssue ?? "the store is damaged."} `
        + "Policies fail closed to clicks, and nothing is guessed from damaged authority state.",
    );
  }

  #sorted(): FoldStandingPolicy[] {
    return [...this.#policies].sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id));
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

// ---------------------------------------------------------------------------
// Matcher vocabulary. One closed descriptor per policy-eligible kind: the
// typed fields a matcher may name, which are required, and — for make-runnable
// kinds — the identity rule that refuses open-registry matchers at write.
// ---------------------------------------------------------------------------

export interface FoldPolicyMatcherFieldSpec {
  required: boolean;
  values?: readonly string[];
}

type MatcherRefusal = { code: "INPUT_INVALID" | "OPEN_REGISTRY"; message: string };

export interface FoldPolicyMatcherDescriptor {
  fields: Readonly<Record<string, FoldPolicyMatcherFieldSpec>>;
  identityIssue?(match: FoldPolicyMatch): MatcherRefusal | null;
}

const CAPABILITY_SCOPES = ["personal", "space"] as const;

function req(values?: readonly string[]): FoldPolicyMatcherFieldSpec {
  return values ? { required: true, values } : { required: true };
}

function opt(values?: readonly string[]): FoldPolicyMatcherFieldSpec {
  return values ? { required: false, values } : { required: false };
}

function isFirstPartyRegistry(source: string | undefined): boolean {
  return source !== undefined
    && (FOLD_POLICY_FIRST_PARTY_REGISTRIES as readonly string[]).includes(source);
}

function openRegistryRefusal(source: string): MatcherRefusal {
  return {
    code: "OPEN_REGISTRY",
    message: `a make-runnable policy must pin per-item identity or name a first-party curated registry. `
      + `"${source}" is not on the curated allowlist, and pre-approving that registry's entire future contents `
      + `would let steered staging become un-clicked installs.`,
  };
}

function scopeContradiction(match: FoldPolicyMatch): MatcherRefusal | null {
  if (match.scope === "personal" && match.spaceId !== undefined) {
    return {
      code: "INPUT_INVALID",
      message: "a Personal-scope matcher cannot also name a spaceId; Personal-scope acts have no Space.",
    };
  }
  return null;
}

function packageIdentityIssue(match: FoldPolicyMatch): MatcherRefusal | null {
  const contradiction = scopeContradiction(match);
  if (contradiction) return contradiction;
  if (match.packageId !== undefined) return null;
  if (isFirstPartyRegistry(match.source)) return null;
  return openRegistryRefusal(String(match.source));
}

function skillsImportIdentityIssue(match: FoldPolicyMatch): MatcherRefusal | null {
  const contradiction = scopeContradiction(match);
  if (contradiction) return contradiction;
  if (match.contentDigest !== undefined) return null;
  if (match.source === undefined) {
    return {
      code: "INPUT_INVALID",
      message: "a skills-import matcher must pin a contentDigest or name a first-party curated registry source.",
    };
  }
  if (isFirstPartyRegistry(match.source)) return null;
  return openRegistryRefusal(match.source);
}

/**
 * Widen-power matchers anchor on an exact App Instance and may only narrow
 * from there; make-runnable matchers additionally answer the identity rule.
 * `app.review.approve` is per-item by construction: the required matcher
 * field is the exact reviewed content digest.
 *
 * Exported read-only: the Settings contract in src/local/server.ts derives
 * its per-kind field structure (names, required flags, value enums) from this
 * vocabulary instead of mirroring it, so the pickers a person sees can never
 * drift from what {@link matcherIssue} accepts at write. Presentation —
 * labels, hints, category copy — stays with the Settings surface.
 */
export const FOLD_POLICY_MATCHER_DESCRIPTORS: Readonly<Record<FoldPolicyEligibleKind, FoldPolicyMatcherDescriptor>> = {
  "app.review.approve": {
    fields: { reviewDigest: req(), spaceId: opt() },
  },
  "capability.package.install": {
    fields: { source: req(), packageId: opt(), version: opt(), scope: opt(CAPABILITY_SCOPES), spaceId: opt() },
    identityIssue: packageIdentityIssue,
  },
  "capability.package.update": {
    fields: { source: req(), packageId: opt(), version: opt(), scope: opt(CAPABILITY_SCOPES), spaceId: opt() },
    identityIssue: packageIdentityIssue,
  },
  "capability.skills.import": {
    fields: { contentDigest: opt(), source: opt(), scope: opt(CAPABILITY_SCOPES), spaceId: opt() },
    identityIssue: skillsImportIdentityIssue,
  },
  "app.grant.network": {
    fields: { appInstanceId: req(), declarationId: opt(), spaceId: opt() },
  },
  "app.grant.files": {
    fields: { appInstanceId: req(), declarationId: opt(), spaceId: opt() },
  },
  "app.grant.notifications": {
    fields: { appInstanceId: req(), declarationId: opt(), spaceId: opt() },
  },
  "app.connection.save": {
    fields: { appInstanceId: req(), declarationId: opt(), target: opt(), adapterKind: opt(), spaceId: opt() },
  },
  "app.automation.enable": {
    fields: { appInstanceId: req(), automationId: opt(), spaceId: opt() },
  },
};

/**
 * Exact-value matching over the staged act's typed fields, pins first —
 * pins are the identities decision-time recheck verifies, so they are the
 * identities a policy trusts. Matcher values are strings only; a non-string
 * act field never matches.
 */
function matcherMatchesAct(match: FoldPolicyMatch, act: FoldStagedAct): boolean {
  for (const [name, expected] of Object.entries(match)) {
    if (expected === undefined) continue;
    const actual = act.pins[name] ?? act.parameters[name];
    if (typeof actual !== "string" || actual !== expected) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 2048;
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textIssue(value: unknown, label: string, maxChars = MAX_TEXT_CHARS): string | null {
  if (typeof value !== "string") return `${label} must be a string.`;
  if (!value.trim() || value.length > maxChars) return `${label} must be 1-${maxChars} characters.`;
  if (FORBIDDEN_TEXT.test(value)) return `${label} must not contain control or direction-override characters.`;
  return null;
}

function labelTextIssue(value: unknown): string | null {
  return textIssue(value, "the label", FOLD_POLICY_LABEL_MAX_CHARS);
}

function kindIneligibleMessage(kind: string): string {
  if (!Object.prototype.hasOwnProperty.call(KIND_CLASSIFICATION, kind)) {
    return `work-fold does not know the staged-act kind "${kind}"; the policy-eligible kind set is closed.`;
  }
  const category = foldStagedActCategory(kind as FoldStagedActKind);
  if (category === "destroy") {
    return `"${kind}" cannot carry a standing policy: the destroy category has no policy vocabulary — `
      + "a standing pre-approval of irreversible destruction is exactly the standing behavior the click exists to interrupt.";
  }
  if (kind === "publish.viewer.expose") {
    return `"${kind}" cannot carry a standing policy: outward viewer exposure always takes a click, because its `
      + "blast radius includes people who are not the person.";
  }
  if (kind === "routing.enable") {
    return `"${kind}" cannot carry a standing policy: a routing enablement is standing cross-Space behavior whose `
      + "whole-declaration review is the point.";
  }
  return `"${kind}" is not a policy-eligible kind.`;
}

function matcherIssue(kind: FoldPolicyEligibleKind, value: unknown): MatcherRefusal | null {
  const descriptor = FOLD_POLICY_MATCHER_DESCRIPTORS[kind];
  if (!isPlainRecord(value)) {
    return { code: "INPUT_INVALID", message: "match must be an object of typed matcher fields." };
  }
  for (const name of Object.keys(value)) {
    if (value[name] === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(descriptor.fields, name)) {
      return {
        code: "INPUT_INVALID",
        message: `match.${name} is not a typed matcher field of ${kind}; the matcher vocabulary is closed.`,
      };
    }
  }
  for (const [name, spec] of Object.entries(descriptor.fields)) {
    const field = value[name];
    if (field === undefined) {
      if (spec.required) return { code: "INPUT_INVALID", message: `match.${name} is required for ${kind}.` };
      continue;
    }
    const issue = textIssue(field, `match.${name}`);
    if (issue) return { code: "INPUT_INVALID", message: issue };
    if (spec.values && !spec.values.includes(field as string)) {
      return { code: "INPUT_INVALID", message: `match.${name} must be one of: ${spec.values.join(", ")}.` };
    }
  }
  return descriptor.identityIssue ? descriptor.identityIssue(value as FoldPolicyMatch) : null;
}

const CREATE_INPUT_KEYS = ["label", "kind", "match", "enabled"];
const UPDATE_PATCH_KEYS = ["label", "match"];

function createInputIssue(input: FoldPolicyCreateInput): FoldPolicyError | null {
  if (!isPlainRecord(input)) {
    return new FoldPolicyError("INPUT_INVALID", "work-fold refused this policy: the input must be an object.");
  }
  const unknown = Object.keys(input).find((key) => !CREATE_INPUT_KEYS.includes(key));
  if (unknown) {
    return new FoldPolicyError("INPUT_INVALID", `work-fold refused this policy: ${unknown} is not part of the policy contract.`);
  }
  const labelIssue = labelTextIssue(input.label);
  if (labelIssue) return new FoldPolicyError("INPUT_INVALID", `work-fold refused this policy: ${labelIssue}`);
  if (typeof input.kind !== "string" || KIND_CLASSIFICATION[input.kind as FoldStagedActKind] !== "eligible") {
    return new FoldPolicyError("KIND_INELIGIBLE", `work-fold refused this policy: ${kindIneligibleMessage(String(input.kind))}`);
  }
  const matchIssue = matcherIssue(input.kind, input.match);
  if (matchIssue) return new FoldPolicyError(matchIssue.code, `work-fold refused this policy: ${matchIssue.message}`);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return new FoldPolicyError("INPUT_INVALID", "work-fold refused this policy: enabled must be a boolean.");
  }
  return null;
}

function updatePatchShapeIssue(patch: FoldPolicyUpdatePatch): string | null {
  if (!isPlainRecord(patch)) return "the patch must be an object.";
  const unknown = Object.keys(patch).find((key) => !UPDATE_PATCH_KEYS.includes(key));
  if (unknown) return `${unknown} is not editable; a policy's kind never changes — delete and create instead.`;
  if (patch.label === undefined && patch.match === undefined) return "the patch names nothing to change.";
  return null;
}

function findPolicy(policies: FoldStandingPolicy[], id: string): FoldStandingPolicy {
  const policy = policies.find((candidate) => candidate.id === id);
  if (!policy) {
    throw new FoldPolicyError("NOT_FOUND", "No standing policy has this id; it may have been deleted in Settings.");
  }
  return policy;
}

function cloneMatch(match: FoldPolicyMatch): FoldPolicyMatch {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(match)) {
    if (value === undefined) continue;
    clean[name] = value;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Persistence validation and the content attestation.
// ---------------------------------------------------------------------------

const POLICY_KEYS = [
  "schemaVersion",
  "id",
  "label",
  "category",
  "kind",
  "match",
  "effect",
  "enabled",
  "createdAt",
  "updatedAt",
];

function isoIssue(value: unknown, label: string): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? null
    : `${label} must be a parseable timestamp.`;
}

function policyRecordIssue(value: unknown): string | null {
  if (!isPlainRecord(value)) return "a policy must be an object.";
  const unknown = Object.keys(value).find((key) => !POLICY_KEYS.includes(key));
  if (unknown) return `${unknown} is not part of the policy contract.`;
  if (value.schemaVersion !== FOLD_POLICY_SCHEMA_VERSION) {
    return `schemaVersion ${String(value.schemaVersion)} is not supported.`;
  }
  const idIssue = textIssue(value.id, "id");
  if (idIssue) return idIssue;
  const labelIssue = labelTextIssue(value.label);
  if (labelIssue) return labelIssue;
  const kind = value.kind;
  if (typeof kind !== "string" || KIND_CLASSIFICATION[kind as FoldStagedActKind] !== "eligible") {
    return kindIneligibleMessage(String(kind));
  }
  if (value.category !== foldStagedActCategory(kind as FoldStagedActKind)) {
    return `category ${String(value.category)} does not match the ${kind} kind.`;
  }
  const matchIssue = matcherIssue(kind as FoldPolicyEligibleKind, value.match);
  if (matchIssue) return matchIssue.message;
  if (value.effect !== "auto-approve") return "effect must be auto-approve; it is the only v1 effect.";
  if (typeof value.enabled !== "boolean") return "enabled must be a boolean.";
  return isoIssue(value.createdAt, "createdAt") ?? isoIssue(value.updatedAt, "updatedAt");
}

/** Validated records, or a damage reason. */
function policiesFileIssue(parsed: unknown): { attestation: string; policies: FoldStandingPolicy[] } | string {
  if (!isPlainRecord(parsed)) return "is not a standing-policy record";
  const unknown = Object.keys(parsed).find((key) => key !== "schemaVersion" && key !== "attestation" && key !== "policies");
  if (unknown) return `carries the unknown field ${unknown}`;
  if (parsed.schemaVersion !== FOLD_POLICY_SCHEMA_VERSION) {
    return typeof parsed.schemaVersion === "number" && parsed.schemaVersion > FOLD_POLICY_SCHEMA_VERSION
      ? `was written by a newer work-fold (schema version ${parsed.schemaVersion})`
      : `uses the unsupported schema version ${String(parsed.schemaVersion)}`;
  }
  if (typeof parsed.attestation !== "string" || !/^[0-9a-f]{64}$/.test(parsed.attestation)) {
    return "does not record a content-attestation digest";
  }
  if (!Array.isArray(parsed.policies)) return "does not list its policies";
  if (parsed.policies.length > FOLD_POLICY_CAP) return `holds more than ${FOLD_POLICY_CAP} policies`;
  const policies: FoldStandingPolicy[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of parsed.policies.entries()) {
    const issue = policyRecordIssue(candidate);
    if (issue) return `holds an invalid policy at index ${index}: ${issue}`;
    const policy = candidate as FoldStandingPolicy;
    if (ids.has(policy.id)) return `holds the duplicate policy id ${policy.id}`;
    ids.add(policy.id);
    policies.push(structuredClone(policy));
  }
  return { attestation: parsed.attestation, policies };
}

/**
 * The content-attestation digest: sha256 over a canonical (sorted-key)
 * serialization of the policy records, recorded in the store file on each
 * Settings write and compared on every read. A quiet edit that does not
 * recompute it breaks the seal immediately; an edit that does recompute it is
 * still caught while the app runs, because the store also remembers the
 * digest it last wrote. Across a restart the in-file seal is trusted — the
 * documented tamper-evidence limit.
 */
export function attestationDigest(policies: readonly FoldStandingPolicy[]): string {
  return createHash("sha256").update(canonicalJson(policies)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function rotatedSibling(journalPath: string): string {
  return journalPath.endsWith(".jsonl")
    ? `${journalPath.slice(0, -".jsonl".length)}.1.jsonl`
    : `${journalPath}.1`;
}
