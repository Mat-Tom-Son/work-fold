import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import { useWorkRequest } from "../web-local/src/hooks/useWorkRequest.js";
import type { WorkRequestView } from "../src/shared/request-presentation.js";

const waitingWork: WorkRequestView = {
  version: 1, requestId: "request-answer", taskId: "first-turn", owner: { conversationId: "chat-answer" },
  state: "waiting", label: "Needs your answer", detail: null, canStop: true, canContinue: false,
  questions: [{ id: "question-answer", requestId: "request-answer", text: "Which currency?", from: "Assistant", state: "open", canAnswer: true }],
  questionCount: 1, children: [], result: null,
};

test("accepted answers clear Sending without awaiting another GET and invalidate a stale poll", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  let state: ReturnType<typeof useWorkRequest>;
  const reads: Array<(work: WorkRequestView) => void> = [];
  let finishPost!: (work: WorkRequestView) => void;
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith("/api/events")) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
    });
    if (options?.method === "POST") return new Promise((resolve) => { finishPost = (work) => resolve(Response.json({ work })); });
    return new Promise((resolve) => reads.push((work) => resolve(Response.json({ work }))));
  };
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  function Probe() { state = useWorkRequest("/work/answer"); return createElement("span", {}, `${state.busy ? "Sending" : "Idle"}: ${state.work?.label ?? "Loading"}`); }
  await dom.render(createElement(Probe));
  await dom.act(() => reads[0](waitingWork));
  let answered: boolean | undefined;
  await dom.act(() => { void state.act("answer", { questionId: "question-answer", answer: "CAD" }).then((value) => { answered = value; }); });
  await dom.act(() => { void state.refresh(); });
  assert.equal(reads.length, 2);
  const continued = { ...waitingWork, taskId: "answer-turn", state: "working" as const, label: "Working", questions: [], questionCount: 0 };
  await dom.act(() => finishPost(continued));
  assert.equal(answered, true);
  assert.equal(dom.container.textContent, "Idle: Working");
  await dom.act(() => reads[1](waitingWork));
  assert.equal(dom.container.textContent, "Idle: Working", "an older poll cannot restore the answered question");
  assert.equal(reads.length, 2, "the accepted response does not start a blocking reread");
});

test("a failed answer becomes retryable before its recovery read finishes", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  let state: ReturnType<typeof useWorkRequest>;
  let reads = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input).endsWith("/api/events")) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
    });
    if (options?.method === "POST") return Response.json({ error: "Answer not accepted" }, { status: 409 });
    reads++;
    return reads === 1 ? Response.json({ work: waitingWork }) : new Promise(() => {});
  };
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  function Probe() { state = useWorkRequest("/work/answer"); return createElement("span", {}, `${state.busy ? "Sending" : "Idle"}: ${state.error ?? "Ready"}`); }
  await dom.render(createElement(Probe));
  let answered: boolean | undefined;
  await dom.act(() => { void state.act("answer", { questionId: "question-answer", answer: "CAD" }).then((value) => { answered = value; }); });
  assert.equal(answered, false);
  assert.equal(dom.container.textContent, "Idle: Answer not accepted");
  assert.equal(reads, 2);
});

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
    if (path.endsWith("/api/events")) return new Promise((_resolve, reject) => {
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
