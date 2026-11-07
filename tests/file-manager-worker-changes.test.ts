import assert from "node:assert/strict";
import test from "node:test";

import { isMarkedPath, workerChangesFrom, workerChangesSummary } from "../web-local/src/components/file-manager/useWorkerChanges.js";
import { absolute } from "../web-local/src/components/file-manager/GoToFolderSheet.js";

test("the Worker's receipt reads a restore point's preview as added, moved, and changed", () => {
  const changes = workerChangesFrom(
    { checkpointId: "cp-1", createdAt: "2026-11-07T10:00:00.000Z" },
    {
      // The host describes a move the way restoring undoes it: from where it is now, back to where it was.
      moves: [{ fromPath: "Receipts/receipt-0931.pdf", toPath: "receipt-0931.pdf" }],
      removePaths: ["Receipts", "Receipts/receipt-0931.pdf", "summary.md"],
      restoreFiles: ["budget.md"],
    },
  );
  assert.ok(changes);
  assert.deepEqual(changes!.moved, [{ from: "receipt-0931.pdf", to: "Receipts/receipt-0931.pdf" }]);
  assert.deepEqual(changes!.added, ["Receipts", "summary.md"]);
  assert.deepEqual(changes!.changed, ["budget.md"]);
  assert.equal(workerChangesSummary(changes!), "2 added · 1 moved · 1 changed");
  // A folder is marked when something inside it changed.
  assert.equal(isMarkedPath("Receipts", changes!.paths), true);
  assert.equal(isMarkedPath("Quotes", changes!.paths), false);
  assert.equal(workerChangesFrom({ checkpointId: "cp-2", createdAt: "" }, { moves: [], removePaths: [], restoreFiles: [] }), null, "nothing changed, no receipt");
});

test("Go to Folder reads a bare name as inside the folder shown", () => {
  assert.equal(absolute("Quotes/2026", "/Users/you/Documents/Home projects"), "/Users/you/Documents/Home projects/Quotes/2026");
  assert.equal(absolute("~/Downloads", "/anywhere"), "~/Downloads");
  assert.equal(absolute("/Volumes/Archive", "/anywhere"), "/Volumes/Archive");
});
