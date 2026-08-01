import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyResourcesToWorkspace, ensureResourceRoot } from "../src/local/resources.js";
import { configureWorkspaceStateRoot } from "../src/local/state-paths.js";
import { writeUploadedFiles } from "../src/local/workspace.js";

test("a failing upload batch removes the files that already landed", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-upload-batch-test-"));
  try {
    const root = join(sandbox, "space");
    await mkdir(root, { recursive: true });
    // The second file's parent path collides with a regular file, so its
    // directory creation fails after the first file has been written.
    await writeFile(join(root, "conflict"), "already a file", "utf8");
    await assert.rejects(() => writeUploadedFiles(root, "", [
      { fileName: "first.txt", data: Buffer.from("first") },
      { fileName: "second.txt", relativePath: "conflict/second.txt", data: Buffer.from("second") },
    ]));
    assert.equal(existsSync(join(root, "first.txt")), false, "the already-written file must be removed");
    assert.deepEqual(await readdir(root), ["conflict"], "only the pre-existing file remains");

    // A clean batch still lands normally afterwards.
    const written = await writeUploadedFiles(root, "Batch", [
      { fileName: "first.txt", data: Buffer.from("first") },
      { fileName: "second.txt", data: Buffer.from("second") },
    ]);
    assert.deepEqual(written.map((file) => file.path), ["Batch/first.txt", "Batch/second.txt"]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a failing Library copy batch removes the items that already copied", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-library-batch-test-"));
  try {
    configureWorkspaceStateRoot(join(sandbox, "state"));
    const libraryRoot = await ensureResourceRoot();
    await writeFile(join(libraryRoot, "a.txt"), "alpha", "utf8");
    const workspaceRoot = join(sandbox, "space");
    await mkdir(workspaceRoot, { recursive: true });

    await assert.rejects(
      () => copyResourcesToWorkspace(workspaceRoot, ["a.txt", "missing.txt"], "From Library"),
      /Library item not found/,
    );
    assert.equal(
      existsSync(join(workspaceRoot, "From Library", "a.txt")),
      false,
      "the already-copied Library item must be removed",
    );

    const copied = await copyResourcesToWorkspace(workspaceRoot, ["a.txt"], "From Library");
    assert.deepEqual(copied, ["From Library/a.txt"]);
  } finally {
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});
