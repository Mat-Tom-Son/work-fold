import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import type { WorkRequestView } from "../src/shared/request-presentation.js";
import { WorkRequest } from "../web-local/src/components/chat/WorkRequest.js";
// The paired browser deliberately ships plain JavaScript.
// @ts-expect-error browser adapter has no TypeScript declaration
import { renderWorkRequest } from "../services/bridge/public/work-request.js";

function view(): WorkRequestView {
  return { version: 1, requestId: "request-one", taskId: "task-one", owner: { conversationId: "chat-one" }, state: "waiting", label: "Needs your answer", detail: null, canStop: true, canContinue: false,
    questions: [{ id: "question-one", requestId: "child-one", text: "Which currency? <script>doNotRun()</script>", from: "Supplier quotes", state: "open", canAnswer: true }], questionCount: 1,
    children: [{ requestId: "child-one", title: "Supplier quotes", state: "waiting", label: "Needs your answer" }], result: null };
}

test("the desktop work presentation shows the question, origin, whole-work Stop and selected deliverables", () => {
  const html = renderToStaticMarkup(React.createElement(WorkRequest, { work: view(), error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(html, /Supplier quotes asks/);
  assert.match(html, /Send answer/);
  assert.match(html, />Stop</);
  assert.doesNotMatch(html, /<script>/);
  const completed = { ...view(), state: "partial" as const, label: "Partly finished", canStop: false, questions: [], questionCount: 0,
    result: { outcome: "partial" as const, summary: "One quote is still missing.", files: [{ spaceId: "quotes", spaceName: "Supplier quotes", path: "comparison.md", sizeBytes: 42 }] } };
  const result = renderToStaticMarkup(React.createElement(WorkRequest, { work: completed, error: null, busy: false, act: async () => true, refresh: async () => {}, showResultSummary: true }));
  assert.match(result, /Partly finished/); assert.match(result, /One quote is still missing/); assert.match(result, /comparison.md/); assert.match(result, /Open file/);
  assert.doesNotMatch(result, />Stop</);
  const saved = view();
  saved.questions[0] = { ...saved.questions[0], state: "recorded", answer: "Canadian dollars, including installation." };
  const recovery = renderToStaticMarkup(React.createElement(WorkRequest, { work: saved, error: null, busy: false, act: async () => true, refresh: async () => {} }));
  assert.match(recovery, /Canadian dollars, including installation/);
  assert.match(recovery, /Continue with saved answer/);
});

test("paired questions preserve focus and draft across refresh, failure and retry; double submit delivers once", async () => {
  const dom = new JSDOM('<div id="work"></div>', { url: "https://example.test" });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  try {
    const container = dom.window.document.getElementById("work")!;
    let calls = 0;
    let finish: (result: unknown) => void = () => {};
    const act = async () => { calls++; if (calls === 1) throw new Error("Connection lost"); return new Promise((resolve) => { finish = resolve; }); };
    const work = view();
    renderWorkRequest(container, work, { act });
    let input = container.querySelector("textarea")!;
    input.value = "Canadian dollars"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.focus(); input.setSelectionRange(4, 9);
    renderWorkRequest(container, { ...work, children: [] }, { act });
    input = container.querySelector("textarea")!;
    assert.equal(dom.window.document.activeElement, input); assert.equal(input.value, "Canadian dollars"); assert.equal(input.selectionStart, 4);
    container.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(container.textContent!, /Connection lost/); assert.equal(container.querySelector("textarea")!.value, "Canadian dollars");
    const form = container.querySelector("form")!;
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(calls, 2);
    finish({ work: { ...work, state: "working", label: "Working", questions: [], questionCount: 0 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(container.querySelector("textarea"), null); assert.match(container.textContent!, /Working/);
    const saved = { ...work, questions: [{ ...work.questions[0], state: "recorded", answer: "Canadian dollars" }] };
    renderWorkRequest(container, saved, { act });
    assert.equal(container.querySelector('[aria-label="Your saved answer"]')?.textContent, "Canadian dollars");
    assert.equal(container.querySelector("textarea"), null, "recovery previews the saved answer instead of collecting another one");
    renderWorkRequest(container, { ...work, questions: [], questionCount: 0, result: { summary: "Comparison ready", files: [{ spaceId: "quotes", spaceName: "Quotes", path: "comparison.md" }] } }, {
      act, openFile: async () => { throw new Error("This file moved. Open its Space to find it."); },
    });
    (container.querySelector(".work-file-button") as HTMLButtonElement).click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /This file moved/);
  } finally {
    if (prior) Object.defineProperty(globalThis, "document", prior); else delete (globalThis as any).document;
    dom.window.close();
  }
});
