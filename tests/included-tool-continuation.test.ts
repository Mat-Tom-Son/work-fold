import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const { resolveMcpResultContent } = await createJiti(import.meta.url, { moduleCache: true, fsCache: false }).import<any>(fileURLToPath(new URL("../node_modules/pi-mcp-adapter/tool-registrar.ts", import.meta.url)));

test("MCP preserves structured cursors without duplicating an equivalent JSON content block", () => {
  const structured = { records: [{ id: 1 }], nextCursor: "next-page" };
  const summary = { type: "text", text: "Fetched one record." };
  const result = resolveMcpResultContent({ content: [summary], structuredContent: structured });
  assert.equal(result.length, 2);
  assert.deepEqual(JSON.parse((result[1] as { text: string }).text), structured);
  const duplicate = resolveMcpResultContent({ content: [{ type: "text", text: '{"nextCursor":"next-page","records":[{"id":1}]}' }], structuredContent: structured });
  assert.equal(duplicate.length, 1);
  assert.deepEqual(resolveMcpResultContent({ content: [], structuredContent: structured }), [{ type: "text", text: JSON.stringify(structured, null, 2) }]);
});

test("native Chrome injected snapshots continue exact body text and reject changed source", async () => {
  const script = await readFile(new URL("../node_modules/pi-chrome/extensions/chrome-profile-bridge/browser-extension/snapshot_injected.js", import.meta.url), "utf8");
  const dom = new JSDOM("<!doctype html><html><head><title>Ranges</title></head><body><p></p></body></html>", { url: "http://fixture.invalid/ranges", runScripts: "outside-only" });
  try {
    const win = dom.window as any;
    Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent ?? ""; } });
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 30, width: 900, height: 30 });
    win.document.elementFromPoint = () => null;
    win.TextEncoder = TextEncoder;
    const body = "First paragraph. ".repeat(3000) + "😀TAIL_MARKER";
    win.document.querySelector("p").textContent = body;
    win.eval(script);
    const capture = (offset: number, version?: string, limit = 10000) => win.__piChromeSnapshotPage(80, null, null, null, "text", null, limit, offset, version);
    let page = await capture(0);
    assert.equal(page.text.length, 10000);
    assert.equal(page.textRange.total, body.length);
    assert.match(page.textRange.version, /^text:[a-f0-9]{32}$/);
    const version = page.textRange.version;
    let combined = page.text;
    while (page.textRange.end < page.textRange.total) {
      const previousEnd = page.textRange.end;
      page = await capture(previousEnd, version);
      assert.equal(page.textRange.start, previousEnd);
      assert.ok(page.textRange.end > previousEnd);
      combined += page.text;
    }
    assert.equal(combined, body);
    assert.equal(page.textTruncated, true, "a later range remains a partial view of the body");
    const emoji = await capture(body.indexOf("😀"), version, 1);
    assert.equal(emoji.text, "😀");
    assert.equal(emoji.textRange.end, body.indexOf("😀") + 2, "minimum limit must still make progress");
    dom.reconfigure({ url: "http://fixture.invalid/other-page" });
    await assert.rejects(capture(10000, version), /page text or URL changed/);
    dom.reconfigure({ url: "http://fixture.invalid/ranges" });
    const freshVersion = (await capture(0)).textRange.version;
    win.document.querySelector("p").textContent += " changed";
    await assert.rejects(capture(10000, freshVersion), /page text or URL changed/);
  } finally { dom.window.close(); }
});
