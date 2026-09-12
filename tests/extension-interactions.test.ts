import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutedPiExtensionUiBridge, createExtensionUiContext, extensionUiLimits, type PiExtensionUiRequest } from "../src/local/agent/extension-ui.js";
import { startLocalApi } from "../src/local/server.js";
import type { WorkFoldRemotePrincipal } from "../src/local/remote-management.js";

const scope = { spaceRoot: "/space", conversationId: "chat" };
const question = (id: string): PiExtensionUiRequest => ({ ...scope, id, method: "select", title: "Which one?", options: ["A", "B"] });

test("Pi UI isolates editors, validates answers without consuming questions, and bounds pending callbacks", async () => {
  const bridge = new RoutedPiExtensionUiBridge();
  const other = { ...scope, conversationId: "other" };
  const ui = createExtensionUiContext(bridge, scope);
  const second = createExtensionUiContext(bridge, other);
  ui.setEditorText("first"); second.setEditorText("second"); ui.pasteToEditor(" chat");
  assert.equal(ui.getEditorText(), "first chat"); assert.equal(second.getEditorText(), "second");
  const original = question("one");
  const pending = bridge.request(original);
  if (original.method === "select") original.options.push("C");
  assert.throws(() => bridge.respond("one", { value: "C" }), /options/);
  assert.throws(() => bridge.respond("one", { confirmed: true }), /text/);
  await assert.rejects(bridge.request(question("one")), /already pending/);
  assert.equal(bridge.respond("one", { value: "B" }), true);
  assert.deepEqual(await pending, { value: "B" });
  assert.equal(bridge.respond("one", { value: "A" }), false);
  const live = Array.from({ length: extensionUiLimits.pendingPerChat }, (_, index) => bridge.request(question(`q-${index}`)));
  await assert.rejects(bridge.request(question("too-many")), /8 per Chat/);
  const otherPending = bridge.request({ ...question("other"), ...other });
  bridge.cancelScope(scope);
  assert.ok((await Promise.all(live)).every((item) => "cancelled" in item));
  assert.equal(bridge.respond("other", { value: "A" }), true, "Stop does not answer or cancel another Chat");
  await otherPending;
  bridge.forgetScope(scope); assert.equal(ui.getEditorText(), ""); assert.equal(second.getEditorText(), "second");
  await assert.rejects(bridge.request({ ...question("large"), title: "x".repeat(65536) }), /limit/);
  bridge.cancelAll();
});

test("native Pi dialog cancellation works without a caller-supplied signal, including timeout and late prompts", async () => {
  const bridge = new RoutedPiExtensionUiBridge();
  let cancelled = false;
  const ui = createExtensionUiContext(bridge, scope, { isCancelled: () => cancelled });
  const timed = ui.input("Short question", undefined, { timeout: 5 });
  assert.equal(await timed, undefined);
  const live = ui.editor("Long text");
  cancelled = true; bridge.cancelScope(scope);
  assert.equal(await live, undefined);
  assert.equal(await ui.select("Late question", ["yes"]), undefined);
});

test("turn settlement leaves session questions alive while Stop still cancels the whole Chat", async () => {
  const bridge = new RoutedPiExtensionUiBridge();
  const session = bridge.request(question("session"));
  const turn = bridge.request({ ...question("turn"), taskId: "task-1" });
  bridge.cancelScope({ ...scope, taskId: "task-1" });
  assert.deepEqual(await turn, { cancelled: true });
  assert.equal(bridge.respond("session", { value: "A" }), true);
  assert.deepEqual(await session, { value: "A" });
});

test("native session-start timers and helper callbacks remain usable across turns and reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-session-callbacks-"));
  const agentDir = join(root, "pi");
  const resultsPath = join(root, "results.jsonl");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "session.ts"), `
    import { appendFile } from "node:fs/promises";
    import { spawn } from "node:child_process";
    export default function(pi) {
      let timer, child, armed = false;
      pi.on("session_start", (_, ctx) => {
        const ask = async (kind) => {
          const answer = await ctx.ui.confirm(kind, "Session-owned question");
          await appendFile(${JSON.stringify(resultsPath)}, JSON.stringify({ kind, answer }) + "\\n");
        };
        timer = setInterval(() => { if (armed) { armed = false; void ask("Timer"); } }, 10);
        child = spawn(process.execPath, ["-e", "process.stdin.on('data', () => process.stdout.write('question\\\\n'))"], { stdio: ["pipe", "pipe", "ignore"] });
        child.stdout.on("data", () => { ctx.ui.notify("Session helper is ready"); void ask("Helper"); });
      });
      pi.on("session_shutdown", () => { clearInterval(timer); child?.kill(); });
      pi.registerCommand("first", { description: "Initialize only", handler: async () => {} });
      pi.registerCommand("arm", { description: "Request new work through session callbacks", handler: async () => {
        armed = true; child.stdin.write("ask\\n");
      }});
    }
  `);
  const bridge = new RoutedPiExtensionUiBridge();
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false,
    extensionUiBridge: bridge, piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } } });
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const pending = new Map<string, PiExtensionUiRequest>();
  bridge.on("request", (request) => pending.set(request.id, request));
  bridge.on("settled", ({ id }) => pending.delete(id));
  const start = await api.actFacade.manageSend({ content: "/first", newConversation: true });
  const settled = (taskId: string) => until(async () => (await api.actFacade.manageTurnStatus({ taskId })).task.state !== "running");
  await settled(start.taskId);
  for (const reload of [false, true]) {
    if (reload) await settled((await api.actFacade.manageSend({ conversationId: start.conversationId, content: "/reload" })).taskId);
    const arm = await api.actFacade.manageSend({ conversationId: start.conversationId, content: "/arm" });
    await settled(arm.taskId);
    await until(() => pending.size === 2);
    assert.deepEqual([...pending.values()].map((request) => request.title).sort(), ["Helper", "Timer"]);
    const projection = await fetch(`${api.origin}/api/management/conversations/${start.conversationId}/extension-ui`).then((response) => response.json()) as any;
    assert.equal(projection.requests.length, 2, "session questions survive the triggering turn's settlement");
    for (const request of pending.values()) {
      assert.equal(request.taskId, undefined, "session callbacks never borrow a turn identity");
      bridge.respond(request.id, { confirmed: true });
    }
    await until(async () => (await readFile(resultsPath, "utf8").catch(() => "")).trim().split("\n").length === (reload ? 4 : 2));
  }
  assert.ok((await readFile(resultsPath, "utf8")).trim().split("\n").every((line) => JSON.parse(line).answer === true));
});

test("real Pi Extensions ask in fold and Space Chats; reconnect, exact-owner web answers and Stop share the same callbacks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-extension-interaction-"));
  const agentDir = join(root, "pi");
  const resultsPath = join(root, "results.jsonl");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "questions.ts"), `
    import { appendFile } from "node:fs/promises";
    export default function(pi) {
      pi.registerCommand("choose", { description: "Ask two ordinary native Pi questions", handler: async (_, ctx) => {
        pi.events.emit("release-old-question", {});
        const answers = await Promise.all([ctx.ui.select("Choose a colour", ["Blue", "Green"]), ctx.ui.confirm("Add a label?", "A short label helps.")]);
        await appendFile(${JSON.stringify(resultsPath)}, JSON.stringify(answers) + "\\n");
      }});
      pi.registerCommand("cancel-question", { description: "Exercise native cancellation", handler: async (_, ctx) => {
        await ctx.ui.input("Pending on Stop");
        const later = await ctx.ui.input("Must not appear after Stop");
        await appendFile(${JSON.stringify(resultsPath)}, JSON.stringify({ cancelled: later === undefined }) + "\\n");
      }});
      pi.registerCommand("late-question", { description: "Exercise old asynchronous work", handler: async (_, ctx) => {
        const released = new Promise((resolve) => { const off = pi.events.on("release-old-question", () => { off(); resolve(); }); });
        void released.then(async () => {
          const later = await ctx.ui.input("Session transport asks after its opening turn");
          await appendFile(${JSON.stringify(resultsPath)}, JSON.stringify({ lateCancelled: later === undefined }) + "\\n");
        });
      }});
      pi.registerCommand("never", { description: "Non-cooperative command", handler: async (_, ctx) => {
        ctx.ui.notify("Non-cooperative command started");
        await new Promise(() => {});
      }});
    }
  `);
  const bridge = new RoutedPiExtensionUiBridge();
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false,
    extensionUiBridge: bridge, piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } } });
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const pending = new Map<string, PiExtensionUiRequest>();
  bridge.on("request", (request) => pending.set(request.id, request));
  bridge.on("settled", ({ id }) => pending.delete(id));
  const space = (await api.actFacade.createSpace({ name: "Extension testing" })).space;
  const chat = (await api.actFacade.createConversation({ space: space.id })).conversation;
  const fold = await api.actFacade.manageSend({ content: "/choose", newConversation: true });
  await api.actFacade.sendMessage({ space: space.id, conversationId: chat.id, content: "/choose" });
  await until(() => pending.size === 4);
  const foldPath = `/api/management/conversations/${fold.conversationId}/extension-ui`;
  const spacePath = `/api/spaces/${space.id}/conversations/${chat.id}/extension-ui`;
  const get = async (path: string) => (await fetch(api.origin + path)).json() as Promise<any>;
  const post = (path: string, body: unknown) => fetch(api.origin + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const foldQuestions = (await get(foldPath)).requests as PiExtensionUiRequest[];
  assert.equal(foldQuestions.length, 2); assert.equal((await get(spacePath)).requests.length, 2);
  assert.ok(!JSON.stringify(foldQuestions).includes(root), "projection contains no root path");
  const select = foldQuestions.find((item) => item.method === "select")!;
  assert.equal(pending.get(select.id)?.taskId, fold.taskId, "the native callback carries its originating task, not an inferred active task");
  assert.equal((await post(`${spacePath}/${select.id}`, { value: "Blue" })).status, 404);
  assert.equal((await post(`${foldPath}/${select.id}`, { value: "Red" })).status, 400);
  const confirm = foldQuestions.find((item) => item.method === "confirm")!;
  assert.equal((await post(`${foldPath}/${confirm.id}`, { value: "false" })).status, 400);
  assert.equal((await post(`${foldPath}/${select.id}`, { value: "Blue" })).status, 200);
  assert.equal((await post(`${foldPath}/${select.id}`, { value: "Green" })).status, 404);

  // Subscribe after emission: recover current questions, not the answered one.
  const controller = new AbortController();
  bridge.publish({ ...[...pending.values()].find((item) => item.id === confirm.id)!, id: "device-code", method: "oauthDeviceCode", userCode: "PRIVATE-SETUP-CODE", verificationUri: "https://example.test/setup" });
  const response = await fetch(`${api.origin}/api/management/conversations/${fold.conversationId}/events`, { signal: controller.signal, headers: { "last-event-id": "0" } });
  const reader = response.body!.getReader();
  let events = "";
  while (!events.includes("extension_ui_snapshot")) events += new TextDecoder().decode((await reader.read()).value);
  controller.abort(); await reader.cancel().catch(() => undefined);
  assert.ok(events.includes(confirm.id)); assert.ok(!events.includes(select.id));
  assert.ok(!events.includes("PRIVATE-SETUP-CODE"), "setup codes never enter the replay journal");
  assert.equal((await post(`${foldPath}/${confirm.id}`, { value: false })).status, 200);
  for (const request of (await get(spacePath)).requests) {
    assert.equal((await post(`${spacePath}/${request.id}`, { value: request.method === "select" ? "Green" : true })).status, 200);
  }
  await until(async () => (await readFile(resultsPath, "utf8").catch(() => "")).trim().split("\n").length === 2);
  const results = (await readFile(resultsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(results.some((item) => item[0] === "Blue" && item[1] === false));
  assert.ok(results.some((item) => item[0] === "Green" && item[1] === true));

  const owner: WorkFoldRemotePrincipal = { browserId: "browser-a", grantId: "grant-a", requestId: "remote-one" };
  const other = { ...owner, grantId: "other-grant" };
  const remote = await api.remoteFacade.execute("management.send", { content: "/choose", newConversation: true }, owner) as { taskId: string; conversationId: string };
  await until(() => [...pending.values()].filter((item) => item.conversationId === remote.conversationId).length === 2);
  const summary = async (principal = owner) => api.remoteFacade.execute("management.summary", { conversationId: remote.conversationId }, principal) as Promise<any>;
  assert.equal((await summary()).extensionRequests.length, 2);
  assert.equal((await summary(other)).extensionRequests.length, 0);
  const remoteQuestion = (await summary()).extensionRequests[0];
  const answer = { taskId: remote.taskId, id: remoteQuestion.id, value: "Blue" };
  await assert.rejects(api.remoteFacade.execute("management.extensionAnswer", answer, other), /browser grant/);
  await assert.rejects(api.remoteFacade.execute("management.extensionAnswer", answer, owner, { assertCurrent() { throw new Error("Revoked"); } }), /Revoked/);
  assert.ok(pending.has(remoteQuestion.id));
  const remoteScope = [...pending.values()].find((item) => item.conversationId === remote.conversationId)!;
  const secret = bridge.request({ ...remoteScope, id: "setup-secret", method: "input", title: "Setup", secret: true });
  assert.equal((await summary()).extensionRequests.length, 2, "setup secrets stay on the desktop");
  await assert.rejects(api.remoteFacade.execute("management.extensionAnswer", { ...answer, id: "setup-secret" }, owner), /desktop/);
  bridge.cancel("setup-secret"); await secret;
  assert.deepEqual(await api.remoteFacade.execute("management.extensionAnswer", answer, owner), { accepted: true });
  await api.remoteFacade.execute("management.stop", { taskId: remote.taskId }, owner);
  await until(() => ![...pending.values()].some((item) => item.conversationId === remote.conversationId));
  assert.deepEqual((await summary()).extensionRequests, []);

  const stop = await api.actFacade.manageSend({ content: "/cancel-question", newConversation: true });
  await until(() => [...pending.values()].some((item) => item.conversationId === stop.conversationId));
  await api.actFacade.manageStop({ taskId: stop.taskId });
  await until(async () => (await readFile(resultsPath, "utf8")).includes('"cancelled":true'));
  assert.equal(pending.size, 0);

  const old = await api.actFacade.manageSend({ content: "/late-question", newConversation: true });
  await until(async () => (await api.actFacade.manageTurnStatus({ taskId: old.taskId })).task.state !== "running");
  const next = await api.actFacade.manageSend({ conversationId: old.conversationId, content: "/choose" });
  await until(() => [...pending.values()].filter((item) => item.conversationId === next.conversationId).length === 3);
  const sessionQuestion = [...pending.values()].find((item) => item.title === "Session transport asks after its opening turn")!;
  assert.equal(sessionQuestion.taskId, undefined, "a long-lived transport loses stale attribution instead of borrowing the next turn");
  assert.ok([...pending.values()].filter((item) => item.id !== sessionQuestion.id).every((item) => item.taskId === next.taskId));
  bridge.respond(sessionQuestion.id, { value: "Session answer" });
  await until(async () => (await readFile(resultsPath, "utf8")).includes('"lateCancelled":false'));
  await api.actFacade.manageStop({ taskId: next.taskId });

  let neverStarted = false;
  bridge.on("event", (event) => { if (event.message === "Non-cooperative command started") neverStarted = true; });
  const stuck = await api.actFacade.manageSend({ content: "/never", newConversation: true });
  await until(() => neverStarted);
  await api.actFacade.manageStop({ taskId: stuck.taskId });
  await until(async () => (await api.actFacade.manageTurnStatus({ taskId: stuck.taskId })).task.state !== "running");
  const recovered = await api.actFacade.manageSend({ conversationId: stuck.conversationId, content: "/late-question" });
  await until(async () => (await api.actFacade.manageTurnStatus({ taskId: recovered.taskId })).task.state !== "running");
  assert.equal((await api.actFacade.manageTurnStatus({ taskId: recovered.taskId })).task.state, "succeeded", "the host disposes cancelled sessions before it accepts another turn");
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for extension state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
