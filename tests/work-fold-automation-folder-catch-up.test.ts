import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { WorkFoldSchedulerClock } from "../src/local/agent/work-fold-scheduler-service.js";
import {
  normalizeWorkFoldAutomationDeclaration,
  workFoldAutomationBounds,
  workFoldAutomationDigest,
  type WorkFoldAutomationChatStep,
  type WorkFoldAutomationFilesChangedTrigger,
} from "../src/local/automations/automation-declarations.js";
import {
  observeWorkFoldAutomationFiles,
  workFoldAutomationCaughtUpPaths,
  workFoldAutomationDirtySnapshotNotice,
  workFoldAutomationFileObserverBounds,
  WorkFoldAutomationFileWatch,
  type WorkFoldAutomationFileSnapshot,
} from "../src/local/automations/automation-file-observer.js";
import {
  WorkFoldAutomationFileSnapshots,
  workFoldAutomationFileWatchKey,
} from "../src/local/automations/automation-file-snapshots.js";
import {
  WorkFoldAutomationService,
  type WorkFoldAutomationAgentHopResult,
  type WorkFoldAutomationChatHopResult,
  type WorkFoldAutomationCheckHopResult,
  type WorkFoldAutomationFilesHopResult,
  type WorkFoldAutomationHopContext,
  type WorkFoldAutomationHopPorts,
} from "../src/local/automations/automation-service.js";
import {
  WorkFoldAutomationReceipts,
  WorkFoldAutomationStore,
  type WorkFoldAutomationReceiptV1,
} from "../src/local/automations/automation-store.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import { registerLinkedWorkFolder } from "../src/local/work-folder.js";

// Folder-change catch-up (docs/automations.md, 2026-10-11 amendment): an
// automation that declares `"ifMissed": "run"` keeps a machine-local metadata
// snapshot and, after work-fold was closed, asleep, turned off, or unable to
// watch, starts one run for the files added or changed in that gap.

const startTime = Date.parse("2026-10-11T09:00:00.000Z");
const workFolderA = "space-aaaaaaaaaaaaaaaa";

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

/** A watched folder as the observer reports it: path → dev:ino:size:mtime:ctime. */
class FakeFolder {
  readonly files = new Map<string, { dev: number; ino: number; size: number; mtime: number; ctime: number }>();
  failure: Error | undefined;
  #tick = 1_000;
  #nextIno = 100;

  write(path: string, size = 10): void {
    const at = ++this.#tick;
    const existing = this.files.get(path);
    this.files.set(path, { dev: 1, ino: existing?.ino ?? this.#nextIno++, size, mtime: at, ctime: at });
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** What a remount, a sync client, or opening a file can do without changing the file. */
  churnMetadata(path: string): void {
    const file = this.files.get(path)!;
    this.files.set(path, { ...file, dev: file.dev + 1, ino: this.#nextIno++, ctime: ++this.#tick });
  }

  snapshot(): WorkFoldAutomationFileSnapshot {
    const entries: Record<string, string> = {};
    for (const path of [...this.files.keys()].sort()) {
      const file = this.files.get(path)!;
      entries[path] = [file.dev, file.ino, file.size, file.mtime, file.ctime].join(":");
    }
    return { digest: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
  }

  readonly observe = async (_trigger: WorkFoldAutomationFilesChangedTrigger): Promise<WorkFoldAutomationFileSnapshot> => {
    if (this.failure) throw this.failure;
    return this.snapshot();
  };
}

class FakePorts implements WorkFoldAutomationHopPorts {
  readonly messages: Array<{ automationId: string; message: string }> = [];
  /** Runs inside the chat hop, before it settles; a test can edit the folder here. */
  onChat: (context: WorkFoldAutomationHopContext) => Promise<void> | void = () => undefined;

  async chat(_step: WorkFoldAutomationChatStep, message: string, context: WorkFoldAutomationHopContext): Promise<WorkFoldAutomationChatHopResult> {
    this.messages.push({ automationId: context.automationId, message });
    await this.onChat(context);
    return {
      conversationId: `conversation-${context.runId}`,
      turnTaskId: `turn-${context.runId}`,
      outcome: context.signal.aborted ? "aborted" : "succeeded",
    };
  }

  async workFoldAgent(): Promise<WorkFoldAutomationAgentHopResult> {
    return { conversationId: "agent-conversation", turnTaskId: "agent-turn", outcome: "succeeded" };
  }

  async checkRunFindings(): Promise<null> {
    return null;
  }

  async files(): Promise<WorkFoldAutomationFilesHopResult> {
    return { copiedPaths: [], fileCount: 0, totalBytes: 0 };
  }

  async check(): Promise<WorkFoldAutomationCheckHopResult> {
    return { runId: "check-run", taskId: "check-task", state: "succeeded", checkIds: [], findingCount: 0, admittedCount: 0 };
  }

  async checkpointManifest(): Promise<null> {
    return null;
  }
}

interface Harness {
  readonly sandbox: string;
  readonly clock: FakeClock;
  readonly folder: FakeFolder;
  readonly ports: FakePorts;
  readonly snapshotsDir: string;
  service: WorkFoldAutomationService;
  /** Simulates quitting work-fold: the executor closes and nothing more is observed. */
  quit(): void;
  /** Simulates the next launch over the same machine-local state. */
  launch(): Promise<void>;
  enable(raw: unknown, requestId?: string): Promise<void>;
  poll(advanceMs?: number): Promise<void>;
  journal(): Promise<WorkFoldAutomationReceiptV1[]>;
  acceptedRuns(automationId?: string): Promise<WorkFoldAutomationReceiptV1[]>;
  settledRuns(count: number): Promise<void>;
}

async function createHarness(t: TestContext, options: { observeFiles?: Harness["folder"]["observe"] } = {}): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-folder-catch-up-"));
  const clock = new FakeClock(startTime);
  const folder = new FakeFolder();
  const ports = new FakePorts();
  const automationsDir = join(sandbox, "state", "automations");
  const journalPath = join(automationsDir, "receipts.jsonl");
  let nextRunId = 0;
  let current: WorkFoldAutomationService | undefined;

  const launch = async () => {
    const now = () => clock.now();
    const receipts = new WorkFoldAutomationReceipts({ path: journalPath, rotatedPath: join(automationsDir, "receipts.1.jsonl"), now });
    const store = await WorkFoldAutomationStore.create({ path: join(automationsDir, "automations.json"), receipts, now });
    current = await WorkFoldAutomationService.create({
      store,
      ports,
      observeFiles: options.observeFiles ?? folder.observe,
      filePollIntervalMs: 0,
      clock,
      createRunId: () => `run-${++nextRunId}`,
      catchUpStagger: () => 0,
    });
  };
  await launch();

  t.after(async () => {
    current?.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(sandbox, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  const journal = async () => (await readFile(journalPath, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as WorkFoldAutomationReceiptV1);

  const harness: Harness = {
    sandbox,
    clock,
    folder,
    ports,
    snapshotsDir: join(automationsDir, "folder-snapshots"),
    get service() { return current!; },
    set service(value) { current = value; },
    quit: () => { current?.close(); },
    launch,
    enable: async (raw, requestId = "request-1") => {
      const declaration = normalizeWorkFoldAutomationDeclaration(raw);
      await current!.enable({
        declaration,
        expectedDigest: workFoldAutomationDigest(declaration),
        grant: { requestId, surface: "popover" },
      });
    },
    poll: async (advanceMs = 0) => {
      if (advanceMs) clock.advance(advanceMs);
      await current!.pollFileChanges();
    },
    journal,
    acceptedRuns: async (automationId) => (await journal())
      .filter((line) => line.scope === "run" && line.outcome === "accepted" && (!automationId || line.automationId === automationId)),
    settledRuns: async (count) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const settled = (await journal()).filter((line) => line.scope === "run" && line.outcome !== "accepted" && line.outcome !== "skipped");
        if (settled.length >= count && current!.status().activeRunCount === 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const lines = (await journal()).map((line) => `${line.scope}:${line.outcome}:${line.runId ?? "-"}:${line.detail ?? ""}`);
      throw new Error(`Timed out waiting for ${count} settled run(s). Journal:\n${lines.join("\n")}`);
    },
  };
  return harness;
}

const watchTrigger = {
  kind: "files-changed",
  workFolder: workFolderA,
  watch: { kind: "tree", path: "Screenshots", recursive: false, extensions: [".png"] },
  debounceSeconds: 2,
  cooldownMinutes: 1,
} as const;

function screenshotsAutomation(id: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: "work-fold.automation",
    version: 5,
    id,
    title: "File new screenshots",
    createdBy: "human",
    createdAt: "2026-10-11T08:00:00.000Z",
    trigger: { ...watchTrigger, ifMissed: "run" },
    steps: [{
      id: "file",
      kind: "chat",
      workFolder: workFolderA,
      message: "{{trigger.summary}}\nLook at these screenshots, rename them, and file them:\n{{trigger.changedFiles}}",
    }],
    ...overrides,
  };
}

const automationId = "automation-screenshots-catch-up";

/** Enables, takes the first look, and saves it, the way a person turning it on would. */
async function enableAndSettle(harness: Harness, raw: unknown = screenshotsAutomation(automationId)): Promise<void> {
  await harness.enable(raw);
  await harness.poll();
  await harness.poll(5_000);
}

test("a catch-up fires once, after the debounce, with exactly the files added or changed while work-fold was closed", async (t) => {
  const harness = await createHarness(t);
  harness.folder.write("Screenshots/kept.png");
  harness.folder.write("Screenshots/edited.png");
  harness.folder.write("Screenshots/deleted.png");
  harness.folder.write("Screenshots/remounted.png");
  await enableAndSettle(harness);
  assert.equal((await harness.acceptedRuns()).length, 0, "enabling takes a first look; existing files never launch work");

  harness.quit();
  harness.folder.write("Screenshots/new.png");
  harness.folder.write("Screenshots/edited.png", 99);
  harness.folder.remove("Screenshots/deleted.png");
  harness.folder.churnMetadata("Screenshots/remounted.png");
  harness.clock.advance(3 * 60 * 60_000);
  await harness.launch();

  await harness.poll();
  assert.equal((await harness.acceptedRuns()).length, 0, "the first look finds the catch-up but waits for the folder to settle");
  assert.deepEqual((await harness.service.getAutomation(automationId))?.fileWatch?.catchingUp, { reason: "closed", count: 2 });
  await harness.poll(1_000);
  assert.equal((await harness.acceptedRuns()).length, 0);
  await harness.poll(1_000);
  await harness.settledRuns(1);

  const [accepted] = await harness.acceptedRuns();
  assert.deepEqual(accepted?.cause, {
    kind: "files-changed",
    workFolderId: workFolderA,
    snapshotDigest: harness.folder.snapshot().digest,
    changedCount: 2,
    changedPaths: ["Screenshots/edited.png", "Screenshots/new.png"],
    catchUp: { reason: "closed", count: 2 },
  });
  assert.equal(
    harness.ports.messages[0]?.message,
    `Caught up on 2 files under "Screenshots" in work-folder ${workFolderA} that changed while work-fold was closed.\n`
      + "Look at these screenshots, rename them, and file them:\nScreenshots/edited.png\nScreenshots/new.png",
  );
  const terminal = (await harness.journal()).find((line) => line.scope === "run" && line.outcome === "succeeded");
  assert.deepEqual(terminal?.cause, accepted?.cause, "the terminal receipt names the same catch-up cause");

  // At most once: nothing is owed after the run, and no backlog follows.
  for (let step = 0; step < 5; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns()).length, 1);
  const watch = (await harness.service.getAutomation(automationId))?.fileWatch;
  assert.equal(watch?.catchingUp, undefined);
  assert.ok(watch?.lastCatchUpAt);

  // A launch over an unchanged folder catches up on nothing.
  harness.quit();
  await harness.launch();
  for (let step = 0; step < 4; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns()).length, 1);
});

test("nothing changed, only removals, or only device/inode/change-time churn: no catch-up", async (t) => {
  const harness = await createHarness(t);
  harness.folder.write("Screenshots/a.png");
  harness.folder.write("Screenshots/b.png");
  await enableAndSettle(harness);

  harness.quit();
  await harness.launch();
  for (let step = 0; step < 3; step += 1) await harness.poll(70_000);

  harness.quit();
  harness.folder.remove("Screenshots/b.png");
  harness.folder.churnMetadata("Screenshots/a.png");
  await harness.launch();
  for (let step = 0; step < 3; step += 1) await harness.poll(70_000);

  assert.equal((await harness.acceptedRuns()).length, 0);
  assert.equal(harness.ports.messages.length, 0);
});

test("an automation that did not opt in never catches up and keeps no snapshot", async (t) => {
  const harness = await createHarness(t);
  harness.folder.write("Screenshots/a.png");
  const { ifMissed: _ifMissed, ...trigger } = { ...watchTrigger, ifMissed: "run" };
  await enableAndSettle(harness, screenshotsAutomation(automationId, { version: 4, trigger }));

  harness.quit();
  harness.folder.write("Screenshots/new.png");
  harness.folder.write("Screenshots/a.png", 50);
  await harness.launch();
  for (let step = 0; step < 4; step += 1) await harness.poll(70_000);

  assert.equal((await harness.acceptedRuns()).length, 0, "the default still takes a fresh look after a restart");
  assert.equal(existsSync(harness.snapshotsDir), false, "nothing is saved for an automation that did not opt in");

  // Live changes still work exactly as before.
  harness.folder.write("Screenshots/live.png");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(1);
  const [accepted] = await harness.acceptedRuns();
  assert.equal((accepted?.cause as { catchUp?: unknown }).catchUp, undefined);
  assert.deepEqual((accepted?.cause as { changedPaths?: string[] }).changedPaths, ["Screenshots/live.png"]);
});

test("the saved snapshot is metadata in app state, bounded to the watched selector, and removed with the automation", async (t) => {
  const harness = await createHarness(t);
  harness.folder.write("Screenshots/a.png");
  await enableAndSettle(harness);

  const recordPath = join(harness.snapshotsDir, `${automationId}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), ["automationId", "kind", "savedAt", "snapshot", "v", "watchKey"]);
  assert.equal(record.kind, "work-fold.automation-folder-snapshot");
  assert.equal(record.watchKey, workFoldAutomationFileWatchKey({
    ...watchTrigger,
    watch: { ...watchTrigger.watch, extensions: [...watchTrigger.watch.extensions] },
  }));
  assert.deepEqual(record.snapshot, {
    digest: harness.folder.snapshot().digest,
    entries: harness.folder.snapshot().entries,
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    assert.equal((await stat(harness.snapshotsDir)).mode & 0o777, 0o700);
  }

  // Turning it off keeps the snapshot so turning it on can catch up; a
  // different watched folder is never compared with it.
  await harness.service.disable(automationId);
  assert.equal(existsSync(recordPath), true);
  harness.folder.write("Screenshots/b.png");
  harness.folder.write("Elsewhere/c.png");
  await harness.enable(screenshotsAutomation(automationId, {
    trigger: { ...watchTrigger, watch: { ...watchTrigger.watch, path: "Elsewhere" }, ifMissed: "run" },
  }), "request-2");
  for (let step = 0; step < 3; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns()).length, 0, "a changed selector starts from a fresh look");

  await harness.service.disable(automationId);
  await harness.service.deleteAutomation(automationId);
  assert.equal(existsSync(recordPath), false, "deleting the automation forgets its snapshot");
});

test("a run that edits its own watched folder never starts another run, even across a restart", async (t) => {
  const harness = await createHarness(t);
  await enableAndSettle(harness);
  harness.ports.onChat = () => {
    // The Worker renames and files the screenshot it was given.
    harness.folder.remove("Screenshots/raw.png");
    harness.folder.write("Screenshots/2026-10-11 receipt.png");
  };

  harness.folder.write("Screenshots/raw.png");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(1);
  assert.equal((await harness.acceptedRuns()).length, 1);

  // The post-run look absorbs the run's own edits and is what gets saved.
  for (let step = 0; step < 4; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns()).length, 1, "no loop while running");
  assert.equal(existsSync(join(harness.snapshotsDir, `${automationId}.running`)), false);

  harness.quit();
  await harness.launch();
  for (let step = 0; step < 4; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns()).length, 1, "a restart does not catch up on the run's own output");
});

test("quitting during a run takes a fresh look on the next launch instead of catching up on the run's edits", async (t) => {
  const harness = await createHarness(t);
  await enableAndSettle(harness);
  let reachedHop!: () => void;
  const hopReached = new Promise<void>((resolve) => { reachedHop = resolve; });
  harness.ports.onChat = (context) => new Promise<void>((resolve) => {
    harness.folder.remove("Screenshots/raw.png");
    harness.folder.write("Screenshots/half-filed.png");
    reachedHop();
    context.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  harness.folder.write("Screenshots/raw.png");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await hopReached;
  assert.equal(existsSync(join(harness.snapshotsDir, `${automationId}.running`)), true, "a running run marks the saved snapshot");

  harness.quit();
  await harness.settledRuns(1);
  harness.ports.onChat = () => undefined;
  harness.folder.write("Screenshots/after-quit.png");
  await harness.launch();
  for (let step = 0; step < 4; step += 1) await harness.poll(70_000);

  assert.equal((await harness.acceptedRuns()).length, 1, "neither the run's own edits nor anything else is replayed");
  assert.equal((await harness.service.getAutomation(automationId))?.fileWatch?.notice, workFoldAutomationDirtySnapshotNotice);
  assert.equal(existsSync(join(harness.snapshotsDir, `${automationId}.running`)), false, "the fresh look is saved");

  // Watching continues normally from that fresh look.
  harness.folder.write("Screenshots/next.png");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(2);
  const runs = await harness.acceptedRuns();
  assert.equal(runs.length, 2);
  assert.deepEqual((runs[1]?.cause as { changedPaths?: string[] }).changedPaths, ["Screenshots/next.png"]);
});

test("wake, Turn on, and observer recovery each catch up once and say which gap it was", async (t) => {
  const harness = await createHarness(t);
  await enableAndSettle(harness);
  const reasons = async () => (await harness.acceptedRuns())
    .map((line) => (line.cause as { catchUp?: { reason: string } }).catchUp?.reason);

  harness.service.suspend();
  harness.folder.write("Screenshots/while-asleep.png");
  await harness.service.resume();
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(1);
  await harness.poll(1_000);
  assert.deepEqual(await reasons(), ["asleep"]);
  assert.match(harness.ports.messages[0]!.message, /^Caught up on 1 file under "Screenshots" .* that changed while the computer was asleep\./);

  await harness.service.disable(automationId);
  harness.folder.write("Screenshots/while-off.png");
  harness.clock.advance(2 * 60_000);
  await harness.enable(screenshotsAutomation(automationId), "request-2");
  await harness.poll();
  await harness.poll(2_000);
  await harness.settledRuns(2);
  assert.deepEqual(await reasons(), ["asleep", "off"]);
  assert.match(harness.ports.messages[1]!.message, /that changed while this automation was off\./);

  await harness.poll(70_000);
  harness.folder.failure = new Error("The watched folder is unavailable.");
  await harness.poll(1_000);
  assert.equal((await harness.service.getAutomation(automationId))?.fileWatch?.state, "error");
  harness.folder.write("Screenshots/while-unavailable.png");
  await harness.poll(1_000);
  harness.folder.failure = undefined;
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(3);
  assert.deepEqual(await reasons(), ["asleep", "off", "unavailable"]);
  assert.match(harness.ports.messages[2]!.message, /that changed while the folder could not be watched\./);
  assert.deepEqual(
    harness.ports.messages.map((entry) => entry.message.split("\n").at(-1)),
    ["Screenshots/while-asleep.png", "Screenshots/while-off.png", "Screenshots/while-unavailable.png"],
  );
});

test("a catch-up respects the cooldown across a restart and coalesces later changes into the same run", async (t) => {
  const harness = await createHarness(t);
  await enableAndSettle(harness, screenshotsAutomation(automationId, {
    trigger: { ...watchTrigger, cooldownMinutes: 10, ifMissed: "run" },
  }));
  harness.folder.write("Screenshots/first.png");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(1);
  await harness.poll(1_000);

  harness.quit();
  harness.folder.write("Screenshots/while-closed.png");
  harness.clock.advance(60_000);
  await harness.launch();
  await harness.poll();
  await harness.poll(5_000);
  assert.equal((await harness.acceptedRuns()).length, 1, "the last run's cooldown survives the restart");

  // A later change folds into the waiting catch-up instead of queueing a second run.
  harness.folder.write("Screenshots/later.png");
  await harness.poll(2_000);
  await harness.poll(10 * 60_000);
  await harness.settledRuns(2);
  const runs = await harness.acceptedRuns();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1]?.cause && (runs[1].cause as { changedPaths?: string[]; catchUp?: unknown }).changedPaths, [
    "Screenshots/later.png",
    "Screenshots/while-closed.png",
  ]);
  assert.deepEqual((runs[1]?.cause as { catchUp?: unknown }).catchUp, { reason: "closed", count: 1 });
  assert.match(harness.ports.messages[1]!.message, /that changed while work-fold was closed\. 1 more file changed after that\./);
});

test("a run that starts before the first look still leaves the catch-up owed, without that run's edits", async (t) => {
  const harness = await createHarness(t);
  await enableAndSettle(harness);
  await harness.enable({
    kind: "work-fold.automation",
    version: 5,
    id: "automation-other-writer",
    title: "Another automation",
    createdBy: "human",
    createdAt: "2026-10-11T08:00:00.000Z",
    trigger: { kind: "manual" },
    steps: [{ id: "write", kind: "chat", workFolder: workFolderA, message: "Put a chart in Screenshots." }],
  });
  harness.ports.onChat = (context) => {
    if (context.automationId === "automation-other-writer") harness.folder.write("Screenshots/chart-from-another-run.png");
  };

  harness.quit();
  harness.folder.write("Screenshots/while-closed.png");
  await harness.launch();
  // The other automation runs before this launch's first look.
  assert.equal((await harness.service.runNow("automation-other-writer")).outcome, "success");
  await harness.poll(1_000);
  await harness.poll(2_000);
  await harness.settledRuns(2);

  const runs = await harness.acceptedRuns(automationId);
  assert.equal(runs.length, 1);
  assert.deepEqual((runs[0]?.cause as { changedPaths?: string[] }).changedPaths, ["Screenshots/while-closed.png"]);
  for (let step = 0; step < 3; step += 1) await harness.poll(70_000);
  assert.equal((await harness.acceptedRuns(automationId)).length, 1, "another automation's output never starts a run here");
});

test("the catch-up comparison counts new and resized or retimed files, and caps listed paths with a true count", () => {
  const saved = { digest: "a".repeat(64), entries: { "S/same.png": "1:10:5:100:100", "S/resized.png": "1:11:5:100:100", "S/retimed.png": "1:12:5:100:100", "S/gone.png": "1:13:5:100:100" } };
  const current = { digest: "b".repeat(64), entries: { "S/same.png": "9:99:5:100:555", "S/resized.png": "1:11:6:100:100", "S/retimed.png": "1:12:5:101:100", "S/new.png": "1:14:5:100:100" } };
  assert.deepEqual(workFoldAutomationCaughtUpPaths(saved, current), ["S/new.png", "S/resized.png", "S/retimed.png"]);

  const trigger: WorkFoldAutomationFilesChangedTrigger = { ...watchTrigger, watch: { ...watchTrigger.watch, extensions: [".png"] }, ifMissed: "run" };
  const watch = new WorkFoldAutomationFileWatch({ catchUp: "closed" });
  watch.load({ state: { snapshot: { digest: "c".repeat(64), entries: {} }, savedAt: new Date(0).toISOString() }, dirty: false }, 0);
  const many = workFoldAutomationBounds.maxChangedPathsRecorded + 1;
  const entries = Object.fromEntries(Array.from({ length: many }, (_, index) => [`S/${String(index).padStart(5, "0")}.png`, `1:${index}:1:1:1`]));
  const snapshot = { digest: "d".repeat(64), entries };
  assert.equal(watch.observe(snapshot, 0, trigger), null);
  assert.equal(watch.view().catchingUp?.count, many);
  const fired = watch.observe(snapshot, 2_000, trigger);
  assert.equal(fired?.changedCount, many);
  assert.equal(fired?.changedPaths.length, workFoldAutomationBounds.maxChangedPathsRecorded);
  assert.deepEqual(fired?.catchUp, { reason: "closed", count: many });
});

test("saved snapshots are read fail-safe and never exceed the observer's bounds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-folder-snapshots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const snapshots = new WorkFoldAutomationFileSnapshots({ directory });
  const key = "e".repeat(64);
  const id = "automation-bounded-snapshot";
  const state = {
    snapshot: { digest: "f".repeat(64), entries: { "S/a.png": "1:2:3:4:5" } },
    savedAt: "2026-10-11T09:00:00.000Z",
    lastTriggeredAt: "2026-10-11T08:59:00.000Z",
    owed: { reason: "closed" as const, paths: ["S/a.png"], foundAt: "2026-10-11T09:00:00.000Z" },
  };

  assert.deepEqual(await snapshots.read(id, key), { state: null, dirty: false });
  await snapshots.save(id, key, state);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  assert.deepEqual(plain(await snapshots.read(id, key)), { state, dirty: false });
  assert.deepEqual(await snapshots.read(id, "0".repeat(64)), { state: null, dirty: false }, "another selector has nothing to compare");
  await snapshots.markRunning(id, "2026-10-11T09:01:00.000Z");
  assert.equal((await snapshots.read(id, key)).dirty, true);
  await snapshots.clearRunning(id);
  assert.equal((await snapshots.read(id, key)).dirty, false);

  const tooMany = Object.fromEntries(
    Array.from({ length: workFoldAutomationFileObserverBounds.maxFiles + 1 }, (_, index) => [`S/${index}.png`, "1:2:3:4:5"]),
  );
  await assert.rejects(
    snapshots.save(id, key, { ...state, snapshot: { digest: state.snapshot.digest, entries: tooMany } }),
    /outside the bounds/,
  );
  await assert.rejects(snapshots.save(id, key, { ...state, snapshot: { digest: state.snapshot.digest, entries: { "/etc/passwd": "1:2:3:4:5" } } }), /outside the bounds/);
  assert.deepEqual(plain((await snapshots.read(id, key)).state), state, "a refused save leaves the last good snapshot");

  const recordPath = join(directory, `${id}.json`);
  const written = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
  await writeFile(recordPath, JSON.stringify({ ...written, snapshot: { digest: state.snapshot.digest, entries: tooMany } }));
  const oversized = await snapshots.read(id, key);
  assert.equal(oversized.state, null);
  assert.match(oversized.problem ?? "", /took a fresh look instead of catching up/);
  await writeFile(recordPath, "{not json");
  assert.equal((await snapshots.read(id, key)).state, null);
  await rm(recordPath);
  await writeFile(join(directory, "elsewhere.json"), JSON.stringify(written));
  await symlink(join(directory, "elsewhere.json"), recordPath);
  assert.equal((await snapshots.read(id, key)).state, null, "a linked record is never followed");

  await snapshots.remove(id);
  assert.deepEqual((await readdir(directory)).sort(), ["elsewhere.json"]);
});

test("with the real observer, files added while closed are caught up and the snapshot holds only metadata outside the work-folder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "work-fold-folder-catch-up-real-"));
  configureWorkFoldStateRoot(join(dir, "state"));
  let closeService = () => {};
  t.after(async () => {
    closeService();
    configureWorkFoldStateRoot(undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  const root = join(dir, "Desktop");
  await mkdir(join(root, "Screenshots"), { recursive: true });
  await writeFile(join(root, "Screenshots", "before.png"), "PIXELS-BEFORE");
  const workFolder = await registerLinkedWorkFolder(root);

  const clock = new FakeClock(startTime);
  const ports = new FakePorts();
  const automationsDir = join(dir, "state", "automations");
  const createService = async () => {
    const now = () => clock.now();
    const receipts = new WorkFoldAutomationReceipts({ path: join(automationsDir, "receipts.jsonl"), now });
    const store = await WorkFoldAutomationStore.create({ path: join(automationsDir, "automations.json"), receipts, now });
    return await WorkFoldAutomationService.create({
      store,
      ports,
      observeFiles: observeWorkFoldAutomationFiles,
      filePollIntervalMs: 0,
      clock,
      catchUpStagger: () => 0,
    });
  };
  let service = await createService();
  closeService = () => { service.close(); };
  const declaration = normalizeWorkFoldAutomationDeclaration(screenshotsAutomation(automationId, {
    trigger: { ...watchTrigger, workFolder: workFolder.id, ifMissed: "run" },
    steps: [{ id: "file", kind: "chat", workFolder: workFolder.id, message: "File these:\n{{trigger.changedFiles}}" }],
  }));
  await service.enable({ declaration, expectedDigest: workFoldAutomationDigest(declaration), grant: { requestId: "request-1", surface: "popover" } });
  await service.pollFileChanges();

  service.close();
  await writeFile(join(root, "Screenshots", "Screenshot 2026-10-11 at 21.04.png"), "PIXELS-WHILE-CLOSED");
  await writeFile(join(root, "Screenshots", "notes.txt"), "not a watched type");
  service = await createService();
  await service.pollFileChanges();
  clock.advance(2_000);
  await service.pollFileChanges();
  const journalPath = join(automationsDir, "receipts.jsonl");
  const succeeded = async () => (await readFile(journalPath, "utf8").catch(() => ""))
    .split("\n").some((line) => line.includes('"scope":"run"') && line.includes('"outcome":"succeeded"'));
  for (let attempt = 0; attempt < 400 && !(await succeeded()); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ports.messages[0]?.message, "File these:\nScreenshots/Screenshot 2026-10-11 at 21.04.png");

  const saved = await readFile(join(automationsDir, "folder-snapshots", `${automationId}.json`), "utf8");
  assert.doesNotMatch(saved, /PIXELS/, "no file contents are saved");
  assert.match(saved, /Screenshots\/before\.png/);
  const workFoldEntries = await readdir(join(root, ".work-fold"));
  assert.ok(!workFoldEntries.some((entry) => /automation|snapshot/i.test(entry)), "nothing automation-shaped enters the work-folder");
});

test("Turn on takes its first look before returning, so a file dropped right after is a change", async (t) => {
  const harness = await createHarness(t);
  harness.folder.write("Screenshots/already-there.png");
  await harness.enable(screenshotsAutomation(automationId));
  // No poll in between: the person drops a file the moment Turn on returns.
  harness.folder.write("Screenshots/just-dropped.png");
  await harness.poll();
  await harness.poll(5_000);
  await harness.settledRuns(1);
  const [accepted] = await harness.acceptedRuns();
  assert.deepEqual((accepted?.cause as { changedPaths?: string[] } | undefined)?.changedPaths, ["Screenshots/just-dropped.png"],
    "only the new file, and the one already there before Turn on never launches work");
});
