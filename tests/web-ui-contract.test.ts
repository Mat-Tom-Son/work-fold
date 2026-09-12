import assert from "node:assert/strict";
import test from "node:test";

import {
  foldPublicationsSettings,
  primaryNavigation,
  recentlyDeletedSettings,
  remoteAccessSettings,
  welcomeActions,
} from "../web-local/src/ui-contract.js";

test("Space navigation separates the active Space from its surfaces", () => {
  assert.deepEqual(primaryNavigation.map(({ id, label }) => [id, label]), [
    ["files", "Files"],
    ["chats", "Chats"],
    ["history", "History"],
  ]);
  assert.deepEqual(welcomeActions, {
    create: "Create a Space",
    linkFolder: "Turn an existing folder into a Space",
  });
});

test("publication controls preserve access, retention, and revocation consequences", () => {
  // Settings → General → Pages your fold serves (docs/fold-publishing.md,
  // plan item 5): narrowing only — stop sharing, tighten budgets, snapshot
  // off. Widening is a fresh `pages share` through the fold, and the copy
  // says so instead of offering a control.
  assert.equal(foldPublicationsSettings.heading, "Pages your fold serves");
  assert.match(foldPublicationsSettings.linkMeaning, /anyone with the link can read this page/i);
  // The snapshot opt-in is an explicitly labeled choice: an encrypted copy
  // stays at the relay so the page outlives desktop sleep, and the label
  // says exactly that instead of hiding the retention.
  assert.match(foldPublicationsSettings.snapshotLabel, /encrypted copy at the relay/i);
  assert.match(foldPublicationsSettings.snapshotLabel, /while your desktop sleeps/i);
  assert.match(foldPublicationsSettings.narrowHint, /raise budgets.*share again/i);
  assert.match(foldPublicationsSettings.empty, /Ask the fold to share a page\./);
  assert.equal(foldPublicationsSettings.stopSharing, "Stop sharing");
  assert.match(foldPublicationsSettings.stopSharingConfirm, /every copy of its link stops working/i);
  const copy = JSON.stringify(foldPublicationsSettings);
  assert.doesNotMatch(copy, /\bhost(ing|ed)?\b|\bwebsite\b/i, "the words host and website never appear in product copy");
  assert.doesNotMatch(copy, /publish/i, '"publish" stays reserved for App Studio\'s local Release transition');
  assert.doesNotMatch(copy, /consecrat/i, "person-facing copy never says consecration");
});

test("Recently deleted says what is waiting, how long, and what work-fold never erases", () => {
  // Settings → General → Recently deleted (docs/receipts-not-gates.md, F20):
  // nothing work-fold destroys is gone at the moment it happens, and the copy
  // names the retention window and the clean-break rule instead of implying
  // permanence either way.
  assert.equal(recentlyDeletedSettings.heading, "Recently deleted");
  assert.equal(recentlyDeletedSettings.restore, "Restore");
  assert.equal(recentlyDeletedSettings.saveCopy, "Save a copy");
  assert.equal(recentlyDeletedSettings.deleteNow, "Delete now");
  assert.match(recentlyDeletedSettings.deleteNowConfirm, /cannot be brought back/i);
  assert.match(recentlyDeletedSettings.retentionLabel, /^Keep deleted items for$/);
  assert.match(recentlyDeletedSettings.heldNote, /legacy Workspace records/i);
  assert.match(recentlyDeletedSettings.heldNote, /cannot be deleted/i);
  assert.match(recentlyDeletedSettings.damagedNote, /could not be read/i);
});

test("person-facing fold copy promises receipts and undo, never a gate", () => {
  // docs/receipts-not-gates.md: no surface offers an authority mode, a
  // policy, or a decision card. Pairing copy names identity, not a gate on
  // work.
  assert.match(remoteAccessSettings.pairedBrowserTrust, /read or change accessible files/);
  assert.match(remoteAccessSettings.pairedBrowserTrust, /run local commands/);
  const copy = JSON.stringify({ foldPublicationsSettings, recentlyDeletedSettings, remoteAccessSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|Reviewed|Unrestricted|needs-you card|decision card|consecrat/i);
  assert.doesNotMatch(JSON.stringify(recentlyDeletedSettings), /\bmode\b|\bcard\b|sandbox|digest|trash/i);
});
