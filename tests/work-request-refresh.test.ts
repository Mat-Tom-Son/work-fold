import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import { useWorkRequest } from "../web-local/src/hooks/useWorkRequest.js";

test("slow work reads do not overlap or overwrite a newly selected conversation", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  const setInterval = window.setInterval;
  const clearInterval = window.clearInterval;
  const timers = new Map<number, () => void>();
  let timerId = 9000;
  window.setInterval = ((callback: () => void) => { timers.set(++timerId, callback); return timerId; }) as typeof window.setInterval;
  window.clearInterval = (id?: number) => { if (id !== undefined) timers.delete(id); };
  const reads: { path: string; finish: (label: string) => void }[] = [];
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.includes("control-events")) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
    });
    return new Promise((resolve) => reads.push({ path, finish: (label) => resolve(new Response(JSON.stringify({ work: { requestId: path, label } }), { headers: { "content-type": "application/json" } })) }));
  };
  t.after(async () => {
    await dom.cleanup(); globalThis.fetch = originalFetch;
  });
  function Probe({ path }: { path: string }) {
    const state = useWorkRequest(path);
    return createElement("span", { id: "status" }, state.work?.label ?? "Loading");
  }
  await dom.render(createElement(Probe, { path: "/work/one" }));
  await dom.waitFor(() => reads.length === 1);
  await dom.act(async () => { for (let i = 0; i < 10; i++) for (const tick of timers.values()) tick(); });
  assert.equal(reads.length, 1, "polls wait for the slow read instead of invalidating it");
  await dom.act(async () => reads[0].finish("First request"));
  await dom.waitFor(() => document.getElementById("status")?.textContent === "First request");
  await dom.act(async () => { for (const tick of timers.values()) tick(); });
  await dom.waitFor(() => reads.length === 2);
  await dom.render(createElement(Probe, { path: "/work/two" }));
  await dom.waitFor(() => reads.length === 3);
  await dom.act(async () => reads[1].finish("Old request changed"));
  assert.equal(document.getElementById("status")?.textContent, "Loading", "the old request cannot replace the new selection");
  await dom.act(async () => reads[2].finish("Second request"));
  await dom.waitFor(() => document.getElementById("status")?.textContent === "Second request");
  assert.deepEqual(reads.map((read) => read.path), ["/work/one", "/work/one", "/work/two"]);
  window.setInterval = setInterval; window.clearInterval = clearInterval;
});
