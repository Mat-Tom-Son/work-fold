import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { HISTORY_REVIEW_LIMITS } from "../src/shared/history-review.js";
import { compareHistoryFile, readHistoryFile } from "../src/local/history-review.js";
import { createSpaceCheckpoint, createSpaceMutationCheckpoint, type SpaceCheckpoint } from "../src/local/history.js";
import { configureWorkFoldStateRoot, spaceHistoryRoot } from "../src/local/state-paths.js";
import { registerLinkedSpace } from "../src/local/space.js";

async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "history-review-"));
  const root = join(sandbox, "folder");
  configureWorkFoldStateRoot(join(sandbox, "state"));
  await mkdir(root);
  t.after(async () => { configureWorkFoldStateRoot(undefined); await rm(sandbox, { recursive: true, force: true }); });
  return { sandbox, root };
}

function blobPath(root: string, checkpoint: SpaceCheckpoint, path: string): string {
  const hash = checkpoint.files.find((file) => file.path === path)!.hashSha256;
  return join(spaceHistoryRoot(root), "objects", hash.slice(0, 2), hash.slice(2));
}

test("History reads saved bytes and compares checkpoints or a read-only current observation", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "note.txt"), "Heading\nold\nend\n");
  const first = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), "Heading\nnew\nend\n");
  const second = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), "Heading\ncurrent\nend\n");
  const manifestNames = await readdir(join(spaceHistoryRoot(root), "checkpoints"));
  const saved = await readHistoryFile(root, { path: "note.txt", checkpointId: first.checkpointId });
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.observation.text, "Heading\nold\nend\n");
  assert.equal(saved.observation.hashVerified, true);
  assert.equal(saved.observation.capturedAt, first.createdAt);
  const compared = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: first.checkpointId, toCheckpointId: second.checkpointId });
  assert.equal(compared.change, "modified");
  assert.equal(compared.after.source, "checkpoint");
  assert.equal(compared.diff.status, "available");
  assert.match(compared.diff.text!, /@@ -1,3 \+1,3 @@\n Heading\n-old\n\+new\n end\n/u);
  const current = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: first.checkpointId });
  assert.equal(current.after.source, "current");
  assert.ok(current.after.observedAt);
  assert.equal(current.after.checkpointId, undefined);
  assert.equal(current.after.text, "Heading\ncurrent\nend\n");
  assert.match(current.diff.text!, /\+current\n/u);
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "Heading\ncurrent\nend\n");
  assert.deepEqual(await readdir(join(spaceHistoryRoot(root), "checkpoints")), manifestNames, "review writes no recovery records");
});

test("known absence produces additions and deletions, including a deleted current file", async (t) => {
  const { root } = await fixture(t);
  const empty = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), "new file");
  const created = await createSpaceCheckpoint(root);
  const addition = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: empty.checkpointId, toCheckpointId: created.checkpointId });
  assert.equal(addition.before.status, "absent");
  assert.equal(addition.change, "added");
  assert.match(addition.diff.text!, /--- \/dev\/null/u);
  assert.match(addition.diff.text!, /@@ -0,0 \+1,1 @@\n\+new file\n\\ No newline at end of file\n/u);
  await rm(join(root, "note.txt"));
  const deletion = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: created.checkpointId });
  assert.equal(deletion.change, "deleted");
  assert.equal(deletion.after.status, "absent");
  assert.match(deletion.diff.text!, /@@ -1,1 \+0,0 @@/u);
  const absent = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: empty.checkpointId });
  assert.equal(absent.change, "unchanged");
  assert.equal(absent.diff.status, "not_needed");
});

test("targeted coverage distinguishes captured absence, additive undo, and unobserved paths", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "one.txt"), "one");
  await writeFile(join(root, "other.txt"), "other");
  const targeted = await createSpaceMutationCheckpoint(root, { paths: ["one.txt", "missing.txt"], deleteOnRestore: ["added"] });
  for (const path of ["missing.txt", "added/file.txt"]) {
    assert.equal((await readHistoryFile(root, { path, checkpointId: targeted.checkpointId })).observation.status, "absent");
  }
  const uncovered = await compareHistoryFile(root, { path: "other.txt", fromCheckpointId: targeted.checkpointId });
  assert.equal(uncovered.before.status, "uncaptured");
  assert.equal(uncovered.before.reason, "outside_capture");
  assert.equal(uncovered.change, "unknown");
  assert.equal(uncovered.diff.status, "unsupported");
  await mkdir(join(root, "excluded"));
  await writeFile(join(root, "excluded", "note.txt"), "not captured");
  await writeFile(join(root, ".gitignore"), "excluded/\n");
  const excluded = await createSpaceCheckpoint(root);
  await writeFile(join(root, ".gitignore"), "");
  const historical = await readHistoryFile(root, { path: "excluded/note.txt", checkpointId: excluded.checkpointId });
  assert.equal(historical.observation.status, "uncaptured");
  assert.equal(historical.observation.reason, "skipped_excluded");
});

test("unavailable, excluded, large, and non-file evidence never becomes absence", async (t) => {
  const { root } = await fixture(t);
  const previousLimit = process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
  process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "16";
  t.after(() => { if (previousLimit === undefined) delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES; else process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = previousLimit; });
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "large.txt"), "a".repeat(32));
  await writeFile(join(root, "~$lock.docx"), "lock");
  const checkpoint = await createSpaceCheckpoint(root);
  const large = await readHistoryFile(root, { path: "large.txt", checkpointId: checkpoint.checkpointId });
  assert.equal(large.observation.status, "uncaptured");
  assert.equal(large.observation.reason, "skipped_too_large");
  assert.equal((await readHistoryFile(root, { path: "directory", checkpointId: checkpoint.checkpointId })).observation.reason, "not_regular_file");
  assert.equal((await readHistoryFile(root, { path: "~$lock.docx", checkpointId: checkpoint.checkpointId })).observation.status, "uncaptured");
});

test("binary controls and invalid UTF-8 do not emit lossy text", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "binary.dat"), Buffer.from([65, 0, 66]));
  await writeFile(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, "bom.txt"), "\ufeffhello\r\n");
  const checkpoint = await createSpaceCheckpoint(root);
  const binary = (await readHistoryFile(root, { path: "binary.dat", checkpointId: checkpoint.checkpointId })).observation;
  assert.equal(binary.status, "binary");
  assert.equal(binary.reason, "binary_content");
  assert.equal(binary.text, undefined);
  const invalid = (await readHistoryFile(root, { path: "invalid.txt", checkpointId: checkpoint.checkpointId })).observation;
  assert.equal(invalid.reason, "invalid_utf8");
  assert.equal(invalid.hashVerified, true);
  assert.equal(invalid.text, undefined);
  assert.equal((await readHistoryFile(root, { path: "bom.txt", checkpointId: checkpoint.checkpointId })).observation.text, "\ufeffhello\r\n");
  await writeFile(join(root, "binary.dat"), Buffer.from([65, 0, 67]));
  const compare = await compareHistoryFile(root, { path: "binary.dat", fromCheckpointId: checkpoint.checkpointId });
  assert.equal(compare.change, "modified");
  assert.equal(compare.diff.status, "unsupported");
});

test("missing and corrupted blobs are unavailable, including a false manifest size", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "note.txt"), "original");
  const checkpoint = await createSpaceCheckpoint(root);
  const saved = blobPath(root, checkpoint, "note.txt");
  await writeFile(saved, "corrupt!");
  const corrupt = (await readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.checkpointId })).observation;
  assert.equal(corrupt.status, "unavailable");
  assert.equal(corrupt.reason, "corrupt_blob");
  assert.equal(corrupt.hashVerified, false);
  assert.equal(corrupt.text, undefined);
  await writeFile(saved, Buffer.alloc(HISTORY_REVIEW_LIMITS.maxFileBytes + 1));
  assert.equal((await readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.checkpointId })).observation.reason, "corrupt_blob");
  await rm(saved);
  assert.equal((await readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.checkpointId })).observation.reason, "missing_blob");
});

test("read verifies selected Folder, checkpoint identity, and exact path membership before blobs", async (t) => {
  const { root, sandbox } = await fixture(t);
  await writeFile(join(root, "note.txt"), "saved");
  const checkpoint = await createSpaceCheckpoint(root);
  const other = join(sandbox, "other");
  await mkdir(other);
  await writeFile(join(other, "note.txt"), "other secret");
  const otherCheckpoint = await createSpaceCheckpoint(other);
  await assert.rejects(readHistoryFile(root, { path: "note.txt", checkpointId: otherCheckpoint.checkpointId }), /not found in this Folder/u);
  await assert.rejects(readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.files[0]!.hashSha256 }), /not found/u);
  assert.equal((await readHistoryFile(root, { path: "unrelated.txt", checkpointId: checkpoint.checkpointId })).observation.text, undefined);
  const manifest = join(spaceHistoryRoot(root), "checkpoints", `${checkpoint.checkpointId}.json`);
  await writeFile(manifest, JSON.stringify({ ...checkpoint, checkpointId: otherCheckpoint.checkpointId }));
  await assert.rejects(readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.checkpointId }), /not found/u);
  await writeFile(manifest, JSON.stringify({ ...checkpoint, files: [{ ...checkpoint.files[0], hashSha256: "../../outside" }] }));
  assert.equal((await readHistoryFile(root, { path: "note.txt", checkpointId: checkpoint.checkpointId })).observation.reason, "invalid_checkpoint");
});

test("protected metadata, traversal, links and newly registered nested Folders are refused", async (t) => {
  const { root, sandbox } = await fixture(t);
  await mkdir(join(root, "child"));
  await writeFile(join(root, "child", "note.txt"), "belongs to child");
  const checkpoint = await createSpaceCheckpoint(root);
  for (const path of ["../outside.txt", "/absolute.txt", "child/../../outside.txt", "C:\\outside.txt", ".", ".pi/config.json", ".work-fold/space.json", ".workspace/secret", "child/.PI/config", "bad\nname.txt"]) {
    await assert.rejects(readHistoryFile(root, { path, checkpointId: checkpoint.checkpointId }));
  }
  await symlink(join(root, "child"), join(root, "linked"));
  await symlink(join(sandbox, "does-not-exist"), join(root, "dangling"));
  await assert.rejects(readHistoryFile(root, { path: "linked/note.txt", checkpointId: checkpoint.checkpointId }), /symbolic/u);
  await assert.rejects(readHistoryFile(root, { path: "dangling/note.txt", checkpointId: checkpoint.checkpointId }), /symbolic/u);
  await registerLinkedSpace(root);
  await registerLinkedSpace(join(root, "child"));
  await assert.rejects(readHistoryFile(root, { path: "child/note.txt", checkpointId: checkpoint.checkpointId }), /another registered Space/u);
  await assert.rejects(compareHistoryFile(root, { path: "child/note.txt", fromCheckpointId: checkpoint.checkpointId }), /another registered Space/u);
  if (await readFile(join(root, "CHILD", "note.txt")).then(() => true, () => false)) {
    await assert.rejects(compareHistoryFile(root, { path: "CHILD/note.txt", fromCheckpointId: checkpoint.checkpointId }), /another registered Space/u);
  }
});

test("oversized saved and current files report limits without claiming digest verification", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "large.txt"), "x".repeat(HISTORY_REVIEW_LIMITS.maxFileBytes + 1));
  const checkpoint = await createSpaceCheckpoint(root);
  const read = await readHistoryFile(root, { path: "large.txt", checkpointId: checkpoint.checkpointId });
  assert.equal(read.observation.status, "too_large");
  assert.equal(read.observation.text, undefined);
  assert.equal(read.observation.hashVerified, false);
  const compare = await compareHistoryFile(root, { path: "large.txt", fromCheckpointId: checkpoint.checkpointId });
  assert.equal(compare.after.status, "too_large");
  assert.equal(compare.after.hashSha256, undefined);
  assert.equal(compare.change, "unknown");
  assert.equal(compare.diff.status, "unsupported");
});

test("diff budgets distinguish long lines, many lines, and expensive comparisons", async (t) => {
  const { root } = await fixture(t);
  const scenarios = [
    { before: "a".repeat(HISTORY_REVIEW_LIMITS.maxLineCharacters + 1), after: "different", reason: "long_line" },
    { before: "a\n".repeat(HISTORY_REVIEW_LIMITS.maxDiffLines + 1), after: "different", reason: "line_limit" },
    { before: "a\n".repeat(1_000), after: "b\n".repeat(1_000), reason: "computation_limit" },
  ];
  for (const scenario of scenarios) {
    await writeFile(join(root, "note.txt"), scenario.before);
    const checkpoint = await createSpaceCheckpoint(root);
    await writeFile(join(root, "note.txt"), scenario.after);
    const comparison = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: checkpoint.checkpointId });
    assert.equal(comparison.change, "modified");
    assert.equal(comparison.diff.status, "limited");
    assert.equal(comparison.diff.reason, scenario.reason);
    assert.equal(comparison.diff.truncated, true);
    assert.equal(comparison.diff.text, undefined);
  }
});

test("diff output and JSON payload stay bounded and mark truncation explicitly", async (t) => {
  const { root } = await fixture(t);
  const before = `${"\\".repeat(1_000)}\n`.repeat(100);
  const after = `${'"'.repeat(1_000)}\n`.repeat(100);
  await writeFile(join(root, "note.txt"), before);
  const checkpoint = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), after);
  const comparison = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: checkpoint.checkpointId });
  assert.equal(comparison.diff.status, "limited");
  assert.equal(comparison.diff.reason, "output_limit");
  assert.equal(comparison.diff.truncated, true);
  assert.ok(Buffer.byteLength(comparison.diff.text!) <= HISTORY_REVIEW_LIMITS.maxDiffBytes);
  assert.ok(Buffer.byteLength(JSON.stringify(comparison)) < 1024 * 1024);
  assert.equal(comparison.before.text, before, "saved text is still complete");
  assert.equal(comparison.after.text, after, "observed text is still complete");
});

test("diff context and line positions are correct for separated hunks and newline changes", async (t) => {
  const { root } = await fixture(t);
  const before = Array.from({ length: 25 }, (_, index) => `line ${index + 1}\n`);
  await writeFile(join(root, "note.txt"), before.join(""));
  const checkpoint = await createSpaceCheckpoint(root);
  const after = [...before]; after[1] = "changed 2\n"; after[23] = "changed 24\n";
  await writeFile(join(root, "note.txt"), after.join(""));
  const compared = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: checkpoint.checkpointId });
  assert.equal(compared.diff.status, "available");
  assert.match(compared.diff.text!, /@@ -1,5 \+1,5 @@/u);
  assert.match(compared.diff.text!, /@@ -21,5 \+21,5 @@/u);
  await writeFile(join(root, "note.txt"), before.join("").slice(0, -1));
  const newline = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: checkpoint.checkpointId });
  assert.match(newline.diff.text!, /-line 25\n\+line 25\n\\ No newline at end of file\n/u);
});

test("a detected outside write during current reading returns unavailable with no mixed text", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, "note.txt"), "checkpoint-before\n");
  const checkpoint = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), "current-before\n");
  const handle = await open(join(root, "note.txt"), "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();
  const read = prototype.read;
  let changed = false;
  t.mock.method(prototype, "read", async function (this: FileHandle, buffer: Buffer, offset: number, length: number, position: number) {
    const result = await read.call(this, buffer, { offset, length, position });
    if (!changed && result.bytesRead > 0 && buffer.subarray(0, result.bytesRead).toString("utf8").startsWith("current-before")) {
      changed = true;
      await writeFile(join(root, "note.txt"), "current-after-longer\n");
    }
    return result;
  });
  const compared = await compareHistoryFile(root, { path: "note.txt", fromCheckpointId: checkpoint.checkpointId });
  assert.equal(changed, true);
  assert.equal(compared.after.status, "unavailable");
  assert.equal(compared.after.reason, "changed_during_read");
  assert.equal(compared.after.text, undefined);
  assert.equal(compared.after.hashSha256, undefined);
  assert.equal(compared.change, "unknown");
});
