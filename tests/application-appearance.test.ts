import assert from "node:assert/strict";
import test from "node:test";
import { applicationAppearanceKey, applicationPresetsKey, applicationAppearanceVariables, appearancePresetKind, defaultApplicationAppearance, parseAppearancePreset, parseApplicationAppearance } from "../src/shared/application-appearance.js";
import { ApplicationAppearanceStore, maximumAppearancePresets } from "../web-local/src/lib/application-appearance-store.js";

function memory(initial: Record<string,string> = {}) {
  const data = new Map(Object.entries(initial));
  let writes = 0;
  return { data, get writes() { return writes; }, getItem: (key: string) => data.get(key) ?? null, setItem(key: string, value: string) { writes += 1; data.set(key, value); } };
}
const preset = (name = "My Paper", preferences = defaultApplicationAppearance) => ({ kind: appearancePresetKind, version: 1, name, preferences });

test("appearance migrates existing preferences without rewriting any storage on load", () => {
  const storage = memory({ "work-fold.theme": "system", "work-fold.typography.v1": JSON.stringify({ font: "verdana", textSize: "comfortable" }) });
  const store = new ApplicationAppearanceStore(storage);
  assert.deepEqual({ mode: store.getSnapshot().preferences.mode, font: store.getSnapshot().preferences.font, readingSize: store.getSnapshot().preferences.readingSize }, { mode: "system", font: "verdana", readingSize: 16 });
  assert.equal(storage.writes, 0);
  store.update({ palette: "paper" });
  assert.equal(storage.writes, 1);
  assert.equal(JSON.parse(storage.data.get(applicationAppearanceKey)!).font, "verdana");
  assert.equal(storage.data.get("work-fold.theme"), "system");
});

test("future appearance and preset bytes survive both initialization and explicit changes", () => {
  const future = JSON.stringify({ version: 2, custom: "new setting" });
  const storage = memory({ [applicationAppearanceKey]: future, [applicationPresetsKey]: future });
  const store = new ApplicationAppearanceStore(storage);
  store.update({ palette: "paper" });
  assert.equal(store.getSnapshot().preferences.palette, "paper");
  assert.match(store.getSnapshot().error!, /newer build/);
  assert.equal(store.getSnapshot().notice, null);
  assert.throws(() => store.savePreset("Preserve future"), /newer build/);
  assert.equal(storage.writes, 0);
  assert.equal(storage.data.get(applicationAppearanceKey), future);
  assert.equal(storage.data.get(applicationPresetsKey), future);
});

test("storage failure is window-only and never reports a saved appearance or preset", () => {
  const store = new ApplicationAppearanceStore({ getItem: () => null, setItem() { throw new Error("quota"); } });
  store.update({ palette: "ink" });
  assert.equal(store.getSnapshot().preferences.palette, "ink");
  assert.match(store.getSnapshot().error!, /could not be saved/);
  assert.equal(store.getSnapshot().notice, null);
  assert.throws(() => store.savePreset("Mine"), /could not be saved/);
  assert.equal(store.getSnapshot().presets.length, 0);
  store.undo();
  assert.equal(store.getSnapshot().preferences.palette, "original");
});

test("storage refresh follows another renderer without a write loop or stale undo", () => {
  const storage = memory();
  const first = new ApplicationAppearanceStore(storage);
  const second = new ApplicationAppearanceStore(storage);
  first.update({ mode: "light", readingSize: 22 });
  second.refresh(applicationAppearanceKey);
  assert.deepEqual(first.getSnapshot().preferences, second.getSnapshot().preferences);
  second.update({ palette: "slate" });
  first.refresh(applicationAppearanceKey);
  assert.equal(first.getSnapshot().preferences.palette, "slate");
  assert.equal(first.getSnapshot().canUndo, false);
  assert.equal(storage.writes, 2);
  first.refresh("unrelated");
  assert.equal(storage.writes, 2);
});

test("undo and reset are bounded and presets never weaken explicit accessibility", () => {
  const store = new ApplicationAppearanceStore(memory());
  store.update({ contrast: "more", motion: "reduce", transparency: "opaque", palette: "ink" });
  store.applyPreset({ ...defaultApplicationAppearance, palette: "paper" });
  assert.equal(store.getSnapshot().preferences.motion, "reduce");
  assert.equal(store.getSnapshot().preferences.contrast, "more");
  assert.equal(store.getSnapshot().preferences.transparency, "opaque");
  store.undo(); assert.equal(store.getSnapshot().preferences.palette, "ink");
  store.reset(); assert.deepEqual(store.getSnapshot().preferences, defaultApplicationAppearance);
  store.undo(); assert.equal(store.getSnapshot().preferences.palette, "ink");
  for (let i = 0; i < 30; i++) store.update({ readingSize: i % 2 ? 14 : 22 });
  let undoCount = 0;
  while (store.getSnapshot().canUndo) { store.undo(); undoCount += 1; }
  assert.equal(undoCount, 20);
});

test("typed preset imports are bounded inert data and do not change the active appearance", () => {
  const storage = memory();
  const store = new ApplicationAppearanceStore(storage);
  store.importPreset(JSON.stringify(preset("Paper", { ...defaultApplicationAppearance, palette: "paper" })));
  assert.equal(store.getSnapshot().preferences.palette, "original");
  assert.equal(store.getSnapshot().presets[0].preferences.palette, "paper");
  assert.throws(() => store.importPreset("x".repeat(16_385)), /smaller than 16 KB/);
  assert.throws(() => store.importPreset(JSON.stringify({ ...preset(), css: "@import url(https://example.org/)" })), /supported/);
  assert.throws(() => parseApplicationAppearance({ ...defaultApplicationAppearance, font: "https://example.org/font" }), /font/);
  assert.throws(() => parseApplicationAppearance({ ...defaultApplicationAppearance, accent: "url(https://example.org)" }), /accent/);
  assert.throws(() => parseApplicationAppearance({ ...defaultApplicationAppearance, readingSize: 1000 }), /between 14 and 22/);
  assert.throws(() => parseAppearancePreset(preset("\n")), /name/);
  assert.equal(storage.writes, 1);
  store.savePreset("paper", { ...defaultApplicationAppearance, palette: "slate" });
  assert.equal(store.getSnapshot().presets.length, 1);
  assert.equal(store.getSnapshot().presets[0].preferences.palette, "slate");
  for (let i = 1; i < maximumAppearancePresets; i++) store.savePreset(`Look ${i}`);
  assert.throws(() => store.savePreset("Too many"), /Keep up to/);
});

test("fixture preferences never read or write personal storage", () => {
  const store = new ApplicationAppearanceStore({ getItem() { throw new Error("must not read"); }, setItem() { throw new Error("must not write"); } }, true);
  store.update({ palette: "paper" }); store.savePreset("Preview"); store.refresh(applicationAppearanceKey);
  assert.equal(store.getSnapshot().preferences.palette, "paper");
  assert.equal(store.getSnapshot().error, null);
  assert.equal(store.getSnapshot().notice, "Preview preset updated");
});

test("a custom accent is independent of device color and has explicit fill/on-fill roles", () => {
  const p = { ...defaultApplicationAppearance, palette: "paper" as const, accent: "#fff000" };
  const a = applicationAppearanceVariables(p, "light", "#ee0022");
  const b = applicationAppearanceVariables(p, "light", "#00eeaa");
  assert.deepEqual(a,b);
  assert.notEqual(a["--ui-accent"], a["--ui-on-accent"]);
  assert.match(a["--ui-accent-solid"], /^#/);
  assert.match(a["--ui-on-accent"], /^#/);
});


test("effect-time checks preserve a future record written before its storage event is delivered", () => {
  const storage = memory();
  const store = new ApplicationAppearanceStore(storage);
  const future = JSON.stringify({ version: 2, extra: "another build wrote this" });
  storage.data.set(applicationAppearanceKey, future);
  storage.data.set(applicationPresetsKey, future);
  store.update({ palette: "ink" });
  assert.equal(store.getSnapshot().preferences.palette, "ink");
  assert.match(store.getSnapshot().error!, /newer build/);
  assert.throws(() => store.savePreset("From old window"), /newer build/);
  assert.equal(storage.data.get(applicationAppearanceKey), future);
  assert.equal(storage.data.get(applicationPresetsKey), future);
  assert.equal(storage.writes, 0);
});
