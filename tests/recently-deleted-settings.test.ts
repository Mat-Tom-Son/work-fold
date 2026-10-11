import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

/**
 * Settings → Recently deleted over the running local API
 * (docs/receipts-not-gates.md, F20). A delete never refuses for lack of
 * coverage: the entry moves here and comes back on request. A deleted managed
 * work-folder's folder comes back with its portable identity, its Chats, and its
 * History. Retention is adjustable, "Delete Now" removes one item, and a tree
 * holding legacy `.workspace/` records is never erased — the clean-break rule.
 */

async function withApi(
  run: (context: { api: LocalApiHandle; sandbox: string; stateBase: string; workFolderBase: string }) => Promise<void>,
): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-recently-deleted-settings-test-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "content");
  const api = await startLocalApi({ port: 0, stateBase, workFolderBase, loadEnv: false });
  try {
    await run({ api, sandbox, stateBase, workFolderBase });
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} must answer 200`);
  return await response.json() as Record<string, unknown>;
}

async function send(
  origin: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(new URL(path, origin), {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function journalLines(stateBase: string): Promise<Array<Record<string, unknown>>> {
  const probe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
  return (await readFile(probe.path, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an uncoverable desktop delete lands in Recently deleted, restores, and leaves receipts", async () => {
  await withApi(async ({ api, stateBase }) => {
    const created = await api.actFacade.createWorkFolder({ name: "Delete work-folder" });
    const workFolder = created.workFolder;
    await mkdir(join(workFolder.workFolderRoot, "bulk"), { recursive: true });
    await writeFile(join(workFolder.workFolderRoot, "bulk", "big.bin"), "0123456789", "utf8");

    const listedEmpty = await getJson(api.origin, "/api/settings/recently-deleted");
    assert.deepEqual(listedEmpty.entries, []);
    assert.equal(listedEmpty.retentionDays, 30);

    // The desktop route always succeeds; the restore point covers what it can
    // and the whole entry moves to Recently deleted.
    process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "4";
    let deleted;
    try {
      deleted = await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "bulk" });
    } finally {
      delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
    }
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const recentlyDeleted = deleted.body.recentlyDeleted as { entryId: string; restoreBy: string; uncoveredCount: number };
    assert.ok(recentlyDeleted?.entryId);
    assert.equal(recentlyDeleted.uncoveredCount, 1);
    assert.equal(existsSync(join(workFolder.workFolderRoot, "bulk")), false);

    const listed = await getJson(api.origin, "/api/settings/recently-deleted");
    const entries = listed.entries as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, recentlyDeleted.entryId);
    assert.equal(entries[0]!.kind, "folder");
    assert.equal(entries[0]!.originalPath, "bulk");
    assert.equal(entries[0]!.name, "bulk");
    assert.equal(entries[0]!.workFolderName, "Delete work-folder");
    assert.equal(entries[0]!.restorable, "in-place");
    assert.deepEqual(entries[0]!.uncovered, [{ path: "bulk/big.bin", reason: "too_large" }]);

    const restored = await send(api.origin, `/api/settings/recently-deleted/${recentlyDeleted.entryId}/restore`, "POST", {});
    assert.equal(restored.status, 200);
    const effect = restored.body.restored as { kind: string; path: string; renamed: boolean };
    assert.equal(effect.kind, "folder");
    assert.equal(effect.path, "bulk");
    assert.equal(effect.renamed, false);
    assert.equal(await readFile(join(workFolder.workFolderRoot, "bulk", "big.bin"), "utf8"), "0123456789");
    assert.deepEqual((await getJson(api.origin, "/api/settings/recently-deleted")).entries, []);

    const journal = await journalLines(stateBase);
    const settingsActs = journal
      .filter((entry) => String(entry.requestId).startsWith("settings:"))
      .map((entry) => [entry.command, entry.outcome, entry.surface, entry.detail]);
    assert.deepEqual(settingsActs.map((entry) => [entry[0], entry[1]]), [
      ["files.delete", "accepted"],
      ["files.delete", "ok"],
      ["recently-deleted.restore", "accepted"],
      ["recently-deleted.restore", "ok"],
    ]);
    for (const entry of settingsActs) assert.equal(entry[2], "main-window");
    assert.equal(settingsActs[1]![3], `work-folder ${workFolder.id}; trash ${recentlyDeleted.entryId}`);
    assert.equal(settingsActs[3]![3], `entry ${recentlyDeleted.entryId}; kind folder`);
  });
});

test("a deleted managed work-folder's folder waits in Recently deleted and comes back with its identity and History", async () => {
  await withApi(async ({ api }) => {
    const created = await api.actFacade.createWorkFolder({ name: "Whole work-folder" });
    const workFolder = created.workFolder;
    await writeFile(join(workFolder.workFolderRoot, "keep.md"), "# keep\n", "utf8");
    const checkpoint = await api.actFacade.historySave({ workFolder: workFolder.id, label: "before deletion" });
    assert.ok(checkpoint.checkpoint.checkpointId);

    const removed = await send(api.origin, `/api/work-folders/${workFolder.id}`, "DELETE");
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    const recentlyDeleted = removed.body.recentlyDeleted as { entryId: string; restoreBy: string };
    assert.ok(recentlyDeleted?.entryId);
    assert.equal(existsSync(workFolder.workFolderRoot), false);

    const entries = (await getJson(api.origin, "/api/settings/recently-deleted")).entries as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.kind, "work-folder");
    assert.equal(entries[0]!.workFolderName, "Whole work-folder");
    assert.equal(entries[0]!.originalPath, workFolder.workFolderRoot);

    const restored = await send(api.origin, `/api/settings/recently-deleted/${recentlyDeleted.entryId}/restore`, "POST", {});
    assert.equal(restored.status, 200);
    const effect = restored.body.restored as { kind: string; workFolderRoot: string; workFolder: { id: string; name: string } };
    assert.equal(effect.kind, "work-folder");
    assert.equal(effect.workFolder.id, workFolder.id, "the portable identity comes back with the folder");
    assert.equal(effect.workFolder.name, "Whole work-folder");
    assert.equal(effect.workFolderRoot, workFolder.workFolderRoot);
    assert.equal(await readFile(join(workFolder.workFolderRoot, "keep.md"), "utf8"), "# keep\n");
    // The work-folder's machine-local History travelled with the folder.
    const history = await api.actFacade.historyList({ workFolder: workFolder.id });
    assert.ok(history.checkpoints.some((item) => item.checkpointId === checkpoint.checkpoint.checkpointId));
  });
});

test("retention is adjustable, Delete now removes one item, and legacy trees are never erased", async () => {
  await withApi(async ({ api }) => {
    const created = await api.actFacade.createWorkFolder({ name: "Retention work-folder" });
    const workFolder = created.workFolder;

    const outOfRange = await send(api.origin, "/api/settings/recently-deleted/retention", "PUT", { retentionDays: 400 });
    assert.equal(outOfRange.status, 400);
    assert.match(String(outOfRange.body.error), /between 1 and 365 days/);

    process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "1";
    let plain;
    let legacy;
    try {
      await writeFile(join(workFolder.workFolderRoot, "note.txt"), "plain", "utf8");
      plain = await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "note.txt" });
      // A folder carrying records from the earlier Workspace product may be
      // deleted, and moving it here is fine; erasing it never is.
      await mkdir(join(workFolder.workFolderRoot, "old", ".workspace"), { recursive: true });
      await writeFile(join(workFolder.workFolderRoot, "old", ".workspace", "legacy.json"), "{}", "utf8");
      await writeFile(join(workFolder.workFolderRoot, "old", "doc.txt"), "old", "utf8");
      legacy = await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "old" });
    } finally {
      delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
    }
    const plainId = (plain.body.recentlyDeleted as { entryId: string }).entryId;
    const legacyId = (legacy.body.recentlyDeleted as { entryId: string }).entryId;

    const narrowed = await send(api.origin, "/api/settings/recently-deleted/retention", "PUT", { retentionDays: 7 });
    assert.equal(narrowed.status, 200);
    assert.equal(narrowed.body.retentionDays, 7);
    const afterRetention = await getJson(api.origin, "/api/settings/recently-deleted");
    assert.equal(afterRetention.retentionDays, 7);
    for (const entry of afterRetention.entries as Array<Record<string, string>>) {
      const kept = Date.parse(entry.restoreBy!) - Date.parse(entry.deletedAt!);
      assert.equal(Math.round(kept / (24 * 60 * 60 * 1000)), 7, "a shorter window rewrites what is already waiting");
    }

    assert.deepEqual((await send(api.origin, `/api/settings/recently-deleted/${plainId}`, "DELETE")).body, { removed: true });
    const held = await send(api.origin, `/api/settings/recently-deleted/${legacyId}`, "DELETE");
    assert.equal(held.status, 409, "a legacy tree is never erased");
    assert.match(String(held.body.error), /earlier Workspace product/i);
    const remaining = (await getJson(api.origin, "/api/settings/recently-deleted")).entries as Array<Record<string, unknown>>;
    assert.deepEqual(remaining.map((entry) => entry.id), [legacyId]);
    assert.equal((remaining[0]!.held as { reason: string }).reason, "legacy-metadata");
  });
});

test("an item whose work-folder is no longer registered says so instead of offering a restore", async () => {
  await withApi(async ({ api }) => {
    const created = await api.actFacade.createWorkFolder({ name: "Going Away" });
    const workFolder = created.workFolder;
    process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "1";
    let deleted;
    try {
      await writeFile(join(workFolder.workFolderRoot, "note.txt"), "orphan", "utf8");
      deleted = await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "note.txt" });
    } finally {
      delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
    }
    const entryId = (deleted.body.recentlyDeleted as { entryId: string }).entryId;

    // Unregistering keeps the folder but takes the work-folder out of the registry,
    // so there is no work-folder to put the item back into. work-fold never guesses
    // another one.
    await api.actFacade.workFoldersUnregister({ workFolder: workFolder.id });
    const entries = (await getJson(api.origin, "/api/settings/recently-deleted")).entries as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.id, entryId);
    assert.equal(entries[0]!.restorable, "blocked");
    assert.equal(entries[0]!.note, "The work-folder this came from is no longer registered.");

    const refused = await send(api.origin, `/api/settings/recently-deleted/${entryId}/restore`, "POST", {});
    assert.equal(refused.status, 409);
    assert.match(String(refused.body.error), /no longer registered/);
    assert.equal(((await getJson(api.origin, "/api/settings/recently-deleted")).entries as unknown[]).length, 1);
  });
});

test("retention purge runs at startup and keeps what has not expired", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-recently-deleted-purge-test-"));
  const stateBase = join(sandbox, "state");
  const workFolderBase = join(sandbox, "content");
  let api = await startLocalApi({ port: 0, stateBase, workFolderBase, loadEnv: false });
  let expiredId: string;
  let freshId: string;
  try {
    const created = await api.actFacade.createWorkFolder({ name: "Purge work-folder" });
    const workFolder = created.workFolder;
    process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "1";
    try {
      await writeFile(join(workFolder.workFolderRoot, "expired.txt"), "gone", "utf8");
      await writeFile(join(workFolder.workFolderRoot, "fresh.txt"), "stays", "utf8");
      expiredId = ((await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "expired.txt" }))
        .body.recentlyDeleted as { entryId: string }).entryId;
      freshId = ((await send(api.origin, `/api/work-folders/${workFolder.id}/local-file`, "DELETE", { path: "fresh.txt" }))
        .body.recentlyDeleted as { entryId: string }).entryId;
    } finally {
      delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
    }
    // Backdate one entry's keep-until date the way a month of waiting would.
    const manifestPath = join(stateBase, "recently-deleted", "entries", expiredId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.restoreBy = "2020-01-01T00:00:00.000Z";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  } finally {
    await api.close();
  }

  api = await startLocalApi({ port: 0, stateBase, workFolderBase, loadEnv: false });
  try {
    const entries = (await getJson(api.origin, "/api/settings/recently-deleted")).entries as Array<Record<string, unknown>>;
    assert.deepEqual(entries.map((entry) => entry.id), [freshId], "startup removes only what its time ran out on");
    assert.equal(existsSync(join(stateBase, "recently-deleted", "entries", expiredId)), false);
  } finally {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
