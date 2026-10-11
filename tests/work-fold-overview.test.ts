import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChatMessage, ConversationSummary } from "../src/local/agent/chat-store.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import type { WorkFoldCheckStatusSnapshot } from "../src/local/checks/check-types.js";
import {
  composeWorkFoldOverview,
  createWorkFoldOverviewAutomationRunReader,
  createWorkFoldOverviewViewerGrantReader,
  workFoldOverviewChatRecordFromMessages,
  workFoldOverviewChangesPerKindCap,
  workFoldOverviewChangesTotalCap,
  workFoldOverviewChecksCap,
  workFoldOverviewNeedsYouCap,
  workFoldOverviewRunningCap,
  type WorkFoldOverviewChatRecord,
  type WorkFoldOverviewSourceReaders,
  type WorkFoldOverviewWorkFolderRef,
} from "../src/local/overview.js";
import { startLocalApi } from "../src/local/server.js";

const composedAtIso = "2026-08-10T12:00:00.000Z";
const alpha: WorkFoldOverviewWorkFolderRef = { id: "work-folder-a", name: "Alpha", workFolderRoot: "/work-folders/alpha" };
const beta: WorkFoldOverviewWorkFolderRef = { id: "work-folder-b", name: "Beta", workFolderRoot: "/work-folders/beta" };

test("composeWorkFoldGlance is deterministic and orders every section", async () => {
  const input = () => ({
    now: new Date(composedAtIso),
    workFolders: [beta, alpha],
    sources: fullFixtureSources(),
    seen: {
      "remote:grant-1": "2026-08-10T09:00:00.000Z/act-receipts:req-0",
      popover: "2026-08-10T10:00:00.000Z/act-receipts:req-0",
    },
  });
  const first = await composeWorkFoldOverview(input());
  const second = await composeWorkFoldOverview(input());
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    "the same recorded state and clock reading must produce a byte-identical digest",
  );

  assert.equal(first.kind, "work-fold.overview.experimental");
  assert.equal(first.version, 0);
  assert.equal(first.composedAt, composedAtIso);
  assert.deepEqual(first.truncated, { running: false, needsYou: false, changes: false, checks: false });
  assert.deepEqual(first.unavailable, []);

  // Running: longest-running first, one item per work-fold agent request, the
  // request's own turn and its running child folded into the headline count.
  assert.deepEqual(first.running.map((item) => item.id), [
    "agent-requests:req-mgmt",
    "kernel-tasks:task-turn",
    "kernel-tasks:task-compact",
    "kernel-tasks:task-check",
    "app-automation-schedule:auto-run-1",
    "automation-runs:rr-1",
  ]);
  assert.equal(first.running[0].headline, "Handling your request — 1 Worker turn running");
  assert.deepEqual(first.running[0].ref, { taskId: "task-mgmt", conversationId: "mgmt-1", requestId: "req-mgmt" });
  assert.equal(first.running[1].workFolderName, "Alpha");
  assert.equal(first.running[1].kind, "assistant-turn", "a plain work-folder turn's own root never replaces its kernel task");
  assert.ok(!first.running.some((item) => item.id === "agent-requests:req-wait"), "a waiting request is not running");
  assert.equal(first.running[3].kind, "check-run");
  assert.equal(first.running[5].headline, 'Automation "Weekly handoff" running');

  // Needs you: questions and due snoozes only, newest first. Nothing here is
  // an approval (docs/receipts-not-gates.md, F24).
  assert.deepEqual(first.needsYou.map((item) => item.id), [
    "chats:chat-s:due-snooze:2026-08-10T11:30:00.000Z",
    "agent-requests:req-wait:question:q-person",
    "chats:chat-q:question",
    "agent-requests:req-ask",
  ]);
  assert.deepEqual(new Set(first.needsYou.map((item) => item.kind)), new Set(["due-snooze", "chat-question", "request-question"]));
  assert.equal(first.needsYou[1].headline, '"Beta" is waiting on your answer');
  assert.equal(first.needsYou[1].workFolderName, "Beta");
  assert.deepEqual(first.needsYou[1].ref, { taskId: "task-wait", conversationId: "chat-wait", requestId: "req-wait", questionId: "q-person" });
  assert.ok(!first.needsYou.some((item) => item.ref?.questionId === "q-parent"), "a question addressed to the parent request belongs to that agent, never to the person");
  assert.equal(first.needsYou[2].headline, '"Quarterly plan" is waiting on your reply');
  assert.equal(first.needsYou[2].workFolderName, "Alpha");
  assert.equal(first.needsYou[3].headline, "Your request is waiting on your answer");

  // Since you last looked: newest first.
  assert.deepEqual(first.changes.map((item) => item.id), [
    "viewer-grants:pub-1:revoked",
    "act-receipts:req-1",
    "history-checkpoints:work-folder-a:cp-1",
    "viewer-grants:pub-1:created",
    "act-receipts:req-2",
    "app-automation-receipts:ar-1",
    "checks:work-folder-a:run-1",
    "automation-runs:rr-0",
    "agent-requests:req-done",
    "agent-requests:req-expired",
    "settled-turns:task-old",
    "history-checkpoints:work-folder-a:cp-2",
    "chats:chat-s:msg-snooze",
    "chats:chat-x:msg-arch",
    "chats:chat-x:msg-ren",
  ]);
  assert.equal(first.changes[8].headline, "Request done");
  assert.equal(first.changes[9].headline, "Request ran out of time");
  assert.deepEqual(first.changes[9].ref, { taskId: "task-expired", conversationId: "mgmt-1", requestId: "req-expired" });
  assert.ok(!first.changes.some((item) => item.id === "agent-requests:req-plain-old"), "a plain work-folder turn's settle is its turn-settled item, not a second request item");
  assert.equal(first.cursor, "2026-08-10T10:58:00.000Z/viewer-grants:pub-1:revoked");
  const actItem = first.changes[1];
  assert.equal(actItem.headline, "Performed files.add — restore point saved");
  assert.equal(actItem.workFolderName, "work-folder-gone (removed)", "an unregistered work-folder renders the id plus (removed)");
  assert.deepEqual(actItem.ref, { checkpointId: "cp-9", requestId: "req-1" });
  assert.equal(first.changes[4].headline, "chat.rename failed");
  assert.equal(first.changes[6].headline, "Check run failed — 2 findings admitted");
  assert.equal(first.changes[7].headline, 'Automation "Weekly handoff" failed — 1/3 steps completed');
  assert.equal(first.changes[12].headline, '"Waiting" snoozed until 2026-08-10T11:30:00.000Z');

  // Checks: one row per work-folder with configured Checks; unconfigured is absent.
  assert.deepEqual(first.checks, [{
    workFolderId: "work-folder-a",
    workFolderName: "Alpha",
    state: "needs-attention",
    needsAttention: 1,
    neverRun: 0,
    stale: 1,
    blocked: 0,
    errors: 0,
    lastRunAt: "2026-08-10T10:00:00.000Z",
  }]);

  // Seen markers pass through with sorted surface keys.
  assert.deepEqual(Object.keys(first.seen), ["popover", "remote:grant-1"]);
});

/** One second apart from the start of the fixture day, so any cap fits before composition time. */
function overflowTime(index: number): string {
  return new Date(Date.parse("2026-08-10T00:00:00.000Z") + index * 1_000).toISOString();
}

test("running overflow drops the newest items and discloses truncation", async () => {
  const tasks = Array.from({ length: workFoldOverviewRunningCap + 4 }, (_item, index) => ({
    id: `task-${String(index).padStart(4, "0")}`,
    kind: "assistant_turn" as const,
    workFolderId: alpha.id,
    startedAt: overflowTime(index),
  }));
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: { runningTasks: async () => tasks },
  });
  assert.equal(snapshot.running.length, workFoldOverviewRunningCap);
  assert.equal(snapshot.truncated.running, true);
  assert.equal(snapshot.running[0].id, "kernel-tasks:task-0000", "the longest-running task must stay visible");
  assert.ok(
    !snapshot.running.some((item) => item.id === `kernel-tasks:task-${String(workFoldOverviewRunningCap + 3).padStart(4, "0")}`),
    "overflow must drop the newest, never the oldest",
  );
});

test("needs-you overflow keeps the newest questions and states truncation", async () => {
  const chats: WorkFoldOverviewChatRecord[] = Array.from({ length: workFoldOverviewNeedsYouCap + 2 }, (_item, index) => ({
    conversationId: `chat-${String(index).padStart(4, "0")}`,
    title: `Question ${index}`,
    archivedAt: null,
    snoozedUntil: null,
    newestMessage: { role: "assistant", createdAt: overflowTime(index), followUpPrompt: "Ready?" },
    lifecycleEvents: [],
    titleEvents: [],
  }));
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: { chats: async () => chats },
  });
  assert.equal(snapshot.needsYou.length, workFoldOverviewNeedsYouCap);
  assert.equal(snapshot.truncated.needsYou, true);
  assert.ok(snapshot.needsYou.every((item) => item.kind === "chat-question"));
  assert.equal(snapshot.needsYou[0].id, `chats:chat-${String(workFoldOverviewNeedsYouCap + 1).padStart(4, "0")}:question`, "the newest question comes first; overflow drops the oldest");
});

test("needs-you carries questions, request questions, and due snoozes only", async () => {
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: fullFixtureSources(),
  });
  const kinds = new Set(snapshot.needsYou.map((item) => item.kind));
  assert.deepEqual(kinds, new Set(["request-question", "chat-question", "due-snooze"]));
  assert.ok(snapshot.needsYou.every((item) => item.ref?.conversationId || item.ref?.taskId), "every needs-you item points at the conversation or request that asked");
});

test("a question addressed to the parent agent never becomes a needs-you item", async () => {
  // `chat ask --to parent` puts the asking request in state `waiting`, and a
  // waiting state maps to phase `needs_you` — but that question belongs to
  // the parent's agent, not to the person (docs/work-fold-agent-overview.md, F24/F27).
  // The root is waiting for the same reason and must stay quiet too.
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: {
      workFoldAgentRequests: async () => [
        {
          requestId: "req-root", kind: "agent", state: "waiting", taskId: "task-root", conversationId: "mgmt-1",
          phase: "needs_you", startedAt: "2026-08-10T09:00:00.000Z", endedAt: null, childTaskIds: ["task-child"],
          openQuestions: [], questionCount: 0, resultCount: 0,
        },
        {
          requestId: "req-child", kind: "work-folder", state: "waiting", taskId: "task-child", conversationId: "chat-child",
          workFolderId: alpha.id, phase: "needs_you", startedAt: "2026-08-10T09:05:00.000Z", endedAt: null, childTaskIds: [],
          openQuestions: [{ questionId: "q-parent", respondent: "parent", askedAt: "2026-08-10T09:06:00.000Z" }],
          questionCount: 1, resultCount: 0,
        },
      ],
    },
  });
  assert.deepEqual(snapshot.needsYou, [], "nothing here is the person's to answer");

  // The same shape with the question put to the person does produce exactly
  // one item, and it carries the question id a surface reads by.
  const personAsked = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: {
      workFoldAgentRequests: async () => [
        {
          requestId: "req-child", kind: "work-folder", state: "waiting", taskId: "task-child", conversationId: "chat-child",
          workFolderId: alpha.id, phase: "needs_you", startedAt: "2026-08-10T09:05:00.000Z", endedAt: null, childTaskIds: [],
          openQuestions: [{ questionId: "q-person", respondent: "person", askedAt: "2026-08-10T09:06:00.000Z" }],
          questionCount: 1, resultCount: 0,
        },
      ],
    },
  });
  assert.equal(personAsked.needsYou.length, 1);
  assert.equal(personAsked.needsYou[0]!.ref?.questionId, "q-person");
});

test("changes are bounded per kind and in total, newest first", async () => {
  const stamp = (index: number): string => `2026-08-10T10:${String(index).padStart(2, "0")}:00.000Z`;
  const perSource = workFoldOverviewChangesPerKindCap + 1;
  const indexes = Array.from({ length: perSource }, (_item, index) => index);
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: {
      checkpoints: async () => indexes.map((index) => ({
        checkpointId: `cp-${index}`,
        createdAt: stamp(index),
        reason: "manual",
        scope: "full" as const,
      })),
      settledTurns: async () => indexes.map((index) => ({
        taskId: `task-${index}`,
        workFolderId: alpha.id,
        outcome: "succeeded" as const,
        endedAt: stamp(index),
      })),
      actReceipts: async () => indexes.map((index) => ({
        v: 2 as const,
        at: stamp(index),
        requestId: `req-${index}`,
        command: "chat.send",
        outcome: "ok" as const,
      })),
      appAutomationRunReceipts: async () => indexes.map((index) => ({
        receiptId: `ar-${index}`,
        runId: `run-${index}`,
        appAutomationId: "collect",
        outcome: "success" as const,
        finishedAt: stamp(index),
      })),
      viewerGrants: async () => indexes.map((index) => ({
        publicationId: `pub-${index}`,
        event: "created" as const,
        at: stamp(index),
      })),
    },
  });
  assert.equal(snapshot.changes.length, workFoldOverviewChangesTotalCap);
  assert.equal(snapshot.truncated.changes, true);
  const counts = new Map<string, number>();
  for (const item of snapshot.changes) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  for (const [kind, count] of counts) {
    assert.ok(count <= workFoldOverviewChangesPerKindCap, `${kind} must respect the per-kind cap`);
  }
  for (let index = 1; index < snapshot.changes.length; index += 1) {
    assert.ok(
      snapshot.changes[index - 1].at >= snapshot.changes[index].at,
      "changes must render newest first",
    );
  }
  assert.ok(
    !snapshot.changes.some((item) => item.at === stamp(0)),
    "the per-kind cut drops the oldest records",
  );
});

test("checks rows order by state severity and respect the row cap", async () => {
  const workFolders = Array.from({ length: workFoldOverviewChecksCap + 2 }, (_item, index) => ({
    id: `work-folder-${String(index).padStart(2, "0")}`,
    name: `work-folder ${String(index).padStart(2, "0")}`,
    workFolderRoot: `/work-folders/${index}`,
  }));
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders,
    sources: {
      checks: async (workFolder) => ({
        status: checkStatus(workFolder.id, workFolder.id === "work-folder-01" ? "needs-attention" : "current-clear"),
        settledRuns: [],
      }),
    },
  });
  assert.equal(snapshot.checks.length, workFoldOverviewChecksCap);
  assert.equal(snapshot.truncated.checks, true);
  assert.equal(snapshot.checks[0].workFolderId, "work-folder-01", "needs-attention must sort before current-clear");
});

test("restart honesty: absent readers render their kinds absent, not unavailable", async () => {
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: {
      checkpoints: async () => [{
        checkpointId: "cp-1",
        createdAt: "2026-08-10T10:00:00.000Z",
        reason: "manual",
        scope: "full" as const,
      }],
    },
  });
  assert.deepEqual(snapshot.running, []);
  assert.deepEqual(snapshot.needsYou, []);
  assert.deepEqual(snapshot.changes.map((item) => item.kind), ["checkpoint-saved"]);
  assert.deepEqual(snapshot.unavailable, [], "an absent reader is absence, never a read failure");
  assert.deepEqual(snapshot.seen, {});
  assert.equal(snapshot.cursor, "2026-08-10T10:00:00.000Z/history-checkpoints:work-folder-a:cp-1");
});

test("a failing reader is disclosed as unavailable, never rendered as quiet", async () => {
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha, beta],
    sources: {
      actReceipts: async () => { throw new Error("journal damaged"); },
      checkpoints: async (workFolder) => {
        if (workFolder.id === alpha.id) throw new Error("store damaged");
        return [{
          checkpointId: "cp-b",
          createdAt: "2026-08-10T10:00:00.000Z",
          reason: "manual",
          scope: "full" as const,
        }];
      },
    },
  });
  assert.deepEqual(snapshot.unavailable, ["act-receipts", "history-checkpoints"]);
  assert.deepEqual(
    snapshot.changes.map((item) => item.id),
    ["history-checkpoints:work-folder-b:cp-b"],
    "work-folders that could be read stay rendered while the failure is disclosed",
  );
});

test("chat records derive question, snooze, lifecycle, and rename semantics", async () => {
  const summary: ConversationSummary = {
    id: "chat-1",
    title: "Planning",
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T10:30:00.000Z",
    archivedAt: null,
    snoozedUntil: null,
  };
  const messages: ChatMessage[] = [
    {
      id: "msg-seed",
      role: "system",
      kind: "conversation_title",
      titleSource: "placeholder",
      content: "New Chat",
      createdAt: "2026-08-10T08:00:00.000Z",
    },
    { id: "msg-user", role: "user", content: "Plan the week", createdAt: "2026-08-10T08:01:00.000Z" },
    {
      id: "msg-assistant",
      role: "assistant",
      content: "Draft ready.",
      createdAt: "2026-08-10T10:30:00.000Z",
      landing: {
        summary: "Drafted the plan.",
        nextActions: [],
        followUpPrompt: "Should I file it under reports/?",
        generatedAt: "2026-08-10T10:30:00.000Z",
        provider: "anthropic",
        model: "test-model",
      },
    },
    {
      id: "msg-snooze",
      role: "system",
      kind: "conversation_lifecycle",
      content: "Chat snoozed until 2026-08-12T09:00:00.000Z.",
      lifecycle: { snoozedUntil: "2026-08-12T09:00:00.000Z" },
      createdAt: "2026-08-10T10:40:00.000Z",
    },
    {
      id: "msg-rename",
      role: "system",
      kind: "conversation_title",
      titleSource: "manual",
      content: "Weekly planning",
      createdAt: "2026-08-10T10:45:00.000Z",
    },
  ];
  const record = workFoldOverviewChatRecordFromMessages(summary, messages);
  assert.deepEqual(record.newestMessage, {
    role: "assistant",
    createdAt: "2026-08-10T10:30:00.000Z",
    followUpPrompt: "Should I file it under reports/?",
  }, "bookkeeping system messages never hide the newest real message");
  assert.deepEqual(record.lifecycleEvents, [{
    messageId: "msg-snooze",
    createdAt: "2026-08-10T10:40:00.000Z",
    change: "snoozed",
    snoozedUntil: "2026-08-12T09:00:00.000Z",
  }]);
  assert.deepEqual(record.titleEvents, [{
    messageId: "msg-rename",
    createdAt: "2026-08-10T10:45:00.000Z",
    title: "Weekly planning",
    source: "manual",
  }], "the creation seed title is not a rename");

  const compose = (chat: WorkFoldOverviewChatRecord, sources: WorkFoldOverviewSourceReaders = {}) =>
    composeWorkFoldOverview({
      now: new Date(composedAtIso),
      workFolders: [alpha],
      sources: { chats: async () => [chat], ...sources },
    });

  const active = await compose({ ...record, snoozedUntil: null });
  assert.deepEqual(active.needsYou.map((item) => item.kind), ["chat-question"]);

  const running = await compose({ ...record, snoozedUntil: null }, {
    runningTasks: async () => [{
      id: "task-1",
      kind: "assistant_turn",
      workFolderId: alpha.id,
      conversationId: "chat-1",
      startedAt: "2026-08-10T11:59:00.000Z",
    }],
  });
  assert.ok(
    !running.needsYou.some((item) => item.kind === "chat-question"),
    "a running Chat is not waiting on the person",
  );

  const replied = await compose({
    ...record,
    snoozedUntil: null,
    newestMessage: { role: "user", createdAt: "2026-08-10T11:00:00.000Z", followUpPrompt: null },
  });
  assert.ok(
    !replied.needsYou.some((item) => item.kind === "chat-question"),
    "the item clears when the person replies",
  );

  const archived = await compose({ ...record, archivedAt: "2026-08-10T11:00:00.000Z", snoozedUntil: null });
  assert.ok(
    !archived.needsYou.some((item) => item.kind === "chat-question" || item.kind === "due-snooze"),
    "archived Chats are structurally not waiting on the person",
  );

  const dueSnooze = await compose({ ...record, snoozedUntil: "2026-08-10T11:30:00.000Z" });
  assert.deepEqual(dueSnooze.needsYou.map((item) => item.kind), ["due-snooze"]);
  const futureSnooze = await compose({ ...record, snoozedUntil: "2026-08-11T11:30:00.000Z" });
  assert.deepEqual(futureSnooze.needsYou, [], "a future snooze is quiet by design");
});

test("tolerant automation-run reader derives runs and hop outcomes from the journal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-stores-"));
  try {
    const reader = createWorkFoldOverviewAutomationRunReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing journal renders absent");

    await mkdir(join(sandbox, "automations"), { recursive: true });
    await writeFile(join(sandbox, "automations", "receipts.1.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:00:00.000Z", runId: "run-old", automationId: "automation-1", scope: "run", outcome: "accepted", title: "Weekly handoff" }),
    ].join("\n"), "utf8");
    await writeFile(join(sandbox, "automations", "receipts.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:10:00.000Z", runId: "run-old", automationId: "automation-1", scope: "run", outcome: "ok" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:00:00.000Z", runId: "run-new", automationId: "automation-1", scope: "run", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:01:00.000Z", runId: "run-new", automationId: "automation-1", scope: "hop", hopId: "review", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:05:00.000Z", runId: "run-new", automationId: "automation-1", scope: "hop", hopId: "review", outcome: "ok" }),
      "this line is damaged",
      JSON.stringify({ v: 9, at: "2026-08-10T11:06:00.000Z", runId: "run-vnext", automationId: "automation-1", scope: "run", outcome: "accepted" }),
    ].join("\n"), "utf8");

    const runs = await reader();
    assert.deepEqual(runs, [
      {
        runId: "run-old",
        automationId: "automation-1",
        title: "Weekly handoff",
        state: "succeeded",
        startedAt: "2026-08-10T09:00:00.000Z",
        endedAt: "2026-08-10T09:10:00.000Z",
        hops: [],
      },
      {
        runId: "run-new",
        automationId: "automation-1",
        state: "running",
        startedAt: "2026-08-10T11:00:00.000Z",
        hops: [{ id: "review", state: "succeeded" }],
      },
    ], "rotated and live lines merge; damaged and unknown-version lines are skipped");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("tolerant viewer-grant reader emits created, revoked, and health-note events", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-overview-stores-"));
  try {
    const reader = createWorkFoldOverviewViewerGrantReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing store renders absent");

    await mkdir(join(sandbox, "shared-pages"), { recursive: true });
    await writeFile(join(sandbox, "shared-pages", "publications.json"), JSON.stringify({
      version: 1,
      publications: [
        {
          publicationId: "pub-1",
          workFolderId: "work-folder-a",
          createdAt: "2026-08-10T10:00:00.000Z",
          title: "Quarterly report",
          // The record's one bounded health note becomes the publisher-facing
          // change event, carrying the recorded title and precise reason.
          lastProblem: {
            state: "not-available",
            reason: "the designated file does not exist as a regular file",
            at: "2026-08-10T11:00:00.000Z",
          },
        },
        {
          publicationId: "pub-2",
          createdAt: "2026-08-10T09:00:00.000Z",
          revokedAt: "2026-08-10T10:30:00.000Z",
          // An unknown problem state is bookkeeping damage, dropped without
          // poisoning the record's lifecycle events.
          lastProblem: { state: "unheard-of", reason: "x", at: "2026-08-10T10:00:00.000Z" },
        },
        { publicationId: "", createdAt: "2026-08-10T09:00:00.000Z" },
      ],
    }), "utf8");
    assert.deepEqual(await reader(), [
      { publicationId: "pub-1", event: "created", at: "2026-08-10T10:00:00.000Z", workFolderId: "work-folder-a" },
      {
        publicationId: "pub-1",
        event: "not-available",
        at: "2026-08-10T11:00:00.000Z",
        workFolderId: "work-folder-a",
        title: "Quarterly report",
        reason: "the designated file does not exist as a regular file",
      },
      { publicationId: "pub-2", event: "created", at: "2026-08-10T09:00:00.000Z" },
      { publicationId: "pub-2", event: "revoked", at: "2026-08-10T10:30:00.000Z" },
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("publication health notes render as publisher-facing change items", async () => {
  // The audience saw the deliberately vague page (docs/shared-pages.md,
  // "Honest states"); the person gets the precise reason here, as a
  // publication-state change item beside — never instead of — the grant's
  // lifecycle items.
  const snapshot = await composeWorkFoldOverview({
    now: new Date(composedAtIso),
    workFolders: [alpha],
    sources: {
      viewerGrants: async () => [
        { publicationId: "pub-1", event: "created", at: "2026-08-10T10:00:00.000Z", workFolderId: "work-folder-a" },
        {
          publicationId: "pub-1",
          event: "not-available",
          at: "2026-08-10T11:00:00.000Z",
          workFolderId: "work-folder-a",
          title: "Quarterly report",
          reason: "the designated file could not be read",
        },
        {
          publicationId: "pub-2",
          event: "resting",
          at: "2026-08-10T11:30:00.000Z",
          title: "Busy page",
          reason: "it hit its serves-per-minute budget at the relay",
        },
        { publicationId: "pub-3", event: "resting", at: "2026-08-10T11:45:00.000Z" },
      ],
    },
  });
  const states = snapshot.changes.filter((item) => item.kind === "publication-state");
  assert.deepEqual(
    states.map((item) => item.id),
    [
      "viewer-grants:pub-3:problem:2026-08-10T11:45:00.000Z",
      "viewer-grants:pub-2:problem:2026-08-10T11:30:00.000Z",
      "viewer-grants:pub-1:problem:2026-08-10T11:00:00.000Z",
    ],
    "the item id carries the note's timestamp so a recurrence after recovery is a new item",
  );
  assert.equal(
    states[2].headline,
    '"Quarterly report" isn\'t reaching viewers — the designated file could not be read',
  );
  assert.equal(states[2].workFolderName, "Alpha");
  assert.deepEqual(states[2].ref, { publicationId: "pub-1" });
  assert.equal(states[1].headline, '"Busy page" is resting — it hit its serves-per-minute budget at the relay');
  assert.equal(
    states[0].headline,
    "A shared page is resting — its viewer budget is used up",
    "a note without a recorded title or reason stays honest and generic",
  );
  assert.ok(
    snapshot.changes.some((item) => item.kind === "viewer-grant-changed" && item.id === "viewer-grants:pub-1:created"),
    "a health note renders beside the grant-lifecycle item, under its own per-kind budget",
  );
});

function fullFixtureSources(): WorkFoldOverviewSourceReaders {
  return {
    runningTasks: async () => [
      { id: "task-turn", kind: "assistant_turn", workFolderId: "work-folder-a", conversationId: "chat-busy", startedAt: "2026-08-10T11:00:00.000Z" },
      { id: "task-compact", kind: "compaction", workFolderId: "work-folder-b", conversationId: "chat-c2", startedAt: "2026-08-10T11:05:00.000Z" },
      { id: "task-check", kind: "check_run", workFolderId: "work-folder-a", startedAt: "2026-08-10T11:10:00.000Z" },
      { id: "task-child", kind: "assistant_turn", workFolderId: "work-folder-b", conversationId: "chat-child", startedAt: "2026-08-10T11:15:00.000Z" },
      { id: "task-mgmt", kind: "assistant_turn", workFolderId: "work-fold-agent", conversationId: "mgmt-1", startedAt: "2026-08-10T10:59:00.000Z" },
    ],
    settledTurns: async () => [
      { taskId: "task-old", workFolderId: "work-folder-a", conversationId: "chat-q", outcome: "succeeded", endedAt: "2026-08-10T07:00:00.000Z" },
    ],
    // Durable requests (F25): the work-fold agent's own requests plus work-folder-owned ones.
    // A request is keyed by its id, which is stable across continuations.
    workFoldAgentRequests: async () => [
      { requestId: "req-mgmt", kind: "agent", state: "working", taskId: "task-mgmt", conversationId: "mgmt-1", phase: "working", startedAt: "2026-08-10T10:59:00.000Z", endedAt: null, childTaskIds: ["task-child"], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-ask", kind: "agent", state: "done", taskId: "task-ask", conversationId: "mgmt-1", phase: "needs_you", startedAt: "2026-08-10T09:00:00.000Z", endedAt: "2026-08-10T09:05:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-done", kind: "agent", state: "done", taskId: "task-done", conversationId: "mgmt-1", phase: "done", startedAt: "2026-08-10T08:00:00.000Z", endedAt: "2026-08-10T08:30:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      // A work-folder-owned request waiting on the person: one needs-you item per
      // open question addressed to the person, none for the one addressed
      // to its parent, and nothing in Running.
      {
        requestId: "req-wait", kind: "work-folder", state: "waiting", taskId: "task-wait", conversationId: "chat-wait", workFolderId: "work-folder-b", phase: "needs_you",
        startedAt: "2026-08-10T10:40:00.000Z", endedAt: null, childTaskIds: [],
        openQuestions: [
          { questionId: "q-person", respondent: "person", askedAt: "2026-08-10T10:45:00.000Z" },
          { questionId: "q-parent", respondent: "parent", askedAt: "2026-08-10T10:46:00.000Z" },
        ],
        questionCount: 2, resultCount: 0,
      },
      // A request that ran out of time settles into Since you last looked.
      { requestId: "req-expired", kind: "agent", state: "expired", taskId: "task-expired", conversationId: "mgmt-1", phase: "stopped", startedAt: "2026-08-09T07:00:00.000Z", endedAt: "2026-08-10T07:30:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      // A plain work-folder turn's own root: one kernel task and one settled turn
      // already describe it, so it is never listed a second time as a request.
      { requestId: "req-plain", kind: "work-folder", state: "working", taskId: "task-turn", conversationId: "chat-busy", workFolderId: "work-folder-a", phase: "working", startedAt: "2026-08-10T11:00:00.000Z", endedAt: null, childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
      { requestId: "req-plain-old", kind: "cli", state: "done", taskId: "task-old", conversationId: "chat-q", workFolderId: "work-folder-a", phase: "done", startedAt: "2026-08-10T06:50:00.000Z", endedAt: "2026-08-10T07:00:00.000Z", childTaskIds: [], openQuestions: [], questionCount: 0, resultCount: 0 },
    ],
    chats: async (workFolder) => workFolder.id === "work-folder-a" ? [
      {
        conversationId: "chat-q",
        title: "Quarterly plan",
        archivedAt: null,
        snoozedUntil: null,
        newestMessage: { role: "assistant", createdAt: "2026-08-10T10:30:00.000Z", followUpPrompt: "Ship it?" },
        lifecycleEvents: [],
        titleEvents: [],
      },
      {
        conversationId: "chat-s",
        title: "Waiting",
        archivedAt: null,
        snoozedUntil: "2026-08-10T11:30:00.000Z",
        newestMessage: { role: "user", createdAt: "2026-08-10T05:59:00.000Z", followUpPrompt: null },
        lifecycleEvents: [
          { messageId: "msg-snooze", createdAt: "2026-08-10T06:00:00.000Z", change: "snoozed", snoozedUntil: "2026-08-10T11:30:00.000Z" },
        ],
        titleEvents: [],
      },
      {
        conversationId: "chat-x",
        title: "Old",
        archivedAt: "2026-08-10T05:00:00.000Z",
        snoozedUntil: null,
        newestMessage: { role: "assistant", createdAt: "2026-08-10T04:30:00.000Z", followUpPrompt: "Still there?" },
        lifecycleEvents: [
          { messageId: "msg-arch", createdAt: "2026-08-10T05:00:00.000Z", change: "archived" },
        ],
        titleEvents: [
          { messageId: "msg-ren", createdAt: "2026-08-10T04:00:00.000Z", title: "Old", source: "manual" },
        ],
      },
    ] : [],
    checkpoints: async (workFolder) => workFolder.id === "work-folder-a" ? [
      { checkpointId: "cp-1", createdAt: "2026-08-10T10:45:00.000Z", label: "Before cleanup", reason: "manual", scope: "full" },
      { checkpointId: "cp-2", createdAt: "2026-08-10T06:30:00.000Z", reason: "mutation", scope: "targeted" },
    ] : [],
    checks: async (workFolder) => workFolder.id === "work-folder-a"
      ? {
        status: {
          ...checkStatus("work-folder-a", "needs-attention"),
          needsAttention: 1,
          stale: 1,
          lastRunAt: "2026-08-10T10:00:00.000Z",
        },
        settledRuns: [
          { runId: "run-1", taskId: "task-cr", state: "failed", startedAt: "2026-08-10T09:50:00.000Z", endedAt: "2026-08-10T09:55:00.000Z", admittedCount: 2 },
        ],
      }
      : { status: checkStatus("work-folder-b", "not-configured"), settledRuns: [] },
    actReceipts: async (): Promise<WorkFoldCliActReceipt[]> => [
      { v: 2, at: "2026-08-10T10:50:00.000Z", requestId: "req-1", command: "files.add", workFolderId: "work-folder-gone", outcome: "ok", checkpointId: "cp-9" },
      { v: 1, at: "2026-08-10T10:20:00.000Z", requestId: "req-2", command: "chat.rename", workFolderId: "work-folder-a", outcome: "error", errorCode: "conflict" },
      { v: 2, at: "2026-08-10T10:55:00.000Z", requestId: "req-3", command: "chat.send", outcome: "accepted" },
    ],
    appAutomationRuns: async () => [
      { runId: "auto-run-1", appAutomationId: "collect", workFolderId: "work-folder-b", startedAt: "2026-08-10T11:20:00.000Z" },
    ],
    appAutomationRunReceipts: async () => [
      { receiptId: "ar-1", runId: "auto-run-0", appAutomationId: "collect", workFolderId: "work-folder-b", outcome: "success", finishedAt: "2026-08-10T10:10:00.000Z" },
    ],
    automationRuns: async () => [
      { runId: "rr-1", automationId: "automation-1", title: "Weekly handoff", state: "running", startedAt: "2026-08-10T11:25:00.000Z", hops: [] },
      {
        runId: "rr-0",
        automationId: "automation-1",
        title: "Weekly handoff",
        state: "failed",
        startedAt: "2026-08-10T09:00:00.000Z",
        endedAt: "2026-08-10T09:10:00.000Z",
        hops: [
          { id: "review", state: "succeeded" },
          { id: "handoff", state: "failed" },
          { id: "verify", state: "skipped" },
        ],
      },
    ],
    viewerGrants: async () => [
      { publicationId: "pub-1", event: "created", at: "2026-08-10T10:40:00.000Z", workFolderId: "work-folder-a" },
      { publicationId: "pub-1", event: "revoked", at: "2026-08-10T10:58:00.000Z", workFolderId: "work-folder-a" },
    ],
  };
}

function checkStatus(workFolderId: string, state: WorkFoldCheckStatusSnapshot["state"]): WorkFoldCheckStatusSnapshot {
  return {
    kind: "work-fold.checks.experimental",
    version: 0,
    workFolderId,
    state,
    configured: state === "not-configured" ? 0 : 2,
    proposed: 0,
    enabled: state === "not-configured" ? 0 : 2,
    current: state === "current-clear" ? 2 : 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  };
}


test("the local API wires the overview's live-registry readers end to end", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-overview-server-"));
  await mkdir(join(sandbox, "agent", "extensions"), { recursive: true });
  await writeFile(join(sandbox, "agent", "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", {
      description: "Hold a test turn",
      handler: async () => await new Promise((resolve) => setTimeout(resolve, 150)),
    });
  }\n`, "utf8");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const workFolder = await facade.createWorkFolder({ name: "Glanced" });

    // Recorded chat activity: a settled turn, a rename, an archive.
    const chat = await facade.createConversation({ workFolder: workFolder.workFolder.id });
    const turn = await facade.sendMessage({ workFolder: workFolder.workFolder.id, conversationId: chat.conversation.id, content: "/hold" });
    await waitForCondition(async () =>
      (await facade.turnStatus({ workFolder: workFolder.workFolder.id, taskId: turn.taskId })).task.state !== "running");
    await facade.chatRename({ workFolder: workFolder.workFolder.id, conversationId: chat.conversation.id, title: "Renamed by hand" });
    await facade.chatArchive({ workFolder: workFolder.workFolder.id, conversationId: chat.conversation.id });

    // History and Checks leave recorded state behind.
    const saved = await facade.historySave({ workFolder: workFolder.workFolder.id, label: "Milestone" });
    const proposalPath = join(sandbox, "presence.work-fold-check.json");
    await writeFile(proposalPath, JSON.stringify({
      kind: "work-fold.check-proposal",
      version: 1,
      name: "Required delivery",
      createdBy: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      check: {
        title: "The signed delivery exists",
        severity: "error",
        trigger: "manual",
        sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
        targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
      },
    }), "utf8");
    const check = await facade.checksEnable({ workFolder: workFolder.workFolder.id, proposalPath, cwd: sandbox });
    const checkRun = await facade.checksRun({ workFolder: workFolder.workFolder.id, checkId: check.check.id });
    await waitForCondition(async () => {
      const status = await facade.checksTask({ workFolder: workFolder.workFolder.id, taskId: checkRun.taskId });
      return status.task.state !== "accepted" && status.task.state !== "running";
    });

    // A shared page creates grant records.
    await writeFile(join(workFolder.workFolder.workFolderRoot, "notes.md"), "# Notes\n", "utf8");
    const page = await api.publications.activate(
      { workFolderId: workFolder.workFolder.id, relativePath: "notes.md", title: "Notes page" },
      { requestId: "req-overview-page" },
    );

    const pending = await api.kernel.getOverview({ kind: "system" });
    assert.equal(pending.kind, "work-fold.overview.experimental");
    assert.deepEqual(pending.unavailable, [], "every wired source reads cleanly");
    assert.ok(
      pending.needsYou.every((item) => item.kind === "request-question" || item.kind === "chat-question" || item.kind === "due-snooze"),
      "needs-you carries questions and due snoozes only",
    );
    const checkRow = pending.checks.find((row) => row.workFolderId === workFolder.workFolder.id);
    assert.equal(checkRow?.workFolderName, "Glanced");
    assert.equal(checkRow?.state, "needs-attention", "the missing delivery is a Check finding");
    const changeKinds = new Set(pending.changes.map((item) => item.kind));
    for (const expected of [
      "checkpoint-saved",
      "turn-settled",
      "chat-renamed",
      "chat-lifecycle",
      "check-run-settled",
      "viewer-grant-changed",
    ] as const) {
      assert.ok(changeKinds.has(expected), `changes include ${expected}`);
    }
    const checkpointItem = pending.changes.find((item) =>
      item.kind === "checkpoint-saved" && item.ref?.checkpointId === saved.checkpoint.checkpointId);
    assert.equal(checkpointItem?.workFolderName, "Glanced", "work-folder names resolve on per-work-folder items");
    const settledRunItem = pending.changes.find((item) => item.kind === "check-run-settled");
    assert.equal(settledRunItem?.ref?.runId, checkRun.runId, "the content-free settled-run accessor names the run");
    assert.match(settledRunItem?.headline ?? "", /1 finding admitted/);

    // A serve refusal is vague to the audience and precise to the publisher:
    // deleting the source and serving records the bounded health note, and
    // the next digest renders it as a publication-state change item.
    await rm(join(workFolder.workFolder.workFolderRoot, "notes.md"), { force: true });
    const refusal = await api.publications.serveViewerPage(page.publicationId);
    assert.equal(refusal.state, "not-available", "the viewer-facing refusal stays typed and content-free");
    const troubled = await api.kernel.getOverview({ kind: "system" });
    const problemItem = troubled.changes.find((item) => item.kind === "publication-state");
    assert.ok(problemItem, "the serve refusal surfaces as a publisher-facing change item");
    assert.match(problemItem!.headline, /"Notes page" isn't reaching viewers — /);
    assert.equal(problemItem!.ref?.publicationId, page.publicationId);
    assert.equal(problemItem!.workFolderName, "Glanced", "the health item resolves its work-folder name");

    // Revoking the page turns the grant into records, and the publication
    // service's own act receipts reach the ledger reader.
    await api.publications.revoke(page.publicationId, { requestId: "req-overview-revoke" });
    const settled = await api.kernel.getOverview({ kind: "system" });
    assert.ok(
      settled.changes.some((item) => item.kind === "act-performed" && item.ref?.requestId === "req-overview-revoke"),
      "the act-receipts ledger reader surfaces the revocation receipt",
    );
    assert.equal(
      settled.changes.filter((item) => item.kind === "viewer-grant-changed").length,
      2,
      "the publication reader emits created and revoked events",
    );
    assert.ok(settled.cursor, "recorded changes produce a cursor for seen markers");
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
