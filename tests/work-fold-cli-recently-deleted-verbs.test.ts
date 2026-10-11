import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
} from "../src/local/cli/index.js";
import type { WorkFoldCliActReceiptV3 } from "../src/local/cli/act-receipts.js";
import { startLocalApi, type LocalApiHandle } from "../src/local/server.js";

const token = "a".repeat(64);

type ReceiptEntry = Omit<WorkFoldCliActReceiptV3, "v" | "at">;

/**
 * `recently-deleted list` and `recently-deleted restore` end to end through the installed act lane
 * (docs/receipts-not-gates.md, F20): argv → executor → the real facade inside
 * startLocalApi → the store. A delete History could not fully keep a copy of
 * is listed here, comes back on request, and the receipt's undo reference is
 * the item itself. Recently deleted sits above work-folders, so neither verb takes
 * `--work-folder`, and nothing empties it.
 */
async function recentlyDeletedHarness(prefix: string): Promise<{
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  execute: (argv: string[]) => ReturnType<typeof executeWorkFoldCliActRequest>;
  lastOk: () => ReceiptEntry;
  close: () => Promise<void>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-recently-deleted-verbs-${prefix}-`));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  const records: ReceiptEntry[] = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveWorkFoldAgentLineageParent(taskId),
      receipts: {
        hasAccepted: async () => false,
        append: async (record) => {
          records.push(structuredClone(record));
          return true;
        },
      },
    },
  );
  return {
    sandbox,
    api,
    records,
    execute,
    lastOk: () => records.filter((record) => record.outcome === "ok").at(-1)!,
    close: async () => {
      await api.close();
      await rm(sandbox, { recursive: true, force: true });
    },
  };
}

function errorCodeOf(stderr: string): string | undefined {
  try {
    return (JSON.parse(stderr) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/** Deletes `path` with History's file bound lowered, so the entry must move. */
async function deleteUncoverable(
  h: { execute: (argv: string[]) => ReturnType<typeof executeWorkFoldCliActRequest> },
  workFolderId: string,
  path: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "1";
  try {
    return await h.execute(["files", "delete", "--work-folder", workFolderId, "--path", path, "--json"]);
  } finally {
    delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
  }
}

test("files delete reports the Recently deleted item, and recently-deleted list and restore bring a file back", async () => {
  const h = await recentlyDeletedHarness("files");
  try {
    const created = await h.api.actFacade.createWorkFolder({ name: "Fold work-folder" });
    const workFolder = created.workFolder;
    await writeFile(join(workFolder.workFolderRoot, "ledger.csv"), "a,b\n1,2\n", "utf8");

    const emptyList = await h.execute(["recently-deleted", "list", "--json"]);
    assert.equal(emptyList.exitCode, 0, emptyList.stderr);
    const emptyJson = JSON.parse(emptyList.stdout) as { data: { entries: unknown[]; retentionDays: number; damagedCount: number } };
    assert.deepEqual(emptyJson.data.entries, []);
    assert.equal(emptyJson.data.retentionDays, 30);
    assert.equal(emptyJson.data.damagedCount, 0);

    h.records.length = 0;
    const deleted = await deleteUncoverable(h, workFolder.id, "ledger.csv");
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    const deletedJson = JSON.parse(deleted.stdout) as {
      data: {
        deleted: boolean;
        kind: string;
        safetyCheckpointId: string;
        recovery: { kind: string; entryId: string; restoreBy: string; uncovered: Array<{ path: string; reason: string }> };
      };
    };
    assert.equal(deletedJson.data.deleted, true, "a delete History cannot fully cover still goes through");
    assert.equal(deletedJson.data.recovery.kind, "recently-deleted");
    assert.deepEqual(deletedJson.data.recovery.uncovered, [{ path: "ledger.csv", reason: "too_large" }]);
    assert.equal(existsSync(join(workFolder.workFolderRoot, "ledger.csv")), false);
    const entryId = deletedJson.data.recovery.entryId;

    // The delete's undo reference is the item, not its partial restore point.
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, `recently-deleted ${entryId}`);
    assert.deepEqual(h.lastOk().undoRef, { kind: "recently-deleted-entry", value: entryId });
    assert.equal(h.lastOk().checkpointId, deletedJson.data.safetyCheckpointId);

    const listed = await h.execute(["recently-deleted", "list", "--json"]);
    const listedJson = JSON.parse(listed.stdout) as {
      data: { entries: Array<Record<string, unknown>>; retentionDays: number };
    };
    assert.equal(listedJson.data.entries.length, 1);
    assert.equal(listedJson.data.entries[0]!.id, entryId);
    assert.equal(listedJson.data.entries[0]!.kind, "file");
    assert.equal(listedJson.data.entries[0]!.originalPath, "ledger.csv");
    assert.equal(listedJson.data.entries[0]!.workFolderId, workFolder.id);
    assert.equal(listedJson.data.entries[0]!.workFolderName, "Fold work-folder");
    assert.equal(listedJson.data.entries[0]!.restorable, "in-place");

    // The human form names the item and how to bring it back.
    const human = await h.execute(["recently-deleted", "list"]);
    assert.match(human.stdout, /1 item\(s\) in Recently deleted \(kept 30 days\)/);
    assert.match(human.stdout, new RegExp(`${entryId} — file "ledger\\.csv" from Fold work-folder`));

    // Something else took the name in the meantime, so the restore renames.
    await writeFile(join(workFolder.workFolderRoot, "ledger.csv"), "replacement\n", "utf8");
    h.records.length = 0;
    const restored = await h.execute(["recently-deleted", "restore", "--entry", entryId, "--json"]);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const restoredJson = JSON.parse(restored.stdout) as {
      data: { entry: { id: string }; restored: { kind: string; path: string; renamed: boolean; safetyCheckpointId: string } };
    };
    assert.equal(restoredJson.data.entry.id, entryId);
    assert.equal(restoredJson.data.restored.kind, "file");
    assert.equal(restoredJson.data.restored.renamed, true);
    assert.equal(restoredJson.data.restored.path, "ledger (2).csv");
    assert.equal(await readFile(join(workFolder.workFolderRoot, "ledger (2).csv"), "utf8"), "a,b\n1,2\n");
    assert.equal(await readFile(join(workFolder.workFolderRoot, "ledger.csv"), "utf8"), "replacement\n");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().workFolderId, workFolder.id);
    assert.equal(h.lastOk().detail, `entry ${entryId}; kind file; restored ledger (2).csv`);
    // Restoring is additive, so its own undo is the restore point it recorded.
    assert.deepEqual(h.lastOk().undoRef, { kind: "safety-checkpoint", value: restoredJson.data.restored.safetyCheckpointId });
    assert.deepEqual((await h.api.recentlyDeleted.list()).entries, []);

    // Nothing empties the store, and a missing item is a plain not-found.
    const missing = await h.execute(["recently-deleted", "restore", "--entry", "trash-20991231235959-ffffffff", "--json"]);
    assert.equal(errorCodeOf(missing.stderr), "notFound");
    const malformed = await h.execute(["recently-deleted", "restore", "--entry", "not-an-id", "--json"]);
    assert.equal(errorCodeOf(malformed.stderr), "usage");
  } finally {
    await h.close();
  }
});

test("recently-deleted restore brings a deleted work-folder back with its identity, and the trash verbs refuse --work-folder", async () => {
  const h = await recentlyDeletedHarness("work-folders");
  try {
    const created = await h.api.actFacade.createWorkFolder({ name: "Whole work-folder" });
    const workFolder = created.workFolder;
    await writeFile(join(workFolder.workFolderRoot, "brief.md"), "# brief\n", "utf8");

    const deleted = await h.execute(["work-folders", "delete", "--work-folder", workFolder.id, "--json"]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    const deletedJson = JSON.parse(deleted.stdout) as { data: { recentlyDeleted: { entryId: string; restoreBy: string } | null } };
    const entryId = deletedJson.data.recentlyDeleted?.entryId;
    assert.ok(entryId);
    assert.equal(existsSync(workFolder.workFolderRoot), false);

    const listed = JSON.parse((await h.execute(["recently-deleted", "list", "--json"])).stdout) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    assert.equal(listed.data.entries.length, 1);
    assert.equal(listed.data.entries[0]!.kind, "work-folder");
    assert.equal(listed.data.entries[0]!.originalPath, workFolder.workFolderRoot);

    h.records.length = 0;
    const restored = await h.execute(["recently-deleted", "restore", "--entry", entryId!, "--json"]);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const restoredJson = JSON.parse(restored.stdout) as {
      data: { restored: { kind: string; workFolderRoot: string; renamed: boolean; workFolder: { id: string; name: string } } };
    };
    assert.equal(restoredJson.data.restored.kind, "work-folder");
    assert.equal(restoredJson.data.restored.workFolder.id, workFolder.id, "the portable identity comes back");
    assert.equal(restoredJson.data.restored.workFolderRoot, workFolder.workFolderRoot);
    assert.equal(restoredJson.data.restored.renamed, false);
    assert.equal(await readFile(join(workFolder.workFolderRoot, "brief.md"), "utf8"), "# brief\n");
    assert.deepEqual(h.lastOk().undoRef, { kind: "work-folder-root", value: workFolder.workFolderRoot });

    // A restored work-folder is registered again, so a second copy of the same
    // identity is a conflict rather than a silent adoption.
    const again = await h.execute(["recently-deleted", "restore", "--entry", entryId!, "--json"]);
    assert.equal(errorCodeOf(again.stderr), "notFound");

    // Recently deleted is above work-folders: neither verb takes --work-folder
    const scoped = await h.execute(["recently-deleted", "list", "--work-folder", workFolder.id, "--json"]);
    assert.equal(errorCodeOf(scoped.stderr), "usage");
    assert.match(scoped.stderr, /--work-folder cannot be used with 'recently-deleted list'/);
    const scopedRestore = await h.execute(["recently-deleted", "restore", "--work-folder", workFolder.id, "--entry", entryId!, "--json"]);
    assert.equal(errorCodeOf(scopedRestore.stderr), "usage");
    const withoutEntry = await h.execute(["recently-deleted", "restore", "--json"]);
    assert.equal(errorCodeOf(withoutEntry.stderr), "usage");
  } finally {
    await h.close();
  }
});

test("--to saves app data as a file and refuses a path inside a work-folder or work-fold's own files", async () => {
  const h = await recentlyDeletedHarness("save-copy");
  try {
    const created = await h.api.actFacade.createWorkFolder({ name: "Save work-folder" });
    const workFolder = created.workFolder;
    await writeFile(join(workFolder.workFolderRoot, "big.bin"), "0123456789", "utf8");
    const deleted = await deleteUncoverable(h, workFolder.id, "big.bin");
    const entryId = (JSON.parse(deleted.stdout) as { data: { recovery: { entryId: string } } }).data.recovery.entryId;

    // `--to` is for app data only; a file goes back where it came from.
    const refusedForFile = await h.execute([
      "recently-deleted", "restore", "--entry", entryId, "--to", join(h.sandbox, "copy.json"), "--json",
    ]);
    assert.equal(errorCodeOf(refusedForFile.stderr), "usage");
    assert.match(refusedForFile.stderr, /go back where they came from/);
    assert.equal((await h.api.recentlyDeleted.list()).entries.length, 1, "a refused restore leaves the item alone");
  } finally {
    await h.close();
  }
});
