import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiConversationClient, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { appendMessage, readConversation } from "../src/local/agent/chat-store.js";
import { boundedLiveTurnPresentation } from "../src/local/agent/turn-live-presentation.js";
import { parseAssistantPresentation } from "../src/local/agent/turn-presentation.js";
import { maxLiveTurnPresentationBytes } from "../src/shared/chat-presentation.js";
import { startLocalApi } from "../src/local/server.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";

test("live native-event projection keeps stable identities, chronology, silent thinking and exact canonical offsets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-live-presentation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new PiConversationClient("live", root);
  const events: PiChatEvent[] = [];
  client.on("event", (event) => events.push(event));
  const native = (event: unknown) => (client as unknown as { handleSessionEvent(event: unknown): void }).handleSessionEvent(event);
  native({ type: "message_start", message: { role: "assistant" } });
  native({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
  const silent = client.getTurnLivePresentation()!;
  assert.equal(silent.workTrail[0]?.id, "thinking:1");
  assert.equal(silent.workTrail[0]?.order, 0); assert.equal(silent.workTrail[0]?.text, "");
  assert.equal(silent.workTrail[0]?.phase, "streaming"); assert.ok(silent.workTrail[0]?.startedAt);
  await delay(10);
  assert.equal(client.getTurnLivePresentation()!.workTrail[0]?.startedAt, silent.workTrail[0]?.startedAt);
  native({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } });
  native({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "  I will check.  " } });
  native({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "  I will check.  " }, { type: "toolCall" }], stopReason: "toolUse" } });
  native({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "notes.txt" } });
  const running = client.getTurnLivePresentation()!;
  assert.equal(running.text, "I will check.");
  assert.equal(running.assistantPresentation?.segments[0]?.order, 1);
  assert.equal(running.workTrail[1]?.id, "tool:read-1"); assert.equal(running.workTrail[1]?.order, 2);
  assert.equal(running.workTrail[1]?.phase, "running");
  assert.ok(running.workTrail[0]!.durationMs! >= 10);
  native({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "unselected body" }] } });
  native({ type: "message_start", message: { role: "assistant" } });
  native({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " All done. " } });
  assert.equal(client.getTurnLivePresentation()!.assistantPresentation?.segments.at(-1)?.kind, "progress");
  native({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: " All done. " }], stopReason: "stop" } });
  const complete = client.getTurnLivePresentation()!;
  assert.deepEqual(complete.assistantPresentation?.segments.map(({ order, kind }) => ({ order, kind })), [{ order: 1, kind: "progress" }, { order: 3, kind: "final" }]);
  assert.equal(complete.workTrail[1]?.id, running.workTrail[1]?.id);
  assert.equal(complete.workTrail[1]?.phase, "complete");
  for (const event of events.filter((event) => event.type === "assistant_message")) {
    assert.ok(parseAssistantPresentation(event.assistantPresentation, event.text!), "canonical metadata matches exactly the emitted text");
  }
  assert.ok(events.filter((event) => event.type === "assistant_delta").every((event) => event.assistantPresentation === undefined));
  const thoughtEvents = events.filter((event) => event.type === "assistant_thinking");
  assert.ok(thoughtEvents.every((event) => event.workTrailId === "thinking:1" && event.order === 0));
  assert.equal(thoughtEvents.at(-1)?.durationMs, complete.workTrail[0]?.durationMs);
  complete.workTrail[1]!.text = "mutated";
  assert.notEqual(client.getTurnLivePresentation()!.workTrail[1]?.text, "mutated");
  assert.equal(client.getTurnLivePresentation("different-turn"), undefined, "a reused client cannot describe another turn");
  const persisted = { id: "saved", role: "assistant" as const, createdAt: "now", content: complete.text, assistantPresentation: complete.assistantPresentation, workTrail: client.getTurnWorkTrail() };
  await appendMessage(root, "saved", persisted);
  assert.deepEqual((await readConversation(root, "saved"))[0], persisted);
});

test("live snapshots bound encoded bytes, preserve the active row and explicitly omit unavailable metadata", () => {
  const input = { text: "\u0000".repeat(500_000), workTrail: Array.from({ length: 100 }, (_, index) => ({
    id: `thinking:${index}`, kind: "thinking" as const, text: "\u0001".repeat(32_000), order: index,
    phase: index === 99 ? "streaming" as const : "complete" as const, ...(index === 99 ? { startedAt: 123 } : { durationMs: 1000 }),
  })), truncated: false };
  const result = boundedLiveTurnPresentation(input);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= maxLiveTurnPresentationBytes);
  assert.equal(result.truncated, true); assert.equal(result.textTruncated, true);
  assert.equal(result.workTrail.at(-1)?.id, "thinking:99"); assert.equal(result.workTrail.at(-1)?.startedAt, 123);
  assert.equal(input.text.length, 500_000); assert.equal(input.workTrail.length, 100);
});

test("malformed new chronology metadata is discarded without inventing order for legacy text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-order-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "First.\n\nLast.";
  const legacy = { version: 1, segments: [{ start: 0, end: 6, kind: "progress" }, { start: 8, end: 13, kind: "final" }], truncated: false };
  assert.deepEqual(parseAssistantPresentation(legacy, content), legacy);
  for (const order of [-1, 1.5, Infinity]) assert.equal(parseAssistantPresentation({ ...legacy, segments: legacy.segments.map((segment) => ({ ...segment, order })) }, content), undefined);
  assert.equal(parseAssistantPresentation({ ...legacy, segments: legacy.segments.map((segment) => ({ ...segment, order: 1 })) }, content), undefined);
  await appendMessage(root, "legacy", { id: "legacy", role: "assistant", content, createdAt: "now", workTrail: [{ kind: "tool", text: "Read a file", toolName: "read", phase: "complete" }] });
  assert.equal((await readConversation(root, "legacy"))[0]?.workTrail?.[0]?.order, undefined);
});

test("reconnect snapshots restore live steps and edit evidence without replay or a second model/tool execution", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-live-reconnect-"));
  const agentDir = join(root, "pi"); await mkdir(agentDir, { recursive: true });
  let requests = 0;
  let held: { response: ServerResponse; send(delta: Record<string, unknown>, reason?: string): void } | undefined;
  const providerServer = createServer((request, response) => {
    let body = ""; request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests++;
      const payload = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const send = (delta: Record<string, unknown>, reason?: string) => response.write(`data: ${JSON.stringify({ id: "live", object: "chat.completion.chunk", created: 1, model: "live", choices: [{ index: 0, delta, finish_reason: reason ?? null }] })}\n\n`);
      if (!payload.tools?.length) { send({ role: "assistant", content: "A file check" }); send({}, "stop"); response.end("data: [DONE]\n\n"); return; }
      if (!payload.messages.some((message: any) => message.role === "tool")) {
        send({ role: "assistant", content: "I will update notes.txt." });
        send({ tool_calls: [{ index: 0, id: "live-edit", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] }) } }] });
        send({}, "tool_calls"); response.end("data: [DONE]\n\n");
      } else {
        held = { response, send };
        send({ role: "assistant", reasoning_content: "Checking the changed file." });
      }
    });
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const authStorage = FileCredentialStore.inMemory({ live: { type: "api_key", key: "synthetic" } });
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  modelRuntime.registerProvider("live", { api: "openai-completions", baseUrl: `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}/v1`, apiKey: "synthetic", models: [{ id: "live", name: "Live", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "live", defaultModel: "live", defaultThinkingLevel: "low" });
  const turnStore = await WorkFoldTurnStore.create({ stateRoot: join(root, "state") });
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "folders"), loadEnv: false, turnStore,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir, credentials: authStorage, modelRuntime, settingsManager }; } } });
  t.after(async () => { held?.response.end(); await api.close(); providerServer.closeAllConnections(); await new Promise<void>((resolve) => providerServer.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const created = await json(api.origin, "/api/spaces", { name: "Reconnect" });
  await writeFile(join(created.space.spaceRoot, "notes.txt"), "before\n");
  const conversation = await json(api.origin, `/api/spaces/${created.space.id}/conversations`, {});
  const base = `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`;
  const accepted = await json(api.origin, `${base}/messages`, { content: "Update and check notes.txt.", requestId: "reconnect-request", userMessageId: "reconnect-user" });
  await until(() => !!held);
  const first = await snapshot(api.origin + base + "/events", "0");
  const second = await snapshot(api.origin + base + "/events", "99999999");
  assert.equal(first.turnId, accepted.taskId); assert.equal(second.turnId, accepted.taskId);
  assert.equal(second.running, true);
  assert.equal(second.presentation.text, second.text);
  const edit = second.presentation.workTrail.find((entry: any) => entry.id === "tool:live-edit");
  assert.equal(edit.phase, "complete"); assert.equal(edit.edit.path, "notes.txt"); assert.match(edit.edit.diff, /\+1 after/);
  assert.equal(first.presentation.workTrail.find((entry: any) => entry.id === edit.id).order, edit.order);
  const thought = second.presentation.workTrail.find((entry: any) => entry.kind === "thinking");
  assert.ok(thought, "native reasoning remains active in the reconnect snapshot");
  assert.equal(thought.phase, "streaming"); assert.ok(thought.startedAt);
  assert.equal(first.presentation.workTrail.find((entry: any) => entry.id === thought.id).startedAt, thought.startedAt);
  assert.ok(thought.order > edit.order);
  assert.equal(requests, 2, "reconnect never starts a provider or tool attempt");
  assert.equal(await readFile(join(created.space.spaceRoot, "notes.txt"), "utf8"), "after\n");
  held!.send({ content: "The file is updated." }); held!.send({}, "stop"); held!.response.end("data: [DONE]\n\n");
  await until(() => turnStore.get(accepted.taskId)?.status === "succeeded");
  const saved = (await json(api.origin, base)).messages.find((message: any) => message.turnId === accepted.taskId && message.role === "assistant");
  assert.deepEqual(saved.assistantPresentation.segments.map((segment: any) => segment.kind), ["progress", "final"]);
  assert.ok(saved.assistantPresentation.segments.at(-1).order > thought.order);
  assert.equal(saved.workTrail.find((entry: any) => entry.toolName === "edit").order, edit.order);
});

async function json(origin: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const response = await fetch(origin + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text(); assert.equal(response.ok, true, text); return JSON.parse(text);
}
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) { if (predicate()) return; await delay(10); }
  throw new Error("Fixture did not reach its expected state.");
}
async function snapshot(url: string, cursor: string): Promise<any> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { "last-event-id": cursor }, signal: controller.signal });
  const reader = response.body!.getReader(); let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) throw new Error("Stream ended before snapshot");
      text += new TextDecoder().decode(value);
      const frames = text.split("\n\n").filter((frame) => frame.startsWith("data:") || frame.includes("\ndata:"));
      for (const frame of frames) {
        const line = frame.split("\n").find((line) => line.startsWith("data:"));
        if (!line) continue;
        let event; try { event = JSON.parse(line.slice(5)); } catch { continue; }
        assert.notEqual(event.type, "assistant_delta", "reconnect must not replay old deltas");
        assert.notEqual(event.type, "tool", "reconnect must not replay old tool events");
        if (event.type === "turn_snapshot") return event;
      }
    }
  } finally { controller.abort(); await reader.cancel().catch(() => undefined); }
}
