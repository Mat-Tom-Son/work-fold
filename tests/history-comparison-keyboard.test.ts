import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";

import { HISTORY_REVIEW_LIMITS } from "../src/shared/history-review.js";
import { FileVersionHistoryModal } from "../web-local/src/components/modals/FileVersionHistoryModal.js";
import { useModalDialog } from "../web-local/src/hooks/useModalDialog.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

test("History modal keyboard navigation reaches disclosures and skips text in closed details", async (t) => {
  const dom = await createDomHarness();
  const previousFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = previousFetch; });
  globalThis.fetch = (async (input) => String(input).includes("file-versions")
    ? Response.json({ versions: [{ path: "note.txt", hashSha256: "a".repeat(64), sizeBytes: 7, modifiedAt: "2026-09-27T00:00:00Z", capturedAt: "2026-09-27T00:00:00Z", checkpointId: "cp-before", source: "checkpoint" }] })
    : Response.json({ comparison: {
      schemaVersion: 1, path: "note.txt", change: "modified", limits: HISTORY_REVIEW_LIMITS,
      before: { source: "checkpoint", checkpointId: "cp-before", status: "text", text: "Before" },
      after: { source: "current", status: "text", text: "After", observedAt: "2026-09-27T12:00:00Z" },
      diff: { status: "available", text: "-Before\n+After", truncated: false },
    } })) as typeof fetch;
  await dom.render(createElement(FileVersionHistoryModal, {
    workFolder: { id: "folder", name: "Folder" } as WorkFolderSummary, filePath: "note.txt", fileName: "note.txt", onClose() {}, onRestored() {},
  }));
  await dom.act(() => [...dom.container.querySelectorAll("button")].find((button) => button.textContent === "Compare")!.click());
  const close = dom.container.querySelector<HTMLButtonElement>('[aria-label="Close version history"]')!;
  const details = dom.container.querySelector<HTMLDetailsElement>(".history-file-comparison > details")!;
  const summary = details.querySelector<HTMLElement>(":scope > summary")!;
  assert.equal(details.open, false);
  await dom.act(() => close.focus());
  await dom.press("Tab", { shiftKey: true });
  assert.equal(document.activeElement === summary, true, "wrapping backward must focus the visible disclosure, not a hidden text pane");
  await dom.act(() => { details.open = true; summary.focus(); });
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  await dom.act(() => { summary.dispatchEvent(event); });
  assert.equal(event.defaultPrevented, false, "Tab within visible disclosures should use normal browser navigation");
  assert.equal(document.activeElement === summary, true, "the trap must not send a summary's Tab back to Close");
});

test("dialog focus follows nested disclosure state and hidden ancestors", async (t) => {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  function Dialog() {
    const ref = useModalDialog({ onClose() {} });
    return createElement("section", { ref, role: "dialog", tabIndex: -1 },
      createElement("button", { id: "first" }, "Close"),
      createElement("details", { id: "outer" },
        createElement("summary", { id: "outer-summary" }, "Outer"),
        createElement("summary", { id: "extra-summary", tabIndex: 0 }, "Hidden second summary"),
        createElement("details", { id: "inner", open: true },
          createElement("summary", { id: "inner-summary" }, "Inner"),
          createElement("pre", { id: "text", tabIndex: 0 }, "Saved text"))),
      createElement("div", { hidden: true }, createElement("details", { open: true },
        createElement("summary", { id: "hidden-summary" }, "Hidden"),
        createElement("button", { id: "hidden-button" }, "Hidden control"))));
  }
  await dom.render(createElement(Dialog));
  const first = document.getElementById("first")!;
  const outer = document.getElementById("outer")!;
  const inner = document.getElementById("inner")!;
  await dom.press("Tab", { shiftKey: true });
  assert.equal(document.activeElement?.id, "outer-summary", "a closed outer disclosure also hides its open inner disclosure");
  await dom.act(() => { outer.setAttribute("open", ""); inner.removeAttribute("open"); first.focus(); });
  await dom.press("Tab", { shiftKey: true });
  assert.equal(document.activeElement?.id, "inner-summary", "a closed inner disclosure exposes its summary but not its text");
  await dom.act(() => { inner.setAttribute("open", ""); first.focus(); });
  await dom.press("Tab", { shiftKey: true });
  assert.equal(document.activeElement?.id, "text", "opening every ancestor exposes text to keyboard scrolling");
  await dom.press("Tab");
  assert.equal(document.activeElement?.id, "first", "forward navigation still wraps from the last visible control");
});
