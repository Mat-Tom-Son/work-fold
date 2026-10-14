import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement, useState } from "react";
import { createDomHarness } from "./support/dom.js";
import type { TreeEntry } from "../web-local/src/types.js";

test("Worker working files remain interactive alongside normal Files", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:worker-files-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:worker-files-icons") return { format: "module", source: iconNames.map(name => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const { FileTree } = await import("../web-local/src/components/tree/FileTree.js");
  const opened: string[] = [], renamed: string[] = [], menus: string[] = [];
  const entries: TreeEntry[] = [
    { path: ".worker", name: ".worker", kind: "folder", children: [{ path: ".worker/draft.txt", name: "draft.txt", kind: "file" }] },
    { path: "deliverable.txt", name: "deliverable.txt", kind: "file" },
  ];
  function Files() {
    const [collapsed, collapse] = useState(new Set([".worker"]));
    const [selected, select] = useState<string | null>(null);
    return createElement(FileTree, {
      entries, collapsedPaths: collapsed, loadingFolderPaths: new Set<string>(), selectedPath: selected,
      movingTreePath: null, dropTargetFolderPath: null,
      onToggleFolder: path => collapse(value => value.has(path) ? new Set() : new Set([path])),
      onSelectFile: select, onFocusEntry: select, onOpenFile: path => opened.push(path),
      onOpenContextMenu: entry => menus.push(entry.path), onRenameEntry: path => renamed.push(path),
      onUpdateDropTarget() {}, onDropOnTarget() {}, onDragStartEntry() {}, onDragEndEntry() {},
    });
  }
  await dom.render(createElement(Files));
  const row = dom.container.querySelector<HTMLButtonElement>('[data-tree-path=".worker"]')!;
  assert.equal(row.disabled, false);
  assert.equal(row.draggable, true);
  assert.ok(row.classList.contains("worker-scratch"));
  assert.equal(dom.container.querySelector('[data-tree-path="deliverable.txt"]')?.classList.contains("worker-scratch"), false);
  await dom.act(() => row.click());
  const draft = dom.container.querySelector<HTMLButtonElement>('[data-tree-path=".worker/draft.txt"]')!;
  assert.ok(draft, "scratch contents expand normally");
  await dom.act(() => draft.focus());
  await dom.press(" ");
  assert.equal(draft.getAttribute("aria-selected"), "true");
  await dom.press("Enter");
  await dom.press("F2");
  await dom.act(() => { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); });
  assert.deepEqual(opened, [".worker/draft.txt"]);
  assert.deepEqual(renamed, [".worker/draft.txt"]);
  assert.deepEqual(menus, [".worker"]);
});
