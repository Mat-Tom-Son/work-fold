import assert from "node:assert/strict";
import test from "node:test";

import {
  fileSharing,
  publicationsSettings,
  primaryNavigation,
  recentlyDeletedSettings,
  remoteAccessSettings,
  welcomeActions,
} from "../web-local/src/ui-contract.js";
import {
  activeSharedPageFor,
  isShareablePath,
  pageByteBudgetMaximumMiB,
  pageServeRateMaximum,
  pageTitleFromFileName,
  shareableSourceExtensions,
  sharedPageHealth,
  sharedPathsForWorkFolder,
  type SharedPageView,
} from "../web-local/src/lib/page-sharing.js";
import { WORKFOLD_PUBLICATION_SOURCE_TYPES } from "../src/local/publications.js";
import { buildFixturePublications } from "../web-local/src/fixtures/work-folder-fixture.js";

test("work-folder navigation separates the active work-folder from its surfaces", () => {
  assert.deepEqual(primaryNavigation.map(({ id, label }) => [id, label]), [
    ["files", "Files"],
    ["chats", "Chats"],
    ["history", "History"],
  ]);
  assert.deepEqual(welcomeActions, {
    create: "Create new work-folder",
    linkFolder: "Use existing folder",
  });
});

test("publication controls preserve access, retention, and revocation consequences", () => {
  // Settings → Shared pages (docs/shared-pages.md, plan item 5; amended
  // 2026-09-24): stop sharing, one Budgets control that narrows or widens in
  // place, and a Sleep copy toggle. A new page starts from a file's tab.
  assert.equal(publicationsSettings.heading, "Shared Pages");
  assert.match(publicationsSettings.linkMeaning, /anyone with the link can read this page/i);
  // The snapshot opt-in is an explicitly labeled choice: an encrypted copy
  // stays at the relay so the page outlives desktop sleep, and the label
  // says exactly that instead of hiding the retention.
  assert.match(publicationsSettings.snapshotLabel, /encrypted copy at the relay/i);
  assert.match(publicationsSettings.snapshotLabel, /while your desktop sleeps/i);
  assert.equal(publicationsSettings.budgets, "Budgets");
  assert.equal(publicationsSettings.sleepCopy, "Sleep Copy");
  assert.equal(publicationsSettings.saveBudgets, "Save");
  assert.equal(publicationsSettings.budgetRange(600, 1024), "Choose 1 to 600 serves per minute and 1 to 1024 MiB per day.");
  assert.equal("narrowHint" in publicationsSettings, false, "raising a budget is a control now, not a hint");
  // Empty states point at the next step: web access first, then a file's tab.
  assert.equal(publicationsSettings.emptyNoAddress, "Set up web access to share pages.");
  assert.equal(publicationsSettings.webAccess, "Web Access");
  assert.equal(publicationsSettings.empty, "No pages are shared. Share a file from its tab.");
  // One quiet state word per row; the reason rides in the tooltip.
  assert.deepEqual(publicationsSettings.states, {
    live: "Live",
    asleep: "Asleep",
    resting: "Resting",
    "not-available": "Not Available",
    stopped: "Stopped",
  });
  assert.equal(publicationsSettings.stopSharing, "Stop Sharing");
  assert.match(publicationsSettings.stopSharingConfirm, /every copy of its link stops working/i);
  const copy = JSON.stringify(publicationsSettings);
  assert.doesNotMatch(copy, /\bhost(ing|ed)?\b|\bwebsite\b/i, "the words host and website never appear in product copy");
  assert.doesNotMatch(copy, /publish/i, '"publish" stays reserved for App Studio\'s local Release transition');
  assert.doesNotMatch(copy, /consecrat/i, "person-facing copy never says consecration");
});

test("sharing from a file tab says what happened in plain words and never asks first", () => {
  assert.equal(fileSharing.share, "Share");
  assert.equal(fileSharing.shared, "Shared");
  assert.equal(fileSharing.sharedToast("Weekly report"), 'Shared "Weekly report"');
  assert.equal(fileSharing.noAddress, "Set up web access before sharing a page.");
  assert.equal(fileSharing.linkInSettings, "Show the link in Settings → Shared Pages.");
  assert.equal(fileSharing.webAccess, "Web Access");
  for (const label of [fileSharing.share, fileSharing.shared, fileSharing.openSharedPages, fileSharing.webAccess]) {
    assert.doesNotMatch(label, /…|\.\.\.$/, "button labels carry no trailing ellipsis");
  }
  const copy = JSON.stringify(fileSharing);
  assert.doesNotMatch(copy, /\bhost(ing|ed)?\b|\bwebsite\b|publish|consecrat|approv|confirm/i);
});

test("the file tab offers Share for exactly the types the host serves as a page", () => {
  assert.deepEqual([...shareableSourceExtensions].sort(), Object.keys(WORKFOLD_PUBLICATION_SOURCE_TYPES).sort());
  assert.deepEqual([...shareableSourceExtensions].sort(), [".htm", ".html", ".jpeg", ".jpg", ".markdown", ".md", ".pdf", ".png", ".txt"]);
  for (const path of ["notes.md", "a/b/Plan.MARKDOWN", "readme.txt", "photo.PNG", "x.jpg", "y.jpeg", "doc.pdf", "flyer.html", "site/Index.HTM"]) {
    assert.equal(isShareablePath(path), true, path);
  }
  for (const path of ["page.xhtml", "logo.svg", "budget.xlsx", ".md", "noextension", "folder.md/child"]) {
    assert.equal(isShareablePath(path), false, path);
  }
  assert.equal(pageServeRateMaximum, 600);
  assert.equal(pageByteBudgetMaximumMiB, 1024);
  assert.equal(pageTitleFromFileName("weekend checklist.md"), "weekend checklist");
  assert.equal(pageTitleFromFileName("archive.tar.pdf"), "archive.tar");
  assert.equal(pageTitleFromFileName(".md"), ".md");
  assert.equal(pageTitleFromFileName(`${"a".repeat(120)}.md`).length, 80, "titles stay within the host's bound");
});

test("the preview's sample pages cover every state a Shared pages row shows", () => {
  const samples = buildFixturePublications();
  const states = samples.map((publication) => sharedPageHealth(publication, { configured: true, enabled: true, connection: "connected" }).state);
  assert.deepEqual([...new Set(states)].sort(), ["asleep", "live", "not-available", "resting", "stopped"]);
  for (const publication of samples) {
    const derived = sharedPageHealth({ ...publication, health: undefined } as SharedPageView, null);
    assert.deepEqual(derived, publication.health, `${publication.publicationId} carries the state the host would derive`);
    assert.ok(publication.serveRatePerMinute <= 600 && publication.byteBudgetPerDay <= 1024 * 1024 * 1024);
  }
  const shared = activeSharedPageFor(samples, "fixture-home", "weekend checklist.md");
  assert.equal(shared?.publicationId, "fixture-page-live", "the preview's file tab shows Shared for its live sample");
  assert.equal(activeSharedPageFor(samples, "fixture-home", "Kitchen refresh/ideas.md"), null, "a stopped page is not shared");
  assert.deepEqual(
    [...sharedPathsForWorkFolder(samples, "fixture-home")].sort(),
    ["Garden/planting-plan.pdf", "weekend checklist.md"],
    "Files marks the active page slots of this work-folder only: no stopped page, no other work-folder's page",
  );
  assert.deepEqual([...sharedPathsForWorkFolder(null, "fixture-home")], []);
  assert.deepEqual([...sharedPathsForWorkFolder(samples, "fixture-none")], []);
  const withApp = [...samples, { ...samples[0]!, publicationId: "app-slot", kind: "app" as const, relativePath: "app.md" }];
  assert.equal(sharedPathsForWorkFolder(withApp, "fixture-home").has("app.md"), false, "a hosted-app slot never marks a file");
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
  const copy = JSON.stringify({ publicationsSettings, recentlyDeletedSettings, remoteAccessSettings });
  assert.doesNotMatch(copy, /staged|approv|polic|Reviewed|Unrestricted|needs-you card|decision card|consecrat/i);
  assert.doesNotMatch(JSON.stringify(recentlyDeletedSettings), /\bmode\b|\bcard\b|sandbox|digest|recently-deleted/i);
});
