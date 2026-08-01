import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const version = packageJson.version;
const arch = process.env.WORKFOLD_DESKTOP_RELEASE_ARCH?.trim() || (process.arch === "x64" ? "x64" : "arm64");
const releaseBuild = process.env.WORKFOLD_MAC_RELEASE_BUILD === "1";
const unsignedSmokeBuild = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD === "1";
const builderDir = join(rootDir, "out", "builder");
const expectedProductName = unsignedSmokeBuild ? identity.macSmokeProductName : identity.productName;
const appBundleName = `${expectedProductName}.app`;
const executableName = expectedProductName;
const expectedBundleId = unsignedSmokeBuild ? identity.macSmokeAppId : identity.productionAppId;
const appPath = join(builderDir, `mac-${arch}`, appBundleName);
const resourcesPath = join(appPath, "Contents", "Resources");
const artifactStem = `${identity.productName}-${version}-mac-${arch}`;
const dmgPath = join(builderDir, `${artifactStem}.dmg`);
const zipPath = join(builderDir, `${artifactStem}.zip`);
const updatePath = join(builderDir, "latest-mac.yml");
const manifestPath = join(builderDir, `${identity.productName}-mac-release-manifest.json`);
const textManifestPath = join(builderDir, `${identity.productName}-mac-release-manifest.txt`);
const expectedFeedOwner = process.env.WORKFOLD_MAC_RELEASE_OWNER?.trim() || identity.sourceRepositoryOwner;
const expectedFeedRepo = process.env.WORKFOLD_MAC_RELEASE_REPO?.trim() || identity.macReleaseRepositoryName;
const failures = [];

for (const [path, label] of [
  [appPath, "packaged application"],
  [dmgPath, "DMG"],
  [`${dmgPath}.blockmap`, "DMG blockmap"],
  [zipPath, "ZIP"],
  [`${zipPath}.blockmap`, "ZIP blockmap"],
  [updatePath, "latest-mac.yml"],
  [join(resourcesPath, "app-update.yml"), "embedded updater feed"],
  [manifestPath, "JSON release manifest"],
  [textManifestPath, "text release manifest"],
]) {
  if (!existsSync(path)) failures.push(`Missing ${label}: ${path}.`);
}

if (existsSync(appPath)) await verifyApplication();
if (existsSync(updatePath)) verifyUpdateManifest();
if (existsSync(join(resourcesPath, "app-update.yml"))) verifyEmbeddedUpdateFeed();
if (existsSync(manifestPath)) verifyReleaseManifest();
if (existsSync(dmgPath)) await verifyDmg();

if (failures.length) {
  console.error(`${identity.productName} macOS release verification failed:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const checksumPaths = [dmgPath, `${dmgPath}.blockmap`, zipPath, `${zipPath}.blockmap`, updatePath];
const checksumText = checksumPaths
  .map((path) => `${digest(path, "sha256", "hex")}  ${path.slice(builderDir.length + 1)}`)
  .join("\n");
await writeFile(join(builderDir, "SHA256SUMS-mac.txt"), `${checksumText}\n`, "utf8");
console.log(`Verified ${identity.productName} ${version} macOS ${arch} artifacts in ${builderDir}.`);

async function verifyApplication() {
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  } catch (error) {
    failures.push(`Application code signature verification failed: ${errorMessage(error)}.`);
  }

  const bundleId = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(appPath, "Contents", "Info.plist")]);
  const bundleName = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleName", join(appPath, "Contents", "Info.plist")]);
  const bundleVersion = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")]);
  const category = await commandValue("/usr/libexec/PlistBuddy", ["-c", "Print :LSApplicationCategoryType", join(appPath, "Contents", "Info.plist")]);
  if (bundleId !== expectedBundleId) failures.push(`Unexpected bundle identifier: ${bundleId || "missing"}.`);
  if (bundleName !== expectedProductName) failures.push(`Unexpected bundle name: ${bundleName || "missing"}.`);
  if (bundleVersion !== version) failures.push(`Bundle version ${bundleVersion || "missing"} does not match ${version}.`);
  if (category !== "public.app-category.productivity") failures.push(`Unexpected macOS application category: ${category || "missing"}.`);

  const executable = join(appPath, "Contents", "MacOS", executableName);
  const architecture = await commandValue("/usr/bin/file", [executable]);
  if (!architecture.includes(arch === "arm64" ? "arm64" : "x86_64")) failures.push(`Application executable is not ${arch}: ${architecture}.`);

  try {
    const signature = await run("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
    const details = `${signature.stdout}\n${signature.stderr}`;
    if (releaseBuild) {
      if (!/Authority=Developer ID Application:/.test(details)) failures.push("Release app is not signed by a Developer ID Application identity.");
      if (/TeamIdentifier=not set/.test(details) || !/TeamIdentifier=\S+/.test(details)) failures.push("Release app has no Apple TeamIdentifier.");
      if (!/flags=.*\(runtime\)/.test(details)) failures.push("Release app is not signed with the hardened runtime flag.");
      await run("/usr/bin/xcrun", ["stapler", "validate", appPath]).catch((error) => {
        failures.push(`Notarization staple validation failed: ${errorMessage(error)}.`);
      });
      await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]).catch((error) => {
        failures.push(`Gatekeeper assessment failed: ${errorMessage(error)}.`);
      });
    } else if (!/Signature=adhoc/.test(details)) {
      failures.push("Unsigned smoke app does not have the expected ad hoc signature.");
    }
  } catch (error) {
    failures.push(`Could not inspect application signature: ${errorMessage(error)}.`);
  }
}

function verifyUpdateManifest() {
  const manifest = readFileSync(updatePath, "utf8");
  if (!new RegExp(`^version:\\s*${escapeRegExp(version)}\\s*$`, "m").test(manifest)) failures.push("latest-mac.yml has the wrong version.");
  for (const path of [dmgPath, zipPath]) {
    if (!existsSync(path)) continue;
    const name = path.slice(builderDir.length + 1);
    if (!manifest.includes(name)) failures.push(`latest-mac.yml does not reference ${name}.`);
    if (!manifest.includes(digest(path, "sha512", "base64"))) failures.push(`latest-mac.yml SHA-512 does not match ${name}.`);
    if (!manifest.includes(`size: ${lstatSync(path).size}`)) failures.push(`latest-mac.yml size does not match ${name}.`);
  }
}

function verifyEmbeddedUpdateFeed() {
  const feed = readFileSync(join(resourcesPath, "app-update.yml"), "utf8");
  expectYamlScalar(feed, "provider", "github", "embedded updater provider");
  expectYamlScalar(feed, "owner", expectedFeedOwner, "embedded updater owner");
  expectYamlScalar(feed, "repo", expectedFeedRepo, "embedded updater repository");
  expectYamlScalar(feed, "releaseType", "release", "embedded updater channel");
  expectYamlScalar(feed, "updaterCacheDirName", identity.updaterCacheDirectoryName, "embedded updater cache directory");
}

function verifyReleaseManifest() {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.productName !== expectedProductName) failures.push(`Release manifest product name ${manifest.productName || "missing"} does not match ${expectedProductName}.`);
    if (manifest.version !== version) failures.push(`Release manifest version ${manifest.version || "missing"} does not match ${version}.`);
    if (manifest.platform !== "darwin" || manifest.arch !== arch) failures.push("Release manifest platform or architecture is incorrect.");
    if (manifest.unsignedSmokeBuild !== !releaseBuild) failures.push("Release manifest signed/unsigned mode does not match the current verification mode.");
    if (manifest.feed?.owner !== expectedFeedOwner || manifest.feed?.repo !== expectedFeedRepo) failures.push("Release manifest feed does not match the embedded Mac feed.");
    const artifacts = new Map((manifest.artifacts ?? []).map((artifact) => [artifact.name, artifact]));
    for (const path of [dmgPath, `${dmgPath}.blockmap`, zipPath, `${zipPath}.blockmap`, updatePath]) {
      if (!existsSync(path)) continue;
      const name = path.slice(builderDir.length + 1);
      const artifact = artifacts.get(name);
      if (!artifact) {
        failures.push(`Release manifest is missing ${name}.`);
        continue;
      }
      const bytes = readFileSync(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (artifact.bytes !== bytes.length || artifact.sha256 !== sha256) failures.push(`Release manifest metadata does not match ${name}.`);
    }
  } catch (error) {
    failures.push(`Could not verify the ${identity.productName} release manifest: ${errorMessage(error)}.`);
  }
}

async function verifyDmg() {
  let mountPoint = "";
  try {
    if (releaseBuild) {
      const signature = await run("/usr/bin/codesign", ["--display", "--verbose=4", dmgPath]);
      const details = `${signature.stdout}\n${signature.stderr}`;
      if (!/Authority=Developer ID Application:/.test(details) || !/TeamIdentifier=\S+/.test(details)) {
        failures.push("Release DMG is not signed by a Developer ID Application identity.");
      }
      await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
      await run("/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
      await run("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmgPath]);
    }
    const attached = await run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-plist", dmgPath]);
    mountPoint = decodeXml(attached.stdout.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)?.[1] || "");
    if (!mountPoint) throw new Error("hdiutil did not report a mount point");
    if (!existsSync(join(mountPoint, appBundleName))) failures.push(`DMG does not contain ${appBundleName}.`);
    if (!existsSync(join(mountPoint, "Applications")) || !lstatSync(join(mountPoint, "Applications")).isSymbolicLink()) {
      failures.push("DMG does not contain the Applications link.");
    }
    if (!existsSync(join(mountPoint, ".background.png"))) failures.push("DMG does not contain the custom background.");
  } catch (error) {
    failures.push(`DMG inspection failed: ${errorMessage(error)}.`);
  } finally {
    if (mountPoint) await run("/usr/bin/hdiutil", ["detach", mountPoint]).catch(() => undefined);
  }
}

function expectYamlScalar(source, key, expected, label) {
  const actual = readYamlScalar(source, key);
  if (actual !== expected) failures.push(`${label} is ${actual ?? "missing"}; expected ${expected}.`);
}

function readYamlScalar(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`^\\s*(?:-\\s+)?${escaped}:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.replace(/^['"]|['"]$/g, "");
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

function digest(path, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeXml(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function errorMessage(error) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) return error.stderr.trim();
  return error instanceof Error ? error.message : String(error);
}
