import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const appPath = process.env.WORKFOLD_MAC_APP_PATH || `/Applications/${identity.productName}.app`;
const expectedVersion = argumentValue("--version") || String(packageJson.version || "").trim();
const expectedOwner = stringValue(process.env.WORKFOLD_MAC_RELEASE_OWNER) || identity.sourceRepositoryOwner;
const expectedRepo = stringValue(process.env.WORKFOLD_MAC_RELEASE_REPO) || identity.macReleaseRepositoryName;
const expectedTeamId = stringValue(process.env.WORKFOLD_MAC_TEAM_ID) || "464JD5K8DC";
const infoPlist = join(appPath, "Contents", "Info.plist");
const appUpdatePath = join(appPath, "Contents", "Resources", "app-update.yml");

if (process.platform !== "darwin") throw new Error(`Installed ${identity.productName} verification is only available on macOS.`);
if (!expectedVersion) throw new Error("Provide --version <version> or declare package.json version.");
if (!existsSync(infoPlist) || !existsSync(appUpdatePath)) throw new Error(`${identity.productName} is not installed completely at ${appPath}.`);

const installedVersion = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist], `Could not read installed ${identity.productName} version`);
const bundleId = run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist], `Could not read installed ${identity.productName} bundle id`);
if (installedVersion !== expectedVersion) throw new Error(`Installed ${identity.productName} is ${installedVersion}; expected ${expectedVersion}.`);
if (bundleId !== identity.productionAppId) throw new Error(`Installed ${identity.productName} has unexpected bundle id ${bundleId}.`);

const updateConfig = readSimpleYaml(appUpdatePath);
const expectedUpdateConfig = {
  provider: "github",
  owner: expectedOwner,
  repo: expectedRepo,
  releaseType: "release",
  updaterCacheDirName: identity.updaterCacheDirectoryName,
};
for (const [key, value] of Object.entries(expectedUpdateConfig)) {
  if (updateConfig[key] !== value) {
    throw new Error(`Installed app-update.yml ${key} is ${JSON.stringify(updateConfig[key])}; expected ${JSON.stringify(value)}.`);
  }
}

for (const relativePath of [`Contents/bin/${identity.cliCommand}`, `Contents/bin/${identity.cliCommand}-cli.jxa.js`]) {
  if (!existsSync(join(appPath, relativePath))) throw new Error(`Installed ${identity.productName} is missing ${relativePath}.`);
}

run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], `Installed ${identity.productName} signature verification failed`);
const signature = run("codesign", ["-dv", "--verbose=4", appPath], `Could not inspect installed ${identity.productName} signature`, true);
if (!signature.includes("Authority=Developer ID Application:") || !signature.includes(`TeamIdentifier=${expectedTeamId}`)) {
  throw new Error(`Installed ${identity.productName} is not signed by the expected Developer ID Team ${expectedTeamId}.`);
}
run("xcrun", ["stapler", "validate", appPath], `Installed ${identity.productName} notarization ticket validation failed`);
run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath], `Gatekeeper rejected installed ${identity.productName}`);

console.log(`Installed ${identity.productName} ${installedVersion} verified at ${appPath}.`);
console.log(`Updater feed: ${expectedOwner}/${expectedRepo}; Team ID: ${expectedTeamId}.`);
console.log("No Keychain secret data was requested.");

function readSimpleYaml(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? "" : stringValue(process.argv[index + 1]);
}

function run(command, args, label, includeStderr = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  if (result.error || result.status !== 0) {
    throw new Error(`${label}: ${compactText(result.error?.message || stderr || stdout || `exit code ${result.status ?? 1}`)}`);
  }
  return includeStderr ? `${stdout}\n${stderr}`.trim() : stdout;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1200);
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
