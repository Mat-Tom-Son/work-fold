import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  accentIdentityFromHex,
  createWorkFolderAppearanceProposal,
  parseWorkFolderAppearanceProposal,
  resolveWorkFolderAppearance,
} from "../src/shared/work-folder-appearance.js";
import { WorkFolderAppearanceStore } from "../src/local/work-folder-appearance-store.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import { defaultWorkFolderBannerName } from "../web-local/src/constants.js";
import {
  normalizeWorkFolderBannerImage,
  normalizeWorkFolderBannerImagePosition,
  normalizeWorkFolderCustomizations,
  workFolderBannerOptionFor,
} from "../web-local/src/lib/work-folder-customization.js";
import { writeStoredJsonValue } from "../web-local/src/lib/storage.js";
import { readableTextColorOn } from "../web-local/src/lib/color-contrast.js";
import type { WorkFolderSummary } from "../web-local/src/types.js";

const workFolder: WorkFolderSummary = {
  id: "work-folder-home",
  name: "Home projects",
  workFolderRoot: "C:\\Users\\you\\Documents\\Home projects",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

test("work-folder banners keep Classic as the explicit default while supporting None", () => {
  assert.equal(defaultWorkFolderBannerName, "classic");
  assert.equal(workFolderBannerOptionFor(undefined).name, "classic");
  assert.equal(workFolderBannerOptionFor("none").name, "none");
  assert.equal(workFolderBannerOptionFor("unknown").name, "classic");
});

test("work-folder customization normalization accepts only supported fields", () => {
  const raster = "data:image/png;base64,AA==";
  const normalized = normalizeWorkFolderCustomizations({
    [workFolder.id]: {
      color: "#0D74CE",
      color2: "#5C7C2E",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
      ignored: "value",
    },
    removed: { color: "#ffffff" },
  }, new Set([workFolder.id]), new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {
    [workFolder.id]: {
      schema: 1,
      color: "#0d74ce",
      color2: "#5c7c2e",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
    },
  });
});

test("work-folder customization normalization rejects unsafe images and invalid values", () => {
  const normalized = normalizeWorkFolderCustomizations({
    [workFolder.id]: {
      color: "blue",
      color2: "#12345g",
      iconName: "not-a-real-icon",
      bannerName: "not-a-banner",
      bannerImage: "data:image/svg+xml;base64,PHN2Zy8+",
      bannerImagePosition: "left",
    },
  }, undefined, new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {});
  assert.equal(normalizeWorkFolderBannerImage("https://example.com/banner.png"), null);
  assert.equal(normalizeWorkFolderBannerImage("data:image/svg+xml;base64,PHN2Zy8+"), null);
  assert.equal(normalizeWorkFolderBannerImagePosition("left"), "center");
});

test("preference storage reports quota failures instead of silently claiming durability", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => { throw new Error("quota"); }, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("work-fold.appearance.test", { color: "#0d74ce" }), false);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => {}, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("work-fold.appearance.test", { color: "#0d74ce" }), true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("work-folder identity chooses user-message text from the primary message background", () => {
  assert.equal(readableTextColorOn("#c5c5c4"), "#182846");
  assert.equal(readableTextColorOn("#0d74ce"), "#ffffff");
});

test("semantic work-folder palettes preserve v1 light solids and pass both contrast gates", () => {
  const colors = [
    "#60646c", "#ce2c31", "#cc4e00", "#ab6400", "#5c7c2e", "#1a7f37",
    "#0e7490", "#0d74ce", "#6550b9", "#953ea3", "#c2298a", "#815e46",
  ];
  for (const color of colors) {
    const first = resolveWorkFolderAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
    const second = resolveWorkFolderAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
    assert.equal(first.light.solid, color, `light solid must preserve ${color}`);
    assert.equal(first.passes, true, `${color} must pass both modes`);
    assert.deepEqual(first, second, "resolution must be deterministic");
    for (const palette of [first.light, first.dark]) {
      assert.deepEqual(palette.audit.filter((entry) => !entry.passes), []);
      assert.equal(palette.audit.find((entry) => entry.role === "textBody")!.wcag >= 4.5, true);
      assert.equal(palette.audit.find((entry) => entry.role === "textBody")!.apca >= 75, true);
      assert.equal(palette.audit.find((entry) => entry.role === "glyph")!.wcag >= 3, true);
    }
  }
});

test("guided palettes resolve extreme and arbitrary user colors in both modes", () => {
  const colors = [
    "#000000", "#ffffff", "#ffffee", "#010001", "#ff00ff", "#00ffff",
    "#7f7f7f", "#123456", "#fedcba", "#80ff00", "#0000ff", "#ff0000",
  ];
  for (const color of colors) {
    const resolved = resolveWorkFolderAppearance({ primary: accentIdentityFromHex(color) });
    assert.equal(resolved.passes, true, `${color} must produce a passing guided palette`);
    for (const palette of [resolved.light, resolved.dark]) {
      assert.equal(palette.audit.find((entry) => entry.role === "onSolidMuted")?.passes, true);
    }
  }
});

test("appearance identities repair forged hue and chroma metadata from reference hex", () => {
  const parsed = parseWorkFolderAppearanceProposal({
    kind: "work-fold.work-folder-appearance",
    version: 1,
    name: "Forged metadata",
    customization: {
      schema: 2,
      primary: { schema: 2, hue: 140, chroma: 0.4, referenceHex: "#ffffff" },
    },
  });
  assert.deepEqual(parsed.customization.primary, accentIdentityFromHex("#ffffff"));
  assert.equal(resolveWorkFolderAppearance({ primary: parsed.customization.primary! }).passes, true);
});

test("appearance proposals are typed, code-free, and ignore unknown fields", () => {
  const proposal = createWorkFolderAppearanceProposal({
    name: "Project blue",
    customization: {
      schema: 2,
      primary: accentIdentityFromHex("#0d74ce"),
      iconName: "folder",
      bannerName: "classic",
      ...({ css: "body { display: none }", javascript: "alert(1)" } as Record<string, unknown>),
    },
    createdBy: "codex",
  });
  const parsed = parseWorkFolderAppearanceProposal(JSON.parse(JSON.stringify(proposal)));
  assert.equal(parsed.kind, "work-fold.work-folder-appearance");
  assert.equal(parsed.customization.primary?.referenceHex, "#0d74ce");
  assert.equal("css" in parsed.customization, false);
  assert.equal("javascript" in parsed.customization, false);
});

test("legacy Workspace appearance kinds and target fields are rejected", () => {
  const customization = { schema: 2 as const, primary: accentIdentityFromHex("#0d74ce") };
  assert.throws(() => parseWorkFolderAppearanceProposal({
    kind: "workspace.work-folder-appearance",
    version: 1,
    name: "Legacy kind",
    customization,
  }), /unsupported format/);
  assert.throws(() => parseWorkFolderAppearanceProposal({
    kind: "work-fold.work-folder-appearance",
    version: 1,
    name: "Legacy target",
    target: { workspaceId: "work-folder-home", workspaceName: "Home projects" },
    customization,
  }), /Legacy appearance target fields/);
});

test("appearance store writes versioned machine-local state atomically", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await WorkFolderAppearanceStore.create({ path });
  const updated = await store.replaceWorkFolder("work-folder-home", {
    schema: 2,
    primary: accentIdentityFromHex("#6550b9"),
    iconName: "folder",
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.customizations["work-folder-home"]?.primary?.referenceHex, "#6550b9");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), updated);
  const reopened = await WorkFolderAppearanceStore.create({ path });
  assert.deepEqual(reopened.snapshot(), updated);
});

test("appearance store recovers its last committed backup and rejects future formats", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-recovery-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await WorkFolderAppearanceStore.create({ path });
  const first = await store.replaceWorkFolder("work-folder-home", { color: "#0d74ce" });
  await store.replaceWorkFolder("work-folder-home", { color: "#6550b9" });
  await writeFile(path, "{not-json", "utf8");
  const recovered = await WorkFolderAppearanceStore.create({ path });
  assert.deepEqual(recovered.snapshot(), first);

  await writeFile(path, JSON.stringify({ version: 99, revision: 3, customizations: {} }), "utf8");
  await assert.rejects(
    () => WorkFolderAppearanceStore.create({ path }),
    /unsupported version 99/i,
  );
});

test("authenticated renderer API owns work-folder appearance persistence and removal", async (t) => {
  const { startLocalApi } = await import("../src/local/server.js");
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-api-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "work-folders"),
    sessionToken: "appearance-test-token",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = {
    "content-type": "application/json",
    "x-work-fold-session": "appearance-test-token",
  };
  const createResponse = await fetch(`${api.origin}/api/work-folders`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Appearance API" }),
  });
  assert.equal(createResponse.status, 201);
  const workFolderId = (await createResponse.json() as { workFolder: { id: string } }).workFolder.id;
  const updateResponse = await fetch(`${api.origin}/api/work-folders/${workFolderId}/appearance`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      customization: {
        schema: 2,
        primary: accentIdentityFromHex("#0d74ce"),
        bannerName: "classic",
      },
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json() as { appearance: { revision: number; customizations: Record<string, { primary?: { referenceHex: string } }> } };
  assert.equal(updated.appearance.revision, 1);
  assert.equal(updated.appearance.customizations[workFolderId]?.primary?.referenceHex, "#0d74ce");

  const bootstrapResponse = await fetch(`${api.origin}/api/bootstrap`, { headers });
  const bootstrap = await bootstrapResponse.json() as { appearance: typeof updated.appearance };
  assert.equal(bootstrap.appearance.customizations[workFolderId]?.primary?.referenceHex, "#0d74ce");

  const removeResponse = await fetch(`${api.origin}/api/work-folders/${workFolderId}/appearance`, { method: "DELETE", headers });
  const removed = await removeResponse.json() as { appearance: { customizations: Record<string, unknown> } };
  assert.equal(workFolderId in removed.appearance.customizations, false);
});
