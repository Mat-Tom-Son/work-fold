import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  accentIdentityFromHex,
  createSpaceAppearanceProposal,
  parseSpaceAppearanceProposal,
  resolveSpaceAppearance,
} from "../src/shared/space-appearance.js";
import { SpaceAppearanceStore } from "../src/local/space-appearance-store.js";
import { startLocalApi } from "../src/local/server.js";
import { configureWorkspaceStateRoot } from "../src/local/state-paths.js";
import { defaultWorkspaceBannerName } from "../web-local/src/constants.js";
import {
  normalizeWorkspaceBannerImage,
  normalizeWorkspaceBannerImagePosition,
  normalizeWorkspaceCustomizations,
  workspaceBannerOptionFor,
} from "../web-local/src/lib/workspace-customization.js";
import { writeStoredJsonValue } from "../web-local/src/lib/storage.js";
import { readableTextColorOn } from "../web-local/src/lib/color-contrast.js";
import type { WorkspaceSummary } from "../web-local/src/types.js";

const workspace: WorkspaceSummary = {
  id: "space-home",
  name: "Home projects",
  rootPath: "C:\\Users\\you\\Documents\\Home projects",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

test("Space banners keep Classic as the explicit default while supporting None", () => {
  assert.equal(defaultWorkspaceBannerName, "classic");
  assert.equal(workspaceBannerOptionFor(undefined).name, "classic");
  assert.equal(workspaceBannerOptionFor("none").name, "none");
  assert.equal(workspaceBannerOptionFor("unknown").name, "classic");
});

test("Space customization normalization accepts only supported fields", () => {
  const raster = "data:image/png;base64,AA==";
  const normalized = normalizeWorkspaceCustomizations({
    [workspace.id]: {
      color: "#0D74CE",
      color2: "#5C7C2E",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
      ignored: "value",
    },
    removed: { color: "#ffffff" },
  }, new Set([workspace.id]), new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {
    [workspace.id]: {
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

test("Space customization normalization rejects unsafe images and invalid values", () => {
  const normalized = normalizeWorkspaceCustomizations({
    [workspace.id]: {
      color: "blue",
      color2: "#12345g",
      iconName: "not-a-real-icon",
      bannerName: "not-a-banner",
      bannerImage: "data:image/svg+xml;base64,PHN2Zy8+",
      bannerImagePosition: "left",
    },
  }, undefined, new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {});
  assert.equal(normalizeWorkspaceBannerImage("https://example.com/banner.png"), null);
  assert.equal(normalizeWorkspaceBannerImage("data:image/svg+xml;base64,PHN2Zy8+"), null);
  assert.equal(normalizeWorkspaceBannerImagePosition("left"), "center");
});

test("preference storage reports quota failures instead of silently claiming durability", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => { throw new Error("quota"); }, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("workspace.appearance.test", { color: "#0d74ce" }), false);

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { setItem: () => {}, removeItem: () => {} } },
    });
    assert.equal(writeStoredJsonValue("workspace.appearance.test", { color: "#0d74ce" }), true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Space identity chooses user-message text from the primary message background", () => {
  assert.equal(readableTextColorOn("#c5c5c4"), "#182846");
  assert.equal(readableTextColorOn("#0d74ce"), "#ffffff");
});

test("semantic Space palettes preserve v1 light solids and pass both contrast gates", () => {
  const colors = [
    "#60646c", "#ce2c31", "#cc4e00", "#ab6400", "#5c7c2e", "#1a7f37",
    "#0e7490", "#0d74ce", "#6550b9", "#953ea3", "#c2298a", "#815e46",
  ];
  for (const color of colors) {
    const first = resolveSpaceAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
    const second = resolveSpaceAppearance({ primary: accentIdentityFromHex(color), bannerName: "classic" });
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
    const resolved = resolveSpaceAppearance({ primary: accentIdentityFromHex(color) });
    assert.equal(resolved.passes, true, `${color} must produce a passing guided palette`);
    for (const palette of [resolved.light, resolved.dark]) {
      assert.equal(palette.audit.find((entry) => entry.role === "onSolidMuted")?.passes, true);
    }
  }
});

test("appearance identities repair forged hue and chroma metadata from reference hex", () => {
  const parsed = parseSpaceAppearanceProposal({
    kind: "workspace.space-appearance",
    version: 1,
    name: "Forged metadata",
    customization: {
      schema: 2,
      primary: { schema: 2, hue: 140, chroma: 0.4, referenceHex: "#ffffff" },
    },
  });
  assert.deepEqual(parsed.customization.primary, accentIdentityFromHex("#ffffff"));
  assert.equal(resolveSpaceAppearance({ primary: parsed.customization.primary! }).passes, true);
});

test("appearance proposals are typed, code-free, and ignore unknown fields", () => {
  const proposal = createSpaceAppearanceProposal({
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
  const parsed = parseSpaceAppearanceProposal(JSON.parse(JSON.stringify(proposal)));
  assert.equal(parsed.kind, "workspace.space-appearance");
  assert.equal(parsed.customization.primary?.referenceHex, "#0d74ce");
  assert.equal("css" in parsed.customization, false);
  assert.equal("javascript" in parsed.customization, false);
});

test("appearance store writes versioned machine-local state atomically and imports v1 once", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-appearance-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await SpaceAppearanceStore.create({ path });
  const migrated = await store.importLegacy({
    "space-home": { color: "#0D74CE", iconName: "home", bannerName: "classic" },
  }, new Set(["space-home"]));
  assert.equal(migrated.revision, 1);
  assert.equal(migrated.customizations["space-home"]?.color, "#0d74ce");
  const updated = await store.replaceWorkspace("space-home", {
    schema: 2,
    primary: accentIdentityFromHex("#6550b9"),
    iconName: "folder",
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.customizations["space-home"]?.primary?.referenceHex, "#6550b9");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), updated);
  const reopened = await SpaceAppearanceStore.create({ path });
  assert.deepEqual(reopened.snapshot(), updated);
});

test("appearance store recovers its last committed backup and rejects future formats", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-appearance-recovery-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await SpaceAppearanceStore.create({ path });
  const first = await store.replaceWorkspace("space-home", { color: "#0d74ce" });
  await store.replaceWorkspace("space-home", { color: "#6550b9" });
  await writeFile(path, "{not-json", "utf8");
  const recovered = await SpaceAppearanceStore.create({ path });
  assert.deepEqual(recovered.snapshot(), first);

  await writeFile(path, JSON.stringify({ version: 99, revision: 3, customizations: {} }), "utf8");
  await assert.rejects(
    () => SpaceAppearanceStore.create({ path }),
    /unsupported version 99/i,
  );
});

test("authenticated renderer API owns Space appearance persistence and removal", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-appearance-api-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workspaceBase: join(sandbox, "spaces"),
    sessionToken: "appearance-test-token",
    loadEnv: false,
  });
  t.after(async () => {
    await api.close();
    configureWorkspaceStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const headers = {
    "content-type": "application/json",
    "x-workspace-session": "appearance-test-token",
  };
  const createResponse = await fetch(`${api.origin}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Appearance API" }),
  });
  assert.equal(createResponse.status, 201);
  const workspaceId = (await createResponse.json() as { workspace: { id: string } }).workspace.id;
  const updateResponse = await fetch(`${api.origin}/api/workspaces/${workspaceId}/appearance`, {
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
  assert.equal(updated.appearance.customizations[workspaceId]?.primary?.referenceHex, "#0d74ce");

  const bootstrapResponse = await fetch(`${api.origin}/api/bootstrap`, { headers });
  const bootstrap = await bootstrapResponse.json() as { appearance: typeof updated.appearance };
  assert.equal(bootstrap.appearance.customizations[workspaceId]?.primary?.referenceHex, "#0d74ce");

  const removeResponse = await fetch(`${api.origin}/api/workspaces/${workspaceId}/appearance`, { method: "DELETE", headers });
  const removed = await removeResponse.json() as { appearance: { customizations: Record<string, unknown> } };
  assert.equal(workspaceId in removed.appearance.customizations, false);
});
