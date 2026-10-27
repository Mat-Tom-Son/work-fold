import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import type { WorkFoldRemotePrincipal } from "../src/local/remote-work-fold-agent.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Queue and steer from every window (2026-10-27): a Chat's queued message is
 * held by the app, so every window shows it and it is sent when the turn ends
 * (never after a Stop); and the work-fold agent's running turn takes a
 * steering message from the menu-bar panel and from the paired browser that
 * started it.
 */

interface Harness {
  api: LocalApiHandle;
  /** Chat-turn requests as the model received them. */
  requests: Message[][];
  /** Queue a reply; a held reply waits for `release()`. */
  reply(text: string, options?: { held?: boolean }): void;
  release(): void;
}

async function startHarness(t: { after: (fn: () => unknown) => void }): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-queue-steer-"));
  const faux = fauxProvider({ provider: "fixture-queue", models: [{ id: "chat" }] });
  const runtime = await ModelRuntime.create({ credentials: FileCredentialStore.inMemory(), modelsPath: null });
  const replies: Array<{ text: string; held: boolean }> = [];
  let releaseHeld: (() => void) | null = null;
  const requests: Message[][] = [];
  const respond = async (messages: Message[]): Promise<AssistantMessage> => {
    if (JSON.stringify(messages).includes("word title for this conversation")) return fauxAssistantMessage("Title");
    requests.push(structuredClone(messages));
    const next = replies.shift() ?? { text: "Done.", held: false };
    if (next.held) await new Promise<void>((resolve) => { releaseHeld = resolve; });
    return fauxAssistantMessage(next.text);
  };
  runtime.registerNativeProvider({ ...faux.provider, streamSimple(model, context, options) {
    faux.setResponses([() => respond(context.messages)]);
    return faux.provider.streamSimple(model, context, options);
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
        preferredModel: { provider: "fixture-queue", id: "chat" },
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      }),
    },
  });
  t.after(async () => {
    releaseHeld?.();
    await api.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  return {
    api,
    requests,
    reply: (text, options = {}) => { replies.push({ text, held: options.held === true }); },
    release: () => {
      const release = releaseHeld;
      releaseHeld = null;
      release?.();
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function call(api: LocalApiHandle, path: string, init: { method: string; body?: unknown }): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, api.origin), {
    method: init.method,
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function transcript(api: LocalApiHandle, workFolderId: string, conversationId: string): Promise<Array<{ role: string; content: string; delivery?: string }>> {
  return (await call(api, `/api/work-folders/${workFolderId}/conversations/${conversationId}`, { method: "GET" })).body.messages;
}

test("a queued message is held by the app, replaced as it grows, and sent when the turn ends", { timeout: 60_000 }, async (t) => {
  const h = await startHarness(t);
  h.reply("First answer.", { held: true });
  h.reply("Second answer.");
  const { workFolder } = await h.api.actFacade.createWorkFolder({ name: "Queue" });
  const sent = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Start." });
  await waitFor(() => h.requests.length === 1, "the held turn");
  const queuePath = `/api/work-folders/${workFolder.id}/conversations/${sent.conversationId}/queue`;

  assert.equal((await call(h.api, queuePath, { method: "PUT", body: { content: "Then this." } })).status, 200);
  const grown = await call(h.api, queuePath, { method: "PUT", body: { content: "Then this.\nAnd that." } });
  assert.equal(grown.body.queued.content, "Then this.\nAnd that.", "the window's latest draft replaces the app's copy");

  h.release();
  await waitFor(async () => (await transcript(h.api, workFolder.id, sent.conversationId)).some((message) => message.role === "assistant" && message.content === "Second answer."), "the queued message's turn");
  const messages = await transcript(h.api, workFolder.id, sent.conversationId);
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content), ["Start.", "Then this.\nAnd that."]);
  assert.match(JSON.stringify(h.requests.at(-1)), /Then this\.\\nAnd that\./);

  const idle = await h.api.actFacade.createConversation({ workFolder: workFolder.id });
  const idlePath = `/api/work-folders/${workFolder.id}/conversations/${idle.conversation.id}/queue`;
  assert.equal((await call(h.api, idlePath, { method: "PUT", body: { content: "Now." } })).status, 409, "an idle Chat sends instead");
  assert.deepEqual((await call(h.api, idlePath, { method: "DELETE" })).body, { queued: null }, "an idle Chat holds nothing");
});

test("Stop keeps the queued message for the person instead of sending it", { timeout: 60_000 }, async (t) => {
  const h = await startHarness(t);
  h.reply("Never finished.", { held: true });
  const { workFolder } = await h.api.actFacade.createWorkFolder({ name: "Stopped" });
  const sent = await h.api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Start." });
  await waitFor(() => h.requests.length === 1, "the held turn");
  const queuePath = `/api/work-folders/${workFolder.id}/conversations/${sent.conversationId}/queue`;
  await call(h.api, queuePath, { method: "PUT", body: { content: "Not after a stop." } });

  assert.equal((await call(h.api, `/api/work-folders/${workFolder.id}/conversations/${sent.conversationId}/abort`, { method: "POST" })).status, 200);
  await waitFor(async () => (await h.api.actFacade.turnStatus({ workFolder: workFolder.id, taskId: sent.taskId })).task.state === "aborted", "the stop");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const users = (await transcript(h.api, workFolder.id, sent.conversationId)).filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.content), ["Start."], "nothing was sent after the stop");
  assert.deepEqual((await call(h.api, queuePath, { method: "DELETE" })).body.queued?.content, "Not after a stop.", "Cancel hands it back");
});

test("the work-fold agent's running turn takes a steering message from the panel and from the browser that started it", { timeout: 60_000 }, async (t) => {
  const h = await startHarness(t);
  h.reply("Working on it.", { held: true });
  h.reply("Adjusted.");
  const panel = await call(h.api, "/api/work-fold-agent/messages", { method: "POST", body: { content: "Plan my week.", newConversation: true } });
  assert.equal(panel.status, 202);
  await waitFor(() => h.requests.length === 1, "the held agent turn");

  const steered = await call(h.api, "/api/work-fold-agent/messages", {
    method: "POST",
    body: { content: "Leave Friday free.", delivery: "steer", conversationId: panel.body.conversationId, requestId: "steer-panel-1" },
  });
  assert.equal(steered.status, 202);
  assert.equal(steered.body.delivery, "steer");
  assert.equal((await call(h.api, "/api/work-fold-agent/messages", {
    method: "POST",
    body: { content: "No.", delivery: "steer" },
  })).status, 400, "steering names the running Chat");
  h.release();
  await waitFor(() => h.requests.length === 2, "the steered step");
  assert.match(JSON.stringify(h.requests[1]), /Leave Friday free\./, "the message reached the running turn");

  // A paired browser steers only work it started (the same rule as Stop).
  const owner: WorkFoldRemotePrincipal = { browserId: "browser-owner", grantId: "grant-owner", requestId: "send-1" };
  const stranger: WorkFoldRemotePrincipal = { browserId: "browser-other", grantId: "grant-other", requestId: "steer-x" };
  await waitFor(async () => (await h.api.remoteFacade.execute("management.summary", {}, owner) as { state: string }).state === "idle", "the agent to be idle");
  h.reply("Remote work.", { held: true });
  h.reply("Remote adjusted.");
  const remote = await h.api.remoteFacade.execute("management.send", { content: "Tidy my notes.", newConversation: true }, owner) as { conversationId: string };
  await waitFor(() => h.requests.length === 3, "the browser's held turn");
  await assert.rejects(
    () => h.api.remoteFacade.execute("management.send", { content: "Mine now.", conversationId: remote.conversationId, delivery: "steer" }, stranger),
    /another surface/,
  );
  const fromBrowser = await h.api.remoteFacade.execute("management.send", { content: "Skip the archive.", conversationId: remote.conversationId, delivery: "steer" }, { ...owner, requestId: "steer-1" }) as { delivery: string };
  assert.equal(fromBrowser.delivery, "steer");
  h.release();
  await waitFor(() => h.requests.length === 4, "the browser-steered step");
  assert.match(JSON.stringify(h.requests[3]), /Skip the archive\./);
});
