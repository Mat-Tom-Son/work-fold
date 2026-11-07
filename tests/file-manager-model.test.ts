import assert from "node:assert/strict";
import test from "node:test";

import {
  fileKindLabel,
  collapseCrumbs,
  fileManagerPathBar,
  fileManagerIcon,
  fileManagerStatusText,
  fileManagerSuggestions,
  formatFileManagerDate,
  historyDay,
  historyTimeLabel,
  nativePathParts,
  nextFileManagerSort,
  normalizeFileManagerSort,
  normalizeFileManagerView,
  parentPath,
  rangeSelection,
  sortFileManagerEntries,
  typeSelectMatch,
} from "../web-local/src/components/file-manager/file-manager-model.js";
import {
  placeApiBase,
  placeEventsUrl,
  sameLocation,
  sidebarStandardFolders,
} from "../web-local/src/components/file-manager/file-manager-places.js";
import { normalizeAppLayout } from "../web-local/src/lib/app-layout.js";
import type { TreeEntry } from "../web-local/src/types.js";

const file = (name: string, sizeBytes: number, updatedAt: string): TreeEntry => ({ name, path: name, kind: "file", sizeBytes, updatedAt });
const folder = (name: string, updatedAt?: string): TreeEntry => ({ name, path: name, kind: "folder", ...(updatedAt ? { updatedAt } : {}) });
const names = (entries: TreeEntry[]) => entries.map((entry) => entry.name);

const listing: TreeEntry[] = [
  file("10 - notes.md", 300, "2026-10-01T00:00:00Z"),
  folder("Receipts", "2026-09-01T00:00:00Z"),
  file("2 - plan.txt", 9000, "2026-10-05T00:00:00Z"),
  folder("Archive", "2026-10-09T00:00:00Z"),
  file("budget.xlsx", 20, "2026-09-20T00:00:00Z"),
];

test("name order mixes folders and files the way Finder does, numbers naturally", () => {
  assert.deepEqual(names(sortFileManagerEntries(listing, { key: "name", ascending: true })), ["2 - plan.txt", "10 - notes.md", "Archive", "budget.xlsx", "Receipts"]);
  assert.deepEqual(names(sortFileManagerEntries(listing, { key: "name", ascending: false })), ["Receipts", "budget.xlsx", "Archive", "10 - notes.md", "2 - plan.txt"]);
});

test("date, size, and kind order whole rows, and a new column starts as Finder does", () => {
  assert.deepEqual(names(sortFileManagerEntries(listing, { key: "modified", ascending: false })), ["Archive", "2 - plan.txt", "10 - notes.md", "budget.xlsx", "Receipts"]);
  assert.deepEqual(names(sortFileManagerEntries(listing, { key: "size", ascending: false })), ["2 - plan.txt", "10 - notes.md", "budget.xlsx", "Archive", "Receipts"]);
  assert.deepEqual(names(sortFileManagerEntries(listing, { key: "kind", ascending: true })), ["budget.xlsx", "Archive", "Receipts", "10 - notes.md", "2 - plan.txt"]);
  assert.deepEqual(nextFileManagerSort({ key: "name", ascending: true }, "name"), { key: "name", ascending: false });
  assert.deepEqual(nextFileManagerSort({ key: "name", ascending: true }, "modified"), { key: "modified", ascending: false });
  assert.deepEqual(nextFileManagerSort({ key: "modified", ascending: false }, "kind"), { key: "kind", ascending: true });
});

test("stored view choices fall back to safe defaults", () => {
  assert.deepEqual(normalizeFileManagerSort({ key: "size", ascending: false }), { key: "size", ascending: false });
  assert.deepEqual(normalizeFileManagerSort({ key: "color" }), { key: "name", ascending: true });
  assert.deepEqual(normalizeFileManagerSort(null), { key: "name", ascending: true });
  assert.equal(normalizeFileManagerView("icons"), "icons");
  assert.equal(normalizeFileManagerView("columns"), "list");
  assert.equal(normalizeAppLayout("file-manager"), "file-manager");
  assert.equal(normalizeAppLayout("anything else"), "classic");
});

test("kinds and icons read like Finder's", () => {
  assert.equal(fileKindLabel(folder("Photos")), "Folder");
  assert.equal(fileKindLabel(file("Quote.PDF", 1, "")), "PDF document");
  assert.equal(fileKindLabel(file("budget.xlsx", 1, "")), "Excel spreadsheet");
  assert.equal(fileKindLabel(file("archive.weird", 1, "")), "WEIRD file");
  assert.equal(fileKindLabel(file("Makefile", 1, "")), "Document");
  assert.deepEqual(fileManagerIcon(folder("Photos")), { className: "fm-ic fm-ic-folder", label: "" });
  assert.deepEqual(fileManagerIcon(file("Quote.pdf", 1, "")), { className: "fm-ic fm-ic-doc fm-tag-pdf", label: "PDF" });
  assert.deepEqual(fileManagerIcon(file("notes.md", 1, "")), { className: "fm-ic fm-ic-doc", label: "MD" });
  assert.deepEqual(fileManagerIcon(file("tile.JPG", 1, "")), { className: "fm-ic fm-ic-img", label: "" });
  assert.deepEqual(fileManagerIcon(file("installer.dmg", 1, "")), { className: "fm-ic fm-ic-box", label: "" });
});

test("dates say Today and Yesterday the way Finder's list does", () => {
  const now = new Date(2026, 10, 6, 10, 56);
  assert.match(formatFileManagerDate(new Date(2026, 10, 6, 9, 12).toISOString(), now), /^Today at /);
  assert.match(formatFileManagerDate(new Date(2026, 10, 5, 15, 40).toISOString(), now), /^Yesterday at /);
  assert.match(formatFileManagerDate(new Date(2026, 10, 1, 8, 47).toISOString(), now), /2026 at /);
  assert.equal(formatFileManagerDate(undefined, now), "--");
  assert.equal(formatFileManagerDate("not a date", now), "--");
});

test("History groups by day with the week starting Monday", () => {
  const now = new Date(2026, 10, 6, 10, 56); // a Friday
  assert.equal(historyDay(new Date(2026, 10, 6, 6, 31).toISOString(), now), "Today");
  assert.equal(historyDay(new Date(2026, 10, 5, 23, 0).toISOString(), now), "Yesterday");
  assert.equal(historyDay(new Date(2026, 10, 2, 9, 20).toISOString(), now), "This Week");
  assert.equal(historyDay(new Date(2026, 10, 1, 9, 20).toISOString(), now), "Earlier");
});

test("each History row carries its own day, since Changes and Chats are sections rather than day groups", () => {
  const now = new Date(2026, 10, 6, 10, 56); // a Friday
  assert.match(historyTimeLabel(new Date(2026, 10, 6, 6, 31).toISOString(), now), /^Today at \d/);
  assert.match(historyTimeLabel(new Date(2026, 10, 5, 23, 0).toISOString(), now), /^Yesterday at \d/);
  assert.match(historyTimeLabel(new Date(2026, 10, 2, 9, 20).toISOString(), now), /^Monday at \d/);
  assert.doesNotMatch(historyTimeLabel(new Date(2026, 10, 1, 9, 20).toISOString(), now), /2026| at /);
  assert.match(historyTimeLabel(new Date(2025, 10, 1, 9, 20).toISOString(), now), /2025/);
  assert.equal(historyTimeLabel("not a date", now), "");
});

test("the path bar reads like Finder's, from the disk down to the selected item", () => {
  const crumbs = fileManagerPathBar("/Users/mat/Documents/Home projects", "Kitchen refresh/Quotes", "quote-a.pdf");
  assert.deepEqual(crumbs, [
    { label: "Macintosh HD", path: null, nativePath: "/" },
    { label: "Users", path: null, nativePath: "/Users" },
    { label: "mat", path: null, nativePath: "/Users/mat" },
    { label: "Documents", path: null, nativePath: "/Users/mat/Documents" },
    { label: "Home projects", path: "", nativePath: "/Users/mat/Documents/Home projects" },
    { label: "Kitchen refresh", path: "Kitchen refresh", nativePath: "/Users/mat/Documents/Home projects/Kitchen refresh" },
    { label: "Quotes", path: "Kitchen refresh/Quotes", nativePath: "/Users/mat/Documents/Home projects/Kitchen refresh/Quotes" },
    { label: "quote-a.pdf", path: null, nativePath: "/Users/mat/Documents/Home projects/Kitchen refresh/Quotes/quote-a.pdf" },
  ]);
  // A long path keeps the disk and the last four whole, with "…" for the folders between.
  const collapsed = collapseCrumbs(crumbs);
  assert.deepEqual(collapsed.map((crumb) => crumb.label), ["Macintosh HD", "…", "Home projects", "Kitchen refresh", "Quotes", "quote-a.pdf"]);
  assert.deepEqual(collapsed[1]!.hidden, ["Users", "mat", "Documents"]);
  assert.equal(collapsed[1]!.nativePath, "/Users/mat/Documents");
  assert.equal(collapseCrumbs(crumbs.slice(0, 5)).length, 5, "a short path stays whole");
  assert.equal(fileManagerPathBar("/Volumes/Archive/Photos", "")[1]!.nativePath, "/Volumes/Archive/Photos");
  assert.deepEqual(nativePathParts("/Volumes/Archive/Photos/"), ["Archive", "Photos"]);
  assert.deepEqual(nativePathParts("C:\\Users\\mat\\Downloads"), ["C:", "Users", "mat", "Downloads"]);
});

test("places: routes and sidebar Standard Folders", () => {
  assert.equal(placeApiBase({ kind: "work-folder", id: "wf 1" }), "/api/work-folders/wf%201");
  assert.equal(placeApiBase({ kind: "standard", id: "downloads" }), "/api/standard-folders/downloads");
  assert.equal(placeEventsUrl({ kind: "work-folder", id: "a" }, "Quotes"), "/api/work-folders/a/file-events");
  assert.equal(placeEventsUrl({ kind: "standard", id: "downloads" }, "Receipts/2026"), "/api/standard-folders/downloads/events?path=Receipts%2F2026");
  assert.equal(sameLocation({ place: { kind: "standard", id: "desktop" }, path: "" }, { place: { kind: "standard", id: "desktop" }, path: "" }), true);
  assert.equal(sameLocation({ place: { kind: "standard", id: "desktop" }, path: "" }, { place: { kind: "work-folder", id: "desktop" }, path: "" }), false);
  const folders = [
    { id: "desktop", name: "Desktop", root: "/Users/mat/Desktop", workFolderId: null },
    { id: "downloads", name: "Downloads", root: "/Users/mat/Downloads", workFolderId: "wf-downloads" },
    { id: "documents", name: "Documents", root: "/Users/mat/Documents", workFolderId: "wf-removed" },
  ];
  assert.deepEqual(sidebarStandardFolders(folders, [{ id: "wf-downloads" }]).map((folder) => folder.id), ["desktop", "documents"],
    "a registered standard folder moves down to work-folders; one whose registration is gone comes back");
});

test("the enclosing folder and status line", () => {
  assert.equal(parentPath("Kitchen refresh/Quotes"), "Kitchen refresh");
  assert.equal(parentPath("Kitchen refresh"), "");
  assert.equal(fileManagerStatusText(1, 0), "1 item");
  assert.equal(fileManagerStatusText(12, 2), "2 of 12 selected");
});

test("Shift-click selects a range and typing jumps to a name", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(rangeSelection(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeSelection(order, "d", "a"), ["a", "b", "c", "d"]);
  assert.deepEqual(rangeSelection(order, null, "c"), ["c"]);
  const rows = [file("apple.txt", 1, ""), file("banana.txt", 1, ""), file("blueberry.txt", 1, ""), file("cherry.txt", 1, "")];
  assert.equal(typeSelectMatch(rows, "bl", null), "blueberry.txt");
  assert.equal(typeSelectMatch(rows, "b", "banana.txt"), "blueberry.txt", "a repeated letter moves to the next match");
  assert.equal(typeSelectMatch(rows, "b", "blueberry.txt"), "banana.txt", "and wraps around");
  assert.equal(typeSelectMatch(rows, "z", null), null);
});

test("suggested messages are plain fallbacks: up to four, two when Automations are on", () => {
  assert.deepEqual(fileManagerSuggestions({ selection: [], inSubfolder: false }), ["What’s in here?", "What changed this week?", "Organize this folder", "Find duplicate files"]);
  assert.deepEqual(fileManagerSuggestions({ selection: [], inSubfolder: false, automationsOn: true }), ["What’s in here?", "What changed this week?"]);
  assert.deepEqual(fileManagerSuggestions({ selection: [], inSubfolder: true }), ["What’s in here?", "Organize this folder", "What changed this week?"]);
  assert.deepEqual(fileManagerSuggestions({ selection: [{ kind: "file" }], inSubfolder: false, automationsOn: true }), ["Summarize", "Give it a clearer name", "Where should this go?"],
    "a selection fills the panel, so Automations don't shorten its list");
  assert.deepEqual(fileManagerSuggestions({ selection: [{ kind: "folder" }], inSubfolder: false }), ["What’s in here?", "Organize this folder"]);
  assert.deepEqual(fileManagerSuggestions({ selection: [{ kind: "file" }, { kind: "file" }], inSubfolder: false }), ["Summarize each", "Put these in a folder", "Give them clearer names"]);
});
