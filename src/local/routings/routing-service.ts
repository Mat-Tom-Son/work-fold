import { randomUUID } from "node:crypto";

import {
  WorkFoldAutomationService,
  type WorkFoldAutomationClock,
  type WorkFoldAutomationJobKey,
  type WorkFoldAutomationRunContext,
  type WorkFoldAutomationRunResult,
} from "../agent/work-fold-automation-service.js";
import {
  workFoldRoutingBounds,
  type WorkFoldRoutingChatStep,
  type WorkFoldRoutingCheckStep,
  type WorkFoldRoutingDeclaration,
  type WorkFoldRoutingFilesStep,
  type WorkFoldRoutingSettleSource,
  type WorkFoldRoutingStepCreatedFilesSource,
  type WorkFoldRoutingTrigger,
} from "./routing-declarations.js";
import {
  type WorkFoldRoutingEnableInput,
  type WorkFoldRoutingHealth,
  type WorkFoldRoutingReceipts,
  type WorkFoldRoutingRecord,
  type WorkFoldRoutingRunCause,
  type WorkFoldRoutingStore,
} from "./routing-store.js";
import type {
  WorkFoldRoutingHopLineage,
  WorkFoldSettleRecord,
  WorkFoldSettleSignal,
} from "./settle-signal.js";

/**
 * The routing executor (docs/fold-routings.md): deterministic app code that
 * evaluates triggers over settle signals and the bounded schedule, admits
 * runs through its own two-slot FIFO scheduler instance, executes at most
 * eight reviewed hops strictly in order, and writes journal-first receipts
 * for every run and hop. There is no model call anywhere in this module:
 * agentic work happens only inside a Space Chat hop, run by that Space's own
 * Assistant through the injected ports, and the executor appends no ambient
 * context to anything it dispatches.
 *
 * The service owns its own `WorkFoldAutomationService` instance — the same
 * proven class the restricted-app scheduler uses, deliberately a separate
 * budget so one Space app's jobs can never starve cross-Space glue (and vice
 * versa), and a separate suspend/resume/close lifecycle so the two authority
 * domains stay uncoupled.
 */
export const workFoldRoutingAutomationOwnerId = "work-fold.routing";

/** Machine-wide concurrent routing runs; FIFO beyond it, per the scheduler default. */
export const workFoldRoutingMaxConcurrentRuns = 2;

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
  error?: string;
  preCheckpointId?: string;
  postCheckpointId?: string;
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
 * evidence, never content: the executor journals identifiers, paths, and
 * counts only.
 */
export interface WorkFoldRoutingHopPorts {
  chat(step: WorkFoldRoutingChatStep, context: WorkFoldRoutingHopContext): Promise<WorkFoldRoutingChatHopResult>;
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
}

export interface WorkFoldRoutingProjection extends WorkFoldRoutingRecord {
  nextScheduledAt?: string;
}

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
}

type RunSummary =
  | { kind: "succeeded" }
  | { kind: "failed"; failedHopId: string; error: string }
  | { kind: "stopped" }
  | { kind: "interrupted"; detail: string };

const causeMapGuard = 256;

export class WorkFoldRoutingService {
  readonly #store: WorkFoldRoutingStore;
  readonly #receipts: WorkFoldRoutingReceipts;
  readonly #ports: WorkFoldRoutingHopPorts;
  readonly #tasks: WorkFoldRoutingRunTaskPort | null;
  readonly #automation: WorkFoldAutomationService;
  readonly #armed = new Map<string, ArmedRouting>();
  readonly #causeByRunId = new Map<string, WorkFoldRoutingRunCause>();
  readonly #launchedRunIds = new Set<string>();
  readonly #activeRuns = new Map<string, ActiveRunState>();
  readonly #recoveredRunIds: string[] = [];
  #stagedCause: WorkFoldRoutingRunCause | null = null;
  #unsubscribeSettle: (() => void) | null = null;
  #journalDamageReason: string | null = null;
  #closed = false;

  private constructor(options: WorkFoldRoutingServiceOptions) {
    this.#store = options.store;
    this.#receipts = options.store.receipts;
    this.#ports = options.ports;
    this.#tasks = options.tasks ?? null;
    const createRunId = options.createRunId ?? randomUUID;
    this.#automation = new WorkFoldAutomationService({
      maxConcurrency: options.maxConcurrency ?? workFoldRoutingMaxConcurrentRuns,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.catchUpStagger ? { catchUpStagger: options.catchUpStagger } : {}),
      // The scheduler mints exactly one run id per admission, synchronously
      // inside the admission call. Binding the staged trigger cause to that
      // id here — instead of to a per-routing slot — makes attribution exact
      // even when an admission waits in the FIFO queue behind a full budget.
      createRunId: () => {
        const runId = createRunId();
        const staged = this.#stagedCause;
        this.#stagedCause = null;
        if (staged) {
          if (this.#causeByRunId.size >= causeMapGuard) {
            const oldest = this.#causeByRunId.keys().next().value;
            if (oldest !== undefined) this.#causeByRunId.delete(oldest);
          }
          this.#causeByRunId.set(runId, staged);
        }
        return runId;
      },
      onResult: (result) => this.#onAutomationResult(result),
    });
  }

  static async create(options: WorkFoldRoutingServiceOptions): Promise<WorkFoldRoutingService> {
    const service = new WorkFoldRoutingService(options);
    await service.#initialize(options.settleSignal);
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
   * Commits a consecrated enablement and arms the routing. Replacing an
   * already-enabled routing (an edit that went back through a fresh
   * consecration) first stops any run still executing under the prior
   * digest: revocation stops stale work before the authority change reads
   * as complete.
   */
  async enable(input: WorkFoldRoutingEnableInput): Promise<WorkFoldRoutingRecord> {
    this.#assertOperational();
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
  async disable(routingId: string): Promise<{ record: WorkFoldRoutingRecord; stoppedRunId: string | null }> {
    const record = await this.#store.disable(routingId);
    const stopped = this.stopRun(routingId);
    this.#disarm(routingId);
    return { record, stoppedRunId: stopped?.runId ?? null };
  }

  /** Deletes a disabled or suspended routing; receipts are retained by the store. */
  async deleteRouting(routingId: string): Promise<WorkFoldRoutingRecord> {
    const record = await this.#store.delete(routingId);
    this.#disarm(routingId);
    return record;
  }

  /**
   * Manual run-now for an enabled routing: receipted, never a schedule
   * mutation. A merely proposed routing is refused — the executor never runs
   * an unreviewed standing declaration, even once.
   */
  async runNow(routingId: string, options: { requestId?: string } = {}): Promise<WorkFoldAutomationRunResult> {
    this.#assertOperational();
    const record = await this.#store.get(routingId);
    if (!record) {
      throw new WorkFoldRoutingServiceError(
        "NOT_FOUND",
        "No routing has this id. A proposal holds no authority; enablement binds a person's review to the exact declaration digest before anything runs.",
      );
    }
    if (record.health !== "enabled") {
      throw new WorkFoldRoutingServiceError(
        "HEALTH_INVALID",
        record.health === "suspended"
          ? "This routing is suspended because a referenced Space was removed; re-enablement is a fresh consecration."
          : "This routing is disabled; re-enablement is a fresh consecration.",
        { health: record.health },
      );
    }
    const cause: WorkFoldRoutingRunCause = {
      kind: "run-now",
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    };
    return await this.#dispatch(routingId, cause);
  }

  /**
   * Stops this routing's active run by aborting the current hop through the
   * run's own controller; the hop's domain honors the signal on its own abort
   * path, later hops are recorded skipped, and the run settles `stopped`.
   * Returns null when no run is active — a settled run refuses stop with its
   * terminal state at the verb layer.
   */
  stopRun(routingId: string): { runId: string } | null {
    const active = [...this.#activeRuns.values()].find((run) => run.routingId === routingId);
    if (!active) return null;
    active.stopRequested = true;
    active.controller.abort(new Error("Routing run was stopped."));
    return { runId: active.runId };
  }

  /**
   * Space-removal revocation: every enabled routing referencing the removed
   * Space is suspended with the missing Space id recorded (durable, in the
   * store), its active run is stopped, and its schedule is disarmed. A
   * suspended routing never runs, never retargets, and never resumes
   * automatically; re-enablement is a fresh consecration. With a damaged
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
    this.#automation.suspend();
  }

  resume(): void {
    this.#automation.resume();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeSettle?.();
    this.#unsubscribeSettle = null;
    this.#automation.close();
  }

  async #initialize(settleSignal?: WorkFoldSettleSignal): Promise<void> {
    if (!this.#store.status().damaged) {
      await this.#recoverInterruptedRuns();
      if (this.#journalDamageReason === null) {
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
    }
  }

  #project(record: WorkFoldRoutingRecord): WorkFoldRoutingProjection {
    const next = this.#automation.nextScheduledAt(this.#jobKey(record.declaration.id));
    return { ...record, ...(next !== undefined ? { nextScheduledAt: next } : {}) };
  }

  #jobKey(routingId: string): WorkFoldAutomationJobKey {
    return { ownerId: workFoldRoutingAutomationOwnerId, jobId: routingId };
  }

  #arm(record: WorkFoldRoutingRecord): void {
    const routingId = record.declaration.id;
    const trigger = record.declaration.trigger;
    this.#armed.set(routingId, {
      digest: record.digest,
      title: record.declaration.title,
      trigger: structuredClone(trigger),
    });
    const interval = trigger.kind === "interval" ? trigger : null;
    // Manual and on-settled routings register disabled: the job then never
    // fires on a cadence, while dispatch (always reason "manual" to the
    // scheduler) still flows through the same FIFO admission, per-routing
    // non-overlap, suspension, and abort machinery.
    this.#automation.register({
      key: this.#jobKey(routingId),
      intervalMinutes: interval ? interval.intervalMinutes : workFoldRoutingBounds.minIntervalMinutes,
      enabled: interval !== null,
      catchUp: interval ? "latest" : "none",
      ...(interval && record.lastScheduledAt !== undefined ? { lastScheduledAt: record.lastScheduledAt } : {}),
      run: (context) => this.#executeRun(context),
    });
  }

  #disarm(routingId: string): void {
    this.#armed.delete(routingId);
    const key = this.#jobKey(routingId);
    if (this.#automation.has(key)) this.#automation.unregister(key);
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
    this.#stagedCause = cause;
    try {
      return this.#automation.runNow(this.#jobKey(routingId));
    } finally {
      this.#stagedCause = null;
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
    // admission: a routing disabled, suspended, or re-consecrated while this
    // admission waited in the queue must not run under stale authority.
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
      else if (record.health !== "enabled") refusal = `This routing is ${record.health}; the admission was skipped.`;
      else if (record.digest !== armed.digest) {
        refusal = "This routing's declaration changed before the run could start; an edited routing never coasts on a stale approval.";
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
    });
    if (!accepted) {
      throw new Error("work-fold could not journal this routing run, so it was refused before any hop executed.");
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
    this.#activeRuns.set(runId, active);
    try {
      const summary = await this.#executeHops(record.declaration, active);
      if (summary.kind === "succeeded") {
        await this.#receipts.append({ scope: "run", outcome: "succeeded", routingId, runId, cause });
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
        detail: summary.detail,
      });
    } finally {
      releaseOuterAbort();
      this.#activeRuns.delete(runId);
      if (taskId !== null) {
        try {
          this.#tasks?.finish(taskId);
        } catch {
          // The kernel task is observability; its lifecycle never fails a run.
        }
      }
    }
  }

  async #executeHops(declaration: WorkFoldRoutingDeclaration, active: ActiveRunState): Promise<RunSummary> {
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
        if (step.kind === "chat") {
          const result = await this.#ports.chat(step, hopContext);
          chatResults.set(step.id, result);
          const evidence = {
            spaceId: step.space,
            conversationId: result.conversationId,
            taskId: result.turnTaskId,
            ...(result.preCheckpointId !== undefined && result.postCheckpointId !== undefined
              ? { checkpointIds: [result.preCheckpointId, result.postCheckpointId] }
              : {}),
          };
          if (result.outcome === "succeeded") {
            await this.#receipts.append({
              scope: "hop", outcome: "succeeded", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
          } else if (result.outcome === "aborted" && active.stopRequested) {
            active.stoppedHopTaskIds.push(result.turnTaskId);
            await this.#receipts.append({
              scope: "hop", outcome: "stopped", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
            halted = { kind: "stopped" };
          } else if (result.outcome === "aborted" && controller.signal.aborted) {
            await this.#receipts.append({
              scope: "hop", outcome: "interrupted", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence,
            });
            halted = { kind: "interrupted", detail: abortReasonText(controller.signal.reason) };
          } else {
            const error = result.error ?? `The Space Assistant turn settled ${result.outcome}.`;
            await this.#receipts.append({
              scope: "hop", outcome: "failed", routingId, runId, hopId: step.id, hopKind: step.kind, ...evidence, detail: error,
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
    const chat = chatResults.get(source.step);
    if (!chat || chat.outcome !== "succeeded") {
      throw new Error(`The created-files handoff needs chat hop "${source.step}" to have succeeded in this run.`);
    }
    if (chat.preCheckpointId === undefined || chat.postCheckpointId === undefined) {
      throw new Error(
        `Chat hop "${source.step}" did not record its pre/post-turn checkpoint pair, so the created files cannot be resolved.`,
      );
    }
    const pre = await this.#ports.checkpointManifest(step.fromSpace, chat.preCheckpointId);
    const post = await this.#ports.checkpointManifest(step.fromSpace, chat.postCheckpointId);
    if (!pre || !post) {
      const missing = !pre ? chat.preCheckpointId : chat.postCheckpointId;
      throw new Error(`Checkpoint ${missing} is missing from the source Space's History, so the created files cannot be resolved.`);
    }
    const extensions = source.extensions;
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
    const created = post.files.filter((file) => matches(file.path) && before.get(file.path) !== file.hashSha256);
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
    return created.map((file) => file.path).sort();
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
      await this.#receipts.append({
        scope: "run",
        outcome: "skipped",
        routingId,
        runId: result.runId,
        cause,
        detail: result.error ?? `The admission settled ${result.outcome} before launch.`,
      });
      return;
    }
    if (result.reason !== "manual") {
      // Durable cadence: the anchor advances to the slot that fired, so
      // restarts resume the cadence instead of resetting it.
      await this.#store.recordCadence(routingId, result.scheduledAt);
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
  step: WorkFoldRoutingChatStep | WorkFoldRoutingFilesStep | WorkFoldRoutingCheckStep,
): { spaceId: string } | { fromSpaceId: string; toSpaceId: string } {
  return step.kind === "files"
    ? { fromSpaceId: step.fromSpace, toSpaceId: step.toSpace }
    : { spaceId: step.space };
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

function abortReasonText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return "The run was aborted.";
}
