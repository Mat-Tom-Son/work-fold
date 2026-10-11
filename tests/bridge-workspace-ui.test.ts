import assert from "node:assert/strict";
import { TextDecoder, TextEncoder } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Exercise the shipped client, including its actual event handlers. The
// fixture must stay inert even when navigation and draft actions are used.
const bundle = await build({
  entryPoints: ["services/bridge/public/app.js"],
  bundle: true, format: "iife", platform: "browser", write: false,
});

async function workspace(screen = "chat") {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: `http://localhost/?fixture=${screen}`, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const win = dom.window;
  const network: unknown[] = [];
  Object.assign(win, {
    TextEncoder, TextDecoder, structuredClone,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    CSS: { escape: (value: string) => value.replace(/[\\"]/g, "\\$&") },
    fetch: (...args: unknown[]) => { network.push(args); throw new Error("Fixture reached the network"); },
    EventSource: class { constructor(...args: unknown[]) { network.push(args); throw new Error("Fixture opened an event stream"); } },
  });
  win.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions | number) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
  };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.eval(bundle.outputFiles[0]!.text);
  await Promise.resolve();
  const document = win.document;
  const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
  return { dom, win, document, network, click };
}

test("chat filtering preserves the open transcript, draft and keyboard focus", async (t) => {
  const f = await workspace(); t.after(() => f.dom.window.close());
  const input = f.document.querySelector<HTMLInputElement>("#chat-search")!;
  const draft = f.document.querySelector<HTMLTextAreaElement>("#prompt")!;
  draft.value = "Keep this unsent draft";
  draft.dispatchEvent(new f.win.Event("input"));
  input.focus(); input.value = "  wEbSiTe  "; input.dispatchEvent(new f.win.Event("input"));
  assert.deepEqual([...f.document.querySelectorAll("#chats [data-chat-id]")].map((row) => row.textContent), ["Website copy"]);
  assert.equal(f.document.querySelector("#conversation-title")!.textContent, "A weekend in Montréal");
  assert.equal(draft.value, "Keep this unsent draft");
  assert.equal(f.document.activeElement, input);
  input.value = "<unmatched>"; input.dispatchEvent(new f.win.Event("input"));
  assert.match(f.document.querySelector("#chats")!.textContent!, /No matching chats/);
  assert.equal(f.document.querySelectorAll("#chats [data-chat-id]").length, 0);
  input.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(input.value, "");
  assert.equal(f.document.querySelectorAll("#chats [data-chat-id]").length, 4);
  assert.equal(f.document.activeElement, input);
  assert.deepEqual(f.network, []);
});

test("fixture chats own distinct transcripts and retain their unsent drafts", async (t) => {
  const f = await workspace(); t.after(() => f.dom.window.close());
  const draft = f.document.querySelector<HTMLTextAreaElement>("#prompt")!;
  const content = () => f.document.querySelector("#message-rows")!.textContent!;
  assert.match(content(), /weekend in Montréal/);
  assert.equal(f.document.querySelector<HTMLButtonElement>("#stop-task")!.hidden, true);
  assert.equal(f.document.querySelector("#work-status")!.textContent!.trim(), "");
  assert.equal(f.document.querySelector(".chat-waiting, .chat-working, .conversation-scope, #top-new-chat"), null);
  draft.value = "Add a café on Sunday"; draft.dispatchEvent(new f.win.Event("input"));
  f.click('[data-chat-id="chat-3"]');
  assert.match(content(), /independent shops/);
  assert.doesNotMatch(content(), /Montréal/);
  assert.equal(draft.value, "");
  draft.value = "Try another introduction"; draft.dispatchEvent(new f.win.Event("input"));
  f.click('[data-chat-id="chat-4"]');
  assert.match(content(), /Passages to return to/);
  f.click('[data-chat-id="chat-1"]');
  assert.match(content(), /weekend in Montréal/);
  assert.equal(draft.value, "Add a café on Sunday");
  f.click('[data-chat-id="chat-3"]');
  assert.equal(draft.value, "Try another introduction");
  assert.deepEqual(f.network, []);
});

test("switching chats lands on the latest message even when the previous chat was scrolled up", async (t) => {
  const f = await workspace(); t.after(() => f.dom.window.close());
  const messages = f.document.querySelector<HTMLElement>("#messages")!;
  Object.defineProperties(messages, { scrollHeight: { value: 2400 }, clientHeight: { value: 600 } });
  messages.scrollTop = 120;
  f.click('[data-chat-id="chat-3"]');
  assert.equal(messages.scrollTop, 2400);
  assert.equal(messages.dataset.conversationId, "chat-3");
  assert.deepEqual(f.network, []);
});

test("chat options keep rename and deletion available without permanent header controls", async (t) => {
  const f = await workspace(); t.after(() => f.dom.window.close());
  const menu = f.document.querySelector<HTMLElement>("#chat-menu")!;
  const options = f.document.querySelector<HTMLButtonElement>("#chat-options")!;
  assert.equal(menu.hidden, true);
  f.click("#chat-options");
  assert.equal(menu.hidden, false);
  assert.equal(options.getAttribute("aria-expanded"), "true");
  assert.equal(f.document.activeElement!.id, "rename-chat");
  f.document.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(menu.hidden, true);
  assert.equal(f.document.activeElement, options);
  f.click("#chat-options"); f.click("#rename-chat");
  assert.equal(menu.hidden, true);
  assert.equal(options.hidden, true);
  f.document.querySelector<HTMLInputElement>("#rename-chat-input")!.value = "Our Montréal weekend";
  f.document.querySelector<HTMLFormElement>("#rename-chat-form")!.dispatchEvent(new f.win.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(f.document.querySelector("#conversation-title")!.textContent, "Our Montréal weekend");
  assert.equal(options.hidden, false);
  f.click("#chat-options"); f.click("#delete-chat");
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(f.document.querySelector('[data-chat-id="chat-1"]'), null);
  assert.equal(f.document.querySelectorAll("#chats [data-chat-id]").length, 3);
  assert.equal(f.document.querySelector("#conversation-title")!.textContent, "Quarterly report");
  assert.match(f.document.querySelector("#message-rows")!.textContent!, /purchase-order references/);
  assert.deepEqual(f.network, []);
});

test("explicit question fixtures keep the actual question inside its owning chat", async (t) => {
  const f = await workspace("chat&work=question"); t.after(() => f.dom.window.close());
  assert.match(f.document.querySelector("#request-work")!.textContent!, /Which currency should I use/);
  assert.doesNotMatch(f.document.querySelector("#chats")!.textContent!, /Needs your answer|Working/);
  f.click('[data-chat-id="chat-3"]');
  assert.equal(f.document.querySelector("#request-work")!.textContent, "");
  f.click('[data-chat-id="chat-1"]');
  assert.match(f.document.querySelector("#request-work")!.textContent!, /Which currency should I use/);
  assert.deepEqual(f.network, []);
});

test("running is an explicit fixture state and its Stop remains inert", async (t) => {
  const f = await workspace("chat&activity=running"); t.after(() => f.dom.window.close());
  const stop = f.document.querySelector<HTMLButtonElement>("#stop-task")!;
  assert.equal(stop.hidden, false);
  assert.match(f.document.querySelector(".message.streaming")!.textContent!, /checking the invoice references/);
  f.click("#chat-options");
  assert.equal(f.document.querySelector<HTMLButtonElement>("#rename-chat")!.disabled, true);
  f.click("#stop-task");
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(stop.hidden, true);
  assert.equal(f.document.querySelector(".message.streaming"), null);
  assert.match(f.document.querySelector("#message-rows")!.textContent!, /checking the invoice references/);
  const results = f.document.querySelector<HTMLDetailsElement>(".request-deliverables")!;
  assert.equal(results.open, false);
  assert.match(results.textContent!, /q3-summary.md/);
  assert.equal(f.document.querySelector("#banner")!.textContent, "");
  assert.deepEqual(f.network, []);
});

test("retired Files and work-folder routes land on chat without a file browser", async (t) => {
  for (const screen of ["work-folders", "files"]) {
    const f = await workspace(screen); t.after(() => f.dom.window.close());
    assert.equal(f.document.querySelector(".app-shell")!.getAttribute("data-context"), "new");
    assert.equal(f.document.querySelector("#context-work-folders, #file-tree, #folder-picker, #ask-work-folder"), null);
    assert.equal(f.document.querySelectorAll(".context").length, 2);
    assert.deepEqual(f.network, []);
  }
});

test("Shared pages opens the selected isolated viewer and never stores its link key", async (t) => {
  const f = await workspace(); t.after(() => f.dom.window.close());
  let target = "";
  const opened = { opener: {} as unknown, closed: false, document: new JSDOM().window.document,
    location: { replace(url: string) { target = url; } }, close() { this.closed = true; } };
  f.win.open = (() => opened) as never;
  const button = f.document.querySelector<HTMLButtonElement>("#shared-pages-toggle")!;
  const popup = f.document.querySelector<HTMLElement>("#shared-pages-popup")!;
  button.focus(); button.click();
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(popup.hidden, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.deepEqual([...popup.querySelectorAll(".shared-page-copy > span")].map((row) => row.textContent), ["Quarterly overview", "Montréal weekend", "Reading notes"]);
  assert.equal(f.document.activeElement?.getAttribute("data-page-id"), "fixture-quarterly");
  f.document.dispatchEvent(new f.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(popup.hidden, true);
  assert.equal(f.document.activeElement, button);
  button.click(); await new Promise<void>((done) => setImmediate(done));
  f.click('[data-page-id="fixture-trip"]');
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(opened.opener, null);
  assert.equal(opened.closed, false);
  assert.equal(target, `http://pages-casey.localhost/p/fixture-trip?fixture=1#${"A".repeat(43)}`);
  assert.equal(popup.hidden, true);
  assert.equal(popup.querySelector("a"), null);
  assert.equal(f.document.querySelector("#conversation-title")!.textContent, "A weekend in Montréal");
  assert.ok(!JSON.stringify(f.win.localStorage).includes("A".repeat(43)));
  assert.ok(!JSON.stringify(f.win.sessionStorage).includes("A".repeat(43)));
  assert.deepEqual(f.network, []);
});
