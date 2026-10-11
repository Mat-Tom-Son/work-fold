import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeWorkFoldAutomationDeclaration, workFoldAutomationDigest } from "../src/local/automations/automation-declarations.js";
import { existsSync } from "node:fs";
import { appendMessage } from "../src/local/agent/chat-store.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { WorkFoldCliError } from "../src/local/cli/index.js";
import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";
import { listWorkFolderCheckpoints } from "../src/local/history.js";
import { workFoldAgentScopeId } from "../src/local/state-paths.js";

/**
 * Report, ask, answer, handoff, the non-blocking wait, and the root
 * continuation (docs/collaboration-contract.md, F27/F28) through the real
 * local API: a question puts the task in `waiting` without suspending its
 * turn; exactly one answer starts exactly one linked continuation; an answer
 * from the wrong work-folder, past the window, after a stop, or a second time is
 * refused by name; the host brings settled results back to the work-fold agent once per
 * settle batch, within the request's limits, off when the setting says so,
 * never after a root Stop, and never on a restart.
 *
 * Turns are held open with the prompt gate so a test can act inside "its own
 * running turn" and release turns in the order a scenario needs.
 */

interface HeldTurn {
  taskId: string;
  workFolderId: string;
  workFolderTurn?: import("../src/local/agent/work-folder-turn-context.js").PiWorkFolderTurnContext;
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
  const failTasks = new Set<string>();
  // Once a test tears down, no turn is held any more: a continuation the
  // host accepted a moment ago may reach the gate only after the last
  // release, and a held turn would keep `close()` waiting forever.
  let draining = false;
  const open = (overrides: { requestStore?: WorkFoldRequestStore; turnStore?: WorkFoldTurnStore } = {}) => {
    draining = false;
    return startLocalApi({
      port: 0,
      stateBase,
      workFolderBase: join(sandbox, "content"),
      loadEnv: false,
      piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
      beforeAgentPrompt: async (event) => {
        if (draining || !held.has(event.workFolderId)) return;
        await new Promise<void>((release) => pending.push({ taskId: event.taskId, workFolderId: event.workFolderId, workFolderTurn: event.workFolderTurn, release }));
        if (failTasks.has(event.taskId)) throw new Error("Synthetic failed answer continuation");
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
  return { sandbox, stateBase, held, pending, failTasks, open, release, releaseAll };
}

async function settled(api: LocalApiHandle, workFolderId: string, taskId: string): Promise<void> {
  await waitFor(async () => {
    const status = workFolderId === workFoldAgentScopeId
      ? await api.actFacade.agentTurnStatus({ taskId })
      : await api.actFacade.turnStatus({ workFolder: workFolderId, taskId });
    return status.task.state !== "running";
  });
}

async function workFoldAgentMessages(api: LocalApiHandle, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/work-fold-agent/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

async function workFolderMessages(api: LocalApiHandle, workFolderId: string, conversationId: string): Promise<Array<{ role: string; content: string; requestId?: string }>> {
  const response = await fetch(new URL(`/api/work-folders/${workFolderId}/conversations/${conversationId}`, api.origin));
  assert.equal(response.status, 200);
  return (await response.json() as { messages: Array<{ role: string; content: string; requestId?: string }> }).messages;
}

const conflict = (pattern: RegExp) => (error: unknown): boolean =>
  error instanceof WorkFoldCliError && error.code === "conflict" && pattern.test(error.message);

for (const fails of [true, false]) {
  test(`parent delivery uses the latest answer turn when it ${fails ? "fails" : "finishes without a report"}`, async (t) => {
    const h = await collaborationHarness(t);
    const api = await h.open();
    h.held.add(workFoldAgentScopeId);
    try {
      const { workFolder } = await api.actFacade.createWorkFolder({ name: "Reviewer" });
      h.held.add(workFolder.id);
      const root = await api.actFacade.agentSend({ content: "/hold" });
      const child = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
      await writeFile(join(workFolder.workFolderRoot, "old.txt"), "Old deliverable\n");
      await api.actFacade.chatReport({ workFolder: workFolder.id, taskId: child.taskId, summary: "STALE SUCCESS REPORT", outcome: "succeeded", files: ["old.txt"] });
      const asked = await api.actFacade.chatAsk({ workFolder: workFolder.id, taskId: child.taskId, question: "Which quarter?", respondent: "person" });
      await h.release(child.taskId);
      await settled(api, workFolder.id, child.taskId);
      const answer = await api.actFacade.chatAnswer({ workFolder: workFolder.id, questionId: asked.question.questionId, answer: "/hold" });
      if (fails) h.failTasks.add(answer.continuation.taskId);
      await h.release(answer.continuation.taskId);
      await settled(api, workFolder.id, answer.continuation.taskId);
      assert.equal(api.requests.byTaskId(child.taskId)!.state, fails ? "failed" : "done");
      await h.release(root.taskId);
      await settled(api, workFoldAgentScopeId, root.taskId);
      const requestId = api.requests.byTaskId(root.taskId)!.requestId;
      await waitFor(async () => api.requests.get(requestId)!.turns.length === 2);
      const delivered = api.requests.get(requestId)!;
      assert.match(delivered.content, fails ? /failed: The agent couldn’t complete this request/ : /finished without a report/);
      assert.doesNotMatch(delivered.content, /STALE SUCCESS REPORT|old\.txt/);
      assert.deepEqual(delivered.deliveredChildTaskIds, [answer.continuation.taskId]);
      assert.equal(api.requests.byTaskId(child.taskId)!.results.length, 1, "the earlier report remains historical");
    } finally {
      h.releaseAll();
      await api.close();
    }
  });
}

for (const lane of ["act", "http", "failed-act"] as const) {
  test(`a child settled during ${lane} compaction is delivered once after the Chat is released`, async (t) => {
    const h = await collaborationHarness(t);
    const api = await h.open();
    const originalCompact = PiConversationClient.prototype.compact;
    let releaseCompact: (() => void) | undefined;
    let compactStarted: () => void;
    const started = new Promise<void>((resolve) => { compactStarted = resolve; });
    PiConversationClient.prototype.compact = async () => {
      compactStarted();
      await new Promise<void>((resolve) => { releaseCompact = resolve; });
      if (lane === "failed-act") throw new Error("Synthetic compaction failure");
    };
    try {
      const { workFolder: parentWorkFolder } = await api.actFacade.createWorkFolder({ name: "Coordinator" });
      const { workFolder: childWorkFolder } = await api.actFacade.createWorkFolder({ name: "Child" });
      h.held.add(parentWorkFolder.id);
      h.held.add(childWorkFolder.id);
      const parent = await api.actFacade.sendMessage({ workFolder: parentWorkFolder.id, newConversation: true, content: "/hold" });
      const child = await api.actFacade.chatHandoff({ workFolder: parentWorkFolder.id, taskId: parent.taskId, toWorkFolder: childWorkFolder.id, message: "/hold", files: [] });
      await api.actFacade.chatReport({ workFolder: childWorkFolder.id, taskId: child.taskId, summary: "Fresh fact for the coordinator", outcome: "succeeded", files: [] });
      await h.release(parent.taskId);
      await settled(api, parentWorkFolder.id, parent.taskId);
      const compact = lane === "http"
        ? fetch(`${api.origin}/api/work-folders/${parentWorkFolder.id}/conversations/${parent.conversationId}/compact`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((response) => assert.equal(response.status, 200))
        : api.actFacade.chatCompact({ workFolder: parentWorkFolder.id, conversationId: parent.conversationId }).then(
          () => assert.notEqual(lane, "failed-act"),
          (error) => { assert.equal(lane, "failed-act"); assert.match(String(error), /Synthetic compaction failure/); },
        );
      await started;
      await h.release(child.taskId);
      await settled(api, childWorkFolder.id, child.taskId);
      const requestId = api.requests.byTaskId(parent.taskId)!.requestId;
      assert.equal(api.requests.get(requestId)!.turns.length, 1, "compaction still holds the Chat");
      releaseCompact!();
      await compact;
      await waitFor(async () => api.requests.get(requestId)!.turns.length === 2);
      const continuation = api.requests.get(requestId)!;
      assert.deepEqual(continuation.deliveredChildTaskIds, [child.taskId]);
      assert.match(continuation.content, /succeeded: Fresh fact for the coordinator/);
      await h.release(continuation.turns.at(-1)!.taskId);
      await settled(api, parentWorkFolder.id, continuation.turns.at(-1)!.taskId);
      assert.equal(api.requests.get(requestId)!.turns.length, 2);
    } finally {
      releaseCompact?.();
      PiConversationClient.prototype.compact = originalCompact;
      h.releaseAll();
      await api.close();
    }
  });
}

test("file and work-folder deletion refuse running, waiting, and stopped-but-draining work until it settles", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  try {
    const { workFolder } = await api.actFacade.createWorkFolder({ name: "Busy folder" });
    h.held.add(workFolder.id);
    await writeFile(join(workFolder.workFolderRoot, "keep.txt"), "Keep this until settled\n");
    const assertRefused = async () => {
      const checkpoints = JSON.stringify(await listWorkFolderCheckpoints(workFolder.workFolderRoot));
      for (const [path, body] of [
        [`/api/work-folders/${workFolder.id}/local-file`, { path: "keep.txt" }],
        [`/api/work-folders/${workFolder.id}`, undefined],
      ] as const) {
        const response = await fetch(`${api.origin}${path}`, { method: "DELETE", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
        assert.equal(response.status, 409, await response.text());
      }
      await assert.rejects(() => api.actFacade.filesDelete({ workFolder: workFolder.id, path: "keep.txt" }), conflict(/finish|stop|work/i));
      assert.equal(await readFile(join(workFolder.workFolderRoot, "keep.txt"), "utf8"), "Keep this until settled\n");
      assert.equal(JSON.stringify(await listWorkFolderCheckpoints(workFolder.workFolderRoot)), checkpoints, "refusal leaves no checkpoint");
      assert.equal((await api.recentlyDeleted.list()).entries.length, 0);
    };
    const first = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/hold" });
    await waitFor(async () => h.pending.some((turn) => turn.taskId === first.taskId));
    await assertRefused();
    // Busy work in this folder does not block deletion in another folder.
    const { workFolder: other } = await api.actFacade.createWorkFolder({ name: "Idle folder" });
    await writeFile(join(other.workFolderRoot, "remove.txt"), "Idle\n");
    assert.equal((await api.actFacade.filesDelete({ workFolder: other.id, path: "remove.txt" })).deleted, true);
    // Remove the unrelated recovery reference from the assertions below.
    const recentlyDeletedBefore = (await api.recentlyDeleted.list()).entries.length;
    assert.equal(recentlyDeletedBefore, 0, "ordinary small files are covered by History");
    const question = await api.actFacade.chatAsk({ workFolder: workFolder.id, taskId: first.taskId, question: "Which draft?", respondent: "person" });
    await h.release(first.taskId);
    await settled(api, workFolder.id, first.taskId);
    assert.equal(api.requests.byTaskId(first.taskId)!.state, "waiting");
    await assertRefused();
    const answer = await api.actFacade.chatAnswer({ workFolder: workFolder.id, questionId: question.question.questionId, answer: "/hold" });
    await waitFor(async () => h.pending.some((turn) => turn.taskId === answer.continuation.taskId));
    const stopped = await fetch(`${api.origin}/api/work-folders/${workFolder.id}/conversations/${first.conversationId}/abort`, { method: "POST" });
    assert.equal(stopped.status, 200);
    assert.equal(api.requests.byTaskId(first.taskId)!.state, "stopped");
    await assertRefused();
    await h.release(answer.continuation.taskId);
    await settled(api, workFolder.id, answer.continuation.taskId);
    assert.equal((await api.actFacade.filesDelete({ workFolder: workFolder.id, path: "keep.txt" })).deleted, true);
    const removed = await fetch(`${api.origin}/api/work-folders/${workFolder.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal(existsSync(workFolder.workFolderRoot), false);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("chat ask puts the task in waiting without suspending its turn, and chat answer continues it exactly once and brings the result back to the work-fold agent", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    const drafts = await api.actFacade.createWorkFolder({ name: "Drafts" });
    const reviews = await api.actFacade.createWorkFolder({ name: "Reviews" });
    h.held.add(drafts.workFolder.id);
    await writeFile(join(drafts.workFolder.workFolderRoot, "draft.md"), "# Draft\n", "utf8");

    // The work-fold agent hands work to Drafts while its own turn runs.
    const root = await api.actFacade.agentSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ workFolder: drafts.workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const rootRecord = api.requests.byTaskId(root.taskId)!;

    // Inside its running turn the child reports, asks, and hands on.
    const reported = await api.actFacade.chatReport({
      workFolder: drafts.workFolder.id,
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

    const asked = await api.actFacade.chatAsk({ workFolder: drafts.workFolder.id, taskId: child.taskId, question: "Which quarter?", respondent: "parent" });
    assert.equal(asked.redirectedToPerson, false, "a child has a parent, so --to parent stays with the parent");
    assert.equal(asked.question.respondent, "parent");
    assert.equal(asked.request.state, "waiting", "asking puts the request in waiting at once");

    // The turn still runs; the status says the task is waiting and on what.
    const live = await api.actFacade.turnStatus({ workFolder: drafts.workFolder.id, taskId: child.taskId });
    assert.equal(live.task.state, "running");
    assert.equal(live.waiting?.questionId, asked.question.questionId);
    assert.equal(live.waiting?.question, "Which quarter?");
    assert.equal(live.request?.state, "waiting");

    // Both fields are scoped to the named work-folder. A task id is easy to come by,
    // and `waiting` carries the question text an agent wrote, so a caller
    // naming a work-folder that does not own the task learns nothing about it
    // (F9 as amended, F26).
    const foreign = await api.actFacade.turnStatus({ workFolder: reviews.workFolder.id, taskId: child.taskId });
    assert.equal(foreign.task.state, "unknown");
    assert.equal(foreign.request, null);
    assert.equal(foreign.waiting, null, "another work-folder's open question never reaches this caller");
    const parentView = await api.actFacade.agentTurnStatus({ taskId: root.taskId });
    assert.equal(parentView.waiting, null, "the work-fold agent asked nothing itself");
    assert.equal(parentView.requestGraph?.state, "working", "the work-fold agent's own turn is still running, so it is working, not waiting");

    const handed = await api.actFacade.chatHandoff({
      workFolder: drafts.workFolder.id,
      taskId: child.taskId,
      toWorkFolder: reviews.workFolder.id,
      message: "/hold",
      files: ["draft.md"],
    });
    assert.deepEqual(handed.copied, ["draft.md"]);
    assert.ok(handed.checkpointId, "the copy landed with a restore point in the destination");
    // The handoff IS a child of the work-fold agent's root, but a work-folder-scoped verb never
    // hands that id back: `requests show` reads a request by id, so the real
    // root id would put the work-fold agent's own content and every work-folder's result one
    // taught command away. It is projected through the same opaque handle the
    // work-folder turn context uses, which no verb accepts.
    assert.equal(api.requests.byTaskId(handed.taskId)!.rootId, rootRecord.requestId, "the handoff is a child of the caller's root");
    assert.notEqual(handed.request.rootId, rootRecord.requestId);
    assert.match(handed.request.rootId, /^parent-[0-9a-f]{16}$/);
    await assert.rejects(
      () => api.actFacade.requestsShow({ request: handed.request.rootId }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "notFound",
    );
    assert.equal(handed.request.depth, 2);
    await assert.rejects(
      () => api.actFacade.chatHandoff({ workFolder: drafts.workFolder.id, taskId: child.taskId, toWorkFolder: drafts.workFolder.id, message: "/hold", files: ["draft.md"] }),
      (error: unknown) => error instanceof WorkFoldCliError && error.code === "usage" && /already there/.test(error.message),
    );

    // A wrong task id is refused by name before anything is recorded.
    await assert.rejects(
      () => api.actFacade.chatReport({ workFolder: reviews.workFolder.id, taskId: child.taskId, summary: "Nope.", files: [], outcome: "succeeded" }),
      conflict(/another work-folder's turn/),
    );

    // The work-fold agent's own turn ends first. Its request now reads the descendant's
    // open question as waiting, while the child's turn is still running.
    await h.release(root.taskId);
    await settled(api, workFoldAgentScopeId, root.taskId);
    assert.equal((await api.actFacade.agentTurnStatus({ taskId: root.taskId })).requestGraph?.state, "waiting");

    // The child's turn and the handoff's turn end. The request keeps waiting
    // on its question; the settled turn still reports it.
    await h.release(child.taskId);
    await settled(api, drafts.workFolder.id, child.taskId);
    await settled(api, reviews.workFolder.id, handed.taskId);
    const ended = await api.actFacade.turnStatus({ workFolder: drafts.workFolder.id, taskId: child.taskId });
    assert.equal(ended.task.state, "succeeded");
    assert.equal(ended.waiting?.questionId, asked.question.questionId, "a settled turn still reports its open question");

    // The whole story is one read.
    const shown = await api.actFacade.requestsShow({ request: rootRecord.requestId });
    assert.equal(shown.request.childRequests.length, 1);
    assert.equal(shown.request.childRequests[0]!.workFolderName, "Drafts");
    assert.equal(shown.request.childRequests[0]!.resultRecords[0]!.envelope?.summary, "Drafted draft.md from the brief.");
    assert.equal(shown.request.childRequests[0]!.questions[0]!.text, "Which quarter?");
    assert.equal(shown.request.childRequests[0]!.childRequests[0]!.workFolderName, "Reviews");
    const listed = await api.actFacade.requestsList();
    assert.ok(listed.requests.some((request) => request.id === rootRecord.requestId));
    assert.ok(listed.requests.every((request) => request.id === request.rootId), "list shows roots only");

    // Every child has settled after the work-fold agent's own turn ended: the host
    // brings the batch back exactly once, including the question the child
    // put to the work-fold agent and how to answer it.
    await waitFor(async () => api.requests.get(rootRecord.requestId)!.turns.length === 2);
    const continued = api.requests.get(rootRecord.requestId)!;
    assert.equal(continued.continuationCount, 1);
    assert.equal(continued.turns[1]!.role, "continuation");
    // Joining the request precedes the asynchronous transcript write. Wait
    // for this exact turn's prompt gate before inspecting its saved message.
    await waitFor(async () => h.pending.some((turn) => turn.taskId === continued.turns[1]!.taskId));
    const first = (await workFoldAgentMessages(api, root.conversationId))
      .filter((message) => message.role === "user" && message.requestId === `continuation-${rootRecord.requestId}-1`);
    assert.equal(first.length, 1);
    assert.match(first[0]!.content, /work-fold is continuing request/);
    assert.match(first[0]!.content, /Nobody typed this message/);
    assert.match(first[0]!.content, /Drafts \[/);
    assert.match(first[0]!.content, /partial: Drafted draft\.md from the brief\./);
    assert.match(first[0]!.content, /files: draft\.md/);
    assert.doesNotMatch(first[0]!.content, /Reviews \[/, "delivery contains direct children only");
    assert.match(first[0]!.content, new RegExp(`waiting on you: question ${asked.question.questionId} — Which quarter\\?`));
    assert.match(first[0]!.content, new RegExp(`answer it with: work-fold chat answer --work-folder ${drafts.workFolder.id} --question ${asked.question.questionId}`));
    // That continuation turn ends (no model here). Nothing settled after it,
    // so nothing follows it: a continuation never continues itself.
    await h.release(continued.turns[1]!.taskId);
    await settled(api, workFoldAgentScopeId, continued.turns[1]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 2);

    // An answer from a work-folder that does not own the question is refused and
    // names the owner; the answer from the owning work-folder continues the Chat
    // once, and only once.
    await assert.rejects(
      () => api.actFacade.chatAnswer({ workFolder: reviews.workFolder.id, questionId: asked.question.questionId, answer: "Q3" }),
      conflict(/belongs to Drafts/),
    );
    const answered = await api.actFacade.chatAnswer({ workFolder: drafts.workFolder.id, questionId: asked.question.questionId, answer: "/hold" });
    assert.equal(answered.question.state, "answered");
    assert.equal(answered.question.continuationTaskId, answered.continuation.taskId);
    assert.equal(answered.continuation.conversationId, child.conversationId, "the continuation is a new turn in the same Chat");
    await assert.rejects(
      () => api.actFacade.chatAnswer({ workFolder: drafts.workFolder.id, questionId: asked.question.questionId, answer: "/hold" }),
      conflict(/already has an answer/),
    );
    const transcript = await workFolderMessages(api, drafts.workFolder.id, child.conversationId);
    const answers = transcript.filter((message) => message.role === "user" && message.requestId === `answer-${asked.question.questionId}`);
    assert.equal(answers.length, 1, "exactly one continuation message, keyed by the question");
    assert.equal(answers[0]!.content, "/hold", "the answer is an ordinary user message; the question id stays machine-local");
    assert.equal(api.requests.byTaskId(answered.continuation.taskId)!.requestId, api.requests.byTaskId(child.taskId)!.requestId, "the continuation joined the child's request");
    assert.equal((await api.actFacade.turnStatus({ workFolder: drafts.workFolder.id, taskId: child.taskId })).waiting, null, "an answered question is not owed");

    // The answered child's continuation settles after the work-fold agent's last turn
    // ended: a second batch, a second continuation, no open question in it.
    await h.release(answered.continuation.taskId);
    await settled(api, drafts.workFolder.id, answered.continuation.taskId);
    await waitFor(async () => api.requests.get(rootRecord.requestId)!.turns.length === 3);
    assert.equal(api.requests.get(rootRecord.requestId)!.continuationCount, 2);
    await waitFor(async () => h.pending.some((turn) => turn.taskId === api.requests.get(rootRecord.requestId)!.turns[2]!.taskId));
    const second = (await workFoldAgentMessages(api, root.conversationId))
      .find((message) => message.role === "user" && message.requestId === `continuation-${rootRecord.requestId}-2`);
    assert.ok(second);
    assert.match(second!.content, new RegExp(`Drafts \\[[^\\]]+\\] — Chat ${child.conversationId}, task ${answered.continuation.taskId}`));
    assert.doesNotMatch(second!.content, /waiting on/, "the answered question is not owed any more");
    assert.doesNotMatch(second!.content, /Reviews \[/, "a child that settled before the work-fold agent's last turn ended is not narrated again");
    await h.release(api.requests.get(rootRecord.requestId)!.turns[2]!.taskId);
    await settled(api, workFoldAgentScopeId, api.requests.get(rootRecord.requestId)!.turns[2]!.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 3);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("a question remains answerable after 24 hours, and --to parent on a root reaches the person", async (t) => {
  const h = await collaborationHarness(t);
  let clock = new Date();
  const requestStore = await WorkFoldRequestStore.open({ rootPath: join(h.stateBase, "requests"), now: () => clock });
  const api = await h.open({ requestStore });
  try {
    const workFolder = await api.actFacade.createWorkFolder({ name: "Solo" });
    h.held.add(workFolder.workFolder.id);
    const own = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ workFolder: workFolder.workFolder.id, taskId: own.taskId, question: "Proceed?", respondent: "parent" });
    assert.equal(asked.redirectedToPerson, true, "a root has nothing above it, so the question reaches the person");
    assert.equal(asked.question.respondent, "person");
    await h.release(own.taskId);
    await settled(api, workFolder.workFolder.id, own.taskId);
    assert.equal((await api.actFacade.turnStatus({ workFolder: workFolder.workFolder.id, taskId: own.taskId })).waiting?.questionId, asked.question.questionId);

    clock = new Date(clock.getTime() + 25 * 60 * 60 * 1000);
    const answered = await api.actFacade.chatAnswer({ workFolder: workFolder.workFolder.id, questionId: asked.question.questionId, answer: "Yes" });
    assert.ok(answered);
    assert.equal(api.requests.question(asked.question.questionId)!.state, "answered");
    assert.equal(api.requests.byTaskId(own.taskId)!.turns.length, 2, "an answer continues without a fixed lifetime");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("a root Stop closes every open question below it, refuses a late answer, and starts no continuation", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    const workFolder = await api.actFacade.createWorkFolder({ name: "Stopped" });
    h.held.add(workFolder.workFolder.id);
    const root = await api.actFacade.agentSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const asked = await api.actFacade.chatAsk({ workFolder: workFolder.workFolder.id, taskId: child.taskId, question: "Which one?", respondent: "person" });
    await h.release(child.taskId);
    await settled(api, workFolder.workFolder.id, child.taskId);
    const rootRecord = api.requests.byTaskId(root.taskId)!;

    const stopped = await api.actFacade.agentStop({ taskId: root.taskId });
    assert.equal(stopped.workFoldAgentAborted, true);
    await h.release(root.taskId);
    await settled(api, workFoldAgentScopeId, root.taskId);
    assert.equal(api.requests.question(asked.question.questionId)!.state, "cancelled");
    assert.equal((await api.actFacade.turnStatus({ workFolder: workFolder.workFolder.id, taskId: child.taskId })).waiting, null, "a withdrawn question is not owed");
    await assert.rejects(
      () => api.actFacade.chatAnswer({ workFolder: workFolder.workFolder.id, questionId: asked.question.questionId, answer: "/hold" }),
      conflict(/stopped/),
    );
    const after = api.requests.get(rootRecord.requestId)!;
    assert.ok(after.stopRequestedAt);
    assert.equal(after.state, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRecord.requestId)!.turns.length, 1, "no continuation after a root Stop");
    assert.equal(api.requests.get(rootRecord.requestId)!.continuationCount, 0);

    // A stop that finds nothing running still closes an open question.
    h.held.delete(workFoldAgentScopeId);
    const quiet = await api.actFacade.agentSend({ content: "/hold", newConversation: true });
    await settled(api, workFoldAgentScopeId, quiet.taskId);
    const quietChild = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold" });
    const quietQuestion = await api.actFacade.chatAsk({ workFolder: workFolder.workFolder.id, taskId: quietChild.taskId, question: "Still there?", respondent: "person" });
    await h.release(quietChild.taskId);
    await settled(api, workFolder.workFolder.id, quietChild.taskId);
    const stoppedQuiet = await api.actFacade.agentStop({ taskId: quietChild.taskId });
    assert.equal(stoppedQuiet.workFoldAgentAborted, false);
    assert.equal(api.requests.question(quietQuestion.question.questionId)!.state, "cancelled");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("a stop on a mid-graph request closes everything it handed on, not only itself", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    const middle = await api.actFacade.createWorkFolder({ name: "Middle" });
    const leaf = await api.actFacade.createWorkFolder({ name: "Leaf" });
    h.held.add(middle.workFolder.id);
    h.held.add(leaf.workFolder.id);

    // fold -> Middle -> Leaf. `agent stop` takes any task id, and a request
    // below a root records the ROOT's id, never its parent's, so a stop that
    // only looked at the root's own family would close Middle and leave Leaf
    // running with its question still open (F25).
    const root = await api.actFacade.agentSend({ content: "/hold" });
    const child = await api.actFacade.sendMessage({ workFolder: middle.workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    const handed = await api.actFacade.chatHandoff({
      workFolder: middle.workFolder.id,
      taskId: child.taskId,
      toWorkFolder: leaf.workFolder.id,
      message: "/hold",
      files: [],
    });
    const asked = await api.actFacade.chatAsk({ workFolder: leaf.workFolder.id, taskId: handed.taskId, question: "Which ledger?", respondent: "person" });
    const childRequestId = api.requests.byTaskId(child.taskId)!.requestId;
    const leafRequestId = api.requests.byTaskId(handed.taskId)!.requestId;

    const stopped = await api.actFacade.agentStop({ taskId: child.taskId });
    assert.equal(stopped.taskId, child.taskId);
    assert.equal(stopped.workFoldAgentAborted, true, "the named request's own turn is cancelled");
    assert.ok(stopped.children.some((item) => item.taskId === handed.taskId && item.workFolderId === leaf.workFolder.id),
      "the stop reached the turn the mid-graph request handed on");
    assert.equal(api.requests.question(asked.question.questionId)!.state, "cancelled");
    assert.ok(api.requests.get(leafRequestId)!.stopRequestedAt, "the request below the stopped one is marked too");
    await assert.rejects(
      () => api.actFacade.chatAnswer({ workFolder: leaf.workFolder.id, questionId: asked.question.questionId, answer: "/hold" }),
      conflict(/stopped/),
    );

    await h.release(handed.taskId);
    await settled(api, leaf.workFolder.id, handed.taskId);
    await h.release(child.taskId);
    await settled(api, middle.workFolder.id, child.taskId);
    assert.equal(api.requests.get(childRequestId)!.state, "stopped");
    assert.equal(api.requests.get(leafRequestId)!.state, "stopped");
    // Only the named request and the graph below it are stopped: the work-fold agent's
    // own turn above it is untouched.
    assert.equal((await api.actFacade.agentTurnStatus({ taskId: root.taskId })).task.state, "running");
    assert.equal(api.requests.byTaskId(root.taskId)!.stopRequestedAt, null);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("continuations can be turned off, the settle is still recorded, and a restart never starts one", async (t) => {
  const h = await collaborationHarness(t);
  let api = await h.open();
  h.held.add(workFoldAgentScopeId);
  let rootRequestId: string;
  let rootConversationId: string;
  let workFolderId: string;
  try {
    await api.requests.setContinuationsEnabled(false);
    const workFolder = await api.actFacade.createWorkFolder({ name: "Quiet" });
    workFolderId = workFolder.workFolder.id;
    h.held.add(workFolder.workFolder.id);
    const root = await api.actFacade.agentSend({ content: "/hold" });
    rootConversationId = root.conversationId;
    const child = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    rootRequestId = api.requests.byTaskId(root.taskId)!.requestId;
    await api.actFacade.chatReport({ workFolder: workFolder.workFolder.id, taskId: child.taskId, summary: "Done quietly.", files: [], outcome: "succeeded" });
    // The work-fold agent's turn ends first, then the child settles: a settle batch the
    // host would narrate, except the setting says not to.
    await h.release(root.taskId);
    await settled(api, workFoldAgentScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, workFolder.workFolder.id, child.taskId);
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
    workFolderId: workFoldAgentScopeId,
    conversationId: rootConversationId,
    actorKind: "system",
  });
  await turnStore.markRunning(accepted.record.turnId);
  await store.joinTurn({ requestId: rootRequestId, taskId: accepted.record.turnId, role: "continuation", content: "work-fold is continuing request." });
  await store.markTurnRunning(accepted.record.turnId);
  await store.flush();

  api = await h.open();
  h.held.delete(workFoldAgentScopeId);
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
    const later = await api.actFacade.agentSend({ content: "/hold", conversationId: rootConversationId });
    await settled(api, workFoldAgentScopeId, later.taskId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(api.requests.get(rootRequestId)!.turns.length, 2, "the pre-restart batch is not replayed");
    assert.equal(api.requests.get(rootRequestId)!.continuationCount, 0);

    // Fresh work in this run is narrated: a new root, a child that settles
    // after the work-fold agent's turn ended, one continuation.
    h.held.add(workFoldAgentScopeId);
    h.held.add(workFolderId);
    const root = await api.actFacade.agentSend({ content: "/hold", newConversation: true });
    const child = await api.actFacade.sendMessage({ workFolder: workFolderId, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    await h.release(root.taskId);
    await settled(api, workFoldAgentScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, workFolderId, child.taskId);
    const freshRoot = api.requests.byTaskId(root.taskId)!;
    await waitFor(async () => api.requests.get(freshRoot.requestId)!.turns.length === 2);
    const continuation = api.requests.get(freshRoot.requestId)!.turns[1]!;
    // Request reservation precedes transcript persistence. The prompt gate
    // proves this continuation's message has landed before we read it back.
    await waitFor(async () => h.pending.some((turn) => turn.taskId === continuation.taskId));
    const fold = await workFoldAgentMessages(api, root.conversationId);
    const brought = fold.find((message) => message.requestId === `continuation-${freshRoot.requestId}-1`);
    assert.ok(brought, "the fresh batch came back as one turn");
    assert.match(brought!.content, /finished without a report/);
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("the work-fold agent continues after more than four settle batches", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    const workFolder = await api.actFacade.createWorkFolder({ name: "Capped" });
    h.held.add(workFolder.workFolder.id);
    const root = await api.actFacade.agentSend({ content: "/hold" });
    const rootRecord = api.requests.byTaskId(root.taskId)!;
    // Four follow-up turns already counted against this root.
    for (let index = 0; index < 4; index += 1) assert.equal((await api.requests.noteContinuation(rootRecord.requestId)).allowed, true);
    assert.equal((await api.requests.noteContinuation(rootRecord.requestId)).allowed, true);
    const child = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold", parentTaskId: root.taskId });
    await api.actFacade.chatReport({ workFolder: workFolder.workFolder.id, taskId: child.taskId, summary: "Fifth.", files: [], outcome: "succeeded" });
    await h.release(root.taskId);
    await settled(api, workFoldAgentScopeId, root.taskId);
    await h.release(child.taskId);
    await settled(api, workFolder.workFolder.id, child.taskId);
    await waitFor(async () => api.requests.get(rootRecord.requestId)!.turns.length === 2);
    const capped = api.requests.get(rootRecord.requestId)!;
    assert.equal(capped.turns.length, 2, "later settle batches still start a follow-up");
    assert.equal(capped.continuationCount, 6);
    assert.equal(capped.state, "working");
    assert.equal((await api.actFacade.requestsShow({ request: rootRecord.requestId })).request.childRequests[0]!.resultRecords[0]!.envelope?.summary, "Fifth.");
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("an answer whose continuation could not start is recorded once and resumes on the next try", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  try {
    const workFolder = await api.actFacade.createWorkFolder({ name: "Recover" });
    h.held.add(workFolder.workFolder.id);
    const own = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ workFolder: workFolder.workFolder.id, taskId: own.taskId, question: "Proceed?", respondent: "person" });
    await h.release(own.taskId);
    await settled(api, workFolder.workFolder.id, own.taskId);

    // `chat answer` journals the answer and then starts its continuation, so
    // "answered with no follow-up" is reachable — a turn that started in that
    // Chat in between, or a crash across the pair. Recorded directly here,
    // because both races are host-internal.
    await api.requests.answer({ questionId: asked.question.questionId, answer: "Yes, Q3.", answeredByWorkFolderId: workFolder.workFolder.id });
    const stranded = api.requests.question(asked.question.questionId)!;
    assert.equal(stranded.state, "answered");
    assert.equal(stranded.continuationTaskId, null, "the continuation never started");
    assert.equal(api.requests.byTaskId(own.taskId)!.turns.length, 1);

    // Sending the answer again picks up from exactly there rather than
    // refusing it: one continuation, carrying the text already on record.
    const resumed = await api.actFacade.chatAnswer({ workFolder: workFolder.workFolder.id, questionId: asked.question.questionId, answer: "Ignored; the record stands." });
    assert.equal(resumed.question.continuationTaskId, resumed.continuation.taskId);
    assert.equal(resumed.question.answer, "Yes, Q3.");
    const transcript = await workFolderMessages(api, workFolder.workFolder.id, own.conversationId);
    const answers = transcript.filter((message) => message.role === "user" && message.requestId === `answer-${asked.question.questionId}`);
    assert.equal(answers.length, 1, "exactly one continuation message");
    assert.equal(answers[0]!.content, "Yes, Q3.", "the Chat gets the answer the record holds");
    assert.equal(api.requests.byTaskId(own.taskId)!.turns.length, 2);

    // Once it has its continuation, a further answer is a second answer again.
    await assert.rejects(
      () => api.actFacade.chatAnswer({ workFolder: workFolder.workFolder.id, questionId: asked.question.questionId, answer: "Actually Q4." }),
      conflict(/already has an answer/),
    );
  } finally {
    h.releaseAll();
    await api.close();
  }
});

test("the request graph is a management-scope read and is refused from inside a work-folder", async (t) => {
  const h = await collaborationHarness(t);
  const api = await h.open();
  try {
    const workFolder = await api.actFacade.createWorkFolder({ name: "Inside" });
    const own = await api.actFacade.sendMessage({ workFolder: workFolder.workFolder.id, newConversation: true, content: "/hold" });
    await settled(api, workFolder.workFolder.id, own.taskId);
    const requestId = api.requests.byTaskId(own.taskId)!.requestId;

    // The work-fold agent and an outside harness read the graph; a caller whose own
    // directory is a registered work-folder is inside that work-folder's scope, and the
    // graph carries every work-folder's results (F9 as amended).
    assert.ok((await api.actFacade.requestsList()).requests.length >= 1);
    assert.equal((await api.actFacade.requestsShow({ request: requestId })).request.id, requestId);
    for (const call of [
      () => api.actFacade.requestsList({ cwd: workFolder.workFolder.workFolderRoot }),
      () => api.actFacade.requestsShow({ request: requestId, cwd: join(workFolder.workFolder.workFolderRoot, "notes") }),
    ]) {
      await assert.rejects(call, (error: unknown) =>
        error instanceof WorkFoldCliError
        && error.code === "permissionDenied"
        && /sits above work-folders/.test(error.message)
        && /"Inside"/.test(error.message));
    }
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

test("an answered continuation keeps its delegated assignment in host context", async t => {
  const h=await collaborationHarness(t); const api=await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    await api.requests.setContinuationsEnabled(false);
    const {workFolder}=await api.actFacade.createWorkFolder({name:"Context review"});h.held.add(workFolder.id);
    const root=await api.actFacade.agentSend({content:"/hold"});
    const child=await api.actFacade.sendMessage({workFolder:workFolder.id,newConversation:true,content:"/hold Compare annual quotes.",parentTaskId:root.taskId});
    const q=await api.actFacade.chatAsk({workFolder:workFolder.id,taskId:child.taskId,question:"Which quarter?",respondent:"person"});
    await h.release(child.taskId);await settled(api,workFolder.id,child.taskId);
    const a=await api.actFacade.chatAnswer({workFolder:workFolder.id,questionId:q.question.questionId,answer:"/hold Q3"});
    await waitFor(async()=>h.pending.some(p=>p.taskId===a.continuation.taskId));
    const context=(h.pending.find(p=>p.taskId===a.continuation.taskId)).workFolderTurn;
    assert.ok(context?.delegated,"the continuing task is still delegated");
    assert.match(JSON.stringify(context), /Compare annual quotes/);
    await h.release(root.taskId); await settled(api,workFoldAgentScopeId,root.taskId);
    assert.equal(api.requests.byTaskId(root.taskId)?.state, "handed_off");
  } finally {h.releaseAll();await api.close();}
});



test("the work-fold agent asks and receives one durable answer through the same lifecycle", async (t) => {
  const h = await collaborationHarness(t); const api = await h.open();
  h.held.add(workFoldAgentScopeId);
  try {
    const principal = { browserId: "question-browser", grantId: "question-grant", requestId: "question-send" };
    const root = await api.remoteFacade.execute("management.send", { content: "/hold", newConversation: true }, principal) as { taskId: string; conversationId: string };
    const asked = await api.actFacade.agentAsk({ taskId: root.taskId, question: "Which quarter?" });
    assert.equal(asked.request.state, "waiting");
    await h.release(root.taskId); await settled(api, workFoldAgentScopeId, root.taskId);
    const ownedList = await api.remoteFacade.execute("management.chats", {}, principal) as { conversations: Array<{ id: string; needsAnswer?: boolean }> };
    assert.equal(ownedList.conversations.find((chat) => chat.id === root.conversationId)?.needsAnswer, true);
    const otherList = await api.remoteFacade.execute("management.chats", {}, { ...principal, grantId: "another-grant" }) as typeof ownedList;
    assert.equal(otherList.conversations.find((chat) => chat.id === root.conversationId)?.needsAnswer, undefined, "the chat list does not grant another browser question access");
    const answer = await api.actFacade.agentAnswer({ questionId: asked.question.questionId, answer: "/hold Q3" });
    assert.equal(answer.request.id, asked.request.id);
    assert.equal(answer.request.state, "working");
    const answeredList = await api.remoteFacade.execute("management.chats", {}, principal) as typeof ownedList;
    assert.equal(answeredList.conversations.find((chat) => chat.id === root.conversationId)?.needsAnswer, false);
    await assert.rejects(api.actFacade.agentAnswer({ questionId: asked.question.questionId, answer: "Q4" }), /already has an answer/);
    await h.release(answer.continuation.taskId); await settled(api, workFoldAgentScopeId, answer.continuation.taskId);
    assert.equal(api.requests.byTaskId(root.taskId)?.state, "done");
  } finally { h.releaseAll(); await api.close(); }
});

test("a work-folder receives a child result that finished before its own turn, exactly once", async (t) => {
  const h = await collaborationHarness(t); const api = await h.open();
  try {
    const { workFolder: source } = await api.actFacade.createWorkFolder({ name: "Coordinator" });
    const { workFolder: target } = await api.actFacade.createWorkFolder({ name: "Research" });
    h.held.add(source.id); h.held.add(target.id);
    const parent = await api.actFacade.sendMessage({ workFolder: source.id, newConversation: true, content: "/hold Assemble a brief." });
    const child = await api.actFacade.chatHandoff({ workFolder: source.id, taskId: parent.taskId, toWorkFolder: target.id, message: "/hold Find a fact.", files: [] });
    await api.actFacade.chatReport({ workFolder: target.id, taskId: child.taskId, summary: "Selected fact", outcome: "succeeded", data: { count: 7 }, files: [] });
    await h.release(child.taskId); await settled(api, target.id, child.taskId);
    const read = await api.actFacade.turnResult({ workFolder: target.id, taskId: child.taskId });
    assert.deepEqual(read.result?.data, { count: 7 });
    assert.equal(read.result?.summary, "Selected fact");
    const record = api.requests.byTaskId(parent.taskId)!;
    assert.equal(record.turns.length, 1);
    await h.release(parent.taskId); await settled(api, source.id, parent.taskId);
    await waitFor(async () => api.requests.get(record.requestId)!.turns.length === 2);
    const continued = api.requests.get(record.requestId)!;
    await waitFor(async () => h.pending.some((p) => p.taskId === continued.turns[1]!.taskId));
    assert.ok(continued.deliveredChildTaskIds.includes(child.taskId));
    assert.match(continued.content, /Selected fact/);
    assert.match(continued.content, /Submit any needed chat report before your final reply, then give the complete useful answer in that reply/);
    assert.doesNotMatch(continued.content, /requests show/);
    assert.equal(continued.assignment, "/hold Assemble a brief.");
    assert.match(JSON.stringify(h.pending.find((p) => p.taskId === continued.turns[1]!.taskId)?.workFolderTurn), /Assemble a brief/);
    await api.actFacade.abortTurn({ workFolder: source.id, conversationId: parent.conversationId });
    await h.release(continued.turns[1]!.taskId); await settled(api, source.id, continued.turns[1]!.taskId);
    assert.equal(api.requests.get(record.requestId)?.turns.length, 2);
  } finally { h.releaseAll(); await api.close(); }
});


test("an automation stops at a question and an answer never replays later hops", async (t) => {
  const h = await collaborationHarness(t); const api = await h.open();
  try {
    const source = (await api.actFacade.createWorkFolder({ name: "Automation question" })).workFolder;
    const destination = (await api.actFacade.createWorkFolder({ name: "Automation target" })).workFolder;
    h.held.add(source.id);
    await writeFile(join(source.workFolderRoot, "notes.md"), "Synthetic notes");
    const declaration = normalizeWorkFoldAutomationDeclaration({ kind: "work-fold.automation", version: 1, id: "automation-question-hop", title: "Question hop", createdBy: "human", createdAt: new Date().toISOString(), trigger: { kind: "manual" }, steps: [
      { id: "ask", kind: "chat", workFolder: source.id, message: "/hold" },
      { id: "copy", kind: "files", fromWorkFolder: source.id, from: { kind: "paths", paths: ["notes.md"] }, toWorkFolder: destination.id, to: "Incoming" },
    ] });
    await api.automations.enable({ declaration, expectedDigest: workFoldAutomationDigest(declaration), grant: { requestId: "automation-question", surface: "main-window" } });
    const run = api.automations.runNow(declaration.id);
    await waitFor(async () => h.pending.some((turn) => turn.workFolderId === source.id));
    const task = h.pending.find((turn) => turn.workFolderId === source.id)!;
    const asked = await api.actFacade.chatAsk({ workFolder: source.id, taskId: task.taskId, question: "Which quarter?", respondent: "person" });
    const result = await run;
    assert.equal(result.outcome, "failure");
    assert.equal(existsSync(join(destination.workFolderRoot, "Incoming", "notes.md")), false);
    await h.release(task.taskId); await settled(api, source.id, task.taskId);
    const answered = await api.actFacade.chatAnswer({ workFolder: source.id, questionId: asked.question.questionId, answer: "/hold Q3" });
    await h.release(answered.continuation.taskId); await settled(api, source.id, answered.continuation.taskId);
    assert.equal(api.requests.byTaskId(task.taskId)?.state, "done");
    assert.equal(existsSync(join(destination.workFolderRoot, "Incoming", "notes.md")), false);
  } finally { h.releaseAll(); await api.close(); }
});

test("multiplexed Chat channels preserve snapshots and accepted-answer visibility while one continuation remains running", async (t) => {
  const h = await collaborationHarness(t); const api = await h.open();
  const controller = new AbortController();
  let reading: Promise<void> | undefined;
  try {
    const workFolder = (await api.actFacade.createWorkFolder({ name: "Multiplex answer" })).workFolder;
    const sibling = (await api.actFacade.createWorkFolder({ name: "Surviving file monitor" })).workFolder;
    h.held.add(workFolder.id);
    const first = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ workFolder: workFolder.id, taskId: first.taskId, question: "Which currency?", respondent: "person" });
    await h.release(first.taskId); await settled(api, workFolder.id, first.taskId);
    const chatPath = `/api/work-folders/${workFolder.id}/conversations/${first.conversationId}`;
    const subscriptions = Array.from({ length: 10 }, (_, index) => ({ id: `chat-${index}`, path: `${chatPath}/events` }));
    const response = await fetch(`${api.origin}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ subscriptions: [...subscriptions, { id: "removed", path: "/api/work-folders/space-0000000000000000/file-events" }, { id: "files", path: `/api/work-folders/${workFolder.id}/file-events` }, { id: "sibling-files", path: `/api/work-folders/${sibling.id}/file-events` }, { id: "control", path: "/api/work-fold-agent/control-events" }] }),
    });
    assert.equal(response.status, 200);
    const events: Array<{ subscriptionId: string; ready?: boolean; closed?: boolean; eventId?: string; error?: { status: number }; event?: { type?: string; running?: boolean } }> = [];
    const transcriptReads: Array<Promise<Array<{ content: string }>>> = [];
    const reader = response.body!.getReader();
    reading = (async () => {
      const decoder = new TextDecoder(); let buffer = "";
      try { for (;;) {
        const result = await reader.read(); if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)); events.push(event);
          if (event.subscriptionId === "chat-0" && event.event?.type === "turn_state" && event.event.running) {
            transcriptReads.push(workFolderMessages(api, workFolder.id, first.conversationId));
          }
        }
      } } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    })();
    await waitFor(async () => events.filter((event) => event.ready).length === 13);
    assert.equal(events.find((event) => event.subscriptionId === "removed" && event.error)?.error?.status, 404);
    assert.equal(events.filter((event) => event.event?.type === "turn_snapshot").length, 10, "duplicate paths each receive their own snapshot");
    const answered = await fetch(`${api.origin}/api/requests/${api.requests.byTaskId(first.taskId)!.requestId}/answer`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: asked.question.questionId, answer: "/hold CAD", surface: "main-window" }), signal: AbortSignal.timeout(5000) });
    assert.equal(answered.status, 200, await answered.clone().text());
    const work = (await answered.json() as { work: { state: string } }).work;
    assert.equal(work.state, "working", "answer acceptance does not await the held continuation");
    await waitFor(async () => transcriptReads.length > 0);
    assert.ok((await transcriptReads[0]!).some((message) => message.content.includes("/hold CAD")), "a running notification cannot precede its persisted accepted answer");
    const record = api.requests.get(api.requests.byTaskId(first.taskId)!.requestId)!;
    assert.equal(record.turns.length, 2);
    const stopped = await fetch(`${api.origin}/api/requests/${record.requestId}/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surface: "main-window" }), signal: AbortSignal.timeout(5000) });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal(api.requests.get(record.requestId)?.state, "stopped");
    h.releaseAll();
    await settled(api, workFolder.id, record.turns.at(-1)!.taskId);
    await api.actFacade.workFoldersUnregister({ workFolder: workFolder.id });
    await waitFor(async () => events.filter((event) => event.closed && (event.subscriptionId.startsWith("chat-") || event.subscriptionId === "files")).length === 11);
    await writeFile(join(sibling.workFolderRoot, "surviving.txt"), "Synthetic sibling monitor still works");
    await waitFor(async () => events.some((event) => event.subscriptionId === "sibling-files" && event.event?.type === "file_event"));
  } finally { controller.abort(); await reading; h.releaseAll(); await api.close(); }
});

test("a reconnect during turn reservation waits for accepted-message persistence before announcing running", async (t) => {
  const h = await collaborationHarness(t);
  const turnStore = await WorkFoldTurnStore.create({ stateRoot: h.stateBase });
  const accept = turnStore.accept.bind(turnStore);
  let reserved: Awaited<ReturnType<typeof accept>> | undefined;
  let releaseAcceptance: (() => void) | undefined;
  turnStore.accept = async (input) => {
    const result = await accept(input); reserved = result;
    await new Promise<void>((resolve) => { releaseAcceptance = resolve; });
    return result;
  };
  const api = await h.open({ turnStore });
  const controller = new AbortController();
  let sending: Promise<unknown> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const workFolder = (await api.actFacade.createWorkFolder({ name: "Slow acceptance" })).workFolder;
    h.held.add(workFolder.id);
    sending = api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/hold Accepted after reservation" });
    await waitFor(async () => Boolean(releaseAcceptance));
    const conversationId = reserved!.record.conversationId;
    const response = await fetch(`${api.origin}/api/events`, { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ subscriptions: [{ id: "chat", path: `/api/work-folders/${workFolder.id}/conversations/${conversationId}/events` }] }),
    });
    reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"turn_snapshot".*"running":false/);
    assert.doesNotMatch(first, /"running":true/);
    assert.deepEqual((await workFolderMessages(api, workFolder.id, conversationId)).filter((message) => message.role === "user"), []);
    releaseAcceptance!();
    await sending;
    let buffer = first;
    while (!buffer.includes('"running":true')) {
      const next = await reader.read(); assert.equal(next.done, false);
      buffer += new TextDecoder().decode(next.value);
    }
    assert.ok((await workFolderMessages(api, workFolder.id, conversationId)).some((message) => message.content.includes("Accepted after reservation")));
  } finally {
    releaseAcceptance?.(); controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock();
    await sending; h.releaseAll(); await api.close();
  }
});
