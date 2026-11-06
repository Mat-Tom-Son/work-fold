import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  PAGE_DOCUMENT_CONTENT_SECURITY_POLICY,
  PAGE_FRAME_CONTENT_SECURITY_POLICY,
  PAGE_FRAME_HTML,
  PAGE_FRAME_MESSAGE,
  PAGE_FRAME_SCRIPT,
  PAGE_RUNTIME_SCRIPT,
} from "../src/local/pages/frame/page-frame-assets.js";
import { externalPageLink, mountPageFrame, pageCallFrom, pageFrameMessage, pageFrameSandbox } from "../web-local/src/lib/page-frame-host.js";
import { PageCallFailure, pageCallErrorFrom } from "../web-local/src/lib/pages.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Values made in a JSDOM window, as plain values of this realm. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

test("the intermediary and the page run under the documented policies", () => {
  assert.equal(PAGE_DOCUMENT_CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'");
  const directives = new Map(PAGE_FRAME_CONTENT_SECURITY_POLICY.split("; ").map((directive) => [directive.split(" ")[0], directive]));
  // Only its own script and the blob child are added to the page's policy.
  assert.equal(directives.get("script-src"), "script-src 'self' 'unsafe-inline'");
  assert.equal(directives.get("frame-src"), "frame-src blob:");
  assert.equal(directives.get("connect-src"), "connect-src 'none'");
  assert.equal(directives.get("form-action"), "form-action 'none'");
  assert.equal(directives.get("sandbox"), "sandbox allow-scripts allow-forms");
  assert.doesNotMatch(PAGE_FRAME_CONTENT_SECURITY_POLICY, /allow-same-origin|unsafe-eval|https?:/);
  assert.match(PAGE_FRAME_HTML, /<script src="\/page-frame\.js" defer><\/script>/);
  assert.doesNotMatch(PAGE_FRAME_HTML.replace('<script src="/page-frame.js" defer></script>', ""), /<script/);
  assert.deepEqual(pageFrameMessage, PAGE_FRAME_MESSAGE, "the host and the sandbox speak the same messages");
  assert.equal(pageFrameSandbox, "allow-scripts allow-forms");
  assert.doesNotMatch(PAGE_RUNTIME_SCRIPT, /<\/script|<!--|<script/i, "the runtime can be inlined into any page");
  new Function(PAGE_FRAME_SCRIPT);
  new Function(PAGE_RUNTIME_SCRIPT.replace("__WORK_FOLD_PAGE_CONFIG__", "{}"));
});

/** The intermediary, alone in a window whose parent is itself (as JSDOM's top window is). */
function intermediary() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "http://127.0.0.1:4327/page-frame.html" });
  const window = dom.window;
  const toHost: any[] = [];
  const blobs: string[] = [];
  (window as any).postMessage = (message: unknown) => { toHost.push(plain(message)); };
  (window as any).Blob = class { constructor(parts: string[], readonly options: unknown) { blobs.push(parts.join("")); } };
  (window.URL as any).createObjectURL = () => "about:blank";
  (window.URL as any).revokeObjectURL = () => undefined;
  window.eval(PAGE_FRAME_SCRIPT);
  const send = (data: unknown, source: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: source as any }));
  return { dom, window, toHost, blobs, send, frame: () => window.document.querySelector("iframe") };
}

test("the intermediary loads one page into a sandboxed blob child, with the policy and runtime first", () => {
  const view = intermediary();
  try {
    assert.deepEqual(view.toHost, [{ type: "work-fold.page.ready" }]);
    view.send({ type: "work-fold.page.init", channel: "", html: "<p>x</p>" }, view.window);
    assert.equal(view.frame(), null, "an init without a channel is ignored");
    view.send({ type: "work-fold.page.init", channel: "view-1", html: "<p>x</p>" }, null);
    assert.equal(view.frame(), null, "only the parent may hand over a page");
    view.send({
      type: "work-fold.page.init",
      channel: "view-1",
      html: "<!DOCTYPE html>\n<html lang=\"en\"><head><title>RSVP</title></head><body><form data-page-table=\"rsvps\"></form></body></html>",
      title: "Garden Party",
      owner: true,
      tables: { rsvps: { name: "text", guests: "number", "Bad Name": "text" }, "</script>": { x: "text" } },
    }, view.window);
    const frame = view.frame()!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(frame.title, "Garden Party");
    const source = view.blobs[0]!;
    assert.match(source, /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline';[^"]*frame-src 'none'; base-uri 'none'"><script>\(function \(\) \{/);
    assert.match(source, /var config = \{"owner":true,"tables":\{"rsvps":\{"name":"text","guests":"number"\}\}\};/, "only declared-looking names reach the runtime");
    assert.match(source, /<\/script>\n<html lang="en"><head><title>RSVP<\/title>/, "the page follows the runtime, its doctype first");
    view.send({ type: "work-fold.page.init", channel: "view-2", html: "<p>other</p>" }, view.window);
    assert.equal(view.blobs.length, 1, "a view holds one page");
  } finally { view.dom.window.close(); }
});

test("the intermediary forwards only its child's messages up, and only its channel's answers down", () => {
  const view = intermediary();
  try {
    view.send({ type: "work-fold.page.init", channel: "view-1", html: "<p>x</p>" }, view.window);
    const child = view.frame()!.contentWindow!;
    const toChild: any[] = [];
    (child as any).postMessage = (message: unknown) => { toChild.push(plain(message)); };
    view.toHost.length = 0;
    view.send({ type: "work-fold.page.loaded" }, child);
    view.send({ type: "work-fold.page.call", callId: 1, call: { op: "count", table: "rsvps" } }, child);
    view.send({ type: "work-fold.page.call", callId: "1", call: { op: "count", table: "rsvps" } }, child);
    view.send({ type: "work-fold.page.link", href: "https://example.com/" }, child);
    view.send({ type: "work-fold.page.call", callId: 2, call: { op: "count" } }, view.window);
    view.send({ type: "work-fold.page.loaded" }, null);
    assert.deepEqual(view.toHost, [
      { type: "work-fold.page.loaded", channel: "view-1" },
      { type: "work-fold.page.call", channel: "view-1", callId: 1, call: { op: "count", table: "rsvps" } },
      { type: "work-fold.page.link", channel: "view-1", href: "https://example.com/" },
    ]);
    view.send({ type: "work-fold.page.result", channel: "other", callId: 1, ok: true, result: 3 }, view.window);
    view.send({ type: "work-fold.page.result", channel: "view-1", callId: 1, ok: true, result: 3 }, child);
    view.send({ type: "work-fold.page.result", channel: "view-1", callId: 1, ok: true, result: 3 }, view.window);
    view.send({ type: "work-fold.page.changed", channel: "view-1", table: "rsvps" }, view.window);
    assert.deepEqual(toChild, [
      { type: "work-fold.page.result", callId: 1, ok: true, result: 3 },
      { type: "work-fold.page.changed", table: "rsvps" },
    ], "the channel never reaches page code");
    const violation = new view.window.Event("securitypolicyviolation");
    Object.defineProperty(violation, "effectiveDirective", { value: "frame-src" });
    view.window.dispatchEvent(violation);
    assert.deepEqual(view.toHost.at(-1), { type: "work-fold.page.navigated", channel: "view-1" }, "a page trying to leave is reported");
  } finally { view.dom.window.close(); }
});

/** The runtime inside a page; its parent is its own window here, so its posts are captured. */
function runtime(body: string, config: unknown = { owner: false, tables: { rsvps: { name: "text", email: "email", guests: "number", vegan: "boolean", bringing: "choice", notes: "long-text" } } }) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { runScripts: "outside-only", url: "about:blank" });
  const window = dom.window;
  const posted: any[] = [];
  (window as any).postMessage = (message: unknown) => { posted.push(plain(message)); };
  window.eval(PAGE_RUNTIME_SCRIPT.replace("__WORK_FOLD_PAGE_CONFIG__", JSON.stringify(config)));
  const reply = (data: unknown, source: unknown = window) => window.dispatchEvent(new window.MessageEvent("message", { data, source: source as any }));
  const calls = () => posted.filter((message) => message.type === "work-fold.page.call");
  return { dom, window, posted, reply, calls, page: (window as any).workFoldPage };
}

test("workFoldPage sends each call to the host and settles it with the host's answer", async () => {
  const view = runtime("<p>Hi</p>", { owner: true, tables: {} });
  try {
    assert.ok(Object.isFrozen(view.page));
    assert.throws(() => { (view.window as any).workFoldPage = {}; });
    assert.equal(await view.page.isOwner(), true);
    const added = view.page.add("rsvps", { name: "Ada" });
    const [call] = view.calls();
    assert.equal(call.call.op, "add");
    assert.deepEqual(call.call.values, { name: "Ada" });
    assert.match(call.call.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "every add carries a request id");
    view.reply({ type: "work-fold.page.result", callId: call.callId, ok: true, result: { id: "r1", name: "Ada" } }, null);
    view.reply({ type: "work-fold.page.result", callId: call.callId, ok: true, result: { id: "r1", name: "Ada" } });
    assert.deepEqual(plain(await added), { id: "r1", name: "Ada" });

    const listed = view.page.list("rsvps", { limit: 5, newestFirst: true });
    const listCall = view.calls().at(-1);
    assert.deepEqual(listCall.call, { op: "list", table: "rsvps", options: { limit: 5, newestFirst: true } });
    view.reply({ type: "work-fold.page.result", callId: listCall.callId, ok: false, error: { code: "NOT_ALLOWED", message: "Visitors can't see everyone's replies.", field: 3 } });
    await assert.rejects(listed, (error: any) => error.code === "NOT_ALLOWED" && error.message === "Visitors can't see everyone's replies." && !("field" in error));

    const counted = view.page.count("rsvps", { bringing: "Salad" });
    const countCall = view.calls().at(-1);
    assert.deepEqual(countCall.call, { op: "count", table: "rsvps", where: { bringing: "Salad" } });
    view.reply({ type: "work-fold.page.result", callId: countCall.callId, ok: false, error: { code: "INVALID", message: "Bringing isn't a column.", field: "bringing" } });
    await assert.rejects(counted, { code: "INVALID", message: "Bringing isn't a column.", field: "bringing" });

    const cyclic: any = {}; cyclic.self = cyclic;
    const before = view.calls().length;
    await assert.rejects(view.page.update("rsvps", "r1", cyclic), { code: "INVALID" });
    await assert.rejects(view.page.mine(""), { code: "INVALID" });
    assert.equal(view.calls().length, before, "a call that can't be sent is refused in the page");

    const changes: any[] = [];
    const stop = view.page.onChange((detail: unknown) => changes.push(detail));
    view.reply({ type: "work-fold.page.changed", table: "rsvps" });
    view.reply({ type: "work-fold.page.changed", table: "rsvps" }, null);
    stop();
    view.reply({ type: "work-fold.page.changed", table: null });
    assert.deepEqual(plain(changes), [{ table: "rsvps" }]);
    assert.ok(view.posted.some((message) => message.type === "work-fold.page.loaded"), "the page says when it is ready");
  } finally { view.dom.window.close(); }
});

test("the form helper saves a form, marks its state, and keeps one request id until it is saved", async () => {
  const view = runtime(`
    <form data-page-table="rsvps">
      <input name="name" value="Ada Lovelace">
      <input name="email" type="email" value="ada@example.com">
      <input name="guests" type="number" value="2">
      <input name="vegan" type="checkbox" checked>
      <input name="notes" value="   ">
      <input name="stray" value="not a column">
      <label><input type="radio" name="bringing" value="Salad">Salad</label>
      <label><input type="radio" name="bringing" value="Drinks" checked>Drinks</label>
      <button>Send</button>
      <p data-page-message>old</p>
    </form>
    <form id="own" data-page-table="rsvps"><input name="name" value="x"><button>Own</button></form>`);
  try {
    const form = view.window.document.querySelector("form")!;
    const button = form.querySelector("button")!;
    const events: string[] = [];
    form.addEventListener("page:sent", (event: any) => events.push(`sent:${event.detail.id}`));
    form.addEventListener("page:error", (event: any) => events.push(`error:${event.detail.code}`));

    form.requestSubmit();
    assert.equal(form.dataset.pageState, "sending");
    assert.equal(button.disabled, true, "sending can't be started twice");
    assert.equal(form.querySelector("[data-page-message]")!.textContent, "");
    form.requestSubmit();
    assert.equal(view.calls().length, 1);
    const first = view.calls()[0];
    assert.deepEqual(first.call.values, { name: "Ada Lovelace", email: "ada@example.com", guests: 2, vegan: true, bringing: "Drinks" }, "fields by name, typed, empty and stray ones left out");

    view.reply({ type: "work-fold.page.result", callId: first.callId, ok: false, error: { code: "UNAVAILABLE", message: "Try again." } });
    await flush();
    assert.equal(form.dataset.pageState, "error");
    assert.equal(form.querySelector("[data-page-message]")!.textContent, "Try again.");
    assert.equal(button.disabled, false);
    form.requestSubmit();
    const retry = view.calls()[1];
    assert.equal(retry.call.requestId, first.call.requestId, "a retry after a lost answer is the same add");

    view.reply({ type: "work-fold.page.result", callId: retry.callId, ok: true, result: { id: "r1" } });
    await flush();
    assert.equal(form.dataset.pageState, "sent");
    assert.equal((form.querySelector("input[name=name]") as HTMLInputElement).value, "Ada Lovelace", "reset returns fields to their defaults");
    assert.equal(form.querySelector("[data-page-message]")!.textContent, "");
    assert.deepEqual(events, ["error:UNAVAILABLE", "sent:r1"]);

    form.requestSubmit();
    const next = view.calls()[2];
    assert.notEqual(next.call.requestId, first.call.requestId, "a saved entry's id is not reused");
    view.reply({ type: "work-fold.page.result", callId: next.callId, ok: false, error: { code: "DUPLICATE", message: "Someone already replied with that email.", field: "email" } });
    await flush();
    form.requestSubmit();
    assert.notEqual(view.calls()[3].call.requestId, next.call.requestId, "a refused add made nothing, so the next one is new");

    const own = view.window.document.getElementById("own") as HTMLFormElement;
    own.addEventListener("submit", (event) => event.preventDefault());
    const count = view.calls().length;
    own.requestSubmit();
    assert.equal(view.calls().length, count, "a page that handles its own submit keeps it");
  } finally { view.dom.window.close(); }
});

test("web and email links open outside the page; nothing else navigates it", () => {
  const view = runtime('<a id="web" href="https://example.com/directions">Directions</a><a id="mail" href="mailto:host@example.com"><span id="inner">Mail</span></a><a id="here" href="#rsvp">Down</a><a id="rel" href="other.html">Other</a><a id="file" href="file:///etc/hosts">File</a>');
  try {
    const click = (id: string) => {
      const event = new view.window.MouseEvent("click", { bubbles: true, cancelable: true });
      view.window.document.getElementById(id)!.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(click("web"), true);
    assert.equal(click("inner"), true);
    assert.equal(click("here"), false, "same-page anchors still scroll");
    assert.equal(click("rel"), true);
    assert.equal(click("file"), true);
    assert.deepEqual(view.posted.filter((message) => message.type === "work-fold.page.link").map((message) => message.href), ["https://example.com/directions", "mailto:host@example.com"]);
  } finally { view.dom.window.close(); }
});

test("the page tab's frame answers only its intermediary on its channel, within bounds", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=host></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  const previous = { window: (globalThis as any).window, document: (globalThis as any).document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const calls: any[] = [];
  const waiting: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const opened: string[] = [];
  const mutated: string[] = [];
  const states: string[] = [];
  try {
    const handle = mountPageFrame({
      container: dom.window.document.getElementById("host")!,
      frameUrl: "about:blank",
      title: "Garden Party",
      html: "<p>RSVP</p>",
      owner: false,
      tables: { rsvps: { name: "text" } },
      channel: "view-1",
      call: (call) => { calls.push(call); return new Promise((resolve, reject) => waiting.push({ resolve, reject })); },
      openLink: (href) => opened.push(href),
      onLoaded: () => states.push("loaded"),
      onFailed: (reason) => states.push(reason),
      onMutated: (table) => mutated.push(table),
      loadTimeoutMs: 60_000,
    });
    const frame = handle.frame;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms");
    assert.doesNotMatch(frame.getAttribute("sandbox")!, /allow-same-origin/);
    const intermediary = frame.contentWindow!;
    const sent: any[] = [];
    (intermediary as any).postMessage = (message: unknown) => { sent.push(message); };
    const send = (data: unknown, source: unknown = intermediary) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: source as any }));

    send({ type: pageFrameMessage.ready }, dom.window);
    assert.equal(sent.length, 0, "another window can't take the page");
    send({ type: pageFrameMessage.ready });
    assert.deepEqual(sent[0], { type: pageFrameMessage.init, channel: "view-1", html: "<p>RSVP</p>", title: "Garden Party", owner: false, tables: { rsvps: { name: "text" } } });
    send({ type: pageFrameMessage.ready });
    assert.equal(sent.length, 1, "the page is handed over once");

    send({ type: pageFrameMessage.loaded, channel: "other" });
    send({ type: pageFrameMessage.loaded, channel: "view-1" });
    assert.deepEqual(states, ["loaded"]);

    send({ type: pageFrameMessage.call, channel: "view-1", callId: 1, call: { op: "add", table: "rsvps", values: { name: "Ada" }, requestId: "req-1", viewer: { role: "owner" } } });
    assert.deepEqual(calls[0], { op: "add", table: "rsvps", values: { name: "Ada" }, requestId: "req-1" }, "a page never chooses who it is");
    send({ type: pageFrameMessage.call, channel: "view-1", callId: 2, call: { op: "drop", table: "rsvps" } });
    assert.deepEqual(sent.at(-1), { type: pageFrameMessage.result, channel: "view-1", callId: 2, ok: false, error: { code: "INVALID", message: "That isn't something a page can ask for." } });
    send({ type: pageFrameMessage.call, channel: "view-2", callId: 3, call: { op: "count", table: "rsvps" } });
    assert.equal(calls.length, 1);

    waiting[0]!.resolve({ id: "r1", name: "Ada" });
    await flush();
    assert.deepEqual(sent.slice(-2), [
      { type: pageFrameMessage.result, channel: "view-1", callId: 1, ok: true, result: { id: "r1", name: "Ada" } },
      { type: pageFrameMessage.changed, channel: "view-1", table: "rsvps" },
    ], "a change from the page reaches its own onChange");
    assert.deepEqual(mutated, ["rsvps"]);

    for (let callId = 10; callId < 19; callId++) send({ type: pageFrameMessage.call, channel: "view-1", callId, call: { op: "count", table: "rsvps" } });
    assert.equal(calls.length, 9);
    assert.equal(sent.at(-1).error.code, "UNAVAILABLE", "at most eight calls at once");
    waiting[1]!.reject(new PageCallFailure({ code: "NOT_ALLOWED", message: "No.", field: "name" }));
    await flush();
    assert.deepEqual(sent.at(-1), { type: pageFrameMessage.result, channel: "view-1", callId: 10, ok: false, error: { code: "NOT_ALLOWED", message: "No.", field: "name" } });

    send({ type: pageFrameMessage.link, channel: "view-1", href: "javascript:alert(1)" });
    send({ type: pageFrameMessage.link, channel: "view-1", href: "https://example.com/x" });
    assert.deepEqual(opened, ["https://example.com/x"]);
    send({ type: pageFrameMessage.navigated, channel: "view-1" });
    assert.deepEqual(states, ["loaded", "navigated"]);

    handle.notifyChanged("rsvps");
    assert.deepEqual(sent.at(-1), { type: pageFrameMessage.changed, channel: "view-1", table: "rsvps" });
    const count = sent.length;
    handle.destroy();
    waiting[2]!.resolve(3);
    await flush();
    assert.equal(sent.length, count, "a closed view hears nothing more");
    assert.equal(frame.isConnected, false);
  } finally {
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

test("a page that never starts is reported", async () => {
  const dom = new JSDOM("<!doctype html><div id=host></div>", { url: "http://localhost/" });
  const previous = { window: (globalThis as any).window, document: (globalThis as any).document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    const states: string[] = [];
    const handle = mountPageFrame({ container: dom.window.document.getElementById("host")!, frameUrl: "about:blank", title: "P", html: "", owner: false, tables: {}, call: async () => null, openLink() {}, onFailed: (reason) => states.push(reason), loadTimeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(states, ["timeout"]);
    handle.destroy();
  } finally {
    dom.window.close();
    Object.assign(globalThis, previous);
  }
});

test("calls and refusals keep their documented shapes across the host", () => {
  assert.equal(pageCallFrom({ op: "isOwner", table: "x" }), null, "isOwner is answered in the page");
  assert.equal(pageCallFrom({ op: "count", table: "x".repeat(65) }), null);
  assert.equal(pageCallFrom({ op: "add", table: "rsvps", requestId: 7 }), null);
  assert.deepEqual(pageCallFrom({ op: "remove", table: "rsvps", id: "r1", extra: true }), { op: "remove", table: "rsvps", id: "r1" });
  assert.equal(externalPageLink("https://example.com/a b"), "https://example.com/a%20b");
  assert.equal(externalPageLink("mailto:a@example.com"), "mailto:a@example.com");
  for (const href of ["javascript:alert(1)", "file:///etc/hosts", "data:text/html,x", "work-fold-desktop://app/index.html", "relative.html"]) assert.equal(externalPageLink(href), null, href);
  assert.deepEqual(pageCallErrorFrom({ error: "Someone already replied.", code: "DUPLICATE", message: "Someone already replied.", field: "email" }, 409), { code: "DUPLICATE", message: "Someone already replied.", field: "email" });
  assert.deepEqual(pageCallErrorFrom({ error: { message: "Not found.", code: "NOPE" } }, 404), { code: "NOT_FOUND", message: "Not found." });
  assert.deepEqual(pageCallErrorFrom(null, 502), { code: "UNAVAILABLE", message: "Something went wrong. Try again." });
});
