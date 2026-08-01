import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertCompatibleReleaseState,
  computeReleaseFingerprint,
  nextIncompleteStage,
  readReleaseState,
  releaseStatePath,
  summarizeReleaseState,
} from "./mac-release-state.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
loadLocalReleaseEnvironment();
const identity = JSON.parse(readFileSync(join(rootDir, "src", "shared", "product-identity.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const arch = readOption("--arch") || (process.arch === "x64" ? "x64" : "arm64");
const descriptor = {
  productName: identity.productName,
  version: String(packageJson.version ?? "").trim(),
  arch,
  mode: "release",
  nodeVersion: process.version,
  signIdentity: value(process.env.WORKFOLD_MAC_SIGN_IDENTITY || process.env.CSC_NAME),
  teamId: value(process.env.WORKFOLD_MAC_TEAM_ID || process.env.APPLE_TEAM_ID),
  feedOwner: value(process.env.WORKFOLD_MAC_RELEASE_OWNER) || identity.sourceRepositoryOwner,
  feedRepo: value(process.env.WORKFOLD_MAC_RELEASE_REPO) || identity.macReleaseRepositoryName,
};
const path = releaseStatePath(rootDir, identity.productName);
const state = await readReleaseState(path);
let compatible = false;
let incompatibility = "";

if (state) {
  try {
    const fingerprint = await computeReleaseFingerprint(rootDir, descriptor);
    assertCompatibleReleaseState(state, descriptor, fingerprint);
    compatible = true;
  } catch (error) {
    incompatibility = error instanceof Error ? error.message : String(error);
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    statePath: path,
    exists: Boolean(state),
    compatible,
    incompatibility: incompatibility || null,
    nextStage: compatible ? nextIncompleteStage(state) : null,
    state,
  }, null, 2));
} else {
  console.log(summarizeReleaseState(state).join("\n"));
  if (state && !compatible) console.log(`\nNot resumable: ${incompatibility}`);
  else if (state) console.log("\nCheckpoint inputs match this checkout and release environment.");
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
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
