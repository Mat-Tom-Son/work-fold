import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkFoldAutomationService,
  workFoldAutomationCatchUpStagger,
  workFoldAutomationMaxErrorLength,
  type WorkFoldAutomationClock,
  type WorkFoldAutomationJobDefinition,
  type WorkFoldAutomationJobKey,
  type WorkFoldAutomationRunContext,
} from "../src/local/agent/work-fold-automation-service.js";

const startTime = Date.parse("2026-07-14T12:00:00.000Z");
const minute = 60_000;

test("WorkFoldAutomationService defaults to two machine-wide execution slots", async () => {
  const clock = new FakeClock(startTime);
  const starts: string[] = [];
  const releases: Array<() => void> = [];
  const service = new WorkFoldAutomationService({ clock, createRunId: runIds().next });
  const keys = [key("space-a/app", "job"), key("space-b/app", "job"), key("space-c/app", "job")];
  for (const automation of keys) {
    service.register(job(automation, async () => {
      starts.push(automation.ownerId);
      await new Promise<void>((resolve) => releases.push(resolve));
    }));
  }

  const runs = keys.map((automation) => service.runNow(automation));
  assert.deepEqual(starts, ["space-a/app", "space-b/app"]);
  assert.equal(service.activeCount, 2);
  assert.equal(service.pendingCount, 1);
  releases.shift()?.();
  await flushTasks();
  assert.deepEqual(starts, ["space-a/app", "space-b/app", "space-c/app"]);
  releases.splice(0).forEach((release) => release());
  await flushTasks();
  assert.deepEqual((await Promise.all(runs)).map(({ outcome }) => outcome), ["success", "success", "success"]);
  service.close();
});

test("WorkFoldAutomationService enforces FIFO global concurrency, prevents same-job overlap, and launches the latest callback", async () => {
  const clock = new FakeClock(startTime);
  const ids = runIds();
  const service = new WorkFoldAutomationService({ clock, maxConcurrency: 1, createRunId: ids.next });
  const starts: string[] = [];
  const releases: Array<() => void> = [];
  const blocker = key("owner-a", "blocker");
  const second = key("owner-b", "second");
  const third = key("owner-c", "third");
  service.register(job(blocker, async () => {
    starts.push("blocker");
    await new Promise<void>((resolve) => releases.push(resolve));
  }));
  service.register(job(second, () => { starts.push("stale-second"); }));
  service.register(job(third, () => { starts.push("third"); }));

  const firstRun = service.runNow(blocker);
  const overlappingRun = await service.runNow(blocker);
  const secondRun = service.runNow(second);
  const thirdRun = service.runNow(third);
  assert.deepEqual(starts, ["blocker"]);
  assert.equal(service.activeCount, 1);
  assert.equal(service.pendingCount, 2);
  assert.equal(overlappingRun.outcome, "skipped");
  assert.match(overlappingRun.error ?? "", /already pending or active/i);

  service.update(job(second, async () => {
    starts.push("latest-second");
    await new Promise<void>((resolve) => releases.push(resolve));
  }, { enabled: false }));
  releases.shift()?.();
  await flushTasks();
  assert.deepEqual(starts, ["blocker", "latest-second"], "the oldest queued job must acquire the next slot using its current callback");
  assert.equal((await firstRun).outcome, "success");

  releases.shift()?.();
  await flushTasks();
  assert.deepEqual(starts, ["blocker", "latest-second", "third"]);
  assert.equal((await secondRun).outcome, "success");
  assert.equal((await thirdRun).outcome, "success");
  assert.deepEqual(service.listRunResults().map(({ outcome }) => outcome), ["skipped", "success", "success", "success"]);
  service.close();
});

test("WorkFoldAutomationService schedules intervals, exposes the next due time, and honors explicit disabled manual runs", async () => {
  const clock = new FakeClock(startTime);
  const contexts: WorkFoldAutomationRunContext[] = [];
  const observedReasons: string[] = [];
  const automation = key("space-one/app-one", "refresh");
  const service = new WorkFoldAutomationService({
    clock,
    createRunId: runIds().next,
    onResult: (result) => { observedReasons.push(result.reason); },
  });
  service.register(job(automation, (context) => { contexts.push(context); }));
  assert.equal(service.nextScheduledAt(automation), "2026-07-14T12:01:00.000Z");

  clock.advance(minute - 1);
  await flushTasks();
  assert.equal(contexts.length, 0);
  clock.advance(1);
  await flushTasks();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.reason, "scheduled");
  assert.equal(contexts[0]?.scheduledAt, "2026-07-14T12:01:00.000Z");
  assert.equal(service.nextScheduledAt(automation), "2026-07-14T12:02:00.000Z");

  service.update(job(automation, (context) => { contexts.push(context); }, { enabled: false }));
  assert.equal(service.nextScheduledAt(automation), undefined);
  clock.advance(10 * minute);
  await flushTasks();
  assert.equal(contexts.length, 1, "disabled jobs must not launch on their cadence");
  const manual = await service.runNow(automation);
  assert.equal(manual.outcome, "success", "enabled controls scheduling, not an independently authorized one-off run");
  assert.equal(contexts[1]?.reason, "manual");

  service.update(job(automation, (context) => { contexts.push(context); }, { intervalMinutes: 2 }));
  assert.equal(service.nextScheduledAt(automation), "2026-07-14T12:13:00.000Z");
  clock.advance(2 * minute);
  await flushTasks();
  assert.equal(contexts.at(-1)?.reason, "scheduled");
  assert.deepEqual(observedReasons, ["scheduled", "manual", "scheduled"], "scheduled and explicit results must share one receipt callback");
  service.close();
});

test("WorkFoldAutomationService schedules one-time jobs once, keeps run-now independent, and applies missed policy", async () => {
  const clock = new FakeClock(startTime);
  const contexts: WorkFoldAutomationRunContext[] = [];
  const future = key("owner", "future-once");
  const missedRun = key("owner", "missed-run");
  const missedSkip = key("owner", "missed-skip");
  const service = new WorkFoldAutomationService({
    clock,
    createRunId: runIds().next,
    catchUpStagger: () => 0,
  });
  service.register({
    key: future,
    schedule: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
    enabled: true,
    run: (context) => { contexts.push(context); },
  });
  assert.equal(service.nextScheduledAt(future), "2026-07-14T12:02:00.000Z");
  assert.equal((await service.runNow(future)).reason, "manual");
  assert.equal(service.nextScheduledAt(future), "2026-07-14T12:02:00.000Z", "run-now never consumes the one-time slot");

  clock.advance(2 * minute);
  await flushTasks();
  assert.deepEqual(contexts.map(({ reason }) => reason), ["manual", "scheduled"]);
  assert.equal(service.nextScheduledAt(future), undefined);
  clock.advance(10 * minute);
  await flushTasks();
  assert.equal(contexts.filter(({ key: value }) => value.jobId === future.jobId).length, 2, "the scheduled occurrence fires once");
  for (const enabled of [false, true]) {
    service.update({
      key: future,
      schedule: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
      enabled,
      run: (context) => { contexts.push(context); },
    });
  }
  clock.advance(minute);
  await flushTasks();
  assert.equal(contexts.filter(({ key: value }) => value.jobId === future.jobId).length, 2, "disable/re-enable cannot rearm a consumed occurrence");

  service.register({
    key: missedRun,
    schedule: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
    enabled: true,
    run: (context) => { contexts.push(context); },
  });
  service.register({
    key: missedSkip,
    schedule: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "skip" },
    enabled: true,
    run: (context) => { contexts.push(context); },
  });
  clock.advance(0);
  await flushTasks();
  assert.equal(contexts.some(({ key: value, reason }) => value.jobId === missedRun.jobId && reason === "resume"), true);
  assert.equal(contexts.some(({ key: value }) => value.jobId === missedSkip.jobId), false);
  assert.equal(service.nextScheduledAt(missedRun), undefined);
  assert.equal(service.nextScheduledAt(missedSkip), undefined);
  service.close();
});

test("suspension preserves a queued one-time catch-up until resume", async () => {
  const clock = new FakeClock(startTime);
  const releases: Array<() => void> = [];
  const contexts: WorkFoldAutomationRunContext[] = [];
  const blocker = key("owner", "blocker");
  const once = key("owner", "once");
  const service = new WorkFoldAutomationService({
    clock,
    maxConcurrency: 1,
    createRunId: runIds().next,
    catchUpStagger: () => 0,
  });
  service.register(job(blocker, async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
  }));
  service.register({
    key: once,
    schedule: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
    enabled: true,
    run: (context) => { contexts.push(context); },
  });

  const blockingRun = service.runNow(blocker);
  clock.advance(minute);
  assert.equal(service.pendingCount, 1, "the due occurrence waits behind the machine-wide slot");
  service.suspend();
  await flushTasks();
  const paused = service.listRunResults(once)[0];
  assert.equal(paused?.notLaunchedReason, "suspended");
  assert.deepEqual(contexts, []);

  releases.shift()?.();
  await blockingRun;
  service.resume();
  clock.advance(0);
  await flushTasks();
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.reason, "resume");
  assert.equal(contexts[0]?.scheduledAt, "2026-07-14T12:01:00.000Z");
  clock.advance(24 * 60 * minute);
  await flushTasks();
  assert.equal(contexts.length, 1, "the preserved occurrence still launches only once");
  service.close();
});

test("WorkFoldAutomationService restores a persisted cadence and performs at most one deterministically staggered latest catch-up", async () => {
  const clock = new FakeClock(startTime);
  const contexts: WorkFoldAutomationRunContext[] = [];
  const latestOne = key("space-one/app-one", "one");
  const latestTwo = key("space-two/app-two", "two");
  const noCatchUp = key("space-three/app-three", "none");
  const service = new WorkFoldAutomationService({
    clock,
    createRunId: runIds().next,
    catchUpStagger: ({ jobId }) => jobId === "one" ? 10 : jobId === "two" ? 20 : 0,
  });
  const persistedAt = "2026-07-14T11:54:30.000Z";
  service.register(job(latestOne, (context) => { contexts.push(context); }, { catchUp: "latest", lastScheduledAt: persistedAt }));
  service.register(job(latestTwo, (context) => { contexts.push(context); }, { catchUp: "latest", lastScheduledAt: persistedAt }));
  service.register(job(noCatchUp, (context) => { contexts.push(context); }, { catchUp: "none", lastScheduledAt: persistedAt }));

  assert.equal(service.nextScheduledAt(latestOne), "2026-07-14T12:00:30.000Z");
  assert.equal(contexts.length, 0);
  clock.advance(9);
  await flushTasks();
  assert.equal(contexts.length, 0);
  clock.advance(1);
  await flushTasks();
  assert.deepEqual(contexts.map(({ key: value }) => value.jobId), ["one"]);
  assert.equal(contexts[0]?.reason, "resume");
  assert.equal(contexts[0]?.scheduledAt, "2026-07-14T11:59:30.000Z", "only the latest missed point in the persisted cadence is retained");
  clock.advance(10);
  await flushTasks();
  assert.deepEqual(contexts.map(({ key: value }) => value.jobId), ["one", "two"]);
  assert.equal(contexts.filter(({ reason }) => reason === "resume").length, 2);
  assert.equal(contexts.some(({ key: value }) => value.jobId === "none"), false);

  service.suspend();
  clock.advance(5 * minute);
  service.resume();
  clock.advance(20);
  await flushTasks();
  const resumed = contexts.filter(({ reason }) => reason === "resume");
  assert.deepEqual(resumed.map(({ key: value }) => value.jobId), ["one", "two", "one", "two"]);
  assert.equal(resumed[2]?.scheduledAt, "2026-07-14T12:04:30.000Z");
  assert.equal(resumed[3]?.scheduledAt, "2026-07-14T12:04:30.000Z");
  assert.equal(contexts.filter(({ key: value, reason }) => value.jobId === "none" && reason === "resume").length, 0);

  assert.equal(workFoldAutomationCatchUpStagger(latestOne), workFoldAutomationCatchUpStagger({ ...latestOne }));
  assert.ok(workFoldAutomationCatchUpStagger(latestOne) >= 1_000);
  assert.ok(workFoldAutomationCatchUpStagger(latestOne) <= 30_999);
  service.close();
});

test("WorkFoldAutomationService unregisters queued generations without launching stale work", async () => {
  const clock = new FakeClock(startTime);
  const starts: string[] = [];
  let releaseBlocker!: () => void;
  const blocker = key("owner", "blocker");
  const target = key("owner", "target");
  const service = new WorkFoldAutomationService({ clock, maxConcurrency: 1, createRunId: runIds().next });
  service.register(job(blocker, async () => {
    starts.push("blocker");
    await new Promise<void>((resolve) => { releaseBlocker = resolve; });
  }));
  service.register(job(target, () => { starts.push("stale"); }));
  const blockerRun = service.runNow(blocker);
  const staleRun = service.runNow(target);
  assert.equal(service.unregister(target), true);
  assert.equal((await staleRun).outcome, "cancelled");
  assert.equal(service.unregister(target), false);

  service.register(job(target, () => { starts.push("current"); }));
  const currentRun = service.runNow(target);
  releaseBlocker();
  await flushTasks();
  assert.equal((await blockerRun).outcome, "success");
  assert.equal((await currentRun).outcome, "success");
  assert.deepEqual(starts, ["blocker", "current"]);
  service.close();
});

test("WorkFoldAutomationService aborts active work when a job is disabled or scheduling is suspended", async () => {
  const clock = new FakeClock(startTime);
  const service = new WorkFoldAutomationService({ clock, createRunId: runIds().next });
  const disableKey = key("owner", "disable");
  const suspendKey = key("owner", "suspend");
  const waitForAbort = (context: WorkFoldAutomationRunContext) => new Promise<void>((resolve) => {
    context.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  service.register(job(disableKey, waitForAbort));
  service.register(job(suspendKey, waitForAbort));

  const disabledRun = service.runNow(disableKey);
  service.update(job(disableKey, waitForAbort, { enabled: false }));
  assert.equal((await disabledRun).outcome, "cancelled");

  const suspendedRun = service.runNow(suspendKey);
  service.suspend();
  assert.equal((await suspendedRun).outcome, "cancelled");
  assert.equal(service.suspended, true);
  service.close();
});

test("WorkFoldAutomationService records bounded failures and isolates observable onResult failures", async () => {
  const clock = new FakeClock(startTime);
  const observed: string[] = [];
  const failing = key("owner", "failure");
  const service = new WorkFoldAutomationService({
    clock,
    maxRunResults: 2,
    createRunId: runIds().next,
    async onResult(result) {
      observed.push(result.runId);
      result.key.ownerId = "mutated observer copy";
      throw new Error(`receipt failure for ${result.runId}`);
    },
  });
  service.register(job(failing, () => { throw new Error("x".repeat(500)); }));

  const first = await service.runNow(failing);
  const second = await service.runNow(failing);
  const third = await service.runNow(failing);
  assert.equal(first.outcome, "failure");
  assert.equal(first.error?.length, workFoldAutomationMaxErrorLength);
  assert.deepEqual(observed, [first.runId, second.runId, third.runId]);
  assert.deepEqual(service.listRunResults().map(({ runId }) => runId), [second.runId, third.runId], "the in-memory ledger must remain bounded");
  assert.equal(service.listRunResults()[0]?.key.ownerId, "owner", "observers must receive defensive result copies");
  assert.deepEqual(service.listResultCallbackErrors().map(({ runId }) => runId), [second.runId, third.runId]);
  assert.match(service.listResultCallbackErrors()[0]?.error ?? "", /receipt failure/);
  service.close();
});

test("WorkFoldAutomationService close cancels queued and active work, clears timers, and prevents later launches", async () => {
  const clock = new FakeClock(startTime);
  const starts: string[] = [];
  const active = key("owner", "active");
  const queued = key("owner", "queued");
  const service = new WorkFoldAutomationService({ clock, maxConcurrency: 1, createRunId: runIds().next });
  service.register(job(active, async (context) => {
    starts.push("active");
    await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
  }));
  service.register(job(queued, () => { starts.push("queued"); }));
  const activeRun = service.runNow(active);
  const queuedRun = service.runNow(queued);
  service.close();
  assert.equal(service.closed, true);
  assert.equal(service.size, 0);
  assert.equal((await queuedRun).outcome, "cancelled");
  assert.equal((await activeRun).outcome, "cancelled");
  assert.deepEqual(starts, ["active"]);

  clock.advance(100 * minute);
  await flushTasks();
  assert.deepEqual(starts, ["active"]);
  const afterClose = await service.runNow(active);
  assert.equal(afterClose.outcome, "cancelled");
  assert.match(afterClose.error ?? "", /closed/i);
  assert.throws(() => service.register(job(active, () => undefined)), /closed/i);
});

function key(ownerId: string, jobId: string): WorkFoldAutomationJobKey {
  return { ownerId, jobId };
}

function job(
  automationKey: WorkFoldAutomationJobKey,
  run: WorkFoldAutomationJobDefinition["run"],
  overrides: Partial<Omit<WorkFoldAutomationJobDefinition, "key" | "run">> = {},
): WorkFoldAutomationJobDefinition {
  return {
    key: automationKey,
    intervalMinutes: 1,
    enabled: true,
    catchUp: "none",
    run,
    ...overrides,
  };
}

function runIds(): { next: () => string } {
  let id = 0;
  return { next: () => `run-${++id}` };
}

async function flushTasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

class FakeClock implements WorkFoldAutomationClock {
  #now: number;
  #nextTimerId = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now: number) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = ++this.#nextTimerId;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(Number(handle));
  }

  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([leftId, left], [rightId, right]) => left.at - right.at || leftId - rightId)[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.callback();
    }
    this.#now = target;
  }
}
