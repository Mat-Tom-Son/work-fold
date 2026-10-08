import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ChatMessage, ChatStreamEvent, LocalEventStream, SpaceSummary } from "../web-local/src/types.js";

const userMessage: ChatMessage = { id: "request", role: "user", content: "Update the notes", createdAt: "2026-09-27T12:00:00Z" };

async function chatHarness(t: TestContext, readTranscript = async () => ({ messages: [userMessage] })) {
  const dom = await createDomHarness();
  const realApi = await import("../web-local/src/lib/api.js");
  const streams = new Map<string, LocalEventStream>();
  const api = async (path: string, options: { body?: unknown } = {}) => {
    if (path === "/api/spaces/folder/conversations") return { conversations: [{ id: "chat", title: "Notes", updatedAt: "2026-09-27T12:00:00Z" }] };
    if (path.endsWith("/conversations/chat")) return readTranscript();
    if (path.endsWith("/conversations/chat/messages")) {
      const body = options.body as { userMessageId: string; requestId: string; content: string };
      return { accepted: true, message: { ...userMessage, id: body.userMessageId, content: body.content, requestId: body.requestId } };
    }
    if (path.endsWith("/runtime")) return { runtime: null };
    if (path.endsWith("/work")) return { work: null };
    if (path.includes("/agent/catalog")) return { commands: [] };
    if (path.includes("/agent/status")) return { status: { ready: true, configured: true } };
    if (path.includes("/agent/composer")) return { composer: null };
    if (path.includes("/paths-exist")) return { existing: [] };
    throw new Error(`Unexpected UI request: ${path}`);
  };
  const mocked = { ...realApi, api, createEventSource(path: string) {
    const stream: LocalEventStream = { onmessage: null, onopen: null, onerror: null, lastEventId: "", close() {} };
    streams.set(path, stream); return stream;
  } };
  const scope = globalThis as unknown as Record<string, unknown>; scope.__chatPresentationApi = mocked;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:live-chat-icons", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:live-chat-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:live-chat-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:live-chat-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${name === "api" || name === "createEventSource" ? `(...args)=>globalThis.__chatPresentationApi.${name}(...args)` : `globalThis.__chatPresentationApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__chatPresentationApi; });
  HTMLElement.prototype.scrollIntoView = () => {};
  HTMLElement.prototype.scrollTo = () => {};
  const { ChatPanel } = await import("../web-local/src/components/chat/ChatPanel.js");
  await dom.render(createElement(ChatPanel, { surfaceTabId: "chat-tab", space: { id: "folder", name: "Notes", spaceRoot: "/folder" } as SpaceSummary,
    spaceCustomizations: {}, targetConversationId: "chat", contextPathRequest: null, selectedPath: null, onAgentFinished() {} }));
  await dom.waitFor(() => streams.has("/api/spaces/folder/conversations/chat/events"));
  const stream = streams.get("/api/spaces/folder/conversations/chat/events")!;
  const emit = async (value: Omit<ChatStreamEvent, "conversationId">) => { await dom.act(async () => { stream.onmessage?.({ data: JSON.stringify({ conversationId: "chat", ...value }) }); await Promise.resolve(); }); await dom.settle(); };
  return { dom, stream, emit };
}

test("Chat reconnect replaces stable steps, resumes their updates, and clears a different turn", async (t) => {
  const { dom, emit } = await chatHarness(t);
  const snapshot: Omit<ChatStreamEvent, "conversationId"> = { type: "turn_snapshot", running: true, turnId: "turn-one", text: "Checking.", presentation: {
    text: "Checking.", assistantPresentation: { version: 1, truncated: false, segments: [{ start: 0, end: 9, kind: "progress", order: 1 }] }, truncated: false,
    workTrail: [{ id: "thinking:1", kind: "thinking", text: "", phase: "streaming", order: 0, startedAt: Date.now() - 5000 },
      { id: "tool:read", kind: "tool", toolName: "read", text: "Reading", detail: "notes.txt", phase: "running", order: 2 }],
  } };
  await emit(snapshot);
  await emit(snapshot);
  assert.equal(dom.container.querySelectorAll(".work-step").length, 3, "repeated snapshots replace rows rather than append");
  assert.match(dom.container.querySelector(".work-step-timer")!.textContent!, /[5-9]s/);
  assert.ok(dom.container.querySelector(".work-steps.running.open"), "progress does not fold the strip");
  await emit({ type: "tool", turnId: "turn-one", workTrailId: "tool:read", order: 2, toolName: "read", message: "Read", detail: "notes.txt", phase: "complete" });
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1);
  assert.ok(dom.container.querySelector(".work-step.tool.complete"));
  await emit({ type: "assistant_delta", turnId: "turn-one", order: 3, text: "\n\nReady." });
  assert.ok(dom.container.querySelector(".work-steps.running.open"));
  await emit({ type: "assistant_message", turnId: "turn-one", text: "Checking.\n\nReady.", assistantPresentation: { version: 1, truncated: false,
    segments: [{ start: 0, end: 9, kind: "progress", order: 1 }, { start: 11, end: 17, kind: "final", order: 3 }] } });
  assert.equal(dom.container.querySelector(".streaming > .message-body")?.textContent, "Ready.");
  assert.ok(dom.container.querySelector(".work-steps.settled"));
  await emit({ type: "turn_snapshot", turnId: "turn-two", running: true, text: "", presentation: { text: "", workTrail: [], truncated: false } });
  assert.doesNotMatch(dom.container.textContent!, /Checking\.|Ready\.|notes\.txt/);
  await emit({ type: "tool", turnId: "turn-one", workTrailId: "tool:read", order: 2, toolName: "read", message: "STALE STEP", phase: "complete" });
  assert.doesNotMatch(dom.container.textContent!, /STALE STEP/);
});

function replySnapshot(turnId: string, text: string): Omit<ChatStreamEvent, "conversationId"> {
  return { type: "turn_snapshot", running: true, turnId, text, presentation: {
    text, assistantPresentation: { version: 1, truncated: false, segments: [{ start: 0, end: text.length, kind: "final", order: 2 }] },
    workTrail: [{ id: "tool:read", kind: "tool", toolName: "read", text: "Read", detail: "notes.txt", phase: "complete", order: 1 }],
    truncated: false,
  } };
}

function savedReply(text: string): ChatMessage {
  return { id: "saved-reply", role: "assistant", content: text, createdAt: "2026-09-27T12:00:01Z",
    workTrail: [{ kind: "tool", toolName: "read", text: "Read", detail: "notes.txt", phase: "complete", order: 1 }] };
}

test("a failed settlement read preserves the reply and steps, ends running state, and retries into the saved transcript", async (t) => {
  let read = async (): Promise<{ messages: ChatMessage[] }> => ({ messages: [userMessage] });
  const { dom, emit } = await chatHarness(t, () => read());
  await emit(replySnapshot("turn-one", "Ready."));
  let recoveryStarted = false;
  let resolveRecovery!: (result: { messages: ChatMessage[] }) => void;
  read = async () => {
    read = () => { recoveryStarted = true; return new Promise((resolve) => { resolveRecovery = resolve; }); };
    throw new Error("Failed to fetch");
  };
  await emit({ type: "done", turnId: "turn-one" });
  assert.equal(dom.container.querySelector(".streaming > .message-body")?.textContent, "Ready.");
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1, "live steps survive a failed read");
  assert.equal(dom.container.querySelector(".work-steps.running"), null);
  assert.equal(dom.container.querySelector('[aria-label="Stop Assistant"]'), null, "a settled Worker is no longer running");
  assert.match(dom.container.textContent!, /still reconnecting/);
  await dom.waitFor(() => recoveryStarted);
  await dom.act(() => { resolveRecovery({ messages: [userMessage, savedReply("Ready.")] }); });
  await dom.waitFor(() => dom.container.querySelector(".streaming") === null);
  assert.equal([...dom.container.querySelectorAll(".message-body")].filter((item) => item.textContent === "Ready.").length, 1);
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1, "the saved trail replaces the live trail");
  assert.equal(dom.container.querySelector('[aria-label="Stop Assistant"]'), null);
  assert.doesNotMatch(dom.container.textContent!, /still reconnecting/);
});

for (const recoveryOutcome of ["resolved", "rejected"] as const) {
  test(`a ${recoveryOutcome} settlement retry cannot change a newer running turn`, async (t) => {
    let read = async (): Promise<{ messages: ChatMessage[] }> => ({ messages: [userMessage] });
    const { dom, emit } = await chatHarness(t, () => read());
    await emit(replySnapshot("turn-one", "Old reply."));
    let recoveryStarted = false;
    let resolveRecovery!: (result: { messages: ChatMessage[] }) => void;
    let rejectRecovery!: (error: Error) => void;
    read = async () => {
      read = () => { recoveryStarted = true; return new Promise((resolve, reject) => { resolveRecovery = resolve; rejectRecovery = reject; }); };
      throw new Error("Failed to fetch");
    };
    await emit({ type: "done", turnId: "turn-one" });
    await dom.waitFor(() => recoveryStarted);
    read = async () => ({ messages: [userMessage, { ...userMessage, id: "new-request", content: "New request" }] });
    await emit(replySnapshot("turn-two", "New reply."));
    await dom.act(() => {
      if (recoveryOutcome === "resolved") resolveRecovery({ messages: [userMessage, savedReply("Old reply.")] });
      else rejectRecovery(new Error("Failed to fetch stale recovery"));
    });
    await dom.settle();
    assert.equal(dom.container.querySelector(".streaming > .message-body")?.textContent, "New reply.");
    assert.ok(dom.container.querySelector('[aria-label="Stop Assistant"]'), "the newer turn remains running");
    assert.doesNotMatch(dom.container.textContent!, /Old reply\.|stale recovery|still reconnecting/);
  });
}

test("sending the next message fences a pending recovery before its turn snapshot arrives", async (t) => {
  let read = async (): Promise<{ messages: ChatMessage[] }> => ({ messages: [userMessage] });
  const { dom, stream, emit } = await chatHarness(t, () => read());
  await dom.act(() => { stream.onopen?.(); });
  await emit(replySnapshot("turn-one", "Old reply."));
  let recoveryStarted = false;
  let resolveRecovery!: (result: { messages: ChatMessage[] }) => void;
  read = async () => {
    read = () => { recoveryStarted = true; return new Promise((resolve) => { resolveRecovery = resolve; }); };
    throw new Error("Failed to fetch");
  };
  await emit({ type: "done", turnId: "turn-one" });
  await dom.waitFor(() => recoveryStarted);
  const composer = dom.container.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  await dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "New request");
    composer.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await dom.act(async () => {
    dom.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
  await dom.waitFor(() => Boolean(dom.container.querySelector('[aria-label="Stop Assistant"]')));
  await dom.act(() => { resolveRecovery({ messages: [userMessage, savedReply("Old reply.")] }); });
  await dom.settle();
  assert.ok(dom.container.querySelector('[aria-label="Stop Assistant"]'));
  assert.match(dom.container.textContent!, /New request/);
  assert.doesNotMatch(dom.container.textContent!, /Old reply\.|still reconnecting/);
});
