import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const version = "5.30.3";
const rootDir = resolve(import.meta.dirname, "..");
const installDir = join(rootDir, ".tools", "railway");
const binaryName = process.platform === "win32" ? "railway.exe" : "railway";

const triples = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

const platformKey = `${process.platform}-${process.arch}`;
const triple = triples[platformKey];
if (!triple) {
  throw new Error(`Railway CLI installation is not configured for ${platformKey}.`);
}

const archiveName = `railway-v${version}-${triple}.tar.gz`;
const releaseApiUrl = `https://api.github.com/repos/railwayapp/cli/releases/tags/v${version}`;
const expectedDownloadPrefix = `https://github.com/railwayapp/cli/releases/download/v${version}/`;
const requestHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "work-fold-railway-cli-installer",
  "X-GitHub-Api-Version": "2022-11-28",
};

const releaseResponse = await fetch(releaseApiUrl, { headers: requestHeaders });
if (!releaseResponse.ok) {
  throw new Error(`Unable to read Railway CLI release metadata (${releaseResponse.status}).`);
}

const release = await releaseResponse.json();
const asset = release.assets?.find((candidate) => candidate.name === archiveName);
if (!asset) {
  throw new Error(`Railway CLI release v${version} does not contain ${archiveName}.`);
}
if (!asset.browser_download_url?.startsWith(expectedDownloadPrefix)) {
  throw new Error(`Railway CLI release returned an unexpected download URL for ${archiveName}.`);
}
if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "")) {
  throw new Error(`Railway CLI release did not publish a usable SHA-256 digest for ${archiveName}.`);
}

const downloadResponse = await fetch(asset.browser_download_url, { headers: requestHeaders });
if (!downloadResponse.ok) {
  throw new Error(`Unable to download Railway CLI ${archiveName} (${downloadResponse.status}).`);
}

const archiveBytes = Buffer.from(await downloadResponse.arrayBuffer());
const actualDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`;
if (actualDigest !== asset.digest) {
  throw new Error(`Railway CLI digest mismatch for ${archiveName}.`);
}

const temporaryDir = await mkdtemp(join(tmpdir(), "work-fold-railway-cli-"));
try {
  const archivePath = join(temporaryDir, archiveName);
  const extractedDir = join(temporaryDir, "extracted");
  await writeFile(archivePath, archiveBytes, { mode: 0o600 });
  await mkdir(extractedDir);

  const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", extractedDir], {
    stdio: "inherit",
  });
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0) {
    throw new Error(`Unable to extract Railway CLI ${archiveName}.`);
  }

  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });
  await copyFile(join(extractedDir, binaryName), join(installDir, binaryName));
  if (process.platform !== "win32") {
    await chmod(join(installDir, binaryName), 0o755);
  }
  await writeFile(join(installDir, "VERSION"), `${version}\n`, { mode: 0o644 });
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}

console.log(`Installed Railway CLI v${version} at ${join(installDir, binaryName)}`);
