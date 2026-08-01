import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, lstatSync } from "node:fs";
import {
  copyFile,
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { isOfficeDocumentPath, isOfficeLockFileName, officeDocumentLockPresent } from "./office-lock-files.js";
import {
  managedSpaceRoot,
  spaceStateDir,
  workFoldStateRoot,
  spaceManifestFile,
  spaceRegistryFile,
} from "./state-paths.js";
import { isAlwaysHiddenSpaceEntry, isSpaceIgnored, readSpaceIgnoreState } from "./space-ignore.js";
import { containsReservedSpacePathSegment } from "./space-path-policy.js";
import { productIdentity } from "../shared/product-identity.js";

export interface SpaceLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface SpaceSummary {
  id: string;
  name: string;
  spaceRoot: string;
  location: SpaceLocation;
  createdAt: string;
  updatedAt: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt?: string;
  ignored?: boolean;
  descendantIgnoredCount?: number;
  hasChildren?: boolean;
  children?: TreeEntry[];
}

export interface SpaceEntryInfo {
  name: string;
  path: string;
  kind: "file" | "folder";
  sizeBytes: number;
  createdAt: string;
  modifiedAt: string;
  extension: string | null;
  mimeType: string;
  hashSha256: string | null;
  officeDocument: boolean;
  openInOffice: boolean;
}

export interface SpaceMovedEntry {
  fromPath: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  updatedAt: string;
}

export interface SpaceCreatedEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt: string;
}

export interface SpaceTreeOptions {
  includeIgnored?: boolean;
}

export interface SpaceRemovalIntent {
  transactionId: string;
  spaceId: string;
  spaceRoot: string;
  storage: SpaceLocation["storage"];
  managedBase: string | null;
  managedRootIdentity: ManagedSpaceRootIdentity | null;
  managedRootClaimed: boolean;
  phase: "requested" | "app-state-removed";
  requestedAt: string;
}

export interface ManagedSpaceRootIdentity {
  realPath: string;
  managedBaseRealPath: string;
  device: string;
  inode: string;
}

export interface SpaceRemovalResult {
  removed: true;
  deleted: boolean;
  spaceRoot: string;
  cleanupPending: boolean;
}

export interface SpaceRegistry {
  version: 1;
  spaces: SpaceSummary[];
  pendingRemovals: SpaceRemovalIntent[];
}

export interface SpaceRemovalIo {
  persistRegistry(registry: SpaceRegistry): Promise<void>;
  claimManagedRoot(spaceRoot: string, claimPath: string): Promise<void>;
  restoreMismatchedManagedClaim(claimPath: string, spaceRoot: string): Promise<void>;
  removeClaimedManagedRoot(claimPath: string): Promise<void>;
  removeSpaceState(spaceRoot: string): Promise<void>;
}

interface PortableSpaceManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const maxPreviewBytes = 2 * 1024 * 1024;
const treeScanConcurrency = 64;

export async function listSpaces(): Promise<SpaceSummary[]> {
  const registry = await readRegistry();
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.spaceId));
  const spaces = registry.spaces
    .filter((space) => !removingIds.has(space.id))
    .filter((space) => existsSync(space.spaceRoot))
    .filter((space) => space.location.storage !== "linked" || linkedSpaceStateSeparated(space.spaceRoot))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  await Promise.all(spaces.map(async (space) => {
    try {
      await writePortableManifest(space);
    } catch {
      // A previously linked folder can become read-only or temporarily unavailable.
      // Registry-backed listing must remain usable; the next successful mutation retries.
    }
  }));
  return spaces;
}

export async function createManagedSpace(name: string, baseDir = managedSpaceRoot()): Promise<SpaceSummary> {
  const normalizedName = normalizeSpaceName(name);
  await mkdir(baseDir, { recursive: true });
  const spaceRoot = await nextAvailableDirectory(baseDir, safeSegment(normalizedName) || "space");
  await mkdir(spaceRoot, { recursive: false });
  try {
    return await registerSpace({
      name: normalizedName,
      spaceRoot,
      location: { kind: "local", storage: "managed" },
    });
  } catch (error) {
    await rm(spaceRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function registerLinkedSpace(spaceRoot: string, providerHint?: "google-drive"): Promise<SpaceSummary> {
  const safeRoot = ensureSafeSpaceRoot(spaceRoot);
  assertLinkedSpaceStateSeparation(safeRoot);
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder selected for this Space does not exist.");
  return registerSpace({
    name: basename(safeRoot),
    spaceRoot: safeRoot,
    location: {
      kind: "local",
      storage: "linked",
      ...(providerHint === "google-drive" || looksLikeGoogleDrivePath(safeRoot) ? { providerHint: "google-drive" as const } : {}),
    },
  });
}

export async function getSpace(spaceId: string): Promise<SpaceSummary> {
  assertId(spaceId);
  const space = (await listSpaces()).find((item) => item.id === spaceId);
  if (!space) throw notFound("Space not found.");
  if (space.location.storage === "linked") assertLinkedSpaceStateSeparation(space.spaceRoot);
  return space;
}

export async function renameSpace(spaceId: string, name: string): Promise<SpaceSummary> {
  assertId(spaceId);
  const normalizedName = normalizeSpaceName(name);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const space = registry.spaces.find((item) => item.id === spaceId);
    if (!space || registry.pendingRemovals.some((intent) => intent.spaceId === spaceId)
      || !existsSync(space.spaceRoot)) throw notFound("Space not found.");
    space.name = normalizedName;
    space.updatedAt = new Date().toISOString();
    await commitRegistryAndPortableManifest(registry, space);
    return space;
  });
}

/**
 * Persists the user-authorized removal before any App or content cleanup. From
 * this point the Space is intentionally hidden from every registry projection;
 * startup recovery can safely roll the operation forward after a crash.
 */
export async function beginSpaceRemoval(
  spaceId: string,
  managedBase = managedSpaceRoot(),
  io: Partial<SpaceRemovalIo> = {},
): Promise<SpaceRemovalIntent> {
  assertId(spaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const existing = registry.pendingRemovals.find((intent) => intent.spaceId === spaceId);
    if (existing) return structuredClone(existing);
    const space = registry.spaces.find((item) => item.id === spaceId);
    if (!space || !existsSync(space.spaceRoot)) throw notFound("Space not found.");
    const spaceRoot = ensureSafeSpaceRoot(space.spaceRoot);
    const base = space.location.storage === "managed" ? resolve(managedBase) : null;
    if (base && (samePath(spaceRoot, base) || !pathContains(base, spaceRoot))) {
      throw new Error("work-fold will only delete a managed Space inside its registered managed-content folder.");
    }
    const managedRootIdentity = space.location.storage === "managed"
      ? await captureManagedRootIdentity(spaceRoot, base!)
      : null;
    const intent: SpaceRemovalIntent = {
      transactionId: `space-removal_${randomUUID()}`,
      spaceId: space.id,
      spaceRoot,
      storage: space.location.storage,
      managedBase: base,
      managedRootIdentity,
      managedRootClaimed: false,
      phase: "requested",
      requestedAt: new Date().toISOString(),
    };
    registry.pendingRemovals.push(intent);
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function markSpaceRemovalAppStateRemoved(
  spaceId: string,
  io: Partial<SpaceRemovalIo> = {},
): Promise<SpaceRemovalIntent> {
  assertId(spaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const intent = registry.pendingRemovals.find((item) => item.spaceId === spaceId);
    if (!intent) throw new Error("Space removal intent not found.");
    if (intent.phase === "app-state-removed") return structuredClone(intent);
    intent.phase = "app-state-removed";
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function listPendingSpaceRemovals(): Promise<SpaceRemovalIntent[]> {
  return (await readRegistry({ strict: true })).pendingRemovals.map((intent) => structuredClone(intent));
}

export async function finalizeSpaceRemoval(
  spaceId: string,
  io: Partial<SpaceRemovalIo> = {},
): Promise<SpaceRemovalResult> {
  assertId(spaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const intent = registry.pendingRemovals.find((item) => item.spaceId === spaceId);
    if (!intent) throw new Error("Space removal intent not found.");
    if (intent.phase !== "app-state-removed") {
      throw new Error("Space cleanup cannot start before App state has been removed.");
    }
    const space = registry.spaces.find((item) => item.id === spaceId);
    if (!space || !samePath(space.spaceRoot, intent.spaceRoot)
      || space.location.storage !== intent.storage) {
      throw new Error("Space removal intent no longer matches the registered Space.");
    }
    validateSpaceRemovalIntent(intent);
    const operations = removalIo(io);
    let deleted = false;
    if (intent.storage === "managed") {
      const claimPath = managedRemovalClaimPath(intent);
      let claimStatus = await managedClaimStatus(intent);
      if (claimStatus === "mismatch") {
        if (await managedRootStatus(intent) === "absent") {
          await operations.restoreMismatchedManagedClaim(claimPath, intent.spaceRoot).catch(() => undefined);
        }
        return spaceRemovalPendingResult(intent);
      }
      if (claimStatus === "unavailable") {
        return spaceRemovalPendingResult(intent);
      }

      if (claimStatus === "absent") {
        const rootStatus = await managedRootStatus(intent);
        if (rootStatus === "absent") {
          deleted = true;
        } else if (rootStatus === "mismatch" && intent.managedRootClaimed) {
          // The approved identity was durably claimed and is now absent. A new
          // occupant at the old path is unrelated and must be left untouched.
          deleted = true;
        } else if (rootStatus !== "matching") {
          return spaceRemovalPendingResult(intent);
        } else {
          try {
            await operations.claimManagedRoot(intent.spaceRoot, claimPath);
          } catch {
            return spaceRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
          if (claimStatus !== "matching") {
            if (claimStatus === "mismatch" && await managedRootStatus(intent) === "absent") {
              await operations.restoreMismatchedManagedClaim(claimPath, intent.spaceRoot).catch(() => undefined);
            }
            return spaceRemovalPendingResult(intent);
          }
        }
      }

      if (!deleted && !intent.managedRootClaimed) {
        intent.managedRootClaimed = true;
        try {
          await operations.persistRegistry(registry);
        } catch {
          return spaceRemovalPendingResult(intent);
        }
      }

      if (!deleted) {
        claimStatus = await managedClaimStatus(intent);
        if (claimStatus === "matching") {
          try {
            await operations.removeClaimedManagedRoot(claimPath);
          } catch {
            return spaceRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
        }
        if (claimStatus !== "absent") return spaceRemovalPendingResult(intent);
        deleted = true;
      }
    }
    try {
      await operations.removeSpaceState(intent.spaceRoot);
    } catch {
      return spaceRemovalPendingResult(intent);
    }

    const next: SpaceRegistry = {
      ...registry,
      spaces: registry.spaces.filter((item) => item.id !== spaceId),
      pendingRemovals: registry.pendingRemovals.filter((item) => item.spaceId !== spaceId),
    };
    try {
      await operations.persistRegistry(next);
    } catch {
      return spaceRemovalPendingResult(intent);
    }
    return { removed: true, deleted, spaceRoot: intent.spaceRoot, cleanupPending: false };
  });
}

export async function spaceRemovalPendingResult(
  intent: Pick<SpaceRemovalIntent,
    "transactionId" | "spaceRoot" | "storage" | "managedBase" | "managedRootIdentity" | "managedRootClaimed">,
): Promise<SpaceRemovalResult> {
  const rootStatus = intent.storage === "managed" ? await managedRootStatus(intent) : "mismatch";
  const deleted = intent.storage === "managed"
    && await managedClaimStatus(intent) === "absent"
    && (rootStatus === "absent" || (intent.managedRootClaimed && rootStatus === "mismatch"));
  return {
    removed: true,
    deleted,
    spaceRoot: intent.spaceRoot,
    cleanupPending: true,
  };
}

export interface SpaceTreeScan {
  entries: TreeEntry[];
  /** True when the entry budget stopped the walk before the folder was exhausted. */
  truncated: boolean;
}

interface TreeScanBudget {
  remaining: number;
  truncated: boolean;
}

export async function scanSpaceTree(
  spaceRoot: string,
  maxDepth = 20,
  relativePath = "",
  options: SpaceTreeOptions = {},
): Promise<SpaceTreeScan> {
  const safeRoot = ensureSafeSpaceRoot(spaceRoot);
  const scanRoot = resolveSpacePath(safeRoot, relativePath || ".");
  const info = await stat(scanRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Requested Space tree path is not a folder.");
  const ignoreState = await readSpaceIgnoreState(safeRoot);
  // A Space is an arbitrary folder and may hold far more entries than a
  // navigator can present. The walk stops at a total entry budget and says so,
  // so a partial tree is never mistaken for the whole Space.
  const budget: TreeScanBudget = { remaining: maxTreeEntries(), truncated: false };
  const entries = await scanDirectory(
    safeRoot,
    scanRoot,
    0,
    Math.min(Math.max(maxDepth, 0), 50),
    ignoreState.patterns,
    options.includeIgnored !== false,
    createFilesystemLimiter(treeScanConcurrency),
    budget,
  );
  return { entries, truncated: budget.truncated };
}

function maxTreeEntries(): number {
  const configured = Number(process.env.WORKFOLD_TREE_MAX_ENTRIES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 20_000;
}

export async function readSpaceTextFile(spaceRoot: string, relativePath: string): Promise<{ text: string }> {
  const path = resolveSpacePath(spaceRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (info.size > maxPreviewBytes) throw new Error("This file is too large to preview (2 MB maximum).");
  const bytes = await readFile(path);
  if (looksBinary(bytes)) throw new Error("This file is binary and cannot be previewed as text.");
  return { text: bytes.toString("utf8") };
}

export async function writeSpaceTextFile(spaceRoot: string, relativePath: string, text: string): Promise<{ path: string; text: string }> {
  const path = resolveSpacePath(spaceRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("This file is too large to edit (2 MB maximum).");
  await writeFile(path, text, "utf8");
  await touchSpace(spaceRoot);
  return { path: normalizeRelative(relative(ensureSafeSpaceRoot(spaceRoot), path)), text };
}

export async function getSpaceEntryInfo(spaceRoot: string, relativePath: string): Promise<SpaceEntryInfo> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const path = resolveSpacePath(root, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Space item not found.");
  const extension = info.isFile() ? extname(path).toLowerCase() || null : null;
  const officeDocument = info.isFile() && isOfficeDocumentPath(path);
  return {
    name: basename(path),
    path: normalizeRelative(relative(root, path)),
    kind: info.isDirectory() ? "folder" : "file",
    sizeBytes: info.isFile() ? info.size : 0,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
    extension,
    mimeType: info.isDirectory() ? "inode/directory" : contentTypeForExtension(extension),
    hashSha256: info.isFile() ? await sha256File(path) : null,
    officeDocument,
    openInOffice: officeDocument ? await officeDocumentLockPresent(path) : false,
  };
}

export async function findExistingSpaceFilePaths(spaceRoot: string, requestedPaths: string[]): Promise<string[]> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const requests = [...new Set(requestedPaths.map(normalizeRelative).filter(Boolean))].slice(0, 32);
  const existing = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const request of requests) {
    try {
      const path = resolveSpacePath(root, request);
      if ((await stat(path)).isFile()) {
        existing.add(normalizeRelative(relative(root, path)));
        continue;
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!request.includes("/")) unresolvedNames.add(request.toLocaleLowerCase());
  }
  if (unresolvedNames.size) {
    const matches = new Map<string, string[]>();
    for (const name of unresolvedNames) matches.set(name, []);
    await visitSpaceFiles(root, root, (path, name) => matches.get(name.toLocaleLowerCase())?.push(path));
    for (const paths of matches.values()) if (paths.length === 1 && paths[0]) existing.add(paths[0]);
  }
  return [...existing].sort((left, right) => left.localeCompare(right));
}

export async function moveSpaceEntry(
  spaceRoot: string,
  input: { sourcePath: string; targetFolderPath?: string },
): Promise<SpaceMovedEntry> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const sourcePath = normalizeRelative(input.sourcePath);
  const targetFolderPath = normalizeRelative(input.targetFolderPath ?? "");
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to move.");
  if (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`)) throw new Error("Folders cannot be moved into themselves.");
  const source = resolveSpacePath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Space root cannot be moved.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("Space item not found.");
  const targetFolder = resolveSpacePath(root, targetFolderPath || ".");
  if (!(await stat(targetFolder)).isDirectory()) throw new Error("Move items into a folder.");
  if (dirname(source) === targetFolder) throw new Error("That item is already in the selected folder.");
  const destination = join(targetFolder, basename(source));
  if (existsSync(destination)) throw new Error(`A file or folder named ${basename(source)} already exists there.`);
  await rename(source, destination);
  const movedInfo = await stat(destination);
  await touchSpace(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: basename(destination),
    kind: movedInfo.isDirectory() ? "folder" : "file",
    updatedAt: movedInfo.mtime.toISOString(),
  };
}

export async function renameSpaceEntry(
  spaceRoot: string,
  input: { path: string; newName: string },
): Promise<SpaceMovedEntry> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const sourcePath = normalizeRelative(input.path);
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to rename.");
  const newName = safeFileName(input.newName);
  const source = resolveSpacePath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Space root cannot be renamed.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("Space item not found.");
  if (basename(source) === newName) throw new Error("That item already has this name.");
  const destination = join(dirname(source), newName);
  resolveSpacePath(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${newName} already exists there.`);
  await rename(source, destination);
  const renamedInfo = await stat(destination);
  await touchSpace(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: newName,
    kind: renamedInfo.isDirectory() ? "folder" : "file",
    updatedAt: renamedInfo.mtime.toISOString(),
  };
}

export async function createSpaceFolder(
  spaceRoot: string,
  parentPath: string,
  name: string,
): Promise<SpaceCreatedEntry> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const parent = resolveSpacePath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create folders inside a Space folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  if (existsSync(destination)) throw new Error(`A file or folder named ${safeName} already exists there.`);
  await mkdir(destination, { recursive: false });
  const info = await stat(destination);
  await touchSpace(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "folder",
    updatedAt: info.mtime.toISOString(),
  };
}

export async function createSpaceTextFile(
  spaceRoot: string,
  parentPath: string,
  name: string,
  text = "",
): Promise<SpaceCreatedEntry> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const parent = resolveSpacePath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create files inside a Space folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("The new file is too large (2 MB maximum).");
  await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
  const info = await stat(destination);
  await touchSpace(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "file",
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function deleteSpaceEntry(spaceRoot: string, relativePath: string): Promise<{ deleted: true; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") throw new Error("Select a file or folder to delete.");
  const path = resolveSpacePath(root, normalized);
  if (samePath(path, root)) throw new Error("The Space root cannot be deleted.");
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Space item not found.");
  await rm(path, { recursive: info.isDirectory(), force: false });
  await touchSpace(root);
  return { deleted: true, path: normalized, kind: info.isDirectory() ? "folder" : "file" };
}

export async function writeUploadedFiles(
  spaceRoot: string,
  targetFolderPath: string,
  files: Array<{ fileName: string; relativePath?: string; data: Buffer }>,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const targetFolder = resolveSpacePath(spaceRoot, targetFolderPath || ".");
  await mkdir(targetFolder, { recursive: true });
  const written: Array<{ path: string; sizeBytes: number }> = [];
  const destinations: string[] = [];
  let attempted: string | null = null;
  try {
    for (const file of files) {
      const uploadPath = safeUploadPath(file.relativePath || file.fileName);
      const desired = resolveSpacePath(targetFolder, uploadPath);
      await mkdir(dirname(desired), { recursive: true });
      const destination = await nextAvailableFile(desired);
      attempted = destination;
      await writeFile(destination, file.data, { flag: "wx" });
      attempted = null;
      destinations.push(destination);
      written.push({ path: normalizeRelative(relative(spaceRoot, destination)), sizeBytes: file.data.byteLength });
    }
  } catch (error) {
    // The upload batch is one action: a mid-batch failure must not strand the
    // files that already landed, nor a partially written current file.
    await Promise.all([...destinations, ...(attempted ? [attempted] : [])].map((path) =>
      rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
  await touchSpace(spaceRoot);
  return written;
}

export async function copyPathIntoSpace(
  sourcePath: string,
  spaceRoot: string,
  targetFolderPath: string,
): Promise<string> {
  const targetFolder = resolveSpacePath(spaceRoot, targetFolderPath || ".");
  await mkdir(targetFolder, { recursive: true });
  const destination = await nextAvailablePath(join(targetFolder, safeFileName(basename(sourcePath))));
  try {
    await copyVisiblePath(sourcePath, destination);
  } catch (error) {
    // A folder copy that fails partway must not strand a partial destination.
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await touchSpace(spaceRoot);
  return normalizeRelative(relative(spaceRoot, destination));
}

export function resolveSpacePath(spaceRoot: string, relativePath: string): string {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const normalized = normalizeRelative(relativePath || ".");
  if (isAbsolute(relativePath) || normalized.split("/").includes("..")) {
    throw new Error("Path escapes the selected Space.");
  }
  if (containsReservedSpacePathSegment(normalized)) {
    throw new Error("Path selects reserved work-fold, legacy product, or Pi metadata.");
  }
  const path = resolve(root, normalized || ".");
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Path escapes the selected Space.");
  assertNoLinkSegments(root, path);
  return path;
}

export function ensureSafeSpaceRoot(spaceRoot: string): string {
  const resolved = resolve(spaceRoot);
  if (!isAbsolute(resolved) || resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Space.");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) throw new Error("A Space cannot be a symbolic link or junction.");
  return resolved;
}

export function assertSpaceDoesNotContainState(spaceRoot: string): void {
  const root = ensureSafeSpaceRoot(spaceRoot);
  const stateRoot = resolve(workFoldStateRoot());
  if (pathContains(root, stateRoot)) {
    throw new Error("Choose a narrower folder that does not contain work-fold application data.");
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function registerSpace(input: Omit<SpaceSummary, "id" | "createdAt" | "updatedAt">): Promise<SpaceSummary> {
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const spaceRoot = resolve(input.spaceRoot);
    const existing = registry.spaces.find((space) => samePath(space.spaceRoot, spaceRoot));
    if (existing) {
      if (registry.pendingRemovals.some((intent) => intent.spaceId === existing.id)) {
        throw new Error("This Space is still being removed. Restart work-fold to retry its cleanup.");
      }
      await writePortableManifest(existing);
      return existing;
    }
    const portableIdentity = await readExistingSpaceManifest(spaceRoot);
    const now = new Date().toISOString();
    if (portableIdentity) {
      const identityOwner = registry.spaces.find((space) => space.id === portableIdentity.id);
      if (identityOwner) {
        if (registry.pendingRemovals.some((intent) => intent.spaceId === identityOwner.id)) {
          throw new Error("This Space is still being removed. Restart work-fold to retry its cleanup.");
        }
        if (existsSync(identityOwner.spaceRoot)) {
          throw new Error("This Space identity is already linked to another folder.");
        }
        identityOwner.name = portableIdentity.name;
        identityOwner.spaceRoot = spaceRoot;
        identityOwner.location = input.location;
        identityOwner.createdAt = portableIdentity.createdAt;
        identityOwner.updatedAt = now;
        await commitRegistryAndPortableManifest(registry, identityOwner);
        return identityOwner;
      }
    }
    const id = portableIdentity?.id ?? stableSpaceId(spaceRoot);
    const identityCollision = registry.spaces.find((space) => space.id === id);
    if (identityCollision) throw new Error("This Space identity is already registered to another folder.");
    const space: SpaceSummary = {
      ...input,
      id,
      name: portableIdentity?.name ?? input.name,
      spaceRoot,
      createdAt: portableIdentity?.createdAt ?? now,
      updatedAt: now,
    };
    registry.spaces.push(space);
    await commitRegistryAndPortableManifest(registry, space);
    return space;
  });
}

async function touchSpace(spaceRoot: string): Promise<void> {
  await withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const space = registry.spaces.find((item) => samePath(item.spaceRoot, spaceRoot));
    if (!space || registry.pendingRemovals.some((intent) => intent.spaceId === space.id)) return;
    space.updatedAt = new Date().toISOString();
    try {
      await commitRegistryAndPortableManifest(registry, space);
    } catch {
      // The content mutation already succeeded. Leave both metadata records at their
      // previous values and retry maintenance on a later mutation or Space listing.
    }
  });
}

async function readRegistry(options: { strict?: boolean } = {}): Promise<SpaceRegistry> {
  const file = spaceRegistryFile();
  if (!existsSync(file)) return emptySpaceRegistry();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<SpaceRegistry>;
    if (!Array.isArray(parsed.spaces)) throw new Error("Space registry Spaces are invalid.");
    const spaces = parsed.spaces.map((space) => {
      if (!isSpaceSummary(space)) throw new Error("Space registry contains an invalid Space.");
      return { ...space, spaceRoot: resolve(space.spaceRoot) };
    });
    const pendingRemovals = parsed.pendingRemovals === undefined
      ? []
      : parsed.pendingRemovals.map((intent) => spaceRemovalIntent(intent));
    const spaceById = new Map(spaces.map((space) => [space.id, space]));
    if (new Set(pendingRemovals.map((intent) => intent.spaceId)).size !== pendingRemovals.length
      || new Set(pendingRemovals.map((intent) => intent.transactionId)).size !== pendingRemovals.length
      || pendingRemovals.some((intent) => {
        const space = spaceById.get(intent.spaceId);
        return !space
          || !samePath(space.spaceRoot, intent.spaceRoot)
          || space.location.storage !== intent.storage;
      })) {
      throw new Error("Space registry removal intents are inconsistent.");
    }
    return {
      version: 1,
      spaces,
      pendingRemovals,
    };
  } catch (error) {
    if (options.strict) throw new Error("Space registry could not be read safely.", { cause: error });
    return emptySpaceRegistry();
  }
}

async function writeRegistry(registry: SpaceRegistry): Promise<void> {
  const file = spaceRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicJsonWrite(file, registry);
}

function emptySpaceRegistry(): SpaceRegistry {
  return { version: 1, spaces: [], pendingRemovals: [] };
}

function removalIo(overrides: Partial<SpaceRemovalIo>): SpaceRemovalIo {
  return {
    persistRegistry: writeRegistry,
    claimManagedRoot: async (spaceRoot, claimPath) => {
      await rename(spaceRoot, claimPath);
      await syncDirectoriesBestEffort([dirname(spaceRoot), dirname(claimPath)]);
    },
    restoreMismatchedManagedClaim: async (claimPath, spaceRoot) => {
      await rename(claimPath, spaceRoot);
      await syncDirectoriesBestEffort([dirname(claimPath), dirname(spaceRoot)]);
    },
    removeClaimedManagedRoot: async (claimPath) => {
      await rm(claimPath, { recursive: true, force: true });
      await syncDirectoriesBestEffort([dirname(claimPath)]);
    },
    removeSpaceState: async (spaceRoot) => rm(spaceStateDir(spaceRoot), { recursive: true, force: true }),
    ...overrides,
  };
}

type ManagedRootStatus = "matching" | "absent" | "mismatch" | "unavailable";

async function captureManagedRootIdentity(spaceRoot: string, managedBase: string): Promise<ManagedSpaceRootIdentity> {
  const initialInfo = await lstat(spaceRoot, { bigint: true });
  if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink()) {
    throw new Error("A managed Space root must be an ordinary directory.");
  }
  if (initialInfo.ino === 0n) throw new Error("This filesystem does not expose a stable managed Space directory identity.");
  const [realPath, managedBaseRealPath] = await Promise.all([realpath(spaceRoot), realpath(managedBase)]);
  const confirmedInfo = await lstat(spaceRoot, { bigint: true });
  if (!confirmedInfo.isDirectory() || confirmedInfo.isSymbolicLink()
    || confirmedInfo.dev !== initialInfo.dev || confirmedInfo.ino !== initialInfo.ino) {
    throw new Error("The managed Space root changed while its removal identity was being recorded.");
  }
  if (samePath(realPath, managedBaseRealPath) || !pathContains(managedBaseRealPath, realPath)) {
    throw new Error("A managed Space root must resolve inside its managed-content folder.");
  }
  return {
    realPath: resolve(realPath),
    managedBaseRealPath: resolve(managedBaseRealPath),
    device: confirmedInfo.dev.toString(10),
    inode: confirmedInfo.ino.toString(10),
  };
}

async function managedRootStatus(
  intent: Pick<SpaceRemovalIntent, "spaceRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  return managedDirectoryStatus(intent, intent.spaceRoot, intent.managedRootIdentity?.realPath ?? intent.spaceRoot);
}

async function managedClaimStatus(
  intent: Pick<SpaceRemovalIntent,
    "transactionId" | "spaceRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  const claimPath = managedRemovalClaimPath(intent);
  return managedDirectoryStatus(intent, claimPath, claimPath);
}

async function managedDirectoryStatus(
  intent: Pick<SpaceRemovalIntent, "storage" | "managedBase" | "managedRootIdentity">,
  path: string,
  expectedRealPath: string,
): Promise<ManagedRootStatus> {
  if (intent.storage !== "managed" || !intent.managedRootIdentity) return "mismatch";
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    return isFileNotFound(error) ? "absent" : "unavailable";
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return "mismatch";
  let currentRealPath: string;
  let currentManagedBaseRealPath: string;
  try {
    [currentRealPath, currentManagedBaseRealPath] = await Promise.all([
      realpath(path),
      realpath(intent.managedBase!),
    ]);
  } catch {
    // Only the lstat above may establish absence. A failure or race after that
    // point is uncertain and must preserve the cleanup intent.
    return "unavailable";
  }
  return info.dev.toString(10) === intent.managedRootIdentity.device
    && info.ino.toString(10) === intent.managedRootIdentity.inode
    && samePath(currentRealPath, expectedRealPath)
    && samePath(currentManagedBaseRealPath, intent.managedRootIdentity.managedBaseRealPath)
    ? "matching"
    : "mismatch";
}

function managedRemovalClaimPath(
  intent: Pick<SpaceRemovalIntent, "transactionId" | "storage" | "managedRootIdentity">,
): string {
  if (intent.storage !== "managed" || !intent.managedRootIdentity
    || !/^space-removal_[0-9a-f-]{36}$/.test(intent.transactionId)) {
    throw new Error("Managed Space removal intent cannot derive a safe claim path.");
  }
  const claimPath = resolve(
    intent.managedRootIdentity.managedBaseRealPath,
    `.space-removal-${intent.transactionId.slice("space-removal_".length)}`,
  );
  if (dirname(claimPath) !== resolve(intent.managedRootIdentity.managedBaseRealPath)) {
    throw new Error("Managed Space removal claim escapes its content boundary.");
  }
  return claimPath;
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

async function syncDirectoriesBestEffort(paths: readonly string[]): Promise<void> {
  for (const path of new Set(paths.map((item) => resolve(item)))) {
    try {
      const directory = await open(path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Windows does not consistently allow directory handles. The same-volume
      // rename remains the claim point and exact identity is rechecked afterward.
    }
  }
}

let registryMutationQueue: Promise<void> = Promise.resolve();

async function withRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryMutationQueue.then(operation, operation);
  registryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writePortableManifest(space: SpaceSummary): Promise<void> {
  const file = spaceManifestFile(space.spaceRoot);
  await mkdir(dirname(file), { recursive: true });
  let existingFields: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const existing = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (existing && typeof existing === "object" && !Array.isArray(existing)) existingFields = existing as Record<string, unknown>;
    } catch {
      // Invalid fields are replaced by the canonical manifest below.
    }
  }
  const manifest: PortableSpaceManifest & Record<string, unknown> = {
    ...existingFields,
    version: 1,
    id: space.id,
    name: space.name,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
  };
  await atomicJsonWrite(file, manifest);
}

async function commitRegistryAndPortableManifest(registry: SpaceRegistry, space: SpaceSummary): Promise<void> {
  const manifestFile = spaceManifestFile(space.spaceRoot);
  const previousManifest = await snapshotFile(manifestFile);
  await writePortableManifest(space);
  try {
    await writeRegistry(registry);
  } catch (error) {
    try {
      await restoreFileSnapshot(manifestFile, previousManifest);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Space metadata commit failed and its portable manifest could not be restored.");
    }
    throw error;
  }
}

type FileSnapshot = { exists: false } | { exists: true; contents: string };

async function snapshotFile(file: string): Promise<FileSnapshot> {
  if (!existsSync(file)) return { exists: false };
  return { exists: true, contents: await readFile(file, "utf8") };
}

async function restoreFileSnapshot(file: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.rollback.tmp`;
  await writeFile(temp, snapshot.contents, "utf8");
  await rename(temp, file);
}

async function readExistingSpaceManifest(spaceRoot: string): Promise<PortableSpaceManifest | null> {
  const file = spaceManifestFile(spaceRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PortableSpaceManifest>;
    if (!isSpaceId(parsed.id) || typeof parsed.name !== "string") return null;
    if (typeof parsed.createdAt !== "string" || !isValidTimestamp(parsed.createdAt)) return null;
    if (typeof parsed.updatedAt !== "string" || !isValidTimestamp(parsed.updatedAt)) return null;
    return {
      version: 1,
      id: parsed.id,
      name: normalizeSpaceName(parsed.name),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    // An invalid or partially written work-fold manifest must not make its folder unusable.
    return null;
  }
}

async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file)) {
    try {
      if (await readFile(file, "utf8") === serialized) return;
    } catch {
      // Replace unreadable or concurrently changed metadata through the atomic path below.
    }
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Windows does not consistently allow directory handles. The fsynced temp
    // plus atomic rename remains the commit; directory sync is best-effort.
  }
}

async function scanDirectory(
  root: string,
  directory: string,
  depth: number,
  maxDepth: number,
  ignorePatterns: string[],
  includeIgnored: boolean,
  limit: FilesystemLimiter,
  budget: TreeScanBudget,
): Promise<TreeEntry[]> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }
  const entries = (await limit(() => readdir(directory, { withFileTypes: true })))
    .filter((entry) => !entry.isSymbolicLink() && !isAlwaysHiddenSpaceEntry(entry.name) && !isOfficeLockFileName(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const path = join(directory, entry.name);
      const relativePath = normalizeRelative(relative(root, path));
      return { entry, path, relativePath, ignored: isSpaceIgnored(relativePath, ignorePatterns) };
    })
    .filter((item) => includeIgnored || !item.ignored)
    .sort((left, right) => left.entry.isDirectory() === right.entry.isDirectory()
      ? left.entry.name.localeCompare(right.entry.name)
      : left.entry.isDirectory() ? -1 : 1);

  // The budget is applied before inspection, not after. A folder can hold far
  // more entries than the whole walk is allowed to return, and statting all of
  // them to then discard most is the cost this bound exists to avoid.
  const considered = entries.length > budget.remaining ? entries.slice(0, budget.remaining) : entries;
  if (considered.length < entries.length) budget.truncated = true;

  // Every entry needs its own stat for size and modification time. Inspecting a
  // folder's entries together turns one round trip per entry into one bounded
  // batch per folder, which is what a Space with a large flat folder pays for.
  const inspected = await Promise.all(considered.map(async (item) => {
    // A tree walk races ordinary file activity, so an entry that disappears
    // between readdir and stat is skipped rather than failing the whole Space.
    const info = await limit(() => stat(item.path).catch(() => null));
    if (!info) return null;
    return { ...item, info };
  }));

  const result: TreeEntry[] = [];
  for (const item of inspected) {
    if (!item) continue;
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    if (item.entry.isDirectory()) {
      const childrenLoaded = depth < maxDepth;
      const children = childrenLoaded
        ? await scanDirectory(root, item.path, depth + 1, maxDepth, ignorePatterns, includeIgnored, limit, budget)
        : [];
      // An empty child list means "no children" only when the walk was free to
      // look. If the budget ran out first, the folder has to be probed, or a
      // folder that does have contents would present as an empty one.
      const childrenAreComplete = childrenLoaded && budget.remaining > 0;
      const descendantIgnoredCount = children.reduce((total, child) => total + (child.ignored ? 1 : 0) + (child.descendantIgnoredCount ?? 0), 0);
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "folder",
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
        ...(descendantIgnoredCount ? { descendantIgnoredCount } : {}),
        hasChildren: childrenAreComplete
          ? children.length > 0
          : children.length > 0 || await directoryHasVisibleEntries(root, item.path, ignorePatterns, includeIgnored, limit),
        children,
      });
    } else {
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "file",
        sizeBytes: item.info.size,
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
      });
    }
  }
  return result.sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "folder" ? -1 : 1);
}

async function directoryHasVisibleEntries(
  root: string,
  directory: string,
  ignorePatterns: string[],
  includeIgnored: boolean,
  limit: FilesystemLimiter,
): Promise<boolean> {
  for (const entry of await limit(() => readdir(directory, { withFileTypes: true }).catch(() => []))) {
    if (entry.isSymbolicLink() || isAlwaysHiddenSpaceEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = normalizeRelative(relative(root, join(directory, entry.name)));
    if (!includeIgnored && isSpaceIgnored(relativePath, ignorePatterns)) continue;
    return true;
  }
  return false;
}

type FilesystemLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Caps how many filesystem calls the tree walk keeps in flight. Only leaf
 * operations pass through the limiter; recursion never holds a slot while
 * waiting for one, so a deep Space cannot deadlock its own walk.
 */
function createFilesystemLimiter(limit: number): FilesystemLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    // A finished task hands its slot directly to the next waiter instead of
    // releasing it and waking one. Releasing first lets a fresh caller claim
    // the free slot before the woken waiter resumes, so both proceed and the
    // cap is exceeded.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

async function visitSpaceFiles(root: string, directory: string, visitor: (relativePath: string, name: string) => void): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isAlwaysHiddenSpaceEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visitSpaceFiles(root, path, visitor);
    else if (entry.isFile()) visitor(normalizeRelative(relative(root, path)), entry.name);
  }
}

function contentTypeForExtension(extension: string | null): string {
  switch (extension) {
    case ".txt": return "text/plain";
    case ".md": case ".markdown": return "text/markdown";
    case ".json": return "application/json";
    case ".csv": return "text/csv";
    case ".html": case ".htm": return "text/html";
    case ".pdf": return "application/pdf";
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

async function copyVisiblePath(source: string, destination: string): Promise<void> {
  const info = await stat(source).catch(() => null);
  if (!info) throw notFound("Library item not found.");
  if (lstatSync(source).isSymbolicLink()) throw new Error("Symbolic links cannot be copied into a Space.");
  if (info.isFile()) {
    await copyFile(source, destination, 1);
    return;
  }
  if (!info.isDirectory()) throw new Error("Only ordinary files and folders can be copied.");
  await mkdir(destination, { recursive: false });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    await copyVisiblePath(join(source, entry.name), join(destination, entry.name));
  }
}

async function nextAvailableDirectory(parent: string, segment: string): Promise<string> {
  let candidate = join(parent, segment);
  for (let index = 2; existsSync(candidate); index += 1) candidate = join(parent, `${segment}-${index}`);
  return candidate;
}

async function nextAvailableFile(desired: string): Promise<string> {
  if (!existsSync(desired)) return desired;
  const extension = extname(desired);
  const stem = basename(desired, extension);
  let index = 2;
  let candidate = join(dirname(desired), `${stem} (${index})${extension}`);
  while (existsSync(candidate)) candidate = join(dirname(desired), `${stem} (${index += 1})${extension}`);
  return candidate;
}

async function nextAvailablePath(desired: string): Promise<string> {
  if (!existsSync(desired)) return desired;
  const info = await stat(desired);
  return info.isDirectory() ? nextAvailableDirectory(dirname(desired), basename(desired)) : nextAvailableFile(desired);
}

function assertNoLinkSegments(root: string, path: string): void {
  const rel = relative(root, path);
  if (!rel || rel === ".") return;
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) return;
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("Space paths cannot traverse symbolic links or junctions.");
  }
}

function safeUploadPath(value: string): string {
  const segments = normalizeRelative(value).split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) throw new Error("Uploaded file path is not allowed.");
  return segments.map(safeFileName).join("/");
}

function safeFileName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) throw new Error("File name is not allowed.");
  const windowsStem = name.split(".")[0]?.toLocaleUpperCase() ?? "";
  if (/[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)) {
    throw new Error("File name is reserved by Windows.");
  }
  return name.slice(0, 240);
}

function normalizeSpaceName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("Space name is required.");
  return name;
}

function safeSegment(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalizeRelative(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function stableSpaceId(spaceRoot: string): string {
  const normalized = process.platform === "win32" ? resolve(spaceRoot).toLocaleLowerCase() : resolve(spaceRoot);
  return `space-${createHash("sha256")
    .update(`${productIdentity.productName}:space-id:v1\0${normalized}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function isSpaceId(value: unknown): value is string {
  return typeof value === "string" && /^space-[a-f0-9]{16}$/.test(value);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}

function assertLinkedSpaceStateSeparation(spaceRoot: string): void {
  if (linkedSpaceStateSeparated(spaceRoot)) return;
  throw new Error("Linked folders cannot contain, or be contained by, work-fold application data. Choose a different folder.");
}

function linkedSpaceStateSeparated(spaceRoot: string): boolean {
  const root = resolve(spaceRoot);
  const stateRoot = resolve(workFoldStateRoot());
  return !pathContains(root, stateRoot) && !pathContains(stateRoot, root);
}

function pathContains(parentPath: string, childPath: string): boolean {
  const parent = normalizeComparisonPath(parentPath);
  const child = normalizeComparisonPath(childPath);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function normalizeComparisonPath(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

function looksLikeGoogleDrivePath(path: string): boolean {
  return /(^|[\\/])(google drive|my drive|shared drives|drivefs)([\\/]|$)/i.test(path);
}

function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

function isSpaceSummary(value: unknown): value is SpaceSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SpaceSummary>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.spaceRoot === "string"
    && item.location?.kind === "local" && (item.location.storage === "managed" || item.location.storage === "linked")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function spaceRemovalIntent(value: unknown): SpaceRemovalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Space registry contains an invalid removal intent.");
  }
  const item = value as Partial<SpaceRemovalIntent>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== [
    "transactionId", "spaceId", "spaceRoot", "storage", "managedBase", "managedRootIdentity", "managedRootClaimed", "phase", "requestedAt",
  ].sort().join("\0")
    || typeof item.transactionId !== "string"
    || !/^space-removal_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.transactionId)
    || !isSpaceId(item.spaceId)
    || typeof item.spaceRoot !== "string"
    || (item.storage !== "managed" && item.storage !== "linked")
    || typeof item.managedRootClaimed !== "boolean"
    || (item.phase !== "requested" && item.phase !== "app-state-removed")
    || typeof item.requestedAt !== "string" || !isValidTimestamp(item.requestedAt)) {
    throw new Error("Space registry contains an invalid removal intent.");
  }
  if (item.storage === "managed" && (typeof item.managedBase !== "string" || !isAbsolute(item.managedBase))) {
    throw new Error("Managed Space removal intent has no content boundary.");
  }
  if (item.storage === "managed" && !item.managedRootIdentity) {
    throw new Error("Managed Space removal intent has no root identity.");
  }
  if (item.storage === "linked" && (item.managedBase !== null || item.managedRootIdentity !== null || item.managedRootClaimed)) {
    throw new Error("Linked Space removal intent has unexpected managed-content authority.");
  }
  const intent: SpaceRemovalIntent = {
    transactionId: item.transactionId,
    spaceId: item.spaceId,
    spaceRoot: lexicalSpaceRoot(item.spaceRoot),
    storage: item.storage,
    managedBase: item.managedBase === null ? null : resolve(item.managedBase!),
    managedRootIdentity: item.managedRootIdentity === null ? null : managedRootIdentity(item.managedRootIdentity),
    managedRootClaimed: item.managedRootClaimed,
    phase: item.phase,
    requestedAt: item.requestedAt,
  };
  validateSpaceRemovalIntent(intent);
  return intent;
}

function validateSpaceRemovalIntent(intent: SpaceRemovalIntent): void {
  const spaceRoot = lexicalSpaceRoot(intent.spaceRoot);
  if (intent.storage === "managed") {
    const base = resolve(intent.managedBase!);
    if (samePath(spaceRoot, base) || !pathContains(base, spaceRoot)) {
      throw new Error("Managed Space removal intent escapes its registered content boundary.");
    }
    const identity = intent.managedRootIdentity;
    if (!identity || samePath(identity.realPath, identity.managedBaseRealPath)
      || !pathContains(identity.managedBaseRealPath, identity.realPath)) {
      throw new Error("Managed Space removal intent has an invalid canonical content boundary.");
    }
  } else if (intent.managedBase !== null || intent.managedRootIdentity !== null || intent.managedRootClaimed) {
    throw new Error("Linked Space removal intent cannot delete managed content.");
  }
}

function lexicalSpaceRoot(spaceRoot: string): string {
  if (!isAbsolute(spaceRoot)) throw new Error("Space removal intent root must be absolute.");
  const resolved = resolve(spaceRoot);
  if (resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Space removal intent.");
  return resolved;
}

function managedRootIdentity(value: unknown): ManagedSpaceRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Space removal intent has an invalid root identity.");
  }
  const item = value as Partial<ManagedSpaceRootIdentity>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["device", "inode", "managedBaseRealPath", "realPath"].sort().join("\0")
    || typeof item.realPath !== "string" || !isAbsolute(item.realPath)
    || typeof item.managedBaseRealPath !== "string" || !isAbsolute(item.managedBaseRealPath)
    || typeof item.device !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(item.device)
    || typeof item.inode !== "string" || !/^[1-9][0-9]*$/.test(item.inode)) {
    throw new Error("Managed Space removal intent has an invalid root identity.");
  }
  return {
    realPath: resolve(item.realPath),
    managedBaseRealPath: resolve(item.managedBaseRealPath),
    device: item.device,
    inode: item.inode,
  };
}

function assertId(value: string): void {
  if (!isSpaceId(value)) throw new Error("Invalid Space id.");
}

function notFound(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 404;
  return error;
}
