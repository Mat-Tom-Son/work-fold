import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { createWorkspaceCheckpoint, restoreWorkspaceCheckpoint } from "../src/local/history.js";
import { copyResourcesToWorkspace, listResourceTree, uploadResourceFiles } from "../src/local/resources.js";
import {
  configureWorkspaceStateRoot,
  legacyWorkspaceManifestFile,
  resourceLibraryRoot,
  workspaceManifestFile,
  workspaceRegistryFile,
} from "../src/local/state-paths.js";
import {
  beginWorkspaceRemoval,
  createManagedWorkspace,
  finalizeWorkspaceRemoval,
  listWorkspaces,
  listPendingWorkspaceRemovals,
  markWorkspaceRemovalAppStateRemoved,
  readWorkspaceTextFile,
  renameWorkspace,
  registerLinkedWorkspace,
  resolveWorkspacePath,
  scanWorkspaceTree,
  type WorkspaceRegistry,
  writeUploadedFiles,
  writeWorkspaceTextFile,
} from "../src/local/workspace.js";

let sandbox = "";
let stateRoot = "";
let contentRoot = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "workspace-local-test-"));
  stateRoot = join(sandbox, "state");
  contentRoot = join(sandbox, "content");
  configureWorkspaceStateRoot(stateRoot);
});

after(async () => {
  configureWorkspaceStateRoot(undefined);
  await rm(sandbox, { recursive: true, force: true });
});

test("managed Spaces keep portable identity metadata inside a hidden .workspace folder", async () => {
  const workspace = await createManagedWorkspace("Personal Space", contentRoot);
  const initialManifest = JSON.parse(await readFile(workspaceManifestFile(workspace.rootPath), "utf8")) as Record<string, unknown>;
  initialManifest.futurePortableField = { retained: true };
  await writeFile(workspaceManifestFile(workspace.rootPath), `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");
  const uploaded = await writeUploadedFiles(workspace.rootPath, "", [{
    fileName: "notes.txt",
    relativePath: "Notes/notes.txt",
    data: Buffer.from("hello workspace\n"),
  }]);

  assert.equal(uploaded[0]?.path, "Notes/notes.txt");
  assert.equal((await readWorkspaceTextFile(workspace.rootPath, "Notes/notes.txt")).text, "hello workspace\n");
  assert.equal((await scanWorkspaceTree(workspace.rootPath)).entries[0]?.name, "Notes");
  const currentWorkspace = (await listWorkspaces()).find((item) => item.id === workspace.id);
  assert.ok(currentWorkspace);
  assert.equal(existsSync(workspaceManifestFile(workspace.rootPath)), true);
  assert.deepEqual(JSON.parse(await readFile(workspaceManifestFile(workspace.rootPath), "utf8")), {
    version: 1,
    id: currentWorkspace.id,
    name: currentWorkspace.name,
    createdAt: currentWorkspace.createdAt,
    updatedAt: currentWorkspace.updatedAt,
    futurePortableField: { retained: true },
  });
  assert.equal((await listWorkspaces()).length, 1);
  assert.throws(() => resolveWorkspacePath(workspace.rootPath, "../outside.txt"), /escapes/);
});

test("linked Google Drive folders keep portable metadata hidden from Files", async () => {
  const linkedRoot = join(sandbox, "Google Drive", "My Drive", "Project");
  await mkdir(linkedRoot, { recursive: true });
  await mkdir(join(linkedRoot, ".pi", "skills"), { recursive: true });
  await writeFile(join(linkedRoot, ".pi", "skills", "private.md"), "hidden capability", "utf8");
  const existingFile = join(linkedRoot, "existing.txt");
  await writeFile(existingFile, "original", "utf8");
  const workspace = await registerLinkedWorkspace(linkedRoot);
  assert.equal(workspace.rootPath, linkedRoot);
  assert.equal(workspace.location.storage, "linked");
  assert.equal(workspace.location.providerHint, "google-drive");
  assert.equal(await readFile(existingFile, "utf8"), "original");
  assert.equal(existsSync(workspaceManifestFile(linkedRoot)), true);
  assert.equal((await scanWorkspaceTree(linkedRoot)).entries[0]?.path, "existing.txt");
});

test("a moved linked folder preserves its manifest identity when it is relinked", async () => {
  const originalRoot = join(sandbox, "portable-space-original");
  const movedRoot = join(sandbox, "portable-space-moved");
  await mkdir(originalRoot, { recursive: true });
  const original = await registerLinkedWorkspace(originalRoot);
  await rename(originalRoot, movedRoot);

  const relinked = await registerLinkedWorkspace(movedRoot);
  assert.equal(relinked.id, original.id);
  assert.equal(relinked.name, original.name);
  assert.equal(relinked.rootPath, movedRoot);
  assert.equal((await listWorkspaces()).filter((workspace) => workspace.id === original.id).length, 1);

  const duplicateRoot = join(sandbox, "portable-space-copy");
  await mkdir(join(duplicateRoot, ".workspace"), { recursive: true });
  await writeFile(workspaceManifestFile(duplicateRoot), await readFile(workspaceManifestFile(movedRoot), "utf8"), "utf8");
  await assert.rejects(registerLinkedWorkspace(duplicateRoot), /identity is already linked to another folder/);
});

test("legacy external manifests migrate non-destructively into .workspace", async () => {
  const linkedRoot = join(sandbox, "legacy-manifest-space");
  await mkdir(linkedRoot, { recursive: true });
  const legacyFile = legacyWorkspaceManifestFile(linkedRoot);
  await mkdir(dirname(legacyFile), { recursive: true });
  const legacyManifest = {
    id: "ws-0123456789abcdef",
    name: "Portable legacy identity",
    rootPath: linkedRoot,
    location: { kind: "local", storage: "linked" },
    createdAt: "2025-01-02T03:04:05.000Z",
    updatedAt: "2025-01-02T03:04:05.000Z",
  };
  await writeFile(legacyFile, `${JSON.stringify(legacyManifest)}\n`, "utf8");

  const workspace = await registerLinkedWorkspace(linkedRoot);
  assert.equal(workspace.id, legacyManifest.id);
  assert.equal(workspace.name, legacyManifest.name);
  assert.equal(existsSync(legacyFile), true);
  assert.equal(existsSync(workspaceManifestFile(linkedRoot)), true);
});

test("Space listing survives when portable metadata can no longer be maintained", async () => {
  const linkedRoot = join(sandbox, "metadata-became-unwritable");
  await mkdir(linkedRoot, { recursive: true });
  const workspace = await registerLinkedWorkspace(linkedRoot);
  await rm(join(linkedRoot, ".workspace"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".workspace"), "temporarily blocked", "utf8");

  assert.equal((await listWorkspaces()).some((item) => item.id === workspace.id), true);
});

test("blocked portable metadata does not leave a failed linked registration in the registry", async () => {
  const linkedRoot = join(sandbox, "blocked-registration-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, ".workspace"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedWorkspace(linkedRoot));
  assert.equal((await listWorkspaces()).some((item) => item.rootPath === linkedRoot), false);
});

test("failed portable writes do not apply a Space rename", async () => {
  const linkedRoot = join(sandbox, "blocked-rename-metadata");
  await mkdir(linkedRoot, { recursive: true });
  const workspace = await registerLinkedWorkspace(linkedRoot);
  await rm(join(linkedRoot, ".workspace"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".workspace"), "blocks the metadata directory", "utf8");

  await assert.rejects(renameWorkspace(workspace.id, "Failed rename"));
  const current = (await listWorkspaces()).find((item) => item.id === workspace.id);
  assert.equal(current?.name, workspace.name);
  assert.equal(current?.updatedAt, workspace.updatedAt);
});

test("failed portable writes do not rebind a moved Space identity", async () => {
  const originalRoot = join(sandbox, "blocked-rebind-original");
  const movedRoot = join(sandbox, "blocked-rebind-moved");
  await mkdir(originalRoot, { recursive: true });
  const workspace = await registerLinkedWorkspace(originalRoot);
  const portableManifest = await readFile(workspaceManifestFile(originalRoot), "utf8");
  await rename(originalRoot, movedRoot);
  const legacyFile = legacyWorkspaceManifestFile(movedRoot);
  await mkdir(dirname(legacyFile), { recursive: true });
  await writeFile(legacyFile, portableManifest, "utf8");
  await rm(join(movedRoot, ".workspace"), { recursive: true, force: true });
  await writeFile(join(movedRoot, ".workspace"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedWorkspace(movedRoot));
  await rm(join(movedRoot, ".workspace"), { force: true });
  await mkdir(join(movedRoot, ".workspace"), { recursive: true });
  await writeFile(workspaceManifestFile(movedRoot), portableManifest, "utf8");
  await rename(movedRoot, originalRoot);
  const current = (await listWorkspaces()).find((item) => item.id === workspace.id);
  assert.equal(current?.rootPath, originalRoot);
});

test("a content edit succeeds when post-mutation portable metadata maintenance is blocked", async () => {
  const linkedRoot = join(sandbox, "blocked-touch-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "draft.txt"), "before", "utf8");
  const workspace = await registerLinkedWorkspace(linkedRoot);
  await rm(join(linkedRoot, ".workspace"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".workspace"), "blocks the metadata directory", "utf8");

  await writeWorkspaceTextFile(linkedRoot, "draft.txt", "after");
  assert.equal(await readFile(join(linkedRoot, "draft.txt"), "utf8"), "after");
  const current = (await listWorkspaces()).find((item) => item.id === workspace.id);
  assert.equal(current?.updatedAt, workspace.updatedAt);
});

test("linked folders cannot overlap Workspace application state", async () => {
  await mkdir(stateRoot, { recursive: true });
  await assert.rejects(registerLinkedWorkspace(stateRoot), /cannot contain, or be contained by/);
  await assert.rejects(registerLinkedWorkspace(sandbox), /cannot contain, or be contained by/);
  await assert.rejects(createWorkspaceCheckpoint(sandbox), /does not contain Workspace application data/);
});

test("managed Space removal refuses a mismatched managed-content boundary", async () => {
  const workspace = await createManagedWorkspace("Removal guard", contentRoot);
  await assert.rejects(beginWorkspaceRemoval(workspace.id, join(sandbox, "different-managed-root")), /only delete a managed Space/);
  assert.equal(existsSync(workspace.rootPath), true);
});

test("a removal-intent persistence failure leaves the Space and managed folder untouched", async () => {
  const workspace = await createManagedWorkspace("Removal intent failure", contentRoot);
  await writeFile(join(workspace.rootPath, "keep.txt"), "keep", "utf8");

  await assert.rejects(beginWorkspaceRemoval(workspace.id, contentRoot, {
    async persistRegistry() {
      throw new Error("simulated registry write failure");
    },
  }), /simulated registry write failure/);

  assert.equal((await listWorkspaces()).some((item) => item.id === workspace.id), true);
  assert.equal(await readFile(join(workspace.rootPath, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

test("managed-folder cleanup failure leaves a hidden, recoverable removal intent", async () => {
  const workspace = await createManagedWorkspace("Removal cleanup retry", contentRoot);
  await writeFile(join(workspace.rootPath, "retry.txt"), "retry", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const pending = await finalizeWorkspaceRemoval(workspace.id, {
    async claimManagedRoot() {
      throw new Error("simulated managed-folder lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    rootPath: workspace.rootPath,
    cleanupPending: true,
  });
  assert.equal((await listWorkspaces()).some((item) => item.id === workspace.id), false);
  assert.equal(await readFile(join(workspace.rootPath, "retry.txt"), "utf8"), "retry");
  assert.equal((await listPendingWorkspaceRemovals())[0]?.phase, "app-state-removed");

  const recovered = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.equal(existsSync(workspace.rootPath), false);
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

test("a durable claim hint cannot finalize while the approved root still exists", async () => {
  const workspace = await createManagedWorkspace("Removal claim replay", contentRoot);
  await writeFile(join(workspace.rootPath, "approved-original.txt"), "original", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const registry = JSON.parse(await readFile(workspaceRegistryFile(), "utf8")) as {
    pendingRemovals: Array<{ managedRootClaimed: boolean }>;
  };
  registry.pendingRemovals[0]!.managedRootClaimed = true;
  await writeFile(workspaceRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const removed = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(workspace.rootPath), false,
    "recovery must reclaim and delete the exact root instead of trusting the progress hint");
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

test("a final registry-write failure remains idempotently recoverable after managed content is gone", async () => {
  const workspace = await createManagedWorkspace("Removal registry retry", contentRoot);
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const pending = await finalizeWorkspaceRemoval(workspace.id, {
    async persistRegistry(registry) {
      if (registry.pendingRemovals.length === 0) {
        throw new Error("simulated final registry write failure");
      }
      await persistWorkspaceRegistryForTest(registry);
    },
  });
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, true);
  assert.equal(existsSync(workspace.rootPath), false);
  assert.equal((await listWorkspaces()).some((item) => item.id === workspace.id), false);
  assert.equal((await listPendingWorkspaceRemovals())[0]?.workspaceId, workspace.id);

  await mkdir(workspace.rootPath, { recursive: true });
  const replacementSentinel = join(workspace.rootPath, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");
  const recovered = await finalizeWorkspaceRemoval(workspace.id);
  assert.deepEqual(recovered, {
    removed: true,
    deleted: true,
    rootPath: workspace.rootPath,
    cleanupPending: false,
  });
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

test("an unclaimed replacement folder or junction keeps managed removal pending", async () => {
  const workspace = await createManagedWorkspace("Removal replacement guard", contentRoot);
  await writeFile(join(workspace.rootPath, "approved-original.txt"), "original", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const originalAside = join(contentRoot, "approved-original-aside");
  await rename(workspace.rootPath, originalAside);
  await mkdir(workspace.rootPath, { recursive: false });
  const replacementSentinel = join(workspace.rootPath, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");

  const refusedReplacement = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(refusedReplacement.cleanupPending, true);
  assert.equal(refusedReplacement.deleted, false);
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(workspace.rootPath, { recursive: true, force: true });
  const junctionTarget = join(sandbox, "unrelated-junction-target");
  const junctionSentinel = join(junctionTarget, "outside-managed-root.txt");
  await mkdir(junctionTarget, { recursive: true });
  await writeFile(junctionSentinel, "also do not delete", "utf8");
  await symlink(junctionTarget, workspace.rootPath, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    (await listPendingWorkspaceRemovals())[0]?.workspaceId,
    workspace.id,
    "a later link at the pending path must not make intent parsing inspect live content",
  );
  const refusedJunction = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(refusedJunction.cleanupPending, true);
  assert.equal(refusedJunction.deleted, false);
  assert.equal(await readFile(junctionSentinel, "utf8"), "also do not delete");

  await unlink(workspace.rootPath);
  await rm(junctionTarget, { recursive: true, force: true });
  await rename(originalAside, workspace.rootPath);
  const recovered = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

test("a root swap during the managed claim never deletes either directory", async () => {
  const workspace = await createManagedWorkspace("Removal claim swap", contentRoot);
  await writeFile(join(workspace.rootPath, "approved-original.txt"), "original", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const originalAside = join(contentRoot, "claim-swap-original-aside");
  let claimedReplacement = "";
  const pending = await finalizeWorkspaceRemoval(workspace.id, {
    async claimManagedRoot(rootPath, claimPath) {
      claimedReplacement = claimPath;
      await rename(rootPath, originalAside);
      await mkdir(rootPath, { recursive: false });
      await writeFile(join(rootPath, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(rootPath, claimPath);
    },
  });

  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, false);
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");
  assert.equal(existsSync(claimedReplacement), false, "the mismatched claim is restored when the root name is still free");
  assert.equal(await readFile(join(workspace.rootPath, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal((await listPendingWorkspaceRemovals())[0]?.managedRootClaimed, false);

  await rm(workspace.rootPath, { recursive: true, force: true });
  await rename(originalAside, workspace.rootPath);
  const recovered = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("recovery retries restoration of a mismatched managed claim", async () => {
  const workspace = await createManagedWorkspace("Removal claim restore retry", contentRoot);
  await writeFile(join(workspace.rootPath, "approved-original.txt"), "original", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  const originalAside = join(contentRoot, "claim-restore-original-aside");
  let claimPath = "";
  const first = await finalizeWorkspaceRemoval(workspace.id, {
    async claimManagedRoot(rootPath, destination) {
      claimPath = destination;
      await rename(rootPath, originalAside);
      await mkdir(rootPath, { recursive: false });
      await writeFile(join(rootPath, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(rootPath, destination);
    },
    async restoreMismatchedManagedClaim() {
      throw new Error("simulated transient restore failure");
    },
  });
  assert.equal(first.cleanupPending, true);
  assert.equal(await readFile(join(claimPath, "replacement-sentinel.txt"), "utf8"), "replacement");

  const retry = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(retry.cleanupPending, true);
  assert.equal(retry.deleted, false);
  assert.equal(existsSync(claimPath), false);
  assert.equal(await readFile(join(workspace.rootPath, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(workspace.rootPath, { recursive: true, force: true });
  await rename(originalAside, workspace.rootPath);
  const recovered = await finalizeWorkspaceRemoval(workspace.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("a replacement created after the managed claim survives approved-folder deletion", async () => {
  const workspace = await createManagedWorkspace("Removal post-claim replacement", contentRoot);
  await writeFile(join(workspace.rootPath, "approved-original.txt"), "original", "utf8");
  await beginWorkspaceRemoval(workspace.id, contentRoot);
  await markWorkspaceRemovalAppStateRemoved(workspace.id);

  let claimPath = "";
  const replacementSentinel = join(workspace.rootPath, "replacement-sentinel.txt");
  const removed = await finalizeWorkspaceRemoval(workspace.id, {
    async claimManagedRoot(rootPath, destination) {
      claimPath = destination;
      await rename(rootPath, destination);
      await mkdir(rootPath, { recursive: false });
      await writeFile(replacementSentinel, "replacement", "utf8");
      await mkdir(join(rootPath, ".workspace"), { recursive: false });
      await writeFile(join(rootPath, ".workspace", "replacement-metadata.txt"), "replacement metadata", "utf8");
    },
  });

  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(claimPath), false, "only the identity-verified claim is recursively deleted");
  assert.equal(await readFile(replacementSentinel, "utf8"), "replacement");
  assert.equal(
    await readFile(join(workspace.rootPath, ".workspace", "replacement-metadata.txt"), "utf8"),
    "replacement metadata",
    "external Workspace state cleanup must not touch a replacement folder's portable metadata",
  );
  assert.deepEqual(await listPendingWorkspaceRemovals(), []);
});

async function persistWorkspaceRegistryForTest(registry: WorkspaceRegistry): Promise<void> {
  await writeFile(workspaceRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

test("Library items copy into a visible From Library folder", async () => {
  assert.equal(resourceLibraryRoot(), join(stateRoot, "resources"));
  const workspace = await createManagedWorkspace("Library Target", contentRoot);
  await uploadResourceFiles("", [{ fileName: "template.md", data: Buffer.from("# Template\n") }]);
  assert.equal((await listResourceTree())[0]?.path, "template.md");
  const copied = await copyResourcesToWorkspace(workspace.rootPath, ["template.md"], "From Library");
  assert.deepEqual(copied, ["From Library/template.md"]);
  assert.equal(await readFile(join(workspace.rootPath, "From Library", "template.md"), "utf8"), "# Template\n");
});

test("restore points live externally and can restore workspace files", async () => {
  const workspace = await createManagedWorkspace("History Target", contentRoot);
  const file = join(workspace.rootPath, "draft.txt");
  await writeFile(file, "version one", "utf8");
  const checkpoint = await createWorkspaceCheckpoint(workspace.rootPath, { label: "Version one" });
  assert.equal(checkpoint.files.some((entry) => entry.path.startsWith(".workspace/")), false);
  assert.equal(checkpoint.directories.some((entry) => entry === ".workspace" || entry.startsWith(".workspace/")), false);
  await writeFile(file, "version two", "utf8");

  const result = await restoreWorkspaceCheckpoint(workspace.rootPath, checkpoint.checkpointId);
  assert.equal(result.restored, true);
  assert.equal(await readFile(file, "utf8"), "version one");
  assert.equal(existsSync(join(workspace.rootPath, "history")), false);
});

test("the Space tree keeps a stable order under batched inspection and survives unreadable entries", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-tree-scan-"));
  t.after(async () => {
    await chmod(join(sandbox, "unreadable"), 0o755).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  // Wide enough to span several inspection batches.
  const names = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name) => writeFile(join(sandbox, name), name, "utf8")));
  await mkdir(join(sandbox, "zeta-folder"), { recursive: true });

  const tree = (await scanWorkspaceTree(sandbox, 2)).entries;
  assert.deepEqual(
    tree.map((entry) => entry.name),
    ["zeta-folder", ...names],
    "folders sort before files and batching does not disturb the order",
  );

  // A directory that can be listed but not traversed makes stat fail for every
  // child. That must degrade to an empty folder, not break the whole Space.
  await mkdir(join(sandbox, "unreadable"), { recursive: true });
  await writeFile(join(sandbox, "unreadable", "hidden.txt"), "x", "utf8");
  await chmod(join(sandbox, "unreadable"), 0o444);
  if ((await stat(join(sandbox, "unreadable", "hidden.txt")).catch(() => null)) !== null) {
    t.skip("filesystem does not enforce directory traversal permission");
    return;
  }

  const degraded = (await scanWorkspaceTree(sandbox, 2)).entries;
  const unreadable = degraded.find((entry) => entry.name === "unreadable");
  assert.equal(unreadable?.kind, "folder");
  assert.deepEqual(unreadable?.children, [], "children that cannot be inspected are skipped");
  assert.equal(degraded.filter((entry) => entry.kind === "file").length, names.length, "the rest of the Space still lists");
});

test("the Space tree stops at its entry budget and reports a partial listing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-tree-budget-"));
  const previous = process.env.WORKSPACE_TREE_MAX_ENTRIES;
  process.env.WORKSPACE_TREE_MAX_ENTRIES = "5";
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKSPACE_TREE_MAX_ENTRIES;
    else process.env.WORKSPACE_TREE_MAX_ENTRIES = previous;
    await rm(sandbox, { recursive: true, force: true });
  });

  await mkdir(join(sandbox, "nested"), { recursive: true });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, `top-${index}.txt`), "x", "utf8")),
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, "nested", `deep-${index}.txt`), "x", "utf8")),
  ]);

  const capped = await scanWorkspaceTree(sandbox, 5);
  assert.equal(capped.truncated, true, "reaching the budget is disclosed rather than silently trimming");
  assert.ok(countTreeEntries(capped.entries) <= 5, `budget must bound total entries, saw ${countTreeEntries(capped.entries)}`);

  // The budget spans the whole walk, not each folder, so a deep Space cannot
  // multiply it by depth.
  process.env.WORKSPACE_TREE_MAX_ENTRIES = "1000";
  const whole = await scanWorkspaceTree(sandbox, 5);
  assert.equal(whole.truncated, false);
  assert.equal(countTreeEntries(whole.entries), 17, "8 top files + nested folder + 8 nested files");
});

function countTreeEntries(entries: Awaited<ReturnType<typeof scanWorkspaceTree>>["entries"]): number {
  return entries.reduce((total, entry) => total + 1 + countTreeEntries(entry.children ?? []), 0);
}
