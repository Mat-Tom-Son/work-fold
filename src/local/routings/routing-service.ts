import type { WorkFoldResultEnvelope } from "../requests/request-records.js";
import { WorkFoldRoutingFileWatch, type WorkFoldRoutingFileObserver, type WorkFoldRoutingFileWatchStatus } from "./routing-file-observer.js";
import { randomUUID } from "node:crypto";

import { workFoldRoutingMaxConcurrentRuns } from "../../shared/fold-limits.js";
import {
  WorkFoldAutomationService,
  type WorkFoldAutomationClock,
  type WorkFoldAutomationJobKey,
  type WorkFoldAutomationRunAdmission,
  type WorkFoldAutomationRunContext,
  type WorkFoldAutomationRunResult,
} from "../agent/work-fold-automation-service.js";
import {
  workFoldRoutingBounds,
  normalizeWorkFoldRoutingDeclaration,
  scrubWorkFoldRoutingMessageText,
  workFoldRoutingDigest,
  workFoldRoutingMessagePlaceholders,
  type WorkFoldRoutingChatStep,
  type WorkFoldRoutingCheckStep,
  type WorkFoldRoutingDeclaration,
  type WorkFoldRoutingFilesStep,
  type WorkFoldRoutingFoldStep,
  type WorkFoldRoutingPlaceholder,
  type WorkFoldRoutingSettleSource,
  type WorkFoldRoutingStep,
  type WorkFoldRoutingStepCreatedFilesSource,
  type WorkFoldRoutingTrigger,
} from "./routing-declarations.js";
import {
  type WorkFoldRoutingEnableInput,
  type WorkFoldRoutingActionReceiptContext,
  type WorkFoldRoutingHealth,
  type WorkFoldRoutingReceipts,
  type WorkFoldRoutingReceiptPlaceholder,
  type WorkFoldRoutingReceiptV1,
  type WorkFoldRoutingRecord,
  type WorkFoldRoutingRunCause,
  type WorkFoldRoutingStore,
  workFoldRoutingAtOccurrenceId,
} from "./routing-store.js";
import type {
  WorkFoldRoutingHopLineage,
  WorkFoldSettleRecord,
  WorkFoldSettleSignal,
} from "./settle-signal.js";

/**
 * The routing executor (docs/fold-routings.md): deterministic app code that
 * evaluates triggers over settle signals and the bounded schedule, admits
 * runs through its own FIFO scheduler instance, executes at most sixteen
 * declared hops by default strictly in order, and writes journal-first
 * receipts for every run and hop. There is no model call anywhere in this
 * module: agentic work happens only inside a Space Chat hop or a fold hop,
 * run by that Space's own Assistant or the management conversation through
 * the injected ports. The executor appends no ambient context to anything it
 * dispatches — the only text it adds is the closed placeholder set, filled in
 * host-side from the run's own cause and its earlier hops' host records.
 *
 * The service owns its own `WorkFoldAutomationService` instance — the same
 * proven class the restricted-app scheduler uses, deliberately a separate
 * budget so one Space app's jobs can never starve cross-Space glue (and vice
 * versa), and a separate suspend/resume/close lifecycle so the two authority
 * domains stay uncoupled.
 */
export const workFoldRoutingAutomationOwnerId = "work-fold.routing";

/**
 * Machine-wide concurrent routing runs by default; FIFO beyond it. A generous
 * default, not a cap. The number lives in the shared limits contract so
 * Settings → The fold → Limits shows exactly what this executor enforces.
 */
export { workFoldRoutingMaxConcurrentRuns };

export interface WorkFoldRoutingHopContext {
  routingId: string;
  runId: string;
  hopId: string;
  /** Stamped onto every domain run a hop causes, so its settles never fire triggers. */
  lineage: WorkFoldRoutingHopLineage;
  signal: AbortSignal;
}

export interface WorkFoldRoutingChatHopResult {
  conversationId: string;
  turnTaskId: string;
  outcome: "succeeded" | "failed" | "aborted";
  /** Selected request result, never turn file-change evidence. Null while waiting. */
  result?: WorkFoldResultEnvelope | null;
  error?: string;
  preCheckpointId?: string;
  postCheckpointId?: string;
}

/** A fold hop's own management turn; it records no checkpoints and names no Space. */
export type WorkFoldRoutingFoldHopResult = Pick<
  WorkFoldRoutingChatHopResult,
  "conversationId" | "turnTaskId" | "outcome" | "error" | "result"
>;

/** The active findings of a settled Check run, for `{{trigger.findings}}`. */
export interface WorkFoldRoutingCheckRunFindings {
  findings: Array<{ checkId: string; title: string; targetPath: string; severity: string }>;
}

export interface WorkFoldRoutingFilesHopResult {
  restorePointId?: string;
  /** Destination-relative placed paths, including collision renames. */
  copiedPaths: string[];
  fileCount: number;
  totalBytes: number;
}

export interface WorkFoldRoutingCheckHopResult {
  runId: string;
  taskId: string;
  state: "succeeded" | "failed" | "aborted" | "interrupted";
  checkIds: string[];
  findingCount: number;
  admittedCount: number;
  error?: string;
}

export interface WorkFoldRoutingCheckpointManifestEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
}

/** The slice of a History checkpoint the created-files handoff diffs. */
export interface WorkFoldRoutingCheckpointManifest {
  files: WorkFoldRoutingCheckpointManifestEntry[];
  /** Paths the capture skipped (oversized, unreadable, links, excluded). */
  skippedFilePaths: string[];
}

/**
 * What the files port receives: the declared exact paths or tree selector
 * verbatim, or — for the created-files handoff — the exact path list the
 * executor resolved host-side from the chat hop's own checkpoint pair.
 */
export type WorkFoldRoutingResolvedFilesSource =
  | { kind: "paths"; paths: string[] }
  | { kind: "tree"; path: string; recursive: boolean; extensions: string[] };

/**
 * The hop ports are the seam to the same in-process route internals the act
 * facade uses (turn acceptance, `files add`, Check runs). They perform the
 * mutations and honor the abort signal through their own domain's abort
 * paths; a files port is not interruptible mid-copy — the copy either
 * completes with its restore point or fails as one unit. Ports return
 * evidence, never content: the executor journals identifiers, paths, counts,
 * and the bounded text it filled into a message itself.
 *
 * A message port receives the resolved message as an explicit argument: the
 * executor, never the port, fills placeholders, so every port sees exactly
 * what was sent.
 */
export interface WorkFoldRoutingHopPorts {
  chat(
    step: WorkFoldRoutingChatStep,
    message: string,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingChatHopResult>;
  /** Starts a new thread in the management conversation and waits for its turn. */
  fold(
    step: WorkFoldRoutingFoldStep,
    message: string,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingFoldHopResult>;
  /** The settled Check run's active findings; null when the run cannot be read. */
  checkRunFindings(spaceId: string, taskId: string): Promise<WorkFoldRoutingCheckRunFindings | null>;
  files(
    step: WorkFoldRoutingFilesStep,
    source: WorkFoldRoutingResolvedFilesSource,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingFilesHopResult>;
  check(step: WorkFoldRoutingCheckStep, context: WorkFoldRoutingHopContext): Promise<WorkFoldRoutingCheckHopResult>;
  /** Reads one checkpoint's manifest from the named Space's History; null when missing. */
  checkpointManifest(spaceId: string, checkpointId: string): Promise<WorkFoldRoutingCheckpointManifest | null>;
}

/**
 * Optional seam to the kernel's experimental `routing_run` task kind (the
 * `check_run` precedent): observability only, deliberately excluded from
 * stable task projections, and a port failure never affects the run.
 */
export interface WorkFoldRoutingRunTaskPort {
  start(input: { routingId: string; runId: string }): { id: string };
  finish(taskId: string): void;
}

export type WorkFoldRoutingServiceErrorCode =
  | "SERVICE_DAMAGED"
  | "NOT_FOUND"
  | "HEALTH_INVALID"
  | "INPUT_INVALID";

export class WorkFoldRoutingServiceError extends Error {
  readonly code: WorkFoldRoutingServiceErrorCode;
  readonly health?: WorkFoldRoutingHealth;

  constructor(
    code: WorkFoldRoutingServiceErrorCode,
    message: string,
    options: { health?: WorkFoldRoutingHealth; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WorkFoldRoutingServiceError";
    this.code = code;
    if (options.health !== undefined) this.health = options.health;
  }
}

export interface WorkFoldRoutingServiceStatus {
  storeDamaged: boolean;
  storeDamageReason?: string;
  journalDamaged: boolean;
  journalDamageReason?: string;
  armedRoutingCount: number;
  activeRunCount: number;
  /** Runs found accepted-without-terminal at startup and recorded interrupted, never replayed. */
  recoveredInterruptedRunIds: string[];
}

export interface WorkFoldRoutingServiceOptions {
  store: WorkFoldRoutingStore;
  ports: WorkFoldRoutingHopPorts;
  settleSignal?: WorkFoldSettleSignal;
  tasks?: WorkFoldRoutingRunTaskPort;
  clock?: WorkFoldAutomationClock;
  createRunId?: () => string;
  catchUpStagger?: (key: WorkFoldAutomationJobKey) => number;
  maxConcurrency?: number;
  observeFiles?: WorkFoldRoutingFileObserver;
  /** Tests can drive observation explicitly. Production scans every two seconds. */
  filePollIntervalMs?: number;
}

export interface WorkFoldRoutingProjection extends WorkFoldRoutingRecord {
  fileWatch?: WorkFoldRoutingFileWatchStatus;
  nextScheduledAt?: string;
  /** Present only while a hop-bearing run is genuinely active. */
  activeRunId?: string;
}

export interface WorkFoldRoutingRunAdmission extends WorkFoldAutomationRunAdmission {}

interface ArmedRouting {
  digest: string;
  title: string;
  trigger: WorkFoldRoutingTrigger;
}

interface ActiveRunState {
  routingId: string;
  runId: string;
  controller: AbortController;
  stopRequested: boolean;
  stoppedHopTaskIds: string[];
  stopReceipt?: WorkFoldRoutingActionReceiptContext;
}

type RunSummary =
  | { kind: "succeeded" }
  | { kind: "failed"; failedHopId: string; error: string }
  | { kind: "stopped" }
  | { kind: "interrupted"; detail: string };

/** A terminal skipped receipt was already written for a non-exceptional claim refusal. */
class PreHopClaimRefusal extends Error {}

const causeMapGuard = 256;

export class WorkFoldRoutingService {
  readonly #fileWatches = new Map<string, WorkFoldRoutingFileWatch>();
  readonly #observeFiles?: WorkFoldRoutingFileObserver;
  #filePollTimer?: ReturnType<typeof setInterval>;
  #filePollBusy = false;
  #fileEpoch = 0;
  readonly #store: WorkFoldRoutingStore;
  readonly #receipts: WorkFoldRoutingReceipts;
  readonly #ports: WorkFoldRoutingHopPorts;
  readonly #tasks: WorkFoldRoutingRunTaskPort | null;
  readonly #automation: WorkFoldAutomationService;
  readonly #now: () => Date;
  readonly #armed = new Map<string, ArmedRouting>();
  readonly #causeByRunId = new Map<string, WorkFoldRoutingRunCause>();
  readonly #launchedRunIds = new Set<string>();
  readonly #activeRuns = new Map<string, ActiveRunState>();
  readonly #recoveredRunIds: string[] = [];
  #pendingCause: WorkFoldRoutingRunCause | null = null;
  #unsubscribeSettle: (() => void) | null = null;
  #journalDamageReason: string | null = null;
  #suspensionGeneration = 0;
  #suspensionDesired = false;
  #closed = false;

  private constructor(options: WorkFoldRoutingServiceOptions) {
    this.#observeFiles = options.observeFiles;
    this.#store = options.store;
    this.#receipts = options.store.receipts;
    this.#ports = options.ports;
    this.#tasks = options.tasks ?? null;
    this.#now = options.clock ? () => options.clock!.now() : () => new Date();
    const createRunId = options.createRunId ?? randomUUID;
    this.#automation = new WorkFoldAutomationService({
      maxConcurrency: options.maxConcurrency ?? workFoldRoutingMaxConcurrentRuns,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.catchUpStagger ? { catchUpStagger: options.catchUpStagger } : {}),
      // The scheduler mints exactly one run id per admission, synchronously
      // inside the admission call. Binding the pending trigger cause to that
      // id here — instead of to a per-routing slot — makes attribution exact
      // even when an admission waits in the FIFO queue behind a full budget.
      createRunId: () => {
        const runId = createRunId();
        const pending = this.#pendingCause;
        this.#pendingCause = null;
        if (pending) {
          if (this.#causeByRunId.size >= causeMapGuard) {
            const oldest = this.#causeByRunId.keys().next().value;
            if (oldest !== undefined) this.#causeByRunId.delete(oldest);
          }
          this.#causeByRunId.set(runId, pending);
        }
        return runId;
      },
      onResult: (result) => this.#onAutomationResult(result),
    });
  }

  static async create(options: WorkFoldRoutingServiceOptions): Promise<WorkFoldRoutingService> {
    const service = new WorkFoldRoutingService(options);
    await service.#initialize(options.settleSignal);
    if (options.observeFiles && options.filePollIntervalMs !== 0) {
      service.#filePollTimer = setInterval(() => { void service.pollFileChanges(); }, Math.max(2000, options.filePollIntervalMs ?? 2000));
      service.#filePollTimer.unref?.();
    }
    return service;
  }

  status(): WorkFoldRoutingServiceStatus {
    const store = this.#store.status();
    return {
      storeDamaged: store.damaged,
      ...(store.damageReason !== undefined ? { storeDamageReason: store.damageReason } : {}),
      journalDamaged: this.#journalDamageReason !== null,
      ...(this.#journalDamageReason !== null ? { journalDamageReason: this.#journalDamageReason } : {}),
      armedRoutingCount: this.#armed.size,
      activeRunCount: this.#activeRuns.size,
      recoveredInterruptedRunIds: [...this.#recoveredRunIds],
    };
  }

  async listRoutings(): Promise<WorkFoldRoutingProjection[]> {
    return (await this.#store.list()).map((record) => this.#project(record));
  }

  async getRouting(routingId: string): Promise<WorkFoldRoutingProjection | undefined> {
    const record = await this.#store.get(routingId);
    return record ? this.#project(record) : undefined;
  }

  /**
   * Commits an enablement receipt and arms the routing. Enabling an
   * already-enabled identical declaration is a no-op: no fresh receipt, no
   * journal line, and the active run is left alone, so asking twice never
   * costs a person work in flight. Replacing an already-enabled routing with
   * a changed declaration is a fresh receipt that first stops any run still
   * executing under the prior digest: revocation stops stale work before the
   * authority change reads as complete.
   */
  async enable(input: WorkFoldRoutingEnableInput): Promise<WorkFoldRoutingRecord> {
    this.#assertOperational();
    const declaration = normalizeWorkFoldRoutingDeclaration(input.declaration);
    const digest = workFoldRoutingDigest(declaration);
    const current = await this.#store.get(declaration.id);
    if (current?.health === "enabled" && current.digest === digest && input.expectedDigest === digest) {
      return current;
    }
    if (declaration.trigger.kind === "files-changed") {
      if (!this.#observeFiles) throw new Error("Folder-change triggers are unavailable in this runtime.");
      await this.#observeFiles(declaration.trigger);
    }
    const record = await this.#store.enable(input);
    const routingId = record.declaration.id;
    this.stopRun(routingId);
    this.#disarm(routingId);
    this.#arm(record);
    return record;
  }

  /**
   * Disables a routing on the layered-authority order: the disabled intent
   * journals and persists first (startup refuses to arm it), then pending
   * admissions are cancelled and the active run, if any, is stopped through
   * the stop path — and the result reports what it stopped. Narrowing is
   * never blocked by journal damage or a closed executor.
   */
  async disable(
    routingId: string,
    receiptContext: WorkFoldRoutingActionReceiptContext = {},
  ): Promise<{ record: WorkFoldRoutingRecord; stoppedRunId: string | null }> {
    const record = await this.#store.disable(routingId, receiptContext);
    const stopped = this.stopRun(routingId, receiptContext);
    this.#disarm(routingId);
    return { record, stoppedRunId: stopped?.runId ?? null };
  }

  /** Deletes an inert routing; receipts are retained by the store. */
  async deleteRouting(
    routingId: string,
    receiptContext: WorkFoldRoutingActionReceiptContext = {},
  ): Promise<WorkFoldRoutingRecord> {
    const current = await this.#store.get(routingId);
    const active = [...this.#activeRuns.values()].some((run) => run.routingId === routingId);
    const claimedButUnfinished = current?.health === "completed"
      && current.atOccurrence !== undefined
      && current.atOccurrence.finishedAt === undefined;
    if (active || claimedButUnfinished) {
      throw new WorkFoldRoutingServiceError(
        "HEALTH_INVALID",
        "Stop this routing's active run before deleting it.",
        { ...(current ? { health: current.health } : {}) },
      );
    }
    const record = await this.#store.delete(routingId, receiptContext);
    this.#disarm(routingId);
    return record;
  }

  /**
   * Manual run-now for an enabled routing: receipted, never a schedule
   * mutation. A merely proposed routing is refused — the executor never runs
   * a merely proposed standing declaration, even once.
   */
  async runNow(
    routingId: string,
    options: WorkFoldRoutingActionReceiptContext = {},
  ): Promise<WorkFoldAutomationRunResult> {
    return (await this.runNowAdmission(routingId, options)).result;
  }

  /** Validates authority and returns the scheduler admission before the run settles. */
  async runNowAdmission(
    routingId: string,
    options: WorkFoldRoutingActionReceiptContext = {},
  ): Promise<WorkFoldRoutingRunAdmission> {
    this.#assertOperational();
    const record = await this.#store.get(routingId);
    if (!record) {
      throw new WorkFoldRoutingServiceError(
        "NOT_FOUND",
        "No routing has this id. A proposal holds no authority; enabling pins the exact declaration before anything runs.",
      );
    }
    if (record.health !== "enabled") {
      throw new WorkFoldRoutingServiceError(
        "HEALTH_INVALID",
        record.health === "suspended"
          ? "This routing is suspended because a referenced Space was removed; enable it again to resume."
          : record.health === "completed"
            ? "This one-time routing is completed; its scheduled occurrence has already been consumed."
            : "This routing is off; enable it again to run it.",
        { health: record.health },
      );
    }
    const cause: WorkFoldRoutingRunCause = {
      kind: "run-now",
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      ...(options.surface !== undefined ? { surface: options.surface } : {}),
    };
    return this.#dispatchAdmission(routingId, cause);
  }

  /**
   * Stops this routing's active run by aborting the current hop through the
   * run's own controller; the hop's domain honors the signal on its own abort
   * path, later hops are recorded skipped, and the run settles `stopped`.
   * Returns null when no run is active — a settled run refuses stop with its
   * terminal state at the verb layer.
   */
  stopRun(
    routingId: string,
    receiptContext: WorkFoldRoutingActionReceiptContext = {},
  ): { runId: string } | null {
    const active = [...this.#activeRuns.values()].find((run) => run.routingId === routingId);
    if (!active) return null;
    active.stopRequested = true;
    active.stopReceipt = { ...receiptContext };
    active.controller.abort(new Error("Routing run was stopped."));
    return { runId: active.runId };
  }

  /**
   * Space-removal revocation: every enabled routing referencing the removed
   * Space is suspended with the missing Space id recorded (durable, in the
   * store), its active run is stopped, and its schedule is disarmed. A
   * suspended routing never runs, never retargets, and never resumes
   * automatically; turning it on again is a fresh enablement. With a damaged
   * store this returns empty: damage already fails closed, because nothing
   * is armed and nothing can run.
   */
  async handleSpaceRemoved(spaceId: string): Promise<{ suspendedRoutingIds: string[]; stoppedRunIds: string[] }> {
    if (this.#store.status().damaged) return { suspendedRoutingIds: [], stoppedRunIds: [] };
    const { suspended } = await this.#store.suspendForSpaceRemoval(spaceId);
    const stoppedRunIds: string[] = [];
    for (const record of suspended) {
      const routingId = record.declaration.id;
      const stopped = this.stopRun(routingId);
      if (stopped) stoppedRunIds.push(stopped.runId);
      this.#disarm(routingId);
    }
    return { suspendedRoutingIds: suspended.map((record) => record.declaration.id), stoppedRunIds };
  }

  /**
   * Records that a missing Space's portable identity was re-registered. The
   * copy changes; the semantics deliberately do not: registration must never
   * silently re-arm standing behavior.
   */
  async handleSpaceReRegistered(spaceId: string): Promise<string[]> {
    if (this.#store.status().damaged) return [];
    const affected = await this.#store.noteSpaceReRegistered(spaceId);
    return affected.map((record) => record.declaration.id);
  }

  /** Diagnostic passthrough to the scheduler's bounded in-memory run history. */
  listAutomationResults(routingId?: string): WorkFoldAutomationRunResult[] {
    return this.#automation.listRunResults(routingId ? this.#jobKey(routingId) : undefined);
  }

  /** Sleep/quit suspension: aborts active runs, which settle `interrupted`. */
  suspend(): void {
    this.#resetFileWatches(true);
    this.#suspensionDesired = true;
    this.#suspensionGeneration += 1;
    this.#automation.suspend();
  }

  async resume(): Promise<void> {
    this.#suspensionDesired = false;
    const generation = ++this.#suspensionGeneration;
    await this.#completeMissedSkips(await this.#store.list());
    if (this.#closed || this.#suspensionDesired || generation !== this.#suspensionGeneration) return;
    this.#resetFileWatches();
    this.#automation.resume();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#filePollTimer) clearInterval(this.#filePollTimer);
    this.#resetFileWatches(true);
    this.#suspensionDesired = true;
    this.#suspensionGeneration += 1;
    this.#unsubscribeSettle?.();
    this.#unsubscribeSettle = null;
    this.#automation.close();
  }

  async #initialize(settleSignal?: WorkFoldSettleSignal): Promise<void> {
    if (!this.#store.status().damaged) {
      await this.#recoverInterruptedRuns();
      if (this.#journalDamageReason === null) {
        const records = await this.#store.list();
        await this.#finishRecoveredAtOccurrences(records);
        await this.#completeMissedSkips(await this.#store.list());
        for (const record of await this.#store.list()) {
          if (record.health !== "enabled") continue;
          this.#arm(record);
        }
      }
    }
    if (settleSignal) {
      this.#unsubscribeSettle = settleSignal.subscribe((record) => {
        this.#onSettle(record);
      });
    }
  }

  /**
   * Crash recovery on the Check runner's honesty rule: record, never replay.
   * A run with an `accepted` record and no terminal record gets a terminal
   * `interrupted` record (and so does its in-flight hop); the completed hops
   * keep their receipts, and the schedule then resumes from the durable
   * anchor. A journal that cannot be scanned or written fails the whole
   * executor closed instead of guessing.
   */
  async #recoverInterruptedRuns(): Promise<void> {
    let openRuns;
    try {
      openRuns = await this.#receipts.scanOpenRuns();
    } catch (error) {
      this.#journalDamageReason = error instanceof Error ? error.message : String(error);
      return;
    }
    for (const run of openRuns) {
      let completedAtOccurrence = false;
      if (run.cause && run.digest) {
        try {
          const record = await this.#store.get(run.routingId);
          if (record?.digest === run.digest) {
            if (record.health === "enabled" && record.declaration.trigger.kind === "interval") {
              await this.#store.recordCadence(run.routingId, run.cause.slotAt);
            } else if (record.health === "enabled" && record.declaration.trigger.kind === "at") {
              completedAtOccurrence = (await this.#store.claimAtOccurrence(
                run.routingId,
                run.cause.slotAt,
                run.runId,
                this.#now(),
              )) !== null;
            } else if (record.health === "completed" && record.atOccurrence?.runId === run.runId) {
              completedAtOccurrence = true;
            }
          }
        } catch (error) {
          this.#journalDamageReason = `work-fold could not reconcile the durable schedule claim for interrupted run ${run.runId}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return;
        }
      }
      for (const hopId of run.openHopIds) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "interrupted",
          routingId: run.routingId,
          runId: run.runId,
          hopId,
          detail: "work-fold stopped while this hop was in flight; its effects resolve by that domain's own crash rule.",
        });
      }
      const recorded = await this.#receipts.append({
        scope: "run",
        outcome: "interrupted",
        routingId: run.routingId,
        runId: run.runId,
        ...(run.title !== undefined ? { title: run.title } : {}),
        detail: "work-fold stopped before this routing run recorded a terminal outcome. It was not replayed.",
      });
      if (!recorded) {
        this.#journalDamageReason =
          "The routing receipts journal is unwritable, so interrupted runs cannot be recorded honestly.";
        return;
      }
      this.#recoveredRunIds.push(run.runId);
      if (completedAtOccurrence) {
        await this.#store.finishAtOccurrence(run.routingId, run.runId, this.#now().toISOString());
      }
    }
  }

  #project(record: WorkFoldRoutingRecord): WorkFoldRoutingProjection {
    const next = this.#automation.nextScheduledAt(this.#jobKey(record.declaration.id));
    const active = [...this.#activeRuns.values()].find((run) => run.routingId === record.declaration.id);
    return {
      ...record,
      ...(this.#fileWatches.has(record.declaration.id) ? { fileWatch: structuredClone(this.#fileWatches.get(record.declaration.id)!.status) } : {}),
      ...(next !== undefined ? { nextScheduledAt: next } : {}),
      ...(active !== undefined ? { activeRunId: active.runId } : {}),
    };
  }

  #jobKey(routingId: string): WorkFoldAutomationJobKey {
    return { ownerId: workFoldRoutingAutomationOwnerId, jobId: routingId };
  }

  #arm(record: WorkFoldRoutingRecord): void {
    const routingId = record.declaration.id;
    const trigger = record.declaration.trigger;
    if (trigger.kind === "files-changed") this.#fileWatches.set(routingId, new WorkFoldRoutingFileWatch());
    this.#armed.set(routingId, {
      digest: record.digest,
      title: record.declaration.title,
      trigger: structuredClone(trigger),
    });
    const scheduled = trigger.kind === "interval" || trigger.kind === "at" ? trigger : null;
    // Manual and on-settled routings register disabled: the job then never
    // fires on a cadence, while dispatch (always reason "manual" to the
    // scheduler) still flows through the same FIFO admission, per-routing
    // non-overlap, suspension, and abort machinery.
    this.#automation.register({
      key: this.#jobKey(routingId),
      schedule: scheduled?.kind === "at"
        ? { kind: "at", at: scheduled.at, ifMissed: scheduled.ifMissed }
        : {
            kind: "interval",
            intervalMinutes: scheduled?.kind === "interval"
              ? scheduled.intervalMinutes
              : workFoldRoutingBounds.minIntervalMinutes,
            catchUp: scheduled?.kind === "interval" ? "latest" : "none",
          },
      enabled: scheduled !== null,
      ...(scheduled?.kind === "interval" && record.lastScheduledAt !== undefined
        ? { lastScheduledAt: record.lastScheduledAt }
        : {}),
      run: (context) => this.#executeRun(context),
    });
  }

  async #finishRecoveredAtOccurrences(records: WorkFoldRoutingRecord[]): Promise<void> {
    const finishedAt = this.#now().toISOString();
    for (const record of records) {
      if (record.health !== "completed" || !record.atOccurrence || record.atOccurrence.finishedAt !== undefined) continue;
      await this.#store.finishAtOccurrence(record.declaration.id, record.atOccurrence.runId, finishedAt);
    }
  }

  async #completeMissedSkips(records: WorkFoldRoutingRecord[]): Promise<void> {
    const now = this.#now();
    for (const record of records) {
      const trigger = record.declaration.trigger;
      if (
        record.health !== "enabled"
        || trigger.kind !== "at"
        || trigger.ifMissed !== "skip"
        || Date.parse(trigger.at) > now.getTime()
      ) continue;
      const runId = `missed-${record.declaration.id}-${Date.parse(trigger.at)}`;
      const claimed = await this.#store.claimAtOccurrence(record.declaration.id, trigger.at, runId, now);
      if (!claimed?.atOccurrence) continue;
      await this.#receipts.append({
        scope: "run",
        outcome: "skipped",
        routingId: record.declaration.id,
        runId,
        title: record.declaration.title,
        digest: record.digest,
        cause: { kind: "resume", slotAt: trigger.at },
        occurrenceId: claimed.atOccurrence.occurrenceId,
        detail: "The one-time occurrence passed while work-fold was unavailable, and this routing is declared to skip a missed slot.",
      });
      await this.#store.finishAtOccurrence(record.declaration.id, runId, now.toISOString());
      this.#disarm(record.declaration.id);
    }
  }

  #disarm(routingId: string): void {
    this.#armed.delete(routingId);
    this.#fileWatches.delete(routingId);
    this.#fileEpoch += 1;
    const key = this.#jobKey(routingId);
    if (this.#automation.has(key)) this.#automation.unregister(key);
  }

  #resetFileWatches(paused = false): void {
    this.#fileEpoch += 1;
    for (const watch of this.#fileWatches.values()) watch.reset(paused);
  }

  async pollFileChanges(): Promise<void> {
    if (this.#closed || this.#suspensionDesired || this.#activeRuns.size || this.#filePollBusy || !this.#observeFiles) return;
    this.#filePollBusy = true;
    const epoch = this.#fileEpoch;
    try {
      for (const [routingId, watch] of this.#fileWatches) {
        const armed = this.#armed.get(routingId);
        if (armed?.trigger.kind !== "files-changed") continue;
        try {
          const snapshot = await this.#observeFiles(armed.trigger);
          if (epoch !== this.#fileEpoch || this.#closed || this.#suspensionDesired || this.#activeRuns.size) return;
          const observed = watch.observe(snapshot, this.#now().getTime(), armed.trigger);
          if (observed !== null) {
            const admission = this.#dispatchAdmission(routingId, {
              kind: "files-changed",
              spaceId: armed.trigger.space,
              snapshotDigest: snapshot.digest,
              changedCount: observed.changedCount,
              changedPaths: observed.changedPaths,
            });
            void admission.result.catch(() => undefined);
          }
        } catch (error) {
          if (epoch !== this.#fileEpoch) return;
          watch.fail(error);
        }
      }
    } finally { this.#filePollBusy = false; }
  }

  #onSettle(record: WorkFoldSettleRecord): void {
    if (this.#closed) return;
    // Routing-caused settles never fire triggers: dropping lineage here is
    // what makes routing chains structurally impossible.
    if (record.lineage) return;
    for (const [routingId, armed] of this.#armed) {
      if (armed.trigger.kind !== "on-settled") continue;
      if (!settleMatchesSource(armed.trigger.source, record)) continue;
      void this.#dispatch(routingId, settleCause(record));
    }
  }

  #dispatch(routingId: string, cause: WorkFoldRoutingRunCause): Promise<WorkFoldAutomationRunResult> {
    return this.#dispatchAdmission(routingId, cause).result;
  }

  #dispatchAdmission(routingId: string, cause: WorkFoldRoutingRunCause): WorkFoldAutomationRunAdmission {
    this.#pendingCause = cause;
    try {
      return this.#automation.runNowAdmission(this.#jobKey(routingId));
    } finally {
      this.#pendingCause = null;
    }
  }

  #takeCause(context: WorkFoldAutomationRunContext): WorkFoldRoutingRunCause {
    const registered = this.#causeByRunId.get(context.runId);
    if (registered) {
      this.#causeByRunId.delete(context.runId);
      return registered;
    }
    if (context.reason === "scheduled" || context.reason === "resume") {
      return { kind: context.reason, slotAt: context.scheduledAt };
    }
    return { kind: "run-now" };
  }

  async #executeRun(context: WorkFoldAutomationRunContext): Promise<void> {
    const routingId = context.key.jobId;
    const runId = context.runId;
    this.#launchedRunIds.add(runId);
    const cause = this.#takeCause(context);

    // Authority is rechecked at the launch boundary, not assumed from the
    // admission: a routing disabled, suspended, or re-enabled at a different
    // digest while this admission waited in the queue must not run under
    // stale authority.
    let record: WorkFoldRoutingRecord | undefined;
    let refusal: string | null = null;
    try {
      record = await this.#store.get(routingId);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    const armed = this.#armed.get(routingId);
    if (refusal === null) {
      if (!record || !armed) refusal = "This routing's enablement was revoked before the run could start.";
      else if (record.digest !== armed.digest) {
        refusal = "This routing's declaration changed before the run could start; an edited routing never coasts on a stale enablement.";
      } else if (record.health !== "enabled") {
        refusal = `This routing is ${record.health}; the admission was skipped.`;
      }
    }
    if (refusal !== null || !record) {
      const detail = refusal ?? "This routing's enablement was revoked before the run could start.";
      await this.#receipts.append({ scope: "run", outcome: "skipped", routingId, runId, cause, detail });
      // The journal's skipped record is the authoritative receipt; throwing
      // keeps the scheduler's own run history from reading "success" for a
      // run that never held authority.
      throw new Error(detail);
    }

    // Journal-first: the accepted record lands before hop 1 executes, and an
    // unwritable journal refuses the run.
    const accepted = await this.#receipts.append({
      scope: "run",
      outcome: "accepted",
      routingId,
      runId,
      title: record.declaration.title,
      digest: record.digest,
      cause,
      ...runReceiptFields(cause, record),
    });
    if (!accepted) {
      throw new Error("work-fold could not journal this routing run, so it was refused before any hop executed.");
    }

    // The accepted receipt is the recoverable intent. Persist the exact
    // occurrence/cadence claim next, still before hop 1, so a process stop
    // cannot replay effects for a slot that already crossed this boundary.
    try {
      if (cause.kind === "scheduled" || cause.kind === "resume") {
        if (record.declaration.trigger.kind === "at") {
          const claimed = await this.#store.claimAtOccurrence(routingId, cause.slotAt, runId, new Date(context.startedAt));
          if (!claimed) {
            const detail = "This one-time routing occurrence was already consumed or no longer holds authority.";
            await this.#receipts.append({ scope: "run", outcome: "skipped", routingId, runId, cause, detail });
            throw new PreHopClaimRefusal(detail);
          }
          record = claimed;
        } else if (record.declaration.trigger.kind === "interval") {
          const claimed = await this.#store.recordCadence(routingId, cause.slotAt);
          if (!claimed) {
            const detail = "This interval routing lost authority before its scheduled slot could be claimed.";
            await this.#receipts.append({ scope: "run", outcome: "skipped", routingId, runId, cause, detail });
            throw new PreHopClaimRefusal(detail);
          }
        }
      }
    } catch (error) {
      if (error instanceof PreHopClaimRefusal) throw error;
      const detail = `The durable schedule claim failed before any hop executed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await this.#receipts.append({
        scope: "run",
        outcome: "failed",
        routingId,
        runId,
        title: record.declaration.title,
        digest: record.digest,
        cause,
        ...runReceiptFields(cause, record),
        detail,
      });
      throw new Error(detail, { cause: error });
    }

    const controller = new AbortController();
    const outerSignal = context.signal;
    const onOuterAbort = () => {
      controller.abort(outerSignal.reason ?? new Error("Routing scheduling aborted this run."));
    };
    let releaseOuterAbort = () => {};
    if (outerSignal.aborted) onOuterAbort();
    else {
      outerSignal.addEventListener("abort", onOuterAbort, { once: true });
      releaseOuterAbort = () => outerSignal.removeEventListener("abort", onOuterAbort);
    }

    let taskId: string | null = null;
    try {
      taskId = this.#tasks?.start({ routingId, runId }).id ?? null;
    } catch {
      taskId = null;
    }
    const active: ActiveRunState = { routingId, runId, controller, stopRequested: false, stoppedHopTaskIds: [] };
    this.#resetFileWatches(true);
    this.#activeRuns.set(runId, active);
    try {
      const summary = await this.#executeHops(record.declaration, active, cause);
      if (summary.kind === "succeeded") {
        await this.#receipts.append({
          scope: "run", outcome: "succeeded", routingId, runId, cause, ...runReceiptFields(cause, record),
        });
        return;
      }
      if (summary.kind === "failed") {
        await this.#receipts.append({
          scope: "run",
          outcome: "failed",
          routingId,
          runId,
          cause,
          failedHopId: summary.failedHopId,
          detail: summary.error,
          ...runReceiptFields(cause, record),
        });
        // There are no retries; the next trigger occurrence is the retry,
        // and the scheduler's run history records the failure too.
        throw new Error(`Routing hop "${summary.failedHopId}" failed: ${summary.error}`);
      }
      if (summary.kind === "stopped") {
        await this.#receipts.append({
          scope: "run",
          outcome: "stopped",
          routingId,
          runId,
          cause,
          ...(active.stoppedHopTaskIds.length ? { stoppedHopTaskIds: [...active.stoppedHopTaskIds] } : {}),
          ...runReceiptFields(cause, record),
          ...(active.stopReceipt ?? {}),
          detail: "The run was stopped; later hops were skipped.",
        });
        throw new Error("Routing run was stopped.");
      }
      await this.#receipts.append({
        scope: "run",
        outcome: "interrupted",
        routingId,
        runId,
        cause,
        ...runReceiptFields(cause, record),
        detail: summary.detail,
      });
    } finally {
      releaseOuterAbort();
      this.#activeRuns.delete(runId);
      this.#resetFileWatches(this.#activeRuns.size > 0 || this.#suspensionDesired);
      if (taskId !== null) {
        try {
          this.#tasks?.finish(taskId);
        } catch {
          // The kernel task is observability; its lifecycle never fails a run.
        }
      }
    }
  }

  async #executeHops(
    declaration: WorkFoldRoutingDeclaration,
    active: ActiveRunState,
    cause: WorkFoldRoutingRunCause,
  ): Promise<RunSummary> {
    const { routingId, runId, controller } = active;
    const chatResults = new Map<string, WorkFoldRoutingChatHopResult>();
    let failure: { hopId: string; error: string } | null = null;
    let halted: { kind: "stopped" } | { kind: "interrupted"; detail: string } | null = null;

    for (const step of declaration.steps) {
      if (failure) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "skipped",
          routingId,
          runId,
          hopId: step.id,
          hopKind: step.kind,
          failedHopId: failure.hopId,
          detail: `Hop "${failure.hopId}" failed, so this hop did not run.`,
        });
        continue;
      }
      if (halted === null && controller.signal.aborted) {
        halted = active.stopRequested
          ? { kind: "stopped" }
          : { kind: "interrupted", detail: abortReasonText(controller.signal.reason) };
      }
      if (halted) {
        await this.#receipts.append({
          scope: "hop",
          outcome: "skipped",
          routingId,
          runId,
          hopId: step.id,
          hopKind: step.kind,
          detail: halted.kind === "stopped"
            ? "The run was stopped before this hop."
            : "The run was interrupted before this hop.",
        });
        continue;
      }

      const hopContext: WorkFoldRoutingHopContext = {
        routingId,
        runId,
        hopId: step.id,
        lineage: { kind: "routing-hop", routingId, routingRunId: runId, hopId: step.id },
        signal: controller.signal,
      };
      const acceptedHop = await this.#receipts.append({
        scope: "hop",
        outcome: "accepted",
        routingId,
        runId,
        hopId: step.id,
        hopKind: step.kind,
        ...hopSpaceFields(step),
      });
      if (!acceptedHop) {
        failure = { hopId: step.id, error: "work-fold could not journal this hop, so it was refused before its mutation." };
        continue;
      }

      try {
        if (step.kind === "chat" || step.kind === "fold") {
          // Placeholders are filled in host-side, after this hop's accepted
          // receipt and before the port is called, from the run's own cause
          // and its earlier hops' host records. A resolution that cannot be
          // proven throws here and fails the hop closed.
          const resolved = await this.#resolveMessage(step, declaration, cause, chatResults);
          const filled: Partial<WorkFoldRoutingReceiptV1> = resolved.placeholders.length
            ? { placeholders: resolved.placeholders, messageBytes: resolved.bytes }
            : {};
          let result: WorkFoldRoutingChatHopResult | WorkFoldRoutingFoldHopResult;
          let evidence: Partial<WorkFoldRoutingReceiptV1>;
          if (step.kind === "chat") {
            const chat = await this.#ports.chat(step, resolved.message, hopContext);
            chatResults.set(step.id, chat);
            result = chat;
            evidence = {
              spaceId: step.space,
              conversationId: chat.conversationId,
              taskId: chat.turnTaskId,
              ...(chat.preCheckpointId !== undefined && chat.postCheckpointId !== undefined
                ? { checkpointIds: [chat.preCheckpointId, chat.postCheckpointId] }
                : {}),
            };
          } else {
            const fold = await this.#ports.fold(step, resolved.message, hopContext);
            result = fold;
            evidence = { conversationId: fold.conversationId, taskId: fold.turnTaskId };
          }
          if (result.outcome === "succeeded") {
            await this.#receipts.append({
              scope: "hop", outcome: "succeeded", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
            });
          } else if (result.outcome === "aborted" && active.stopRequested) {
            active.stoppedHopTaskIds.push(result.turnTaskId);
            await this.#receipts.append({
              scope: "hop", outcome: "stopped", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
            });
            halted = { kind: "stopped" };
          } else if (result.outcome === "aborted" && controller.signal.aborted) {
            await this.#receipts.append({
              scope: "hop", outcome: "interrupted", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled,
            });
            halted = { kind: "interrupted", detail: abortReasonText(controller.signal.reason) };
          } else {
            const error = result.error ?? (step.kind === "chat"
              ? `The Space Assistant turn settled ${result.outcome}.`
              : `The fold's turn settled ${result.outcome}.`);
            await this.#receipts.append({
              scope: "hop", outcome: "failed", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, ...filled, detail: error,
            });
            failure = { hopId: step.id, error };
          }
        } else if (step.kind === "files") {
          const resolved = await this.#resolveFilesSource(step, chatResults);
          if (resolved.kind === "empty") {
            await this.#receipts.append({
              scope: "hop",
              outcome: "succeeded",
              routingId,
              runId,
              hopId: step.id,
              hopKind: step.kind,
              fromSpaceId: step.fromSpace,
              toSpaceId: step.toSpace,
              fileCount: 0,
              totalBytes: 0,
              copiedPaths: [],
              detail: resolved.detail,
            });
          } else {
            const result = await this.#ports.files(step, resolved.source, hopContext);
            await this.#receipts.append({
              scope: "hop",
              outcome: "succeeded",
              routingId,
              runId,
              hopId: step.id,
              hopKind: step.kind,
              fromSpaceId: step.fromSpace,
              toSpaceId: step.toSpace,
              ...(resolved.source.kind === "paths" ? { sourcePaths: [...resolved.source.paths] } : {}),
              copiedPaths: [...result.copiedPaths],
              fileCount: result.fileCount,
              totalBytes: result.totalBytes,
              ...(result.restorePointId !== undefined ? { restorePointId: result.restorePointId } : {}),
            });
          }
        } else {
          const result = await this.#ports.check(step, hopContext);
          const evidence = {
            spaceId: step.space,
            checkRunId: result.runId,
            taskId: result.taskId,
            checkIds: [...result.checkIds],
            findingCount: result.findingCount,
            admittedCount: result.admittedCount,
          };
          if (result.state === "succeeded") {
            // Findings are content state for the person; glue is not a gate.
            await this.#receipts.append({
              scope: "hop", outcome: "succeeded", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
          } else if (result.state === "aborted" && active.stopRequested) {
            active.stoppedHopTaskIds.push(result.taskId);
            await this.#receipts.append({
              scope: "hop", outcome: "stopped", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
            halted = { kind: "stopped" };
          } else {
            const error = result.error ?? `The Check run settled ${result.state}.`;
            await this.#receipts.append({
              scope: "hop", outcome: "failed", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, detail: error,
            });
            failure = { hopId: step.id, error };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted && active.stopRequested) {
          await this.#receipts.append({
            scope: "hop", outcome: "stopped", routingId, runId, hopId: step.id, hopKind: step.kind, ...hopSpaceFields(step), detail: message,
          });
          halted = { kind: "stopped" };
        } else if (controller.signal.aborted) {
          await this.#receipts.append({
            scope: "hop", outcome: "interrupted", routingId, runId, hopId: step.id, hopKind: step.kind, ...hopSpaceFields(step), detail: message,
          });
          halted = { kind: "interrupted", detail: message };
        } else {
          // Infrastructure refusals inside a hop — a capability mutation
          // fence, a Check reservation conflict — fail the hop with the
          // typed reason; they are glue health, never silently skipped work.
          await this.#receipts.append({
            scope: "hop", outcome: "failed", routingId, runId, hopId: step.id, hopKind: step.kind, ...hopSpaceFields(step), detail: message,
          });
          failure = { hopId: step.id, error: message };
        }
      }
    }

    if (failure) return { kind: "failed", failedHopId: failure.hopId, error: failure.error };
    if (halted) return halted;
    return { kind: "succeeded" };
  }

  /**
   * Fills the closed placeholder set into one chat- or fold-step message.
   * Resolution is by the run's own cause, never by the declared trigger: a
   * run-now on a folder-change routing says so in plain words instead of
   * pretending files changed. Versions 1–3 are never scanned — their
   * messages are literal text, braces included.
   */
  async #resolveMessage(
    step: WorkFoldRoutingChatStep | WorkFoldRoutingFoldStep,
    declaration: WorkFoldRoutingDeclaration,
    cause: WorkFoldRoutingRunCause,
    chatResults: Map<string, WorkFoldRoutingChatHopResult>,
  ): Promise<{ message: string; bytes: number; placeholders: WorkFoldRoutingReceiptPlaceholder[] }> {
    const literal = () => ({
      message: step.message,
      bytes: Buffer.byteLength(step.message, "utf8"),
      placeholders: [] as WorkFoldRoutingReceiptPlaceholder[],
    });
    if (declaration.version < 4) return literal();
    const occurrences = workFoldRoutingMessagePlaceholders(step.message, `Routing step "${step.id}"`);
    if (!occurrences.length) return literal();
    const texts = new Map<string, { text: string; truncated: boolean }>();
    for (const placeholder of occurrences) {
      if (texts.has(placeholder.name)) continue;
      texts.set(placeholder.name, await this.#placeholderText(placeholder, declaration, cause, chatResults));
    }
    const message = step.message.replace(
      /\{\{([^{}]*)\}\}/g,
      (match, inner: string) => texts.get(inner.trim())?.text ?? match,
    );
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > workFoldRoutingBounds.maxResolvedMessageBytes) {
      throw new Error(
        `The filled-in message would exceed the ${workFoldRoutingBounds.maxResolvedMessageBytes / 1024} KiB limit for one step.`,
      );
    }
    return {
      message,
      bytes,
      placeholders: [...texts].map(([name, value]) => ({
        name,
        text: value.text,
        bytes: Buffer.byteLength(value.text, "utf8"),
        truncated: value.truncated,
      })),
    };
  }

  /**
   * One placeholder's text. Nothing here parses model output: the summary and
   * changed paths come from the run cause the host recorded, findings come
   * from the settled Check run's own record, and created files come from the
   * source chat hop's History checkpoint pair.
   */
  async #placeholderText(
    placeholder: WorkFoldRoutingPlaceholder,
    declaration: WorkFoldRoutingDeclaration,
    cause: WorkFoldRoutingRunCause,
    chatResults: Map<string, WorkFoldRoutingChatHopResult>,
  ): Promise<{ text: string; truncated: boolean }> {
    if (placeholder.name === "trigger.summary") {
      return { text: causeSummary(cause, declaration), truncated: false };
    }
    if (placeholder.name === "trigger.changedFiles") {
      if (cause.kind !== "files-changed") {
        return { text: `(no changed files: ${causeClause(cause)})`, truncated: false };
      }
      const paths = cause.changedPaths ?? [];
      return paths.length ? boundedPlaceholderList(paths) : { text: "(no changed files)", truncated: false };
    }
    if (placeholder.name === "trigger.findings") {
      if (cause.kind !== "on-settled" || cause.source.kind !== "check-run") {
        return { text: "(no findings: this run was not started by a Check run)", truncated: false };
      }
      const unreadable = "The Check run's findings could not be read, so {{trigger.findings}} cannot be filled in.";
      const taskId = cause.source.taskId;
      if (taskId === undefined) throw new Error(unreadable);
      let read: WorkFoldRoutingCheckRunFindings | null;
      try {
        read = await this.#ports.checkRunFindings(cause.source.spaceId, taskId);
      } catch (error) {
        throw new Error(unreadable, { cause: error });
      }
      if (!read) throw new Error(unreadable);
      if (!read.findings.length) return { text: "(no findings)", truncated: false };
      return boundedPlaceholderList(read.findings.map(
        (finding) => `- [${finding.severity}] ${finding.title} — ${finding.targetPath} (${finding.checkId})`,
      ));
    }
    const sourceStepId = placeholder.step!;
    const source = declaration.steps.find((candidate) => candidate.id === sourceStepId);
    if (source?.kind !== "chat") {
      throw new Error(`Routing step "${sourceStepId}" is not a chat step, so its created files cannot be filled in.`);
    }
    const created = await this.#createdFiles(sourceStepId, source.space, chatResults);
    return created.length
      ? boundedPlaceholderList(created.map((file) => file.path))
      : { text: "(no files created)", truncated: false };
  }

  async #resolveFilesSource(
    step: WorkFoldRoutingFilesStep,
    chatResults: Map<string, WorkFoldRoutingChatHopResult>,
  ): Promise<{ kind: "source"; source: WorkFoldRoutingResolvedFilesSource } | { kind: "empty"; detail: string }> {
    if (step.from.kind === "paths") {
      return { kind: "source", source: { kind: "paths", paths: [...step.from.paths] } };
    }
    if (step.from.kind === "tree") {
      return {
        kind: "source",
        source: { kind: "tree", path: step.from.path, recursive: step.from.recursive, extensions: [...step.from.extensions] },
      };
    }
    const paths = await this.#resolveCreatedFiles(step, step.from, chatResults);
    if (paths.length === 0) {
      return { kind: "empty", detail: "The source chat step's turn created or changed no files matching this handoff." };
    }
    return { kind: "source", source: { kind: "paths", paths } };
  }

  /**
   * The declared created-files handoff, resolved host-side and
   * deterministically: the manifest diff between the source chat hop's own
   * pre/post-turn History checkpoints, filtered by the declared bounds. No
   * model output is parsed — the file set comes from host-recorded
   * content-addressed identity — and every gap fails the hop closed: a
   * partial handoff is never silently delivered.
   */
  async #resolveCreatedFiles(
    step: WorkFoldRoutingFilesStep,
    source: WorkFoldRoutingStepCreatedFilesSource,
    chatResults: Map<string, WorkFoldRoutingChatHopResult>,
  ): Promise<string[]> {
    const created = await this.#createdFiles(source.step, step.fromSpace, chatResults, source.extensions);
    if (created.length > source.maxFiles) {
      throw new Error(
        `The turn created or changed ${created.length} matching files, more than this handoff's bound of ${source.maxFiles}.`,
      );
    }
    const totalBytes = created.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalBytes > source.maxTotalBytes) {
      throw new Error(
        `The turn's matching files total ${totalBytes} bytes, more than this handoff's bound of ${source.maxTotalBytes}.`,
      );
    }
    return created.map((file) => file.path);
  }

  /**
   * The manifest diff itself, shared by the declared files handoff and the
   * `{{steps.<id>.createdFiles}}` placeholder: sorted paths with their sizes,
   * fail-closed on every gap.
   */
  async #createdFiles(
    sourceStepId: string,
    spaceId: string,
    chatResults: Map<string, WorkFoldRoutingChatHopResult>,
    extensions?: string[],
  ): Promise<WorkFoldRoutingCheckpointManifestEntry[]> {
    const chat = chatResults.get(sourceStepId);
    if (!chat || chat.outcome !== "succeeded") {
      throw new Error(`The created-files handoff needs chat hop "${sourceStepId}" to have succeeded in this run.`);
    }
    if (chat.preCheckpointId === undefined || chat.postCheckpointId === undefined) {
      throw new Error(
        `Chat hop "${sourceStepId}" did not record its pre/post-turn checkpoint pair, so the created files cannot be resolved.`,
      );
    }
    const pre = await this.#ports.checkpointManifest(spaceId, chat.preCheckpointId);
    const post = await this.#ports.checkpointManifest(spaceId, chat.postCheckpointId);
    if (!pre || !post) {
      const missing = !pre ? chat.preCheckpointId : chat.postCheckpointId;
      throw new Error(`Checkpoint ${missing} is missing from the source Space's History, so the created files cannot be resolved.`);
    }
    const matches = (path: string): boolean => {
      if (!extensions || extensions.length === 0) return true;
      const lowered = path.toLocaleLowerCase("en-US");
      return extensions.some((extension) => lowered.endsWith(extension));
    };
    for (const [label, manifest] of [["pre-turn", pre], ["post-turn", post]] as const) {
      const skipped = manifest.skippedFilePaths.filter(matches);
      if (skipped.length) {
        throw new Error(
          `The ${label} checkpoint skipped ${skipped.length} file(s) matching this handoff (first: ${skipped[0]}), `
            + "so the created files cannot be proven complete.",
        );
      }
    }
    const before = new Map(pre.files.map((file) => [file.path, file.hashSha256]));
    return post.files
      .filter((file) => matches(file.path) && before.get(file.path) !== file.hashSha256)
      .map((file) => ({ ...file }))
      .sort((left, right) => compareRoutingStrings(left.path, right.path));
  }

  async #onAutomationResult(result: WorkFoldAutomationRunResult): Promise<void> {
    const routingId = result.key.jobId;
    const registeredCause = this.#causeByRunId.get(result.runId);
    this.#causeByRunId.delete(result.runId);
    const launched = this.#launchedRunIds.delete(result.runId);
    if (!launched) {
      // Admissions that never launched — per-routing non-overlap, suspension,
      // disable, unregistration, close — settle skipped and are receipted as
      // such, naming the cause that admitted them.
      const cause: WorkFoldRoutingRunCause = registeredCause
        ?? (result.reason === "scheduled" || result.reason === "resume"
          ? { kind: result.reason, slotAt: result.scheduledAt }
          : { kind: "run-now" });
      let occurrenceId: string | undefined;
      const armed = this.#armed.get(routingId);
      const record = await this.#store.get(routingId).catch(() => undefined);
      const catchUpSurvivesLifecyclePause = (
        result.notLaunchedReason === "suspended"
        || result.notLaunchedReason === "closed"
      ) && (cause.kind === "scheduled" || cause.kind === "resume") && (
        record?.declaration.trigger.kind === "interval"
        || (record?.declaration.trigger.kind === "at" && record.declaration.trigger.ifMissed === "run")
      );
      const oneTimeSlotSurvivesManualOverlap = result.notLaunchedReason === "overlap"
        && (cause.kind === "scheduled" || cause.kind === "resume")
        && record?.declaration.trigger.kind === "at";
      if (catchUpSurvivesLifecyclePause || oneTimeSlotSurvivesManualOverlap) {
        await this.#receipts.append({
          scope: "run",
          outcome: "skipped",
          routingId,
          runId: result.runId,
          cause,
          detail: oneTimeSlotSurvivesManualOverlap
            ? `${result.error ?? "The admission paused before launch."} The one-time slot remains pending until the manual copy settles.`
            : `${result.error ?? "The admission paused before launch."} Its durable schedule remains eligible for catch-up.`,
        });
        return;
      }
      if (
        armed
        && record?.health === "enabled"
        && record.digest === armed.digest
        && (cause.kind === "scheduled" || cause.kind === "resume")
        && (record.declaration.trigger.kind === "at" || record.declaration.trigger.kind === "interval")
      ) {
        const accepted = await this.#receipts.append({
          scope: "run",
          outcome: "accepted",
          routingId,
          runId: result.runId,
          title: record.declaration.title,
          digest: record.digest,
          cause,
        });
        if (accepted && record.declaration.trigger.kind === "at") {
          const claimed = await this.#store.claimAtOccurrence(routingId, cause.slotAt, result.runId, new Date(result.startedAt));
          occurrenceId = claimed?.atOccurrence?.occurrenceId;
        } else if (accepted) {
          await this.#store.recordCadence(routingId, cause.slotAt);
        }
      }
      await this.#receipts.append({
        scope: "run",
        outcome: "skipped",
        routingId,
        runId: result.runId,
        cause,
        ...(occurrenceId !== undefined ? { occurrenceId } : {}),
        detail: result.error ?? `The admission settled ${result.outcome} before launch.`,
      });
      if (occurrenceId !== undefined) {
        await this.#store.finishAtOccurrence(routingId, result.runId, result.finishedAt);
        this.#disarm(routingId);
      }
      return;
    }
    if (result.reason !== "manual") {
      const record = await this.#store.get(routingId).catch(() => undefined);
      if (record?.health === "completed" && record.atOccurrence?.runId === result.runId) {
        await this.#store.finishAtOccurrence(routingId, result.runId, result.finishedAt);
        this.#disarm(routingId);
      }
    }
  }

  #assertOperational(): void {
    if (this.#closed) {
      throw new WorkFoldRoutingServiceError("SERVICE_DAMAGED", "The routing executor is closed.");
    }
    if (this.#journalDamageReason !== null) {
      throw new WorkFoldRoutingServiceError(
        "SERVICE_DAMAGED",
        `work-fold cannot arm or run routings: ${this.#journalDamageReason} Disable, suspension, and deletion remain available.`,
      );
    }
  }
}

function hopSpaceFields(
  step: WorkFoldRoutingStep,
): { spaceId: string } | { fromSpaceId: string; toSpaceId: string } | Record<string, never> {
  if (step.kind === "files") return { fromSpaceId: step.fromSpace, toSpaceId: step.toSpace };
  // A fold hop names no Space: the management conversation sits above them.
  return step.kind === "fold" ? {} : { spaceId: step.space };
}

function settleMatchesSource(source: WorkFoldRoutingSettleSource, record: WorkFoldSettleRecord): boolean {
  if (source.kind === "check-run") {
    return record.kind === "check-run"
      && record.spaceId === source.space
      && (source.check === undefined || record.checkIds.includes(source.check))
      && (source.outcomes as readonly string[]).includes(record.state);
  }
  return record.kind === "app-automation-run"
    && record.spaceId === source.space
    && record.appId === source.appId
    && record.automationId === source.automationId
    && (source.outcomes as readonly string[]).includes(record.outcome);
}

function settleCause(record: WorkFoldSettleRecord): WorkFoldRoutingRunCause {
  if (record.kind === "check-run") {
    return {
      kind: "on-settled",
      source: {
        kind: "check-run",
        spaceId: record.spaceId,
        runId: record.runId,
        state: record.state,
        checkIds: [...record.checkIds],
        // The Check task id is how `{{trigger.findings}}` reads the settled
        // run's own findings back from the host.
        taskId: record.taskId,
      },
    };
  }
  return {
    kind: "on-settled",
    source: {
      kind: "app-automation-run",
      spaceId: record.spaceId,
      appId: record.appId,
      automationId: record.automationId,
      runId: record.runId,
      outcome: record.outcome,
    },
  };
}

function compareRoutingStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Room for the "… and n more" marker inside the per-placeholder byte bound. */
const placeholderMarkerAllowanceBytes = 96;

/**
 * One filled-in list placeholder, cut at a line boundary. Every cut names the
 * limit that actually bit, so a person reading the message knows the list is
 * short because work-fold stopped, not because the work did.
 */
function boundedPlaceholderList(rawLines: string[]): { text: string; truncated: boolean } {
  const maxItems = workFoldRoutingBounds.maxPlaceholderListItems;
  const maxBytes = workFoldRoutingBounds.maxPlaceholderTextBytes;
  // Placeholder text is host-supplied, not declared: a pre-existing file named
  // with a direction override would otherwise carry a character the
  // declaration contract forbids into the message the destination receives —
  // and the hop receipt, which replaces the same class, would then disagree
  // with what was actually sent. Filtering here keeps the two identical.
  const lines = rawLines.map((line) => scrubWorkFoldRoutingMessageText(line));
  const kept: string[] = [];
  let bytes = 0;
  let byteLimited = false;
  for (const line of lines.slice(0, maxItems)) {
    const cost = Buffer.byteLength(line, "utf8") + (kept.length ? 1 : 0);
    if (bytes + cost > maxBytes - placeholderMarkerAllowanceBytes) {
      byteLimited = true;
      break;
    }
    kept.push(line);
    bytes += cost;
  }
  const omitted = lines.length - kept.length;
  if (omitted <= 0) return { text: kept.join("\n"), truncated: false };
  const limit = byteLimited ? `${maxBytes / 1024} KiB` : `${maxItems}-item`;
  return {
    text: [...kept, `… and ${omitted} more (${limit} limit for one filled-in placeholder)`].join("\n"),
    truncated: true,
  };
}

/** `{{trigger.summary}}`: what actually started this run, in one sentence. */
function causeSummary(cause: WorkFoldRoutingRunCause, declaration: WorkFoldRoutingDeclaration): string {
  switch (cause.kind) {
    case "run-now":
      return "Started by hand.";
    case "scheduled":
      return `Scheduled run for ${cause.slotAt}.`;
    case "resume":
      return `Caught-up run for the ${cause.slotAt} slot.`;
    case "files-changed": {
      const watched = declaration.trigger.kind === "files-changed" ? declaration.trigger.watch.path : "the watched folder";
      return `${cause.changedCount} file(s) changed under "${watched}" in Space ${cause.spaceId}.`;
    }
    default:
      return cause.source.kind === "check-run"
        ? `Check run ${cause.source.runId} in Space ${cause.source.spaceId} settled ${cause.source.state}`
          + ` (Checks: ${cause.source.checkIds.join(", ")}).`
        : `App automation ${cause.source.appId}/${cause.source.automationId} in Space ${cause.source.spaceId}`
          + ` settled ${cause.source.outcome}.`;
  }
}

/** Why a placeholder has nothing to fill in for this run, in the same sentence. */
function causeClause(cause: WorkFoldRoutingRunCause): string {
  switch (cause.kind) {
    case "run-now":
      return "this run was started by hand";
    case "scheduled":
      return "this was a scheduled run";
    case "resume":
      return "this was a caught-up run";
    case "files-changed":
      return "this run was started by a folder change";
    default:
      return "this run was started by a settled run";
  }
}

function abortReasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "The run was aborted.";
}

function runReceiptFields(
  cause: WorkFoldRoutingRunCause,
  record: WorkFoldRoutingRecord,
): Pick<WorkFoldRoutingActionReceiptContext, "requestId" | "surface"> & { occurrenceId?: string } {
  return {
    ...(cause.kind === "run-now" && cause.requestId !== undefined ? { requestId: cause.requestId } : {}),
    ...(cause.kind === "run-now" && cause.surface !== undefined ? { surface: cause.surface } : {}),
    ...(record.atOccurrence?.runId !== undefined
      ? { occurrenceId: record.atOccurrence.occurrenceId }
      : record.declaration.trigger.kind === "at" && (cause.kind === "scheduled" || cause.kind === "resume")
        ? {
          occurrenceId: workFoldRoutingAtOccurrenceId(
            record.declaration.id,
            record.digest,
            cause.slotAt,
          ),
        }
        : {}),
  };
}
