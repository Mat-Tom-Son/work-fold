import { createReadStream } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { linuxSbomKinds } from "./linux-sbom.mjs";

// This stages an immutable, signed candidate. It never uploads, installs keys,
// changes a package manager's configuration, or chooses a signing identity.
export async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readCandidate(input, recordPath = join(input, "linux-build.json")) {
  input = resolve(input);
  const recordStat = await lstat(recordPath);
  if (!recordStat.isFile() || recordStat.size > 1024 * 1024) throw new Error("Invalid Linux build record.");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  if (record.platform !== "linux" || record.arch !== "x64" || !/^\d+\.\d+\.\d+$/.test(record.version ?? "") ||
      !/^[a-f0-9]{40}$/.test(record.sourceCommit ?? "") || typeof record.sourceDirty !== "boolean" ||
      record.automaticUpdates !== false || !Number.isFinite(Date.parse(record.createdAt))) throw new Error("Invalid Linux candidate identity.");
  const names = ["amd64.deb", "x86_64.rpm", "x86_64.AppImage"].map(suffix => `work-fold-${record.version}-linux-${suffix}`);
  if (!Array.isArray(record.artifacts) || record.artifacts.length !== names.length || new Set(record.artifacts.map(a => a.name)).size !== names.length) {
    throw new Error("Expected exactly one DEB, RPM and AppImage.");
  }
  for (const item of record.artifacts) {
    if (!names.includes(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) {
      throw new Error("Invalid artifact name, size or digest.");
    }
    const path = join(input, item.name);
    const stat = await lstat(path);
    if (!stat.isFile() || await realpath(path) !== path || stat.size !== item.bytes || await digestFile(path) !== item.sha256) {
      throw new Error(`Artifact does not match its source build record: ${item.name}`);
    }
  }
  if (record.sourceEvidence !== undefined) {
    if (!record.sourceEvidence || Object.keys(record.sourceEvidence).sort().join(",") !== "archive,manifest") throw new Error("Invalid source evidence fields.");
    for (const [kind, suffix] of [["archive", "tar.gz"], ["manifest", "json"]]) {
      const item = record.sourceEvidence?.[kind];
      if (!item || item.name !== `work-fold-${record.version}-linux-source.${suffix}` ||
          !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) throw new Error("Invalid source evidence.");
      const path = join(input, item.name), stat = await lstat(path);
      if (!stat.isFile() || await realpath(path) !== path || stat.size !== item.bytes || await digestFile(path) !== item.sha256) throw new Error("Source evidence does not match its build record.");
    }
    const manifest = JSON.parse(await readFile(join(input, record.sourceEvidence.manifest.name), "utf8"));
    if (manifest.schema !== "work-fold.linux-source.v1" || manifest.version !== record.version || manifest.sourceCommit !== record.sourceCommit ||
        manifest.sourceDirty !== record.sourceDirty || JSON.stringify(manifest.archive) !== JSON.stringify(record.sourceEvidence.archive)) throw new Error("Source manifest identity does not match its build record.");
  }
  if (record.sbomEvidence !== undefined) {
    const files = record.sbomEvidence?.files;
    const expected = linuxSbomKinds.map(kind => `work-fold-${record.version}-linux-${kind}.cdx.json`);
    if (!Array.isArray(files) || files.length !== expected.length || new Set(files.map(item => item.name)).size !== expected.length) throw new Error("Invalid SBOM evidence set.");
    for (const item of files) {
      if (!expected.includes(item.name) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) throw new Error("Invalid SBOM evidence.");
      const path = join(input, item.name), stat = await lstat(path);
      if (!stat.isFile() || await realpath(path) !== path || stat.size !== item.bytes || await digestFile(path) !== item.sha256) throw new Error("SBOM evidence does not match its build record.");
      if (JSON.parse(await readFile(path, "utf8")).bomFormat !== "CycloneDX") throw new Error("Expected a CycloneDX SBOM.");
    }
  }
  return record;
}

function run(command, args, env, capture = false) {
  const result = spawnSync(command, args, { env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).${capture ? ` ${result.stderr}` : ""}`);
  return result.stdout ?? "";
}

async function filesUnder(path, prefix = "") {
  const files = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(join(path, entry.name), relative + "/"));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected non-regular repository entry: ${relative}`);
  }
  return files;
}

export async function stageRepository({ input, recordPath, output, fingerprint, gnupgHome, testKey = false }) {
  if (process.platform !== "linux") throw new Error("Stage Linux repositories on Linux.");
  if (!/^[A-F0-9]{40}$/.test(fingerprint ?? "")) throw new Error("Supply the complete uppercase OpenPGP primary-key fingerprint.");
  input = resolve(input); output = resolve(output); gnupgHome = resolve(gnupgHome);
  const keyStat = await lstat(gnupgHome);
  if (!keyStat.isDirectory() || await realpath(gnupgHome) !== gnupgHome || (keyStat.mode & 0o077) !== 0 || keyStat.uid !== process.getuid()) {
    throw new Error("GNUPGHOME must be an owned, private directory without symlinks.");
  }
  if (gnupgHome === output || gnupgHome.startsWith(output + "/")) throw new Error("Never put private keys in the published tree.");
  const source = await readCandidate(input, recordPath);
  if (source.sourceDirty && !testKey) throw new Error("A production-key candidate requires a clean source build; use a disposable test key for dirty builds.");
  if (!source.sourceEvidence && !testKey) throw new Error("A production-key candidate requires the captured source archive and manifest.");
  if (!source.sbomEvidence && !testKey) throw new Error("A production-key candidate requires dependency SBOM evidence.");
  try { await lstat(output); throw new Error("Output already exists; use a new candidate directory."); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const env = { ...process.env, GNUPGHOME: gnupgHome, LC_ALL: "C", TZ: "UTC" };
  const listing = run("gpg", ["--batch", "--with-colons", "--list-secret-keys", fingerprint], env, true);
  const firstFingerprint = listing.split("\n").find(line => line.startsWith("fpr:"))?.split(":")[9];
  if (firstFingerprint !== fingerprint || !listing.split("\n").some(line => line.startsWith("sec:") && /[sS]/.test(line.split(":")[11] ?? ""))) {
    throw new Error("The exact requested signing key is unavailable.");
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), `.${basename(output)}-`));
  const scratch = await mkdtemp(join(tmpdir(), "workfold-repository-"));
  try {
    const artifacts = join(staging, "artifacts"); await mkdir(artifacts);
    for (const item of source.artifacts) {
      const target = join(artifacts, item.name);
      await copyFile(join(input, item.name), target);
      // Recheck the actual copy: input files may change after initial admission.
      if ((await lstat(target)).size !== item.bytes || await digestFile(target) !== item.sha256) throw new Error(`Artifact changed while staging: ${item.name}`);
    }
    if (source.sourceEvidence) {
      await mkdir(join(staging, "source"));
      for (const item of [source.sourceEvidence.archive, source.sourceEvidence.manifest]) {
        const target = join(staging, "source", item.name);
        await copyFile(join(input, item.name), target);
        if ((await lstat(target)).size !== item.bytes || await digestFile(target) !== item.sha256) throw new Error("Source evidence changed while staging.");
      }
    }
    if (source.sbomEvidence) {
      await mkdir(join(staging, "sbom"));
      for (const item of source.sbomEvidence.files) {
        const target = join(staging, "sbom", item.name);
        await copyFile(join(input, item.name), target);
        if ((await lstat(target)).size !== item.bytes || await digestFile(target) !== item.sha256) throw new Error("SBOM evidence changed while staging.");
      }
    }
    const deb = join(artifacts, `work-fold-${source.version}-linux-amd64.deb`);
    for (const [field, expected] of [["Package", "work-fold-desktop"], ["Version", source.version], ["Architecture", "amd64"]]) {
      if (run("dpkg-deb", ["--field", deb, field], env, true).trim() !== expected) throw new Error(`DEB ${field} does not match the build record.`);
    }
    const rpm = join(artifacts, `work-fold-${source.version}-linux-x86_64.rpm`);
    if (run("rpm", ["-qp", "--qf", "%{NAME}\n%{VERSION}\n%{ARCH}", rpm], env, true) !== `work-fold-desktop\n${source.version}\nx86_64`) throw new Error("RPM identity does not match the build record.");
    const armoredKey = join(staging, "work-fold-signing-key.asc");
    const binaryKey = join(staging, "work-fold-signing-key.gpg");
    run("gpg", ["--batch", "--armor", "--output", armoredKey, "--export", fingerprint], env);
    run("gpg", ["--batch", "--output", binaryKey, "--export", fingerprint], env);
    const sign = (path, clear = false) => {
      const signature = clear ? join(dirname(path), "InRelease") : path + ".asc";
      run("gpg", ["--batch", "--yes", "--local-user", fingerprint, "--digest-algo", "SHA256", "--armor", "--output", signature,
        clear ? "--clearsign" : "--detach-sign", path], env);
      run("gpgv", ["--homedir", scratch, "--keyring", binaryKey, signature, ...(clear ? [] : [path])], env);
      return signature;
    };
    run("rpmsign", ["--define", "__gpg /usr/bin/gpg", "--define", `_gpg_name ${fingerprint}`, "--define", "_gpg_digest_algo sha256", "--addsign", rpm], env);
    const rpmdb = join(scratch, "rpmdb"); await mkdir(rpmdb);
    run("rpm", ["--dbpath", rpmdb, "--import", armoredKey], env);
    const verifiedRpm = run("rpmkeys", ["--dbpath", rpmdb, "--checksig", rpm], env, true);
    if (!verifiedRpm.includes("digests signatures OK")) throw new Error("RPM signature verification did not affirm both signature and digest.");
    const rpmRepo = join(staging, "rpm", "x86_64"); await mkdir(join(rpmRepo, "Packages"), { recursive: true });
    await copyFile(rpm, join(rpmRepo, "Packages", basename(rpm)));
    run("createrepo_c", ["--checksum", "sha256", "--unique-md-filenames", "--revision", String(Math.floor(Date.now() / 1000)), rpmRepo], env);
    sign(join(rpmRepo, "repodata", "repomd.xml"));

    const aptlyRoot = join(scratch, "aptly");
    const config = join(scratch, "aptly.json");
    await writeFile(config, JSON.stringify({ rootDir: aptlyRoot, architectures: ["amd64"], gpgProvider: "gpg" }));
    const aptly = args => run("aptly", ["-config=" + config, ...args], env);
    aptly(["repo", "create", "-distribution=stable", "-component=main", "work-fold"]);
    aptly(["repo", "add", "work-fold", join(artifacts, `work-fold-${source.version}-linux-amd64.deb`)]);
    aptly(["snapshot", "create", "candidate", "from", "repo", "work-fold"]);
    // Aptly owns indexes/hashes. GnuPG signs the final Release after adding the
    // bounded validity interval that baseline Aptly 1.5 cannot configure itself.
    aptly(["publish", "snapshot", "-architectures=amd64", "-distribution=stable", "-component=main", "-acquire-by-hash", "-skip-signing", "-origin=work-fold", "-label=work-fold", "candidate"]);
    // Materialize Aptly's by-hash aliases so the export is self-contained and
    // works on object storage without a web server resolving symlinks.
    const aptRepo = join(staging, "apt"); await cp(join(aptlyRoot, "public"), aptRepo, { recursive: true, dereference: true });
    const release = join(aptRepo, "dists", "stable", "Release");
    const validUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toUTCString();
    await writeFile(release, `Valid-Until: ${validUntil}\n${await readFile(release, "utf8")}`);
    await rename(sign(release), release + ".gpg"); sign(release, true);
    sign(join(artifacts, `work-fold-${source.version}-linux-x86_64.AppImage`));
    await writeFile(join(staging, "source-build.json"), JSON.stringify(source, null, 2) + "\n");
    const manifest = { schema: "work-fold.linux-repository.v1", distribution: "signed-candidate", testKey, published: false,
      version: source.version, sourceCommit: source.sourceCommit, sourceDirty: source.sourceDirty, fingerprint,
      createdAt: new Date().toISOString(), aptValidUntil: validUntil, files: [] };
    for (const name of await filesUnder(staging)) manifest.files.push({ name, bytes: (await lstat(join(staging, name))).size, sha256: await digestFile(join(staging, name)) });
    await writeFile(join(staging, "repository.json"), JSON.stringify(manifest, null, 2) + "\n");
    sign(join(staging, "repository.json"));
    const checksumEntries = [];
    for (const name of await filesUnder(staging)) checksumEntries.push(`${await digestFile(join(staging, name))}  ${name}\n`);
    await writeFile(join(staging, "SHA256SUMS"), checksumEntries.join(""));
    sign(join(staging, "SHA256SUMS"));
    await chmod(staging, 0o755);
    await rename(staging, output);
    console.log(`Signed ${testKey ? "TEST-KEY " : ""}Linux candidate staged at ${output}; fingerprint ${fingerprint}. Nothing published.`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2); const values = new Map(); let testKey = false;
  while (args.length) {
    const key = args.shift();
    if (key === "--test-key" && !testKey) { testKey = true; continue; }
    if (!["--input", "--record", "--output", "--fingerprint", "--gnupg-home"].includes(key) || values.has(key) || !args[0] || args[0].startsWith("--")) throw new Error("Use --input PATH [--record PATH] --output NEW_PATH --fingerprint FULL_FINGERPRINT --gnupg-home PRIVATE_PATH [--test-key].");
    values.set(key, args.shift());
  }
  for (const key of ["--input", "--output", "--fingerprint", "--gnupg-home"]) if (!values.has(key)) throw new Error(`Missing ${key}`);
  await stageRepository({ input: values.get("--input"), recordPath: values.get("--record"), output: values.get("--output"), fingerprint: values.get("--fingerprint"), gnupgHome: values.get("--gnupg-home"), testKey });
}
