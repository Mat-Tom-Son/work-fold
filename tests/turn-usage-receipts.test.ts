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
 * The measurement behind an app request's receipt (docs/receipts-not-gates.md,
 * F22): after a turn settles, the client reports the model that actually ran it
 * and what the provider said it used. A model with published rates carries a
 * cost; a model without them leaves the cost out rather than reporting zero.
 */
async function fixture(t: test.TestContext) {
  const providerServer = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const model = /"model":"([^"]+)"/.exec(body)?.[1] ?? "priced-model";
      const send = (payload: unknown) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      send({ id: "completion-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "North is cheaper." }, finish_reason: null }] });
      send({ id: "completion-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      send({ id: "completion-1", object: "chat.completion.chunk", created: 1, model, choices: [], usage: { prompt_tokens: 1_000, completion_tokens: 200 } });
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => { providerServer.once("error", reject); providerServer.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>((resolve, reject) => { providerServer.close((error) => error ? reject(error) : resolve()); }));
  const port = (providerServer.address() as AddressInfo).port;

  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const spaceRoot = join(root, "space");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(spaceRoot, { recursive: true });
  const model = (id: string, cost: string) =>
    `{ id: "${id}", name: "${id}", reasoning: false, input: ["text"], cost: ${cost}, contextWindow: 32768, maxTokens: 1024 }`;
  await writeFile(join(agentDir, "extensions", "usage-provider.ts"),
    `export default function (pi) {
      pi.registerProvider("usage-provider", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:${port}/v1",
        apiKey: "test-key",
        models: [
          ${model("priced-model", "{ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }")},
          ${model("unpriced-model", "{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }")},
        ],
      });
    }\n`, "utf8");
  return {
    client(conversationId: string, modelId: string) {
      const settingsManager = SettingsManager.inMemory({ defaultProvider: "usage-provider", defaultModel: modelId, defaultThinkingLevel: "off" });
      const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, settingsManager }; } };
      const client = new PiConversationClient(conversationId, spaceRoot, provider);
      t.after(() => client.stop());
      return client;
    },
  };
}

test("a settled turn reports the model that ran it, its tokens, and a cost only when the model is priced", { timeout: 45_000 }, async (t) => {
  const f = await fixture(t);

  const priced = f.client("usage-priced", "priced-model");
  assert.equal(priced.getTurnUsage(), null, "nothing is claimed before a turn runs");
  await priced.prompt("Compare the quotes.");
  const pricedUsage = priced.getTurnUsage()!;
  assert.equal(pricedUsage.provider, "usage-provider");
  assert.equal(pricedUsage.modelId, "priced-model");
  assert.equal(pricedUsage.inputTokens, 1_000);
  assert.equal(pricedUsage.outputTokens, 200);
  // 1,000 input at $3/M plus 200 output at $15/M.
  assert.ok(Math.abs(pricedUsage.amountUsd! - 0.006) < 1e-9, "the reported cost follows the model's own rates");

  const unpriced = f.client("usage-unpriced", "unpriced-model");
  await unpriced.prompt("Compare the quotes.");
  const unpricedUsage = unpriced.getTurnUsage()!;
  assert.equal(unpricedUsage.modelId, "unpriced-model");
  assert.equal(unpricedUsage.inputTokens, 1_000);
  assert.equal(unpricedUsage.outputTokens, 200);
  assert.equal("amountUsd" in unpricedUsage, false, "a model with no rates leaves the cost unknown, never zero");

  // A second turn is measured on its own, not as the session's running total.
  await priced.prompt("And again.");
  assert.equal(priced.getTurnUsage()!.inputTokens, 1_000, "usage is the delta across one turn");
});
