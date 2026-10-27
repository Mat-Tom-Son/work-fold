import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { fillInterruptedToolResults, interruptedToolResultText } from "../src/local/agent/interrupted-tool-results.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * A turn cut off by work-fold closing (2026-10-27): it is recorded like a
 * crash, never as a Stop the person asked for; the person continues it with an
 * ordinary message; and a tool call that never recorded a result reaches the
 * model as possibly partly done, never as a bare "No result provided".
 */

type Msg = { role: string; content?: unknown; stopReason?: string; toolCallId?: string; timestamp?: number };

const call = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });
const result = (id: string): Msg => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], timestamp: 2 });

test("a tool call with no recorded result gets an honest result where Pi would put its filler", () => {
  const messages: Msg[] = [
    { role: "user", content: "Write the report.", timestamp: 0 },
    { role: "assistant", content: [call("a"), call("b", "write")], stopReason: "toolUse", timestamp: 1 },
    result("a"),
    { role: "user", content: "Continue where you left off.", timestamp: 3 },
  ];
  const filled = fillInterruptedToolResults(messages)!;
  assert.deepEqual(filled.map((message) => message.role), ["user", "assistant", "toolResult", "toolResult", "user"]);
  const inserted = filled[3] as Msg & { toolName?: string; isError?: boolean };
  assert.equal(inserted.toolCallId, "b");
  assert.equal(inserted.toolName, "write");
  assert.equal(inserted.isError, true);
  assert.deepEqual(inserted.content, [{ type: "text", text: interruptedToolResultText }]);
  assert.match(interruptedToolResultText, /may have partly happened/);
});

test("answered, errored, and aborted calls are left exactly as Pi sends them", () => {
  assert.equal(fillInterruptedToolResults([
    { role: "assistant", content: [call("a")], stopReason: "toolUse", timestamp: 1 },
    result("a"),
  ]), undefined, "every call answered");
  assert.equal(fillInterruptedToolResults([
    { role: "assistant", content: [call("a")], stopReason: "aborted", timestamp: 1 },
    { role: "assistant", content: [call("b")], stopReason: "error", timestamp: 2 },
    { role: "user", content: "again", timestamp: 3 },
  ]), undefined, "Pi drops errored and aborted messages with their calls");
  const trailing = fillInterruptedToolResults([
    { role: "assistant", content: [call("a")], stopReason: "toolUse", timestamp: 1 },
  ])!;
  assert.equal(trailing.length, 2, "a call left open at the end is answered too");
  const later = fillInterruptedToolResults([
    { role: "assistant", content: [call("a"), call("b")], stopReason: "toolUse", timestamp: 1 },
    { role: "custom", content: "note", timestamp: 2 },
    result("a"),
  ])!;
  assert.equal(later.filter((message) => message.role === "toolResult" && message.toolCallId === "a").length, 1, "a result that arrives later is never duplicated");
  assert.equal(later.filter((message) => message.role === "toolResult" && message.toolCallId === "b").length, 1);
});

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("quitting mid-turn records an app interruption, and Continue starts an ordinary new turn", { timeout: 60_000 }, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-interrupted-turn-"));
  const faux = fauxProvider({ provider: "fixture-interrupted", models: [{ id: "chat" }] });
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
        preferredModel: { provider: "fixture-interrupted", id: "chat" },
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      }),
    },
  });
  let api: LocalApiHandle = await open();
  t.after(async () => {
    await api.close().catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Never reached."),
  ]);
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Interrupted" });
  const sent = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Run the long command." });
  await waitFor(() => requests.length === 1, "the turn's first model request");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Quit while the tool runs, then start again.
  await api.close();
  api = await open();

  const status = await api.actFacade.turnStatus({ workFolder: workFolder.id, taskId: sent.taskId });
  assert.equal(status.task.state, "failed", "a quit is reported like a crash, not as a person's Stop");
  const request = api.requests.byTaskId(sent.taskId)!;
  assert.equal(request.turns[0]!.state, "interrupted");
  assert.notEqual(request.state, "stopped");
  const transcriptPath = `/api/work-folders/${workFolder.id}/conversations/${sent.conversationId}`;
  const transcript = await (await fetch(new URL(transcriptPath, api.origin))).json() as { messages: Array<{ role: string; turnId?: string; interruption?: { reason: string; message: string } }> };
  const reply = transcript.messages.find((message) => message.role === "assistant" && message.turnId === sent.taskId)!;
  assert.equal(reply.interruption?.reason, "app_interrupted");
  assert.match(reply.interruption!.message, /work-fold closed before this turn finished/);

  // Continue is the person's ordinary message; the model sees no bare filler.
  faux.setResponses([fauxAssistantMessage("Picked up where I left off.")]);
  const continued = await api.actFacade.sendMessage({ workFolder: workFolder.id, conversationId: sent.conversationId, content: "Continue where you left off." });
  await waitFor(async () => (await api.actFacade.turnStatus({ workFolder: workFolder.id, taskId: continued.taskId })).task.state !== "running", "the continued turn");
  assert.equal((await api.actFacade.turnStatus({ workFolder: workFolder.id, taskId: continued.taskId })).task.state, "succeeded");
  // The Chat's title request may follow; the continued turn's own request is the one with its message.
  const turnRequest = requests.findLast((messages) => JSON.stringify(messages).includes("Continue where you left off."))!;
  assert.ok(turnRequest, "the continued turn reached the model");
  assert.doesNotMatch(JSON.stringify(turnRequest), /No result provided/);
  assert.equal(turnRequest.filter((message) => message.role === "toolResult").length, 1, "the cut-off call has exactly one result");
});
