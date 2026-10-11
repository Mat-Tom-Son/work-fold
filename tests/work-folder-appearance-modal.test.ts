import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement, useState } from "react";
import test from "node:test";

import { createDomHarness } from "./support/dom.js";
import type { WorkFolderSummary, WorkFolderCustomization } from "../web-local/src/types.js";

test("Customize work-folder isolates its popup and routes edits to the work-folder it was opened for", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:customize-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:customize-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const { WorkFolderAppearanceModal } = await import("../web-local/src/components/modals/WorkFolderAppearanceModal.js");
  const { workFolderIdentityFor } = await import("../web-local/src/lib/work-folder-identity.js");
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const target = { id: "other-folder", name: "Trip", workFolderRoot: "/tmp/trip", location: { kind: "local", storage: "linked" } } as WorkFolderSummary;
  const edits: string[] = [];
  let closes = 0;
  const popup = createElement(WorkFolderAppearanceModal, {
    workFolder: target,
    identity: workFolderIdentityFor(target, {}),
    canUndo: true,
    onRenameWorkFolder: async (workFolder, name) => { edits.push(`rename:${workFolder.id}:${name}`); },
    onCustomizeWorkFolder: (id) => { edits.push(`customize:${id}`); },
    onReplaceWorkFolder: (id) => { edits.push(`replace:${id}`); },
    onUndoWorkFolder: (id) => { edits.push(`undo:${id}`); },
    onResetWorkFolder: (id) => { edits.push(`reset:${id}`); },
    onClose: () => { closes += 1; },
  });
  const screen = (open: boolean) => createElement("div", null,
    createElement("main", { id: "work" }, createElement("button", { id: "opener" }, "Customize another work-folder")),
    open ? popup : null,
  );
  await dom.render(screen(false));
  document.getElementById("opener")!.focus();
  await dom.render(screen(true));
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.ok(dialog.querySelector('header [role="tablist"]'), "tabs stay in the fixed modal header");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Close Customize work-folder");
  assert.equal(document.getElementById("work")!.getAttribute("aria-hidden"), "true");
  assert.equal(document.getElementById("work")!.inert, true);
  await dom.act(() => document.querySelector<HTMLButtonElement>('[role="tab"][id="folder-appearance-tab-color"]')!.click());
  await dom.act(() => document.querySelector<HTMLButtonElement>('[aria-label="Use Blue color"]')!.click());
  await dom.act(() => document.querySelector<HTMLButtonElement>('[title="Undo the last appearance change"]')!.click());
  await dom.act(() => {
    const field = document.querySelector<HTMLInputElement>('[aria-label="work-folder name for Trip"]')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, "Holiday");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dom.act(() => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(edits, ["customize:other-folder", "undo:other-folder", "rename:other-folder:Holiday"]);
  await dom.press("Escape");
  assert.equal(closes, 1);
  await dom.render(screen(false));
  await dom.settle();
  assert.equal(document.getElementById("work")!.getAttribute("aria-hidden"), null);
  assert.equal(Boolean(document.getElementById("work")!.inert), false);
  assert.equal(document.activeElement?.id, "opener");
});


test("banner framing, image/pattern switching, accent colors and icon categories share one work-folder editor", async (t) => {
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:customize-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:customize-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      return /\.svg(?:\?|$)/.test(url) ? { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true } : next(url, context);
    },
  });
  t.after(() => assets.deregister());
  const { WorkFolderAppearanceModal } = await import("../web-local/src/components/modals/WorkFolderAppearanceModal.js");
  const { workFolderIdentityFor } = await import("../web-local/src/lib/work-folder-identity.js");
  const { filterWorkFolderIconOptions, workFolderIconGroups } = await import("../web-local/src/work-folder-icons.js");
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const target = { id: "target-folder", name: "Notes", workFolderRoot: "/tmp/notes", location: { kind: "local", storage: "linked" } } as WorkFolderSummary;
  const changes: WorkFolderCustomization[] = [];
  const shortcuts: string[] = [];
  let saved: WorkFolderCustomization = { color: "#0e7490", bannerImagePosition: "bottom", bannerImage: "data:image/png;base64,AA==" };
  function Editor() {
    const [customization, setCustomization] = useState(saved);
    return createElement(WorkFolderAppearanceModal, {
      workFolder: target, identity: workFolderIdentityFor(target, { [target.id]: customization }), customization, canUndo: changes.length > 0,
      onCustomizeWorkFolder: (id, patch) => { assert.equal(id, target.id); changes.push(patch); saved = { ...saved, ...patch }; setCustomization(saved); },
      onReplaceWorkFolder: () => {}, onUndoWorkFolder: () => {}, onResetWorkFolder: () => {}, onClose: () => {}, onRenameWorkFolder: async () => {},
      onOpenWorkerSettings: (section, returnSection) => { shortcuts.push(`${target.id}:${section}:${returnSection}`); },
    });
  }
  const click = async (selector: string) => dom.act(() => document.querySelector<HTMLButtonElement>(selector)!.click());
  await dom.render(createElement(Editor));
  assert.equal(document.querySelector('[aria-label="Banner zoom"]'), null, "framing is on demand");
  await click('.work-folder-framing-trigger');
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Banner vertical position"]')!.value, "100");
  await click('[aria-label="Use Fold image"]');
  assert.equal(saved.bannerPreset, "fold");
  assert.equal(saved.bannerImage, undefined);
  assert.equal(saved.color, "#0e7490");
  assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Banner vertical position"]')!.value, "50");
  assert.equal(document.querySelector('[aria-label="Use Fold image"]')!.getAttribute("aria-pressed"), "true");
  const preview = document.querySelector<HTMLElement>('[data-preview-mode="light"]')!;
  await dom.act(() => preview.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })));
  assert.deepEqual(saved.bannerFraming, { x: 50, y: 60, zoom: 1 });
  assert.equal(changes.length, 2, "one keyboard framing edit commits once");
  await click('[aria-label="Reset banner framing"]');
  assert.deepEqual(saved.bannerFraming, { x: 50, y: 50, zoom: 1 });
  await click('#folder-appearance-tab-color');
  assert.equal(document.querySelector('[aria-label="Folder color pairs"]'), null);
  assert.equal(document.querySelector('[aria-label="Choose second banner color"]'), null, "image colors are not exposed as editable pattern colors");
  await click('[aria-label="Use Blue color"]');
  assert.equal(saved.color, "#3b82f6");
  assert.equal(saved.bannerPreset, "fold", "the accent does not discard the chosen image");
  const { workFolderColorOptions, defaultWorkFolderColor } = await import("../web-local/src/lib/work-folder-identity.js");
  const { accentIdentityFromHex, resolveWorkFolderAppearance } = await import("../src/shared/work-folder-appearance.js");
  assert.equal(workFolderColorOptions.length, 24);
  for (const option of workFolderColorOptions) assert.equal(resolveWorkFolderAppearance({ primary: accentIdentityFromHex(option.color) }).passes, true, `${option.label} remains legible in both modes`);
  const originalColors = ["#60646c", "#ce2c31", "#cc4e00", "#ab6400", "#5c7c2e", "#1a7f37", "#0e7490", "#0d74ce", "#6550b9", "#953ea3", "#c2298a", "#815e46"];
  let hash = 0;
  for (const character of target.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  assert.equal(defaultWorkFolderColor(target.id).color, originalColors[hash % originalColors.length], "updating the picker preserves default work-folder identities");
  assert.equal(document.querySelectorAll('.work-folder-color-dot').length, 24);
  await click('#folder-appearance-tab-icon');
  assert.equal(document.querySelectorAll('.work-folder-icon-option').length, filterWorkFolderIconOptions("", "popular").length);
  const nature = [...document.querySelectorAll<HTMLButtonElement>('.work-folder-icon-categories button')].find(button => button.textContent === "Nature")!;
  await dom.act(() => nature.click());
  await click('[aria-label="Use Leaf icon"]');
  assert.equal(saved.iconName, "leaf");
  for (const group of workFolderIconGroups) if (group.id !== "all") assert.equal(filterWorkFolderIconOptions("", group.id).length, group.names.length, `${group.label} has no missing icons`);
  assert.equal(filterWorkFolderIconOptions("camping")[0].name, "tent");
  await click('#folder-appearance-tab-banner');
  await click('[aria-label="Use Classic banner"]');
  assert.ok(document.querySelector('[aria-label="Choose second banner color"]'));
  assert.equal(document.querySelector<HTMLButtonElement>('.work-folder-framing-trigger')!.disabled, true);
  await click('[aria-label="Use Fold image"]');
  await click('.work-folder-framing-trigger');
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Banner horizontal position');
  await dom.press('Escape');
  assert.equal(document.querySelector('[aria-label="Banner zoom"]'), null);
  assert.ok(document.querySelector('[role="dialog"]'), "Escape closes framing before the enclosing dialog");
  assert.equal(document.activeElement?.className, 'work-folder-framing-trigger');
  await click('[aria-label="Use None banner"]');
  assert.equal(saved.bannerPreset, undefined);
  assert.equal(saved.bannerFraming, undefined);
  assert.equal(document.querySelector('[aria-label="Banner zoom"]'), null);
  await click('#folder-appearance-tab-color');
  const shortcutBar = document.querySelector('.work-folder-customize-worker')!;
  assert.equal(shortcutBar.querySelector('span'), null, "the Worker label and robot have been removed");
  const workerButtons = [...document.querySelectorAll<HTMLButtonElement>('.work-folder-customize-worker button')];
  await dom.act(() => workerButtons[0].click());
  await dom.act(() => workerButtons[1].click());
  assert.deepEqual(shortcuts, ["target-folder:model:color", "target-folder:instructions:color"]);
});
