import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness, type DomHarness } from "./support/dom.js";
import type { ModelContextInspection, ModelContextInspectionState } from "../src/shared/model-context-inspection.js";

function button(dom: DomHarness, text: string): HTMLButtonElement {
  const found = [...dom.container.querySelectorAll("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text);
  assert.ok(found, `Missing button ${text}`);
  return found;
}
async function setInput(dom: DomHarness, input: HTMLInputElement, value: string) {
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("context inspector fixture makes no requests, distinguishes capture stages, preserves search through refresh, and clears on disable", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ModelContextInspector } = await import("../web-local/src/components/chat/ModelContextInspector.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("The inert fixture must never call an API."); };
  t.after(() => { globalThis.fetch = originalFetch; });
  let closed = false;
  await dom.render(createElement(ModelContextInspector, { fixtureMode: true, spaceId: "one", conversationId: "chat-one", onClose: () => { closed = true; } }));
  assert.match(dom.container.textContent!, /including private message text/);
  assert.equal(dom.container.querySelector('[role="dialog"]')?.getAttribute("aria-modal"), "true");
  assert.equal(dom.container.querySelectorAll("img").length, 0);
  assert.match(dom.container.querySelector("pre")!.textContent!, /Remaining pages have not been inspected/);
  const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await setInput(dom, search, "revision");
  await dom.act(() => { search.focus(); search.setSelectionRange(2, 5); button(dom, "Refresh").click(); });
  assert.equal(document.activeElement, search);
  assert.equal(search.value, "revision");
  assert.ok(dom.container.querySelector("mark"));
  await dom.act(() => button(dom, "Provider payload observed").click());
  assert.match(dom.container.textContent!, /does not prove network delivery or model completion/);
  assert.doesNotMatch(dom.container.querySelector("pre")!.textContent!, /systemPrompt/);
  const picker = dom.container.querySelector("select")!;
  await dom.act(() => { picker.value = "fixture-context-two"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
  assert.match(dom.container.textContent!, /No provider payload was observed/);
  await dom.act(async () => { dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await Promise.resolve(); });
  assert.match(dom.container.textContent!, /Recording is off/);
  assert.equal(dom.container.querySelector("pre"), null);
  await dom.press("Escape");
  assert.equal(closed, true);
});

test("opening the inspector is read-only, recording is explicit, and failed changes remain actionable", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ModelContextInspector, createModelContextFixture } = await import("../web-local/src/components/chat/ModelContextInspector.js");
  let state: ModelContextInspectionState = { ...createModelContextFixture().state, enabled: false, records: [] };
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let fail = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    if (init?.method === "POST") {
      if (fail) return new Response(JSON.stringify({ error: "Capture service unavailable" }), { status: 503 });
      state = { ...state, ...("enabled" in body ? { enabled: body.enabled } : {}), records: [] };
    }
    return Response.json(state);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await dom.render(createElement(ModelContextInspector, { spaceId: "space / one", conversationId: "chat?one", onClose() {} }));
  assert.deepEqual(calls.map(({ method }) => method), ["GET"]);
  assert.match(calls[0].url, /spaceId=space\+%2F\+one&conversationId=chat%3Fone/);
  assert.match(dom.container.textContent!, /Recording is off/);
  await dom.act(() => dom.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  assert.deepEqual(calls.find(({ method }) => method === "POST")?.body, { enabled: true });
  assert.match(dom.container.textContent!, /No requests captured here yet/);
  fail = true;
  await dom.act(() => button(dom, "Clear all").click());
  assert.match(dom.container.querySelector('[role="alert"]')!.textContent!, /Capture service unavailable/);
  assert.equal(button(dom, "Clear all").disabled, false);
  fail = false;
  await dom.act(() => button(dom, "Clear all").click());
  assert.equal(dom.container.querySelector('[role="alert"]'), null);
  assert.ok(calls.every(({ url }) => url.startsWith("/api/model-context")), "the inspector never creates a Chat, session, or model request");
});

test("context inspection isolates a late snapshot from the next Chat and renders untrusted content as text", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ModelContextInspector, createModelContextFixture } = await import("../web-local/src/components/chat/ModelContextInspector.js");
  const first = createModelContextFixture("space-a", "chat-a");
  const second = createModelContextFixture("space-b", "chat-b");
  for (const fixture of [first, second]) for (const item of [...fixture.records, ...fixture.state.records]) item.createdAt = Date.now();
  second.records[0].assembled = { ...second.records[0].assembled, truncated: true, omissions: ["Output limited to one page"], value: { content: "<script>steal()</script> Only Chat B", image: "[Omitted: image data]" } };
  let finishOld!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const old = String(url).includes("spaceId=space-a");
    if (String(url).includes("/fixture-context-one")) {
      if (old) { oldSignal = init?.signal; return await new Promise<Response>((resolve) => { finishOld = resolve; }); }
      return Response.json({ record: second.records[0] });
    }
    return Response.json(old ? first.state : second.state);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await dom.render(createElement(ModelContextInspector, { spaceId: "space-a", conversationId: "chat-a", onClose() {} }));
  assert.equal(typeof finishOld, "function");
  await dom.render(createElement(ModelContextInspector, { spaceId: "space-b", conversationId: "chat-b", onClose() {} }));
  assert.equal(oldSignal?.aborted, true);
  assert.match(dom.container.querySelector("pre")!.textContent!, /Only Chat B/);
  assert.equal(dom.container.querySelector("script"), null);
  assert.match(dom.container.textContent!, /This snapshot is truncated/);
  await dom.act(() => finishOld(Response.json({ record: first.records[0] })));
  assert.match(dom.container.querySelector("pre")!.textContent!, /Only Chat B/);
  assert.doesNotMatch(dom.container.querySelector("pre")!.textContent!, /Remaining pages/);
});

test("a refreshed capture preserves selection and search, and a late copy does not label a different snapshot copied", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ModelContextInspector, createModelContextFixture } = await import("../web-local/src/components/chat/ModelContextInspector.js");
  const fixture = createModelContextFixture();
  for (const item of [...fixture.records, ...fixture.state.records]) item.createdAt = Date.now();
  let activeRecord: ModelContextInspection = fixture.records[0];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/fixture-context-one") ? Response.json({ record: activeRecord }) : Response.json(fixture.state);
  t.after(() => { globalThis.fetch = originalFetch; });
  let finishCopy!: () => void;
  let copiedText = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { copiedText = value; return new Promise<void>((resolve) => { finishCopy = resolve; }); } } });
  await dom.render(createElement(ModelContextInspector, { onClose() {} }));
  const search = dom.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await setInput(dom, search, "Page");
  await dom.act(() => { search.focus(); button(dom, "Copy").click(); });
  assert.match(copiedText, /revision 7/);
  activeRecord = { ...activeRecord, assembled: { ...activeRecord.assembled, value: { content: "Page 2, revision 8" } } };
  await dom.act(() => button(dom, "Refresh").click());
  assert.equal(document.activeElement, search);
  assert.equal(search.value, "Page");
  assert.match(dom.container.querySelector("pre")!.textContent!, /revision 8/);
  await dom.act(() => finishCopy());
  assert.equal(button(dom, "Copy").textContent, "Copy");
});

test("displayed captures expire locally and window focus discovers recording cleared elsewhere", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const { ModelContextInspector, createModelContextFixture } = await import("../web-local/src/components/chat/ModelContextInspector.js");
  const fixture = createModelContextFixture();
  for (const item of [...fixture.records, ...fixture.state.records]) item.createdAt = Date.now();
  fixture.state.limits.retentionMs = 100;
  const originalFetch = globalThis.fetch;
  let state = fixture.state;
  globalThis.fetch = async (url) => String(url).includes("/fixture-context-one") ? Response.json({ record: fixture.records[0] }) : Response.json(state);
  t.after(() => { globalThis.fetch = originalFetch; });
  await dom.render(createElement(ModelContextInspector, { onClose() {} }));
  assert.ok(dom.container.querySelector("pre"));
  await dom.waitFor(() => !dom.container.querySelector("pre"));
  assert.match(dom.container.textContent!, /No requests captured here yet/);
  state = { ...state, enabled: false, records: [] };
  await dom.act(() => window.dispatchEvent(new Event("focus")));
  assert.match(dom.container.textContent!, /Recording is off/);
});
