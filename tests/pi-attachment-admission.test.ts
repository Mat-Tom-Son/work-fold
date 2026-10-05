import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { PiConversationClient, PiTurnFailure } from "../src/local/agent/pi-client.js";
import { loadConversationContextReferencesForTurn } from "../src/local/conversation-context.js";

test("native dispatch loads attachments against the actual model and marks length exhaustion incomplete", { timeout: 15_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-admission-"));
  const agentDir = join(root, "pi"), spaceRoot = join(root, "folder");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(spaceRoot);
  await writeFile(join(spaceRoot, "oversized.txt"), "DO_NOT_INLINE_THIS ".repeat(16_000));
  await writeFile(join(spaceRoot, "small.txt"), "SMALL_BODY_MUST_NOT_BE_INLINED");
  const payloads: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const first = payloads.length === 1;
      const delta = first
        ? { role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "small.txt" }) } }] }
        : { role: "assistant", content: payloads.length === 2 ? "I can read the file by path." : "An unfinished sentence" };
      for (const [chunk, finish_reason] of [[delta, null], [{}, first ? "tool_calls" : payloads.length === 2 ? "stop" : "length"]]) {
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta: chunk, finish_reason }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(agentDir, "extensions", "provider.ts"), `
    export default function(pi) { pi.registerProvider("admission-test", {
      api: "openai-completions", baseUrl: ${JSON.stringify(origin + "/v1")}, apiKey: "synthetic",
      models: [{id:"small",name:"Small fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024}]
    }); }`);
  const client = new PiConversationClient("admission-chat", spaceRoot, { async resolveRuntime() { return {
    agentDir, settingsManager: SettingsManager.inMemory({ defaultProvider: "admission-test", defaultModel: "small", defaultThinkingLevel: "off" }),
  }; } });
  t.after(async () => { await client.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  let admittedBudget = -1;
  const reply = await client.prompt("Inspect my file.", { loadContextAttachments: async (budget) => {
    admittedBudget = budget; return loadConversationContextReferencesForTurn(spaceRoot, ["oversized.txt", "small.txt"], budget);
  } });
  assert.ok(admittedBudget >= 0 && admittedBudget < 32768);
  assert.equal(reply, "I can read the file by path.");
  const context = JSON.stringify(payloads[0]);
  assert.match(context, /oversized.txt/);
  assert.match(context, /small.txt/);
  assert.match(context, /Use your file or document tools/);
  assert.doesNotMatch(context, /DO_NOT_INLINE_THIS|SMALL_BODY_MUST_NOT_BE_INLINED/);
  assert.match(JSON.stringify(payloads[1]), /SMALL_BODY_MUST_NOT_BE_INLINED/, "the original contents arrive only after the Worker's native read tool runs");
  assert.ok(payloads[1].messages.some((message: any) => message.role === "tool"));
  await assert.rejects(client.prompt("Continue with a long answer."), (error) => {
    assert.ok(error instanceof PiTurnFailure);
    assert.match(error.message, /response length limit/);
    assert.equal(error.partialText, "An unfinished sentence");
    return true;
  });
  assert.equal(payloads.length, 3, "one tool read, its reply, and one incomplete response, without automatic replay");
});


test("native dispatch spills oversized reference metadata while preserving exact user text and all paths", { timeout: 15_000 }, async (t) => {
  const { readFile, readdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "work-fold-admission-manifest-"));
  const agentDir = join(root, "pi"), spaceRoot = join(root, "folder"), sessionDir = join(root, "sessions");
  await mkdir(join(agentDir, "extensions"), { recursive: true }); await mkdir(spaceRoot);
  const payloads: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "I can inspect the reference manifest." }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "small", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await writeFile(join(agentDir, "extensions", "provider.ts"), `export default function(pi){pi.registerProvider("reference-test",{
    api:"openai-completions",baseUrl:${JSON.stringify(origin + "/v1")},apiKey:"synthetic",models:[{id:"small",name:"Small fixture",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:1024}]});}`);
  const client = new PiConversationClient("manifest-chat", spaceRoot, { async resolveRuntime() { return {
    agentDir, sessionDir, settingsManager: SettingsManager.inMemory({ defaultProvider: "reference-test", defaultModel: "small", defaultThinkingLevel: "off" }),
  }; } });
  t.after(async () => { await client.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const exactMessage = "Please inspect my selected files.\nKeep this exact request.";
  let loaderCalls = 0;
  const references = Array.from({ length: 400 }, (_, index) => `selected/${"segment/".repeat(50)}${index}.txt`);
  const reply = await client.prompt(exactMessage, { loadContextAttachments: async () => {
    loaderCalls++;
    return references.map((sourcePath) => ({ sourcePath, sourceFileName: sourcePath.split("/").at(-1)!, sourceSizeBytes: 16,
      mode: "full_original_text" as const, includedInPrompt: true, reason: null, estimatedTokens: 100,
      budgetTokens: 1000, provenance: [], warnings: [], userLabel: "Text", detail: "", text: "DO_NOT_INLINE_OR_COPY_BODY" }));
  } });
  assert.equal(reply, "I can inspect the reference manifest."); assert.equal(loaderCalls, 1); assert.equal(payloads.length, 1);
  const directories = await readdir(join(sessionDir, "attachment-artifacts"));
  assert.equal(directories.length, 1);
  const path = join(sessionDir, "attachment-artifacts", directories[0]!, "references.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.owner.conversationId, "manifest-chat"); assert.equal(manifest.cwd, spaceRoot);
  assert.deepEqual(manifest.references.map((entry: { path: string }) => entry.path), references);
  const serialized = JSON.stringify(payloads[0]);
  assert.match(serialized, /400 attachment paths/); assert.ok(serialized.includes(JSON.stringify(JSON.stringify(path)).slice(1, -1)), "the prompt names the manifest by its quoted path");
  assert.doesNotMatch(serialized, /DO_NOT_INLINE_OR_COPY_BODY/);
  assert.doesNotMatch(JSON.stringify(manifest), /DO_NOT_INLINE_OR_COPY_BODY/);
  assert.ok(payloads[0].messages.some((message: any) => message.role === "user" && (message.content === exactMessage || (Array.isArray(message.content) && message.content.some((part: any) => part.type === "text" && part.text === exactMessage)))), "the user's exact text is sent unchanged");
});
