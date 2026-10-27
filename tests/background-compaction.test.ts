import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessageEventStream,
  type Message,
} from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * An idle Chat close to Pi's own compaction point is summarized in the
 * background (2026-10-27): as its own kernel compaction task, and never at the
 * person's expense — a message sent meanwhile cancels the summary and runs.
 */

const contextWindow = 100_000;

interface Harness {
  api: LocalApiHandle;
  /** Every Chat-turn request the model received. */
  turns: Message[][];
  summaries: number;
  /** The next replies report this much context, like a long Chat would. */
  reportContext: number | null;
  /** When set, a summary request hangs until it is cancelled. */
  holdSummaries: boolean;
  aborted: number;
  compactionTaskActors: Array<{ kind: string; conversationId?: string }>;
  setResponses: (steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) => void;
}

async function startHarness(t: { after: (fn: () => unknown) => void }): Promise<Harness> {
  const previous = process.env.WORKFOLD_PI_BACKGROUND_COMPACTION_IDLE_MS;
  process.env.WORKFOLD_PI_BACKGROUND_COMPACTION_IDLE_MS = "50";
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-background-compaction-"));
  const faux = fauxProvider({ provider: "fixture-compact", models: [{ id: "chat", contextWindow }] });
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  const harness = { turns: [], summaries: 0, reportContext: null, holdSummaries: false, aborted: 0, compactionTaskActors: [], setResponses: faux.setResponses } as unknown as Harness;
  runtime.registerNativeProvider({ ...faux.provider, async streamSimple(model, context, options) {
    const text = JSON.stringify(context);
    if (text.includes("context summarization assistant")) {
      harness.summaries += 1;
      const stream = createAssistantMessageEventStream();
      const answer = { ...fauxAssistantMessage("## Goal\nSUMMARY-MARKER"), api: model.api, provider: model.provider, model: model.id };
      if (harness.holdSummaries) {
        options?.signal?.addEventListener("abort", () => {
          harness.aborted += 1;
          stream.push({ type: "error", reason: "aborted", error: { ...answer, content: [], stopReason: "aborted" } });
        });
      } else {
        setTimeout(() => stream.push({ type: "done", reason: "stop", message: answer }), 0);
      }
      return stream;
    }
    if (!text.includes("word title for this conversation")) harness.turns.push(structuredClone(context.messages));
    const upstream = await faux.provider.streamSimple(model, context, options) as AssistantMessageEventStream;
    if (harness.reportContext === null) return upstream;
    const reported = harness.reportContext;
    const out = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of upstream) {
        if (event.type === "done") event.message.usage = { ...event.message.usage, input: reported, cacheRead: 0, cacheWrite: 0, totalTokens: reported };
        out.push(event);
      }
    })();
    return out;
  } });
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      resolveRuntime: async () => ({
        agentDir: join(sandbox, "pi"),
        modelRuntime: runtime,
        preferredModel: { provider: "fixture-compact", id: "chat" },
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } }),
      }),
    },
  });
  harness.api = api;
  const startTask = api.kernel.startTask.bind(api.kernel);
  api.kernel.startTask = (input) => {
    if (input.kind === "compaction") harness.compactionTaskActors.push({ kind: input.actor.kind, conversationId: input.conversationId });
    return startTask(input);
  };
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFOLD_PI_BACKGROUND_COMPACTION_IDLE_MS;
    else process.env.WORKFOLD_PI_BACKGROUND_COMPACTION_IDLE_MS = previous;
    await api.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return harness;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function compactionTasks(h: Harness) {
  return (await h.api.kernel.getTasks({ kind: "system" })).tasks.filter((task) => task.kind === "compaction");
}

async function settled(h: Harness, workFolderId: string, taskId: string): Promise<string> {
  let state = "running";
  await waitFor(async () => {
    state = (await h.api.actFacade.turnStatus({ workFolder: workFolderId, taskId })).task.state;
    return state !== "running";
  }, `turn ${taskId}`);
  return state;
}

test("an idle Chat near Pi's compaction point is summarized in the background as its own task", { timeout: 60_000 }, async (t) => {
  const h = await startHarness(t);
  h.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Title"), fauxAssistantMessage("Second reply.")]);
  const { workFolder } = await h.api.actFacade.createWorkFolder({ name: "Long Chat" });
  const first = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Start a long piece of work." });
  assert.equal(await settled(h, workFolder.id, first.taskId), "succeeded");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(h.summaries, 0, "a Chat with room left is not summarized");

  // The second reply reports a context past 80% of Pi's own compaction point
  // (100k window − 16k reserve), but short of it, so Pi does not compact mid-turn.
  h.reportContext = 75_000;
  const second = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: first.conversationId, content: "Keep going." });
  assert.equal(await settled(h, workFolder.id, second.taskId), "succeeded");
  h.reportContext = null;
  h.setResponses([fauxAssistantMessage("Third reply.")]);
  await waitFor(() => h.summaries >= 1, "the background summary");
  await waitFor(async () => !(await compactionTasks(h)).length, "the compaction task to finish");
  assert.deepEqual(h.compactionTaskActors, [{ kind: "system", conversationId: first.conversationId }], "recorded as its own kernel compaction task");
  const summaryRequests = h.summaries;

  const third = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: first.conversationId, content: "And the last step." });
  assert.equal(await settled(h, workFolder.id, third.taskId), "succeeded");
  assert.match(JSON.stringify(h.turns.at(-1)), /SUMMARY-MARKER/, "the next turn starts from the summary, without waiting on one");
  assert.equal(h.summaries, summaryRequests, "no further summary mid-turn");
});

test("a message sent during a background summary cancels it and runs at once", { timeout: 60_000 }, async (t) => {
  const h = await startHarness(t);
  h.setResponses([fauxAssistantMessage("First reply."), fauxAssistantMessage("Title")]);
  const { workFolder } = await h.api.actFacade.createWorkFolder({ name: "Busy Chat" });
  h.reportContext = 75_000;
  const first = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Start." });
  assert.equal(await settled(h, workFolder.id, first.taskId), "succeeded");
  h.reportContext = null;
  // Send a short follow-up while the summary is still running.
  h.holdSummaries = true;
  h.setResponses([fauxAssistantMessage("Answered right away.")]);
  // Wait for the hold, the follow-up, and the reply. Pi may still compact mid-turn if it must, so that answer stays free.
  await waitFor(() => h.summaries >= 1, "the background summary to start");
  const followUp = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: first.conversationId, content: "Quick question." });
  assert.ok(h.aborted >= 1, "the summary was cancelled for the person's message");
  assert.equal(await settled(h, workFolder.id, followUp.taskId), "succeeded");
  assert.equal((await compactionTasks(h)).length, 0);
});
