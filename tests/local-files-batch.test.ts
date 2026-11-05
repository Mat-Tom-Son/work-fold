import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * Several Files rows moved or deleted together get one History restore point
 * (2026-11-05), while each deleted row keeps the receipt, busy refusal, and
 * History or Recently deleted recovery one delete has. A row that fails
 * partway never leaves the rows already done without a restore point.
 */

// A read-only folder makes a later row fail after the batch passed its checks.
const canLockFolders = process.platform !== "win32" && process.getuid?.() !== 0;

// node:test runs `after` hooks in the order they were added, so a test adds
// anything that must happen before the API closes (releasing a held turn,
// unlocking a folder) before it calls setup.
async function setup(t: TestContext, options: Partial<Parameters<typeof startLocalApi>[0]> = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-files-batch-test-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({ port: 0, stateBase, workFolderBase: join(sandbox, "content"), loadEnv: false, ...options });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Batch" });
  const root = workFolder.workFolderRoot;
  const file = (path: string) => join(root, ...path.split("/"));
  const write = async (path: string, text = path) => {
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), text, "utf8");
  };
  const send = async (path: string, method: string, body: unknown) => {
    const response = await fetch(new URL(`/api/work-folders/${workFolder.id}${path}`, api.origin), {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const checkpoints = async () => {
    const response = await fetch(new URL(`/api/work-folders/${workFolder.id}/history/checkpoints?limit=1000`, api.origin));
    return (await response.json() as { checkpoints: Array<{ checkpointId: string; label?: string }> }).checkpoints;
  };
  const restore = async (checkpointId: string) => {
    const response = await fetch(new URL(`/api/work-folders/${workFolder.id}/history/checkpoints/${checkpointId}/restore`, api.origin), { method: "POST" });
    assert.equal(response.status, 200, await response.text());
  };
  const deleteReceipts = async () => {
    const probe = new WorkFoldCliActReceipts({ stateRoot: stateBase });
    const text = await readFile(probe.path, "utf8").catch(() => "");
    return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.command === "files.delete" && String(entry.requestId).startsWith("settings:"));
  };
  return { api, workFolder, file, write, send, checkpoints, restore, deleteReceipts };
}

test("several rows move into a folder under one restore point that puts them all back", async (t) => {
  const batch = await setup(t);
  await batch.write("a.txt");
  await batch.write("b.txt");
  await batch.write("Notes/c.txt");
  await batch.write("Archive/keep.txt");
  const before = await batch.checkpoints();

  const moved = await batch.send("/move-local-entries", "POST", { sourcePaths: ["a.txt", "b.txt", "Notes", "Notes/c.txt"], targetFolderPath: "Archive" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual((moved.body.moved as Array<{ fromPath: string; path: string }>).map((item) => [item.fromPath, item.path]), [
    ["a.txt", "Archive/a.txt"], ["b.txt", "Archive/b.txt"], ["Notes", "Archive/Notes"],
  ], "a row inside another selected row moves with it");
  assert.equal(moved.body.failed, undefined);
  assert.equal(await readFile(batch.file("Archive/Notes/c.txt"), "utf8"), "Notes/c.txt");

  const after = await batch.checkpoints();
  assert.equal(after.length, before.length + 1, "one restore point for the whole move");
  assert.equal(after.find((item) => item.checkpointId === moved.body.safetyCheckpointId)?.label, "Before moving 3 items");

  await batch.restore(String(moved.body.safetyCheckpointId));
  for (const path of ["a.txt", "b.txt", "Notes/c.txt"]) assert.equal(existsSync(batch.file(path)), true, `${path} is back`);
  assert.equal(existsSync(batch.file("Archive/a.txt")), false);
});

test("a several-row move that cannot all happen moves nothing", async (t) => {
  const batch = await setup(t);
  await batch.write("a.txt");
  await batch.write("b.txt");
  await batch.write("Archive/b.txt", "already there");
  await batch.write("x/report.md");
  await batch.write("y/report.md");
  const before = await batch.checkpoints();

  const collision = await batch.send("/move-local-entries", "POST", { sourcePaths: ["a.txt", "b.txt"], targetFolderPath: "Archive" });
  assert.ok(collision.status >= 400);
  assert.match(String(collision.body.error), /named b\.txt already exists/);
  assert.equal(existsSync(batch.file("a.txt")), true, "an earlier row does not move when a later one cannot");

  const sameName = await batch.send("/move-local-entries", "POST", { sourcePaths: ["x/report.md", "y/report.md"], targetFolderPath: "Archive" });
  assert.ok(sameName.status >= 400);
  assert.match(String(sameName.body.error), /same name/);

  const empty = await batch.send("/move-local-entries", "POST", { sourcePaths: [], targetFolderPath: "Archive" });
  assert.equal(empty.status, 400);
  assert.equal((await batch.checkpoints()).length, before.length, "no restore point when nothing moved");
});

test("a move that stops partway keeps a restore point for exactly the rows that moved", { skip: !canLockFolders }, async (t) => {
  let locked: string | null = null;
  t.after(() => locked ? chmod(locked, 0o755).catch(() => undefined) : undefined);
  const batch = await setup(t);
  await batch.write("a.txt");
  await batch.write("Locked/b.txt");
  await batch.write("c.txt");
  await batch.write("Archive/keep.txt");
  const before = await batch.checkpoints();
  locked = batch.file("Locked");
  await chmod(locked, 0o555);

  const moved = await batch.send("/move-local-entries", "POST", { sourcePaths: ["a.txt", "Locked/b.txt", "c.txt"], targetFolderPath: "Archive" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual((moved.body.moved as Array<{ path: string }>).map((item) => item.path), ["Archive/a.txt"]);
  assert.equal((moved.body.failed as { path: string }).path, "Locked/b.txt");
  assert.deepEqual(moved.body.notMoved, ["c.txt"]);
  assert.equal(existsSync(batch.file("c.txt")), true, "rows after the failure stay put");
  assert.equal((await batch.checkpoints()).length, before.length + 1, "one restore point, naming only what moved");

  const first = await batch.send("/move-local-entries", "POST", { sourcePaths: ["Locked/b.txt", "c.txt"], targetFolderPath: "Archive" });
  assert.ok(first.status >= 400, "when the first row fails, nothing moved");
  assert.equal(existsSync(batch.file("c.txt")), true);
  assert.equal((await batch.checkpoints()).length, before.length + 1, "and its restore point is discarded");

  await batch.restore(String(moved.body.safetyCheckpointId));
  assert.equal(existsSync(batch.file("a.txt")), true, "the restore point undoes the move that happened");
  assert.equal(existsSync(batch.file("Archive/a.txt")), false);
});

test("several rows delete under one restore point, each with its own receipt", async (t) => {
  const batch = await setup(t);
  await batch.write("a.txt");
  await batch.write("b.txt");
  await batch.write("Folder/x.txt");
  const before = await batch.checkpoints();

  const deleted = await batch.send("/local-files", "DELETE", { paths: ["a.txt", "Folder", "Folder/x.txt", "b.txt"] });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const rows = deleted.body.deleted as Array<{ path: string; kind: string; receiptId: string; safetyCheckpointId: string; recentlyDeleted?: unknown }>;
  assert.deepEqual(rows.map((row) => [row.path, row.kind]), [["a.txt", "file"], ["Folder", "folder"], ["b.txt", "file"]]);
  for (const path of ["a.txt", "Folder", "b.txt"]) assert.equal(existsSync(batch.file(path)), false);
  assert.ok(rows.every((row) => !row.recentlyDeleted && row.safetyCheckpointId === deleted.body.safetyCheckpointId));

  const after = await batch.checkpoints();
  assert.equal(after.length, before.length + 1, "one restore point for the whole delete");
  assert.equal(after.find((item) => item.checkpointId === deleted.body.safetyCheckpointId)?.label, "Before deleting 3 items");

  const receipts = await batch.deleteReceipts();
  assert.deepEqual(receipts.map((entry) => entry.outcome), ["accepted", "ok", "accepted", "ok", "accepted", "ok"]);
  assert.deepEqual([...new Set(receipts.map((entry) => entry.requestId))], rows.map((row) => row.receiptId), "one receipt per row");
  for (const entry of receipts.filter((item) => item.outcome === "ok")) {
    assert.equal(entry.detail, `work-folder ${batch.workFolder.id}; checkpoint ${deleted.body.safetyCheckpointId}`);
  }

  await batch.restore(String(deleted.body.safetyCheckpointId));
  for (const path of ["a.txt", "b.txt", "Folder/x.txt"]) assert.equal(await readFile(batch.file(path), "utf8"), path);
});

test("a row History cannot keep goes to Recently deleted while the others stay under the restore point", async (t) => {
  const batch = await setup(t);
  await batch.write("bulk/big.bin", "0123456789");
  await batch.write("small.txt", "ok");
  process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES = "4";
  let deleted;
  try {
    deleted = await batch.send("/local-files", "DELETE", { paths: ["bulk", "small.txt"] });
  } finally {
    delete process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES;
  }
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const rows = deleted.body.deleted as Array<{ path: string; receiptId: string; recentlyDeleted?: { entryId: string; uncoveredCount: number } }>;
  assert.equal(rows[0]?.path, "bulk");
  assert.equal(rows[0]?.recentlyDeleted?.uncoveredCount, 1);
  assert.equal(rows[1]?.path, "small.txt");
  assert.equal(rows[1]?.recentlyDeleted, undefined);
  assert.deepEqual(deleted.body.historySkippedPaths, ["bulk/big.bin"]);

  const kept = (await batch.api.recentlyDeleted.list()).entries;
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.id, rows[0]?.recentlyDeleted?.entryId);
  assert.equal(kept[0]?.originalPath, "bulk");
  const receipts = await batch.deleteReceipts();
  assert.equal(receipts.find((entry) => entry.requestId === rows[0]?.receiptId && entry.outcome === "ok")?.detail,
    `work-folder ${batch.workFolder.id}; trash ${rows[0]?.recentlyDeleted?.entryId}`);
});

test("a several-row delete is checked whole first, and a row that fails partway leaves the rest alone", async (t) => {
  let locked: string | null = null;
  t.after(() => locked ? chmod(locked, 0o755).catch(() => undefined) : undefined);
  const batch = await setup(t);
  await batch.write("a.txt");
  await batch.write("c.txt");
  const before = await batch.checkpoints();

  const missing = await batch.send("/local-files", "DELETE", { paths: ["a.txt", "gone.txt"] });
  assert.equal(missing.status, 404);
  assert.equal(existsSync(batch.file("a.txt")), true, "nothing is deleted when one row cannot be");
  assert.equal((await batch.checkpoints()).length, before.length);
  assert.deepEqual(await batch.deleteReceipts(), []);

  const outside = await batch.send("/local-files", "DELETE", { paths: ["a.txt", "../outside.txt"] });
  assert.ok(outside.status >= 400);
  assert.equal(existsSync(batch.file("a.txt")), true);

  if (!canLockFolders) return;
  await batch.write("Locked/b.txt");
  locked = batch.file("Locked");
  await chmod(locked, 0o555);
  const partial = await batch.send("/local-files", "DELETE", { paths: ["a.txt", "Locked/b.txt", "c.txt"] });
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  assert.deepEqual((partial.body.deleted as Array<{ path: string }>).map((row) => row.path), ["a.txt"]);
  assert.equal((partial.body.failed as { path: string }).path, "Locked/b.txt");
  assert.deepEqual(partial.body.notDeleted, ["c.txt"]);
  assert.equal(existsSync(batch.file("c.txt")), true);
  assert.deepEqual((await batch.deleteReceipts()).map((entry) => entry.outcome), ["accepted", "ok", "accepted", "error"]);

  // Restoring rewrites every row it covers, so the person fixes the folder first.
  await chmod(locked, 0o755);
  await batch.restore(String(partial.body.safetyCheckpointId));
  assert.equal(await readFile(batch.file("a.txt"), "utf8"), "a.txt", "the one restore point brings back the row that was deleted");
});

test("a several-row delete refuses while the work-folder has work running", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-files-batch-agent-"));
  const agentDir = join(sandbox, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "hold.ts"), `export default function (pi) {
    pi.registerCommand("hold", { description: "Hold a test turn", handler: async () => {} });
  }\n`, "utf8");
  const held: Array<{ taskId: string; release: () => void }> = [];
  let releasing = false;
  // Released before the API closes; a turn that starts during shutdown is let go at once.
  t.after(() => { releasing = true; held.splice(0).forEach((turn) => turn.release()); });
  const batch = await setup(t, {
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
    beforeAgentPrompt: async (event) => { if (!releasing) await new Promise<void>((release) => held.push({ taskId: event.taskId, release })); },
  });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await batch.write("a.txt");
  await batch.write("b.txt");
  const before = await batch.checkpoints();

  const sent = await batch.api.actFacade.sendMessage({ workFolder: batch.workFolder.id, newConversation: true, content: "/hold" });
  const deadline = Date.now() + 10_000;
  while (!held.some((turn) => turn.taskId === sent.taskId)) {
    if (Date.now() > deadline) throw new Error("The test turn never started.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const refused = await batch.send("/local-files", "DELETE", { paths: ["a.txt", "b.txt"] });
  assert.equal(refused.status, 409);
  assert.equal(existsSync(batch.file("a.txt")), true);
  assert.equal(existsSync(batch.file("b.txt")), true);
  // The held turn saves its own restore point; the refused delete adds none.
  const added = (await batch.checkpoints()).filter((item) => !before.some((earlier) => earlier.checkpointId === item.checkpointId));
  assert.deepEqual(added.filter((item) => item.label?.startsWith("Before deleting")), []);
  assert.deepEqual(await batch.deleteReceipts(), []);
});
