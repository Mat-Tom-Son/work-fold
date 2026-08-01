import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";
import electronFuses from "@electron/fuses";

const { FuseV1Options, getCurrentFuseWire } = electronFuses;

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const outDir = join(rootDir, "out");
const failures = [];
const WasmTrapHandlersFuse = 8;
const fuseDisabled = "0".charCodeAt(0);
const fuseEnabled = "1".charCodeAt(0);

const packageDirArgument = readArgument("--package-dir");
const packageDir = packageDirArgument ? resolve(rootDir, packageDirArgument) : findPackageDir();
if (!packageDir) {
  console.error(`${identity.productName} package verification failed: no unpacked app was found under out/.`);
  process.exit(1);
}
if (!existsSync(packageDir)) failures.push(`Packaged app directory does not exist: ${packageDir}.`);

const packagedPlatform = readArgument("--platform") ?? inferPackagedPlatform(packageDir);
const macAppBundleName = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD === "1"
  ? `${identity.macSmokeProductName}.app`
  : `${identity.productName}.app`;
const macExecutableName = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD === "1"
  ? identity.macSmokeProductName
  : identity.productName;
const appDir = packagedPlatform === "darwin" && !packageDir.endsWith(".app")
  ? join(packageDir, macAppBundleName)
  : packageDir;
const resourcesDir = packagedPlatform === "darwin"
  ? join(appDir, "Contents", "Resources")
  : join(appDir, "resources");
const binDir = packagedPlatform === "darwin" ? join(appDir, "Contents", "bin") : join(appDir, "bin");
const asarPath = join(resourcesDir, "app.asar");
const executablePath = packagedPlatform === "win32"
  ? join(appDir, `${identity.productName}.exe`)
  : packagedPlatform === "darwin"
    ? join(appDir, "Contents", "MacOS", macExecutableName)
    : join(appDir, identity.productName);

assertPath(executablePath, `${identity.productName} executable`);
assertPath(asarPath, "app.asar");
assertPath(join(resourcesDir, "web-local", "index.html"), "renderer index");
assertPath(join(resourcesDir, "web-local", "popover.html"), "management popover renderer");
assertPath(join(resourcesDir, "assets", "icon.png"), "desktop icon");
assertPath(join(resourcesDir, "assets", "iconTemplate.png"), "menu-bar template icon");
assertPath(join(resourcesDir, "assets", "iconTemplate@2x.png"), "menu-bar template icon (2x)");
assertPath(join(binDir, identity.cliCommand), `${identity.productName} CLI shell shim`);
if (packagedPlatform === "win32") {
  assertPath(join(binDir, `${identity.cliCommand}.cmd`), `${identity.productName} CLI command shim`);
  assertPath(join(binDir, `${identity.cliCommand}-cli.ps1`), `${identity.productName} CLI PowerShell helper`);
} else if (packagedPlatform === "darwin") {
  assertPath(join(binDir, `${identity.cliCommand}-cli.jxa.js`), `${identity.productName} CLI macOS helper`);
  assertPath(join(resourcesDir, "icon.icns"), "macOS application icon");
  if (existsSync(join(binDir, identity.cliCommand)) && !(statSync(join(binDir, identity.cliCommand)).mode & 0o111)) {
    failures.push(`${identity.productName} CLI shell shim is not executable.`);
  }
}
for (const oldShim of ["workspace", "workspace.cmd", "workspace-cli.ps1", "workspace-cli.jxa.js"]) {
  if (existsSync(join(binDir, oldShim))) failures.push(`Legacy CLI shim must not be packaged: ${oldShim}.`);
}

if (existsSync(executablePath) && (packagedPlatform === "win32" || packagedPlatform === "darwin")) {
  try {
    const wire = await getCurrentFuseWire(executablePath);
    const expectedFuses = new Map([
      [FuseV1Options.RunAsNode, fuseDisabled],
      [FuseV1Options.EnableCookieEncryption, fuseEnabled],
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable, fuseDisabled],
      [FuseV1Options.EnableNodeCliInspectArguments, fuseDisabled],
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, fuseEnabled],
      [FuseV1Options.OnlyLoadAppFromAsar, fuseEnabled],
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, fuseDisabled],
      [FuseV1Options.GrantFileProtocolExtraPrivileges, fuseDisabled],
      [WasmTrapHandlersFuse, fuseEnabled],
    ]);
    for (const [fuse, expected] of expectedFuses) {
      const name = fuse === WasmTrapHandlersFuse ? "WasmTrapHandlers" : FuseV1Options[fuse];
      if (wire[fuse] !== expected) failures.push(`Electron fuse ${name} is not in the required state.`);
    }
  } catch (error) {
    failures.push(`Could not inspect Electron security fuses: ${formatError(error)}`);
  }
}

if (existsSync(asarPath)) {
  const entries = new Set(listPackage(asarPath).map(normalizeAsarPath));
  for (const required of [
    "/package.json",
    "/LICENSE",
    "/dist/desktop/desktop/src/main.js",
    "/dist/desktop/desktop/src/preload.cjs",
    "/dist/desktop/desktop/src/management-popover-preload.cjs",
    "/dist/desktop/desktop/src/restricted-app-host.js",
    "/dist/desktop/desktop/src/restricted-app-preload.cjs",
    "/node_modules/@earendil-works/pi-coding-agent/package.json",
    "/node_modules/electron-updater/package.json",
    "/node_modules/jszip/package.json",
  ]) {
    if (!entries.has(required)) failures.push(`app.asar is missing ${required}.`);
  }
  for (const externalOnly of [
    `/bin/${identity.cliCommand}.cmd`,
    `/bin/${identity.cliCommand}`,
    `/bin/${identity.cliCommand}-cli.ps1`,
    `/bin/${identity.cliCommand}-cli.jxa.js`,
    `/desktop/cli/${identity.cliCommand}.cmd`,
    `/desktop/cli/${identity.cliCommand}`,
    `/desktop/cli/${identity.cliCommand}-cli.ps1`,
    `/desktop/cli/${identity.cliCommand}-cli.jxa.js`,
  ]) {
    if (entries.has(externalOnly)) failures.push(`CLI shim must remain outside app.asar: ${externalOnly}.`);
  }

  try {
    const packaged = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
    if (packaged.name !== identity.packageName) failures.push(`Packaged npm name is ${packaged.name ?? "missing"}.`);
    if (packaged.productName !== identity.productName) failures.push(`Packaged product name is ${packaged.productName ?? "missing"}.`);
    const expectedBuildChannel = process.env.WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD === "1" ? "mac-local-smoke" : "production";
    if (packaged.workFoldBuildChannel !== expectedBuildChannel) {
      failures.push(`Packaged build channel is ${packaged.workFoldBuildChannel ?? "missing"}; expected ${expectedBuildChannel}.`);
    }
  } catch (error) {
    failures.push(`Could not inspect packaged package.json: ${formatError(error)}`);
  }
}

if (failures.length) {
  console.error(`${identity.productName} package verification failed:\n`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified packaged ${identity.productName} app at ${packageDir}.`);

function findPackageDir() {
  if (!existsSync(outDir)) return null;
  const builderDir = join(outDir, "builder");
  const builderCandidates = existsSync(builderDir)
    ? readdirSync(builderDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === "win-unpacked" || /^mac(?:-|$)/.test(entry.name)))
      .map((entry) => join(builderDir, entry.name))
    : [];
  const candidates = [...builderCandidates, ...readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && new RegExp(`^${escapeRegExp(identity.productName)}-(?:win32|darwin|linux)-`).test(entry.name))
    .map((entry) => join(outDir, entry.name))]
    .filter((candidate) => existsSync(candidate));
  return candidates[0] ?? null;
}

function inferPackagedPlatform(packagePath) {
  if (packagePath.endsWith(".app") || existsSync(join(packagePath, `${identity.productName}.app`)) || existsSync(join(packagePath, `${identity.macSmokeProductName}.app`))) return "darwin";
  if (existsSync(join(packagePath, `${identity.productName}.exe`))) return "win32";
  return process.platform;
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertPath(path, label) {
  if (!existsSync(path)) failures.push(`Missing ${label}: ${path}.`);
}

function normalizeAsarPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
