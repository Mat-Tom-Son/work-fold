import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { readConversation } from "../src/local/agent/chat-store.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { startLocalApi, type LocalApiOptions } from "../src/local/server.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";

test("closing stops an accepted turn that is still preparing before it reaches the provider", async (t) => {
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  let preparing!: () => void;
  const reachedPreparation = new Promise<void>((resolve) => { preparing = resolve; });
  const h = await fixture(t, { async beforeAgentPrompt() { preparing(); await resumed; } });
  const { taskId } = await h.send();
  await reachedPreparation;
  const runtimeRequests = h.runtimeRequests();
  const closing = h.close();
  // close() stops accepting turns before its first await, so the turn resumes
  // preparing after closing began, whenever close() reaches its clients.
  resume();
  await within(closing, "close()");
  // Quitting is recorded like a crash, never as a Stop the person asked for (2026-10-27).
  assert.equal(h.turnStore.get(taskId)?.status, "interrupted");
  const reply = (await readConversation(h.workFolderRoot, h.conversationId)).findLast((message) => message.role === "assistant");
  assert.equal(reply?.turnId, taskId);
  assert.equal(reply?.interruption?.reason, "app_interrupted");
  assert.equal(h.runtimeRequests(), runtimeRequests, "the turn never started its prompt, which resolves its runtime first");
  assert.equal(h.providerRequests(), 0);
});

test("closing waits for an acceptance already in flight and stops its turn before it prompts", async (t) => {
  const h = await fixture(t);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let accepting!: (turnId: string) => void;
  const held = new Promise<string>((resolve) => { accepting = resolve; });
  // Hold the acceptance after its message is durable but before its turn is
  // dispatched into the set close() drains.
  const markRunning = h.turnStore.markRunning.bind(h.turnStore);
  h.turnStore.markRunning = async (turnId) => { accepting(turnId); await released; return markRunning(turnId); };
  const sending = h.send();
  const taskId = await held;
  const runtimeRequests = h.runtimeRequests();
  const closing = h.close();
  // A close() that did not wait for the acceptance would resolve first, with
  // this turn not yet started; one that waits is released shortly instead.
  void closing.then(release, release);
  const fallback = setTimeout(release, 250);
  try {
    await within(closing, "close()");
  } finally {
    clearTimeout(fallback);
  }
  assert.equal(h.turnStore.get(taskId)?.status, "interrupted", "close() resolves only after the turn it was accepting has settled");
  assert.equal((await sending).taskId, taskId);
  assert.equal(h.runtimeRequests(), runtimeRequests);
  assert.equal(h.providerRequests(), 0);
});

async function fixture(t: TestContext, options: Pick<LocalApiOptions, "beforeAgentPrompt"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-close-turns-"));
  // The provider never answers: a turn that reaches it would hold close() open.
  let providerRequests = 0;
  const provider = createServer((request, response) => {
    providerRequests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const credentials = FileCredentialStore.inMemory({ fixture: { type: "api_key", key: "synthetic" } });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  modelRuntime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiKey: "synthetic",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off" });
  const runtimeRoots: string[] = [];
  const stateRoot = join(root, "state");
  const turnStore = await WorkFoldTurnStore.create({ stateRoot });
  const api = await startLocalApi({
    port: 0, stateBase: stateRoot, workFolderBase: join(root, "content"), loadEnv: false, turnStore, ...options,
    piRuntimeProvider: { async resolveRuntime(workFolderRoot) {
      runtimeRoots.push(workFolderRoot);
      return { agentDir, credentials, modelRuntime, settingsManager };
    } },
  });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= api.close();
  t.after(async () => {
    try {
      await within(close(), "close()");
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      configureWorkFoldStateRoot(undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Close fixture" });
  const { conversation } = await api.actFacade.createConversation({ workFolder: workFolder.id });
  return {
    turnStore,
    close,
    workFolderRoot: workFolder.workFolderRoot,
    conversationId: conversation.id,
    send: () => api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: conversation.id, content: "Start working." }),
    runtimeRequests: () => runtimeRoots.filter((candidate) => candidate === workFolder.workFolderRoot).length,
    providerRequests: () => providerRequests,
  };
}

async function within<T>(work: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs} ms.`)), timeoutMs);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
