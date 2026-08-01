import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { formatDuration } from "./mac-release-state.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const arch = readOption("--arch") || (process.arch === "x64" ? "x64" : "arm64");
const outputDirectory = "out/mac-rc";
const packageDirectory = `${outputDirectory}/mac-${arch}`;
const appPath = `${packageDirectory}/${identity.productName}.app`;
const builderCli = join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js");

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS candidates must be built on a Mac host.`);
if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}.`);
assertReleaseCredentials();

const envPatch = {
  WORKFOLD_DESKTOP_RELEASE_PLATFORM: "darwin",
  WORKFOLD_DESKTOP_RELEASE_ARCH: arch,
  WORKFOLD_DESKTOP_OUTPUT_DIR: outputDirectory,
  WORKFOLD_MAC_RELEASE_BUILD: "1",
  WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD: "0",
  WORKFOLD_REQUIRE_CODE_SIGNING: "1",
};

await timedStage("prepare", () => runNpmScript("desktop:prepare", envPatch));
await rm(join(rootDir, outputDirectory), { recursive: true, force: true });
await timedStage("package + sign + app notarization", () => run(process.execPath, [
  builderCli,
  "--config",
  "electron-builder.desktop.cjs",
  "--mac",
  `--${arch}`,
  "--dir",
  "--publish",
  "never",
], envPatch));
await timedStage("packaged asset verification", () => run(process.execPath, [
  join(rootDir, "scripts", "verify-packaged-app-assets.mjs"),
  "--platform",
  "darwin",
  "--package-dir",
  packageDirectory,
], envPatch));
await timedStage("signed candidate verification", () => run(process.execPath, [
  join(rootDir, "scripts", "verify-mac-release-candidate.mjs"),
  "--app",
  appPath,
  "--arch",
  arch,
], envPatch));

console.log(`\nSigned and notarized ${identity.productName} release candidate: ${join(rootDir, appPath)}`);
console.log("This app-only candidate is for interactive QA; the public release lane still creates and verifies DMG/ZIP updater artifacts.");

function assertReleaseCredentials() {
  if (!value(process.env.WORKFOLD_MAC_SIGN_IDENTITY) && !value(process.env.CSC_NAME)) {
    throw new Error("Set WORKFOLD_MAC_SIGN_IDENTITY or CSC_NAME to a Developer ID Application identity.");
  }
  const hasApiKey = every("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER");
  const hasAppleId = every("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID");
  const hasKeychainProfile = Boolean(value(process.env.APPLE_KEYCHAIN_PROFILE));
  if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
    throw new Error("Configure one complete electron-builder notarization credential set before a signed candidate build.");
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

async function timedStage(label, action) {
  const started = performance.now();
  console.log(`\n[${identity.productName} macOS candidate] Starting ${label}.`);
  await action();
  console.log(`[${identity.productName} macOS candidate] Finished ${label} in ${formatDuration(performance.now() - started)}.`);
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
