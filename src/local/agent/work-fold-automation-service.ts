import { randomUUID } from "node:crypto";

export const workFoldAutomationMaxErrorLength = 300;

const defaultMaxConcurrency = 2;
const defaultMaxRunResults = 500;
const maximumTimerDelayMs = 2_147_483_647;
const maximumKeyPartLength = 200;

export interface WorkFoldAutomationJobKey {
  ownerId: string;
  jobId: string;
}

export type WorkFoldAutomationCatchUp = "none" | "latest";
export type WorkFoldAutomationSchedule =
  | { kind: "interval"; intervalMinutes: number; catchUp: WorkFoldAutomationCatchUp }
  | { kind: "at"; at: string; ifMissed: "run" | "skip" };
export type WorkFoldAutomationRunReason = "scheduled" | "manual" | "resume";
export type WorkFoldAutomationRunOutcome = "success" | "failure" | "skipped" | "cancelled";
export type WorkFoldAutomationNoLaunchReason =
  | "closed"
  | "suspended"
  | "disabled"
  | "overlap"
  | "registration-changed";

export interface WorkFoldAutomationRunContext {
  runId: string;
  key: WorkFoldAutomationJobKey;
  reason: WorkFoldAutomationRunReason;
  scheduledAt: string;
  startedAt: string;
  signal: AbortSignal;
}

export interface WorkFoldAutomationRunResult {
  runId: string;
  key: WorkFoldAutomationJobKey;
  reason: WorkFoldAutomationRunReason;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  outcome: WorkFoldAutomationRunOutcome;
  /** Present only when scheduler admission settled before the callback launched. */
  notLaunchedReason?: WorkFoldAutomationNoLaunchReason;
  error?: string;
}

export interface WorkFoldAutomationRunAdmission {
  runId: string;
  result: Promise<WorkFoldAutomationRunResult>;
}

export interface WorkFoldAutomationResultCallbackError {
  runId: string;
  key: WorkFoldAutomationJobKey;
  occurredAt: string;
  error: string;
}

export interface WorkFoldAutomationJobDefinition {
  key: WorkFoldAutomationJobKey;
  /** Canonical scheduling contract. */
  schedule?: WorkFoldAutomationSchedule;
  /**
   * Compatibility input for restricted-app callers. It is normalized
   * immediately into an interval schedule and may not accompany `schedule`.
   */
  intervalMinutes?: number;
  enabled: boolean;
  catchUp?: WorkFoldAutomationCatchUp;
  /** Optional durable cadence anchor supplied by the owning domain. */
  lastScheduledAt?: string;
  run(context: WorkFoldAutomationRunContext): void | Promise<void>;
}

export interface WorkFoldAutomationClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkFoldAutomationServiceOptions {
  maxConcurrency?: number;
  maxRunResults?: number;
  clock?: WorkFoldAutomationClock;
  createRunId?: () => string;
  catchUpStagger?: (key: WorkFoldAutomationJobKey) => number;
  /**
   * Receives every terminal result before a manual run promise resolves. A
   * callback failure is isolated in listResultCallbackErrors().
   */
  onResult?: (result: WorkFoldAutomationRunResult) => void | Promise<void>;
}

interface RegisteredJob {
  definition: NormalizedAutomationJobDefinition;
  encodedKey: string;
  registration: symbol;
  nextScheduledAt?: number;
  pendingCatchUpAt?: number;
  atConsumed: boolean;
  scheduleTimer?: unknown;
  catchUpTimer?: unknown;
}

interface NormalizedAutomationJobDefinition {
  key: WorkFoldAutomationJobKey;
  schedule: WorkFoldAutomationSchedule;
  enabled: boolean;
  lastScheduledAt?: string;
  run(context: WorkFoldAutomationRunContext): void | Promise<void>;
}

interface PendingRun {
  runId: string;
  key: WorkFoldAutomationJobKey;
  encodedKey: string;
  registration: symbol;
  reason: WorkFoldAutomationRunReason;
  scheduledAt: number;
  resolve(result: WorkFoldAutomationRunResult): void;
}

interface ActiveRun {
  registration: symbol;
  controller: AbortController;
}

/**
 * Coordinates named, in-process automation callbacks for the whole work-fold
 * host. Authority checks, durable schedules, and run persistence deliberately
 * remain the responsibility of the registering domain service.
 */
export class WorkFoldAutomationService {
  readonly #maxConcurrency: number;
  readonly #maxRunResults: number;
  readonly #clock: WorkFoldAutomationClock;
  readonly #createRunId: () => string;
  readonly #catchUpStagger: (key: WorkFoldAutomationJobKey) => number;
  readonly #onResult?: (result: WorkFoldAutomationRunResult) => void | Promise<void>;
  readonly #jobs = new Map<string, RegisteredJob>();
  readonly #pending: PendingRun[] = [];
  readonly #busyKeys = new Set<string>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #runResults: WorkFoldAutomationRunResult[] = [];
  readonly #resultCallbackErrors: WorkFoldAutomationResultCallbackError[] = [];
  #activeCount = 0;
  #suspended = false;
  #closed = false;

  constructor(options: WorkFoldAutomationServiceOptions = {}) {
    this.#maxConcurrency = positiveInteger(options.maxConcurrency ?? defaultMaxConcurrency, "Automation concurrency");
    this.#maxRunResults = positiveInteger(options.maxRunResults ?? defaultMaxRunResults, "Automation result history size");
    this.#clock = options.clock ?? systemAutomationClock;
    this.#createRunId = options.createRunId ?? randomUUID;
    this.#catchUpStagger = options.catchUpStagger ?? workFoldAutomationCatchUpStagger;
    this.#onResult = options.onResult;
  }

  get size(): number {
    return this.#jobs.size;
  }

  get activeCount(): number {
    return this.#activeCount;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get closed(): boolean {
    return this.#closed;
  }

  has(key: WorkFoldAutomationJobKey): boolean {
    return this.#jobs.has(automationKey(key));
  }

  nextScheduledAt(key: WorkFoldAutomationJobKey): string | undefined {
    const job = this.#jobs.get(automationKey(key));
    return job?.definition.enabled && job.nextScheduledAt !== undefined ? isoTime(job.nextScheduledAt) : undefined;
  }

  register(definition: WorkFoldAutomationJobDefinition): void {
    this.#assertOpen();
    const normalized = normalizeDefinition(definition);
    const encodedKey = automationKey(normalized.key);
    if (this.#jobs.has(encodedKey)) {
      throw new Error(`Automation ${displayKey(normalized.key)} is already registered.`);
    }
    const now = this.#now();
    const initial = initialSchedule(normalized, now);
    const job: RegisteredJob = {
      definition: normalized,
      encodedKey,
      registration: Symbol(encodedKey),
      nextScheduledAt: initial.nextScheduledAt,
      atConsumed: initial.atConsumed,
      ...(initial.pendingCatchUpAt === undefined ? {} : { pendingCatchUpAt: initial.pendingCatchUpAt }),
    };
    this.#jobs.set(encodedKey, job);
    this.#armCatchUp(job);
    this.#armSchedule(job);
  }

  update(definition: WorkFoldAutomationJobDefinition): void {
    this.#assertOpen();
    const normalized = normalizeDefinition(definition);
    const encodedKey = automationKey(normalized.key);
    const job = this.#jobs.get(encodedKey);
    if (!job) throw new Error(`Automation ${displayKey(normalized.key)} is not registered.`);

    const wasEnabled = job.definition.enabled;
    const scheduleChanged = !schedulesEqual(normalized.schedule, job.definition.schedule);
    const anchorChanged = normalized.lastScheduledAt !== job.definition.lastScheduledAt;
    job.definition = normalized;

    if (!normalized.enabled) {
      this.#clearJobTimers(job);
      job.pendingCatchUpAt = undefined;
      this.#cancelPending(job, "disabled", "Automation was disabled before this run could start.", (pending) => pending.reason !== "manual");
      this.#abortActive(job, "Automation was disabled while this run was active.");
      return;
    }

    if (!wasEnabled || scheduleChanged || anchorChanged) {
      this.#clearJobTimers(job);
      const initial = normalized.schedule.kind === "at" && !scheduleChanged && job.atConsumed
        ? { atConsumed: true }
        : initialSchedule(normalized, this.#now());
      job.nextScheduledAt = initial.nextScheduledAt;
      job.pendingCatchUpAt = initial.pendingCatchUpAt;
      job.atConsumed = initial.atConsumed;
      this.#armCatchUp(job);
      this.#armSchedule(job);
      return;
    }

    if (!scheduleCatchesUp(normalized.schedule)) {
      this.#clearCatchUpTimer(job);
      job.pendingCatchUpAt = undefined;
    }
  }

  unregister(key: WorkFoldAutomationJobKey): boolean {
    const encodedKey = automationKey(key);
    const job = this.#jobs.get(encodedKey);
    if (!job) return false;
    this.#jobs.delete(encodedKey);
    this.#clearJobTimers(job);
    this.#cancelPending(job, "registration-changed", "Automation was unregistered before this run could start.");
    this.#abortActive(job, "Automation was unregistered while this run was active.");
    return true;
  }

  runNow(key: WorkFoldAutomationJobKey): Promise<WorkFoldAutomationRunResult> {
    return this.runNowAdmission(key).result;
  }

  /**
   * Admits a manual run and exposes its host-minted id immediately. The
   * result still settles only after the callback (and result observer) does.
   */
  runNowAdmission(key: WorkFoldAutomationJobKey): WorkFoldAutomationRunAdmission {
    const normalizedKey = normalizeKey(key);
    const scheduledAt = this.#now();
    const runId = this.#nextRunId();
    if (this.#closed) {
      return {
        runId,
        result: this.#immediateResult(runId, normalizedKey, "manual", scheduledAt, "cancelled", "closed", "Automation service is closed."),
      };
    }
    const job = this.#jobs.get(automationKey(normalizedKey));
    if (!job) {
      return {
        runId,
        result: this.#immediateResult(runId, normalizedKey, "manual", scheduledAt, "cancelled", "registration-changed", "Automation is not registered."),
      };
    }
    return this.#requestRun(job, "manual", scheduledAt, runId);
  }

  listRunResults(key?: WorkFoldAutomationJobKey): WorkFoldAutomationRunResult[] {
    const encodedKey = key ? automationKey(key) : undefined;
    return this.#runResults
      .filter((result) => encodedKey === undefined || automationKey(result.key) === encodedKey)
      .map(copyRunResult);
  }

  listResultCallbackErrors(): WorkFoldAutomationResultCallbackError[] {
    return this.#resultCallbackErrors.map(copyResultCallbackError);
  }

  suspend(): void {
    if (this.#closed || this.#suspended) return;
    this.#suspended = true;
    for (const job of this.#jobs.values()) {
      this.#clearJobTimers(job);
      this.#abortActive(job, "Automation scheduling was suspended while this run was active.");
    }
    this.#cancelAllPending(
      "suspended",
      "Automation scheduling was suspended before this run could start.",
      true,
    );
  }

  resume(): void {
    if (this.#closed || !this.#suspended) return;
    this.#suspended = false;
    const now = this.#now();
    for (const job of this.#jobs.values()) {
      if (!job.definition.enabled) continue;
      if (job.nextScheduledAt !== undefined && job.nextScheduledAt <= now) {
        if (job.definition.schedule.kind === "interval") {
          const intervalMs = intervalMilliseconds(job.definition.schedule.intervalMinutes);
          const latestDue = latestDueAt(job.nextScheduledAt, intervalMs, now);
          job.nextScheduledAt = latestDue + intervalMs;
          if (job.definition.schedule.catchUp === "latest") job.pendingCatchUpAt = latestDue;
        } else {
          const dueAt = job.nextScheduledAt;
          job.nextScheduledAt = undefined;
          job.atConsumed = true;
          if (job.definition.schedule.ifMissed === "run") job.pendingCatchUpAt = dueAt;
        }
      }
      if (scheduleCatchesUp(job.definition.schedule) && job.pendingCatchUpAt !== undefined) this.#armCatchUp(job);
      this.#armSchedule(job);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#suspended = false;
    this.#cancelAllPending("closed", "Automation service closed before this run could start.");
    for (const job of this.#jobs.values()) {
      this.#clearJobTimers(job);
      this.#abortActive(job, "Automation service closed while this run was active.");
    }
    this.#jobs.clear();
  }

  #requestRun(
    job: RegisteredJob,
    reason: WorkFoldAutomationRunReason,
    scheduledAt: number,
    requestedRunId?: string,
  ): WorkFoldAutomationRunAdmission {
    const runId = requestedRunId ?? this.#nextRunId();
    let resolveResult!: (result: WorkFoldAutomationRunResult) => void;
    const result = new Promise<WorkFoldAutomationRunResult>((resolve) => {
      resolveResult = resolve;
    });
    const pending: PendingRun = {
      runId,
      key: copyKey(job.definition.key),
      encodedKey: job.encodedKey,
      registration: job.registration,
      reason,
      scheduledAt,
      resolve: resolveResult,
    };
    if (this.#closed) {
      this.#finishWithoutLaunch(pending, "cancelled", "closed", "Automation service is closed.");
      return { runId, result };
    }
    if (this.#suspended) {
      this.#finishWithoutLaunch(pending, "skipped", "suspended", "Automation scheduling is suspended.");
      return { runId, result };
    }
    if (reason !== "manual" && !job.definition.enabled) {
      this.#finishWithoutLaunch(pending, "skipped", "disabled", "Automation is disabled.");
      return { runId, result };
    }
    if (this.#busyKeys.has(job.encodedKey)) {
      this.#finishWithoutLaunch(pending, "skipped", "overlap", "Another run of this automation is already pending or active.");
      return { runId, result };
    }
    this.#busyKeys.add(job.encodedKey);
    this.#pending.push(pending);
    this.#pump();
    return { runId, result };
  }

  #pump(): void {
    if (this.#closed || this.#suspended) return;
    while (this.#activeCount < this.#maxConcurrency && this.#pending.length > 0) {
      const pending = this.#pending.shift()!;
      const job = this.#jobs.get(pending.encodedKey);
      if (!job || job.registration !== pending.registration) {
        this.#busyKeys.delete(pending.encodedKey);
        this.#finishWithoutLaunch(pending, "cancelled", "registration-changed", "Automation registration changed before this run could start.");
        continue;
      }
      if (pending.reason !== "manual" && !job.definition.enabled) {
        this.#busyKeys.delete(pending.encodedKey);
        this.#finishWithoutLaunch(pending, "skipped", "disabled", "Automation was disabled before this run could start.");
        continue;
      }

      // The callback is intentionally read only after a global slot is
      // acquired. Updates made while a run is queued therefore take effect at
      // the launch boundary instead of executing a stale closure.
      const run = job.definition.run;
      const startedAt = this.#now();
      const controller = new AbortController();
      this.#activeCount += 1;
      this.#active.set(pending.encodedKey, { registration: job.registration, controller });
      void this.#execute(pending, run, startedAt, controller);
    }
  }

  async #execute(
    pending: PendingRun,
    run: NormalizedAutomationJobDefinition["run"],
    startedAt: number,
    controller: AbortController,
  ): Promise<void> {
    let outcome: WorkFoldAutomationRunOutcome = "success";
    let failure: unknown;
    try {
      await run({
        runId: pending.runId,
        key: copyKey(pending.key),
        reason: pending.reason,
        scheduledAt: isoTime(pending.scheduledAt),
        startedAt: isoTime(startedAt),
        signal: controller.signal,
      });
    } catch (error) {
      outcome = "failure";
      failure = error;
    }
    if (controller.signal.aborted) {
      outcome = "cancelled";
      failure = controller.signal.reason;
    }
    const finishedAt = this.#now();
    const active = this.#active.get(pending.encodedKey);
    if (active?.controller === controller) this.#active.delete(pending.encodedKey);
    this.#activeCount = Math.max(0, this.#activeCount - 1);
    this.#busyKeys.delete(pending.encodedKey);
    const completion = this.#complete(pending, {
      runId: pending.runId,
      key: copyKey(pending.key),
      reason: pending.reason,
      scheduledAt: isoTime(pending.scheduledAt),
      startedAt: isoTime(startedAt),
      finishedAt: isoTime(finishedAt),
      outcome,
      ...(outcome === "success" ? {} : { error: boundedError(failure) }),
    });
    this.#pump();
    await completion;
  }

  async #finishWithoutLaunch(
    pending: PendingRun,
    outcome: Extract<WorkFoldAutomationRunOutcome, "skipped" | "cancelled">,
    notLaunchedReason: WorkFoldAutomationNoLaunchReason,
    error: string,
  ): Promise<void> {
    const now = this.#now();
    await this.#complete(pending, {
      runId: pending.runId,
      key: copyKey(pending.key),
      reason: pending.reason,
      scheduledAt: isoTime(pending.scheduledAt),
      startedAt: isoTime(now),
      finishedAt: isoTime(now),
      outcome,
      notLaunchedReason,
      error: boundedError(error),
    });
  }

  async #immediateResult(
    runId: string,
    key: WorkFoldAutomationJobKey,
    reason: WorkFoldAutomationRunReason,
    scheduledAt: number,
    outcome: Extract<WorkFoldAutomationRunOutcome, "skipped" | "cancelled">,
    notLaunchedReason: WorkFoldAutomationNoLaunchReason,
    error: string,
  ): Promise<WorkFoldAutomationRunResult> {
    const now = this.#now();
    const result: WorkFoldAutomationRunResult = {
      runId,
      key: copyKey(key),
      reason,
      scheduledAt: isoTime(scheduledAt),
      startedAt: isoTime(now),
      finishedAt: isoTime(now),
      outcome,
      notLaunchedReason,
      error: boundedError(error),
    };
    await this.#record(result);
    return copyRunResult(result);
  }

  async #complete(pending: PendingRun, result: WorkFoldAutomationRunResult): Promise<void> {
    await this.#record(result);
    pending.resolve(copyRunResult(result));
  }

  async #record(result: WorkFoldAutomationRunResult): Promise<void> {
    this.#runResults.push(copyRunResult(result));
    const overflow = this.#runResults.length - this.#maxRunResults;
    if (overflow > 0) this.#runResults.splice(0, overflow);
    if (!this.#onResult) return;
    try {
      await this.#onResult(copyRunResult(result));
    } catch (error) {
      this.#resultCallbackErrors.push({
        runId: result.runId,
        key: copyKey(result.key),
        occurredAt: isoTime(this.#now()),
        error: boundedError(error),
      });
      const callbackOverflow = this.#resultCallbackErrors.length - this.#maxRunResults;
      if (callbackOverflow > 0) this.#resultCallbackErrors.splice(0, callbackOverflow);
    }
  }

  #armSchedule(job: RegisteredJob): void {
    if (
      this.#closed
      || this.#suspended
      || !job.definition.enabled
      || job.nextScheduledAt === undefined
      || job.scheduleTimer !== undefined
    ) return;
    const delay = boundedTimerDelay(job.nextScheduledAt - this.#now());
    job.scheduleTimer = this.#clock.setTimeout(() => {
      job.scheduleTimer = undefined;
      const current = this.#jobs.get(job.encodedKey);
      if (this.#closed || this.#suspended || current !== job || !job.definition.enabled) return;
      const now = this.#now();
      if (job.nextScheduledAt === undefined) return;
      if (job.nextScheduledAt > now) {
        this.#armSchedule(job);
        return;
      }
      let scheduledAt: number;
      if (job.definition.schedule.kind === "interval") {
        const intervalMs = intervalMilliseconds(job.definition.schedule.intervalMinutes);
        scheduledAt = latestDueAt(job.nextScheduledAt, intervalMs, now);
        job.nextScheduledAt = scheduledAt + intervalMs;
        this.#armSchedule(job);
      } else {
        scheduledAt = job.nextScheduledAt;
        job.nextScheduledAt = undefined;
        job.atConsumed = true;
      }
      void this.#requestRun(job, "scheduled", scheduledAt);
    }, delay);
  }

  #armCatchUp(job: RegisteredJob): void {
    if (
      this.#closed
      || this.#suspended
      || !job.definition.enabled
      || !scheduleCatchesUp(job.definition.schedule)
      || job.pendingCatchUpAt === undefined
      || job.catchUpTimer !== undefined
    ) return;
    const rawDelay = this.#catchUpStagger(copyKey(job.definition.key));
    if (!Number.isFinite(rawDelay) || rawDelay < 0) throw new Error("Automation catch-up staggering must return a non-negative number of milliseconds.");
    const delay = boundedTimerDelay(rawDelay);
    job.catchUpTimer = this.#clock.setTimeout(() => {
      job.catchUpTimer = undefined;
      const current = this.#jobs.get(job.encodedKey);
      if (
        this.#closed
        || this.#suspended
        || current !== job
        || !job.definition.enabled
        || !scheduleCatchesUp(job.definition.schedule)
        || job.pendingCatchUpAt === undefined
      ) return;
      const scheduledAt = job.pendingCatchUpAt;
      job.pendingCatchUpAt = undefined;
      if (job.definition.schedule.kind === "at") job.atConsumed = true;
      void this.#requestRun(job, "resume", scheduledAt);
    }, delay);
  }

  #clearJobTimers(job: RegisteredJob): void {
    if (job.scheduleTimer !== undefined) this.#clock.clearTimeout(job.scheduleTimer);
    job.scheduleTimer = undefined;
    this.#clearCatchUpTimer(job);
  }

  #clearCatchUpTimer(job: RegisteredJob): void {
    if (job.catchUpTimer !== undefined) this.#clock.clearTimeout(job.catchUpTimer);
    job.catchUpTimer = undefined;
  }

  #cancelPending(
    job: RegisteredJob,
    notLaunchedReason: WorkFoldAutomationNoLaunchReason,
    reason: string,
    shouldCancel: (pending: PendingRun) => boolean = () => true,
  ): void {
    const cancelled: PendingRun[] = [];
    const retained: PendingRun[] = [];
    for (const pending of this.#pending) {
      if (pending.registration === job.registration && shouldCancel(pending)) cancelled.push(pending);
      else retained.push(pending);
    }
    if (!cancelled.length) return;
    this.#pending.splice(0, this.#pending.length, ...retained);
    for (const pending of cancelled) {
      this.#busyKeys.delete(pending.encodedKey);
      void this.#finishWithoutLaunch(pending, "cancelled", notLaunchedReason, reason);
    }
  }

  #cancelAllPending(
    notLaunchedReason: WorkFoldAutomationNoLaunchReason,
    reason: string,
    preserveCatchUp = false,
  ): void {
    for (const pending of this.#pending.splice(0)) {
      this.#busyKeys.delete(pending.encodedKey);
      const job = this.#jobs.get(pending.encodedKey);
      if (
        preserveCatchUp
        && pending.reason !== "manual"
        && job?.registration === pending.registration
        && scheduleCatchesUp(job.definition.schedule)
      ) {
        job.pendingCatchUpAt = job.pendingCatchUpAt === undefined
          ? pending.scheduledAt
          : Math.max(job.pendingCatchUpAt, pending.scheduledAt);
        if (job.definition.schedule.kind === "at") job.atConsumed = false;
      }
      void this.#finishWithoutLaunch(pending, "cancelled", notLaunchedReason, reason);
    }
  }

  #abortActive(job: RegisteredJob, reason: string): void {
    const active = this.#active.get(job.encodedKey);
    if (active?.registration === job.registration) active.controller.abort(reason);
  }

  #nextRunId(): string {
    const value = this.#createRunId();
    if (typeof value !== "string" || !value.trim() || value.length > maximumKeyPartLength) {
      throw new Error("Automation run ids must be non-empty strings of at most 200 characters.");
    }
    return value;
  }

  #now(): number {
    const value = this.#clock.now().getTime();
    if (!Number.isFinite(value)) throw new Error("Automation clock returned an invalid date.");
    return value;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("work-fold automation service is closed.");
  }
}

export function workFoldAutomationCatchUpStagger(key: WorkFoldAutomationJobKey): number {
  const normalized = normalizeKey(key);
  let value = 0;
  for (const character of `${normalized.ownerId}\0${normalized.jobId}`) {
    value = (value * 31 + character.charCodeAt(0)) >>> 0;
  }
  return 1_000 + (value % 30_000);
}

const systemAutomationClock: WorkFoldAutomationClock = {
  now: () => new Date(),
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function normalizeDefinition(definition: WorkFoldAutomationJobDefinition): NormalizedAutomationJobDefinition {
  if (!definition || typeof definition !== "object") throw new Error("Automation definition is required.");
  const key = normalizeKey(definition.key);
  if (typeof definition.enabled !== "boolean") throw new Error("Automation enabled state must be a boolean.");
  if (typeof definition.run !== "function") throw new Error("Automation run callback is required.");
  const schedule = normalizeSchedule(definition);
  const lastScheduledAt = definition.lastScheduledAt === undefined
    ? undefined
    : normalizedIsoTime(definition.lastScheduledAt, "Automation scheduling anchor");
  if (schedule.kind === "at" && lastScheduledAt !== undefined) {
    throw new Error("A one-time automation cannot carry an interval cadence anchor.");
  }
  return {
    key,
    schedule,
    enabled: definition.enabled,
    ...(lastScheduledAt === undefined ? {} : { lastScheduledAt }),
    run: definition.run,
  };
}

function normalizeSchedule(definition: WorkFoldAutomationJobDefinition): WorkFoldAutomationSchedule {
  if (definition.schedule !== undefined) {
    if (definition.intervalMinutes !== undefined || definition.catchUp !== undefined) {
      throw new Error("Automation schedule cannot be combined with legacy interval fields.");
    }
    if (definition.schedule.kind === "interval") {
      intervalMilliseconds(definition.schedule.intervalMinutes);
      if (definition.schedule.catchUp !== "none" && definition.schedule.catchUp !== "latest") {
        throw new Error('Automation catch-up policy must be "none" or "latest".');
      }
      return { ...definition.schedule };
    }
    if (definition.schedule.kind === "at") {
      if (definition.schedule.ifMissed !== "run" && definition.schedule.ifMissed !== "skip") {
        throw new Error('Automation one-time missed policy must be "run" or "skip".');
      }
      return {
        kind: "at",
        at: normalizedIsoTime(definition.schedule.at, "Automation one-time schedule"),
        ifMissed: definition.schedule.ifMissed,
      };
    }
    throw new Error("Automation schedule kind is unsupported.");
  }
  if (definition.intervalMinutes === undefined) throw new Error("Automation schedule is required.");
  intervalMilliseconds(definition.intervalMinutes);
  if (definition.catchUp !== "none" && definition.catchUp !== "latest") {
    throw new Error('Automation catch-up policy must be "none" or "latest".');
  }
  return { kind: "interval", intervalMinutes: definition.intervalMinutes, catchUp: definition.catchUp };
}

function normalizeKey(key: WorkFoldAutomationJobKey): WorkFoldAutomationJobKey {
  if (!key || typeof key !== "object") throw new Error("Automation key is required.");
  return {
    ownerId: keyPart(key.ownerId, "owner"),
    jobId: keyPart(key.jobId, "job"),
  };
}

function keyPart(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumKeyPartLength) {
    throw new Error(`Automation ${label} id must be a non-empty string of at most ${maximumKeyPartLength} characters.`);
  }
  return value;
}

function intervalMilliseconds(intervalMinutes: number): number {
  const milliseconds = intervalMinutes * 60_000;
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0 || !Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error("Automation interval must be a positive number of minutes resolving to a whole millisecond.");
  }
  return milliseconds;
}

function automationKey(key: WorkFoldAutomationJobKey): string {
  const normalized = normalizeKey(key);
  return JSON.stringify([normalized.ownerId, normalized.jobId]);
}

function displayKey(key: WorkFoldAutomationJobKey): string {
  return `${key.ownerId}/${key.jobId}`;
}

function copyKey(key: WorkFoldAutomationJobKey): WorkFoldAutomationJobKey {
  return { ownerId: key.ownerId, jobId: key.jobId };
}

function copyRunResult(result: WorkFoldAutomationRunResult): WorkFoldAutomationRunResult {
  return { ...result, key: copyKey(result.key) };
}

function copyResultCallbackError(error: WorkFoldAutomationResultCallbackError): WorkFoldAutomationResultCallbackError {
  return { ...error, key: copyKey(error.key) };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function latestDueAt(firstDueAt: number, intervalMs: number, now: number): number {
  if (firstDueAt > now) return firstDueAt;
  return firstDueAt + Math.floor((now - firstDueAt) / intervalMs) * intervalMs;
}

function initialSchedule(
  definition: NormalizedAutomationJobDefinition,
  now: number,
): { nextScheduledAt?: number; pendingCatchUpAt?: number; atConsumed: boolean } {
  if (definition.schedule.kind === "at") {
    const at = Date.parse(definition.schedule.at);
    if (at > now) return { nextScheduledAt: at, atConsumed: false };
    return definition.enabled && definition.schedule.ifMissed === "run"
      ? { pendingCatchUpAt: at, atConsumed: false }
      : { atConsumed: true };
  }
  const intervalMs = intervalMilliseconds(definition.schedule.intervalMinutes);
  if (definition.lastScheduledAt === undefined) return { nextScheduledAt: now + intervalMs, atConsumed: false };
  const firstDueAt = Date.parse(definition.lastScheduledAt) + intervalMs;
  if (firstDueAt > now) return { nextScheduledAt: firstDueAt, atConsumed: false };
  const latestDue = latestDueAt(firstDueAt, intervalMs, now);
  return {
    nextScheduledAt: latestDue + intervalMs,
    atConsumed: false,
    ...(definition.enabled && definition.schedule.catchUp === "latest" ? { pendingCatchUpAt: latestDue } : {}),
  };
}

function scheduleCatchesUp(schedule: WorkFoldAutomationSchedule): boolean {
  return schedule.kind === "interval" ? schedule.catchUp === "latest" : schedule.ifMissed === "run";
}

function schedulesEqual(left: WorkFoldAutomationSchedule, right: WorkFoldAutomationSchedule): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "interval" && right.kind === "interval"
    ? left.intervalMinutes === right.intervalMinutes && left.catchUp === right.catchUp
    : left.kind === "at" && right.kind === "at" && left.at === right.at && left.ifMissed === right.ifMissed;
}

function boundedTimerDelay(value: number): number {
  return Math.min(maximumTimerDelayMs, Math.max(0, Math.ceil(value)));
}

function isoTime(value: number): string {
  return new Date(value).toISOString();
}

function normalizedIsoTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be an ISO date string.`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO date string.`);
  return isoTime(time);
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Automation run failed.");
  const bounded = message.slice(0, workFoldAutomationMaxErrorLength);
  return bounded.trim() ? bounded : "Automation run failed.";
}
