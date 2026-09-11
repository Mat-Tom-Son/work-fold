import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldRequestStore } from "../src/local/requests/request-store.js";

/**
 * Management request lineage over the durable request store
 * (docs/collaboration-contract.md, F25). These are the behaviors the
 * in-memory registry used to promise, kept word for word against the store
 * that replaced it: attribution only to an explicit task id, the widened
 * action vocabulary, one story per continued request, and a first settled
 * outcome that stands.
 */

async function openStore(t: { after: (fn: () => unknown) => void }): Promise<WorkFoldRequestStore> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-management-requests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return WorkFoldRequestStore.open({ rootPath: root });
}

test("the request store attributes actions only to an explicit management task", async (t) => {
  const store = await openStore(t);

  const first = await store.beginRoot({ kind: "management", owner: { conversationId: "chat-1" }, surface: "popover", taskId: "task-1", content: "file this" });
  assert.equal(store.isAccepting("task-1"), true);

  // recordAction never creates a child request: only beginChild does, from
  // inside turn acceptance, where the parent and every bound are checked.
  const attributed = await store.recordAction("task-1", {
    command: "chat.send",
    at: new Date().toISOString(),
    spaceId: "space-1",
    spaceName: "Target",
    conversationId: "chat-child",
    taskId: "task-child",
  });
  assert.equal(attributed, first.requestId);
  assert.deepEqual(store.byTaskId("task-1")?.childRequestIds, []);
  assert.equal(store.byTaskId("task-child"), null, "an action trail entry is attribution, never a child record");

  // A concurrent turn does not make attribution ambiguous because the caller
  // carries the exact parent id instead of relying on ambient running state.
  const second = await store.beginRoot({ kind: "management", owner: { conversationId: "chat-2" }, surface: "cli", taskId: "task-2", content: "also this" });
  assert.equal(store.isAccepting("task-2"), true);
  assert.equal(store.latestForConversation("chat-1")?.requestId, first.requestId);
  assert.equal(store.latestForConversation("chat-2")?.requestId, second.requestId);
  assert.equal(store.latestForConversation("missing"), null);
  const attributedSecond = await store.recordAction("task-2", {
    command: "spaces.create",
    at: new Date().toISOString(),
    spaceId: "space-2",
    spaceName: "Elsewhere",
  });
  assert.equal(attributedSecond, second.requestId);
  assert.equal(store.byTaskId("task-1")?.actions.length, 1);
  assert.equal(store.byTaskId("task-2")?.actions.length, 1);
  assert.equal(await store.recordAction(undefined, {
    command: "spaces.create",
    at: new Date().toISOString(),
    spaceId: "space-3",
    spaceName: "Unrelated",
  }), null, "an unrelated CLI action is never inferred from ambient state");

  await store.settleTurn("task-2", { status: "succeeded" });
  assert.equal(store.isAccepting("task-2"), false);
  assert.equal(store.byTaskId("task-2")?.state, "done");
  await store.settleTurn("task-1", { status: "aborted" });
  assert.equal(store.isAccepting("task-1"), false);
  assert.equal(store.byTaskId("task-1")?.state, "stopped");
  assert.ok(store.byTaskId("task-1")?.settledAt);
  assert.equal(store.list({ kind: "management", limit: 1 })[0]?.requestId, second.requestId, "the newest management request is the popover's latest");

  // Settling twice never overwrites the first recorded outcome.
  await store.settleTurn("task-1", { status: "succeeded" });
  assert.equal(store.byTaskId("task-1")?.turns[0]?.state, "aborted");
  assert.equal(store.byTaskId("task-1")?.state, "stopped");
});

test("the widened action vocabulary records every landed mutation verb, Space-free acts included", async (t) => {
  const store = await openStore(t);
  const request = await store.beginRoot({ kind: "management", owner: { conversationId: "chat-1" }, surface: "popover", taskId: "task-1", content: "tidy things" });

  // Space-bound acts carry their Space; the compaction act also carries the
  // kernel task id without ever becoming a child request.
  await store.recordAction("task-1", {
    command: "chat.compact",
    at: new Date().toISOString(),
    spaceId: "space-1",
    spaceName: "Fold",
    conversationId: "chat-9",
    taskId: "task-compact",
  });
  assert.deepEqual(store.get(request.requestId)?.childRequestIds, [], "recordAction never creates a child request");

  // The personal Library and personal-scope tools are Space-free: the action
  // records honestly without inventing a Space.
  await store.recordAction("task-1", { command: "library.add", at: new Date().toISOString(), copied: ["Receipts/one.pdf"] });
  await store.recordAction("task-1", { command: "tools.remove", at: new Date().toISOString() });
  await store.recordAction("task-1", { command: "apps.revoke", at: new Date().toISOString(), spaceId: "space-1", spaceName: "Fold" });
  const record = store.get(request.requestId)!;
  assert.deepEqual(
    record.actions.map((action) => action.command),
    ["chat.compact", "library.add", "tools.remove", "apps.revoke"],
  );
  assert.equal(record.actions[1]?.spaceId, undefined);
  assert.deepEqual(record.actions[1]?.copied, ["Receipts/one.pdf"]);

  // A chat.send without resolved Space fields records the action and nothing
  // else: there is no child-task list to malform any more.
  await store.recordAction("task-1", { command: "chat.send", at: new Date().toISOString(), conversationId: "chat-2", taskId: "task-child" });
  assert.equal(store.get(request.requestId)?.actions.length, 5);
  assert.deepEqual(store.get(request.requestId)?.childRequestIds, []);
});

test("--task names the caller's own running turn, checked the way --parent-task is", async (t) => {
  const store = await openStore(t);
  const audits = { spaceId: "space-audits", spaceName: "Audits", conversationId: "chat-audits" };
  const root = await store.beginRoot({ kind: "management", owner: { conversationId: "chat-fold" }, surface: "cli", taskId: "task-fold", content: "Review the audits." });
  const child = await store.beginChild({ parentTaskId: "task-fold", kind: "cli", owner: audits, surface: "cli", taskId: "task-audits", content: "Review the audits." });

  // The Space's own running turn passes and returns its record.
  assert.equal(store.assertOwnAcceptingTurn("task-audits", { spaceId: "space-audits" }).requestId, child.requestId);
  assert.equal(store.assertOwnAcceptingTurn("task-fold", {}).requestId, root.requestId);
  // Another Space, the fold's turn from a Space, an unknown id: refused by name.
  assert.throws(() => store.assertOwnAcceptingTurn("task-audits", { spaceId: "space-other" }), /another Space's turn/);
  assert.throws(() => store.assertOwnAcceptingTurn("task-fold", { spaceId: "space-audits" }), /another Space's turn/);
  assert.throws(() => store.assertOwnAcceptingTurn("task-missing", { spaceId: "space-audits" }), /not belong to a request on record/);
  // A settled turn no longer speaks for its request; a continuation makes the older id stale.
  await store.settleTurn("task-audits", { status: "succeeded" });
  assert.throws(() => store.assertOwnAcceptingTurn("task-audits", { spaceId: "space-audits" }), /stopping or has already finished/);
  await store.joinTurn({ requestId: child.requestId, taskId: "task-audits-2", content: "Use Q3." });
  assert.throws(() => store.assertOwnAcceptingTurn("task-audits", { spaceId: "space-audits" }), /older turn of its request/);
  assert.equal(store.assertOwnAcceptingTurn("task-audits-2", { spaceId: "space-audits" }).requestId, child.requestId);
  // A request-level stop closes the door for its running turn too.
  await store.markStopRequested(child.requestId);
  assert.throws(() => store.assertOwnAcceptingTurn("task-audits-2", { spaceId: "space-audits" }), /stopping or has already finished/);
});

test("a needs-you continuation joins the request instead of copying its trail into a second record", async (t) => {
  const store = await openStore(t);
  const request = await store.beginRoot({
    kind: "management",
    owner: { conversationId: "chat-1" },
    surface: "popover",
    taskId: "task-1",
    content: "where should this go?",
    attachments: [{ kind: "file", target: "/tmp/report.pdf", name: "report.pdf" }],
  });
  await store.recordAction("task-1", { command: "spaces.create", at: new Date().toISOString(), spaceId: "space-1", spaceName: "Audits" });
  await store.settleTurn("task-1", { status: "succeeded" });

  const continued = await store.joinTurn({
    requestId: request.requestId,
    taskId: "task-2",
    content: "Use Audits",
    attachments: [{ kind: "url", target: "https://example.com/context", name: "example.com/context" }],
  });
  assert.equal(continued.continuedFromTaskId, "task-1");
  assert.deepEqual(continued.attachments.map((attachment) => attachment.kind), ["file", "url"]);
  assert.equal(continued.actions.length, 1);
  assert.equal(continued.content, "Use Audits");
  assert.equal(continued.turns.length, 2);
  assert.equal(continued.turns[1]?.role, "continuation");
  assert.equal(continued.state, "working", "a joined turn reopens the request");
  assert.equal(store.byTaskId("task-1")?.requestId, store.byTaskId("task-2")?.requestId, "both task ids resolve to the one record");
  assert.equal(store.list().length, 1, "no second record was created");
});
