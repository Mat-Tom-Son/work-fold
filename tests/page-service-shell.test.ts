import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { PAGE_FRAME_MESSAGE } from "../src/local/pages/frame/page-frame-assets.js";
import { PAGE_SHELL_SCRIPT, pageShellHtml } from "../services/pages/src/shell.js";
import { newPageId } from "./support/page-service.js";

/**
 * The shell's host script (services/pages/src/shell.ts) in JSDOM: it runs a
 * page the way the desktop's Preview host does (web-local/src/lib/
 * page-frame-host.ts): one page per view, only its exact intermediary window
 * and channel, only the documented calls, links in a new tab.
 */

const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

interface FakeAnswer { status: number; body: unknown }

function shell(documentAnswer: FakeAnswer) {
  const pageId = newPageId();
  const dom = new JSDOM(pageShellHtml("Garden Party"), { runScripts: "outside-only", url: `http://127.0.0.1:4330/p/${pageId}` });
  const window = dom.window as unknown as Window & typeof globalThis & { eval: (code: string) => unknown };
  const requests: Array<{ url: string; init: RequestInit; answer: (value: FakeAnswer | Error) => void }> = [];
  const opened: unknown[][] = [];
  const respond = (answer: FakeAnswer) => ({
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => answer.body,
    text: async () => JSON.stringify(answer.body),
  });
  (window as any).fetch = (url: string, init: RequestInit = {}) => {
    if (url.endsWith("/document")) {
      requests.push({ url, init, answer: () => undefined });
      return Promise.resolve(respond(documentAnswer));
    }
    return new Promise((resolve, reject) => {
      requests.push({ url, init, answer: (value) => (value instanceof Error ? reject(value) : resolve(respond(value))) });
    });
  };
  (window as any).open = (...args: unknown[]) => { opened.push(args); return null; };
  window.eval(PAGE_SHELL_SCRIPT);
  const frame = () => window.document.querySelector("iframe");
  const sent: any[] = [];
  const send = (data: unknown, source: unknown) => window.dispatchEvent(new window.MessageEvent("message", { data, source: source as any }));
  const notice = () => {
    const element = window.document.getElementById("notice")!;
    return { hidden: element.hidden, heading: element.querySelector("h1")!.textContent, text: element.querySelector("p")!.textContent, reload: !element.querySelector("button")!.hidden };
  };
  return { dom, window, pageId, requests, opened, frame, sent, send, notice };
}

test("the shell hands the page to its own intermediary once, as a visitor", async () => {
  const view = shell({ status: 200, body: { html: "<p>RSVP</p>", title: "Garden Party", tables: { rsvps: { name: "text" } } } });
  try {
    await flush();
    assert.equal(view.requests[0]!.url, `/p/${view.pageId}/document`);
    assert.equal(view.requests[0]!.init.credentials, "same-origin");
    const frame = view.frame()!;
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(frame.getAttribute("src"), "/page-frame.html");
    assert.equal(frame.title, "Garden Party");
    const intermediary = frame.contentWindow!;
    (intermediary as any).postMessage = (message: unknown) => { view.sent.push(plain(message)); };

    view.send({ type: PAGE_FRAME_MESSAGE.ready }, view.window);
    view.send({ type: PAGE_FRAME_MESSAGE.ready }, null);
    assert.equal(view.sent.length, 0, "only the intermediary may take the page");
    view.send({ type: PAGE_FRAME_MESSAGE.ready }, intermediary);
    const init = view.sent[0];
    assert.equal(typeof init.channel, "string");
    assert.ok(init.channel.length >= 16);
    assert.deepEqual(init, { type: PAGE_FRAME_MESSAGE.init, channel: init.channel, html: "<p>RSVP</p>", title: "Garden Party", owner: false, tables: { rsvps: { name: "text" } } });
    view.send({ type: PAGE_FRAME_MESSAGE.ready }, intermediary);
    assert.equal(view.sent.length, 1, "a view holds one page");

    view.send({ type: PAGE_FRAME_MESSAGE.navigated, channel: "other" }, intermediary);
    assert.equal(view.notice().hidden, true, "another channel is ignored");
    view.send({ type: PAGE_FRAME_MESSAGE.navigated, channel: init.channel }, intermediary);
    assert.deepEqual(view.notice(), { hidden: false, heading: "The page tried to leave.", text: "A page stays on one screen; its web links open in a new tab. Reload to show it again.", reload: true });
    view.send({ type: PAGE_FRAME_MESSAGE.loaded, channel: init.channel }, intermediary);
    assert.equal(view.notice().hidden, true);
  } finally {
    view.dom.window.close();
  }
});

test("the shell sends only documented calls, one visitor at a time at first, and relays the answers", async () => {
  const view = shell({ status: 200, body: { html: "<p>RSVP</p>", title: "Garden Party", tables: {} } });
  try {
    await flush();
    const intermediary = view.frame()!.contentWindow!;
    (intermediary as any).postMessage = (message: unknown) => { view.sent.push(plain(message)); };
    view.send({ type: PAGE_FRAME_MESSAGE.ready }, intermediary);
    const channel = view.sent[0].channel as string;
    const call = (callId: unknown, pageCall: unknown, onChannel = channel) => view.send({ type: PAGE_FRAME_MESSAGE.call, channel: onChannel, callId, call: pageCall }, intermediary);
    const results = () => view.sent.filter((message) => message.type === PAGE_FRAME_MESSAGE.result);

    call(1, { op: "add", table: "rsvps", values: { name: "Ada" }, requestId: "req-1", viewer: { role: "owner" }, sql: "DROP TABLE rsvps" });
    call(2, { op: "count", table: "rsvps" });
    await flush();
    const calls = view.requests.filter((request) => request.url.endsWith("/call"));
    assert.equal(calls.length, 1, "later calls wait for the first, which makes the visitor cookie");
    assert.equal(calls[0]!.url, `/p/${view.pageId}/call`);
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[0]!.init.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { call: { op: "add", table: "rsvps", values: { name: "Ada" }, requestId: "req-1" } }, "a page never chooses who it is");
    calls[0]!.answer({ status: 200, body: { result: { id: "r1", name: "Ada" } } });
    await flush();
    assert.deepEqual(results()[0], { type: PAGE_FRAME_MESSAGE.result, callId: 1, ok: true, result: { id: "r1", name: "Ada" }, channel });
    assert.deepEqual(view.sent.find((message) => message.type === PAGE_FRAME_MESSAGE.changed), { type: PAGE_FRAME_MESSAGE.changed, table: "rsvps", channel });
    const second = view.requests.filter((request) => request.url.endsWith("/call"))[1]!;
    second.answer({ status: 409, body: { error: "An entry with this email already exists.", code: "DUPLICATE", message: "An entry with this email already exists.", field: "email" } });
    await flush();
    assert.deepEqual(results()[1], { type: PAGE_FRAME_MESSAGE.result, callId: 2, ok: false, error: { code: "DUPLICATE", message: "An entry with this email already exists.", field: "email" }, channel });

    const before = view.requests.length;
    call(3, { op: "drop", table: "rsvps" });
    call(4, { op: "isOwner", table: "rsvps" });
    call(5, { op: "add", table: "rsvps", requestId: 7 });
    call(6, { op: "count", table: "x".repeat(65) });
    assert.deepEqual(results().slice(2).map((message) => [message.callId, message.error.code]), [[3, "INVALID"], [4, "INVALID"], [5, "INVALID"], [6, "INVALID"]]);
    call(7, { op: "count", table: "rsvps" }, "other-channel");
    call(0, { op: "count", table: "rsvps" });
    call("8", { op: "count", table: "rsvps" });
    view.send({ type: PAGE_FRAME_MESSAGE.call, channel, callId: 9, call: { op: "count", table: "rsvps" } }, view.window);
    await flush();
    assert.equal(view.requests.length, before, "nothing else reaches the service");

    for (let callId = 10; callId < 18; callId += 1) call(callId, { op: "count", table: "rsvps" });
    call(18, { op: "count", table: "rsvps" });
    await flush();
    assert.deepEqual(results().at(-1), { type: PAGE_FRAME_MESSAGE.result, callId: 18, ok: false, error: { code: "UNAVAILABLE", message: "The page is busy. Try again in a moment." }, channel });
    const pending = view.requests.slice(before);
    assert.equal(pending.length, 8);
    pending[0]!.answer(new Error("offline"));
    pending[1]!.answer({ status: 429, body: { code: "UNAVAILABLE", message: "This page is getting a lot of requests right now. Try again in a minute." } });
    pending[2]!.answer({ status: 500, body: null });
    await flush();
    const answered = results().filter((message) => [10, 11, 12].includes(message.callId)).map((message) => message.error);
    assert.deepEqual(answered, [
      { code: "UNAVAILABLE", message: "The page couldn't be reached. Check your connection and try again." },
      { code: "UNAVAILABLE", message: "This page is getting a lot of requests right now. Try again in a minute." },
      { code: "UNAVAILABLE", message: "Something went wrong. Try again." },
    ]);
  } finally {
    view.dom.window.close();
  }
});

test("web and email links open in a new tab; nothing else opens", async () => {
  const view = shell({ status: 200, body: { html: "<p>x</p>", title: "P", tables: {} } });
  try {
    await flush();
    const intermediary = view.frame()!.contentWindow!;
    (intermediary as any).postMessage = (message: unknown) => { view.sent.push(plain(message)); };
    view.send({ type: PAGE_FRAME_MESSAGE.ready }, intermediary);
    const channel = view.sent[0].channel as string;
    for (const href of ["https://example.com/a b", "mailto:host@example.com", "javascript:alert(1)", "data:text/html,x", "/p/other", "file:///etc/hosts"]) {
      view.send({ type: PAGE_FRAME_MESSAGE.link, channel, href }, intermediary);
    }
    view.send({ type: PAGE_FRAME_MESSAGE.link, channel: "other", href: "https://example.com/" }, intermediary);
    assert.deepEqual(view.opened, [
      ["https://example.com/a%20b", "_blank", "noopener,noreferrer"],
      ["mailto:host@example.com", "_blank", "noopener,noreferrer"],
    ]);
  } finally {
    view.dom.window.close();
  }
});

test("a page that isn't published, or can't load, says so", async () => {
  const gone = shell({ status: 404, body: { code: "UNAVAILABLE", message: "Nothing is published here." } });
  const failing = shell({ status: 503, body: null });
  try {
    await flush();
    assert.equal(gone.frame(), null);
    assert.deepEqual(gone.notice(), { hidden: false, heading: "Nothing is published here.", text: "", reload: false });
    assert.equal(failing.frame(), null);
    assert.deepEqual(failing.notice(), { hidden: false, heading: "This page couldn't load.", text: "Check your connection, then reload to try again.", reload: true });
  } finally {
    gone.dom.window.close();
    failing.dom.window.close();
  }
});
