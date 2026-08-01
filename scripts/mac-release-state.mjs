import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAC_RELEASE_STATE_SCHEMA = 1;
export const MAC_RELEASE_STAGES = ["prepare", "package", "packaged-assets", "finalize", "manifest", "verify"];

const inputPaths = [
  "LICENSE",
  "package.json",
  "package-lock.json",
  "electron-builder.desktop.cjs",
  "tsconfig.desktop.json",
  "tsconfig.web.json",
  "vite.local.config.ts",
  "desktop",
  "scripts",
  "src",
  "web-local",
];

export function releaseStatePath(rootDir, productName) {
  return join(rootDir, "out", "builder", `${productName}-mac-release-state.json`);
}

export async function computeReleaseFingerprint(rootDir, descriptor) {
  const hash = createHash("sha256");
  hash.update(`${JSON.stringify(normalizeDescriptor(descriptor))}\n`);

  for (const relativePath of await listInputFiles(rootDir)) {
    hash.update(`${relativePath}\0`);
    hash.update(await readFile(join(rootDir, relativePath)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function readReleaseState(path) {
  if (!existsSync(path)) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`Invalid macOS release state file ${path}.`);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (parsed.schemaVersion !== MAC_RELEASE_STATE_SCHEMA) {
    throw new Error(`Unsupported macOS release state schema ${parsed.schemaVersion ?? "missing"} in ${path}.`);
  }
  if (!parsed.descriptor || typeof parsed.descriptor !== "object" || !parsed.stages || typeof parsed.stages !== "object") {
    throw new Error(`Malformed macOS release state in ${path}.`);
  }
  if (typeof parsed.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)) {
    throw new Error(`Malformed macOS release fingerprint in ${path}.`);
  }
  let foundIncompleteStage = false;
  for (const stage of MAC_RELEASE_STAGES) {
    const result = parsed.stages[stage];
    const completed = result && typeof result === "object" && typeof result.completedAt === "string";
    if (!completed) foundIncompleteStage = true;
    else if (foundIncompleteStage) throw new Error(`Out-of-order macOS release stages in ${path}.`);
  }
  return parsed;
}

export async function writeReleaseState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  const value = {
    ...state,
    schemaVersion: MAC_RELEASE_STATE_SCHEMA,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
  return value;
}

export async function captureArtifactReceipt(rootDir, paths) {
  const files = {};
  for (const path of paths) {
    const absolutePath = resolveInsideRoot(rootDir, path);
    const info = await lstat(absolutePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`Cannot checkpoint missing release artifact ${absolutePath}.`);
    files[relative(rootDir, absolutePath)] = {
      bytes: info.size,
      sha256: await sha256File(absolutePath),
    };
  }
  return files;
}

export async function assertArtifactReceipt(rootDir, receipt) {
  if (!receipt || typeof receipt !== "object" || !Object.keys(receipt).length) {
    throw new Error("The resumable macOS release checkpoint has no artifact receipt.");
  }
  for (const [path, expected] of Object.entries(receipt)) {
    const absolutePath = resolveInsideRoot(rootDir, path);
    const info = await lstat(absolutePath).catch(() => null);
    if (!info?.isFile()) throw new Error(`Checkpointed release artifact is missing: ${absolutePath}.`);
    if (info.size !== expected.bytes) throw new Error(`Checkpointed release artifact changed size: ${absolutePath}.`);
    const actual = await sha256File(absolutePath);
    if (actual !== expected.sha256) throw new Error(`Checkpointed release artifact changed contents: ${absolutePath}.`);
  }
}

export function assertCompatibleReleaseState(state, descriptor, fingerprint) {
  const expected = normalizeDescriptor(descriptor);
  const actual = normalizeDescriptor(state.descriptor ?? {});
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `The saved macOS release belongs to ${describeDescriptor(actual)}, not ${describeDescriptor(expected)}. Run a fresh release build.`,
    );
  }
  if (state.fingerprint !== fingerprint) {
    throw new Error("Release inputs changed after the saved macOS checkpoint. Run a fresh release build instead of resuming it.");
  }
}

export function nextIncompleteStage(state) {
  return MAC_RELEASE_STAGES.find((stage) => !state?.stages?.[stage]?.completedAt) ?? null;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export function summarizeReleaseState(state) {
  if (!state) return ["No resumable macOS release checkpoint exists."];
  const lines = [
    `${state.productName} ${state.descriptor.version} macOS ${state.descriptor.arch} release checkpoint`,
    `Inputs: ${state.fingerprint}`,
  ];
  for (const stage of MAC_RELEASE_STAGES) {
    const result = state.stages?.[stage];
    const duration = result?.durationMs === undefined ? "" : ` (${formatDuration(result.durationMs)})`;
    lines.push(`${result?.completedAt ? "done" : "next"}  ${stage}${duration}`);
    if (!result?.completedAt) break;
  }
  const next = nextIncompleteStage(state);
  lines.push(next ? `Resume at: ${next}` : "Release artifacts are fully built and verified; publication is the next operation.");
  return lines;
}

async function listInputFiles(rootDir) {
  const files = [];
  for (const path of inputPaths) {
    const absolutePath = join(rootDir, path);
    const info = await lstat(absolutePath).catch(() => null);
    if (!info) continue;
    if (info.isFile()) files.push(path);
    else if (info.isDirectory()) await walk(rootDir, absolutePath, files);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function walk(rootDir, directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === ".DS_Store") continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) await walk(rootDir, absolutePath, files);
    else if (entry.isFile()) files.push(relative(rootDir, absolutePath));
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function resolveInsideRoot(rootDir, path) {
  const absoluteRoot = resolve(rootDir);
  const absolutePath = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Release artifact path escapes the repository: ${path}.`);
  }
  return absolutePath;
}

function normalizeDescriptor(descriptor) {
  return {
    productName: String(descriptor.productName ?? ""),
    version: String(descriptor.version ?? ""),
    arch: String(descriptor.arch ?? ""),
    mode: String(descriptor.mode ?? ""),
    nodeVersion: String(descriptor.nodeVersion ?? ""),
    signIdentity: String(descriptor.signIdentity ?? ""),
    teamId: String(descriptor.teamId ?? ""),
    feedOwner: String(descriptor.feedOwner ?? ""),
    feedRepo: String(descriptor.feedRepo ?? ""),
  };
}

function describeDescriptor(descriptor) {
  return `${descriptor.mode || "unknown"} ${descriptor.version || "unknown"} ${descriptor.arch || "unknown"}`;
}
