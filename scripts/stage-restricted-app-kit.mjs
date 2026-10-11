// Stages the app kit (stylesheet and Inter font) next to the compiled desktop
// code, where the restricted-app host serves it under /__work-fold/.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "dist", "desktop", "restricted-app-kit");
const interFiles = join(root, "node_modules", "@fontsource-variable", "inter", "files");

await mkdir(join(target, "fonts"), { recursive: true });
await copyFile(join(root, "desktop", "assets", "restricted-app-kit", "kit.css"), join(target, "kit.css"));
for (const file of ["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2"]) {
  await copyFile(join(interFiles, file), join(target, "fonts", file));
}
// The SIL Open Font License travels with every copy of the font.
await copyFile(join(interFiles, "..", "LICENSE"), join(target, "fonts", "Inter-LICENSE.txt"));
console.log(`Staged the app kit in ${target}.`);
