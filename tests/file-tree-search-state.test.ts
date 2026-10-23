import assert from "node:assert/strict";
import { createElement } from "react";
import test, { type TestContext } from "node:test";
import { useWorkFolderTree } from "../web-local/src/hooks/useWorkFolderTree.js";
import type { TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const workFolder = { id: "files", name: "files", workFolderRoot: "/tmp/files", location: { storage: "linked" } } as WorkFolderSummary;
const folder = (path: string, children?: TreeEntry[]): TreeEntry => ({ kind: "folder", path, name: path.split("/").pop()!, hasChildren: true, ...(children ? { children } : {}) });
const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.split("/").pop()! });

// The folder's first listing is shallow; a search reads the whole tree.
const shallowRoot = [folder("Opened"), folder("Closed")];
const fullTree = [
  folder("Opened", [file("Opened/notes.txt")]),
  folder("Closed", [folder("Closed/Inner", [file("Closed/Inner/needle.txt")])]),
];

async function setup(t: TestContext) {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://work-fold.test");
    if (url.pathname === "/api/events") {
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    }
    const path = url.searchParams.get("path");
    if (url.searchParams.get("maxDepth") === "6") return Response.json({ tree: fullTree });
    if (path === "Opened") return Response.json({ tree: [file("Opened/notes.txt")] });
    return Response.json({ tree: path ? [] : shallowRoot });
  }) as typeof fetch;
  let state!: ReturnType<typeof useWorkFolderTree>;
  function Tree() { state = useWorkFolderTree(workFolder, () => {}); return null; }
  await dom.render(createElement(Tree));
  await dom.waitFor(() => state.status === "ready" && state.tree.length === 2);
  await dom.act(() => state.toggleFolder("Opened"));
  await dom.waitFor(() => Boolean(state.tree.find((entry) => entry.path === "Opened")?.children?.length));
  const search = async (query: string) => {
    await dom.act(() => state.setQuery(query));
    await dom.waitFor(() => Boolean(state.tree.find((entry) => entry.path === "Closed")?.children?.length));
  };
  return { dom, state: () => state, search };
}

test("clearing a Files search leaves closed folders closed and open ones open", async (t) => {
  const ui = await setup(t);
  await ui.search("needle");
  await ui.dom.act(() => ui.state().setQuery(""));
  const collapsed = ui.state().collapsedPaths;
  assert.equal(collapsed.has("Closed"), true);
  assert.equal(collapsed.has("Closed/Inner"), true);
  assert.equal(collapsed.has("Opened"), false);
  await ui.dom.act(() => ui.state().toggleFolder("Closed"));
  assert.equal(ui.state().collapsedPaths.has("Closed"), false, "opening a folder a search loaded works on the first click");
  assert.equal(ui.state().collapsedPaths.has("Closed/Inner"), true);
});

test("a file picked from search results is revealed when the search is cleared", async (t) => {
  const ui = await setup(t);
  await ui.search("needle");
  await ui.dom.act(() => ui.state().setSelectedPath("Closed/Inner/needle.txt"));
  await ui.dom.act(() => ui.state().setQuery(""));
  const collapsed = ui.state().collapsedPaths;
  assert.equal(collapsed.has("Closed"), false);
  assert.equal(collapsed.has("Closed/Inner"), false);
});
