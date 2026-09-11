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
 * `trash list` and `trash restore` end to end through the installed act lane
 * (docs/receipts-not-gates.md, F20): argv → executor → the real facade inside
 * startLocalApi → the store. A delete History could not fully keep a copy of
 * is listed here, comes back on request, and the receipt's undo reference is
 * the item itself. Recently deleted sits above Spaces, so neither verb takes
 * `--space`, and nothing empties it.
 */
async function trashHarness(prefix: string): Promise<{
  sandbox: string;
  api: LocalApiHandle;
  records: ReceiptEntry[];
  execute: (argv: string[]) => ReturnType<typeof executeWorkFoldCliActRequest>;
  lastOk: () => ReceiptEntry;
  close: () => Promise<void>;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-trash-verbs-${prefix}-`));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return {}; } },
  });
  const records: ReceiptEntry[] = [];
  const execute = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      resolveLineageParent: (taskId) => api.resolveManagementLineageParent(taskId),
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
  spaceId: string,
  path: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "1";
  try {
    return await h.execute(["files", "delete", "--space", spaceId, "--path", path, "--json"]);
  } finally {
    delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
  }
}

test("files delete reports the Recently deleted item, and trash list and restore bring a file back", async () => {
  const h = await trashHarness("files");
  try {
    const created = await h.api.actFacade.createSpace({ name: "Fold Space" });
    const space = created.space;
    await writeFile(join(space.spaceRoot, "ledger.csv"), "a,b\n1,2\n", "utf8");

    const emptyList = await h.execute(["trash", "list", "--json"]);
    assert.equal(emptyList.exitCode, 0, emptyList.stderr);
    const emptyJson = JSON.parse(emptyList.stdout) as { data: { entries: unknown[]; retentionDays: number; damagedCount: number } };
    assert.deepEqual(emptyJson.data.entries, []);
    assert.equal(emptyJson.data.retentionDays, 30);
    assert.equal(emptyJson.data.damagedCount, 0);

    h.records.length = 0;
    const deleted = await deleteUncoverable(h, space.id, "ledger.csv");
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
    assert.equal(deletedJson.data.recovery.kind, "trash");
    assert.deepEqual(deletedJson.data.recovery.uncovered, [{ path: "ledger.csv", reason: "too_large" }]);
    assert.equal(existsSync(join(space.spaceRoot, "ledger.csv")), false);
    const entryId = deletedJson.data.recovery.entryId;

    // The delete's undo reference is the item, not its partial restore point.
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().detail, `trash ${entryId}`);
    assert.deepEqual(h.lastOk().undoRef, { kind: "trash-entry", value: entryId });
    assert.equal(h.lastOk().checkpointId, deletedJson.data.safetyCheckpointId);

    const listed = await h.execute(["trash", "list", "--json"]);
    const listedJson = JSON.parse(listed.stdout) as {
      data: { entries: Array<Record<string, unknown>>; retentionDays: number };
    };
    assert.equal(listedJson.data.entries.length, 1);
    assert.equal(listedJson.data.entries[0]!.id, entryId);
    assert.equal(listedJson.data.entries[0]!.kind, "file");
    assert.equal(listedJson.data.entries[0]!.originalPath, "ledger.csv");
    assert.equal(listedJson.data.entries[0]!.spaceId, space.id);
    assert.equal(listedJson.data.entries[0]!.spaceName, "Fold Space");
    assert.equal(listedJson.data.entries[0]!.restorable, "in-place");

    // The human form names the item and how to bring it back.
    const human = await h.execute(["trash", "list"]);
    assert.match(human.stdout, /1 item\(s\) in Recently deleted \(kept 30 days\)/);
    assert.match(human.stdout, new RegExp(`${entryId} — file "ledger\\.csv" from Fold Space`));

    // Something else took the name in the meantime, so the restore renames.
    await writeFile(join(space.spaceRoot, "ledger.csv"), "replacement\n", "utf8");
    h.records.length = 0;
    const restored = await h.execute(["trash", "restore", "--entry", entryId, "--json"]);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const restoredJson = JSON.parse(restored.stdout) as {
      data: { entry: { id: string }; restored: { kind: string; path: string; renamed: boolean; safetyCheckpointId: string } };
    };
    assert.equal(restoredJson.data.entry.id, entryId);
    assert.equal(restoredJson.data.restored.kind, "file");
    assert.equal(restoredJson.data.restored.renamed, true);
    assert.equal(restoredJson.data.restored.path, "ledger (2).csv");
    assert.equal(await readFile(join(space.spaceRoot, "ledger (2).csv"), "utf8"), "a,b\n1,2\n");
    assert.equal(await readFile(join(space.spaceRoot, "ledger.csv"), "utf8"), "replacement\n");
    assert.deepEqual(h.records.map((record) => record.outcome), ["accepted", "ok"]);
    assert.equal(h.lastOk().spaceId, space.id);
    assert.equal(h.lastOk().detail, `entry ${entryId}; kind file; restored ledger (2).csv`);
    // Restoring is additive, so its own undo is the restore point it recorded.
    assert.deepEqual(h.lastOk().undoRef, { kind: "safety-checkpoint", value: restoredJson.data.restored.safetyCheckpointId });
    assert.deepEqual((await h.api.trash.list()).entries, []);

    // Nothing empties the store, and a missing item is a plain not-found.
    const missing = await h.execute(["trash", "restore", "--entry", "trash-20991231235959-ffffffff", "--json"]);
    assert.equal(errorCodeOf(missing.stderr), "notFound");
    const malformed = await h.execute(["trash", "restore", "--entry", "not-an-id", "--json"]);
    assert.equal(errorCodeOf(malformed.stderr), "usage");
  } finally {
    await h.close();
  }
});

test("trash restore brings a deleted Space back with its identity, and the trash verbs refuse --space", async () => {
  const h = await trashHarness("spaces");
  try {
    const created = await h.api.actFacade.createSpace({ name: "Whole Space" });
    const space = created.space;
    await writeFile(join(space.spaceRoot, "brief.md"), "# brief\n", "utf8");

    const deleted = await h.execute(["spaces", "delete", "--space", space.id, "--json"]);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    const deletedJson = JSON.parse(deleted.stdout) as { data: { trash: { entryId: string; restoreBy: string } | null } };
    const entryId = deletedJson.data.trash?.entryId;
    assert.ok(entryId);
    assert.equal(existsSync(space.spaceRoot), false);

    const listed = JSON.parse((await h.execute(["trash", "list", "--json"])).stdout) as {
      data: { entries: Array<Record<string, unknown>> };
    };
    assert.equal(listed.data.entries.length, 1);
    assert.equal(listed.data.entries[0]!.kind, "space");
    assert.equal(listed.data.entries[0]!.originalPath, space.spaceRoot);

    h.records.length = 0;
    const restored = await h.execute(["trash", "restore", "--entry", entryId!, "--json"]);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const restoredJson = JSON.parse(restored.stdout) as {
      data: { restored: { kind: string; spaceRoot: string; renamed: boolean; space: { id: string; name: string } } };
    };
    assert.equal(restoredJson.data.restored.kind, "space");
    assert.equal(restoredJson.data.restored.space.id, space.id, "the portable identity comes back");
    assert.equal(restoredJson.data.restored.spaceRoot, space.spaceRoot);
    assert.equal(restoredJson.data.restored.renamed, false);
    assert.equal(await readFile(join(space.spaceRoot, "brief.md"), "utf8"), "# brief\n");
    assert.deepEqual(h.lastOk().undoRef, { kind: "space-root", value: space.spaceRoot });

    // A restored Space is registered again, so a second copy of the same
    // identity is a conflict rather than a silent adoption.
    const again = await h.execute(["trash", "restore", "--entry", entryId!, "--json"]);
    assert.equal(errorCodeOf(again.stderr), "notFound");

    // Recently deleted is above Spaces: neither verb takes --space.
    const scoped = await h.execute(["trash", "list", "--space", space.id, "--json"]);
    assert.equal(errorCodeOf(scoped.stderr), "usage");
    assert.match(scoped.stderr, /--space cannot be used with 'trash list'/);
    const scopedRestore = await h.execute(["trash", "restore", "--space", space.id, "--entry", entryId!, "--json"]);
    assert.equal(errorCodeOf(scopedRestore.stderr), "usage");
    const withoutEntry = await h.execute(["trash", "restore", "--json"]);
    assert.equal(errorCodeOf(withoutEntry.stderr), "usage");
  } finally {
    await h.close();
  }
});

test("--to saves app data as a file and refuses a path inside a Space or work-fold's own files", async () => {
  const h = await trashHarness("save-copy");
  try {
    const created = await h.api.actFacade.createSpace({ name: "Save Space" });
    const space = created.space;
    await writeFile(join(space.spaceRoot, "big.bin"), "0123456789", "utf8");
    const deleted = await deleteUncoverable(h, space.id, "big.bin");
    const entryId = (JSON.parse(deleted.stdout) as { data: { recovery: { entryId: string } } }).data.recovery.entryId;

    // `--to` is for app data only; a file goes back where it came from.
    const refusedForFile = await h.execute([
      "trash", "restore", "--entry", entryId, "--to", join(h.sandbox, "copy.json"), "--json",
    ]);
    assert.equal(errorCodeOf(refusedForFile.stderr), "usage");
    assert.match(refusedForFile.stderr, /go back where they came from/);
    assert.equal((await h.api.trash.list()).entries.length, 1, "a refused restore leaves the item alone");
  } finally {
    await h.close();
  }
});
