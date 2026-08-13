import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { startLocalApi } from "../src/local/server.js";

test("renderer turn acceptance is idempotent across retries and app restarts", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-turn-idempotency-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const stateRoot = join(sandbox, "state");
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "reliable.ts"), `export default function (pi) {
    pi.registerCommand("reliable", { description: "Reliable answer", handler: async () => "Reliable answer." });
  }\n`, "utf8");
  const provider = { async resolveRuntime() { return { agentDir }; } };

  const first = await startLocalApi({ port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "content"), loadEnv: false, piRuntimeProvider: provider });
  const created = await json(first.origin, "/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Reliable Space" }),
  }) as { space: { id: string; spaceRoot: string } };
  const conversationCreate = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId: "chat-reliable-client-1" }),
  };
  const conversation = await json(first.origin, `/api/spaces/${created.space.id}/conversations`, conversationCreate) as { conversation: { id: string } };
  const conversationReplay = await json(first.origin, `/api/spaces/${created.space.id}/conversations`, conversationCreate) as { conversation: { id: string } };
  assert.equal(conversation.conversation.id, "chat-reliable-client-1");
  assert.equal(conversationReplay.conversation.id, conversation.conversation.id);
  const messagePath = `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}/messages`;
  const body = {
    content: "/reliable",
    contextPaths: [],
    selectedPath: null,
    requestId: "request-reliable-1",
    userMessageId: "message-reliable-1",
  };
  const accepted = await json(first.origin, messagePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as { taskId: string; message: { id: string }; replayed: boolean };
  assert.equal(accepted.replayed, false);
  const replay = await json(first.origin, messagePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as { taskId: string; message: { id: string }; replayed: boolean };
  assert.equal(replay.replayed, true);
  assert.equal(replay.taskId, accepted.taskId);
  assert.equal(replay.message.id, accepted.message.id);
  await waitForAsync(async () => {
    const transcript = await json(first.origin, `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`) as { messages: Array<{ role: string }> };
    return transcript.messages.filter((message) => message.role === "assistant").length === 1;
  });
  await first.close();

  const restarted = await startLocalApi({ port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "content"), loadEnv: false, piRuntimeProvider: provider });
  try {
    const afterRestart = await json(restarted.origin, messagePath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as { taskId: string; replayed: boolean };
    assert.equal(afterRestart.replayed, true);
    assert.equal(afterRestart.taskId, accepted.taskId);
    const transcript = await json(restarted.origin, `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`) as { messages: Array<{ role: string; requestId?: string }> };
    assert.equal(transcript.messages.filter((message) => message.role === "user" && message.requestId === body.requestId).length, 1);
    assert.equal(transcript.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    await restarted.close();
  }
});

test("startup converts an orphaned running turn into a durable interruption without rerunning it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-turn-recovery-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const stateRoot = join(sandbox, "state");
  const initial = await startLocalApi({ port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "content"), loadEnv: false });
  const created = await json(initial.origin, "/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Recovery Space" }),
  }) as { space: { id: string; spaceRoot: string } };
  const conversation = await json(initial.origin, `/api/spaces/${created.space.id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
  await initial.close();

  const content = "Do not run this twice.";
  const requestId = "request-orphan-1";
  const userMessageId = "message-orphan-1";
  const requestDigest = createHash("sha256").update(JSON.stringify({
    content,
    contextPaths: [],
    selectedPath: null,
    actorKind: "assistant",
    continuedFromManagementTaskId: null,
    managementAttachments: [],
  })).digest("hex");
  const store = await WorkFoldTurnStore.create({ stateRoot });
  const accepted = await store.accept({
    requestId,
    requestDigest,
    userMessageId,
    userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
    spaceId: created.space.id,
    conversationId: conversation.conversation.id,
    actorKind: "assistant",
  });
  await appendMessage(created.space.spaceRoot, conversation.conversation.id, {
    id: userMessageId,
    role: "user",
    content,
    createdAt: "2026-08-13T12:00:00.000Z",
    turnId: accepted.record.turnId,
    requestId,
  });
  await store.markRunning(accepted.record.turnId);
  await store.checkpoint(accepted.record.turnId, "A partial answer saved before the crash.");

  const recovered = await startLocalApi({ port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "content"), loadEnv: false });
  try {
    const transcriptPath = `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`;
    const transcript = await json(recovered.origin, transcriptPath) as { messages: Array<any> };
    const interruption = transcript.messages.find((message) => message.turnId === accepted.record.turnId && message.role === "assistant");
    assert.equal(interruption.content, "A partial answer saved before the crash.");
    assert.equal(interruption.interruption.reason, "app_interrupted");
    assert.match(interruption.interruption.message, /not run again/i);

    const status = await recovered.actFacade.turnStatus({ space: created.space.id, taskId: accepted.record.turnId });
    assert.equal(status.task.state, "failed");
    assert.equal(status.task.messageId, interruption.id);

    const replay = await json(recovered.origin, `${transcriptPath}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, contextPaths: [], selectedPath: null, requestId, userMessageId }),
    }) as { taskId: string; replayed: boolean };
    assert.equal(replay.replayed, true);
    assert.equal(replay.taskId, accepted.record.turnId);
    const afterReplay = await json(recovered.origin, transcriptPath) as { messages: Array<{ role: string; turnId?: string }> };
    assert.equal(afterReplay.messages.filter((message) => message.turnId === accepted.record.turnId).length, 2);
  } finally {
    await recovered.close();
  }
});

test("an explicit retry resumes a durable acceptance that never reached the transcript", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-turn-pre-persist-retry-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const stateRoot = join(sandbox, "state");
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "resume.ts"), `export default function (pi) {
    pi.registerCommand("resume-once", { description: "Resume accepted turn", handler: async () => "Resumed exactly once." });
  }\n`, "utf8");
  const initial = await startLocalApi({ port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "content"), loadEnv: false });
  const created = await json(initial.origin, "/api/spaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Pre-persist Recovery Space" }),
  }) as { space: { id: string; spaceRoot: string } };
  const conversation = await json(initial.origin, `/api/spaces/${created.space.id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
  await initial.close();

  const content = "/resume-once";
  const requestId = "request-pre-persist-1";
  const userMessageId = "message-pre-persist-1";
  const store = await WorkFoldTurnStore.create({ stateRoot });
  const accepted = await store.accept({
    requestId,
    requestDigest: createHash("sha256").update(JSON.stringify({
      content,
      contextPaths: [],
      selectedPath: null,
      actorKind: "assistant",
      continuedFromManagementTaskId: null,
      managementAttachments: [],
    })).digest("hex"),
    userMessageId,
    userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
    spaceId: created.space.id,
    conversationId: conversation.conversation.id,
    actorKind: "assistant",
  });

  const recovered = await startLocalApi({
    port: 0,
    stateBase: stateRoot,
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  try {
    const result = await json(recovered.origin, `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, requestId, userMessageId }),
    }) as { taskId: string; replayed: boolean };
    assert.equal(result.taskId, accepted.record.turnId);
    assert.equal(result.replayed, false);
    await waitForAsync(async () => {
      const transcript = await json(recovered.origin, `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`) as { messages: Array<{ role: string }> };
      return transcript.messages.some((message) => message.role === "assistant");
    });
    const transcript = await json(recovered.origin, `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`) as { messages: Array<{ role: string; turnId?: string }> };
    assert.equal(transcript.messages.filter((message) => message.role === "user" && message.turnId === accepted.record.turnId).length, 1);
    assert.equal(transcript.messages.filter((message) => message.role === "assistant" && message.turnId === accepted.record.turnId).length, 1);
  } finally {
    await recovered.close();
  }
});

test("Chat event streams replay retained cursor events after reconnect", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-turn-stream-replay-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "stream.ts"), `export default function (pi) {
    pi.registerCommand("stream-result", { description: "Stream result", handler: async () => "Replayable answer." });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  const controller = new AbortController();
  try {
    const created = await json(api.origin, "/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Stream Space" }),
    }) as { space: { id: string } };
    const conversation = await json(api.origin, `/api/spaces/${created.space.id}/conversations`, { method: "POST" }) as { conversation: { id: string } };
    const conversationPath = `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`;
    await json(api.origin, `${conversationPath}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "/stream-result",
        requestId: "request-stream-1",
        userMessageId: "message-stream-1",
      }),
    });
    await waitForAsync(async () => {
      const transcript = await json(api.origin, conversationPath) as { messages: Array<{ role: string }> };
      return transcript.messages.some((message) => message.role === "assistant");
    });

    const response = await fetch(`${api.origin}${conversationPath}/events`, {
      headers: { "last-event-id": "0" },
      signal: controller.signal,
    });
    assert.equal(response.ok, true);
    const frames: Array<{ id: number | null; data: any }> = [];
    const pump = pumpSse(response, frames).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    });
    await waitForAsync(async () => frames.some((frame) => frame.data.type === "done"));
    controller.abort();
    await pump;
    assert.equal(frames.some((frame) => frame.data.type === "turn_state" && frame.data.running === true), true);
    assert.equal(frames.some((frame) => frame.data.type === "done"), true);
    assert.equal(frames.filter((frame) => frame.data.type !== "status").every((frame) => (frame.id ?? 0) > 0), true);
    const ids = frames.map((frame) => frame.id).filter((id): id is number => id !== null);
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
  } finally {
    controller.abort();
    await api.close();
  }
});

async function json(origin: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as unknown;
}

async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a durable Assistant turn.");
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function pumpSse(response: Response, frames: Array<{ id: number | null; data: any }>): Promise<void> {
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = raw.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (data) {
        const idText = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
        frames.push({ id: idText ? Number(idText) : null, data: JSON.parse(data) });
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
