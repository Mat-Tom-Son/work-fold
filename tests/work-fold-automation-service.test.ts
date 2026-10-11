import type { WorkFoldAutomationFileObserver } from "../src/local/automations/automation-file-observer.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import type { WorkFoldSchedulerClock } from "../src/local/agent/work-fold-scheduler-service.js";
import { createWorkFoldOverviewAutomationRunReader } from "../src/local/overview.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationBounds,
  workFoldAutomationDigest,
  type WorkFoldAutomationChatStep,
  type WorkFoldAutomationCheckStep,
  type WorkFoldAutomationFilesStep,
  type WorkFoldAutomationAgentStep,
} from "../src/local/automations/automation-declarations.js";
import {
  WorkFoldAutomationService,
  WorkFoldAutomationServiceError,
  workFoldAutomationMaxConcurrentRuns,
  type WorkFoldAutomationChatHopResult,
  type WorkFoldAutomationCheckHopResult,
  type WorkFoldAutomationCheckRunFindings,
  type WorkFoldAutomationCheckpointManifest,
  type WorkFoldAutomationFilesHopResult,
  type WorkFoldAutomationAgentHopResult,
  type WorkFoldAutomationHopContext,
  type WorkFoldAutomationHopPorts,
  type WorkFoldAutomationResolvedFilesSource,
} from "../src/local/automations/automation-service.js";
import {
  WorkFoldAutomationReceipts,
  WorkFoldAutomationStore,
  type WorkFoldAutomationReceiptV1,
  type WorkFoldAutomationRecord,
} from "../src/local/automations/automation-store.js";
import { WorkFoldSettleSignal, type WorkFoldCheckRunSettleRecord } from "../src/local/automations/settle-signal.js";

const startTime = Date.parse("2026-07-14T12:00:00.000Z");
const minute = 60_000;
const workFolderA = "space-aaaaaaaaaaaaaaaa";
const workFolderB = "space-bbbbbbbbbbbbbbbb";
const workFolderC = "space-cccccccccccccccc";

interface RecordedPortCall {
  kind: "chat" | "files" | "check" | "agent";
  hopId: string;
  runId: string;
  automationId: string;
  lineage: WorkFoldAutomationHopContext["lineage"];
  source?: WorkFoldAutomationResolvedFilesSource;
  /** The message the executor actually sent, with every placeholder filled in. */
  message?: string;
}

class FakePorts implements WorkFoldAutomationHopPorts {
  readonly calls: RecordedPortCall[] = [];
  readonly manifests = new Map<string, WorkFoldAutomationCheckpointManifest>();
  readonly findingsByTask = new Map<string, WorkFoldAutomationCheckRunFindings | null>();
  chatImpl: (step: WorkFoldAutomationChatStep, context: WorkFoldAutomationHopContext) => Promise<WorkFoldAutomationChatHopResult>;
  workFoldAgentImpl: (step: WorkFoldAutomationAgentStep, context: WorkFoldAutomationHopContext) => Promise<WorkFoldAutomationAgentHopResult>;
  filesImpl: (
    step: WorkFoldAutomationFilesStep,
    source: WorkFoldAutomationResolvedFilesSource,
    context: WorkFoldAutomationHopContext,
  ) => Promise<WorkFoldAutomationFilesHopResult>;
  checkImpl: (step: WorkFoldAutomationCheckStep, context: WorkFoldAutomationHopContext) => Promise<WorkFoldAutomationCheckHopResult>;

  constructor() {
    this.chatImpl = this.defaultChat;
    this.workFoldAgentImpl = async (_step, context) => ({
      conversationId: `agent-conversation-${context.hopId}`,
      turnTaskId: `agent-turn-task-${context.hopId}`,
      outcome: "succeeded",
    });
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
    _step: WorkFoldAutomationChatStep,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationChatHopResult> => ({
    conversationId: `conversation-${context.hopId}`,
    turnTaskId: `turn-task-${context.hopId}`,
    outcome: "succeeded",
    preCheckpointId: `pre-${context.hopId}`,
    postCheckpointId: `post-${context.hopId}`,
  });

  /** A chat turn that runs until its abort path settles it, like a real turn abort. */
  readonly abortableChat = (
    _step: WorkFoldAutomationChatStep,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationChatHopResult> => new Promise((resolvePromise) => {
    const settle = () => resolvePromise({
      conversationId: `conversation-${context.hopId}`,
      turnTaskId: `turn-task-${context.hopId}`,
      outcome: "aborted",
    });
    if (context.signal.aborted) settle();
    else context.signal.addEventListener("abort", settle, { once: true });
  });

  /** A work-fold agent turn that runs until its abort path settles it, like a real turn abort. */
  readonly abortableWorkFoldAgent = (
    _step: WorkFoldAutomationAgentStep,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationAgentHopResult> => new Promise((resolvePromise) => {
    const settle = () => resolvePromise({
      conversationId: `agent-conversation-${context.hopId}`,
      turnTaskId: `agent-turn-task-${context.hopId}`,
      outcome: "aborted",
    });
    if (context.signal.aborted) settle();
    else context.signal.addEventListener("abort", settle, { once: true });
  });

  async chat(
    step: WorkFoldAutomationChatStep,
    message: string,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationChatHopResult> {
    this.calls.push({ kind: "chat", hopId: context.hopId, runId: context.runId, automationId: context.automationId, lineage: context.lineage, message });
    return this.chatImpl(step, context);
  }

  async workFoldAgent(
    step: WorkFoldAutomationAgentStep,
    message: string,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationAgentHopResult> {
    this.calls.push({ kind: "agent", hopId: context.hopId, runId: context.runId, automationId: context.automationId, lineage: context.lineage, message });
    return this.workFoldAgentImpl(step, context);
  }

  async checkRunFindings(_workFolderId: string, taskId: string): Promise<WorkFoldAutomationCheckRunFindings | null> {
    return this.findingsByTask.get(taskId) ?? null;
  }

  async files(
    step: WorkFoldAutomationFilesStep,
    source: WorkFoldAutomationResolvedFilesSource,
    context: WorkFoldAutomationHopContext,
  ): Promise<WorkFoldAutomationFilesHopResult> {
    this.calls.push({ kind: "files", hopId: context.hopId, runId: context.runId, automationId: context.automationId, lineage: context.lineage, source });
    return this.filesImpl(step, source, context);
  }

  async check(step: WorkFoldAutomationCheckStep, context: WorkFoldAutomationHopContext): Promise<WorkFoldAutomationCheckHopResult> {
    this.calls.push({ kind: "check", hopId: context.hopId, runId: context.runId, automationId: context.automationId, lineage: context.lineage });
    return this.checkImpl(step, context);
  }

  async checkpointManifest(workFolderId: string, checkpointId: string): Promise<WorkFoldAutomationCheckpointManifest | null> {
    return this.manifests.get(`${workFolderId}/${checkpointId}`) ?? null;
  }
}

class FakeClock implements WorkFoldSchedulerClock {
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
  store: WorkFoldAutomationStore;
  service: WorkFoldAutomationService;
  journalPath: string;
  enable(raw: unknown, requestId?: string): Promise<WorkFoldAutomationRecord>;
  journal(): Promise<WorkFoldAutomationReceiptV1[]>;
  runLines(): Promise<string[]>;
}

async function createHarness(t: TestContext, options: { maxConcurrency?: number; observeFiles?: WorkFoldAutomationFileObserver } = {}): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-service-"));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  const receipts = new WorkFoldAutomationReceipts({
    path: journalPath,
    rotatedPath: join(sandbox, "automations", "receipts.1.jsonl"),
    now,
  });
  const store = await WorkFoldAutomationStore.create({ path: join(sandbox, "automations", "automations.json"), receipts, now });
  const signal = new WorkFoldSettleSignal({ now });
  const ports = new FakePorts();
  let nextRunId = 0;
  const service = await WorkFoldAutomationService.create({
    store,
    ports,
    settleSignal: signal,
    ...(options.observeFiles ? { observeFiles: options.observeFiles, filePollIntervalMs: 0 } : {}),
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
      .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1);
  };
  return {
    sandbox,
    clock,
    ports,
    signal,
    store,
    service,
    journalPath,
    enable: async (raw, requestId = "request-1") => {
      const declaration = normalizeWorkFoldAutomationDeclaration(raw);
      return await service.enable({
        declaration,
        expectedDigest: workFoldAutomationDigest(declaration),
        grant: { requestId, surface: "popover" },
      });
    },
    journal,
    runLines: async () => (await journal())
      .filter((line) => line.scope !== "automation")
      .map((line) => `${line.scope}:${line.outcome}:${line.hopId ?? "-"}`),
  };
}

function declarationInput(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "work-fold.automation",
    version: 1,
    id,
    title: `Automation ${id}`,
    createdBy: "assistant",
    createdAt: "2026-07-01T00:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{ id: "review", kind: "chat", workFolder: workFolderA, message: "Review chapters for unresolved notes." }],
    ...overrides,
  };
}

const pipelineSteps = [
  { id: "review", kind: "chat", workFolder: workFolderA, message: "Review chapters for unresolved notes." },
  { id: "handoff", kind: "files", fromWorkFolder: workFolderA, from: { kind: "paths", paths: ["reports/weekly.md"] }, toWorkFolder: workFolderB, to: "Incoming" },
  { id: "verify", kind: "check", workFolder: workFolderB },
];

const checkSettle: WorkFoldCheckRunSettleRecord = {
  kind: "check-run",
  workFolderId: workFolderA,
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

test("a scheduled run executes hops strictly in order with journal-first receipts, cadence, and overview visibility", async (t) => {
  const harness = await createHarness(t);
  const record = await harness.enable(declarationInput("automation-weekly-handoff", {
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
  assert.equal(accepted?.title, "Automation automation-weekly-handoff");
  assert.equal(accepted?.digest, record.digest, "the run receipt names the declaration digest in force");
  assert.deepEqual(accepted?.cause, { kind: "scheduled", slotAt: "2026-07-14T13:00:00.000Z" }, "the terminal cause names the exact scheduled slot");

  const chatDone = lines.find((line) => line.hopId === "review" && line.outcome === "succeeded");
  assert.equal(chatDone?.workFolderId, workFolderA);
  assert.equal(chatDone?.conversationId, "conversation-review");
  assert.equal(chatDone?.taskId, "turn-task-review");
  assert.deepEqual(chatDone?.checkpointIds, ["pre-review", "post-review"]);

  const filesDone = lines.find((line) => line.hopId === "handoff" && line.outcome === "succeeded");
  assert.equal(filesDone?.fromWorkFolderId, workFolderA);
  assert.equal(filesDone?.toWorkFolderId, workFolderB);
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
    { kind: "automation-hop", automationId: "automation-weekly-handoff", automationRunId: runId, hopId: "verify" },
    "every hop-caused domain run carries automation lineage",
  );

  await waitForCondition(
    async () => (await harness.store.get("automation-weekly-handoff"))?.lastScheduledAt === "2026-07-14T13:00:00.000Z",
    "the durable cadence anchor to advance to the fired slot",
  );
  const projection = await harness.service.getAutomation("automation-weekly-handoff");
  assert.equal(projection?.nextScheduledAt, "2026-07-14T14:00:00.000Z");

  const overviewRuns = await createWorkFoldOverviewAutomationRunReader({ stateRoot: harness.sandbox })();
  assert.equal(overviewRuns.length, 1);
  assert.equal(overviewRuns[0]?.state, "succeeded");
  assert.equal(overviewRuns[0]?.title, "Automation automation-weekly-handoff");
  assert.deepEqual(overviewRuns[0]?.hops, [
    { id: "review", state: "succeeded" },
    { id: "handoff", state: "succeeded" },
    { id: "verify", state: "succeeded" },
  ], "the overview's tolerant reader consumes the journal this executor writes");
});

test("an interval slot is claimed durably after acceptance and before hop 1", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-interval-pre-hop-claim", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }));
  let anchorSeenByHop: string | undefined;
  harness.ports.chatImpl = async (step, context) => {
    anchorSeenByHop = (await harness.store.get(context.automationId))?.lastScheduledAt;
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
    ["automation:enabled", "run:accepted"],
    "acceptance is durable before the cadence claim and hop receipts",
  );
});

test("an interval cadence persistence failure closes the accepted run before any hop", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-interval-claim-fails", {
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
  await harness.enable(declarationInput("automation-at-claim-fails", {
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

test("a one-time automation runs once, durably completes before hop 1, and run-now executes an independent copy", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-one-time", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  assert.equal((await harness.service.getAutomation("automation-one-time"))?.nextScheduledAt, "2026-07-14T12:02:00.000Z");

  const manual = await harness.service.runNow("automation-one-time", { requestId: "request-copy", surface: "popover" });
  assert.equal(manual.outcome, "success");
  assert.equal((await harness.store.get("automation-one-time"))?.health, "enabled", "run-now does not consume the scheduled occurrence");

  harness.clock.advance(2 * minute);
  await waitForCondition(
    async () => (await harness.store.get("automation-one-time"))?.atOccurrence?.finishedAt !== undefined,
    "the one-time occurrence to finish",
  );
  const completed = await harness.service.getAutomation("automation-one-time");
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
    () => harness.service.runNow("automation-one-time"),
    (error: unknown) => error instanceof WorkFoldAutomationServiceError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );
});

test("a one-time slot due during run-now waits and executes after the manual copy", async (t) => {
  for (const ifMissed of ["run", "skip"] as const) {
    await t.test(ifMissed, { timeout: 10_000 }, async (caseContext) => {
      const harness = await createHarness(caseContext);
      const release = deferred();
      const started = deferred();
      caseContext.after(() => release.resolve());
      let firstHop = true;
      harness.ports.chatImpl = async (_step, context) => {
        if (firstHop) {
          firstHop = false;
          started.resolve();
          await release.promise;
        }
        return harness.ports.defaultChat(_step, context);
      };
      const automationId = `automation-at-manual-overlap-${ifMissed}`;
      await harness.enable(declarationInput(automationId, {
        version: 2,
        trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed },
      }));

      const manual = harness.service.runNow(automationId, { requestId: `manual-${ifMissed}` });
      await started.promise;
      const before = await harness.service.getAutomation(automationId);
      assert.equal(before?.nextScheduledAt, "2026-07-14T12:01:00.000Z");
      assert.equal(before?.activeRunId, "run-1", "the manual copy owns the non-overlap fence before the due timer fires");
      harness.clock.advance(minute);
      // Owned-clock callbacks and the scheduler's in-memory admission are
      // synchronous. Assert that boundary directly; wall-clock polling cannot
      // advance a fake timer and obscures the state that actually failed.
      const overlap = harness.service.listAutomationResults(automationId).find((result) => (
        result.reason === "scheduled" && result.notLaunchedReason === "overlap"
      ));
      assert.equal(overlap?.outcome, "skipped", `the due slot reaches the per-automation non-overlap fence: ${JSON.stringify(harness.service.listAutomationResults(automationId))}`);
      assert.equal((await harness.store.get(automationId))?.health, "enabled");
      assert.equal((await harness.store.get(automationId))?.atOccurrence, undefined);

      release.resolve();
      assert.equal((await manual).outcome, "success", "the held manual hop must actually succeed");
      await waitForCondition(
        async () => {
          // Manual completion arms the preserved one-time catch-up after its
          // async result observer settles. Pump the fake clock until that exact
          // timer fires, regardless of microtask ordering on the host runner.
          harness.clock.advance(0);
          return (await harness.store.get(automationId))?.atOccurrence?.finishedAt !== undefined;
        },
        "the preserved one-time slot to finish after the manual copy",
      );
      assert.equal((await harness.store.get(automationId))?.health, "completed");
      const completedRuns = harness.service.listAutomationResults(automationId).filter((result) => result.notLaunchedReason !== "overlap");
      assert.equal(completedRuns.length, 2);
      assert.ok(completedRuns.every((result) => result.outcome === "success"), "both the manual copy and preserved scheduled run succeed");
      assert.equal(
        harness.ports.calls.filter((call) => call.automationId === automationId).length,
        2,
        "the manual copy and the exact scheduled slot each run once",
      );
      assert.ok((await harness.journal()).some((line) => (
        line.automationId === automationId
        && line.scope === "run"
        && line.outcome === "skipped"
        && line.cause?.kind === "scheduled"
      )), "the overlap is durably receipted before the preserved slot finishes");
    });
  }
});

test("a crash after the durable one-time claim cannot replay the occurrence", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-at-claim-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  const receipts = new WorkFoldAutomationReceipts({ path: journalPath, now });
  const statePath = join(sandbox, "automations", "automations.json");
  const store = await WorkFoldAutomationStore.create({ path: statePath, receipts, now });
  const declaration = normalizeWorkFoldAutomationDeclaration(declarationInput("automation-claimed-before-crash", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  await store.enable({
    declaration,
    expectedDigest: workFoldAutomationDigest(declaration),
    grant: { requestId: "decision-claim", surface: "popover" },
  });
  await store.claimAtOccurrence(
    declaration.id,
    "2026-07-14T12:02:00.000Z",
    "run-claimed",
    new Date("2026-07-14T12:02:00.000Z"),
  );

  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldAutomationService.create({ store: reloaded, ports, clock, catchUpStagger: () => 0 });
  t.after(() => service.close());
  assert.equal(service.status().armedAutomationCount, 0);
  assert.deepEqual(ports.calls, []);
  assert.equal((await service.getAutomation(declaration.id))?.health, "completed");
  assert.equal((await service.getAutomation(declaration.id))?.atOccurrence?.finishedAt, clock.now().toISOString());

  clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(ports.calls, [], "startup records the unfinished claim but never replays it");
});

test("startup reconciles a crash between a one-time accepted receipt and its durable claim", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-at-accepted-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  const receipts = new WorkFoldAutomationReceipts({ path: journalPath, now });
  const statePath = join(sandbox, "automations", "automations.json");
  const store = await WorkFoldAutomationStore.create({ path: statePath, receipts, now });
  const declaration = normalizeWorkFoldAutomationDeclaration(declarationInput("automation-accepted-before-claim", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }));
  const enabled = await store.enable({
    declaration,
    expectedDigest: workFoldAutomationDigest(declaration),
    grant: { requestId: "decision-accepted", surface: "main-window" },
  });
  await receipts.append({
    scope: "run",
    outcome: "accepted",
    automationId: declaration.id,
    runId: "run-accepted",
    title: declaration.title,
    digest: enabled.digest,
    cause: { kind: "scheduled", slotAt: declaration.trigger.kind === "at" ? declaration.trigger.at : "" },
  });

  const reloaded = await WorkFoldAutomationStore.create({ path: statePath, receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldAutomationService.create({ store: reloaded, ports, clock, catchUpStagger: () => 0 });
  t.after(() => service.close());

  const completed = await service.getAutomation(declaration.id);
  assert.equal(completed?.health, "completed");
  assert.equal(completed?.atOccurrence?.runId, "run-accepted");
  assert.ok(completed?.atOccurrence?.finishedAt);
  assert.deepEqual(ports.calls, [], "the recovered accepted occurrence is consumed and never replayed");
  const runLines = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1)
    .filter((line) => line.runId === "run-accepted" && line.scope === "run");
  assert.deepEqual(runLines.map((line) => line.outcome), ["accepted", "interrupted"]);
});

test("failed and stopped scheduled one-time runs still consume their occurrence", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-at-failure", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }), "decision-failure");
  await harness.enable(declarationInput("automation-at-stopped", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:02:00.000Z", ifMissed: "run" },
  }), "decision-stopped");
  harness.ports.chatImpl = (step, context) => context.automationId === "automation-at-failure"
    ? Promise.resolve({
        conversationId: "conversation-failed-at",
        turnTaskId: "turn-task-failed-at",
        outcome: "failed",
        error: "The provider refused this turn.",
      })
    : harness.ports.abortableChat(step, context);

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.store.get("automation-at-failure"))?.atOccurrence?.finishedAt !== undefined,
    "the failed occurrence to finish",
  );
  assert.equal((await harness.store.get("automation-at-failure"))?.health, "completed");

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.service.getAutomation("automation-at-stopped"))?.activeRunId !== undefined,
    "the stopped occurrence to become active",
  );
  harness.service.stopRun("automation-at-stopped", { requestId: "request-stop-at", surface: "main-window" });
  await waitForCondition(
    async () => (await harness.store.get("automation-at-stopped"))?.atOccurrence?.finishedAt !== undefined,
    "the stopped occurrence to finish",
  );
  assert.equal((await harness.store.get("automation-at-stopped"))?.health, "completed");

  harness.clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.ports.calls.filter((call) => call.automationId === "automation-at-failure").length, 1);
  assert.equal(harness.ports.calls.filter((call) => call.automationId === "automation-at-stopped").length, 1);
});

test("an active completed one-time automation must be stopped before deletion", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-at-delete-active", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }));
  harness.ports.chatImpl = harness.ports.abortableChat;

  harness.clock.advance(minute);
  await waitForCondition(
    async () => (await harness.service.getAutomation("automation-at-delete-active"))?.activeRunId !== undefined,
    "the one-time run to become active",
  );
  assert.equal((await harness.store.get("automation-at-delete-active"))?.health, "completed");
  await assert.rejects(
    () => harness.service.deleteAutomation("automation-at-delete-active"),
    (error: unknown) => error instanceof WorkFoldAutomationServiceError
      && error.code === "HEALTH_INVALID"
      && error.health === "completed",
  );

  assert.ok(harness.service.stopRun("automation-at-delete-active"));
  await waitForCondition(
    async () => (await harness.service.getAutomation("automation-at-delete-active"))?.activeRunId === undefined,
    "the stopped one-time run to settle",
  );
  assert.equal((await harness.service.deleteAutomation("automation-at-delete-active")).declaration.id, "automation-at-delete-active");
});

test("a queued due occurrence survives suspend and catches up exactly once on resume", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("automation-suspend-blocker"));
  await harness.enable(declarationInput("automation-suspend-once", {
    version: 2,
    trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed: "run" },
  }));
  harness.ports.chatImpl = (step, context) => context.automationId === "automation-suspend-blocker"
    ? harness.ports.abortableChat(step, context)
    : harness.ports.defaultChat(step, context);

  const blocker = harness.service.runNow("automation-suspend-blocker");
  await waitForCondition(
    () => harness.ports.calls.some((call) => call.automationId === "automation-suspend-blocker"),
    "the blocking route to acquire the only slot",
  );
  harness.clock.advance(minute);
  harness.service.suspend();
  await blocker;
  await waitForCondition(
    () => harness.service.listAutomationResults("automation-suspend-once")
      .some((result) => result.notLaunchedReason === "suspended"),
    "the queued one-time admission to settle as suspended",
  );
  assert.equal((await harness.store.get("automation-suspend-once"))?.health, "enabled");
  assert.equal((await harness.store.get("automation-suspend-once"))?.atOccurrence, undefined);

  await harness.service.resume();
  harness.clock.advance(0);
  await waitForCondition(
    async () => (await harness.store.get("automation-suspend-once"))?.atOccurrence?.finishedAt !== undefined,
    "the preserved occurrence to catch up",
  );
  assert.equal(
    harness.ports.calls.filter((call) => call.automationId === "automation-suspend-once").length,
    1,
  );
  harness.clock.advance(24 * 60 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(
    harness.ports.calls.filter((call) => call.automationId === "automation-suspend-once").length,
    1,
    "resume cannot replay the occurrence",
  );
});

test("a newer suspend wins over an older asynchronous resume", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-resume-generation", {
    trigger: { kind: "interval", intervalMinutes: 30 },
  }));
  const originalList = harness.store.list.bind(harness.store);
  const entered = deferred();
  const release = deferred();
  let delayNextList = true;
  (harness.store as unknown as { list: () => Promise<WorkFoldAutomationRecord[]> }).list = async () => {
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
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-at-missed-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const receipts = new WorkFoldAutomationReceipts({ path: join(sandbox, "receipts.jsonl"), now });
  const store = await WorkFoldAutomationStore.create({ path: join(sandbox, "automations.json"), receipts, now });
  const ports = new FakePorts();
  const first = await WorkFoldAutomationService.create({ store, ports, clock, catchUpStagger: () => 0 });
  for (const [id, ifMissed] of [["automation-missed-run", "run"], ["automation-missed-skip", "skip"]] as const) {
    const declaration = normalizeWorkFoldAutomationDeclaration(declarationInput(id, {
      version: 2,
      trigger: { kind: "at", at: "2026-07-14T12:01:00.000Z", ifMissed },
    }));
    await first.enable({
      declaration,
      expectedDigest: workFoldAutomationDigest(declaration),
      grant: { requestId: `decision-${ifMissed}`, surface: "popover" },
    });
  }
  first.close();
  clock.advance(2 * minute);

  const restarted = await WorkFoldAutomationService.create({
    store,
    ports,
    clock,
    createRunId: () => "run-catch-up",
    catchUpStagger: () => 0,
  });
  t.after(() => restarted.close());
  clock.advance(0);
  await waitForCondition(
    async () => (await store.get("automation-missed-run"))?.atOccurrence?.finishedAt !== undefined,
    "the missed run policy occurrence to finish",
  );
  assert.equal((await store.get("automation-missed-run"))?.health, "completed");
  assert.equal((await store.get("automation-missed-skip"))?.health, "completed");
  assert.equal(ports.calls.filter((call) => call.automationId === "automation-missed-run").length, 1);
  assert.equal(ports.calls.filter((call) => call.automationId === "automation-missed-skip").length, 0);
  const missedReceipts = (await readFile(join(sandbox, "receipts.jsonl"), "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1);
  const skipped = missedReceipts.filter((line) => line.automationId === "automation-missed-skip");
  assert.ok(skipped.some((line) => line.scope === "run" && line.outcome === "skipped"));
  assert.ok(skipped.some((line) => line.scope === "automation" && line.outcome === "completed"));
  assert.ok(skipped.every((line) => line.outcome !== "lapsed"), "missed skip uses the canonical skipped + completed receipt pair");
});

test("an on-settled trigger admits matching settles only, and automation-caused settles never fire triggers", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-on-settle", {
    trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: workFolderA, outcomes: ["succeeded"] } },
    steps: [{ id: "verify", kind: "check", workFolder: workFolderB }],
  }));

  harness.signal.publish(checkSettle);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the settle-admitted run to settle",
  );
  const accepted = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "accepted");
  assert.deepEqual(accepted?.cause, {
    kind: "on-settled",
    source: {
      kind: "check-run",
      workFolderId: workFolderA,
      runId: "settled-check-run-1",
      state: "succeeded",
      checkIds: ["check-quality-gate"],
      // The Check task id is how {{trigger.findings}} reads the settled run back.
      taskId: "settled-check-task-1",
    },
  }, "the run receipt names the settled source exactly");
  assert.equal(harness.ports.calls[0]?.lineage.automationId, "automation-on-settle");

  harness.signal.publish({ ...checkSettle, runId: "settled-check-run-2", state: "failed" });
  harness.signal.publish({ ...checkSettle, runId: "settled-check-run-3", workFolderId: workFolderB });
  harness.signal.publish({
    ...checkSettle,
    runId: "settled-check-run-4",
    lineage: { kind: "automation-hop", automationId: "automation-on-settle", automationRunId: "some-run", hopId: "verify" },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const acceptedCount = (await harness.journal())
    .filter((line) => line.scope === "run" && line.outcome === "accepted")
    .length;
  assert.equal(acceptedCount, 1, "unmatched outcomes, other work-folders, and lineage-stamped settles admit nothing — chains are structurally impossible");
});

test("per-automation non-overlap settles the second admission skipped, receipted with its own cause", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-manual-only"));
  const gate = deferred();
  harness.ports.chatImpl = async (step, context) => {
    await gate.promise;
    return harness.ports.defaultChat(step, context);
  };

  const first = harness.service.runNow("automation-manual-only", { requestId: "request-1" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the first run to start");
  const second = await harness.service.runNow("automation-manual-only", { requestId: "request-2" });
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
  await harness.enable(declarationInput("automation-weekly-handoff", { steps: pipelineSteps }));
  harness.ports.chatImpl = async (_step, context) => ({
    conversationId: `conversation-${context.hopId}`,
    turnTaskId: `turn-task-${context.hopId}`,
    outcome: "failed",
    error: "The Worker turn failed.",
  });

  const result = await harness.service.runNow("automation-weekly-handoff", { requestId: "request-1" });
  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /Automation hop "review" failed/);
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
  const retry = await harness.service.runNow("automation-weekly-handoff", { requestId: "request-2" });
  assert.equal(retry.outcome, "success", "there are no automatic retries; the next trigger occurrence is the retry");
});

test("stop aborts the current hop through its domain path, skips later hops, and names the aborted hop task", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-weekly-handoff", { steps: pipelineSteps }));
  harness.ports.chatImpl = harness.ports.abortableChat;

  const resultPromise = harness.service.runNow("automation-weekly-handoff", { requestId: "request-1" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the chat hop to start");
  assert.match((await harness.service.getAutomation("automation-weekly-handoff"))?.activeRunId ?? "", /^run-/);
  const stopped = harness.service.stopRun("automation-weekly-handoff", { requestId: "request-stop", surface: "main-window" });
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
  assert.equal((await harness.service.getAutomation("automation-weekly-handoff"))?.activeRunId, undefined);
  assert.equal(harness.service.stopRun("automation-weekly-handoff"), null, "a settled run refuses stop");
});

test("disable persists first, cancels pending admissions with receipts, stops the active run, and reports it", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("automation-slot-blocker"), "decision-blocker");
  await harness.enable(declarationInput("automation-queued-tidy", {
    steps: [{ id: "tidy", kind: "chat", workFolder: workFolderC, message: "Tidy the inbox." }],
  }), "decision-queued");
  harness.ports.chatImpl = harness.ports.abortableChat;

  const blockerPromise = harness.service.runNow("automation-slot-blocker", { requestId: "request-blocker" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the blocker run to hold the only slot");
  const queuedPromise = harness.service.runNow("automation-queued-tidy", { requestId: "request-queued" });

  const disabledQueued = await harness.service.disable("automation-queued-tidy");
  assert.equal(disabledQueued.record.health, "disabled");
  assert.equal(disabledQueued.stoppedRunId, null, "a queued admission is cancelled, not stopped");
  const queuedResult = await queuedPromise;
  assert.equal(queuedResult.outcome, "cancelled");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "skipped" && line.automationId === "automation-queued-tidy"),
    "the cancelled admission's receipt",
  );
  const cancelledReceipt = (await harness.journal())
    .find((line) => line.scope === "run" && line.outcome === "skipped" && line.automationId === "automation-queued-tidy");
  assert.deepEqual(cancelledReceipt?.cause, { kind: "run-now", requestId: "request-queued" }, "the cause survives cancellation through the run-id registry");
  assert.match(cancelledReceipt?.detail ?? "", /unregistered/);

  const disabledBlocker = await harness.service.disable("automation-slot-blocker");
  assert.ok(disabledBlocker.stoppedRunId, "disable reports the run it stopped");
  await blockerPromise;
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "stopped" && line.automationId === "automation-slot-blocker"),
    "the stopped run's terminal receipt",
  );
  assert.equal((await harness.store.get("automation-slot-blocker"))?.health, "disabled");

  await assert.rejects(
    () => harness.service.runNow("automation-slot-blocker"),
    (error: unknown) => error instanceof WorkFoldAutomationServiceError && error.code === "HEALTH_INVALID" && error.health === "disabled",
    "run-now on a disabled automation is refused",
  );
});

test("suspension interrupts the active run honestly and skips admissions while suspended", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-manual-only"));
  harness.ports.chatImpl = harness.ports.abortableChat;

  const resultPromise = harness.service.runNow("automation-manual-only", { requestId: "request-1" });
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

  const whileSuspended = await harness.service.runNow("automation-manual-only", { requestId: "request-2" });
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
  const afterResume = await harness.service.runNow("automation-manual-only", { requestId: "request-3" });
  assert.equal(afterResume.outcome, "success");
});

test("the created-files handoff resolves host-side from the checkpoint pair and fails closed on every gap", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-created-files", {
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Write the weekly summary." },
      {
        id: "handoff",
        kind: "files",
        fromWorkFolder: workFolderA,
        from: { kind: "step-created-files", step: "review", extensions: ["md"], maxFiles: 5, maxTotalBytes: 1000 },
        toWorkFolder: workFolderB,
        to: "Incoming",
      },
    ],
  }));
  const preManifest: WorkFoldAutomationCheckpointManifest = {
    files: [
      { path: "reports/a.md", hashSha256: "hash-a-1", sizeBytes: 10 },
      { path: "notes/keep.txt", hashSha256: "hash-keep", sizeBytes: 5 },
    ],
    skippedFilePaths: [],
  };
  const postManifest: WorkFoldAutomationCheckpointManifest = {
    files: [
      { path: "reports/a.md", hashSha256: "hash-a-2", sizeBytes: 20 },
      { path: "reports/new.md", hashSha256: "hash-new", sizeBytes: 30 },
      { path: "notes/other.txt", hashSha256: "hash-other", sizeBytes: 7 },
    ],
    skippedFilePaths: [],
  };
  harness.ports.manifests.set(`${workFolderA}/pre-review`, preManifest);
  harness.ports.manifests.set(`${workFolderA}/post-review`, postManifest);

  const first = await harness.service.runNow("automation-created-files", { requestId: "request-1" });
  assert.equal(first.outcome, "success");
  const filesCall = harness.ports.calls.find((call) => call.kind === "files");
  assert.deepEqual(
    filesCall?.source,
    { kind: "paths", paths: ["reports/a.md", "reports/new.md"] },
    "the handoff is the manifest diff — added or content-changed paths — filtered by the declared extensions",
  );
  const delivered = (await harness.journal()).find((line) => line.hopId === "handoff" && line.outcome === "succeeded");
  assert.deepEqual(delivered?.sourcePaths, ["reports/a.md", "reports/new.md"]);

  harness.ports.manifests.delete(`${workFolderA}/post-review`);
  const missing = await harness.service.runNow("automation-created-files", { requestId: "request-2" });
  assert.equal(missing.outcome, "failure");
  assert.match(missing.error ?? "", /missing from the source work-folder's History/);

  harness.ports.manifests.set(`${workFolderA}/post-review`, { ...postManifest, skippedFilePaths: ["reports/oversized.md"] });
  const skipGap = await harness.service.runNow("automation-created-files", { requestId: "request-3" });
  assert.equal(skipGap.outcome, "failure");
  assert.match(skipGap.error ?? "", /skipped 1 file/, "a capture skip matching the filters fails the hop; a partial handoff is never delivered");

  harness.ports.manifests.set(`${workFolderA}/post-review`, postManifest);
  harness.ports.manifests.set(`${workFolderA}/pre-review`, { ...preManifest, files: postManifest.files });
  const filesCallsBefore = harness.ports.calls.filter((call) => call.kind === "files").length;
  const empty = await harness.service.runNow("automation-created-files", { requestId: "request-4" });
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

  await harness.enable(declarationInput("automation-created-tight", {
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Write the weekly summary." },
      {
        id: "handoff",
        kind: "files",
        fromWorkFolder: workFolderA,
        from: { kind: "step-created-files", step: "review", maxFiles: 1, maxTotalBytes: 1000 },
        toWorkFolder: workFolderB,
        to: "Incoming",
      },
    ],
  }), "decision-tight");
  harness.ports.manifests.set(`${workFolderA}/pre-review`, preManifest);
  const overBound = await harness.service.runNow("automation-created-tight", { requestId: "request-5" });
  assert.equal(overBound.outcome, "failure");
  assert.match(overBound.error ?? "", /more than this handoff's bound/, "over-bound handoffs fail instead of truncating");
});

test("crash recovery records interrupted runs from the journal and never replays them", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-automation-recovery-"));
  const journalPath = join(sandbox, "automations", "receipts.jsonl");
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, [
    JSON.stringify({ v: 1, at: "2026-07-14T11:00:00.000Z", scope: "run", outcome: "accepted", automationId: "automation-recovered", runId: "run-crashed", title: "Recovered run" }),
    JSON.stringify({ v: 1, at: "2026-07-14T11:00:01.000Z", scope: "hop", outcome: "accepted", automationId: "automation-recovered", runId: "run-crashed", hopId: "review" }),
    "",
  ].join("\n"), "utf8");

  const clock = new FakeClock(startTime);
  const now = () => clock.now();
  const receipts = new WorkFoldAutomationReceipts({ path: journalPath, rotatedPath: join(sandbox, "automations", "receipts.1.jsonl"), now });
  const store = await WorkFoldAutomationStore.create({ path: join(sandbox, "automations", "automations.json"), receipts, now });
  const ports = new FakePorts();
  const service = await WorkFoldAutomationService.create({ store, ports, clock, catchUpStagger: () => 0 });
  t.after(async () => {
    service.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  assert.deepEqual(service.status().recoveredInterruptedRunIds, ["run-crashed"]);
  assert.deepEqual(ports.calls, [], "recovery records; it never replays");
  const lines = (await readFile(journalPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1);
  assert.deepEqual(lines.slice(2).map((line) => `${line.scope}:${line.outcome}`), ["hop:interrupted", "run:interrupted"]);
  assert.match(lines[3]?.detail ?? "", /not replayed/);
  assert.deepEqual(await receipts.scanOpenRuns(), [], "the recovered journal holds no open runs");

  const overviewRuns = await createWorkFoldOverviewAutomationRunReader({ stateRoot: sandbox })();
  assert.equal(overviewRuns[0]?.state, "interrupted");
  assert.deepEqual(overviewRuns[0]?.hops, [{ id: "review", state: "interrupted" }]);
});

test("work-folder removal stops the active run, suspends durably, disarms every trigger, and never auto-resumes", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-alpha-weekly", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }), "decision-alpha");
  await harness.enable(declarationInput("automation-beta-standby", {
    trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: workFolderC, outcomes: ["succeeded"] } },
    steps: [{ id: "tidy", kind: "chat", workFolder: workFolderC, message: "Tidy the inbox." }],
  }), "decision-beta");
  harness.ports.chatImpl = (step, context) => step.workFolder === workFolderA
    ? harness.ports.abortableChat(step, context)
    : harness.ports.defaultChat(step, context);

  harness.clock.advance(60 * minute);
  await waitForCondition(() => harness.ports.calls.length === 1, "automation-alpha-weekly's scheduled run to start");

  const summary = await harness.service.handleWorkFolderRemoved(workFolderA);
  assert.deepEqual(summary.suspendedAutomationIds, ["automation-alpha-weekly"]);
  assert.equal(summary.stoppedRunIds.length, 1, "the active run is stopped before removal completes");
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "stopped" && line.automationId === "automation-alpha-weekly"),
    "the stopped run's terminal receipt",
  );
  assert.equal((await harness.store.get("automation-alpha-weekly"))?.health, "suspended");
  assert.deepEqual((await harness.store.get("automation-alpha-weekly"))?.suspension?.missingWorkFolderIds, [workFolderA]);
  assert.equal((await harness.store.get("automation-beta-standby"))?.health, "enabled", "automations that never reference the work-folder keep their authority");

  const acceptedForAlpha = async () => (await harness.journal())
    .filter((line) => line.scope === "run" && line.outcome === "accepted" && line.automationId === "automation-alpha-weekly")
    .length;
  const alphaRunsAfterSuspension = await acceptedForAlpha();
  harness.clock.advance(180 * minute);
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(await acceptedForAlpha(), alphaRunsAfterSuspension, "a suspended automation never fires on its schedule");

  harness.signal.publish({ ...checkSettle, workFolderId: workFolderC, runId: "settled-check-run-beta" });
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded" && line.automationId === "automation-beta-standby"),
    "automation-beta-standby to keep working",
  );

  assert.deepEqual(await harness.service.handleWorkFolderReRegistered(workFolderA), ["automation-alpha-weekly"]);
  assert.equal((await harness.store.get("automation-alpha-weekly"))?.health, "suspended", "re-registration never silently re-arms standing behavior");
  await assert.rejects(
    () => harness.service.runNow("automation-alpha-weekly"),
    (error: unknown) => error instanceof WorkFoldAutomationServiceError && error.code === "HEALTH_INVALID" && error.health === "suspended"
      && /enable it again/.test(error.message),
  );

  harness.ports.chatImpl = harness.ports.defaultChat;
  const reEnabled = await harness.enable(declarationInput("automation-alpha-weekly", {
    trigger: { kind: "interval", intervalMinutes: 60 },
  }), "decision-fresh");
  assert.equal(reEnabled.health, "enabled");
  const before = await acceptedForAlpha();
  harness.clock.advance(60 * minute);
  await waitForCondition(async () => (await acceptedForAlpha()) === before + 1, "the fresh receipted enablement to re-arm the schedule");
  await waitForCondition(
    async () => (await harness.journal())
      .some((line) => line.scope === "run" && line.outcome === "succeeded" && line.automationId === "automation-alpha-weekly"),
    "the re-armed run to settle before teardown",
  );
});

test("an unwritable journal refuses the run before any hop executes", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-manual-only"));
  await rm(harness.journalPath, { force: true });
  await mkdir(harness.journalPath);

  const result = await harness.service.runNow("automation-manual-only", { requestId: "request-1" });
  assert.equal(result.outcome, "failure");
  assert.match(result.error ?? "", /could not journal this automation run/);
  assert.deepEqual(harness.ports.calls, [], "journal-first means no journal, no hops");
});

test("an admission that outlived its authority is skipped at the launch boundary, receipted, never run", async (t) => {
  const harness = await createHarness(t, { maxConcurrency: 1 });
  await harness.enable(declarationInput("automation-slot-blocker"), "decision-blocker");
  await harness.enable(declarationInput("automation-target-tidy", {
    steps: [{ id: "tidy", kind: "chat", workFolder: workFolderC, message: "Tidy the inbox." }],
  }), "decision-target");
  const gate = deferred();
  harness.ports.chatImpl = async (step, context) => {
    if (step.workFolder === workFolderA) await gate.promise;
    return harness.ports.defaultChat(step, context);
  };

  const blockerPromise = harness.service.runNow("automation-slot-blocker", { requestId: "request-blocker" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the blocker to hold the only slot");
  const targetPromise = harness.service.runNow("automation-target-tidy", { requestId: "request-target" });
  // The authority changes underneath the queued admission, without the
  // executor being told — the launch-boundary recheck is the last gate.
  await harness.store.disable("automation-target-tidy");
  gate.resolve();

  const targetResult = await targetPromise;
  assert.equal(targetResult.outcome, "failure");
  assert.match(targetResult.error ?? "", /disabled/);
  assert.equal((await blockerPromise).outcome, "success");
  const targetLines = (await harness.journal()).filter((line) => line.automationId === "automation-target-tidy" && line.scope !== "automation");
  assert.deepEqual(targetLines.map((line) => `${line.scope}:${line.outcome}`), ["run:skipped"], "no accepted record, no hops — stale authority never runs");
  assert.deepEqual(targetLines[0]?.cause, { kind: "run-now", requestId: "request-target" });
  assert.equal(harness.ports.calls.filter((call) => call.automationId === "automation-target-tidy").length, 0);
});

test("folder changes debounce into one receipted cross-work-folder sequence and absorb automation outputs", async (t) => {
  let revision = "1";
  let observations = 0;
  const harness = await createHarness(t, { observeFiles: async () => {
    observations++;
    return { digest: revision.repeat(64), entries: { "Drafts/notes.md": revision } };
  } });
  const trigger = { kind: "files-changed", workFolder: workFolderA, watch: { kind: "tree", path: "Drafts", recursive: true, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 1 };
  await harness.enable(declarationInput("automation-folder-handoff", { version: 3, trigger, steps: pipelineSteps }));
  await harness.service.pollFileChanges();
  harness.clock.advance(10_000);
  await harness.service.pollFileChanges();
  assert.equal(harness.ports.calls.length, 0, "enablement seeds a baseline without running");
  revision = "2";
  await harness.service.pollFileChanges();
  harness.clock.advance(1000);
  revision = "3";
  await harness.service.pollFileChanges();
  harness.clock.advance(2000);
  await harness.service.pollFileChanges();
  await waitForCondition(async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"), "folder handoff");
  assert.deepEqual(harness.ports.calls.map(({ kind }) => kind), ["chat", "files", "check"]);
  const accepted = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "accepted");
  assert.deepEqual(accepted?.cause, {
    kind: "files-changed",
    workFolderId: workFolderA,
    snapshotDigest: "3".repeat(64),
    changedCount: 1,
    changedPaths: ["Drafts/notes.md"],
  });
  revision = "4";
  harness.clock.advance(120_000);
  await harness.service.pollFileChanges();
  harness.clock.advance(2000);
  await harness.service.pollFileChanges();
  assert.equal(harness.ports.calls.length, 3, "post-run baseline absorbs generated output");
  harness.service.suspend();
  const beforePause = observations;
  revision = "5";
  await harness.service.pollFileChanges();
  assert.equal(observations, beforePause);
  await harness.service.resume();
  await harness.service.pollFileChanges();
  harness.clock.advance(2000);
  await harness.service.pollFileChanges();
  assert.equal(harness.ports.calls.length, 3, "wake never replays missed edits");
  await harness.service.disable("automation-folder-handoff");
  revision = "6";
  await harness.service.pollFileChanges();
  assert.equal((await harness.service.getAutomation("automation-folder-handoff"))?.health, "disabled");
});

test("folder observer failures stay visible and a scan cannot outlive revocation", async (t) => {
  let fail = false;
  let hold: ReturnType<typeof deferred> | undefined;
  const harness = await createHarness(t, { observeFiles: async () => {
    if (hold) await hold.promise;
    if (fail) throw new Error("Watched folder is unavailable");
    return { digest: "a".repeat(64), entries: { "Drafts/a.md": "a" } };
  } });
  const trigger = { kind: "files-changed", workFolder: workFolderA, watch: { kind: "tree", path: "Drafts", recursive: false, extensions: [".md"] }, debounceSeconds: 2, cooldownMinutes: 1 };
  await harness.enable(declarationInput("automation-folder-health", { version: 3, trigger }));
  fail = true;
  await harness.service.pollFileChanges();
  assert.equal((await harness.service.getAutomation("automation-folder-health"))?.fileWatch?.state, "error");
  fail = false;
  hold = deferred();
  const scan = harness.service.pollFileChanges();
  await harness.service.disable("automation-folder-health");
  hold.resolve();
  await scan;
  assert.equal(harness.ports.calls.length, 0);
  await assert.rejects(harness.enable(declarationInput("automation-folder-health", { version: 2, trigger })), /version 3/);
});

// The version-4 placeholder set (docs/receipts-not-gates.md, F23). Resolution
// is host-side, in the executor, from the run's own cause and its earlier
// hops' host records — never from model output — and every filled-in text
// lands on the hop's terminal receipt so a person can see what was said.
const placeholderTrigger = {
  kind: "files-changed",
  workFolder: workFolderA,
  watch: { kind: "tree", path: "Drafts", recursive: true, extensions: [".md"] },
  debounceSeconds: 2,
  cooldownMinutes: 1,
};

const placeholderSteps = [
  { id: "review", kind: "chat", workFolder: workFolderA, message: "{{trigger.summary}}\nChanged:\n{{trigger.changedFiles}}" },
  { id: "report", kind: "agent", message: "Created:\n{{steps.review.createdFiles}}" },
];

function seedReviewManifests(harness: Harness, created: Array<{ path: string; sizeBytes?: number }>): void {
  harness.ports.manifests.set(`${workFolderA}/pre-review`, { files: [], skippedFilePaths: [] });
  harness.ports.manifests.set(`${workFolderA}/post-review`, {
    files: created.map((file) => ({ path: file.path, hashSha256: `hash-${file.path}`, sizeBytes: file.sizeBytes ?? 10 })),
    skippedFilePaths: [],
  });
}

test("placeholders resolve host-side from the cause and earlier chat hops, and land on the hop receipt", async (t) => {
  let revision = "1";
  const harness = await createHarness(t, {
    observeFiles: async () => ({
      digest: revision.repeat(64),
      entries: { "Drafts/notes.md": revision, "Drafts/plan.md": revision },
    }),
  });
  await harness.enable(declarationInput("automation-placeholders", {
    version: 4,
    trigger: placeholderTrigger,
    steps: placeholderSteps,
  }));
  seedReviewManifests(harness, [{ path: "reports/new.md" }, { path: "reports/a.md" }]);

  await harness.service.pollFileChanges();
  harness.clock.advance(10_000);
  revision = "2";
  await harness.service.pollFileChanges();
  harness.clock.advance(3_000);
  await harness.service.pollFileChanges();
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the folder-change run to settle",
  );

  const chatCall = harness.ports.calls.find((call) => call.kind === "chat");
  assert.equal(
    chatCall?.message,
    '2 file(s) changed under "Drafts" in work-folder space-aaaaaaaaaaaaaaaa.\nChanged:\nDrafts/notes.md\nDrafts/plan.md',
    "the trigger summary and changed paths are filled in from the run cause",
  );
  const workFoldAgentCall = harness.ports.calls.find((call) => call.kind === "agent");
  assert.equal(
    workFoldAgentCall?.message,
    "Created:\nreports/a.md\nreports/new.md",
    "created files come from the chat hop's own checkpoint pair, sorted",
  );

  const reportHop = (await harness.journal()).find((line) => line.hopId === "report" && line.outcome === "succeeded");
  assert.equal(reportHop?.hopKind, "agent");
  assert.deepEqual(reportHop?.placeholders, [{
    name: "steps.review.createdFiles",
    text: "reports/a.md\nreports/new.md",
    bytes: Buffer.byteLength("reports/a.md\nreports/new.md", "utf8"),
    truncated: false,
  }]);
  assert.equal(reportHop?.messageBytes, Buffer.byteLength(workFoldAgentCall!.message!, "utf8"));

  // Resolution is by cause, never by the declared trigger: a run started by
  // hand says so instead of pretending files changed.
  await waitForCondition(() => harness.service.status().activeRunCount === 0, "the folder-change run to release its slot");
  harness.ports.calls.length = 0;
  const manual = await harness.service.runNow("automation-placeholders", { requestId: "request-by-hand" });
  assert.equal(manual.outcome, "success");
  assert.equal(
    harness.ports.calls.find((call) => call.kind === "chat")?.message,
    "Started by hand.\nChanged:\n(no changed files: this run was started by hand)",
  );
});

test("filled-in placeholder text obeys the automation message character rule, so the receipt matches what was sent", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-placeholder-characters", {
    version: 4,
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Write the weekly summary." },
      { id: "report", kind: "agent", message: "Created:\n{{steps.review.createdFiles}}" },
    ],
  }));
  // A file work-fold did not create can carry a direction override or a C0
  // control in its name. A declared message carrying either is refused at
  // parse time, so substituted text must not smuggle one past that rule.
  seedReviewManifests(harness, [
    { path: "reports/\u202einvoice.md" },
    { path: "reports/plain\u0007.md" },
  ]);

  assert.equal((await harness.service.runNow("automation-placeholder-characters", { requestId: "request-1" })).outcome, "success");
  const workFoldAgentCall = harness.ports.calls.find((call) => call.kind === "agent");
  assert.equal(
    workFoldAgentCall?.message,
    "Created:\nreports/plain\ufffd.md\nreports/\ufffdinvoice.md",
    "the destination receives text that obeys the same character rule as a declared message",
  );
  assert.doesNotMatch(workFoldAgentCall?.message ?? "", /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);

  const reportHop = (await harness.journal()).find((line) => line.hopId === "report" && line.outcome === "succeeded");
  assert.equal(
    reportHop?.placeholders?.[0]?.text,
    "reports/plain\ufffd.md\nreports/\ufffdinvoice.md",
    "the receipt records exactly the text the destination received",
  );
  assert.equal(reportHop?.messageBytes, Buffer.byteLength(workFoldAgentCall!.message!, "utf8"));
});

test("a filled-in list names the limit that cut it, and a too-large message fails the hop", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-placeholder-bounds", {
    version: 4,
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Write the weekly summary." },
      { id: "report", kind: "agent", message: "Created:\n{{steps.review.createdFiles}}" },
    ],
  }));
  const many = workFoldAutomationBounds.maxPlaceholderListItems + 50;
  seedReviewManifests(harness, Array.from({ length: many }, (_, index) => ({
    path: `reports/note-${String(index).padStart(5, "0")}.md`,
  })));

  assert.equal((await harness.service.runNow("automation-placeholder-bounds", { requestId: "request-1" })).outcome, "success");
  const reportHop = (await harness.journal()).find((line) => line.hopId === "report" && line.outcome === "succeeded");
  assert.equal(reportHop?.placeholders?.[0]?.truncated, true);
  assert.match(
    reportHop?.placeholders?.[0]?.text ?? "",
    new RegExp(`\\n… and 50 more \\(${workFoldAutomationBounds.maxPlaceholderListItems}-item limit for one filled-in placeholder\\)$`),
  );
  assert.equal(
    reportHop?.placeholders?.[0]?.text.split("\n").length,
    workFoldAutomationBounds.maxPlaceholderListItems + 1,
    "the cut happens at a line boundary, plus the marker line",
  );

  // One filled-in placeholder is bounded; the whole message has its own
  // bound, and exceeding it fails the hop rather than sending a document.
  const chatMessage = `Work on this.\n${Array.from({ length: 12 }, () => "{{steps.review.createdFiles}}").join("\n")}`;
  await harness.enable(declarationInput("automation-message-bound", {
    version: 4,
    steps: [
      { id: "review", kind: "chat", workFolder: workFolderA, message: "Write the weekly summary." },
      { id: "flood", kind: "chat", workFolder: workFolderB, message: chatMessage },
      { id: "after", kind: "check", workFolder: workFolderB },
    ],
  }), "request-message-bound");
  const wide = "x".repeat(4_000);
  // Enough wide paths that twelve filled-in copies overflow the whole-message bound.
  const wideCount = Math.ceil(workFoldAutomationBounds.maxResolvedMessageBytes / 12 / wide.length) + 10;
  harness.ports.manifests.set(`${workFolderA}/pre-review`, { files: [], skippedFilePaths: [] });
  harness.ports.manifests.set(`${workFolderA}/post-review`, {
    files: Array.from({ length: wideCount }, (_, index) => ({ path: `reports/${wide}-${index}.md`, hashSha256: `h-${index}`, sizeBytes: 10 })),
    skippedFilePaths: [],
  });
  const flooded = await harness.service.runNow("automation-message-bound", { requestId: "request-2" });
  assert.equal(flooded.outcome, "failure");
  const floodLines = (await harness.journal()).filter((line) => line.automationId === "automation-message-bound" && line.scope === "hop");
  const failed = floodLines.find((line) => line.hopId === "flood" && line.outcome === "failed");
  assert.match(failed?.detail ?? "", new RegExp(`${workFoldAutomationBounds.maxResolvedMessageBytes / 1024} KiB limit for one step`));
  assert.equal(
    floodLines.find((line) => line.hopId === "after" && line.outcome === "skipped")?.failedHopId,
    "flood",
    "a resolution that cannot be proven fails the hop closed and later hops are skipped",
  );
  assert.equal(harness.ports.calls.filter((call) => call.hopId === "flood").length, 0, "nothing was sent");
});

test("{{trigger.findings}} reads the settled Check run through the port and fails closed when it cannot", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-findings", {
    version: 4,
    trigger: { kind: "on-settled", source: { kind: "check-run", workFolder: workFolderA, outcomes: ["succeeded"] } },
    steps: [{ id: "triage", kind: "chat", workFolder: workFolderB, message: "Triage these:\n{{trigger.findings}}" }],
  }));
  harness.ports.findingsByTask.set("settled-check-task-1", {
    findings: [
      { checkId: "check-quality-gate", title: "Stale link", targetPath: "docs/a.md", severity: "warning" },
      { checkId: "check-quality-gate", title: "Missing owner", targetPath: "docs/b.md", severity: "notice" },
    ],
  });

  harness.signal.publish(checkSettle);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "succeeded"),
    "the settle-admitted run to settle",
  );
  assert.equal(
    harness.ports.calls.find((call) => call.kind === "chat")?.message,
    "Triage these:\n- [warning] Stale link — docs/a.md (check-quality-gate)\n- [notice] Missing owner — docs/b.md (check-quality-gate)",
  );

  await waitForCondition(() => harness.service.status().activeRunCount === 0, "the first run to release its slot");
  harness.ports.findingsByTask.delete("settled-check-task-1");
  harness.ports.calls.length = 0;
  harness.signal.publish({ ...checkSettle, runId: "settled-check-run-2" });
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.hopId === "triage" && line.outcome === "failed"),
    "the unreadable findings to fail the hop",
  );
  const failed = (await harness.journal()).find((line) => line.hopId === "triage" && line.outcome === "failed");
  assert.match(failed?.detail ?? "", /could not be read/);
  assert.equal(harness.ports.calls.length, 0, "nothing was sent on an unprovable resolution");
});

test("a fold hop starts a work-fold agent turn, stops honestly, and never fires another trigger", async (t) => {
  const harness = await createHarness(t);
  await harness.enable(declarationInput("automation-agent-only", {
    version: 4,
    steps: [{ id: "digest", kind: "agent", message: "{{trigger.summary}} Say hello." }],
  }));

  assert.equal((await harness.service.runNow("automation-agent-only", { requestId: "request-1" })).outcome, "success");
  assert.equal(harness.ports.calls[0]?.kind, "agent");
  assert.equal(harness.ports.calls[0]?.message, "Started by hand. Say hello.");
  const hop = (await harness.journal()).find((line) => line.hopId === "digest" && line.outcome === "succeeded");
  assert.equal(hop?.hopKind, "agent");
  assert.equal(hop?.conversationId, "agent-conversation-digest");
  assert.equal(hop?.taskId, "agent-turn-task-digest");
  assert.equal(hop?.workFolderId, undefined, "the work-fold agent names no work-folder: it sits above them");

  harness.ports.workFoldAgentImpl = harness.ports.abortableWorkFoldAgent;
  const stoppable = harness.service.runNow("automation-agent-only", { requestId: "request-2" });
  await waitForCondition(() => harness.ports.calls.filter((call) => call.kind === "agent").length === 2, "the work-fold agent turn to start");
  assert.deepEqual(harness.service.stopRun("automation-agent-only", { requestId: "request-stop", surface: "cli" }), { runId: "run-2" });
  assert.equal((await stoppable).outcome, "failure");
  const stopped = (await harness.journal()).find((line) => line.scope === "hop" && line.outcome === "stopped");
  assert.equal(stopped?.hopId, "digest");
  const stoppedRun = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "stopped");
  assert.deepEqual(stoppedRun?.stoppedHopTaskIds, ["agent-turn-task-digest"], "stop names the work-fold agent turn it aborted");
});

test("enabling an identical declaration again changes nothing and leaves the active run alone", async (t) => {
  const harness = await createHarness(t);
  const raw = declarationInput("automation-idempotent", {
    steps: [{ id: "review", kind: "chat", workFolder: workFolderA, message: "Review chapters." }],
  });
  const first = await harness.enable(raw, "request-enable-1");
  assert.equal(first.grants.length, 1);

  harness.ports.chatImpl = harness.ports.abortableChat;
  const running = harness.service.runNow("automation-idempotent", { requestId: "request-run" });
  await waitForCondition(() => harness.ports.calls.length === 1, "the run to hold its hop");

  const again = await harness.enable(raw, "request-enable-2");
  assert.equal(again.grants.length, 1, "an identical enablement writes no fresh receipt");
  assert.deepEqual(again.grants[0]?.requestId, "request-enable-1");
  assert.equal(
    (await harness.journal()).filter((line) => line.scope === "automation" && line.outcome === "enabled").length,
    1,
    "and no second journal line",
  );
  assert.equal((await harness.service.getAutomation("automation-idempotent"))?.activeRunId, "run-1", "the run in flight is untouched");

  // A changed declaration is a fresh receipt that stops the run still
  // executing the previous one.
  const changed = await harness.enable(declarationInput("automation-idempotent", {
    steps: [{ id: "review", kind: "chat", workFolder: workFolderA, message: "Review chapters and the appendix." }],
  }), "request-enable-3");
  assert.equal(changed.grants.length, 2);
  await running.catch(() => undefined);
  await waitForCondition(
    async () => (await harness.journal()).some((line) => line.scope === "run" && line.outcome === "stopped"),
    "the run under the previous declaration to settle stopped",
  );
  assert.equal((await harness.journal()).find((line) => line.scope === "run" && line.outcome === "stopped")?.runId, "run-1");
});

test("automation declarations accept more than the former sixteen-step default", async (t) => {
  const harness = await createHarness(t);
  assert.ok(workFoldAutomationMaxConcurrentRuns >= 8, "runs at once only ever grew");

  const seventeen = Array.from({ length: 17 }, (_, index) => ({
    id: `hop-${index}`,
    kind: "chat",
    workFolder: workFolderA,
    message: `Step ${index}.`,
  }));
  const enabled = await harness.enable(declarationInput("automation-seventeen-steps", { version: 4, steps: seventeen }));
  assert.equal(enabled.declaration.steps.length, 17);
  const eighteen = await harness.enable(declarationInput("automation-eighteen-steps", {
    version: 4,
    steps: [...seventeen, { id: "hop-17", kind: "chat", workFolder: workFolderA, message: "Another step." }],
  }), "request-eighteen");
  assert.equal(eighteen.declaration.steps.length, 18);

  harness.ports.chatImpl = harness.ports.abortableChat;
  const automationIds = Array.from({ length: workFoldAutomationMaxConcurrentRuns + 1 }, (_, index) => `automation-slot-hold-${index}`);
  for (const automationId of automationIds) {
    await harness.enable(declarationInput(automationId, {
      steps: [{ id: "hold", kind: "chat", workFolder: workFolderA, message: "Hold the slot." }],
    }), `request-${automationId}`);
  }
  const runs = automationIds.map((automationId) => harness.service.runNow(automationId, { requestId: `request-run-${automationId}` }));
  await waitForCondition(
    () => harness.ports.calls.filter((call) => call.hopId === "hold").length === workFoldAutomationMaxConcurrentRuns,
    "a run holding every slot",
  );
  assert.equal(harness.service.status().activeRunCount, workFoldAutomationMaxConcurrentRuns);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(
    harness.ports.calls.filter((call) => call.hopId === "hold").length,
    workFoldAutomationMaxConcurrentRuns,
    "the admission past the budget queues instead of launching",
  );
  // Let the queued admission finish once a slot frees, so the harness
  // tears down with nothing in flight.
  harness.ports.chatImpl = harness.ports.defaultChat;
  for (const automationId of automationIds) harness.service.stopRun(automationId);
  await Promise.allSettled(runs);
  assert.equal(
    harness.ports.calls.filter((call) => call.hopId === "hold").length,
    automationIds.length,
    "the queued run launched after a slot freed, never lost",
  );
});
