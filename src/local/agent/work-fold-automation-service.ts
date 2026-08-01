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
export type WorkFoldAutomationRunReason = "scheduled" | "manual" | "resume";
export type WorkFoldAutomationRunOutcome = "success" | "failure" | "skipped" | "cancelled";

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
  error?: string;
}

export interface WorkFoldAutomationResultCallbackError {
  runId: string;
  key: WorkFoldAutomationJobKey;
  occurredAt: string;
  error: string;
}

export interface WorkFoldAutomationJobDefinition {
  key: WorkFoldAutomationJobKey;
  intervalMinutes: number;
  enabled: boolean;
  catchUp: WorkFoldAutomationCatchUp;
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
  definition: WorkFoldAutomationJobDefinition;
  encodedKey: string;
  registration: symbol;
  intervalMs: number;
  nextScheduledAt: number;
  pendingCatchUpAt?: number;
  scheduleTimer?: unknown;
  catchUpTimer?: unknown;
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
    return job?.definition.enabled ? isoTime(job.nextScheduledAt) : undefined;
  }

  register(definition: WorkFoldAutomationJobDefinition): void {
    this.#assertOpen();
    const normalized = normalizeDefinition(definition);
    const encodedKey = automationKey(normalized.key);
    if (this.#jobs.has(encodedKey)) {
      throw new Error(`Automation ${displayKey(normalized.key)} is already registered.`);
    }
    const now = this.#now();
    const intervalMs = intervalMilliseconds(normalized.intervalMinutes);
    const initial = initialSchedule(normalized, intervalMs, now);
    const job: RegisteredJob = {
      definition: normalized,
      encodedKey,
      registration: Symbol(encodedKey),
      intervalMs,
      nextScheduledAt: initial.nextScheduledAt,
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
    const intervalMs = intervalMilliseconds(normalized.intervalMinutes);
    const intervalChanged = intervalMs !== job.intervalMs;
    const anchorChanged = normalized.lastScheduledAt !== job.definition.lastScheduledAt;
    job.definition = normalized;

    if (!normalized.enabled) {
      this.#clearJobTimers(job);
      job.pendingCatchUpAt = undefined;
      this.#cancelPending(job, "Automation was disabled before this run could start.", (pending) => pending.reason !== "manual");
      this.#abortActive(job, "Automation was disabled while this run was active.");
      return;
    }

    if (!wasEnabled || intervalChanged || anchorChanged) {
      this.#clearJobTimers(job);
      job.intervalMs = intervalMs;
      const initial = initialSchedule(normalized, intervalMs, this.#now());
      job.nextScheduledAt = initial.nextScheduledAt;
      job.pendingCatchUpAt = initial.pendingCatchUpAt;
      this.#armCatchUp(job);
      this.#armSchedule(job);
      return;
    }

    job.intervalMs = intervalMs;
    if (normalized.catchUp === "none") {
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
    this.#cancelPending(job, "Automation was unregistered before this run could start.");
    this.#abortActive(job, "Automation was unregistered while this run was active.");
    return true;
  }

  runNow(key: WorkFoldAutomationJobKey): Promise<WorkFoldAutomationRunResult> {
    const normalizedKey = normalizeKey(key);
    const scheduledAt = this.#now();
    if (this.#closed) {
      return this.#immediateResult(normalizedKey, "manual", scheduledAt, "cancelled", "Automation service is closed.");
    }
    const job = this.#jobs.get(automationKey(normalizedKey));
    if (!job) {
      return this.#immediateResult(normalizedKey, "manual", scheduledAt, "cancelled", "Automation is not registered.");
    }
    return this.#requestRun(job, "manual", scheduledAt);
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
    this.#cancelAllPending("Automation scheduling was suspended before this run could start.");
  }

  resume(): void {
    if (this.#closed || !this.#suspended) return;
    this.#suspended = false;
    const now = this.#now();
    for (const job of this.#jobs.values()) {
      if (!job.definition.enabled) continue;
      if (job.nextScheduledAt <= now) {
        const latestDue = latestDueAt(job.nextScheduledAt, job.intervalMs, now);
        job.nextScheduledAt = latestDue + job.intervalMs;
        if (job.definition.catchUp === "latest") job.pendingCatchUpAt = latestDue;
      }
      if (job.definition.catchUp === "latest" && job.pendingCatchUpAt !== undefined) this.#armCatchUp(job);
      this.#armSchedule(job);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#suspended = false;
    this.#cancelAllPending("Automation service closed before this run could start.");
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
  ): Promise<WorkFoldAutomationRunResult> {
    const runId = this.#nextRunId();
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
      this.#finishWithoutLaunch(pending, "cancelled", "Automation service is closed.");
      return result;
    }
    if (this.#suspended) {
      this.#finishWithoutLaunch(pending, "skipped", "Automation scheduling is suspended.");
      return result;
    }
    if (reason !== "manual" && !job.definition.enabled) {
      this.#finishWithoutLaunch(pending, "skipped", "Automation is disabled.");
      return result;
    }
    if (this.#busyKeys.has(job.encodedKey)) {
      this.#finishWithoutLaunch(pending, "skipped", "Another run of this automation is already pending or active.");
      return result;
    }
    this.#busyKeys.add(job.encodedKey);
    this.#pending.push(pending);
    this.#pump();
    return result;
  }

  #pump(): void {
    if (this.#closed || this.#suspended) return;
    while (this.#activeCount < this.#maxConcurrency && this.#pending.length > 0) {
      const pending = this.#pending.shift()!;
      const job = this.#jobs.get(pending.encodedKey);
      if (!job || job.registration !== pending.registration) {
        this.#busyKeys.delete(pending.encodedKey);
        this.#finishWithoutLaunch(pending, "cancelled", "Automation registration changed before this run could start.");
        continue;
      }
      if (pending.reason !== "manual" && !job.definition.enabled) {
        this.#busyKeys.delete(pending.encodedKey);
        this.#finishWithoutLaunch(pending, "skipped", "Automation was disabled before this run could start.");
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
    run: WorkFoldAutomationJobDefinition["run"],
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
      error: boundedError(error),
    });
  }

  async #immediateResult(
    key: WorkFoldAutomationJobKey,
    reason: WorkFoldAutomationRunReason,
    scheduledAt: number,
    outcome: Extract<WorkFoldAutomationRunOutcome, "skipped" | "cancelled">,
    error: string,
  ): Promise<WorkFoldAutomationRunResult> {
    const runId = this.#nextRunId();
    const now = this.#now();
    const result: WorkFoldAutomationRunResult = {
      runId,
      key: copyKey(key),
      reason,
      scheduledAt: isoTime(scheduledAt),
      startedAt: isoTime(now),
      finishedAt: isoTime(now),
      outcome,
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
    if (this.#closed || this.#suspended || !job.definition.enabled || job.scheduleTimer !== undefined) return;
    const delay = boundedTimerDelay(job.nextScheduledAt - this.#now());
    job.scheduleTimer = this.#clock.setTimeout(() => {
      job.scheduleTimer = undefined;
      const current = this.#jobs.get(job.encodedKey);
      if (this.#closed || this.#suspended || current !== job || !job.definition.enabled) return;
      const now = this.#now();
      if (job.nextScheduledAt > now) {
        this.#armSchedule(job);
        return;
      }
      const scheduledAt = latestDueAt(job.nextScheduledAt, job.intervalMs, now);
      job.nextScheduledAt = scheduledAt + job.intervalMs;
      this.#armSchedule(job);
      void this.#requestRun(job, "scheduled", scheduledAt);
    }, delay);
  }

  #armCatchUp(job: RegisteredJob): void {
    if (
      this.#closed
      || this.#suspended
      || !job.definition.enabled
      || job.definition.catchUp !== "latest"
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
        || job.definition.catchUp !== "latest"
        || job.pendingCatchUpAt === undefined
      ) return;
      const scheduledAt = job.pendingCatchUpAt;
      job.pendingCatchUpAt = undefined;
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

  #cancelPending(job: RegisteredJob, reason: string, shouldCancel: (pending: PendingRun) => boolean = () => true): void {
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
      void this.#finishWithoutLaunch(pending, "cancelled", reason);
    }
  }

  #cancelAllPending(reason: string): void {
    for (const pending of this.#pending.splice(0)) {
      this.#busyKeys.delete(pending.encodedKey);
      void this.#finishWithoutLaunch(pending, "cancelled", reason);
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

function normalizeDefinition(definition: WorkFoldAutomationJobDefinition): WorkFoldAutomationJobDefinition {
  if (!definition || typeof definition !== "object") throw new Error("Automation definition is required.");
  const key = normalizeKey(definition.key);
  intervalMilliseconds(definition.intervalMinutes);
  if (typeof definition.enabled !== "boolean") throw new Error("Automation enabled state must be a boolean.");
  if (definition.catchUp !== "none" && definition.catchUp !== "latest") {
    throw new Error('Automation catch-up policy must be "none" or "latest".');
  }
  if (typeof definition.run !== "function") throw new Error("Automation run callback is required.");
  const lastScheduledAt = definition.lastScheduledAt === undefined
    ? undefined
    : normalizedIsoTime(definition.lastScheduledAt, "Automation scheduling anchor");
  return { ...definition, key, ...(lastScheduledAt === undefined ? {} : { lastScheduledAt }) };
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
  definition: WorkFoldAutomationJobDefinition,
  intervalMs: number,
  now: number,
): { nextScheduledAt: number; pendingCatchUpAt?: number } {
  if (definition.lastScheduledAt === undefined) return { nextScheduledAt: now + intervalMs };
  const firstDueAt = Date.parse(definition.lastScheduledAt) + intervalMs;
  if (firstDueAt > now) return { nextScheduledAt: firstDueAt };
  const latestDue = latestDueAt(firstDueAt, intervalMs, now);
  return {
    nextScheduledAt: latestDue + intervalMs,
    ...(definition.enabled && definition.catchUp === "latest" ? { pendingCatchUpAt: latestDue } : {}),
  };
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
