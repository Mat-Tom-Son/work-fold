import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { isOfficeLockFileName } from "./office-lock-files.js";
import { workspaceHistoryRoot } from "./state-paths.js";
import { assertWorkspaceDoesNotContainState, ensureSafeWorkspaceRoot, resolveWorkspacePath } from "./workspace.js";

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

export interface WorkspaceCheckpoint {
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

export interface WorkspaceFileVersion {
  path: string;
  hashSha256: string;
  sizeBytes: number;
  modifiedAt: string;
  capturedAt: string;
  checkpointId: string;
  checkpointLabel?: string;
  source: "checkpoint";
}

export interface WorkspaceRestoreResult {
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
const versionScopeSkippedSegments = new Set([".git", ".pi", ".workspace", "node_modules"]);
const maxCaptureReuseManifests = 20;
const legacyMetadataName = "checkpoint.json";
const legacySnapshotDirName = "files";

export async function storeWorkspaceBlob(workspaceRoot: string, bytes: Buffer): Promise<StoredBlobRef> {
  const root = ensureHistoryRoot(workspaceRoot);
  const hashSha256 = sha256(bytes);
  const blobPath = workspaceBlobPath(root, hashSha256);
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

export async function captureWorkspaceBlobSafe(workspaceRoot: string, bytes: Buffer): Promise<StoredBlobRef | null> {
  if (bytes.byteLength > maxVersionedFileBytes()) return null;
  try {
    return await storeWorkspaceBlob(workspaceRoot, bytes);
  } catch {
    return null;
  }
}

export async function readWorkspaceBlob(workspaceRoot: string, hashSha256: string): Promise<Buffer | null> {
  const root = ensureHistoryRoot(workspaceRoot);
  const normalized = normalizeHash(hashSha256);
  const bytes = await readFile(workspaceBlobPath(root, normalized)).catch(() => null);
  if (!bytes || sha256(bytes) !== normalized) return null;
  return bytes;
}

export async function createWorkspaceCheckpoint(
  workspaceRoot: string,
  options: { label?: string; reason?: string } = {},
): Promise<WorkspaceCheckpoint> {
  const root = ensureHistoryRoot(workspaceRoot);
  const captured = await capturePaths(root, [""], true);
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

export async function createWorkspaceMutationCheckpoint(
  workspaceRoot: string,
  options: {
    paths?: string[];
    deleteOnRestore?: string[];
    movesOnRestore?: CheckpointMove[];
    label?: string;
    reason?: string;
  },
): Promise<WorkspaceCheckpoint> {
  const root = ensureHistoryRoot(workspaceRoot);
  const captureRoots = collapsePaths((options.paths ?? []).map((path) => canonicalPath(root, path, true).path));
  const deleteOnRestore = collapsePaths((options.deleteOnRestore ?? []).map((path) => canonicalPath(root, path, true).path));
  const movesOnRestore = (options.movesOnRestore ?? []).map((move) => ({
    fromPath: canonicalPath(root, move.fromPath, true).path,
    toPath: canonicalPath(root, move.toPath, true).path,
  }));
  const captured = await capturePaths(root, captureRoots, false);
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

export async function listWorkspaceCheckpoints(workspaceRoot: string, limit = 50): Promise<WorkspaceCheckpoint[]> {
  const root = ensureHistoryRoot(workspaceRoot);
  await migrateLegacyCheckpoints(root);
  return (await readCheckpointManifests(root)).slice(0, Math.min(Math.max(limit, 1), 1000));
}

export async function getWorkspaceCheckpoint(workspaceRoot: string, checkpointId: string): Promise<WorkspaceCheckpoint | null> {
  if (!checkpointIdPattern.test(checkpointId)) return null;
  const root = ensureHistoryRoot(workspaceRoot);
  await migrateLegacyCheckpoints(root);
  return readCheckpointManifest(join(checkpointsDir(root), `${checkpointId}.json`));
}

export async function discardWorkspaceCheckpoint(workspaceRoot: string, checkpointId: string): Promise<void> {
  if (!checkpointIdPattern.test(checkpointId)) return;
  const root = ensureHistoryRoot(workspaceRoot);
  await rm(join(checkpointsDir(root), `${checkpointId}.json`), { force: true });
  await garbageCollectObjects(root, await readCheckpointManifests(root));
}

export async function restoreWorkspaceCheckpoint(workspaceRoot: string, checkpointId: string): Promise<WorkspaceRestoreResult> {
  const root = ensureHistoryRoot(workspaceRoot);
  const checkpoint = await getWorkspaceCheckpoint(root, checkpointId);
  if (!checkpoint) throw notFound("Restore point not found.");
  validateCheckpointPaths(root, checkpoint);

  // Verifying every object up front preserves the promise that a restore point
  // with missing content changes nothing. The bytes are deliberately not
  // retained: a full checkpoint can describe far more content than fits in
  // memory, so each object is read again when it is actually written.
  const missing: string[] = [];
  for (const file of checkpoint.files) {
    if (!await readWorkspaceBlob(root, file.hashSha256)) missing.push(file.path);
  }
  if (missing.length) throw new Error(`Restore point is missing saved content for ${missing.sort().join(", ")}. No files were changed.`);
  await preflightRestore(root, checkpoint);

  const safety = checkpoint.scope === "full"
    ? await createWorkspaceCheckpoint(root, { reason: "pre_restore", label: `Before restoring ${checkpointId}` })
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
    const bytes = await readWorkspaceBlob(root, file.hashSha256);
    if (!bytes) throw new Error(`Restore point content for ${file.path} became unavailable during the restore.`);
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
}

export async function listFileVersions(
  workspaceRoot: string,
  relativePath: string,
  limit = 50,
): Promise<WorkspaceFileVersion[]> {
  const root = ensureHistoryRoot(workspaceRoot);
  const path = canonicalPath(root, relativePath, true).path;
  const versions: WorkspaceFileVersion[] = [];
  const seen = new Set<string>();
  for (const checkpoint of await listWorkspaceCheckpoints(root, 1000)) {
    const file = checkpoint.files.find((entry) => entry.path === path);
    if (!file || seen.has(file.hashSha256) || !(await hasWorkspaceBlob(root, file.hashSha256))) continue;
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
  workspaceRoot: string,
  relativePath: string,
  hashSha256: string,
): Promise<{ restored: true; path: string; hashSha256: string; previousHashSha256: string | null; safetyCheckpointId: string }> {
  const root = ensureHistoryRoot(workspaceRoot);
  const { path, absolutePath } = canonicalPath(root, relativePath, true);
  const normalizedHash = normalizeHash(hashSha256);
  const bytes = await readWorkspaceBlob(root, normalizedHash);
  if (!bytes) throw notFound("File version not found.");
  const currentInfo = await stat(absolutePath).catch(() => null);
  if (currentInfo && !currentInfo.isFile()) throw new Error("The selected path is currently a folder.");
  const currentBytes = currentInfo?.isFile() ? await readFile(absolutePath) : null;
  const safety = await createWorkspaceMutationCheckpoint(root, {
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

async function capturePaths(root: string, requestedPaths: string[], full: boolean): Promise<{
  directories: string[];
  files: CheckpointFileEntry[];
  skippedFiles: CheckpointSkippedFile[];
}> {
  const directories = new Set<string>();
  const files = new Map<string, CheckpointFileEntry>();
  const skipped = new Map<string, CheckpointSkippedFile>();
  // Only a whole-Space capture amortizes the index across enough files to be
  // worth reading manifests for. A targeted capture already touches a handful
  // of paths, and building an index for it would make every ordinary file
  // mutation parse a manifest describing the entire Space.
  const reusableDigests = full ? await buildCaptureReuseIndex(root) : new Map<string, string>();
  const visit = async (absolutePath: string): Promise<void> => {
    const info = await lstat(absolutePath).catch(() => null);
    if (!info) return;
    const path = toPosix(relative(root, absolutePath));
    if (path && path.split("/").some((segment) => versionScopeSkippedSegments.has(segment))) {
      skipped.set(path, { path, sizeBytes: info.isFile() ? info.size : 0, reason: "excluded" });
      return;
    }
    if (info.isSymbolicLink()) {
      if (path) skipped.set(path, { path, sizeBytes: 0, reason: "symbolic_link" });
      return;
    }
    if (info.isDirectory()) {
      if (path) directories.add(path);
      const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (isOfficeLockFileName(entry.name)) continue;
        await visit(join(absolutePath, entry.name));
      }
      return;
    }
    if (!info.isFile() || !path) return;
    if (info.size > maxVersionedFileBytes()) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "too_large" });
      return;
    }
    // A settled path/size/mtime triple that an earlier checkpoint already
    // hashed cannot describe different bytes, so its digest is reused instead
    // of reading the file again. A miss always falls back to a full read, so
    // the manifest stays byte-identical either way.
    const modifiedAt = info.mtime.toISOString();
    const reusedDigest = reusableDigests.get(captureReuseKey(path, info.size, modifiedAt));
    if (reusedDigest && await hasWorkspaceBlob(root, reusedDigest)) {
      files.set(path, { path, hashSha256: reusedDigest, sizeBytes: info.size, modifiedAt });
      return;
    }
    const bytes = await readFile(absolutePath).catch(() => null);
    if (!bytes) {
      skipped.set(path, { path, sizeBytes: info.size, reason: "unreadable" });
      return;
    }
    const blob = await storeWorkspaceBlob(root, bytes);
    files.set(path, { path, hashSha256: blob.hashSha256, sizeBytes: blob.sizeBytes, modifiedAt });
  };

  if (full) await visit(root);
  else for (const path of collapsePaths(requestedPaths)) await visit(canonicalPath(root, path, true).absolutePath);
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
}): Promise<WorkspaceCheckpoint> {
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
  const [latest] = await listWorkspaceCheckpoints(root, 1);
  if (input.scope === "full" && latest?.scope === "full" && latest.manifestHash === manifestHash) return latest;

  const createdAt = new Date().toISOString();
  const checkpoint: WorkspaceCheckpoint = {
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

async function createTargetedRestoreSafety(root: string, checkpoint: WorkspaceCheckpoint): Promise<WorkspaceCheckpoint> {
  const affectedRoots = collapsePaths([...checkpoint.captureRoots, ...checkpoint.deleteOnRestore]);
  const existing: string[] = [];
  const deleteOnRestore: string[] = [];
  for (const path of affectedRoots) {
    if (existsSync(canonicalPath(root, path, true).absolutePath)) existing.push(path);
    else deleteOnRestore.push(path);
  }
  return createWorkspaceMutationCheckpoint(root, {
    paths: existing,
    deleteOnRestore,
    movesOnRestore: checkpoint.movesOnRestore.map((move) => ({ fromPath: move.toPath, toPath: move.fromPath })),
    reason: "pre_restore",
    label: `Before restoring ${checkpoint.checkpointId}`,
  });
}

async function preflightRestore(root: string, checkpoint: WorkspaceCheckpoint): Promise<void> {
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

function validateCheckpointPaths(root: string, checkpoint: WorkspaceCheckpoint): void {
  for (const directory of checkpoint.directories) canonicalPath(root, directory, true);
  for (const file of checkpoint.files) canonicalPath(root, file.path, true);
  for (const path of checkpoint.captureRoots) canonicalPath(root, path, true);
  for (const path of checkpoint.deleteOnRestore) canonicalPath(root, path, true);
  for (const move of checkpoint.movesOnRestore) {
    canonicalPath(root, move.fromPath, true);
    canonicalPath(root, move.toPath, true);
  }
}

async function migrateLegacyCheckpoints(root: string): Promise<void> {
  const historyRoot = workspaceHistoryRoot(root);
  const entries = await readdir(historyRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !checkpointIdPattern.test(entry.name)) continue;
    const legacyDir = join(historyRoot, entry.name);
    const metadata = await readFile(join(legacyDir, legacyMetadataName), "utf8")
      .then((text) => JSON.parse(text) as { checkpointId?: string; createdAt?: string; label?: string; reason?: string })
      .catch(() => null);
    const snapshotRoot = join(legacyDir, legacySnapshotDirName);
    if (!metadata?.checkpointId || !metadata.createdAt || !existsSync(snapshotRoot)) continue;
    const captured = await captureLegacySnapshot(root, snapshotRoot);
    const material = {
      scope: "full",
      captureRoots: [],
      deleteOnRestore: [],
      movesOnRestore: [],
      directories: captured.directories,
      files: captured.files.map(({ path, hashSha256 }) => ({ path, hashSha256 })),
      skippedFiles: captured.skippedFiles,
    };
    const checkpoint: WorkspaceCheckpoint = {
      schemaVersion: "0.2.0",
      checkpointId: metadata.checkpointId,
      createdAt: metadata.createdAt,
      ...(metadata.label ? { label: metadata.label } : {}),
      reason: metadata.reason ?? "legacy",
      scope: "full",
      manifestHash: sha256(Buffer.from(stableJson(material), "utf8")),
      fileCount: captured.files.length,
      totalBytes: captured.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      skippedLargeFiles: captured.skippedFiles.filter((file) => file.reason === "too_large").map((file) => file.path),
      skippedFiles: captured.skippedFiles,
      captureRoots: [],
      deleteOnRestore: [],
      movesOnRestore: [],
      directories: captured.directories,
      files: captured.files,
    };
    await atomicJsonWrite(join(checkpointsDir(root), `${checkpoint.checkpointId}.json`), checkpoint);
    await rm(legacyDir, { recursive: true, force: true });
  }
}

async function captureLegacySnapshot(root: string, snapshotRoot: string): Promise<{ directories: string[]; files: CheckpointFileEntry[]; skippedFiles: CheckpointSkippedFile[] }> {
  const directories: string[] = [];
  const files: CheckpointFileEntry[] = [];
  const skippedFiles: CheckpointSkippedFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || isOfficeLockFileName(entry.name)) continue;
      const source = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(toPosix(relative(snapshotRoot, source)));
        await visit(source);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = toPosix(relative(snapshotRoot, source));
      const info = await stat(source);
      if (info.size > maxVersionedFileBytes()) {
        skippedFiles.push({ path, sizeBytes: info.size, reason: "too_large" });
        continue;
      }
      const bytes = await readFile(source).catch(() => null);
      if (!bytes) {
        skippedFiles.push({ path, sizeBytes: info.size, reason: "unreadable" });
        continue;
      }
      const blob = await storeWorkspaceBlob(root, bytes);
      files.push({ path, hashSha256: blob.hashSha256, sizeBytes: blob.sizeBytes, modifiedAt: info.mtime.toISOString() });
    }
  };
  await visit(snapshotRoot);
  return { directories: directories.sort((left, right) => left.localeCompare(right)), files: files.sort((left, right) => left.path.localeCompare(right.path)), skippedFiles };
}

async function pruneHistory(root: string): Promise<void> {
  const checkpoints = await readCheckpointManifests(root);
  const retained = checkpoints.slice(0, maxRetainedCheckpoints());
  const removed = checkpoints.slice(retained.length);
  if (!removed.length) return;
  for (const checkpoint of removed) await rm(join(checkpointsDir(root), `${checkpoint.checkpointId}.json`), { force: true });
  await garbageCollectObjects(root, retained);
}

async function garbageCollectObjects(root: string, retained: WorkspaceCheckpoint[]): Promise<void> {
  const referenced = new Set(retained.flatMap((checkpoint) => checkpoint.files.map((file) => file.hashSha256)));
  const objectsRoot = join(workspaceHistoryRoot(root), "objects");
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

function captureReuseKey(path: string, sizeBytes: number, modifiedAt: string): string {
  return `${path}\u0000${sizeBytes}\u0000${modifiedAt}`;
}

/**
 * Digests recorded by recent checkpoints, keyed by the exact path, size, and
 * modification time they described. Capture uses this to skip re-reading and
 * re-hashing files a previous checkpoint already covered, which is what keeps
 * a per-turn checkpoint proportional to what changed rather than to the size
 * of the whole Space.
 *
 * Scanning stops at the newest full-scope manifest because everything older is
 * already represented there. An entry seeds the index only when its file had
 * settled strictly before that checkpoint was taken, so a write sharing a
 * timestamp tick with its own capture can never be trusted as a cache source.
 */
async function buildCaptureReuseIndex(root: string): Promise<Map<string, string>> {
  const names = (await readdir(checkpointsDir(root)).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => right.localeCompare(left));
  const index = new Map<string, string>();
  let scanned = 0;
  for (const name of names) {
    if (scanned >= maxCaptureReuseManifests) break;
    const checkpoint = await readCheckpointManifest(join(checkpointsDir(root), name));
    if (!checkpoint) continue;
    scanned += 1;
    const capturedAt = Date.parse(checkpoint.createdAt);
    for (const file of checkpoint.files) {
      if (!(Date.parse(file.modifiedAt) < capturedAt)) continue;
      const key = captureReuseKey(file.path, file.sizeBytes, file.modifiedAt);
      if (!index.has(key)) index.set(key, file.hashSha256);
    }
    if (checkpoint.scope === "full") break;
  }
  return index;
}

async function readCheckpointManifests(root: string): Promise<WorkspaceCheckpoint[]> {
  const entries = await readdir(checkpointsDir(root)).catch(() => [] as string[]);
  const checkpoints: WorkspaceCheckpoint[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const checkpoint = await readCheckpointManifest(join(checkpointsDir(root), name));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.checkpointId.localeCompare(left.checkpointId));
}

async function readCheckpointManifest(path: string): Promise<WorkspaceCheckpoint | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<WorkspaceCheckpoint>;
    if (value.schemaVersion !== "0.2.0" || !checkpointIdPattern.test(value.checkpointId ?? "") || !Array.isArray(value.files)) return null;
    return { ...value, directories: Array.isArray(value.directories) ? value.directories : [] } as WorkspaceCheckpoint;
  } catch {
    return null;
  }
}

async function hasWorkspaceBlob(root: string, hashSha256: string): Promise<boolean> {
  try {
    return existsSync(workspaceBlobPath(root, hashSha256));
  } catch {
    return false;
  }
}

function canonicalPath(root: string, value: string, allowMissing: boolean): { path: string; absolutePath: string } {
  const absolutePath = resolveWorkspacePath(root, toPosix(value).replace(/^\/+/, "") || ".");
  const path = toPosix(relative(root, absolutePath));
  if (!path || path === ".") throw new Error("The Space root cannot be used as a history item.");
  if (!allowMissing && !existsSync(absolutePath)) throw notFound(`Space item not found: ${path}`);
  return { path, absolutePath };
}

function collapsePaths(paths: string[]): string[] {
  const sorted = [...new Set(paths.filter(Boolean))].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  return sorted.filter((path, index) => !sorted.slice(0, index).some((parent) => path === parent || path.startsWith(`${parent}/`)));
}

function ensureHistoryRoot(workspaceRoot: string): string {
  const root = ensureSafeWorkspaceRoot(workspaceRoot);
  assertWorkspaceDoesNotContainState(root);
  return root;
}

function workspaceBlobPath(root: string, hashSha256: string): string {
  const normalized = normalizeHash(hashSha256);
  return join(workspaceHistoryRoot(root), "objects", normalized.slice(0, 2), normalized.slice(2));
}

function checkpointsDir(root: string): string {
  return join(workspaceHistoryRoot(root), "checkpoints");
}

async function ensureHistoryMeta(root: string): Promise<void> {
  const path = join(workspaceHistoryRoot(root), "meta.json");
  if (existsSync(path)) return;
  await atomicJsonWrite(path, { schemaVersion: "0.2.0", rootPath: resolve(root), createdAt: new Date().toISOString() });
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function maxVersionedFileBytes(): number {
  const configured = Number(process.env.WORKSPACE_HISTORY_MAX_FILE_BYTES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 100 * 1024 * 1024;
}

function maxRetainedCheckpoints(): number {
  const configured = Number(process.env.WORKSPACE_HISTORY_MAX_CHECKPOINTS);
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
