import assert from "node:assert/strict";
import test from "node:test";

import { primaryNavigation, welcomeActions } from "../web-local/src/ui-contract.js";

test("Workspace navigation separates the active Space from its surfaces", () => {
  assert.deepEqual(primaryNavigation.map(({ id, label }) => [id, label]), [
    ["files", "Files"],
    ["chats", "Chats"],
    ["library", "Library"],
    ["history", "History"],
  ]);
  assert.deepEqual(welcomeActions, {
    create: "Create a Space",
    linkFolder: "Turn an existing folder into a Space",
  });
});
