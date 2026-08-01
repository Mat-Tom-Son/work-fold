import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";

import { createDomHarness } from "./support/dom.js";

/**
 * The Files content-search section talks to the search endpoint, so its
 * request shaping and its stale-result handling are the parts worth pinning.
 */

interface FetchCall { url: string; signal?: AbortSignal | null }

function stubSearch(calls: FetchCall[], respond: (url: string) => unknown): void {
  (globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, signal: init?.signal });
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function mountSearch(dom: Awaited<ReturnType<typeof createDomHarness>>, props: {
  spaceId: string;
  query: string;
  onOpenFile?: (path: string) => void;
}): Promise<void> {
  const { FileContentSearch } = await import("../web-local/src/components/panes/FileContentSearch.js");
  await dom.render(createElement(FileContentSearch, { onOpenFile: () => {}, ...props }));
}

test("content search stays silent until there is a query, then reports matches", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: FetchCall[] = [];
  stubSearch(calls, () => ({ files: [{ path: "notes/plan.md", line: 2, preview: "the quarterly budget" }], truncated: false }));

  await mountSearch(dom, { spaceId: "space-1", query: "   " });
  assert.equal(dom.container.querySelector(".file-content-search"), null, "an empty query renders nothing and asks for nothing");
  assert.equal(calls.length, 0);

  await mountSearch(dom, { spaceId: "space-1", query: "quarterly" });
  await dom.waitFor(() => calls.length > 0);
  assert.match(calls[0]?.url ?? "", /scope=files/, "the tree already covers filenames, so this asks only for contents");
  assert.match(calls[0]?.url ?? "", /q=quarterly/);
  assert.match(calls[0]?.url ?? "", /\/api\/spaces\/space-1\/search/);

  await dom.waitFor(() => Boolean(dom.container.querySelector(".file-content-search-preview")));
  assert.match(dom.container.textContent ?? "", /notes\/plan\.md/);
  assert.match(dom.container.textContent ?? "", /the quarterly budget/);
});

test("content search opens the file a match belongs to", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  stubSearch([], () => ({ files: [{ path: "notes/plan.md", line: 7, preview: "match" }], truncated: false }));

  const opened: string[] = [];
  await mountSearch(dom, { spaceId: "space-1", query: "match", onOpenFile: (path) => opened.push(path) });
  await dom.waitFor(() => Boolean(dom.container.querySelector(".file-content-search li button")));

  dom.container.querySelector<HTMLButtonElement>(".file-content-search li button")?.click();
  assert.deepEqual(opened, ["notes/plan.md"]);
});

test("content search discloses a truncated result and surfaces failures", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());

  stubSearch([], () => ({ files: [{ path: "a.txt", line: 1, preview: "x" }], truncated: true }));
  await mountSearch(dom, { spaceId: "space-1", query: "x" });
  await dom.waitFor(() => Boolean(dom.container.querySelector(".file-content-search-note")));
  assert.match(dom.container.textContent ?? "", /Showing the first/, "a bounded search says so rather than implying completeness");

  (globalThis as unknown as { fetch: unknown }).fetch = async () => new Response("{}", { status: 500 });
  await mountSearch(dom, { spaceId: "space-2", query: "boom" });
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("search this Space"));
  assert.match(dom.container.textContent ?? "", /Couldn\u2019t search this Space/);
});

test("content search clears stale matches and aborts superseded disk work", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const calls: FetchCall[] = [];
  const responses: Array<(response: Response) => void> = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    return new Promise<Response>((resolve) => responses.push(resolve));
  };

  await mountSearch(dom, { spaceId: "space-1", query: "first" });
  await dom.waitFor(() => calls.length === 1);
  await dom.act(() => {
    responses[0]?.(new Response(JSON.stringify({
      files: [{ path: "old.txt", line: 1, preview: "stale first result" }],
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("stale first result"));

  await mountSearch(dom, { spaceId: "space-1", query: "second" });
  assert.doesNotMatch(dom.container.textContent ?? "", /stale first result/, "the prior query disappears immediately");
  assert.equal(calls[0]?.signal?.aborted, true, "the superseded request is cancelled");

  await dom.waitFor(() => calls.length === 2);
  await dom.act(() => {
    responses[1]?.(new Response(JSON.stringify({
      files: [{ path: "new.txt", line: 2, preview: "fresh second result" }],
      truncated: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  });
  await dom.waitFor(() => (dom.container.textContent ?? "").includes("fresh second result"));
});
