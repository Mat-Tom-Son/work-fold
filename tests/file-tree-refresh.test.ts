import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { useWorkFolderTree } from "../web-local/src/hooks/useWorkFolderTree.js";
import { keepLoadedChildren } from "../web-local/src/lib/tree.js";
import type { TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const workFolder = { id: "files", name: "files", workFolderRoot: "/tmp/files", location: { storage: "linked" } } as WorkFolderSummary;
const folder = (path: string, children?: TreeEntry[]): TreeEntry => ({ kind: "folder", path, name: path.split("/").pop()!, hasChildren: true, ...(children ? { children } : {}) });
const file = (path: string): TreeEntry => ({ kind: "file", path, name: path.split("/").pop()! });

test("an event-scoped refresh keeps every open folder open with its rows", async (t) => {
  // What the disk holds; each listing is shallow, as the host's is.
  const listings: Record<string, TreeEntry[]> = {
    "": [folder("Archive"), folder("Reports"), file("todo.md")],
    Archive: [file("Archive/old.md")],
    Reports: [folder("Reports/2026"), file("Reports/q3.md")],
    "Reports/2026": [file("Reports/2026/jan.md")],
  };
  const reads: string[] = [];
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://work-fold.test");
    if (url.pathname === "/api/events") {
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    }
    const path = url.searchParams.get("path") ?? "";
    reads.push(path);
    return Response.json({ tree: listings[path] ?? [] });
  }) as typeof fetch;
  let state!: ReturnType<typeof useWorkFolderTree>;
  function Tree() { state = useWorkFolderTree(workFolder, () => {}); return null; }
  await dom.render(createElement(Tree));
  await dom.waitFor(() => state.status === "ready" && state.tree.length === 3);
  const children = (path: string) => {
    const find = (items: TreeEntry[]): TreeEntry | undefined => {
      for (const entry of items) {
        if (entry.path === path) return entry;
        const inner = entry.children ? find(entry.children) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    return find(state.tree)?.children?.map((entry) => entry.path);
  };
  for (const path of ["Archive", "Reports", "Reports/2026"]) {
    await dom.act(() => state.toggleFolder(path));
    await dom.waitFor(() => Boolean(children(path)?.length));
  }

  // A file arrives in Reports; only Reports' listing changes.
  listings.Reports = [folder("Reports/2026"), file("Reports/moved.md"), file("Reports/q3.md")];
  reads.length = 0;
  await dom.act(() => state.refresh(false, { eventPaths: ["Reports/moved.md"] }));
  await dom.waitFor(() => state.status === "ready" && Boolean(children("Reports")?.includes("Reports/moved.md")));

  assert.deepEqual(children("Archive"), ["Archive/old.md"], "Archive stays open with its rows");
  assert.deepEqual(children("Reports/2026"), ["Reports/2026/jan.md"], "a folder inside the reloaded one stays open");
  assert.deepEqual(reads.sort(), ["", "Reports"], "only the root and the touched folder are read again");
});

test("keepLoadedChildren carries loaded rows onto a shallow listing and leaves new folders closed", () => {
  const cached = [folder("A", [file("A/x.md"), folder("A/B", [file("A/B/y.md")])]), folder("Gone", [file("Gone/z.md")])];
  const fresh = [folder("A"), folder("New")];
  const merged = keepLoadedChildren(fresh, cached);
  assert.deepEqual(merged[0]!.children?.map((entry) => entry.path), ["A/x.md", "A/B"]);
  assert.deepEqual(merged[0]!.children?.[1]?.children?.map((entry) => entry.path), ["A/B/y.md"]);
  assert.equal(merged[1]!.children, undefined, "a folder that was never opened stays unloaded");
  assert.equal(merged.some((entry) => entry.path === "Gone"), false, "a folder that is gone stays gone");
  // A reloaded folder's own listing wins over what was cached for it.
  const reloaded = keepLoadedChildren([folder("A", [file("A/new.md")])], cached);
  assert.deepEqual(reloaded[0]!.children?.map((entry) => entry.path), ["A/new.md"]);
});
