import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSpaceCheckpoint, createSpaceMutationCheckpoint, restoreSpaceCheckpoint, restoreFileVersion, listSpaceCheckpoints, previewSpaceCheckpointRestore } from "../src/local/history.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import { registerLinkedSpace, withSpaceHistoryOperation } from "../src/local/space.js";

async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "history-boundary-"));
  const root = join(sandbox, "space");
  configureWorkFoldStateRoot(join(sandbox, "state"));
  await mkdir(root);
  t.after(async () => { configureWorkFoldStateRoot(undefined); await rm(sandbox, { recursive: true, force: true }); });
  return { sandbox, root };
}

test("restore refuses deleting or overwriting content its new safety checkpoint cannot capture", async (t) => {
  const { root } = await fixture(t);
  const oldLimit = process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
  process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "32";
  t.after(() => { if (oldLimit === undefined) delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES; else process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = oldLimit; });
  const added = await createSpaceMutationCheckpoint(root, { deleteOnRestore: ["added"] });
  await mkdir(join(root, "added"));
  const bytes = Buffer.alloc(64, 7);
  await writeFile(join(root, "added", "large.bin"), bytes);
  const preview = await previewSpaceCheckpointRestore(root, added.checkpointId);
  assert.match(preview.conflicts.join(), /cannot be recovered/);
  assert.deepEqual(preview.removePaths, ["added"]);
  await assert.rejects(restoreSpaceCheckpoint(root, added.checkpointId), /cannot be recovered/);
  assert.deepEqual(await readFile(join(root, "added", "large.bin")), bytes);
  await writeFile(join(root, "note.txt"), "small");
  const cp = await createSpaceCheckpoint(root);
  await writeFile(join(root, "note.txt"), bytes);
  await assert.rejects(restoreSpaceCheckpoint(root, cp.checkpointId), /cannot be recovered/);
  await assert.rejects(restoreFileVersion(root, "note.txt", cp.files.find((file) => file.path === "note.txt")!.hashSha256), /cannot be recovered/);
  assert.deepEqual(await readFile(join(root, "note.txt")), bytes);
});

test("additive undo never recursively deletes protected metadata", async (t) => {
  const { root } = await fixture(t);
  const cp = await createSpaceMutationCheckpoint(root, { deleteOnRestore: ["added"] });
  await mkdir(join(root, "added", ".workspace"), { recursive: true });
  await writeFile(join(root, "added", ".workspace", "sentinel"), "preserve");
  await assert.rejects(restoreSpaceCheckpoint(root, cp.checkpointId), /cannot be recovered/);
  assert.equal(await readFile(join(root, "added", ".workspace", "sentinel"), "utf8"), "preserve");
});

test("History excludes nested Spaces and refuses older checkpoints after child registration", async (t) => {
  const { root } = await fixture(t);
  const child = join(root, "child"); await mkdir(child);
  await registerLinkedSpace(root);
  await writeFile(join(child, "note.txt"), "before");
  const old = await createSpaceCheckpoint(root);
  await registerLinkedSpace(child);
  await writeFile(join(child, "note.txt"), "after");
  const current = await createSpaceCheckpoint(root);
  assert.equal(current.files.some((file) => file.path.startsWith("child/")), false);
  const targeted = await createSpaceMutationCheckpoint(root, { paths: ["child/note.txt"] });
  assert.equal(targeted.files.length, 0);
  await assert.rejects(restoreSpaceCheckpoint(root, old.checkpointId), /another registered Space/);
  assert.equal(await readFile(join(child, "note.txt"), "utf8"), "after");
});

test("old directory exclusions protect descendants after ignore rules change", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, "scratch"));
  await writeFile(join(root, ".gitignore"), "scratch/\n");
  await writeFile(join(root, "scratch", "note.txt"), "precious");
  const cp = await createSpaceCheckpoint(root);
  await writeFile(join(root, ".gitignore"), "");
  assert.deepEqual((await previewSpaceCheckpointRestore(root, cp.checkpointId)).removePaths, []);
  await restoreSpaceCheckpoint(root, cp.checkpointId);
  assert.equal(await readFile(join(root, "scratch", "note.txt"), "utf8"), "precious");
});

test("relinking a moved Space preserves its machine-local History", async (t) => {
  const { root, sandbox } = await fixture(t);
  const original = await registerLinkedSpace(root);
  await writeFile(join(root, "note.txt"), "before");
  const cp = await createSpaceCheckpoint(root);
  const moved = join(sandbox, "moved"); await rename(root, moved);
  assert.equal((await registerLinkedSpace(moved)).id, original.id);
  assert.equal((await listSpaceCheckpoints(moved))[0]?.checkpointId, cp.checkpointId);
  await writeFile(join(moved, "note.txt"), "after");
  await restoreSpaceCheckpoint(moved, cp.checkpointId);
  assert.equal(await readFile(join(moved, "note.txt"), "utf8"), "before");
  assert.equal(existsSync(root), false);
});

test("History holds ownership stable and refuses independent concurrent writers", async (t) => {
  const { root, sandbox } = await fixture(t);
  const child = join(sandbox, "other"); await mkdir(child);
  let release!: () => void;
  const held = withSpaceHistoryOperation(root, () => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(registerLinkedSpace(child), /Wait for History/);
  await assert.rejects(createSpaceCheckpoint(root), /current History/);
  release(); await held;
  await registerLinkedSpace(child);
});
