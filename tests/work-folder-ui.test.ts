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

test("work-folder removal warns when it will erase machine-local App Studio lineage", () => {
  const copy = removeWorkFolderConfirmText(linkedWorkFolder, {
    project: { projectId: "project_fixture" },
    previews: [{}],
    releases: [{}, {}],
    operations: [{}],
  });
  assert.match(copy, /original folder and everything inside it will stay/i);
  assert.match(copy, /permanently clears this computer's App Studio history for it/i);
  assert.match(copy, /1 Development preview, 2 Releases, 1 prepared operation/i);
  assert.match(copy, /Keeping the folder does not preserve that state/i);
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
  assert.match(copy, /cancels 2 prepared App operations aimed at this work-folder/i);
});
