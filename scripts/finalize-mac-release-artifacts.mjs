import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const productIdentity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const version = String(packageJson.version ?? "").trim();
const arch = stringValue(process.env.WORKFOLD_DESKTOP_RELEASE_ARCH) || (process.arch === "x64" ? "x64" : "arm64");
const builderDir = join(rootDir, "out", "builder");
const dmgPath = join(builderDir, `${productIdentity.productName}-${version}-mac-${arch}.dmg`);
const blockmapPath = `${dmgPath}.blockmap`;
const latestPath = join(builderDir, "latest-mac.yml");

if (process.platform !== "darwin") throw new Error(`${productIdentity.productName} macOS release artifacts must be finalized on a Mac host.`);
if (!version || !existsSync(dmgPath) || !existsSync(latestPath)) {
  throw new Error(`The ${productIdentity.productName} DMG or latest-mac.yml is missing. Run the macOS release builder first.`);
}

if (isFinalizedDmg()) {
  console.log(`${productIdentity.productName} DMG is already Developer ID-signed, notarized, and accepted by Gatekeeper.`);
} else {
  signDmg();
  notarizeDmg();
  run("xcrun", ["stapler", "staple", dmgPath], `Could not staple the notarization ticket to the ${productIdentity.productName} DMG`);
  verifyDmg();
}
await refreshUpdateMetadata();
console.log(`Finalized signed and notarized ${productIdentity.productName} ${version} macOS ${arch} installer metadata.`);

function signDmg() {
  const identity = stringValue(process.env.WORKFOLD_MAC_SIGN_IDENTITY || process.env.CSC_NAME);
  if (!identity) throw new Error("WORKFOLD_MAC_SIGN_IDENTITY is required to sign the release DMG.");
  run("codesign", ["--force", "--timestamp", "--sign", identity, dmgPath], `Could not Developer ID-sign the ${productIdentity.productName} DMG`);
}

function notarizeDmg() {
  const args = ["notarytool", "submit", dmgPath];
  const keychainProfile = stringValue(process.env.APPLE_KEYCHAIN_PROFILE);
  const keychain = stringValue(process.env.APPLE_KEYCHAIN);
  if (keychainProfile) {
    if (keychain) args.push("--keychain", keychain);
    args.push("--keychain-profile", keychainProfile);
  } else if (complete("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER")) {
    args.push(
      "--key", process.env.APPLE_API_KEY,
      "--key-id", process.env.APPLE_API_KEY_ID,
      "--issuer", process.env.APPLE_API_ISSUER,
    );
  } else if (complete("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID")) {
    args.push(
      "--apple-id", process.env.APPLE_ID,
      "--password", process.env.APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id", process.env.APPLE_TEAM_ID,
    );
  } else {
    throw new Error("Configure APPLE_KEYCHAIN_PROFILE or a complete Apple notarization credential set.");
  }
  args.push("--wait", "--output-format", "json");

  const output = run("xcrun", args, `Apple rejected or could not process the ${productIdentity.productName} DMG`, 20 * 60_000);
  const result = JSON.parse(output.stdout.trim());
  if (result.status !== "Accepted") {
    throw new Error(`Apple notarization did not accept ${basename(dmgPath)} (status: ${result.status || "unknown"}).`);
  }
  console.log(`Apple accepted ${productIdentity.productName} DMG notarization submission ${result.id}.`);
}

function verifyDmg() {
  run("codesign", ["--verify", "--strict", "--verbose=2", dmgPath], `${productIdentity.productName} DMG signature verification failed`);
  run("xcrun", ["stapler", "validate", dmgPath], `The ${productIdentity.productName} DMG does not contain a valid stapled notarization ticket`);
  run(
    "spctl",
    ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath],
    `Gatekeeper rejected the ${productIdentity.productName} release DMG`,
  );
}

function isFinalizedDmg() {
  return [
    ["codesign", ["--verify", "--strict", "--verbose=2", dmgPath]],
    ["xcrun", ["stapler", "validate", dmgPath]],
    ["spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]],
  ].every(([command, args]) => commandSucceeds(command, args));
}

function commandSucceeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "ignore",
    timeout: 120_000,
  });
  return !result.error && result.status === 0;
}

async function refreshUpdateMetadata() {
  const require = createRequire(import.meta.url);
  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
  const updateInfo = await buildBlockMap(dmgPath, "gzip", blockmapPath);
  const latest = readFileSync(latestPath, "utf8");
  const dmgName = basename(dmgPath);
  const refreshed = replaceLatestFileMetadata(latest, dmgName, updateInfo.sha512, updateInfo.size);
  writeFileSync(latestPath, refreshed, "utf8");

  if (statSync(dmgPath).size !== updateInfo.size) {
    throw new Error(`${productIdentity.productName} DMG blockmap size ${updateInfo.size} does not match the finalized image.`);
  }
}

function replaceLatestFileMetadata(source, name, sha512, size) {
  const lines = source.split(/\r?\n/);
  const entry = lines.findIndex((line) => line.trim() === `- url: ${name}`);
  if (entry < 0) throw new Error(`latest-mac.yml does not contain ${name}.`);
  let shaIndex = -1;
  let sizeIndex = -1;
  for (let index = entry + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("- url:") || (!lines[index].startsWith(" ") && trimmed)) break;
    if (trimmed.startsWith("sha512:")) shaIndex = index;
    if (trimmed.startsWith("size:")) sizeIndex = index;
  }
  if (shaIndex < 0 || sizeIndex < 0) throw new Error(`latest-mac.yml metadata is incomplete for ${name}.`);
  lines[shaIndex] = `${lines[shaIndex].match(/^\s*/)?.[0] ?? "    "}sha512: ${sha512}`;
  lines[sizeIndex] = `${lines[sizeIndex].match(/^\s*/)?.[0] ?? "    "}size: ${size}`;
  return lines.join("\n");
}

function run(command, args, label, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${compactText(result.error?.message || output || `exit code ${result.status ?? 1}`)}`);
  }
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function complete(...names) {
  return names.every((name) => stringValue(process.env[name]));
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1400);
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
