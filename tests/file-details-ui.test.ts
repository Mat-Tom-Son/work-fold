import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import type { ClipboardContent } from "../src/shared/clipboard.js";
import type { TreeEntry, WorkFolderSummary } from "../web-local/src/types.js";
import { createDomHarness } from "./support/dom.js";

type Preview = { kind: "text"; content: string; truncated?: boolean; sizeBytes: number };

async function fileHarness(t: TestContext, initialPath = "notes.txt", initialContent = "Preview text") {
  const dom = await createDomHarness();
  const realApi = await import("../web-local/src/lib/api.js");
  let preview: Preview = { kind: "text", content: initialContent, sizeBytes: initialContent.length };
  let rawText = initialContent;
  let rawRead: ((signal?: AbortSignal) => Promise<string>) | undefined;
  const copied: ClipboardContent[] = [];
  const reads: string[] = [];
  const api = async (path: string) => {
    if (path.includes("/file-info?")) return { name: new URL(path, "http://localhost").searchParams.get("path"), modifiedAt: new Date(1_700_000_000_000 + preview.sizeBytes).toISOString(), sizeBytes: preview.sizeBytes };
    if (path.includes("/file-preview?")) return { preview: { ...preview } };
    if (path === "/api/settings/publications") return { publications: [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.__fileDetailsApi = { ...realApi, api };
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "@fluentui/react-icons") return { url: "test:file-details-icons", shortCircuit: true };
      const result = next(specifier, context);
      return result.url.endsWith("/web-local/src/lib/api.ts") ? { url: "test:file-details-api", shortCircuit: true } : result;
    },
    load(url, context, next) {
      if (url === "test:file-details-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (url === "test:file-details-api") return { format: "module", source: Object.keys(realApi).map((name) => `export const ${name}=${name === "api" ? "(...args)=>globalThis.__fileDetailsApi.api(...args)" : `globalThis.__fileDetailsApi.${name}`};`).join("\n"), shortCircuit: true };
      if (/\.(?:png|svg)(?:\?|$)/u.test(url)) return { format: "module", source: `export default ${JSON.stringify(url)};`, shortCircuit: true };
      return next(url, context);
    },
  });
  window.workFoldDesktop = {
    api: { async getSessionHeaders() { return {}; } },
    clipboard: { async write(content: ClipboardContent) { copied.push(content); } },
  } as typeof window.workFoldDesktop;
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    reads.push(String(url));
    return new Response(rawRead ? await rawRead(options?.signal ?? undefined) : rawText);
  });
  t.after(async () => { await dom.cleanup(); hook.deregister(); delete scope.__fileDetailsApi; });
  const { FileDetailsPane } = await import("../web-local/src/components/panes/FileDetailsPane.js");
  const render = async (path = initialPath, active = true) => {
    await dom.render(createElement(FileDetailsPane, {
      workFolder: { id: "folder", workFolderRoot: "/folder" } as WorkFolderSummary,
      path, active, entry: { name: path, path, kind: "file", updatedAt: new Date(1_700_000_000_000 + preview.sizeBytes).toISOString() } as TreeEntry,
      onOpenLocal() {}, onAddToChatContext() {}, onShowVersionHistory() {},
    }));
    await dom.waitFor(() => !!dom.container.querySelector('[aria-label="Copy contents"]'));
  };
  await render();
  const copy = async () => { await dom.act(async () => { dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy contents"]')!.click(); }); };
  return { dom, copied, reads, render, copy,
    setRawText(value: string) { rawText = value; },
    setRawRead(value: typeof rawRead) { rawRead = value; },
    setPreview(value: Preview) { preview = value; },
  };
}

test("Copy reads the current file even when a short preview is still showing older bytes", async (t) => {
  const h = await fileHarness(t);
  h.setRawText("Edited after preview");
  await h.copy();
  await h.dom.waitFor(() => h.copied.length === 1);
  assert.deepEqual(h.copied, [{ text: "Edited after preview" }]);
  assert.equal(h.reads.length, 1);
});

test("Copy preserves all Markdown beyond the preview and supplies rich text to the native clipboard", async (t) => {
  const h = await fileHarness(t, "notes.md", "# Preview");
  const full = "# Current\n\n" + "Paragraph\n\n".repeat(30_000) + "**The end**";
  h.setPreview({ kind: "text", content: "# Preview", truncated: true, sizeBytes: full.length });
  h.setRawText(full);
  await h.render();
  await h.copy();
  await h.dom.waitFor(() => h.copied.length === 1);
  assert.equal(h.copied[0]!.text, full);
  assert.match(h.copied[0]!.html!, /<h1>Current<\/h1>/);
  assert.match(h.copied[0]!.html!, /<strong>The end<\/strong>/);
});

test("Copy remains available for an empty text file", async (t) => {
  const h = await fileHarness(t, "empty.txt", "");
  await h.copy();
  await h.dom.waitFor(() => h.copied.length === 1);
  assert.deepEqual(h.copied, [{ text: "" }]);
});

test("changing files cancels an unfinished Copy before it writes to the clipboard", async (t) => {
  const h = await fileHarness(t);
  h.setPreview({ kind: "text", content: "Preview", truncated: true, sizeBytes: 300_000 });
  await h.render();
  let release!: (text: string) => void;
  h.setRawRead(() => new Promise<string>((resolve) => { release = resolve; }));
  await h.copy();
  assert.equal(h.reads.length, 1);
  await h.render("other.txt");
  await h.dom.act(async () => { release("Old file bytes"); });
  assert.deepEqual(h.copied, [], "a completed read from the previous file cannot overwrite the clipboard");
  assert.ok(h.dom.container.querySelector('[aria-label="Copy contents"]'), "the new file must not claim it was copied");
});

test("switching tabs cancels Copy even though the old file tab stays mounted", async (t) => {
  const h = await fileHarness(t);
  let release!: (text: string) => void;
  h.setRawRead(() => new Promise<string>((resolve) => { release = resolve; }));
  await h.copy();
  assert.equal(h.reads.length, 1);
  await h.render("notes.txt", false);
  await h.dom.act(async () => { release("Inactive file bytes"); });
  assert.deepEqual(h.copied, [], "the inactive tab cannot overwrite a later Copy in another tab");
  assert.equal(h.dom.container.querySelector(".file-details-copy")!.getAttribute("aria-busy"), "false");
});
