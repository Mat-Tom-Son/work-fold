import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { appendMessage, readConversation, type ChatMessage } from "../src/local/agent/chat-store.js";
import { PiConversationClient, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { localEditPath, parseAssistantPresentation, projectNativeEdit, turnPresentation } from "../src/local/agent/turn-presentation.js";
import { maxAssistantPresentationSegments, maxChatToolEditDiffBytes, maxTurnToolEditDiffBytes } from "../src/shared/chat-presentation.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { startLocalApi } from "../src/local/server.js";

test("native edit events retain selected diffs and exact progress/final boundaries without changing Pi evidence", async (t) => {
  const h = await harness(t, (payload, send) => {
    if (!payload.messages.some((message: any) => message.role === "tool")) {
      send({ role: "assistant", content: "I will update the file." });
      send({ tool_calls: [toolCall("edit-1", "edit", { path: join(h.spaceRoot, "notes.txt"), edits: [{ oldText: "before", newText: "after" }] })] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "The file is updated." });
      send({}, "stop");
    }
  }, `export default function(pi) { pi.registerCommand("fixture", { description: "A fixture command", handler: async () => {} }); }`);
  await writeFile(join(h.spaceRoot, "notes.txt"), "before\n");
  const content = await h.client.prompt("Update notes.txt.");
  assert.equal(content, "I will update the file.\n\nThe file is updated.");
  assert.equal(h.events.filter((event) => event.type === "assistant_delta").map((event) => event.text ?? "").join(""), content);
  const presentation = h.client.getTurnPresentation();
  assert.deepEqual(presentation, {
    version: 1,
    segments: [{ start: 0, end: 23, kind: "progress" }, { start: 25, end: content.length, kind: "final" }],
    truncated: false,
  });
  const completed = h.events.find((event) => event.type === "tool" && event.phase === "complete")!;
  assert.equal(completed.edit?.path, "notes.txt");
  assert.equal(completed.edit?.firstChangedLine, 1);
  assert.equal(completed.edit?.truncated, false);
  assert.match(completed.edit?.diff ?? "", /-1 before\n\+1 after/);
  const nativeDetails = (completed.raw as any).result.details;
  assert.equal(completed.edit?.diff, nativeDetails.diff);
  assert.ok(nativeDetails.patch.includes(join(h.spaceRoot, "notes.txt")));
  assert.equal("patch" in completed.edit!, false);
  const sessionFile = (await h.client.getState()).sessionFile!;
  const nativeResult = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .find((entry) => entry.message?.role === "toolResult" && entry.message?.toolCallId === "edit-1");
  assert.deepEqual(nativeResult.message.details, nativeDetails, "the selected projection does not rewrite native session evidence");

  const trail = h.client.getTurnWorkTrail();
  const message: ChatMessage = { id: "reply", role: "assistant", content, createdAt: new Date().toISOString(), workTrail: trail, assistantPresentation: presentation };
  await appendMessage(h.spaceRoot, "presentation", message);
  assert.deepEqual((await readConversation(h.spaceRoot, "presentation"))[0], message);
  trail[0]!.edit!.diff = "mutated";
  assert.equal(h.client.getTurnWorkTrail()[0]?.edit?.diff, nativeDetails.diff);
  presentation!.segments[0]!.kind = "final";
  assert.equal(h.client.getTurnPresentation()?.segments[0]?.kind, "progress");

  const command = await h.client.prompt("/session");
  assert.equal(h.requests.length, 2, "a built-in command does not run a model");
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: command.length, kind: "command" }], truncated: false });
  const extensionCommand = await h.client.prompt("/fixture");
  assert.equal(extensionCommand, "Command completed.");
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: extensionCommand.length, kind: "command" }], truncated: false });
});

test("native edits outside the Folder, through symlinks, or into internal metadata keep generic activity only", async (t) => {
  const h = await harness(t, (payload, send) => {
    if (!payload.messages.some((message: any) => message.role === "tool")) {
      send({ role: "assistant", tool_calls: targets.map((path, index) => toolCall(`unsafe-${index}`, "edit", { path, edits: [{ oldText: "before", newText: "after" }] }, index)) });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "Finished." });
      send({}, "stop");
    }
  });
  const external = join(h.root, "outside.txt");
  const linked = join(h.root, "linked.txt");
  await writeFile(external, "before\n");
  await writeFile(linked, "before\n");
  await symlink(linked, join(h.spaceRoot, "link.txt"));
  const targets = [external, "link.txt", ".work-fold/private.txt", ".pi/private.txt", ".workspace/private.txt"];
  for (const directory of [".work-fold", ".pi", ".workspace"]) {
    await mkdir(join(h.spaceRoot, directory), { recursive: true });
    await writeFile(join(h.spaceRoot, directory, "private.txt"), "before\n");
  }
  await mkdir(join(h.spaceRoot, "child", ".work-fold"), { recursive: true });
  await writeFile(join(h.spaceRoot, "child", ".work-fold", "space.json"), JSON.stringify({ id: "child-folder" }));
  await writeFile(join(h.spaceRoot, "child", "notes.txt"), "before\n");
  targets.push("child/notes.txt");
  await h.client.prompt("Exercise the disposable paths.");
  const completed = h.events.filter((event) => event.type === "tool" && event.phase === "complete");
  assert.equal(completed.length, targets.length);
  assert.ok(completed.every((event) => !event.edit));
  assert.ok(h.client.getTurnWorkTrail().every((entry) => !entry.edit));
  assert.equal(await readFile(external, "utf8"), "after\n", "projection admission does not alter native full-trust execution");
});

test("an Extension replacing edit does not inherit the built-in evidence projection", async (t) => {
  const h = await harness(t, (payload, send) => {
    if (!payload.messages.some((message: any) => message.role === "tool")) {
      send({ role: "assistant", tool_calls: [toolCall("custom-1", "edit", { path: "notes.txt" })] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "Finished." });
      send({}, "stop");
    }
  }, `export default function(pi) {
    pi.registerTool({ name: "edit", label: "Custom edit", description: "A fixture replacing edit",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute() { return { content: [{ type: "text", text: "custom content" }], details: { diff: "private custom details", firstChangedLine: 1 } }; }
    });
  }`);
  await writeFile(join(h.spaceRoot, "notes.txt"), "before\n");
  await h.client.prompt("Use the custom tool.");
  const completed = h.events.find((event) => event.type === "tool" && event.phase === "complete")!;
  assert.equal((completed.raw as any).result.details.diff, "private custom details");
  assert.equal(completed.edit, undefined);
  assert.equal(h.client.getTurnWorkTrail()[0]?.edit, undefined);
});

test("length-limited and tool-only final messages never relabel progress as a final answer", async (t) => {
  const limited = await harness(t, (_payload, send) => {
    send({ role: "assistant", content: "I am still working." });
    send({}, "length");
  });
  const partial = await limited.client.prompt("Respond until the provider limit.");
  assert.equal(partial, "I am still working.");
  assert.deepEqual(limited.client.getTurnPresentation()?.segments.map((segment) => segment.kind), ["progress"]);

  const empty = await harness(t, (payload, send) => {
    if (!payload.messages.some((message: any) => message.role === "tool")) {
      send({ role: "assistant", content: "I will inspect the file." });
      send({ tool_calls: [toolCall("read-1", "read", { path: "notes.txt" })] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "" });
      send({}, "stop");
    }
  });
  await writeFile(join(empty.spaceRoot, "notes.txt"), "Evidence\n");
  assert.equal(await empty.client.prompt("Inspect notes.txt."), "I will inspect the file.");
  assert.deepEqual(empty.client.getTurnPresentation()?.segments.map((segment) => segment.kind), ["progress"]);
  assert.equal(empty.client.getTurnWorkTrail().find((entry) => entry.toolName === "read")?.edit, undefined);
});

test("Stop preserves partial text boundaries without inventing a final segment", async (t) => {
  const h = await harness(t, (_payload, send) => {
    send({ role: "assistant", content: "Partial reply before Stop." });
    return "hold";
  });
  const streamed = new Promise<void>((resolve) => h.client.on("event", (event: PiChatEvent) => { if (event.type === "assistant_delta") resolve(); }));
  const pending = h.client.prompt("Wait while streaming.");
  const stopped = assert.rejects(pending, { name: "PiTurnCancelledError" });
  await streamed;
  await h.client.abort();
  await stopped;
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: 26, kind: "progress" }], truncated: false });
});

test("the local API persists native edit evidence and successful or interrupted segment metadata", async (t) => {
  const h = await harness(t, (payload, send) => {
    if (!payload.tools?.length) {
      send({ role: "assistant", content: "A file update" });
      send({}, "stop");
      return;
    }
    const latestUser = payload.messages.findLastIndex((message: any) => message.role === "user");
    if (payload.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("Hold the reply"))) {
      send({ role: "assistant", content: "The partial reply is still in progress." });
      return "hold";
    }
    if (!payload.messages.slice(latestUser + 1).some((message: any) => message.role === "tool")) {
      send({ role: "assistant", content: "I will update notes.txt." });
      send({ tool_calls: [toolCall("server-edit", "edit", { path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] })] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "Updated notes.txt." });
      send({}, "stop");
    }
  });
  const stateRoot = join(h.root, "state");
  const turnStore = await WorkFoldTurnStore.create({ stateRoot });
  const options = { port: 0, stateBase: stateRoot, spaceBase: join(h.root, "spaces"), loadEnv: false, piRuntimeProvider: h.provider, turnStore };
  let api = await startLocalApi(options);
  t.after(async () => { await api.close(); });
  const created = await json(api.origin, "/api/spaces", { name: "Presentation Folder" });
  await writeFile(join(created.space.spaceRoot, "notes.txt"), "before\n");
  const conversation = await json(api.origin, `/api/spaces/${created.space.id}/conversations`, {});
  const base = `/api/spaces/${created.space.id}/conversations/${conversation.conversation.id}`;
  const accepted = await json(api.origin, `${base}/messages`, { content: "Update notes.txt.", requestId: "request-presentation", userMessageId: "message-presentation" });
  await until(() => turnStore.get(accepted.taskId)?.status === "succeeded");
  const completed = (await json(api.origin, base)).messages.find((message: ChatMessage) => message.role === "assistant") as ChatMessage;
  assert.equal(completed.content, "I will update notes.txt.\n\nUpdated notes.txt.");
  assert.deepEqual(completed.assistantPresentation?.segments.map((segment) => segment.kind), ["progress", "final"]);
  assert.equal(completed.workTrail?.find((entry) => entry.toolName === "edit")?.edit?.path, "notes.txt");
  assert.match(completed.workTrail?.find((entry) => entry.toolName === "edit")?.edit?.diff ?? "", /\+1 after/);
  await until(async () => !(await api.kernel.getTasks({ kind: "renderer" })).tasks.some((task) => task.id === accepted.taskId));

  const held = await json(api.origin, `${base}/messages`, { content: "Hold the reply open.", requestId: "request-held", userMessageId: "message-held" });
  await until(() => turnStore.get(held.taskId)?.assistantText === "The partial reply is still in progress.");
  await json(api.origin, `${base}/abort`, {});
  await until(() => turnStore.get(held.taskId)?.status === "aborted");
  const stopped = (await json(api.origin, base)).messages.find((message: ChatMessage) => message.role === "assistant" && message.turnId === held.taskId) as ChatMessage;
  assert.equal(stopped.content, "The partial reply is still in progress.");
  assert.equal(stopped.interruption?.reason, "cancelled");
  assert.deepEqual(stopped.assistantPresentation?.segments.map((segment) => segment.kind), ["progress"]);
  await api.close();
  api = await startLocalApi(options);
  const reopened = (await json(api.origin, base)).messages as ChatMessage[];
  assert.deepEqual(reopened.find((message) => message.id === completed.id), completed);
  assert.deepEqual(reopened.find((message) => message.id === stopped.id), stopped);
});

test("portable metadata rejects malformed ranges and unsafe edit paths, bounds diffs and strips raw extras", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-presentation-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "Progress.\n\nDone.";
  const valid = turnPresentation([" Progress. ", "", "Done."], 2, false)!;
  assert.deepEqual(parseAssistantPresentation(valid, content), valid);
  for (const bad of [
    { ...valid, segments: [{ start: 1, end: content.length, kind: "final" }] },
    { ...valid, segments: [{ start: 0, end: content.length + 1, kind: "final" }] },
    { ...valid, segments: [{ start: 0, end: 9, kind: "final" }, { start: 11, end: content.length, kind: "progress" }] },
    { ...valid, segments: [{ start: 0, end: 9, kind: "progress" }] },
  ]) assert.equal(parseAssistantPresentation(bad, content), undefined);
  const tooMany = Array.from({ length: maxAssistantPresentationSegments + 1 }, () => "a");
  const bounded = turnPresentation(tooMany, tooMany.length - 1, false)!;
  assert.equal(bounded.segments.length, maxAssistantPresentationSegments);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(parseAssistantPresentation(bounded, tooMany.join("\n\n")), bounded);
  const diff = "é".repeat(maxChatToolEditDiffBytes);
  const edit = projectNativeEdit("notes.txt", { diff, firstChangedLine: 3, patch: "private absolute headers", unrelated: "secret" }, maxChatToolEditDiffBytes)!;
  assert.equal(Buffer.byteLength(edit.diff), maxChatToolEditDiffBytes);
  assert.equal(edit.truncated, true);
  assert.equal(edit.diff.includes("�"), false);
  assert.deepEqual(projectNativeEdit("notes.txt", { diff: "a😀b" }, 4), { path: "notes.txt", diff: "a", truncated: true });
  assert.deepEqual(projectNativeEdit("notes.txt", { diff: "a😀b" }, 2), { path: "notes.txt", diff: "a", truncated: true });
  const trail = Array.from({ length: 5 }, () => ({ kind: "tool" as const, text: "Edit finished", toolName: "edit", phase: "complete" as const, edit, raw: "should not persist" }));
  await appendMessage(root, "bounded", { id: "reply", role: "assistant", content, createdAt: "now", workTrail: trail, assistantPresentation: valid });
  const saved = (await readConversation(root, "bounded"))[0]!;
  assert.equal(saved.workTrail?.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.edit?.diff ?? ""), 0), maxTurnToolEditDiffBytes);
  const disk = await readFile(join(root, ".work-fold", "conversations", "bounded.jsonl"), "utf8");
  assert.doesNotMatch(disk, /should not persist|private absolute headers|unrelated/);

  for (const path of ["../secret", "/private/secret", "C:/secret", "folder\\secret", ".WORK-FOLD/private", ".pi/private", ".workspace/private"]) {
    await appendMessage(root, "unsafe", { id: path, role: "assistant", content, createdAt: "now", workTrail: [{ ...trail[0]!, edit: { ...edit, path } }] });
  }
  assert.ok((await readConversation(root, "unsafe")).every((message) => !message.workTrail?.[0]?.edit));
  await appendMessage(root, "legacy", { id: "legacy", role: "assistant", content: "Old plain reply.", createdAt: "now" });
  assert.equal((await readConversation(root, "legacy"))[0]?.assistantPresentation, undefined);
});

test("edit path admission rejects symlink parents and rechecks a changed target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-edit-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "folder"));
  await writeFile(join(root, "folder", "notes.txt"), "before");
  assert.equal(localEditPath(root, "folder/notes.txt"), "folder/notes.txt");
  await symlink(join(root, "folder"), join(root, "shortcut"));
  assert.equal(localEditPath(root, "shortcut/notes.txt"), undefined);
  await rm(join(root, "folder", "notes.txt"));
  await symlink(join(root, "elsewhere.txt"), join(root, "folder", "notes.txt"));
  assert.equal(localEditPath(root, "folder/notes.txt"), undefined);
  await mkdir(join(root, "other", ".WORK-FOLD"), { recursive: true });
  await writeFile(join(root, "other", ".WORK-FOLD", "SPACE.JSON"), JSON.stringify({ id: "other-folder" }));
  await writeFile(join(root, "other", "notes.txt"), "Other Folder material.");
  assert.equal(localEditPath(root, "other/notes.txt"), undefined, "portable identity case aliases cannot expose another Folder");
});

type Send = (delta: Record<string, unknown>, finishReason?: string) => void;

async function harness(t: TestContext, respond: (payload: any, send: Send, response: ServerResponse) => void | "hold", extension?: string) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-presentation-"));
  const spaceRoot = join(root, "folder");
  const agentDir = join(root, "pi");
  await mkdir(spaceRoot);
  if (extension) {
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(agentDir, "extensions", "fixture.ts"), extension);
  }
  const requests: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const send: Send = (delta, finishReason) => response.write(`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 1,
        model: "presentation", choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] })}\n\n`);
      if (respond(payload, send, response) !== "hold") response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const authStorage = AuthStorage.inMemory({ presentation: { type: "api_key", key: "synthetic" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("presentation", { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "synthetic",
    models: [{ id: "presentation", name: "Presentation", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "presentation", defaultModel: "presentation", defaultThinkingLevel: "off" });
  const provider = { async resolveRuntime() { return { agentDir, authStorage, modelRegistry, settingsManager }; } };
  const client = new PiConversationClient("native-presentation", spaceRoot, provider);
  const events: PiChatEvent[] = [];
  client.on("event", (event: PiChatEvent) => events.push(event));
  t.after(async () => {
    await client.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, spaceRoot, client, events, requests, provider };
}

function toolCall(id: string, name: string, args: Record<string, unknown>, index = 0) {
  return { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function json(origin: string, path: string, body?: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${origin}${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the native turn to persist.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
