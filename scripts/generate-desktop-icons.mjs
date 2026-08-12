import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Installs the desktop icons from the committed designer icon pack under
// desktop/assets/brand/pack/. Every output is a byte-for-byte copy of a pack
// export — the pack ships purpose-built sizes (including the optically
// simplified small sizes and the menu-bar template), so this script only
// places files and verifies their geometry.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDir = join(rootDir, "desktop", "assets", "brand", "pack");
const outDir = join(rootDir, "desktop", "assets");

const copies = [
  ["macOS/WorkFold.icns", "icon.icns", null],
  ["Windows/WorkFold.ico", "icon.ico", null],
  ["macOS/WorkFold-macOS-1024.png", "icon.png", 1024],
  ["macOS/WorkFold-macOS-1024.png", "icon-1024.png", 1024],
  ["macOS/WorkFold.iconset/icon_512x512.png", "icon-512.png", 512],
  ["Windows/png/WorkFold-256.png", "icon-256.png", 256],
  ["Windows/png/WorkFold-128.png", "icon-128.png", 128],
  ["Windows/png/WorkFold-64.png", "icon-64.png", 64],
  ["Windows/png/WorkFold-48.png", "icon-48.png", 48],
  ["Windows/png/WorkFold-32.png", "icon-32.png", 32],
  ["Windows/png/WorkFold-24.png", "icon-24.png", 24],
  ["Windows/png/WorkFold-16.png", "icon-16.png", 16],
  ["monochrome/macOS-template/WorkFoldTemplate.png", "iconTemplate.png", 18],
  ["monochrome/macOS-template/WorkFoldTemplate@2x.png", "iconTemplate@2x.png", 36],
];

await mkdir(outDir, { recursive: true });
for (const [source, target, expectedSize] of copies) {
  const sourcePath = join(packDir, source);
  if (!existsSync(sourcePath)) throw new Error(`Icon pack source not found: ${sourcePath}`);
  await copyFile(sourcePath, join(outDir, target));
  if (expectedSize !== null) {
    const { width, height } = await sharp(sourcePath).metadata();
    if (width !== expectedSize || height !== expectedSize) {
      throw new Error(`${source} is ${width}x${height}; expected ${expectedSize}x${expectedSize}`);
    }
  }
}
console.log(`Installed ${copies.length} work-fold desktop icons from the pack into ${outDir}`);
