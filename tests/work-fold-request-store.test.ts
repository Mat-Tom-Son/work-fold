import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  computeWorkFoldRequestState,
  WorkFoldRequestLimitError,
  workFoldRequestLimitMessage,
  WorkFoldRequestLineageError,
  workFoldRequestStateToManagementPhase,
  type WorkFoldRequestLimitName,
  type WorkFoldRequestStateInput,
} from "../src/local/requests/request-records.js";
import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";
import { workFoldRequestLimits } from "../src/shared/fold-limits.js";
import type { WorkFoldDurableTurnRecord } from "../src/local/agent/turn-store.js";

/**
 * The durable request graph (docs/collaboration-contract.md, F25).
 *
 * Every accepted turn belongs to one record; the records survive restart, are
 * reconciled against the turn journal, and are never replayed. Bounds are
 * defaults, not gates (docs/receipts-not-gates.md, principle 6), so every
 * refusal here has to name its number and the Settings section that shows it.
 */

const limitsSection = "Settings → The fold → Limits";

function clockFrom(start: string) {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

async function temporaryRoot(t: { after: (fn: () => unknown) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-request-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const managementOwner = { conversationId: "chat-fold" };
const spaceOwner = { spaceId: "space-audits", spaceName: "Audits", conversationId: "chat-audits" };

function stateInput(overrides: Partial<WorkFoldRequestStateInput> = {}): WorkFoldRequestStateInput {
  return {
    stopRequestedAt: null,
    deadline: "2026-09-12T09:00:00.000Z",
    now: new Date("2026-09-11T09:00:00.000Z"),
    turnStates: ["succeeded"],
    openQuestions: 0,
    openDescendantQuestions: 0,
    childStates: [],
    resultOutcomes: [],
    limitHit: null,
    ...overrides,
  };
}

test("a root, a child, and the graph between them", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const request = await store.beginRoot({
    kind: "management",
    owner: managementOwner,
    surface: "popover",
    taskId: "task-1",
    content: "Check the quarter's audits.",
  });
  assert.equal(request.rootId, request.requestId);
  assert.equal(request.depth, 0);
  assert.equal(request.parentRequestId, null);
  assert.equal(request.parentTaskId, null);
  assert.equal(request.state, "working");
  assert.equal(request.deadline, new Date(Date.parse(request.createdAt) + workFoldRequestLimits.deadlineMs).toISOString());

  const child = await store.beginChild({
    parentTaskId: "task-1",
    kind: "space",
    owner: spaceOwner,
    surface: "cli",
    taskId: "task-2",
    content: "Review the ledger.",
  });
  assert.equal(child.rootId, request.requestId);
  assert.equal(child.parentRequestId, request.requestId);
  assert.equal(child.parentTaskId, "task-1");
  assert.equal(child.depth, 1);
  assert.deepEqual(store.get(request.requestId)?.childRequestIds, [child.requestId]);
  assert.equal(store.byTaskId("task-2")?.requestId, child.requestId);
  assert.equal(store.byTaskId("task-1")?.requestId, request.requestId);
  assert.deepEqual(store.descendants(request.requestId).map((item) => item.requestId), [child.requestId]);
  assert.equal(store.children(request.requestId).length, 1);
  assert.equal(store.latestForConversation("chat-audits")?.requestId, child.requestId);
  assert.equal(store.isAccepting("task-1"), true);

  await store.flush();
});

test("every bound a child turn can reach names its own number", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");

  const breadth = await WorkFoldRequestStore.open({ rootPath: join(root, "breadth"), now: clock.now });
  await breadth.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  for (let index = 0; index < workFoldRequestLimits.maxChildRequestsPerRoot; index += 1) {
    await breadth.beginChild({
      parentTaskId: "task-1",
      kind: "space",
      owner: spaceOwner,
      surface: "cli",
      taskId: `child-${index}`,
    });
    await breadth.settleTurn(`child-${index}`, { status: "succeeded", messageId: `reply-${index}` });
  }
  const tooMany = await breadth.beginChild({
    parentTaskId: "task-1",
    kind: "space",
    owner: spaceOwner,
    surface: "cli",
    taskId: "child-over",
  }).then(() => null, (error: unknown) => error);
  assert.ok(tooMany instanceof WorkFoldRequestLimitError);
  assert.equal(tooMany.limit, "childTasks");
  assert.ok(tooMany.message.includes(String(workFoldRequestLimits.maxChildRequestsPerRoot)));
  assert.ok(tooMany.message.includes(limitsSection));
  assert.equal(breadth.byTaskId("child-over"), null);

  const deep = await WorkFoldRequestStore.open({ rootPath: join(root, "deep"), now: clock.now });
  await deep.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "deep-0" });
  for (let level = 1; level <= workFoldRequestLimits.maxDelegationDepth; level += 1) {
    const record = await deep.beginChild({
      parentTaskId: `deep-${level - 1}`,
      kind: "space",
      owner: spaceOwner,
      surface: "cli",
      taskId: `deep-${level}`,
    });
    assert.equal(record.depth, level);
  }
  const tooDeep = await deep.beginChild({
    parentTaskId: `deep-${workFoldRequestLimits.maxDelegationDepth}`,
    kind: "space",
    owner: spaceOwner,
    surface: "cli",
    taskId: "deep-over",
  }).then(() => null, (error: unknown) => error);
  assert.ok(tooDeep instanceof WorkFoldRequestLimitError);
  assert.equal(tooDeep.limit, "depth");
  assert.ok(tooDeep.message.includes(String(workFoldRequestLimits.maxDelegationDepth)));
  assert.ok(tooDeep.message.includes(limitsSection));

  const wide = await WorkFoldRequestStore.open({ rootPath: join(root, "wide"), now: clock.now });
  await wide.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  for (let index = 0; index < workFoldRequestLimits.maxConcurrentChildrenPerRoot; index += 1) {
    await wide.beginChild({ parentTaskId: "task-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: `busy-${index}` });
  }
  const tooBusy = await wide.beginChild({
    parentTaskId: "task-1",
    kind: "space",
    owner: spaceOwner,
    surface: "cli",
    taskId: "busy-over",
  }).then(() => null, (error: unknown) => error);
  assert.ok(tooBusy instanceof WorkFoldRequestLimitError);
  assert.equal(tooBusy.limit, "concurrentChildren");
  assert.ok(tooBusy.message.includes(String(workFoldRequestLimits.maxConcurrentChildrenPerRoot)));
  assert.ok(tooBusy.message.includes(limitsSection));

  // Settling one frees the slot: a bound stops a runaway, it does not queue a person behind a click.
  await wide.settleTurn("busy-0", { status: "succeeded" });
  const admitted = await wide.beginChild({
    parentTaskId: "task-1",
    kind: "space",
    owner: spaceOwner,
    surface: "cli",
    taskId: "busy-again",
  });
  assert.equal(admitted.depth, 1);

  await Promise.all([breadth.flush(), deep.flush(), wide.flush()]);
});

test("the state ladder decides the same facts the same way every time", () => {
  assert.equal(computeWorkFoldRequestState(stateInput({ stopRequestedAt: "2026-09-11T09:30:00.000Z" })), "stopped");
  assert.equal(computeWorkFoldRequestState(stateInput({ turnStates: ["aborted"] })), "stopped");
  assert.equal(
    computeWorkFoldRequestState(stateInput({ limitHit: { limit: "providerBudget", at: "2026-09-11T09:30:00.000Z" } })),
    "failed",
  );
  assert.equal(
    computeWorkFoldRequestState(stateInput({ turnStates: ["running"], now: new Date("2026-09-13T09:00:00.000Z") })),
    "expired",
  );
  // A request that finished before its window closed stays finished.
  assert.equal(computeWorkFoldRequestState(stateInput({ now: new Date("2026-09-13T09:00:00.000Z") })), "done");
  // An open question this request asked outranks its own running turn: asking
  // puts the asking task in waiting, and Needs you means questions.
  assert.equal(computeWorkFoldRequestState(stateInput({ turnStates: ["running"], openQuestions: 1 })), "waiting");
  assert.equal(computeWorkFoldRequestState(stateInput({ turnStates: ["running"] })), "working");
  // A child's open question waits behind this request's own running turn.
  assert.equal(computeWorkFoldRequestState(stateInput({ turnStates: ["running"], openDescendantQuestions: 1 })), "working");
  assert.equal(computeWorkFoldRequestState(stateInput({ openDescendantQuestions: 1, childStates: ["waiting"] })), "waiting");
  assert.equal(computeWorkFoldRequestState(stateInput({ childStates: ["handed_off"] })), "handed_off");
  assert.equal(computeWorkFoldRequestState(stateInput({ turnStates: ["interrupted"] })), "failed");
  assert.equal(computeWorkFoldRequestState(stateInput({ childStates: [null] })), "failed");
  assert.equal(computeWorkFoldRequestState(stateInput({ childStates: ["expired"] })), "stopped");
  assert.equal(computeWorkFoldRequestState(stateInput({ resultOutcomes: ["partial"] })), "partial");
  assert.equal(computeWorkFoldRequestState(stateInput({ resultOutcomes: ["succeeded"] })), "done");

  // The older phase vocabulary keeps its meaning, and the closing-question
  // heuristic still upgrades a finished request but never a failed one.
  assert.equal(workFoldRequestStateToManagementPhase("waiting"), "needs_you");
  assert.equal(workFoldRequestStateToManagementPhase("partial"), "done");
  assert.equal(workFoldRequestStateToManagementPhase("expired"), "stopped");
  assert.equal(workFoldRequestStateToManagementPhase("done", true), "needs_you");
  assert.equal(workFoldRequestStateToManagementPhase("failed", true), "failed");
});

test("a request never claims done while work it started is still running", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const request = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  await store.beginChild({ parentTaskId: "task-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "task-2" });
  await store.markTurnRunning("task-1");
  assert.equal(store.get(request.requestId)?.state, "working");

  await store.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });
  assert.equal(store.get(request.requestId)?.state, "handed_off");
  assert.equal(store.get(request.requestId)?.settledAt, null);

  await store.settleTurn("task-2", { status: "succeeded", messageId: "reply-2" });
  const done = store.get(request.requestId);
  assert.equal(done?.state, "done");
  assert.ok(done?.settledAt);

  // A settled turn keeps its first outcome, exactly as the turn journal does.
  await store.settleTurn("task-1", { status: "failed", error: "second thoughts" });
  assert.equal(store.get(request.requestId)?.turns[0]?.state, "succeeded");
  assert.equal(store.get(request.requestId)?.state, "done");

  await store.flush();
});

test("a failed child fails its root and a stopped request says so", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const failing = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "fail-1" });
  await store.beginChild({ parentTaskId: "fail-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "fail-2" });
  await store.settleTurn("fail-1", { status: "succeeded", messageId: "reply-1" });
  await store.settleTurn("fail-2", { status: "failed", error: "The ledger could not be read." });
  assert.equal(store.get(failing.requestId)?.state, "failed");

  const stopping = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "stop-1" });
  await store.markStopRequested(stopping.requestId);
  assert.equal(store.get(stopping.requestId)?.state, "stopped");
  assert.equal(store.isAccepting("stop-1"), false);

  await store.flush();
});

test("questions take exactly one answer, from the Space that was asked, inside the window", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const request = await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-1" });
  const question = await store.ask({
    requestId: request.requestId,
    taskId: "task-1",
    respondent: "person",
    text: "a".repeat(workFoldRequestLimits.maxQuestionTextBytes),
  });
  assert.equal(question.state, "open");
  assert.equal(question.expiresAt, request.deadline);
  assert.equal(store.get(request.requestId)?.state, "waiting");
  assert.equal(store.openQuestions(request.rootId).length, 1);

  const oversized = await store.ask({
    requestId: request.requestId,
    taskId: "task-1",
    respondent: "person",
    text: "a".repeat(workFoldRequestLimits.maxQuestionTextBytes + 1),
  }).then(() => null, (error: unknown) => error);
  assert.ok(oversized instanceof WorkFoldRequestLimitError);
  assert.equal(oversized.limit, "questionText");
  assert.ok(oversized.message.includes(limitsSection));

  const wrongSpace = await store.answer({ questionId: question.questionId, answer: "Yes", answeredBySpaceId: "space-other" })
    .then(() => null, (error: unknown) => error);
  assert.ok(wrongSpace instanceof WorkFoldRequestLineageError);

  const answered = await store.answer({ questionId: question.questionId, answer: "Use the 2026 ledger.", answeredBySpaceId: "space-audits" });
  assert.equal(answered.state, "answered");
  assert.equal(answered.answer, "Use the 2026 ledger.");
  assert.equal(store.get(request.requestId)?.state, "working");

  const second = await store.answer({ questionId: question.questionId, answer: "Actually the 2025 one." })
    .then(() => null, (error: unknown) => error);
  assert.ok(second instanceof WorkFoldRequestLineageError);

  const linked = await store.linkContinuation(question.questionId, "task-2");
  assert.equal(linked.continuationTaskId, "task-2");
  const relinked = await store.linkContinuation(question.questionId, "task-3").then(() => null, (error: unknown) => error);
  assert.ok(relinked instanceof WorkFoldRequestLineageError);

  await store.flush();
});

test("a request and its open questions run out of time together, and the refusal names the window", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const request = await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-1" });
  const question = await store.ask({ requestId: request.requestId, taskId: "task-1", respondent: "person", text: "Which ledger?" });
  await store.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });
  assert.equal(store.get(request.requestId)?.state, "waiting");

  clock.advance(workFoldRequestLimits.deadlineMs + 1_000);
  const tooLate = await store.answer({ questionId: question.questionId, answer: "The 2026 one." })
    .then(() => null, (error: unknown) => error);
  assert.ok(tooLate instanceof WorkFoldRequestLimitError);
  assert.equal(tooLate.limit, "questionLifetime");
  assert.ok(tooLate.message.includes("24-hour"));
  assert.ok(tooLate.message.includes(limitsSection));

  const due = await store.expireDue();
  assert.equal(due.requests, 1);
  assert.equal(store.get(request.requestId)?.state, "expired");
  assert.equal(store.question(question.questionId)?.state, "expired");
  assert.equal(store.openQuestions().length, 0);

  await store.flush();
});

test("the result envelope keeps its shape, its sizes, and its Space-relative files", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const request = await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-1" });
  const digest = "a".repeat(64);

  const recorded = await store.recordResult({
    requestId: request.requestId,
    taskId: "task-1",
    receiptId: "receipt-1",
    envelope: {
      summary: "s".repeat(workFoldRequestLimits.maxResultSummaryBytes),
      data: { rows: 12 },
      files: [{ path: "reports/audit.md", sha256: digest, sizeBytes: 2_048 }],
      outcome: "succeeded",
    },
  });
  assert.match(recorded.resultId, /^res-\d{14}-[0-9a-f]{8}$/);
  assert.equal(store.get(request.requestId)?.results[0]?.fileCount, 1);
  assert.equal(store.get(request.requestId)?.results[0]?.outcome, "succeeded");

  const read = await store.result(recorded.resultId);
  assert.equal(read?.state, "ok");
  assert.deepEqual(read?.state === "ok" ? read.record.envelope.data : null, { rows: 12 });

  const refusals: Array<[unknown, string]> = [
    [{ summary: "s".repeat(workFoldRequestLimits.maxResultSummaryBytes + 1), outcome: "succeeded" }, "resultSummary"],
    [{ summary: "ok", data: { blob: "d".repeat(workFoldRequestLimits.maxResultDataBytes) }, outcome: "succeeded" }, "resultData"],
    [{
      summary: "ok",
      outcome: "succeeded",
      files: Array.from({ length: workFoldRequestLimits.maxResultFiles + 1 }, (_item, index) => ({
        path: `reports/${index}.md`,
        sha256: digest,
        sizeBytes: 1,
      })),
    }, "resultFiles"],
  ];
  for (const [envelope, limit] of refusals) {
    const error = await store.recordResult({ requestId: request.requestId, taskId: "task-1", receiptId: "receipt-2", envelope })
      .then(() => null, (thrown: unknown) => thrown);
    assert.ok(error instanceof WorkFoldRequestLimitError, `${limit} refuses with a named bound`);
    assert.equal(error.limit, limit);
    assert.ok(error.message.includes(limitsSection));
  }

  for (const path of ["../escape.md", "/etc/hosts", ".work-fold/space.json", ".pi/config.json", ".workspace/state.json"]) {
    await assert.rejects(
      store.recordResult({
        requestId: request.requestId,
        taskId: "task-1",
        receiptId: "receipt-3",
        envelope: { summary: "ok", outcome: "succeeded", files: [{ path, sha256: digest, sizeBytes: 1 }] },
      }),
      (error: unknown) => error instanceof Error && !(error instanceof WorkFoldRequestLimitError),
      `${path} is not a deliverable a Space can name`,
    );
  }

  // A declared schema validates the details; an undeclared property is refused.
  await assert.rejects(store.recordResult({
    requestId: request.requestId,
    taskId: "task-1",
    receiptId: "receipt-4",
    envelope: { summary: "ok", data: { rows: "twelve" }, outcome: "succeeded" },
    schema: { type: "object", properties: { rows: { type: "integer" } }, required: ["rows"], additionalProperties: false },
  }));

  // A task from another request cannot report into this one.
  await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-elsewhere" });
  await assert.rejects(
    store.recordResult({ requestId: request.requestId, taskId: "task-elsewhere", receiptId: "receipt-5", envelope: { summary: "ok", outcome: "succeeded" } }),
    (error: unknown) => error instanceof WorkFoldRequestLineageError,
  );

  // A partial result is reported as partial, never as success.
  await store.recordResult({
    requestId: request.requestId,
    taskId: "task-1",
    receiptId: "receipt-6",
    envelope: { summary: "Half the ledger was unreadable.", outcome: "partial" },
  });
  await store.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });
  assert.equal(store.get(request.requestId)?.state, "partial");

  await store.flush();
});

test("requests, questions, results, and the action trail survive a restart", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const request = await store.beginRoot({
    kind: "management",
    owner: managementOwner,
    surface: "popover",
    taskId: "task-1",
    content: "Place the contract.",
    attachments: [{ kind: "file", target: "/tmp/contract.pdf", name: "contract.pdf" }],
    remote: { principalId: "browser-1", grantId: "grant-1", requestId: "remote-1" },
  });
  const child = await store.beginChild({ parentTaskId: "task-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "task-2" });
  const question = await store.ask({ requestId: child.requestId, taskId: "task-2", respondent: "parent", text: "Which folder?" });
  await store.recordAction("task-1", { command: "files.add", at: clock.now().toISOString(), spaceId: "space-audits", spaceName: "Audits", sources: ["/tmp/contract.pdf"], copied: ["contract.pdf"], checkpointId: "checkpoint-1" });
  await store.recordResult({ requestId: child.requestId, taskId: "task-2", receiptId: "receipt-1", envelope: { summary: "Placed.", outcome: "succeeded" } });
  await store.flush();

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const recovered = reopened.get(request.requestId);
  assert.equal(recovered?.content, "Place the contract.");
  assert.deepEqual(recovered?.attachments, [{ kind: "file", target: "/tmp/contract.pdf", name: "contract.pdf" }]);
  assert.deepEqual(recovered?.remote, { principalId: "browser-1", grantId: "grant-1", requestId: "remote-1" });
  assert.equal(recovered?.actions.length, 1);
  assert.equal(recovered?.actions[0]?.command, "files.add");
  assert.deepEqual(recovered?.childRequestIds, [child.requestId]);
  assert.equal(reopened.byTaskId("task-2")?.requestId, child.requestId);
  assert.equal(reopened.question(question.questionId)?.text, "Which folder?");
  assert.equal(reopened.get(child.requestId)?.results.length, 1);
  const results = await reopened.results(child.requestId);
  assert.equal(results[0]?.state, "ok");
  assert.equal(reopened.damagedRecordCount(), 0);
  // The child asked, so the child waits; the root is still working its own
  // turn and only reports waiting once that turn ends.
  assert.equal(reopened.get(child.requestId)?.state, "waiting");
  assert.equal(recovered?.state, "working");
  await reopened.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });
  assert.equal(reopened.get(request.requestId)?.state, "waiting");

  await reopened.flush();
});

test("restart reconciliation settles from the turn journal and never re-dispatches", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const finished = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  const lost = await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-2" });
  await store.markTurnRunning("task-1");
  await store.markTurnRunning("task-2");
  await store.flush();

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const journal: WorkFoldDurableTurnRecord[] = [{
    schema: "work-fold.turn.v1",
    turnId: "task-1",
    requestId: "turn-request-1",
    requestDigest: "b".repeat(64),
    userMessageId: "message-1",
    userMessageCreatedAt: "2026-09-11T09:00:00.000Z",
    spaceId: "work-fold-management",
    conversationId: "chat-fold",
    actorKind: "renderer",
    status: "succeeded",
    userMessagePersisted: true,
    acceptedAt: "2026-09-11T09:00:00.000Z",
    updatedAt: "2026-09-11T09:05:00.000Z",
    assistantText: "Done.",
    messageId: "reply-1",
    usage: { provider: "anthropic", modelId: "test-model", inputTokens: 100, outputTokens: 20, amountUsd: 0.5 },
  }];
  const snapshot = JSON.stringify(journal);

  const before = reopened.list().flatMap((record) => record.turns.map((turn) => turn.taskId)).sort();
  const outcome = await reopened.reconcile({ turns: journal });
  assert.equal(outcome.settled, 2);

  const settledRoot = reopened.get(finished.requestId);
  assert.equal(settledRoot?.state, "done");
  assert.equal(settledRoot?.turns[0]?.state, "succeeded");
  assert.equal(settledRoot?.turns[0]?.messageId, "reply-1");
  assert.ok(settledRoot?.reconciledAt);
  assert.deepEqual(settledRoot?.usage, { turns: 1, inputTokens: 100, outputTokens: 20, amountUsdComplete: true, amountUsd: 0.5 });

  const lostRoot = reopened.get(lost.requestId);
  assert.equal(lostRoot?.state, "failed");
  assert.equal(lostRoot?.turns[0]?.state, "interrupted");
  assert.equal(lostRoot?.turns[0]?.error, "work-fold closed before this Assistant turn finished.");
  assert.ok(lostRoot?.reconciledAt);

  // Reconciliation settles; it can never start a turn. The task ids it knows
  // do not change, and the journal it was handed is left exactly as it was.
  assert.deepEqual(reopened.list().flatMap((record) => record.turns.map((turn) => turn.taskId)).sort(), before);
  assert.equal(JSON.stringify(journal), snapshot);
  assert.equal(Object.keys(reopened).some((key) => key.toLowerCase().includes("dispatch")), false);

  await reopened.flush();
});

test("a damaged journal line degrades the view instead of keeping the app from starting", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-2" });
  await store.flush();

  const journalPath = join(root, "requests.jsonl");
  const lines = (await readFile(journalPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  await writeFile(journalPath, `${lines[0]}\n{ this line is not readable\n${lines[1]}\n{"schema":"work-fold.req\n`, "utf8");

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.damagedRecordCount(), 1);
  assert.equal(reopened.byTaskId("task-1")?.kind, "management");
  assert.equal(reopened.byTaskId("task-2")?.kind, "space");

  await reopened.flush();
});

test("an outgrown journal compacts into one line per record and keeps the generation it replaced", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now, compactBytes: 512 });

  await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  await store.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });
  await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-2" });
  await store.settleTurn("task-2", { status: "succeeded", messageId: "reply-2" });
  await store.flush();

  assert.ok(existsSync(join(root, "requests.1.jsonl")), "the replaced generation is kept for a tolerant reader");
  const live = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n");
  assert.equal(live.length, 2, "compaction collapses repeated appends to one line per record");

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now, compactBytes: 512 });
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.byTaskId("task-1")?.state, "done");
  assert.equal(reopened.byTaskId("task-2")?.state, "done");
  assert.equal(reopened.damagedRecordCount(), 0);

  await reopened.flush();
});

test("retention removes a settled graph whole and leaves one with work outstanding alone", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const old = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "old-1" });
  const oldChild = await store.beginChild({ parentTaskId: "old-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "old-2" });
  const oldQuestion = await store.ask({ requestId: oldChild.requestId, taskId: "old-2", respondent: "person", text: "Which folder?" });
  await store.answer({ questionId: oldQuestion.questionId, answer: "Audits." });
  await store.recordResult({ requestId: oldChild.requestId, taskId: "old-2", receiptId: "receipt-1", envelope: { summary: "Placed.", outcome: "succeeded" } });
  await store.settleTurn("old-2", { status: "succeeded", messageId: "reply-2" });
  await store.settleTurn("old-1", { status: "succeeded", messageId: "reply-1" });
  assert.equal(store.get(old.requestId)?.state, "done");

  const busy = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "busy-1" });
  await store.beginChild({ parentTaskId: "busy-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "busy-2" });
  await store.settleTurn("busy-1", { status: "succeeded", messageId: "reply-3" });

  clock.advance((workFoldRequestLimits.retentionDays + 1) * 24 * 60 * 60 * 1000);
  const purge = await store.purgeExpired();
  assert.equal(purge.purged, 2);
  assert.equal(store.get(old.requestId), null);
  assert.equal(store.get(oldChild.requestId), null);
  assert.equal(store.question(oldQuestion.questionId), null);
  assert.equal(existsSync(join(root, "results", oldChild.requestId)), false);
  assert.ok(store.get(busy.requestId), "a root with work still outstanding below it is kept");
  assert.ok(store.lastPurgeAt());

  // Purged text does not survive in the rotated generation either.
  const remaining = await readFile(join(root, "requests.jsonl"), "utf8");
  assert.equal(remaining.includes(old.requestId), false);
  assert.equal(existsSync(join(root, "requests.1.jsonl")), false);

  // The daily wrapper does not purge twice in the same window.
  assert.equal(await store.purgeExpiredIfDue(), null);

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  assert.equal(reopened.get(old.requestId), null);
  assert.ok(reopened.get(busy.requestId));

  await Promise.all([store.flush(), reopened.flush()]);
});

test("one task id belongs to one request, and a joined turn keeps one story", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });

  const first = await store.beginRoot({
    kind: "management",
    owner: managementOwner,
    surface: "popover",
    taskId: "task-1",
    content: "Use Audits",
    attachments: [{ kind: "file", target: "/tmp/a.pdf", name: "a.pdf" }],
  });
  const again = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1", content: "different" });
  assert.equal(again.requestId, first.requestId);
  assert.equal(again.content, "Use Audits", "a replayed acceptance never rewrites the record");
  await store.flush();
  assert.equal((await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").length, 1);

  await store.recordAction("task-1", { command: "files.add", at: clock.now().toISOString(), spaceId: "space-audits", spaceName: "Audits" });
  await store.settleTurn("task-1", { status: "succeeded", messageId: "reply-1" });

  const joined = await store.joinTurn({
    requestId: first.requestId,
    taskId: "task-2",
    content: "Use Audits",
    attachments: [{ kind: "url", target: "https://example.com/ledger", name: "example.com/ledger" }],
  });
  assert.equal(joined.requestId, first.requestId);
  assert.equal(joined.continuedFromTaskId, "task-1");
  assert.deepEqual(joined.attachments.map((attachment) => attachment.kind), ["file", "url"]);
  assert.equal(joined.actions.length, 1);
  assert.equal(joined.content, "Use Audits");
  assert.equal(joined.turns.length, 2);
  assert.equal(joined.turns[1]?.role, "continuation");
  assert.equal(joined.state, "working");
  assert.equal(store.byTaskId("task-1")?.requestId, store.byTaskId("task-2")?.requestId);

  await store.flush();
});

test("a model spending cap stops a runaway graph and names the cap", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now, providerBudgetUsd: 1 });

  const request = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });
  await store.beginChild({ parentTaskId: "task-1", kind: "space", owner: spaceOwner, surface: "cli", taskId: "task-2" });
  await store.settleTurn("task-2", {
    status: "succeeded",
    messageId: "reply-2",
    usage: { provider: "anthropic", modelId: "test-model", inputTokens: 10, outputTokens: 5, amountUsd: 1.5 },
  });

  const stopped = store.get(request.requestId);
  assert.equal(stopped?.state, "failed");
  assert.equal(stopped?.limitHit?.limit, "providerBudget");

  await store.flush();
});

test("usage stays honest when a model carries no published rates", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const request = await store.beginRoot({ kind: "space", owner: spaceOwner, surface: "renderer", taskId: "task-1" });
  await store.settleTurn("task-1", {
    status: "succeeded",
    messageId: "reply-1",
    usage: { provider: "local", modelId: "unpriced", inputTokens: 7, outputTokens: 3 },
  });
  const usage = store.get(request.requestId)?.usage;
  assert.equal(usage?.turns, 1);
  assert.equal(usage?.inputTokens, 7);
  assert.equal(usage?.amountUsdComplete, false);
  assert.equal(usage?.amountUsd, undefined);

  await store.flush();
});

test("follow-up turns are counted against the root and the bound names itself", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const request = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });

  for (let index = 1; index <= workFoldRequestLimits.maxContinuationsPerRoot; index += 1) {
    assert.deepEqual(await store.noteContinuation(request.requestId), { allowed: true, count: index });
  }
  assert.deepEqual(
    await store.noteContinuation(request.requestId),
    { allowed: false, count: workFoldRequestLimits.maxContinuationsPerRoot },
  );
  assert.equal(store.continuationsEnabled(), true);
  await store.setContinuationsEnabled(false);
  assert.equal(store.continuationsEnabled(), false);
  await store.flush();

  const reopened = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  assert.equal(reopened.continuationsEnabled(), false);
  assert.equal(reopened.get(request.requestId)?.continuationCount, workFoldRequestLimits.maxContinuationsPerRoot);
  await reopened.flush();
});

test("the action trail is bounded and only an explicitly named request is credited", async (t) => {
  const root = await temporaryRoot(t);
  const clock = clockFrom("2026-09-11T09:00:00.000Z");
  const store = await WorkFoldRequestStore.open({ rootPath: root, now: clock.now });
  const request = await store.beginRoot({ kind: "management", owner: managementOwner, surface: "popover", taskId: "task-1" });

  assert.equal(await store.recordAction(undefined, { command: "files.add", at: clock.now().toISOString() }), null);
  assert.equal(await store.recordAction("task-unknown", { command: "files.add", at: clock.now().toISOString() }), null);
  assert.equal(await store.recordAction("task-1", { command: "library.add", at: clock.now().toISOString() }), request.requestId);

  for (let index = store.get(request.requestId)!.actions.length; index < workFoldRequestLimits.maxActionsPerRequest; index += 1) {
    await store.recordAction("task-1", { command: "files.move", at: clock.now().toISOString(), spaceId: "space-audits", spaceName: "Audits" });
  }
  assert.equal(store.get(request.requestId)?.actions.length, workFoldRequestLimits.maxActionsPerRequest);
  assert.equal(await store.recordAction("task-1", { command: "files.move", at: clock.now().toISOString() }), null);

  // Recording an act never creates a child request; only `beginChild` does.
  assert.deepEqual(store.get(request.requestId)?.childRequestIds, []);

  await store.flush();
});

test("every bound names its number and the Settings section that shows it", () => {
  const caps: Array<[WorkFoldRequestLimitName, number]> = [
    ["deadline", workFoldRequestLimits.deadlineMs],
    ["childTasks", workFoldRequestLimits.maxChildRequestsPerRoot],
    ["depth", workFoldRequestLimits.maxDelegationDepth],
    ["concurrentChildren", workFoldRequestLimits.maxConcurrentChildrenPerRoot],
    ["continuations", workFoldRequestLimits.maxContinuationsPerRoot],
    ["providerBudget", 25],
    ["questionLifetime", workFoldRequestLimits.deadlineMs],
    ["questionText", workFoldRequestLimits.maxQuestionTextBytes],
    ["answerText", workFoldRequestLimits.maxAnswerTextBytes],
    ["resultSummary", workFoldRequestLimits.maxResultSummaryBytes],
    ["resultData", workFoldRequestLimits.maxResultDataBytes],
    ["resultFiles", workFoldRequestLimits.maxResultFiles],
    ["questionsPerRequest", workFoldRequestLimits.maxQuestionsPerRequest],
    ["resultsPerRequest", workFoldRequestLimits.maxResultsPerRequest],
    ["turnsPerRequest", workFoldRequestLimits.maxTurnsPerRequest],
    ["actionsPerRequest", workFoldRequestLimits.maxActionsPerRequest],
  ];
  for (const [limit, cap] of caps) {
    const message = workFoldRequestLimitMessage(limit, cap);
    const shown = limit === "deadline" || limit === "questionLifetime"
      ? String(Math.round(cap / 3_600_000))
      : cap >= 1024 && limit.startsWith("result") || limit.endsWith("Text")
        ? String(Math.round(cap / 1024))
        : String(cap);
    assert.ok(message.includes(shown), `${limit} names its number`);
    assert.ok(message.includes(limitsSection), `${limit} names the Settings section`);
    // A bound is a bound, never a gate: nothing here asks a person to allow anything.
    assert.doesNotMatch(message, /staged|approv|polic|Reviewed|Unrestricted|\bcard\b|\bmode\b|sandbox|digest/i);
  }
});
