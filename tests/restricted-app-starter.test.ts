import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

import { inspectRestrictedAppPackage } from "../src/local/agent/restricted-app-package.js";
import { restrictedAppStarterFiles, writeRestrictedAppStarter } from "../src/local/agent/restricted-app-starter.js";
import { createRestrictedAppStarterTool } from "../src/local/agent/pi-client.js";

const input = { id: "reading-list", title: "Reading \"list\" </script>", description: "Keeps what to read next.", icon: "notebook" };

test("the starter is a valid package that work-fold accepts as written", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-starter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = await writeRestrictedAppStarter(root, "apps/reading-list", restrictedAppStarterFiles(input));
  assert.equal(folder, "apps/reading-list");
  const inspection = await inspectRestrictedAppPackage(join(root, folder));
  assert.equal(inspection.manifest.id, "reading-list");
  assert.equal(inspection.manifest.title, input.title);
  assert.equal(inspection.manifest.ui.icon, "notebook");
  const html = await readFile(join(root, folder, "index.html"), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\/__work-fold\/kit\.css">/);
  assert.match(html, /<body class="wf-app">/);
  assert.match(html, /<title>Reading &quot;list&quot; &lt;\/script&gt;<\/title>/, "the title is escaped in HTML");
  assert.doesNotMatch(html, /<script>|onclick=/i, "no inline script, which the view's policy blocks");
});

test("the starter's code runs: a left-pane home, one tab per row click, and the rail dot cleared", async () => {
  const files = restrictedAppStarterFiles(input);
  const dom = new JSDOM(files["index.html"]!.replace(/<script[^>]*><\/script>/, ""));
  const saved = new Map<string, unknown>();
  const tabs: unknown[] = [];
  let attentionCleared = 0;
  const context = { placement: "navigator", route: "/", state: null, theme: "dark", active: true };
  const bridge = {
    context: { get: () => context, onChanged: () => () => undefined },
    storage: {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: unknown) => { saved.set(key, value); },
      onChanged: () => () => undefined,
    },
    tabs: { open: async (tab: unknown) => { tabs.push(tab); } },
    attention: { clear: async () => { attentionCleared += 1; } },
  };
  const scope = { document: dom.window.document, crypto: globalThis.crypto, globalThis: { workFoldRestrictedApp: bridge } };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("document", "crypto", "globalThis", files["app.js"]!)(scope.document, scope.crypto, scope.globalThis);
  const app = dom.window.document.querySelector("#app")!;
  assert.equal(dom.window.document.documentElement.dataset.theme, "dark");
  assert.equal(app.querySelector(".wf-title")?.textContent, input.title, "the title is a JavaScript string, never code");
  assert.ok(app.querySelector(".wf-empty"));
  assert.equal(attentionCleared, 1);

  const field = app.querySelector<HTMLInputElement>(".wf-input")!;
  field.value = "Middlemarch";
  app.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = app.querySelector<HTMLButtonElement>(".wf-row");
  assert.equal(row?.querySelector(".wf-row-title")?.textContent, "Middlemarch");
  row!.click();
  assert.equal(tabs.length, 1);
  assert.match(JSON.stringify(tabs[0]), /"title":"Middlemarch","route":"\/items\//);
});

test("the starter never writes over files or outside the work-folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-starter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = restrictedAppStarterFiles(input);
  await mkdir(join(root, "taken"));
  await writeFile(join(root, "taken", "notes.md"), "mine");
  await assert.rejects(writeRestrictedAppStarter(root, "taken", files), /already has files/);
  assert.equal(await readFile(join(root, "taken", "notes.md"), "utf8"), "mine");
  await assert.rejects(writeRestrictedAppStarter(root, "../outside", files), /relative folder inside/);
  await assert.rejects(writeRestrictedAppStarter(root, "/tmp/abs", files), /relative folder inside/);
  await assert.rejects(writeRestrictedAppStarter(root, ".work-fold/app", files), /hidden folders/);
  assert.throws(() => restrictedAppStarterFiles({ ...input, id: "Bad Id" }), /app id/);
  assert.throws(() => restrictedAppStarterFiles({ ...input, title: "two\nlines" }), /one line/);
});

test("the Worker gets the starter tool, and it reports where the package is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-starter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = createRestrictedAppStarterTool({ workFolderRoot: root });
  assert.equal(tool.name, "start_work-folder_app");
  const result = await tool.execute("call-1", { folder: "apps/reads", ...input }, undefined, undefined, {} as never);
  const text = result.content.find((item: { type: string }) => item.type === "text") as { text: string };
  assert.match(text.text, /Wrote a starter app in apps\/reads/);
  assert.match(text.text, /propose_work-folder_app with sourcePath apps\/reads/);
});
