import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

const root = process.cwd();
const asset = (name: string) => join(root, "desktop", "assets", name);
const read = (path: string) => readFile(join(root, path), "utf8");

test("the canonical icon source is the folded work-fold mark", async () => {
  const [source, generator] = await Promise.all([
    read("desktop/assets/work-fold-icon-source.svg"),
    read("scripts/generate-desktop-icons.mjs"),
  ]);

  assert.match(source, /id="work-fold-mark" data-template-view-box="142 142 740 740"/);
  assert.match(source, /#252321/);
  assert.match(source, /#D95735/);
  assert.match(source, /<title id="title">work-fold<\/title>/);
  await assert.rejects(access(asset("workspace-icon-source.svg")));

  assert.match(generator, /work-fold-icon-source\.svg/);
  assert.match(generator, /extractMarkedSvgGroup/);
  assert.match(generator, /id="work-fold-mark"/);
  assert.doesNotMatch(generator, /stroked polyline glyph|m\[\\d\\s\.\-\]/);
});

test("generated app and template icons preserve the mark at tiny sizes", async () => {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const metadata = await sharp(asset(`icon-${size}.png`)).metadata();
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
  }

  const tiny = await pixelSummary(asset("icon-16.png"));
  assert.ok(tiny.ink >= 20, `16px icon needs a legible graphite silhouette; found ${tiny.ink} dark pixels`);
  assert.ok(tiny.paper >= 100, `16px icon needs a quiet paper field; found ${tiny.paper} light pixels`);
  assert.ok(tiny.warm >= 3, `16px icon needs a visible warm crease; found ${tiny.warm} pixels`);

  for (const [name, size] of [["iconTemplate.png", 18], ["iconTemplate@2x.png", 36]] as const) {
    const summary = await pixelSummary(asset(name));
    assert.equal(summary.width, size);
    assert.equal(summary.height, size);
    assert.equal(summary.colored, 0, `${name} must remain black-plus-alpha for native template recoloring`);
    assert.ok(summary.bounds.width >= Math.round(size * 0.84), `${name} mark is too narrow for the menu bar`);
    assert.ok(summary.bounds.height >= Math.round(size * 0.63), `${name} mark is too short for the menu bar`);
  }
});

test("onboarding, loading, About, and the popover use the restrained work-fold lockup", async () => {
  const [brand, brandCss, onboarding, app, settings, popover, indexHtml, popoverHtml, foundation] = await Promise.all([
    read("web-local/src/components/brand/WorkFoldBrand.tsx"),
    read("web-local/src/brand.css"),
    read("web-local/src/components/onboarding/OnboardingFlow.tsx"),
    read("web-local/src/App.tsx"),
    read("web-local/src/components/modals/DesktopSettingsModal.tsx"),
    read("web-local/src/popover/PopoverApp.tsx"),
    read("web-local/index.html"),
    read("web-local/popover.html"),
    read("web-local/src/professional-foundation.css"),
  ]);

  assert.match(brand, /work-fold-mark-plane-left/);
  assert.match(brand, /work-fold-mark-plane-right/);
  assert.match(brand, /work-fold-mark-crease/);
  assert.match(brand, /data-animated=/);
  assert.match(brandCss, /--work-fold-crease:\s*#c84f30/i);
  assert.match(brandCss, /@keyframes work-fold-plane-left-in/);
  assert.match(brandCss, /@keyframes work-fold-plane-right-in/);
  assert.match(brandCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation:\s*none/);
  assert.match(brandCss, /@media \(forced-colors: active\)[\s\S]*?fill:\s*CanvasText[\s\S]*?fill:\s*Highlight/);
  assert.match(foundation, /--ui-accent:\s*#c84f30/i);
  assert.match(foundation, /:root\[data-theme="dark"\][\s\S]*?--ui-accent:\s*#f08363/i);

  assert.match(onboarding, /<WorkFoldLockup className="onboarding-brand" animated/);
  assert.doesNotMatch(onboarding, />W<|space-wordmark|onboarding-kicker/);
  assert.match(app, /<WorkFoldLoadingState message=/);
  assert.match(settings, /<WorkFoldLockup className="about-work-fold-brand"/);
  assert.match(popover, /<WorkFoldLockup className="popover-brand"/);
  assert.match(popover, /<WorkFoldLockup className="popover-loading-brand" animated/);
  assert.match(popover, />Open work-fold<\/button>/);

  assert.match(indexHtml, /<title>work-fold<\/title>/);
  assert.match(indexHtml, /%23D95735/);
  assert.match(popoverHtml, /<title>Tell work-fold<\/title>/);
  assert.doesNotMatch(`${indexHtml}\n${popoverHtml}`, /Workspace/);
});

async function pixelSummary(path: string) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  let paper = 0;
  let warm = 0;
  let colored = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      const blue = data[offset + 2] ?? 0;
      const alpha = data[offset + 3] ?? 0;
      if (alpha > 20) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      if (alpha > 100 && red + green + blue < 300) ink += 1;
      if (alpha > 100 && red + green + blue > 650) paper += 1;
      if (alpha > 80 && red > green * 1.22 && red > blue * 1.3) warm += 1;
      if (alpha > 20 && (red !== green || green !== blue)) colored += 1;
    }
  }
  return {
    width: info.width,
    height: info.height,
    ink,
    paper,
    warm,
    colored,
    bounds: {
      width: maxX >= minX ? maxX - minX + 1 : 0,
      height: maxY >= minY ? maxY - minY + 1 : 0,
    },
  };
}
