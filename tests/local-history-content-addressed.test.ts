import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkspaceCheckpoint,
  createWorkspaceMutationCheckpoint,
  listFileVersions,
  listWorkspaceCheckpoints,
  restoreWorkspaceCheckpoint,
} from "../src/local/history.js";
import { configureWorkspaceStateRoot, workspaceHistoryRoot } from "../src/local/state-paths.js";

test("content-addressed history deduplicates blobs and identical manifests while recording skipped content", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-history-objects-"));
  const root = join(sandbox, "space");
  const state = join(sandbox, "state");
  const oldMaxBytes = process.env.WORKSPACE_HISTORY_MAX_FILE_BYTES;
  const oldMaxCheckpoints = process.env.WORKSPACE_HISTORY_MAX_CHECKPOINTS;
  process.env.WORKSPACE_HISTORY_MAX_FILE_BYTES = "32";
  process.env.WORKSPACE_HISTORY_MAX_CHECKPOINTS = "100";
  configureWorkspaceStateRoot(state);
  await mkdir(join(root, "node_modules", "example"), { recursive: true });
  await writeFile(join(root, "alpha.txt"), "shared content", "utf8");
  await writeFile(join(root, "duplicate.txt"), "shared content", "utf8");
  await writeFile(join(root, "large.bin"), Buffer.alloc(64, 7));
  await writeFile(join(root, "node_modules", "example", "index.js"), "ignored dependency", "utf8");
  t.after(async () => {
    restoreEnv("WORKSPACE_HISTORY_MAX_FILE_BYTES", oldMaxBytes);
    restoreEnv("WORKSPACE_HISTORY_MAX_CHECKPOINTS", oldMaxCheckpoints);
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const first = await createWorkspaceCheckpoint(root, { reason: "manual", label: "First" });
  assert.equal(first.fileCount, 2);
  assert.deepEqual(first.skippedLargeFiles, ["large.bin"]);
  assert.ok(first.skippedFiles.some((file) => file.path === "node_modules" && file.reason === "excluded"));
  assert.equal((await listObjectFiles(workspaceHistoryRoot(root))).length, 1, "identical bytes share one object");

  const duplicate = await createWorkspaceCheckpoint(root, { reason: "manual", label: "Same contents" });
  assert.equal(duplicate.checkpointId, first.checkpointId, "identical manifest is reused");
  assert.equal((await listWorkspaceCheckpoints(root)).length, 1);

  await writeFile(join(root, "alpha.txt"), "changed", "utf8");
  await writeFile(join(root, "later.txt"), "created later", "utf8");
  const second = await createWorkspaceCheckpoint(root, { reason: "manual", label: "Second" });
  assert.notEqual(second.checkpointId, first.checkpointId);
  await writeFile(join(root, "large.bin"), Buffer.alloc(64, 9));

  const restored = await restoreWorkspaceCheckpoint(root, first.checkpointId);
  assert.equal(restored.restored, true);
  assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "shared content");
  assert.equal(existsSync(join(root, "later.txt")), false, "full restore removes later versioned files");
  assert.deepEqual(await readFile(join(root, "large.bin")), Buffer.alloc(64, 9), "skipped large file is preserved");
  assert.ok((await listFileVersions(root, "alpha.txt")).length >= 2);
});

test("targeted mutation restore changes only the affected paths", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-history-targeted-"));
  const root = join(sandbox, "space");
  configureWorkspaceStateRoot(join(sandbox, "state"));
  await mkdir(join(root, "Drafts"), { recursive: true });
  await writeFile(join(root, "Drafts", "note.txt"), "before", "utf8");
  await writeFile(join(root, "unrelated.txt"), "one", "utf8");
  t.after(async () => {
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const editSafety = await createWorkspaceMutationCheckpoint(root, {
    paths: ["Drafts/note.txt"],
    reason: "pre_edit",
  });
  await writeFile(join(root, "Drafts", "note.txt"), "after", "utf8");
  await writeFile(join(root, "unrelated.txt"), "two", "utf8");
  await restoreWorkspaceCheckpoint(root, editSafety.checkpointId);
  assert.equal(await readFile(join(root, "Drafts", "note.txt"), "utf8"), "before");
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "two", "unrelated later work survives targeted undo");

  const moveSafety = await createWorkspaceMutationCheckpoint(root, {
    movesOnRestore: [{ fromPath: "Renamed", toPath: "Drafts" }],
    reason: "pre_move",
  });
  await import("node:fs/promises").then(({ rename }) => rename(join(root, "Drafts"), join(root, "Renamed")));
  await restoreWorkspaceCheckpoint(root, moveSafety.checkpointId);
  assert.equal(await readFile(join(root, "Drafts", "note.txt"), "utf8"), "before");
  assert.equal(existsSync(join(root, "Renamed")), false);

  const createSafety = await createWorkspaceMutationCheckpoint(root, {
    deleteOnRestore: ["new-folder"],
    reason: "pre_create",
  });
  await mkdir(join(root, "new-folder"));
  await writeFile(join(root, "new-folder", "new.txt"), "new", "utf8");
  await restoreWorkspaceCheckpoint(root, createSafety.checkpointId);
  assert.equal(existsSync(join(root, "new-folder")), false);
  assert.equal(await readFile(join(root, "unrelated.txt"), "utf8"), "two");
});

test("history migrates legacy copied snapshots and enforces manifest retention", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-history-migrate-"));
  const root = join(sandbox, "space");
  const state = join(sandbox, "state");
  const oldMax = process.env.WORKSPACE_HISTORY_MAX_CHECKPOINTS;
  process.env.WORKSPACE_HISTORY_MAX_CHECKPOINTS = "2";
  configureWorkspaceStateRoot(state);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "note.txt"), "legacy", "utf8");
  const legacyId = "cp-20260101010101-12345678";
  const legacyDir = join(workspaceHistoryRoot(root), legacyId);
  await mkdir(join(legacyDir, "files"), { recursive: true });
  await writeFile(join(legacyDir, "files", "note.txt"), "legacy", "utf8");
  await writeFile(join(legacyDir, "checkpoint.json"), `${JSON.stringify({
    checkpointId: legacyId,
    createdAt: "2026-01-01T01:01:01.000Z",
    reason: "manual",
    label: "Legacy",
    fileCount: 1,
  })}\n`, "utf8");
  t.after(async () => {
    restoreEnv("WORKSPACE_HISTORY_MAX_CHECKPOINTS", oldMax);
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  assert.equal((await listWorkspaceCheckpoints(root))[0]?.checkpointId, legacyId);
  assert.equal(existsSync(legacyDir), false, "legacy copied snapshot is removed after object migration");
  assert.equal((await listObjectFiles(workspaceHistoryRoot(root))).length, 1);

  for (const value of ["two", "three", "four"]) {
    await writeFile(join(root, "note.txt"), value, "utf8");
    await createWorkspaceCheckpoint(root, { reason: "manual", label: value });
  }
  assert.equal((await listWorkspaceCheckpoints(root, 20)).length, 2);
  assert.equal((await listObjectFiles(workspaceHistoryRoot(root))).length, 2, "unreferenced objects are collected with pruned manifests");
});

test("capture hashes current bytes even when external tools preserve file metadata", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-history-incremental-"));
  const root = join(sandbox, "space");
  const state = join(sandbox, "state");
  configureWorkspaceStateRoot(state);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "settled.txt"), "aaaa", "utf8");
  await writeFile(join(root, "edited.txt"), "keep", "utf8");
  t.after(async () => {
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  const first = await createWorkspaceCheckpoint(root, { reason: "manual", label: "First" });
  // Same path, same size, same mtime, different bytes. History is a recovery
  // boundary, so filesystem metadata cannot stand in for reading the bytes.
  const settledStat = await stat(join(root, "settled.txt"));
  await writeFile(join(root, "settled.txt"), "bbbb", "utf8");
  await utimes(join(root, "settled.txt"), settledStat.atime, settledStat.mtime);
  await writeFile(join(root, "edited.txt"), "changed", "utf8");

  const second = await createWorkspaceCheckpoint(root, { reason: "manual", label: "Second" });
  assert.notEqual(
    digestOf(second, "settled.txt"),
    digestOf(first, "settled.txt"),
    "a metadata-preserving rewrite is still captured as new content",
  );
  assert.notEqual(digestOf(second, "edited.txt"), digestOf(first, "edited.txt"), "a changed file is re-read and re-hashed");

  // Future mtimes are not special-cased either: the checkpoint always records
  // the bytes it observed.
  const unsettled = new Date(Date.now() + 60_000);
  await writeFile(join(root, "racing.txt"), "first", "utf8");
  await utimes(join(root, "racing.txt"), unsettled, unsettled);
  const third = await createWorkspaceCheckpoint(root, { reason: "manual", label: "Third" });
  await writeFile(join(root, "racing.txt"), "fresh", "utf8");
  await utimes(join(root, "racing.txt"), unsettled, unsettled);
  const fourth = await createWorkspaceCheckpoint(root, { reason: "manual", label: "Fourth" });
  assert.notEqual(
    digestOf(fourth, "racing.txt"),
    digestOf(third, "racing.txt"),
    "a capture sharing its file's timestamp tick is not trusted as a reuse source",
  );
});

function digestOf(checkpoint: { files: Array<{ path: string; hashSha256: string }> }, path: string): string | undefined {
  return checkpoint.files.find((file) => file.path === path)?.hashSha256;
}

async function listObjectFiles(historyRoot: string): Promise<string[]> {
  const objectsRoot = join(historyRoot, "objects");
  const result: string[] = [];
  for (const prefix of await readdir(objectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!prefix.isDirectory()) continue;
    for (const file of await readdir(join(objectsRoot, prefix.name), { withFileTypes: true })) {
      if (file.isFile()) result.push(`${prefix.name}${file.name}`);
    }
  }
  return result.sort();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
