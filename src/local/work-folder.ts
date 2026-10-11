import { AsyncLocalStorage } from "node:async_hooks";
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
  managedWorkFolderRoot,
  workFolderStateDir,
  workFoldStateRoot,
  workFolderManifestFile,
  workFolderRegistryFile,
} from "./state-paths.js";
import { isAlwaysHiddenWorkFolderEntry, isWorkFolderIgnored, readWorkFolderIgnoreState } from "./work-folder-ignore.js";
import { containsReservedWorkFolderPathSegment } from "./work-folder-path-policy.js";
import { migrateWorkFolderMetadata } from "./vocabulary-migration.js";
import { productIdentity } from "../shared/product-identity.js";

import type { WorkFolderLocation, WorkFolderSummary } from "../shared/work-folder-summary.js";
export type { WorkFolderLocation, WorkFolderSummary } from "../shared/work-folder-summary.js";

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
  /** This folder is its own registered work-folder (2026-10-01): the walk stops at its boundary. */
  nestedFolder?: true;
}

export interface WorkFolderEntryInfo {
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

export interface WorkFolderMovedEntry {
  fromPath: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  updatedAt: string;
}

export interface WorkFolderCreatedEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt: string;
}

export interface WorkFolderTreeOptions {
  includeIgnored?: boolean;
  /**
   * Relative paths of work-folders registered inside this one. Each is listed as a
   * boundary entry with no children, the same separate ownership History and
   * Search already honor; a lazy read below one returns nothing.
   */
  nestedFolderPaths?: readonly string[];
}

export interface WorkFolderRemovalIntent {
  transactionId: string;
  workFolderId: string;
  workFolderRoot: string;
  storage: WorkFolderLocation["storage"];
  managedBase: string | null;
  managedRootIdentity: ManagedWorkFolderRootIdentity | null;
  managedRootClaimed: boolean;
  /**
   * Present exactly on a managed registration removal that keeps the folder
   * (`work-folders unregister` for managed storage, docs/act-ledger.md). A
   * preserve intent carries no managed-content deletion authority — no base,
   * no root identity, no claim — so neither finalization nor crash recovery
   * can ever delete under it. Absent means the managed folder is deleted,
   * exactly the pre-existing intent shape.
   */
  folderDisposition?: "preserve";
  phase: "requested" | "app-state-removed";
  requestedAt: string;
}

export interface ManagedWorkFolderRootIdentity {
  realPath: string;
  managedBaseRealPath: string;
  device: string;
  inode: string;
}

export interface WorkFolderRemovalResult {
  removed: true;
  deleted: boolean;
  workFolderRoot: string;
  cleanupPending: boolean;
}

export interface WorkFolderRegistry {
  version: 1;
  workFolders: WorkFolderSummary[];
  pendingRemovals: WorkFolderRemovalIntent[];
}

export interface WorkFolderRemovalIo {
  persistRegistry(registry: WorkFolderRegistry): Promise<void>;
  claimManagedRoot(workFolderRoot: string, claimPath: string): Promise<void>;
  restoreMismatchedManagedClaim(claimPath: string, workFolderRoot: string): Promise<void>;
  removeClaimedManagedRoot(claimPath: string): Promise<void>;
  removeWorkFolderState(workFolderRoot: string): Promise<void>;
}

interface PortableWorkFolderManifest {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

const maxPreviewBytes = 2 * 1024 * 1024;
const treeScanConcurrency = 64;

export async function listWorkFolders(): Promise<WorkFolderSummary[]> {
  const registry = await readRegistry();
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.workFolderId));
  const workFolders = registry.workFolders
    .filter((workFolder) => !removingIds.has(workFolder.id))
    .filter((workFolder) => existsSync(workFolder.workFolderRoot))
    .filter((workFolder) => workFolder.location.storage !== "linked" || linkedWorkFolderStateSeparated(workFolder.workFolderRoot))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  await Promise.all(workFolders.map(async (workFolder) => {
    try {
      await writePortableManifest(workFolder);
    } catch {
      // A previously linked folder can become read-only or temporarily unavailable.
      // Registry-backed listing must remain usable; the next successful mutation retries.
    }
  }));
  return workFolders;
}

export async function createManagedWorkFolder(name: string, baseDir = managedWorkFolderRoot()): Promise<WorkFolderSummary> {
  const normalizedName = normalizeWorkFolderName(name);
  await mkdir(baseDir, { recursive: true });
  const workFolderRoot = await nextAvailableDirectory(baseDir, safeSegment(normalizedName) || "work-folder");
  await mkdir(workFolderRoot, { recursive: false });
  try {
    return await registerWorkFolder({
      name: normalizedName,
      workFolderRoot,
      location: { kind: "local", storage: "managed" },
    });
  } catch (error) {
    await rm(workFolderRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Registers a managed folder that already exists inside the managed base —
 * the path a work-folder's folder takes when it comes back from Recently deleted
 * (docs/receipts-not-gates.md, F20). The folder's portable
 * `.work-fold/work-folder.json` identity is reused, so a restored work-folder keeps its
 * id, its Chats, and its History. Creating a brand-new managed folder stays
 * `createManagedWorkFolder`.
 */
export async function registerManagedWorkFolder(
  workFolderRoot: string,
  name: string,
  baseDir = managedWorkFolderRoot(),
): Promise<WorkFolderSummary> {
  const safeRoot = ensureSafeWorkFolderRoot(workFolderRoot);
  const base = resolve(baseDir);
  if (samePath(safeRoot, base) || !pathContains(base, safeRoot)) {
    throw new Error("work-fold only registers a managed work-folder inside its managed-content folder.");
  }
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder for this work-folder does not exist.");
  return registerWorkFolder({
    name: normalizeWorkFolderName(name),
    workFolderRoot: safeRoot,
    location: { kind: "local", storage: "managed" },
  });
}

/**
 * Records a content mutation a caller performed through another path (the
 * trash move behind `files delete`), so the registry's `updatedAt` and the
 * portable manifest stay as truthful as they are after `deleteWorkFolderEntry`.
 */
export async function touchWorkFolderRoot(workFolderRoot: string): Promise<void> {
  await touchWorkFolder(ensureSafeWorkFolderRoot(workFolderRoot));
}

export async function registerLinkedWorkFolder(workFolderRoot: string, providerHint?: "google-drive"): Promise<WorkFolderSummary> {
  const safeRoot = ensureSafeWorkFolderRoot(workFolderRoot);
  assertLinkedWorkFolderStateSeparation(safeRoot);
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder selected for this work-folder does not exist.");
  return registerWorkFolder({
    name: basename(safeRoot),
    workFolderRoot: safeRoot,
    location: {
      kind: "local",
      storage: "linked",
      ...(providerHint === "google-drive" || looksLikeGoogleDrivePath(safeRoot) ? { providerHint: "google-drive" as const } : {}),
    },
  });
}

export async function getWorkFolder(workFolderId: string): Promise<WorkFolderSummary> {
  assertId(workFolderId);
  const workFolder = (await listWorkFolders()).find((item) => item.id === workFolderId);
  if (!workFolder) throw notFound("work-folder not found.");
  if (workFolder.location.storage === "linked") assertLinkedWorkFolderStateSeparation(workFolder.workFolderRoot);
  return workFolder;
}

export async function renameWorkFolder(workFolderId: string, name: string): Promise<WorkFolderSummary> {
  assertId(workFolderId);
  const normalizedName = normalizeWorkFolderName(name);
  return withRegistryMutation(async () => {
    const registry = await readRegistry();
    const workFolder = registry.workFolders.find((item) => item.id === workFolderId);
    if (!workFolder || registry.pendingRemovals.some((intent) => intent.workFolderId === workFolderId)
      || !existsSync(workFolder.workFolderRoot)) throw notFound("work-folder not found.");
    workFolder.name = normalizedName;
    workFolder.updatedAt = new Date().toISOString();
    await commitRegistryAndPortableManifest(registry, workFolder);
    return workFolder;
  });
}

/**
 * Persists the user-authorized removal before any App or content cleanup. From
 * this point the work-folder is intentionally hidden from every registry projection;
 * startup recovery can safely roll the operation forward after a crash.
 */
export async function beginWorkFolderRemoval(
  workFolderId: string,
  managedBase = managedWorkFolderRoot(),
  io: Partial<WorkFolderRemovalIo> = {},
  options: { folderDisposition?: "delete" | "preserve" } = {},
): Promise<WorkFolderRemovalIntent> {
  assertId(workFolderId);
  const requestedDisposition = options.folderDisposition ?? "delete";
  return withRegistryOwnershipMutation(async () => {
    const registry = await readRegistry();
    const existing = registry.pendingRemovals.find((intent) => intent.workFolderId === workFolderId);
    if (existing) {
      // An in-flight intent's folder authority is settled; converting a
      // pending deletion into a preservation (or the reverse) mid-flight
      // would make crash recovery act on an authority the caller never held.
      if (existing.storage === "managed"
        && (existing.folderDisposition === "preserve") !== (requestedDisposition === "preserve")) {
        throw new Error("A work-folder removal with a different folder disposition is already in progress.");
      }
      if (existing.storage === "managed" && existing.folderDisposition !== "preserve") {
        assertNoNestedWorkFolderDeletion(registry, existing.workFolderId, existing.workFolderRoot);
      }
      return structuredClone(existing);
    }
    const workFolder = registry.workFolders.find((item) => item.id === workFolderId);
    if (!workFolder || !existsSync(workFolder.workFolderRoot)) throw notFound("work-folder not found.");
    const workFolderRoot = ensureSafeWorkFolderRoot(workFolder.workFolderRoot);
    // A preserve removal deletes nothing, so it records no managed-content
    // boundary and no root identity: the intent shape itself proves the
    // deletion machinery has nothing to act on.
    const preserveManagedFolder = workFolder.location.storage === "managed" && requestedDisposition === "preserve";
    const base = workFolder.location.storage === "managed" && !preserveManagedFolder ? resolve(managedBase) : null;
    if (base) assertNoNestedWorkFolderDeletion(registry, workFolder.id, workFolderRoot);
    if (base && (samePath(workFolderRoot, base) || !pathContains(base, workFolderRoot))) {
      throw new Error("work-fold will only delete a managed work-folder inside its registered managed-content folder.");
    }
    const managedRootIdentity = base !== null
      ? await captureManagedRootIdentity(workFolderRoot, base)
      : null;
    const intent: WorkFolderRemovalIntent = {
      transactionId: `space-removal_${randomUUID()}`,
      workFolderId: workFolder.id,
      workFolderRoot,
      storage: workFolder.location.storage,
      managedBase: base,
      managedRootIdentity,
      managedRootClaimed: false,
      ...(preserveManagedFolder ? { folderDisposition: "preserve" as const } : {}),
      phase: "requested",
      requestedAt: new Date().toISOString(),
    };
    registry.pendingRemovals.push(intent);
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function markWorkFolderRemovalAppStateRemoved(
  workFolderId: string,
  io: Partial<WorkFolderRemovalIo> = {},
): Promise<WorkFolderRemovalIntent> {
  assertId(workFolderId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry();
    const intent = registry.pendingRemovals.find((item) => item.workFolderId === workFolderId);
    if (!intent) throw new Error("work-folder removal intent not found.");
    if (intent.phase === "app-state-removed") return structuredClone(intent);
    intent.phase = "app-state-removed";
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function listPendingWorkFolderRemovals(): Promise<WorkFolderRemovalIntent[]> {
  return (await readRegistry()).pendingRemovals.map((intent) => structuredClone(intent));
}

export async function finalizeWorkFolderRemoval(
  workFolderId: string,
  io: Partial<WorkFolderRemovalIo> = {},
): Promise<WorkFolderRemovalResult> {
  assertId(workFolderId);
  return withRegistryOwnershipMutation(async () => {
    const registry = await readRegistry();
    const intent = registry.pendingRemovals.find((item) => item.workFolderId === workFolderId);
    if (!intent) throw new Error("work-folder removal intent not found.");
    if (intent.phase !== "app-state-removed") {
      throw new Error("work-folder cleanup cannot start before App state has been removed.");
    }
    const workFolder = registry.workFolders.find((item) => item.id === workFolderId);
    if (!workFolder || !samePath(workFolder.workFolderRoot, intent.workFolderRoot)
      || workFolder.location.storage !== intent.storage) {
      throw new Error("work-folder removal intent no longer matches the registered work-folder.");
    }
    validateWorkFolderRemovalIntent(intent);
    if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
      assertNoNestedWorkFolderDeletion(registry, intent.workFolderId, intent.workFolderRoot);
    }
    const operations = removalIo(io);
    let deleted = false;
    // A preserve intent carries no deletion authority (null base, null root
    // identity), so the managed claim-and-delete machinery below must never
    // run for it: the registration and app state go, the folder stays.
    if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
      const claimPath = managedRemovalClaimPath(intent);
      let claimStatus = await managedClaimStatus(intent);
      if (claimStatus === "mismatch") {
        if (await managedRootStatus(intent) === "absent") {
          await operations.restoreMismatchedManagedClaim(claimPath, intent.workFolderRoot).catch(() => undefined);
        }
        return workFolderRemovalPendingResult(intent);
      }
      if (claimStatus === "unavailable") {
        return workFolderRemovalPendingResult(intent);
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
          return workFolderRemovalPendingResult(intent);
        } else {
          try {
            await operations.claimManagedRoot(intent.workFolderRoot, claimPath);
          } catch {
            return workFolderRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
          if (claimStatus !== "matching") {
            if (claimStatus === "mismatch" && await managedRootStatus(intent) === "absent") {
              await operations.restoreMismatchedManagedClaim(claimPath, intent.workFolderRoot).catch(() => undefined);
            }
            return workFolderRemovalPendingResult(intent);
          }
        }
      }

      if (!deleted && !intent.managedRootClaimed) {
        intent.managedRootClaimed = true;
        try {
          await operations.persistRegistry(registry);
        } catch {
          return workFolderRemovalPendingResult(intent);
        }
      }

      if (!deleted) {
        claimStatus = await managedClaimStatus(intent);
        if (claimStatus === "matching") {
          try {
            await operations.removeClaimedManagedRoot(claimPath);
          } catch {
            return workFolderRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
        }
        if (claimStatus !== "absent") return workFolderRemovalPendingResult(intent);
        deleted = true;
      }
    }
    try {
      await operations.removeWorkFolderState(intent.workFolderRoot);
    } catch {
      return workFolderRemovalPendingResult(intent);
    }

    const next: WorkFolderRegistry = {
      ...registry,
      workFolders: registry.workFolders.filter((item) => item.id !== workFolderId),
      pendingRemovals: registry.pendingRemovals.filter((item) => item.workFolderId !== workFolderId),
    };
    try {
      await operations.persistRegistry(next);
    } catch {
      return workFolderRemovalPendingResult(intent);
    }
    return { removed: true, deleted, workFolderRoot: intent.workFolderRoot, cleanupPending: false };
  });
}

/**
 * Effect-time pin recheck for the prepared `work-folder.delete-folder` act
 * (docs/receipts-not-gates.md, F19): re-verifies the pinned work-folder identity
 * and canonical root against the live registry immediately before the
 * deletion executes. There is no decision time — the verb runs on its first
 * call — so this is the recheck the prepare-pin-journal-execute path performs
 * on its way to the effect. Identity only: the `.workspace/` fail-closed
 * rule, managed-base containment, and managed-root identity claims are
 * re-verified by the removal machinery itself at execution, exactly as they
 * are for a desktop-initiated deletion.
 */
export async function managedWorkFolderDeletionPinIssue(
  pins: { workFolderId: string; workFolderRoot: string },
): Promise<string | null> {
  const workFolder = (await listWorkFolders()).find((item) => item.id === pins.workFolderId);
  if (!workFolder) return "The pinned work-folder is no longer registered.";
  if (workFolder.location.storage !== "managed") {
    return "The pinned work-folder is not managed by work-fold; only a managed work-folder's folder can be deleted.";
  }
  if (!samePath(workFolder.workFolderRoot, pins.workFolderRoot)) {
    return "The registered work-folder's folder no longer matches the pinned canonical root.";
  }
  return null;
}

export async function workFolderRemovalPendingResult(
  intent: Pick<WorkFolderRemovalIntent,
    "transactionId" | "workFolderRoot" | "storage" | "managedBase" | "managedRootIdentity" | "managedRootClaimed" | "folderDisposition">,
): Promise<WorkFolderRemovalResult> {
  const deletes = intent.storage === "managed" && intent.folderDisposition !== "preserve";
  const rootStatus = deletes ? await managedRootStatus(intent) : "mismatch";
  const deleted = deletes
    && await managedClaimStatus(intent) === "absent"
    && (rootStatus === "absent" || (intent.managedRootClaimed && rootStatus === "mismatch"));
  return {
    removed: true,
    deleted,
    workFolderRoot: intent.workFolderRoot,
    cleanupPending: true,
  };
}

export interface WorkFolderTreeScan {
  entries: TreeEntry[];
  /** True when the entry budget stopped the walk before the folder was exhausted. */
  truncated: boolean;
}

interface TreeScanBudget {
  remaining: number;
  truncated: boolean;
}

export async function scanWorkFolderTree(
  workFolderRoot: string,
  maxDepth = 20,
  relativePath = "",
  options: WorkFolderTreeOptions = {},
): Promise<WorkFolderTreeScan> {
  const safeRoot = ensureSafeWorkFolderRoot(workFolderRoot);
  const scanRoot = resolveWorkFolderPath(safeRoot, relativePath || ".");
  const info = await stat(scanRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Requested work-folder tree path is not a folder.");
  const ignoreState = await readWorkFolderIgnoreState(safeRoot);
  const boundaries = new Set(options.nestedFolderPaths ?? []);
  // Compare the resolved location, as the file system sees it, so
  // `packages//api`, `packages/./api`, or `Packages/api` cannot list a nested
  // work-folder's contents through its parent.
  const requested = comparableRelative(relative(safeRoot, scanRoot));
  const comparableBoundaries = [...boundaries].map(comparableRelative);
  if (requested && comparableBoundaries.some((boundary) => requested === boundary || requested.startsWith(`${boundary}/`))) {
    return { entries: [], truncated: false };
  }
  // A work-folder is an arbitrary folder and may hold far more entries than a
  // navigator can present. The walk stops at a total entry budget and says so,
  // so a partial tree is never mistaken for the whole work-folder.
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
    boundaries,
  );
  return { entries, truncated: budget.truncated };
}

function maxTreeEntries(): number {
  const configured = Number(process.env.WORKFOLD_TREE_MAX_ENTRIES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 20_000;
}

export async function readWorkFolderTextFile(workFolderRoot: string, relativePath: string): Promise<{ text: string }> {
  const path = resolveWorkFolderPath(workFolderRoot, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (info.size > maxPreviewBytes) throw new Error("This file is too large to preview (2 MB maximum).");
  const bytes = await readFile(path);
  if (looksBinary(bytes)) throw new Error("This file is binary and cannot be previewed as text.");
  return { text: bytes.toString("utf8") };
}

export async function writeWorkFolderTextFile(workFolderRoot: string, relativePath: string, text: string): Promise<{ path: string; text: string }> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const path = resolveWorkFolderPath(root, relativePath);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, path)));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("This file is too large to edit (2 MB maximum).");
  await writeFile(path, text, "utf8");
  await touchWorkFolder(workFolderRoot);
  return { path: normalizeRelative(relative(ensureSafeWorkFolderRoot(workFolderRoot), path)), text };
}

export async function getWorkFolderEntryInfo(workFolderRoot: string, relativePath: string): Promise<WorkFolderEntryInfo> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const path = resolveWorkFolderPath(root, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("work-folder item not found.");
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

/**
 * The file tab's read-only inline preview. Text renders from a bounded head
 * read with the truncation disclosed; recognized image types defer to the
 * raw-file route, as do PDFs; binary or oversized content declines with its reason
 * instead of decoding garbage. The read honors the same work-folder path policy as
 * every other entry route.
 */
const previewTextByteLimit = 256 * 1024;
const previewImageByteLimit = 12 * 1024 * 1024;
const previewPdfByteLimit = 200 * 1024 * 1024;
const previewImageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"]);

export interface WorkFolderFilePreview {
  kind: "text" | "image" | "pdf" | "none";
  reason?: "folder" | "binary" | "too-large";
  content?: string;
  truncated?: boolean;
  sizeBytes: number;
}

export async function getWorkFolderFilePreview(workFolderRoot: string, relativePath: string): Promise<WorkFolderFilePreview> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const path = resolveWorkFolderPath(root, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("work-folder item not found.");
  if (info.isDirectory()) return { kind: "none", reason: "folder", sizeBytes: 0 };
  const extension = extname(path).toLowerCase();
  if (previewImageExtensions.has(extension)) {
    return info.size <= previewImageByteLimit
      ? { kind: "image", sizeBytes: info.size }
      : { kind: "none", reason: "too-large", sizeBytes: info.size };
  }
  // PDFs render in the built-in viewer from the raw-file route. The renderer
  // holds the whole file as a blob, so very large ones fall back to Open.
  if (extension === ".pdf") {
    return info.size <= previewPdfByteLimit
      ? { kind: "pdf", sizeBytes: info.size }
      : { kind: "none", reason: "too-large", sizeBytes: info.size };
  }
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(Math.min(info.size, previewTextByteLimit));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    if (previewLooksBinary(head)) return { kind: "none", reason: "binary", sizeBytes: info.size };
    const truncated = info.size > previewTextByteLimit;
    // A bounded read can split a UTF-8 sequence; drop the dangling
    // replacement character rather than rendering it as content.
    const content = truncated ? head.toString("utf8").replace(/�+$/, "") : head.toString("utf8");
    return { kind: "text", content, truncated, sizeBytes: info.size };
  } finally {
    await handle.close();
  }
}

/** Mirrors the content-search admission rule in search.ts (looksBinary). */
function previewLooksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  return sample.length > 0 && controls / sample.length > 0.1;
}

export async function findExistingWorkFolderFilePaths(workFolderRoot: string, requestedPaths: string[]): Promise<string[]> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const requests = [...new Set(requestedPaths.map(normalizeRelative).filter(Boolean))].slice(0, 32);
  const existing = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const request of requests) {
    try {
      const path = resolveWorkFolderPath(root, request);
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
    await visitWorkFolderFiles(root, root, (path, name) => matches.get(name.toLocaleLowerCase())?.push(path));
    for (const paths of matches.values()) if (paths.length === 1 && paths[0]) existing.add(paths[0]);
  }
  return [...existing].sort((left, right) => left.localeCompare(right));
}

export async function moveWorkFolderEntry(
  workFolderRoot: string,
  input: { sourcePath: string; targetFolderPath?: string },
): Promise<WorkFolderMovedEntry> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const sourcePath = normalizeRelative(input.sourcePath);
  const targetFolderPath = normalizeRelative(input.targetFolderPath ?? "");
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to move.");
  if (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`)) throw new Error("Folders cannot be moved into themselves.");
  await assertOutsideNestedFolders(root, sourcePath);
  if (targetFolderPath) await assertOutsideNestedFolders(root, `${targetFolderPath}/${basename(sourcePath)}`);
  const source = resolveWorkFolderPath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The work-folder root cannot be moved.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("work-folder item not found.");
  const targetFolder = resolveWorkFolderPath(root, targetFolderPath || ".");
  if (!(await stat(targetFolder)).isDirectory()) throw new Error("Move items into a folder.");
  if (dirname(source) === targetFolder) throw new Error("That item is already in the selected folder.");
  const destination = join(targetFolder, basename(source));
  if (existsSync(destination)) throw new Error(`A file or folder named ${basename(source)} already exists there.`);
  await rename(source, destination);
  const movedInfo = await stat(destination);
  await touchWorkFolder(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: basename(destination),
    kind: movedInfo.isDirectory() ? "folder" : "file",
    updatedAt: movedInfo.mtime.toISOString(),
  };
}

export async function renameWorkFolderEntry(
  workFolderRoot: string,
  input: { path: string; newName: string },
): Promise<WorkFolderMovedEntry> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const sourcePath = normalizeRelative(input.path);
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to rename.");
  const newName = safeFileName(input.newName);
  await assertOutsideNestedFolders(root, sourcePath);
  const source = resolveWorkFolderPath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The work-folder root cannot be renamed.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("work-folder item not found.");
  if (basename(source) === newName) throw new Error("That item already has this name.");
  const destination = join(dirname(source), newName);
  resolveWorkFolderPath(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${newName} already exists there.`);
  await rename(source, destination);
  const renamedInfo = await stat(destination);
  await touchWorkFolder(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: newName,
    kind: renamedInfo.isDirectory() ? "folder" : "file",
    updatedAt: renamedInfo.mtime.toISOString(),
  };
}

export async function createWorkFolderFolder(
  workFolderRoot: string,
  parentPath: string,
  name: string,
): Promise<WorkFolderCreatedEntry> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const parent = resolveWorkFolderPath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create folders inside a work-folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${safeName} already exists there.`);
  await mkdir(destination, { recursive: false });
  const info = await stat(destination);
  await touchWorkFolder(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "folder",
    updatedAt: info.mtime.toISOString(),
  };
}

export async function createWorkFolderTextFile(
  workFolderRoot: string,
  parentPath: string,
  name: string,
  text = "",
): Promise<WorkFolderCreatedEntry> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const parent = resolveWorkFolderPath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create files inside a work-folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("The new file is too large (2 MB maximum).");
  await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
  const info = await stat(destination);
  await touchWorkFolder(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "file",
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

/**
 * The one resolution a delete performs before it commits to erasing or
 * moving: the same path policy, root refusal, and existence check
 * `deleteWorkFolderEntry` applies, exposed so the Recently deleted lane
 * (docs/receipts-not-gates.md, F20) can move the exact entry instead.
 */
export async function resolveWorkFolderDeleteTarget(
  workFolderRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") throw new Error("Select a file or folder to delete.");
  await assertOutsideNestedFolders(root, normalized);
  const path = resolveWorkFolderPath(root, normalized);
  if (samePath(path, root)) throw new Error("The work-folder root cannot be deleted.");
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("work-folder item not found.");
  return { absolutePath: path, path: normalized, kind: info.isDirectory() ? "folder" : "file" };
}

export async function deleteWorkFolderEntry(workFolderRoot: string, relativePath: string): Promise<{ deleted: true; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const target = await resolveWorkFolderDeleteTarget(root, relativePath);
  await rm(target.absolutePath, { recursive: target.kind === "folder", force: false });
  await touchWorkFolder(root);
  return { deleted: true, path: target.path, kind: target.kind };
}

export async function writeUploadedFiles(
  workFolderRoot: string,
  targetFolderPath: string,
  files: Array<{ fileName: string; relativePath?: string; data: Buffer }>,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const targetFolder = resolveWorkFolderPath(root, targetFolderPath || ".");
  const uploads = files.map((file) => ({
    desired: resolveWorkFolderPath(targetFolder, safeUploadPath(file.relativePath || file.fileName)),
    data: file.data,
  }));
  // Validate the whole batch before making directories or writing an earlier
  // file. The collision name may be a sibling of a nested work-folder, so check
  // the actual available destination rather than refusing its occupied name.
  for (const { desired } of uploads) {
    const destination = await nextAvailableFile(desired);
    await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  }
  await mkdir(targetFolder, { recursive: true });
  const written: Array<{ path: string; sizeBytes: number }> = [];
  const destinations: string[] = [];
  let attempted: string | null = null;
  try {
    for (const { desired, data } of uploads) {
      await mkdir(dirname(desired), { recursive: true });
      const destination = await nextAvailableFile(desired);
      await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
      attempted = destination;
      await writeFile(destination, data, { flag: "wx" });
      attempted = null;
      destinations.push(destination);
      written.push({ path: normalizeRelative(relative(root, destination)), sizeBytes: data.byteLength });
    }
  } catch (error) {
    // The upload batch is one action: a mid-batch failure must not strand the
    // files that already landed, nor a partially written current file.
    await Promise.all([...destinations, ...(attempted ? [attempted] : [])].map((path) =>
      rm(path, { force: true }).catch(() => undefined)));
    throw error;
  }
  await touchWorkFolder(workFolderRoot);
  return written;
}

export async function copyPathIntoWorkFolder(
  sourcePath: string,
  workFolderRoot: string,
  targetFolderPath: string,
): Promise<string> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const targetFolder = resolveWorkFolderPath(root, targetFolderPath || ".");
  const destination = await nextAvailablePath(join(targetFolder, safeFileName(basename(sourcePath))));
  await assertOutsideNestedFolders(root, normalizeRelative(relative(root, destination)));
  await mkdir(targetFolder, { recursive: true });
  try {
    await copyVisiblePath(sourcePath, destination);
  } catch (error) {
    // A folder copy that fails partway must not strand a partial destination.
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await touchWorkFolder(workFolderRoot);
  return normalizeRelative(relative(workFolderRoot, destination));
}

export function resolveWorkFolderPath(workFolderRoot: string, relativePath: string): string {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const normalized = normalizeRelative(relativePath || ".");
  if (isAbsolute(relativePath) || normalized.split("/").includes("..")) {
    throw new Error("Path escapes the selected work-folder.");
  }
  if (containsReservedWorkFolderPathSegment(normalized)) {
    throw new Error("Path selects reserved work-fold, legacy product, or Pi metadata.");
  }
  const path = resolve(root, normalized || ".");
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Path escapes the selected work-folder.");
  assertNoLinkSegments(root, path);
  return path;
}

export function ensureSafeWorkFolderRoot(workFolderRoot: string): string {
  const resolved = resolve(workFolderRoot);
  if (!isAbsolute(resolved) || resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a work-folder.");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) throw new Error("A work-folder cannot be a symbolic link or junction.");
  return resolved;
}

export function assertWorkFolderDoesNotContainState(workFolderRoot: string): void {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
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

async function registerWorkFolder(input: Omit<WorkFolderSummary, "id" | "createdAt" | "updatedAt">): Promise<WorkFolderSummary> {
  return withRegistryOwnershipMutation(async () => {
    const registry = await readRegistry();
    const workFolderRoot = resolve(input.workFolderRoot);
    if (registry.pendingRemovals.some((intent) => intent.storage === "managed"
      && intent.folderDisposition !== "preserve" && !samePath(intent.workFolderRoot, workFolderRoot)
      && pathContains(intent.workFolderRoot, workFolderRoot))) {
      throw Object.assign(new Error("This folder belongs to a work-folder that is still being removed. Wait for its cleanup before registering it."), { status: 409, statusCode: 409 });
    }
    const existing = registry.workFolders.find((workFolder) => samePath(workFolder.workFolderRoot, workFolderRoot));
    if (existing) {
      if (registry.pendingRemovals.some((intent) => intent.workFolderId === existing.id)) {
        throw new Error("This work-folder is still being removed. Restart work-fold to retry its cleanup.");
      }
      await writePortableManifest(existing);
      return existing;
    }
    const portableIdentity = await readExistingWorkFolderManifest(workFolderRoot);
    const now = new Date().toISOString();
    if (portableIdentity) {
      const identityOwner = registry.workFolders.find((workFolder) => workFolder.id === portableIdentity.id);
      if (identityOwner) {
        if (registry.pendingRemovals.some((intent) => intent.workFolderId === identityOwner.id)) {
          throw new Error("This work-folder is still being removed. Restart work-fold to retry its cleanup.");
        }
        if (existsSync(identityOwner.workFolderRoot)) {
          throw new Error("This work-folder identity is already linked to another folder.");
        }
        await relocateWorkFolderState(identityOwner.workFolderRoot, workFolderRoot, identityOwner.id);
        identityOwner.name = portableIdentity.name;
        identityOwner.workFolderRoot = workFolderRoot;
        identityOwner.location = input.location;
        identityOwner.createdAt = portableIdentity.createdAt;
        identityOwner.updatedAt = now;
        await commitRegistryAndPortableManifest(registry, identityOwner);
        return identityOwner;
      }
    }
    const id = portableIdentity?.id ?? stableWorkFolderId(workFolderRoot);
    const identityCollision = registry.workFolders.find((workFolder) => workFolder.id === id);
    if (identityCollision) throw new Error("This work-folder identity is already registered to another folder.");
    const workFolder: WorkFolderSummary = {
      ...input,
      id,
      name: portableIdentity?.name ?? input.name,
      workFolderRoot,
      createdAt: portableIdentity?.createdAt ?? now,
      updatedAt: now,
    };
    registry.workFolders.push(workFolder);
    await commitRegistryAndPortableManifest(registry, workFolder);
    return workFolder;
  });
}

async function touchWorkFolder(workFolderRoot: string): Promise<void> {
  await withRegistryMutation(async () => {
    const registry = await readRegistry();
    const workFolder = registry.workFolders.find((item) => samePath(item.workFolderRoot, workFolderRoot));
    if (!workFolder || registry.pendingRemovals.some((intent) => intent.workFolderId === workFolder.id)) return;
    workFolder.updatedAt = new Date().toISOString();
    try {
      await commitRegistryAndPortableManifest(registry, workFolder);
    } catch {
      // The content mutation already succeeded. Leave both metadata records at their
      // previous values and retry maintenance on a later mutation or work-folder listing.
    }
  });
}

async function readRegistry(): Promise<WorkFolderRegistry> {
  const file = workFolderRegistryFile();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<WorkFolderRegistry>;
    if (!Array.isArray(parsed.workFolders)) throw new Error("work-folder registry work-folders are invalid.");
    const workFolders = parsed.workFolders.map((workFolder) => {
      if (!isWorkFolderSummary(workFolder)) throw new Error("work-folder registry contains an invalid work-folder.");
      return { ...workFolder, workFolderRoot: resolve(workFolder.workFolderRoot) };
    });
    const pendingRemovals = parsed.pendingRemovals === undefined
      ? []
      : parsed.pendingRemovals.map((intent) => workFolderRemovalIntent(intent));
    const workFolderById = new Map(workFolders.map((workFolder) => [workFolder.id, workFolder]));
    if (new Set(pendingRemovals.map((intent) => intent.workFolderId)).size !== pendingRemovals.length
      || new Set(pendingRemovals.map((intent) => intent.transactionId)).size !== pendingRemovals.length
      || pendingRemovals.some((intent) => {
        const workFolder = workFolderById.get(intent.workFolderId);
        return !workFolder
          || !samePath(workFolder.workFolderRoot, intent.workFolderRoot)
          || workFolder.location.storage !== intent.storage;
      })) {
      throw new Error("work-folder registry removal intents are inconsistent.");
    }
    return {
      version: 1,
      workFolders,
      pendingRemovals,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyWorkFolderRegistry();
    // An I/O failure or malformed registry is not evidence that the person has
    // no work-folders. Keep the last rendered state and surface a retryable failure.
    throw new Error("work-folder registry could not be read safely.", { cause: error });
  }
}

async function writeRegistry(registry: WorkFolderRegistry): Promise<void> {
  const file = workFolderRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicJsonWrite(file, registry);
}

function emptyWorkFolderRegistry(): WorkFolderRegistry {
  return { version: 1, workFolders: [], pendingRemovals: [] };
}

function removalIo(overrides: Partial<WorkFolderRemovalIo>): WorkFolderRemovalIo {
  return {
    persistRegistry: writeRegistry,
    claimManagedRoot: async (workFolderRoot, claimPath) => {
      await rename(workFolderRoot, claimPath);
      await syncDirectoriesBestEffort([dirname(workFolderRoot), dirname(claimPath)]);
    },
    restoreMismatchedManagedClaim: async (claimPath, workFolderRoot) => {
      await rename(claimPath, workFolderRoot);
      await syncDirectoriesBestEffort([dirname(claimPath), dirname(workFolderRoot)]);
    },
    removeClaimedManagedRoot: async (claimPath) => {
      await rm(claimPath, { recursive: true, force: true });
      await syncDirectoriesBestEffort([dirname(claimPath)]);
    },
    removeWorkFolderState: async (workFolderRoot) => rm(workFolderStateDir(workFolderRoot), { recursive: true, force: true }),
    ...overrides,
  };
}

type ManagedRootStatus = "matching" | "absent" | "mismatch" | "unavailable";

async function captureManagedRootIdentity(workFolderRoot: string, managedBase: string): Promise<ManagedWorkFolderRootIdentity> {
  const initialInfo = await lstat(workFolderRoot, { bigint: true });
  if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink()) {
    throw new Error("A managed work-folder root must be an ordinary directory.");
  }
  if (initialInfo.ino === 0n) throw new Error("This filesystem does not expose a stable managed work-folder directory identity.");
  const [realPath, managedBaseRealPath] = await Promise.all([realpath(workFolderRoot), realpath(managedBase)]);
  const confirmedInfo = await lstat(workFolderRoot, { bigint: true });
  if (!confirmedInfo.isDirectory() || confirmedInfo.isSymbolicLink()
    || confirmedInfo.dev !== initialInfo.dev || confirmedInfo.ino !== initialInfo.ino) {
    throw new Error("The managed work-folder root changed while its removal identity was being recorded.");
  }
  if (samePath(realPath, managedBaseRealPath) || !pathContains(managedBaseRealPath, realPath)) {
    throw new Error("A managed work-folder root must resolve inside its managed-content folder.");
  }
  return {
    realPath: resolve(realPath),
    managedBaseRealPath: resolve(managedBaseRealPath),
    device: confirmedInfo.dev.toString(10),
    inode: confirmedInfo.ino.toString(10),
  };
}

async function managedRootStatus(
  intent: Pick<WorkFolderRemovalIntent, "workFolderRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  return managedDirectoryStatus(intent, intent.workFolderRoot, intent.managedRootIdentity?.realPath ?? intent.workFolderRoot);
}

async function managedClaimStatus(
  intent: Pick<WorkFolderRemovalIntent,
    "transactionId" | "workFolderRoot" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  const claimPath = managedRemovalClaimPath(intent);
  return managedDirectoryStatus(intent, claimPath, claimPath);
}

async function managedDirectoryStatus(
  intent: Pick<WorkFolderRemovalIntent, "storage" | "managedBase" | "managedRootIdentity">,
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
  intent: Pick<WorkFolderRemovalIntent, "transactionId" | "storage" | "managedRootIdentity">,
): string {
  if (intent.storage !== "managed" || !intent.managedRootIdentity
    || !/^space-removal_[0-9a-f-]{36}$/.test(intent.transactionId)) {
    throw new Error("Managed work-folder removal intent cannot derive a safe claim path.");
  }
  const claimPath = resolve(
    intent.managedRootIdentity.managedBaseRealPath,
    `.space-removal-${intent.transactionId.slice("space-removal_".length)}`,
  );
  if (dirname(claimPath) !== resolve(intent.managedRootIdentity.managedBaseRealPath)) {
    throw new Error("Managed work-folder removal claim escapes its content boundary.");
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

const historyContext = new AsyncLocalStorage<Set<string>>();
const activeHistoryRoots = new Set<string>();
let ownershipMutations = 0;

/** Holds folder ownership stable through a complete capture or restore. Nested
 * captures for the same restore are reentrant; independent writers conflict. */
export async function withWorkFolderHistoryOperation<T>(workFolderRoot: string, operation: () => Promise<T>): Promise<T> {
  const root = resolve(workFolderRoot);
  if (historyContext.getStore()?.has(root)) return operation();
  if (ownershipMutations || activeHistoryRoots.has(root)) {
    throw Object.assign(new Error("Wait for the current History or work-folder registration operation to finish."), { status: 409, statusCode: 409 });
  }
  activeHistoryRoots.add(root);
  try {
    return await historyContext.run(new Set([...(historyContext.getStore() ?? []), root]), operation);
  } finally { activeHistoryRoots.delete(root); }
}

async function withRegistryOwnershipMutation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeHistoryRoots.size) throw Object.assign(new Error("Wait for History to finish before changing registered work-folders."), { status: 409, statusCode: 409 });
  ownershipMutations += 1;
  try { return await withRegistryMutation(operation); }
  finally { ownershipMutations -= 1; }
}

function assertNoNestedWorkFolderDeletion(registry: WorkFolderRegistry, workFolderId: string, workFolderRoot: string): void {
  if (registry.workFolders.some((nested) => nested.id !== workFolderId && pathContains(workFolderRoot, nested.workFolderRoot))) {
    throw Object.assign(new Error("Remove the nested work-folder registrations before deleting this work-folder."), { status: 409, statusCode: 409 });
  }
}

/**
 * The registered work-folders' ids, names, and roots straight from the registry,
 * excluding pending removals. Unlike listWorkFolders() it never rewrites portable
 * manifests, so a hot path (every turn) can read nesting without
 * touching any work-folder on disk.
 */
export async function registeredWorkFolderOutline(): Promise<Array<{ id: string; name: string; workFolderRoot: string }>> {
  const registry = await readRegistry();
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.workFolderId));
  return registry.workFolders
    .filter((workFolder) => !removingIds.has(workFolder.id))
    .map((workFolder) => ({ id: workFolder.id, name: workFolder.name, workFolderRoot: workFolder.workFolderRoot }));
}

/**
 * Refuses a parent work-folder's file operation on a folder that holds a nested
 * registered work-folder, or on anything inside one: that content belongs to the
 * nested work-folder's own Worker and History (2026-10-01).
 */
async function assertOutsideNestedFolders(workFolderRoot: string, relativePath: string): Promise<void> {
  const path = comparableRelative(relativePath);
  if (!path) return;
  for (const nested of await nestedRegisteredWorkFolderPaths(workFolderRoot)) {
    const boundary = comparableRelative(nested);
    if (path === boundary || boundary.startsWith(`${path}/`)) {
      throw Object.assign(new Error(`${relativePath} holds the ${nested} work-folder, which has its own Worker. Remove that work-folder from work-fold first, or change it in ${process.platform === "darwin" ? "Finder" : "your file manager"}.`), { status: 409, statusCode: 409 });
    }
    if (path.startsWith(`${boundary}/`)) {
      throw Object.assign(new Error(`${relativePath} belongs to the ${nested} work-folder. Open that work-folder to change it.`), { status: 409, statusCode: 409 });
    }
  }
}

/**
 * Resolves a folder inside a registered work-folder that may become a nested work-folder
 * of its own (2026-10-01): a real, visible directory below the root that is not
 * already a work-folder and does not sit inside one. Returns its absolute path.
 */
export async function resolveNestableFolderPath(workFolderRoot: string, relativePath: string): Promise<string> {
  const root = ensureSafeWorkFolderRoot(workFolderRoot);
  const normalized = normalizeRelative(relativePath).split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized) throw Object.assign(new Error("Choose a folder inside this work-folder."), { status: 400, statusCode: 400 });
  if (normalized.split("/").some((part) => isAlwaysHiddenWorkFolderEntry(part))) throw Object.assign(new Error("That folder is hidden work-fold or Pi data."), { status: 400, statusCode: 400 });
  let target: string;
  try { target = resolveWorkFolderPath(root, normalized); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error("Choose a folder inside this work-folder."), { status: 400, statusCode: 400 }); }
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw notFound("That folder no longer exists here.");
  const path = comparableRelative(normalized);
  for (const nested of await nestedRegisteredWorkFolderPaths(root)) {
    const boundary = comparableRelative(nested);
    if (path === boundary) throw Object.assign(new Error(`${normalized} already has its own Worker.`), { status: 409, statusCode: 409 });
    if (path.startsWith(`${boundary}/`)) throw Object.assign(new Error(`${normalized} belongs to the ${nested} work-folder. Open that work-folder to do this.`), { status: 409, statusCode: 409 });
  }
  return target;
}

/** Relative paths as the file system compares them: macOS and Windows ignore case. */
const boundaryKeyCache = new WeakMap<ReadonlySet<string>, Set<string>>();
function boundaryKeys(boundaries: ReadonlySet<string>): Set<string> {
  let keys = boundaryKeyCache.get(boundaries);
  if (!keys) { keys = new Set([...boundaries].map(comparableRelative)); boundaryKeyCache.set(boundaries, keys); }
  return keys;
}

function comparableRelative(value: string): string {
  const normalized = normalizeRelative(value).split("/").filter((part) => part && part !== ".").join("/");
  return process.platform === "darwin" || process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

/** Includes pending removals: their content is still separately owned. */
export async function nestedRegisteredWorkFolderPaths(workFolderRoot: string): Promise<string[]> {
  const root = resolve(workFolderRoot);
  const registry = await readRegistry();
  return registry.workFolders.filter((workFolder) => !samePath(root, workFolder.workFolderRoot) && pathContains(root, workFolder.workFolderRoot))
    .map((workFolder) => normalizeRelative(relative(root, workFolder.workFolderRoot)));
}

/** Moves only this product's machine-local state. A marker makes a crash before
 * the registry commit resumable; conflicting destination state is never merged. */
async function relocateWorkFolderState(fromRoot: string, toRoot: string, workFolderId: string): Promise<void> {
  const from = workFolderStateDir(fromRoot);
  const to = workFolderStateDir(toRoot);
  if (from === to) return;
  const marker = { version: 1, workFolderId, fromRoot, toRoot };
  const markerName = "state-relocation.json";
  if (!existsSync(from)) {
    if (existsSync(join(to, markerName))) {
      const prior = JSON.parse(await readFile(join(to, markerName), "utf8"));
      if (JSON.stringify(prior) !== JSON.stringify(marker)) throw new Error("work-folder state relocation does not match this folder.");
    } else if (existsSync(to)) throw new Error("work-folder state relocation has unrelated destination state.");
    return;
  }
  if ((await lstat(from)).isSymbolicLink() || existsSync(to)) throw new Error("work-folder state relocation has a conflicting destination.");
  await atomicJsonWrite(join(from, markerName), marker);
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

let registryMutationQueue: Promise<void> = Promise.resolve();

async function withRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryMutationQueue.then(operation, operation);
  registryMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function writePortableManifest(workFolder: WorkFolderSummary): Promise<void> {
  await migrateWorkFolderMetadata(workFolder.workFolderRoot);
  const file = workFolderManifestFile(workFolder.workFolderRoot);
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
  const manifest: PortableWorkFolderManifest & Record<string, unknown> = {
    ...existingFields,
    version: 1,
    id: workFolder.id,
    name: workFolder.name,
    createdAt: workFolder.createdAt,
    updatedAt: workFolder.updatedAt,
  };
  await atomicJsonWrite(file, manifest);
}

async function commitRegistryAndPortableManifest(registry: WorkFolderRegistry, workFolder: WorkFolderSummary): Promise<void> {
  const manifestFile = workFolderManifestFile(workFolder.workFolderRoot);
  const previousManifest = await snapshotFile(manifestFile);
  await writePortableManifest(workFolder);
  try {
    await writeRegistry(registry);
  } catch (error) {
    try {
      await restoreFileSnapshot(manifestFile, previousManifest);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "work-folder metadata commit failed and its portable manifest could not be restored.");
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

async function readExistingWorkFolderManifest(workFolderRoot: string): Promise<PortableWorkFolderManifest | null> {
  // A folder from an older install, or another machine, still carries `.work-fold/space.json`.
  await migrateWorkFolderMetadata(workFolderRoot).catch(() => false);
  const file = workFolderManifestFile(workFolderRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PortableWorkFolderManifest>;
    if (!isWorkFolderId(parsed.id) || typeof parsed.name !== "string") return null;
    if (typeof parsed.createdAt !== "string" || !isValidTimestamp(parsed.createdAt)) return null;
    if (typeof parsed.updatedAt !== "string" || !isValidTimestamp(parsed.updatedAt)) return null;
    return {
      version: 1,
      id: parsed.id,
      name: normalizeWorkFolderName(parsed.name),
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
  boundaries: ReadonlySet<string> = new Set(),
): Promise<TreeEntry[]> {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return [];
  }
  const entries = (await limit(() => readdir(directory, { withFileTypes: true })))
    .filter((entry) => !entry.isSymbolicLink() && !isAlwaysHiddenWorkFolderEntry(entry.name) && !isOfficeLockFileName(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => {
      const path = join(directory, entry.name);
      const relativePath = normalizeRelative(relative(root, path));
      return { entry, path, relativePath, ignored: isWorkFolderIgnored(relativePath, ignorePatterns) };
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
  // batch per folder, which is what a work-folder with a large flat folder pays for.
  const inspected = await Promise.all(considered.map(async (item) => {
    // A tree walk races ordinary file activity, so an entry that disappears
    // between readdir and stat is skipped rather than failing the whole work-folder.
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
    if (item.entry.isDirectory() && boundaries.size && boundaryKeys(boundaries).has(comparableRelative(item.relativePath))) {
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "folder",
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
        hasChildren: false,
        children: [],
        nestedFolder: true,
      });
      continue;
    }
    if (item.entry.isDirectory()) {
      const childrenLoaded = depth < maxDepth;
      const children = childrenLoaded
        ? await scanDirectory(root, item.path, depth + 1, maxDepth, ignorePatterns, includeIgnored, limit, budget, boundaries)
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
    if (entry.isSymbolicLink() || isAlwaysHiddenWorkFolderEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = normalizeRelative(relative(root, join(directory, entry.name)));
    if (!includeIgnored && isWorkFolderIgnored(relativePath, ignorePatterns)) continue;
    return true;
  }
  return false;
}

type FilesystemLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Caps how many filesystem calls the tree walk keeps in flight. Only leaf
 * operations pass through the limiter; recursion never holds a slot while
 * waiting for one, so a deep work-folder cannot deadlock its own walk.
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

async function visitWorkFolderFiles(root: string, directory: string, visitor: (relativePath: string, name: string) => void): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isAlwaysHiddenWorkFolderEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visitWorkFolderFiles(root, path, visitor);
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
  if (!info) throw notFound("Source not found.");
  if (lstatSync(source).isSymbolicLink()) throw new Error("Symbolic links cannot be copied into a work-folder.");
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
    if (lstatSync(cursor).isSymbolicLink()) throw new Error("work-folder paths cannot traverse symbolic links or junctions.");
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

function normalizeWorkFolderName(value: string): string {
  const name = value.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("work-folder name is required.");
  return name;
}

function safeSegment(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function normalizeRelative(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/^\/+|\/+$/g, "");
}

function stableWorkFolderId(workFolderRoot: string): string {
  const normalized = process.platform === "win32" ? resolve(workFolderRoot).toLocaleLowerCase() : resolve(workFolderRoot);
  return `space-${createHash("sha256")
    .update(`${productIdentity.productName}:work-folder-id:v1\0${normalized}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function isWorkFolderId(value: unknown): value is string {
  return typeof value === "string" && /^space-[a-f0-9]{16}$/.test(value);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}

function assertLinkedWorkFolderStateSeparation(workFolderRoot: string): void {
  if (linkedWorkFolderStateSeparated(workFolderRoot)) return;
  throw new Error("Linked folders cannot contain, or be contained by, work-fold application data. Choose a different folder.");
}

function linkedWorkFolderStateSeparated(workFolderRoot: string): boolean {
  const root = resolve(workFolderRoot);
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

function isWorkFolderSummary(value: unknown): value is WorkFolderSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkFolderSummary>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.workFolderRoot === "string"
    && item.location?.kind === "local" && (item.location.storage === "managed" || item.location.storage === "linked")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function workFolderRemovalIntent(value: unknown): WorkFolderRemovalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("work-folder registry contains an invalid removal intent.");
  }
  const item = value as Partial<WorkFolderRemovalIntent>;
  const requiredKeys = [
    "transactionId", "workFolderId", "workFolderRoot", "storage", "managedBase", "managedRootIdentity", "managedRootClaimed", "phase", "requestedAt",
  ];
  const keys = Object.keys(value).sort();
  // The one optional key is the preserve marker; every other shape mismatch
  // stays a hard failure exactly as before.
  const expectedKeys = keys.includes("folderDisposition") ? [...requiredKeys, "folderDisposition"] : requiredKeys;
  if (keys.join("\0") !== [...expectedKeys].sort().join("\0")
    || typeof item.transactionId !== "string"
    || !/^space-removal_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.transactionId)
    || !isWorkFolderId(item.workFolderId)
    || typeof item.workFolderRoot !== "string"
    || (item.storage !== "managed" && item.storage !== "linked")
    || typeof item.managedRootClaimed !== "boolean"
    || (item.folderDisposition !== undefined && item.folderDisposition !== "preserve")
    || (item.phase !== "requested" && item.phase !== "app-state-removed")
    || typeof item.requestedAt !== "string" || !isValidTimestamp(item.requestedAt)) {
    throw new Error("work-folder registry contains an invalid removal intent.");
  }
  const preserves = item.storage === "managed" && item.folderDisposition === "preserve";
  if (item.folderDisposition === "preserve" && item.storage !== "managed") {
    throw new Error("Only a managed work-folder removal intent may carry a preserve disposition.");
  }
  if (item.storage === "managed" && !preserves && (typeof item.managedBase !== "string" || !isAbsolute(item.managedBase))) {
    throw new Error("Managed work-folder removal intent has no content boundary.");
  }
  if (item.storage === "managed" && !preserves && !item.managedRootIdentity) {
    throw new Error("Managed work-folder removal intent has no root identity.");
  }
  if (item.storage === "linked" && (item.managedBase !== null || item.managedRootIdentity !== null || item.managedRootClaimed)) {
    throw new Error("Linked work-folder removal intent has unexpected managed-content authority.");
  }
  if (preserves && (item.managedBase !== null || item.managedRootIdentity !== null || item.managedRootClaimed)) {
    throw new Error("A preserve removal intent cannot hold managed-content deletion authority.");
  }
  const intent: WorkFolderRemovalIntent = {
    transactionId: item.transactionId,
    workFolderId: item.workFolderId,
    workFolderRoot: lexicalWorkFolderRoot(item.workFolderRoot),
    storage: item.storage,
    managedBase: item.managedBase === null || item.managedBase === undefined ? null : resolve(item.managedBase),
    managedRootIdentity: item.managedRootIdentity === null || item.managedRootIdentity === undefined
      ? null
      : managedRootIdentity(item.managedRootIdentity),
    managedRootClaimed: item.managedRootClaimed,
    ...(preserves ? { folderDisposition: "preserve" as const } : {}),
    phase: item.phase,
    requestedAt: item.requestedAt,
  };
  validateWorkFolderRemovalIntent(intent);
  return intent;
}

function validateWorkFolderRemovalIntent(intent: WorkFolderRemovalIntent): void {
  const workFolderRoot = lexicalWorkFolderRoot(intent.workFolderRoot);
  if (intent.storage === "managed" && intent.folderDisposition !== "preserve") {
    const base = resolve(intent.managedBase!);
    if (samePath(workFolderRoot, base) || !pathContains(base, workFolderRoot)) {
      throw new Error("Managed work-folder removal intent escapes its registered content boundary.");
    }
    const identity = intent.managedRootIdentity;
    if (!identity || samePath(identity.realPath, identity.managedBaseRealPath)
      || !pathContains(identity.managedBaseRealPath, identity.realPath)) {
      throw new Error("Managed work-folder removal intent has an invalid canonical content boundary.");
    }
  } else if (intent.managedBase !== null || intent.managedRootIdentity !== null || intent.managedRootClaimed) {
    throw new Error(intent.storage === "linked"
      ? "Linked work-folder removal intent cannot delete managed content."
      : "A preserve removal intent cannot hold managed-content deletion authority.");
  }
}

function lexicalWorkFolderRoot(workFolderRoot: string): string {
  if (!isAbsolute(workFolderRoot)) throw new Error("work-folder removal intent root must be absolute.");
  const resolved = resolve(workFolderRoot);
  if (resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a work-folder removal intent.");
  return resolved;
}

function managedRootIdentity(value: unknown): ManagedWorkFolderRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed work-folder removal intent has an invalid root identity.");
  }
  const item = value as Partial<ManagedWorkFolderRootIdentity>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["device", "inode", "managedBaseRealPath", "realPath"].sort().join("\0")
    || typeof item.realPath !== "string" || !isAbsolute(item.realPath)
    || typeof item.managedBaseRealPath !== "string" || !isAbsolute(item.managedBaseRealPath)
    || typeof item.device !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(item.device)
    || typeof item.inode !== "string" || !/^[1-9][0-9]*$/.test(item.inode)) {
    throw new Error("Managed work-folder removal intent has an invalid root identity.");
  }
  return {
    realPath: resolve(item.realPath),
    managedBaseRealPath: resolve(item.managedBaseRealPath),
    device: item.device,
    inode: item.inode,
  };
}

function assertId(value: string): void {
  if (!isWorkFolderId(value)) throw new Error("Invalid work-folder id.");
}

function notFound(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 404;
  return error;
}
