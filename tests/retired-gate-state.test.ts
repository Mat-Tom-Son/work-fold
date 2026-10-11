import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { removeRetiredGateState } from "../src/local/retired-gate-state.js";
import { startLocalApi } from "../src/local/server.js";

const retiredFiles = [
  "staged-acts.json",
  "staged-acts.json.1c1c1c1c.tmp",
  "authority.json",
  "authority-changes.jsonl",
  "authority-changes.1.jsonl",
  "policies.json",
  "policy-changes.jsonl",
  "policy-changes.1.jsonl",
];

test("startup deletes retired gate state unread and never executes a pending act", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-retired-state-"));
  const stateBase = join(sandbox, "state");
  const options = { port: 0, stateBase, workFolderBase: join(sandbox, "content"), loadEnv: false };
  const first = await startLocalApi(options);
  const workFolder = (await first.actFacade.createWorkFolder({ name: "Kept" })).workFolder;
  await first.close();

  // An older build left a pending-decision store holding a never-confirmed
  // managed deletion pinned to this work-folder, an Unrestricted authority file,
  // a standing-policy store, their journals, and a held automation declaration.
  const fold = join(stateBase, "fold");
  await mkdir(join(fold, "staged-routings"), { recursive: true });
  const pendingId = "act-pending-0001";
  await writeFile(join(fold, "staged-acts.json"), JSON.stringify({
    schemaVersion: 2,
    acts: [{
      schemaVersion: 2,
      id: pendingId,
      category: "destroy",
      kind: "work-folder.delete-folder",
      parameters: { workFolderId: workFolder.id },
      pins: { workFolderId: workFolder.id, workFolderRoot: workFolder.workFolderRoot },
      provenance: { stagedVia: "act-cli", requestId: "req-old-stage" },
      state: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2099-09-01T00:00:00.000Z",
    }],
  }), "utf8");
  await writeFile(join(fold, "staged-acts.json.1c1c1c1c.tmp"), "{}", "utf8");
  await writeFile(join(fold, "authority.json"), JSON.stringify({ schemaVersion: 1, mode: "unrestricted" }), "utf8");
  await writeFile(join(fold, "authority-changes.jsonl"), "{\"v\":1}\n", "utf8");
  await writeFile(join(fold, "authority-changes.1.jsonl"), "{\"v\":1}\n", "utf8");
  await writeFile(join(fold, "policies.json"), JSON.stringify({ schemaVersion: 1, policies: [] }), "utf8");
  await writeFile(join(fold, "policy-changes.jsonl"), "{\"v\":1}\n", "utf8");
  await writeFile(join(fold, "policy-changes.1.jsonl"), "{\"v\":1}\n", "utf8");
  await writeFile(join(fold, "staged-routings", "x.json"), "{}", "utf8");

  const second = await startLocalApi(options);
  try {
    for (const name of retiredFiles) assert.equal(existsSync(join(fold, name)), false, `${name} is removed at startup`);
    assert.equal(existsSync(join(fold, "staged-routings")), false, "the held automation declarations are removed");
    assert.equal(existsSync(workFolder.workFolderRoot), true, "a never-confirmed deletion never runs");
    assert.equal(existsSync(join(workFolder.workFolderRoot, ".work-fold", "work-folder.json")), true);
    await second.actFacade.listConversations({ workFolder: workFolder.id });
    const receipts = await readFile(join(stateBase, "cli", "receipts", "act.jsonl"), "utf8").catch(() => "");
    assert.equal(receipts.includes(pendingId), false, "the pending act leaves no receipt");
    assert.equal(receipts.includes("fold-decision:"), false);
    // The digest carries no decision items from the retired store.
    const overview = await second.kernel.getOverview({ kind: "system" });
    assert.ok(overview.needsYou.every((item) => (item.kind as string) !== "pending-decision"));
    assert.deepEqual(overview.unavailable, []);
  } finally {
    await second.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("removing retired state tolerates a missing fold directory and unrelated files", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-retired-state-unit-"));
  try {
    await removeRetiredGateState(join(sandbox, "nowhere"));
    await mkdir(join(sandbox, "fold"), { recursive: true });
    await writeFile(join(sandbox, "fold", "publications.json"), "{}", "utf8");
    await writeFile(join(sandbox, "fold", "authority.json"), "{}", "utf8");
    await removeRetiredGateState(sandbox);
    assert.equal(existsSync(join(sandbox, "fold", "publications.json")), true, "unrelated fold state is untouched");
    assert.equal(existsSync(join(sandbox, "fold", "authority.json")), false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
