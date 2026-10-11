import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { build } from "esbuild";

import { createDomHarness } from "./support/dom.js";
import type { CapabilitySurface, RestrictedAppInstalled, WorkFolderSummary } from "../web-local/src/types.js";

/**
 * An app's `ui.icon` names an entry in the work-folder icon catalog. A name the
 * catalog does not know keeps the rail's generic Apps glyph; it must not fall
 * through to the catalog's first entry, which is a folder and would make an app
 * look like a work-folder. Work-folder icons keep their own folder fallback.
 */
test("an app rail button with an unknown icon name shows the generic Apps glyph", async (t) => {
  const compiled = await mkdtemp(resolve("node_modules/.app-rail-icons-test-"));
  t.after(() => rm(compiled, { recursive: true, force: true }));
  const entry = join(compiled, "entry.ts");
  const outfile = join(compiled, "component.mjs");
  await writeFile(entry, [
    `export { WorkFolderModeRail } from ${JSON.stringify(resolve("web-local/src/components/panes/workFolderChrome.tsx"))};`,
    `export { knownWorkFolderIconOption, workFolderIconOptionFor, workFolderIconOptions } from ${JSON.stringify(resolve("web-local/src/work-folder-icons.ts"))};`,
  ].join("\n"));
  // Every Fluent icon becomes a marker naming itself, so the rendered rail says
  // which glyph each button chose; `bundleIcon` keeps the filled half.
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const iconStub = [
    `import { createElement } from "react";`,
    ...iconNames.map((name) => name === "bundleIcon"
      ? "export const bundleIcon = (filled) => filled;"
      : `export const ${name} = (props) => createElement("i", { "data-icon": ${JSON.stringify(name)}, className: props?.className });`),
  ].join("\n");
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic",
    loader: { ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".css": "empty" },
    plugins: [{ name: "icon-markers", setup(builder) {
      builder.onResolve({ filter: /^@fluentui\/react-icons$/ }, () => ({ path: "icons", namespace: "icon-markers" }));
      builder.onLoad({ filter: /.*/, namespace: "icon-markers" }, () => ({ contents: iconStub, loader: "js", resolveDir: resolve(".") }));
    } }],
    logLevel: "silent",
  });
  const module = await import(pathToFileURL(outfile).href) as {
    WorkFolderModeRail: typeof import("../web-local/src/components/panes/workFolderChrome.js").WorkFolderModeRail;
    knownWorkFolderIconOption: typeof import("../web-local/src/work-folder-icons.js").knownWorkFolderIconOption;
    workFolderIconOptionFor: typeof import("../web-local/src/work-folder-icons.js").workFolderIconOptionFor;
    workFolderIconOptions: typeof import("../web-local/src/work-folder-icons.js").workFolderIconOptions;
  };

  // The lookup itself: known names and aliases resolve, anything else is null,
  // and the work-folder lookup still falls back to its first (folder) entry.
  assert.equal(module.knownWorkFolderIconOption("mail")?.name, "mail");
  assert.equal(module.knownWorkFolderIconOption("  MAIL ")?.name, "mail");
  assert.equal(module.knownWorkFolderIconOption("archive-restore")?.name, "archive", "an alias is a known name");
  for (const guess of ["images", "photos", "screenshots"]) {
    assert.equal(module.knownWorkFolderIconOption(guess)?.name, "image", `a Worker's natural guess "${guess}" finds the image icon`);
  }
  assert.equal(module.knownWorkFolderIconOption("definitely-not-an-icon"), null);
  assert.equal(module.knownWorkFolderIconOption(undefined), null);
  assert.equal(module.knownWorkFolderIconOption(""), null);
  assert.equal(module.workFolderIconOptionFor("definitely-not-an-icon"), module.workFolderIconOptions[0]);
  assert.equal(module.workFolderIconOptions[0]!.name, "folder");

  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const workFolder = { id: "work-folder-one", name: "Quotes", workFolderRoot: "/synthetic/quotes" } as WorkFolderSummary;
  const app = (id: string, icon: string | undefined) => ({
    workFolderId: workFolder.id, sourceWorkFolderId: workFolder.id, featureInstallationId: `feature-installation_${id}`, runtimeInstanceKind: "development",
    runtimeInstanceId: `runtime-instance_${id}`, packageName: id, version: "1.0.0", digest: "a".repeat(64),
    installedAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", networkGrants: [], fileGrants: [], notificationGrants: [], automations: [],
    manifest: { id, title: id, version: 2, runtime: { kind: "sandboxed-web", entry: "index.html" }, ui: icon === undefined ? {} : { icon }, tools: [], automations: [],
      permissions: { network: [], files: [], notifications: [] } },
  }) as unknown as RestrictedAppInstalled;
  await dom.render(createElement(module.WorkFolderModeRail, {
    activeMode: "files",
    workFolder,
    surfaces: [{ key: "notes", title: "Surface", icon: "not-a-catalog-icon" } as unknown as CapabilitySurface],
    apps: [app("mailbox", "mail"), app("mystery", "not-a-catalog-icon"), app("plain", undefined)],
    onModeChange() {},
    onOpenSkillsExtensions() {},
    accountControl: null,
  }));
  const glyphs = (label: string) => [...(dom.container.querySelector(`button[aria-label="${label}"]`)?.querySelectorAll("[data-icon]") ?? [])]
    .map((element) => element.getAttribute("data-icon"));
  assert.deepEqual(glyphs("mailbox"), ["Mail20Filled"], "a catalog icon name is used");
  assert.deepEqual(glyphs("mystery"), ["Apps24Regular"], "an unknown icon name keeps the generic Apps glyph, not a folder");
  assert.deepEqual(glyphs("plain"), ["Apps24Regular"], "no icon name keeps the generic Apps glyph");
  assert.deepEqual(glyphs("Surface"), ["Apps24Regular"], "a contributed surface follows the same rule");
});
