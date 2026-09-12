import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("fold history pins replies, preserves per-chat drafts, and ignores late reads after navigation", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  const assets = registerHooks({ load(url, context, next) {
    return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
  } });
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; assets.deregister(); });
  let hidden = 0;
  Object.assign(window, { workFoldDesktop: { api: {}, management: { hide: () => { hidden++; }, onStaged: () => () => {} } } });
  let running = false;
  let delayOld = false;
  let finishOld: (() => void) | null = null;
  let failSend = false;
  let emptyDesktop = false;
  const sent: Record<string, unknown>[] = [];
  const chats = [
    { id: "newer", title: "Workshop plan", updatedAt: "2026-09-11T19:00:00Z" },
    { id: "older", title: "Field notes", updatedAt: "2026-09-10T16:00:00Z" },
  ];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/control-events")) {
      return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/api/management/conversations") return json({ conversations: emptyDesktop ? [] : chats.map((chat) => ({ ...chat, requestState: chat.id === "newer" && running ? "working" : "done" })) });
    if (url.pathname === "/api/management/summary") {
      if (emptyDesktop && !url.searchParams.has("conversationId")) return json({ available: true, conversation: null, state: "idle", latestRequest: null });
      const id = url.searchParams.get("conversationId") ?? "newer";
      return json({ available: true, conversation: chats.find((chat) => chat.id === id), state: "idle", latestRequest: {
        taskId: `task-${id}`, conversationId: id, phase: id === "newer" && running ? "working" : "done",
        startedAt: new Date().toISOString(), endedAt: null, error: null, content: "Test", attachments: [], dispositions: [], actions: [], children: [], reply: null,
      } });
    }
    if (url.pathname.endsWith("/runtime")) return json({ runtime: { thinkingLevel: "medium", thinkingLevels: ["low", "medium"] } });
    if (url.pathname.endsWith("/work")) return json({ work: null });
    if (url.pathname === "/api/agent/composer") return json({ composer: { model: { id: "model", name: "Test model" }, thinkingLevel: "medium", thinkingLevels: ["low", "medium"] } });
    if (url.pathname === "/api/management/messages") {
      const body = JSON.parse(String(init?.body)); sent.push(body);
      if (failSend) return json({ error: "Please try again." }, 400);
      if (body.newConversation) chats.unshift({ id: "created", title: "First chat", updatedAt: new Date().toISOString() });
      return json({ conversationId: body.conversationId ?? "created", taskId: "sent-task" });
    }
    if (url.pathname.startsWith("/api/management/conversations/")) {
      const id = url.pathname.split("/").at(-1);
      if (id === "older" && delayOld) await new Promise<void>((resolve) => { finishOld = resolve; });
      return json({ messages: [{ id: `message-${id}`, role: "user", content: `Transcript ${id}`, createdAt: new Date().toISOString() }] });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  const { PopoverApp } = await import("../web-local/src/popover/PopoverApp.js");
  const click = async (selector: string) => { const element = dom.container.querySelector<HTMLButtonElement>(selector); assert.ok(element, selector); await dom.act(() => element.click()); };
  const input = async (selector: string, value: string) => {
    const element = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await dom.act(() => {
      const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const openHistory = () => click('[aria-controls="fold-chat-history"]');
  const choose = async (title: string) => {
    const row = [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-chat-row")].find((button) => button.textContent?.includes(title));
    assert.ok(row, title); await dom.act(() => row.click());
  };
  await dom.render(createElement(PopoverApp));
  await dom.waitFor(() => dom.container.textContent?.includes("Transcript newer") === true);
  await input("textarea", "Workshop draft");
  await openHistory();
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Search chats");
  await input('input[type="search"]', "Field");
  assert.equal(dom.container.querySelectorAll(".fold-chat-row").length, 1);
  await choose("Field notes");
  await dom.waitFor(() => dom.container.textContent?.includes("Transcript older") === true);
  assert.equal(dom.container.querySelector("textarea")?.value, "");
  await input("textarea", "Reply to old notes");
  failSend = true;
  await click(".composer-action");
  assert.equal(dom.container.querySelector("textarea")?.value, "Reply to old notes");
  failSend = false;
  await click(".composer-action");
  assert.equal(sent[0].conversationId, "older");
  assert.equal(sent[1].requestId, sent[0].requestId, "retry retains the same acceptance identity");
  await input("textarea", "Field draft");
  await openHistory(); await choose("Workshop plan");
  await dom.waitFor(() => dom.container.textContent?.includes("Transcript newer") === true);
  assert.equal(dom.container.querySelector("textarea")?.value, "Workshop draft");

  // An old transcript request finishes after New chat: it must not replace it.
  delayOld = true;
  await openHistory(); await choose("Field notes");
  await dom.waitFor(() => finishOld !== null);
  await click('[aria-label="New chat"]');
  await dom.act(() => finishOld!());
  assert.equal(dom.container.querySelector(".popover-chat-title")?.textContent, "New chat");
  assert.equal(dom.container.querySelector('[role="alert"]'), null);
  assert.equal(dom.container.querySelector("textarea")?.value, "");
  assert.equal(dom.container.textContent?.includes("Transcript older"), false);
  delayOld = false;
  await input("textarea", "New draft");
  await openHistory(); await choose("Field notes");
  await dom.waitFor(() => dom.container.textContent?.includes("Transcript older") === true);
  assert.equal(dom.container.querySelector("textarea")?.value, "Field draft");
  running = true;
  await openHistory(); await choose("Workshop plan");
  await dom.waitFor(() => dom.container.querySelector('[aria-label="Stop"]'));
  await click('[aria-label="New chat"]');
  assert.equal(dom.container.querySelector("textarea")?.value, "New draft");
  assert.ok(dom.container.querySelector(".fold-background-work"), "running Chat remains reachable");
  await click(".fold-background-work");
  await dom.waitFor(() => dom.container.querySelector('[aria-label="Stop"]'));
  await openHistory(); await dom.press("Escape");
  assert.equal(hidden, 0, "Escape closes history first");
  await dom.press("Escape"); assert.equal(hidden, 1);

  emptyDesktop = true; running = false;
  await dom.render(createElement(PopoverApp, { key: "empty-desktop" }));
  await dom.waitFor(() => dom.container.querySelector(".popover-chat-title")?.textContent === "New chat");
  emptyDesktop = false; // Another surface starts a Chat before this draft sends.
  await input("textarea", "Start my own chat");
  await click(".composer-action");
  assert.equal(sent.at(-1)!.newConversation, true, "an initially empty desktop also pins a fresh conversation");
  assert.equal(sent.at(-1)!.conversationId, undefined);
});
