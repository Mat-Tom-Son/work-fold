import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDataNamespaceId, parseFeatureInstallationId, parseRuntimeInstanceId, parseTenantId } from "../src/local/agent/app-platform-contract.js";
import {
  FileRestrictedAppStorage,
  validateRestrictedAppDataBackup,
  type RestrictedAppDataBackup,
  type RestrictedAppStorageOwner,
} from "../src/local/agent/restricted-app-storage.js";
import {
  WORKFOLD_TRASH_DEFAULT_RETENTION_DAYS,
  WorkFoldTrashError,
  WorkFoldTrashStore,
  workFoldTrashEntryIdPattern,
  type WorkFoldTrashAppDataIdentity,
  type WorkFoldTrashManifest,
  type WorkFoldTrashStoreOptions,
} from "../src/local/trash-store.js";
import { configureWorkFoldStateRoot, workFoldStateRoot, workFoldTrashRoot } from "../src/local/state-paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function sandbox(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-trash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function openStore(root: string, options: Partial<WorkFoldTrashStoreOptions> = {}): Promise<WorkFoldTrashStore> {
  return await WorkFoldTrashStore.open({ rootPath: join(root, "trash"), ...options });
}

async function readManifest(entryPath: string): Promise<WorkFoldTrashManifest> {
  return JSON.parse(await readFile(join(entryPath, "manifest.json"), "utf8")) as WorkFoldTrashManifest;
}

async function writeManifest(entryPath: string, manifest: unknown): Promise<void> {
  await writeFile(join(entryPath, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2));
}

function exdevError(): NodeJS.ErrnoException {
  return Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
}

async function rejectsTrashError(promise: Promise<unknown>, code: WorkFoldTrashError["code"], pattern?: RegExp): Promise<WorkFoldTrashError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WorkFoldTrashError, `expected a WorkFoldTrashError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

const appOwner: RestrictedAppStorageOwner = {
  ownerClass: "instance",
  tenantId: parseTenantId("tenant_test"),
  runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_test"),
  featureInstallationId: parseFeatureInstallationId("feature-installation_test"),
  dataNamespaceId: parseDataNamespaceId("data-namespace_test"),
};
const appDigest = "a".repeat(64);
const appIdentity: WorkFoldTrashAppDataIdentity = {
  kind: "app-data",
  appId: "quotes",
  appDigest,
  featureInstallationId: appOwner.featureInstallationId,
  runtimeInstanceId: appOwner.runtimeInstanceId,
  dataNamespaceId: appOwner.dataNamespaceId,
  sourceSpaceId: "space_source",
  projectId: "project_quotes",
  releaseDigest: null,
};

async function exportedBackup(root: string): Promise<RestrictedAppDataBackup> {
  const storage = new FileRestrictedAppStorage(join(root, "app-storage"));
  await storage.set(appOwner, "record", { count: 3 });
  await storage.set(appOwner, "title", "Quotes");
  return await storage.exportData(appOwner, "quotes", appDigest);
}

test("workFoldTrashRoot lives under the state root", () => {
  configureWorkFoldStateRoot("/tmp/work-fold-trash-state-root");
  try {
    assert.equal(workFoldTrashRoot(), join(workFoldStateRoot(), "trash"));
  } finally {
    configureWorkFoldStateRoot(undefined);
  }
});

test("open creates the layout with default retention, keeps it across reopen, and bounds retention changes", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  assert.equal(store.retentionDays(), WORKFOLD_TRASH_DEFAULT_RETENTION_DAYS);
  assert.equal(store.lastPurgeAt(), null);
  for (const child of ["entries", "incoming", "settings.json"]) assert.ok(existsSync(join(store.rootPath, child)), child);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.rootPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(store.rootPath, "settings.json"))).mode & 0o777, 0o600);
  }

  await store.setRetentionDays(45);
  const reopened = await openStore(root);
  assert.equal(reopened.retentionDays(), 45);

  await rejectsTrashError(reopened.setRetentionDays(400), "INPUT_INVALID", /between 1 and 365/);
  await rejectsTrashError(reopened.setRetentionDays(0), "INPUT_INVALID");
  await rejectsTrashError(reopened.setRetentionDays(7.5), "INPUT_INVALID");
  await rejectsTrashError(WorkFoldTrashStore.open({ rootPath: join(root, "other"), defaultRetentionDays: 0 }), "INPUT_INVALID");

  // The retention change rewrites every complete manifest's restoreBy.
  const space = join(root, "space");
  await mkdir(space, { recursive: true });
  await writeFile(join(space, "note.txt"), "keep me");
  const entry = await reopened.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "note.txt"), spaceId: "space-1", originalPath: "note.txt", receiptId: null,
  });
  assert.equal(Date.parse(entry.restoreBy) - Date.parse(entry.deletedAt), 45 * DAY_MS);
  await reopened.setRetentionDays(7);
  const rewritten = await readManifest(entry.entryPath);
  assert.equal(Date.parse(rewritten.restoreBy) - Date.parse(rewritten.deletedAt), 7 * DAY_MS);
  assert.equal((await reopened.list()).retentionDays, 7);

  await writeFile(join(store.rootPath, "settings.json"), "{ not json");
  await rejectsTrashError(openStore(root), "STORE_DAMAGED", /not valid JSON/);
});

test("trashTree moves a file with a complete manifest, size, receipt, and uncovered reasons", async (t) => {
  const root = await sandbox(t);
  const now = new Date("2026-09-10T12:00:00.000Z");
  const store = await openStore(root, { now: () => now });
  const space = join(root, "space");
  await mkdir(join(space, "docs"), { recursive: true });
  const source = join(space, "docs", "big.bin");
  await writeFile(source, Buffer.alloc(1234, 7));

  const entry = await store.trashTree({
    kind: "file",
    reason: "files.delete",
    sourcePath: source,
    spaceId: "space-1",
    spaceName: "Fold Space",
    originalPath: "docs/big.bin",
    receiptId: "act_request_1",
    uncovered: [{ path: "docs/big.bin", reason: "too_large" }],
  });

  assert.match(entry.id, workFoldTrashEntryIdPattern);
  assert.ok(entry.id.startsWith("trash-20260910120000-"));
  assert.equal(existsSync(source), false);
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "big.bin"));
  assert.deepEqual(await readFile(entry.payloadPath), Buffer.alloc(1234, 7));
  assert.equal(entry.complete, true);
  assert.equal(entry.kind, "file");
  assert.equal(entry.sizeBytes, 1234);
  assert.equal(entry.sizeApproximate, undefined);
  assert.equal(entry.receiptId, "act_request_1");
  assert.equal(entry.originalPath, "docs/big.bin");
  assert.equal(entry.spaceName, "Fold Space");
  assert.deepEqual(entry.uncovered, [{ path: "docs/big.bin", reason: "too_large" }]);
  assert.deepEqual(entry.payload, { kind: "tree", name: "big.bin" });
  assert.equal(entry.deletedAt, now.toISOString());
  assert.equal(entry.restoreBy, new Date(now.getTime() + 30 * DAY_MS).toISOString());

  const onDisk = await readManifest(entry.entryPath);
  assert.equal(onDisk.complete, true);
  assert.equal(onDisk.sizeBytes, 1234);
  assert.deepEqual(await store.get(entry.id), entry);

  // Kind must match what is on disk, and nothing moves when it does not.
  await mkdir(join(space, "folder"));
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "folder"), spaceId: "space-1", originalPath: "folder", receiptId: null,
  }), "INPUT_INVALID", /is a folder/);
  assert.ok(existsSync(join(space, "folder")));
  await rejectsTrashError(store.trashTree({
    kind: "folder", reason: "files.delete", sourcePath: join(space, "missing"), spaceId: "space-1", originalPath: "missing", receiptId: null,
  }), "MOVE_FAILED", /Nothing was moved/);
  assert.equal((await store.list()).entries.length, 1);
});

test("trashTree moves a folder verbatim: links stay links and unreadable files arrive byte for byte", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const space = join(root, "space");
  const folder = join(space, "bulk");
  await mkdir(join(folder, "nested"), { recursive: true });
  await writeFile(join(folder, "target.txt"), "target");
  await writeFile(join(folder, "nested", "deep.txt"), "deep");
  await symlink("target.txt", join(folder, "link"));
  await symlink("/nowhere/dangling", join(folder, "dangling"));
  const locked = join(folder, "locked.txt");
  await writeFile(locked, "secret bytes");
  const restrictable = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  if (restrictable) await chmod(locked, 0o000);

  const entry = await store.trashTree({
    kind: "folder",
    reason: "files.delete",
    sourcePath: folder,
    spaceId: "space-1",
    originalPath: "bulk",
    receiptId: "act_request_2",
    uncovered: [{ path: "bulk/link", reason: "symbolic_link" }, { path: "bulk/locked.txt", reason: "unreadable" }],
  });

  assert.equal(existsSync(folder), false);
  assert.equal(entry.kind, "folder");
  const link = join(entry.payloadPath, "link");
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readlink(link), "target.txt");
  assert.ok((await lstat(join(entry.payloadPath, "dangling"))).isSymbolicLink());
  assert.equal(await readFile(join(entry.payloadPath, "nested", "deep.txt"), "utf8"), "deep");
  const movedLocked = join(entry.payloadPath, "locked.txt");
  if (restrictable) {
    assert.equal((await stat(movedLocked)).mode & 0o777, 0o000);
    await chmod(movedLocked, 0o600);
  }
  assert.equal(await readFile(movedLocked, "utf8"), "secret bytes");
  assert.equal(entry.sizeApproximate, undefined);
  assert.equal(entry.sizeBytes, "target".length + "deep".length + "secret bytes".length + "target.txt".length + "/nowhere/dangling".length);
});

test("a cross-device move copies through incoming/, releases the source, and commits the manifest", async (t) => {
  const root = await sandbox(t);
  let thrown = false;
  const renames: Array<[string, string]> = [];
  const store = await openStore(root, {
    io: {
      async rename(from, to) {
        renames.push([from, to]);
        if (!thrown) {
          thrown = true;
          throw exdevError();
        }
        await rename(from, to);
      },
    },
  });
  const space = join(root, "space");
  const folder = join(space, "drafts");
  await mkdir(join(folder, "inner"), { recursive: true });
  await writeFile(join(folder, "a.txt"), "alpha");
  await writeFile(join(folder, "inner", "b.txt"), "beta");
  await symlink("a.txt", join(folder, "alias"));

  const entry = await store.trashTree({
    kind: "folder", reason: "files.delete", sourcePath: folder, spaceId: "space-1", originalPath: "drafts", receiptId: null,
  });

  assert.equal(thrown, true);
  assert.equal(existsSync(folder), false);
  assert.equal(await readFile(join(entry.payloadPath, "a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(join(entry.payloadPath, "inner", "b.txt"), "utf8"), "beta");
  assert.ok((await lstat(join(entry.payloadPath, "alias"))).isSymbolicLink());
  assert.equal(await readlink(join(entry.payloadPath, "alias")), "a.txt");
  assert.equal(entry.complete, true);
  assert.equal(entry.sizeBytes, "alpha".length + "beta".length + "a.txt".length);
  assert.equal((await readManifest(entry.entryPath)).complete, true);
  assert.deepEqual(await readdir(join(store.rootPath, "incoming")), []);
  assert.ok(renames.some(([from, to]) => from.includes(join("incoming")) && to === entry.payloadPath), "the staged copy was renamed into place");
});

test("a move that fails before landing leaves the source untouched and no entry behind", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root, {
    io: {
      async rename() {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    },
  });
  const space = join(root, "space");
  await mkdir(space, { recursive: true });
  await writeFile(join(space, "note.txt"), "still here");

  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "note.txt"), spaceId: "space-1", originalPath: "note.txt", receiptId: null,
  }), "MOVE_FAILED", /could not move .* into Recently deleted: EPERM.*Nothing was moved/);

  assert.equal(await readFile(join(space, "note.txt"), "utf8"), "still here");
  assert.deepEqual(await readdir(join(store.rootPath, "entries")), []);
  const listing = await store.list();
  assert.deepEqual(listing.entries, []);
  assert.deepEqual(listing.damaged, []);
});

test("listing tolerates crashes and corruption without discarding content", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const space = join(root, "space");
  await mkdir(space, { recursive: true });
  const entriesDir = join(store.rootPath, "entries");

  // (a) the move landed but the commit never happened
  await writeFile(join(space, "landed.txt"), "landed bytes");
  const landed = await store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "landed.txt"), spaceId: "space-1", originalPath: "landed.txt", receiptId: null,
  });
  await writeManifest(landed.entryPath, { ...(await readManifest(landed.entryPath)), complete: false, sizeBytes: 0 });

  // (b) a manifest whose content never arrived
  const orphanId = "trash-20260101000000-0badc0de";
  await mkdir(join(entriesDir, orphanId, "payload"), { recursive: true });
  await writeManifest(join(entriesDir, orphanId), { ...(await readManifest(landed.entryPath)), id: orphanId, complete: false, sizeBytes: 0 });

  // (c) garbage JSON
  const garbageId = "trash-20260101000001-0badc0de";
  await mkdir(join(entriesDir, garbageId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, garbageId, "payload", "x.txt"), "x");
  await writeManifest(join(entriesDir, garbageId), "{ definitely not json");

  // a manifest with an unknown field, and one whose id does not match its directory
  const strangeId = "trash-20260101000002-0badc0de";
  await mkdir(join(entriesDir, strangeId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, strangeId, "payload", "landed.txt"), "x");
  await writeManifest(join(entriesDir, strangeId), { ...(await readManifest(landed.entryPath)), id: strangeId, extra: true });
  const mismatchId = "trash-20260101000003-0badc0de";
  await mkdir(join(entriesDir, mismatchId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, mismatchId, "payload", "landed.txt"), "x");
  await writeManifest(join(entriesDir, mismatchId), { ...(await readManifest(landed.entryPath)), id: landed.id });

  // (d) incoming debris, pure debris, and a payload with no manifest
  await mkdir(join(store.rootPath, "incoming", "stale-copy"), { recursive: true });
  await writeFile(join(store.rootPath, "incoming", "stale-copy", "part.bin"), "partial");
  const debrisId = "trash-20260101000004-0badc0de";
  await mkdir(join(entriesDir, debrisId), { recursive: true });
  await writeFile(join(entriesDir, "stray-file"), "junk");
  const manifestlessId = "trash-20260101000005-0badc0de";
  await mkdir(join(entriesDir, manifestlessId, "payload"), { recursive: true });
  await writeFile(join(entriesDir, manifestlessId, "payload", "precious.txt"), "precious");
  await mkdir(join(entriesDir, "not-an-id", "payload"), { recursive: true });
  await writeFile(join(entriesDir, "not-an-id", "payload", "also.txt"), "also");

  const reopened = await openStore(root);
  assert.equal(existsSync(join(store.rootPath, "incoming", "stale-copy")), false);
  assert.equal(existsSync(join(entriesDir, debrisId)), false);
  assert.equal(existsSync(join(entriesDir, "stray-file")), false);
  assert.ok(existsSync(join(entriesDir, manifestlessId, "payload", "precious.txt")));
  assert.ok(existsSync(join(entriesDir, garbageId, "payload", "x.txt")));

  const listing = await reopened.list();
  assert.deepEqual(listing.entries.map((entry) => entry.id), [landed.id]);
  assert.equal(listing.entries[0]!.complete, true);
  assert.equal(listing.entries[0]!.sizeBytes, "landed bytes".length);
  assert.equal((await readManifest(landed.entryPath)).complete, true, "the missed commit was repaired on disk");
  const damaged = new Map(listing.damaged.map((record) => [record.id, record.error]));
  assert.deepEqual([...damaged.keys()].sort(), [garbageId, manifestlessId, mismatchId, "not-an-id", orphanId, strangeId].sort());
  assert.match(damaged.get(orphanId)!, /never arrived/);
  assert.match(damaged.get(garbageId)!, /not a valid record/);
  assert.match(damaged.get(strangeId)!, /unknown field extra/);
  assert.match(damaged.get(mismatchId)!, /names .* instead of/);
  assert.match(damaged.get(manifestlessId)!, /manifest\.json is missing/);
  await rejectsTrashError(reopened.get(garbageId), "STORE_DAMAGED");
  assert.equal(await reopened.get("trash-20991231235959-ffffffff"), null);
});

test("restoreTree puts a tree back, collision-renames, and removes the entry", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const space = join(root, "space");
  await mkdir(join(space, "docs"), { recursive: true });
  await writeFile(join(space, "docs", "report.txt"), "v1");
  const file = await store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "docs", "report.txt"), spaceId: "space-1", originalPath: "docs/report.txt", receiptId: null,
  });

  // The original path is free again: restored in place, parent recreated when needed.
  await rm(join(space, "docs"), { recursive: true, force: true });
  const back = await store.restoreTree(file.id, { absolutePath: join(space, "docs", "report.txt") });
  assert.deepEqual(back, { restoredPath: join(space, "docs", "report.txt"), renamed: false });
  assert.equal(await readFile(join(space, "docs", "report.txt"), "utf8"), "v1");
  assert.equal(existsSync(file.entryPath), false);
  assert.deepEqual((await store.list()).entries, []);
  await rejectsTrashError(store.restoreTree(file.id, { absolutePath: join(space, "docs", "report.txt") }), "NOT_FOUND", /Nothing in Recently deleted/);

  // An occupied file path renames like space.ts: `stem (2).ext`.
  await writeFile(join(space, "docs", "notes.md"), "older");
  const notes = await store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "docs", "notes.md"), spaceId: "space-1", originalPath: "docs/notes.md", receiptId: null,
  });
  await writeFile(join(space, "docs", "notes.md"), "newer");
  await writeFile(join(space, "docs", "notes (2).md"), "also taken");
  const renamedFile = await store.restoreTree(notes.id, { absolutePath: join(space, "docs", "notes.md") });
  assert.deepEqual(renamedFile, { restoredPath: join(space, "docs", "notes (3).md"), renamed: true });
  assert.equal(await readFile(join(space, "docs", "notes (3).md"), "utf8"), "older");
  assert.equal(await readFile(join(space, "docs", "notes.md"), "utf8"), "newer");

  // An occupied folder path renames `name-2`.
  await mkdir(join(space, "drafts"));
  await writeFile(join(space, "drafts", "one.txt"), "one");
  const drafts = await store.trashTree({
    kind: "folder", reason: "files.delete", sourcePath: join(space, "drafts"), spaceId: "space-1", originalPath: "drafts", receiptId: null,
  });
  await mkdir(join(space, "drafts"));
  const renamedFolder = await store.restoreTree(drafts.id, { absolutePath: join(space, "drafts") });
  assert.deepEqual(renamedFolder, { restoredPath: join(space, "drafts-2"), renamed: true });
  assert.equal(await readFile(join(space, "drafts-2", "one.txt"), "utf8"), "one");

  // App data cannot be restored as a tree; relative destinations are refused before anything moves.
  const app = await store.trashAppData({
    kind: "app-storage", reason: "apps.storage.clear", backup: await exportedBackup(root), identity: appIdentity, spaceId: "space-1", receiptId: null,
  });
  await rejectsTrashError(store.restoreTree(app.id, { absolutePath: join(space, "app.json") }), "INPUT_INVALID", /app data/);
  await rejectsTrashError(store.restoreTree(app.id, { absolutePath: "relative/path" }), "INPUT_INVALID", /absolute path/);
});

test("a failing restore leaves the entry intact", async (t) => {
  const root = await sandbox(t);
  const space = join(root, "space");
  await mkdir(space, { recursive: true });
  await writeFile(join(space, "keep.txt"), "kept");
  let failRestores = false;
  const store = await openStore(root, {
    io: {
      async rename(from, to) {
        if (failRestores) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        await rename(from, to);
      },
    },
  });
  const entry = await store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(space, "keep.txt"), spaceId: "space-1", originalPath: "keep.txt", receiptId: null,
  });
  failRestores = true;
  const error = await rejectsTrashError(store.restoreTree(entry.id, { absolutePath: join(space, "keep.txt") }), "MOVE_FAILED", /still in Recently deleted/);
  assert.equal(error.entryId, entry.id);
  assert.equal(existsSync(join(space, "keep.txt")), false);
  assert.equal(await readFile(entry.payloadPath, "utf8"), "kept");
  assert.deepEqual((await store.list()).entries.map((item) => item.id), [entry.id]);
  failRestores = false;
  await store.restoreTree(entry.id, { absolutePath: join(space, "keep.txt") });
  assert.equal(await readFile(join(space, "keep.txt"), "utf8"), "kept");
});

test("app data round-trips through the trash and every integrity failure is named", async (t) => {
  const root = await sandbox(t);
  // The listing orders by deleted-at, so two entries kept in the same second
  // are deliberately not ordered against each other; the clock moves here to
  // assert the order the store does promise.
  let now = new Date("2026-09-10T08:30:00.000Z");
  const store = await openStore(root, { now: () => now });
  const backup = await exportedBackup(root);

  const entry = await store.trashAppData({
    kind: "app-storage",
    reason: "apps.storage.clear",
    backup: JSON.parse(JSON.stringify(backup)) as RestrictedAppDataBackup,
    identity: appIdentity,
    spaceId: "space-1",
    spaceName: "Fold Space",
    receiptId: "settings:11111111-2222-4333-8444-555555555555",
  });
  assert.equal(entry.kind, "app-storage");
  assert.equal(entry.originalPath, `quotes/${appOwner.dataNamespaceId}`);
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "app-data.json"));
  assert.deepEqual(entry.payload, appIdentity);
  assert.equal(entry.sizeBytes, (await stat(entry.payloadPath)).size);
  assert.ok(entry.sizeBytes > 0);
  assert.equal(entry.complete, true);
  assert.equal(entry.receiptId, "settings:11111111-2222-4333-8444-555555555555");

  const read = await store.readAppData(entry.id);
  assert.deepEqual(read, backup);
  assert.deepEqual(validateRestrictedAppDataBackup(read, appOwner, "quotes", appDigest), backup);

  // Tampered content on disk is STORE_DAMAGED on read; the entry is still listed.
  const tampered = structuredClone(backup);
  tampered.data.entries[0]!.value = { count: 99 };
  await writeFile(entry.payloadPath, JSON.stringify(tampered));
  await rejectsTrashError(store.readAppData(entry.id), "STORE_DAMAGED", /integrity/);
  await writeFile(entry.payloadPath, "not json");
  await rejectsTrashError(store.readAppData(entry.id), "STORE_DAMAGED", /cannot be read/);
  assert.equal((await store.list()).entries.length, 1);

  // A backup whose hash, app, or installation identity does not match is refused before anything is written.
  const badHash = { ...backup, sha256: "0".repeat(64) };
  await rejectsTrashError(store.trashAppData({
    kind: "app-storage", reason: "apps.storage.clear", backup: badHash, identity: appIdentity, spaceId: "space-1", receiptId: null,
  }), "INPUT_INVALID", /cannot be kept/);
  await rejectsTrashError(store.trashAppData({
    kind: "app-storage", reason: "apps.storage.clear", backup, identity: { ...appIdentity, appDigest: "b".repeat(64) }, spaceId: "space-1", receiptId: null,
  }), "INPUT_INVALID", /different app/);
  await rejectsTrashError(store.trashAppData({
    kind: "app-storage", reason: "apps.storage.clear", backup, identity: { ...appIdentity, dataNamespaceId: "data-namespace_other" }, spaceId: "space-1", receiptId: null,
  }), "INPUT_INVALID");
  await rejectsTrashError(store.trashAppData({
    kind: "app-retained", reason: "apps.retained.purge", backup, identity: appIdentity, spaceId: "space-1", receiptId: null,
  }), "INPUT_INVALID", /retained-data id/);
  assert.equal((await store.list()).entries.length, 1);

  now = new Date("2026-09-10T08:30:05.000Z");
  const retained = await store.trashAppData({
    kind: "app-retained", reason: "apps.uninstall.purge", backup, identity: { ...appIdentity, retainedDataId: "retained-data_1" }, spaceId: "space-1", receiptId: null,
  });
  assert.equal(retained.kind, "app-retained");
  assert.equal(retained.payload.kind === "app-data" ? retained.payload.retainedDataId : null, "retained-data_1");
  await rejectsTrashError(store.readAppData("trash-20991231235959-ffffffff"), "NOT_FOUND");
  assert.deepEqual((await store.list()).entries.map((item) => item.id), [retained.id, entry.id], "newest first");
});

test("retention purge erases only expired entries, holds legacy trees, and runs once per interval", async (t) => {
  const root = await sandbox(t);
  let clock = new Date("2026-09-10T00:00:00.000Z");
  const store = await openStore(root, { now: () => clock });
  const space = join(root, "space");
  await mkdir(join(space, "legacy", ".workspace"), { recursive: true });
  await writeFile(join(space, "legacy", ".workspace", "legacy.json"), "{}");
  await writeFile(join(space, "legacy", "work.txt"), "work");
  await writeFile(join(space, "old.txt"), "old");
  await writeFile(join(space, "new.txt"), "new");

  const legacy = await store.trashTree({ kind: "folder", reason: "files.delete", sourcePath: join(space, "legacy"), spaceId: "space-1", originalPath: "legacy", receiptId: null });
  const old = await store.trashTree({ kind: "file", reason: "files.delete", sourcePath: join(space, "old.txt"), spaceId: "space-1", originalPath: "old.txt", receiptId: null });
  clock = new Date(clock.getTime() + 10 * DAY_MS);
  const fresh = await store.trashTree({ kind: "file", reason: "files.delete", sourcePath: join(space, "new.txt"), spaceId: "space-1", originalPath: "new.txt", receiptId: null });

  clock = new Date(Date.parse(old.restoreBy) + 1000);
  const first = await store.purgeExpiredIfDue();
  assert.ok(first);
  assert.deepEqual(first, { purged: [old.id], held: [legacy.id], failed: [] });
  assert.equal(existsSync(old.entryPath), false);
  assert.ok(existsSync(join(legacy.payloadPath, ".workspace", "legacy.json")));
  assert.ok(existsSync(fresh.entryPath));
  assert.equal(store.lastPurgeAt(), clock.toISOString());
  const heldManifest = await readManifest(legacy.entryPath);
  assert.equal(heldManifest.held?.reason, "legacy-metadata");
  assert.equal(heldManifest.held?.noticedAt, clock.toISOString());

  const heldError = await rejectsTrashError(store.remove(legacy.id), "HELD", /earlier Workspace product/);
  assert.equal(heldError.entryId, legacy.id);
  assert.ok(existsSync(join(legacy.payloadPath, "work.txt")));

  // Not due again until a day has passed, even across a reopen.
  clock = new Date(clock.getTime() + 60 * 60 * 1000);
  assert.equal(await store.purgeExpiredIfDue(), null);
  const reopened = await openStore(root, { now: () => clock });
  assert.equal(await reopened.purgeExpiredIfDue(), null);
  clock = new Date(Date.parse(fresh.restoreBy) + DAY_MS);
  const second = await reopened.purgeExpiredIfDue();
  assert.deepEqual(second, { purged: [fresh.id], held: [legacy.id], failed: [] });
  assert.deepEqual((await reopened.list()).entries.map((item) => item.id), [legacy.id]);

  // "Delete now" also fails closed on a legacy tree that no purge has looked at yet.
  await mkdir(join(space, "again", ".WORKSPACE"), { recursive: true });
  const again = await reopened.trashTree({ kind: "folder", reason: "files.delete", sourcePath: join(space, "again"), spaceId: "space-1", originalPath: "again", receiptId: null });
  if (process.platform === "win32") {
    await rejectsTrashError(reopened.remove(again.id), "HELD");
  } else {
    assert.deepEqual(await reopened.remove(again.id), { removed: true });
  }
  await writeFile(join(space, "plain.txt"), "plain");
  const plain = await reopened.trashTree({ kind: "file", reason: "files.delete", sourcePath: join(space, "plain.txt"), spaceId: "space-1", originalPath: "plain.txt", receiptId: null });
  assert.deepEqual(await reopened.remove(plain.id), { removed: true });
  assert.equal(existsSync(plain.entryPath), false);
  assert.deepEqual(await reopened.remove(plain.id), { removed: false });
  await rejectsTrashError(reopened.purgeExpiredIfDue(-1), "INPUT_INVALID");
});

test("a Space folder travels with its History state and both come back", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const managed = join(root, "managed");
  const claim = join(managed, ".space-removal-1234");
  await mkdir(join(claim, ".work-fold"), { recursive: true });
  await writeFile(join(claim, ".work-fold", "space.json"), JSON.stringify({ version: 1, id: "space_abc", name: "Fold Space" }));
  await writeFile(join(claim, "notes.txt"), "notes");
  const stateDir = join(root, "state", "spaces", "fold-space-abc");
  await mkdir(join(stateDir, "history"), { recursive: true });
  await writeFile(join(stateDir, "history", "cp-1.json"), "{}");

  const entry = await store.trashTree({
    kind: "space",
    reason: "spaces.delete",
    sourcePath: claim,
    spaceId: "space_abc",
    spaceName: "Fold Space",
    originalPath: join(managed, "Fold Space"),
    receiptId: "act_request_9",
    stateDirPath: stateDir,
  });
  assert.equal(entry.kind, "space");
  assert.equal(entry.stateDir, true);
  assert.equal(entry.payloadPath, join(entry.entryPath, "payload", "Fold Space"));
  assert.equal(existsSync(claim), false);
  assert.equal(existsSync(stateDir), false);
  assert.equal(await readFile(join(entry.entryPath, "state", "history", "cp-1.json"), "utf8"), "{}");
  assert.equal(await readFile(join(entry.payloadPath, ".work-fold", "space.json"), "utf8"), JSON.stringify({ version: 1, id: "space_abc", name: "Fold Space" }));

  // The state destination is required for a Space entry that carries state, and must be free.
  await rejectsTrashError(store.restoreTree(entry.id, { absolutePath: join(managed, "Fold Space") }), "INPUT_INVALID", /History state/);
  await mkdir(stateDir, { recursive: true });
  await rejectsTrashError(store.restoreTree(entry.id, { absolutePath: join(managed, "Fold Space"), stateDirPath: stateDir }), "MOVE_FAILED", /already exists/);
  await rm(stateDir, { recursive: true, force: true });
  assert.ok(existsSync(entry.payloadPath));

  const seen: string[] = [];
  const restored = await store.restoreTree(entry.id, {
    absolutePath: join(managed, "Fold Space"),
    stateDirFor: (finalPath) => {
      seen.push(finalPath);
      return join(root, "state", "spaces", `restored-${finalPath.endsWith("Fold Space") ? "same" : "renamed"}`);
    },
  });
  assert.deepEqual(seen, [join(managed, "Fold Space")]);
  assert.deepEqual(restored, {
    restoredPath: join(managed, "Fold Space"),
    renamed: false,
    stateDirMovedTo: join(root, "state", "spaces", "restored-same"),
  });
  assert.equal(await readFile(join(managed, "Fold Space", "notes.txt"), "utf8"), "notes");
  assert.equal(await readFile(join(root, "state", "spaces", "restored-same", "history", "cp-1.json"), "utf8"), "{}");
  assert.equal(existsSync(entry.entryPath), false);

  // A missing state dir at trash time is fine: the entry simply carries none, and stateDirPath moves plainly.
  const claim2 = join(managed, ".space-removal-5678");
  await mkdir(claim2, { recursive: true });
  const plain = await store.trashTree({
    kind: "space", reason: "spaces.delete", sourcePath: claim2, spaceId: "space_def", originalPath: join(managed, "Other"), receiptId: null, stateDirPath: join(root, "state", "spaces", "missing"),
  });
  assert.equal(plain.stateDir, undefined);
  await mkdir(join(managed, "Other"));
  const back = await store.restoreTree(plain.id, { absolutePath: join(managed, "Other"), stateDirPath: join(root, "state", "spaces", "unused") });
  assert.deepEqual(back, { restoredPath: join(managed, "Other-2"), renamed: true });
  await rejectsTrashError(store.trashTree({
    kind: "folder", reason: "files.delete", sourcePath: join(managed, "Other-2"), spaceId: "space_def", originalPath: "Other-2", receiptId: null, stateDirPath: stateDir,
  }), "INPUT_INVALID", /Only a Space folder/);
});

test("entry ids are validated before any path is touched", async (t) => {
  const root = await sandbox(t);
  const store = await openStore(root);
  const bad = ["../x", "trash-20260910120000-abcdef01/../..", "", "trash-2026-abc", "TRASH-20260910120000-ABCDEF01", "trash-20260910120000-abcdef01\n"];
  for (const id of bad) {
    await rejectsTrashError(store.get(id), "INPUT_INVALID", /look like trash-/);
    await rejectsTrashError(store.restoreTree(id, { absolutePath: join(root, "x") }), "INPUT_INVALID");
    await rejectsTrashError(store.readAppData(id), "INPUT_INVALID");
    await rejectsTrashError(store.remove(id), "INPUT_INVALID");
  }
  assert.equal(existsSync(join(root, "x")), false);
  assert.deepEqual(await readdir(join(store.rootPath, "entries")), []);
  assert.ok(workFoldTrashEntryIdPattern.test("trash-20260910120000-abcdef01"));

  // Inputs are validated with the same care: reasons, ids, and paths.
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.destroy" as never, sourcePath: join(root, "x"), spaceId: "space-1", originalPath: "x", receiptId: null,
  }), "INPUT_INVALID");
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: "relative.txt", spaceId: "space-1", originalPath: "relative.txt", receiptId: null,
  }), "INPUT_INVALID", /absolute path/);
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), spaceId: " ", originalPath: "x", receiptId: null,
  }), "INPUT_INVALID");
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), spaceId: "space-1", originalPath: "..", receiptId: null,
  }), "INPUT_INVALID", /file or folder name/);
  await rejectsTrashError(store.trashTree({
    kind: "file", reason: "files.delete", sourcePath: join(root, "x"), spaceId: "space-1", originalPath: "x", receiptId: null, uncovered: [{ path: "x", reason: "gone" as never }],
  }), "INPUT_INVALID");
});
