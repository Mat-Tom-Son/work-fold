import { mkdir } from "node:fs/promises";
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
  <path d="M13 28 H120" fill="none" stroke="#65718a" stroke-width="5" stroke-linecap="round"/>
  <path d="M104 13 L124 28 L104 43" fill="none" stroke="#65718a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`)).png().toBuffer();

const background = Buffer.from(`
<svg width="720" height="440" viewBox="0 0 720 440" xmlns="http://www.w3.org/2000/svg">
  <rect width="720" height="440" fill="#f8f9fb"/>
  <path d="M0 342 C98 305 184 314 264 343 C347 373 430 359 505 325 C582 290 651 301 720 331 L720 440 L0 440 Z" fill="#edf1f8"/>
  <path d="M0 382 C96 346 185 356 269 385 C350 413 433 398 510 363 C587 328 655 337 720 367" fill="none" stroke="#d3dbea" stroke-width="4"/>
  <text x="360" y="72" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="24" font-weight="700" fill="#202534">Workspace</text>
  <text x="360" y="104" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif" font-size="14" fill="#596174">Drag Workspace to Applications</text>
</svg>`);

await sharp(background)
  .composite([
    { input: icon, left: 326, top: 124 },
    { input: arrow, left: 285, top: 233 },
  ])
  .png()
  .toFile(join(outDir, "dmg-background.png"));

console.log(`Generated Workspace DMG background at ${join(outDir, "dmg-background.png")}`);
