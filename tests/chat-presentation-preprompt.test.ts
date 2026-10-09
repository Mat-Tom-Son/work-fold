import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { markConversationTitleAttempted, readConversation } from "../src/local/agent/chat-store.js";
import { startLocalApi } from "../src/local/server.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";

test("a reused Chat stopped before prompting cannot inherit the prior turn's final segment or edit evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-preprompt-presentation-"));
  // Matching lengths deliberately defeat range-only validation. The previous
  // answer is unrelated content, despite occupying the same UTF-16 interval.
  const stoppedText = "The Assistant was stopped before it completed a response.";
  const previousText = "x".repeat(stoppedText.length);
  let requests = 0;
  const provider = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests += 1;
      const payload = JSON.parse(body);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      if (!payload.messages.some((message: { role?: string }) => message.role === "tool")) {
        send(response, { role: "assistant", tool_calls: [{ index: 0, id: "prior-edit", type: "function", function: {
          name: "edit", arguments: JSON.stringify({ path: "note.txt", edits: [{ oldText: "before", newText: "after" }] }),
        } }] });
        send(response, {}, "tool_calls");
      } else {
        send(response, { role: "assistant", content: previousText });
        send(response, {}, "stop");
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const authStorage = FileCredentialStore.inMemory({ fixture: { type: "api_key", key: "synthetic" } });
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  modelRuntime.registerProvider("fixture", {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, apiKey: "synthetic",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off" });
  let prompted = 0;
  const api = await startLocalApi({
    port: 0, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir, credentials: authStorage, modelRuntime, settingsManager }; } },
    beforeAgentPrompt() {
      if (++prompted === 2) throw Object.assign(new Error("Stopped before prompt"), { name: "PiTurnCancelledError" });
    },
  });
  t.after(async () => {
    await api.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    configureWorkFoldStateRoot(undefined);
    await rm(root, { recursive: true, force: true });
  });
  const { space } = await api.actFacade.createSpace({ name: "Presentation fixture" });
  const { conversation } = await api.actFacade.createConversation({ space: space.id });
  await markConversationTitleAttempted(space.spaceRoot, conversation.id);
  await writeFile(join(space.spaceRoot, "note.txt"), "before\n");
  for (const expected of ["succeeded", "aborted"]) {
    const sent = await api.actFacade.sendMessage({ space: space.id, conversationId: conversation.id, content: "Update the file." });
    let settled = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const { task } = await api.actFacade.turnStatus({ space: space.id, taskId: sent.taskId });
      if (task.state !== "running" && task.state !== "accepted") {
        assert.equal(task.state, expected);
        settled = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled, true, "the admitted turn must settle");
  }
  const replies = (await readConversation(space.spaceRoot, conversation.id)).filter((message) => message.role === "assistant");
  assert.equal(replies.length, 2);
  assert.equal(replies[0]!.content, previousText);
  assert.deepEqual(replies[0]!.assistantPresentation?.segments.map((segment) => segment.kind), ["final"]);
  assert.ok(replies[0]!.workTrail?.some((entry) => entry.edit?.path === "note.txt"), "the prior turn must have evidence available to leak");
  assert.equal(replies[1]!.content, stoppedText);
  assert.equal(replies[1]!.interruption?.reason, "cancelled");
  assert.equal(replies[1]!.assistantPresentation, undefined, "a turn that never prompted has no native text boundaries");
  assert.equal(replies[1]!.workTrail, undefined, "a turn that never prompted cannot borrow the prior edit");
  assert.equal(requests, 2, "only the first turn invokes the synthetic model");
});

function send(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
