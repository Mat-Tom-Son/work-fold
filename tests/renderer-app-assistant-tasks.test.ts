import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";
import { createDomHarness } from "./support/dom.js";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { RestrictedAppInstalled, SpaceSummary } from "../web-local/src/types.js";
import { restrictedAppAssistantTaskUsageLine } from "../web-local/src/lib/restricted-app-assistant.js";

test("opening an app task Chat closes its retained Apps dialog and restores shell navigation", async (t) => {
  // The icon package's module field is bundler-owned, just as in Vite. Keep
  // React external so the component uses this harness's one React instance.
  const compiled = await mkdtemp(resolve("node_modules/.app-task-renderer-test-"));
  t.after(() => rm(compiled, { recursive: true, force: true }));
  const outfile = join(compiled, "component.mjs");
  await build({ entryPoints: [resolve("web-local/src/components/panes/RestrictedAppsSection.tsx")], outfile,
    bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    plugins: [{ name: "renderer-icons", setup(builder) {
      builder.onResolve({ filter: /^@fluentui\/react-icons$/ }, () => ({ path: resolve("node_modules/@fluentui/react-icons/lib/index.js") }));
    } }], logLevel: "silent" });
  const { RestrictedAppsSection } = await import(pathToFileURL(outfile).href) as typeof import("../web-local/src/components/panes/RestrictedAppsSection.js");
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const app = { spaceId: "space-one", sourceSpaceId: "space-one", featureInstallationId: "feature-one", runtimeInstanceKind: "development", runtimeInstanceId: "runtime-one",
    packageName: "quotes", version: "1.0.0", digest: "a".repeat(64), installedAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    networkGrants: [], fileGrants: [], notificationGrants: [], automations: [],
    manifest: { id: "quotes", title: "Quotes", version: 2, runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], automations: [],
      permissions: { network: [], files: [], notifications: [] }, assistantActions: [{ id: "compare", title: "Compare", instructions: "Compare quotes", inputSchema: { type: "string", maxLength: 100 } }] } } as RestrictedAppInstalled;
  const task = { id: "task-one", requestId: "request-one", actionId: "compare", title: "Compare", status: "succeeded", createdAt: app.installedAt, updatedAt: app.updatedAt, startedAt: app.updatedAt,
    model: { provider: "anthropic", id: "claude-sonnet-4-5" }, usage: { inputTokens: 12048, outputTokens: 486, amountUsd: 0.0312 } };
  const running = { ...task, id: "task-two", requestId: "request-two", status: "running", model: undefined, usage: undefined };
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.includes("control-events")) return new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true }); });
    let value: unknown;
    if (path.includes("assistant-tasks/request-one")) value = { detail: { task, instructions: "Compare quotes", inputJson: '"North $42"', conversationId: "chat-one" } };
    else if (path.includes("assistant-tasks")) value = { tasks: [task, running] };
    else if (path.includes("build-context")) value = { context: { sourceSpaceId: app.spaceId, sourcePath: null, buildConversationId: null, updateTargetRuntimeInstanceId: null } };
    else if (path.includes("connections")) value = { connections: [] };
    else if (path.includes("storage/recovery")) value = { recovery: null };
    else if (path.includes("storage")) value = { usage: { revision: 0, usageBytes: 0, quotaBytes: 1000, keyCount: 0, keyLimit: 512 } };
    else throw new Error(`Unexpected API read: ${path}`);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  };
  const errors: (string | null)[] = [];
  const opened: string[][] = [];
  const onError = (message: string | null) => errors.push(message);
  function Screen() {
    const [chatOpen, setChatOpen] = useState(false);
    return createElement("main", null,
      createElement("nav", { id: "shell-navigation" }, createElement("button", { id: "settings" }, "Settings")),
      createElement("section", { hidden: chatOpen }, createElement(RestrictedAppsSection, {
        space: { id: app.spaceId, name: "Quotes", spaceRoot: "/synthetic" } as SpaceSummary,
        apps: [app], loading: false, onBuildApp() {}, onOpenAppStudio() {}, onUpsertApp() {}, onRemoveApp() {}, onError,
        async onOpenBuildChat(spaceId, conversationId) { opened.push([spaceId, conversationId]); setChatOpen(true); },
      })),
      chatOpen ? createElement("article", { id: "chat" }, "Task Chat") : null);
  }
  const button = (label: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label)!;
  const buttons = () => Array.from(document.querySelectorAll("button")).map((item) => item.textContent);
  await dom.render(createElement(Screen));
  await dom.act(() => button("Details").click());
  await dom.waitFor(() => Boolean(button("Open Chat")));
  assert.equal(document.getElementById("shell-navigation")!.inert, true);
  assert.ok(buttons().includes("Stop"), "a running request offers Stop");
  assert.deepEqual(
    Array.from(document.querySelectorAll(".restricted-app-task-usage")).map((item) => item.textContent),
    ["anthropic · claude-sonnet-4-5 · 12048 in · 486 out · $0.0312"],
    "a settled request shows one compact model and usage line; a running one shows none yet",
  );
  assert.ok(!buttons().some((label) => label === "Review" || label === "Run in this Space" || label === "Dismiss"), "no review or approval controls");
  await dom.act(() => button("Open Chat").click());
  await dom.waitFor(() => Boolean(document.getElementById("chat")) && !document.querySelector('[role="dialog"]'));
  assert.deepEqual(opened, [["space-one", "chat-one"]]);
  assert.notEqual(document.getElementById("shell-navigation")!.inert, true);
  assert.equal(document.getElementById("shell-navigation")!.getAttribute("aria-hidden"), null);
  document.getElementById("settings")!.focus();
  assert.equal(document.activeElement?.id, "settings");
  assert.deepEqual(errors, []);
});

test("the Apps tab request line reports a model without pricing as a cost it does not know", () => {
  assert.equal(
    restrictedAppAssistantTaskUsageLine({ model: { provider: "custom", id: "local-model" }, usage: { inputTokens: 900, outputTokens: 0 } }),
    "custom · local-model · 900 in · 0 out",
    "a model with no pricing contributes no cost segment instead of claiming the turn was free",
  );
  assert.equal(
    restrictedAppAssistantTaskUsageLine({ model: { provider: "anthropic", id: "claude-sonnet-4-5" }, usage: { inputTokens: 4, outputTokens: 2, amountUsd: 1.5 } }),
    "anthropic · claude-sonnet-4-5 · 4 in · 2 out · $1.50",
  );
  assert.equal(restrictedAppAssistantTaskUsageLine({}), null, "a request that has not settled shows no line at all");
});
