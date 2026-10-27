import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { piStreamStallMs, streamWithStallWatchdog } from "../src/local/agent/stream-stall-watchdog.js";
import { startLocalApi } from "../src/local/server.js";

const model = { id: "chat", api: "faux", provider: "fixture-stall" } as unknown as Model<Api>;

function partial(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("the stall setting defaults to three minutes and 0 turns it off", () => {
  assert.equal(piStreamStallMs({}), 180_000);
  assert.equal(piStreamStallMs({ WORKFOLD_PI_STREAM_STALL_MS: "0" }), 0);
  assert.equal(piStreamStallMs({ WORKFOLD_PI_STREAM_STALL_MS: "90000" }), 90_000);
  assert.equal(piStreamStallMs({ WORKFOLD_PI_STREAM_STALL_MS: "soon" }), 180_000);
});

test("a silent response ends as a retryable timeout that keeps its partial text and aborts the request", async () => {
  let upstreamSignal: AbortSignal | undefined;
  const stream = await streamWithStallWatchdog(model, undefined, 40, (signal) => {
    upstreamSignal = signal;
    const upstream = createAssistantMessageEventStream();
    upstream.push({ type: "start", partial: partial("") });
    upstream.push({ type: "text_delta", contentIndex: 0, delta: "Half an ans", partial: partial("Half an ans") });
    return upstream;
  });
  const events = await collect(stream);
  const last = events.at(-1)!;
  assert.equal(last.type, "error");
  const error = (last as Extract<AssistantMessageEvent, { type: "error" }>).error;
  assert.equal(error.stopReason, "error");
  assert.match(error.errorMessage!, /stream timeout/);
  assert.deepEqual(error.content, [{ type: "text", text: "Half an ans" }]);
  assert.equal(isRetryableAssistantError(error), true, "Pi's own retry sends it again");
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal((await stream.result()).stopReason, "error");
});

test("a response that keeps producing is never cut off, however long it runs", async () => {
  const stream = await streamWithStallWatchdog(model, undefined, 60, () => {
    const upstream = createAssistantMessageEventStream();
    upstream.push({ type: "start", partial: partial("") });
    let sent = 0;
    const tick = setInterval(() => {
      sent += 1;
      if (sent < 6) upstream.push({ type: "text_delta", contentIndex: 0, delta: ".", partial: partial(".".repeat(sent)) });
      else {
        clearInterval(tick);
        upstream.push({ type: "done", reason: "stop", message: partial(".....") });
      }
    }, 30);
    return upstream;
  });
  const events = await collect(stream);
  assert.equal(events.at(-1)!.type, "done");
  assert.equal(events.length, 7);
});

test("the caller's own abort is never reported as a stall", async () => {
  const caller = new AbortController();
  const stream = await streamWithStallWatchdog(model, caller.signal, 40, (signal) => {
    const upstream = createAssistantMessageEventStream();
    upstream.push({ type: "start", partial: partial("") });
    signal?.addEventListener("abort", () => upstream.push({ type: "error", reason: "aborted", error: { ...partial(""), stopReason: "aborted" } }));
    return upstream;
  });
  setTimeout(() => caller.abort(), 10);
  const events = await collect(stream);
  const last = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
  assert.equal(last.reason, "aborted");
  assert.doesNotMatch(last.error.errorMessage ?? "", /stream timeout/);
});

test("a real turn whose first response goes silent is sent again and finishes", { timeout: 60_000 }, async (t) => {
  const previous = process.env.WORKFOLD_PI_STREAM_STALL_MS;
  process.env.WORKFOLD_PI_STREAM_STALL_MS = "300";
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-stream-stall-"));
  const faux = fauxProvider({ provider: "fixture-stall", models: [{ id: "chat" }] });
  let calls = 0;
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  runtime.registerNativeProvider({ ...faux.provider, streamSimple(requestModel, context, options) {
    calls += 1;
    if (calls === 1) {
      // Starts, then goes silent: the stall the evals saw.
      const silent = createAssistantMessageEventStream();
      silent.push({ type: "start", partial: { ...partial(""), api: requestModel.api, provider: requestModel.provider, model: requestModel.id } });
      return silent;
    }
    return faux.provider.streamSimple(requestModel, context, options);
  } });
  faux.setResponses([fauxAssistantMessage("Done after a resend.")]);
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      resolveRuntime: async () => ({
        agentDir: join(sandbox, "pi"),
        modelRuntime: runtime,
        preferredModel: { provider: "fixture-stall", id: "chat" },
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 } }),
      }),
    },
  });
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFOLD_PI_STREAM_STALL_MS;
    else process.env.WORKFOLD_PI_STREAM_STALL_MS = previous;
    await api.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Stall" });
  const sent = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Say something." });
  const deadline = Date.now() + 20_000;
  let state = "running";
  while (state === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = (await api.actFacade.turnStatus({ workFolder: workFolder.id, taskId: sent.taskId })).task.state;
  }
  assert.equal(state, "succeeded");
  assert.ok(calls >= 2, "the silent response was sent again");
  const transcript = await (await fetch(new URL(`/api/work-folders/${workFolder.id}/conversations/${sent.conversationId}`, api.origin))).json() as { messages: Array<{ role: string; content: string }> };
  assert.equal(transcript.messages.filter((message) => message.role === "assistant").at(-1)?.content, "Done after a resend.");
});
