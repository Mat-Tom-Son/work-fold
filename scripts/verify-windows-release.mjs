import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const builderDir = join(rootDir, "out", "builder");
const packageDir = join(builderDir, "win-unpacked");
const installerName = `${identity.productName}-Setup-${packageJson.version}.exe`;
const installerPath = join(builderDir, installerName);
const blockmapPath = `${installerPath}.blockmap`;
const latestPath = join(builderDir, "latest.yml");
const appUpdatePath = join(packageDir, "resources", "app-update.yml");
const failures = [];

for (const [path, label] of [
  [installerPath, "NSIS installer"],
  [blockmapPath, "NSIS blockmap"],
  [latestPath, "latest.yml"],
  [appUpdatePath, "embedded app-update.yml"],
]) {
  if (!existsSync(path)) failures.push(`Missing ${label}: ${path}.`);
  else if (statSync(path).size === 0) failures.push(`${label} is empty: ${path}.`);
}

if (existsSync(packageDir)) {
  const packageCheck = spawnSync(
    process.execPath,
    [join(rootDir, "scripts", "verify-packaged-app-assets.mjs"), "--package-dir", relative(rootDir, packageDir)],
    { cwd: rootDir, encoding: "utf8" },
  );
  if (packageCheck.status !== 0) {
    failures.push(`Packaged application verification failed:\n${packageCheck.stderr || packageCheck.stdout}`);
  }
} else {
  failures.push(`Missing unpacked application: ${packageDir}.`);
}

if (existsSync(appUpdatePath)) {
  const appUpdate = readFileSync(appUpdatePath, "utf8");
  expectYamlScalar(appUpdate, "provider", "github", "embedded update provider");
  expectYamlScalar(appUpdate, "owner", "Mat-Tom-Son", "embedded update owner");
  expectYamlScalar(appUpdate, "repo", identity.sourceRepositoryName, "embedded update repository");
  const publisherName = readYamlScalar(appUpdate, "publisherName");
  if (process.env.WORKFOLD_TRUSTED_CODE_SIGNING === "1" && !publisherName) {
    failures.push("Trusted code signing was enabled, but app-update.yml has no publisher name.");
  }
  if (process.env.WORKFOLD_TRUSTED_CODE_SIGNING !== "1" && publisherName) {
    failures.push("app-update.yml enables publisher verification without a publicly trusted signing identity.");
  }
}

if (existsSync(latestPath) && existsSync(installerPath)) {
  const latest = readFileSync(latestPath, "utf8");
  expectYamlScalar(latest, "version", packageJson.version, "release version");
  expectYamlScalar(latest, "path", installerName, "release installer path");
  const listedUrl = readYamlScalar(latest, "url");
  if (listedUrl !== installerName) failures.push(`latest.yml URL is ${listedUrl ?? "missing"}; expected ${installerName}.`);
  const expectedSha512 = createHash("sha512").update(readFileSync(installerPath)).digest("base64");
  const listedSha512 = readYamlScalar(latest, "sha512");
  if (listedSha512 !== expectedSha512) failures.push("latest.yml SHA-512 does not match the installer bytes.");
}

const signature = process.platform === "win32" && existsSync(installerPath)
  ? readAuthenticodeSignature(installerPath)
  : { status: "Unavailable", subject: "" };
if (process.env.WORKFOLD_REQUIRE_CODE_SIGNING === "1" && !signature.subject) {
  failures.push(`Code signing was required, but the installer has no signer certificate (status: ${signature.status}).`);
}

if (failures.length) {
  console.error(`${identity.productName} Windows release verification failed:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified ${identity.productName} ${packageJson.version} Windows release assets in ${builderDir}.`);
console.log(`Installer: ${basename(installerPath)}`);
console.log(`Authenticode: ${signature.status}${signature.subject ? ` (${signature.subject})` : ""}`);

function expectYamlScalar(source, key, expected, label) {
  const actual = readYamlScalar(source, key);
  if (actual !== expected) failures.push(`${label} is ${actual ?? "missing"}; expected ${expected}.`);
}

function readYamlScalar(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^\\s*(?:-\\s+)?${escaped}:\\s*(.+?)\\s*$`, "m"));
  if (!match) return undefined;
  return match[1].replace(/^['"]|['"]$/g, "");
}

function readAuthenticodeSignature(path) {
  const escapedPath = path.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
    "$subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }",
    "[pscustomobject]@{ status = [string]$signature.Status; subject = $subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || result.stderr.trim()) return { status: "InspectionFailed", subject: "" };
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return { status: "InspectionFailed", subject: "" };
  }
}
