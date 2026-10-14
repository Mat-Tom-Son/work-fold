import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadExtensionSurfaceManifests,
  parseExtensionSurfaceManifest,
} from "../src/local/agent/surface-manifest.js";
import type { PiCatalogSource, PiExtensionCatalogItem } from "../src/local/agent/skill-catalog.js";

const source: PiCatalogSource = {
  path: "extensions/inbox/index.ts",
  source: "auto",
  scope: "project",
  origin: "top-level",
};

test("Extension surface manifests validate and normalize declarative views", () => {
  const surface = parseExtensionSurfaceManifest({
    version: 1,
    id: "project-inbox",
    title: "Project inbox",
    description: "Messages related to this work-folder.",
    icon: "mail",
    views: [{
      id: "overview",
      title: "Overview",
      blocks: [
        { type: "heading", text: "Inbox", level: 1 },
        { type: "metrics", items: [{ label: "Unread", value: "8", detail: "Two need replies" }] },
        { type: "table", columns: ["From", "Subject"], rows: [["Ava", "Kitchen estimate"]] },
        { type: "callout", tone: "warning", title: "Follow up", text: "The cabinetry quote expires Friday." },
      ],
    }],
  }, {
    extensionPath: "C:\\work-folder\\.pi\\extensions\\inbox\\index.ts",
    manifestPath: "C:\\work-folder\\.pi\\extensions\\inbox\\surface.json",
    source,
  });

  assert.equal(surface.id, "project-inbox");
  assert.equal(surface.views[0]?.blocks.length, 4);
  assert.equal(surface.source.scope, "project");
});

test("Extension surface manifests reject executable markup shapes and invalid bounds", () => {
  assert.throws(() => parseExtensionSurfaceManifest({
    version: 1,
    id: "Inbox App",
    title: "Inbox",
    views: [],
  }, { extensionPath: "index.ts", manifestPath: "surface.json", source }), /lowercase letters/);

  assert.throws(() => parseExtensionSurfaceManifest({
    version: 1,
    id: "inbox",
    title: "Inbox",
    views: [{ id: "main", title: "Main", blocks: [{ type: "html", html: "<script>bad()</script>" }] }],
  }, { extensionPath: "index.ts", manifestPath: "surface.json", source }), /type is unsupported/);
});

test("Surface discovery only reads a regular manifest beside a loaded Extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-surfaces-"));
  try {
    const extensionDir = join(root, "inbox");
    await mkdir(extensionDir, { recursive: true });
    const extensionPath = join(extensionDir, "index.ts");
    await writeFile(extensionPath, "export default function () {}\n", "utf8");
    await writeFile(join(extensionDir, "surface.json"), JSON.stringify({
      version: 1,
      id: "inbox",
      title: "Inbox",
      views: [{ id: "main", title: "Main", blocks: [{ type: "text", text: "Hello" }] }],
    }), "utf8");
    const extension: PiExtensionCatalogItem = {
      path: extensionPath,
      resolvedPath: extensionPath,
      source,
      tools: [],
      commands: [],
      flags: [],
    };

    const result = await loadExtensionSurfaceManifests([extension]);
    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.surfaces[0]?.id, "inbox");
    assert.equal(result.surfaces[0]?.manifestPath, join(extensionDir, "surface.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
