import assert from "node:assert/strict";
import React, { createElement, useEffect } from "react";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { createDomHarness } from "./support/dom.js";
import { fileSelectionLabel } from "../src/shared/file-selection.js";
import { nativeFileMenuItems, parseNativeFileMenuRequest } from "../desktop/src/file-context-menu.js";
import { draggedWorkFolderPaths } from "../web-local/src/lib/file-actions.js";
import { isSelectionToggleKey, outermostTreePaths, treeSelectionRange, visibleTreePaths } from "../web-local/src/lib/tree-selection.js";
import { useWorkFolderTree } from "../web-local/src/hooks/useWorkFolderTree.js";
import type { FileContextMenuState, TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";

const assets = registerHooks({
  load(url, context, next) { return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context); },
});
const { FileTree } = await import("../web-local/src/components/tree/FileTree.js");
const { FileContextMenu } = await import("../web-local/src/components/tree/FileContextMenu.js");
assets.deregister();

const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.split("/").pop()! });
const folder = (path: string, children: TreeEntry[]): TreeEntry => ({ kind: "folder", path, name: path.split("/").pop()!, hasChildren: true, children });
const entries: TreeEntry[] = [
  folder("Notes", [file("Notes/a.md"), file("Notes/b.md")]),
  folder("Reports", [file("Reports/q3.xlsx")]),
  { kind: "folder", path: "Client", name: "Client", nestedFolder: true },
  file("readme.md"),
  file("todo.txt"),
];
const workFolder = { id: "multi-select", name: "Multi", workFolderRoot: "/tmp/multi", location: { storage: "linked" } } as WorkFolderSummary;

test("the shown order follows open folders, skips closed ones, and leaves nested work-folders out", () => {
  assert.deepEqual(visibleTreePaths(entries, new Set()), ["Notes", "Notes/a.md", "Notes/b.md", "Reports", "Reports/q3.xlsx", "readme.md", "todo.txt"]);
  assert.deepEqual(visibleTreePaths(entries, new Set(["Notes"])), ["Notes", "Reports", "Reports/q3.xlsx", "readme.md", "todo.txt"]);
  const order = visibleTreePaths(entries, new Set());
  assert.deepEqual(treeSelectionRange(order, "readme.md", "Notes/b.md"), ["Notes/b.md", "Reports", "Reports/q3.xlsx", "readme.md"], "a range runs either way");
  assert.deepEqual(treeSelectionRange(order, "gone.txt", "readme.md"), []);
  assert.deepEqual(outermostTreePaths(["Notes/a.md", "Notes", "readme.md", "Notes", ""]), ["Notes", "readme.md"], "a selected folder carries what is selected inside it");
  assert.equal(isSelectionToggleKey({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(isSelectionToggleKey({ metaKey: false, ctrlKey: true }, true), false, "Ctrl-click is a right-click on the Mac");
  assert.equal(isSelectionToggleKey({ metaKey: false, ctrlKey: true }, false), true);
});

test("selection labels name the kinds selected", () => {
  assert.equal(fileSelectionLabel(3, 0), "3 Files");
  assert.equal(fileSelectionLabel(0, 2), "2 Folders");
  assert.equal(fileSelectionLabel(2, 1), "3 Items");
});

test("a drag of several rows carries every path, and a one-row drag still reads as before", () => {
  const transfer = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? "" }) as unknown as DataTransfer;
  assert.deepEqual(draggedWorkFolderPaths(transfer({
    "application/x-work-fold-work-folder-path": "Notes/a.md",
    "application/x-work-fold-work-folder-paths": JSON.stringify(["Notes/a.md", "readme.md"]),
  })), ["Notes/a.md", "readme.md"]);
  assert.deepEqual(draggedWorkFolderPaths(transfer({ "application/x-work-fold-work-folder-path": "Notes/a.md" })), ["Notes/a.md"]);
  assert.deepEqual(draggedWorkFolderPaths(transfer({ "application/x-work-fold-work-folder-paths": "not json", "text/plain": "readme.md" })), ["readme.md"]);
  assert.deepEqual(draggedWorkFolderPaths(transfer({})), []);
});

test("the native Mac menu for several rows offers only what applies to all of them", () => {
  const base = {
    workFolderId: "work-folder-1",
    path: "Notes/a.md",
    kind: "file",
    capabilities: { open: false, attach: true, history: false, upload: false, rename: false, delete: true, share: false, shared: false },
    point: { x: 10, y: 20 },
  } as const;
  const files = parseNativeFileMenuRequest({ ...base, selection: { files: 3, folders: 0 } });
  assert.deepEqual(nativeFileMenuItems(files), [
    { type: "item", label: "Attach to Chat", command: "attach-chat" },
    { type: "item", label: "Copy Paths", command: "copy-path" },
    { type: "separator" },
    { type: "item", label: "Delete 3 Files", command: "delete" },
  ]);
  const mixed = parseNativeFileMenuRequest({ ...base, selection: { files: 2, folders: 1 } });
  assert.deepEqual(nativeFileMenuItems(mixed).map((item) => item.type === "item" ? item.label : "—"), ["Copy Paths", "—", "Delete 3 Items"], "folders cannot be attached");
  const guarded = parseNativeFileMenuRequest({ ...base, capabilities: { ...base.capabilities, delete: false }, selection: { files: 0, folders: 2 } });
  assert.deepEqual(nativeFileMenuItems(guarded).map((item) => item.type === "item" ? item.command : "—"), ["copy-path"], "a folder holding a nested work-folder keeps the selection undeletable");
  assert.equal(parseNativeFileMenuRequest(base).selection, undefined, "older renderers omit the selection");
  for (const selection of [{ files: 1, folders: 0 }, { files: -1, folders: 3 }, { files: 1.5, folders: 1 }, { files: 2, folders: 0, label: "x" }, "2"]) {
    assert.throws(() => parseNativeFileMenuRequest({ ...base, selection }), /selection is invalid/);
  }
});

async function renderFiles(t: TestContext) {
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const opened: string[] = [], renamed: string[] = [], deleted: string[] = [];
  let state!: ReturnType<typeof useWorkFolderTree>;
  // Wired the way App wires Files.
  function Files() {
    state = useWorkFolderTree(workFolder, () => {}, entries);
    const order = visibleTreePaths(state.visibleEntries, state.collapsedPaths);
    useEffect(() => state.keepSelectionWithin(order), [order.join("\n")]);
    return createElement("div", { className: "file-tree-shell" }, createElement(FileTree, {
      entries: state.visibleEntries, collapsedPaths: state.collapsedPaths, loadingFolderPaths: new Set<string>(),
      selectedPath: state.selectedPath, selectedPaths: state.selectedPaths, movingTreePaths: state.movingTreePaths, dropTargetFolderPath: null,
      onToggleFolder: state.toggleFolder,
      onSelectFile: (path: string) => { state.setSelectedPath(path); opened.push(path); },
      onFocusEntry: state.setSelectedPath,
      onToggleSelected: state.toggleSelectedPath,
      onSelectRange: (path: string, additive: boolean) => state.selectPathRange(path, order, additive),
      onSelectAll: () => state.selectPaths(order, state.selectedPath),
      onOpenFile() {}, onOpenContextMenu() {},
      onRenameEntry: (path: string) => renamed.push(path), onDeleteEntry: (path: string) => deleted.push(path),
      onUpdateDropTarget() {}, onDropOnTarget() {}, onDragStartEntry() {}, onDragEndEntry() {},
    }));
  }
  await dom.render(createElement(Files));
  const row = (path: string) => dom.container.querySelector<HTMLButtonElement>(`[data-tree-path="${path}"]`)!;
  const click = (path: string, init: MouseEventInit = {}) => dom.act(() => { row(path).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init })); });
  const selected = () => [...dom.container.querySelectorAll<HTMLElement>(".file-row.selected")].map((item) => item.dataset.treePath);
  return { dom, row, click, selected, opened, renamed, deleted, state: () => state };
}

// jsdom is not the Mac, so Ctrl is the toggle key here.
test("Ctrl-click adds and removes rows, Shift-click selects the shown run, and only a plain click opens a file", async (t) => {
  const files = await renderFiles(t);
  assert.equal(files.dom.container.querySelector('[role="tree"]')?.getAttribute("aria-multiselectable"), "true");
  await files.click("Notes/b.md");
  assert.deepEqual(files.selected(), ["Notes/b.md"]);
  assert.deepEqual(files.opened, ["Notes/b.md"]);

  await files.click("readme.md", { shiftKey: true });
  assert.deepEqual(files.selected(), ["Notes/b.md", "Reports", "Reports/q3.xlsx", "readme.md"], "the run includes an open folder's rows");
  assert.equal(files.row("readme.md").getAttribute("aria-selected"), "true");
  assert.equal(files.row("Reports").getAttribute("aria-selected"), "true", "a selected folder says so");

  await files.click("Reports", { ctrlKey: true });
  assert.deepEqual(files.selected(), ["Notes/b.md", "Reports/q3.xlsx", "readme.md"]);
  assert.equal(files.state().collapsedPaths.has("Reports"), false, "Ctrl-click on a folder never opens or closes it");

  await files.click("todo.txt", { ctrlKey: true });
  await files.click("Notes/a.md", { shiftKey: true });
  assert.deepEqual(files.selected(), ["Notes/a.md", "Notes/b.md", "Reports", "Reports/q3.xlsx", "readme.md", "todo.txt"], "Shift-click runs from the last Ctrl-clicked row");

  await files.click("Notes/a.md");
  await files.click("readme.md", { ctrlKey: true });
  await files.click("todo.txt", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(files.selected(), ["Notes/a.md", "readme.md", "todo.txt"], "Ctrl+Shift adds the run to what was selected");
  assert.deepEqual(files.opened, ["Notes/b.md", "Notes/a.md"], "modified clicks never open a tab");

  await files.click("Notes/b.md");
  assert.deepEqual(files.selected(), ["Notes/b.md"], "a plain click selects just that row again");
});

test("the keyboard extends, narrows, and clears a selection", async (t) => {
  const files = await renderFiles(t);
  await files.click("Notes/a.md");
  files.row("Notes/a.md").focus();
  await files.dom.press("ArrowDown", { shiftKey: true });
  await files.dom.press("ArrowDown", { shiftKey: true });
  assert.deepEqual(files.selected(), ["Notes/a.md", "Notes/b.md", "Reports"]);
  await files.dom.press("ArrowUp", { shiftKey: true });
  assert.deepEqual(files.selected(), ["Notes/a.md", "Notes/b.md"]);

  await files.dom.press("F2");
  assert.deepEqual(files.renamed, [], "Rename is for one row");
  await files.dom.press("Delete");
  assert.deepEqual(files.deleted, ["Notes/b.md"], "Delete reports the focused row; App widens it to the selection");

  await files.dom.press("Escape");
  assert.deepEqual(files.selected(), ["Notes/b.md"], "Escape keeps only the focused row");

  await files.dom.press("a", { ctrlKey: true });
  assert.equal(files.selected().length, 7, "Ctrl+A selects every shown row");
  await files.click("Notes");
  assert.deepEqual(files.selected(), ["Notes", "Reports", "Reports/q3.xlsx", "readme.md", "todo.txt"], "closing a folder drops its hidden rows from the selection");

  files.row("readme.md").focus();
  await files.dom.press("ArrowDown");
  assert.deepEqual(files.selected(), ["todo.txt"], "a plain arrow moves a single selection");
});

test("the Files menu for several rows offers attach, copy, and delete for all of them", async (t) => {
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: Array<[string, string[]]> = [];
  const render = (selection: TreeEntry[], canDelete = true) => {
    const state: FileContextMenuState = { entry: selection[0]!, selection, x: 0, y: 0 };
    return dom.render(createElement(FileContextMenu, {
      state, canDelete, fixtureMode: true,
      onSelect() {}, onOpenLocal() {}, onAddToChatContext() {}, onCopyPath() {}, onShowVersionHistory() {}, onDelete() {}, onClose() {},
      onRename: () => calls.push(["rename", []]),
      onAttachSelection: (paths: string[]) => calls.push(["attach", paths]),
      onCopyPaths: (paths: string[]) => calls.push(["copy", paths]),
      onDeleteSelection: (paths: string[]) => calls.push(["delete", paths]),
    }));
  };
  const labels = () => [...dom.container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  await render([file("Notes/a.md"), file("readme.md")]);
  assert.deepEqual(labels(), ["Attach to Chat", "Copy Paths", "Delete 2 Files"]);
  await dom.act(() => { (dom.container.querySelector('[role="menuitem"]') as HTMLButtonElement).click(); });
  assert.deepEqual(calls, [["attach", ["Notes/a.md", "readme.md"]]]);

  await render([entries[0]!, file("readme.md")]);
  assert.deepEqual(labels(), ["Copy Paths", "Delete 2 Items"], "a folder in the selection leaves out Attach to Chat; Rename never shows");
  await dom.act(() => { (dom.container.querySelector(".context-menu .danger") as HTMLButtonElement).click(); });
  assert.deepEqual(calls.at(-1), ["delete", ["Notes", "readme.md"]]);

  await render([entries[0]!, entries[1]!], false);
  assert.deepEqual(labels(), ["Copy Paths"], "a folder holding a nested work-folder keeps the selection undeletable");
});
