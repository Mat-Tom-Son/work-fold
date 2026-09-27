import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const linuxSbomKinds = ["npm", "computer", "hosts", "wayland"];

/** Use upstream CycloneDX generators; do not synthesize a dependency graph. */
export async function captureLinuxSboms(root, output, version) {
  root = resolve(root); output = resolve(output);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid SBOM version");
  const env = { ...process.env, SOURCE_DATE_EPOCH: "0" };
  const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180_000 });
  if (run("cyclonedx-npm", ["--version"]).trim() !== "6.0.1" ||
      !/^cargo-cyclonedx(?:-cyclonedx)? 0\.5\.9\s*$/.test(run("cargo-cyclonedx", ["cyclonedx", "--version"]))) throw new Error("Use the pinned CycloneDX tools from desktop/linux/Dockerfile");
  // npm flags two reviewed projections as invalid despite the exact installed
  // versions being intentional. Admit only those; never silence new problems.
  const listing = spawnSync("npm", ["ls", "--json", "--all"], { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (listing.error) throw listing.error;
  const problems = JSON.parse(listing.stdout).problems ?? [];
  const reviewed = new Set([
    `invalid: undici@8.10.0 ${join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/undici")}`,
    `invalid: @modelcontextprotocol/core@2.0.0 ${join(root, "node_modules/@modelcontextprotocol/core")}`,
  ]);
  if (problems.some(problem => !reviewed.has(problem)) || (listing.status !== 0 && !problems.length)) throw new Error("Unexpected npm dependency problems prevent SBOM generation");
  await mkdir(output, { recursive: true });
  // Cargo uses the project path in component IDs. A versioned, exclusively
  // created private workspace keeps those IDs stable without rewriting a BOM.
  const scratch = join(tmpdir(), `workfold-linux-sbom-${version}`);
  await mkdir(scratch, { mode: 0o700 });
  try {
    const npmFile = join(scratch, "npm.cdx.json");
    run("cyclonedx-npm", ["--ignore-npm-errors", "--output-reproducible", "--validate", "--output-file", npmFile]);
    const generated = { npm: npmFile };
    for (const [kind, source, name] of [
      ["computer", "node_modules/@injaneity/pi-computer-use/native/linux/bridge-rs", "linux-bridge"],
      ["hosts", "desktop/native/linux", "work-fold-linux-hosts"],
      ["wayland", "desktop/native/linux-wayland", "work-fold-wayland"],
    ]) {
      const copied = join(scratch, kind);
      await cp(join(root, source), copied, { recursive: true });
      const lock = await readFile(join(copied, "Cargo.lock"));
      run("cargo-cyclonedx", ["cyclonedx", "--manifest-path", join(copied, "Cargo.toml"), "--format", "json",
        "--spec-version", "1.5", "--target", "x86_64-unknown-linux-gnu", "--no-build-deps"], copied);
      if (!(await readFile(join(copied, "Cargo.lock"))).equals(lock)) throw new Error(`SBOM generation changed ${kind}'s locked dependencies`);
      generated[kind] = join(copied, `${name}.cdx.json`);
    }
    const files = [];
    for (const kind of linuxSbomKinds) {
      const bytes = await readFile(generated[kind]);
      const bom = JSON.parse(bytes);
      if (bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components) || !bom.components.length) throw new Error(`Invalid ${kind} CycloneDX output`);
      const item = { name: `work-fold-${version}-linux-${kind}.cdx.json`, bytes: bytes.length, sha256: sha256(bytes) };
      const destination = join(output, item.name);
      const existingStat = await lstat(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (existingStat && !existingStat.isFile()) throw new Error("Existing SBOM evidence is not a regular file");
      const existing = await readFile(destination).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (existing && !existing.equals(bytes)) throw new Error("SBOM bytes already exist for this version; choose a higher version");
      if (!existing) await writeFile(destination, bytes, { flag: "wx" });
      files.push(item);
    }
    return { generators: { npm: "@cyclonedx/cyclonedx-npm@6.0.1", cargo: "cargo-cyclonedx@0.5.9" },
      scope: "npm dependency graph including build tools; Linux Rust runtime dependency graphs. System-provided shared libraries are external and recorded separately in helper provenance and package dependencies.",
      reviewedNpmProblems: problems.map(problem => problem.replace(root + "/", "")), files };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
