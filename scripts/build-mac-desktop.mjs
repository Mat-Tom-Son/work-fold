import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertArtifactReceipt,
  assertCompatibleReleaseState,
  captureArtifactReceipt,
  computeReleaseFingerprint,
  formatDuration,
  nextIncompleteStage,
  readReleaseState,
  releaseStatePath,
  writeReleaseState,
} from "./mac-release-state.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
loadLocalReleaseEnvironment();
const builderCli = join(rootDir, "node_modules", "electron-builder", "out", "cli", "cli.js");
const releaseBuild = process.argv.includes("--release");
const unsignedSmokeBuild = process.argv.includes("--unsigned-smoke") || !releaseBuild;
const resumeBuild = process.argv.includes("--resume");
const arch = readOption("--arch") || (process.arch === "x64" ? "x64" : "arm64");
const version = String(packageJson.version ?? "").trim();
const builderDir = join(rootDir, "out", "builder");
const appPath = join(builderDir, `mac-${arch}`, `${identity.productName}.app`);
const artifactStem = `${identity.productName}-${version}-mac-${arch}`;
const packageArtifacts = [
  `out/builder/${artifactStem}.dmg`,
  `out/builder/${artifactStem}.dmg.blockmap`,
  `out/builder/${artifactStem}.zip`,
  `out/builder/${artifactStem}.zip.blockmap`,
  "out/builder/latest-mac.yml",
];
const stablePackageArtifacts = packageArtifacts.filter((path) => path.includes(".zip"));
const finalizedArtifacts = packageArtifacts.filter((path) => !path.includes(".zip"));
const manifestArtifacts = [
  `out/builder/${identity.productName}-mac-release-manifest.json`,
  `out/builder/${identity.productName}-mac-release-manifest.txt`,
];
const verifiedArtifacts = [...packageArtifacts, ...manifestArtifacts, "out/builder/SHA256SUMS-mac.txt"];

if (process.platform !== "darwin") throw new Error(`${identity.productName} macOS artifacts must be built on a Mac host.`);
if (releaseBuild && process.argv.includes("--unsigned-smoke")) throw new Error("Use either --release or --unsigned-smoke, not both.");
if (resumeBuild && !releaseBuild) throw new Error("Only a signed macOS release build can be resumed.");
if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}.`);
if (!version) throw new Error("package.json does not declare a macOS release version.");
if (releaseBuild) assertReleaseCredentials();

const envPatch = {
  WORKFOLD_DESKTOP_RELEASE_PLATFORM: "darwin",
  WORKFOLD_DESKTOP_RELEASE_ARCH: arch,
  WORKFOLD_DESKTOP_OUTPUT_DIR: "out/builder",
  ...(releaseBuild
    ? { WORKFOLD_MAC_RELEASE_BUILD: "1", WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD: "0", WORKFOLD_REQUIRE_CODE_SIGNING: "1" }
    : { WORKFOLD_MAC_RELEASE_BUILD: "0", WORKFOLD_ALLOW_UNSIGNED_MAC_BUILD: "1", WORKFOLD_REQUIRE_CODE_SIGNING: "0", CSC_IDENTITY_AUTO_DISCOVERY: "false" }),
};

if (releaseBuild) await buildResumableRelease();
else await buildUnsignedSmoke();

async function buildResumableRelease() {
  const descriptor = {
    productName: identity.productName,
    version,
    arch,
    mode: "release",
    nodeVersion: process.version,
    signIdentity: value(process.env.WORKFOLD_MAC_SIGN_IDENTITY || process.env.CSC_NAME),
    teamId: value(process.env.WORKFOLD_MAC_TEAM_ID || process.env.APPLE_TEAM_ID),
    feedOwner: value(process.env.WORKFOLD_MAC_RELEASE_OWNER) || identity.sourceRepositoryOwner,
    feedRepo: value(process.env.WORKFOLD_MAC_RELEASE_REPO) || identity.macReleaseRepositoryName,
  };
  const fingerprint = await computeReleaseFingerprint(rootDir, descriptor);
  const statePath = releaseStatePath(rootDir, identity.productName);
  let state;

  if (resumeBuild) {
    state = await readReleaseState(statePath);
    if (!state) throw new Error("No saved macOS release checkpoint exists. Run a fresh signed candidate first.");
    assertCompatibleReleaseState(state, descriptor, fingerprint);
    await validateResumeCheckpoint(state);
    console.log(`[${identity.productName} macOS release] Resuming at ${nextIncompleteStage(state) ?? "completed verification"}.`);
  } else {
    const prepare = await timedStage("prepare", () => runNpmScript("desktop:prepare", envPatch));
    await cleanMacArtifacts(arch);
    state = await writeReleaseState(statePath, {
      schemaVersion: 1,
      productName: identity.productName,
      descriptor,
      fingerprint,
      startedAt: new Date(Date.now() - prepare.durationMs).toISOString(),
      stages: { prepare },
    });
  }

  if (!state.stages.package?.completedAt) {
    await cleanMacArtifacts(arch);
    const result = await timedStage("package + sign + app notarization", runBuilder);
    state = await completeStage(statePath, state, "package", result, {
      stableReceipt: await captureArtifactReceipt(rootDir, stablePackageArtifacts),
      preFinalizeReceipt: await captureArtifactReceipt(rootDir, finalizedArtifacts),
    });
  }

  if (!state.stages["packaged-assets"]?.completedAt) {
    const result = await timedStage("packaged asset verification", verifyPackagedAssets);
    state = await completeStage(statePath, state, "packaged-assets", result);
  }

  if (!state.stages.finalize?.completedAt) {
    const result = await timedStage("DMG signing + notarization", () => runNpmScript("desktop:finalize:release:mac", envPatch));
    state = await completeStage(statePath, state, "finalize", result, {
      receipt: await captureArtifactReceipt(rootDir, finalizedArtifacts),
    });
  }

  if (!state.stages.manifest?.completedAt) {
    const result = await timedStage("release manifest", () => runNpmScript("desktop:manifest:release:mac", envPatch));
    state = await completeStage(statePath, state, "manifest", result, {
      receipt: await captureArtifactReceipt(rootDir, manifestArtifacts),
    });
  }

  if (!state.stages.verify?.completedAt) {
    const result = await timedStage("strict release verification", () => runNpmScript("desktop:verify:release:mac", envPatch));
    state = await completeStage(statePath, state, "verify", result, {
      receipt: await captureArtifactReceipt(rootDir, verifiedArtifacts),
    });
  }

  console.log(`[${identity.productName} macOS release] Candidate is complete. Later retries may use npm run desktop:make:mac:release:resume.`);

  async function runBuilder() {
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
  }

  async function verifyPackagedAssets() {
    await run(process.execPath, [
      join(rootDir, "scripts", "verify-packaged-app-assets.mjs"),
      "--platform",
      "darwin",
      "--package-dir",
      `out/builder/mac-${arch}`,
    ], envPatch);
  }

  async function validateResumeCheckpoint(savedState) {
    if (!savedState.stages.package?.completedAt) return;
    await assertSignedAppCheckpoint();
    if (savedState.stages.verify?.completedAt) {
      await assertArtifactReceipt(rootDir, savedState.stages.verify.receipt);
    } else if (savedState.stages.finalize?.completedAt) {
      await assertArtifactReceipt(rootDir, savedState.stages.package.stableReceipt);
      await assertArtifactReceipt(rootDir, savedState.stages.finalize.receipt);
    } else {
      await assertArtifactReceipt(rootDir, savedState.stages.package.stableReceipt);
      try {
        await assertArtifactReceipt(rootDir, savedState.stages.package.preFinalizeReceipt);
      } catch (error) {
        await assertTrustedInProgressDmg(error);
      }
    }
    if (!savedState.stages.verify?.completedAt && savedState.stages.manifest?.completedAt) {
      await assertArtifactReceipt(rootDir, savedState.stages.manifest.receipt);
    }
  }

  async function assertSignedAppCheckpoint() {
    if (!existsSync(appPath)) throw new Error(`Checkpointed release app is missing: ${appPath}.`);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
    await run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
    await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  }

  async function assertTrustedInProgressDmg(receiptError) {
    const dmgPath = join(builderDir, `${artifactStem}.dmg`);
    try {
      await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
      const signature = await execFileAsync("/usr/bin/codesign", ["--display", "--verbose=4", dmgPath], {
        cwd: rootDir,
        env: { ...process.env, ...envPatch },
      });
      const details = `${signature.stdout}\n${signature.stderr}`;
      const expectedIdentity = descriptor.signIdentity.replace(/^Developer ID Application:\s*/i, "");
      if (!details.includes(`Authority=Developer ID Application: ${expectedIdentity}`)) {
        throw new Error("the DMG signature does not match the configured Developer ID identity");
      }
      if (descriptor.teamId && !details.includes(`TeamIdentifier=${descriptor.teamId}`)) {
        throw new Error(`the DMG signature does not match Team ${descriptor.teamId}`);
      }
      console.log(`[${identity.productName} macOS release] DMG bytes changed during an interrupted finalization but retain the configured Developer ID signature; the idempotent finalizer will continue.`);
    } catch (signatureError) {
      throw new Error(
        `Checkpointed pre-finalization DMG changed and is not a trusted interrupted finalizer output. ${errorText(receiptError)} ${errorText(signatureError)}`,
      );
    }
  }
}

async function buildUnsignedSmoke() {
  await timedStage("prepare", () => runNpmScript("desktop:prepare", envPatch));
  await cleanMacArtifacts(arch);
  await timedStage("unsigned package", async () => {
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
  });
  await timedStage("packaged asset verification", async () => {
    await run(process.execPath, [
      join(rootDir, "scripts", "verify-packaged-app-assets.mjs"),
      "--platform",
      "darwin",
      "--package-dir",
      `out/builder/mac-${arch}`,
    ], envPatch);
  });
  await timedStage("release manifest", () => runNpmScript("desktop:manifest:release:mac", envPatch));
  await timedStage("strict release verification", () => runNpmScript("desktop:verify:release:mac", envPatch));
}

async function completeStage(path, state, name, result, extra = {}) {
  return writeReleaseState(path, {
    ...state,
    stages: {
      ...state.stages,
      [name]: { ...result, ...extra },
    },
  });
}

async function timedStage(label, action) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  console.log(`\n[${identity.productName} macOS release] Starting ${label}.`);
  await action();
  const durationMs = Math.round(performance.now() - started);
  console.log(`[${identity.productName} macOS release] Finished ${label} in ${formatDuration(durationMs)}.`);
  return { startedAt, completedAt: new Date().toISOString(), durationMs };
}

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

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function loadLocalReleaseEnvironment() {
  for (const filename of [".env", ".env.macos.local"]) {
    const path = join(rootDir, filename);
    if (existsSync(path)) loadEnvFile(path);
  }
}
