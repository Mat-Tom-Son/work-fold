import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteFolderConfirm,
  pagePublishing,
  primaryNavigation,
  publishedPagesSettings,
  recentlyDeletedSettings,
  remoteAccessSettings,
  welcomeActions,
} from "../web-local/src/ui-contract.js";

test("work-folder navigation separates the active work-folder from its surfaces", () => {
  assert.deepEqual(primaryNavigation.map(({ id, label }) => [id, label]), [
    ["files", "Files"],
    ["chats", "Chats"],
    ["history", "History"],
  ]);
  assert.deepEqual(welcomeActions, {
    create: "Create New work-folder",
    linkFolder: "Use Existing Folder",
  });
});

test("Recently deleted says what is waiting, how long, and what work-fold never erases", () => {
  // Settings → Recently deleted (docs/receipts-not-gates.md, F20):
  // nothing work-fold destroys is gone at the moment it happens, and the copy
  // names the retention window and the clean-break rule instead of implying
  // permanence either way.
  assert.equal(recentlyDeletedSettings.heading, "Recently Deleted");
  assert.equal(recentlyDeletedSettings.restore, "Restore");
  assert.equal(recentlyDeletedSettings.saveCopy, "Save a Copy");
  assert.equal(recentlyDeletedSettings.deleteNow, "Delete Now");
  // Deleting a plain folder in Files says "Folder", not "work-folder".
  assert.equal(deleteFolderConfirm.confirmLabel, "Delete Folder");
  assert.match(recentlyDeletedSettings.deleteNowConfirm, /cannot be brought back/i);
  assert.match(recentlyDeletedSettings.retentionLabel, /^Keep Deleted Items For$/);
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
  const copy = JSON.stringify({ recentlyDeletedSettings, remoteAccessSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|Reviewed|Unrestricted|needs-you card|decision card|consecrat/i);
  assert.doesNotMatch(JSON.stringify(recentlyDeletedSettings), /\bmode\b|\bcard\b|sandbox|digest|recently-deleted/i);
});

test("publishing a page says what goes online, what Unpublish keeps, and where Web Access is set up", () => {
  // docs/pages.md, "Publishing (stage 2)": Publish puts the page online,
  // later edits wait for Publish Changes, Unpublish keeps the entries, and
  // publishing again brings back the same link.
  assert.equal(pagePublishing.publish, "Publish");
  assert.equal(pagePublishing.publishChanges, "Publish Changes");
  assert.equal(pagePublishing.online, "Online");
  assert.equal(pagePublishing.copyLink, "Copy Link");
  assert.equal(pagePublishing.open, "Open");
  assert.equal(pagePublishing.unpublish, "Unpublish");
  assert.equal(pagePublishing.onlineEntries, "Online Entries");
  assert.equal(pagePublishing.testEntries, "Test Entries");
  assert.equal(pagePublishing.checkNow, "Check Now");
  assert.equal(pagePublishing.unpublishHint, "Takes the page offline and keeps its entries.");
  assert.equal(pagePublishing.republishHint, "Publishing again brings back the same link.");
  assert.equal(pagePublishing.webAccessRequired, "Set up web access in Settings to publish.");
  assert.match(pagePublishing.unpublished("Garden Party RSVP"), /^Garden Party RSVP is offline\. Its entries are kept/);
  assert.match(pagePublishing.shareHint, /Anyone with the link/);
  assert.equal(publishedPagesSettings.heading, "Published");
  assert.equal(publishedPagesSettings.openLink, "Open Link");
  assert.equal(publishedPagesSettings.openPage, "Open Page");
  assert.match(publishedPagesSettings.empty, /Ask a Worker to make a page/);
  // Controls and status words are Title Case; nothing reads as a gate.
  for (const label of [pagePublishing.publish, pagePublishing.publishChanges, pagePublishing.copyLink, pagePublishing.unpublish, pagePublishing.onlineEntries, pagePublishing.testEntries, pagePublishing.checkNow, pagePublishing.openSettings, publishedPagesSettings.changesWaiting, publishedPagesSettings.openPage, publishedPagesSettings.emptyHeading]) {
    assert.match(label, /^(?:[A-Z][a-z]*|[Ii]s)(?: (?:[A-Z][a-z]*|Is))*$/, `${label} is Title Case`);
  }
  const copy = JSON.stringify({ pagePublishing: Object.fromEntries(Object.entries(pagePublishing).filter(([, value]) => typeof value === "string")), publishedPagesSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|consecrat|Space\b|Assistant|sandbox|digest|data\.sqlite|pg_/i);
});
