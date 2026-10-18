import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { PiConversationClient } from "../src/local/agent/pi-client.js";
import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

/**
 * The `checklist` tool inside a real Pi session: a stand-in model asks for it
 * once, the session runs it against the host, and the turn's own task id
 * reaches the host with the list.
 */
test("a Worker session carries the checklist tool and saves the list for its own turn", { timeout: 45_000 }, async (t) => {
  let calls = 0;
  const providerServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      calls += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: `completion-${calls}`, object: "chat.completion.chunk", created: 1, model: "checklist-model" };
      if (calls === 1) {
        assert.match(body, /"name":"checklist"/, "the session offers the checklist tool to the model");
        const args = JSON.stringify({ items: [{ text: "Read the quotes", status: "doing" }, { text: "Write the summary", status: "todo" }] });
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "checklist", arguments: args } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Plan saved." }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => { providerServer.close((error) => error ? reject(error) : resolve()); }));
  const port = (providerServer.address() as AddressInfo).port;

  const root = await mkdtemp(join(tmpdir(), "work-fold-checklist-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const workFolderRoot = join(root, "work-folder");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(workFolderRoot, { recursive: true });
  await writeFile(join(agentDir, "extensions", "checklist-provider.ts"), `export default function (pi) {
    pi.registerProvider("checklist-provider", {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:${port}/v1",
      apiKey: "test-key",
      models: [{ id: "checklist-model", name: "checklist-model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    });
  }\n`, "utf8");
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "checklist-provider", defaultModel: "checklist-model", defaultThinkingLevel: "off" });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, settingsManager }; } };
  const saved: Array<{ taskId: string; items: unknown }> = [];
  const client = new PiConversationClient("chat-checklist", workFolderRoot, provider, undefined, {
    checklist: { async set(input) { saved.push(input); return { items: input.items as never, updatedAt: new Date().toISOString(), taskId: input.taskId }; } },
  });
  t.after(() => client.stop());

  const reply = await client.prompt("Plan the kitchen budget.", { workFolderTurn: { workFolderId: "space-0000000000000001", taskId: "task-checklist", requestId: "req-20261018000000-abcdef01" } });
  assert.equal(reply, "Plan saved.");
  assert.deepEqual(saved, [{ taskId: "task-checklist", items: [{ text: "Read the quotes", status: "doing" }, { text: "Write the summary", status: "todo" }] }]);
});
