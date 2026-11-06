import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";

test("screen setup needs no Chat and Stop cancels an open chooser without a late repaint", async t => {
  const dom = await createDomHarness(), original = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = original; });
  const { IncludedWaylandSetup } = await import("../web-local/src/components/panes/IncludedWaylandSetup.js");
  const idle = { id: "computer", state: "setup_required", detail: "Stopped", checkedAt: new Date().toISOString(),
    computerSession: { state: "idle", detail: "Screen sharing is stopped." } };
  let resolveShare: ((value: Response) => void) | undefined;
  let shareSignal: AbortSignal | undefined;
  const calls: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(!String(url).includes("/conversations"), "setup does not require a Chat list");
    if (!options?.body) return Response.json({ tools: [idle] });
    const body = JSON.parse(String(options.body)); calls.push(body);
    if (body.action === "stop-sharing") return Response.json({ status: idle });
    shareSignal = options.signal as AbortSignal;
    return new Promise(resolve => { resolveShare = resolve; });
  };
  const button = (label: string) => { const value = [...dom.container.querySelectorAll("button")].find(button => button.textContent === label); assert.ok(value); return value; };
  await dom.render(createElement(IncludedWaylandSetup, { workFolderId: "work-folder-a", enabled: true }));
  assert.equal(dom.container.querySelector("select"), null);
  assert.equal(button("Share desktop").disabled, false);
  await dom.act(() => button("Share desktop").click());
  assert.deepEqual(calls[0], { workFolderId: "work-folder-a", id: "computer", action: "share-screen" });
  assert.equal(button("Stop sharing").disabled, false);
  await dom.act(() => button("Stop sharing").click());
  assert.equal(shareSignal!.aborted, true);
  assert.equal(calls[1].action, "stop-sharing");
  await dom.act(() => resolveShare!(Response.json({ status: { ...idle, computerSession: { state: "active", detail: "Late stale share" } } })));
  assert.doesNotMatch(dom.container.textContent!, /Late stale share/);
  assert.equal(button("Share desktop").disabled, false);
});

test("Linux first-run Computer Control uses the app's portal setup without a work-folder", async t => {
  const dom = await createDomHarness(), original = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = original; });
  window.workFoldDesktop = { app: { platform: "linux" }, api: {} } as any;
  const { IncludedComputerSetup } = await import("../web-local/src/components/panes/IncludedComputerSetup.js");
  const idle = { id: "computer", state: "setup_required", detail: "Stopped", checkedAt: new Date().toISOString(),
    computerSession: { state: "idle", detail: "Screen sharing is stopped." } };
  const calls: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(!String(url).includes("workFolderId"), "first run has no work-folder yet");
    if (!options?.body) return Response.json({ tools: [idle] });
    const body = JSON.parse(String(options.body)); calls.push(body);
    return Response.json({ status: body.action === "share-screen" ? { ...idle, state: "ready", computerSession: { state: "active", pointer: true, keyboard: true } } : idle });
  };
  const button = (label: string) => [...dom.container.querySelectorAll("button")].find(button => button.textContent === label);
  await dom.render(createElement(IncludedComputerSetup, { enabled: true }));
  await dom.waitFor(() => Boolean(button("Share desktop")));
  assert.doesNotMatch(dom.container.textContent!, /macOS|System Settings|Allow Computer Control/);
  await dom.act(() => button("Share desktop")!.click());
  assert.deepEqual(calls[0], { id: "computer", action: "share-screen" });
  assert.match(dom.container.textContent!, /Shared with all chats and the work-fold agent/);
  await dom.act(() => button("Stop sharing")!.click());
  assert.deepEqual(calls[1], { id: "computer", action: "stop-sharing" });
  assert.ok(button("Share desktop"));
});
