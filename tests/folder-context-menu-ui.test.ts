import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import test from "node:test";
import { createDomHarness } from "./support/dom.js";
import type { SpaceSummary } from "../web-local/src/types.js";

const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:folder-menu-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:folder-menu-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(png|svg)$/.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
    return next(url, context);
  },
});
const { SpacePaneHeader } = await import("../web-local/src/components/panes/spaceChrome.js");
const { spaceIdentityFor } = await import("../web-local/src/lib/space-identity.js");
assets.deregister();

test("the work-folder context menu consumes outside presses, preserves its actions, and restores normal pane input after dismissal", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const space = { id: "menu-owner", name: "Workshop", spaceRoot: "/synthetic/workshop", location: { kind: "local", storage: "linked" } } as SpaceSummary;
  let resizes = 0;
  let customizes = 0;
  await dom.render(createElement("div", { className: "app-shell" },
    createElement(SpacePaneHeader, {
      space, identity: spaceIdentityFor(space, {}), spaces: [space], spaceCustomizations: {},
      onSwitchSpace: () => {}, onCreateSpace: () => {}, onOpenFolder: () => {}, onManageSpaces: () => {},
      onNewChat: () => {}, onOpenAppearance: () => { customizes += 1; },
    }),
    createElement("button", { id: "resize", onPointerDown: () => { resizes += 1; } }, "Resize pane"),
  ));
  const header = document.querySelector<HTMLElement>(".space-identity-header")!;
  const trigger = document.querySelector<HTMLButtonElement>(".space-pane-switch-trigger")!;
  const open = async () => {
    await dom.act(() => header.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })));
    await dom.waitFor(() => document.activeElement?.getAttribute("role") === "menuitem");
  };
  await open();
  const menu = document.querySelector<HTMLElement>('[aria-label="work-folder actions"]')!;
  assert.equal(menu.parentElement?.className, "app-shell", "the menu escapes the header's stacking layer while retaining the app's theme");
  assert.ok(document.querySelector(".folder-context-menu-backdrop"));
  const outside = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
  await dom.act(() => document.getElementById("resize")!.dispatchEvent(outside));
  assert.equal(outside.defaultPrevented, true);
  assert.equal(resizes, 0, "the dismissing press never reaches the resize handle");
  assert.equal(document.querySelector(".folder-context-menu"), null);
  assert.equal(document.activeElement, trigger);
  await dom.act(() => document.getElementById("resize")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  assert.equal(resizes, 1, "pane input works again after the menu closes");

  await open();
  await dom.press("ArrowDown");
  assert.equal(document.activeElement?.textContent, "Customize work-folder");
  await dom.act(() => (document.activeElement as HTMLButtonElement).click());
  assert.equal(customizes, 1);
  assert.equal(document.querySelector(".folder-context-menu-backdrop"), null);
  await open();
  await dom.press("Escape");
  assert.equal(document.querySelector(".folder-context-menu"), null);
  assert.equal(document.activeElement, trigger);
});
