import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { WorkFoldAutomationClock } from "../src/local/agent/work-fold-automation-service.js";
import { createWorkFoldGlanceRoutingRunReader } from "../src/local/glance.js";
import {
  normalizeWorkFoldRoutingDeclaration,
  workFoldRoutingDigest,
  type WorkFoldRoutingChatStep,
  type WorkFoldRoutingCheckStep,
  type WorkFoldRoutingFilesStep,
} from "../src/local/routings/routing-declarations.js";
import {
  WorkFoldRoutingService,
  WorkFoldRoutingServiceError,
  type WorkFoldRoutingChatHopResult,
  type WorkFoldRoutingCheckHopResult,
  type WorkFoldRoutingCheckpointManifest,
  type WorkFoldRoutingFilesHopResult,
  type WorkFoldRoutingHopContext,
  type WorkFoldRoutingHopPorts,
  type WorkFoldRoutingResolvedFilesSource,
} from "../src/local/routings/routing-service.js";
import {
  WorkFoldRoutingReceipts,
  WorkFoldRoutingStore,
  type WorkFoldRoutingReceiptV1,
  type WorkFoldRoutingRecord,
} from "../src/local/routings/routing-store.js";
import { WorkFoldSettleSignal, type WorkFoldCheckRunSettleRecord } from "../src/local/routings/settle-signal.js";

const startTime = Date.parse("2026-07-14T12:00:00.000Z");
const minute = 60_000;
const spaceA = "space-aaaaaaaaaaaaaaaa";
const spaceB = "space-bbbbbbbbbbbbbbbb";
const spaceC = "space-cccccccccccccccc";

interface RecordedPortCall {
  kind: "chat" | "files" | "check";
  hopId: string;
  runId: string;
  routingId: string;
  lineage: WorkFoldRoutingHopContext["lineage"];
  source?: WorkFoldRoutingResolvedFilesSource;
}

class FakePorts implements WorkFoldRoutingHopPorts {
  readonly calls: RecordedPortCall[] = [];
  readonly manifests = new Map<string, WorkFoldRoutingCheckpointManifest>();
  chatImpl: (step: WorkFoldRoutingChatStep, context: WorkFoldRoutingHopContext) => Promise<WorkFoldRoutingChatHopResult>;
  filesImpl: (
    step: WorkFoldRoutingFilesStep,
    source: WorkFoldRoutingResolvedFilesSource,
    context: WorkFoldRoutingHopContext,
  ) => Promise<WorkFoldRoutingFilesHopResult>;
  checkImpl: (step: WorkFoldRoutingCheckStep, context: WorkFoldRoutingHopContext) => Promise<WorkFoldRoutingCheckHopResult>;

  constructor() {
    this.chatImpl = this.defaultChat;
    this.filesImpl = async (_step, source, context) => ({
      restorePointId: `restore-${context.hopId}`,
      copiedPaths: source.kind === "paths" ? [...source.paths] : ["resolved/tree.md"],
      fileCount: source.kind === "paths" ? source.paths.length : 1,
      totalBytes: 64,
    });
    this.checkImpl = async (_step, context) => ({
      runId: `check-run-${context.hopId}`,
      taskId: `check-task-${context.hopId}`,
      state: "succeeded",
      checkIds: ["check-quality-gate"],
      findingCount: 2,
      admittedCount: 2,
    });
  }

  readonly defaultChat = async (
    _step: WorkFoldRoutingChatStep,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingChatHopResult> => ({
    conversationId: `conversation-${context.hopId}`,
    turnTaskId: `turn-task-${context.hopId}`,
    outcome: "succeeded",
    preCheckpointId: `pre-${context.hopId}`,
    postCheckpointId: `post-${context.hopId}`,
  });

  /** A chat turn that runs until its abort path settles it, like a real turn abort. */
  readonly abortableChat = (
    _step: WorkFoldRoutingChatStep,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingChatHopResult> => new Promise((resolvePromise) => {
    const settle = () => resolvePromise({
      conversationId: `conversation-${context.hopId}`,
      turnTaskId: `turn-task-${context.hopId}`,
      outcome: "aborted",
    });
    if (context.signal.aborted) settle();
    else context.signal.addEventListener("abort", settle, { once: true });
  });

  async chat(step: WorkFoldRoutingChatStep, context: WorkFoldRoutingHopContext): Promise<WorkFoldRoutingChatHopResult> {
    this.calls.push({ kind: "chat", hopId: context.hopId, runId: context.runId, routingId: context.routingId, lineage: context.lineage });
    return this.chatImpl(step, context);
  }

  async files(
    step: WorkFoldRoutingFilesStep,
    source: WorkFoldRoutingResolvedFilesSource,
    context: WorkFoldRoutingHopContext,
  ): Promise<WorkFoldRoutingFilesHopResult> {
    this.calls.push({ kind: "files", hopId: context.hopId, runId: context.runId, routingId: context.routingId, lineage: context.lineage, source });
    return this.filesImpl(step, source, context);
  }

  async check(step: WorkFoldRoutingCheckStep, context: WorkFoldRoutingHopContext): Promise<WorkFoldRoutingCheckHopResult> {
    this.calls.push({ kind: "check", hopId: context.hopId, runId: context.runId, routingId: context.routingId, lineage: context.lineage });
    return this.checkImpl(step, context);
  }

  async checkpointManifest(spaceId: string, checkpointId: string): Promise<WorkFoldRoutingCheckpointManifest | null> {
    return this.manifests.get(`${spaceId}/${checkpointId}`) ?? null;
  }
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

interface Harness {
  sandbox: string;
  clock: FakeClock;
  ports: FakePorts;
  signal: WorkFoldSettleSignal;
  store: WorkFoldRoutingStore;
  service: WorkFoldRoutingService;
  journalPath: string;
  enable(raw: unknown, decisionId?: string): Promise<WorkFoldRoutingRecord>;
  journal(): Promise<WorkFoldRoutingReceiptV1[]>;
  runLines(): Promise<string[]>;
}

async function createHarness(t: TestContext, options: { maxConcurrency?: number } = {}): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-service-"));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "routings", "receipts.jsonl");
  const receipts = new WorkFoldRoutingReceipts({
    path: journalPath,
    rotatedPath: join(sandbox, "routings", "receipts.1.jsonl"),
    now,
  });
  const store = await WorkFoldRoutingStore.create({ path: join(sandbox, "routings", "routings.json"), receipts, now });
  const signal = new WorkFoldSettleSignal({ now });
  const ports = new FakePorts();
  let nextRunId = 0;
  const service = await WorkFoldRoutingService.create({
    store,
    ports,
    settleSignal: signal,
    clock,
    createRunId: () => `run-${++nextRunId}`,
    catchUpStagger: () => 0,
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {}),
  });
  t.after(async () => {
    service.close();
    // close() aborts active runs whose best-effort terminal appends may still
    // be in flight; retry so a racing write never fails an unrelated test.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(sandbox, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  });
  const journal = async () => {
    const text = await readFile(journalPath, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as WorkFoldRoutingReceiptV1);
  };
  return {
    sandbox,
    clock,
    ports,
    signal,
    store,
    service,
    journalPath,
    enable: async (raw, decisionId = "decision-1") => {
      const declaration = normalizeWorkFoldRoutingDeclaration(raw);
      return await service.enable({
        declaration,
        expectedDigest: workFoldRoutingDigest(declaration),
        decision: { decisionId, surface: "popover" },
      });
    },
    journal,
    runLines: async () => (await journal())
      .filter((line) => line.scope !== "routing")
      .map((line) => `${line.scope}:${line.outcome}:${line.hopId ?? "-"}`),
  };
}

function declarationInput(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "work-fold.routing",
    version: 1,
    id,
    title: `Routing ${id}`,
    createdBy: "assistant",
    createdAt: "2026-07-01T00:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{ id: "review", kind: "chat", space: spaceA, message: "Review chapters for unresolved notes." }],
    ...overrides,
  };
}

const pipelineSteps = [
  { id: "review", kind: "chat", space: spaceA, message: "Review chapters for unresolved notes." },
  { id: "handoff", kind: "files", fromSpace: spaceA, from: { kind: "paths", paths: ["reports/weekly.md"] }, toSpace: spaceB, to: "Incoming" },
  { id: "verify", kind: "check", space: spaceB },
];

const checkSettle: WorkFoldCheckRunSettleRecord = {
  kind: "check-run",
  spaceId: spaceA,
  runId: "settled-check-run-1",
  taskId: "settled-check-task-1",
  checkIds: ["check-quality-gate"],
  state: "succeeded",
  startedAt: "2026-07-14T11:59:00.000Z",
  endedAt: "2026-07-14T11:59:30.000Z",
};

async function waitForCondition(predicate: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("a scheduled run executes hops strictly in order with journal-first receipts, cadence, and glance visibility", async (t) => {
  const harness = await createHarness(t);
  const record = await harness.enable(declarationInput("routing-weekly-handoff", {
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps: pipelineSteps,
  }));

  harness.clock.advance(60 * minute);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the scheduled run to settle",
  );

  assert.deepEqual(await harness.runLines(), [
    "run:accepted:-",
    "hop:accepted:review",
    "hop:succeeded:review",
    "hop:accepted:handoff",
    "hop:succeeded:handoff",
    "hop:accepted:verify",
    "hop:succeeded:verify",
    "run:succeeded:-",
  ], "the accepted record lands before hop 1 and every hop journals before and after its mutation");

  const lines = await harness.journal();
  const accepted = lines.find((line) => line.scope === "run" && line.outcome === "accepted");
  assert.equal(accepted?.title, "Routing routing-weekly-handoff");
  assert.equal(accepted?.digest, record.digest, "the run receipt names the declaration digest in force");
  assert.deepEqual(accepted?.cause, { kind: "scheduled", slotAt: "2026-07-14T13:00:00.000Z" }, "the terminal cause names the exact scheduled slot");

  const chatDone = lines.find((line) => line.hopId === "review" && line.outcome === "succeeded");
  assert.equal(chatDone?.spaceId, spaceA);
  assert.equal(chatDone?.conversationId, "conversation-review");
  assert.equal(chatDone?.taskId, "turn-task-review");
  assert.deepEqual(chatDone?.checkpointIds, ["pre-review", "post-review"]);

  const filesDone = lines.find((line) => line.hopId === "handoff" && line.outcome === "succeeded");
  assert.equal(filesDone?.fromSpaceId, spaceA);
  assert.equal(filesDone?.toSpaceId, spaceB);
  assert.deepEqual(filesDone?.sourcePaths, ["reports/weekly.md"]);
  assert.deepEqual(filesDone?.copiedPaths, ["reports/weekly.md"]);
  assert.equal(filesDone?.restorePointId, "restore-handoff");

  const checkDone = lines.find((line) => line.hopId === "verify" && line.outcome === "succeeded");
  assert.equal(checkDone?.checkRunId, "check-run-verify");
  assert.equal(checkDone?.findingCount, 2, "a succeeded Check hop succeeds even when it admits findings; glue is not a gate");

  assert.deepEqual(harness.ports.calls.map((call) => call.kind), ["chat", "files", "check"]);
  const runId = accepted?.runId ?? "";
  assert.deepEqual(
    harness.ports.calls[2]?.lineage,
    { kind: "routing-hop", routingId: "routing-weekly-handoff", routingRunId: runId, hopId: "verify" },
    "every hop-caused domain run carries routing lineage",
  );

  await waitForCondition(
    async () => (await harness.store.get("routing-weekly-handoff"))?.lastScheduledAt === "2026-07-14T13:00:00.000Z",
    "the durable cadence anchor to advance to the fired slot",
  );
  const projection = await harness.service.getRouting("routing-weekly-handoff");
  assert.equal(projection?.nextScheduledAt, "2026-07-14T14:00:00.000Z");

  const glanceRuns = await createWorkFoldGlanceRoutingRunReader({ stateRoot: harness.sandbox })();
  assert.equal(glanceRuns.length, 1);
  assert.equal(glanceRuns[0]?.state, "succeeded");
  assert.equal(glanceRuns[0]?.title, "Routing routing-weekly-handoff");
  assert.deepEqual(glanceRuns[0]?.hops, [
    { id: "review", state: "succeeded" },
    { id: "handoff", state: "succeeded" },
    { id: "verify", state: "succeeded" },
  ], "the glance's tolerant reader consumes the journal this executor writes");
});

test("an interval slot is claimed durably after acceptance and before hop 1", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-interval-pre-hop-claim", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }));
  let anchorSeenByHop: string | undefined;
  harness.ports.chatImpl = async (step, context) => {
    anchorSeenByHop = (await harness.store.get(context.routingId))?.lastScheduledAt;
    return await harness.ports.defaultChat(step, context);
  };

  harness.clock.advance(60 * minute);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the interval run to settle",
  );
  assert.equal(anchorSeenByHop, "2026-07-14T13:00:00.000Z");
  assert.deepEqual(
    (await harness.journal()).slice(0, 2).map((line) => `${line.scope}:${line.outcome}`),
    ["routing:enabled", "run:accepted"],
    "acceptance is durable before the cadence claim and hop receipts",
  );
});

test("an interval cadence persistence failure closes the accepted run before any hop", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-interval-claim-fails", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }));
  harness.store.recordCadence = async () => {
    throw new Error("injected cadence write failure");
  };

  harness.clock.advance(60 * minute);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "failed"),
    "the cadence claim failure to receive a terminal receipt",
  );
  assert.deepEqual(harness.ports.calls, [], "a rejected cadence claim never reaches hop 1");
  const runLines = (await harness.journal()).filter((line) => line.scope === "run");
  assert.deepEqual(runLines.map((line) => line.outcome), ["accepted", "failed"]);
  assert.match(runLines[1]?.detail ?? "", /injected cadence write failure/);
});

test("a one-time occurrence persistence failure closes the accepted run before any hop", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-at-claim-fails", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }));
  harness.store.claimAtOccurrence = async () => {
    throw new Error("injected occurrence write failure");
  };

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "failed"),
    "the occurrence claim failure to receive a terminal receipt",
  );
  assert.deepEqual(harness.ports.calls, [], "a rejected one-time claim never reaches hop 1");
  const runLines = (await harness.journal()).filter((line) => line.scope === "run");
  assert.deepEqual(runLines.map((line) => line.outcome), ["accepted", "failed"]);
  assert.match(runLines[1]?.detail ?? "", /injected occurrence write failure/);
});

test("a one-time routing runs once, durably completes before hop 1, and run-now executes an independent copy", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-one-time", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  assert.equal((await harness.service.getRouting("routing-one-time"))?.nextScheduledAt, "2026-07-14T12:02:00.000Z");

  const manual = await harness.service.runNow("routing-one-time", { requestId: "request-copy", surface: "popover" });
  assert.equal(manual.outcome, "success");
  assert.equal((await harness.store.get("routing-one-time"))?.health, "enabled", "run-now does not consume the scheduled occurrence");

  harness.clock.advance(2 * minute);
  await waitForCondition(
    async () => (await harness.store.get("routing-one-time"))?.atOccurrence?.finishedAt !== undefined,
    "the one-time occurrence to finish",
  );
  const completed = await harness.service.getRouting("routing-one-time");
  assert.equal(completed?.health, "completed");
  assert.equal(completed?.nextScheduledAt, undefined);
  assert.equal(completed?.activeRunId, undefined);
  assert.equal(completed?.atOccurrence?.slotAt, "2026-07-14T12:02:00.000Z");
  assert.match(completed?.atOccurrence?.occurrenceId ?? "", /^at-[a-f0-9]{32}$/);
  assert.equal(harness.ports.calls.length, 2, "one manual copy and one scheduled occurrence executed");

  const lines = await harness.journal();
  const manualAccepted = lines.find((line) => line.scope === "run" && line.outcome === "accepted" && line.cause?.kind === "run-now");
  assert.equal(manualAccepted?.requestId, "request-copy");
  assert.equal(manualAccepted?.surface, "popover");
  const scheduledAccepted = lines.find((line) => line.scope === "run" && line.outcome === "accepted" && line.cause?.kind === "scheduled");
  assert.equal(scheduledAccepted?.occurrenceId, completed?.atOccurrence?.occurrenceId);

  harness.clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.ports.calls.length, 2, "completed one-time work never rearms");
  await assert.rejects(
    () => harness.service.runNow("routing-one-time"),
    (error: unknown) => error instanceof WorkFoldRoutingServiceError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );
});

test("a one-time slot due during run-now waits and executes after the manual copy", async (t) => {
  for (const ifMissed of ["run", "skip"] as const) {
    const harness = await createHarness(t);
    const release = deferred();
    harness.ports.chatImpl = async (_step, context) => {
      if (context.lineage.cause.kind === "run-now") await release.promise;
      return harness.ports.defaultChat(_step, context);
    };
    const routingId = `routing-at-manual-overlap-${ifMissed}`;
    await harness.enable(declarationInput(routingId, {
      version: 2,
      trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed },
    }));

    const manual = harness.service.runNow(routingId, { requestId: `manual-${ifMissed}` });
    await waitForCondition(
      () => harness.ports.calls.filter((call) => call.routingId === routingId).length === 1,
      "the manual copy to start",
    );
    harness.clock.advance(minute);
    await waitForCondition(
      () => harness.service.listAutomationResults(routingId).some((result) => (
        result.reason === "scheduled" && result.notLaunchedReason === "overlap"
      )),
      "the scheduled admission to reach the in-memory non-overlap fence",
    );
    const overlap = harness.service.listAutomationResults(routingId).find((result) => (
      result.reason === "scheduled" && result.notLaunchedReason === "overlap"
    ));
    assert.equal(overlap?.outcome, "skipped", "the due slot reaches the per-routing non-overlap fence");
    assert.equal((await harness.store.get(routingId))?.health, "enabled");
    assert.equal((await harness.store.get(routingId))?.atOccurrence, undefined);

    release.resolve();
    await manual;
    harness.clock.advance(0);
    await waitForCondition(
      async () => (await harness.store.get(routingId))?.atOccurrence?.finishedAt !== undefined,
      "the preserved one-time slot to finish after the manual copy",
    );
    assert.equal((await harness.store.get(routingId))?.health, "completed");
    assert.equal(
      harness.ports.calls.filter((call) => call.routingId === routingId).length,
      2,
      "the manual copy and the exact scheduled slot each run once",
    );
    assert.ok((await harness.journal()).some((line) => (
      line.routingId === routingId
      && line.scope === "run"
      && line.outcome === "skipped"
      && line.cause?.kind === "scheduled"
    )), "the overlap is durably receipted before the preserved slot finishes");
  }
});

test("a crash after the durable one-time claim cannot replay the occurrence", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-at-claim-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "routings", "receipts.jsonl");
  const receipts = new WorkFoldRoutingReceipts({ path: journalPath, now });
  const statePath = join(sandbox, "routings", "routings.json");
  const store = await WorkFoldRoutingStore.create({ path: statePath, receipts, now });
  const declaration = normalizeWorkFoldRoutingDeclaration(declarationInput("routing-claimed-before-crash", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  await store.enable({
    declaration,
    expectedDigest: workFoldRoutingDigest(declaration),
    decision: { decisionId: "decision-claim", surface: "popover" },
  });
  await store.claimAtOccurrence(
    declaration.id,
    "2026-07-14T12:02:00.000Z",
    "run-claimed",
    new Date("2026-07-14T12:02:00.000Z"),
  );

  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldRoutingService.create({ store: reloaded, ports, clock, catchUpStagger: () => 0 });
  t.after(() => service.close());
  assert.equal(service.status().armedRoutingCount, 0);
  assert.deepEqual(ports.calls, []);
  assert.equal((await service.getRouting(declaration.id))?.health, "completed");
  assert.equal((await service.getRouting(declaration.id))?.atOccurrence?.finishedAt, clock.now().toISOString());

  clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ports.calls, [], "startup records the unfinished claim but never replays it");
});

test("startup reconciles a crash between a one-time accepted receipt and its durable claim", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-at-accepted-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "routings", "receipts.jsonl");
  const receipts = new WorkFoldRoutingReceipts({ path: journalPath, now });
  const statePath = join(sandbox, "routings", "routings.json");
  const store = await WorkFoldRoutingStore.create({ path: statePath, receipts, now });
  const declaration = normalizeWorkFoldRoutingDeclaration(declarationInput("routing-accepted-before-claim", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  const enabled = await store.enable({
    declaration,
    expectedDigest: workFoldRoutingDigest(declaration),
    decision: { decisionId: "decision-accepted", surface: "main-window" },
  });
  await receipts.append({
    scope: "run",
    outcome: "accepted",
    routingId: declaration.id,
    runId: "run-accepted",
    title: declaration.title,
    digest: enabled.digest,
    cause: { kind: "scheduled", slotAt: declaration.trigger.kind === "at" ? declaration.trigger.at : "" },
  });

  const reloaded = await WorkFoldRoutingStore.create({ path: statePath, receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldRoutingService.create({ store: reloaded, ports, clock, catchUpStagger: () => 0 });
  t.after(() => service.close());

  const completed = await service.getRouting(declaration.id);
  assert.equal(completed?.health, "completed");
  assert.equal(completed?.atOccurrence?.runId, "run-accepted");
  assert.ok(completed?.atOccurrence?.finishedAt);
  assert.deepEqual(ports.calls, [], "the recovered accepted occurrence is consumed and never replayed");
  const runLines = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkFoldRoutingReceiptV1)
    .filter((line) => line.runId === "run-accepted" && line.scope === "run");
  assert.deepEqual(runLines.map((line) => line.outcome), ["accepted", "interrupted"]);
});

test("failed and stopped scheduled one-time runs still consume their occurrence", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-at-failure", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }), "decision-failure");
  await harness.enable(declarationInput("routing-at-stopped", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }), "decision-stopped");
  harness.ports.chatImpl = (step, context) => context.routingId === "routing-at-failure"
    ? Promise.resolve({
        conversationId: "conversation-failed-at",
        turnTaskId: "turn-task-failed-at",
        outcome: "failed",
        error: "The provider refused this turn.",
      })
    : harness.ports.abortableChat(step, context);

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.store.get("routing-at-failure"))?.atOccurrence?.finishedAt !== undefined,
    "the failed occurrence to finish",
  );
  assert.equal((await harness.store.get("routing-at-failure"))?.health, "completed");

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.service.getRouting("routing-at-stopped"))?.activeRunId !== undefined,
    "the stopped occurrence to become active",
  );
  harness.service.stopRun("routing-at-stopped", { requestId: "request-stop-at", surface: "main-window" });
  await waitForCondition(
    async () => (await harness.store.get("routing-at-stopped"))?.atOccurrence?.finishedAt !== undefined,
    "the stopped occurrence to finish",
  );
  assert.equal((await harness.store.get("routing-at-stopped"))?.health, "completed");

  harness.clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.ports.calls.filter((call) => call.routingId === "routing-at-failure").length, 1);
  assert.equal(harness.ports.calls.filter((call) => call.routingId === "routing-at-stopped").length, 1);
});

test("an active completed one-time routing must be stopped before deletion", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-at-delete-active", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }));
  harness.ports.chatImpl = harness.ports.abortableChat;

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.service.getRouting("routing-at-delete-active"))?.activeRunId !== undefined,
    "the one-time run to become active",
  );
  assert.equal((await harness.store.get("routing-at-delete-active"))?.health, "completed");
  await assert.rejects(
    () => harness.service.deleteRouting("routing-at-delete-active"),
    (error: unknown) => error instanceof WorkFoldRoutingServiceError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );

  assert.ok(harness.service.stopRun("routing-at-delete-active"));
  await waitForCondition(
    async () => (await harness.service.getRouting("routing-at-delete-active"))?.activeRunId === undefined,
    "the stopped one-time run to settle",
  );
  assert.equal((await harness.service.deleteRouting("routing-at-delete-active")).declaration.id, "routing-at-delete-active");
});

test("a queued due occurrence survives suspend and catches up exactly once on resume", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("routing-suspend-blocker"));
  await harness.enable(declarationInput("routing-suspend-once", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }));
  harness.ports.chatImpl = (step, context) => context.routingId === "routing-suspend-blocker"
    ? harness.ports.abortableChat(step, context)
    : harness.ports.defaultChat(step, context);

  const blocker = harness.service.runNow("routing-suspend-blocker");
  await waitForCondition(
    () => harness.ports.calls.some((call) => call.routingId === "routing-suspend-blocker"),
    "the blocking route to acquire the only slot",
  );
  harness.clock.advance(minute);
  harness.service.suspend();
  await blocker;
  await waitForCondition(
    () => harness.service.listAutomationResults("routing-suspend-once")
      .some((result) => result.notLaunchedReason === "suspended"),
    "the queued one-time admission to settle as suspended",
  );
  assert.equal((await harness.store.get("routing-suspend-once"))?.health, "enabled");
  assert.equal((await harness.store.get("routing-suspend-once"))?.atOccurrence, undefined);

  await harness.service.resume();
  harness.clock.advance(0);
  await waitForCondition(
    async () => (await harness.store.get("routing-suspend-once"))?.atOccurrence?.finishedAt !== undefined,
    "the preserved occurrence to catch up",
  );
  assert.equal(
    harness.ports.calls.filter((call) => call.routingId === "routing-suspend-once").length,
    1,
  );
  harness.clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(
    harness.ports.calls.filter((call) => call.routingId === "routing-suspend-once").length,
    1,
    "resume cannot replay the occurrence",
  );
});

test("a newer suspend wins over an older asynchronous resume", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-resume-generation", {
    trigger: { kind: "interval", intervalMinutes: 30 },
  }));
  const originalList = harness.store.list.bind(harness.store);
  const entered = deferred();
  const release = deferred();
  let delayNextList = true;
  (harness.store as unknown as { list: () => Promise<WorkFoldRoutingRecord[]> }).list = async () => {
    if (delayNextList) {
      delayNextList = false;
      entered.resolve();
      await release.promise;
    }
    return await originalList();
  };

  harness.service.suspend();
  const staleResume = harness.service.resume();
  await entered.promise;
  harness.service.suspend();
  release.resolve();
  await staleResume;
  harness.clock.advance(30 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.ports.calls.length, 0, "the stale continuation cannot re-enable scheduling");

  await harness.service.resume();
  harness.clock.advance(0);
  await waitForCondition(() => harness.ports.calls.length === 1, "the later explicit resume to catch up");
});

test("restart catch-up runs or skips a missed one-time occurrence exactly as declared", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-at-missed-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const receipts = new WorkFoldRoutingReceipts({ path: join(sandbox, "receipts.jsonl"), now });
  const store = await WorkFoldRoutingStore.create({ path: join(sandbox, "routings.json"), receipts, now });
  const ports = new FakePorts();
  const first = await WorkFoldRoutingService.create({ store, ports, clock, catchUpStagger: () => 0 });
  for (const [id, ifMissed] of [["routing-missed-run", "run"], ["routing-missed-skip", "skip"]] as const) {
    const declaration = normalizeWorkFoldRoutingDeclaration(declarationInput(id, {
      version: 2,
      trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed },
    }));
    await first.enable({
      declaration,
      expectedDigest: workFoldRoutingDigest(declaration),
      decision: { decisionId: `decision-${ifMissed}`, surface: "popover" },
    });
  }
  first.close();
  clock.advance(2 * minute);

  const restarted = await WorkFoldRoutingService.create({
    store,
    ports,
    clock,
    createRunId: () => "run-catch-up",
    catchUpStagger: () => 0,
  });
  t.after(() => restarted.close());
  clock.advance(0);
  await waitForCondition(
    async () => (await store.get("routing-missed-run"))?.atOccurrence?.finishedAt !== undefined,
    "the missed run policy occurrence to finish",
  );
  assert.equal((await store.get("routing-missed-run"))?.health, "completed");
  assert.equal((await store.get("routing-missed-skip"))?.health, "completed");
  assert.equal(ports.calls.filter((call) => call.routingId === "routing-missed-run").length, 1);
  assert.equal(ports.calls.filter((call) => call.routingId === "routing-missed-skip").length, 0);
  const missedReceipts = (await readFile(join(sandbox, "receipts.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldRoutingReceiptV1);
  const skipped = missedReceipts.filter((line) => line.routingId === "routing-missed-skip");
  assert.ok(skipped.some((line) => line.scope === "run" && line.outcome === "skipped"));
  assert.ok(skipped.some((line) => line.scope === "routing" && line.outcome === "completed"));
  assert.ok(skipped.every((line) => line.outcome !== "lapsed"), "missed skip uses the canonical skipped + completed receipt pair");
});

test("an on-settled trigger admits matching settles only, and routing-caused settles never fire triggers", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-on-settle", {
    trigger: { kind: "on-settled", source: { kind: "check-run", space: spaceA, outcomes: ["succeeded"] } },
    steps: [{ id: "verify", kind: "check", space: spaceB }],
  }));

  harness.signal.publish(checkSettle);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the settle-admitted run to settle",
  );
  const accepted = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "accepted");
  assert.deepEqual(accepted?.cause, {
    kind: "on-settled",
    source: { kind: "check-run", spaceId: spaceA, runId: "settled-check-run-1", state: "succeeded", checkIds: ["check-quality-gate"] },
  }, "the run receipt names the settled source exactly");
  assert.equal(harness.ports.calls[0]?.lineage.routingId, "routing-on-settle");

  harness.signal.publish({ ...checkSettle, runId: "settled-check-run-2", state: "failed" });
  harness.signal.publish({ ...checkSettle, runId: "settled-check-run-3", spaceId: spaceB });
  harness.signal.publish({
    ...checkSettle,
    runId: "settled-check-run-4",
    lineage: { kind: "routing-hop", routingId: "routing-on-settle", routingRunId: "some-run", hopId: "verify" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const acceptedCount = (await harness.journal())
    .filter((line) => line.scope === "run" && line.outcome === "accepted")
    .length;
  assert.equal(acceptedCount, 1, "unmatched outcomes, other Spaces, and lineage-stamped settles admit nothing — chains are structurally impossible");
});

test("per-routing non-overlap settles the second admission skipped, receipted with its own cause", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-manual-only"));
  const gate = deferred();
  harness.ports.chatImpl = async (step, context) => {
    await gate.promise;
    return harness.ports.defaultChat(step, context);
  };

  const first = harness.service.runNow("routing-manual-only", { requestId: "request-1" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the first run to start");
  const second = await harness.service.runNow("routing-manual-only", { requestId: "request-2" });
  assert.equal(second.outcome, "skipped");

  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "skipped"),
    "the skipped admission's receipt",
  );
  const skipped = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "skipped");
  assert.deepEqual(skipped?.cause, { kind: "run-now", requestId: "request-2" }, "the skip receipt names the admission that was refused, not the running one");
  assert.match(skipped?.detail ?? "", /already pending or active/);

  gate.resolve();
  assert.equal((await first).outcome, "success");
  const runOutcomes = (await harness.journal()).filter((line) => line.scope === "run").map((line) => line.outcome);
  assert.deepEqual(runOutcomes.sort(), ["accepted", "skipped", "succeeded"], "exactly one run executed");
});

test("a failed hop fails the run, later hops are recorded skipped naming it, and the next trigger is the only retry", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-weekly-handoff", { steps: pipelineSteps }));
  harness.ports.chatImpl = async (_step, context) => ({
    conversationId: `conversation-${context.hopId}`,
    turnTaskId: `turn-task-${context.hopId}`,
    outcome: "failed",
    error: "The Space Assistant turn failed.",
  });

  const result = await harness.service.runNow("routing-weekly-handoff", { requestId: "request-1" });
  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /Routing hop "review" failed/);
  assert.deepEqual(await harness.runLines(), [
    "run:accepted:-",
    "hop:accepted:review",
    "hop:failed:review",
    "hop:skipped:handoff",
    "hop:skipped:verify",
    "run:failed:-",
  ]);
  const lines = await harness.journal();
  const skippedHop = lines.find((line) => line.hopId === "handoff" && line.outcome === "skipped");
  assert.equal(skippedHop?.failedHopId, "review", "skipped hops name the failing hop");
  const failedRun = lines.find((line) => line.scope === "run" && line.outcome === "failed");
  assert.equal(failedRun?.failedHopId, "review");
  assert.deepEqual(harness.ports.calls.map((call) => call.kind), ["chat"], "later hops never execute after a failure");

  harness.ports.chatImpl = harness.ports.defaultChat;
  const retry = await harness.service.runNow("routing-weekly-handoff", { requestId: "request-2" });
  assert.equal(retry.outcome, "success", "there are no automatic retries; the next trigger occurrence is the retry");
});

test("stop aborts the current hop through its domain path, skips later hops, and names the aborted hop task", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-weekly-handoff", { steps: pipelineSteps }));
  harness.ports.chatImpl = harness.ports.abortableChat;

  const resultPromise = harness.service.runNow("routing-weekly-handoff", { requestId: "request-1" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the chat hop to start");
  assert.match((await harness.service.getRouting("routing-weekly-handoff"))?.activeRunId ?? "", /^run-/);
  const stopped = harness.service.stopRun("routing-weekly-handoff", { requestId: "request-stop", surface: "main-window" });
  assert.ok(stopped, "stop finds the active run");

  const result = await resultPromise;
  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /stopped/);
  assert.deepEqual(await harness.runLines(), [
    "run:accepted:-",
    "hop:accepted:review",
    "hop:stopped:review",
    "hop:skipped:handoff",
    "hop:skipped:verify",
    "run:stopped:-",
  ]);
  const lines = await harness.journal();
  const stoppedRun = lines.find((line) => line.scope === "run" && line.outcome === "stopped");
  assert.deepEqual(stoppedRun?.stoppedHopTaskIds, ["turn-task-review"], "the receipt names every hop task the stop aborted");
  assert.equal(stoppedRun?.requestId, "request-stop");
  assert.equal(stoppedRun?.surface, "main-window");
  assert.equal((await harness.service.getRouting("routing-weekly-handoff"))?.activeRunId, undefined);
  assert.equal(harness.service.stopRun("routing-weekly-handoff"), null, "a settled run refuses stop");
});

test("disable persists first, cancels pending admissions with receipts, stops the active run, and reports it", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("routing-slot-blocker"), "decision-blocker");
  await harness.enable(declarationInput("routing-queued-tidy", {
    steps: [{ id: "tidy", kind: "chat", space: spaceC, message: "Tidy the inbox." }],
  }), "decision-queued");
  harness.ports.chatImpl = harness.ports.abortableChat;

  const blockerPromise = harness.service.runNow("routing-slot-blocker", { requestId: "request-blocker" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the blocker run to hold the only slot");
  const queuedPromise = harness.service.runNow("routing-queued-tidy", { requestId: "request-queued" });

  const disabledQueued = await harness.service.disable("routing-queued-tidy");
  assert.equal(disabledQueued.record.health, "disabled");
  assert.equal(disabledQueued.stoppedRunId, null, "a queued admission is cancelled, not stopped");
  const queuedResult = await queuedPromise;
  assert.equal(queuedResult.outcome, "cancelled");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "skipped" && line.routingId === "routing-queued-tidy"),
    "the cancelled admission's receipt",
  );
  const cancelledReceipt = (await harness.journal())
    .find((line) => line.scope === "run" && line.outcome === "skipped" && line.routingId === "routing-queued-tidy");
  assert.deepEqual(cancelledReceipt?.cause, { kind: "run-now", requestId: "request-queued" }, "the cause survives cancellation through the run-id registry");
  assert.match(cancelledReceipt?.detail ?? "", /unregistered/);

  const disabledBlocker = await harness.service.disable("routing-slot-blocker");
  assert.ok(disabledBlocker.stoppedRunId, "disable reports the run it stopped");
  await blockerPromise;
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "stopped" && line.routingId === "routing-slot-blocker"),
    "the stopped run's terminal receipt",
  );
  assert.equal((await harness.store.get("routing-slot-blocker"))?.health, "disabled");

  await assert.rejects(
    () => harness.service.runNow("routing-slot-blocker"),
    (error: unknown) => error instanceof WorkFoldRoutingServiceError && error.code === "HEALTH_INVALID" && error.health === "disabled",
    "run-now on a disabled routing is refused",
  );
});

test("suspension interrupts the active run honestly and skips admissions while suspended", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-manual-only"));
  harness.ports.chatImpl = harness.ports.abortableChat;

  const resultPromise = harness.service.runNow("routing-manual-only", { requestId: "request-1" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the run to start");
  harness.service.suspend();
  const result = await resultPromise;
  assert.equal(result.outcome, "cancelled");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "interrupted"),
    "the interrupted run's terminal receipt",
  );
  const lines = await harness.journal();
  assert.equal(lines.find((line) => line.hopId === "review" && line.scope === "hop")?.outcome, "accepted");
  assert.ok(lines.some((line) => line.hopId === "review" && line.outcome === "interrupted"), "the in-flight hop records interrupted, not stopped");

  const whileSuspended = await harness.service.runNow("routing-manual-only", { requestId: "request-2" });
  assert.equal(whileSuspended.outcome, "skipped");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "skipped"),
    "the suspended admission's skip receipt",
  );
  assert.match(
    (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "skipped")?.detail ?? "",
    /suspended/,
    "settles during suspension are not queued; the admission is receipted as skipped",
  );

  harness.service.resume();
  harness.ports.chatImpl = harness.ports.defaultChat;
  const afterResume = await harness.service.runNow("routing-manual-only", { requestId: "request-3" });
  assert.equal(afterResume.outcome, "success");
});

test("the created-files handoff resolves host-side from the checkpoint pair and fails closed on every gap", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-created-files", {
    steps: [
      { id: "review", kind: "chat", space: spaceA, message: "Write the weekly summary." },
      {
        id: "handoff",
        kind: "files",
        fromSpace: spaceA,
        from: { kind: "step-created-files", step: "review", extensions: ["md"], maxFiles: 5, maxTotalBytes: 1000 },
        toSpace: spaceB,
        to: "Incoming",
      },
    ],
  }));
  const preManifest: WorkFoldRoutingCheckpointManifest = {
    files: [
      { path: "reports/a.md", hashSha256: "hash-a-1", sizeBytes: 10 },
      { path: "notes/keep.txt", hashSha256: "hash-keep", sizeBytes: 5 },
    ],
    skippedFilePaths: [],
  };
  const postManifest: WorkFoldRoutingCheckpointManifest = {
    files: [
      { path: "reports/a.md", hashSha256: "hash-a-2", sizeBytes: 20 },
      { path: "reports/new.md", hashSha256: "hash-new", sizeBytes: 30 },
      { path: "notes/other.txt", hashSha256: "hash-other", sizeBytes: 7 },
    ],
    skippedFilePaths: [],
  };
  harness.ports.manifests.set(`${spaceA}/pre-review`, preManifest);
  harness.ports.manifests.set(`${spaceA}/post-review`, postManifest);

  const first = await harness.service.runNow("routing-created-files", { requestId: "request-1" });
  assert.equal(first.outcome, "success");
  const filesCall = harness.ports.calls.find((call) => call.kind === "files");
  assert.deepEqual(
    filesCall?.source,
    { kind: "paths", paths: ["reports/a.md", "reports/new.md"] },
    "the handoff is the manifest diff — added or content-changed paths — filtered by the declared extensions",
  );
  const delivered = (await harness.journal()).find((line) => line.hopId === "handoff" && line.outcome === "succeeded");
  assert.deepEqual(delivered?.sourcePaths, ["reports/a.md", "reports/new.md"]);

  harness.ports.manifests.delete(`${spaceA}/post-review`);
  const missing = await harness.service.runNow("routing-created-files", { requestId: "request-2" });
  assert.equal(missing.outcome, "failure");
  assert.match(missing.error ?? "", /missing from the source Space's History/);

  harness.ports.manifests.set(`${spaceA}/post-review`, { ...postManifest, skippedFilePaths: ["reports/oversized.md"] });
  const skipGap = await harness.service.runNow("routing-created-files", { requestId: "request-3" });
  assert.equal(skipGap.outcome, "failure");
  assert.match(skipGap.error ?? "", /skipped 1 file/, "a capture skip matching the filters fails the hop; a partial handoff is never delivered");

  harness.ports.manifests.set(`${spaceA}/post-review`, postManifest);
  harness.ports.manifests.set(`${spaceA}/pre-review`, { ...preManifest, files: postManifest.files });
  const filesCallsBefore = harness.ports.calls.filter((call) => call.kind === "files").length;
  const empty = await harness.service.runNow("routing-created-files", { requestId: "request-4" });
  assert.equal(empty.outcome, "success");
  assert.equal(
    harness.ports.calls.filter((call) => call.kind === "files").length,
    filesCallsBefore,
    "an empty diff is a deterministic no-op: the files port is never called",
  );
  const emptyHop = (await harness.journal())
    .filter((line) => line.hopId === "handoff" && line.outcome === "succeeded")
    .at(-1);
  assert.equal(emptyHop?.fileCount, 0);

  await harness.enable(declarationInput("routing-created-tight", {
    steps: [
      { id: "review", kind: "chat", space: spaceA, message: "Write the weekly summary." },
      {
        id: "handoff",
        kind: "files",
        fromSpace: spaceA,
        from: { kind: "step-created-files", step: "review", maxFiles: 1, maxTotalBytes: 1000 },
        toSpace: spaceB,
        to: "Incoming",
      },
    ],
  }), "decision-tight");
  harness.ports.manifests.set(`${spaceA}/pre-review`, preManifest);
  const overBound = await harness.service.runNow("routing-created-tight", { requestId: "request-5" });
  assert.equal(overBound.outcome, "failure");
  assert.match(overBound.error ?? "", /more than this handoff's bound/, "over-bound handoffs fail instead of truncating");
});

test("crash recovery records interrupted runs from the journal and never replays them", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-routing-recovery-"));
  const journalPath = join(sandbox, "routings", "receipts.jsonl");
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, [
    JSON.stringify({ v: 1, at: "2026-07-14T11:00:00.000Z", scope: "run", outcome: "accepted", routingId: "routing-recovered", runId: "run-crashed", title: "Recovered run" }),
    JSON.stringify({ v: 1, at: "2026-07-14T11:00:01.000Z", scope: "hop", outcome: "accepted", routingId: "routing-recovered", runId: "run-crashed", hopId: "review" }),
    "",
  ].join("\n"), "utf8");

  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const receipts = new WorkFoldRoutingReceipts({ path: journalPath, rotatedPath: join(sandbox, "routings", "receipts.1.jsonl"), now });
  const store = await WorkFoldRoutingStore.create({ path: join(sandbox, "routings", "routings.json"), receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldRoutingService.create({ store, ports, clock, catchUpStagger: () => 0 });
  t.after(async () => {
    service.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  assert.deepEqual(service.status().recoveredInterruptedRunIds, ["run-crashed"]);
  assert.deepEqual(ports.calls, [], "recovery records; it never replays");
  const lines = (await readFile(journalPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldRoutingReceiptV1);
  assert.deepEqual(lines.slice(2).map((line) => `${line.scope}:${line.outcome}`), ["hop:interrupted", "run:interrupted"]);
  assert.match(lines[3]?.detail ?? "", /not replayed/);
  assert.deepEqual(await receipts.scanOpenRuns(), [], "the recovered journal holds no open runs");

  const glanceRuns = await createWorkFoldGlanceRoutingRunReader({ stateRoot: sandbox })();
  assert.equal(glanceRuns[0]?.state, "interrupted");
  assert.deepEqual(glanceRuns[0]?.hops, [{ id: "review", state: "interrupted" }]);
});

test("Space removal stops the active run, suspends durably, disarms every trigger, and never auto-resumes", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-alpha-weekly", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }), "decision-alpha");
  await harness.enable(declarationInput("routing-beta-standby", {
    trigger: { kind: "on-settled", source: { kind: "check-run", space: spaceC, outcomes: ["succeeded"] } },
    steps: [{ id: "tidy", kind: "chat", space: spaceC, message: "Tidy the inbox." }],
  }), "decision-beta");
  harness.ports.chatImpl = (step, context) => step.space === spaceA
    ? harness.ports.abortableChat(step, context)
    : harness.ports.defaultChat(step, context);

  harness.clock.advance(60 * minute);
  await waitForCondition(() => harness.ports.calls.length === 1, "routing-alpha-weekly's scheduled run to start");

  const summary = await harness.service.handleSpaceRemoved(spaceA);
  assert.deepEqual(summary.suspendedRoutingIds, ["routing-alpha-weekly"]);
  assert.equal(summary.stoppedRunIds.length, 1, "the active run is stopped before removal completes");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "stopped" && line.routingId === "routing-alpha-weekly"),
    "the stopped run's terminal receipt",
  );
  assert.equal((await harness.store.get("routing-alpha-weekly"))?.health, "suspended");
  assert.deepEqual((await harness.store.get("routing-alpha-weekly"))?.suspension?.missingSpaceIds, [spaceA]);
  assert.equal((await harness.store.get("routing-beta-standby"))?.health, "enabled", "routings that never reference the Space keep their authority");

  const acceptedForAlpha = async () => (await harness.journal())
    .filter((line) => line.scope === "run" && line.outcome === "accepted" && line.routingId === "routing-alpha-weekly")
    .length;
  const alphaRunsAfterSuspension = await acceptedForAlpha();
  harness.clock.advance(180 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(await acceptedForAlpha(), alphaRunsAfterSuspension, "a suspended routing never fires on its schedule");

  harness.signal.publish({ ...checkSettle, spaceId: spaceC, runId: "settled-check-run-beta" });
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded" && line.routingId === "routing-beta-standby"),
    "routing-beta-standby to keep working",
  );

  assert.deepEqual(await harness.service.handleSpaceReRegistered(spaceA), ["routing-alpha-weekly"]);
  assert.equal((await harness.store.get("routing-alpha-weekly"))?.health, "suspended", "re-registration never silently re-arms standing behavior");
  await assert.rejects(
    () => harness.service.runNow("routing-alpha-weekly"),
    (error: unknown) => error instanceof WorkFoldRoutingServiceError && error.code === "HEALTH_INVALID" && error.health === "suspended"
      && /fresh consecration/.test(error.message),
  );

  harness.ports.chatImpl = harness.ports.defaultChat;
  const reEnabled = await harness.enable(declarationInput("routing-alpha-weekly", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }), "decision-fresh");
  assert.equal(reEnabled.health, "enabled");
  const before = await acceptedForAlpha();
  harness.clock.advance(60 * minute);
  await waitForCondition(async () => (await acceptedForAlpha()) === before + 1, "the fresh consecration to re-arm the schedule");
  await waitForCondition(
    async () => (await harness.journal())
      .some((line) => line.scope === "run" && line.outcome === "succeeded" && line.routingId === "routing-alpha-weekly"),
    "the re-armed run to settle before teardown",
  );
});

test("an unwritable journal refuses the run before any hop executes", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("routing-manual-only"));
  await rm(harness.journalPath, { force: true });
  await mkdir(harness.journalPath);

  const result = await harness.service.runNow("routing-manual-only", { requestId: "request-1" });
  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /could not journal this routing run/);
  assert.deepEqual(harness.ports.calls, [], "journal-first means no journal, no hops");
});

test("an admission that outlived its authority is skipped at the launch boundary, receipted, never run", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("routing-slot-blocker"), "decision-blocker");
  await harness.enable(declarationInput("routing-target-tidy", {
    steps: [{ id: "tidy", kind: "chat", space: spaceC, message: "Tidy the inbox." }],
  }), "decision-target");
  const gate = deferred();
  harness.ports.chatImpl = async (step, context) => {
    if (step.space === spaceA) await gate.promise;
    return harness.ports.defaultChat(step, context);
  };

  const blockerPromise = harness.service.runNow("routing-slot-blocker", { requestId: "request-blocker" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the blocker to hold the only slot");
  const targetPromise = harness.service.runNow("routing-target-tidy", { requestId: "request-target" });
  // The authority changes underneath the queued admission, without the
  // executor being told — the launch-boundary recheck is the last gate.
  await harness.store.disable("routing-target-tidy");
  gate.resolve();

  const targetResult = await targetPromise;
  assert.equal(targetResult.outcome, "failure");
  assert.match(targetResult.error ?? "", /disabled/);
  assert.equal((await blockerPromise).outcome, "success");
  const targetLines = (await harness.journal()).filter((line) => line.routingId === "routing-target-tidy" && line.scope !== "routing");
  assert.deepEqual(targetLines.map((line) => `${line.scope}:${line.outcome}`), ["run:skipped"], "no accepted record, no hops — stale authority never runs");
  assert.deepEqual(targetLines[0]?.cause, { kind: "run-now", requestId: "request-target" });
  assert.equal(harness.ports.calls.filter((call) => call.routingId === "routing-target-tidy").length, 0);
});
