import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { FOLD_DECISION_SURFACES, type FoldDecisionSurface } from "../fold-staged-acts.js";
import { workFoldStateRoot } from "../state-paths.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingBounds,
  workFoldRoutingDigest,
  workFoldRoutingReferencedSpaceIds,
  type WorkFoldRoutingDeclaration,
} from "./routing-declarations.js";

/**
 * Machine-local routing authority and its receipts journal
 * (docs/fold-routings.md). Everything here is application state that
 * references multiple Spaces and must never travel with any folder: the
 * enabled declarations, their exact-digest enablement grants, cadence
 * anchors, health states, and the append-only run/hop receipts. A file
 * claiming to be routing state is inert bytes anywhere else — authority
 * exists only in this store, and only over a digest a person consecrated.
 */
export const WORKFOLD_ROUTING_STORE_SCHEMA_VERSION = 1;

export const WORKFOLD_ROUTING_RECEIPTS_MAX_BYTES = 1024 * 1024;

/** Bounded per-routing enablement history; every re-enablement is a fresh consecration. */
export const WORKFOLD_ROUTING_GRANT_HISTORY_LIMIT = 16;

const maximumStateBytes = 8 * 1024 * 1024;
const maximumTextLength = 2_000;
const forbiddenTextPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const scrubReplacePattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** The routing state file: enabled declarations, grants, anchors, health. */
export function workFoldRoutingStateFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "routings", "routings.json");
}

/**
 * The routing receipts journal. The path is a cross-module contract: the
 * glance's tolerant reader (src/local/glance.ts) consumes exactly this file
 * and its rotated sibling.
 */
export function workFoldRoutingReceiptsFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "routings", "receipts.jsonl");
}

export function workFoldRoutingReceiptsRotatedFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "routings", "receipts.1.jsonl");
}

export type WorkFoldRoutingHealth = "enabled" | "disabled" | "suspended";

/** Terminal and progress outcomes for run- and hop-scoped receipt records. */
export type WorkFoldRoutingRunReceiptOutcome =
  | "accepted"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";

/** Store lifecycle outcomes for routing-scoped receipt records. */
export type WorkFoldRoutingLifecycleReceiptOutcome =
  | "enabled"
  | "disabled"
  | "suspended"
  | "re-registered"
  | "deleted";

export type WorkFoldRoutingReceiptScope = "routing" | "run" | "hop";

/** Why a run was admitted; the terminal record names the trigger cause exactly. */
export type WorkFoldRoutingRunCause =
  | { kind: "scheduled" | "resume"; slotAt: string }
  | { kind: "run-now"; requestId?: string }
  | {
      kind: "on-settled";
      source:
        | { kind: "check-run"; spaceId: string; runId: string; state: string; checkIds: string[] }
        | { kind: "app-automation-run"; spaceId: string; appId: string; automationId: string; runId: string; outcome: string };
    };

/**
 * One journal line. Lines are written at version 1 and read tolerantly:
 * unknown fields are ignored by readers (the glance destructures only what it
 * knows), and every text field is scrubbed before it is written. Receipts
 * carry identifiers, digests, paths, and counts — never message text, file
 * contents, or secrets.
 */
export interface WorkFoldRoutingReceiptV1 {
  v: 1;
  at: string;
  scope: WorkFoldRoutingReceiptScope;
  outcome: WorkFoldRoutingRunReceiptOutcome | WorkFoldRoutingLifecycleReceiptOutcome;
  routingId: string;
  /** Present on every run- and hop-scoped record; absent on lifecycle records. */
  runId?: string;
  hopId?: string;
  hopKind?: "chat" | "files" | "check";
  title?: string;
  digest?: string;
  cause?: WorkFoldRoutingRunCause;
  detail?: string;
  spaceId?: string;
  fromSpaceId?: string;
  toSpaceId?: string;
  conversationId?: string;
  /** Turn task id (chat hops) or Check task id (check hops). */
  taskId?: string;
  /** Pre- and post-turn History checkpoint ids of a chat hop. */
  checkpointIds?: string[];
  restorePointId?: string;
  sourcePaths?: string[];
  copiedPaths?: string[];
  fileCount?: number;
  totalBytes?: number;
  checkRunId?: string;
  checkIds?: string[];
  findingCount?: number;
  admittedCount?: number;
  /** Names the failing hop on a failed run and on the skipped hops after it. */
  failedHopId?: string;
  /** Hop task ids a stop aborted, exactly as `manage stop` names child turns. */
  stoppedHopTaskIds?: string[];
  surface?: FoldDecisionSurface;
  decisionId?: string;
  browserId?: string;
  missingSpaceIds?: string[];
  requestId?: string;
}

export interface WorkFoldRoutingOpenRun {
  routingId: string;
  runId: string;
  title?: string;
  openHopIds: string[];
}

export type WorkFoldRoutingStoreErrorCode =
  | "STORE_DAMAGED"
  | "JOURNAL_UNAVAILABLE"
  | "JOURNAL_DAMAGED"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "BOUND_EXCEEDED"
  | "HEALTH_INVALID"
  | "DIGEST_MISMATCH";

export class WorkFoldRoutingStoreError extends Error {
  readonly code: WorkFoldRoutingStoreErrorCode;
  /** The health a refused transition found, when one exists. */
  readonly health?: WorkFoldRoutingHealth;

  constructor(
    code: WorkFoldRoutingStoreErrorCode,
    message: string,
    options: { health?: WorkFoldRoutingHealth; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkFoldRoutingStoreError";
    this.code = code;
    if (options.health !== undefined) this.health = options.health;
  }
}

export interface WorkFoldRoutingReceiptsOptions {
  path?: string;
  rotatedPath?: string;
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Durable, append-only journal of routing lifecycle, runs, and hops on the
 * act-receipts discipline (src/local/cli/act-receipts.ts): a run's `accepted`
 * line is written BEFORE hop 1 executes and an unwritable journal refuses the
 * run; terminal appends stay best-effort because an applied mutation must not
 * be failed retroactively. Rotation never runs while the live file still
 * holds a run without a terminal record — the startup recovery scan must
 * always be able to find an interrupted run's `accepted` line.
 */
export class WorkFoldRoutingReceipts {
  readonly path: string;
  readonly rotatedPath: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkFoldRoutingReceiptsOptions = {}) {
    this.path = options.path ? resolve(options.path) : workFoldRoutingReceiptsFile();
    this.rotatedPath = options.rotatedPath
      ? resolve(options.rotatedPath)
      : options.path
        ? `${resolve(options.path)}.1`
        : workFoldRoutingReceiptsRotatedFile();
    this.#maxBytes = options.maxBytes ?? WORKFOLD_ROUTING_RECEIPTS_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** Serialized best-effort append; resolves false when the receipt could not be written. */
  append(entry: Omit<WorkFoldRoutingReceiptV1, "v" | "at">): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      try {
        const record: WorkFoldRoutingReceiptV1 = {
          v: 1,
          at: this.#now().toISOString(),
          ...entry,
          ...(entry.title !== undefined ? { title: scrubText(entry.title) } : {}),
          ...(entry.detail !== undefined ? { detail: scrubText(entry.detail) } : {}),
        };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await this.#rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
        return true;
      } catch {
        return false;
      }
    });
    this.#queue = operation;
    return operation;
  }

  /**
   * Runs whose `accepted` record has no terminal record, with their open
   * hops, across the rotated and live files. The scan fails closed: a line
   * that cannot be parsed makes honest crash recovery impossible, so the
   * caller refuses to arm anything instead of guessing.
   */
  scanOpenRuns(): Promise<WorkFoldRoutingOpenRun[]> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const open = new Map<string, { routingId: string; title?: string; openHopIds: Set<string> }>();
      for (const path of [this.rotatedPath, this.path]) {
        const text = await readFile(path, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new WorkFoldRoutingStoreError(
            "JOURNAL_DAMAGED",
            "work-fold could not read the routing receipts journal, so crash recovery cannot be trusted.",
            { cause: error },
          );
        });
        if (text === null) continue;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let record: Partial<WorkFoldRoutingReceiptV1>;
          try {
            record = JSON.parse(line) as Partial<WorkFoldRoutingReceiptV1>;
          } catch (error) {
            throw new WorkFoldRoutingStoreError(
              "JOURNAL_DAMAGED",
              "The routing receipts journal holds an unreadable line, so crash recovery cannot be trusted.",
              { cause: error },
            );
          }
          if (record.scope !== "run" && record.scope !== "hop") continue;
          if (typeof record.runId !== "string" || typeof record.routingId !== "string") continue;
          if (record.scope === "run") {
            if (record.outcome === "accepted") {
              open.set(record.runId, {
                routingId: record.routingId,
                ...(typeof record.title === "string" ? { title: record.title } : {}),
                openHopIds: new Set(),
              });
            } else {
              open.delete(record.runId);
            }
            continue;
          }
          const run = open.get(record.runId);
          if (!run || typeof record.hopId !== "string") continue;
          if (record.outcome === "accepted") run.openHopIds.add(record.hopId);
          else run.openHopIds.delete(record.hopId);
        }
      }
      return [...open.entries()].map(([runId, run]) => ({
        routingId: run.routingId,
        runId,
        ...(run.title !== undefined ? { title: run.title } : {}),
        openHopIds: [...run.openHopIds],
      }));
    });
    this.#queue = operation;
    return operation as Promise<WorkFoldRoutingOpenRun[]>;
  }

  async #rotateIfNeeded(): Promise<void> {
    const info = await stat(this.path).catch(() => null);
    if (!info || info.size <= this.#maxBytes) return;
    // Never rotate away an open run's `accepted` line: the recovery scan
    // reads only the live and one rotated file, and rotation discards the
    // previous rotated file. While a run is open — or the file cannot prove
    // it is not — the journal temporarily overgrows instead.
    if (await this.#liveFileHasOpenRun()) return;
    await rm(this.rotatedPath, { force: true });
    await rename(this.path, this.rotatedPath);
  }

  async #liveFileHasOpenRun(): Promise<boolean> {
    const text = await readFile(this.path, "utf8").catch(() => null);
    if (text === null) return false;
    const open = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: Partial<WorkFoldRoutingReceiptV1>;
      try {
        record = JSON.parse(line) as Partial<WorkFoldRoutingReceiptV1>;
      } catch {
        return true;
      }
      if (record.scope !== "run" || typeof record.runId !== "string") continue;
      if (record.outcome === "accepted") open.add(record.runId);
      else open.delete(record.runId);
    }
    return open.size > 0;
  }
}

/**
 * One enablement consecration over one exact declaration digest. Grants are
 * history, never destroyed by disable or suspension; only the newest grant on
 * an `enabled` record is live authority.
 */
export interface WorkFoldRoutingGrant {
  digest: string;
  decisionId: string;
  approvedAt: string;
  surface: FoldDecisionSurface;
  browserId?: string;
  browserGrantId?: string;
}

export interface WorkFoldRoutingSuspension {
  at: string;
  /** Every referenced Space whose removal revoked this routing's grant. */
  missingSpaceIds: string[];
  /**
   * Missing Spaces later re-registered with preserved portable identity.
   * Copy-level detail only: the routing stays suspended either way, and
   * leaving suspension is always a fresh consecration.
   */
  reRegisteredSpaceIds: string[];
}

export interface WorkFoldRoutingRecord {
  declaration: WorkFoldRoutingDeclaration;
  digest: string;
  health: WorkFoldRoutingHealth;
  grants: WorkFoldRoutingGrant[];
  /** Durable cadence anchor for interval triggers; restarts resume, never reset. */
  lastScheduledAt?: string;
  disabledAt?: string;
  suspension?: WorkFoldRoutingSuspension;
}

export interface WorkFoldRoutingEnableInput {
  declaration: unknown;
  /**
   * The digest the person reviewed and approved. Enablement is exact
   * authority: a declaration that does not hash to this digest is refused.
   */
  expectedDigest: string;
  decision: {
    decisionId: string;
    surface: FoldDecisionSurface;
    browserId?: string;
    browserGrantId?: string;
  };
  now?: Date;
}

export interface WorkFoldRoutingSuspendResult {
  /** Enabled routings this removal revoked into suspension. */
  suspended: WorkFoldRoutingRecord[];
  /** Already-suspended routings that gained this missing Space id. */
  noted: WorkFoldRoutingRecord[];
}

export interface WorkFoldRoutingStoreStatus {
  damaged: boolean;
  damageReason?: string;
  routingCount: number;
  enabledCount: number;
}

export interface WorkFoldRoutingStoreOptions {
  /** Defaults to `routings/routings.json` under the work-fold state root. */
  path?: string;
  receipts?: WorkFoldRoutingReceipts;
  now?: () => Date;
}

interface RoutingStoreFileShape {
  schemaVersion: typeof WORKFOLD_ROUTING_STORE_SCHEMA_VERSION;
  routings: WorkFoldRoutingRecord[];
}

/**
 * The machine-local routing store. It follows the staged-act store's
 * disciplines (src/local/fold-staged-acts.ts): schema-versioned, normalized
 * fail-closed on read, atomic temp-file-and-rename writes with 0600 modes,
 * serialized mutations, and a damaged file that disables the store rather
 * than being guessed at or overwritten.
 *
 * Journaling is asymmetric on purpose, failing toward less authority:
 * widening (enable) and destruction of the audit anchor (delete) are strictly
 * journal-first — an unwritable journal refuses them — while narrowing
 * (disable, Space-removal suspension) persists even when its journal line
 * cannot be written, because revocation must never be blocked by a full disk.
 */
export class WorkFoldRoutingStore {
  readonly path: string;
  readonly receipts: WorkFoldRoutingReceipts;
  readonly #now: () => Date;
  readonly #damageReason: string | null;
  #file: RoutingStoreFileShape;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    path: string,
    receipts: WorkFoldRoutingReceipts,
    now: () => Date,
    file: RoutingStoreFileShape,
    damageReason: string | null,
  ) {
    this.path = path;
    this.receipts = receipts;
    this.#now = now;
    this.#file = file;
    this.#damageReason = damageReason;
  }

  static async create(options: WorkFoldRoutingStoreOptions = {}): Promise<WorkFoldRoutingStore> {
    const path = resolve(options.path ?? workFoldRoutingStateFile());
    const now = options.now ?? (() => new Date());
    const receipts = options.receipts ?? new WorkFoldRoutingReceipts({ now });
    const loaded = await loadRoutingStoreFile(path);
    return new WorkFoldRoutingStore(path, receipts, now, loaded.file, loaded.damageReason);
  }

  status(): WorkFoldRoutingStoreStatus {
    if (this.#damageReason !== null) {
      return { damaged: true, damageReason: this.#damageReason, routingCount: 0, enabledCount: 0 };
    }
    return {
      damaged: false,
      routingCount: this.#file.routings.length,
      enabledCount: this.#file.routings.filter((routing) => routing.health === "enabled").length,
    };
  }

  async list(): Promise<WorkFoldRoutingRecord[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      return this.#file.routings
        .map((routing) => structuredClone(routing))
        .sort((left, right) => compareStrings(left.declaration.id, right.declaration.id));
    });
  }

  async get(routingId: string): Promise<WorkFoldRoutingRecord | undefined> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const routing = this.#file.routings.find((candidate) => candidate.declaration.id === routingId);
      return routing ? structuredClone(routing) : undefined;
    });
  }

  /**
   * Commits a consecrated enablement: the declaration write and the grant
   * commit are one logical operation (one atomic state write), so a failure
   * leaves prior state intact — never undeclared or digest-mismatched
   * authority. Re-enabling an existing routing id records a fresh grant; the
   * 32-routing machine bound applies to new ids at exactly this door.
   */
  async enable(input: WorkFoldRoutingEnableInput): Promise<WorkFoldRoutingRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const declaration = normalizeDeclarationInput(input.declaration);
      const digest = workFoldRoutingDigest(declaration);
      if (typeof input.expectedDigest !== "string" || input.expectedDigest !== digest) {
        throw new WorkFoldRoutingStoreError(
          "DIGEST_MISMATCH",
          "This declaration does not match the reviewed digest; an edited routing never coasts on a stale approval.",
        );
      }
      const decision = normalizeDecision(input.decision);
      const now = (input.now ?? this.#now()).toISOString();
      const draft = structuredClone(this.#file);
      const existing = draft.routings.find((candidate) => candidate.declaration.id === declaration.id);
      if (!existing && draft.routings.length >= workFoldRoutingBounds.maxRoutingsPerMachine) {
        throw new WorkFoldRoutingStoreError(
          "BOUND_EXCEEDED",
          `This machine already holds ${workFoldRoutingBounds.maxRoutingsPerMachine} routings; delete one before enabling another. Routings are glue, not a job system.`,
        );
      }
      const grant: WorkFoldRoutingGrant = { digest, approvedAt: now, ...decision };
      const record: WorkFoldRoutingRecord = {
        declaration,
        digest,
        health: "enabled",
        grants: [...(existing?.grants ?? []), grant].slice(-WORKFOLD_ROUTING_GRANT_HISTORY_LIMIT),
        // A fresh consecration starts a fresh cadence: the first scheduled
        // slot is one interval after enablement, as restricted-app
        // automations anchor at enable time.
        ...(declaration.trigger.kind === "interval" ? { lastScheduledAt: now } : {}),
      };
      await this.#journalStrict({
        scope: "routing",
        outcome: "enabled",
        routingId: declaration.id,
        digest,
        title: declaration.title,
        surface: decision.surface,
        decisionId: decision.decisionId,
        ...(decision.browserId !== undefined ? { browserId: decision.browserId } : {}),
        ...(existing ? { detail: `Re-enabled from ${existing.health}; a fresh consecration replaced the prior grant.` } : {}),
      });
      draft.routings = [...draft.routings.filter((candidate) => candidate.declaration.id !== declaration.id), record];
      await this.#commit(draft);
      return structuredClone(record);
    });
  }

  /**
   * Narrows an enabled routing to disabled. The disabled intent persists
   * first — startup refuses to arm a disabled routing — and the caller stops
   * runs and cancels admissions after this returns. Never destroys the
   * declaration, grant history, or receipts.
   */
  async disable(routingId: string): Promise<WorkFoldRoutingRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const draft = structuredClone(this.#file);
      const routing = this.#requireRouting(draft, routingId);
      if (routing.health !== "enabled") {
        throw new WorkFoldRoutingStoreError(
          "HEALTH_INVALID",
          routing.health === "disabled"
            ? "This routing is already disabled."
            : "This routing is suspended because a referenced Space was removed; there is no enablement left to disable, and leaving suspension is a fresh consecration.",
          { health: routing.health },
        );
      }
      routing.health = "disabled";
      routing.disabledAt = this.#now().toISOString();
      await this.#journalBestEffort({
        scope: "routing",
        outcome: "disabled",
        routingId,
        digest: routing.digest,
      });
      await this.#commit(draft);
      return structuredClone(routing);
    });
  }

  /**
   * Space-removal revocation: every enabled routing referencing the removed
   * Space loses its grant and enters durable `suspended` health with the
   * missing Space id recorded. A suspended routing never runs, never
   * retargets, and never resumes automatically — re-registration is noted in
   * copy only, and leaving suspension is a fresh consecration.
   */
  async suspendForSpaceRemoval(spaceId: string, now?: Date): Promise<WorkFoldRoutingSuspendResult> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const removedAt = (now ?? this.#now()).toISOString();
      requireReference(spaceId, "Space id");
      const draft = structuredClone(this.#file);
      const suspended: WorkFoldRoutingRecord[] = [];
      const noted: WorkFoldRoutingRecord[] = [];
      for (const routing of draft.routings) {
        if (!workFoldRoutingReferencedSpaceIds(routing.declaration).includes(spaceId)) continue;
        if (routing.health === "enabled") {
          routing.health = "suspended";
          routing.suspension = { at: removedAt, missingSpaceIds: [spaceId], reRegisteredSpaceIds: [] };
          delete routing.lastScheduledAt;
          suspended.push(routing);
          await this.#journalBestEffort({
            scope: "routing",
            outcome: "suspended",
            routingId: routing.declaration.id,
            digest: routing.digest,
            missingSpaceIds: [spaceId],
            detail: "A referenced Space was removed; the enablement grant is revoked and re-enablement is a fresh consecration.",
          });
          continue;
        }
        if (routing.health === "suspended" && routing.suspension && !routing.suspension.missingSpaceIds.includes(spaceId)) {
          routing.suspension.missingSpaceIds = [...routing.suspension.missingSpaceIds, spaceId].sort();
          noted.push(routing);
          await this.#journalBestEffort({
            scope: "routing",
            outcome: "suspended",
            routingId: routing.declaration.id,
            digest: routing.digest,
            missingSpaceIds: routing.suspension.missingSpaceIds,
            detail: "Another referenced Space was removed while this routing was already suspended.",
          });
        }
      }
      if (suspended.length || noted.length) await this.#commit(draft);
      return {
        suspended: suspended.map((routing) => structuredClone(routing)),
        noted: noted.map((routing) => structuredClone(routing)),
      };
    });
  }

  /**
   * Copy-level detail when a missing Space's portable identity is
   * re-registered: the person sees "re-registered" rather than "removed",
   * and nothing else changes — registration must never silently re-arm
   * standing behavior.
   */
  async noteSpaceReRegistered(spaceId: string): Promise<WorkFoldRoutingRecord[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      requireReference(spaceId, "Space id");
      const draft = structuredClone(this.#file);
      const affected: WorkFoldRoutingRecord[] = [];
      for (const routing of draft.routings) {
        if (routing.health !== "suspended" || !routing.suspension) continue;
        if (!routing.suspension.missingSpaceIds.includes(spaceId)) continue;
        if (routing.suspension.reRegisteredSpaceIds.includes(spaceId)) continue;
        routing.suspension.reRegisteredSpaceIds = [...routing.suspension.reRegisteredSpaceIds, spaceId].sort();
        affected.push(routing);
        await this.#journalBestEffort({
          scope: "routing",
          outcome: "re-registered",
          routingId: routing.declaration.id,
          digest: routing.digest,
          missingSpaceIds: [spaceId],
          detail: "The missing Space was re-registered with preserved identity. The routing stays suspended; re-enablement is a fresh consecration.",
        });
      }
      if (affected.length) await this.#commit(draft);
      return affected.map((routing) => structuredClone(routing));
    });
  }

  /** Persists the durable cadence anchor after a scheduled or resume run. */
  async recordCadence(routingId: string, lastScheduledAt: string): Promise<boolean> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      if (typeof lastScheduledAt !== "string" || !Number.isFinite(Date.parse(lastScheduledAt))) {
        throw new WorkFoldRoutingStoreError("INPUT_INVALID", "A cadence anchor must be an ISO timestamp.");
      }
      const draft = structuredClone(this.#file);
      const routing = draft.routings.find((candidate) => candidate.declaration.id === routingId);
      if (!routing || routing.health !== "enabled") return false;
      routing.lastScheduledAt = new Date(lastScheduledAt).toISOString();
      await this.#commit(draft);
      return true;
    });
  }

  /**
   * Removes a disabled or suspended routing's declaration, grant history,
   * and cadence anchor. The receipts journal is retained — audit records
   * survive the object — which is why deletion is strictly journal-first.
   */
  async delete(routingId: string): Promise<WorkFoldRoutingRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const draft = structuredClone(this.#file);
      const routing = this.#requireRouting(draft, routingId);
      if (routing.health === "enabled") {
        throw new WorkFoldRoutingStoreError(
          "HEALTH_INVALID",
          "This routing is enabled; disable it before deleting it so revocation stops stale work first.",
          { health: routing.health },
        );
      }
      await this.#journalStrict({
        scope: "routing",
        outcome: "deleted",
        routingId,
        digest: routing.digest,
        detail: `Deleted from ${routing.health}. Receipts are retained; audit records survive the object.`,
      });
      draft.routings = draft.routings.filter((candidate) => candidate.declaration.id !== routingId);
      await this.#commit(draft);
      return structuredClone(routing);
    });
  }

  #requireRouting(draft: RoutingStoreFileShape, routingId: string): WorkFoldRoutingRecord {
    const routing = draft.routings.find((candidate) => candidate.declaration.id === routingId);
    if (!routing) {
      throw new WorkFoldRoutingStoreError(
        "NOT_FOUND",
        "No routing has this id. A proposal holds no authority until its enablement is consecrated.",
      );
    }
    return routing;
  }

  async #journalStrict(entry: Omit<WorkFoldRoutingReceiptV1, "v" | "at">): Promise<void> {
    if (await this.receipts.append(entry)) return;
    throw new WorkFoldRoutingStoreError(
      "JOURNAL_UNAVAILABLE",
      "work-fold could not journal this routing mutation, so nothing was changed.",
    );
  }

  async #journalBestEffort(entry: Omit<WorkFoldRoutingReceiptV1, "v" | "at">): Promise<void> {
    // Narrowing proceeds even when its journal line cannot be written: the
    // durable state file is the authority record, and failing toward less
    // authority is the safe direction.
    await this.receipts.append(entry);
  }

  #assertOperational(): void {
    if (this.#damageReason === null) return;
    throw new WorkFoldRoutingStoreError(
      "STORE_DAMAGED",
      `work-fold disabled routings: ${this.#damageReason} Nothing is guessed from damaged authority state.`,
    );
  }

  async #commit(draft: RoutingStoreFileShape): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.path);
    this.#file = draft;
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function normalizeDeclarationInput(value: unknown): WorkFoldRoutingDeclaration {
  try {
    return normalizeWorkFoldRoutingDeclaration(value);
  } catch (error) {
    throw new WorkFoldRoutingStoreError(
      "INPUT_INVALID",
      `work-fold refused this routing declaration: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function normalizeDecision(value: WorkFoldRoutingEnableInput["decision"]): WorkFoldRoutingEnableInput["decision"] {
  if (!value || typeof value !== "object") {
    throw new WorkFoldRoutingStoreError("INPUT_INVALID", "An enablement requires its consecration decision record.");
  }
  requireReference(value.decisionId, "Decision id");
  if (!FOLD_DECISION_SURFACES.includes(value.surface)) {
    throw new WorkFoldRoutingStoreError("INPUT_INVALID", "The approving surface must be a decision surface.");
  }
  if (value.surface === "policy") {
    throw new WorkFoldRoutingStoreError(
      "INPUT_INVALID",
      "routing.enable is not policy-eligible: standing cross-Space behavior always takes the unforgeable human click.",
    );
  }
  if (value.surface === "remote_web") {
    requireReference(value.browserId, "Approving browser id");
    requireReference(value.browserGrantId, "Approving browser grant id");
  } else if (value.browserId !== undefined || value.browserGrantId !== undefined) {
    throw new WorkFoldRoutingStoreError("INPUT_INVALID", "Browser identity belongs only to remote decisions.");
  }
  return {
    decisionId: value.decisionId,
    surface: value.surface,
    ...(value.browserId !== undefined ? { browserId: value.browserId } : {}),
    ...(value.browserGrantId !== undefined ? { browserGrantId: value.browserGrantId } : {}),
  };
}

function requireReference(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumTextLength || forbiddenTextPattern.test(value)) {
    throw new WorkFoldRoutingStoreError("INPUT_INVALID", `${label} is required and must be plain text.`);
  }
}

function scrubText(value: string): string {
  return value.replace(scrubReplacePattern, "�").slice(0, maximumTextLength);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyFile(): RoutingStoreFileShape {
  return { schemaVersion: WORKFOLD_ROUTING_STORE_SCHEMA_VERSION, routings: [] };
}

async function loadRoutingStoreFile(
  path: string,
): Promise<{ file: RoutingStoreFileShape; damageReason: string | null }> {
  const damaged = (reason: string) => ({
    file: emptyFile(),
    damageReason: `The routing store at ${path} ${reason}.`,
  });
  let text: string;
  try {
    const info = await stat(path);
    if (info.size > maximumStateBytes) return damaged("is oversized");
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return damaged("is not a routing record");
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => key !== "schemaVersion" && key !== "routings");
  if (unknown) return damaged(`carries the unknown field ${unknown}`);
  if (record.schemaVersion !== WORKFOLD_ROUTING_STORE_SCHEMA_VERSION) {
    return typeof record.schemaVersion === "number" && record.schemaVersion > WORKFOLD_ROUTING_STORE_SCHEMA_VERSION
      ? damaged(`was written by a newer work-fold (schema version ${record.schemaVersion})`)
      : damaged(`uses the unsupported schema version ${String(record.schemaVersion)}`);
  }
  if (!Array.isArray(record.routings)) return damaged("does not list its routings");
  if (record.routings.length > workFoldRoutingBounds.maxRoutingsPerMachine) {
    return damaged(`holds more than ${workFoldRoutingBounds.maxRoutingsPerMachine} routings`);
  }
  const routings: WorkFoldRoutingRecord[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of record.routings.entries()) {
    const issue = routingRecordIssue(candidate);
    if (issue) return damaged(`holds an invalid routing at index ${index}: ${issue}`);
    const routing = candidate as WorkFoldRoutingRecord;
    if (ids.has(routing.declaration.id)) return damaged(`holds the duplicate routing id ${routing.declaration.id}`);
    ids.add(routing.declaration.id);
    routings.push(structuredClone(routing));
  }
  return { file: { schemaVersion: WORKFOLD_ROUTING_STORE_SCHEMA_VERSION, routings }, damageReason: null };
}

const ROUTING_RECORD_KEYS = ["declaration", "digest", "health", "grants", "lastScheduledAt", "disabledAt", "suspension"];
const GRANT_KEYS = ["digest", "decisionId", "approvedAt", "surface", "browserId", "browserGrantId"];
const SUSPENSION_KEYS = ["at", "missingSpaceIds", "reRegisteredSpaceIds"];

function routingRecordIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a routing record must be an object";
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !ROUTING_RECORD_KEYS.includes(key));
  if (unknown) return `${unknown} is not part of the routing record contract`;
  let declaration: WorkFoldRoutingDeclaration;
  try {
    declaration = normalizeWorkFoldRoutingDeclaration(record.declaration);
  } catch (error) {
    return `its declaration is invalid (${error instanceof Error ? error.message : String(error)})`;
  }
  // Recompute rather than trust: a digest that does not match its declaration
  // is digest-mismatched authority, which must never load.
  if (record.digest !== workFoldRoutingDigest(declaration)) return "its digest does not match its declaration";
  if (record.health !== "enabled" && record.health !== "disabled" && record.health !== "suspended") {
    return "its health state is unknown";
  }
  if (!Array.isArray(record.grants) || record.grants.length < 1 || record.grants.length > WORKFOLD_ROUTING_GRANT_HISTORY_LIMIT) {
    return "its grant history is missing or oversized";
  }
  for (const grant of record.grants) {
    const issue = grantIssue(grant);
    if (issue) return issue;
  }
  const newest = record.grants[record.grants.length - 1] as WorkFoldRoutingGrant;
  if (record.health === "enabled" && newest.digest !== record.digest) {
    return "its live grant does not pin its declaration digest";
  }
  if (record.lastScheduledAt !== undefined && !isTimestamp(record.lastScheduledAt)) return "its cadence anchor is invalid";
  if (record.disabledAt !== undefined && !isTimestamp(record.disabledAt)) return "its disabledAt is invalid";
  if ((record.health === "suspended") !== (record.suspension !== undefined)) {
    return "suspension detail and suspended health must appear together";
  }
  if (record.suspension !== undefined) {
    const issue = suspensionIssue(record.suspension, workFoldRoutingReferencedSpaceIds(declaration));
    if (issue) return issue;
  }
  return null;
}

function grantIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a grant must be an object";
  const grant = value as Record<string, unknown>;
  const unknown = Object.keys(grant).find((key) => !GRANT_KEYS.includes(key));
  if (unknown) return `grant field ${unknown} is not part of the grant contract`;
  if (typeof grant.digest !== "string" || !/^[a-f0-9]{64}$/.test(grant.digest)) return "a grant digest is invalid";
  if (typeof grant.decisionId !== "string" || !grant.decisionId.trim()) return "a grant decision id is invalid";
  if (!isTimestamp(grant.approvedAt)) return "a grant approvedAt is invalid";
  if (!FOLD_DECISION_SURFACES.includes(grant.surface as FoldDecisionSurface) || grant.surface === "policy") {
    return "a grant surface is invalid";
  }
  if ((grant.surface === "remote_web") !== (typeof grant.browserId === "string" && typeof grant.browserGrantId === "string")) {
    return "a grant's browser identity must accompany exactly the remote surface";
  }
  return null;
}

function suspensionIssue(value: unknown, referencedSpaceIds: string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "suspension detail must be an object";
  const suspension = value as Record<string, unknown>;
  const unknown = Object.keys(suspension).find((key) => !SUSPENSION_KEYS.includes(key));
  if (unknown) return `suspension field ${unknown} is not part of the suspension contract`;
  if (!isTimestamp(suspension.at)) return "the suspension timestamp is invalid";
  for (const key of ["missingSpaceIds", "reRegisteredSpaceIds"] as const) {
    const list = suspension[key];
    if (!Array.isArray(list) || (key === "missingSpaceIds" && list.length < 1) || list.length > 64) {
      return `suspension ${key} is invalid`;
    }
    for (const id of list) {
      if (typeof id !== "string" || !id.trim()) return `suspension ${key} holds an invalid Space id`;
    }
  }
  const missing = suspension.missingSpaceIds as string[];
  const reRegistered = suspension.reRegisteredSpaceIds as string[];
  if (!missing.every((id) => referencedSpaceIds.includes(id))) {
    return "suspension names a Space the declaration never references";
  }
  if (!reRegistered.every((id) => missing.includes(id))) {
    return "suspension notes a re-registered Space it never recorded as missing";
  }
  return null;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
