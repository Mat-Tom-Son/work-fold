import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Installs the desktop icons from the committed designer icon pack under
// desktop/assets/brand/pack/. Application outputs are byte-for-byte copies of
// pack exports. The menu-bar pair is rendered from its high-resolution,
// optically compensated template source so both scales preserve the source
// aspect ratio and three transparent panel gaps.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packDir = join(rootDir, "desktop", "assets", "brand", "pack");
const outDir = join(rootDir, "desktop", "assets");
const macIconSource = join(packDir, "macOS", "WorkFold-macOS-1024.png");
const macIconsetDir = join(packDir, "macOS", "WorkFold.iconset");
const macIcns = join(packDir, "macOS", "WorkFold.icns");
const menuTemplateDir = join(packDir, "monochrome", "macOS-template");
const menuTemplateSource = join(menuTemplateDir, "WorkFoldTemplate-source.png");

const macIconset = [
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

// Modern ICNS stores PNG payloads in typed chunks. The paired chunk types are
// intentional: macOS asks for both the point-size and Retina representation.
const icnsChunks = [
  ["icp4", "icon_16x16.png", 16],
  ["ic11", "icon_16x16@2x.png", 32],
  ["icp5", "icon_32x32.png", 32],
  ["ic12", "icon_32x32@2x.png", 64],
  ["icp6", "icon_32x32@2x.png", 64],
  ["ic07", "icon_128x128.png", 128],
  ["ic13", "icon_128x128@2x.png", 256],
  ["ic08", "icon_256x256.png", 256],
  ["ic14", "icon_256x256@2x.png", 512],
  ["ic09", "icon_512x512.png", 512],
  ["ic10", "icon_512x512@2x.png", 1024],
];

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
];

async function renderMacIconPack() {
  await mkdir(macIconsetDir, { recursive: true });
  for (const [name, size] of macIconset) {
    await sharp(macIconSource)
      .resize(size, size, { fit: "fill", kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toFile(join(macIconsetDir, name));
  }

  const chunks = [];
  for (const [type, name, expectedSize] of icnsChunks) {
    const path = join(macIconsetDir, name);
    const [png, metadata] = await Promise.all([readFile(path), sharp(path).metadata()]);
    if (metadata.width !== expectedSize || metadata.height !== expectedSize) {
      throw new Error(`${name} is ${metadata.width}x${metadata.height}; expected ${expectedSize}x${expectedSize}`);
    }
    const chunk = Buffer.alloc(8 + png.length);
    chunk.write(type, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.length, 4);
    png.copy(chunk, 8);
    chunks.push(chunk);
  }
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
  await writeFile(macIcns, Buffer.concat([header, ...chunks]));
}

async function renderMenuTemplate(canvasSize, packName, installedName) {
  const inset = canvasSize / 18;
  const contentSize = canvasSize - (inset * 2);
  const trimmed = await sharp(menuTemplateSource)
    .ensureAlpha()
    .extractChannel("alpha")
    .trim({ background: "black" })
    .png()
    .toBuffer({ resolveWithObject: true });
  const scale = Math.min(contentSize / trimmed.info.width, contentSize / trimmed.info.height);
  const renderedWidth = Math.max(1, Math.round(trimmed.info.width * scale));
  const renderedHeight = Math.max(1, Math.round(trimmed.info.height * scale));
  const rendered = await sharp(trimmed.data)
    .resize(renderedWidth, renderedHeight, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Clear low-alpha resampling haze so the three faces stay disconnected at
  // 18 points. Stronger edge coverage is retained for native antialiasing.
  const alpha = Buffer.alloc(canvasSize * canvasSize);
  const offsetX = Math.floor((canvasSize - renderedWidth) / 2);
  const offsetY = Math.floor((canvasSize - renderedHeight) / 2);
  for (let y = 0; y < renderedHeight; y += 1) {
    for (let x = 0; x < renderedWidth; x += 1) {
      const coverage = rendered.data[((y * renderedWidth) + x) * rendered.info.channels] ?? 0;
      alpha[((y + offsetY) * canvasSize) + x + offsetX] = coverage < 80 ? 0 : coverage;
    }
  }
  const template = await sharp({
    create: {
      width: canvasSize,
      height: canvasSize,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).joinChannel(alpha, {
    raw: { width: canvasSize, height: canvasSize, channels: 1 },
  }).png().toBuffer();

  await Promise.all([
    writeFile(join(menuTemplateDir, packName), template),
    writeFile(join(outDir, installedName), template),
  ]);
}

await mkdir(outDir, { recursive: true });
if (!existsSync(macIconSource)) throw new Error(`Icon Composer source not found: ${macIconSource}`);
await renderMacIconPack();
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

if (!existsSync(menuTemplateSource)) throw new Error(`Menu-bar template source not found: ${menuTemplateSource}`);
await renderMenuTemplate(18, "WorkFoldTemplate.png", "iconTemplate.png");
await renderMenuTemplate(36, "WorkFoldTemplate@2x.png", "iconTemplate@2x.png");

console.log(`Installed ${copies.length + 2} work-fold desktop icons from the pack into ${outDir}`);
