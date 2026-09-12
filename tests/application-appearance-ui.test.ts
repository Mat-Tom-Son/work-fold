import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createDomHarness } from "./support/dom.js";
import { applicationAppearanceKey, defaultApplicationAppearance } from "../src/shared/application-appearance.js";
import { ApplicationAppearanceStore } from "../web-local/src/lib/application-appearance-store.js";
import type { SpaceSummary } from "../web-local/src/types.js";

function mediaEnvironment(matches: Record<string,boolean> = {}) {
  const callbacks = new Map<string,Set<() => void>>();
  window.matchMedia = ((query: string) => ({ get matches() { return matches[query] ?? false; }, addEventListener(_name: string, callback: () => void) { if (!callbacks.has(query)) callbacks.set(query,new Set()); callbacks.get(query)!.add(callback); }, removeEventListener(_name: string, callback: () => void) { callbacks.get(query)?.delete(callback); } })) as typeof window.matchMedia;
  return (query: string, value: boolean) => { matches[query] = value; for (const callback of callbacks.get(query) ?? []) callback(); };
}
function changeSelect(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
}

test("appearance controls affect the shared document, preserve explicit Space routing, and support undo", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup()); mediaEnvironment();
  const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
  const { AppearanceSettingsPane } = await import("../web-local/src/components/modals/AppearanceSettingsPane.js");
  const store = new ApplicationAppearanceStore(null, true);
  const routes: string[] = [];
  function Screen() { const appearance = useApplicationAppearance({ store, fixtureMode: true }); return createElement(AppearanceSettingsPane, { appearance, space: { id: "space-owner", name: "Workshop" } as SpaceSummary, onCustomizeSpace: (id) => routes.push(id) }); }
  await dom.render(createElement(Screen));
  await dom.act(() => document.querySelector<HTMLButtonElement>('[aria-label="Paper preset"]')!.click());
  assert.equal(document.documentElement.dataset.appearancePalette, "paper");
  assert.match(document.documentElement.style.getPropertyValue("--work-fold-reading-font"), /Georgia/);
  await dom.act(() => { changeSelect("Reading size", "22"); changeSelect("List density", "spacious"); changeSelect("Your messages", "quiet"); });
  assert.equal(document.documentElement.style.getPropertyValue("--work-fold-reading-size"), "22px");
  assert.equal(document.documentElement.dataset.appearanceDensity, "spacious");
  assert.equal(document.documentElement.dataset.appearanceMessages, "quiet");
  await dom.act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Undo")!.click());
  assert.equal(document.documentElement.dataset.appearanceMessages, "tinted");
  await dom.act(() => Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Customize this folder")!.click());
  assert.deepEqual(routes, ["space-owner"]);
});

test("device accessibility follows changes even with an explicit app mode, and fixture never touches native theme", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const updateDevice = mediaEnvironment();
  let nativeCalls = 0;
  window.workFoldDesktop = { app: { platform: "darwin" }, window: { setTheme() { nativeCalls++; }, getAccentColor() { nativeCalls++; return Promise.resolve("#ffffff"); } } } as never;
  const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
  const store = new ApplicationAppearanceStore(null, true);
  function Screen() { useApplicationAppearance({ store, fixtureMode: true }); return null; }
  await dom.render(createElement(Screen));
  await dom.act(() => { updateDevice("(prefers-contrast: more)", true); updateDevice("(prefers-reduced-motion: reduce)", true); updateDevice("(prefers-reduced-transparency: reduce)", true); });
  assert.equal(document.documentElement.dataset.appearanceMotion, "reduce");
  assert.equal(document.documentElement.dataset.appearanceContrast, "more");
  assert.equal(document.documentElement.dataset.appearanceTransparency, "opaque");
  await dom.act(() => store.update({ mode: "dark", motion: "system", contrast: "system", transparency: "system" }));
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(document.documentElement.dataset.appearanceMotion, "reduce");
  assert.equal(nativeCalls, 0);
});

test("storage events update mounted consumers and late accent reads cannot overwrite a newer device event", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup()); mediaEnvironment();
  const data = new Map<string,string>();
  const store = new ApplicationAppearanceStore({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key,value); } });
  let finishRead!: (value: string) => void;
  let accentEvent!: (value: string) => void;
  window.workFoldDesktop = { app: { platform: "darwin" }, window: { setTheme() {}, getAccentColor: () => new Promise<string>((resolve) => { finishRead = resolve; }), onAccentColorChanged(callback: (value: string) => void) { accentEvent = callback; return () => {}; } } } as never;
  const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
  function Screen() { useApplicationAppearance({ store }); return null; }
  await dom.render(createElement(Screen));
  await dom.act(() => accentEvent("#348743"));
  const freshAccent = document.documentElement.style.getPropertyValue("--ui-accent-solid");
  await dom.act(async () => { finishRead("#ed0011"); await Promise.resolve(); });
  assert.equal(document.documentElement.style.getPropertyValue("--ui-accent-solid"), freshAccent);
  data.set(applicationAppearanceKey, JSON.stringify({ ...defaultApplicationAppearance, mode: "light", palette: "ink", readingSize: 20 }));
  await dom.act(() => window.dispatchEvent(new window.StorageEvent("storage", { key: applicationAppearanceKey })));
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(document.documentElement.dataset.appearancePalette, "ink");
  assert.equal(document.documentElement.style.getPropertyValue("--work-fold-reading-size"), "20px");
});

test("a file import that completes after leaving Appearance cannot save into the closed form", async (t) => {
  const dom = await createDomHarness(); t.after(() => dom.cleanup()); mediaEnvironment();
  const { useApplicationAppearance } = await import("../web-local/src/hooks/useApplicationAppearance.js");
  const { AppearanceSettingsPane } = await import("../web-local/src/components/modals/AppearanceSettingsPane.js");
  const store = new ApplicationAppearanceStore(null, true);
  let finishFile!: (text: string) => void;
  function Screen() { const appearance = useApplicationAppearance({ store, fixtureMode: true }); return createElement(AppearanceSettingsPane, { appearance, space: null }); }
  await dom.render(createElement(Screen));
  await dom.act(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [{ size: 300, text: () => new Promise<string>((resolve) => { finishFile = resolve; }) }] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await dom.render(null);
  await dom.act(async () => { finishFile(JSON.stringify({ kind: "work-fold.appearance-preset", version: 1, name: "Late", preferences: defaultApplicationAppearance })); await Promise.resolve(); });
  assert.equal(store.getSnapshot().presets.length, 0);
});
