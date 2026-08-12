import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { trayPopoverToggleAction, trayToggleBlurGraceMs } from "../desktop/src/tray-popover-toggle.js";

const popover = await readFile(new URL("../desktop/src/management-popover.ts", import.meta.url), "utf8");

test("a visible popover always toggles hidden", () => {
  assert.equal(trayPopoverToggleAction({ visible: true, lastBlurHiddenAt: null }, 1_000), "hide");
  // Visibility wins even with a fresh blur timestamp (devtools kept it open).
  assert.equal(trayPopoverToggleAction({ visible: true, lastBlurHiddenAt: 990 }, 1_000), "hide");
});

test("a tray click right after its own blur-hide stays closed instead of flashing", () => {
  // The dismissal race: mousedown blurs (hides) the popover, then the click's
  // toggle runs. Within the grace window the click means "close it".
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000), "suppress");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000 + trayToggleBlurGraceMs), "suppress");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 1_000 }, 1_000 + trayToggleBlurGraceMs + 1), "show");
});

test("clean opens and stale or skewed timestamps show the popover", () => {
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: null }, 1_000), "show");
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 0 }, 10_000), "show");
  // A clock that moved backwards must not suppress future clicks forever.
  assert.equal(trayPopoverToggleAction({ visible: false, lastBlurHiddenAt: 2_000 }, 1_000), "show");
});

test("the popover consumes a suppressed toggle so the next click reopens it", () => {
  assert.match(popover, /if \(action === "suppress"\) \{[\s\S]*?this\.#lastBlurHiddenAt = null;[\s\S]*?return;/);
  assert.match(popover, /trayPopoverToggleAction\(\s*\{ visible: this\.isVisible\(\), lastBlurHiddenAt: this\.#lastBlurHiddenAt \},\s*Date\.now\(\),\s*\)/);
});

test("only blur-caused hides arm the tray-click grace", () => {
  // Programmatic hides (Escape, Open work-fold) emit a trailing blur after the
  // window is already hidden; arming the grace there would swallow reopens.
  assert.match(
    popover,
    /window\.on\("blur", \(\) => \{[\s\S]*?if \(!window\.isVisible\(\)\) return;[\s\S]*?this\.#lastBlurHiddenAt = Date\.now\(\);[\s\S]*?this\.hide\(\);[\s\S]*?\}\);/,
  );
});

test("the macOS popover is a nonactivating panel that never transforms the process type", () => {
  // type: "panel" keeps app activation with the previous app, so summoning
  // the popover cannot raise the main window behind it; without
  // skipTransformProcessType Electron turns the whole app into a
  // UIElementApplication (Dock icon gone, app force-deactivated) the moment
  // the popover window exists.
  assert.match(popover, /\.\.\.\(process\.platform === "darwin" \? \{ type: "panel" as const \} : \{\}\)/);
  assert.match(popover, /setVisibleOnAllWorkspaces\(true, \{ visibleOnFullScreen: true, skipTransformProcessType: true \}\)/);
});

test("summoning the popover focuses its content without activating the app on macOS", () => {
  assert.match(
    popover,
    /window\.show\(\);\s*if \(process\.platform === "darwin"\) \{[\s\S]*?window\.webContents\.focus\(\);[\s\S]*?\} else \{\s*window\.focus\(\);\s*\}/,
  );
});

test("a second tray event during a cold open reuses the pending show", () => {
  assert.match(popover, /if \(this\.#pendingShow\) return this\.#pendingShow;/);
  assert.match(popover, /finally \{\s*this\.#pendingShow = null;\s*\}/);
});
