import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { listWorkFolderCheckpoints } from "../src/local/history.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Background jobs end to end (docs/background-jobs.md, F31–F33): a real turn
 * on a scripted provider calls job_start, its turn ends while the command
 * runs, and the command's end comes back to the same Chat exactly once —
 * through the F28 follow-up, through a read in the turn, or through the next
 * turn's context. Stop, deletion, and quitting are driven through the same
 * local API the desktop uses.
 */

interface Journey {
  sandbox: string;
  api: LocalApiHandle;
  /** Every provider request, as the model received it. */
  requests: Message[][];
  script(steps: FauxResponseStep[]): void;
  reopen(): Promise<void>;
  close(): Promise<void>;
}

async function startJourney(t: { after: (fn: () => unknown) => void }): Promise<Journey> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-jobs-journey-"));
  const faux = fauxProvider({ provider: "fixture-jobs", models: [{ id: "chat" }] });
  const requests: Message[][] = [];
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  runtime.registerNativeProvider({ ...faux.provider, streamSimple(model, context, options) {
    requests.push(structuredClone(context.messages));
    return faux.provider.streamSimple(model, context, options);
  } });
  const open = () => startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      resolveRuntime: async () => ({
        agentDir: join(sandbox, "pi"),
        modelRuntime: runtime,
        preferredModel: { provider: "fixture-jobs", id: "chat" },
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      }),
    },
  });
  let api = await open();
  let closed = false;
  const journey: Journey = {
    sandbox,
    get api() { return api; },
    requests,
    script: (steps) => faux.setResponses(steps),
    reopen: async () => {
      await api.close();
      api = await open();
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await api.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
  t.after(() => journey.close());
  return journey;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function transcript(api: LocalApiHandle, workFolderId: string, conversationId: string): Promise<Array<{ role: string; content: string; kind?: string }>> {
  const response = await fetch(new URL(`/api/work-folders/${workFolderId}/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; kind?: string }> }).messages;
}

async function work(api: LocalApiHandle, workFolderId: string, conversationId: string): Promise<{ state: string; label: string; detail: string | null; canStop: boolean; requestId: string } | null> {
  const response = await fetch(new URL(`/api/work-folders/${workFolderId}/conversations/${conversationId}/work`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { work: { state: string; label: string; detail: string | null; canStop: boolean; requestId: string } | null }).work;
}

async function startTurn(j: Journey, content: string) {
  const { workFolder } = await j.api.actFacade.createWorkFolder({ name: `Site ${Math.random().toString(16).slice(2, 8)}` });
  const sent = await j.api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content });
  return { workFolder, ...sent };
}

async function turnSettled(j: Journey, workFolderId: string, taskId: string): Promise<void> {
  await waitFor(async () => (await j.api.actFacade.turnStatus({ workFolder: workFolderId, taskId })).task.state !== "running", `turn ${taskId} to settle`);
}

function userTexts(messages: Message[]): string {
  return JSON.stringify(messages.filter((message) => message.role === "user"));
}

test("a job that outlives its turn wakes its Chat once with its exit, History, and output", async (t) => {
  const j = await startJourney(t);
  let followUp: Message[] | null = null;
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", {
      command: "sleep 0.8; echo build ok; echo built > out.txt; exit 0",
      name: "Build the site",
      wait: 0,
    })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Started the build; I will report when it finishes."),
    // The Chat's one title request.
    fauxAssistantMessage("Build the site"),
    (context) => {
      followUp = structuredClone(context.messages);
      return fauxAssistantMessage("The build finished: build ok.");
    },
  ]);
  const { workFolder, conversationId, taskId } = await startTurn(j, "Build the site.");
  await turnSettled(j, workFolder.id, taskId);

  // The turn ended; the job did not. The request is still working on it.
  const running = j.api.requests.byTaskId(taskId)!;
  assert.equal(running.state, "working");
  assert.equal(running.jobs?.length, 1);
  const jobId = running.jobs![0]!.jobId;
  assert.equal(j.api.jobs.get(jobId)?.state, "running");
  assert.equal(j.api.jobs.get(jobId)?.cwd, workFolder.workFolderRoot);
  const line = await work(j.api, workFolder.id, conversationId);
  assert.equal(line?.label, "Running in the background");
  assert.match(line?.detail ?? "", /Build the site/);
  assert.equal(line?.canStop, true);
  assert.equal(running.actions.some((action) => action.command === "jobs.start"), true);

  await waitFor(() => j.api.requests.byTaskId(taskId)?.state === "done", "the follow-up turn to finish the request");
  const settled = j.api.requests.byTaskId(taskId)!;
  assert.equal(settled.turns.length, 2, "exactly one follow-up turn");
  assert.equal(settled.turns[1]!.role, "continuation");
  assert.deepEqual(settled.deliveredJobIds, [jobId]);
  const job = j.api.jobs.get(jobId)!;
  assert.equal(job.state, "exited");
  assert.equal(job.exitCode, 0);
  assert.equal(job.delivery?.by, "follow_up");
  assert.equal(job.delivery?.taskId, settled.turns[1]!.taskId);
  assert.equal(job.history?.status, "captured");

  const wake = userTexts(followUp!);
  assert.match(wake, /a background job this Chat started has finished/);
  assert.match(wake, /exited with code 0/);
  assert.match(wake, /build ok/);
  assert.match(wake, /History: checkpoint /);
  assert.match(wake, /Nobody typed this message/);

  // History covers what the job wrote after its turn's own checkpoint.
  const checkpoints = await listWorkFolderCheckpoints(workFolder.workFolderRoot);
  const after = checkpoints.find((checkpoint) => checkpoint.label === "After background job: Build the site");
  assert.ok(after, "a checkpoint after the job ended");
  assert.ok(after.files.some((file) => file.path === "out.txt"));
  assert.equal(job.history?.status === "captured" && job.history.checkpointId, after.checkpointId);
  assert.equal(await readFile(join(workFolder.workFolderRoot, "out.txt"), "utf8"), "built\n");

  // The Chat holds one quiet host continuation carrying what was released.
  const continuations = (await transcript(j.api, workFolder.id, conversationId)).filter((message) => message.kind === "assistant_continuation");
  assert.equal(continuations.length, 1);
  assert.match(continuations[0]!.content, /build ok/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(j.api.requests.byTaskId(taskId)!.turns.length, 2, "no second follow-up");
});

test("reading a finished job inside its turn delivers it, so no follow-up starts", async (t) => {
  const j = await startJourney(t);
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", { command: "echo quick", wait: 10 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("It printed quick."),
  ]);
  const { workFolder, taskId } = await startTurn(j, "Run the quick one.");
  await turnSettled(j, workFolder.id, taskId);
  const record = j.api.requests.byTaskId(taskId)!;
  const job = j.api.jobs.get(record.jobs![0]!.jobId)!;
  assert.equal(job.state, "exited");
  assert.equal(job.delivery?.by, "read");
  assert.match(JSON.stringify(j.requests.at(-1)), /quick/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(j.api.requests.byTaskId(taskId)!.turns.length, 1);
  assert.equal(j.api.requests.byTaskId(taskId)!.state, "done");
});

test("a finished job reaches the next turn's context when follow-ups are off", async (t) => {
  const j = await startJourney(t);
  await j.api.requests.setContinuationsEnabled(false);
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", { command: "sleep 0.3; echo exported", name: "Export", wait: 0 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Export started."),
  ]);
  const { workFolder, conversationId, taskId } = await startTurn(j, "Export it.");
  await turnSettled(j, workFolder.id, taskId);
  const jobId = j.api.requests.byTaskId(taskId)!.jobs![0]!.jobId;
  await waitFor(() => Boolean(j.api.jobs.get(jobId)?.settledAt), "the job to settle");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(j.api.requests.byTaskId(taskId)!.turns.length, 1, "no follow-up while they are off");

  j.script([fauxAssistantMessage("The export finished.")]);
  const next = await j.api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId, content: "Is it done?" });
  await turnSettled(j, workFolder.id, next.taskId);
  const context = userTexts(j.requests.at(-1)!);
  assert.match(context, /Background jobs in this Chat \(host-owned\)/);
  assert.match(context, new RegExp(`${jobId} \\\\"Export\\\\" — exited with code 0`));
  assert.match(context, /it finished since this Chat's last turn/);
  assert.equal(j.api.jobs.get(jobId)?.delivery?.by, "turn_context");
  assert.equal(j.api.jobs.get(jobId)?.delivery?.taskId, next.taskId);
});

test("Stop ends a running job and its request; deleting the Chat waits until it has", async (t) => {
  const j = await startJourney(t);
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", { command: "sleep 30", name: "Long server", wait: 0 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The server is running."),
  ]);
  const { workFolder, conversationId, taskId } = await startTurn(j, "Start the server.");
  await turnSettled(j, workFolder.id, taskId);
  const record = j.api.requests.byTaskId(taskId)!;
  const jobId = record.jobs![0]!.jobId;
  const pid = j.api.jobs.get(jobId)!.pid!;

  const refused = await fetch(new URL(`/api/work-folders/${workFolder.id}/conversations/${conversationId}`, j.api.origin), { method: "DELETE" });
  assert.equal(refused.status, 409);
  assert.match(await refused.text(), /outstanding work/);

  const stop = await fetch(new URL(`/api/requests/${record.requestId}/stop`, j.api.origin), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(stop.status, 200);
  await waitFor(() => j.api.jobs.get(jobId)?.settledAt !== null, "the job to stop");
  const stopped = j.api.jobs.get(jobId)!;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.stoppedBy, "request");
  assert.throws(() => process.kill(pid, 0));
  assert.equal(j.api.requests.byTaskId(taskId)!.state, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(j.api.requests.byTaskId(taskId)!.turns.length, 1, "a stopped request never wakes");

  const deleted = await fetch(new URL(`/api/work-folders/${workFolder.id}/conversations/${conversationId}`, j.api.origin), { method: "DELETE" });
  assert.equal(deleted.status, 200);
});

test("a whole-work-folder restore waits for a running job", async (t) => {
  const j = await startJourney(t);
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", { command: "sleep 30", name: "Watcher", wait: 0 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Watching."),
  ]);
  const { workFolder, taskId } = await startTurn(j, "Watch it.");
  await turnSettled(j, workFolder.id, taskId);
  const [checkpoint] = await listWorkFolderCheckpoints(workFolder.workFolderRoot);
  await assert.rejects(j.api.actFacade.historyRestore({ workFolder: workFolder.id, checkpointId: checkpoint!.checkpointId }),
    /Stop or wait for the background job "Watcher"/);
  await j.api.jobs.stop(j.api.requests.byTaskId(taskId)!.jobs![0]!.jobId, "cli");
});

test("quitting interrupts a running job; after a restart it is recorded failed and never wakes", async (t) => {
  const j = await startJourney(t);
  j.script([
    fauxAssistantMessage([fauxToolCall("job_start", { command: "sleep 30", name: "Overnight export", wait: 0 })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Exporting."),
  ]);
  const { workFolder, conversationId, taskId } = await startTurn(j, "Export overnight.");
  await turnSettled(j, workFolder.id, taskId);
  const jobId = j.api.requests.byTaskId(taskId)!.jobs![0]!.jobId;
  const pid = j.api.jobs.get(jobId)!.pid!;
  await j.reopen();
  assert.throws(() => process.kill(pid, 0), "quitting stopped the process group");
  const job = j.api.jobs.get(jobId)!;
  assert.equal(job.state, "interrupted");
  assert.equal(job.delivery, null);
  const record = j.api.requests.byTaskId(taskId)!;
  assert.equal(record.state, "failed");
  assert.equal(record.turns.length, 1);
  const line = await work(j.api, workFolder.id, conversationId);
  assert.match(line?.detail ?? "", /background job was interrupted/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(j.api.requests.byTaskId(taskId)!.turns.length, 1, "a restart never replays");
});
