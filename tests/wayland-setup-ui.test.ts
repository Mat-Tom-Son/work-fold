import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("screen setup chooses an explicit Chat and Stop cancels an open chooser without a late repaint", async t => {
  const dom = await createDomHarness(), original = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = original; });
  const { IncludedWaylandSetup } = await import("../web-local/src/components/panes/IncludedWaylandSetup.js");
  const idle = { id: "computer", state: "setup_required", detail: "Stopped", checkedAt: new Date().toISOString(),
    computerSession: { state: "idle", detail: "Screen sharing is stopped." } };
  let resolveShare: ((value: Response) => void) | undefined;
  let shareSignal: AbortSignal | undefined;
  const calls: any[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/conversations")) return Response.json({ conversations: [
      { id: String(url).includes("management") ? "chat-management" : "chat-folder", title: "Fixture Chat" },
      { id: "chat-archived", title: "Archived", archivedAt: "2026-09-01" },
    ] });
    if (!options?.body) return Response.json({ tools: [idle] });
    const body = JSON.parse(String(options.body)); calls.push(body);
    if (body.action === "stop-sharing") return Response.json({ status: idle });
    shareSignal = options.signal as AbortSignal;
    return new Promise(resolve => { resolveShare = resolve; });
  };
  const button = (label: string) => { const value = [...dom.container.querySelectorAll("button")].find(button => button.textContent === label); assert.ok(value); return value; };
  await dom.render(createElement(IncludedWaylandSetup, { spaceId: "space-a", enabled: true }));
  await dom.waitFor(() => dom.container.querySelectorAll("option").length === 3);
  assert.equal(button("Choose screen").disabled, true);
  assert.doesNotMatch(dom.container.textContent!, /Archived/);
  await dom.act(() => {
    const select = dom.container.querySelector("select")!;
    select.value = "management:chat-management";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await dom.act(() => button("Choose screen").click());
  assert.deepEqual(calls[0], { spaceId: "space-a", id: "computer", action: "share-screen", scope: "management", conversationId: "chat-management" });
  assert.equal(button("Stop sharing").disabled, false);
  await dom.act(() => button("Stop sharing").click());
  assert.equal(shareSignal!.aborted, true);
  assert.equal(calls[1].action, "stop-sharing");
  await dom.act(() => resolveShare!(Response.json({ status: { ...idle, computerSession: { state: "active", detail: "Late stale share" } } })));
  assert.doesNotMatch(dom.container.textContent!, /Late stale share/);
  assert.equal(button("Choose screen").disabled, false);
});
