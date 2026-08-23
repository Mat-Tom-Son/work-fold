import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  createFullHistoryCapturePolicy,
  createTargetedHistoryCapturePolicy,
  type HistoryCapturePolicy,
} from "./history-capture-policy.js";
import { isOfficeLockFileName } from "./office-lock-files.js";
import { spaceHistoryRoot } from "./state-paths.js";
import { assertSpaceDoesNotContainState, ensureSafeSpaceRoot, resolveSpacePath } from "./space.js";

export interface CheckpointFileEntry {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface CheckpointMove {
  fromPath: string;
  toPath: string;
}

export interface CheckpointSkippedFile {
  path: string;
  sizeBytes: number;
  reason: "too_large" | "unreadable" | "symbolic_link" | "excluded";
}

export interface SpaceCheckpoint {
  schemaVersion: "0.2.0";
  checkpointId: string;
  createdAt: string;
  label?: string;
  reason: string;
  scope: "full" | "targeted";
  manifestHash: string;
  fileCount: number;
  totalBytes: number;
  skippedLargeFiles: string[];
  skippedFiles: CheckpointSkippedFile[];
  captureRoots: string[];
  deleteOnRestore: string[];
  movesOnRestore: CheckpointMove[];
  directories: string[];
  files: CheckpointFileEntry[];
}

export interface SpaceFileVersion {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
  source: "checkpoint";
}

export interface SpaceRestoreResult {
  restored: true;
  checkpointId: string;
  safetyCheckpointId: string;
  restoredFiles: string[];
  deletedFiles: string[];
  movedEntries: CheckpointMove[];
  unchangedFiles: number;
  skippedLargeFiles: string[];
}

export interface StoredBlobRef {
  hashSha256: string;
  sizeBytes: number;
}

const checkpointIdPattern = /^cp-[A-Za-z0-9-]{10,80}$/;
/** Files hashed concurrently during a capture; bounds memory for in-memory reads. */
const captureHashConcurrency = 8;
/** Files at or above this size are hashed from a stream instead of being read whole. */
const captureStreamHashBytes = 8 * 1024 * 1024;

export async function storeSpaceBlob(spaceRoot: string, bytes: Buffer): Promise<StoredBlobRef> {
  const root = ensureHistoryRoot(spaceRoot);
  const hashSha256 = sha256(bytes);
  const blobPath = spaceBlobPath(root, hashSha256);
  if (!existsSync(blobPath)) {
    await mkdir(dirname(blobPath), { recursive: true });
    const stagingPath = `${blobPath}.tmp-${randomUUID().slice(0, 8)}`;
    await writeFile(stagingPath, bytes);
    try {
      await rename(stagingPath, blobPath);
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined);
      if (!existsSync(blobPath)) throw error;
    }
  }
  await ensureHistoryMeta(root);
  return { hashSha256, sizeBytes: bytes.byteLength };
}

/**
 * Captures one Space file into the blob store without holding large files in
 * memory. The common case — content already stored — costs one streamed read.
 * A new blob is copied (a clone on APFS) into a private staging file and then
 * hashed again from that copy, so the stored bytes always match the recorded
 * hash even if the source file changes mid-capture.
 */
async function storeSpaceBlobFromFile(root: string, absolutePath: string, sizeBytes: number): Promise<StoredBlobRef> {
  if (sizeBytes < captureStreamHashBytes) {
    return storeSpaceBlob(root, await readFile(absolutePath));
  }
  const hashSha256 = await sha256File(absolutePath);
  const blobPath = spaceBlobPath(root, hashSha256);
  if (existsSync(blobPath)) {
    await ensureHistoryMeta(root);
    return { hashSha256, sizeBytes };
  }
  await mkdir(dirname(blobPath), { recursive: true });
  const stagingPath = `${blobPath}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    await copyFile(absolutePath, stagingPath);
    const stagedHash = await sha256File(stagingPath);
    const stagedInfo = await stat(stagingPath);
    const finalPath = spaceBlobPath(root, stagedHash);
    if (existsSync(finalPath)) {
      await rm(stagingPath, { force: true });
    } else {
      await mkdir(dirname(finalPath), { recursive: true });
      try {
        await rename(stagingPath, finalPath);
      } catch (error) {
        await rm(stagingPath, { force: true }).catch(() => undefined);
        if (!existsSync(finalPath)) throw error;
      }
    }
    await ensureHistoryMeta(root);
    return { hashSha256: stagedHash, sizeBytes: stagedInfo.size };
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

export async function captureSpaceBlobSafe(spaceRoot: string, bytes: Buffer): Promise<StoredBlobRef | null> {
  if (bytes.byteLength > maxVersionedFileBytes()) return null;
  try {
    return await storeSpaceBlob(spaceRoot, bytes);
  } catch {
    return null;
  }
}

export async function readSpaceBlob(spaceRoot: string, hashSha256: string): Promise<Buffer | null> {
  const root = ensureHistoryRoot(spaceRoot);
  const normalized = normalizeHash(hashSha256);
  const bytes = await readFile(spaceBlobPath(root, normalized)).catch(() => null);
  if (!bytes || sha256(bytes) !== normalized) return null;
  return bytes;
}

export async function createSpaceCheckpoint(
  spaceRoot: string,
  options: { label?: string; reason?: string } = {},
): Promise<SpaceCheckpoint> {
  const root = ensureHistoryRoot(spaceRoot);
  const captured = await capturePaths(root, [""], await createFullHistoryCapturePolicy(root));
  return persistCheckpoint(root, {
    reason: options.reason?.trim() || "manual",
    label: options.label,
    scope: "full",
    captureRoots: [],
    deleteOnRestore: [],
    movesOnRestore: [],
    ...captured,
  });
}

export async function createSpaceMutationCheckpoint(
  spaceRoot: string,
  options: {
    paths?: string[];
    deleteOnRestore?: string[];
    movesOnRestore?: CheckpointMove[];
    label?: string;
    reason?: string;
  },
): Promise<SpaceCheckpoint> {
  const root = ensureHistoryRoot(spaceRoot);
  const captureRoots = collapsePaths((options.paths ?? []).map((path) => canonicalPath(root, path, true).path));
  const deleteOnRestore = collapsePaths((options.deleteOnRestore ?? []).map((path) => canonicalPath(root, path, true).path));
  const movesOnRestore = (options.movesOnRestore ?? []).map((move) => ({
    fromPath: canonicalPath(root, move.fromPath, true).path,
    toPath: canonicalPath(root, move.toPath, true).path,
  }));
  const captured = await capturePaths(root, captureRoots, createTargetedHistoryCapturePolicy());
  return persistCheckpoint(root, {
    reason: options.reason?.trim() || "mutation",
    label: options.label,
    scope: "targeted",
    captureRoots,
    deleteOnRestore,
    movesOnRestore,
    ...captured,
  });
}

export async function listSpaceCheckpoints(spaceRoot: string, limit = 50): Promise<SpaceCheckpoint[]> {
  const root = ensureHistoryRoot(spaceRoot);
  return (await readCheckpointManifests(root)).slice(0, Math.min(Math.max(limit, 1), 1000));
}

export async function getSpaceCheckpoint(spaceRoot: string, checkpointId: string): Promise<SpaceCheckpoint | null> {
  if (!checkpointIdPattern.test(checkpointId)) return null;
  const root = ensureHistoryRoot(spaceRoot);
  return readCheckpointManifest(join(checkpointsDir(root), `${checkpointId}.json`));
}

export async function discardSpaceCheckpoint(spaceRoot: string, checkpointId: string): Promise<void> {
  if (!checkpointIdPattern.test(checkpointId)) return;
  const root = ensureHistoryRoot(spaceRoot);
  await rm(join(checkpointsDir(root), `${checkpointId}.json`), { force: true });
  await garbageCollectObjects(root, await readCheckpointManifests(root));
}

export async function restoreSpaceCheckpoint(spaceRoot: string, checkpointId: string): Promise<SpaceRestoreResult> {
  const root = ensureHistoryRoot(spaceRoot);
  const checkpoint = await getSpaceCheckpoint(root, checkpointId);
  if (!checkpoint) throw notFound("Restore point not found.");
  validateCheckpointPaths(root, checkpoint);
  const staged = await stageCheckpointContent(root, checkpoint);
  try {
    await preflightRestore(root, checkpoint);

    const safety = checkpoint.scope === "full"
      ? await createSpaceCheckpoint(root, { reason: "pre_restore", label: `Before restoring ${checkpointId}` })
      : await createTargetedRestoreSafety(root, checkpoint);

    const movedEntries: CheckpointMove[] = [];
    for (const move of checkpoint.movesOnRestore) {
      const from = canonicalPath(root, move.fromPath, false).absolutePath;
      const to = canonicalPath(root, move.toPath, true).absolutePath;
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      movedEntries.push(move);
    }

    const deletedFiles: string[] = [];
    for (const path of collapsePaths(checkpoint.deleteOnRestore)) {
      const target = canonicalPath(root, path, true).absolutePath;
      if (!existsSync(target)) continue;
      await rm(target, { recursive: true, force: true });
      deletedFiles.push(path);
    }

    for (const directory of checkpoint.directories) {
      await mkdir(canonicalPath(root, directory, true).absolutePath, { recursive: true });
    }

    const current = checkpoint.scope === "full"
      ? new Map(safety.files.map((file) => [file.path, file]))
      : new Map<string, CheckpointFileEntry>();
    const restoredFiles: string[] = [];
    let unchangedFiles = 0;
    for (const file of checkpoint.files) {
      if (current.get(file.path)?.hashSha256 === file.hashSha256) {
        unchangedFiles += 1;
        continue;
      }
      const bytes = await readFile(staged.pathsByHash.get(file.hashSha256)!);
      const target = canonicalPath(root, file.path, true).absolutePath;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      restoredFiles.push(file.path);
    }

    if (checkpoint.scope === "full") {
      const selectedPaths = new Set(checkpoint.files.map((file) => file.path));
      const selectedSkipped = new Set(checkpoint.skippedFiles.map((file) => file.path));
      for (const file of safety.files) {
        if (selectedPaths.has(file.path) || selectedSkipped.has(file.path)) continue;
        const target = canonicalPath(root, file.path, false).absolutePath;
        await rm(target, { force: true });
        deletedFiles.push(file.path);
      }
    }

    return {
      restored: true,
      checkpointId,
      safetyCheckpointId: safety.checkpointId,
      restoredFiles: restoredFiles.sort(),
      deletedFiles: [...new Set(deletedFiles)].sort(),
      movedEntries,
      unchangedFiles,
      skippedLargeFiles: checkpoint.skippedLargeFiles,
    };
  } finally {
    await rm(staged.root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function listFileVersions(
  spaceRoot: string,
  relativePath: string,
  limit = 50,
): Promise<SpaceFileVersion[]> {
  const root = ensureHistoryRoot(spaceRoot);
  const path = canonicalPath(root, relativePath, true).path;
  const versions: SpaceFileVersion[] = [];
  const seen = new Set<string>();
  for (const checkpoint of await listSpaceCheckpoints(root, 1000)) {
    const file = checkpoint.files.find((entry) => entry.path === path);
    if (!file || seen.has(file.hashSha256) || !(await hasSpaceBlob(root, file.hashSha256))) continue;
    seen.add(file.hashSha256);
    versions.push({
      path,
      hashSha256: file.hashSha256,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
      capturedAt: checkpoint.createdAt,
      checkpointId: checkpoint.checkpointId,
      ...(checkpoint.label ? { checkpointLabel: checkpoint.label } : {}),
      source: "checkpoint",
    });
    if (versions.length >= Math.min(Math.max(limit, 1), 200)) break;
  }
  return versions;
}

export async function restoreFileVersion(
  spaceRoot: string,
  relativePath: string,
  hashSha256: string,
): Promise<{ restored: true; path: string; hashSha256: string; previousHashSha256: string | null; safetyCheckpointId: string }> {
  const root = ensureHistoryRoot(spaceRoot);
  const { path, absolutePath } = canonicalPath(root, relativePath, true);
  const normalizedHash = normalizeHash(hashSha256);
  const bytes = await readSpaceBlob(root, normalizedHash);
  if (!bytes) throw notFound("File version not found.");
  const currentInfo = await stat(absolutePath).catch(() => null);
  if (currentInfo && !currentInfo.isFile()) throw new Error("The selected path is currently a folder.");
  const currentBytes = currentInfo?.isFile() ? await readFile(absolutePath) : null;
  const safety = await createSpaceMutationCheckpoint(root, {
    paths: currentBytes ? [path] : [],
    deleteOnRestore: currentBytes ? [] : [path],
    reason: "pre_file_restore",
    label: `Before restoring ${path}`,
  });
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, bytes);
  return {
    restored: true,
    path,
    hashSha256: normalizedHash,
    previousHashSha256: currentBytes ? sha256(currentBytes) : null,
    safetyCheckpointId: safety.checkpointId,
  };
}

async function capturePaths(root: string, requestedPaths: string[], policy: HistoryCapturePolicy): Promise<{
  directories: string[];
  files: CheckpointFileEntry[];
  skippedFiles: CheckpointSkippedFile[];
}> {
  const directories = new Set<string>();
  const files = new Map<string, CheckpointFileEntry>();
  const skipped = new Map<string, CheckpointSkippedFile>();
  const pendingFiles: Array<{ path: string; absolutePath: string; sizeBytes: number; modifiedAt: string }> = [];

  const visit = async (absolutePath: string): Promise<void> => {
    const info = await lstat(absolutePath).catch(() => null);
    if (!info) return;
    const path = toPosix(relative(root, absolutePath));
    if (info.isSymbolicLink()) {
      if (path) skipped.set(path, { path, sizeBytes: 0, reason: "symbolic_link" });
      return;
    }
    if (info.isDirectory()) {
      if (path && await policy.excludeDirectory(path, absolutePath)) {
        skipped.set(path, { path, sizeBytes: 0, reason: "excluded" });
        return;
      }
      if (path) directories.add(path);
      await policy.enterDirectory(path, absolutePath);
      const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (isOfficeLockFileName(entry.name)) continue;
        await visit(join(absolutePath, entry.name));
      }
      return;
    }
    if (!info.isFile() || !path) return;
    if (policy.excludeFile(path)) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "excluded" });
      return;
    }
    if (info.size > maxVersionedFileBytes()) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "too_large" });
      return;
    }
    pendingFiles.push({ path, absolutePath, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() });
  };

  if (requestedPaths.includes("")) await visit(root);
  else for (const path of collapsePaths(requestedPaths)) await visit(canonicalPath(root, path, true).absolutePath);

  // History is a recovery boundary, so metadata is never treated as proof of
  // content identity. External tools can preserve both size and mtime while
  // replacing bytes; every capture hashes what is actually on disk. The hashing
  // itself runs a bounded number of files at a time.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pendingFiles.length) {
      const file = pendingFiles[next]!;
      next += 1;
      try {
        const blob = await storeSpaceBlobFromFile(root, file.absolutePath, file.sizeBytes);
        files.set(file.path, { path: file.path, hashSha256: blob.hashSha256, sizeBytes: blob.sizeBytes, modifiedAt: file.modifiedAt });
      } catch {
        skipped.set(file.path, { path: file.path, sizeBytes: file.sizeBytes, reason: "unreadable" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(captureHashConcurrency, pendingFiles.length) }, () => worker()));

  return {
    directories: [...directories].sort((left, right) => left.localeCompare(right)),
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    skippedFiles: [...skipped.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function persistCheckpoint(root: string, input: {
  reason: string;
  label?: string;
  scope: "full" | "targeted";
  captureRoots: string[];
  deleteOnRestore: string[];
  movesOnRestore: CheckpointMove[];
  directories: string[];
  files: CheckpointFileEntry[];
  skippedFiles: CheckpointSkippedFile[];
}): Promise<SpaceCheckpoint> {
  const material = {
    scope: input.scope,
    captureRoots: input.captureRoots,
    deleteOnRestore: input.deleteOnRestore,
    movesOnRestore: input.movesOnRestore,
    directories: input.directories,
    files: input.files.map(({ path, hashSha256 }) => ({ path, hashSha256 })),
    skippedFiles: input.skippedFiles,
  };
  const manifestHash = sha256(Buffer.from(stableJson(material), "utf8"));
  const [latest] = await listSpaceCheckpoints(root, 1);
  if (input.scope === "full" && latest?.scope === "full" && latest.manifestHash === manifestHash) return latest;

  const createdAt = new Date().toISOString();
  const checkpoint: SpaceCheckpoint = {
    schemaVersion: "0.2.0",
    checkpointId: `cp-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`,
    createdAt,
    ...(input.label?.trim() ? { label: input.label.trim().slice(0, 160) } : {}),
    reason: input.reason,
    scope: input.scope,
    manifestHash,
    fileCount: input.files.length,
    totalBytes: input.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    skippedLargeFiles: input.skippedFiles.filter((file) => file.reason === "too_large").map((file) => file.path),
    skippedFiles: input.skippedFiles,
    captureRoots: input.captureRoots,
    deleteOnRestore: input.deleteOnRestore,
    movesOnRestore: input.movesOnRestore,
    directories: input.directories,
    files: input.files,
  };
  await atomicJsonWrite(join(checkpointsDir(root), `${checkpoint.checkpointId}.json`), checkpoint);
  await ensureHistoryMeta(root);
  await pruneHistory(root);
  return checkpoint;
}

async function createTargetedRestoreSafety(root: string, checkpoint: SpaceCheckpoint): Promise<SpaceCheckpoint> {
  const affectedRoots = collapsePaths([...checkpoint.captureRoots, ...checkpoint.deleteOnRestore]);
  const existing: string[] = [];
  const deleteOnRestore: string[] = [];
  for (const path of affectedRoots) {
    if (existsSync(canonicalPath(root, path, true).absolutePath)) existing.push(path);
    else deleteOnRestore.push(path);
  }
  return createSpaceMutationCheckpoint(root, {
    paths: existing,
    deleteOnRestore,
    movesOnRestore: checkpoint.movesOnRestore.map((move) => ({ fromPath: move.toPath, toPath: move.fromPath })),
    reason: "pre_restore",
    label: `Before restoring ${checkpoint.checkpointId}`,
  });
}

async function preflightRestore(root: string, checkpoint: SpaceCheckpoint): Promise<void> {
  for (const move of checkpoint.movesOnRestore) {
    const from = canonicalPath(root, move.fromPath, false).absolutePath;
    const to = canonicalPath(root, move.toPath, true).absolutePath;
    if (!existsSync(from)) throw new Error(`Cannot undo move because ${move.fromPath} no longer exists.`);
    if (existsSync(to)) throw new Error(`Cannot undo move because ${move.toPath} already exists.`);
  }
  const deletedRoots = collapsePaths(checkpoint.deleteOnRestore);
  for (const file of checkpoint.files) {
    const target = canonicalPath(root, file.path, true).absolutePath;
    const info = await stat(target).catch(() => null);
    const isDeletedFirst = deletedRoots.some((path) => file.path === path || file.path.startsWith(`${path}/`));
    if (info?.isDirectory() && !isDeletedFirst) throw new Error(`Cannot restore file over folder: ${file.path}`);
  }
}

function validateCheckpointPaths(root: string, checkpoint: SpaceCheckpoint): void {
  for (const directory of checkpoint.directories) canonicalPath(root, directory, true);
  for (const file of checkpoint.files) canonicalPath(root, file.path, true);
  for (const path of checkpoint.captureRoots) canonicalPath(root, path, true);
  for (const path of checkpoint.deleteOnRestore) canonicalPath(root, path, true);
  for (const move of checkpoint.movesOnRestore) {
    canonicalPath(root, move.fromPath, true);
    canonicalPath(root, move.toPath, true);
  }
}

async function pruneHistory(root: string): Promise<void> {
  const checkpoints = await readCheckpointManifests(root);
  const retained = checkpoints.slice(0, maxRetainedCheckpoints());
  const removed = checkpoints.slice(retained.length);
  if (!removed.length) return;
  for (const checkpoint of removed) await rm(join(checkpointsDir(root), `${checkpoint.checkpointId}.json`), { force: true });
  await garbageCollectObjects(root, retained);
}

async function garbageCollectObjects(root: string, retained: SpaceCheckpoint[]): Promise<void> {
  const referenced = new Set(retained.flatMap((checkpoint) => checkpoint.files.map((file) => file.hashSha256)));
  const objectsRoot = join(spaceHistoryRoot(root), "objects");
  for (const prefix of await readdir(objectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!prefix.isDirectory()) continue;
    const directory = join(objectsRoot, prefix.name);
    for (const object of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!object.isFile()) continue;
      const hash = `${prefix.name}${object.name}`;
      if (!referenced.has(hash)) await rm(join(directory, object.name), { force: true });
    }
    if (!(await readdir(directory).catch(() => [])).length) await rm(directory, { recursive: true, force: true });
  }
}

async function stageCheckpointContent(
  root: string,
  checkpoint: SpaceCheckpoint,
): Promise<{ root: string; pathsByHash: Map<string, string> }> {
  const stagingRoot = join(spaceHistoryRoot(root), "restore-staging", randomUUID());
  const pathsByHash = new Map<string, string>();
  const missing: string[] = [];
  await mkdir(stagingRoot, { recursive: true });
  try {
    for (const file of checkpoint.files) {
      if (pathsByHash.has(file.hashSha256)) continue;
      const bytes = await readSpaceBlob(root, file.hashSha256);
      if (!bytes) {
        missing.push(file.path);
        continue;
      }
      const path = join(stagingRoot, normalizeHash(file.hashSha256));
      await writeFile(path, bytes);
      pathsByHash.set(file.hashSha256, path);
    }
    if (missing.length) {
      throw new Error(`Restore point is missing saved content for ${missing.sort().join(", ")}. No files were changed.`);
    }
    return { root: stagingRoot, pathsByHash };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readCheckpointManifests(root: string): Promise<SpaceCheckpoint[]> {
  const entries = await readdir(checkpointsDir(root)).catch(() => [] as string[]);
  const checkpoints: SpaceCheckpoint[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const checkpoint = await readCheckpointManifest(join(checkpointsDir(root), name));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.checkpointId.localeCompare(left.checkpointId));
}

async function readCheckpointManifest(path: string): Promise<SpaceCheckpoint | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SpaceCheckpoint>;
    if (value.schemaVersion !== "0.2.0" || !checkpointIdPattern.test(value.checkpointId ?? "") || !Array.isArray(value.files)) return null;
    return { ...value, directories: Array.isArray(value.directories) ? value.directories : [] } as SpaceCheckpoint;
  } catch {
    return null;
  }
}

async function hasSpaceBlob(root: string, hashSha256: string): Promise<boolean> {
  try {
    return existsSync(spaceBlobPath(root, hashSha256));
  } catch {
    return false;
  }
}

function canonicalPath(root: string, value: string, allowMissing: boolean): { path: string; absolutePath: string } {
  const absolutePath = resolveSpacePath(root, toPosix(value).replace(/^\/+/, "") || ".");
  const path = toPosix(relative(root, absolutePath));
  if (!path || path === ".") throw new Error("The Space root cannot be used as a history item.");
  if (!allowMissing && !existsSync(absolutePath)) throw notFound(`Space item not found: ${path}`);
  return { path, absolutePath };
}

function collapsePaths(paths: string[]): string[] {
  const sorted = [...new Set(paths.filter(Boolean))].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => path === parent || path.startsWith(`${parent}/`)));
}

function ensureHistoryRoot(spaceRoot: string): string {
  const root = ensureSafeSpaceRoot(spaceRoot);
  assertSpaceDoesNotContainState(root);
  return root;
}

function spaceBlobPath(root: string, hashSha256: string): string {
  const normalized = normalizeHash(hashSha256);
  return join(spaceHistoryRoot(root), "objects", normalized.slice(0, 2), normalized.slice(2));
}

function checkpointsDir(root: string): string {
  return join(spaceHistoryRoot(root), "checkpoints");
}

async function ensureHistoryMeta(root: string): Promise<void> {
  const path = join(spaceHistoryRoot(root), "meta.json");
  if (existsSync(path)) return;
  await atomicJsonWrite(path, { schemaVersion: "0.2.0", spaceRoot: resolve(root), createdAt: new Date().toISOString() });
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function maxVersionedFileBytes(): number {
  const configured = Number(process.env.WORKFOLD_HISTORY_MAX_FILE_BYTES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 100 * 1024 * 1024;
}

function maxRetainedCheckpoints(): number {
  const configured = Number(process.env.WORKFOLD_HISTORY_MAX_CHECKPOINTS);
  return Number.isFinite(configured) && configured >= 2 ? Math.min(Math.floor(configured), 500) : 100;
}

function normalizeHash(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error("Invalid history object hash.");
  return normalized;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}
