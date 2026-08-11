import assert from "node:assert/strict";
import test from "node:test";

import { foldPoliciesSettings, foldPublicationsSettings, needsYouSurface, primaryNavigation, welcomeActions } from "../web-local/src/ui-contract.js";

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

test("the standing-policies Settings section keeps the authoring boundary in its copy", () => {
  // Settings → The fold → Standing policies is the ONLY authoring surface
  // (docs/fold-consecrations.md, never-list entry 4): the copy states that
  // the fold cites policies and never writes them, and that destroy-category
  // acts and page sharing keep their click. The attestation-broken banner is
  // the fail-closed recovery: review and re-save, in Settings, by a person.
  assert.equal(foldPoliciesSettings.heading, "Standing policies");
  assert.match(foldPoliciesSettings.intro, /cite them,\s*never write them/i);
  assert.match(foldPoliciesSettings.intro, /decision receipt/i);
  assert.match(foldPoliciesSettings.intro, /takes a click/i);
  assert.match(foldPoliciesSettings.attestationBroken, /changed outside Settings/i);
  assert.match(foldPoliciesSettings.attestationBroken, /re-save/i);
  assert.equal(foldPoliciesSettings.reattest, "Review and re-save");
  // Label and matcher stay editable in Settings over the PATCH route; a
  // policy's kind never changes (the store's own refusal: delete and create).
  assert.equal(foldPoliciesSettings.edit, "Edit");
  assert.equal(foldPoliciesSettings.editSave, "Save changes");
  assert.equal(foldPoliciesSettings.editCancel, "Cancel");
  const copy = JSON.stringify(foldPoliciesSettings);
  assert.doesNotMatch(copy, /consecrat/i, "person-facing copy never says consecration, in any form");
  assert.doesNotMatch(copy, /approve all/i, "no wording suggests batch approval");
});

test("the publications Settings section keeps the doc's copy rules and the widening boundary", () => {
  // Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
  // plan item 5): narrowing only — stop sharing, tighten budgets, snapshot
  // off. Widening is staged through the fold and clicked on a needs-you
  // card, and the copy says so instead of offering a control.
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
  assert.match(foldPublicationsSettings.snapshotWidenHint, /fresh approval/i);
  assert.match(foldPublicationsSettings.narrowHint, /only shrink/i);
  assert.equal(foldPublicationsSettings.stopSharing, "Stop sharing");
  assert.match(foldPublicationsSettings.stopSharingConfirm, /every copy of its link stops working/i);
  const copy = JSON.stringify(foldPublicationsSettings);
  assert.doesNotMatch(copy, /\bhost(ing|ed)?\b|\bwebsite\b/i, "the words host and website never appear in product copy");
  assert.doesNotMatch(copy, /publish/i, '"publish" stays reserved for App Studio\'s local Release transition');
  assert.doesNotMatch(copy, /consecrat/i, "person-facing copy never says consecration");
});

test("the needs-you surface keeps plain-words copy and single-card decisions", () => {
  // Pending decisions never add a rail destination: primaryNavigation above
  // stays Files/Chats/History, and the needs-you copy is the one renderer
  // contract both the popover stack and the main-window flyout use. The card
  // body itself is host-composed by the local API, never renderer prose.
  assert.equal(needsYouSurface.heading, "Needs you");
  assert.equal(needsYouSurface.approve, "Approve");
  assert.equal(needsYouSurface.deny, "Deny");
  assert.match(needsYouSurface.confirmDestroy, /deletes something for good/i);
  assert.match(needsYouSurface.notePlaceholder, /Optional/);
  const copy = JSON.stringify(needsYouSurface);
  assert.doesNotMatch(copy, /consecration/i, "person-facing copy never says consecration");
  assert.doesNotMatch(copy, /approve all/i, "there is no approve-all control anywhere");
});
