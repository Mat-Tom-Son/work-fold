import assert from "node:assert/strict";
import test from "node:test";

import { foldPublicationsSettings, primaryNavigation, remoteAccessSettings, welcomeActions } from "../web-local/src/ui-contract.js";

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

test("the publications Settings section keeps the doc's copy rules and the widening boundary", () => {
  // Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
  // plan item 5): narrowing only — stop sharing, tighten budgets, snapshot
  // off. Widening is a fresh `pages stage` through the fold, and the copy
  // says so instead of offering a control.
  assert.equal(foldPublicationsSettings.heading, "Pages your fold serves");
  assert.match(foldPublicationsSettings.linkMeaning, /anyone with this link can read this page while your desktop is online/i);
  assert.match(foldPublicationsSettings.linkMeaning, /forwarding it forwards the access/i);
  // The snapshot opt-in is an explicitly labeled choice: an encrypted copy
  // stays at the relay so the page outlives desktop sleep, and the label
  // says exactly that instead of hiding the retention.
  assert.match(foldPublicationsSettings.snapshotLabel, /encrypted copy at the relay/i);
  assert.match(foldPublicationsSettings.snapshotLabel, /while your desktop sleeps/i);
  assert.match(foldPublicationsSettings.snapshotLabel, /cannot read it/i);
  assert.match(foldPublicationsSettings.snapshotLabel, /anyone with the link still can/i);
  assert.match(foldPublicationsSettings.snapshotWidenHint, /share the page again/i);
  assert.match(foldPublicationsSettings.narrowHint, /only shrink/i);
  assert.match(foldPublicationsSettings.empty, /Ask the fold to share a page\./);
  assert.equal(foldPublicationsSettings.stopSharing, "Stop sharing");
  assert.match(foldPublicationsSettings.stopSharingConfirm, /every copy of its link stops working/i);
  const copy = JSON.stringify(foldPublicationsSettings);
  assert.doesNotMatch(copy, /\bhost(ing|ed)?\b|\bwebsite\b/i, "the words host and website never appear in product copy");
  assert.doesNotMatch(copy, /publish/i, '"publish" stays reserved for App Studio\'s local Release transition');
  assert.doesNotMatch(copy, /consecrat/i, "person-facing copy never says consecration");
});

test("person-facing fold copy promises receipts and undo, never a gate", () => {
  // docs/receipts-not-gates.md: no surface offers an authority mode, a
  // policy, or a decision card. Pairing copy names identity, not a gate on
  // work.
  assert.match(remoteAccessSettings.pairedBrowserTrust, /six-digit code/);
  assert.match(remoteAccessSettings.pairedBrowserTrust, /full trust/);
  const copy = JSON.stringify({ foldPublicationsSettings, remoteAccessSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|Reviewed|Unrestricted|needs-you card|decision card|consecrat/i);
});
