import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeSpaceAppearanceCustomization, normalizeSpaceAppearanceBannerFraming, upgradeSpaceAppearanceCustomization, createSpaceAppearanceProposal, parseSpaceAppearanceProposal } from "../src/shared/space-appearance.js";
import { SpaceAppearanceStore } from "../src/local/space-appearance-store.js";
import { spaceBannerPresets } from "../web-local/src/lib/space-banner-presets.js";

test("bundled banners and framing survive proposal round trips and an appearance-store restart", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "work-fold-banners-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "appearance.json");
  const store = await SpaceAppearanceStore.create({ path });
  for (const preset of spaceBannerPresets) {
    const appearance = { bannerPreset: preset.id, bannerFraming: { x: 35, y: 70, zoom: 1.4 }, iconName: "leaf" };
    const proposal = createSpaceAppearanceProposal({ name: preset.label, customization: appearance });
    assert.deepEqual(parseSpaceAppearanceProposal(JSON.parse(JSON.stringify(proposal))).customization, appearance);
    assert.deepEqual(upgradeSpaceAppearanceCustomization(appearance), appearance);
    await store.replaceSpace(preset.id, proposal.customization);
    for (const asset of [preset.image, preset.thumbnail]) {
      const bytes = await readFile(new URL(asset));
      assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
      assert.ok(bytes.length < 250_000);
    }
  }
  const reopened = await SpaceAppearanceStore.create({ path });
  assert.deepEqual(reopened.snapshot().customizations, store.snapshot().customizations);
  const saved = await readFile(path, "utf8");
  assert.ok(saved.length < 1500, "presets store identities rather than copies of image bytes");
  assert.doesNotMatch(saved, /data:image|https?:|file:/);
});

test("framing stays bounded and built-in identities never accept arbitrary asset URLs", () => {
  for (const bad of [null, [], { x: 0, y: 0, zoom: Infinity }, { x: -1, y: 0, zoom: 1 }, { x: 50, y: 101, zoom: 1 }, { x: 50, y: 50, zoom: 0.5 }, { x: 50, y: 50, zoom: 2.01 }, { x: "50", y: 50, zoom: 1 }, { x: 50, zoom: 1 }]) {
    assert.equal(normalizeSpaceAppearanceBannerFraming(bad), undefined);
  }
  for (const id of ["unknown", "https://example.test/a.webp", "../../a", "file:///tmp/a", "data:image/png;base64,AA=="]) {
    assert.deepEqual(normalizeSpaceAppearanceCustomization({ bannerPreset: id }), {});
  }
  assert.deepEqual(normalizeSpaceAppearanceCustomization({ bannerImagePosition: "top" }), { bannerImagePosition: "top" });
  assert.deepEqual(normalizeSpaceAppearanceBannerFraming({ x: 0, y: 100, zoom: 2 }), { x: 0, y: 100, zoom: 2 });
});
