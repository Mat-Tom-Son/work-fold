import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Generates the remote web client's installable-app icons from the same SVG
// mark the client already serves. Run once after changing the mark:
//
//   node scripts/generate-bridge-web-icons.mjs
//
// Outputs are committed as static files in services/bridge/public/ so the
// bridge deploy stays a plain static directory (the pattern set by
// scripts/generate-desktop-icons.mjs for desktop/assets).

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicDir = join(rootDir, "services", "bridge", "public");
const source = join(publicDir, "work-fold-icon.svg");

// The SVG is a 1024 canvas holding a 912px rounded app tile inset by 56px on
// every side. Home-screen icons want the tile itself, not the transparent
// margin around it, so full-bleed variants crop to the tile and flatten its
// rounded corners onto the client's light paper color (app.css --paper).
const tileInset = 56;
const tileSize = 912;
const renderScale = 4;
const paper = "#f3f0e9";

if (!existsSync(source)) throw new Error(`Icon source not found: ${source}`);

const rendered = await sharp(source, { density: 72 * renderScale }).png().toBuffer();

async function writeFullSvgIcon(size, name) {
  await sharp(rendered).resize(size, size).png().toFile(join(publicDir, name));
}

async function writeFullBleedTileIcon(size, name) {
  await sharp(rendered)
    .extract({
      left: tileInset * renderScale,
      top: tileInset * renderScale,
      width: tileSize * renderScale,
      height: tileSize * renderScale,
    })
    .flatten({ background: paper })
    .resize(size, size)
    .png()
    .toFile(join(publicDir, name));
}

// Manifest icons: the mark as drawn (purpose "any"), plus a full-bleed
// maskable variant the launcher may crop to its own shape.
await writeFullSvgIcon(192, "icon-192.png");
await writeFullSvgIcon(512, "icon-512.png");
await writeFullBleedTileIcon(512, "icon-maskable-512.png");

// iOS composites no transparency into home-screen icons, so the Apple touch
// icon is the full-bleed tile too; iOS applies its own corner mask.
await writeFullBleedTileIcon(180, "apple-touch-icon.png");

console.log(`Generated work-fold web client icons in ${publicDir}`);
