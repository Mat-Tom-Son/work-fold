import assert from "node:assert/strict";
import React, { createElement } from "react";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter(name => /^[A-Za-z_$][\w$]*$/.test(name));
const icons = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:tree-motion-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === "test:tree-motion-icons" ? { format: "module", source: iconNames.map(name => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true } : next(url, context); },
});
const { FileTree } = await import("../web-local/src/components/tree/FileTree.js");
icons.deregister();

test("opening a folder animates only that tree, and search results do not replay it", { timeout: 10_000 }, async (t) => {
  // The renderer normally uses Vite's automatic JSX runtime.
  const scope = globalThis as unknown as { React?: typeof React };
  const previousReact = scope.React; scope.React = React;
  t.after(() => { if (previousReact) scope.React = previousReact; else delete scope.React; });
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const props = {
    entries: [{ kind: "folder" as const, name: "Notes", path: "Notes", children: [{ kind: "file" as const, name: "a.md", path: "Notes/a.md" }] }],
    loadingFolderPaths: new Set<string>(), dropTargetFolderPath: null,
    onToggleFolder: () => {}, onSelectFile: () => {}, onOpenFile: () => {}, onOpenContextMenu: () => {},
    onUpdateDropTarget: () => {}, onDropOnTarget: () => {}, onDragStartEntry: () => {}, onDragEndEntry: () => {},
  };
  const render = (collapsed: boolean, searchQuery = "") => dom.render(createElement("div", null,
    createElement("section", { id: "first" }, createElement(FileTree, { ...props, collapsedPaths: new Set(collapsed ? ["Notes"] : []), searchQuery })),
    createElement("section", { id: "second" }, createElement(FileTree, { ...props, collapsedPaths: new Set<string>() })),
  ));
  await render(true);
  await dom.act(() => (dom.container.querySelector("#first button") as HTMLButtonElement).click());
  await render(false);
  assert.ok(dom.container.querySelector("#first .file-children.opening"), "the explicitly opened folder animates");
  assert.equal(Boolean(dom.container.querySelector("#second .opening")), false, "the same relative path in another tree stays still");
  await render(false, "a.md");
  assert.equal(Boolean(dom.container.querySelector("#first .opening")), false, "search results appear in place");
  await render(false);
  assert.equal(Boolean(dom.container.querySelector("#first .opening")), false, "clearing search does not replay an old opening");
});
