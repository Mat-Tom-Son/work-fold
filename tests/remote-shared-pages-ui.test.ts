import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createSharedPages, sharedPageUrl } from "../services/bridge/public/shared-pages.js";

const key = "A".repeat(43);
const origin = "https://pages-casey.work-fold.com";
const link = { viewerOrigin: origin, viewerPath: "/p/report", key };
const options = { publicationId: "report", slug: "casey", managementOrigin: "https://casey.work-fold.com" };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("page navigation accepts only the account's isolated viewer, exact identity and fragment key", () => {
  assert.equal(sharedPageUrl(link, options), `${origin}/p/report#${key}`);
  assert.equal(sharedPageUrl({ ...link, viewerPath: "/a/report" }, options), `${origin}/a/report#${key}`);
  for (const change of [
    { viewerOrigin: "https://casey.work-fold.com" }, { viewerOrigin: "https://pages-other.work-fold.com" },
    { viewerOrigin: "https://pages-casey.work-fold.com.evil.example" }, { viewerOrigin: `${origin}/` },
    { viewerOrigin: "http://pages-casey.work-fold.com" }, { viewerOrigin: "https://person:secret@pages-casey.work-fold.com" },
    { viewerPath: "/p/other" }, { viewerPath: "/p/report?key=secret" }, { viewerPath: "/p/report#secret" },
    { viewerPath: "//evil.example" }, { key: "invalid" },
  ]) assert.throws(() => sharedPageUrl({ ...link, ...change }, options));
  assert.throws(() => sharedPageUrl(link, { ...options, slug: "other" }));
});

async function fixture(run: (f: any) => Promise<void>) {
  const dom = new JSDOM('<div class="shared-pages-shell"><button id="toggle">Shared pages</button><section hidden><button class="shared-pages-refresh">Refresh</button><div class="shared-pages-list"></div></section></div>', { url: options.managementOrigin, pretendToBeVisual: true });
  const originals = new Map(["document", "window", "location", "getComputedStyle"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, Object.fromEntries(Object.entries({ document: dom.window.document, window: dom.window, location: dom.window.location, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) }).map(([name, value]) => [name, { configurable: true, writable: true, value }])));
  const button = document.querySelector<HTMLButtonElement>("#toggle")!;
  const popup = document.querySelector<HTMLElement>("section")!;
  const tabs: any[] = [];
  dom.window.open = (() => { const tab = { opener: {}, closed: false, document: new JSDOM().window.document, target: "", location: { replace(url: string) { tab.target = url; } }, close() { tab.closed = true; } }; tabs.push(tab); return tab; }) as never;
  try { await run({ dom, button, popup, tabs }); }
  finally { dom.window.close(); for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; } }
}

test("closing or disconnecting the popup discards late list and link replies", async () => {
  await fixture(async ({ button, popup, tabs }) => {
    let connected = true;
    const lists: Array<(value: unknown) => void> = [];
    const links: Array<(value: unknown) => void> = [];
    const controller = createSharedPages({ button, popup, online: () => connected, available: () => true, slug: () => "casey", load: () => new Promise((resolve) => lists.push(resolve)), reveal: () => new Promise((resolve) => links.push(resolve)) });
    button.click(); controller.close();
    lists[0]!({ pages: [{ publicationId: "report", title: "Old result" }] }); await tick();
    assert.equal(popup.textContent.includes("Old result"), false);
    button.click(); lists[1]!({ pages: [{ publicationId: "report", title: "Current report" }] }); await tick();
    popup.querySelector("[data-page-id]").click();
    assert.equal(tabs[0].opener, null);
    connected = false; controller.connectionChanged();
    links[0]!(link); await tick();
    assert.equal(tabs[0].closed, true); assert.equal(tabs[0].target, "");
    assert.match(popup.textContent, /Open work-fold on your desktop/);
    assert.equal(popup.querySelector("a"), null);
    connected = true; controller.connectionChanged();
    lists[2]!({ pages: [] }); await tick();
    assert.match(popup.textContent, /Share a page in work-fold/);
    assert.equal(popup.querySelector("[data-page-id]"), null);
    controller.destroy();
  });
});

test("blocked windows have a temporary fallback, escaped titles, and a fresh link per click", async () => {
  await fixture(async ({ dom, button, popup }) => {
    dom.window.open = (() => null) as never;
    let supported = false, reads = 0, reveals = 0;
    const controller = createSharedPages({ button, popup, online: () => true, available: () => supported, slug: () => "casey", load: async () => { reads++; return { pages: [{ publicationId: "report", title: '<img src="bad">' }] }; }, reveal: async () => { reveals++; return link; } });
    button.click(); await tick(); assert.equal(reads, 0); assert.match(popup.textContent, /Update work-fold/);
    supported = true; controller.capabilityChanged(); await tick();
    assert.equal(popup.querySelector("img"), null);
    assert.match(popup.textContent, /<img src="bad">/);
    popup.querySelector("[data-page-id]").click(); await tick();
    const fallback = popup.querySelector("a");
    assert.equal(fallback.href, `${origin}/p/report#${key}`);
    assert.equal(fallback.rel, "noopener noreferrer");
    assert.match(popup.textContent, /browser blocked/);
    controller.close(); assert.equal(popup.querySelector("a"), null);
    button.click(); await tick(); popup.querySelector("[data-page-id]").click(); await tick();
    assert.equal(reveals, 2);
    assert.equal(dom.window.localStorage.length + dom.window.sessionStorage.length, 0);
    controller.destroy();
  });
});
