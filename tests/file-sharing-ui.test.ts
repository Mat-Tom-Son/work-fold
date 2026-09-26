import assert from "node:assert/strict";
import test from "node:test";
import { createElement, StrictMode } from "react";
import { FileShareControl } from "../web-local/src/components/panes/FileSharePopover.js";
import { refreshSharedPages, setSharedPages, sharedPagesSnapshot, type SharedPageView } from "../web-local/src/lib/page-sharing.js";
import { createDomHarness } from "./support/dom.js";

const publication: SharedPageView = {
  publicationId: "page-one", kind: "page", spaceId: "space-one", relativePath: "one.md",
  title: "One", state: "active", live: true, serveRatePerMinute: 60,
  byteBudgetPerDay: 1024 * 1024, snapshotEnabled: false,
  createdAt: "2026-09-24T12:00:00Z", bridgeSlot: "confirmed", viewerPath: "/p/page-one",
};
const props = { spaceId: "space-one", path: "one.md", fileName: "one.md" };
const status = { configured: true, viewerOrigin: "https://pages-test.example" };
const response = (value: unknown, httpStatus = 200) => new Response(JSON.stringify(value), { status: httpStatus, headers: { "content-type": "application/json" } });
const list = (pages: SharedPageView[]) => ({ publications: pages, status: { damaged: false, activeCount: pages.length, pendingBridgeWork: 0 } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function bridge(getStatus = async () => status) {
  Object.assign(window, { workFoldDesktop: { api: {}, remoteAccess: { getStatus } } });
}

test("a native Share request refreshes a cached empty list after the CLI shares the file", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  let hostPages: SharedPageView[] = [];
  let shares = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) {
      shares += 1;
      return response({ error: "This file is already shared as a page." }, 409);
    }
    if (String(input).endsWith("/reveal-link")) return response({ viewerPath: publication.viewerPath, key: "cli-key" });
    return response(list(hostPages));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  assert.equal(dom.container.querySelector("button")!.textContent, "Share");
  hostPages = [publication];
  await dom.render(createElement(FileShareControl, { ...props, shareRequestId: 1 }));
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(dom.container.querySelector("input")!.value, "https://pages-test.example/p/page-one#cli-key");
  assert.equal(dom.container.querySelector("button")!.textContent, "Shared");
  assert.equal(shares, 0, "a fresh host read reopens the existing link without another share act");
});

test("a concurrent external share conflict reopens its link without replaying the mutation", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  let shares = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) {
      shares += 1;
      // Another caller creates the page after this control's preflight GET.
      return response({ error: "This file is already shared as a page." }, 409);
    }
    if (String(input).endsWith("/reveal-link")) return response({ viewerPath: publication.viewerPath, key: "concurrent-key" });
    return response(list(shares ? [publication] : []));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(dom.container.querySelector("input")!.value, "https://pages-test.example/p/page-one#concurrent-key");
  assert.equal(shares, 1, "conflict recovery performs reads, never another share act");
  assert.equal(dom.container.querySelector("button")!.disabled, false);
});

test("a share conflict without a matching page stays refused without another mutation", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  let shares = 0;
  let reveals = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) {
      shares += 1;
      return response({ error: "Stop sharing another page first.", code: "PUBLICATION_CAP" }, 409);
    }
    if (String(input).endsWith("/reveal-link")) reveals += 1;
    return response(list([{ ...publication, relativePath: "another-file.md" }]));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  assert.equal(shares, 1);
  assert.equal(reveals, 0, "another file's page cannot satisfy this Share request");
  assert.equal(dom.container.querySelector('[role="dialog"]'), null);
  assert.equal(dom.container.querySelector("button")!.disabled, false);
});

test("returning to the window refreshes shared markers after external share and revoke", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  let hostPages: SharedPageView[] = [];
  let visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  let reads = 0;
  globalThis.fetch = (async () => { reads += 1; return response(list(hostPages)); }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  hostPages = [publication];
  await dom.act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(dom.container.querySelector("button")!.textContent, "Shared");
  const readsBeforeHide = reads;
  visibility = "hidden";
  await dom.act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(reads, readsBeforeHide, "hiding the window does not start another read");
  hostPages = [];
  visibility = "visible";
  await dom.act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(dom.container.querySelector("button")!.textContent, "Share");
  await dom.cleanup();
});

test("Share admits one request even while its address lookup is pending", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  const lookup = deferred<typeof status>();
  let lookups = 0;
  bridge(async () => { lookups += 1; return lookup.promise; });
  let shares = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) { shares += 1; return response({ publication, revealable: true }); }
    if (String(input).endsWith("/reveal-link")) return response({ viewerPath: publication.viewerPath, key: "current-key" });
    return response(list(shares ? [publication] : []));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  const button = dom.container.querySelector("button")!;
  await dom.act(async () => { button.click(); button.click(); });
  assert.equal(lookups, 1);
  await dom.act(async () => { lookup.resolve(status); });
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(shares, 1);
});

test("a closed popover's late link cannot populate a newer reveal", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([publication]);
  bridge();
  const reveals: Array<ReturnType<typeof deferred<Response>>> = [];
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/reveal-link")) {
      const pending = deferred<Response>();
      reveals.push(pending);
      return pending.promise;
    }
    return response(list([publication]));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  await dom.waitFor(() => reveals.length === 1);
  await dom.press("Escape");
  assert.equal(dom.container.querySelector('[role="dialog"]'), null);
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  await dom.waitFor(() => reveals.length === 2);
  await dom.act(async () => { reveals[0]!.resolve(response({ viewerPath: "/p/old", key: "old-key" })); });
  assert.equal(dom.container.querySelector("input"), null, "the old reveal stays discarded");
  await dom.act(async () => { reveals[1]!.resolve(response({ viewerPath: publication.viewerPath, key: "new-key" })); });
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(dom.container.querySelector("input")!.value, "https://pages-test.example/p/page-one#new-key");
});

test("switching the file drops a pending share result from the old file", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  const pending = deferred<Response>();
  let shares = 0;
  let reveals = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) { shares += 1; return pending.promise; }
    if (String(input).endsWith("/reveal-link")) { reveals += 1; return response({ viewerPath: publication.viewerPath, key: "old-key" }); }
    return response(list([]));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  await dom.waitFor(() => shares === 1);
  await dom.render(createElement(FileShareControl, { ...props, path: "two.md", fileName: "two.md" }));
  await dom.act(async () => { pending.resolve(response({ publication, revealable: true })); });
  assert.equal(dom.container.querySelector('[role="dialog"]'), null);
  assert.equal(reveals, 0, "the old file's link is never revealed in the new control");
  assert.equal(dom.container.querySelector("button")!.disabled, false);
});

test("StrictMode handles a Files-menu share request once and keeps its popover", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  let shares = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) { shares += 1; return response({ publication, revealable: true }); }
    if (String(input).endsWith("/reveal-link")) return response({ viewerPath: publication.viewerPath, key: "current-key" });
    return response(list(shares ? [publication] : []));
  }) as typeof fetch;
  await dom.render(createElement(StrictMode, null, createElement(FileShareControl, { ...props, shareRequestId: 1 })));
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(shares, 1);
  assert.equal(dom.container.querySelector('[role="dialog"]')?.getAttribute("aria-label"), "One");
});

test("Share refreshes file markers after a pending pre-share list finishes", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; setSharedPages(null); });
  setSharedPages([]);
  bridge();
  const oldList = deferred<Response>();
  let reads = 0;
  let shares = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/share")) { shares += 1; return response({ publication, revealable: true }); }
    if (String(input).endsWith("/reveal-link")) return response({ viewerPath: publication.viewerPath, key: "current-key" });
    reads += 1;
    return reads === 1 ? oldList.promise : response(list(shares ? [publication] : []));
  }) as typeof fetch;
  await dom.render(createElement(FileShareControl, props));
  await dom.waitFor(() => reads === 1);
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  assert.equal(shares, 0, "sharing waits for a fresh host list instead of trusting the cached empty list");
  await dom.act(async () => { oldList.resolve(response(list([]))); });
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  await dom.waitFor(() => dom.container.querySelector(".file-share-button")?.textContent === "Shared");
  assert.equal(reads, 3, "fresh GETs follow both the older list and the share mutation");
  assert.deepEqual(sharedPagesSnapshot(), [publication]);
  await dom.press("Escape");
  await dom.act(async () => { dom.container.querySelector("button")!.click(); });
  await dom.waitFor(() => Boolean(dom.container.querySelector("input")));
  assert.equal(shares, 1, "reopening uses the new slot instead of attempting another share");
});

test("a fresh Settings list is not overwritten by an older file-surface read", async () => {
  setSharedPages([publication]);
  const oldList = deferred<ReturnType<typeof list>>();
  const reading = refreshSharedPages(() => oldList.promise);
  // Settings uses its own post-action GET, then publishes the result here.
  setSharedPages([]);
  oldList.resolve(list([publication]));
  await reading;
  assert.deepEqual(sharedPagesSnapshot(), [], "a stopped page cannot regain its Shared marker");
  setSharedPages(null);
});
