import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maxTurnFileChanges, parseTurnFileChanges, turnFileChanges } from "../src/local/agent/turn-file-changes.js";
import { WorkFoldTurnStore } from "../src/local/agent/turn-store.js";
import type { SpaceCheckpoint } from "../src/local/history.js";

const file = (path: string, hash = "a") => ({ path, hashSha256: hash.repeat(64), sizeBytes: 8, modifiedAt: "2026-09-07T12:00:00.000Z" });
const checkpoint = (id: string, files: ReturnType<typeof file>[]): SpaceCheckpoint => ({ schemaVersion: "0.2.0", checkpointId: id,
  createdAt: "2026-09-07T12:00:00.000Z", reason: "post_turn", scope: "full", manifestHash: "a".repeat(64), fileCount: files.length, totalBytes: files.length * 8,
  skippedLargeFiles: [], skippedFiles: [], captureRoots: [""], deleteOnRestore: [], movesOnRestore: [], directories: [], files });

test("turn file references require two full snapshots and identify bounded observed changes", () => {
  const before = checkpoint("before", [file("same.md"), file("changed.md"), file("deleted.md")]);
  before.skippedFiles = [{ path: "unreadable", sizeBytes: 0, reason: "unreadable" }];
  const after = checkpoint("after", [file("same.md"), file("changed.md", "b"), file("created.md"), file("unreadable/secret.md"), file(".pi/secret"), file("../outside")]);
  assert.deepEqual(turnFileChanges(before, after)?.files.map((item) => item.path), ["changed.md", "created.md"]);
  assert.equal(turnFileChanges(null, after), undefined);
  assert.equal(turnFileChanges(before, { ...after, scope: "targeted" }), undefined);
  const many = turnFileChanges(checkpoint("before", []), checkpoint("after", Array.from({ length: maxTurnFileChanges + 1 }, (_, index) => file(`file-${index}.md`))))!;
  assert.equal(many.files.length, maxTurnFileChanges); assert.equal(many.truncated, true);
});

test("turn file references reject malformed metadata, unsafe paths, duplicates and oversized sets", () => {
  const valid = turnFileChanges(checkpoint("before", []), checkpoint("after", [file("brief.md")]))!;
  assert.deepEqual(parseTurnFileChanges(valid), valid);
  for (const value of [null, { ...valid, owner: "injected" }, { ...valid, beforeCheckpointId: "../../other" },
    { ...valid, files: [valid.files[0], valid.files[0]] }, { ...valid, files: Array(maxTurnFileChanges + 1).fill(valid.files[0]) },
    ...["/outside", "../outside", ".work-fold/secret", ".workspace/old", "nested/.pi/auth", "file\\name", "a\0b"].map((path) => ({ ...valid, files: [{ ...valid.files[0], path }] })),
    { ...valid, files: [{ ...valid.files[0], hashSha256: "invalid" }] }, { ...valid, files: [{ ...valid.files[0], sizeBytes: -1 }] }]) {
    assert.throws(() => parseTurnFileChanges(value));
  }
});

test("turn file evidence survives restart and callers cannot mutate the durable references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-turn-files-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await WorkFoldTurnStore.create({ stateRoot: root });
  const accepted = await store.accept({ requestId: "request-one", requestDigest: "a".repeat(64), userMessageId: "user-one",
    userMessageCreatedAt: "2026-09-07T12:00:00.000Z", spaceId: "space-one", conversationId: "chat-one", actorKind: "renderer" });
  const changes = turnFileChanges(checkpoint("before", []), checkpoint("after", [file("brief.md")]))!;
  await store.settle(accepted.record.turnId, { status: "succeeded", fileChanges: changes });
  assert.equal((await store.markRunning(accepted.record.turnId))!.status, "succeeded", "a completed result cannot be reopened by a late running marker");
  changes.files[0]!.path = "mutated.md";
  store.get(accepted.record.turnId)!.fileChanges!.files[0]!.path = "another-mutation.md";
  assert.equal(store.get(accepted.record.turnId)!.fileChanges!.files[0]!.path, "brief.md");
  await store.flush();
  const reopened = await WorkFoldTurnStore.create({ stateRoot: root });
  assert.deepEqual(reopened.get(accepted.record.turnId)!.fileChanges, store.get(accepted.record.turnId)!.fileChanges);
  await assert.rejects(reopened.settle(accepted.record.turnId, { status: "succeeded", fileChanges: { ...changes, files: [{ ...changes.files[0]!, path: "../unsafe" }] } }));
});
