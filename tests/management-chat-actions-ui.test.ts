import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("management history renames the selected chat and handles deletion failure and success", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  const assets = registerHooks({ load(url, context, next) {
    return url.endsWith(".png") ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
  } });
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; assets.deregister(); });
  Object.assign(window, { workFoldDesktop: { api: {}, management: { hide() {}, onStaged: () => () => {} } } });
  let chats = [{ id: "one", title: "New Chat", updatedAt: new Date().toISOString(), requestState: "done" }];
  let failDelete = true;
  const mutations: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    if (url.pathname === "/api/management/conversations") return json({ conversations: chats });
    if (url.pathname === "/api/management/summary") return json({ available: true, conversation: chats[0] ?? null, state: "idle", latestRequest: null });
    if (url.pathname.endsWith("/title")) {
      mutations.push("rename"); chats[0].title = JSON.parse(String(init?.body)).title;
      return json({ conversation: chats[0] });
    }
    if (init?.method === "DELETE") {
      mutations.push("delete");
      if (failDelete) return json({ error: "Chat is busy." }, 409);
      chats = []; return json({ deleted: true });
    }
    if (url.pathname.endsWith("/runtime")) return json({ runtime: { thinkingLevel: "medium", thinkingLevels: ["medium"] } });
    if (url.pathname.endsWith("/work")) return json({ work: null });
    if (url.pathname === "/api/agent/composer") return json({ composer: { model: { id: "model", name: "Test model" }, thinkingLevel: "medium", thinkingLevels: ["medium"] } });
    if (url.pathname.endsWith("/one")) return json({ messages: [{ id: "m", role: "user", content: "Hello", createdAt: new Date().toISOString() }] });
    throw new Error(`Unexpected request ${url.pathname}`);
  };
  const { PopoverApp } = await import("../web-local/src/popover/PopoverApp.js");
  const click = async (selector: string) => { const el = dom.container.querySelector<HTMLButtonElement>(selector); assert.ok(el, selector); await dom.act(() => el.click()); };
  await dom.render(createElement(PopoverApp));
  await dom.waitFor(() => dom.container.textContent?.includes("Hello") === true);
  await click('[aria-controls="fold-chat-history"]');
  await click('[aria-label="Actions for New Chat"]');
  await dom.act(() => [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-chat-actions button")].find((el) => el.textContent === "Rename")!.click());
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Chat title"]')!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "Workshop plan");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click('.fold-chat-actions button[type="submit"]');
  await dom.waitFor(() => dom.container.querySelector(".popover-chat-title")?.textContent === "Workshop plan");
  await click('[aria-label="Actions for Workshop plan"]');
  const deleteButton = () => [...dom.container.querySelectorAll<HTMLButtonElement>(".fold-chat-actions button")].find((el) => el.textContent === "Delete")!;
  await dom.act(() => deleteButton().click());
  await dom.waitFor(() => dom.container.textContent?.includes("Chat is busy.") === true);
  assert.equal(chats.length, 1);
  failDelete = false;
  await dom.act(() => deleteButton().click());
  await dom.waitFor(() => dom.container.querySelectorAll(".fold-chat-item").length === 0);
  assert.equal(dom.container.querySelector(".popover-chat-title")?.textContent, "New chat");
  assert.deepEqual(mutations, ["rename", "delete", "delete"]);
});
