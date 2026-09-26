import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement, useState } from "react";
import type { AgentStatus, RestrictedAppInstalled, SpaceSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:apps-settings-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:apps-settings-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { SettingsAppsPane } = await import("../web-local/src/components/modals/SettingsAppsPane.js");
const { DesktopSettingsModal } = await import("../web-local/src/components/modals/DesktopSettingsModal.js");
assets.deregister();
const { useRestrictedApps } = await import("../web-local/src/hooks/useRestrictedApps.js");
const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
const { useSurfaceTabs } = await import("../web-local/src/hooks/useSurfaceTabs.js");

const source = { id: "source", name: "App source", spaceRoot: "/synthetic/source" } as SpaceSummary;
const target = { id: "target", name: "App installation", spaceRoot: "/synthetic/target" } as SpaceSummary;
const unrelated = { id: "unrelated", name: "Current folder", spaceRoot: "/synthetic/unrelated" } as SpaceSummary;
const spaces = [source, target, unrelated];

test("Settings Apps stops after a failed catalog read and retries only on request or reopening", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  let attempts = 0;
  let fail = true;
  const failures: unknown[] = [];
  const onError = (error: unknown) => failures.push(error);
  const registered = [target];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/api/events")) return pendingEvents(init?.signal);
    assert.ok(String(input).endsWith("/api/spaces/target/restricted-apps"));
    attempts++;
    return fail ? Response.json({ error: "Folder unavailable" }, { status: 404 }) : Response.json({ apps: [] });
  };
  function Screen() {
    const apps = useRestrictedApps({ activeSpaceId: "", spaces: registered, onError });
    const [open, setOpen] = useState(false);
    return createElement("main", null,
      createElement("button", { id: "toggle-settings", onClick: () => setOpen((value) => !value) }, "Toggle settings"),
      open ? createElement(SettingsAppsPane, { spaces: registered, apps }) : null);
  }
  const retry = () => [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Retry Loading Apps");
  await dom.render(createElement(Screen));
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>("#toggle-settings")!.click());
  await dom.waitFor(() => Boolean(retry()));
  await dom.settle();
  await dom.settle();
  assert.equal(attempts, 1);
  assert.equal(failures.length, 1);
  assert.match(dom.container.textContent ?? "", /Could not load apps in App installation/);
  assert.doesNotMatch(dom.container.textContent ?? "", /No apps yet/);
  await dom.act(() => retry()!.click());
  await dom.waitFor(() => attempts === 2 && Boolean(retry()));
  await dom.settle();
  assert.equal(attempts, 2);
  fail = false;
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>("#toggle-settings")!.click());
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>("#toggle-settings")!.click());
  await dom.waitFor(() => dom.container.textContent?.includes("No apps yet") === true);
  assert.equal(attempts, 3);
  assert.equal(retry(), undefined);
});

test("an app result file leaves both Settings dialogs and activates the installation's Folder", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const app = { spaceId: target.id, sourceSpaceId: source.id, featureInstallationId: "feature-installation_target", runtimeInstanceKind: "app", runtimeInstanceId: "runtime-instance_target",
    packageName: "quotes", version: "1.0.0", digest: "a".repeat(64), installedAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z",
    networkGrants: [], fileGrants: [], notificationGrants: [], automations: [],
    manifest: { id: "quotes", title: "Quotes", version: 2, runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: {}, tools: [], automations: [],
      permissions: { network: [], files: [], notifications: [] }, assistantActions: [{ id: "compare", title: "Compare", instructions: "Compare quotes", inputSchema: { type: "string", maxLength: 100 } }] } } as RestrictedAppInstalled;
  const task = { id: "task-one", requestId: "request-one", actionId: "compare", title: "Compare", status: "succeeded", createdAt: app.installedAt, updatedAt: app.updatedAt,
    result: { summary: "Comparison written.", outcome: "succeeded", files: [{ path: "exports/comparison.md", sha256: "b".repeat(64), sizeBytes: 64 }] } };
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/events")) return pendingEvents(init?.signal);
    if (path.includes("assistant-tasks")) return Response.json({ tasks: [task] });
    if (path.includes("build-context")) return Response.json({ context: { sourceSpaceId: source.id, sourcePath: null, buildConversationId: null, updateTargetRuntimeInstanceId: app.runtimeInstanceId } });
    if (path.includes("connections")) return Response.json({ connections: [] });
    if (path.includes("storage/recovery")) return Response.json({ recovery: null });
    if (path.includes("storage")) return Response.json({ usage: { revision: 0, usageBytes: 0, quotaBytes: 1000, keyCount: 0, keyLimit: 512 } });
    throw new Error(`Unexpected API read: ${path}`);
  };
  const installed = {
    appsBySpace: { [target.id]: [app] }, knownSpaceIds: new Set(spaces.map((space) => space.id)), loadingSpaceIds: new Set<string>(),
    async refresh() {}, replaceApps() {}, replaceRuntimeInstanceApps() {}, upsertApp() {}, removeApp() {},
  };
  const opened: string[][] = [];
  function Screen() {
    const appearance = useApplicationAppearance({ fixtureMode: true });
    const [settingsOpen, setSettingsOpen] = useState(true);
    const [activeSpace, setActiveSpace] = useState(unrelated);
    const tabs = useSurfaceTabs({ space: activeSpace, spaces, fixtureMode: true, onSwitchSpace: setActiveSpace });
    const selectedTab = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId);
    return createElement("main", null,
      createElement("button", { id: "shell-navigation" }, "Files"),
      createElement("output", { "data-active-space": activeSpace.id }, selectedTab?.kind === "file" ? selectedTab.path : "Chat"),
      settingsOpen ? createElement(DesktopSettingsModal, {
        appearance, space: activeSpace, spaces, restrictedApps: installed, initialPage: "apps", updateStatus: null,
        agentStatus: { configured: true, ready: true } as AgentStatus, onAgentConfigured() {}, onClose: () => setSettingsOpen(false),
        onOpenAppResultFile(spaceId, path) {
          opened.push([spaceId, path]);
          setSettingsOpen(false);
          tabs.openFileSurfaceTab(spaces.find((space) => space.id === spaceId)!, path);
        },
      }) : null);
  }
  await dom.render(createElement(Screen));
  const details = [...dom.container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Details");
  assert.ok(details);
  await dom.act(() => details.click());
  await dom.waitFor(() => Boolean(dom.container.querySelector('[aria-label="Assistant result files"] button')));
  assert.equal(dom.container.querySelectorAll('[role="dialog"]').length, 2);
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>('[aria-label="Assistant result files"] button')!.click());
  await dom.waitFor(() => !dom.container.querySelector('[role="dialog"]'));
  assert.deepEqual(opened, [[target.id, "exports/comparison.md"]]);
  assert.equal(dom.container.querySelector("output")?.getAttribute("data-active-space"), target.id);
  assert.equal(dom.container.querySelector("output")?.textContent, "exports/comparison.md");
  assert.notEqual(dom.container.querySelector<HTMLElement>("#shell-navigation")!.inert, true);
});

test("a stale saved Folder cannot fetch apps before bootstrap validates registrations", async (t) => {
  const dom = await createDomHarness();
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map([["work-fold.space.active", "removed-folder"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } });
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  const loader = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:apps-settings-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (/\.(png|svg)(?:\?.*)?$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      if (/\.css(?:\?.*)?$/.test(url)) return { format: "module", source: "export {};", shortCircuit: true };
      return next(url, context);
    },
  });
  t.after(async () => {
    await dom.cleanup();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    loader.deregister();
  });
  let completeBootstrap!: (response: Response) => void;
  const appReads: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/events")) return pendingEvents(init?.signal);
    if (path.endsWith("/api/bootstrap")) return new Promise<Response>((resolve) => { completeBootstrap = resolve; });
    if (path.includes("/restricted-apps")) {
      appReads.push(path);
      return Response.json({ error: "Folder was removed" }, { status: 404 });
    }
    throw new Error(`Unexpected startup API read: ${path}`);
  };
  const { App } = await import("../web-local/src/App.js");
  await dom.render(createElement(App));
  await dom.waitFor(() => Boolean(completeBootstrap));
  await dom.settle();
  assert.deepEqual(appReads, [], "the stale persisted selection has not been admitted by bootstrap");
  await dom.act(() => completeBootstrap(Response.json({ spaces: [], agent: { configured: false, ready: false } })));
  await dom.waitFor(() => Boolean(dom.container.querySelector('[aria-label="Choose a folder"]')));
  assert.deepEqual(appReads, [], "the removed Folder is never fetched after the registry is known");
  assert.equal(dom.container.querySelector('[role="alert"]'), null);
});

function pendingEvents(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError")), { once: true });
  });
}
