import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { appendMessage, readConversation, type ChatMessage } from "../src/local/agent/chat-store.js";
import { PiConversationClient, PiTurnFailure, type PiChatEvent } from "../src/local/agent/pi-client.js";
import { localEditPath, parseAssistantPresentation, projectNativeEdit, turnPresentation } from "../src/local/agent/turn-presentation.js";
import { maxAssistantPresentationSegments, maxChatToolEditDiffBytes, maxTurnToolEditDiffBytes } from "../src/shared/chat-presentation.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { startLocalApi } from "../src/local/server.js";

test("native edit events retain selected diffs and exact progress/final boundaries without changing Pi evidence", async (t) => {
  const h = await harness(t, (payload, send) => {
    if (!payload.messages.some((message: any) => message.role === "tool")) {
      send({ role: "assistant", content: "I will update the file." });
      send({ tool_calls: [toolCall("edit-1", "edit", { path: join(h.workFolderRoot, "notes.txt"), edits: [{ oldText: "before", newText: "after" }] })] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "The file is updated." });
      send({}, "stop");
    }
  }, `export default function(pi) { pi.registerCommand("fixture", { description: "A fixture command", handler: async () => {} }); }`);
  await writeFile(join(h.workFolderRoot, "notes.txt"), "before\n");
  const content = await h.client.prompt("Update notes.txt.");
  assert.equal(content, "I will update the file.\n\nThe file is updated.");
  assert.equal(h.events.filter((event) => event.type === "assistant_delta").map((event) => event.text ?? "").join(""), content);
  const presentation = h.client.getTurnPresentation();
  assert.deepEqual(presentation, {
    version: 1,
    segments: [{ start: 0, end: 23, kind: "progress", order: 0 }, { start: 25, end: content.length, kind: "final", order: 2 }],
    truncated: false,
  });
  const completed = h.events.find((event) => event.type === "tool" && event.phase === "complete")!;
  assert.equal(completed.edit?.path, "notes.txt");
  assert.equal(completed.edit?.firstChangedLine, 1);
  assert.equal(completed.edit?.truncated, false);
  assert.match(completed.edit?.diff ?? "", /-1 before\n\+1 after/);
  const nativeDetails = (completed.raw as any).result.details;
  assert.equal(completed.edit?.diff, nativeDetails.diff);
  assert.ok(nativeDetails.patch.includes(join(h.workFolderRoot, "notes.txt")));
  assert.equal("patch" in completed.edit!, false);
  const sessionFile = (await h.client.getState()).sessionFile!;
  const nativeResult = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .find((entry) => entry.message?.role === "toolResult" && entry.message?.toolCallId === "edit-1");
  assert.deepEqual(nativeResult.message.details, nativeDetails, "the selected projection does not rewrite native session evidence");

  const trail = h.client.getTurnWorkTrail();
  const message: ChatMessage = { id: "reply", role: "assistant", content, createdAt: new Date().toISOString(), workTrail: trail, assistantPresentation: presentation };
  await appendMessage(h.workFolderRoot, "presentation", message);
  assert.deepEqual((await readConversation(h.workFolderRoot, "presentation"))[0], message);
  trail[0]!.edit!.diff = "mutated";
  assert.equal(h.client.getTurnWorkTrail()[0]?.edit?.diff, nativeDetails.diff);
  presentation!.segments[0]!.kind = "final";
  assert.equal(h.client.getTurnPresentation()?.segments[0]?.kind, "progress");

  const command = await h.client.prompt("/session");
  assert.equal(h.requests.length, 2, "a built-in command does not run a model");
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: command.length, kind: "command", order: 0 }], truncated: false });
  const extensionCommand = await h.client.prompt("/fixture");
  assert.equal(extensionCommand, "Command completed.");
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: extensionCommand.length, kind: "command", order: 0 }], truncated: false });
});

test("native edits outside the work-folder, through symlinks, or into internal metadata keep generic activity only", async (t) => {
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
  await symlink(linked, join(h.workFolderRoot, "link.txt"));
  const targets = [external, "link.txt", ".work-fold/private.txt", ".pi/private.txt", ".workspace/private.txt"];
  for (const directory of [".work-fold", ".pi", ".workspace"]) {
    await mkdir(join(h.workFolderRoot, directory), { recursive: true });
    await writeFile(join(h.workFolderRoot, directory, "private.txt"), "before\n");
  }
  await mkdir(join(h.workFolderRoot, "child", ".work-fold"), { recursive: true });
  await writeFile(join(h.workFolderRoot, "child", ".work-fold", "work-folder.json"), JSON.stringify({ id: "child-folder" }));
  await writeFile(join(h.workFolderRoot, "child", "notes.txt"), "before\n");
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
  await writeFile(join(h.workFolderRoot, "notes.txt"), "before\n");
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
  await assert.rejects(limited.client.prompt("Respond until the provider limit."), (error: unknown) => {
    assert.ok(error instanceof PiTurnFailure);
    assert.equal(error.partialText, "I am still working.");
    assert.match(error.message, /response length limit/);
    return true;
  });
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
  await writeFile(join(empty.workFolderRoot, "notes.txt"), "Evidence\n");
  assert.equal(await empty.client.prompt("Inspect notes.txt."), "I will inspect the file.");
  assert.deepEqual(empty.client.getTurnPresentation()?.segments.map((segment) => segment.kind), ["progress"]);
  assert.equal(empty.client.getTurnWorkTrail().find((entry) => entry.toolName === "read")?.edit, undefined);
});

test("native overflow compaction recovery discards the failed attempt's error and presentation", async (t) => {
  let requests = 0;
  const h = await harness(t, (_payload, send, response) => {
    requests++;
    if (requests === 3) {
      send({ role: "assistant", content: "Discard this failed attempt." });
      response.write(`data: ${JSON.stringify({ error: { message: "prompt is too long", type: "invalid_request_error" } })}\n\n`);
    } else {
      send({ role: "assistant", content: requests < 3 ? "Ready." : "Recovered after compaction." });
      send({}, "stop");
    }
  }, `export default function(pi) {
    pi.on("session_before_compact", async event => ({ compaction: {
      summary: "Earlier context summarized by the fixture.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } }));
  }`, { enabled: true, reserveTokens: 1024, keepRecentTokens: 64 });
  await h.client.prompt("Earlier context. ".repeat(1_000));
  await h.client.prompt("More earlier context. ".repeat(1_000));
  const reply = await h.client.prompt("Now recover from the overflow.");
  assert.equal(reply, "Recovered after compaction.");
  assert.equal(requests, 4);
  assert.ok(h.events.some((event) => (event.raw as any)?.type === "compaction_end" && (event.raw as any)?.willRetry));
  assert.deepEqual(h.client.getTurnPresentation()?.segments.map((segment) => segment.kind), ["final"]);
});

test("native empty length-stop overflow compacts and retries once without retaining the failed assistant", async (t) => {
  let requests = 0;
  const h = await harness(t, (_payload, send, response) => {
    requests++;
    if (requests === 3) {
      send({ role: "assistant", content: "" });
      send({}, "length");
      response.write(`data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "presentation", choices: [], usage: { prompt_tokens: 32768, completion_tokens: 0, total_tokens: 32768 } })}\n\n`);
    } else {
      send({ role: "assistant", content: requests < 3 ? "Ready." : "Recovered from a full input window." });
      send({}, "stop");
    }
  }, `export default function(pi) {
    pi.on("session_before_compact", async event => ({ compaction: {
      summary: "Earlier context summarized by the fixture.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } }));
  }`, { enabled: true, reserveTokens: 1024, keepRecentTokens: 64 });
  await h.client.prompt("Earlier context. ".repeat(1_000));
  await h.client.prompt("More earlier context. ".repeat(1_000));
  assert.equal(await h.client.prompt("Now recover from the overflow."), "Recovered from a full input window.");
  assert.equal(requests, 4, "the existing native recovery makes exactly one retry");
  assert.ok(h.events.some((event) => (event.raw as any)?.type === "compaction_end" && (event.raw as any)?.willRetry));
  assert.deepEqual(h.client.getTurnPresentation()?.segments.map((segment) => segment.kind), ["final"]);
});

test("native repeated input overflow stops after one compact-and-retry even at the same compaction timestamp", async (t) => {
  for (const stop of ["length", "error"] as const) await t.test(stop, async (t) => {
    let requests = 0;
    const h = await harness(t, (_payload, send, response) => {
      requests++;
      if (requests >= 3) {
        send({ role: "assistant", content: "" });
        if (stop === "length") {
          send({}, "length");
          response.write(`data: ${JSON.stringify({ id: "usage", object: "chat.completion.chunk", created: 1, model: "presentation", choices: [], usage: { prompt_tokens: 32768, completion_tokens: 0, total_tokens: 32768 } })}\n\n`);
        } else response.write(`data: ${JSON.stringify({ error: { message: "prompt is too long", type: "invalid_request_error" } })}\n\n`);
      } else { send({ role: "assistant", content: "Ready." }); send({}, "stop"); }
    }, `export default function(pi) {
      let compactionTimestamp;
      pi.on("session_compact", event => { compactionTimestamp = Date.parse(event.compactionEntry.timestamp); });
      pi.on("message_end", event => {
        if (compactionTimestamp !== undefined && event.message.role === "assistant") event.message.timestamp = compactionTimestamp;
      });
      pi.on("session_before_compact", async event => ({ compaction: {
        summary: "Earlier context summarized by the fixture. ".repeat(100),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } }));
    }`, { enabled: true, reserveTokens: 1024, keepRecentTokens: 64 });
    await h.client.prompt("Earlier context. ".repeat(1_000));
    await h.client.prompt("More earlier context. ".repeat(1_000));
    await assert.rejects(h.client.prompt("Recover once, then report if the input still cannot fit."), /recovery failed after one compact-and-retry/);
    assert.equal(requests, 4, "two seed turns plus the original attempt and one native retry");
    assert.equal(new Set(h.events.filter(event => (event.raw as any)?.type === "compaction_end" && (event.raw as any)?.willRetry).map(event => event.raw)).size, 1);
    assert.equal(h.client.getTurnPresentation(), undefined, "no successful final is invented");
    const entries = (await readFile((await h.client.getState()).sessionFile!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.findLast(entry => entry.message?.role === "assistant").message.timestamp,
      Date.parse(entries.findLast(entry => entry.type === "compaction").timestamp), "fresh retry deliberately shares the compaction timestamp");
  });
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
  assert.deepEqual(h.client.getTurnPresentation(), { version: 1, segments: [{ start: 0, end: 26, kind: "progress", order: 0 }], truncated: false });
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
  const options = { port: 0, stateBase: stateRoot, workFolderBase: join(h.root, "work-folders"), loadEnv: false, piRuntimeProvider: h.provider, turnStore };
  let api = await startLocalApi(options);
  t.after(async () => { await api.close(); });
  const created = await json(api.origin, "/api/work-folders", { name: "Presentation work-folder" });
  await writeFile(join(created.workFolder.workFolderRoot, "notes.txt"), "before\n");
  const conversation = await json(api.origin, `/api/work-folders/${created.workFolder.id}/conversations`, {});
  const base = `/api/work-folders/${created.workFolder.id}/conversations/${conversation.conversation.id}`;
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
  await writeFile(join(root, "other", ".WORK-FOLD", "WORK-FOLDER.JSON"), JSON.stringify({ id: "other-folder" }));
  await writeFile(join(root, "other", "notes.txt"), "Other work-folder material.");
  assert.equal(localEditPath(root, "other/notes.txt"), undefined, "portable identity case aliases cannot expose another work-folder");
});

type Send = (delta: Record<string, unknown>, finishReason?: string) => void;

async function harness(t: TestContext, respond: (payload: any, send: Send, response: ServerResponse) => void | "hold", extension?: string,
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-native-presentation-"));
  const workFolderRoot = join(root, "folder");
  const agentDir = join(root, "pi");
  await mkdir(workFolderRoot);
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
  const authStorage = FileCredentialStore.inMemory({ presentation: { type: "api_key", key: "synthetic" } });
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  modelRuntime.registerProvider("presentation", { api: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "synthetic",
    models: [{ id: "presentation", name: "Presentation", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "presentation", defaultModel: "presentation", defaultThinkingLevel: "off", ...(compaction ? { compaction } : {}) });
  const provider = { async resolveRuntime() { return { agentDir, credentials: authStorage, modelRuntime, settingsManager }; } };
  const client = new PiConversationClient("native-presentation", workFolderRoot, provider);
  const events: PiChatEvent[] = [];
  client.on("event", (event: PiChatEvent) => events.push(event));
  t.after(async () => {
    await client.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, workFolderRoot, client, events, requests, provider };
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
