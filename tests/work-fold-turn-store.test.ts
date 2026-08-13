import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  directorySyncUnsupported,
  WorkFoldTurnReplayConflictError,
  WorkFoldTurnStore,
} from "../src/local/agent/turn-store.js";

const digest = (value: string) => value.repeat(64).slice(0, 64);

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
    spaceId: "space-1",
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
  const recovered = reopened.findRequest("space-1", "chat-1", "request-1");
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
    spaceId: "space-1",
    conversationId: "chat-1",
    actorKind: "cli",
  });
  await first.flush();
  await appendFile(first.path, "{\"schema\":\"work-fold.turn.v1\"", "utf8");

  const repaired = await WorkFoldTurnStore.create({ stateRoot: root });
  assert.equal(repaired.list().length, 1);
  assert.doesNotMatch(await readFile(repaired.path, "utf8"), /\{\"schema\":\"work-fold\.turn\.v1\"$/);
});

test("compaction keeps the newest bounded turn records", async (t) => {
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
    await store.accept({
      requestId: `request-${index}`,
      requestDigest: digest(String(index)),
      userMessageId: `message-${index}`,
      userMessageCreatedAt: "2026-08-13T12:00:00.000Z",
      spaceId: "space-1",
      conversationId: `chat-${index}`,
      actorKind: "system",
    });
  }
  assert.equal(store.list().length, 2);
  assert.equal(store.findRequest("space-1", "chat-1", "request-1"), null);
  assert.ok(store.findRequest("space-1", "chat-3", "request-3"));
});
