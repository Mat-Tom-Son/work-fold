import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// The web client's Published view (docs/pages.md, "Publishing (stage 2)"),
// exercised through the shipped client: from the paired sidebar (inert
// fixture) and from the offline gate before pairing (stubbed bridge).
const bundle = await build({
  entryPoints: ["services/bridge/public/app.js"],
  bundle: true, format: "iife", platform: "browser", write: false,
});

const pageId = "pg_gardenpartyrsvpabcdefghijk";
const settle = async () => { for (let index = 0; index < 6; index += 1) await new Promise<void>((done) => setTimeout(done, 2)); };

type Call = { url: string; method: string; headers: Record<string, string>; body?: string; credentials?: string };
type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

function client(url: string, routes?: (call: Call) => Reply | undefined) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url, runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(source: string): unknown };
  const calls: Call[] = [];
  const downloads: Array<{ download: string; href: string }> = [];
  const copied: string[] = [];
  Object.assign(win, {
    TextEncoder, TextDecoder, structuredClone,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    CSS: { escape: (value: string) => value.replace(/[\\"]/g, "\\$&") },
    indexedDB: fakeIndexedDb(),
    EventSource: class { constructor() { throw new Error("The Published view never opens an event stream."); } },
    fetch: async (input: string, init: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string } = {}) => {
      const call: Call = { url: String(input), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body, credentials: init.credentials };
      calls.push(call);
      if (!routes) throw new Error("Fixture reached the network");
      const reply = routes(call) ?? { status: 404, body: { ok: false, error: "Not found." } };
      const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: async () => reply.body ?? JSON.parse(reply.text ?? ""),
        blob: async () => new win.Blob([reply.text ?? JSON.stringify(reply.body)], { type: headers["content-type"] ?? "" }),
      };
    },
  });
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  win.URL.createObjectURL = () => "blob:http://localhost/export";
  win.URL.revokeObjectURL = () => {};
  win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloads.push({ download: this.download, href: this.href }); };
  win.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
  win.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.open = false; };
  win.HTMLElement.prototype.scrollTo = function (this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
  } as HTMLElement["scrollTo"];
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.eval(bundle.outputFiles[0]!.text);
  const document = win.document;
  const click = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    assert.ok(element, `missing ${selector}`);
    element.click();
  };
  const dialog = () => document.querySelector<HTMLDialogElement>(".published-dialog");
  return { dom, win, document, calls, downloads, copied, click, dialog };
}

/** Just enough IndexedDB for a browser that has never been paired. */
function fakeIndexedDb() {
  const request = <T>(result: T) => {
    const pending: { result?: T; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
    setTimeout(() => { pending.result = result; pending.onupgradeneeded?.(); pending.onsuccess?.(); });
    return pending;
  };
  const database = {
    createObjectStore() {},
    transaction() {
      const transaction: { oncomplete?: () => void; objectStore(): unknown } = {
        objectStore: () => ({ get: () => request(undefined), put: () => { setTimeout(() => transaction.oncomplete?.()); } }),
      };
      return transaction;
    },
  };
  return { open: () => request(database) };
}

function pathOf(call: Call) {
  const url = new URL(call.url, "http://localhost");
  return { path: url.pathname, query: url.searchParams };
}

test("the paired sidebar opens Published over the chat, and the fixture stays inert", async (t) => {
  const f = client("http://localhost/?fixture=chat");
  t.after(() => f.dom.window.close());
  await settle();
  const entry = f.document.querySelector<HTMLButtonElement>(".sidebar-foot #open-published")!;
  assert.equal(entry.getAttribute("aria-label"), "Published");
  assert.equal(entry.textContent!.trim(), "Published");
  assert.ok(entry.compareDocumentPosition(f.document.querySelector("#account-settings")!) & f.win.Node.DOCUMENT_POSITION_FOLLOWING,
    "Published sits beside Settings in the sidebar footer");

  entry.click();
  await settle();
  assert.equal(f.dialog()!.open, true);
  assert.equal(f.document.querySelector(".published-dialog h2")!.textContent, "Published");
  const items = [...f.document.querySelectorAll(".published-item")];
  assert.deepEqual(items.map((item) => item.querySelector("h3")!.textContent), ["Garden Party RSVP", "Book club sign-up", "Bake sale poll"]);
  assert.deepEqual(items.map((item) => item.querySelector(".published-pill")!.textContent), ["Online", "Online", "Unpublished"]);
  assert.equal(items[0]!.querySelector<HTMLInputElement>(".published-link")!.value, `https://pages.work-fold.com/p/${pageId}`);
  assert.equal(items[0]!.querySelector<HTMLAnchorElement>("a.published-button")!.textContent, "Open");
  assert.equal(items[0]!.querySelector<HTMLAnchorElement>("a.published-button")!.rel, "noopener noreferrer");
  assert.equal(items[2]!.querySelector(".published-link"), null, "an unpublished page has no live link");
  assert.deepEqual(items.map((item) => item.querySelector(".published-meta")!.textContent), ["4 entries", "No entries", "3 entries"]);

  f.click(`[data-copy-link="https://pages.work-fold.com/p/${pageId}"]`);
  await settle();
  assert.deepEqual(f.copied, [`https://pages.work-fold.com/p/${pageId}`]);
  assert.equal(f.document.querySelector(".published-status")!.textContent, "Link copied.");

  f.click(`[data-open-page="${pageId}"]`);
  await settle();
  assert.equal(f.document.querySelector(".published-dialog h2")!.textContent, "Garden Party RSVP");
  assert.equal(f.document.querySelector<HTMLButtonElement>("[data-published-back]")!.hidden, false);
  const headings = [...f.document.querySelectorAll(".published-grid th")].map((cell) => cell.textContent);
  assert.deepEqual(headings, ["Added", "Name", "Email", "Guests", "Bringing"]);
  assert.deepEqual([...f.document.querySelectorAll(".published-grid tbody tr")].map((row) => row.children[1]!.textContent),
    ["Jordan Ellis", "Ana Lima", "Tom Becker", "Priya Natarajan"], "entries read newest first");

  f.click("[data-export-table=rsvps]");
  await settle();
  assert.equal(f.downloads.length, 0, "a fixture never downloads anything");
  assert.match(f.document.querySelector(".published-status")!.textContent!, /Fixture preview is inert/);

  f.click("[data-unpublish]");
  await settle();
  assert.match(f.document.querySelector(".published-result")!.textContent!, /^Unpublished\. Anyone opening the link now sees “Nothing is published here\.” The entries are kept/);
  assert.equal(f.document.querySelector("[data-unpublish]"), null);
  assert.equal(f.document.querySelector(".published-summary .published-pill")!.textContent, "Unpublished");
  assert.equal(f.document.activeElement, f.document.querySelector(".published-result"), "the result takes the focus the button had");

  f.click("[data-published-back]");
  await settle();
  assert.equal(f.document.querySelector(".published-dialog h2")!.textContent, "Published");
  assert.equal(f.document.querySelector(".published-item .published-pill")!.textContent, "Unpublished");
  assert.equal(f.document.activeElement, f.document.querySelector(`[data-open-page="${pageId}"]`));

  f.click("[data-published-close]");
  assert.equal(f.dialog()!.open, false);
  assert.equal(f.document.activeElement, entry, "closing returns to the sidebar entry");
  assert.match(f.document.querySelector("#message-rows")!.textContent!, /weekend in Montréal/, "the chat underneath is untouched");
  assert.deepEqual(f.calls, []);
});

test("signed in with the desktop off and no pairing, the owner reads entries, exports, and unpublishes", async (t) => {
  const tables = { tables: [{ name: "rsvps", retired: false, limit: 50, live: 2, deleted: 0, newCount: 0, lastSeen: null }] };
  const rows = {
    table: "rsvps", retired: false, limit: 50, deleted: false, total: 2, lastSeen: null,
    columns: [{ name: "name", type: "text" }, { name: "coming", type: "boolean" }, { name: "first_course", type: "choice" }, { name: "phone", type: "text", retired: true }],
    rows: [
      { id: "r1", createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", name: "Ada", coming: true, first_course: "Soup", phone: null },
      { id: "r2", createdAt: "2026-11-04T10:00:00.000Z", updatedAt: "2026-11-04T10:00:00.000Z", name: "Grace <b>", coming: false, first_course: null, phone: "555" },
    ],
  };
  let status = "online";
  const f = client("http://localhost/?slug=casey", (call) => {
    const { path, query } = pathOf(call);
    assert.equal(query.get("slug"), "casey", "loopback requests carry the address");
    if (path === "/api/public/context") return { status: 200, body: { domain: "work-fold.com", slug: "casey", addressAvailable: true, authenticated: true, paired: false, desktopOnline: false } };
    if (path === "/api/auth/session") return { status: 200, body: { authenticated: true, paired: false, slug: "casey", desktopOnline: false, csrfToken: "csrf-casey", challenge: "challenge" } };
    if (path === "/api/pages") {
      return { status: 200, body: { pagesOrigin: "https://pages.work-fold.test", pages: [{ pageId, title: "Garden Party RSVP", status, revision: 1, publishedAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z", dataRevision: 2, entries: 2 }] } };
    }
    if (path === `/api/pages/${pageId}/data`) return { status: 200, body: query.get("table") === "rsvps" ? rows : tables };
    if (path === `/api/pages/${pageId}/data/export`) {
      return { status: 200, text: "﻿name,coming\nGrace,false\nAda,true\n", headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="rsvps.csv"' } };
    }
    if (path === `/api/pages/${pageId}/unpublish`) {
      status = "unpublished";
      return { status: 200, body: { page: { pageId, title: "Garden Party RSVP", status, entries: 2 } } };
    }
    return undefined;
  });
  t.after(() => f.dom.window.close());
  await settle();
  // The offline gate, before any pairing, offers the way in.
  assert.match(f.document.querySelector(".auth-copy")!.textContent!, /Desktop offline/);
  assert.equal(f.document.querySelector("#open-published")!.textContent, "Published pages");
  f.click("#open-published");
  await settle();
  assert.equal(f.dialog()!.open, true);
  assert.equal(f.document.querySelector<HTMLInputElement>(".published-link")!.value, `https://pages.work-fold.test/p/${pageId}`);
  assert.equal(f.document.querySelector(".published-item .published-meta")!.textContent, "2 entries");

  f.click(`[data-open-page="${pageId}"]`);
  await settle();
  assert.match(f.document.querySelector(".published-summary-line")!.textContent!, /Online\s*2 entries · Published Nov 1, 2026/);
  assert.deepEqual([...f.document.querySelectorAll(".published-grid th")].map((cell) => cell.textContent),
    ["Added", "Name", "Coming", "First Course", "Phone (no longer collected)"]);
  const cells = [...f.document.querySelectorAll(".published-grid tbody tr")].map((row) => [...row.children].slice(1).map((cell) => cell.textContent));
  assert.deepEqual(cells, [["Grace <b>", "No", "", "555"], ["Ada", "Yes", "Soup", ""]], "newest first, as plain text");
  assert.equal(f.document.querySelector(".published-grid b"), null, "entry text never becomes markup");

  f.click("[data-export-table=rsvps]");
  await settle();
  assert.deepEqual(f.downloads, [{ download: "Garden Party RSVP - Rsvps.csv", href: "blob:http://localhost/export" }]);
  assert.equal(f.document.querySelector(".published-status")!.textContent, "Exported Rsvps.");
  const exportCall = f.calls.find((call) => pathOf(call).path.endsWith("/data/export"))!;
  assert.equal(pathOf(exportCall).query.get("table"), "rsvps");
  assert.equal(exportCall.credentials, "same-origin");

  f.click("[data-unpublish]");
  await settle();
  const unpublish = f.calls.find((call) => pathOf(call).path.endsWith("/unpublish"))!;
  assert.equal(unpublish.method, "POST");
  assert.equal(unpublish.headers["x-work-fold-csrf"], "csrf-casey");
  assert.equal(unpublish.body, "{}");
  assert.match(f.document.querySelector(".published-result")!.textContent!, /^Unpublished\./);

  f.click("[data-published-back]");
  await settle();
  assert.equal(f.document.querySelector(".published-item .published-pill")!.textContent, "Unpublished");
  f.click("[data-published-close]");
  assert.equal(f.dialog()!.open, false);
  assert.ok(f.document.querySelector("#retry"), "the offline gate is still underneath");
  assert.equal(f.calls.some((call) => pathOf(call).path.startsWith("/api/pairings")), false, "reading Published never starts a pairing");
  assert.equal(f.calls.some((call) => pathOf(call).path.startsWith("/api/operations")), false);
});

test("Published says plainly when online pages aren't available, and a lapsed session returns to sign-in", async (t) => {
  let signedIn = true;
  const f = client("http://localhost/?slug=casey", (call) => {
    const { path } = pathOf(call);
    if (path === "/api/public/context") return { status: 200, body: { slug: "casey", addressAvailable: true, authenticated: signedIn, paired: false, desktopOnline: false } };
    if (path === "/api/auth/session") return signedIn ? { status: 200, body: { authenticated: true, paired: false, desktopOnline: false, csrfToken: "csrf" } } : { status: 401, body: { ok: false, error: "Sign in to continue." } };
    if (path === "/api/pages" && signedIn) return { status: 503, body: { ok: false, error: "Online pages aren't available yet.", code: "UNAVAILABLE", message: "Online pages aren't available yet." } };
    if (path === "/api/pages") return { status: 401, body: { ok: false, error: "Sign in to continue." } };
    return undefined;
  });
  t.after(() => f.dom.window.close());
  await settle();
  f.click("#open-published");
  await settle();
  assert.equal(f.document.querySelector(".published-failure p")!.textContent, "Online pages aren't available yet.");
  assert.ok(f.document.querySelector("[data-published-retry]"));

  signedIn = false;
  f.click("[data-published-retry]");
  await settle();
  assert.equal(f.dialog()!.open, false, "Published closes with the session");
  assert.ok(f.document.querySelector("#login-form"), "sign-in is showing");
});
