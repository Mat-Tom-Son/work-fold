import assert from "node:assert/strict";
import test from "node:test";

import { removeWorkFolderConfirmText } from "../web-local/src/lib/work-folder-ui.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";

const linkedWorkFolder = {
  id: "work-folder-source",
  name: "App source",
  location: { storage: "linked", providerHint: "local" },
} as WorkFolderSummary;

const managedSpace = {
  ...linkedWorkFolder,
  id: "space-managed",
  name: "Managed work",
  location: { storage: "managed", providerHint: "local" },
} as WorkFolderSummary;

test("managed work-folder deletion names what moves and where it waits", () => {
  // Deleting a managed work-folder moves its folder to Recently deleted rather than
  // erasing it (docs/receipts-not-gates.md, F20), so the confirm names the
  // content classes that travel and where they can be brought back from,
  // instead of promising permanence it no longer delivers.
  const copy = removeWorkFolderConfirmText(managedSpace);
  assert.match(copy, /every file and folder inside it/i);
  assert.match(copy, /Chats and History/i);
  assert.match(copy, /moves to Recently deleted/i);
  assert.match(copy, /Recently Deleted in Settings/);
  assert.match(copy, /put it back until its time runs out/i);
  assert.doesNotMatch(copy, /cannot be undone/i);
});

test("work-folder removal says where its App Studio history waits instead of promising an erase", () => {
  // Removing a work-folder keeps its App Studio history in Recently deleted
  // (docs/receipts-not-gates.md, F20), so the confirm names what moves, where
  // it waits, and what has to come back first — never "permanently".
  const copy = removeWorkFolderConfirmText(linkedWorkFolder, {
    project: { projectId: "project_fixture" },
    previews: [{}],
    releases: [{}, {}],
    operations: [{}],
  });
  assert.match(copy, /original folder and everything inside it will stay/i);
  assert.match(copy, /App Studio history on this computer/i);
  assert.match(copy, /1 Development preview, 2 Releases, 1 prepared operation, with their receipts/i);
  assert.match(copy, /moves to Recently Deleted too/);
  assert.match(copy, /Once the work-folder is back, you can put that back from there/);
  assert.doesNotMatch(copy, /permanent/i);
});

test("ordinary linked work-folder removal keeps the concise folder-preservation copy", () => {
  const copy = removeWorkFolderConfirmText(linkedWorkFolder, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 0,
  });
  assert.doesNotMatch(copy, /App Studio/i);
  assert.match(copy, /folder and everything inside it will stay/i);
});

test("target work-folder removal discloses incoming prepared App operations", () => {
  const copy = removeWorkFolderConfirmText(linkedWorkFolder, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 2,
  });
  assert.match(copy, /cancels 2 prepared App operations aimed at this work-folder; they wait in Recently Deleted until the work-folder is back/i);
});
