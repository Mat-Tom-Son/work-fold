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
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import { defaultSpaceBannerName } from "../web-local/src/constants.js";
import {
  normalizeSpaceBannerImage,
  normalizeSpaceBannerImagePosition,
  normalizeSpaceCustomizations,
  spaceBannerOptionFor,
} from "../web-local/src/lib/space-customization.js";
import { writeStoredJsonValue } from "../web-local/src/lib/storage.js";
import { readableTextColorOn } from "../web-local/src/lib/color-contrast.js";
import { spaceLookOptions } from "../web-local/src/lib/space-looks.js";
import type { SpaceSummary } from "../web-local/src/types.js";

const space: SpaceSummary = {
  id: "space-home",
  name: "Home projects",
  rootPath: "C:\\Users\\you\\Documents\\Home projects",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

test("Space banners keep Classic as the explicit default while supporting None", () => {
  assert.equal(defaultSpaceBannerName, "classic");
  assert.equal(spaceBannerOptionFor(undefined).name, "classic");
  assert.equal(spaceBannerOptionFor("none").name, "none");
  assert.equal(spaceBannerOptionFor("unknown").name, "classic");
});

test("Space customization normalization accepts only supported fields", () => {
  const raster = "data:image/png;base64,AA==";
  const normalized = normalizeSpaceCustomizations({
    [space.id]: {
      color: "#0D74CE",
      color2: "#5C7C2E",
      iconName: "home",
      bannerName: "aurora",
      bannerImage: raster,
      bannerImagePosition: "bottom",
      ignored: "value",
    },
    removed: { color: "#ffffff" },
  }, new Set([space.id]), new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {
    [space.id]: {
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
  const normalized = normalizeSpaceCustomizations({
    [space.id]: {
      color: "blue",
      color2: "#12345g",
      iconName: "not-a-real-icon",
      bannerName: "not-a-banner",
      bannerImage: "data:image/svg+xml;base64,PHN2Zy8+",
      bannerImagePosition: "left",
    },
  }, undefined, new Set(["folder", "home", "airplane"]));

  assert.deepEqual(normalized, {});
  assert.equal(normalizeSpaceBannerImage("https://example.com/banner.png"), null);
  assert.equal(normalizeSpaceBannerImage("data:image/svg+xml;base64,PHN2Zy8+"), null);
  assert.equal(normalizeSpaceBannerImagePosition("left"), "center");
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

test("curated Looks are distinct one-click combinations that pass every audited role", () => {
  assert.equal(spaceLookOptions.length, 8);
  assert.equal(new Set(spaceLookOptions.map((look) => look.name)).size, spaceLookOptions.length);
  assert.equal(new Set(spaceLookOptions.map((look) => `${look.primary}:${look.secondary}:${look.bannerName}`)).size, spaceLookOptions.length);
  for (const look of spaceLookOptions) {
    const resolved = resolveSpaceAppearance({
      primary: accentIdentityFromHex(look.primary),
      secondary: accentIdentityFromHex(look.secondary),
      bannerName: look.bannerName,
    });
    assert.equal(resolved.passes, true, `${look.name} must pass both modes`);
    for (const palette of [resolved.light, resolved.dark]) {
      assert.deepEqual(palette.audit.filter((entry) => !entry.passes), []);
    }
  }
});

test("appearance identities repair forged hue and chroma metadata from reference hex", () => {
  const parsed = parseSpaceAppearanceProposal({
    kind: "work-fold.space-appearance",
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
  assert.equal(parsed.kind, "work-fold.space-appearance");
  assert.equal(parsed.customization.primary?.referenceHex, "#0d74ce");
  assert.equal("css" in parsed.customization, false);
  assert.equal("javascript" in parsed.customization, false);
});

test("legacy Workspace appearance kinds and target fields are rejected", () => {
  const customization = { schema: 2 as const, primary: accentIdentityFromHex("#0d74ce") };
  assert.throws(() => parseSpaceAppearanceProposal({
    kind: "workspace.space-appearance",
    version: 1,
    name: "Legacy kind",
    customization,
  }), /unsupported format/);
  assert.throws(() => parseSpaceAppearanceProposal({
    kind: "work-fold.space-appearance",
    version: 1,
    name: "Legacy target",
    target: { workspaceId: "space-home", workspaceName: "Home projects" },
    customization,
  }), /Legacy appearance target fields/);
});

test("appearance store writes versioned machine-local state atomically", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await SpaceAppearanceStore.create({ path });
  const updated = await store.replaceSpace("space-home", {
    schema: 2,
    primary: accentIdentityFromHex("#6550b9"),
    iconName: "folder",
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.customizations["space-home"]?.primary?.referenceHex, "#6550b9");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), updated);
  const reopened = await SpaceAppearanceStore.create({ path });
  assert.deepEqual(reopened.snapshot(), updated);
});

test("appearance store recovers its last committed backup and rejects future formats", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-recovery-"));
  const path = join(sandbox, "appearance.json");
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = await SpaceAppearanceStore.create({ path });
  const first = await store.replaceSpace("space-home", { color: "#0d74ce" });
  await store.replaceSpace("space-home", { color: "#6550b9" });
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
  const { startLocalApi } = await import("../src/local/server.js");
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-appearance-api-"));
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    spaceBase: join(sandbox, "spaces"),
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
  const createResponse = await fetch(`${api.origin}/api/spaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Appearance API" }),
  });
  assert.equal(createResponse.status, 201);
  const spaceId = (await createResponse.json() as { space: { id: string } }).space.id;
  const updateResponse = await fetch(`${api.origin}/api/spaces/${spaceId}/appearance`, {
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
  assert.equal(updated.appearance.customizations[spaceId]?.primary?.referenceHex, "#0d74ce");

  const bootstrapResponse = await fetch(`${api.origin}/api/bootstrap`, { headers });
  const bootstrap = await bootstrapResponse.json() as { appearance: typeof updated.appearance };
  assert.equal(bootstrap.appearance.customizations[spaceId]?.primary?.referenceHex, "#0d74ce");

  const removeResponse = await fetch(`${api.origin}/api/spaces/${spaceId}/appearance`, { method: "DELETE", headers });
  const removed = await removeResponse.json() as { appearance: { customizations: Record<string, unknown> } };
  assert.equal(spaceId in removed.appearance.customizations, false);
});
