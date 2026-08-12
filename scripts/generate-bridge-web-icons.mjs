import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Installs the remote web client's icons from the committed designer icon
// pack, sizes the horizontal lockups for the header surfaces, and composes
// the Open Graph image. Outputs are committed as static files so the bridge
// deploy stays a plain static directory. Run once after the pack or lockups
// change:
//
//   node scripts/generate-bridge-web-icons.mjs

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const brandDir = join(rootDir, "desktop", "assets", "brand");
const packDir = join(brandDir, "pack");
const publicDir = join(rootDir, "services", "bridge", "public");
const rendererBrandDir = join(rootDir, "web-local", "src", "assets", "brand");

// The client's light paper color (app.css --paper).
const paper = "#f2f4ef";
const lockupHeight = 192;

const packCopies = [
  ["web/icon-192.png", "icon-192.png"],
  ["web/icon-512.png", "icon-512.png"],
  ["web/icon-maskable-512.png", "icon-maskable-512.png"],
  ["web/apple-touch-icon.png", "apple-touch-icon.png"],
  ["web/favicon-32x32.png", "favicon-32.png"],
  ["web/favicon.ico", "favicon.ico"],
  ["png/transparent/work-fold-icon-256.png", "brand-mark.png"],
];

await mkdir(rendererBrandDir, { recursive: true });
for (const [source, target] of packCopies) {
  const sourcePath = join(packDir, source);
  if (!existsSync(sourcePath)) throw new Error(`Icon pack source not found: ${sourcePath}`);
  await copyFile(sourcePath, join(publicDir, target));
}

// The provided horizontal lockups (black for light themes, white for dark)
// serve every header surface; the bridge and the desktop renderer bundle the
// identical bytes.
for (const tone of ["black", "white"]) {
  const lockup = await sharp(join(brandDir, `lockup-horizontal-${tone}.png`))
    .resize({ height: lockupHeight })
    .png()
    .toBuffer();
  await writeFile(join(publicDir, `brand-lockup-${tone}.png`), lockup);
  await writeFile(join(rendererBrandDir, `work-fold-lockup-${tone}.png`), lockup);
}

// The desktop renderer bundles the bare cube for mark-only placements.
await copyFile(join(packDir, "png/transparent/work-fold-icon-512.png"), join(rendererBrandDir, "work-fold-mark.png"));

// Link previews: the black lockup centered on the paper field.
const ogLockup = await sharp(join(brandDir, "lockup-horizontal-black.png")).resize({ width: 940 }).png().toBuffer();
const ogLockupHeight = (await sharp(ogLockup).metadata()).height;
await sharp({ create: { width: 1200, height: 630, channels: 3, background: paper } })
  .composite([{ input: ogLockup, left: 130, top: Math.round((630 - ogLockupHeight) / 2) }])
  .png()
  .toFile(join(publicDir, "og-image.png"));

console.log(`Installed work-fold web client icons from the pack into ${publicDir}`);
