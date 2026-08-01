import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const appPath = resolve(rootDir, readOption("--app") || `out/mac-rc/mac-${process.arch}/${identity.productName}.app`);
const arch = readOption("--arch") || (process.arch === "x64" ? "x64" : "arm64");
const expectedIdentity = String(process.env.WORKFOLD_MAC_SIGN_IDENTITY || process.env.CSC_NAME || "")
  .trim()
  .replace(/^Developer ID Application:\s*/i, "");
const expectedTeamId = String(process.env.WORKFOLD_MAC_TEAM_ID || process.env.APPLE_TEAM_ID || "").trim();
const failures = [];

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS candidates must be verified on a Mac host.`);
if (!existsSync(appPath)) throw new Error(`Signed macOS candidate not found: ${appPath}.`);

await expectCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], "Application code signature verification failed");
const bundleId = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(appPath, "Contents", "Info.plist")]);
const bundleName = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", join(appPath, "Contents", "Info.plist")]);
const bundleVersion = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")]);
const executable = join(appPath, "Contents", "MacOS", identity.productName);
const architecture = await commandValue("/usr/bin/file", [executable]);

if (bundleId !== identity.productionAppId) failures.push(`Unexpected bundle identifier: ${bundleId || "missing"}.`);
if (bundleName !== identity.productName) failures.push(`Unexpected bundle name: ${bundleName || "missing"}.`);
if (bundleVersion !== packageJson.version) failures.push(`Bundle version ${bundleVersion || "missing"} does not match ${packageJson.version}.`);
if (!architecture.includes(arch === "arm64" ? "arm64" : "x86_64")) failures.push(`Application executable is not ${arch}: ${architecture}.`);

try {
  const signature = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
  const details = `${signature.stdout}\n${signature.stderr}`;
  if (!/Authority=Developer ID Application:/.test(details)) failures.push("Candidate is not signed by a Developer ID Application identity.");
  if (expectedIdentity && !details.includes(`Authority=Developer ID Application: ${expectedIdentity}`)) {
    failures.push("Candidate Developer ID identity does not match the configured release identity.");
  }
  if (!/TeamIdentifier=\S+/.test(details) || /TeamIdentifier=not set/.test(details)) failures.push("Candidate has no Apple TeamIdentifier.");
  if (expectedTeamId && !details.includes(`TeamIdentifier=${expectedTeamId}`)) failures.push(`Candidate is not signed by Apple Team ${expectedTeamId}.`);
  if (!/flags=.*\(runtime\)/.test(details)) failures.push("Candidate is not signed with hardened runtime.");
} catch (error) {
  failures.push(`Could not inspect the candidate signature: ${errorMessage(error)}.`);
}

await expectCommand("/usr/bin/xcrun", ["stapler", "validate", appPath], "Candidate has no valid notarization staple");
await expectCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], "Gatekeeper rejected the candidate");

if (failures.length) {
  console.error(`${identity.productName} signed candidate verification failed:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified signed and notarized ${identity.productName} ${packageJson.version} macOS ${arch} candidate at ${appPath}.`);

async function expectCommand(command, args, label) {
  try {
    await run(command, args);
  } catch (error) {
    failures.push(`${label}: ${errorMessage(error)}.`);
  }
}

async function commandValue(command, args) {
  try {
    const result = await run(command, args);
    return result.stdout.trim();
  } catch (error) {
    failures.push(`${command} failed: ${errorMessage(error)}.`);
    return "";
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function errorMessage(error) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
