import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copies the brand webfonts (Inter Variable for body text, Poppins for
// headings) from their npm packages into the bridge's static directory, where
// app.css declares the matching @font-face rules. Run once after bumping
// either font package:
//
//   node scripts/sync-bridge-fonts.mjs
//
// The desktop renderer gets the same fonts through its @fontsource imports in
// web-local/src/main.tsx; only the bridge needs committed copies because its
// deploy is a plain static directory.

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fontsDir = join(rootDir, "services", "bridge", "public", "fonts");
const interFiles = join(rootDir, "node_modules", "@fontsource-variable", "inter", "files");
const poppinsFiles = join(rootDir, "node_modules", "@fontsource", "poppins", "files");

const wanted = [
  [interFiles, "inter-latin-wght-normal.woff2"],
  [interFiles, "inter-latin-ext-wght-normal.woff2"],
  [interFiles, "inter-latin-wght-italic.woff2"],
  [interFiles, "inter-latin-ext-wght-italic.woff2"],
  [poppinsFiles, "poppins-latin-500-normal.woff2"],
  [poppinsFiles, "poppins-latin-ext-500-normal.woff2"],
  [poppinsFiles, "poppins-latin-600-normal.woff2"],
  [poppinsFiles, "poppins-latin-ext-600-normal.woff2"],
  [poppinsFiles, "poppins-latin-700-normal.woff2"],
  [poppinsFiles, "poppins-latin-ext-700-normal.woff2"],
];

await mkdir(fontsDir, { recursive: true });
for (const [dir, name] of wanted) {
  const source = join(dir, name);
  if (!existsSync(source)) throw new Error(`Font file not found: ${source}`);
  await copyFile(source, join(fontsDir, name));
}
console.log(`Copied ${wanted.length} brand font files into ${fontsDir}`);
