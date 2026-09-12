import { logicalEventController } from "./support/local-events.js";
import assert from "node:assert/strict";
import { createElement, useState } from "react";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { useBootstrapRefresh } from "../web-local/src/hooks/useBootstrapRefresh.js";
import { useAssistantConfigurationRevision } from "../web-local/src/hooks/useAssistantConfigurationRevision.js";
import { useRestrictedApps } from "../web-local/src/hooks/useRestrictedApps.js";
import { useSpaceTree } from "../web-local/src/hooks/useSpaceTree.js";
import type { SpaceSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const space = (id: string) => ({ id, name: id, spaceRoot: `/tmp/${id}`, location: { storage: "linked" } }) as SpaceSummary;
const closedStream = (init?: RequestInit) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });

test("newer registry reads win and a removed surface cannot report a late read failure", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch;
  const failures: string[] = [];
  function Registry() {
    const [ids, setIds] = useState<string[]>([]);
    const refresh = useBootstrapRefresh(true, (value) => setIds(value.spaces.map((item) => item.id)), (error) => failures.push(error));
    return createElement("button", { onClick: () => void refresh() }, ids.join(",") || "Refresh");
  }
  await dom.render(createElement(Registry));
  await dom.act(() => dom.container.querySelector("button")!.click());
  await dom.act(() => dom.container.querySelector("button")!.click());
  await dom.act(() => pending[1]!(Response.json({ spaces: [space("survivor")] })));
  await dom.act(() => pending[0]!(Response.json({ spaces: [space("deleted"), space("survivor")] })));
  assert.equal(dom.container.textContent, "survivor");
  await dom.act(() => dom.container.querySelector("button")!.click());
  await dom.render(null);
  await dom.act(() => pending[2]!(Response.json({ error: "Space not found" }, { status: 404 })));
  assert.deepEqual(failures, []);
});

test("app hints wait for the updated registry and never requery removed Spaces", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const reads: string[] = [];
  let finishDeleted!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/events")) return new Response(new ReadableStream({ start(controller) { stream = logicalEventController(controller, init); init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    reads.push(path);
    if (path.includes("/deleted/")) return new Promise<Response>((resolve) => { finishDeleted = resolve; });
    return Response.json({ apps: [] });
  }) as typeof fetch;
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  function Catalog({ spaces, active }: { spaces: SpaceSummary[]; active: string }) {
    const state = useRestrictedApps({ activeSpaceId: active, spaces, onError });
    return createElement("output", null, [...state.knownSpaceIds].join(","));
  }
  await dom.render(createElement(Catalog, { spaces: [space("deleted"), space("survivor")], active: "deleted" }));
  await dom.act(async () => { stream.enqueue(new TextEncoder().encode('data: {"type":"spaces"}\n\n')); await new Promise(setImmediate); });
  await dom.act(() => finishDeleted(Response.json({ error: "Space not found" }, { status: 404 })));
  assert.deepEqual(errors, []);
  await dom.render(createElement(Catalog, { spaces: [space("survivor")], active: "survivor" }));
  await dom.act(async () => { stream.enqueue(new TextEncoder().encode('data: {"type":"apps"}\n\n')); await new Promise(setImmediate); });
  assert.equal(reads.filter((path) => path.includes("/deleted/")).length, 1);
  assert.equal(dom.container.textContent, "survivor");
});

test("removing a Space tree cancels pending error delivery to the global banner", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => String(input).endsWith("/api/events") ? closedStream(init) : new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const errors: Array<string | null> = [];
  function Tree() { useSpaceTree(space("deleted"), (error) => errors.push(error)); return null; }
  await dom.render(createElement(Tree));
  await dom.render(null);
  await dom.act(() => finish(Response.json({ error: "Space not found" }, { status: 404 })));
  assert.deepEqual(errors, []);
});

test("an external Assistant hint refreshes draft models while existing Chat sessions keep their model", async (t) => {
  const { ChatPanel } = await loadChatPanel(t);
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  HTMLElement.prototype.scrollIntoView = () => {}; // jsdom has no layout/scroll implementation.
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let model = { provider: "openrouter", id: "z-ai/glm", name: "Old GLM" };
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/events")) return new Response(new ReadableStream({ start(controller) { stream = logicalEventController(controller, init); init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    if (path.includes("/agent/composer")) return Response.json({ composer: { model, thinkingLevel: "off", thinkingLevels: ["off"] } });
    if (path.includes("/agent/status")) return Response.json({ status: { configured: true, provider: model.provider, model: model.id } });
    if (path.endsWith("/agent/catalog")) return Response.json({ commands: [], skills: [], extensions: [], diagnostics: [] });
    if (path.endsWith("/conversations")) return Response.json({ conversations: [{ id: "saved", title: "Existing work", createdAt: "2026-09-12T12:00:00.000Z", updatedAt: "2026-09-12T12:00:00.000Z" }] });
    if (path.endsWith("/saved")) return Response.json({ messages: [{ id: "message", role: "assistant", content: "Saved response", createdAt: "2026-09-12T12:00:00.000Z" }] });
    if (path.endsWith("/saved/runtime")) return Response.json({ runtime: {
      sessionId: "saved", model: { provider: "openrouter", id: "old/session", name: "Session Model" },
      usage: { contextTokens: 42, contextWindow: 4096, contextPercent: 1, totalTokens: 42, cost: 0 },
      thinkingLevel: "off", thinkingLevels: ["off"], activeTools: [], isStreaming: false, isCompacting: false,
    } });
    if (path.endsWith("/saved/work")) return Response.json({ work: null });
    if (path.endsWith("/saved/events")) return closedStream(init);
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  function Chat() {
    const [revision] = useAssistantConfigurationRevision();
    const props = { space: space("workshop"), spaceCustomizations: {}, assistantConfigurationRevision: revision, contextPathRequest: null, selectedPath: null, onAgentFinished() {} };
    return createElement("div", null,
      createElement("section", { id: "draft" }, createElement(ChatPanel, { ...props, surfaceTabId: "draft" })),
      createElement("section", { id: "saved" }, createElement(ChatPanel, { ...props, surfaceTabId: "saved", targetConversationId: "saved", active: false })),
    );
  }
  await dom.render(createElement(Chat));
  await dom.waitFor(() => dom.container.textContent?.includes("Old GLM") === true);
  await dom.waitFor(() => dom.container.querySelector("#saved")?.textContent?.includes("Session Model") === true);
  model = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek Flash" };
  await dom.act(async () => { stream.enqueue(new TextEncoder().encode('data: {"type":"assistant"}\n\n')); await new Promise(setImmediate); });
  await dom.waitFor(() => dom.container.textContent?.includes("DeepSeek Flash") === true);
  assert.doesNotMatch(dom.container.textContent ?? "", /Old GLM/);
  assert.match(dom.container.querySelector("#saved")?.textContent ?? "", /Session Model/);
});

async function loadChatPanel(t: { after: (cleanup: () => void) => void }) {
  // Vite supplies SVG URLs and CommonJS icon exports in the app. The DOM
  // test needs only inert graphics; the real Chat state/effects stay intact.
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:fluent-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:fluent-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  return import("../web-local/src/components/chat/ChatPanel.js");
}

test("an externally accepted answer is visible during its continuation and an older settlement cannot restore the previous reply", async (t) => {
  const { ChatPanel } = await loadChatPanel(t);
  const dom = await createDomHarness();
  HTMLElement.prototype.scrollIntoView = () => {};
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  const stamp = "2026-09-12T12:00:00Z";
  let messages = [{ id: "old", role: "assistant", content: "Previous reply", createdAt: stamp }];
  let send!: (event: unknown) => void;
  let lastSubscriptions: Array<{ path: string }> = [];
  let holdNext = false;
  let finishOld!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === "/api/events") return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      const subscriptions = JSON.parse(String(init?.body)).subscriptions;
      lastSubscriptions = subscriptions;
      const write = (event: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      for (const subscription of subscriptions) {
        if (subscription.path.endsWith("/saved/events")) {
          send = (event) => write({ subscriptionId: subscription.id, event });
          send({ type: "turn_snapshot", running: false, text: "Previous reply" });
          send({ type: "turn_state", running: false });
        }
        write({ subscriptionId: subscription.id, ready: true });
      }
    } }));
    if (path.includes("/agent/composer")) return Response.json({ composer: { thinkingLevel: "off", thinkingLevels: ["off"] } });
    if (path.includes("/agent/status")) return Response.json({ status: { configured: true, provider: "test", model: "synthetic" } });
    if (path.endsWith("/agent/catalog")) return Response.json({ commands: [], skills: [], extensions: [], diagnostics: [] });
    if (path.endsWith("/conversations")) return Response.json({ conversations: [{ id: "saved", title: "Answers", createdAt: stamp, updatedAt: stamp }] });
    if (path.endsWith("/saved")) { if (holdNext) { holdNext = false; return new Promise<Response>((resolve) => { finishOld = resolve; }); } return Response.json({ messages }); }
    if (path.endsWith("/saved/runtime")) return Response.json({ runtime: { sessionId: "saved", usage: { contextTokens: 42, contextWindow: 4096, contextPercent: 1, totalTokens: 42, cost: 0 }, thinkingLevel: "off", thinkingLevels: ["off"], activeTools: [], isStreaming: false, isCompacting: false } });
    if (path.endsWith("/saved/work")) return Response.json({ work: null });
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  const chatProps = { space: space("workshop"), spaceCustomizations: {}, contextPathRequest: null, selectedPath: null, onAgentFinished() {}, surfaceTabId: "saved", targetConversationId: "saved" };
  await dom.render(createElement(ChatPanel, chatProps));
  await dom.waitFor(() => Boolean(send) && dom.container.textContent?.includes("Previous reply") === true);
  messages = [...messages, { id: "answer", role: "user", content: "Accepted answer: CAD", createdAt: stamp }];
  await dom.act(() => send({ type: "turn_state", running: true }));
  await dom.waitFor(() => dom.container.textContent?.includes("Accepted answer: CAD") === true);
  assert.equal(dom.container.textContent?.split("Previous reply").length, 2, "the previous final never becomes a second streaming bubble");
  await dom.act(() => send({ type: "assistant_message", text: "First continuation response" }));
  holdNext = true;
  await dom.act(() => send({ type: "done" }));
  assert.ok(finishOld);
  messages = [...messages, { id: "next-answer", role: "user", content: "Next accepted message", createdAt: stamp }];
  await dom.act(() => { send({ type: "turn_state", running: true }); send({ type: "assistant_message", text: "Second continuation is still working" }); });
  await dom.waitFor(() => dom.container.textContent?.includes("Next accepted message") === true);
  await dom.act(() => finishOld(Response.json({ messages: [{ id: "old", role: "assistant", content: "Stale transcript", createdAt: stamp }] })));
  assert.match(dom.container.textContent ?? "", /Second continuation is still working/);
  assert.doesNotMatch(dom.container.textContent ?? "", /Stale transcript|First continuation response/);
  // Another tab reconnects the shared stream while a final transcript read
  // is pending. Its authoritative reread must inherit settlement intent.
  await dom.render(createElement(ChatPanel, { ...chatProps, active: false }));
  assert.ok(lastSubscriptions.some((item) => item.path.endsWith("/saved/events")), "a running background Chat stays subscribed");
  holdNext = true;
  await dom.act(() => send({ type: "done" }));
  const finishSettlement = finishOld;
  messages = [...messages, { id: "final", role: "assistant", content: "Persisted second continuation", createdAt: stamp }];
  const { createEventSource } = await import("../web-local/src/lib/api.js");
  let extra!: ReturnType<typeof createEventSource>;
  await dom.act(() => { extra = createEventSource("/api/spaces/workshop/file-events"); });
  await dom.waitFor(() => dom.container.textContent?.includes("Persisted second continuation") === true && !dom.container.querySelector('[aria-label="Stop Assistant"]'));
  await dom.act(() => finishSettlement(Response.json({ messages: [{ id: "stale-final", role: "assistant", content: "Late settlement", createdAt: stamp }] })));
  assert.doesNotMatch(dom.container.textContent ?? "", /Late settlement/);
  assert.equal(dom.container.querySelector('[aria-label="Stop Assistant"]'), null);
  await dom.waitFor(() => !lastSubscriptions.some((item) => item.path.endsWith("/saved/events")));
  await dom.act(() => extra.close());
  await dom.settle();
});

test("file monitoring re-queries edits made while a multiplex connection drains", async (t) => {
  const { createEventSource } = await import("../web-local/src/lib/api.js");
  const dom = await createDomHarness(); const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  let version = "before.txt"; let connections = 0; let extra: ReturnType<typeof createEventSource> | undefined;
  t.after(() => extra?.close());
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/events") return new Response(new ReadableStream({ start(controller) {
      connections++;
      init?.signal?.addEventListener("abort", () => { version = "written-during-drain.txt"; controller.close(); }, { once: true });
      for (const item of JSON.parse(String(init?.body)).subscriptions) {
        if (item.path.endsWith("/file-events")) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ subscriptionId: item.id, event: { type: "ready", recursive: true } })}\n\n`));
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ subscriptionId: item.id, ready: true })}\n\n`));
      }
    } }));
    return Response.json({ tree: [{ kind: "file", path: version, name: version }] });
  }) as typeof fetch;
  function Tree() { const state = useSpaceTree(space("lab"), () => {}); return createElement("output", null, state.tree.map((item) => item.name).join(",")); }
  await dom.render(createElement(Tree));
  await dom.waitFor(() => dom.container.textContent === "before.txt");
  await dom.act(() => { extra = createEventSource("/api/spaces/lab/conversations/background/events"); });
  await dom.waitFor(() => connections === 2 && dom.container.textContent === "written-during-drain.txt");
});
