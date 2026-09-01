import assert from "node:assert/strict";
import test from "node:test";

import { removeSpaceConfirmText } from "../web-local/src/lib/space-ui.js";
import type { SpaceSummary } from "../web-local/src/types.js";

const linkedSpace = {
  id: "space-source",
  name: "App source",
  location: { storage: "linked", providerHint: "local" },
} as SpaceSummary;

const managedSpace = {
  ...linkedSpace,
  id: "space-managed",
  name: "Managed work",
  location: { storage: "managed", providerHint: "local" },
} as SpaceSummary;

test("managed Space deletion names every recursively deleted content class", () => {
  const copy = removeSpaceConfirmText(managedSpace);
  assert.match(copy, /permanently deletes the managed Space folder/i);
  assert.match(copy, /every file and folder inside it/i);
  assert.match(copy, /local chat history/i);
  assert.match(copy, /cannot be undone/i);
});

test("Space removal warns when it will erase machine-local App Studio lineage", () => {
  const copy = removeSpaceConfirmText(linkedSpace, {
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

test("ordinary linked Space removal keeps the concise folder-preservation copy", () => {
  const copy = removeSpaceConfirmText(linkedSpace, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 0,
  });
  assert.doesNotMatch(copy, /App Studio/i);
  assert.match(copy, /folder and everything inside it will stay/i);
});

test("target Space removal discloses incoming prepared App operations", () => {
  const copy = removeSpaceConfirmText(linkedSpace, {
    project: null,
    previews: [],
    releases: [],
    operations: [],
    incomingPreparedOperationCount: 2,
  });
  assert.match(copy, /cancels 2 prepared App operations aimed at this Space/i);
});
