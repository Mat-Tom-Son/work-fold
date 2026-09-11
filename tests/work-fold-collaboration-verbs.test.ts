import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendMessage } from "../src/local/agent/chat-store.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

/**
 * Report, ask, answer, handoff, the non-blocking wait, and the root
 * continuation (docs/collaboration-contract.md, F27/F28) through the real
 * local API: a question puts the task in `waiting` without suspending its
 * turn; exactly one answer starts exactly one linked continuation; an answer
 * from the wrong Space, past the window, after a stop, or a second time is
 * refused by name; the host brings settled results back to the fold once per
 * settle batch, within the request's limits, off when the setting says so,
 * never after a root Stop, and never on a restart.
 *
 * Turns are held open with the prompt gate so a test can act inside "its own
 * running turn" and release turns in the order a scenario needs.
 */

interface HeldTurn {
  taskId: string;
  spaceId: string;
  release: () => void;
}

async function collaborationHarness(t: { after: (fn: () => unknown) => void }) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-collaboration-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 50)),
    });
  }\n`, "utf8");
  const stateBase = join(sandbox, "state");
  const held = new Set<string>();
  const pending: HeldTurn[] = [];
  // Once a test tears down, no turn is held any more: a continuation the
  // host accepted a moment ago may reach the gate only after the last
  // release, and a held turn would keep `close()` waiting forever.
  let draining = false;
  const open = (overrides: { requestStore?: WorkFoldRequestStore } = {}) => {
    draining = false;
    return startLocalApi({
      port: 0,
      stateBase,
      spaceBase: join(sandbox, "content"),
      loadEnv: false,
      piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
      beforeAgentPrompt: async (event) => {
        if (draining || !held.has(event.spaceId)) return;
        await new Promise<void>((release) => pending.push({ taskId: event.taskId, spaceId: event.spaceId, release }));
      },
      ...overrides,
    });
  };
  const release = async (taskId: string): Promise<void> => {
    await waitFor(async () => pending.some((turn) => turn.taskId === taskId));
    const index = pending.findIndex((turn) => turn.taskId === taskId);
    pending.splice(index, 1)[0]!.release();
  };
  const releaseAll = (): void => {
    draining = true;
    for (const turn of pending.splice(0)) turn.release();
  };
  return { sandbox, stateBase, held, pending, open, release, releaseAll };
}

async function settled(api: LocalApiHandle, spaceId: string, taskId: string): Promise<void> {
  await waitFor(async () => {
    const status = spaceId === workFoldManagementScopeId
      ? await api.actFacade.manageTurnStatus({ taskId })
      : await api.actFacade.turnStatus({ space: spaceId, taskId });
    return status.task.state !== "running";
  });
}

async function managementMessages(api: LocalApiHandle, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/management/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

async function spaceMessages(api: LocalApiHandle, spaceId: string, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/spaces/${spaceId}/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

const conflict = (pattern: RegExp) => (error: unknown): boolean =>
  error instanceof WorkFoldCliError && error.code === "conflict" && pattern.test(error.message);

test("chat ask puts the task in waiting without suspending its turn, and chat answer continues it exactly once and brings the result back to the fold", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldManagementScopeId);
  try {
    const drafts = await api.actFacade.createSpace({ name: "Drafts" });
    const reviews = await api.actFacade.createSpace({ name: "Reviews" });
    h.held.add(drafts.space.id);
    await writeFile(join(drafts.space.spaceRoot, "draft.md"), "# Draft\n", "utf8");

    // The fold hands work to Drafts while its own turn runs.
    const root = await api.actFacade.manageSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ space: drafts.space.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const rootRecord = api.requests.byTaskId(root.taskId)!;

    // Inside its running turn the child reports, asks, and hands on.
    const reported = await api.actFacade.chatReport({
      space: drafts.space.id,
      taskId: child.taskId,
      summary: "Drafted draft.md from the brief.",
      data: { pages: 3 },
      files: ["draft.md"],
      outcome: "partial",
    });
    assert.equal(reported.result.outcome, "partial");
    assert.equal(reported.result.files?.[0]?.path, "draft.md");
    assert.equal(reported.result.files?.[0]?.sha256, createHash("sha256").update("# Draft\n").digest("hex"));
    assert.equal(reported.result.files?.[0]?.sizeBytes, 8);
    assert.deepEqual(reported.result.data, { pages: 3 });

    const asked = await api.actFacade.chatAsk({ space: drafts.space.id, taskId: child.taskId, question: "Which quarter?", respondent: "parent" });
    assert.equal(asked.redirectedToPerson, false, "a child has a parent, so --to parent stays with the parent");
    assert.equal(asked.question.respondent, "parent");
    assert.equal(asked.request.state, "waiting", "asking puts the request in waiting at once");

    // The turn still runs; the status says the task is waiting and on what.
    const live = await api.actFacade.turnStatus({ space: drafts.space.id, taskId: child.taskId });
    assert.equal(live.task.state, "running");
    assert.equal(live.waiting?.questionId, asked.question.questionId);
    assert.equal(live.waiting?.question, "Which quarter?");
    assert.equal(live.request?.state, "waiting");
    const parentView = await api.actFacade.manageTurnStatus({ taskId: root.taskId });
    assert.equal(parentView.waiting, null, "the fold asked nothing itself");
    assert.equal(parentView.requestGraph?.state, "working", "the fold's own turn is still running, so it is working, not waiting");

    const handed = await api.actFacade.chatHandoff({
      space: drafts.space.id,
      taskId: child.taskId,
      toSpace: reviews.space.id,
      message: "/hold",
      files: ["draft.md"],
    });
    assert.deepEqual(handed.copied, ["draft.md"]);
    assert.ok(handed.checkpointId, "the copy landed with a restore point in the destination");
    assert.equal(handed.request.rootId, rootRecord.requestId, "the handoff is a child of the caller's root");
    assert.equal(handed.request.depth, 2);
    await assert.rejects(
      () => api.actFacade.chatHandoff({ space: drafts.space.id, taskId: child.taskId, toSpace: drafts.space.id, message: "/hold", files: ["draft.md"] }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage" && /already there/.test(error.message),
    );

    // A wrong task id is refused by name before anything is recorded.
    await assert.rejects(
      () => api.actFacade.chatReport({ space: reviews.space.id, taskId: child.taskId, summary: "Nope.", files: [], outcome: "succeeded" }),
      conflict(/another Space's turn/),
    );

    // The fold's own turn ends first. Its request now reads the descendant's
    // open question as waiting, while the child's turn is still running.
    await h.release(root.taskId);
    await settled(api, workFoldManagementScopeId, root.taskId);
    assert.equal((await api.actFacade.manageTurnStatus({ taskId: root.taskId })).requestGraph?.state, "waiting");

    // The child's turn and the handoff's turn end. The request keeps waiting
    // on its question; the settled turn still reports it.
    await h.release(child.taskId);
    await settled(api, drafts.space.id, child.taskId);
    await settled(api, reviews.space.id, handed.taskId);
    const ended = await api.actFacade.turnStatus({ space: drafts.space.id, taskId: child.taskId });
    assert.equal(ended.task.state, "succeeded");
    assert.equal(ended.waiting?.questionId, asked.question.questionId, "a settled turn still reports its open question");

    // The whole story is one read.
    const shown = await api.actFacade.requestsShow({ request: rootRecord.requestId });
    assert.equal(shown.request.childRequests.length, 1);
    assert.equal(shown.request.childRequests[0]!.spaceName, "Drafts");
    assert.equal(shown.request.childRequests[0]!.resultRecords[0]!.envelope?.summary, "Drafted draft.md from the brief.");
    assert.equal(shown.request.childRequests[0]!.questions[0]!.text, "Which quarter?");
    assert.equal(shown.request.childRequests[0]!.childRequests[0]!.spaceName, "Reviews");
    const listed = await api.actFacade.requestsList();
    assert.ok(listed.requests.some((request) => request.id === rootRecord.requestId));
    assert.ok(listed.requests.every((request) => request.id === request.rootId), "list shows roots only");

    // Every child has settled after the fold's own turn ended: the host
    // brings the batch back exactly once, including the question the child
    // put to the fold and how to answer it.
    await waitFor(async () => api.requests.get(rootRecord.requestId)!.turns.length === 2);
    const continued = api.requests.get(rootRecord.requestId)!;
    assert.equal(continued.continuationCount, 1);
    assert.equal(continued.turns[1]!.role, "continuation");
    const first = (await managementMessages(api, root.conversationId))
      .filter((message) => message.role === "user" && message.requestId === `continuation-${rootRecord.requestId}-1`);
    assert.equal(first.length, 1);
    assert.match(first[0]!.content, /work-fold is continuing request/);
    assert.match(first[0]!.content, /Nobody typed this message/);
    assert.match(first[0]!.content, /Drafts \[/);
    assert.match(first[0]!.content, /partial: Drafted draft\.md from the brief\./);
    assert.match(first[0]!.content, /files: draft\.md/);
    assert.match(first[0]!.content, /Reviews \[[^\]]+\] — Chat [^,]+, task [^ ]+ — finished without a report/);
    assert.match(first[0]!.content, new RegExp(`waiting on you: question ${asked.question.questionId} — Which quarter\\?`));
    assert.match(first[0]!.content, new RegExp(`answer it with: work-fold chat answer --space ${drafts.space.id} --question ${asked.question.questionId}`));
    // That continuation turn ends (no model here). Nothing settled after it,
    // so nothing follows it: a continuation never continues itself.
    await h.release(continued.turns[1]!.taskId);
    await settled(api, workFoldManagementScopeId, continued.turns[1]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 2);

    // An answer from a Space that does not own the question is refused and
    // names the owner; the answer from the owning Space continues the Chat
    // once, and only once.
    await assert.rejects(
      () => api.actFacade.chatAnswer({ space: reviews.space.id, questionId: asked.question.questionId, answer: "Q3" }),
      conflict(/belongs to Drafts/),
    );
    const answered = await api.actFacade.chatAnswer({ space: drafts.space.id, questionId: asked.question.questionId, answer: "/hold" });
    assert.equal(answered.question.state, "answered");
    assert.equal(answered.question.continuationTaskId, answered.continuation.taskId);
    assert.equal(answered.continuation.conversationId, child.conversationId, "the continuation is a new turn in the same Chat");
    await assert.rejects(
      () => api.actFacade.chatAnswer({ space: drafts.space.id, questionId: asked.question.questionId, answer: "/hold" }),
      conflict(/already has an answer/),
    );
    const transcript = await spaceMessages(api, drafts.space.id, child.conversationId);
    const answers = transcript.filter((message) => message.role === "user" && message.requestId === `answer-${asked.question.questionId}`);
    assert.equal(answers.length, 1, "exactly one continuation message, keyed by the question");
    assert.equal(answers[0]!.content, "/hold", "the answer is an ordinary user message; the question id stays machine-local");
    assert.equal(api.requests.byTaskId(answered.continuation.taskId)!.requestId, api.requests.byTaskId(child.taskId)!.requestId, "the continuation joined the child's request");
    assert.equal((await api.actFacade.turnStatus({ space: drafts.space.id, taskId: child.taskId })).waiting, null, "an answered question is not owed");

    // The answered child's continuation settles after the fold's last turn
    // ended: a second batch, a second continuation, no open question in it.
    await h.release(answered.continuation.taskId);
    await settled(api, drafts.space.id, answered.continuation.taskId);
    await waitFor(async () => api.requests.get(rootRecord.requestId)!.turns.length === 3);
    assert.equal(api.requests.get(rootRecord.requestId)!.continuationCount, 2);
    const second = (await managementMessages(api, root.conversationId))
      .find((message) => message.role === "user" && message.requestId === `continuation-${rootRecord.requestId}-2`);
    assert.ok(second);
    assert.match(second!.content, new RegExp(`Drafts \\[[^\\]]+\\] — Chat ${child.conversationId}, task ${answered.continuation.taskId}`));
    assert.doesNotMatch(second!.content, /waiting on/, "the answered question is not owed any more");
    assert.doesNotMatch(second!.content, /Reviews \[/, "a child that settled before the fold's last turn ended is not narrated again");
    await h.release(api.requests.get(rootRecord.requestId)!.turns[2]!.taskId);
    await settled(api, workFoldManagementScopeId, api.requests.get(rootRecord.requestId)!.turns[2]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 3);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("an answer past the request's window is refused by name, and --to parent on a root reaches the person", async (t) => {
  const h = await collaborationHarness(t);
  let clock = new Date();
  const requestStore = await WorkFoldRequestStore.open({ rootPath: join(h.stateBase, "requests"), now: () => clock });
  const api = await h.open({ requestStore });
  try {
    const space = await api.actFacade.createSpace({ name: "Solo" });
    h.held.add(space.space.id);
    const own = await api.actFacade.sendMessage({ space: space.space.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ space: space.space.id, taskId: own.taskId, question: "Proceed?", respondent: "parent" });
    assert.equal(asked.redirectedToPerson, true, "a root has nothing above it, so the question reaches the person");
    assert.equal(asked.question.respondent, "person");
    await h.release(own.taskId);
    await settled(api, space.space.id, own.taskId);
    assert.equal((await api.actFacade.turnStatus({ space: space.space.id, taskId: own.taskId })).waiting?.questionId, asked.question.questionId);

    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    await assert.rejects(
      () => api.actFacade.chatAnswer({ space: space.space.id, questionId: asked.question.questionId, answer: "Yes" }),
      conflict(/Settings → The fold → Limits/),
    );
    assert.equal(api.requests.question(asked.question.questionId)!.state, "open", "a refused answer changes nothing; the sweep owns expiry");
    assert.equal(api.requests.byTaskId(own.taskId)!.turns.length, 1, "no continuation was started");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("a root Stop closes every open question below it, refuses a late answer, and starts no continuation", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldManagementScopeId);
  try {
    const space = await api.actFacade.createSpace({ name: "Stopped" });
    h.held.add(space.space.id);
    const root = await api.actFacade.manageSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ space: space.space.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const asked = await api.actFacade.chatAsk({ space: space.space.id, taskId: child.taskId, question: "Which one?", respondent: "person" });
    await h.release(child.taskId);
    await settled(api, space.space.id, child.taskId);
    const rootRecord = api.requests.byTaskId(root.taskId)!;

    const stopped = await api.actFacade.manageStop({ taskId: root.taskId });
    assert.equal(stopped.managementAborted, true);
    await h.release(root.taskId);
    await settled(api, workFoldManagementScopeId, root.taskId);
    assert.equal(api.requests.question(asked.question.questionId)!.state, "cancelled");
    assert.equal((await api.actFacade.turnStatus({ space: space.space.id, taskId: child.taskId })).waiting, null, "a withdrawn question is not owed");
    await assert.rejects(
      () => api.actFacade.chatAnswer({ space: space.space.id, questionId: asked.question.questionId, answer: "/hold" }),
      conflict(/stopped/),
    );
    const after = api.requests.get(rootRecord.requestId)!;
    assert.ok(after.stopRequestedAt);
    assert.equal(after.state, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 1, "no continuation after a root Stop");
    assert.equal(api.requests.get(rootRecord.requestId)!.continuationCount, 0);

    // A stop that finds nothing running still closes an open question.
    h.held.delete(workFoldManagementScopeId);
    const quiet = await api.actFacade.manageSend({ content: "/hold", newConversation: true });
    await settled(api, workFoldManagementScopeId, quiet.taskId);
    const quietChild = await api.actFacade.sendMessage({ space: space.space.id, newConversation: true, content: "/hold" });
    const quietQuestion = await api.actFacade.chatAsk({ space: space.space.id, taskId: quietChild.taskId, question: "Still there?", respondent: "person" });
    await h.release(quietChild.taskId);
    await settled(api, space.space.id, quietChild.taskId);
    const stoppedQuiet = await api.actFacade.manageStop({ taskId: quietChild.taskId });
    assert.equal(stoppedQuiet.managementAborted, false);
    assert.equal(api.requests.question(quietQuestion.question.questionId)!.state, "cancelled");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("continuations can be turned off, the settle is still recorded, and a restart never starts one", async (t) => {
  const h = await collaborationHarness(t);
  let api = await h.open();
  h.held.add(workFoldManagementScopeId);
  let rootRequestId: string;
  let rootConversationId: string;
  let spaceId: string;
  try {
    await api.requests.setContinuationsEnabled(false);
    const space = await api.actFacade.createSpace({ name: "Quiet" });
    spaceId = space.space.id;
    h.held.add(space.space.id);
    const root = await api.actFacade.manageSend({ content: "/hold" });
    rootConversationId = root.conversationId;
    const child = await api.actFacade.sendMessage({ space: space.space.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    rootRequestId = api.requests.byTaskId(root.taskId)!.requestId;
    await api.actFacade.chatReport({ space: space.space.id, taskId: child.taskId, summary: "Done quietly.", files: [], outcome: "succeeded" });
    // The fold's turn ends first, then the child settles: a settle batch the
    // host would narrate, except the setting says not to.
    await h.release(root.taskId);
    await settled(api, workFoldManagementScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, space.space.id, child.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const quiet = api.requests.get(rootRequestId)!;
    assert.equal(quiet.turns.length, 1, "no follow-up turn while the setting is off");
    assert.equal(quiet.continuationCount, 0);
    assert.equal(quiet.state, "done");
    const shown = await api.actFacade.requestsShow({ request: rootRequestId });
    assert.equal(shown.request.childRequests[0]!.resultRecords[0]!.envelope?.summary, "Done quietly.", "the result is recorded regardless");
  } finally {
    h.releaseAll();
    await api.close();
  }

  // Turn the setting back on while the app is closed, and leave a
  // continuation turn of another root interrupted mid-flight in the journals.
  const store = await WorkFoldRequestStore.open({ rootPath: join(h.stateBase, "requests") });
  await store.setContinuationsEnabled(true);
  const turnStore = await WorkFoldTurnStore.create({ stateRoot: h.stateBase });
  const accepted = await turnStore.accept({
    requestId: `continuation-${rootRequestId}-1`,
    requestDigest: createHash("sha256").update("continuation").digest("hex"),
    userMessageId: "message-continuation",
    userMessageCreatedAt: "2026-09-11T12:00:00.000Z",
    spaceId: workFoldManagementScopeId,
    conversationId: rootConversationId,
    actorKind: "system",
  });
  await turnStore.markRunning(accepted.record.turnId);
  await store.joinTurn({ requestId: rootRequestId, taskId: accepted.record.turnId, role: "continuation", content: "work-fold is continuing request." });
  await store.markTurnRunning(accepted.record.turnId);
  await store.flush();

  api = await h.open();
  h.held.delete(workFoldManagementScopeId);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const recovered = api.requests.get(rootRequestId)!;
    assert.equal(recovered.turns.length, 2, "nothing was started at startup");
    assert.equal(recovered.turns[1]!.state, "interrupted", "the mid-flight continuation was settled from the journal, never re-run");
    assert.ok(recovered.reconciledAt);
    const tasks = await api.kernel.getTasks({ kind: "system" });
    assert.equal(tasks.tasks.length, 0, "no turn runs after the restart");

    // A later settle in the same conversation narrates nothing from before
    // the restart: only settles from this run count.
    const later = await api.actFacade.manageSend({ content: "/hold", conversationId: rootConversationId });
    await settled(api, workFoldManagementScopeId, later.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRequestId)!.turns.length, 2, "the pre-restart batch is not replayed");
    assert.equal(api.requests.get(rootRequestId)!.continuationCount, 0);

    // Fresh work in this run is narrated: a new root, a child that settles
    // after the fold's turn ended, one continuation.
    h.held.add(workFoldManagementScopeId);
    h.held.add(spaceId);
    const root = await api.actFacade.manageSend({ content: "/hold", newConversation: true });
    const child = await api.actFacade.sendMessage({ space: spaceId, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    await h.release(root.taskId);
    await settled(api, workFoldManagementScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, spaceId, child.taskId);
    const freshRoot = api.requests.byTaskId(root.taskId)!;
    await waitFor(async () => api.requests.get(freshRoot.requestId)!.turns.length === 2);
    const fold = await managementMessages(api, root.conversationId);
    const brought = fold.find((message) => message.requestId === `continuation-${freshRoot.requestId}-1`);
    assert.ok(brought, "the fresh batch came back as one turn");
    assert.match(brought!.content, /finished without a report/);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("the fold is brought back at most four times per request; later settles are recorded, not narrated", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldManagementScopeId);
  try {
    const space = await api.actFacade.createSpace({ name: "Capped" });
    h.held.add(space.space.id);
    const root = await api.actFacade.manageSend({ content: "/hold" });
    const rootRecord = api.requests.byTaskId(root.taskId)!;
    // Four follow-up turns already counted against this root.
    for (let index = 0; index < 4; index += 1) assert.equal((await api.requests.noteContinuation(rootRecord.requestId)).allowed, true);
    assert.equal((await api.requests.noteContinuation(rootRecord.requestId)).allowed, false);
    const child = await api.actFacade.sendMessage({ space: space.space.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    await api.actFacade.chatReport({ space: space.space.id, taskId: child.taskId, summary: "Fifth.", files: [], outcome: "succeeded" });
    await h.release(root.taskId);
    await settled(api, workFoldManagementScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, space.space.id, child.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const capped = api.requests.get(rootRecord.requestId)!;
    assert.equal(capped.turns.length, 1, "the fifth settle batch is not narrated");
    assert.equal(capped.continuationCount, 4);
    assert.equal(capped.state, "done");
    assert.equal((await api.actFacade.requestsShow({ request: rootRecord.requestId })).request.childRequests[0]!.resultRecords[0]!.envelope?.summary, "Fifth.");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
