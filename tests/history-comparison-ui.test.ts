import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { HistoryFileComparison } from "../web-local/src/components/panes/HistoryFileComparison.js";
import { FileVersionHistoryModal } from "../web-local/src/components/modals/FileVersionHistoryModal.js";
import { HISTORY_REVIEW_LIMITS, type HistoryFileComparison as Comparison } from "../src/shared/history-review.js";
import { createDomHarness } from "./support/dom.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";

const props = { workFolderId: "folder-a", path: "notes.txt", fromCheckpointId: "cp-before" };
const comparison = (path = props.path): Comparison => ({ schemaVersion: 1, path, before: { source: "checkpoint", checkpointId: props.fromCheckpointId, status: "text", text: "Before\n" }, after: { source: "current", status: "text", text: "After\n", observedAt: "2026-09-27T12:00:00Z" }, change: "modified", diff: { status: "available", text: "-Before\n+After", truncated: false }, limits: HISTORY_REVIEW_LIMITS });

test("History comparison is an inert GET, renders text literally, and discloses incomplete evidence", async (t) => {
  const dom = await createDomHarness(); const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method, "GET"); calls.push(String(input));
    const body = comparison(); body.before.text = "<script>unsafe()</script>";
    body.after = { source: "current", status: "uncaptured", reason: "skipped_symbolic_link" }; body.change = "unknown";
    body.diff = { status: "limited", reason: "output_limit", truncated: true, text: "-<img src=x>\n+next" };
    return Response.json({ comparison: body });
  }) as typeof fetch;
  await dom.render(createElement(HistoryFileComparison, props));
  assert.equal(calls.length, 1); assert.match(calls[0]!, /folder-a\/history\/diff\?path=notes.txt&fromCheckpointId=cp-before/);
  assert.match(dom.container.textContent!, /Comparison incomplete/); assert.match(dom.container.textContent!, /symbolic link/);
  assert.match(dom.container.textContent!, /text difference is incomplete/); assert.match(dom.container.textContent!, /<script>unsafe\(\)<\/script>/);
  assert.equal(dom.container.querySelector("script,img"), null);
  await dom.act(() => dom.container.querySelector("button")!.click()); assert.equal(calls.length, 2);
});

test("switching folders and closing ignore stale History responses", async (t) => {
  const dom = await createDomHarness(); const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const pending: Array<(response: Response) => void> = [];
  globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch;
  await dom.render(createElement(HistoryFileComparison, props));
  await dom.render(createElement(HistoryFileComparison, { ...props, workFolderId: "folder-b", path: "second.txt" }));
  await dom.act(async () => pending[1]!(Response.json({ comparison: comparison("second.txt") })));
  await dom.act(async () => { const old = comparison(); old.diff.text = "STALE SECRET"; pending[0]!(Response.json({ comparison: old })); });
  assert.doesNotMatch(dom.container.textContent!, /STALE SECRET/); assert.match(dom.container.textContent!, /second.txt/);
  await dom.act(() => dom.container.querySelector("button")!.click());
  await dom.render(null);
  await dom.act(async () => pending[2]!(Response.json({ comparison: comparison("second.txt") })));
  assert.equal(dom.container.textContent, "");
});

test("mismatched History responses are refused and the version modal compares without a restore", async (t) => {
  const dom = await createDomHarness(); const originalFetch = globalThis.fetch;
  t.after(async () => { await dom.cleanup(); globalThis.fetch = originalFetch; });
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method, "GET"); const url = String(input); calls.push(url);
    if (url.includes("file-versions")) return Response.json({ versions: [{ path: props.path, hashSha256: "a".repeat(64), sizeBytes: 7, modifiedAt: "2026-09-27T00:00:00Z", capturedAt: "2026-09-27T00:00:00Z", checkpointId: props.fromCheckpointId, source: "checkpoint" }] });
    return Response.json({ comparison: comparison("wrong.txt") });
  }) as typeof fetch;
  await dom.render(createElement(FileVersionHistoryModal, { workFolder: { id: props.workFolderId, name: "Notes" } as WorkFolderSummary, filePath: props.path, fileName: props.path, onClose() {}, onRestored() { assert.fail("Comparing cannot restore"); } }));
  const button = [...dom.container.querySelectorAll("button")].find((item) => item.textContent === "Compare")!;
  assert.ok(button); await dom.act(() => button.click());
  assert.match(dom.container.querySelector('[role="alert"]')!.textContent!, /does not match/);
  assert.equal(calls.filter((url) => url.includes("history/diff")).length, 1);
  assert.doesNotMatch(dom.container.textContent!, /-Before/);
});
