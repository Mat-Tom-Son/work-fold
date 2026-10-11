import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { createWorkFolderCheckpoint, restoreWorkFolderCheckpoint } from "../src/local/history.js";
import {
  configureWorkFoldStateRoot,
  workFolderManifestFile,
  workFolderRegistryFile,
} from "../src/local/state-paths.js";
import {
  beginWorkFolderRemoval,
  copyPathIntoWorkFolder,
  createManagedWorkFolder,
  createWorkFolderFolder,
  createWorkFolderTextFile,
  finalizeWorkFolderRemoval,
  listWorkFolders,
  listPendingWorkFolderRemovals,
  markWorkFolderRemovalAppStateRemoved,
  readWorkFolderTextFile,
  registerManagedWorkFolder,
  renameWorkFolder,
  registerLinkedWorkFolder,
  resolveWorkFolderPath,
  scanWorkFolderTree,
  type WorkFolderRegistry,
  writeUploadedFiles,
  writeWorkFolderTextFile,
} from "../src/local/work-folder.js";
import { setWorkFolderIgnoreState } from "../src/local/work-folder-ignore.js";

let sandbox = "";
let stateRoot = "";
let contentRoot = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "work-folder-local-test-"));
  stateRoot = join(sandbox, "state");
  contentRoot = join(sandbox, "content");
  configureWorkFoldStateRoot(stateRoot);
});

after(async () => {
  configureWorkFoldStateRoot(undefined);
  await rm(sandbox, { recursive: true, force: true });
});

test("an unreadable registry never becomes an empty work-folder list", async () => {
  await mkdir(stateRoot, { recursive: true });
  const file = workFolderRegistryFile();
  const previous = await readFile(file).catch(() => null);
  try {
    await writeFile(file, "{ incomplete registry");
    await assert.rejects(listWorkFolders(), /work-folder registry could not be read safely/);
    assert.equal(await readFile(file, "utf8"), "{ incomplete registry", "reading leaves the recoverable file untouched");
  } finally {
    if (previous) await writeFile(file, previous);
    else await rm(file, { force: true });
  }
});

test("managed work-folders keep portable identity metadata inside a hidden .work-fold folder", async () => {
  const workFolder = await createManagedWorkFolder("Personal work-folder", contentRoot);
  const initialManifest = JSON.parse(await readFile(workFolderManifestFile(workFolder.workFolderRoot), "utf8")) as Record<string, unknown>;
  initialManifest.futurePortableField = { retained: true };
  await writeFile(workFolderManifestFile(workFolder.workFolderRoot), `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");
  const uploaded = await writeUploadedFiles(workFolder.workFolderRoot, "", [{
    fileName: "notes.txt",
    relativePath: "Notes/notes.txt",
    data: Buffer.from("hello space\n"),
  }]);

  assert.equal(uploaded[0]?.path, "Notes/notes.txt");
  assert.equal((await readWorkFolderTextFile(workFolder.workFolderRoot, "Notes/notes.txt")).text, "hello space\n");
  assert.equal((await scanWorkFolderTree(workFolder.workFolderRoot)).entries[0]?.name, "Notes");
  const currentWorkFolder = (await listWorkFolders()).find((item) => item.id === workFolder.id);
  assert.ok(currentWorkFolder);
  assert.equal(existsSync(workFolderManifestFile(workFolder.workFolderRoot)), true);
  assert.deepEqual(JSON.parse(await readFile(workFolderManifestFile(workFolder.workFolderRoot), "utf8")), {
    version: 1,
    id: currentWorkFolder.id,
    name: currentWorkFolder.name,
    createdAt: currentWorkFolder.createdAt,
    updatedAt: currentWorkFolder.updatedAt,
    futurePortableField: { retained: true },
  });
  assert.equal((await listWorkFolders()).length, 1);
  assert.throws(() => resolveWorkFolderPath(workFolder.workFolderRoot, "../outside.txt"), /escapes/);
  for (const reserved of [".work-fold", ".WORK-FOLD", ".workspace", ".WORKSPACE", ".pi", ".PI"]) {
    assert.throws(
      () => resolveWorkFolderPath(workFolder.workFolderRoot, `ordinary/${reserved}/secret.txt`),
      /reserved/i,
      `${reserved} stays outside ordinary work-folder file APIs`,
    );
  }
});

test("linked Google Drive folders keep portable metadata hidden from Files", async () => {
  const linkedRoot = join(sandbox, "Google Drive", "My Drive", "Project");
  await mkdir(linkedRoot, { recursive: true });
  await mkdir(join(linkedRoot, ".pi", "skills"), { recursive: true });
  await writeFile(join(linkedRoot, ".pi", "skills", "private.md"), "hidden capability", "utf8");
  await mkdir(join(linkedRoot, ".workspace", "conversations"), { recursive: true });
  await writeFile(join(linkedRoot, ".workspace", "work-folder.json"), "legacy identity", "utf8");
  await writeFile(join(linkedRoot, ".workspace", "conversations", "old.jsonl"), "legacy chat", "utf8");
  const existingFile = join(linkedRoot, "existing.txt");
  await writeFile(existingFile, "original", "utf8");
  const workFolder = await registerLinkedWorkFolder(linkedRoot);
  assert.equal(workFolder.workFolderRoot, linkedRoot);
  assert.equal(workFolder.location.storage, "linked");
  assert.equal(workFolder.location.providerHint, "google-drive");
  assert.equal(await readFile(existingFile, "utf8"), "original");
  assert.equal(existsSync(workFolderManifestFile(linkedRoot)), true);
  assert.equal((await scanWorkFolderTree(linkedRoot)).entries[0]?.path, "existing.txt");
  assert.equal(await readFile(join(linkedRoot, ".workspace", "work-folder.json"), "utf8"), "legacy identity");
});

test("a moved linked folder preserves its manifest identity when it is relinked", async () => {
  const originalRoot = join(sandbox, "portable-work-folder-original");
  const movedRoot = join(sandbox, "portable-work-folder-moved");
  await mkdir(originalRoot, { recursive: true });
  const original = await registerLinkedWorkFolder(originalRoot);
  await rename(originalRoot, movedRoot);

  const relinked = await registerLinkedWorkFolder(movedRoot);
  assert.equal(relinked.id, original.id);
  assert.equal(relinked.name, original.name);
  assert.equal(relinked.workFolderRoot, movedRoot);
  assert.equal((await listWorkFolders()).filter((workFolder) => workFolder.id === original.id).length, 1);

  const duplicateRoot = join(sandbox, "portable-work-folder-copy");
  await mkdir(join(duplicateRoot, ".work-fold"), { recursive: true });
  await writeFile(workFolderManifestFile(duplicateRoot), await readFile(workFolderManifestFile(movedRoot), "utf8"), "utf8");
  await assert.rejects(registerLinkedWorkFolder(duplicateRoot), /identity is already linked to another folder/);
});

test("legacy external manifests remain inert and are not imported", async () => {
  const linkedRoot = join(sandbox, "legacy-manifest-work-folder");
  await mkdir(linkedRoot, { recursive: true });
  const legacyFile = join(linkedRoot, ".workspace", "work-folder.json");
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

  const workFolder = await registerLinkedWorkFolder(linkedRoot);
  assert.notEqual(workFolder.id, legacyManifest.id);
  assert.notEqual(workFolder.name, legacyManifest.name);
  assert.equal(existsSync(legacyFile), true);
  assert.equal(existsSync(workFolderManifestFile(linkedRoot)), true);
});

test("work-folder listing survives when portable metadata can no longer be maintained", async () => {
  const linkedRoot = join(sandbox, "metadata-became-unwritable");
  await mkdir(linkedRoot, { recursive: true });
  const workFolder = await registerLinkedWorkFolder(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "temporarily blocked", "utf8");

  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), true);
});

test("blocked portable metadata does not leave a failed linked registration in the registry", async () => {
  const linkedRoot = join(sandbox, "blocked-registration-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedWorkFolder(linkedRoot));
  assert.equal((await listWorkFolders()).some((item) => item.workFolderRoot === linkedRoot), false);
});

test("failed portable writes do not apply a work-folder rename", async () => {
  const linkedRoot = join(sandbox, "blocked-rename-metadata");
  await mkdir(linkedRoot, { recursive: true });
  const workFolder = await registerLinkedWorkFolder(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(renameWorkFolder(workFolder.id, "Failed rename"));
  const current = (await listWorkFolders()).find((item) => item.id === workFolder.id);
  assert.equal(current?.name, workFolder.name);
  assert.equal(current?.updatedAt, workFolder.updatedAt);
});

test("failed portable writes do not rebind a moved work-folder identity", async () => {
  const originalRoot = join(sandbox, "blocked-rebind-original");
  const movedRoot = join(sandbox, "blocked-rebind-moved");
  await mkdir(originalRoot, { recursive: true });
  const workFolder = await registerLinkedWorkFolder(originalRoot);
  const portableManifest = await readFile(workFolderManifestFile(originalRoot), "utf8");
  await rename(originalRoot, movedRoot);
  await rm(join(movedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(movedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedWorkFolder(movedRoot));
  await rm(join(movedRoot, ".work-fold"), { force: true });
  await mkdir(join(movedRoot, ".work-fold"), { recursive: true });
  await writeFile(workFolderManifestFile(movedRoot), portableManifest, "utf8");
  await rename(movedRoot, originalRoot);
  const current = (await listWorkFolders()).find((item) => item.id === workFolder.id);
  assert.equal(current?.workFolderRoot, originalRoot);
});

test("a content edit succeeds when post-mutation portable metadata maintenance is blocked", async () => {
  const linkedRoot = join(sandbox, "blocked-touch-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "draft.txt"), "before", "utf8");
  const workFolder = await registerLinkedWorkFolder(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await writeWorkFolderTextFile(linkedRoot, "draft.txt", "after");
  assert.equal(await readFile(join(linkedRoot, "draft.txt"), "utf8"), "after");
  const current = (await listWorkFolders()).find((item) => item.id === workFolder.id);
  assert.equal(current?.updatedAt, workFolder.updatedAt);
});

test("linked folders cannot overlap work-folder application state", async () => {
  await mkdir(stateRoot, { recursive: true });
  await assert.rejects(registerLinkedWorkFolder(stateRoot), /cannot contain, or be contained by/);
  await assert.rejects(registerLinkedWorkFolder(sandbox), /cannot contain, or be contained by/);
  await assert.rejects(createWorkFolderCheckpoint(sandbox), /does not contain work-fold application data/);
});

test("managed work-folder removal refuses a mismatched managed-content boundary", async () => {
  const workFolder = await createManagedWorkFolder("Removal guard", contentRoot);
  await assert.rejects(beginWorkFolderRemoval(workFolder.id, join(sandbox, "different-managed-root")), /only delete a managed work-folder/);
  assert.equal(existsSync(workFolder.workFolderRoot), true);
});

test("a removal-intent persistence failure leaves the work-folder and managed folder untouched", async () => {
  const workFolder = await createManagedWorkFolder("Removal intent failure", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "keep.txt"), "keep", "utf8");

  await assert.rejects(beginWorkFolderRemoval(workFolder.id, contentRoot, {
    async persistRegistry() {
      throw new Error("simulated registry write failure");
    },
  }), /simulated registry write failure/);

  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), true);
  assert.equal(await readFile(join(workFolder.workFolderRoot, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

test("managed-folder cleanup failure leaves a hidden, recoverable removal intent", async () => {
  const workFolder = await createManagedWorkFolder("Removal cleanup retry", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "retry.txt"), "retry", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const pending = await finalizeWorkFolderRemoval(workFolder.id, {
    async claimManagedRoot() {
      throw new Error("simulated managed-folder lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    workFolderRoot: workFolder.workFolderRoot,
    cleanupPending: true,
  });
  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), false);
  assert.equal(await readFile(join(workFolder.workFolderRoot, "retry.txt"), "utf8"), "retry");
  assert.equal((await listPendingWorkFolderRemovals())[0]?.phase, "app-state-removed");

  const recovered = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.equal(existsSync(workFolder.workFolderRoot), false);
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

test("a preserve-disposition removal unregisters a managed work-folder while its folder provably survives", async () => {
  const workFolder = await createManagedWorkFolder("Managed keep-folder", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "keep.md"), "still here", "utf8");

  const intent = await beginWorkFolderRemoval(workFolder.id, contentRoot, {}, { folderDisposition: "preserve" });
  assert.equal(intent.folderDisposition, "preserve");
  assert.equal(intent.storage, "managed");
  assert.equal(intent.managedBase, null, "a preserve intent records no managed-content boundary");
  assert.equal(intent.managedRootIdentity, null, "a preserve intent holds no deletion identity");

  // The durable intent round-trips the strict registry read, and an
  // in-flight preserve intent cannot be converted into a deletion.
  assert.equal((await listPendingWorkFolderRemovals())[0]?.folderDisposition, "preserve");
  await assert.rejects(beginWorkFolderRemoval(workFolder.id, contentRoot), /different folder disposition/);

  await markWorkFolderRemovalAppStateRemoved(workFolder.id);
  // A crash between app-state cleanup and registry finalization keeps the
  // preserve semantics: the pending result never claims a deletion.
  const pending = await finalizeWorkFolderRemoval(workFolder.id, {
    async removeWorkFolderState() {
      throw new Error("simulated app-state lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    workFolderRoot: workFolder.workFolderRoot,
    cleanupPending: true,
  });

  const removed = await finalizeWorkFolderRemoval(workFolder.id, {
    async claimManagedRoot() {
      throw new Error("a preserve removal must never claim the managed root");
    },
    async removeClaimedManagedRoot() {
      throw new Error("a preserve removal must never delete the managed root");
    },
  });
  assert.deepEqual(removed, {
    removed: true,
    deleted: false,
    workFolderRoot: workFolder.workFolderRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(join(workFolder.workFolderRoot, "keep.md"), "utf8"), "still here");
  assert.equal(existsSync(workFolderManifestFile(workFolder.workFolderRoot)), true, "the portable identity persists");
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), false);

  // The preserved folder registers again with the same portable identity.
  const reRegistered = await registerLinkedWorkFolder(workFolder.workFolderRoot);
  assert.equal(reRegistered.id, workFolder.id, "re-registration restores the persisted identity");
});

test("a managed folder registers again with its portable identity, and only inside the managed base", async () => {
  // How a work-folder's folder comes back from Recently deleted
  // (docs/receipts-not-gates.md, F20): the folder is already in the managed
  // base, and its `.work-fold/work-folder.json` identity is what makes it the same
  // work-folder rather than a copy.
  const workFolder = await createManagedWorkFolder("Restorable", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "brief.md"), "# brief\n", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot, {});
  await markWorkFolderRemovalAppStateRemoved(workFolder.id, {});
  // The removal moves the claimed folder away instead of erasing it, exactly
  // as the trash io does; putting it back is what a restore then does.
  const parked = join(dirname(workFolder.workFolderRoot), "parked-managed-folder");
  await finalizeWorkFolderRemoval(workFolder.id, {
    removeClaimedManagedRoot: async (claimPath) => { await rename(claimPath, parked); },
  });
  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), false);
  assert.equal(existsSync(workFolder.workFolderRoot), false);

  await rename(parked, workFolder.workFolderRoot);
  const restored = await registerManagedWorkFolder(workFolder.workFolderRoot, "Restorable", contentRoot);
  assert.equal(restored.id, workFolder.id, "the portable identity comes back with the folder");
  assert.equal(restored.location.storage, "managed");
  assert.equal(await readFile(join(workFolder.workFolderRoot, "brief.md"), "utf8"), "# brief\n");

  // Nothing outside the managed base is a managed work-folder, and a missing
  // folder is refused rather than created.
  const outside = join(dirname(contentRoot), "outside-managed-base");
  await mkdir(outside, { recursive: true });
  await assert.rejects(
    () => registerManagedWorkFolder(outside, "Outside", contentRoot),
    /inside its managed-content folder/,
  );
  await assert.rejects(
    () => registerManagedWorkFolder(join(contentRoot, "never-existed"), "Ghost", contentRoot),
    /does not exist/,
  );
  await assert.rejects(
    () => registerManagedWorkFolder(contentRoot, "The base itself", contentRoot),
    /inside its managed-content folder/,
  );
});

test("a preserve marker is valid only on a managed intent that holds no deletion authority", async () => {
  const workFolder = await createManagedWorkFolder("Preserve marker rules", contentRoot);
  await beginWorkFolderRemoval(workFolder.id, contentRoot, {}, { folderDisposition: "preserve" });
  const registryText = await readFile(workFolderRegistryFile(), "utf8");
  const poison = (mutate: (intent: Record<string, unknown>) => void) => {
    const registry = JSON.parse(registryText) as { pendingRemovals: Array<Record<string, unknown>> };
    mutate(registry.pendingRemovals[0]!);
    return writeFile(workFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  };

  // A preserve intent that somehow gained deletion authority is refused by
  // the strict registry read: the shape itself is the proof.
  await poison((intent) => { intent.managedRootClaimed = true; });
  await assert.rejects(listPendingWorkFolderRemovals(), /could not be read safely/);

  await poison((intent) => { intent.folderDisposition = "delete"; });
  await assert.rejects(listPendingWorkFolderRemovals(), /could not be read safely/);

  // Restore the valid preserve intent and complete the removal so later
  // tests see a clean registry.
  await writeFile(workFolderRegistryFile(), registryText, "utf8");
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);
  const removed = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(removed.deleted, false);
  assert.equal(existsSync(workFolder.workFolderRoot), true);
});

test("a durable claim hint cannot finalize while the approved root still exists", async () => {
  const workFolder = await createManagedWorkFolder("Removal claim replay", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const registry = JSON.parse(await readFile(workFolderRegistryFile(), "utf8")) as {
    pendingRemovals: Array<{ managedRootClaimed: boolean }>;
  };
  registry.pendingRemovals[0]!.managedRootClaimed = true;
  await writeFile(workFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const removed = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(workFolder.workFolderRoot), false,
    "recovery must reclaim and delete the exact root instead of trusting the progress hint");
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

test("a final registry-write failure remains idempotently recoverable after managed content is gone", async () => {
  const workFolder = await createManagedWorkFolder("Removal registry retry", contentRoot);
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const pending = await finalizeWorkFolderRemoval(workFolder.id, {
    async persistRegistry(registry) {
      if (registry.pendingRemovals.length === 0) {
        throw new Error("simulated final registry write failure");
      }
      await persistWorkFolderRegistryForTest(registry);
    },
  });
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, true);
  assert.equal(existsSync(workFolder.workFolderRoot), false);
  assert.equal((await listWorkFolders()).some((item) => item.id === workFolder.id), false);
  assert.equal((await listPendingWorkFolderRemovals())[0]?.workFolderId, workFolder.id);

  await mkdir(workFolder.workFolderRoot, { recursive: true });
  const replacementSentinel = join(workFolder.workFolderRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");
  const recovered = await finalizeWorkFolderRemoval(workFolder.id);
  assert.deepEqual(recovered, {
    removed: true,
    deleted: true,
    workFolderRoot: workFolder.workFolderRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

test("an unclaimed replacement folder or junction keeps managed removal pending", async () => {
  const workFolder = await createManagedWorkFolder("Removal replacement guard", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const originalAside = join(contentRoot, "approved-original-aside");
  await rename(workFolder.workFolderRoot, originalAside);
  await mkdir(workFolder.workFolderRoot, { recursive: false });
  const replacementSentinel = join(workFolder.workFolderRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");

  const refusedReplacement = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(refusedReplacement.cleanupPending, true);
  assert.equal(refusedReplacement.deleted, false);
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(workFolder.workFolderRoot, { recursive: true, force: true });
  const junctionTarget = join(sandbox, "unrelated-junction-target");
  const junctionSentinel = join(junctionTarget, "outside-managed-root.txt");
  await mkdir(junctionTarget, { recursive: true });
  await writeFile(junctionSentinel, "also do not delete", "utf8");
  await symlink(junctionTarget, workFolder.workFolderRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    (await listPendingWorkFolderRemovals())[0]?.workFolderId,
    workFolder.id,
    "a later link at the pending path must not make intent parsing inspect live content",
  );
  const refusedJunction = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(refusedJunction.cleanupPending, true);
  assert.equal(refusedJunction.deleted, false);
  assert.equal(await readFile(junctionSentinel, "utf8"), "also do not delete");

  await unlink(workFolder.workFolderRoot);
  await rm(junctionTarget, { recursive: true, force: true });
  await rename(originalAside, workFolder.workFolderRoot);
  const recovered = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

test("a root swap during the managed claim never deletes either directory", async () => {
  const workFolder = await createManagedWorkFolder("Removal claim swap", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const originalAside = join(contentRoot, "claim-swap-original-aside");
  let claimedReplacement = "";
  const pending = await finalizeWorkFolderRemoval(workFolder.id, {
    async claimManagedRoot(workFolderRoot, claimPath) {
      claimedReplacement = claimPath;
      await rename(workFolderRoot, originalAside);
      await mkdir(workFolderRoot, { recursive: false });
      await writeFile(join(workFolderRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(workFolderRoot, claimPath);
    },
  });

  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, false);
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");
  assert.equal(existsSync(claimedReplacement), false, "the mismatched claim is restored when the root name is still free");
  assert.equal(await readFile(join(workFolder.workFolderRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal((await listPendingWorkFolderRemovals())[0]?.managedRootClaimed, false);

  await rm(workFolder.workFolderRoot, { recursive: true, force: true });
  await rename(originalAside, workFolder.workFolderRoot);
  const recovered = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("recovery retries restoration of a mismatched managed claim", async () => {
  const workFolder = await createManagedWorkFolder("Removal claim restore retry", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  const originalAside = join(contentRoot, "claim-restore-original-aside");
  let claimPath = "";
  const first = await finalizeWorkFolderRemoval(workFolder.id, {
    async claimManagedRoot(workFolderRoot, destination) {
      claimPath = destination;
      await rename(workFolderRoot, originalAside);
      await mkdir(workFolderRoot, { recursive: false });
      await writeFile(join(workFolderRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(workFolderRoot, destination);
    },
    async restoreMismatchedManagedClaim() {
      throw new Error("simulated transient restore failure");
    },
  });
  assert.equal(first.cleanupPending, true);
  assert.equal(await readFile(join(claimPath, "replacement-sentinel.txt"), "utf8"), "replacement");

  const retry = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(retry.cleanupPending, true);
  assert.equal(retry.deleted, false);
  assert.equal(existsSync(claimPath), false);
  assert.equal(await readFile(join(workFolder.workFolderRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(workFolder.workFolderRoot, { recursive: true, force: true });
  await rename(originalAside, workFolder.workFolderRoot);
  const recovered = await finalizeWorkFolderRemoval(workFolder.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("a replacement created after the managed claim survives approved-folder deletion", async () => {
  const workFolder = await createManagedWorkFolder("Removal post-claim replacement", contentRoot);
  await writeFile(join(workFolder.workFolderRoot, "approved-original.txt"), "original", "utf8");
  await beginWorkFolderRemoval(workFolder.id, contentRoot);
  await markWorkFolderRemovalAppStateRemoved(workFolder.id);

  let claimPath = "";
  const replacementSentinel = join(workFolder.workFolderRoot, "replacement-sentinel.txt");
  const removed = await finalizeWorkFolderRemoval(workFolder.id, {
    async claimManagedRoot(workFolderRoot, destination) {
      claimPath = destination;
      await rename(workFolderRoot, destination);
      await mkdir(workFolderRoot, { recursive: false });
      await writeFile(replacementSentinel, "replacement", "utf8");
      await mkdir(join(workFolderRoot, ".work-fold"), { recursive: false });
      await writeFile(join(workFolderRoot, ".work-fold", "replacement-metadata.txt"), "replacement metadata", "utf8");
    },
  });

  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(claimPath), false, "only the identity-verified claim is recursively deleted");
  assert.equal(await readFile(replacementSentinel, "utf8"), "replacement");
  assert.equal(
    await readFile(join(workFolder.workFolderRoot, ".work-fold", "replacement-metadata.txt"), "utf8"),
    "replacement metadata",
    "external work-folder state cleanup must not touch a replacement folder's portable metadata",
  );
  assert.deepEqual(await listPendingWorkFolderRemovals(), []);
});

async function persistWorkFolderRegistryForTest(registry: WorkFolderRegistry): Promise<void> {
  await writeFile(workFolderRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

test("restore points live externally and can restore work-folder files", async () => {
  const workFolder = await createManagedWorkFolder("History Target", contentRoot);
  const file = join(workFolder.workFolderRoot, "draft.txt");
  await writeFile(file, "version one", "utf8");
  const checkpoint = await createWorkFolderCheckpoint(workFolder.workFolderRoot, { label: "Version one" });
  assert.equal(checkpoint.files.some((entry) => entry.path.startsWith(".work-fold/") || entry.path.startsWith(".workspace/")), false);
  assert.equal(checkpoint.directories.some((entry) => [".work-fold", ".workspace"].some((name) => entry === name || entry.startsWith(`${name}/`))), false);
  await writeFile(file, "version two", "utf8");

  const result = await restoreWorkFolderCheckpoint(workFolder.workFolderRoot, checkpoint.checkpointId);
  assert.equal(result.restored, true);
  assert.equal(await readFile(file, "utf8"), "version one");
  assert.equal(existsSync(join(workFolder.workFolderRoot, "history")), false);
});

test("the work-folder tree keeps a stable order under batched inspection and survives unreadable entries", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-tree-scan-"));
  t.after(async () => {
    await chmod(join(sandbox, "unreadable"), 0o755).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  // Wide enough to span several inspection batches.
  const names = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name) => writeFile(join(sandbox, name), name, "utf8")));
  await mkdir(join(sandbox, "zeta-folder"), { recursive: true });

  const tree = (await scanWorkFolderTree(sandbox, 2)).entries;
  assert.deepEqual(
    tree.map((entry) => entry.name),
    ["zeta-folder", ...names],
    "folders sort before files and batching does not disturb the order",
  );

  // A directory that can be listed but not traversed makes stat fail for every
  // child. That must degrade to an empty folder, not break the whole work-folder.
  await mkdir(join(sandbox, "unreadable"), { recursive: true });
  await writeFile(join(sandbox, "unreadable", "hidden.txt"), "x", "utf8");
  await chmod(join(sandbox, "unreadable"), 0o444);
  if ((await stat(join(sandbox, "unreadable", "hidden.txt")).catch(() => null)) !== null) {
    t.skip("filesystem does not enforce directory traversal permission");
    return;
  }

  const degraded = (await scanWorkFolderTree(sandbox, 2)).entries;
  const unreadable = degraded.find((entry) => entry.name === "unreadable");
  assert.equal(unreadable?.kind, "folder");
  assert.deepEqual(unreadable?.children, [], "children that cannot be inspected are skipped");
  assert.equal(degraded.filter((entry) => entry.kind === "file").length, names.length, "the rest of the work-folder still lists");
});

test("the work-folder tree stops at its entry budget and reports a partial listing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-tree-budget-"));
  const previous = process.env.WORKFOLD_TREE_MAX_ENTRIES;
  process.env.WORKFOLD_TREE_MAX_ENTRIES = "5";
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFOLD_TREE_MAX_ENTRIES;
    else process.env.WORKFOLD_TREE_MAX_ENTRIES = previous;
    await rm(sandbox, { recursive: true, force: true });
  });

  await mkdir(join(sandbox, "nested"), { recursive: true });
  await Promise.all([
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, `top-${index}.txt`), "x", "utf8")),
    ...Array.from({ length: 8 }, (_, index) => writeFile(join(sandbox, "nested", `deep-${index}.txt`), "x", "utf8")),
  ]);

  const capped = await scanWorkFolderTree(sandbox, 5);
  assert.equal(capped.truncated, true, "reaching the budget is disclosed rather than silently trimming");
  assert.ok(countTreeEntries(capped.entries) <= 5, `budget must bound total entries, saw ${countTreeEntries(capped.entries)}`);

  // The budget spans the whole walk, not each folder, so a deep work-folder cannot
  // multiply it by depth.
  process.env.WORKFOLD_TREE_MAX_ENTRIES = "1000";
  const whole = await scanWorkFolderTree(sandbox, 5);
  assert.equal(whole.truncated, false);
  assert.equal(countTreeEntries(whole.entries), 17, "8 top files + nested folder + 8 nested files");
});

test("the work-folder tree applies its budget to a stable visible ordering", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-folder-tree-visible-budget-"));
  const previous = process.env.WORKFOLD_TREE_MAX_ENTRIES;
  process.env.WORKFOLD_TREE_MAX_ENTRIES = "2";
  t.after(async () => {
    if (previous === undefined) delete process.env.WORKFOLD_TREE_MAX_ENTRIES;
    else process.env.WORKFOLD_TREE_MAX_ENTRIES = previous;
    await rm(sandbox, { recursive: true, force: true });
  });

  await Promise.all([
    writeFile(join(sandbox, "zulu.txt"), "z", "utf8"),
    writeFile(join(sandbox, "alpha.txt"), "a", "utf8"),
    writeFile(join(sandbox, "ignored-a.txt"), "i", "utf8"),
    writeFile(join(sandbox, "ignored-b.txt"), "i", "utf8"),
  ]);
  await setWorkFolderIgnoreState(sandbox, ["ignored-a.txt", "ignored-b.txt"], true);

  const capped = await scanWorkFolderTree(sandbox, 0, "", { includeIgnored: false });
  assert.deepEqual(capped.entries.map((entry) => entry.name), ["alpha.txt", "zulu.txt"]);
  assert.equal(capped.truncated, false, "ignored entries do not consume the visible entry budget");
});

test("parent file mutations respect nested ownership while allowing siblings and child-owned changes", async () => {
  const parent = await createManagedWorkFolder("Nested write boundaries", contentRoot);
  const childRoot = join(parent.workFolderRoot, "Group", "Child");
  await mkdir(childRoot, { recursive: true });
  await writeFile(join(childRoot, "note.txt"), "child original");
  await registerLinkedWorkFolder(childRoot);
  const childPath = "Group//./Child";

  await assert.rejects(writeWorkFolderTextFile(parent.workFolderRoot, `${childPath}/note.txt`, "parent overwrite"), /belongs to.*work-folder/);
  await assert.rejects(createWorkFolderTextFile(parent.workFolderRoot, childPath, "new.txt", "parent create"), /belongs to.*work-folder/);
  await assert.rejects(createWorkFolderFolder(parent.workFolderRoot, childPath, "new-folder"), /belongs to.*work-folder/);
  await assert.rejects(writeUploadedFiles(parent.workFolderRoot, childPath, [{ fileName: "upload.txt", data: Buffer.from("parent upload") }]), /belongs to.*work-folder/);
  await assert.rejects(writeUploadedFiles(parent.workFolderRoot, "", [
    { fileName: "first.txt", relativePath: "Preflight/first.txt", data: Buffer.from("first") },
    { fileName: "second.txt", relativePath: "Group/Child/new-directory/second.txt", data: Buffer.from("second") },
  ]), /belongs to.*work-folder/);
  assert.equal(existsSync(join(parent.workFolderRoot, "Preflight")), false, "a refused batch has no earlier writes or created directories");
  assert.equal(existsSync(join(childRoot, "new-directory")), false);

  const source = join(sandbox, "nested-copy-source", "Child");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "copy.txt"), "copied sibling");
  await assert.rejects(copyPathIntoWorkFolder(source, parent.workFolderRoot, childPath), /belongs to.*work-folder/);
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "child original");
  assert.equal(existsSync(join(childRoot, "new.txt")), false);
  assert.equal(existsSync(join(childRoot, "new-folder")), false);
  assert.equal(existsSync(join(childRoot, "upload.txt")), false);
  assert.equal(existsSync(join(childRoot, "Child")), false);

  await createWorkFolderFolder(parent.workFolderRoot, "Group", "Sibling");
  await createWorkFolderTextFile(parent.workFolderRoot, "Group/Sibling", "note.txt", "parent sibling");
  await writeWorkFolderTextFile(parent.workFolderRoot, "Group/Sibling/note.txt", "updated sibling");
  assert.equal(await readFile(join(parent.workFolderRoot, "Group", "Sibling", "note.txt"), "utf8"), "updated sibling");
  assert.deepEqual(await writeUploadedFiles(parent.workFolderRoot, "Group", [{ fileName: "Child", data: Buffer.from("collision sibling") }]), [
    { path: "Group/Child (2)", sizeBytes: 17 },
  ], "a colliding nested folder name can become an ordinary sibling file");
  assert.equal(await copyPathIntoWorkFolder(source, parent.workFolderRoot, "Group"), "Group/Child-2");
  assert.equal(await readFile(join(parent.workFolderRoot, "Group", "Child-2", "copy.txt"), "utf8"), "copied sibling");

  await writeWorkFolderTextFile(childRoot, "note.txt", "child update");
  await createWorkFolderTextFile(childRoot, "", "own.txt", "child create");
  await writeUploadedFiles(childRoot, "", [{ fileName: "own-upload.txt", data: Buffer.from("child upload") }]);
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "child update");
  assert.equal(await readFile(join(childRoot, "own.txt"), "utf8"), "child create");
  assert.equal(await readFile(join(childRoot, "own-upload.txt"), "utf8"), "child upload");
});

test("a pending managed deletion cannot gain a newly registered nested work-folder", async () => {
  const parent = await createManagedWorkFolder("Pending nested registration", contentRoot);
  const childRoot = join(parent.workFolderRoot, "Child");
  await mkdir(childRoot);
  await writeFile(join(childRoot, "note.txt"), "still present");
  await beginWorkFolderRemoval(parent.id, contentRoot);
  await assert.rejects(registerLinkedWorkFolder(childRoot), /still being removed/);
  assert.equal(existsSync(workFolderManifestFile(childRoot)), false, "the refused registration creates no portable identity");
  assert.equal(await readFile(join(childRoot, "note.txt"), "utf8"), "still present");
  await markWorkFolderRemovalAppStateRemoved(parent.id);
  assert.equal((await finalizeWorkFolderRemoval(parent.id)).cleanupPending, false);
});

function countTreeEntries(entries: Awaited<ReturnType<typeof scanWorkFolderTree>>["entries"]): number {
  return entries.reduce((total, entry) => total + 1 + countTreeEntries(entry.children ?? []), 0);
}
