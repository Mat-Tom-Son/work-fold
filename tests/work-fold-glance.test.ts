import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ChatMessage, ConversationSummary } from "../src/local/agent/chat-store.js";
import type { WorkFoldCliActReceipt } from "../src/local/cli/act-receipts.js";
import type { WorkFoldCheckStatusSnapshot } from "../src/local/checks/check-types.js";
import {
  composeWorkFoldGlance,
  createWorkFoldGlancePolicyChangeReader,
  createWorkFoldGlanceRoutingRunReader,
  createWorkFoldGlanceStagedActReader,
  createWorkFoldGlanceViewerGrantReader,
  workFoldGlanceChatRecordFromMessages,
  workFoldGlanceChangesPerKindCap,
  workFoldGlanceChangesTotalCap,
  workFoldGlanceChecksCap,
  workFoldGlanceNeedsYouCap,
  workFoldGlanceRunningCap,
  type WorkFoldGlanceChatRecord,
  type WorkFoldGlanceSourceReaders,
  type WorkFoldGlanceSpaceRef,
} from "../src/local/glance.js";
import { startLocalApi } from "../src/local/server.js";

const composedAtIso = "2026-08-10T12:00:00.000Z";
const alpha: WorkFoldGlanceSpaceRef = { id: "space-a", name: "Alpha", spaceRoot: "/spaces/alpha" };
const beta: WorkFoldGlanceSpaceRef = { id: "space-b", name: "Beta", spaceRoot: "/spaces/beta" };

test("composeWorkFoldGlance is deterministic and orders every section", async () => {
  const input = () => ({
    now: new Date(composedAtIso),
    spaces: [beta, alpha],
    sources: fullFixtureSources(),
    seen: {
      "remote:grant-1": "2026-08-10T09:00:00.000Z/act-receipts:req-0",
      popover: "2026-08-10T10:00:00.000Z/act-receipts:req-0",
    },
  });
  const first = await composeWorkFoldGlance(input());
  const second = await composeWorkFoldGlance(input());
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(second),
    "the same recorded state and clock reading must produce a byte-identical digest",
  );

  assert.equal(first.kind, "work-fold.glance.experimental");
  assert.equal(first.version, 0);
  assert.equal(first.composedAt, composedAtIso);
  assert.deepEqual(first.truncated, { running: false, needsYou: false, changes: false, checks: false });
  assert.deepEqual(first.unavailable, []);

  // Running: longest-running first, one item per management request, the
  // request's own turn and its running child folded into the headline count.
  assert.deepEqual(first.running.map((item) => item.id), [
    "management-requests:task-mgmt",
    "kernel-tasks:task-turn",
    "kernel-tasks:task-compact",
    "kernel-tasks:task-check",
    "automation-schedule:auto-run-1",
    "routing-runs:rr-1",
  ]);
  assert.equal(first.running[0].headline, "Handling your request — 1 Space turn running");
  assert.equal(first.running[1].spaceName, "Alpha");
  assert.equal(first.running[3].kind, "check-run");
  assert.equal(first.running[5].headline, 'Routing "Weekly handoff" running');

  // Needs you: pending decisions first by soonest expiry, then newest-first.
  assert.deepEqual(first.needsYou.map((item) => item.id), [
    "staged-acts:act-2",
    "staged-acts:act-1",
    "chats:chat-s:due-snooze:2026-08-10T11:30:00.000Z",
    "chats:chat-q:question",
    "management-requests:task-ask",
  ]);
  assert.equal(first.needsYou[0].headline, "Needs your decision: capability.package.install — make bytes runnable");
  assert.equal(first.needsYou[3].headline, '"Quarterly plan" is waiting on your reply');
  assert.equal(first.needsYou[3].spaceName, "Alpha");

  // Since you last looked: newest first, including the lazy staged-act expiry.
  assert.deepEqual(first.changes.map((item) => item.id), [
    "viewer-grants:pub-1:revoked",
    "act-receipts:req-1",
    "history-checkpoints:space-a:cp-1",
    "viewer-grants:pub-1:created",
    "act-receipts:req-2",
    "automation-receipts:ar-1",
    "staged-acts:act-3",
    "checks:space-a:run-1",
    "staged-acts:act-4",
    "routing-runs:rr-0",
    "management-requests:task-done",
    "settled-turns:task-old",
    "history-checkpoints:space-a:cp-2",
    "chats:chat-s:msg-snooze",
    "chats:chat-x:msg-arch",
    "chats:chat-x:msg-ren",
  ]);
  assert.equal(first.cursor, "2026-08-10T10:58:00.000Z/viewer-grants:pub-1:revoked");
  const actItem = first.changes[1];
  assert.equal(actItem.headline, "Performed files.add — restore point saved");
  assert.equal(actItem.spaceName, "space-gone (removed)", "an unregistered Space renders the id plus (removed)");
  assert.deepEqual(actItem.ref, { checkpointId: "cp-9", requestId: "req-1" });
  assert.equal(first.changes[4].headline, "chat.rename failed");
  assert.equal(first.changes[6].headline, "Expired undecided: space.delete-folder");
  assert.equal(first.changes[7].headline, "Check run failed — 2 findings admitted");
  assert.equal(first.changes[9].headline, 'Routing "Weekly handoff" failed — 1/3 steps completed');
  assert.equal(first.changes[13].headline, '"Waiting" snoozed until 2026-08-10T11:30:00.000Z');

  // Checks: one row per Space with configured Checks; unconfigured is absent.
  assert.deepEqual(first.checks, [{
    spaceId: "space-a",
    spaceName: "Alpha",
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

test("running overflow drops the newest items and discloses truncation", async () => {
  const tasks = Array.from({ length: workFoldGlanceRunningCap + 4 }, (_item, index) => ({
    id: `task-${String(index).padStart(2, "0")}`,
    kind: "assistant_turn" as const,
    spaceId: alpha.id,
    startedAt: `2026-08-10T11:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: { runningTasks: async () => tasks },
  });
  assert.equal(snapshot.running.length, workFoldGlanceRunningCap);
  assert.equal(snapshot.truncated.running, true);
  assert.equal(snapshot.running[0].id, "kernel-tasks:task-00", "the longest-running task must stay visible");
  assert.ok(
    !snapshot.running.some((item) => item.id === "kernel-tasks:task-19"),
    "overflow must drop the newest, never the oldest",
  );
});

test("needs-you overflow keeps pending decisions over conversational items", async () => {
  const stagedActs = Array.from({ length: workFoldGlanceNeedsYouCap + 2 }, (_item, index) => ({
    id: `act-${String(index).padStart(2, "0")}`,
    category: "widen-power" as const,
    kind: "routing.enable",
    state: "staged" as const,
    createdAt: "2026-08-10T09:00:00.000Z",
    expiresAt: `2026-08-11T09:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const chatRecord: WorkFoldGlanceChatRecord = {
    conversationId: "chat-q",
    title: "Question",
    archivedAt: null,
    snoozedUntil: null,
    newestMessage: { role: "assistant", createdAt: "2026-08-10T11:59:00.000Z", followUpPrompt: "Ready?" },
    lifecycleEvents: [],
    titleEvents: [],
  };
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: {
      stagedActs: async () => stagedActs,
      chats: async () => [chatRecord],
    },
  });
  assert.equal(snapshot.needsYou.length, workFoldGlanceNeedsYouCap);
  assert.equal(snapshot.truncated.needsYou, true);
  assert.ok(
    snapshot.needsYou.every((item) => item.kind === "pending-decision"),
    "an authority decision outranks a conversational question at the cap",
  );
  assert.equal(snapshot.needsYou[0].id, "staged-acts:act-00", "decisions order by soonest expiry");
});

test("changes are bounded per kind and in total, newest first", async () => {
  const stamp = (index: number): string => `2026-08-10T10:${String(index).padStart(2, "0")}:00.000Z`;
  const perSource = workFoldGlanceChangesPerKindCap + 1;
  const indexes = Array.from({ length: perSource }, (_item, index) => index);
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: {
      checkpoints: async () => indexes.map((index) => ({
        checkpointId: `cp-${index}`,
        createdAt: stamp(index),
        reason: "manual",
        scope: "full" as const,
      })),
      settledTurns: async () => indexes.map((index) => ({
        taskId: `task-${index}`,
        spaceId: alpha.id,
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
      automationRunReceipts: async () => indexes.map((index) => ({
        receiptId: `ar-${index}`,
        runId: `run-${index}`,
        automationId: "collect",
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
  assert.equal(snapshot.changes.length, workFoldGlanceChangesTotalCap);
  assert.equal(snapshot.truncated.changes, true);
  const counts = new Map<string, number>();
  for (const item of snapshot.changes) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  for (const [kind, count] of counts) {
    assert.ok(count <= workFoldGlanceChangesPerKindCap, `${kind} must respect the per-kind cap`);
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
  const spaces = Array.from({ length: workFoldGlanceChecksCap + 2 }, (_item, index) => ({
    id: `space-${String(index).padStart(2, "0")}`,
    name: `Space ${String(index).padStart(2, "0")}`,
    spaceRoot: `/spaces/${index}`,
  }));
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces,
    sources: {
      checks: async (space) => ({
        status: checkStatus(space.id, space.id === "space-01" ? "needs-attention" : "current-clear"),
        settledRuns: [],
      }),
    },
  });
  assert.equal(snapshot.checks.length, workFoldGlanceChecksCap);
  assert.equal(snapshot.truncated.checks, true);
  assert.equal(snapshot.checks[0].spaceId, "space-01", "needs-attention must sort before current-clear");
});

test("restart honesty: absent readers render their kinds absent, not unavailable", async () => {
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
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
  assert.equal(snapshot.cursor, "2026-08-10T10:00:00.000Z/history-checkpoints:space-a:cp-1");
});

test("a failing reader is disclosed as unavailable, never rendered as quiet", async () => {
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha, beta],
    sources: {
      actReceipts: async () => { throw new Error("journal damaged"); },
      checkpoints: async (space) => {
        if (space.id === alpha.id) throw new Error("store damaged");
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
    ["history-checkpoints:space-b:cp-b"],
    "Spaces that could be read stay rendered while the failure is disclosed",
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
  const record = workFoldGlanceChatRecordFromMessages(summary, messages);
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

  const compose = (chat: WorkFoldGlanceChatRecord, sources: WorkFoldGlanceSourceReaders = {}) =>
    composeWorkFoldGlance({
      now: new Date(composedAtIso),
      spaces: [alpha],
      sources: { chats: async () => [chat], ...sources },
    });

  const active = await compose({ ...record, snoozedUntil: null });
  assert.deepEqual(active.needsYou.map((item) => item.kind), ["chat-question"]);

  const running = await compose({ ...record, snoozedUntil: null }, {
    runningTasks: async () => [{
      id: "task-1",
      kind: "assistant_turn",
      spaceId: alpha.id,
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

test("tolerant staged-act reader omits missing, damaged, and unknown-version stores", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-glance-stores-"));
  try {
    const reader = createWorkFoldGlanceStagedActReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing store renders absent");

    const file = join(sandbox, "fold", "staged-acts.json");
    await mkdir(join(sandbox, "fold"), { recursive: true });
    await writeFile(file, "not json", "utf8");
    assert.deepEqual(await reader(), [], "a damaged store is omitted, never an error");

    await writeFile(file, JSON.stringify({ version: 9, acts: [stagedActFixture("act-1")] }), "utf8");
    assert.deepEqual(await reader(), [], "an unknown store version is omitted whole");

    await writeFile(file, JSON.stringify({
      version: 1,
      acts: [
        stagedActFixture("act-1"),
        { ...stagedActFixture("act-2"), schemaVersion: 2 },
        { ...stagedActFixture(""), id: "" },
        { ...stagedActFixture("act-3"), state: "unheard-of" },
      ],
    }), "utf8");
    assert.deepEqual(await reader(), [stagedActRecord("act-1")], "unknown record versions and shapes are skipped");

    await writeFile(file, JSON.stringify([stagedActFixture("act-4")]), "utf8");
    assert.deepEqual(await reader(), [stagedActRecord("act-4")], "a bare record array is accepted");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("tolerant routing-run reader derives runs and hop outcomes from the journal", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-glance-stores-"));
  try {
    const reader = createWorkFoldGlanceRoutingRunReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing journal renders absent");

    await mkdir(join(sandbox, "routings"), { recursive: true });
    await writeFile(join(sandbox, "routings", "receipts.1.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:00:00.000Z", runId: "run-old", routingId: "routing-1", scope: "run", outcome: "accepted", title: "Weekly handoff" }),
    ].join("\n"), "utf8");
    await writeFile(join(sandbox, "routings", "receipts.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:10:00.000Z", runId: "run-old", routingId: "routing-1", scope: "run", outcome: "ok" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:00:00.000Z", runId: "run-new", routingId: "routing-1", scope: "run", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:01:00.000Z", runId: "run-new", routingId: "routing-1", scope: "hop", hopId: "review", outcome: "accepted" }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:05:00.000Z", runId: "run-new", routingId: "routing-1", scope: "hop", hopId: "review", outcome: "ok" }),
      "this line is damaged",
      JSON.stringify({ v: 9, at: "2026-08-10T11:06:00.000Z", runId: "run-vnext", routingId: "routing-1", scope: "run", outcome: "accepted" }),
    ].join("\n"), "utf8");

    const runs = await reader();
    assert.deepEqual(runs, [
      {
        runId: "run-old",
        routingId: "routing-1",
        title: "Weekly handoff",
        state: "succeeded",
        startedAt: "2026-08-10T09:00:00.000Z",
        endedAt: "2026-08-10T09:10:00.000Z",
        hops: [],
      },
      {
        runId: "run-new",
        routingId: "routing-1",
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
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-glance-stores-"));
  try {
    const reader = createWorkFoldGlanceViewerGrantReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing store renders absent");

    await mkdir(join(sandbox, "fold"), { recursive: true });
    await writeFile(join(sandbox, "fold", "publications.json"), JSON.stringify({
      version: 1,
      publications: [
        {
          publicationId: "pub-1",
          spaceId: "space-a",
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
      { publicationId: "pub-1", event: "created", at: "2026-08-10T10:00:00.000Z", spaceId: "space-a" },
      {
        publicationId: "pub-1",
        event: "not-available",
        at: "2026-08-10T11:00:00.000Z",
        spaceId: "space-a",
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
  // The audience saw the deliberately vague page (docs/fold-publishing.md,
  // "Honest states"); the person gets the precise reason here, as a
  // publication-state change item beside — never instead of — the grant's
  // lifecycle items.
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: {
      viewerGrants: async () => [
        { publicationId: "pub-1", event: "created", at: "2026-08-10T10:00:00.000Z", spaceId: "space-a" },
        {
          publicationId: "pub-1",
          event: "not-available",
          at: "2026-08-10T11:00:00.000Z",
          spaceId: "space-a",
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
  assert.equal(states[2].spaceName, "Alpha");
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

test("tolerant policy-change reader merges rotated and live journals and skips damaged lines", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-glance-stores-"));
  try {
    const reader = createWorkFoldGlancePolicyChangeReader({ stateRoot: sandbox });
    assert.deepEqual(await reader(), [], "a missing journal renders absent");

    await mkdir(join(sandbox, "fold"), { recursive: true });
    await writeFile(join(sandbox, "fold", "policy-changes.1.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T08:00:00.000Z", event: "created", attestation: "a".repeat(64), policyId: "policy-1", label: "Marketplace skills" }),
    ].join("\n"), "utf8");
    await writeFile(join(sandbox, "fold", "policy-changes.jsonl"), [
      JSON.stringify({ v: 1, at: "2026-08-10T09:00:00.000Z", event: "disabled", attestation: "b".repeat(64), policyId: "policy-1", label: "Marketplace skills" }),
      "this line is damaged",
      JSON.stringify({ v: 9, at: "2026-08-10T09:30:00.000Z", event: "created", attestation: "c".repeat(64) }),
      JSON.stringify({ v: 1, at: "2026-08-10T10:00:00.000Z", event: "unheard-of", attestation: "d".repeat(64) }),
      JSON.stringify({ v: 1, at: "2026-08-10T10:30:00.000Z", event: "attestation-mismatch", attestation: "e".repeat(64) }),
      JSON.stringify({ v: 1, at: "2026-08-10T11:00:00.000Z", event: "reattested", attestation: "f".repeat(64) }),
    ].join("\n"), "utf8");

    assert.deepEqual(await reader(), [
      { at: "2026-08-10T08:00:00.000Z", event: "created", policyId: "policy-1", label: "Marketplace skills" },
      { at: "2026-08-10T09:00:00.000Z", event: "disabled", policyId: "policy-1", label: "Marketplace skills" },
      { at: "2026-08-10T10:30:00.000Z", event: "attestation-mismatch" },
      { at: "2026-08-10T11:00:00.000Z", event: "reattested" },
    ], "rotated and live lines merge; damaged, unknown-version, and unknown-event lines are skipped");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("policy changes and policy-approved decisions render distinctly in the change list", async () => {
  const snapshot = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: {
      stagedActs: async () => [
        {
          id: "act-clicked",
          category: "widen-power",
          kind: "app.grant.network",
          state: "approved",
          createdAt: "2026-08-10T09:00:00.000Z",
          expiresAt: "2026-08-11T09:00:00.000Z",
          decidedAt: "2026-08-10T09:30:00.000Z",
          decisionSurface: "popover",
        },
        {
          id: "act-policy",
          category: "make-runnable",
          kind: "capability.skills.import",
          state: "approved",
          createdAt: "2026-08-10T10:00:00.000Z",
          expiresAt: "2026-08-11T10:00:00.000Z",
          decidedAt: "2026-08-10T10:00:01.000Z",
          decisionSurface: "policy",
        },
      ],
      policyChanges: async () => [
        { at: "2026-08-10T08:00:00.000Z", event: "created", policyId: "policy-1", label: "Marketplace skills" },
        { at: "2026-08-10T10:30:00.000Z", event: "attestation-mismatch" },
      ],
    },
  });
  assert.deepEqual(snapshot.unavailable, []);
  const byId = new Map(snapshot.changes.map((item) => [item.id, item]));
  assert.equal(
    byId.get("staged-acts:act-policy")?.headline,
    "Auto-approved by standing policy: capability.skills.import",
    "an exercised policy is listed distinctly from clicked approvals",
  );
  assert.equal(byId.get("staged-acts:act-clicked")?.headline, "Approved: app.grant.network");
  const createdItem = byId.get("policy-changes:2026-08-10T08:00:00.000Z:created:policy-1");
  assert.equal(createdItem?.kind, "policy-changed");
  assert.equal(createdItem?.headline, 'Standing policy "Marketplace skills" created');
  assert.deepEqual(createdItem?.ref, { policyId: "policy-1" });
  assert.equal(
    byId.get("policy-changes:2026-08-10T10:30:00.000Z:attestation-mismatch:store")?.headline,
    "Standing policies changed outside Settings — all disabled until re-saved",
    "the fail-closed mismatch is reported, never quiet",
  );

  const failing = await composeWorkFoldGlance({
    now: new Date(composedAtIso),
    spaces: [alpha],
    sources: {
      policyChanges: async () => { throw new Error("journal unreadable"); },
    },
  });
  assert.deepEqual(failing.unavailable, ["policy-changes"], "a failing reader is disclosed, never rendered as quiet");
});

function fullFixtureSources(): WorkFoldGlanceSourceReaders {
  return {
    runningTasks: async () => [
      { id: "task-turn", kind: "assistant_turn", spaceId: "space-a", conversationId: "chat-busy", startedAt: "2026-08-10T11:00:00.000Z" },
      { id: "task-compact", kind: "compaction", spaceId: "space-b", conversationId: "chat-c2", startedAt: "2026-08-10T11:05:00.000Z" },
      { id: "task-check", kind: "check_run", spaceId: "space-a", startedAt: "2026-08-10T11:10:00.000Z" },
      { id: "task-child", kind: "assistant_turn", spaceId: "space-b", conversationId: "chat-child", startedAt: "2026-08-10T11:15:00.000Z" },
      { id: "task-mgmt", kind: "assistant_turn", spaceId: "work-fold-management", conversationId: "mgmt-1", startedAt: "2026-08-10T10:59:00.000Z" },
    ],
    settledTurns: async () => [
      { taskId: "task-old", spaceId: "space-a", conversationId: "chat-q", outcome: "succeeded", endedAt: "2026-08-10T07:00:00.000Z" },
    ],
    managementRequests: async () => [
      { taskId: "task-mgmt", conversationId: "mgmt-1", phase: "working", startedAt: "2026-08-10T10:59:00.000Z", endedAt: null, childTaskIds: ["task-child"] },
      { taskId: "task-ask", conversationId: "mgmt-1", phase: "needs_you", startedAt: "2026-08-10T09:00:00.000Z", endedAt: "2026-08-10T09:05:00.000Z", childTaskIds: [] },
      { taskId: "task-done", conversationId: "mgmt-1", phase: "done", startedAt: "2026-08-10T08:00:00.000Z", endedAt: "2026-08-10T08:30:00.000Z", childTaskIds: [] },
    ],
    chats: async (space) => space.id === "space-a" ? [
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
    checkpoints: async (space) => space.id === "space-a" ? [
      { checkpointId: "cp-1", createdAt: "2026-08-10T10:45:00.000Z", label: "Before cleanup", reason: "manual", scope: "full" },
      { checkpointId: "cp-2", createdAt: "2026-08-10T06:30:00.000Z", reason: "mutation", scope: "targeted" },
    ] : [],
    checks: async (space) => space.id === "space-a"
      ? {
        status: {
          ...checkStatus("space-a", "needs-attention"),
          needsAttention: 1,
          stale: 1,
          lastRunAt: "2026-08-10T10:00:00.000Z",
        },
        settledRuns: [
          { runId: "run-1", taskId: "task-cr", state: "failed", startedAt: "2026-08-10T09:50:00.000Z", endedAt: "2026-08-10T09:55:00.000Z", admittedCount: 2 },
        ],
      }
      : { status: checkStatus("space-b", "not-configured"), settledRuns: [] },
    actReceipts: async (): Promise<WorkFoldCliActReceipt[]> => [
      { v: 2, at: "2026-08-10T10:50:00.000Z", requestId: "req-1", command: "files.add", spaceId: "space-gone", outcome: "ok", checkpointId: "cp-9" },
      { v: 1, at: "2026-08-10T10:20:00.000Z", requestId: "req-2", command: "chat.rename", spaceId: "space-a", outcome: "error", errorCode: "conflict" },
      { v: 2, at: "2026-08-10T10:55:00.000Z", requestId: "req-3", command: "chat.send", outcome: "accepted" },
    ],
    automationRuns: async () => [
      { runId: "auto-run-1", automationId: "collect", spaceId: "space-b", startedAt: "2026-08-10T11:20:00.000Z" },
    ],
    automationRunReceipts: async () => [
      { receiptId: "ar-1", runId: "auto-run-0", automationId: "collect", spaceId: "space-b", outcome: "success", finishedAt: "2026-08-10T10:10:00.000Z" },
    ],
    stagedActs: async () => [
      { id: "act-1", category: "widen-power", kind: "routing.enable", state: "staged", createdAt: "2026-08-10T11:00:00.000Z", expiresAt: "2026-08-11T10:00:00.000Z" },
      { id: "act-2", category: "make-runnable", kind: "capability.package.install", state: "staged", createdAt: "2026-08-10T10:00:00.000Z", expiresAt: "2026-08-11T08:00:00.000Z" },
      { id: "act-3", category: "destroy", kind: "space.delete-folder", state: "staged", createdAt: "2026-08-09T10:00:00.000Z", expiresAt: "2026-08-10T10:00:00.000Z" },
      { id: "act-4", category: "widen-power", kind: "app.grant.network", state: "denied", createdAt: "2026-08-10T08:00:00.000Z", expiresAt: "2026-08-11T08:00:00.000Z", decidedAt: "2026-08-10T09:30:00.000Z" },
    ],
    routingRuns: async () => [
      { runId: "rr-1", routingId: "routing-1", title: "Weekly handoff", state: "running", startedAt: "2026-08-10T11:25:00.000Z", hops: [] },
      {
        runId: "rr-0",
        routingId: "routing-1",
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
      { publicationId: "pub-1", event: "created", at: "2026-08-10T10:40:00.000Z", spaceId: "space-a" },
      { publicationId: "pub-1", event: "revoked", at: "2026-08-10T10:58:00.000Z", spaceId: "space-a" },
    ],
  };
}

function checkStatus(spaceId: string, state: WorkFoldCheckStatusSnapshot["state"]): WorkFoldCheckStatusSnapshot {
  return {
    kind: "work-fold.checks.experimental",
    version: 0,
    spaceId,
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

function stagedActRecord(id: string): {
  id: string;
  category: "widen-power";
  kind: string;
  state: "staged";
  createdAt: string;
  expiresAt: string;
} {
  return {
    id,
    category: "widen-power",
    kind: "routing.enable",
    state: "staged",
    createdAt: "2026-08-10T10:00:00.000Z",
    expiresAt: "2026-08-11T10:00:00.000Z",
  };
}

function stagedActFixture(id: string): { schemaVersion: 1 } & ReturnType<typeof stagedActRecord> {
  return { schemaVersion: 1, ...stagedActRecord(id) };
}

test("the local API wires the glance's live-registry readers end to end", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-glance-server-"));
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
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: {
      async resolveRuntime() {
        return { agentDir: join(sandbox, "agent") };
      },
    },
  });
  try {
    const facade = api.actFacade;
    const space = await facade.createSpace({ name: "Glanced" });

    // Recorded chat activity: a settled turn, a rename, an archive.
    const chat = await facade.createConversation({ space: space.space.id });
    const turn = await facade.sendMessage({ space: space.space.id, conversationId: chat.conversation.id, content: "/hold" });
    await waitForCondition(async () =>
      (await facade.turnStatus({ space: space.space.id, taskId: turn.taskId })).task.state !== "running");
    await facade.chatRename({ space: space.space.id, conversationId: chat.conversation.id, title: "Renamed by hand" });
    await facade.chatArchive({ space: space.space.id, conversationId: chat.conversation.id });

    // History and Checks leave recorded state behind.
    const saved = await facade.historySave({ space: space.space.id, label: "Milestone" });
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
    const check = await facade.checksEnable({ space: space.space.id, proposalPath, cwd: sandbox });
    const checkRun = await facade.checksRun({ space: space.space.id, checkId: check.check.id });
    await waitForCondition(async () => {
      const status = await facade.checksTask({ space: space.space.id, taskId: checkRun.taskId });
      return status.task.state !== "accepted" && status.task.state !== "running";
    });

    // A staged card and a shared page create needs-you and grant records.
    const staged = await api.stagedActs.stage({
      kind: "routing.enable",
      parameters: { routingId: "routing-glance-demo" },
      pins: { routingId: "routing-glance-demo", declarationDigest: "e".repeat(64) },
      provenance: { stagedVia: "act-cli", requestId: "req-glance-stage" },
    });
    await writeFile(join(space.space.spaceRoot, "notes.md"), "# Notes\n", "utf8");
    const page = await api.publications.activate(
      { spaceId: space.space.id, relativePath: "notes.md", title: "Notes page" },
      { requestId: "req-glance-page" },
    );

    const pending = await api.kernel.getGlance({ kind: "system" });
    assert.equal(pending.kind, "work-fold.glance.experimental");
    assert.deepEqual(pending.unavailable, [], "every wired source reads cleanly");
    assert.ok(
      pending.needsYou.some((item) => item.kind === "pending-decision" && item.ref?.decisionId === staged.act.id),
      "the staged-act reader feeds needs-you",
    );
    const checkRow = pending.checks.find((row) => row.spaceId === space.space.id);
    assert.equal(checkRow?.spaceName, "Glanced");
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
    assert.equal(checkpointItem?.spaceName, "Glanced", "Space names resolve on per-Space items");
    const settledRunItem = pending.changes.find((item) => item.kind === "check-run-settled");
    assert.equal(settledRunItem?.ref?.runId, checkRun.runId, "the content-free settled-run accessor names the run");
    assert.match(settledRunItem?.headline ?? "", /1 finding admitted/);

    // A serve refusal is vague to the audience and precise to the publisher:
    // deleting the source and serving records the bounded health note, and
    // the next digest renders it as a publication-state change item.
    await rm(join(space.space.spaceRoot, "notes.md"), { force: true });
    const refusal = await api.publications.serveViewerPage(page.publicationId);
    assert.equal(refusal.state, "not-available", "the viewer-facing refusal stays typed and content-free");
    const troubled = await api.kernel.getGlance({ kind: "system" });
    const problemItem = troubled.changes.find((item) => item.kind === "publication-state");
    assert.ok(problemItem, "the serve refusal surfaces as a publisher-facing change item");
    assert.match(problemItem!.headline, /"Notes page" isn't reaching viewers — /);
    assert.equal(problemItem!.ref?.publicationId, page.publicationId);
    assert.equal(problemItem!.spaceName, "Glanced", "the health item resolves its Space name");

    // Deciding the card and revoking the page turn needs-you into records.
    await api.foldDecisions.decide(staged.act.id, { decision: "denied", surface: "popover" });
    await api.publications.revoke(page.publicationId, { requestId: "req-glance-revoke" });
    const settled = await api.kernel.getGlance({ kind: "system" });
    assert.equal(
      settled.needsYou.some((item) => item.ref?.decisionId === staged.act.id),
      false,
      "a denied card leaves needs-you",
    );
    assert.ok(
      settled.changes.some((item) => item.kind === "decision-recorded" && item.ref?.decisionId === staged.act.id),
      "the denial is a recorded decision",
    );
    assert.ok(
      settled.changes.some((item) =>
        item.kind === "act-performed" && item.ref?.requestId === `fold-decision:${staged.act.id}`),
      "the act-receipts ledger reader surfaces the decision receipt",
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
