import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

import { workFoldBackgroundJobLimits } from "../src/shared/work-fold-limits.js";
import { describeJobState, WorkFoldJobLimitError, type WorkFoldJobRecord } from "../src/local/jobs/job-records.js";
import { JobOutputWriter, readJobOutputPage, sanitizeJobOutput } from "../src/local/jobs/job-output.js";
import { reapOrphanedJobProcesses, WorkFoldJobService, type WorkFoldJobServicePorts } from "../src/local/jobs/job-service.js";
import { WorkFoldJobStore } from "../src/local/jobs/job-store.js";

/**
 * The background job service on its own (docs/background-jobs.md, F31–F33):
 * real processes in a temporary folder, with the host's ports recorded so a
 * test can see exactly when a job settled and what History said.
 */

interface Harness {
  root: string;
  folder: string;
  store: WorkFoldJobStore;
  service: WorkFoldJobService;
  settled: WorkFoldJobRecord[];
  captured: string[];
}

async function harness(
  t: { after: (fn: () => unknown) => void },
  options: { runningLimit?: number; segmentBytes?: number; stopGraceMs?: number; ports?: Partial<WorkFoldJobServicePorts> } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-jobs-"));
  const folder = await realpath(await mkdtemp(join(tmpdir(), "work-fold-jobs-folder-")));
  const store = await WorkFoldJobStore.open({ rootPath: join(root, "jobs") });
  const settled: WorkFoldJobRecord[] = [];
  const captured: string[] = [];
  const service = new WorkFoldJobService({
    store,
    ...(options.runningLimit ? { runningLimit: options.runningLimit } : {}),
    ...(options.segmentBytes ? { segmentBytes: options.segmentBytes } : {}),
    stopGraceMs: options.stopGraceMs ?? 1_000,
    ports: {
      captureHistory: async (job) => {
        captured.push(job.jobId);
        return { status: "captured", checkpointId: "cp-test", fileCount: 3, skippedFileCount: 0, skippedByReason: {} };
      },
      afterSettle: (job) => { settled.push(job); },
      ...options.ports,
    },
  });
  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
    await rm(folder, { recursive: true, force: true });
  });
  return { root, folder, store, service, settled, captured };
}

function start(h: Harness, command: string, extra: { timeoutSeconds?: number; name?: string } = {}) {
  return h.service.start({
    owner: { workFolderId: "wf-1", workFolderName: "Site", conversationId: "chat-1" },
    taskId: "turn-1",
    requestId: "req-20261018000000-aaaaaaaa",
    command,
    cwd: h.folder,
    surface: "tool",
    ...extra,
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the read bounds are Pi's own bash bounds", () => {
  assert.equal(workFoldBackgroundJobLimits.readMaxLines, DEFAULT_MAX_LINES);
  assert.equal(workFoldBackgroundJobLimits.readMaxBytes, DEFAULT_MAX_BYTES);
});

test("a job runs in its folder, records its exit, captures History, and settles once", async (t) => {
  const h = await harness(t);
  const job = await start(h, "pwd; echo \"id=$WORKFOLD_JOB_ID\"; echo to-stderr >&2; exit 3", { name: "Quick one" });
  assert.match(job.jobId, /^job-\d{14}-[0-9a-f]{8}$/);
  assert.equal(job.name, "Quick one");
  const waited = await h.service.wait(job.jobId, { seconds: 10 });
  assert.equal(waited.outcome, "ended");
  const ended = waited.job;
  assert.equal(ended.state, "exited");
  assert.equal(ended.exitCode, 3);
  assert.ok(ended.settledAt);
  assert.deepEqual(ended.history, { status: "captured", checkpointId: "cp-test", fileCount: 3, skippedFileCount: 0, skippedByReason: {} });
  assert.deepEqual(h.captured, [job.jobId]);
  assert.equal(h.settled.length, 1);
  const { output } = await h.service.read(job.jobId);
  assert.match(output.text, new RegExp(`^${h.folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.match(output.text, new RegExp(`id=${job.jobId}`));
  assert.match(output.text, /to-stderr/);
  assert.equal(output.totalLines, 3);
  assert.match(describeJobState(ended, new Date()), /^exited with code 3 after/);
  // The journal is the record: a fresh store reads the same settled job.
  const reopened = await WorkFoldJobStore.open({ rootPath: h.store.rootPath });
  assert.equal(reopened.get(job.jobId)?.state, "exited");
});

test("until returns as soon as a line matches, and stop ends the whole process group", async (t) => {
  const h = await harness(t);
  const pidFile = join(h.folder, "grandchild.pid");
  const job = await start(h, `echo starting; sleep 0.2; echo "server ready on 4000"; sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`);
  const matched = await h.service.wait(job.jobId, { seconds: 10, until: /ready on \d+/ });
  assert.equal(matched.outcome, "matched");
  assert.equal(matched.outcome === "matched" && matched.text, "server ready on 4000");
  assert.equal(matched.outcome === "matched" && matched.line, 2);
  // A second wait over output already written matches from disk.
  const again = await h.service.wait(job.jobId, { seconds: 1, until: /starting/ });
  assert.equal(again.outcome, "matched");
  let grandchild = 0;
  for (let attempt = 0; attempt < 50 && !grandchild; attempt += 1) {
    grandchild = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(grandchild && alive(grandchild));
  const stopped = await h.service.stop(job.jobId, "agent");
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stoppedBy, "agent");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(grandchild), false);
  assert.equal(h.settled.length, 1);
});

test("a wait without a pattern times out while the job keeps running", async (t) => {
  const h = await harness(t);
  const job = await start(h, "sleep 30");
  const waited = await h.service.wait(job.jobId, { seconds: 0.2 });
  assert.equal(waited.outcome, "timed_out");
  assert.equal(waited.job.state, "running");
  const controller = new AbortController();
  const aborted = h.service.wait(job.jobId, { seconds: 30, signal: controller.signal });
  controller.abort();
  assert.equal((await aborted).outcome, "aborted");
});

test("a timeout stops the job and says so", async (t) => {
  const h = await harness(t);
  const job = await start(h, "sleep 30", { timeoutSeconds: 0.3 });
  const waited = await h.service.wait(job.jobId, { seconds: 10 });
  assert.equal(waited.job.state, "timed_out");
  assert.equal(waited.job.stoppedBy, "timeout");
  assert.match(describeJobState(waited.job, new Date()), /stopped by its timeout/);
});

test("reads page by line and keep the end within Pi's bounds", async (t) => {
  const h = await harness(t);
  const job = await start(h, "seq 1 5000");
  await h.service.wait(job.jobId, { seconds: 10 });
  const tail = await h.service.read(job.jobId);
  assert.equal(tail.output.totalLines, 5000);
  assert.equal(tail.output.toLine, 5000);
  assert.equal(tail.output.fromLine, 3001);
  assert.equal(tail.output.text.split("\n").at(-1), "5000");
  assert.equal(tail.output.truncated, true);
  const page = await h.service.read(job.jobId, { offset: 10, limit: 5 });
  assert.equal(page.output.text, "10\n11\n12\n13\n14");
  assert.equal(page.output.fromLine, 10);
  assert.equal(page.output.nextOffset, 15);
  const beyond = await h.service.read(job.jobId, { offset: 6000 });
  assert.equal(beyond.output.text, "");
});

test("output past a segment drops the oldest segment and counts what it dropped", async (t) => {
  const h = await harness(t, { segmentBytes: 1_000 });
  const job = await start(h, "for i in $(seq 1 2000); do echo \"line $i\"; done");
  const ended = (await h.service.wait(job.jobId, { seconds: 10 })).job;
  // How much is dropped depends on how the pipe chunks the output; the
  // writer test below pins the exact counts.
  assert.equal(ended.output.lines, 2000);
  const tail = await h.service.read(job.jobId);
  assert.equal(tail.output.text.split("\n").at(-1), "line 2000");
  const first = await h.service.read(job.jobId, { offset: 1, limit: 1 });
  assert.equal(first.output.fromLine, ended.output.droppedLines + 1);
  assert.equal(first.output.text, `line ${ended.output.droppedLines + 1}`);
});

test("a segment never ends inside a line, however the pipe splits the output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-job-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = new JobOutputWriter(directory, { segmentBytes: 16 });
  for (const chunk of ["alpha 1\nalpha 2\nal", "pha 3\nalpha 4\nalpha 5", "\nalpha 6\nalpha 7\n"]) writer.write(Buffer.from(chunk));
  writer.close();
  const counters = writer.counters;
  assert.equal(counters.lines, 7);
  assert.equal(counters.bytes, 56);
  // Two rotations, each finishing its line first; a third segment began, so
  // the first ("alpha 1" to "alpha 3", 24 bytes) was dropped.
  assert.deepEqual([counters.droppedLines, counters.droppedBytes], [3, 24]);
  const page = await readJobOutputPage(directory, counters, { offset: 1 });
  assert.equal(page.fromLine, counters.droppedLines + 1);
  assert.equal(page.text.split("\n")[0], `alpha ${counters.droppedLines + 1}`);
  assert.equal(page.text.split("\n").at(-1), "alpha 7");
});

test("the running bound refuses a start and names its number", async (t) => {
  const h = await harness(t, { runningLimit: 1 });
  await start(h, "sleep 30");
  await assert.rejects(start(h, "sleep 30"), (error: unknown) =>
    error instanceof WorkFoldJobLimitError && /1 background jobs are already running/.test(error.message) && /Settings → Automations → Limits/.test(error.message));
});

test("a missing folder is refused before anything is recorded; a shell that cannot start is recorded failed", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.service.start({
    owner: { conversationId: "chat-1" }, taskId: "turn-1", requestId: "req-20261018000000-aaaaaaaa",
    command: "true", cwd: join(h.folder, "missing"), surface: "cli",
  }), /does not exist/);
  assert.equal(h.store.list().length, 0);
  const failed = await h.service.start({
    owner: { conversationId: "chat-1" }, taskId: "turn-1", requestId: "req-20261018000000-aaaaaaaa",
    command: "true", cwd: h.folder, surface: "cli", shell: { shellPath: join(h.folder, "no-such-shell") },
  });
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /shell path not found/i);
  assert.equal(h.settled.length, 1);
});

test("a host refusal before spawn records the job failed and runs nothing", async (t) => {
  const marker = join(tmpdir(), `work-fold-job-refused-${process.pid}-${Date.now()}`);
  const h = await harness(t, { ports: { beforeSpawn: async () => { throw new Error("This request was stopped."); } } });
  const job = await start(h, `touch ${JSON.stringify(marker)}`);
  assert.equal(job.state, "failed");
  assert.equal(job.error, "This request was stopped.");
  await assert.rejects(readFile(marker));
});

test("the work-fold agent's jobs say History does not apply to them", async (t) => {
  const h = await harness(t);
  const job = await h.service.start({
    owner: { conversationId: "agent-chat" }, taskId: "turn-a", requestId: "req-20261018000000-bbbbbbbb",
    command: "echo hi", cwd: h.folder, surface: "tool",
  });
  const ended = (await h.service.wait(job.jobId, { seconds: 10 })).job;
  assert.equal(ended.history?.status, "not_applicable");
  assert.deepEqual(h.captured, []);
});

test("quitting interrupts running jobs without a History capture", async (t) => {
  const h = await harness(t);
  const job = await start(h, "sleep 30");
  await h.service.close();
  const record = h.store.get(job.jobId)!;
  assert.equal(record.state, "interrupted");
  assert.equal(record.stoppedBy, "quit");
  assert.equal(record.history?.status, "unavailable");
  assert.deepEqual(h.captured, []);
  await assert.rejects(start(h, "true"), /closing/);
});

test("a restart records a running job interrupted and kills it only when it is provably the same process", async (t) => {
  const h = await harness(t);
  const job = await start(h, "sleep 30");
  const running = h.store.get(job.jobId)!;
  assert.ok(running.pid && running.processStartedAt);
  // A second store over the same journal stands in for the next app run.
  const next = await WorkFoldJobStore.open({ rootPath: h.store.rootPath });
  const interrupted = await next.reconcile("work-fold closed before this job finished.");
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0]!.state, "interrupted");
  // A reused process id (different start time) is left alone.
  assert.equal(await reapOrphanedJobProcesses([{ ...interrupted[0]!, processStartedAt: "Thu Jan  1 00:00:00 1970" }]), 0);
  assert.equal(alive(running.pid!), true);
  assert.equal(await reapOrphanedJobProcesses(interrupted), 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(running.pid!), false);
  // Reconciling again settles nothing: a job is never re-run.
  const again = await WorkFoldJobStore.open({ rootPath: h.store.rootPath });
  assert.equal((await again.reconcile("again")).filter((record) => record.jobId === job.jobId && record.state !== "interrupted").length, 0);
});

test("a job's end is delivered once", async (t) => {
  const h = await harness(t);
  const job = await start(h, "true");
  await h.service.wait(job.jobId, { seconds: 10 });
  const first = await h.service.markDelivered(job.jobId, "read", "turn-1");
  assert.equal(first?.delivery?.by, "read");
  const second = await h.service.markDelivered(job.jobId, "follow_up", "turn-2");
  assert.equal(second?.delivery?.by, "read");
  assert.equal(second?.delivery?.taskId, "turn-1");
});

test("retention removes a settled job and its output after the window", async (t) => {
  const h = await harness(t);
  const job = await start(h, "echo kept");
  await h.service.wait(job.jobId, { seconds: 10 });
  await writeFile(join(h.store.outputDirectory(job.jobId), "marker"), "x");
  assert.deepEqual(await h.store.purgeExpired(new Date()), { purged: 0 });
  assert.deepEqual(await h.store.purgeExpired(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)), { purged: 1 });
  assert.equal(h.store.get(job.jobId), null);
  await assert.rejects(readFile(join(h.store.outputDirectory(job.jobId), "marker")));
});

test("what a model reads drops escape sequences and progress rewrites but keeps every line", () => {
  assert.equal(sanitizeJobOutput("\u001b[32mgreen\u001b[0m\r\n10%\r50%\r100%\ndone\u0007"), "green\n100%\ndone");
  assert.equal(sanitizeJobOutput("a\n\nb").split("\n").length, 3);
});
