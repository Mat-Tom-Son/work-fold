import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
loadLocalReleaseEnvironment();
const builderCli = join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js");
const releaseBuild = process.argv.includes("--release");
const unsignedSmokeBuild = process.argv.includes("--unsigned-smoke") || !releaseBuild;
const arch = readOption("--arch") || (process.arch === "x64" ? "x64" : "arm64");

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS artifacts must be built on a Mac host.`);
if (releaseBuild && process.argv.includes("--unsigned-smoke")) throw new Error("Use either --release or --unsigned-smoke, not both.");
if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}.`);
if (releaseBuild) assertReleaseCredentials();

const envPatch = {
  WORKFOLD_DESKTOP_RELEASE_PLATFORM: "darwin",
  WORKFOLD_DESKTOP_RELEASE_ARCH: arch,
  ...(releaseBuild
    ? { WORKFOLD_MAC_RELEASE_BUILD: "1", WORKFOLD_REQUIRE_CODE_SIGNING: "1" }
    : { WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD: "1", CSC_IDENTITY_AUTO_DISCOVERY: "false" }),
};

await runNpmScript("desktop:prepare", envPatch);
await cleanMacArtifacts(arch);
await run(process.execPath, [
  builderCli,
  "--config",
  "electron-builder.desktop.cjs",
  "--mac",
  "dmg",
  "zip",
  `--${arch}`,
  "--publish",
  "never",
], envPatch);
await run(process.execPath, [
  join(rootDir, "scripts", "verify-packaged-app-assets.mjs"),
  "--platform",
  "darwin",
  "--package-dir",
  `out/builder/mac-${arch}`,
], envPatch);
if (releaseBuild) await runNpmScript("desktop:finalize:release:mac", envPatch);
await runNpmScript("desktop:manifest:release:mac", envPatch);
await runNpmScript("desktop:verify:release:mac", envPatch);

function assertReleaseCredentials() {
  if (!value(process.env.WORKFOLD_MAC_SIGN_IDENTITY) && !value(process.env.CSC_NAME)) {
    throw new Error("Set WORKFOLD_MAC_SIGN_IDENTITY or CSC_NAME to a Developer ID Application identity.");
  }
  const hasApiKey = every("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER");
  const hasAppleId = every("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID");
  const hasKeychainProfile = Boolean(value(process.env.APPLE_KEYCHAIN_PROFILE));
  if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
    throw new Error("Configure one complete electron-builder notarization credential set before a release build.");
  }
}

async function cleanMacArtifacts(targetArch) {
  const builderDir = join(rootDir, "out", "builder");
  await rm(join(builderDir, `mac-${targetArch}`), { recursive: true, force: true });
  if (!existsSync(builderDir)) return;
  const artifactPattern = new RegExp(`^${identity.productName}-.+-mac-${targetArch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:dmg|zip)(?:\\.blockmap)?$`);
  for (const entry of await readdir(builderDir, { withFileTypes: true })) {
    if (entry.isFile() && (
      artifactPattern.test(entry.name)
      || entry.name === "latest-mac.yml"
      || entry.name === "SHA256SUMS-mac.txt"
      || entry.name === `${identity.productName}-mac-release-manifest.json`
      || entry.name === `${identity.productName}-mac-release-manifest.txt`
    )) {
      await rm(join(builderDir, entry.name), { force: true });
    }
  }
}

function runNpmScript(scriptName, patch) {
  const npm = resolveNpmInvocation();
  return run(npm.command, [...npm.argsPrefix, "run", scriptName], patch);
}

function run(command, args, patch = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...patch },
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (signal) rejectPromise(new Error(`${command} exited with signal ${signal}.`));
      else if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? 1}.`));
    });
  });
}

function resolveNpmInvocation() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, argsPrefix: [process.env.npm_execpath] };
  }
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return existsSync(npmCli) ? { command: process.execPath, argsPrefix: [npmCli] } : { command: "npm", argsPrefix: [] };
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function every(...names) {
  return names.every((name) => value(process.env[name]));
}

function value(input) {
  return typeof input === "string" ? input.trim() : "";
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
