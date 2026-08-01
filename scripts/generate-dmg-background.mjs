import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const assetsDir = join(rootDir, "desktop", "assets");
const outDir = join(rootDir, "out", "generated-assets");
const iconPath = join(assetsDir, "icon.png");

await mkdir(outDir, { recursive: true });

const icon = await sharp(iconPath)
  .resize({ width: 68, height: 68, fit: "contain" })
  .png()
  .toBuffer();

const arrow = await sharp(Buffer.from(`
<svg width="150" height="52" viewBox="0 0 150 52" xmlns="http://www.w3.org/2000/svg">
  <path d="M13 28 H120" fill="none" stroke="#C84F30" stroke-width="5" stroke-linecap="round"/>
  <path d="M104 13 L124 28 L104 43" fill="none" stroke="#C84F30" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`)).png().toBuffer();

const background = Buffer.from(`
<svg width="720" height="440" viewBox="0 0 720 440" xmlns="http://www.w3.org/2000/svg">
  <rect width="720" height="440" fill="#F3F0E9"/>
  <path d="M0 440 0 333 520 0h200v440Z" fill="#EEE9E0"/>
  <path d="M0 379 584 0" fill="none" stroke="#FFFFFF" stroke-opacity=".58" stroke-width="2"/>
  <path d="M720 56 119 440" fill="none" stroke="#D4CBC0" stroke-opacity=".7" stroke-width="2"/>
  <text x="360" y="72" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="26" font-weight="650" letter-spacing="-.5" fill="#252321">work-fold</text>
  <text x="360" y="104" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="14" fill="#6B655F">Drag work-fold to Applications</text>
</svg>`);

const backgroundBytes = await sharp(background)
  .composite([
    { input: icon, left: 326, top: 124 },
    { input: arrow, left: 285, top: 233 },
  ])
  .png()
  .toBuffer();

await Promise.all([
  writeFile(join(outDir, "dmg-background.png"), backgroundBytes),
  writeFile(join(assetsDir, "dmg-background.png"), backgroundBytes),
]);

console.log(`Generated work-fold DMG background at ${join(outDir, "dmg-background.png")}`);
