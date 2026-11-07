import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import React, { createElement } from "react";

import { createDomHarness, type DomHarness } from "./support/dom.js";
import {
  closeFileSurfaceTabs,
  normalizeStoredSurfaceTabsValue,
  pageSurfaceTab,
  retargetFileSurfaceTabs,
} from "../web-local/src/hooks/useSurfaceTabs.js";
import { declaredTables } from "../web-local/src/lib/pages.js";
import { fakePagesClient, pageRow, type FakePagesClient } from "./support/fake-pages-client.js";
import { filterGridEntries, gridColumns, gridEntries, nextSort, sortGridEntries } from "../web-local/src/lib/page-data-grid.js";
import type { TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";

const assets = registerHooks({
  load(url, context, next) { return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context); },
});
const { FileTree } = await import("../web-local/src/components/tree/FileTree.js");
const { PageTab, pageFileChange } = await import("../web-local/src/components/pages/PageTab.js");
const { pageListChange } = await import("../web-local/src/hooks/useWorkFolderPages.js");
const { testEntriesNote } = await import("../web-local/src/components/pages/PageDataView.js");
assets.deregister();

const workFolder = { id: "space-0123456789abcdef", name: "Home", workFolderRoot: "/tmp/home", location: { kind: "local", storage: "linked" } } as WorkFolderSummary;
const pagePath = "Events/Garden Party RSVP";

test("page tabs restore with their view, follow a moved folder, and close with it", () => {
  const tab = pageSurfaceTab(workFolder, pagePath, "Garden Party RSVP");
  assert.deepEqual(tab, { id: `page:${workFolder.id}:${pagePath}`, kind: "page", workFolderId: workFolder.id, path: pagePath, title: "Garden Party RSVP" });
  assert.equal(pageSurfaceTab(workFolder, pagePath).title, "Garden Party RSVP", "the folder's name until page.json is read");
  const restored = normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "anything", kind: "page", workFolderId: workFolder.id, path: pagePath, title: "Garden Party RSVP", view: "data" },
      { id: "page-2", kind: "page", workFolderId: workFolder.id, path: "Sign-up", title: "", view: "spreadsheet" },
      { id: "escape", kind: "page", workFolderId: workFolder.id, path: "../Elsewhere", title: "x" },
      { id: "absolute", kind: "page", workFolderId: workFolder.id, path: "/etc", title: "x" },
      { id: "empty", kind: "page", workFolderId: workFolder.id, path: "", title: "x" },
    ],
    activeTabId: "anything",
  });
  assert.deepEqual(restored, {
    tabs: [
      { id: `page:${workFolder.id}:${pagePath}`, kind: "page", workFolderId: workFolder.id, path: pagePath, title: "Garden Party RSVP", view: "data" },
      { id: `page:${workFolder.id}:Sign-up`, kind: "page", workFolderId: workFolder.id, path: "Sign-up", title: "Sign-up" },
    ],
    activeTabId: `page:${workFolder.id}:${pagePath}`,
  });
  const moved = retargetFileSurfaceTabs(restored.tabs, workFolder.id, "Events", "Parties");
  assert.equal(moved[0]!.id, `page:${workFolder.id}:Parties/Garden Party RSVP`);
  assert.equal((moved[0] as { path: string }).path, "Parties/Garden Party RSVP");
  assert.equal(moved[0]!.title, "Garden Party RSVP", "a moved page keeps its title");
  assert.deepEqual(closeFileSurfaceTabs(moved, workFolder.id, new Set(["Parties/Garden Party RSVP"])).map((item) => item.id), [`page:${workFolder.id}:Sign-up`]);
});

async function harness(t: TestContext): Promise<DomHarness> {
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  return dom;
}

test("Files shows a page folder with a page icon; the row opens its page and the arrow opens the folder", async (t) => {
  const dom = await harness(t);
  const entries: TreeEntry[] = [
    { kind: "folder", path: "Events", name: "Events", hasChildren: true, children: [
      { kind: "folder", path: pagePath, name: "Garden Party RSVP", hasChildren: true, children: [{ kind: "file", path: `${pagePath}/index.html`, name: "index.html" }] },
    ] },
    { kind: "folder", path: "Notes", name: "Notes", hasChildren: true, children: [] },
  ];
  const opened: string[] = [];
  const toggled: string[] = [];
  const files: string[] = [];
  let collapsed = new Set<string>([pagePath]);
  const render = () => dom.render(createElement(FileTree, {
    entries, collapsedPaths: collapsed, loadingFolderPaths: new Set<string>(), dropTargetFolderPath: null,
    pageFolders: new Map([[pagePath, { title: "Garden Party RSVP" }]]),
    onOpenPage: (path: string) => opened.push(path),
    onToggleFolder: (path: string) => { toggled.push(path); collapsed = new Set([...collapsed].filter((item) => item !== path)); },
    onSelectFile: (path: string) => files.push(path), onOpenFile() {}, onOpenContextMenu() {},
    onUpdateDropTarget() {}, onDropOnTarget() {}, onDragStartEntry() {}, onDragEndEntry() {},
  }));
  await render();
  const row = dom.container.querySelector<HTMLButtonElement>(`[data-tree-path="${pagePath}"]`)!;
  assert.equal(row.dataset.pageFolder, "true");
  assert.equal(row.getAttribute("aria-label"), "Garden Party RSVP, page");
  assert.equal(row.title, "Page: Garden Party RSVP");
  assert.ok(row.querySelector(".page-folder-icon svg"), "a page icon instead of a folder");
  assert.equal(dom.container.querySelector('[data-tree-path="Notes"]')!.getAttribute("data-page-folder"), null, "ordinary folders stay folders");

  await dom.act(() => { row.click(); });
  assert.deepEqual(opened, [pagePath]);
  assert.deepEqual(toggled, [], "a plain click opens the page, not the folder");
  await dom.act(() => { row.querySelector(".folder-chevron")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(toggled, [pagePath], "the arrow still opens the folder");
  await render();
  assert.ok(dom.container.querySelector(`[data-tree-path="${pagePath}/index.html"]`), "its files stay browsable");
  row.focus();
  await dom.press("Enter");
  assert.deepEqual(opened, [pagePath, pagePath], "Enter opens the page");
  await dom.act(() => { dom.container.querySelector<HTMLButtonElement>('[data-tree-path="Notes"]')!.click(); });
  assert.deepEqual(toggled, [pagePath, "Notes"], "other folders open as before");
});

type FakeClient = FakePagesClient;
const fakeClient = fakePagesClient;
const row = pageRow;

async function renderPageTab(dom: DomHarness, client: FakeClient, view: "preview" | "data") {
  const changes: { views: string[]; titles: string[] } = { views: [], titles: [] };
  await dom.render(createElement(PageTab, {
    workFolder, path: pagePath, title: "Garden Party RSVP", view, active: true, fixtureMode: true, client,
    onViewChange: (next: string) => changes.views.push(next),
    onTitleChange: (title: string) => changes.titles.push(title),
  }));
  await dom.settle();
  return changes;
}

function frameMessages(frame: HTMLIFrameElement) {
  const sent: any[] = [];
  (frame.contentWindow as any).postMessage = (message: unknown) => sent.push(message);
  window.dispatchEvent(new (window as any).MessageEvent("message", { data: { type: "work-fold.page.ready" }, source: frame.contentWindow }));
  return sent;
}

test("Preview runs the page as a visitor, as the owner, or as a new visitor", async (t) => {
  const dom = await harness(t);
  const client = fakeClient();
  const changes = await renderPageTab(dom, client, "preview");
  await dom.waitFor(() => Boolean(dom.container.querySelector(".page-preview-frame")));
  const radios = [...dom.container.querySelectorAll<HTMLButtonElement>(".page-segmented [role=radio]")];
  assert.deepEqual(radios.map((item) => `${item.textContent}:${item.getAttribute("aria-checked")}`), ["Visitor:true", "Owner:false"]);
  assert.match(dom.container.querySelector(".page-preview-bar")!.textContent!, /Viewing As/);
  assert.ok([...dom.container.querySelectorAll("button")].some((button) => button.textContent === "New Visitor"));
  assert.deepEqual(client.log.slice(0, 3).sort(), ["document", "inspect", "visitor:false"].sort());
  assert.deepEqual(changes.titles, [], "the tab already has the page's title");

  let frame = dom.container.querySelector<HTMLIFrameElement>(".page-preview-frame")!;
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms");
  let init = frameMessages(frame)[0];
  assert.equal(init.type, "work-fold.page.init");
  assert.equal(init.owner, false);
  assert.deepEqual(init.tables, { rsvps: { name: "text", guests: "number", bringing: "choice" } });
  window.dispatchEvent(new (window as any).MessageEvent("message", { data: { type: "work-fold.page.call", channel: init.channel, callId: 1, call: { op: "mine", table: "rsvps" } }, source: frame.contentWindow }));
  await dom.waitFor(() => client.calls.length === 1);
  assert.deepEqual(client.calls[0], { viewer: { role: "visitor", visitor: "v_visitor00000001" }, call: { op: "mine", table: "rsvps" } });

  await dom.act(() => { radios[1]!.click(); });
  await dom.waitFor(() => dom.container.querySelector(".page-preview-frame") !== frame && Boolean(dom.container.querySelector(".page-preview-frame")));
  frame = dom.container.querySelector<HTMLIFrameElement>(".page-preview-frame")!;
  init = frameMessages(frame)[0];
  assert.equal(init.owner, true, "the page sees the owner");
  window.dispatchEvent(new (window as any).MessageEvent("message", { data: { type: "work-fold.page.call", channel: init.channel, callId: 1, call: { op: "count", table: "rsvps" } }, source: frame.contentWindow }));
  await dom.waitFor(() => client.calls.length === 2);
  assert.deepEqual(client.calls[1]!.viewer, { role: "owner" });

  const newVisitor = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New Visitor")!;
  await dom.act(async () => { newVisitor.click(); });
  await dom.waitFor(() => client.log.includes("visitor:true") && dom.container.querySelector(".page-segmented [aria-checked=true]")?.textContent === "Visitor");
  await dom.waitFor(() => dom.container.querySelector(".page-preview-frame") !== frame && Boolean(dom.container.querySelector(".page-preview-frame")));
  frame = dom.container.querySelector<HTMLIFrameElement>(".page-preview-frame")!;
  init = frameMessages(frame)[0];
  window.dispatchEvent(new (window as any).MessageEvent("message", { data: { type: "work-fold.page.call", channel: init.channel, callId: 1, call: { op: "mine", table: "rsvps" } }, source: frame.contentWindow }));
  await dom.waitFor(() => client.calls.length === 3);
  assert.deepEqual(client.calls[2]!.viewer, { role: "visitor", visitor: "v_visitor00000002" }, "a new visitor sees none of the last one's entries");
});

test("a page that saves nothing has no Data view", async (t) => {
  const dom = await harness(t);
  const client = fakeClient({ noTables: true });
  const changes = await renderPageTab(dom, client, "data");
  await dom.waitFor(() => Boolean(dom.container.querySelector(".page-preview-frame")));
  await dom.waitFor(() => changes.views.includes("preview"));
  assert.equal(dom.container.querySelector('[role="tablist"]'), null, "no Preview/Data switch");
  assert.equal([...dom.container.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Data")), false);
  const panel = dom.container.querySelector(".page-preview-frame")!.closest(".page-tab-panel")!;
  assert.equal(panel.hasAttribute("hidden"), false, "the preview stays visible");
  assert.equal(panel.getAttribute("role"), null, "no tab panel without tabs");
});

test("problems show as a list in place of a page that can't be put together", async (t) => {
  const dom = await harness(t);
  const client = fakeClient({ html: null, problems: [
    { file: "page.json", message: "title is required.", severity: "error" },
    { file: "index.html", message: "https://cdn.example.com/x.js is outside the page folder.", severity: "error" },
    { file: "notes.html", message: "Only index.html is the page.", severity: "warning" },
  ] });
  await renderPageTab(dom, client, "preview");
  await dom.waitFor(() => Boolean(dom.container.querySelector(".page-problems")));
  assert.equal(dom.container.querySelector(".page-preview-frame"), null, "no broken page");
  const problems = dom.container.querySelector(".page-problems")!;
  assert.match(problems.textContent!, /This Page Has Problems/);
  assert.deepEqual([...problems.querySelectorAll("li")].map((item) => item.textContent), ["page.jsontitle is required.", "index.htmlhttps://cdn.example.com/x.js is outside the page folder."]);

  await dom.cleanup();
  const again = await harness(t);
  const warned = fakeClient({ problems: [{ file: "notes.html", message: "Only index.html is the page.", severity: "warning" }] });
  await renderPageTab(again, warned, "preview");
  await again.waitFor(() => Boolean(again.container.querySelector(".page-preview-frame")));
  const notes = [...again.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "1 Note")!;
  assert.equal(notes.getAttribute("aria-expanded"), "false", "a page that runs keeps its notes folded away");
  await again.act(() => { notes.click(); });
  assert.match(again.container.querySelector(".page-preview-notes")!.textContent!, /Only index\.html is the page\./);
});

test("the Data view sorts, searches, filters, edits, deletes, restores, and exports test entries", async (t) => {
  const dom = await harness(t);
  const client = fakeClient({
    lastSeen: "2026-11-05T10:00:00.000Z",
    rows: [
      row("r3", "Priya", 3, "Salad", "2026-11-05T11:30:00.000Z"),
      row("r2", "Oliver", 0, "Drinks", "2026-11-05T11:00:00.000Z"),
      row("r1", "Maya", 2, null, "2026-11-04T09:00:00.000Z"),
    ],
  });
  const downloads: string[] = [];
  (window as any).HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push(this.download); };
  await renderPageTab(dom, client, "data");
  await dom.waitFor(() => dom.container.querySelectorAll(".page-data-grid-body [role=row]").length === 3);
  assert.equal(dom.container.querySelector(".page-data-note")!.textContent, testEntriesNote);
  assert.equal(testEntriesNote, "Entries made in Preview. Only you can see them.");
  const names = () => [...dom.container.querySelectorAll(".page-data-grid-body [role=row]")].sort((a, b) => Number(a.getAttribute("aria-rowindex")) - Number(b.getAttribute("aria-rowindex"))).map((item) => item.querySelectorAll("[role=gridcell]")[1]!.textContent);
  assert.deepEqual(names(), ["Priya", "Oliver", "Maya"], "newest first");
  assert.deepEqual([...dom.container.querySelectorAll(".page-data-grid-body .new")].map((item) => item.getAttribute("data-entry-id")).sort(), ["r2", "r3"], "what's new since last looked is marked");
  assert.match(dom.container.querySelector(".page-data-summary")!.textContent!, /^3 entries · 2 new$/);
  assert.deepEqual([...dom.container.querySelectorAll(".page-data-header-row [role=columnheader]")].slice(1).map((item) => item.textContent), ["Name", "Guests", "Bringing", "Phone", "Added"], "retired columns still show; Changed and Visitor start hidden");
  await dom.waitFor(() => client.log.includes("seen:rsvps"), 3_000);

  const header = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-header-cell button")].find((button) => button.textContent === label)!;
  await dom.act(() => { header("Guests").click(); });
  assert.deepEqual(names(), ["Oliver", "Maya", "Priya"]);
  assert.equal(header("Guests").closest("[role=columnheader]")!.getAttribute("aria-sort"), "ascending");
  await dom.act(() => { header("Guests").click(); });
  assert.deepEqual(names(), ["Priya", "Maya", "Oliver"]);

  const search = dom.container.querySelector<HTMLInputElement>(".page-data-search input")!;
  await type(dom, search, "may");
  assert.deepEqual(names(), ["Maya"]);
  assert.match(dom.container.querySelector(".page-data-summary")!.textContent!, /^Showing 1 of 3 entries/);
  await type(dom, search, "");

  const filters = [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-toolbar button")].find((button) => button.textContent?.startsWith("Filters"))!;
  await dom.act(() => { filters.click(); });
  const bringing = dom.container.querySelector<HTMLSelectElement>('select[aria-label="Filter Bringing"]')!;
  assert.deepEqual([...bringing.options].map((option) => option.textContent), ["Any", "Salad", "Dessert", "Drinks", "Empty"]);
  await select(dom, bringing, "Drinks");
  assert.deepEqual(names(), ["Oliver"]);
  await select(dom, bringing, "(empty)");
  assert.deepEqual(names(), ["Maya"]);
  await select(dom, bringing, "");
  await type(dom, dom.container.querySelector<HTMLInputElement>('input[aria-label="Filter Guests"]')!, "> 1");
  assert.deepEqual(names(), ["Priya", "Maya"]);
  await type(dom, dom.container.querySelector<HTMLInputElement>('input[aria-label="Filter Guests"]')!, "");

  const columnsButton = [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-toolbar button")].find((button) => button.textContent === "Columns")!;
  await dom.act(() => { columnsButton.click(); });
  const phone = [...dom.container.querySelectorAll<HTMLLabelElement>(".page-data-columns-menu label")].find((label) => label.textContent?.startsWith("Phone"))!;
  assert.match(phone.textContent!, /No longer collected/);
  await dom.act(() => { phone.querySelector("input")!.click(); });
  assert.ok(![...dom.container.querySelectorAll(".page-data-header-row [role=columnheader]")].some((item) => item.textContent === "Phone"), "a column can be hidden");

  // One entry, and a fix to one value.
  await dom.act(() => { dom.container.querySelector<HTMLElement>('[data-entry-id="r1"]')!.click(); });
  const detail = dom.container.querySelector(".page-data-detail")!;
  assert.equal(detail.querySelector("h3")!.textContent, "Maya");
  assert.equal(detail.querySelector('button[aria-label="Edit Phone"]'), null, "a value nothing collects any more can't be edited");
  await dom.act(() => { detail.querySelector<HTMLButtonElement>('button[aria-label="Edit Guests"]')!.click(); });
  await type(dom, detail.querySelector<HTMLInputElement>(".page-data-editor input")!, "4");
  await dom.act(async () => { [...detail.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!.click(); });
  await dom.waitFor(() => client.log.includes('update:rsvps:r1:{"guests":4}'));

  // Deleting moves the entry to Deleted, where it can be restored.
  await dom.act(async () => { [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-detail button")].find((button) => button.textContent === "Delete Entry")!.click(); });
  await dom.waitFor(() => client.log.includes("remove:rsvps:r1") && dom.container.querySelectorAll(".page-data-grid-body [role=row]").length === 2);
  const deletedToggle = () => [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-toolbar button")].find((button) => /^Deleted|^Back to Entries/.test(button.textContent ?? ""))!;
  await dom.waitFor(() => deletedToggle().textContent === "Deleted1");
  await dom.act(() => { deletedToggle().click(); });
  await dom.waitFor(() => client.log.includes("data:rsvps:true") && dom.container.querySelectorAll(".page-data-grid-body [role=row]").length === 1);
  assert.match(dom.container.querySelector(".page-data-summary")!.textContent!, /1 deleted entry · kept for 30 days/);
  assert.ok([...dom.container.querySelectorAll(".page-data-header-row [role=columnheader]")].some((item) => item.textContent === "Deleted"));
  await dom.act(() => { dom.container.querySelector<HTMLElement>('[data-entry-id="r1"]')!.click(); });
  await dom.act(async () => { [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-detail button")].find((button) => button.textContent === "Restore Entry")!.click(); });
  await dom.waitFor(() => client.log.includes("restore:rsvps:r1"));
  await dom.act(() => { deletedToggle().click(); });
  await dom.waitFor(() => dom.container.querySelectorAll(".page-data-grid-body [role=row]").length === 3);

  // Several at once.
  const checks = [...dom.container.querySelectorAll<HTMLInputElement>(".page-data-grid-body input[type=checkbox]")];
  await dom.act(() => { checks[0]!.click(); checks[1]!.click(); });
  const bulk = [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-toolbar button")].find((button) => button.textContent === "Delete 2")!;
  assert.ok(bulk, "checked entries can be deleted together");

  const exportButton = [...dom.container.querySelectorAll<HTMLButtonElement>(".page-data-toolbar button")].find((button) => button.getAttribute("aria-label") === "Export as Spreadsheet")!;
  await dom.act(async () => { exportButton.click(); });
  await dom.waitFor(() => downloads.length === 1);
  assert.ok(client.log.includes("export:rsvps"));
  assert.deepEqual(downloads, ["Garden Party RSVP.csv"]);
});

test("a few thousand entries render as a window of rows and filter quickly", async (t) => {
  const many = Array.from({ length: 4_000 }, (_, index) => row(`r${index}`, `Guest ${index}`, index % 11, ["Salad", "Dessert", "Drinks"][index % 3]!, new Date(Date.UTC(2026, 10, 1) + index * 60_000).toISOString()));
  const columns = gridColumns([{ name: "name", type: "text" }, { name: "guests", type: "number" }, { name: "bringing", type: "choice", options: ["Salad", "Dessert", "Drinks"] }]);
  const started = performance.now();
  const entries = gridEntries(many, columns);
  const filtered = filterGridEntries(entries, columns, "guest 1", { bringing: "Drinks", guests: ">= 5" });
  const sorted = sortGridEntries(filtered, columns, nextSort(null, "guests"));
  assert.ok(sorted.length > 0 && sorted.every((entry) => entry.row.bringing === "Drinks" && (entry.row.guests as number) >= 5));
  assert.ok(sorted.every((entry, index) => index === 0 || (entry.row.guests as number) >= (sorted[index - 1]!.row.guests as number)));
  assert.ok(performance.now() - started < 1_000, "filtering and sorting stay instant");

  const dom = await harness(t);
  const client = fakeClient({ rows: many });
  await renderPageTab(dom, client, "data");
  await dom.waitFor(() => dom.container.querySelectorAll(".page-data-grid-body [role=row]").length > 0);
  const rendered = dom.container.querySelectorAll(".page-data-grid-body [role=row]").length;
  assert.ok(rendered < 80, `only the rows in view render (${rendered})`);
  assert.equal(dom.container.querySelector(".page-data-grid")!.getAttribute("aria-rowcount"), String(4_000 + 1));
  assert.equal(dom.container.querySelector<HTMLElement>(".page-data-grid-body")!.style.height, `${4_000 * 32}px`);
});

test("only changes that can matter reload a page or Files' page list", () => {
  assert.equal(pageFileChange({ path: `${pagePath}/index.html` }, pagePath), true);
  assert.equal(pageFileChange({ path: `${pagePath}/images/cake.png` }, pagePath), true);
  assert.equal(pageFileChange({ path: "Events" }, pagePath), true, "a folder above it moved");
  assert.equal(pageFileChange({ path: null }, pagePath), true);
  assert.equal(pageFileChange({ path: `${pagePath}/data.sqlite-wal` }, pagePath), false, "the page's data file isn't part of the page");
  assert.equal(pageFileChange({ path: `${pagePath}/.work-fold/x.json` }, pagePath), false);
  assert.equal(pageFileChange({ path: `${pagePath} 2/index.html` }, pagePath), false);
  assert.equal(pageFileChange({ path: "Notes/todo.md" }, pagePath), false);
  assert.equal(pageListChange(`${pagePath}/page.json`), true);
  assert.equal(pageListChange("New Page"), true, "a folder appeared or moved");
  assert.equal(pageListChange(`${pagePath}/index.html`), false);
  assert.equal(pageListChange(null), true);
});

test("declared tables are read from the inspection in page.json's order", () => {
  assert.deepEqual(declaredTables({ page: { path: "p", title: "P", tables: [
    { name: "rsvps", columns: [{ name: "name", type: "text" }, { name: "guests", type: "number" }] },
    { name: "votes", columns: [{ name: "choice", type: "choice", options: ["A"] }] },
  ] }, problems: [] }), [{ name: "rsvps", columns: { name: "text", guests: "number" } }, { name: "votes", columns: { choice: "choice" } }]);
  assert.deepEqual(declaredTables({ page: null, problems: [] }), []);
});

test("page styles use the shell's type scale, control heights, and arrow pointer", async () => {
  const css = await readFile(join(process.cwd(), "web-local/src/components/pages/pages.css"), "utf8");
  for (const match of css.matchAll(/font-size:\s*([^;]+);/g)) assert.match(match[1]!, /^var\(--work-fold-type-/, `font-size ${match[1]} is off the type scale`);
  assert.doesNotMatch(css, /cursor:\s*pointer/);
  assert.doesNotMatch(css, /font-weight:\s*(?:[89]00|bold)/);
  const main = await readFile(join(process.cwd(), "web-local/src/main.tsx"), "utf8");
  assert.match(main, /import "\.\/components\/pages\/pages\.css";/);
  const index = await readFile(join(process.cwd(), "web-local/index.html"), "utf8");
  assert.match(index, /frame-src 'self' blob: http:\/\/127\.0\.0\.1:\*\/page-frame\.html;/, "the renderer may frame only the page intermediary from the local API");
});

async function type(dom: DomHarness, input: HTMLInputElement, value: string) {
  await dom.act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function select(dom: DomHarness, element: HTMLSelectElement, value: string) {
  await dom.act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
