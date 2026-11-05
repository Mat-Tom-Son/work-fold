import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import React, { createElement } from "react";

import { createDomHarness, type DomHarness } from "./support/dom.js";
import { fakePagesClient, onlinePublication, pageRow, type FakePagesClient } from "./support/fake-pages-client.js";
import {
  normalizePublication,
  normalizePublishResult,
  pagePublishRefusalFrom,
  PagePublishRefusal,
  pageTimeAgo,
  type PagePublishResult,
  type PublishedPage,
} from "../web-local/src/lib/pages.js";
import { pagePublishing, publishedPagesSettings } from "../web-local/src/ui-contract.js";
import type { TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";

const assets = registerHooks({
  load(url, context, next) { return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context); },
});
const { FileTree } = await import("../web-local/src/components/tree/FileTree.js");
const { PageTab, pageDataFileChange } = await import("../web-local/src/components/pages/PageTab.js");
const { onlineEntriesNote, testEntriesNote } = await import("../web-local/src/components/pages/PageDataView.js");
const { PublishedPagesPane, groupPublishedPages } = await import("../web-local/src/components/modals/PublishedPagesPane.js");
const { ToastHost } = await import("../web-local/src/ui/feedback.js");
const { createFixturePagesClient } = await import("../web-local/src/fixtures/pages-fixture.js");
assets.deregister();

const workFolder = { id: "space-0123456789abcdef", name: "Home", workFolderRoot: "/tmp/home", location: { kind: "local", storage: "linked" } } as WorkFolderSummary;
const pagePath = "Events/Garden Party RSVP";

interface Harness extends DomHarness {
  copied: string[];
  opened: string[];
}

async function harness(t: TestContext): Promise<Harness> {
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const copied: string[] = [];
  const opened: string[] = [];
  // Copy goes through the native clipboard when there is one; a page's link opens outside the app.
  (window as any).workFoldDiagnostics = { clipboard: { write: async (content: { text: string }) => { copied.push(content.text); } } };
  (window as any).open = (url: string) => { opened.push(url); return null; };
  return Object.assign(dom, { copied, opened });
}

async function renderPageTab(dom: DomHarness, client: FakePagesClient, view: "preview" | "data", extra: Record<string, unknown> = {}) {
  const changes: { views: string[]; settings: number } = { views: [], settings: 0 };
  await dom.render(createElement("div", null,
    createElement(ToastHost),
    createElement(PageTab, {
      workFolder, path: pagePath, title: "Garden Party RSVP", view, active: true, fixtureMode: true, client,
      onViewChange: (next: string) => changes.views.push(next),
      onTitleChange: () => {},
      onOpenWebAccessSettings: () => { changes.settings += 1; },
      ...extra,
    })));
  await dom.settle();
  return changes;
}

const buttons = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label);
const button = (root: ParentNode, label: string) => buttons(root, label)[0];
const header = (dom: DomHarness) => dom.container.querySelector<HTMLElement>(".page-tab-header")!;
const panel = (dom: DomHarness) => dom.container.querySelector<HTMLElement>(".page-publish-panel");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("Publish shows its progress, then the link with Copy Link and Open, and the files that went up", async (t) => {
  const dom = await harness(t);
  const upload = deferred<PagePublishResult>();
  const client = fakePagesClient({ publish: () => upload.promise });
  await renderPageTab(dom, client, "preview");
  await dom.waitFor(() => Boolean(button(header(dom), "Publish")));
  const publish = button(header(dom), "Publish")!;
  assert.equal(publish.disabled, false);
  assert.equal(header(dom).querySelector(".page-publish-status"), null, "a page that was never online has no status yet");

  await dom.act(() => { publish.click(); });
  await dom.waitFor(() => panel(dom)?.dataset.phase === "publishing");
  assert.equal(panel(dom)!.querySelector("h3")!.textContent, "Publishing");
  assert.equal(panel(dom)!.querySelector(".page-publish-progress")!.textContent, "Uploading 2 files (100 B).", "the progress names what goes up");
  assert.equal(button(header(dom), "Publishing")!.disabled, true, "one publish at a time");
  assert.deepEqual(client.publishLog.filter((entry) => entry.startsWith("publish:")), [`publish:${pagePath}`]);

  const publication = { ...onlinePublication, revision: 1, publishedAt: "2026-11-05T14:00:00.000Z" };
  client.state = { ...client.state, publication };
  await dom.act(async () => {
    upload.resolve({ publication, uploaded: { files: [{ path: "index.html", bytes: 2_410 }, { path: "images/cake.png", bytes: 48_200 }], count: 2, bytes: 50_610 } });
    await upload.promise;
  });
  await dom.waitFor(() => panel(dom)?.dataset.phase === "published");
  const shown = panel(dom)!;
  assert.equal(shown.querySelector("h3")!.textContent, pagePublishing.publishedHeading);
  assert.equal(shown.querySelector(".page-publish-link")!.textContent, onlinePublication.url);
  assert.match(shown.textContent!, /Anyone with the link can open the page\./);
  assert.equal(shown.querySelector(".page-publish-uploaded > p")!.textContent, "Uploaded 2 files · 49 KB");
  assert.deepEqual([...shown.querySelectorAll(".page-publish-uploaded li")].map((item) => item.textContent), ["index.html2.4 KB", "images/cake.png47 KB"]);

  await dom.act(async () => { button(shown, "Copy Link")!.click(); });
  await dom.waitFor(() => dom.copied.length === 1);
  assert.deepEqual(dom.copied, [onlinePublication.url]);
  await dom.waitFor(() => button(shown, "Copied") !== undefined);
  await dom.act(() => { button(shown, "Open")!.click(); });
  assert.deepEqual(dom.opened, [onlinePublication.url]);

  // The header now says the page is online, with its link at hand.
  const status = header(dom).querySelector(".page-publish-status.online")!;
  assert.equal(status.textContent, "Online");
  assert.ok(button(header(dom), "Copy Link"));
  assert.ok(button(header(dom), "Open"));
  assert.equal(button(header(dom), "Publish Changes"), undefined, "nothing changed since publishing");
  await dom.act(() => { button(shown, "Done")!.click(); });
  assert.equal(panel(dom), null);
  await dom.act(async () => { button(header(dom), "Copy Link")!.click(); });
  await dom.waitFor(() => dom.copied.length === 2);
  assert.match(dom.container.querySelector(".toast-stack")!.textContent!, /Link copied/);
});

test("Publish says why it can't run: Web Access isn't set up, or the page has errors", async (t) => {
  const dom = await harness(t);
  const noAccess = fakePagesClient({ available: false, unavailableReason: "Set up web access in Settings to publish." });
  const changes = await renderPageTab(dom, noAccess, "preview");
  await dom.waitFor(() => Boolean(button(header(dom), "Publish")));
  const publish = button(header(dom), "Publish")!;
  assert.equal(publish.disabled, true);
  const reason = document.getElementById(publish.getAttribute("aria-describedby")!)!;
  assert.equal(reason.textContent, "Set up web access in Settings to publish.");
  await dom.act(() => { button(header(dom), "Open Settings")!.click(); });
  assert.equal(changes.settings, 1, "the reason points to Settings → Web Access");
  await dom.cleanup();

  const broken = await harness(t);
  const withErrors = fakePagesClient({ html: null, problems: [{ file: "page.json", message: "title is required.", severity: "error" }] });
  await renderPageTab(broken, withErrors, "preview");
  await broken.waitFor(() => Boolean(button(header(broken), "Publish")));
  assert.equal(button(header(broken), "Publish")!.disabled, true);
  assert.equal(header(broken).querySelector(".page-publish-reason")!.textContent, pagePublishing.hasErrors);
  assert.equal(button(header(broken), "Open Settings"), undefined, "errors are fixed in the page, not in Settings");
});

test("a refused publish shows Web Access setup or the page's problems in its panel", async (t) => {
  const dom = await harness(t);
  const refused = fakePagesClient({ publish: async () => { throw new PagePublishRefusal(409, "Set up web access in Settings to publish.", "WEB_ACCESS_REQUIRED", []); } });
  const changes = await renderPageTab(dom, refused, "preview");
  await dom.waitFor(() => Boolean(button(header(dom), "Publish")));
  await dom.act(async () => { button(header(dom), "Publish")!.click(); });
  await dom.waitFor(() => panel(dom)?.dataset.phase === "refused");
  assert.equal(panel(dom)!.querySelector("h3")!.textContent, pagePublishing.webAccessHeading);
  assert.match(panel(dom)!.textContent!, /Set up web access in Settings to publish\./);
  await dom.act(() => { button(panel(dom)!, "Open Settings")!.click(); });
  assert.equal(changes.settings, 1);
  assert.equal(panel(dom), null, "the panel steps aside for Settings");
  await dom.cleanup();

  const again = await harness(t);
  const invalid = fakePagesClient({ publish: async () => { throw pagePublishRefusalFrom({ error: { code: "INVALID", message: "This page has problems.", problems: [{ file: "index.html", message: "https://cdn.example.com/x.js is outside the page folder.", severity: "error" }] } }, 400); } });
  await renderPageTab(again, invalid, "preview");
  await again.waitFor(() => Boolean(button(header(again), "Publish")));
  await again.act(async () => { button(header(again), "Publish")!.click(); });
  await again.waitFor(() => panel(again)?.dataset.phase === "refused");
  assert.equal(panel(again)!.querySelector("h3")!.textContent, pagePublishing.problemsHeading);
  assert.deepEqual([...panel(again)!.querySelectorAll(".page-problem-list li")].map((item) => item.textContent), ["index.htmlhttps://cdn.example.com/x.js is outside the page folder."]);
  await again.cleanup();

  const failing = await harness(t);
  let attempts = 0;
  const flaky = fakePagesClient({ publish: async () => { attempts += 1; throw new Error("Online pages aren't available yet."); } });
  await renderPageTab(failing, flaky, "preview");
  await failing.waitFor(() => Boolean(button(header(failing), "Publish")));
  await failing.act(async () => { button(header(failing), "Publish")!.click(); });
  await failing.waitFor(() => panel(failing)?.dataset.phase === "failed");
  assert.equal(panel(failing)!.querySelector("h3")!.textContent, pagePublishing.failedHeading);
  assert.match(panel(failing)!.textContent!, /Online pages aren't available yet\./);
  await failing.act(async () => { button(panel(failing)!, "Try Again")!.click(); });
  await failing.waitFor(() => attempts === 2);
});

test("an online page offers Publish Changes only after its files changed, and Unpublish keeps its entries", async (t) => {
  const dom = await harness(t);
  const unchanged = fakePagesClient({ publication: { ...onlinePublication } });
  await renderPageTab(dom, unchanged, "preview");
  await dom.waitFor(() => Boolean(header(dom).querySelector(".page-publish-status.online")));
  assert.equal(button(header(dom), "Publish Changes"), undefined);
  assert.equal(button(header(dom), "Publish"), undefined, "an online page isn't published again from scratch");
  await dom.cleanup();

  const edited = await harness(t);
  const client = fakePagesClient({ publication: { ...onlinePublication, changesAvailable: true } });
  await renderPageTab(edited, client, "preview");
  await edited.waitFor(() => Boolean(button(header(edited), "Publish Changes")));
  await edited.act(async () => { button(header(edited), "Publish Changes")!.click(); });
  await edited.waitFor(() => panel(edited)?.dataset.phase === "published");
  assert.equal(panel(edited)!.querySelector("h3")!.textContent, pagePublishing.changesPublishedHeading);
  assert.equal(button(header(edited), "Publish Changes"), undefined, "the changes are online");
  await edited.act(() => { button(panel(edited)!, "Done")!.click(); });

  // Unpublish waits in a small menu that says what it keeps.
  const more = button(header(edited), "More Actions")!;
  assert.equal(more.getAttribute("aria-haspopup"), "menu");
  await edited.act(() => { more.click(); });
  const menu = edited.container.querySelector<HTMLElement>(".page-publish-menu")!;
  const unpublish = menu.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  assert.equal(unpublish.textContent, "Unpublish");
  assert.equal(document.getElementById(unpublish.getAttribute("aria-describedby")!)!.textContent, "Takes the page offline and keeps its entries. Publishing again brings back the same link.");
  await edited.act(async () => { unpublish.click(); });
  await edited.waitFor(() => client.publishLog.includes(`unpublish:${pagePath}`) && Boolean(button(header(edited), "Publish")));
  assert.equal(header(edited).querySelector(".page-publish-status")!.textContent, "Offline");
  assert.equal(button(header(edited), "Publish")!.title, "Publishing again brings back the same link.");
  assert.equal(button(header(edited), "Copy Link"), undefined, "an offline page's link shows nothing");
  assert.match(edited.container.querySelector(".toast-stack")!.textContent!, /Garden Party RSVP is offline\. Its entries are kept, and publishing again brings back the same link\./);
});

test("the Data view opens on online entries, says when it last checked in, and switches to test entries", async (t) => {
  const dom = await harness(t);
  const client = fakePagesClient({
    publication: { ...onlinePublication, lastCheckIn: new Date(Date.now() - 2 * 60_000).toISOString() },
    rows: [pageRow("r3", "Priya", 3, "Salad", "2026-11-05T11:30:00.000Z"), pageRow("r2", "Oliver", 0, "Drinks", "2026-11-05T11:00:00.000Z"), pageRow("r1", "Maya", 2, null, "2026-11-04T09:00:00.000Z")],
    onlineRows: [pageRow("o2", "Grace", 1, "Salad", "2026-11-05T12:00:00.000Z"), pageRow("o1", "Kenji", 2, "Dessert", "2026-11-04T08:00:00.000Z")],
    onlineLastSeen: "2026-11-05T00:00:00.000Z",
    onlineNewCount: 1,
  });
  await renderPageTab(dom, client, "preview");
  await dom.waitFor(() => Boolean(dom.container.querySelector(".page-tab-new-count")));
  assert.equal(dom.container.querySelector(".page-tab-new-count")!.textContent, "1", "the Data badge counts new online entries, not test ones");
  await dom.cleanup();

  const data = await harness(t);
  await renderPageTab(data, client, "data");
  await data.waitFor(() => data.container.querySelectorAll(".page-data-grid-body [role=row]").length === 2);
  const choices = data.container.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Entries"]')!;
  assert.deepEqual([...choices.querySelectorAll('[role="radio"]')].map((item) => `${item.textContent}:${item.getAttribute("aria-checked")}`), ["Online Entries:true", "Test Entries:false"]);
  const note = () => data.container.querySelector(".page-data-note")!.textContent;
  assert.equal(note(), "Entries visitors made on the online page. Last checked in 2 minutes ago.");
  assert.ok(client.online.log.includes("data:rsvps:false"), "online entries come from the online routes");
  assert.ok(!client.log.includes("data:rsvps:false"), "test entries wait until asked for");

  await data.act(async () => { button(data.container, "Check Now")!.click(); });
  await data.waitFor(() => client.publishLog.includes(`check-in:${pagePath}`) && note() === "Entries visitors made on the online page. Last checked in just now.");
  await data.waitFor(() => client.online.log.filter((entry) => entry === "tables").length >= 2);

  // Online changes go to the online entries and never reach Preview's page.
  await data.act(() => { data.container.querySelector<HTMLElement>('[data-entry-id="o1"]')!.click(); });
  await data.act(async () => { button(data.container.querySelector(".page-data-detail")!, "Delete Entry")!.click(); });
  await data.waitFor(() => client.online.log.includes("remove:rsvps:o1"));
  assert.ok(!client.log.some((entry) => entry.startsWith("remove:")));

  await data.act(() => { button(choices, "Test Entries")!.click(); });
  await data.waitFor(() => data.container.querySelectorAll(".page-data-grid-body [role=row]").length === 3);
  assert.equal(note(), testEntriesNote);
  assert.equal(button(data.container, "Check Now"), undefined, "test entries never come from online");
  assert.equal(data.container.querySelector('[role="radiogroup"][aria-label="Entries"] [aria-checked="true"]')!.textContent, "Test Entries");
});

test("a page that was never online keeps the test entries label and no switch", async (t) => {
  const dom = await harness(t);
  const client = fakePagesClient({ rows: [pageRow("r1", "Maya", 2, null, "2026-11-04T09:00:00.000Z")] });
  await renderPageTab(dom, client, "data");
  await dom.waitFor(() => dom.container.querySelectorAll(".page-data-grid-body [role=row]").length === 1);
  assert.equal(dom.container.querySelector('[role="radiogroup"][aria-label="Entries"]'), null);
  assert.equal(dom.container.querySelector(".page-data-note")!.textContent, testEntriesNote);
});

test("the online label says when work-fold last checked in, and that an offline page keeps its entries", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  assert.equal(onlineEntriesNote({ ...onlinePublication, lastCheckIn: "2026-11-05T11:59:40.000Z" }, now), "Entries visitors made on the online page. Last checked in just now.");
  assert.equal(onlineEntriesNote({ ...onlinePublication, lastCheckIn: "2026-11-05T11:59:00.000Z" }, now), "Entries visitors made on the online page. Last checked in 1 minute ago.");
  assert.equal(onlineEntriesNote({ ...onlinePublication, status: "unpublished", lastCheckIn: "2026-11-05T09:00:00.000Z" }, now), "The page is offline. The entries visitors made are kept. Last checked in 3 hours ago.");
  assert.equal(onlineEntriesNote({ ...onlinePublication, lastCheckIn: null }, now), "Entries visitors made on the online page. Not checked in yet.");
  assert.match(pageTimeAgo("2026-11-03T12:00:00.000Z", now), /^on Nov 3/);
});

test("publish answers and refusals are read leniently", () => {
  assert.deepEqual(normalizePublishResult({ publication: onlinePublication, uploaded: { files: ["index.html", "style.css"], bytes: 1_024 } }).uploaded, { files: [{ path: "index.html", bytes: null }, { path: "style.css", bytes: null }], count: 2, bytes: 1_024 });
  assert.deepEqual(normalizePublishResult({ uploaded: { files: [{ path: "index.html", bytes: 10 }, { path: "a.png", size: 30 }] } }).uploaded, { files: [{ path: "index.html", bytes: 10 }, { path: "a.png", bytes: 30 }], count: 2, bytes: 40 });
  assert.deepEqual(normalizePublishResult({ uploaded: { files: 7, bytes: 900 } }).uploaded, { files: [], count: 7, bytes: 900 });
  // The link is null until work-fold hears where pages are served; the page is still published.
  assert.deepEqual(normalizePublication({ url: null, status: "online", revision: 1, publishedAt: "2026-11-05T14:00:00.000Z", changesAvailable: false, lastCheckIn: null, dataRevision: 0, entries: null }), { url: null, status: "online", revision: 1, publishedAt: "2026-11-05T14:00:00.000Z", changesAvailable: false, lastCheckIn: null, dataRevision: 0 });
  assert.equal(normalizePublication(null), null);
  const noAccess = pagePublishRefusalFrom({ error: "Set up web access in Settings to publish.", code: "WEB_ACCESS_REQUIRED" }, 409);
  assert.equal(noAccess.code, "WEB_ACCESS_REQUIRED");
  assert.equal(noAccess.message, "Set up web access in Settings to publish.");
  const invalid = pagePublishRefusalFrom({ code: "INVALID", problems: [{ file: "page.json", message: "title is required." }] }, 400);
  assert.deepEqual(invalid.problems, [{ file: "page.json", message: "title is required.", severity: "error" }]);
  assert.equal(invalid.message, pagePublishing.hasErrors);
});

test("Settings → Published lists pages by work-folder with their links, their tab, and Unpublish", async (t) => {
  const dom = await harness(t);
  const publishedPages: PublishedPage[] = [
    { workFolderId: "space-home", workFolderName: "Home", path: "Events/Garden Party RSVP", title: "Garden Party RSVP", url: onlinePublication.url, status: "online", publishedAt: "2026-11-04T09:00:00.000Z", changesAvailable: true },
    { workFolderId: "space-club", workFolderName: "Book Club", path: "Poll", title: "Next Book Poll", url: "https://pages.work-fold.com/p/pg_aaaaaaaaaaaaaaaaaaaaaaaaaa", status: "unpublished", publishedAt: "2026-10-01T09:00:00.000Z", changesAvailable: false },
    { workFolderId: "space-home", workFolderName: "Home", path: "Sign-up", title: "Bake Sale Sign-up", url: "https://pages.work-fold.com/p/pg_bbbbbbbbbbbbbbbbbbbbbbbbbb", status: "online", publishedAt: null, changesAvailable: false },
    { workFolderId: "space-gone", workFolderName: null, path: "Old Poll", title: "Old Poll", url: null, status: "online", publishedAt: null, changesAvailable: false },
  ];
  assert.deepEqual(groupPublishedPages(publishedPages).map((group) => [group.name, group.pages.map((page) => page.title)]), [["Home", ["Bake Sale Sign-up", "Garden Party RSVP"]], ["Book Club", ["Next Book Poll"]], ["Removed work-folder", ["Old Poll"]]]);
  const client = fakePagesClient({ publishedPages });
  const openedPages: string[][] = [];
  await dom.render(createElement("div", null, createElement(ToastHost), createElement(PublishedPagesPane, { client, onOpenPage: (workFolderId: string, path: string, title: string) => openedPages.push([workFolderId, path, title]) })));
  await dom.waitFor(() => dom.container.querySelectorAll(".published-page-row").length === 4);
  assert.deepEqual([...dom.container.querySelectorAll(".published-pages-work-folder")].map((item) => item.textContent), ["Home", "Book Club", "Removed work-folder"]);
  const rowFor = (title: string) => [...dom.container.querySelectorAll<HTMLElement>(".published-page-row")].find((item) => item.querySelector("strong")!.textContent === title)!;

  const garden = rowFor("Garden Party RSVP");
  assert.match(garden.querySelector(".published-page-facts")!.textContent!, /^OnlineChanges Not Published · Published /);
  assert.equal(garden.querySelector(".published-page-path")!.textContent, "Events/Garden Party RSVP");
  assert.deepEqual([...garden.querySelectorAll("button")].map((item) => item.textContent), ["Copy Link", "Open Link", "Open Page", "Unpublish"]);
  await dom.act(async () => { button(garden, "Copy Link")!.click(); });
  await dom.waitFor(() => dom.copied.length === 1);
  assert.deepEqual(dom.copied, [onlinePublication.url]);
  await dom.act(() => { button(garden, "Open Link")!.click(); });
  assert.deepEqual(dom.opened, [onlinePublication.url]);
  await dom.act(() => { button(garden, "Open Page")!.click(); });
  assert.deepEqual(openedPages, [["space-home", "Events/Garden Party RSVP", "Garden Party RSVP"]]);

  const poll = rowFor("Next Book Poll");
  assert.match(poll.querySelector(".published-page-facts")!.textContent!, /^Offline/);
  assert.deepEqual([...poll.querySelectorAll("button")].map((item) => item.textContent), ["Open Page"], "an offline page has no live link to share");
  assert.equal(dom.container.querySelector(".published-pages-note")!.textContent, publishedPagesSettings.unpublishedNote);
  const orphan = rowFor("Old Poll");
  assert.deepEqual([...orphan.querySelectorAll("button")].map((item) => item.textContent), ["Unpublish"], "no link yet, and no work-folder to open it in");
  assert.equal(orphan.querySelector(".published-page-path"), null, "a folder named like its page isn't repeated");

  await dom.act(async () => { button(garden, "Unpublish")!.click(); });
  await dom.waitFor(() => client.publishLog.includes("unpublish:Events/Garden Party RSVP") && client.publishLog.filter((entry) => entry === "published").length === 2);
  assert.match(dom.container.querySelector(".toast-stack")!.textContent!, /Its entries are kept/);
  await dom.cleanup();

  const empty = await harness(t);
  await empty.render(createElement(PublishedPagesPane, { client: fakePagesClient({ publishedPages: [] }) }));
  await empty.waitFor(() => Boolean(empty.container.querySelector(".published-pages-empty")));
  assert.equal(empty.container.querySelector(".published-pages-empty h3")!.textContent, "Nothing Is Published Yet");
  assert.match(empty.container.querySelector(".published-pages-empty p")!.textContent!, /Ask a Worker to make a page/);
});

test("Files shows a page folder's data.sqlite as Data, which opens the page's Data view", async (t) => {
  const dom = await harness(t);
  const entries: TreeEntry[] = [
    { kind: "folder", path: pagePath, name: "Garden Party RSVP", hasChildren: true, children: [
      { kind: "file", path: `${pagePath}/data.sqlite`, name: "data.sqlite" },
      { kind: "file", path: `${pagePath}/index.html`, name: "index.html" },
    ] },
    { kind: "folder", path: "Backups", name: "Backups", hasChildren: true, children: [{ kind: "file", path: "Backups/data.sqlite", name: "data.sqlite" }] },
  ];
  const openedData: string[][] = [];
  const files: string[] = [];
  const osOpened: string[] = [];
  await dom.render(createElement(FileTree, {
    entries, collapsedPaths: new Set<string>(), loadingFolderPaths: new Set<string>(), dropTargetFolderPath: null,
    pageFolders: new Map([[pagePath, { title: "Garden Party RSVP" }]]),
    onOpenPage() {},
    onOpenPageData: (page: string, path: string) => openedData.push([page, path]),
    onToggleFolder() {}, onSelectFile: (path: string) => files.push(path), onOpenFile: (path: string) => osOpened.push(path), onOpenContextMenu() {},
    onUpdateDropTarget() {}, onDropOnTarget() {}, onDragStartEntry() {}, onDragEndEntry() {},
  }));
  const row = dom.container.querySelector<HTMLButtonElement>(`[data-tree-path="${pagePath}/data.sqlite"]`)!;
  assert.equal(row.dataset.pageData, "true");
  assert.equal(row.querySelector(".file-name")!.textContent, "Data");
  assert.equal(row.getAttribute("aria-label"), "Data, entries for Garden Party RSVP");
  assert.ok(row.querySelector(".page-data-file-icon svg"), "a data icon instead of a file icon");
  await dom.act(() => { row.click(); });
  assert.deepEqual(openedData, [[pagePath, `${pagePath}/data.sqlite`]]);
  assert.deepEqual(files, [], "never the raw file");
  await dom.act(() => { row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  assert.deepEqual(osOpened, [], "double-click doesn't hand the database to another app");
  row.focus();
  await dom.press("Enter");
  assert.equal(openedData.length, 2, "Enter opens the Data view too");

  const plain = dom.container.querySelector<HTMLButtonElement>('[data-tree-path="Backups/data.sqlite"]')!;
  assert.equal(plain.dataset.pageData, undefined, "outside a page folder it's an ordinary file");
  assert.equal(plain.querySelector(".file-name")!.textContent, "data.sqlite");
  await dom.act(() => { plain.click(); });
  assert.deepEqual(files, ["Backups/data.sqlite"]);

  const app = await readFile(join(process.cwd(), "web-local/src/App.tsx"), "utf8");
  assert.match(app, /onOpenPageData=\{\(pagePath, path\) => \{ tree\.setSelectedPath\(path\); tabs\.openPageSurfaceTab\(workFolder, pagePath, pageFolders\.get\(pagePath\)\?\.title, "data"\); \}\}/);
  assert.match(app, /onOpenWebAccessSettings=\{\(\) => onOpenSettings\("web-access"\)\}/);
});

test("checking in rewrites data.sqlite, which reloads online entries but never the page", () => {
  assert.equal(pageDataFileChange({ path: `${pagePath}/data.sqlite` }, pagePath), true);
  assert.equal(pageDataFileChange({ path: `${pagePath}/Data.sqlite` }, pagePath), true);
  assert.equal(pageDataFileChange({ path: `${pagePath}/index.html` }, pagePath), false);
  assert.equal(pageDataFileChange({ path: `${pagePath}/images/data.sqlite` }, pagePath), false);
  assert.equal(pageDataFileChange({ path: null }, pagePath), false);
});

test("the browser preview's page is online, with online entries and a Published list", async (t) => {
  await harness(t);
  const client = createFixturePagesClient();
  const state = await client.publication("fixture-home", "Garden Party RSVP");
  assert.equal(state.available, true);
  assert.equal(state.publication?.status, "online");
  assert.equal(state.publication?.changesAvailable, true, "Publish Changes shows in the preview");
  const online = await client.online.tables("fixture-home", "Garden Party RSVP");
  const test = await client.tables("fixture-home", "Garden Party RSVP");
  assert.ok(online[0]!.live > test[0]!.live, "real visitors' entries, apart from the test entries");
  assert.ok(online[0]!.newCount > 0);
  const published = await client.published();
  assert.deepEqual(published.map((page) => [page.workFolderName, page.title, page.status]), [["Home projects", "Garden Party RSVP", "online"]]);
  await client.unpublish("fixture-home", "Garden Party RSVP");
  assert.equal((await client.published())[0]!.status, "unpublished", "the page tab and Settings share one page");
  const fixtureSource = await readFile(join(process.cwd(), "web-local/src/fixtures/work-folder-fixture.ts"), "utf8");
  assert.match(fixtureSource, /path: "Garden Party RSVP\/data\.sqlite"/, "Files shows the published page's Data");
});

test("an online page whose link isn't known yet shows no link controls and says so after publishing", async (t) => {
  const dom = await harness(t);
  const publication = { ...onlinePublication, url: null, changesAvailable: true };
  const client = fakePagesClient({
    publication,
    publish: async () => ({ publication: { ...publication, changesAvailable: false }, uploaded: { files: [{ path: "index.html", bytes: 10 }], count: 1, bytes: 10 } }),
  });
  await renderPageTab(dom, client, "preview");
  await dom.waitFor(() => Boolean(header(dom).querySelector(".page-publish-status.online")));
  assert.equal(button(header(dom), "Copy Link"), undefined);
  assert.equal(button(header(dom), "Open"), undefined);
  await dom.act(async () => { button(header(dom), "Publish Changes")!.click(); });
  await dom.waitFor(() => panel(dom)?.dataset.phase === "published");
  assert.equal(panel(dom)!.querySelector(".page-publish-link"), null);
  assert.match(panel(dom)!.textContent!, /The link shows here once work-fold hears back from the online service\./);
  assert.equal(panel(dom)!.querySelector(".page-publish-uploaded > p")!.textContent, "Uploaded 1 file · 10 B");
});
