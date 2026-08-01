import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(rootDir, "desktop", "assets", "work-fold-icon-source.svg");
const outDir = join(rootDir, "desktop", "assets");
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const run = promisify(execFile);

await mkdir(outDir, { recursive: true });
if (!existsSync(source)) throw new Error(`Icon source not found: ${source}`);

const sourceBytes = await sharp(source, { density: 384 }).png().toBuffer();
await sharp(sourceBytes).resize(1024, 1024).png().toFile(join(outDir, "icon.png"));

const icoPngs = [];
for (const size of sizes) {
  const bytes = await sharp(sourceBytes).resize(size, size).png().toBuffer();
  const pngPath = join(outDir, `icon-${size}.png`);
  await writeFile(pngPath, bytes);
  if ([16, 24, 32, 48, 64, 128, 256].includes(size)) icoPngs.push(pngPath);
}

await writeFile(join(outDir, "icon.ico"), await pngToIco(icoPngs));
await writeTrayTemplateIcons(await readFile(source, "utf8"));
if (process.platform === "darwin") await writeIcns(sourceBytes);
console.log(`Generated work-fold desktop icons in ${outDir}`);

async function writeTrayTemplateIcons(svgText) {
  // The macOS menu-bar item needs a monochrome template image (black plus
  // alpha) so the system can recolor it for light and dark menu bars. The
  // source identifies the complete mark and its optical crop explicitly;
  // this stays stable as the mark evolves and does not infer geometry from a
  // particular path command or stroke shape.
  const mark = extractMarkedSvgGroup(svgText);
  const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}"><style>path{fill:#000!important;stroke:#000!important}</style>${mark.markup}</svg>`;
  const templateBytes = await sharp(Buffer.from(template), { density: 384 }).png().toBuffer();
  await sharp(templateBytes).resize(18, 18).png().toFile(join(outDir, "iconTemplate.png"));
  await sharp(templateBytes).resize(36, 36).png().toFile(join(outDir, "iconTemplate@2x.png"));
}

function extractMarkedSvgGroup(svgText) {
  const match = svgText.match(/<g\s+id="work-fold-mark"\s+data-template-view-box="([^"]+)">([\s\S]*?)<\/g>/);
  if (!match) throw new Error(`No work-fold mark group with a template crop found in ${source}`);
  return { viewBox: match[1], markup: match[2] };
}

async function writeIcns(sourcePng) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "work-fold-icon-"));
  const iconset = join(temporaryRoot, "work-fold.iconset");
  const variants = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  try {
    await mkdir(iconset, { recursive: true });
    await Promise.all(variants.map(async ([name, size]) => {
      await sharp(sourcePng).resize(size, size).png().toFile(join(iconset, name));
    }));
    await run("/usr/bin/iconutil", ["--convert", "icns", iconset, "--output", join(outDir, "icon.icns")]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
