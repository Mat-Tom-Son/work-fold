import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const patches = join(root, "patches", "included-tools");
const manifest = JSON.parse(await readFile(join(patches, "manifest.json"), "utf8"));
for (const entry of manifest) {
  const target = join(root, "node_modules", entry.package);
  const installed = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  if (installed.version !== entry.version) throw new Error(`Review ${entry.package} ${installed.version} before changing its integration patch.`);
  const patch = join(patches, entry.patch);
  if (await digest(patch) !== entry.sha256) throw new Error(`Integration patch changed without reviewed evidence: ${entry.patch}`);
  const actual = await Promise.all(entry.files.map((file) => digest(contained(target, file.path))));
  if (actual.every((hash, index) => hash === entry.files[index].after)) continue;
  if (!actual.every((hash, index) => hash === entry.files[index].before)) throw new Error(`Unexpected or partially patched ${entry.package} source. Reinstall with npm ci before retrying.`);
  execFileSync("git", ["apply", "--check", `--directory=node_modules/${entry.package}`, patch], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["apply", `--directory=node_modules/${entry.package}`, patch], { cwd: root, stdio: "inherit" });
  for (const file of entry.files) if (await digest(contained(target, file.path)) !== file.after) throw new Error(`Integration patch verification failed: ${entry.package}/${file.path}`);
  console.log(`Included native integration verified: ${entry.package} ${entry.version}`);
}

function contained(root, path) {
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}/`)) throw new Error("Invalid integration patch path.");
  return target;
}
async function digest(path) {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}
