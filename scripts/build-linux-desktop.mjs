import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLinuxSource } from "./linux-source-evidence.mjs";
import { captureLinuxSboms } from "./linux-sbom.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build Linux x64 candidates on a Linux x64 host.");
const args = process.argv.slice(2);
if (args.some(arg => !["--dir", "--skip-prepare"].includes(arg))) throw new Error("Supported options: --dir, --skip-prepare");
if (args.includes("--skip-prepare") && !args.includes("--dir")) throw new Error("Full candidates require desktop:prepare; --skip-prepare is only for unpacked diagnostics.");
const output = join(root, "out/linux");
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const env = { ...process.env, WORKFOLD_DESKTOP_RELEASE_PLATFORM: "linux", WORKFOLD_DESKTOP_OUTPUT_DIR: output };
await mkdir(output, { recursive: true });
if (!args.includes("--dir") && (await readdir(output)).some(name => name.startsWith(`work-fold-${version}-linux-`) && /\.(deb|rpm|AppImage)$/.test(name))) {
  throw new Error(`Linux ${version} artifacts already exist. Preserve them and choose a higher unique version before building another candidate.`);
}
// An interrupted replacement must not retain a previous build's success record.
for (const file of ["linux-build.json", "SHA256SUMS"]) await rm(join(output, file), { force: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
if (!args.includes("--skip-prepare")) run("npm", ["run", "desktop:prepare"]);
// Full candidates retain the exact working tree, including reviewed local
// changes. Unpacked diagnostic builds do not reserve a candidate's source bytes.
const source = args.includes("--dir") ? null : await captureLinuxSource(root, output, version);
const sbomEvidence = source ? await captureLinuxSboms(root, output, version) : null;
// Extend the pinned builder's desktop integration and sandbox/AppArmor setup;
// replacing its hooks would silently remove Ubuntu's sandbox prerequisites.
const hooks = join(root, "out/generated-linux-assets");
await mkdir(hooks, { recursive: true });
for (const name of ["after-install", "after-remove"]) {
  const upstream = await readFile(join(root, `node_modules/app-builder-lib/templates/linux/${name}.tpl`), "utf8");
  const cli = await readFile(join(root, `desktop/linux/${name}.sh`), "utf8");
  const guard = name === "after-remove" ? await readFile(join(root, "desktop/linux/before-remove.sh"), "utf8") : "";
  await writeFile(join(hooks, `${name}.sh`), `${guard}${upstream}\n${cli}\n`);
}
run(process.execPath, ["node_modules/electron-builder/cli.js", "--config", "electron-builder.desktop.cjs", "--linux", ...(args.includes("--dir") ? ["--dir"] : ["deb", "rpm", "AppImage"]), "--x64", "--publish", "never"]);
run(process.execPath, ["scripts/verify-packaged-app-assets.mjs", "--package-dir", join(output, "linux-unpacked"), "--platform", "linux"]);
run(process.execPath, ["scripts/linux-sandbox-smoke.mjs", join(output, "linux-unpacked/work-fold-desktop")]);
run(process.execPath, ["scripts/linux-installed-smoke.mjs", join(output, "linux-unpacked/work-fold-desktop")]);
if (source) await captureLinuxSource(root, output, version); // Reject edits during the build.
await mkdir(output, { recursive: true });
const artifacts = [];
for (const name of (args.includes("--dir") ? [] : await readdir(output)).filter(name => name.startsWith(`work-fold-${version}-linux-`) && /\.(deb|rpm|AppImage)$/.test(name)).sort()) {
  const bytes = await readFile(join(output, name));
  artifacts.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
if (!args.includes("--dir") && artifacts.length !== 3) throw new Error("Expected DEB, RPM and AppImage candidates for this version.");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
const buildRecord = `${JSON.stringify({ version, platform: "linux", arch: "x64", distribution: "local-candidate", automaticUpdates: false,
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null, sourceDirty: status.status === 0 ? Boolean(status.stdout.trim()) : null,
  ...(source ?? {}),
  ...(sbomEvidence ? { sbomEvidence } : {}),
  createdAt: new Date().toISOString(), artifacts }, null, 2)}\n`;
if (source) await writeFile(join(output, `work-fold-${version}-linux-build.json`), buildRecord, { flag: "wx" });
await writeFile(join(output, "linux-build.json"), buildRecord);
await writeFile(join(output, "SHA256SUMS"), [...artifacts, ...Object.values(source?.sourceEvidence ?? {}), ...(sbomEvidence?.files ?? [])].map(item => `${item.sha256}  ${item.name}\n`).join(""));
console.log(`Verified Linux candidate: ${output}`);
