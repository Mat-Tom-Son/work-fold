import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTurnContextMessage, type PiWorkFolderTurnContext } from "../src/local/agent/pi-client.js";
import { appendWorkerInstructions } from "../src/local/agent/pi-runtime-config.js";
import {
  appendWorkFolderOperationsGuide,
  workFolderOperationsGuideForScope,
  workFoldWorkFolderOperationsGuide,
  workFoldWorkFolderOperationsGuideHeading,
} from "../src/local/agent/work-folder-operations-guide.js";
import { buildWorkFolderTurnContext, workFolderTurnAssignmentMaxBytes, workFolderTurnHistory, workFolderTurnParentHandle } from "../src/local/agent/work-folder-turn-context.js";
import { startLocalApi } from "../src/local/server.js";
import { workFoldAgentScopeId } from "../src/local/state-paths.js";

/**
 * work-folder turns get their own context (docs/collaboration-contract.md, F26):
 * this work-folder's id, this turn's task id, its request id, and — when another
 * request delegated the work — an opaque handle plus the assignment. Never
 * another work-folder, the registry, the work-fold agent's conversation, or the parent's real
 * task id.
 */

const bannedWords = /\bstaged\b|\bapprove[sd]?\b|\bapproval\b|\bpolic(y|ies)\b|\bcard\b|\bmode\b|\bsandboxed\b|\bdigest\b/i;
const bannedNames = /\bReviewed\b|\bUnrestricted\b/;

test("a work-folder turn's identity block names exactly its own ids and the stay-inside rule", () => {
  const context = buildTurnContextMessage({
    workFolderTurn: buildWorkFolderTurnContext({ workFolderId: "work-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }),
  });
  assert.match(context, /This turn's work-fold identity/);
  assert.match(context, /"workFolderId": "work-folder-1"/);
  assert.match(context, /"taskId": "task-1"/);
  assert.match(context, /"requestId": "req-1"/);
  assert.match(context, /A task id is accepted only while that exact turn is yours and running/);
  assert.match(context, /Work only in this work-folder/);
  assert.doesNotMatch(context, /"work-folders":/, "no registry array");
  assert.doesNotMatch(context, /delegated this work/, "an undelegated turn has no parent block");
  assert.doesNotMatch(context, bannedWords);
  assert.doesNotMatch(context, bannedNames);
});

test("a delegated turn sees an opaque handle and its assignment, never the parent's task id", () => {
  const delegated = buildWorkFolderTurnContext({
    workFolderId: "work-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    handleSalt: "salt",
  });
  assert.match(delegated.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
  assert.equal(delegated.delegated!.assignmentIsThisMessage, true, "the assignment defaults to this turn's own message");
  const rendered = buildTurnContextMessage({ workFolderTurn: delegated });
  assert.doesNotMatch(rendered, /task-parent/);
  assert.match(rendered, /Refer to it as parent-[0-9a-f]{16}; that handle is all you get, and no command takes it/);
  assert.match(rendered, /Your assignment is the message in this turn/);
  assert.match(rendered, /chat ask --to parent/);
  assert.match(rendered, /report back with chat report before your final reply, then give the complete useful answer in that reply/);

  const explicit = buildWorkFolderTurnContext({
    workFolderId: "work-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "Adopt the brief and list its gaps.",
    handleSalt: "salt",
  });
  assert.equal(explicit.delegated!.assignment, "Adopt the brief and list its gaps.");
  assert.equal(explicit.delegated!.assignmentIsThisMessage, undefined);
  assert.match(buildTurnContextMessage({ workFolderTurn: explicit }), /Your assignment from that request:\nAdopt the brief and list its gaps\./);

  const long = buildWorkFolderTurnContext({
    workFolderId: "work-folder-1",
    taskId: "task-1",
    requestId: "req-1",
    parentTaskId: "task-parent",
    assignment: "x".repeat(workFolderTurnAssignmentMaxBytes + 1024),
    handleSalt: "salt",
  });
  assert.equal(Buffer.byteLength(long.delegated!.assignment!, "utf8"), workFolderTurnAssignmentMaxBytes, "the assignment is cut at the request record bound");
  assert.equal(long.delegated!.assignmentTruncated, true);
  assert.match(buildTurnContextMessage({ workFolderTurn: long }), /\[The assignment was cut at 1 MB; the full text is the first message of this Chat\.\]/);
});

test("parent handles are stable per salt, differ across salts, and refuse an empty salt", () => {
  assert.equal(workFolderTurnParentHandle("task-parent", "salt-a"), workFolderTurnParentHandle("task-parent", "salt-a"));
  assert.notEqual(workFolderTurnParentHandle("task-parent", "salt-a"), workFolderTurnParentHandle("task-parent", "salt-b"));
  assert.notEqual(workFolderTurnParentHandle("task-parent", "salt-a"), workFolderTurnParentHandle("task-other", "salt-a"));
  assert.throws(() => workFolderTurnParentHandle("task-parent", "   "), /non-empty salt/);
  assert.throws(() => buildWorkFolderTurnContext({ workFolderId: " ", taskId: "task-1", requestId: "req-1", handleSalt: "salt" }), /work-folder id/);
  // The builder emits no registry field under any input.
  const keys = Object.keys(buildWorkFolderTurnContext({ workFolderId: "work-folder-1", taskId: "task-1", requestId: "req-1", parentTaskId: "p", handleSalt: "s" }));
  assert.deepEqual(keys.sort(), ["delegated", "requestId", "taskId", "workFolderId"]);
});

test("History turn context reports actual capture coverage and an unavailable capture honestly", () => {
  const context = buildWorkFolderTurnContext({ workFolderId: "work-folder-1", taskId: "task-1", requestId: "req-1", handleSalt: "salt" });
  context.history = workFolderTurnHistory({ checkpointId: "cp-test", fileCount: 4,
    skippedFiles: [{ reason: "excluded" }, { reason: "too_large" }, { reason: "excluded" }] });
  assert.deepEqual(context.history, { status: "captured", checkpointId: "cp-test", fileCount: 4,
    skippedFileCount: 3, skippedByReason: { excluded: 2, too_large: 1 } });
  const rendered = buildTurnContextMessage({ workFolderTurn: context });
  assert.match(rendered, /cp-test/);
  assert.match(rendered, /skipped entries are not backed up/);
  assert.deepEqual(workFolderTurnHistory(null), { status: "unavailable" });
  context.history = workFolderTurnHistory(null);
  assert.match(buildTurnContextMessage({ workFolderTurn: context }), /"status":"unavailable"/);
});

test("the operations guide names the verbs and the rules, stays bounded, and follows work-folder instructions", () => {
  const guide = workFoldWorkFolderOperationsGuide();
  assert.ok(guide.startsWith(workFoldWorkFolderOperationsGuideHeading));
  for (const verb of [
    "chat report", "chat ask", "chat answer", "chat handoff", "chat wait",
    "files delete", "history list|save|restore", "search", "checks status", "apps list", "apps invoke", "help collaborate",
  ]) {
    assert.ok(guide.includes(verb), `the guide names ${verb}`);
  }
  assert.match(guide, /accepts a task id only while that exact turn is your own and running/);
  assert.match(guide, /not yours to read.*hand it off, or ask/s);
  assert.match(guide, /Never write cross-work-folder context into this Chat/);
  assert.match(guide, /Direct Chat answers need no `chat report`; replies are saved/);
  assert.match(guide, /Report delegated work, requested reports, or structured data and deliverables/);
  assert.match(guide, /After all tools, including any chat report, give the complete answer as your final reply/);
  assert.match(guide, /repeat essential earlier findings/);
  assert.doesNotMatch(guide, bannedWords);
  assert.doesNotMatch(guide, bannedNames);

  const appended = appendWorkFolderOperationsGuide(appendWorkerInstructions([], "Prefer short answers."), guide);
  assert.equal(appended.length, 3);
  assert.match(appended[0]!, /^## Worker instructions/);
  assert.equal(appended[1], guide);
  assert.match(appended[2]!, /## Worker working files/);
  assert.deepEqual(appendWorkFolderOperationsGuide([], undefined), [], "management receives no work-folder scratch appendix");
  assert.equal(workFolderOperationsGuideForScope("work-folder-1"), guide);
  assert.equal(workFolderOperationsGuideForScope(workFoldAgentScopeId), undefined);
  assert.equal(workFoldWorkFolderOperationsGuide("wf").includes("`wf help collaborate`"), true, "the executable name substitutes");
});

test("the local API composes a work-folder turn's context from acceptance, never from the work-fold agent's registry", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-work-folder-turn-context-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 300)),
    });
  }\n`, "utf8");
  const events: Array<{ workFolderId: string; conversationId: string; taskId: string; workFolderTurn?: PiWorkFolderTurnContext }> = [];
  let releaseWorkFoldAgent!: () => void;
  const workFoldAgentGate = new Promise<void>((resolve) => { releaseWorkFoldAgent = resolve; });
  // work-folder turns are held only while a case needs to act inside a running one.
  const heldWorkFolderTurns: Array<{ taskId: string; release: () => void }> = [];
  let holdWorkFolderTurns = false;
  const releaseWorkFolderTurn = async (taskId: string): Promise<void> => {
    await waitFor(() => heldWorkFolderTurns.some((turn) => turn.taskId === taskId));
    heldWorkFolderTurns.splice(heldWorkFolderTurns.findIndex((turn) => turn.taskId === taskId), 1)[0]!.release();
  };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent") }; } },
    async beforeAgentPrompt(event) {
      events.push(event);
      if (event.workFolderId === workFoldAgentScopeId) { await workFoldAgentGate; return; }
      if (holdWorkFolderTurns) await new Promise<void>((release) => heldWorkFolderTurns.push({ taskId: event.taskId, release }));
    },
  });
  try {
    const { workFolder } = await api.actFacade.createWorkFolder({ name: "Brief" });
    const other = (await api.actFacade.createWorkFolder({ name: "Elsewhere" })).workFolder;
    const parent = await api.actFacade.agentSend({ content: "/hold" });
    await waitFor(() => events.some((event) => event.taskId === parent.taskId));

    const delegated = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Adopt the brief.", parentTaskId: parent.taskId });
    await waitFor(() => events.some((event) => event.taskId === delegated.taskId));
    const delegatedEvent = events.find((event) => event.taskId === delegated.taskId)!;
    assert.ok(delegatedEvent.workFolderTurn, "a work-folder turn carries its identity");
    assert.equal(delegatedEvent.workFolderTurn!.workFolderId, workFolder.id);
    assert.equal(delegatedEvent.workFolderTurn!.history?.status, "captured", "actual capture reaches the prompt hook");
    const history = delegatedEvent.workFolderTurn!.history;
    if (history?.status === "captured") {
      // The prompt hook can precede the post-turn capture. Read History only
      // once this fixture's turn has released that operation's fence.
      await waitFor(() => !["accepted", "running"].includes(api.requests.byTaskId(delegated.taskId)!.turns[0]!.state));
      const checkpoints = await api.actFacade.historyList({ workFolder: workFolder.id });
      assert.ok(checkpoints.checkpoints.some((checkpoint) => checkpoint.checkpointId === history.checkpointId));
    }
    assert.equal(delegatedEvent.workFolderTurn!.taskId, delegated.taskId);
    assert.equal(delegatedEvent.workFolderTurn!.requestId, api.requests.byTaskId(delegated.taskId)!.requestId, "the request id is the durable record's, never invented");
    assert.match(delegatedEvent.workFolderTurn!.delegated!.parentHandle, /^parent-[0-9a-f]{16}$/);
    assert.notEqual(delegatedEvent.workFolderTurn!.delegated!.parentHandle, parent.taskId);
    assert.equal(delegatedEvent.workFolderTurn!.delegated!.assignmentIsThisMessage, true);
    const serialized = JSON.stringify(delegatedEvent.workFolderTurn);
    assert.equal(serialized.includes(other.id), false, "no other work-folder's id");
    assert.equal(serialized.includes(other.workFolderRoot), false, "no other work-folder's folder");
    assert.equal(serialized.includes(parent.taskId), false, "never the parent's real task id");

    const undelegated = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "Just this work-folder." });
    await waitFor(() => events.some((event) => event.taskId === undelegated.taskId));
    const undelegatedEvent = events.find((event) => event.taskId === undelegated.taskId)!;
    assert.equal(undelegatedEvent.workFolderTurn!.delegated, undefined);
    assert.equal(undelegatedEvent.workFolderTurn!.requestId, api.requests.byTaskId(undelegated.taskId)!.requestId);

    // A continuation names the question it answers in host-built context. The
    // answer itself is an ordinary message, and a request may hold several
    // open questions, so nothing else in the turn says which one this is
    // (docs/collaboration-contract.md, F27).
    holdWorkFolderTurns = true;
    const asking = await api.actFacade.sendMessage({ workFolder: workFolder.id, newConversation: true, content: "/hold" });
    const asked = await api.actFacade.chatAsk({ workFolder: workFolder.id, taskId: asking.taskId, question: "Which brief?", respondent: "person" });
    await releaseWorkFolderTurn(asking.taskId);
    await waitFor(() => api.requests.byTaskId(asking.taskId)!.turns[0]!.state !== "accepted"
      && api.requests.byTaskId(asking.taskId)!.turns[0]!.state !== "running");
    holdWorkFolderTurns = false;
    const answered = await api.actFacade.chatAnswer({
      workFolder: workFolder.id,
      questionId: asked.question.questionId,
      answer: "The 2026 one.",
    });
    await waitFor(() => events.some((event) => event.taskId === answered.continuation.taskId));
    const continuation = events.find((event) => event.taskId === answered.continuation.taskId)!;
    assert.equal(continuation.workFolderTurn!.answeredQuestionId, asked.question.questionId);
    assert.equal(continuation.workFolderTurn!.requestId, api.requests.byTaskId(asking.taskId)!.requestId);
    assert.equal(undelegatedEvent.workFolderTurn!.answeredQuestionId, undefined, "an ordinary turn answers nothing");

    const workFoldAgentEvent = events.find((event) => event.taskId === parent.taskId)!;
    assert.equal(workFoldAgentEvent.workFolderTurn, undefined, "the work-fold agent's own turn carries no work-folder identity block");
  } finally {
    holdWorkFolderTurns = false;
    for (const turn of heldWorkFolderTurns.splice(0)) turn.release();
    releaseWorkFoldAgent();
    await api.close();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
