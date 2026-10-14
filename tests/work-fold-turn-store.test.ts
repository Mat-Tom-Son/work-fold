import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  directorySyncUnsupported,
  maxDurableTurnRecords,
  WorkFoldTurnReplayConflictError,
  WorkFoldTurnStore,
} from "../src/local/agent/turn-store.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);
const turnInput = (id: string) => ({
  requestId: `request-${id}`,
  requestDigest: digest("a"),
  userMessageId: `message-${id}`,
  userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
  workFolderId: "work-folder-1",
  conversationId: `chat-${id}`,
  actorKind: "system" as const,
});

test("directory durability falls back only for known unsupported platform errors", () => {
  assert.equal(directorySyncUnsupported(Object.assign(new Error("unsupported"), { code: "EINVAL" }), "darwin"), true);
  assert.equal(directorySyncUnsupported(Object.assign(new Error("denied"), { code: "EPERM" }), "win32"), true);
  assert.equal(directorySyncUnsupported(Object.assign(new Error("denied"), { code: "EPERM" }), "darwin"), false);
  assert.equal(directorySyncUnsupported(Object.assign(new Error("full"), { code: "ENOSPC" }), "win32"), false);
});

test("durable turn records make acceptance idempotent and survive restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await WorkFoldTurnStore.create({ stateRoot: root });
  const input = {
    requestId: "request-1",
    requestDigest: digest("a"),
    userMessageId: "message-1",
    userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
    workFolderId: "work-folder-1",
    conversationId: "chat-1",
    actorKind: "renderer" as const,
  };

  const accepted = await store.accept(input);
  assert.equal(accepted.replayed, false);
  assert.equal(accepted.record.status, "accepted");
  assert.match(accepted.record.turnId, /^turn-/);
  assert.equal((await store.accept(input)).replayed, true);
  await assert.rejects(
    store.accept({ ...input, requestDigest: digest("b") }),
    (error: unknown) => error instanceof WorkFoldTurnReplayConflictError,
  );

  await store.markRunning(accepted.record.turnId);
  await store.checkpoint(accepted.record.turnId, "A durable partial response.");
  await store.settle(accepted.record.turnId, {
    status: "succeeded",
    messageId: "assistant-1",
  });
  await store.flush();

  const reopened = await WorkFoldTurnStore.create({ stateRoot: root });
  const recovered = reopened.findRequest("work-folder-1", "chat-1", "request-1");
  assert.equal(recovered?.turnId, accepted.record.turnId);
  assert.equal(recovered?.status, "succeeded");
  assert.equal(recovered?.assistantText, "A durable partial response.");
  assert.equal(recovered?.messageId, "assistant-1");
  assert.deepEqual(reopened.active(), []);
});

test("startup repairs a truncated final journal line without discarding durable records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await WorkFoldTurnStore.create({ stateRoot: root });
  await first.accept({
    requestId: "request-1",
    requestDigest: digest("c"),
    userMessageId: "message-1",
    userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
    workFolderId: "work-folder-1",
    conversationId: "chat-1",
    actorKind: "cli",
  });
  await first.flush();
  await appendFile(first.path, "{\"schema\":\"work-fold.turn.v1\"", "utf8");

  const repaired = await WorkFoldTurnStore.create({ stateRoot: root });
  assert.equal(repaired.list().length, 1);
  assert.doesNotMatch(await readFile(repaired.path, "utf8"), /\{\"schema\":\"work-fold\.turn\.v1\"$/);
});

test("compaction keeps the newest bounded terminal turn records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = await WorkFoldTurnStore.create({
    stateRoot: root,
    maxRecords: 2,
    compactBytes: 1,
    now: () => new Date(1_800_000_000_000 + tick++),
  });
  for (let index = 1; index <= 3; index += 1) {
    const { record } = await store.accept({
      requestId: `request-${index}`,
      requestDigest: digest(String(index)),
      userMessageId: `message-${index}`,
      userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
      workFolderId: "work-folder-1",
      conversationId: `chat-${index}`,
      actorKind: "system",
    });
    await store.settle(record.turnId, { status: "succeeded" });
  }
  assert.equal(store.list().length, 2);
  assert.equal(store.findRequest("work-folder-1", "chat-1", "request-1"), null);
  assert.ok(store.findRequest("work-folder-1", "chat-3", "request-3"));
});

test("unfinished turns survive retention and compaction, then checkpoint and settle after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-unfinished-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const options = {
    stateRoot: root,
    maxRecords: 2,
    compactBytes: 1,
    now: () => new Date(1_800_000_000_000 + tick++),
  };
  const store = await WorkFoldTurnStore.create(options);
  const accepted = (await store.accept(turnInput("accepted"))).record;
  const running = (await store.accept(turnInput("running"))).record;
  await store.markRunning(running.turnId);
  await store.checkpoint(running.turnId, "The unfinished response.");
  for (let index = 1; index <= 3; index += 1) {
    const { record } = await store.accept(turnInput(`finished-${index}`));
    await store.settle(record.turnId, { status: "succeeded" });
  }

  assert.deepEqual(store.active().map((record) => record.turnId), [accepted.turnId, running.turnId]);
  assert.equal(store.list().length, 4);
  assert.equal(store.findRequest("work-folder-1", "chat-finished-1", "request-finished-1"), null);
  assert.equal(store.get(running.turnId)?.assistantText, "The unfinished response.");
  const compacted = (await readFile(store.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(compacted.length, 4);
  assert.equal(compacted.find((record) => record.turnId === running.turnId)?.assistantText, "The unfinished response.");

  const reopened = await WorkFoldTurnStore.create(options);
  assert.equal(reopened.get(accepted.turnId)?.status, "accepted");
  assert.equal(reopened.get(running.turnId)?.status, "running");
  for (const id of ["accepted", "running"]) {
    assert.equal((await reopened.accept(turnInput(id))).replayed, true);
    await assert.rejects(
      reopened.accept({ ...turnInput(id), requestDigest: digest("b") }),
      WorkFoldTurnReplayConflictError,
    );
  }
  assert.equal((await reopened.checkpoint(running.turnId, "The completed response."))?.assistantText, "The completed response.");
  assert.equal((await reopened.settle(running.turnId, { status: "succeeded", messageId: "assistant-running" }))?.status, "succeeded");
  assert.equal((await reopened.markRunning(accepted.turnId))?.status, "running");
  assert.equal((await reopened.settle(accepted.turnId, { status: "aborted", error: "Stopped by the person." }))?.status, "aborted");
  assert.deepEqual(reopened.active(), []);
  assert.equal(reopened.list().length, 2);
  assert.equal((await reopened.checkpoint(running.turnId, "A late checkpoint."))?.assistantText, "The completed response.");

  const settled = await WorkFoldTurnStore.create(options);
  assert.equal(settled.get(running.turnId)?.status, "succeeded");
  assert.equal(settled.get(running.turnId)?.messageId, "assistant-running");
  assert.equal(settled.get(running.turnId)?.assistantText, "The completed response.");
  assert.equal(settled.get(accepted.turnId)?.status, "aborted");
  assert.equal(settled.get(accepted.turnId)?.error, "Stopped by the person.");
});

test("terminal memory retention stays bounded before disk compaction without limiting unfinished turns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-memory-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = await WorkFoldTurnStore.create({
    stateRoot: root,
    maxRecords: 2,
    compactBytes: Number.MAX_SAFE_INTEGER,
    now: () => new Date(1_800_000_000_000 + tick++),
  });
  for (let index = 1; index <= 3; index += 1) await store.accept(turnInput(`unfinished-${index}`));
  for (const status of ["succeeded", "failed", "aborted", "interrupted"] as const) {
    const { record } = await store.accept(turnInput(status));
    await store.settle(record.turnId, { status });
    assert.ok(store.list().length <= store.active().length + 2);
  }
  assert.equal(store.active().length, 3);
  assert.equal(store.list().length, 5);
  assert.equal(store.findScopeRequest("work-folder-1", "request-succeeded"), null);
  assert.equal(store.findScopeRequest("work-folder-1", "request-failed"), null);
  assert.equal(store.findScopeRequest("work-folder-1", "request-aborted")?.status, "aborted");
  assert.equal(store.findScopeRequest("work-folder-1", "request-interrupted")?.status, "interrupted");
  // These old disk entries are still present until byte-triggered compaction or
  // startup repair, but reopening applies the same terminal-history allowance.
  assert.ok((await readFile(store.path, "utf8")).includes('"requestId":"request-succeeded"'));
  const reused = await store.accept(turnInput("succeeded"));
  assert.equal(reused.replayed, false);
  const reopened = await WorkFoldTurnStore.create({ stateRoot: root, maxRecords: 2 });
  assert.equal(reopened.list().length, 6);
  assert.equal(reopened.active().length, 4);
  assert.equal(reopened.findRequest("work-folder-1", "chat-succeeded", "request-succeeded")?.turnId, reused.record.turnId);
  assert.equal(reopened.findScopeRequest("work-folder-1", "request-succeeded")?.turnId, reused.record.turnId);
  assert.equal((await reopened.accept(turnInput("succeeded"))).replayed, true);
});

test("startup preserves unfinished turns at the default thousand-terminal-record boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-default-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await WorkFoldTurnStore.create({ stateRoot: root, now: () => new Date(1_800_000_000_000) });
  const accepted = (await store.accept(turnInput("accepted"))).record;
  const running = (await store.accept(turnInput("running"))).record;
  await store.markRunning(running.turnId);
  await store.checkpoint(running.turnId, "Checkpoint retained across the default boundary.");
  const records = [accepted, store.get(running.turnId)!];
  for (let index = 0; index <= maxDurableTurnRecords; index += 1) {
    records.push({
      ...accepted,
      turnId: `turn-finished-${index}`,
      requestId: `request-finished-${index}`,
      status: "succeeded",
      userMessagePersisted: true,
      updatedAt: new Date(1_800_000_000_001 + index).toISOString(),
    });
  }
  await writeFile(store.path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

  let tick = 10_000;
  const reopened = await WorkFoldTurnStore.create({ stateRoot: root, now: () => new Date(1_800_000_000_000 + tick++) });
  assert.equal(reopened.list().length, maxDurableTurnRecords + 2);
  assert.equal(reopened.get("turn-finished-0"), null);
  assert.equal(reopened.get(accepted.turnId)?.status, "accepted");
  assert.equal(reopened.get(running.turnId)?.assistantText, "Checkpoint retained across the default boundary.");
  assert.equal((await reopened.accept(turnInput("running"))).replayed, true);
  assert.equal((await readFile(reopened.path, "utf8")).trim().split("\n").length, maxDurableTurnRecords + 2);
  assert.equal((await reopened.settle(running.turnId, { status: "interrupted", error: "Interrupted by restart." }))?.status, "interrupted");
  assert.equal((await reopened.settle(accepted.turnId, { status: "aborted" }))?.status, "aborted");
  assert.equal(reopened.list().length, maxDurableTurnRecords);
  assert.deepEqual(reopened.active(), []);

  const settled = await WorkFoldTurnStore.create({ stateRoot: root });
  assert.equal(settled.list().length, maxDurableTurnRecords);
  assert.equal(settled.get(running.turnId)?.status, "interrupted");
  assert.equal(settled.get(running.turnId)?.assistantText, "Checkpoint retained across the default boundary.");
  assert.equal(settled.get(accepted.turnId)?.status, "aborted");
});
