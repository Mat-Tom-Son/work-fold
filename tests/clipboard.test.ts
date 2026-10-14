import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { copyToClipboard } from "../web-local/src/lib/clipboard.js";
import { writeDesktopClipboard } from "../desktop/src/clipboard.js";

function globals(t: TestContext, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
}

test("desktop copies both formats without accessing the focus-sensitive browser clipboard", async (t) => {
  const writes: unknown[] = [];
  globals(t, {
    window: { workFoldDesktop: { clipboard: { write: async (value: unknown) => { writes.push(value); } } } },
    navigator: { get clipboard() { throw new Error("Document is not focused"); } },
  });
  const content = { text: "Progress.\n\nFinal — 你好 🌍", html: "<p>Progress.</p><p>Final — 你好 🌍</p>" };
  await copyToClipboard(content);
  await copyToClipboard({ text: "/Folder with spaces/file.txt" });
  assert.deepEqual(writes, [content, { text: "/Folder with spaces/file.txt" }]);
});

test("inspector uses its narrow native writer and native failures never fall back or report success", async (t) => {
  const failure = new Error("Native write failed");
  globals(t, {
    window: { workFoldDiagnostics: { clipboard: { write: async () => { throw failure; } } } },
    navigator: { get clipboard() { assert.fail("Must not turn a native failure into a second clipboard operation"); } },
  });
  await assert.rejects(copyToClipboard({ text: "diagnostic" }), (error) => error === failure);
});

test("browser retains formatted copy and falls back to exact plain text when rich writes are rejected", async (t) => {
  const writes: unknown[] = [];
  let rejectRich = false;
  globals(t, {
    window: {},
    ClipboardItem: class { constructor(readonly data: Record<string, Blob>) {} },
    navigator: { clipboard: {
      write: async (items: Array<{ data: Record<string, Blob> }>) => {
        if (rejectRich) throw new Error("Rich format unavailable");
        writes.push(await items[0]!.data["text/html"]!.text());
        writes.push(await items[0]!.data["text/plain"]!.text());
      },
      writeText: async (text: string) => { writes.push(text); },
    } },
  });
  const content = { text: "**Hello**\n\n🌍", html: "<strong>Hello</strong><p>🌍</p>" };
  await copyToClipboard(content);
  rejectRich = true;
  await copyToClipboard(content);
  assert.deepEqual(writes, [content.html, content.text, content.text]);
});

test("browser denial or a missing clipboard rejects instead of claiming Copied", async (t) => {
  const navigatorValue = { clipboard: { writeText: async () => { throw new Error("Document is not focused"); } } };
  globals(t, { window: {}, navigator: navigatorValue });
  await assert.rejects(copyToClipboard({ text: "a" }), /Document is not focused/);
  Reflect.deleteProperty(navigatorValue, "clipboard");
  await assert.rejects(copyToClipboard({ text: "a" }), /Clipboard access is unavailable/);
});

test("native clipboard validates before writing and preserves exact text without coercing other formats", () => {
  const writes: unknown[] = [];
  const write = (value: unknown) => { writes.push(value); };
  for (const input of [null, [], "text", {}, { text: 2 }, { text: "a", html: null }, { text: "a", image: "file:///secret" }]) {
    assert.throws(() => writeDesktopClipboard(input, write), /Invalid clipboard content/);
  }
  assert.deepEqual(writes, []);
  writeDesktopClipboard({ text: "  a\r\n🌍  ", html: "<p>a 🌍</p>" }, write);
  writeDesktopClipboard({ text: "" }, write);
  assert.deepEqual(writes, [{ text: "  a\r\n🌍  ", html: "<p>a 🌍</p>" }, { text: "" }]);
});
