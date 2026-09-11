import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHash } from "node:crypto";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

/**
 * Durable requests through the local API (docs/collaboration-contract.md,
 * F25): every accepted turn creates or joins a request record, a Space turn
 * with no parent is its own root, a delegated send is a child under the
 * management request, a person's reply joins the request that was waiting on
 * it, and the records survive a restart — reconciled against the turn
 * journal, never replayed.
 */

async function sandboxApi(t: { after: (fn: () => unknown) => void }, stateBase?: string) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-request-integration-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 200)),
    });
  }\n`, "utf8");
  const provider = { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } };
  const open = (gate?: (event: { spaceId: string; taskId: string }) => Promise<void>) => startLocalApi({
    port: 0,
    stateBase: stateBase ?? join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: provider,
    ...(gate ? { beforeAgentPrompt: gate } : {}),
  });
  return { sandbox, open };
}

test("every accepted turn creates or joins a request record, and a Space turn with no parent is its own root", async (t) => {
  const { open } = await sandboxApi(t);
  const api = await open();
  try {
    const { space } = await api.actFacade.createSpace({ name: "Roots" });
    const chat = await api.actFacade.createConversation({ space: space.id });

    // The renderer's Space Chat route: kind `space`, its own root.
    const rendererResponse = await fetch(new URL(`/api/spaces/${space.id}/conversations/${chat.conversation.id}/messages`, api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold", contextPaths: [], selectedPath: null }),
    });
    assert.equal(rendererResponse.status, 202);
    const renderer = await rendererResponse.json() as { taskId: string };
    const spaceRoot = api.requests.byTaskId(renderer.taskId);
    assert.ok(spaceRoot, "a renderer Space turn has a request record");
    assert.equal(spaceRoot!.kind, "space");
    assert.equal(spaceRoot!.surface, "renderer");
    assert.equal(spaceRoot!.rootId, spaceRoot!.requestId);
    assert.equal(spaceRoot!.depth, 0);
    assert.equal(spaceRoot!.parentTaskId, null);
    assert.deepEqual(spaceRoot!.owner, { spaceId: space.id, spaceName: "Roots", conversationId: chat.conversation.id });
    assert.equal(spaceRoot!.turns[0]!.role, "origin");
    await waitFor(async () => (await api.actFacade.turnStatus({ space: space.id, taskId: renderer.taskId })).task.state !== "running");
    const settledRoot = api.requests.byTaskId(renderer.taskId)!;
    assert.equal(settledRoot.state, "done");
    assert.equal(settledRoot.turns[0]!.state, "succeeded");
    assert.equal(settledRoot.usage.turns, 0, "an extension command runs no model, so nothing was spent and nothing is invented");
    assert.ok(settledRoot.settledAt);

    // `manage send` from the CLI: kind `management`, surface `cli`.
    const manage = await api.actFacade.manageSend({ content: "/hold" });
    const managementRoot = api.requests.byTaskId(manage.taskId)!;
    assert.equal(managementRoot.kind, "management");
    assert.equal(managementRoot.surface, "cli");
    assert.deepEqual(managementRoot.owner, { conversationId: manage.conversationId });

    // The popover route: kind `management`, surface `popover`.
    const popoverResponse = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/hold", newConversation: true }),
    });
    assert.equal(popoverResponse.status, 202);
    const popover = await popoverResponse.json() as { taskId: string };
    assert.equal(api.requests.byTaskId(popover.taskId)!.surface, "popover");

    // `chat send` without a parent: kind `cli`, its own root.
    const plain = await api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "/hold" });
    const cliRoot = api.requests.byTaskId(plain.taskId)!;
    assert.equal(cliRoot.kind, "cli");
    assert.equal(cliRoot.surface, "cli");
    assert.equal(cliRoot.rootId, cliRoot.requestId);

    // `chat send --parent-task`: a child under the management request's root.
    await waitFor(async () => (await api.actFacade.manageTurnStatus({ taskId: manage.taskId })).task.state !== "running");
    const held = await api.actFacade.manageSend({ content: "/hold", newConversation: true });
    const child = await api.actFacade.sendMessage({ space: space.id, newConversation: true, content: "/hold", parentTaskId: held.taskId });
    const childRecord = api.requests.byTaskId(child.taskId)!;
    const parentRecord = api.requests.byTaskId(held.taskId)!;
    assert.equal(childRecord.rootId, parentRecord.requestId);
    assert.equal(childRecord.parentRequestId, parentRecord.requestId);
    assert.equal(childRecord.parentTaskId, held.taskId);
    assert.equal(childRecord.depth, 1);
    assert.deepEqual(api.requests.get(parentRecord.requestId)!.childRequestIds, [childRecord.requestId]);
    assert.equal((await api.actFacade.manageTurnStatus({ taskId: held.taskId })).request!.children[0]!.taskId, child.taskId);

    // The glance reads the same records: the fold's request is running work.
    const glance = await api.kernel.getGlance({ kind: "system" });
    assert.ok(glance.running.some((item) => item.id === `management-requests:${parentRecord.requestId}`), "a management request is one running item");
    assert.ok(!glance.running.some((item) => item.id === `management-requests:${cliRoot.requestId}`), "a plain Space turn's root is not a second running item");
    await waitFor(async () => (await api.actFacade.manageTurnStatus({ taskId: held.taskId })).request!.children.every((item) => item.state !== "running"));
  } finally {
    await api.close();
  }
});

test("a person's reply joins the request that was waiting on it and answers its question", async (t) => {
  const { open } = await sandboxApi(t);
  let releaseFold!: () => void;
  const foldGate = new Promise<void>((resolve) => { releaseFold = resolve; });
  const api = await open(async (event) => {
    if (event.spaceId === workFoldManagementScopeId) await foldGate;
  });
  try {
    const first = await api.actFacade.manageSend({ content: "/hold" });
    const record = api.requests.byTaskId(first.taskId)!;
    // The Assistant asks the person while its turn is live (F27); the turn
    // then ends and the request waits on the answer.
    const question = await api.requests.ask({ requestId: record.requestId, taskId: first.taskId, respondent: "person", text: "Which quarter?" });
    releaseFold();
    await waitFor(async () => (await api.actFacade.manageTurnStatus({ taskId: first.taskId })).task.state !== "running");
    const waiting = (await api.actFacade.manageTurnStatus({ taskId: first.taskId })).request!;
    assert.equal(waiting.state, "waiting");
    assert.equal(waiting.phase, "needs_you");
    assert.equal(waiting.questions[0]!.questionId, question.questionId);
    const glance = await api.kernel.getGlance({ kind: "system" });
    assert.ok(glance.needsYou.some((item) => item.ref?.questionId === question.questionId), "the open question is in Needs you");
    assert.ok(!glance.running.some((item) => item.id === `management-requests:${record.requestId}`), "a waiting request is not running");

    // The reply through the popover route joins the same record — one story,
    // two turns — and is the question's one answer.
    const reply = await fetch(new URL("/api/management/messages", api.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The reply is an extension command so the continuation turn needs no model here.
      body: JSON.stringify({ content: "/hold", conversationId: first.conversationId, continuationTaskId: first.taskId }),
    });
    assert.equal(reply.status, 202);
    const continued = await reply.json() as { taskId: string };
    const joined = api.requests.byTaskId(continued.taskId)!;
    assert.equal(joined.requestId, record.requestId, "the reply joined the waiting request");
    assert.equal(joined.turns.length, 2);
    assert.equal(joined.turns[1]!.role, "continuation");
    assert.equal(joined.continuedFromTaskId, first.taskId);
    assert.equal(api.requests.list({ kind: "management" }).length, 1, "no second record");
    const answered = api.requests.question(question.questionId)!;
    assert.equal(answered.state, "answered");
    assert.equal(answered.answer, "/hold", "the reply's text is the recorded answer");
    assert.equal(answered.continuationTaskId, continued.taskId);
    // Either task id resolves to the one request, whose view names its newest turn.
    const viaOld = await fetch(new URL(`/api/management/requests/${first.taskId}`, api.origin));
    assert.equal(viaOld.status, 200);
    const view = (await viaOld.json() as { request: { taskId: string; requestId: string } }).request;
    assert.equal(view.requestId, record.requestId);
    assert.equal(view.taskId, continued.taskId);
    await waitFor(async () => (await api.actFacade.manageTurnStatus({ taskId: continued.taskId })).task.state !== "running");
    assert.equal(api.requests.get(record.requestId)!.state, "done");
  } finally {
    releaseFold();
    await api.close();
  }
});

test("requests survive a restart: settled ones keep their projection and an orphaned one reconciles without rerunning", async (t) => {
  const { sandbox, open } = await sandboxApi(t);
  const stateRoot = join(sandbox, "state");
  const first = await open();
  let spaceId: string;
  let conversationId: string;
  let spaceRoot: string;
  let doneTaskId: string;
  let doneRequestId: string;
  try {
    const created = await first.actFacade.createSpace({ name: "Recovery" });
    spaceId = created.space.id;
    spaceRoot = created.space.spaceRoot;
    conversationId = (await first.actFacade.createConversation({ space: spaceId })).conversation.id;
    const manage = await first.actFacade.manageSend({ content: "/hold" });
    doneTaskId = manage.taskId;
    doneRequestId = first.requests.byTaskId(manage.taskId)!.requestId;
    await waitFor(async () => (await first.actFacade.manageTurnStatus({ taskId: manage.taskId })).task.state !== "running");
  } finally {
    await first.close();
  }

  // A Space root request whose turn was running when the app closed: the
  // turn journal says running, the transcript has the user message, and
  // nothing ever produced a reply.
  const turnStore = await WorkFoldTurnStore.create({ stateRoot });
  const accepted = await turnStore.accept({
    requestId: "request-orphan",
    requestDigest: createHash("sha256").update("orphan").digest("hex"),
    userMessageId: "message-orphan",
    userMessageCreatedAt: "2026-09-11T12:00:00.000Z",
    spaceId,
    conversationId,
    actorKind: "assistant",
  });
  await appendMessage(spaceRoot, conversationId, {
    id: "message-orphan",
    role: "user",
    content: "Do not run this twice.",
    createdAt: "2026-09-11T12:00:00.000Z",
    turnId: accepted.record.turnId,
    requestId: "request-orphan",
  });
  await turnStore.markRunning(accepted.record.turnId);
  const requestStore = await WorkFoldRequestStore.open({ rootPath: join(stateRoot, "requests") });
  const orphan = await requestStore.beginRoot({
    kind: "space",
    owner: { spaceId, spaceName: "Recovery", conversationId },
    surface: "renderer",
    taskId: accepted.record.turnId,
    content: "Do not run this twice.",
  });
  await requestStore.markTurnRunning(accepted.record.turnId);
  await requestStore.flush();

  const restarted = await open();
  try {
    // The settled management request is still there, with the same id and projection.
    const status = await restarted.actFacade.manageTurnStatus({ taskId: doneTaskId });
    assert.equal(status.task.state, "succeeded");
    assert.equal(status.request?.requestId, doneRequestId);
    assert.equal(status.request?.phase, "done");
    assert.equal(status.request?.state, "done");
    assert.equal(status.request?.reply?.content, "Command completed.");

    // The orphan reconciled from the turn journal: failed, marked as
    // recovered at startup, and never dispatched again.
    const reconciled = restarted.requests.get(orphan.requestId)!;
    assert.equal(reconciled.state, "failed");
    assert.equal(reconciled.turns[0]!.state, "interrupted", "the turn journal's own outcome is copied, never overridden");
    assert.ok(reconciled.reconciledAt, "a request settled at startup says so, so nothing continues it");
    assert.match(reconciled.turns[0]!.error ?? "", /closed before this Assistant turn finished/);
    const transcript = await fetch(new URL(`/api/spaces/${spaceId}/conversations/${conversationId}`, restarted.origin));
    const messages = (await transcript.json() as { messages: Array<{ role: string; turnId?: string; interruption?: { reason: string } }> }).messages;
    const replies = messages.filter((message) => message.role === "assistant" && message.turnId === accepted.record.turnId);
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.interruption?.reason, "app_interrupted");
    const tasks = await restarted.kernel.getTasks({ kind: "system" });
    assert.equal(tasks.tasks.some((task) => task.id === accepted.record.turnId), false, "the orphan is not running again");
    assert.ok(
      (await restarted.kernel.getGlance({ kind: "system" })).running.every((item) => item.ref?.taskId !== accepted.record.turnId),
      "the glance shows no running work for the recovered turn",
    );
  } finally {
    await restarted.close();
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
