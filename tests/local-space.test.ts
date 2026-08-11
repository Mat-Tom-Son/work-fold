import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { createSpaceCheckpoint, restoreSpaceCheckpoint } from "../src/local/history.js";
import { copyResourcesToSpace, listResourceTree, uploadResourceFiles } from "../src/local/resources.js";
import {
  configureWorkFoldStateRoot,
  resourceLibraryRoot,
  spaceManifestFile,
  spaceRegistryFile,
} from "../src/local/state-paths.js";
import {
  beginSpaceRemoval,
  createManagedSpace,
  finalizeSpaceRemoval,
  listSpaces,
  listPendingSpaceRemovals,
  markSpaceRemovalAppStateRemoved,
  readSpaceTextFile,
  renameSpace,
  registerLinkedSpace,
  resolveSpacePath,
  scanSpaceTree,
  type SpaceRegistry,
  writeUploadedFiles,
  writeSpaceTextFile,
} from "../src/local/space.js";
import { setSpaceIgnoreState } from "../src/local/space-ignore.js";

let sandbox = "";
let stateRoot = "";
let contentRoot = "";

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "space-local-test-"));
  stateRoot = join(sandbox, "state");
  contentRoot = join(sandbox, "content");
  configureWorkFoldStateRoot(stateRoot);
});

after(async () => {
  configureWorkFoldStateRoot(undefined);
  await rm(sandbox, { recursive: true, force: true });
});

test("managed Spaces keep portable identity metadata inside a hidden .work-fold folder", async () => {
  const space = await createManagedSpace("Personal Space", contentRoot);
  const initialManifest = JSON.parse(await readFile(spaceManifestFile(space.spaceRoot), "utf8")) as Record<string, unknown>;
  initialManifest.futurePortableField = { retained: true };
  await writeFile(spaceManifestFile(space.spaceRoot), `${JSON.stringify(initialManifest, null, 2)}\n`, "utf8");
  const uploaded = await writeUploadedFiles(space.spaceRoot, "", [{
    fileName: "notes.txt",
    relativePath: "Notes/notes.txt",
    data: Buffer.from("hello space\n"),
  }]);

  assert.equal(uploaded[0]?.path, "Notes/notes.txt");
  assert.equal((await readSpaceTextFile(space.spaceRoot, "Notes/notes.txt")).text, "hello space\n");
  assert.equal((await scanSpaceTree(space.spaceRoot)).entries[0]?.name, "Notes");
  const currentSpace = (await listSpaces()).find((item) => item.id === space.id);
  assert.ok(currentSpace);
  assert.equal(existsSync(spaceManifestFile(space.spaceRoot)), true);
  assert.deepEqual(JSON.parse(await readFile(spaceManifestFile(space.spaceRoot), "utf8")), {
    version: 1,
    id: currentSpace.id,
    name: currentSpace.name,
    createdAt: currentSpace.createdAt,
    updatedAt: currentSpace.updatedAt,
    futurePortableField: { retained: true },
  });
  assert.equal((await listSpaces()).length, 1);
  assert.throws(() => resolveSpacePath(space.spaceRoot, "../outside.txt"), /escapes/);
  for (const reserved of [".work-fold", ".WORK-FOLD", ".workspace", ".WORKSPACE", ".pi", ".PI"]) {
    assert.throws(
      () => resolveSpacePath(space.spaceRoot, `ordinary/${reserved}/secret.txt`),
      /reserved/i,
      `${reserved} stays outside ordinary Space file APIs`,
    );
  }
});

test("linked Google Drive folders keep portable metadata hidden from Files", async () => {
  const linkedRoot = join(sandbox, "Google Drive", "My Drive", "Project");
  await mkdir(linkedRoot, { recursive: true });
  await mkdir(join(linkedRoot, ".pi", "skills"), { recursive: true });
  await writeFile(join(linkedRoot, ".pi", "skills", "private.md"), "hidden capability", "utf8");
  await mkdir(join(linkedRoot, ".workspace", "conversations"), { recursive: true });
  await writeFile(join(linkedRoot, ".workspace", "space.json"), "legacy identity", "utf8");
  await writeFile(join(linkedRoot, ".workspace", "conversations", "old.jsonl"), "legacy chat", "utf8");
  const existingFile = join(linkedRoot, "existing.txt");
  await writeFile(existingFile, "original", "utf8");
  const space = await registerLinkedSpace(linkedRoot);
  assert.equal(space.spaceRoot, linkedRoot);
  assert.equal(space.location.storage, "linked");
  assert.equal(space.location.providerHint, "google-drive");
  assert.equal(await readFile(existingFile, "utf8"), "original");
  assert.equal(existsSync(spaceManifestFile(linkedRoot)), true);
  assert.equal((await scanSpaceTree(linkedRoot)).entries[0]?.path, "existing.txt");
  assert.equal(await readFile(join(linkedRoot, ".workspace", "space.json"), "utf8"), "legacy identity");
});

test("a moved linked folder preserves its manifest identity when it is relinked", async () => {
  const originalRoot = join(sandbox, "portable-space-original");
  const movedRoot = join(sandbox, "portable-space-moved");
  await mkdir(originalRoot, { recursive: true });
  const original = await registerLinkedSpace(originalRoot);
  await rename(originalRoot, movedRoot);

  const relinked = await registerLinkedSpace(movedRoot);
  assert.equal(relinked.id, original.id);
  assert.equal(relinked.name, original.name);
  assert.equal(relinked.spaceRoot, movedRoot);
  assert.equal((await listSpaces()).filter((space) => space.id === original.id).length, 1);

  const duplicateRoot = join(sandbox, "portable-space-copy");
  await mkdir(join(duplicateRoot, ".work-fold"), { recursive: true });
  await writeFile(spaceManifestFile(duplicateRoot), await readFile(spaceManifestFile(movedRoot), "utf8"), "utf8");
  await assert.rejects(registerLinkedSpace(duplicateRoot), /identity is already linked to another folder/);
});

test("legacy external manifests remain inert and are not imported", async () => {
  const linkedRoot = join(sandbox, "legacy-manifest-space");
  await mkdir(linkedRoot, { recursive: true });
  const legacyFile = join(linkedRoot, ".workspace", "space.json");
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

  const space = await registerLinkedSpace(linkedRoot);
  assert.notEqual(space.id, legacyManifest.id);
  assert.notEqual(space.name, legacyManifest.name);
  assert.equal(existsSync(legacyFile), true);
  assert.equal(existsSync(spaceManifestFile(linkedRoot)), true);
});

test("Space listing survives when portable metadata can no longer be maintained", async () => {
  const linkedRoot = join(sandbox, "metadata-became-unwritable");
  await mkdir(linkedRoot, { recursive: true });
  const space = await registerLinkedSpace(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "temporarily blocked", "utf8");

  assert.equal((await listSpaces()).some((item) => item.id === space.id), true);
});

test("blocked portable metadata does not leave a failed linked registration in the registry", async () => {
  const linkedRoot = join(sandbox, "blocked-registration-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedSpace(linkedRoot));
  assert.equal((await listSpaces()).some((item) => item.spaceRoot === linkedRoot), false);
});

test("failed portable writes do not apply a Space rename", async () => {
  const linkedRoot = join(sandbox, "blocked-rename-metadata");
  await mkdir(linkedRoot, { recursive: true });
  const space = await registerLinkedSpace(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(renameSpace(space.id, "Failed rename"));
  const current = (await listSpaces()).find((item) => item.id === space.id);
  assert.equal(current?.name, space.name);
  assert.equal(current?.updatedAt, space.updatedAt);
});

test("failed portable writes do not rebind a moved Space identity", async () => {
  const originalRoot = join(sandbox, "blocked-rebind-original");
  const movedRoot = join(sandbox, "blocked-rebind-moved");
  await mkdir(originalRoot, { recursive: true });
  const space = await registerLinkedSpace(originalRoot);
  const portableManifest = await readFile(spaceManifestFile(originalRoot), "utf8");
  await rename(originalRoot, movedRoot);
  await rm(join(movedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(movedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await assert.rejects(registerLinkedSpace(movedRoot));
  await rm(join(movedRoot, ".work-fold"), { force: true });
  await mkdir(join(movedRoot, ".work-fold"), { recursive: true });
  await writeFile(spaceManifestFile(movedRoot), portableManifest, "utf8");
  await rename(movedRoot, originalRoot);
  const current = (await listSpaces()).find((item) => item.id === space.id);
  assert.equal(current?.spaceRoot, originalRoot);
});

test("a content edit succeeds when post-mutation portable metadata maintenance is blocked", async () => {
  const linkedRoot = join(sandbox, "blocked-touch-metadata");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(join(linkedRoot, "draft.txt"), "before", "utf8");
  const space = await registerLinkedSpace(linkedRoot);
  await rm(join(linkedRoot, ".work-fold"), { recursive: true, force: true });
  await writeFile(join(linkedRoot, ".work-fold"), "blocks the metadata directory", "utf8");

  await writeSpaceTextFile(linkedRoot, "draft.txt", "after");
  assert.equal(await readFile(join(linkedRoot, "draft.txt"), "utf8"), "after");
  const current = (await listSpaces()).find((item) => item.id === space.id);
  assert.equal(current?.updatedAt, space.updatedAt);
});

test("linked folders cannot overlap Space application state", async () => {
  await mkdir(stateRoot, { recursive: true });
  await assert.rejects(registerLinkedSpace(stateRoot), /cannot contain, or be contained by/);
  await assert.rejects(registerLinkedSpace(sandbox), /cannot contain, or be contained by/);
  await assert.rejects(createSpaceCheckpoint(sandbox), /does not contain work-fold application data/);
});

test("managed Space removal refuses a mismatched managed-content boundary", async () => {
  const space = await createManagedSpace("Removal guard", contentRoot);
  await assert.rejects(beginSpaceRemoval(space.id, join(sandbox, "different-managed-root")), /only delete a managed Space/);
  assert.equal(existsSync(space.spaceRoot), true);
});

test("a removal-intent persistence failure leaves the Space and managed folder untouched", async () => {
  const space = await createManagedSpace("Removal intent failure", contentRoot);
  await writeFile(join(space.spaceRoot, "keep.txt"), "keep", "utf8");

  await assert.rejects(beginSpaceRemoval(space.id, contentRoot, {
    async persistRegistry() {
      throw new Error("simulated registry write failure");
    },
  }), /simulated registry write failure/);

  assert.equal((await listSpaces()).some((item) => item.id === space.id), true);
  assert.equal(await readFile(join(space.spaceRoot, "keep.txt"), "utf8"), "keep");
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

test("managed-folder cleanup failure leaves a hidden, recoverable removal intent", async () => {
  const space = await createManagedSpace("Removal cleanup retry", contentRoot);
  await writeFile(join(space.spaceRoot, "retry.txt"), "retry", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const pending = await finalizeSpaceRemoval(space.id, {
    async claimManagedRoot() {
      throw new Error("simulated managed-folder lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    spaceRoot: space.spaceRoot,
    cleanupPending: true,
  });
  assert.equal((await listSpaces()).some((item) => item.id === space.id), false);
  assert.equal(await readFile(join(space.spaceRoot, "retry.txt"), "utf8"), "retry");
  assert.equal((await listPendingSpaceRemovals())[0]?.phase, "app-state-removed");

  const recovered = await finalizeSpaceRemoval(space.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.equal(existsSync(space.spaceRoot), false);
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

test("a preserve-disposition removal unregisters a managed Space while its folder provably survives", async () => {
  const space = await createManagedSpace("Managed keep-folder", contentRoot);
  await writeFile(join(space.spaceRoot, "keep.md"), "still here", "utf8");

  const intent = await beginSpaceRemoval(space.id, contentRoot, {}, { folderDisposition: "preserve" });
  assert.equal(intent.folderDisposition, "preserve");
  assert.equal(intent.storage, "managed");
  assert.equal(intent.managedBase, null, "a preserve intent records no managed-content boundary");
  assert.equal(intent.managedRootIdentity, null, "a preserve intent holds no deletion identity");

  // The durable intent round-trips the strict registry read, and an
  // in-flight preserve intent cannot be converted into a deletion.
  assert.equal((await listPendingSpaceRemovals())[0]?.folderDisposition, "preserve");
  await assert.rejects(beginSpaceRemoval(space.id, contentRoot), /different folder disposition/);

  await markSpaceRemovalAppStateRemoved(space.id);
  // A crash between app-state cleanup and registry finalization keeps the
  // preserve semantics: the pending result never claims a deletion.
  const pending = await finalizeSpaceRemoval(space.id, {
    async removeSpaceState() {
      throw new Error("simulated app-state lock");
    },
  });
  assert.deepEqual(pending, {
    removed: true,
    deleted: false,
    spaceRoot: space.spaceRoot,
    cleanupPending: true,
  });

  const removed = await finalizeSpaceRemoval(space.id, {
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
    spaceRoot: space.spaceRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(join(space.spaceRoot, "keep.md"), "utf8"), "still here");
  assert.equal(existsSync(spaceManifestFile(space.spaceRoot)), true, "the portable identity persists");
  assert.deepEqual(await listPendingSpaceRemovals(), []);
  assert.equal((await listSpaces()).some((item) => item.id === space.id), false);

  // The preserved folder registers again with the same portable identity.
  const reRegistered = await registerLinkedSpace(space.spaceRoot);
  assert.equal(reRegistered.id, space.id, "re-registration restores the persisted identity");
});

test("a preserve marker is valid only on a managed intent that holds no deletion authority", async () => {
  const space = await createManagedSpace("Preserve marker rules", contentRoot);
  await beginSpaceRemoval(space.id, contentRoot, {}, { folderDisposition: "preserve" });
  const registryText = await readFile(spaceRegistryFile(), "utf8");
  const poison = (mutate: (intent: Record<string, unknown>) => void) => {
    const registry = JSON.parse(registryText) as { pendingRemovals: Array<Record<string, unknown>> };
    mutate(registry.pendingRemovals[0]!);
    return writeFile(spaceRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  };

  // A preserve intent that somehow gained deletion authority is refused by
  // the strict registry read: the shape itself is the proof.
  await poison((intent) => { intent.managedRootClaimed = true; });
  await assert.rejects(listPendingSpaceRemovals(), /could not be read safely/);

  await poison((intent) => { intent.folderDisposition = "delete"; });
  await assert.rejects(listPendingSpaceRemovals(), /could not be read safely/);

  // Restore the valid preserve intent and complete the removal so later
  // tests see a clean registry.
  await writeFile(spaceRegistryFile(), registryText, "utf8");
  await markSpaceRemovalAppStateRemoved(space.id);
  const removed = await finalizeSpaceRemoval(space.id);
  assert.equal(removed.deleted, false);
  assert.equal(existsSync(space.spaceRoot), true);
});

test("a durable claim hint cannot finalize while the approved root still exists", async () => {
  const space = await createManagedSpace("Removal claim replay", contentRoot);
  await writeFile(join(space.spaceRoot, "approved-original.txt"), "original", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const registry = JSON.parse(await readFile(spaceRegistryFile(), "utf8")) as {
    pendingRemovals: Array<{ managedRootClaimed: boolean }>;
  };
  registry.pendingRemovals[0]!.managedRootClaimed = true;
  await writeFile(spaceRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");

  const removed = await finalizeSpaceRemoval(space.id);
  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(space.spaceRoot), false,
    "recovery must reclaim and delete the exact root instead of trusting the progress hint");
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

test("a final registry-write failure remains idempotently recoverable after managed content is gone", async () => {
  const space = await createManagedSpace("Removal registry retry", contentRoot);
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const pending = await finalizeSpaceRemoval(space.id, {
    async persistRegistry(registry) {
      if (registry.pendingRemovals.length === 0) {
        throw new Error("simulated final registry write failure");
      }
      await persistSpaceRegistryForTest(registry);
    },
  });
  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, true);
  assert.equal(existsSync(space.spaceRoot), false);
  assert.equal((await listSpaces()).some((item) => item.id === space.id), false);
  assert.equal((await listPendingSpaceRemovals())[0]?.spaceId, space.id);

  await mkdir(space.spaceRoot, { recursive: true });
  const replacementSentinel = join(space.spaceRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");
  const recovered = await finalizeSpaceRemoval(space.id);
  assert.deepEqual(recovered, {
    removed: true,
    deleted: true,
    spaceRoot: space.spaceRoot,
    cleanupPending: false,
  });
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

test("an unclaimed replacement folder or junction keeps managed removal pending", async () => {
  const space = await createManagedSpace("Removal replacement guard", contentRoot);
  await writeFile(join(space.spaceRoot, "approved-original.txt"), "original", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const originalAside = join(contentRoot, "approved-original-aside");
  await rename(space.spaceRoot, originalAside);
  await mkdir(space.spaceRoot, { recursive: false });
  const replacementSentinel = join(space.spaceRoot, "unrelated-replacement.txt");
  await writeFile(replacementSentinel, "do not delete", "utf8");

  const refusedReplacement = await finalizeSpaceRemoval(space.id);
  assert.equal(refusedReplacement.cleanupPending, true);
  assert.equal(refusedReplacement.deleted, false);
  assert.equal(await readFile(replacementSentinel, "utf8"), "do not delete");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(space.spaceRoot, { recursive: true, force: true });
  const junctionTarget = join(sandbox, "unrelated-junction-target");
  const junctionSentinel = join(junctionTarget, "outside-managed-root.txt");
  await mkdir(junctionTarget, { recursive: true });
  await writeFile(junctionSentinel, "also do not delete", "utf8");
  await symlink(junctionTarget, space.spaceRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    (await listPendingSpaceRemovals())[0]?.spaceId,
    space.id,
    "a later link at the pending path must not make intent parsing inspect live content",
  );
  const refusedJunction = await finalizeSpaceRemoval(space.id);
  assert.equal(refusedJunction.cleanupPending, true);
  assert.equal(refusedJunction.deleted, false);
  assert.equal(await readFile(junctionSentinel, "utf8"), "also do not delete");

  await unlink(space.spaceRoot);
  await rm(junctionTarget, { recursive: true, force: true });
  await rename(originalAside, space.spaceRoot);
  const recovered = await finalizeSpaceRemoval(space.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

test("a root swap during the managed claim never deletes either directory", async () => {
  const space = await createManagedSpace("Removal claim swap", contentRoot);
  await writeFile(join(space.spaceRoot, "approved-original.txt"), "original", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const originalAside = join(contentRoot, "claim-swap-original-aside");
  let claimedReplacement = "";
  const pending = await finalizeSpaceRemoval(space.id, {
    async claimManagedRoot(spaceRoot, claimPath) {
      claimedReplacement = claimPath;
      await rename(spaceRoot, originalAside);
      await mkdir(spaceRoot, { recursive: false });
      await writeFile(join(spaceRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(spaceRoot, claimPath);
    },
  });

  assert.equal(pending.cleanupPending, true);
  assert.equal(pending.deleted, false);
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");
  assert.equal(existsSync(claimedReplacement), false, "the mismatched claim is restored when the root name is still free");
  assert.equal(await readFile(join(space.spaceRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal((await listPendingSpaceRemovals())[0]?.managedRootClaimed, false);

  await rm(space.spaceRoot, { recursive: true, force: true });
  await rename(originalAside, space.spaceRoot);
  const recovered = await finalizeSpaceRemoval(space.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("recovery retries restoration of a mismatched managed claim", async () => {
  const space = await createManagedSpace("Removal claim restore retry", contentRoot);
  await writeFile(join(space.spaceRoot, "approved-original.txt"), "original", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  const originalAside = join(contentRoot, "claim-restore-original-aside");
  let claimPath = "";
  const first = await finalizeSpaceRemoval(space.id, {
    async claimManagedRoot(spaceRoot, destination) {
      claimPath = destination;
      await rename(spaceRoot, originalAside);
      await mkdir(spaceRoot, { recursive: false });
      await writeFile(join(spaceRoot, "replacement-sentinel.txt"), "replacement", "utf8");
      await rename(spaceRoot, destination);
    },
    async restoreMismatchedManagedClaim() {
      throw new Error("simulated transient restore failure");
    },
  });
  assert.equal(first.cleanupPending, true);
  assert.equal(await readFile(join(claimPath, "replacement-sentinel.txt"), "utf8"), "replacement");

  const retry = await finalizeSpaceRemoval(space.id);
  assert.equal(retry.cleanupPending, true);
  assert.equal(retry.deleted, false);
  assert.equal(existsSync(claimPath), false);
  assert.equal(await readFile(join(space.spaceRoot, "replacement-sentinel.txt"), "utf8"), "replacement");
  assert.equal(await readFile(join(originalAside, "approved-original.txt"), "utf8"), "original");

  await rm(space.spaceRoot, { recursive: true, force: true });
  await rename(originalAside, space.spaceRoot);
  const recovered = await finalizeSpaceRemoval(space.id);
  assert.equal(recovered.cleanupPending, false);
  assert.equal(recovered.deleted, true);
});

test("a replacement created after the managed claim survives approved-folder deletion", async () => {
  const space = await createManagedSpace("Removal post-claim replacement", contentRoot);
  await writeFile(join(space.spaceRoot, "approved-original.txt"), "original", "utf8");
  await beginSpaceRemoval(space.id, contentRoot);
  await markSpaceRemovalAppStateRemoved(space.id);

  let claimPath = "";
  const replacementSentinel = join(space.spaceRoot, "replacement-sentinel.txt");
  const removed = await finalizeSpaceRemoval(space.id, {
    async claimManagedRoot(spaceRoot, destination) {
      claimPath = destination;
      await rename(spaceRoot, destination);
      await mkdir(spaceRoot, { recursive: false });
      await writeFile(replacementSentinel, "replacement", "utf8");
      await mkdir(join(spaceRoot, ".work-fold"), { recursive: false });
      await writeFile(join(spaceRoot, ".work-fold", "replacement-metadata.txt"), "replacement metadata", "utf8");
    },
  });

  assert.equal(removed.cleanupPending, false);
  assert.equal(removed.deleted, true);
  assert.equal(existsSync(claimPath), false, "only the identity-verified claim is recursively deleted");
  assert.equal(await readFile(replacementSentinel, "utf8"), "replacement");
  assert.equal(
    await readFile(join(space.spaceRoot, ".work-fold", "replacement-metadata.txt"), "utf8"),
    "replacement metadata",
    "external Space state cleanup must not touch a replacement folder's portable metadata",
  );
  assert.deepEqual(await listPendingSpaceRemovals(), []);
});

async function persistSpaceRegistryForTest(registry: SpaceRegistry): Promise<void> {
  await writeFile(spaceRegistryFile(), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

test("Library items copy into a visible From Library folder", async () => {
  assert.equal(resourceLibraryRoot(), join(stateRoot, "resources"));
  const space = await createManagedSpace("Library Target", contentRoot);
  await uploadResourceFiles("", [{ fileName: "template.md", data: Buffer.from("# Template\n") }]);
  assert.equal((await listResourceTree())[0]?.path, "template.md");
  const copied = await copyResourcesToSpace(space.spaceRoot, ["template.md"], "From Library");
  assert.deepEqual(copied, ["From Library/template.md"]);
  assert.equal(await readFile(join(space.spaceRoot, "From Library", "template.md"), "utf8"), "# Template\n");
});

test("restore points live externally and can restore space files", async () => {
  const space = await createManagedSpace("History Target", contentRoot);
  const file = join(space.spaceRoot, "draft.txt");
  await writeFile(file, "version one", "utf8");
  const checkpoint = await createSpaceCheckpoint(space.spaceRoot, { label: "Version one" });
  assert.equal(checkpoint.files.some((entry) => entry.path.startsWith(".work-fold/") || entry.path.startsWith(".workspace/")), false);
  assert.equal(checkpoint.directories.some((entry) => [".work-fold", ".workspace"].some((name) => entry === name || entry.startsWith(`${name}/`))), false);
  await writeFile(file, "version two", "utf8");

  const result = await restoreSpaceCheckpoint(space.spaceRoot, checkpoint.checkpointId);
  assert.equal(result.restored, true);
  assert.equal(await readFile(file, "utf8"), "version one");
  assert.equal(existsSync(join(space.spaceRoot, "history")), false);
});

test("the Space tree keeps a stable order under batched inspection and survives unreadable entries", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space-tree-scan-"));
  t.after(async () => {
    await chmod(join(sandbox, "unreadable"), 0o755).catch(() => undefined);
    await rm(sandbox, { recursive: true, force: true });
  });

  // Wide enough to span several inspection batches.
  const names = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
  await Promise.all(names.map((name) => writeFile(join(sandbox, name), name, "utf8")));
  await mkdir(join(sandbox, "zeta-folder"), { recursive: true });

  const tree = (await scanSpaceTree(sandbox, 2)).entries;
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

  const degraded = (await scanSpaceTree(sandbox, 2)).entries;
  const unreadable = degraded.find((entry) => entry.name === "unreadable");
  assert.equal(unreadable?.kind, "folder");
  assert.deepEqual(unreadable?.children, [], "children that cannot be inspected are skipped");
  assert.equal(degraded.filter((entry) => entry.kind === "file").length, names.length, "the rest of the Space still lists");
});

test("the Space tree stops at its entry budget and reports a partial listing", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space-tree-budget-"));
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

  const capped = await scanSpaceTree(sandbox, 5);
  assert.equal(capped.truncated, true, "reaching the budget is disclosed rather than silently trimming");
  assert.ok(countTreeEntries(capped.entries) <= 5, `budget must bound total entries, saw ${countTreeEntries(capped.entries)}`);

  // The budget spans the whole walk, not each folder, so a deep Space cannot
  // multiply it by depth.
  process.env.WORKFOLD_TREE_MAX_ENTRIES = "1000";
  const whole = await scanSpaceTree(sandbox, 5);
  assert.equal(whole.truncated, false);
  assert.equal(countTreeEntries(whole.entries), 17, "8 top files + nested folder + 8 nested files");
});

test("the Space tree applies its budget to a stable visible ordering", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "space-tree-visible-budget-"));
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
  await setSpaceIgnoreState(sandbox, ["ignored-a.txt", "ignored-b.txt"], true);

  const capped = await scanSpaceTree(sandbox, 0, "", { includeIgnored: false });
  assert.deepEqual(capped.entries.map((entry) => entry.name), ["alpha.txt", "zulu.txt"]);
  assert.equal(capped.truncated, false, "ignored entries do not consume the visible entry budget");
});

function countTreeEntries(entries: Awaited<ReturnType<typeof scanSpaceTree>>["entries"]): number {
  return entries.reduce((total, entry) => total + 1 + countTreeEntries(entry.children ?? []), 0);
}
