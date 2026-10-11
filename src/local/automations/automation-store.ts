import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  WORKFOLD_CLI_ACT_LEGACY_SURFACES,
  WORKFOLD_CLI_ACT_SURFACES,
  type WorkFoldCliActLegacySurface,
  type WorkFoldCliActSurface,
} from "../cli/act-receipts.js";
import { workFoldStateRoot } from "../state-paths.js";
import {
  assertWorkFoldAutomationAtAdmissionHorizon,
  normalizeWorkFoldAutomationDeclaration,
  scrubWorkFoldAutomationMessageText,
  workFoldAutomationBounds,
  workFoldAutomationDigest,
  workFoldAutomationReferencedWorkFolderIds,
  type WorkFoldAutomationDeclaration,
} from "./automation-declarations.js";

/**
 * Machine-local automation authority and its receipts journal
 * (docs/automations.md). Everything here is application state that
 * references multiple work-folders and must never travel with any folder: the
 * enabled declarations, their exact-digest enablement grants, cadence
 * anchors, health states, and the append-only run/hop receipts. A file
 * claiming to be automation state is inert bytes anywhere else — authority
 * exists only in this store, and only over the exact digest the enabling
 * receipt pinned.
 */
export const WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION = 3;

export const WORKFOLD_AUTOMATION_RECEIPTS_MAX_BYTES = 16 * 1024 * 1024;

/** Bounded per-automation enablement history; every re-enablement with a changed declaration is a fresh receipt. */
export const WORKFOLD_AUTOMATION_GRANT_HISTORY_LIMIT = 16;

const maximumStateBytes = 512 * 1024 * 1024;
const maximumTextLength = 2_000;
const forbiddenTextPattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const scrubReplacePattern = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** The automation state file: enabled declarations, grants, anchors, health. */
export function workFoldAutomationStateFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "automations", "automations.json");
}

/**
 * The automation receipts journal. The path is a cross-module contract: the
 * overview's tolerant reader (src/local/overview.ts) consumes exactly this file
 * and its rotated sibling.
 */
export function workFoldAutomationReceiptsFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "automations", "receipts.jsonl");
}

export function workFoldAutomationReceiptsRotatedFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "automations", "receipts.1.jsonl");
}

export type WorkFoldAutomationHealth = "enabled" | "disabled" | "suspended" | "completed";

/** Terminal and progress outcomes for run- and hop-scoped receipt records. */
export type WorkFoldAutomationRunReceiptOutcome =
  | "accepted"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"
  | "skipped";

/** Store lifecycle outcomes for automation-scoped receipt records. */
export type WorkFoldAutomationLifecycleReceiptOutcome =
  | "enabled"
  | "disabled"
  | "suspended"
  | "re-registered"
  | "completed"
  | "deleted";

export type WorkFoldAutomationReceiptScope = "automation" | "run" | "hop";

/** Why a run was admitted; the terminal record names the trigger cause exactly. */
export type WorkFoldAutomationRunCause =
  | { kind: "scheduled" | "resume"; slotAt: string }
  | {
      kind: "files-changed";
      workFolderId: string;
      snapshotDigest: string;
      changedCount: number;
      /** The first `maxChangedPathsRecorded` changed paths, sorted; `changedCount` keeps the true total. */
      changedPaths?: string[];
    }
  | { kind: "run-now"; requestId?: string; surface?: WorkFoldCliActSurface }
  | {
      kind: "on-settled";
      source:
        | { kind: "check-run"; workFolderId: string; runId: string; state: string; checkIds: string[]; taskId?: string }
        | { kind: "app-automation-run"; workFolderId: string; appId: string; appAutomationId: string; runId: string; outcome: string };
    };

/**
 * One journal line. Lines are written at version 1 and read tolerantly:
 * unknown fields are ignored by readers (the overview destructures only what it
 * knows), and every text field is scrubbed before it is written. Receipts
 * carry identifiers, digests, paths, and counts — never file contents or
 * secrets. The one bounded exception is `placeholders`: the text work-fold
 * itself filled into a chat- or agent-step message, so a person can see what
 * the automation actually said. The message the step declared is in the
 * declaration; the whole sent message lives in the conversation named by
 * `conversationId`.
 */
export interface WorkFoldAutomationReceiptV1 {
  v: 1;
  at: string;
  scope: WorkFoldAutomationReceiptScope;
  outcome: WorkFoldAutomationRunReceiptOutcome | WorkFoldAutomationLifecycleReceiptOutcome;
  automationId: string;
  /** Present on every run- and hop-scoped record; absent on lifecycle records. */
  runId?: string;
  hopId?: string;
  hopKind?: "chat" | "files" | "check" | "agent";
  title?: string;
  digest?: string;
  cause?: WorkFoldAutomationRunCause;
  detail?: string;
  workFolderId?: string;
  fromWorkFolderId?: string;
  toWorkFolderId?: string;
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
  /** Hop task ids a stop aborted, exactly as `agent stop` names child turns. */
  stoppedHopTaskIds?: string[];
  /** What work-fold filled into this hop's message, bounded per placeholder. */
  placeholders?: WorkFoldAutomationReceiptPlaceholder[];
  /** Byte length of the message the hop actually sent. */
  messageBytes?: number;
  surface?: WorkFoldCliActSurface;
  /** Legacy field on receipts written before receipts-not-gates; never written now. */
  decisionId?: string;
  browserId?: string;
  missingWorkFolderIds?: string[];
  requestId?: string;
  occurrenceId?: string;
  scheduledRunId?: string;
}

/** One filled-in placeholder, as the hop's terminal receipt records it. */
export interface WorkFoldAutomationReceiptPlaceholder {
  name: string;
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface WorkFoldAutomationOpenRun {
  automationId: string;
  runId: string;
  title?: string;
  digest?: string;
  cause?: Extract<WorkFoldAutomationRunCause, { kind: "scheduled" | "resume" }>;
  openHopIds: string[];
}

export type WorkFoldAutomationStoreErrorCode =
  | "STORE_DAMAGED"
  | "JOURNAL_UNAVAILABLE"
  | "JOURNAL_DAMAGED"
  | "INPUT_INVALID"
  | "NOT_FOUND"
  | "BOUND_EXCEEDED"
  | "HEALTH_INVALID"
  | "DIGEST_MISMATCH";

export class WorkFoldAutomationStoreError extends Error {
  readonly code: WorkFoldAutomationStoreErrorCode;
  /** The health a refused transition found, when one exists. */
  readonly health?: WorkFoldAutomationHealth;

  constructor(
    code: WorkFoldAutomationStoreErrorCode,
    message: string,
    options: { health?: WorkFoldAutomationHealth; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkFoldAutomationStoreError";
    this.code = code;
    if (options.health !== undefined) this.health = options.health;
  }
}

export interface WorkFoldAutomationReceiptsOptions {
  path?: string;
  rotatedPath?: string;
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Durable, append-only journal of automation lifecycle, runs, and hops on the
 * act-receipts discipline (src/local/cli/act-receipts.ts): a run's `accepted`
 * line is written BEFORE hop 1 executes and an unwritable journal refuses the
 * run; terminal appends stay best-effort because an applied mutation must not
 * be failed retroactively. Rotation never runs while the live file still
 * holds a run without a terminal record — the startup recovery scan must
 * always be able to find an interrupted run's `accepted` line.
 */
export class WorkFoldAutomationReceipts {
  readonly path: string;
  readonly rotatedPath: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkFoldAutomationReceiptsOptions = {}) {
    this.path = options.path ? resolve(options.path) : workFoldAutomationReceiptsFile();
    this.rotatedPath = options.rotatedPath
      ? resolve(options.rotatedPath)
      : options.path
        ? `${resolve(options.path)}.1`
        : workFoldAutomationReceiptsRotatedFile();
    this.#maxBytes = options.maxBytes ?? WORKFOLD_AUTOMATION_RECEIPTS_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** Serialized best-effort append; resolves false when the receipt could not be written. */
  append(entry: Omit<WorkFoldAutomationReceiptV1, "v" | "at">): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      try {
        const record: WorkFoldAutomationReceiptV1 = {
          v: 1,
          at: this.#now().toISOString(),
          ...entry,
          ...(entry.title !== undefined ? { title: scrubText(entry.title) } : {}),
          ...(entry.detail !== undefined ? { detail: scrubText(entry.detail) } : {}),
          ...(entry.placeholders !== undefined
            ? { placeholders: entry.placeholders.map((placeholder) => ({
              ...placeholder,
              text: scrubPlaceholderText(placeholder.text),
            })) }
            : {}),
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
  scanOpenRuns(): Promise<WorkFoldAutomationOpenRun[]> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      const open = new Map<string, {
        automationId: string;
        title?: string;
        digest?: string;
        cause?: Extract<WorkFoldAutomationRunCause, { kind: "scheduled" | "resume" }>;
        openHopIds: Set<string>;
      }>();
      for (const path of [this.rotatedPath, this.path]) {
        const text = await readFile(path, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new WorkFoldAutomationStoreError(
            "JOURNAL_DAMAGED",
            "work-fold could not read the automation receipts journal, so crash recovery cannot be trusted.",
            { cause: error },
          );
        });
        if (text === null) continue;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let record: Partial<WorkFoldAutomationReceiptV1>;
          try {
            record = JSON.parse(line) as Partial<WorkFoldAutomationReceiptV1>;
          } catch (error) {
            throw new WorkFoldAutomationStoreError(
              "JOURNAL_DAMAGED",
              "The automation receipts journal holds an unreadable line, so crash recovery cannot be trusted.",
              { cause: error },
            );
          }
          if (record.scope !== "run" && record.scope !== "hop") continue;
          if (typeof record.runId !== "string" || typeof record.automationId !== "string") continue;
          if (record.scope === "run") {
            if (record.outcome === "accepted") {
              open.set(record.runId, {
                automationId: record.automationId,
                ...(typeof record.title === "string" ? { title: record.title } : {}),
                ...(typeof record.digest === "string" ? { digest: record.digest } : {}),
                ...(scheduledReceiptCause(record.cause) ? { cause: scheduledReceiptCause(record.cause) } : {}),
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
        automationId: run.automationId,
        runId,
        ...(run.title !== undefined ? { title: run.title } : {}),
        ...(run.digest !== undefined ? { digest: run.digest } : {}),
        ...(run.cause !== undefined ? { cause: run.cause } : {}),
        openHopIds: [...run.openHopIds],
      }));
    });
    this.#queue = operation;
    return operation as Promise<WorkFoldAutomationOpenRun[]>;
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
      let record: Partial<WorkFoldAutomationReceiptV1>;
      try {
        record = JSON.parse(line) as Partial<WorkFoldAutomationReceiptV1>;
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
 * One enablement receipt over one exact declaration digest. Grants are
 * history, never destroyed by disable or suspension; only the newest grant on
 * an `enabled` record is live authority.
 */
export interface WorkFoldAutomationGrant {
  digest: string;
  /** The enabling act's request id. */
  requestId: string;
  enabledAt: string;
  /** Current surfaces on write; a legacy surface an older build recorded still loads. */
  surface: WorkFoldCliActSurface | WorkFoldCliActLegacySurface;
  browserId?: string;
}

/** The grant shape builds before receipts-not-gates wrote; converted on load. */
interface LegacyWorkFoldAutomationGrant {
  digest: string;
  decisionId: string;
  approvedAt: string;
  surface: WorkFoldCliActSurface | WorkFoldCliActLegacySurface;
  browserId?: string;
  browserGrantId?: string;
}

export interface WorkFoldAutomationSuspension {
  at: string;
  /** Every referenced work-folder whose removal revoked this automation's grant. */
  missingWorkFolderIds: string[];
  /**
   * Missing work-folders later re-registered with preserved portable identity.
   * Copy-level detail only: the automation stays suspended either way, and
   * leaving suspension is always a fresh enablement.
   */
  reRegisteredWorkFolderIds: string[];
}

export interface WorkFoldAutomationRecord {
  declaration: WorkFoldAutomationDeclaration;
  digest: string;
  health: WorkFoldAutomationHealth;
  grants: WorkFoldAutomationGrant[];
  /** Durable cadence anchor for interval triggers; restarts resume, never reset. */
  lastScheduledAt?: string;
  disabledAt?: string;
  suspension?: WorkFoldAutomationSuspension;
  /** Durable single-fire claim for a version-2 one-time trigger. */
  atOccurrence?: {
    occurrenceId: string;
    slotAt: string;
    consumedAt: string;
    runId: string;
    finishedAt?: string;
  };
}

export interface WorkFoldAutomationActionReceiptContext {
  requestId?: string;
  surface?: WorkFoldCliActSurface;
}

export interface WorkFoldAutomationEnableInput {
  declaration: unknown;
  /**
   * The digest the enabling call pinned. Enablement is exact authority: a
   * declaration that does not hash to this digest is refused.
   */
  expectedDigest: string;
  grant: {
    requestId: string;
    surface: WorkFoldCliActSurface;
    browserId?: string;
  };
  now?: Date;
}

export interface WorkFoldAutomationSuspendResult {
  /** Enabled automations this removal revoked into suspension. */
  suspended: WorkFoldAutomationRecord[];
  /** Already-suspended automations that gained this missing work-folder id. */
  noted: WorkFoldAutomationRecord[];
}

export interface WorkFoldAutomationStoreStatus {
  damaged: boolean;
  damageReason?: string;
  automationCount: number;
  enabledCount: number;
}

export interface WorkFoldAutomationStoreOptions {
  /** Defaults to `automations/automations.json` under the work-fold state root. */
  path?: string;
  receipts?: WorkFoldAutomationReceipts;
  now?: () => Date;
}

interface AutomationStoreFileShape {
  schemaVersion: typeof WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION;
  automations: WorkFoldAutomationRecord[];
}

/**
 * The machine-local automation store. It follows the prepared-act disciplines
 * (src/local/prepared-acts.ts): schema-versioned, normalized
 * fail-closed on read, atomic temp-file-and-rename writes with 0600 modes,
 * serialized mutations, and a damaged file that disables the store rather
 * than being guessed at or overwritten.
 *
 * Journaling is asymmetric on purpose, failing toward less authority:
 * widening (enable) and destruction of the audit anchor (delete) are strictly
 * journal-first — an unwritable journal refuses them — while narrowing
 * (disable, work-folder-removal suspension) persists even when its journal line
 * cannot be written, because revocation must never be blocked by a full disk.
 */
export class WorkFoldAutomationStore {
  readonly path: string;
  readonly receipts: WorkFoldAutomationReceipts;
  readonly #now: () => Date;
  readonly #damageReason: string | null;
  #file: AutomationStoreFileShape;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    path: string,
    receipts: WorkFoldAutomationReceipts,
    now: () => Date,
    file: AutomationStoreFileShape,
    damageReason: string | null,
  ) {
    this.path = path;
    this.receipts = receipts;
    this.#now = now;
    this.#file = file;
    this.#damageReason = damageReason;
  }

  static async create(options: WorkFoldAutomationStoreOptions = {}): Promise<WorkFoldAutomationStore> {
    const path = resolve(options.path ?? workFoldAutomationStateFile());
    const now = options.now ?? (() => new Date());
    const receipts = options.receipts ?? new WorkFoldAutomationReceipts({ now });
    const loaded = await loadAutomationStoreFile(path);
    return new WorkFoldAutomationStore(path, receipts, now, loaded.file, loaded.damageReason);
  }

  status(): WorkFoldAutomationStoreStatus {
    if (this.#damageReason !== null) {
      return { damaged: true, damageReason: this.#damageReason, automationCount: 0, enabledCount: 0 };
    }
    return {
      damaged: false,
      automationCount: this.#file.automations.length,
      enabledCount: this.#file.automations.filter((automation) => automation.health === "enabled").length,
    };
  }

  async list(): Promise<WorkFoldAutomationRecord[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      return this.#file.automations
        .map((automation) => structuredClone(automation))
        .sort((left, right) => compareStrings(left.declaration.id, right.declaration.id));
    });
  }

  async get(automationId: string): Promise<WorkFoldAutomationRecord | undefined> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const automation = this.#file.automations.find((candidate) => candidate.declaration.id === automationId);
      return automation ? structuredClone(automation) : undefined;
    });
  }

  /**
   * Commits an enablement receipt: the declaration write and the grant commit
   * are one logical operation (one atomic state write), so a failure leaves
   * prior state intact — never undeclared or digest-mismatched authority.
   * Re-enabling an existing automation id records a fresh grant.
   */
  async enable(input: WorkFoldAutomationEnableInput): Promise<WorkFoldAutomationRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const declaration = normalizeDeclarationInput(input.declaration);
      const digest = workFoldAutomationDigest(declaration);
      if (typeof input.expectedDigest !== "string" || input.expectedDigest !== digest) {
        throw new WorkFoldAutomationStoreError(
          "DIGEST_MISMATCH",
          "This declaration does not match the digest the enabling call pinned; an edited automation never coasts on a stale enablement.",
        );
      }
      const grantRef = normalizeGrantInput(input.grant);
      const admissionTime = input.now ?? this.#now();
      try {
        assertWorkFoldAutomationAtAdmissionHorizon(declaration, admissionTime);
      } catch (error) {
        throw new WorkFoldAutomationStoreError(
          "INPUT_INVALID",
          `work-fold refused this automation declaration: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const now = admissionTime.toISOString();
      const draft = structuredClone(this.#file);
      const existing = draft.automations.find((candidate) => candidate.declaration.id === declaration.id);
      const grant: WorkFoldAutomationGrant = { digest, enabledAt: now, ...grantRef };
      const record: WorkFoldAutomationRecord = {
        declaration,
        digest,
        health: "enabled",
        grants: [...(existing?.grants ?? []), grant].slice(-WORKFOLD_AUTOMATION_GRANT_HISTORY_LIMIT),
        // A fresh enablement starts a fresh cadence: the first scheduled
        // slot is one interval after enablement, as restricted-app
        // automations anchor at enable time.
        ...(declaration.trigger.kind === "interval" ? { lastScheduledAt: now } : {}),
      };
      await this.#journalStrict({
        scope: "automation",
        outcome: "enabled",
        automationId: declaration.id,
        digest,
        title: declaration.title,
        surface: grantRef.surface,
        requestId: grantRef.requestId,
        ...(grantRef.browserId !== undefined ? { browserId: grantRef.browserId } : {}),
        ...(existing ? { detail: `Re-enabled from ${existing.health}; a fresh enablement replaced the prior grant.` } : {}),
      });
      draft.automations = [...draft.automations.filter((candidate) => candidate.declaration.id !== declaration.id), record];
      await this.#commit(draft);
      return structuredClone(record);
    });
  }

  /**
   * Narrows an enabled automation to disabled. The disabled intent persists
   * first — startup refuses to arm a disabled automation — and the caller stops
   * runs and cancels admissions after this returns. Never destroys the
   * declaration, grant history, or receipts.
   */
  async disable(
    automationId: string,
    receiptContext: WorkFoldAutomationActionReceiptContext = {},
  ): Promise<WorkFoldAutomationRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const action = normalizeActionReceiptContext(receiptContext);
      const draft = structuredClone(this.#file);
      const automation = this.#requireAutomation(draft, automationId);
      if (automation.health !== "enabled") {
        throw new WorkFoldAutomationStoreError(
          "HEALTH_INVALID",
          automation.health === "disabled"
            ? "This automation is already disabled."
            : automation.health === "completed"
              ? "This one-time automation is completed; its scheduled occurrence has already been consumed."
              : "This automation is suspended because a referenced work-folder was removed; there is no enablement left to disable, and leaving suspension is a fresh enablement.",
          { health: automation.health },
        );
      }
      automation.health = "disabled";
      automation.disabledAt = this.#now().toISOString();
      await this.#journalBestEffort({
        scope: "automation",
        outcome: "disabled",
        automationId,
        digest: automation.digest,
        ...action,
      });
      await this.#commit(draft);
      return structuredClone(automation);
    });
  }

  /**
   * work-folder-removal revocation: every enabled automation referencing the removed
   * work-folder loses its grant and enters durable `suspended` health with the
   * missing work-folder id recorded. A suspended automation never runs, never
   * retargets, and never resumes automatically — re-registration is noted in
   * copy only, and leaving suspension is a fresh enablement.
   */
  async suspendForWorkFolderRemoval(workFolderId: string, now?: Date): Promise<WorkFoldAutomationSuspendResult> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const removedAt = (now ?? this.#now()).toISOString();
      requireReference(workFolderId, "work-folder id");
      const draft = structuredClone(this.#file);
      const suspended: WorkFoldAutomationRecord[] = [];
      const noted: WorkFoldAutomationRecord[] = [];
      for (const automation of draft.automations) {
        if (!workFoldAutomationReferencedWorkFolderIds(automation.declaration).includes(workFolderId)) continue;
        if (automation.health === "enabled") {
          automation.health = "suspended";
          automation.suspension = { at: removedAt, missingWorkFolderIds: [workFolderId], reRegisteredWorkFolderIds: [] };
          delete automation.lastScheduledAt;
          suspended.push(automation);
          await this.#journalBestEffort({
            scope: "automation",
            outcome: "suspended",
            automationId: automation.declaration.id,
            digest: automation.digest,
            missingWorkFolderIds: [workFolderId],
            detail: "A referenced work-folder was removed; the enablement is revoked and turning the automation on again is a fresh enablement.",
          });
          continue;
        }
        if (automation.health === "suspended" && automation.suspension && !automation.suspension.missingWorkFolderIds.includes(workFolderId)) {
          automation.suspension.missingWorkFolderIds = [...automation.suspension.missingWorkFolderIds, workFolderId].sort();
          noted.push(automation);
          await this.#journalBestEffort({
            scope: "automation",
            outcome: "suspended",
            automationId: automation.declaration.id,
            digest: automation.digest,
            missingWorkFolderIds: automation.suspension.missingWorkFolderIds,
            detail: "Another referenced work-folder was removed while this automation was already suspended.",
          });
        }
      }
      if (suspended.length || noted.length) await this.#commit(draft);
      return {
        suspended: suspended.map((automation) => structuredClone(automation)),
        noted: noted.map((automation) => structuredClone(automation)),
      };
    });
  }

  /**
   * Copy-level detail when a missing work-folder's portable identity is
   * re-registered: the person sees "re-registered" rather than "removed",
   * and nothing else changes — registration must never silently re-arm
   * standing behavior.
   */
  async noteWorkFolderReRegistered(workFolderId: string): Promise<WorkFoldAutomationRecord[]> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      requireReference(workFolderId, "work-folder id");
      const draft = structuredClone(this.#file);
      const affected: WorkFoldAutomationRecord[] = [];
      for (const automation of draft.automations) {
        if (automation.health !== "suspended" || !automation.suspension) continue;
        if (!automation.suspension.missingWorkFolderIds.includes(workFolderId)) continue;
        if (automation.suspension.reRegisteredWorkFolderIds.includes(workFolderId)) continue;
        automation.suspension.reRegisteredWorkFolderIds = [...automation.suspension.reRegisteredWorkFolderIds, workFolderId].sort();
        affected.push(automation);
        await this.#journalBestEffort({
          scope: "automation",
          outcome: "re-registered",
          automationId: automation.declaration.id,
          digest: automation.digest,
          missingWorkFolderIds: [workFolderId],
          detail: "The missing work-folder was re-registered with preserved identity. The automation stays suspended; turning it on again is a fresh enablement.",
        });
      }
      if (affected.length) await this.#commit(draft);
      return affected.map((automation) => structuredClone(automation));
    });
  }

  /** Persists the durable cadence anchor after a scheduled or resume run. */
  async recordCadence(automationId: string, lastScheduledAt: string): Promise<boolean> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      if (typeof lastScheduledAt !== "string" || !Number.isFinite(Date.parse(lastScheduledAt))) {
        throw new WorkFoldAutomationStoreError("INPUT_INVALID", "A cadence anchor must be an ISO timestamp.");
      }
      const draft = structuredClone(this.#file);
      const automation = draft.automations.find((candidate) => candidate.declaration.id === automationId);
      if (!automation || automation.health !== "enabled") return false;
      const canonical = new Date(lastScheduledAt).toISOString();
      if (automation.lastScheduledAt !== undefined && Date.parse(automation.lastScheduledAt) >= Date.parse(canonical)) return true;
      automation.lastScheduledAt = canonical;
      await this.#commit(draft);
      return true;
    });
  }

  /**
   * Atomically consumes one deterministic one-time occurrence before hop 1.
   * The health transition is the at-most-once gate: startup never arms a
   * completed record, even when the process stopped before a run receipt.
   */
  async claimAtOccurrence(
    automationId: string,
    slotAt: string,
    runId: string,
    now?: Date,
  ): Promise<WorkFoldAutomationRecord | null> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      requireReference(runId, "Scheduled run id");
      if (!isTimestamp(slotAt)) {
        throw new WorkFoldAutomationStoreError("INPUT_INVALID", "A one-time occurrence slot must be an ISO timestamp.");
      }
      const canonicalSlot = new Date(slotAt).toISOString();
      const draft = structuredClone(this.#file);
      const automation = draft.automations.find((candidate) => candidate.declaration.id === automationId);
      if (!automation || automation.health !== "enabled" || automation.declaration.trigger.kind !== "at") return null;
      if (automation.declaration.trigger.at !== canonicalSlot) return null;
      automation.health = "completed";
      automation.atOccurrence = {
        occurrenceId: workFoldAutomationAtOccurrenceId(automationId, automation.digest, canonicalSlot),
        slotAt: canonicalSlot,
        consumedAt: (now ?? this.#now()).toISOString(),
        runId,
      };
      await this.#commit(draft);
      return structuredClone(automation);
    });
  }

  /** Adds the terminal time to an already-consumed occurrence; idempotent. */
  async finishAtOccurrence(automationId: string, runId: string, finishedAt: string): Promise<boolean> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      if (!isTimestamp(finishedAt)) {
        throw new WorkFoldAutomationStoreError("INPUT_INVALID", "A one-time occurrence finish time must be an ISO timestamp.");
      }
      const draft = structuredClone(this.#file);
      const automation = draft.automations.find((candidate) => candidate.declaration.id === automationId);
      if (automation?.health !== "completed" || automation.atOccurrence?.runId !== runId) return false;
      if (automation.atOccurrence.finishedAt !== undefined) return true;
      automation.atOccurrence.finishedAt = new Date(finishedAt).toISOString();
      await this.#commit(draft);
      await this.#journalBestEffort({
        scope: "automation",
        outcome: "completed",
        automationId,
        digest: automation.digest,
        occurrenceId: automation.atOccurrence.occurrenceId,
        scheduledRunId: runId,
        detail: "The one-time scheduled occurrence was consumed and reached a terminal outcome.",
      });
      return true;
    });
  }

  /**
   * Removes a disabled or suspended automation's declaration, grant history,
   * and cadence anchor. The receipts journal is retained — audit records
   * survive the object — which is why deletion is strictly journal-first.
   */
  async delete(
    automationId: string,
    receiptContext: WorkFoldAutomationActionReceiptContext = {},
  ): Promise<WorkFoldAutomationRecord> {
    return await this.#mutate(async () => {
      this.#assertOperational();
      const action = normalizeActionReceiptContext(receiptContext);
      const draft = structuredClone(this.#file);
      const automation = this.#requireAutomation(draft, automationId);
      if (automation.health === "enabled") {
        throw new WorkFoldAutomationStoreError(
          "HEALTH_INVALID",
          "This automation is enabled; disable it before deleting it so revocation stops stale work first.",
          { health: automation.health },
        );
      }
      await this.#journalStrict({
        scope: "automation",
        outcome: "deleted",
        automationId,
        digest: automation.digest,
        ...action,
        detail: `Deleted from ${automation.health}. Receipts are retained; audit records survive the object.`,
      });
      draft.automations = draft.automations.filter((candidate) => candidate.declaration.id !== automationId);
      await this.#commit(draft);
      return structuredClone(automation);
    });
  }

  #requireAutomation(draft: AutomationStoreFileShape, automationId: string): WorkFoldAutomationRecord {
    const automation = draft.automations.find((candidate) => candidate.declaration.id === automationId);
    if (!automation) {
      throw new WorkFoldAutomationStoreError(
        "NOT_FOUND",
        "No automation has this id. A proposal holds no authority; enabling pins the exact declaration before anything runs.",
      );
    }
    return automation;
  }

  async #journalStrict(entry: Omit<WorkFoldAutomationReceiptV1, "v" | "at">): Promise<void> {
    if (await this.receipts.append(entry)) return;
    throw new WorkFoldAutomationStoreError(
      "JOURNAL_UNAVAILABLE",
      "work-fold could not journal this automation mutation, so nothing was changed.",
    );
  }

  async #journalBestEffort(entry: Omit<WorkFoldAutomationReceiptV1, "v" | "at">): Promise<void> {
    // Narrowing proceeds even when its journal line cannot be written: the
    // durable state file is the authority record, and failing toward less
    // authority is the safe direction.
    await this.receipts.append(entry);
  }

  #assertOperational(): void {
    if (this.#damageReason === null) return;
    throw new WorkFoldAutomationStoreError(
      "STORE_DAMAGED",
      `work-fold disabled automations: ${this.#damageReason} Nothing is guessed from damaged authority state.`,
    );
  }

  async #commit(draft: AutomationStoreFileShape): Promise<void> {
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

function normalizeDeclarationInput(value: unknown): WorkFoldAutomationDeclaration {
  try {
    return normalizeWorkFoldAutomationDeclaration(value);
  } catch (error) {
    throw new WorkFoldAutomationStoreError(
      "INPUT_INVALID",
      `work-fold refused this automation declaration: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function normalizeGrantInput(value: WorkFoldAutomationEnableInput["grant"]): WorkFoldAutomationEnableInput["grant"] {
  if (!value || typeof value !== "object") {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", "An enablement requires its enabling act record.");
  }
  requireReference(value.requestId, "Request id");
  if (!WORKFOLD_CLI_ACT_SURFACES.includes(value.surface)) {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", "The enabling surface must be an act surface.");
  }
  if (value.surface === "remote_web") {
    requireReference(value.browserId, "Paired browser id");
  } else if (value.browserId !== undefined) {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", "Browser identity belongs only to the remote surface.");
  }
  return {
    requestId: value.requestId,
    surface: value.surface,
    ...(value.browserId !== undefined ? { browserId: value.browserId } : {}),
  };
}

function normalizeActionReceiptContext(
  value: WorkFoldAutomationActionReceiptContext,
): WorkFoldAutomationActionReceiptContext {
  if (!value || typeof value !== "object") {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", "Automation receipt context must be an object.");
  }
  if (value.requestId !== undefined) requireReference(value.requestId, "Request id");
  if (value.surface !== undefined && !WORKFOLD_CLI_ACT_SURFACES.includes(value.surface)) {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", "Automation action surface is invalid.");
  }
  return {
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
    ...(value.surface !== undefined ? { surface: value.surface } : {}),
  };
}

function requireReference(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumTextLength || forbiddenTextPattern.test(value)) {
    throw new WorkFoldAutomationStoreError("INPUT_INVALID", `${label} is required and must be plain text.`);
  }
}

function scrubText(value: string): string {
  return value.replace(scrubReplacePattern, "�").slice(0, maximumTextLength);
}

// Filled-in placeholder text is already filtered and bounded by the executor
// before it is substituted, so this is defense in depth over the same
// character class; it keeps its newlines (it is a list) and is re-bounded.
function scrubPlaceholderText(value: string): string {
  return scrubWorkFoldAutomationMessageText(value).slice(0, workFoldAutomationBounds.maxPlaceholderTextBytes);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyFile(): AutomationStoreFileShape {
  return { schemaVersion: WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION, automations: [] };
}

async function loadAutomationStoreFile(
  path: string,
): Promise<{ file: AutomationStoreFileShape; damageReason: string | null }> {
  const damaged = (reason: string) => ({
    file: emptyFile(),
    damageReason: `The automation store at ${path} ${reason}.`,
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return damaged("is not an automation record");
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => key !== "schemaVersion" && key !== "automations");
  if (unknown) return damaged(`carries the unknown field ${unknown}`);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2 && record.schemaVersion !== WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION) {
    return typeof record.schemaVersion === "number" && record.schemaVersion > WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION
      ? damaged(`was written by a newer work-fold (schema version ${record.schemaVersion})`)
      : damaged(`uses the unsupported schema version ${String(record.schemaVersion)}`);
  }
  const legacyGrants = record.schemaVersion !== WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION;
  if (!Array.isArray(record.automations)) return damaged("does not list its automations");
  const automations: WorkFoldAutomationRecord[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of record.automations.entries()) {
    const converted = legacyGrants ? convertLegacyGrants(candidate) : candidate;
    const issue = automationRecordIssue(converted);
    if (issue) return damaged(`holds an invalid automation at index ${index}: ${issue}`);
    const automation = converted as WorkFoldAutomationRecord;
    if (ids.has(automation.declaration.id)) return damaged(`holds the duplicate automation id ${automation.declaration.id}`);
    ids.add(automation.declaration.id);
    automations.push(structuredClone(automation));
  }
  return { file: { schemaVersion: WORKFOLD_AUTOMATION_STORE_SCHEMA_VERSION, automations }, damageReason: null };
}

const AUTOMATION_RECORD_KEYS = [
  "declaration",
  "digest",
  "health",
  "grants",
  "lastScheduledAt",
  "disabledAt",
  "suspension",
  "atOccurrence",
];
const GRANT_KEYS = ["digest", "requestId", "enabledAt", "surface", "browserId"];
const LEGACY_GRANT_KEYS = ["digest", "decisionId", "approvedAt", "surface", "browserId", "browserGrantId"];

/**
 * Converts a pre-receipts-not-gates grant on load: the enabling act's id and
 * time keep their meaning under their honest names, and the browser grant id
 * a decision card carried is dropped. The first commit rewrites the file at
 * the current schema version, so the conversion runs once.
 */
function convertLegacyGrants(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const record = candidate as Record<string, unknown>;
  if (!Array.isArray(record.grants)) return candidate;
  return {
    ...record,
    grants: record.grants.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const grant = entry as Record<string, unknown>;
      if (grant.decisionId === undefined && grant.approvedAt === undefined) return entry;
      const legacy = grant as unknown as LegacyWorkFoldAutomationGrant;
      return {
        digest: legacy.digest,
        requestId: legacy.decisionId,
        enabledAt: legacy.approvedAt,
        surface: legacy.surface,
        ...(legacy.browserId !== undefined ? { browserId: legacy.browserId } : {}),
      };
    }),
  };
}
const SUSPENSION_KEYS = ["at", "missingWorkFolderIds", "reRegisteredWorkFolderIds"];
const AT_OCCURRENCE_KEYS = ["occurrenceId", "slotAt", "consumedAt", "runId", "finishedAt"];

function automationRecordIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "an automation record must be an object";
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !AUTOMATION_RECORD_KEYS.includes(key));
  if (unknown) return `${unknown} is not part of the automation record contract`;
  let declaration: WorkFoldAutomationDeclaration;
  try {
    declaration = normalizeWorkFoldAutomationDeclaration(record.declaration);
  } catch (error) {
    return `its declaration is invalid (${error instanceof Error ? error.message : String(error)})`;
  }
  // Recompute rather than trust: a digest that does not match its declaration
  // is digest-mismatched authority, which must never load.
  if (record.digest !== workFoldAutomationDigest(declaration)) return "its digest does not match its declaration";
  if (record.health !== "enabled" && record.health !== "disabled" && record.health !== "suspended" && record.health !== "completed") {
    return "its health state is unknown";
  }
  if (!Array.isArray(record.grants) || record.grants.length < 1 || record.grants.length > WORKFOLD_AUTOMATION_GRANT_HISTORY_LIMIT) {
    return "its grant history is missing or oversized";
  }
  for (const grant of record.grants) {
    const issue = grantIssue(grant);
    if (issue) return issue;
  }
  const newest = record.grants[record.grants.length - 1] as WorkFoldAutomationGrant;
  if ((record.health === "enabled" || record.health === "completed") && newest.digest !== record.digest) {
    return "its live grant does not pin its declaration digest";
  }
  if (record.lastScheduledAt !== undefined && !isTimestamp(record.lastScheduledAt)) return "its cadence anchor is invalid";
  if (record.lastScheduledAt !== undefined && declaration.trigger.kind !== "interval") {
    return "only an interval automation may hold a cadence anchor";
  }
  if (record.disabledAt !== undefined && !isTimestamp(record.disabledAt)) return "its disabledAt is invalid";
  if ((record.health === "suspended") !== (record.suspension !== undefined)) {
    return "suspension detail and suspended health must appear together";
  }
  if (record.suspension !== undefined) {
    const issue = suspensionIssue(record.suspension, workFoldAutomationReferencedWorkFolderIds(declaration));
    if (issue) return issue;
  }
  if ((record.health === "completed") !== (record.atOccurrence !== undefined)) {
    return "one-time occurrence detail and completed health must appear together";
  }
  if (record.atOccurrence !== undefined) {
    if (declaration.trigger.kind !== "at") return "only a one-time automation may hold occurrence detail";
    const issue = atOccurrenceIssue(record.atOccurrence, declaration);
    if (issue) return issue;
  }
  return null;
}

function atOccurrenceIssue(value: unknown, declaration: WorkFoldAutomationDeclaration): string | null {
  if (declaration.trigger.kind !== "at") return "only a one-time declaration may validate occurrence detail";
  const trigger = declaration.trigger;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "one-time occurrence detail must be an object";
  const occurrence = value as Record<string, unknown>;
  const unknown = Object.keys(occurrence).find((key) => !AT_OCCURRENCE_KEYS.includes(key));
  if (unknown) return `one-time occurrence field ${unknown} is not part of the contract`;
  if (typeof occurrence.occurrenceId !== "string" || !/^at-[a-f0-9]{32}$/.test(occurrence.occurrenceId)) {
    return "the one-time occurrence id is invalid";
  }
  if (!isTimestamp(occurrence.slotAt) || occurrence.slotAt !== trigger.at) {
    return "the one-time occurrence slot does not match its declaration";
  }
  if (!isTimestamp(occurrence.consumedAt)) return "the one-time occurrence consumedAt is invalid";
  if (typeof occurrence.runId !== "string" || !occurrence.runId.trim()) return "the one-time occurrence run id is invalid";
  if (occurrence.finishedAt !== undefined && !isTimestamp(occurrence.finishedAt)) {
    return "the one-time occurrence finishedAt is invalid";
  }
  if (
    occurrence.finishedAt !== undefined
    && Date.parse(occurrence.finishedAt as string) < Date.parse(occurrence.consumedAt as string)
  ) return "the one-time occurrence finished before it was consumed";
  const expected = workFoldAutomationAtOccurrenceId(declaration.id, workFoldAutomationDigest(declaration), trigger.at);
  if (occurrence.occurrenceId !== expected) return "the one-time occurrence id does not match its declaration";
  return null;
}

export function workFoldAutomationAtOccurrenceId(automationId: string, digest: string, slotAt: string): string {
  return `at-${createHash("sha256").update(`${automationId}\0${digest}\0${slotAt}`).digest("hex").slice(0, 32)}`;
}

function scheduledReceiptCause(
  value: unknown,
): Extract<WorkFoldAutomationRunCause, { kind: "scheduled" | "resume" }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cause = value as Record<string, unknown>;
  if ((cause.kind !== "scheduled" && cause.kind !== "resume") || !isTimestamp(cause.slotAt)) return undefined;
  return { kind: cause.kind, slotAt: new Date(cause.slotAt as string).toISOString() };
}

function grantIssue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "a grant must be an object";
  const grant = value as Record<string, unknown>;
  const unknown = Object.keys(grant).find((key) => !GRANT_KEYS.includes(key));
  if (unknown) {
    return LEGACY_GRANT_KEYS.includes(unknown)
      ? `grant field ${unknown} was not converted from its older shape`
      : `grant field ${unknown} is not part of the grant contract`;
  }
  if (typeof grant.digest !== "string" || !/^[a-f0-9]{64}$/.test(grant.digest)) return "a grant digest is invalid";
  if (typeof grant.requestId !== "string" || !grant.requestId.trim()) return "a grant request id is invalid";
  if (!isTimestamp(grant.enabledAt)) return "a grant enabledAt is invalid";
  if (!(WORKFOLD_CLI_ACT_SURFACES as readonly string[]).includes(String(grant.surface))
    && !(WORKFOLD_CLI_ACT_LEGACY_SURFACES as readonly string[]).includes(String(grant.surface))) {
    return "a grant surface is invalid";
  }
  if ((grant.surface === "remote_web") !== (typeof grant.browserId === "string")) {
    return "a grant's browser identity must accompany exactly the remote surface";
  }
  return null;
}

function suspensionIssue(value: unknown, referencedWorkFolderIds: string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "suspension detail must be an object";
  const suspension = value as Record<string, unknown>;
  const unknown = Object.keys(suspension).find((key) => !SUSPENSION_KEYS.includes(key));
  if (unknown) return `suspension field ${unknown} is not part of the suspension contract`;
  if (!isTimestamp(suspension.at)) return "the suspension timestamp is invalid";
  for (const key of ["missingWorkFolderIds", "reRegisteredWorkFolderIds"] as const) {
    const list = suspension[key];
    if (!Array.isArray(list) || (key === "missingWorkFolderIds" && list.length < 1) || list.length > 64) {
      return `suspension ${key} is invalid`;
    }
    for (const id of list) {
      if (typeof id !== "string" || !id.trim()) return `suspension ${key} holds an invalid work-folder id`;
    }
  }
  const missing = suspension.missingWorkFolderIds as string[];
  const reRegistered = suspension.reRegisteredWorkFolderIds as string[];
  if (!missing.every((id) => referencedWorkFolderIds.includes(id))) {
    return "suspension names a work-folder the declaration never references";
  }
  if (!reRegistered.every((id) => missing.includes(id))) {
    return "suspension notes a re-registered work-folder it never recorded as missing";
  }
  return null;
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
