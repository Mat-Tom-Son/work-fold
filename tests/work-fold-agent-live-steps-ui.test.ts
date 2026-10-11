import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import type { ChatStreamEvent, LocalEventStream } from "../web-local/src/types.js";

const conversationId = "agent-chat";
const request = {
  taskId: "task-1", conversationId, phase: "working", startedAt: new Date().toISOString(), endedAt: null, error: null,
  content: "Plan the week", attachments: [], dispositions: [], actions: [], children: [], reply: null,
};

async function agentHarness(t: TestContext, transcript: unknown[] = [{ id: "ask", role: "user", content: "Plan the week", createdAt: "2026-10-11T12:00:00Z" }], latestRequest: unknown = request) {
  const dom = await createDomHarness();
  const realApi = await import("../web-local/src/lib/api.js");
  const streams = new Map<string, LocalEventStream>();
  const api = async (path: string) => {
    if (path.startsWith("/api/work-fold-agent/summary")) return { available: true, conversation: { id: conversationId, title: "Plan the week" }, state: latestRequest ? "running" : "idle", latestRequest };
    if (path === "/api/work-fold-agent/conversations") return { conversations: [{ id: conversationId, title: "Plan the week", updatedAt: "2026-10-11T12:00:00Z", requestState: "working" }] };
    if (path === `/api/work-fold-agent/conversations/${conversationId}`) return { messages: transcript };
    if (path.endsWith("/runtime")) return { runtime: null };
    if (path.endsWith("/work")) return { work: null };
    if (path.startsWith("/api/agent/composer")) return { composer: null };
    if (path === "/api/work-folders/outline") return { workFolders: [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const mocked = { ...realApi, api, createEventSource(path: string) {
    const stream: LocalEventStream = { onmessage: null, onopen: null, onerror: null, lastEventId: "", close() {} };
    streams.set(path, stream); return stream;
  } };
  const scope = globalThis as unknown as Record<string, unknown>; scope.__agentChatApi = mocked;
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:agent-chat-icons", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:agent-chat-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:agent-chat-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:agent-chat-api") return { format: "module", source: Object.keys(mocked).map((name) =>
        `export const ${name}=${name === "api" || name === "createEventSource" ? `(...args)=>globalThis.__agentChatApi.${name}(...args)` : `globalThis.__agentChatApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__agentChatApi; });
  const controls = document.createElement("div");
  document.body.append(controls);
  const { WorkFoldAgentChat } = await import("../web-local/src/popover/PopoverApp.js");
  await dom.render(createElement(WorkFoldAgentChat, { host: "panel", controlsTarget: controls, visible: true }));
  const path = `/api/work-fold-agent/conversations/${conversationId}/events`;
  await dom.waitFor(() => streams.has(path));
  const stream = streams.get(path)!;
  const emit = async (value: Omit<ChatStreamEvent, "conversationId">) => {
    await dom.act(async () => { stream.onmessage?.({ data: JSON.stringify({ conversationId, ...value }) }); await Promise.resolve(); });
    await dom.settle();
  };
  return { dom, emit, controls };
}

test("the work-fold agent shows its thinking and tool steps as they stream, then folds them under the reply", async (t) => {
  const { dom, emit } = await agentHarness(t);
  await emit({ type: "turn_state", running: true, turnId: "turn-1" });
  await emit({ type: "assistant_thinking", turnId: "turn-1", thinkingPhase: "start", workTrailId: "thinking:1", order: 0 });
  await emit({ type: "assistant_thinking", turnId: "turn-1", text: "Checking the folders first.", workTrailId: "thinking:1", order: 0 });
  await emit({ type: "tool", turnId: "turn-1", workTrailId: "tool:list", toolName: "bash", message: "Running", detail: "work-fold work-folders list", phase: "running", order: 1 });
  assert.ok(dom.container.querySelector(".work-steps.running.open"), "the steps stay open while the turn works");
  assert.equal(dom.container.querySelectorAll(".work-step.thinking").length, 1);
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1);

  await emit({ type: "tool", turnId: "turn-1", workTrailId: "tool:list", toolName: "bash", message: "Ran", detail: "work-fold work-folders list", phase: "complete", order: 1 });
  assert.equal(dom.container.querySelectorAll(".work-step.tool").length, 1, "an update replaces its row");
  assert.ok(dom.container.querySelector(".work-step.tool.complete"));

  await emit({ type: "assistant_delta", turnId: "turn-1", text: "Here is the plan.", order: 2 });
  assert.match(dom.container.querySelector(".popover-message.streaming")?.textContent ?? "", /Here is the plan\./);
  assert.ok(dom.container.querySelector(".work-steps.settled"), "reply text folds the steps into one summary line");
});

test("a saved reply keeps its steps folded above it", async (t) => {
  const { dom } = await agentHarness(t, [
    { id: "ask", role: "user", content: "Plan the week", createdAt: "2026-10-11T12:00:00Z" },
    { id: "reply", role: "assistant", content: "Here is the plan.", createdAt: "2026-10-11T12:01:00Z",
      workTrail: [{ kind: "tool", toolName: "read", text: "Read", detail: "notes.md", phase: "complete" }] },
  ], null);
  await dom.waitFor(() => Boolean(dom.container.querySelector(".work-steps-summary")));
  assert.ok(dom.container.querySelector(".popover-message.assistant .work-steps.settled"));
});

test("the panel puts its chat controls in the window's top strip, icon only", async (t) => {
  const { controls } = await agentHarness(t);
  const labels = [...controls.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
  assert.deepEqual(labels, ["Chats", "New Chat"]);
  assert.ok([...controls.querySelectorAll("button")].every((button) => !button.textContent?.trim()), "no text labels in the strip");
});
