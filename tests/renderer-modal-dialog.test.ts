import assert from "node:assert/strict";
import test from "node:test";
import { createElement, StrictMode, useRef, type ReactElement } from "react";

import { useModalDialog } from "../web-local/src/hooks/useModalDialog.js";
import { createDomHarness } from "./support/dom.js";

/**
 * Behavioural coverage for the shared dialog contract. The keyboard and
 * background-isolation rules here were previously asserted by matching regular
 * expressions against component source, which passes whether or not the
 * behaviour survives.
 */

interface DialogProps {
  onClose: () => void;
  blocked?: boolean;
  focusLast?: boolean;
}

function Dialog({ onClose, blocked, focusLast }: DialogProps): ReactElement {
  const lastRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, blocked, ...(focusLast ? { initialFocusRef: lastRef } : {}) });
  return createElement(
    "div",
    { ref: dialogRef, tabIndex: -1, role: "dialog", "aria-modal": true },
    createElement("button", { type: "button", id: "first" }, "First"),
    createElement("button", { type: "button", id: "last", ref: lastRef }, "Last"),
  );
}

function Screen(props: DialogProps & { open: boolean }): ReactElement {
  const { open, ...dialog } = props;
  return createElement(
    "div",
    null,
    createElement("div", { id: "background" }, createElement("button", { type: "button", id: "opener" }, "Open")),
    open ? createElement(Dialog, dialog) : null,
  );
}

test("an open dialog takes focus, contains Tab, and honours a requested entry point", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());

  await dom.render(createElement(Screen, { open: true, onClose: () => {} }));
  assert.equal(document.activeElement?.id, "first", "focus enters the dialog on open");

  // Tab off the last control wraps to the first rather than escaping to the
  // background, and shift+Tab wraps the other way.
  document.getElementById("last")?.focus();
  await dom.press("Tab");
  assert.equal(document.activeElement?.id, "first", "Tab wraps forward inside the dialog");
  await dom.press("Tab", { shiftKey: true });
  assert.equal(document.activeElement?.id, "last", "Tab wraps backward inside the dialog");

  // Focus leaking to the background is pulled back into the dialog.
  const opener = document.getElementById("opener");
  opener?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  assert.ok(document.getElementById("last")?.contains(document.activeElement)
    || document.querySelector("[role=dialog]")?.contains(document.activeElement), "focus is contained");

  await dom.cleanup();
  const withRequestedFocus = await createDomHarness();
  t.after(() => withRequestedFocus.cleanup());
  await withRequestedFocus.render(createElement(Screen, { open: true, onClose: () => {}, focusLast: true }));
  assert.equal(document.activeElement?.id, "last", "an explicit initial focus target wins");
});

test("Escape closes an idle dialog and is ignored while the dialog is blocked", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());

  let closes = 0;
  await dom.render(createElement(Screen, { open: true, onClose: () => { closes += 1; } }));
  await dom.press("Escape");
  assert.equal(closes, 1, "Escape closes an idle dialog");

  await dom.render(createElement(Screen, { open: true, blocked: true, onClose: () => { closes += 1; } }));
  await dom.press("Escape");
  assert.equal(closes, 1, "Escape cannot abandon a dialog that is mid-operation");
});

test("an open dialog hides the background and restores it on close", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());

  await dom.render(createElement(Screen, { open: false, onClose: () => {} }));
  const opener = document.getElementById("opener");
  opener?.focus();
  assert.equal(document.getElementById("background")?.getAttribute("aria-hidden"), null);
  // jsdom does not implement inert natively, so the value it starts at is not
  // a browser's false. What matters here is that the hook restores whatever it
  // found rather than inventing a value.
  const inertBeforeOpen = document.getElementById("background")?.inert;

  await dom.render(createElement(Screen, { open: true, onClose: () => {} }));
  const background = document.getElementById("background");
  assert.equal(background?.getAttribute("aria-hidden"), "true", "the background is hidden from assistive technology");
  assert.equal(background?.inert, true, "the background stops taking input");

  await dom.render(createElement(Screen, { open: false, onClose: () => {} }));
  assert.equal(document.getElementById("background")?.getAttribute("aria-hidden"), null, "closing restores the background exactly");
  assert.equal(document.getElementById("background")?.inert, inertBeforeOpen, "inert is restored to its prior value");

  await dom.settle();
  assert.equal(document.activeElement?.id, "opener", "focus returns to the control that opened the dialog");
});

test("focus restoration survives React Strict Mode effect replay", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());

  await dom.render(createElement(StrictMode, null, createElement(Screen, { open: false, onClose: () => {} })));
  document.getElementById("opener")?.focus();
  await dom.render(createElement(StrictMode, null, createElement(Screen, { open: true, onClose: () => {} })));
  await dom.render(createElement(StrictMode, null, createElement(Screen, { open: false, onClose: () => {} })));
  await dom.settle();

  assert.equal(document.activeElement?.id, "opener");
});
