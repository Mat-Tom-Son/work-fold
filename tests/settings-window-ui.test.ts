import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import test from "node:test";
import { createElement, useState } from "react";
import type { AgentStatus, AppThemePreference, AppTypographyPreference, SpaceSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

// The real modal includes brand artwork. Node needs only the asset URL; the
// browser visual pass checks the actual images and CSS.
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:settings-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
  if (url === "test:settings-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
  if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
  return next(url, context);
} });
const { DesktopSettingsModal } = await import("../web-local/src/components/modals/DesktopSettingsModal.js");
assets.deregister();

const status: AgentStatus = { configured: true, ready: true, provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", error: null, piVersion: "fixture" };
const space = { id: "settings-test", name: "Workshop", spaceRoot: "/synthetic/workshop" } as SpaceSummary;

test("Settings navigation preserves Assistant edits, isolates tab groups and restores focus on close", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  function Screen() {
    const [open, setOpen] = useState(false);
    const [theme, setTheme] = useState<AppThemePreference>("light");
    const [typography, setTypography] = useState<AppTypographyPreference>({ font: "default", textSize: "standard" });
    return createElement("div", null,
      createElement("button", { id: "settings-opener", onClick: () => setOpen(true) }, "Settings"),
      open ? createElement(DesktopSettingsModal, {
        theme: "light", themePreference: theme, onThemePreferenceChange: setTheme,
        typography, onTypographyChange: (update) => setTypography((current) => ({ ...current, ...update })),
        space, agentStatus: status, fixtureMode: true, updateStatus: null,
        onAgentConfigured: () => {}, onClose: () => setOpen(false),
      }) : null);
  }
  await dom.render(createElement(Screen));
  const opener = document.getElementById("settings-opener")!;
  opener.focus();
  await dom.act(() => opener.click());
  const click = async (id: string) => dom.act(() => document.getElementById(id)!.click());
  const nav = document.querySelector('[aria-label="Settings sections"]')!;
  assert.equal(nav.querySelectorAll('[tabindex="0"]').length, 1);
  document.getElementById("settings-tab-appearance")!.focus();
  await dom.press("ArrowDown");
  assert.equal(document.activeElement?.id, "settings-tab-assistant");
  await dom.waitFor(() => Boolean(document.querySelector("textarea")));
  await dom.act(() => {
    const field = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Unsaved workshop guidance");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("settings-tab-appearance");
  assert.equal(document.getElementById("settings-panel-assistant")?.hidden, true);
  await click("settings-tab-assistant");
  assert.equal(document.querySelector("textarea")?.value, "Unsaved workshop guidance");
  assert.equal(document.getElementById("settings-panel-assistant")?.hidden, false);

  const content = document.querySelector<HTMLElement>(".settings-content")!;
  content.scrollTop = 250;
  await click("settings-tab-remote");
  assert.equal(content.scrollTop, 0, "a newly selected settings page starts at its heading");
  document.getElementById("fold-settings-tab-access")!.focus();
  await dom.press("ArrowRight");
  assert.equal(document.activeElement?.id, "fold-settings-tab-pages");
  assert.equal(document.getElementById("settings-tab-remote")?.getAttribute("aria-selected"), "true");
  assert.equal(document.getElementById("fold-settings-panel-pages")?.getAttribute("aria-labelledby"), "fold-settings-tab-pages");

  await dom.press("Escape");
  await dom.settle();
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, opener);
});

test("an accepted Settings save retains its owner across page navigation", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  HTMLElement.prototype.scrollIntoView = () => {};
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  let reads = 0;
  let writes = 0;
  let finishSave!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/control-events")) return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }));
    if (init?.method === "POST") {
      writes += 1;
      return new Promise<Response>((resolve) => { finishSave = resolve; });
    }
    reads += 1;
    return Response.json({ status, models: [{ provider: "openrouter", providerName: "OpenRouter", id: status.model, name: "DeepSeek Flash", authConfigured: true }], catalogs: [], instructions: "Original" });
  }) as typeof fetch;
  await dom.render(createElement(DesktopSettingsModal, {
    theme: "light", themePreference: "light", onThemePreferenceChange: () => {},
    typography: { font: "default", textSize: "standard" }, onTypographyChange: () => {},
    space, agentStatus: status, initialPage: "assistant", updateStatus: null,
    onAgentConfigured: () => {}, onClose: () => {},
  }));
  await dom.waitFor(() => Boolean(document.querySelector("textarea")));
  await dom.act(() => {
    const field = document.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Saved guidance");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => document.querySelector('[aria-labelledby="assistant-instructions-heading"] form')!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await dom.act(submit);
  await dom.act(() => document.getElementById("settings-tab-appearance")!.click());
  await dom.act(() => document.getElementById("settings-tab-assistant")!.click());
  await dom.act(submit);
  assert.equal(writes, 1, "page navigation cannot admit a duplicate pending save");
  assert.equal(reads, 1, "returning keeps the pending owner's form instead of starting a stale read");
  assert.equal(document.querySelector("textarea")?.value, "Saved guidance");
  await dom.act(() => finishSave(Response.json({ instructions: "Saved guidance" })));
  await dom.waitFor(() => Boolean(document.querySelector('[aria-labelledby="assistant-instructions-heading"]')?.textContent?.includes("Instructions saved")));
});

test("opening Settings from a model label focuses the loaded selector only once", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  await dom.render(createElement(DesktopSettingsModal, {
    theme: "light", themePreference: "light", onThemePreferenceChange: () => {},
    typography: { font: "default", textSize: "standard" }, onTypographyChange: () => {},
    space, agentStatus: status, fixtureMode: true, initialPage: "assistant", focusAssistantModel: true,
    updateStatus: null, onAgentConfigured: () => {}, onClose: () => {},
  }));
  await dom.waitFor(() => document.activeElement?.id === "assistant-model");
  await dom.act(() => { document.getElementById("settings-tab-appearance")!.focus(); document.getElementById("settings-tab-appearance")!.click(); });
  await dom.press("ArrowDown");
  assert.equal(document.activeElement?.id, "settings-tab-assistant", "returning to Assistant does not reclaim focus");
});
