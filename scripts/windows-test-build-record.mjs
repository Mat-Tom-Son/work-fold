import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Records what a Windows test build is, after desktop:make verified it, so a
// tester can check the download and find the exact source it came from.
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const builderDir = join(rootDir, "out", "builder");
const packageDir = join(builderDir, "win-unpacked");
const version = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version;
const installerName = `work-fold-Setup-${version}.exe`;
const installerPath = join(builderDir, installerName);
const recordName = `work-fold-${version}-windows-build.json`;

const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8" }).trim();
const sourceCommit = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) throw new Error("A test build record needs a clean, committed source tree.");
if (!existsSync(installerPath)) throw new Error(`Missing installer ${installerName}; run the signed test build first.`);
if (existsSync(join(packageDir, "resources", "app-update.yml"))) throw new Error("This build has an update feed; rebuild with -TestBuild.");

const installer = readFileSync(installerPath);
const signature = authenticode(installerPath);
if (!signature.subject || !signature.timestamped) throw new Error("The test installer must carry a timestamped signature.");
const helper = (path) => {
  const source = JSON.parse(readFileSync(join(packageDir, "resources", path), "utf8"));
  return Object.fromEntries(Object.entries({
    package: source.package, version: source.version, source: source.source, license: source.license,
    integrationPatchSha256: source.integrationPatchSha256, sourceSha256: source.sourceSha256,
    target: source.target, executableContentSha256: source.executableContentSha256,
    compiler: source.compiler?.split("\n")[0],
  }).filter(([, value]) => value !== undefined));
};
const moduleVersion = (name) => JSON.parse(readFileSync(join(rootDir, "node_modules", name, "package.json"), "utf8")).version;

const artifacts = [{ name: installerName, bytes: installer.length, sha256: createHash("sha256").update(installer).digest("hex") }];
const record = {
  version,
  platform: "windows",
  arch: "x64",
  distribution: "test-build",
  automaticUpdates: false,
  sourceCommit,
  sourceDirty: false,
  signing: { subject: signature.subject, thumbprint: signature.thumbprint, publiclyTrusted: signature.status === "Valid", timestamped: true },
  toolchain: {
    node: process.versions.node,
    npm: execFileSync(process.execPath, [join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js"), "--version"], { encoding: "utf8" }).trim(),
    electron: moduleVersion("electron"),
    electronBuilder: moduleVersion("electron-builder"),
    rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  },
  includedHelpers: {
    computer: helper(join("computer-helper", "work-fold Computer", "source.json")),
    chromeHost: helper(join("chrome-native-host", "source.json")),
  },
  createdAt: new Date().toISOString(),
  artifacts,
};
writeFileSync(join(builderDir, recordName), `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(join(builderDir, "SHA256SUMS"), artifacts.map((item) => `${item.sha256}  ${item.name}\n`).join(""));
console.log(`Recorded ${recordName} and SHA256SUMS for ${sourceCommit.slice(0, 12)}.`);

function authenticode(path) {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$s = Get-AuthenticodeSignature -LiteralPath $env:WORKFOLD_SIGNED_PATH",
    "[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; thumbprint = [string]$s.SignerCertificate.Thumbprint; timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, WORKFOLD_SIGNED_PATH: path },
  });
  if (result.status !== 0) throw new Error(`Could not read the installer signature: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout.trim());
}
