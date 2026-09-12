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
    if (path.endsWith("/control-events")) return new Response(new ReadableStream({ start(controller) { stream = controller; init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
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
  globalThis.fetch = (async (input, init) => String(input).includes("/file-events") ? closedStream(init) : new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const errors: Array<string | null> = [];
  function Tree() { useSpaceTree(space("deleted"), (error) => errors.push(error)); return null; }
  await dom.render(createElement(Tree));
  await dom.render(null);
  await dom.act(() => finish(Response.json({ error: "Space not found" }, { status: 404 })));
  assert.deepEqual(errors, []);
});

test("an external Assistant hint refreshes draft models while existing Chat sessions keep their model", async (t) => {
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
  const { ChatPanel } = await import("../web-local/src/components/chat/ChatPanel.js");
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  HTMLElement.prototype.scrollIntoView = () => {}; // jsdom has no layout/scroll implementation.
  const previousFetch = globalThis.fetch; t.after(() => { globalThis.fetch = previousFetch; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let model = { provider: "openrouter", id: "z-ai/glm", name: "Old GLM" };
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/control-events")) return new Response(new ReadableStream({ start(controller) { stream = controller; init?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
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
