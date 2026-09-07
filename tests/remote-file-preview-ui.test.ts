import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createFilePreview, filePreviewMarkup } from "../services/bridge/public/file-preview.js";
import { requestResultLinks } from "../services/bridge/public/request-results.js";

test("web previews escape file content and accept only bounded inert image types", () => {
  const text = filePreviewMarkup({ kind: "text", text: '<script>steal()</script><img src="https://track.example/x">', format: "text" });
  assert.ok(!text.includes("<script>"));
  assert.ok(!text.includes("<img"));
  const md = filePreviewMarkup({ kind: "text", text: '# Result\n\n[x](javascript:alert(1))\n<script>bad()</script>\n![tracking](https://track.example/x)', format: "markdown", truncated: true });
  assert.ok(md.includes("<h1>Result</h1>"));
  assert.ok(!md.includes('href="javascript:'));
  assert.ok(!md.includes("<script>"));
  assert.ok(!md.includes("<img"));
  assert.match(md, /first 256 KiB/);
  assert.throws(() => filePreviewMarkup({ kind: "image", mediaType: "image/svg+xml", base64: "PHN2Zz4=", path: "bad.svg" }));
  assert.throws(() => filePreviewMarkup({ kind: "image", mediaType: 'image/png" onerror="bad', base64: "AAAA", path: "bad.png" }));
  assert.throws(() => filePreviewMarkup({ kind: "image", mediaType: "image/png", base64: '" onerror="bad', path: "bad.png" }));
  assert.ok(filePreviewMarkup({ kind: "image", mediaType: "image/png", base64: Buffer.alloc(1024 * 1024).toString("base64"), path: "full.png" }).includes("data:image/png"));
  assert.throws(() => filePreviewMarkup({ kind: "text", text: "x".repeat(262145) }));
});

test("preview switching, offline recovery and closing cannot display stale asynchronous results", async () => {
  const dom = new JSDOM('<!doctype html><button id="open">Open file</button>');
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let connected = true;
  const waiting: Array<(value: unknown) => void> = [];
  const controller = createFilePreview({ available: () => true, online: () => connected, fetchPreview: () => new Promise((resolve) => waiting.push(resolve)) });
  const result = (path: string, text: string) => ({ spaceId: "space", path, kind: "text", format: "text", text });
  try {
    document.getElementById("open")!.focus();
    const first = controller.open({ spaceId: "space", path: "first.txt", spaceName: "Quotes" });
    const second = controller.open({ spaceId: "space", path: "second.txt", spaceName: "Quotes" });
    waiting[1]!(result("second.txt", "Current result")); await second;
    waiting[0]!(result("first.txt", "Stale result")); await first;
    assert.match(document.body.textContent!, /Current result/);
    assert.ok(!document.body.textContent!.includes("Stale result"));
    connected = false; controller.connectionChanged(false);
    assert.ok(!document.body.textContent!.includes("Current result"));
    assert.match(document.body.textContent!, /Desktop offline/);
    connected = true; controller.connectionChanged(true);
    assert.match(document.body.textContent!, /Refresh/);
    assert.equal(waiting.length, 2, "reconnect does not silently read again");
    const late = controller.open({ spaceId: "space", path: "late.txt", spaceName: "Quotes" });
    document.querySelector<HTMLButtonElement>(".file-preview-close")!.click();
    waiting[2]!(result("late.txt", "Late data")); await late;
    assert.ok(!document.body.textContent!.includes("Late data"));
    assert.equal(document.activeElement?.id, "open");
  } finally {
    controller.destroy(); dom.window.close();
    if (originalDocument === undefined) delete (globalThis as any).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
  }
});

test("unavailable capabilities, wrong-file responses and read failures stay honest", async () => {
  const dom = new JSDOM("<!doctype html>");
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let supported = false;
  let calls = 0;
  const controller = createFilePreview({ available: () => supported, online: () => true, fetchPreview: async () => {
    calls++;
    if (calls === 2) throw new Error("The selected file changed.");
    return { spaceId: "other-space", path: "result.md", kind: "text", text: "Wrong Space contents" };
  } });
  const target = { spaceId: "space", path: "result.md", spaceName: "Quotes" };
  try {
    await controller.open(target);
    assert.match(document.body.textContent!, /Update work-fold/);
    assert.equal(calls, 0, "older desktops never receive an unsupported operation");
    supported = true;
    await controller.open(target);
    assert.match(document.body.textContent!, /does not match/);
    assert.ok(!document.body.textContent!.includes("Wrong Space contents"));
    await controller.open(target);
    assert.match(document.body.textContent!, /selected file changed/);
    assert.equal(document.querySelector<HTMLButtonElement>("[data-refresh]")!.disabled, false);
  } finally {
    controller.destroy(); dom.window.close();
    if (originalDocument === undefined) delete (globalThis as any).document;
    else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: originalDocument });
  }
});

test("deliverable and review links use bounded host receipts with exact Space identities", () => {
  const links = requestResultLinks({ content: "Open /etc/passwd", dispositions: [
    { spaceId: "one", spaceName: "One", copied: ["reports/brief.md", "../secret", ".pi/auth.json"] },
    { status: "library", copied: ["library-only.md"] },
  ], actions: [{ spaceId: "one", copied: ["reports/brief.md"] }, { spaceId: "two", copied: ["reports/brief.md"] }, { decisionId: "review-one" }] });
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((item: any) => item.kind), ["file", "file", "decision"]);
  assert.equal(links[0].spaceId, "one");
  assert.equal(links[1].spaceId, "two");
  assert.equal(requestResultLinks({ actions: Array.from({ length: 100 }, (_, index) => ({ spaceId: "one", copied: [`file-${index}.txt`] })) }).length, 12);
});

test("task file and app links retain exact host identities and ignore active or invented targets", () => {
  const app = { spaceId: "target", appId: "quotes", featureInstallationId: "installation-one", digest: "a".repeat(64), title: "Quote board", version: "1.0.0" };
  const links = requestResultLinks({ reply: { content: "Open imaginary.md" }, actions: [{ spaceId: "source", decisionId: "consumed-review", apps: [app, { ...app, featureInstallationId: "../bad" }, { ...app, digest: "bad" }] }],
    children: [{ spaceId: "target", state: "succeeded", files: ["comparison.md", ".pi/auth"] }, { spaceId: "other", state: "running", files: ["unfinished.md"] }] });
  assert.deepEqual(links.map((item: any) => item.kind), ["app", "file"]);
  assert.equal(links[0].spaceId, "target", "an installation result points at its target Space, not the source operation's Space");
  assert.equal(links[0].featureInstallationId, "installation-one");
  assert.equal(links[1].path, "comparison.md");
});
