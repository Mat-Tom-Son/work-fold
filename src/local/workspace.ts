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
  legacyWorkspaceManifestFile,
  managedWorkspaceRoot,
  workspaceStateDir,
  workspaceStateRoot,
  workspaceManifestFile,
  workspaceRegistryFile,
} from "./state-paths.js";
import { isAlwaysHiddenWorkspaceEntry, isWorkspaceIgnored, readWorkspaceIgnoreState } from "./workspace-ignore.js";

export interface WorkspaceLocation {
  kind: "local";
  storage: "managed" | "linked";
  providerHint?: "google-drive";
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootPath: string;
  location: WorkspaceLocation;
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

export interface WorkspaceEntryInfo {
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

export interface WorkspaceMovedEntry {
  fromPath: string;
  path: string;
  name: string;
  kind: "file" | "folder";
  updatedAt: string;
}

export interface WorkspaceCreatedEntry {
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes?: number;
  updatedAt: string;
}

export interface WorkspaceTreeOptions {
  includeIgnored?: boolean;
}

export interface WorkspaceRemovalIntent {
  transactionId: string;
  workspaceId: string;
  rootPath: string;
  storage: WorkspaceLocation["storage"];
  managedBase: string | null;
  managedRootIdentity: ManagedWorkspaceRootIdentity | null;
  managedRootClaimed: boolean;
  phase: "requested" | "app-state-removed";
  requestedAt: string;
}

export interface ManagedWorkspaceRootIdentity {
  realPath: string;
  managedBaseRealPath: string;
  device: string;
  inode: string;
}

export interface WorkspaceRemovalResult {
  removed: true;
  deleted: boolean;
  rootPath: string;
  cleanupPending: boolean;
}

export interface WorkspaceRegistry {
  version: 1;
  workspaces: WorkspaceSummary[];
  pendingRemovals: WorkspaceRemovalIntent[];
}

export interface WorkspaceRemovalIo {
  persistRegistry(registry: WorkspaceRegistry): Promise<void>;
  claimManagedRoot(rootPath: string, claimPath: string): Promise<void>;
  restoreMismatchedManagedClaim(claimPath: string, rootPath: string): Promise<void>;
  removeClaimedManagedRoot(claimPath: string): Promise<void>;
  removeWorkspaceState(rootPath: string): Promise<void>;
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

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const registry = await readRegistry();
  const removingIds = new Set(registry.pendingRemovals.map((intent) => intent.workspaceId));
  const workspaces = registry.workspaces
    .filter((workspace) => !removingIds.has(workspace.id))
    .filter((workspace) => existsSync(workspace.rootPath))
    .filter((workspace) => workspace.location.storage !== "linked" || linkedWorkspaceStateSeparated(workspace.rootPath))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  await Promise.all(workspaces.map(async (workspace) => {
    try {
      await writePortableManifest(workspace);
    } catch {
      // A previously linked folder can become read-only or temporarily unavailable.
      // Registry-backed listing must remain usable; the next successful mutation retries.
    }
  }));
  return workspaces;
}

export async function createManagedWorkspace(name: string, baseDir = managedWorkspaceRoot()): Promise<WorkspaceSummary> {
  const normalizedName = normalizeWorkspaceName(name);
  await mkdir(baseDir, { recursive: true });
  const rootPath = await nextAvailableDirectory(baseDir, safeSegment(normalizedName) || "workspace");
  await mkdir(rootPath, { recursive: false });
  try {
    return await registerWorkspace({
      name: normalizedName,
      rootPath,
      location: { kind: "local", storage: "managed" },
    });
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function registerLinkedWorkspace(rootPath: string, providerHint?: "google-drive"): Promise<WorkspaceSummary> {
  const safeRoot = ensureSafeWorkspaceRoot(rootPath);
  assertLinkedWorkspaceStateSeparation(safeRoot);
  const info = await stat(safeRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("The folder selected for this Space does not exist.");
  return registerWorkspace({
    name: basename(safeRoot),
    rootPath: safeRoot,
    location: {
      kind: "local",
      storage: "linked",
      ...(providerHint === "google-drive" || looksLikeGoogleDrivePath(safeRoot) ? { providerHint: "google-drive" as const } : {}),
    },
  });
}

export async function getWorkspace(workspaceId: string): Promise<WorkspaceSummary> {
  assertId(workspaceId);
  const workspace = (await listWorkspaces()).find((item) => item.id === workspaceId);
  if (!workspace) throw notFound("Space not found.");
  if (workspace.location.storage === "linked") assertLinkedWorkspaceStateSeparation(workspace.rootPath);
  return workspace;
}

export async function renameWorkspace(workspaceId: string, name: string): Promise<WorkspaceSummary> {
  assertId(workspaceId);
  const normalizedName = normalizeWorkspaceName(name);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const workspace = registry.workspaces.find((item) => item.id === workspaceId);
    if (!workspace || registry.pendingRemovals.some((intent) => intent.workspaceId === workspaceId)
      || !existsSync(workspace.rootPath)) throw notFound("Space not found.");
    workspace.name = normalizedName;
    workspace.updatedAt = new Date().toISOString();
    await commitRegistryAndPortableManifest(registry, workspace);
    return workspace;
  });
}

/**
 * Persists the user-authorized removal before any App or content cleanup. From
 * this point the Space is intentionally hidden from every registry projection;
 * startup recovery can safely roll the operation forward after a crash.
 */
export async function beginWorkspaceRemoval(
  workspaceId: string,
  managedBase = managedWorkspaceRoot(),
  io: Partial<WorkspaceRemovalIo> = {},
): Promise<WorkspaceRemovalIntent> {
  assertId(workspaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const existing = registry.pendingRemovals.find((intent) => intent.workspaceId === workspaceId);
    if (existing) return structuredClone(existing);
    const workspace = registry.workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !existsSync(workspace.rootPath)) throw notFound("Space not found.");
    const rootPath = ensureSafeWorkspaceRoot(workspace.rootPath);
    const base = workspace.location.storage === "managed" ? resolve(managedBase) : null;
    if (base && (samePath(rootPath, base) || !pathContains(base, rootPath))) {
      throw new Error("Workspace will only delete a managed Space inside its registered managed-content folder.");
    }
    const managedRootIdentity = workspace.location.storage === "managed"
      ? await captureManagedRootIdentity(rootPath, base!)
      : null;
    const intent: WorkspaceRemovalIntent = {
      transactionId: `workspace-removal_${randomUUID()}`,
      workspaceId: workspace.id,
      rootPath,
      storage: workspace.location.storage,
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

export async function markWorkspaceRemovalAppStateRemoved(
  workspaceId: string,
  io: Partial<WorkspaceRemovalIo> = {},
): Promise<WorkspaceRemovalIntent> {
  assertId(workspaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const intent = registry.pendingRemovals.find((item) => item.workspaceId === workspaceId);
    if (!intent) throw new Error("Space removal intent not found.");
    if (intent.phase === "app-state-removed") return structuredClone(intent);
    intent.phase = "app-state-removed";
    await removalIo(io).persistRegistry(registry);
    return structuredClone(intent);
  });
}

export async function listPendingWorkspaceRemovals(): Promise<WorkspaceRemovalIntent[]> {
  return (await readRegistry({ strict: true })).pendingRemovals.map((intent) => structuredClone(intent));
}

export async function finalizeWorkspaceRemoval(
  workspaceId: string,
  io: Partial<WorkspaceRemovalIo> = {},
): Promise<WorkspaceRemovalResult> {
  assertId(workspaceId);
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const intent = registry.pendingRemovals.find((item) => item.workspaceId === workspaceId);
    if (!intent) throw new Error("Space removal intent not found.");
    if (intent.phase !== "app-state-removed") {
      throw new Error("Space cleanup cannot start before App state has been removed.");
    }
    const workspace = registry.workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !samePath(workspace.rootPath, intent.rootPath)
      || workspace.location.storage !== intent.storage) {
      throw new Error("Space removal intent no longer matches the registered Space.");
    }
    validateWorkspaceRemovalIntent(intent);
    const operations = removalIo(io);
    let deleted = false;
    if (intent.storage === "managed") {
      const claimPath = managedRemovalClaimPath(intent);
      let claimStatus = await managedClaimStatus(intent);
      if (claimStatus === "mismatch") {
        if (await managedRootStatus(intent) === "absent") {
          await operations.restoreMismatchedManagedClaim(claimPath, intent.rootPath).catch(() => undefined);
        }
        return workspaceRemovalPendingResult(intent);
      }
      if (claimStatus === "unavailable") {
        return workspaceRemovalPendingResult(intent);
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
          return workspaceRemovalPendingResult(intent);
        } else {
          try {
            await operations.claimManagedRoot(intent.rootPath, claimPath);
          } catch {
            return workspaceRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
          if (claimStatus !== "matching") {
            if (claimStatus === "mismatch" && await managedRootStatus(intent) === "absent") {
              await operations.restoreMismatchedManagedClaim(claimPath, intent.rootPath).catch(() => undefined);
            }
            return workspaceRemovalPendingResult(intent);
          }
        }
      }

      if (!deleted && !intent.managedRootClaimed) {
        intent.managedRootClaimed = true;
        try {
          await operations.persistRegistry(registry);
        } catch {
          return workspaceRemovalPendingResult(intent);
        }
      }

      if (!deleted) {
        claimStatus = await managedClaimStatus(intent);
        if (claimStatus === "matching") {
          try {
            await operations.removeClaimedManagedRoot(claimPath);
          } catch {
            return workspaceRemovalPendingResult(intent);
          }
          claimStatus = await managedClaimStatus(intent);
        }
        if (claimStatus !== "absent") return workspaceRemovalPendingResult(intent);
        deleted = true;
      }
    }
    try {
      await operations.removeWorkspaceState(intent.rootPath);
    } catch {
      return workspaceRemovalPendingResult(intent);
    }

    const next: WorkspaceRegistry = {
      ...registry,
      workspaces: registry.workspaces.filter((item) => item.id !== workspaceId),
      pendingRemovals: registry.pendingRemovals.filter((item) => item.workspaceId !== workspaceId),
    };
    try {
      await operations.persistRegistry(next);
    } catch {
      return workspaceRemovalPendingResult(intent);
    }
    return { removed: true, deleted, rootPath: intent.rootPath, cleanupPending: false };
  });
}

export async function workspaceRemovalPendingResult(
  intent: Pick<WorkspaceRemovalIntent,
    "transactionId" | "rootPath" | "storage" | "managedBase" | "managedRootIdentity" | "managedRootClaimed">,
): Promise<WorkspaceRemovalResult> {
  const rootStatus = intent.storage === "managed" ? await managedRootStatus(intent) : "mismatch";
  const deleted = intent.storage === "managed"
    && await managedClaimStatus(intent) === "absent"
    && (rootStatus === "absent" || (intent.managedRootClaimed && rootStatus === "mismatch"));
  return {
    removed: true,
    deleted,
    rootPath: intent.rootPath,
    cleanupPending: true,
  };
}

export async function scanWorkspaceTree(
  rootPath: string,
  maxDepth = 20,
  relativePath = "",
  options: WorkspaceTreeOptions = {},
): Promise<TreeEntry[]> {
  const safeRoot = ensureSafeWorkspaceRoot(rootPath);
  const scanRoot = resolveWorkspacePath(safeRoot, relativePath || ".");
  const info = await stat(scanRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Requested Space tree path is not a folder.");
  const ignoreState = await readWorkspaceIgnoreState(safeRoot);
  return scanDirectory(
    safeRoot,
    scanRoot,
    0,
    Math.min(Math.max(maxDepth, 0), 50),
    ignoreState.patterns,
    options.includeIgnored !== false,
    createFilesystemLimiter(treeScanConcurrency),
  );
}

export async function readWorkspaceTextFile(rootPath: string, relativePath: string): Promise<{ text: string }> {
  const path = resolveWorkspacePath(rootPath, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (info.size > maxPreviewBytes) throw new Error("This file is too large to preview (2 MB maximum).");
  const bytes = await readFile(path);
  if (looksBinary(bytes)) throw new Error("This file is binary and cannot be previewed as text.");
  return { text: bytes.toString("utf8") };
}

export async function writeWorkspaceTextFile(rootPath: string, relativePath: string, text: string): Promise<{ path: string; text: string }> {
  const path = resolveWorkspacePath(rootPath, relativePath);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw notFound("File not found.");
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("This file is too large to edit (2 MB maximum).");
  await writeFile(path, text, "utf8");
  await touchWorkspace(rootPath);
  return { path: normalizeRelative(relative(ensureSafeWorkspaceRoot(rootPath), path)), text };
}

export async function getWorkspaceEntryInfo(rootPath: string, relativePath: string): Promise<WorkspaceEntryInfo> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const path = resolveWorkspacePath(root, relativePath);
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

export async function findExistingWorkspaceFilePaths(rootPath: string, requestedPaths: string[]): Promise<string[]> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const requests = [...new Set(requestedPaths.map(normalizeRelative).filter(Boolean))].slice(0, 32);
  const existing = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const request of requests) {
    try {
      const path = resolveWorkspacePath(root, request);
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
    await visitWorkspaceFiles(root, root, (path, name) => matches.get(name.toLocaleLowerCase())?.push(path));
    for (const paths of matches.values()) if (paths.length === 1 && paths[0]) existing.add(paths[0]);
  }
  return [...existing].sort((left, right) => left.localeCompare(right));
}

export async function moveWorkspaceEntry(
  rootPath: string,
  input: { sourcePath: string; targetFolderPath?: string },
): Promise<WorkspaceMovedEntry> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const sourcePath = normalizeRelative(input.sourcePath);
  const targetFolderPath = normalizeRelative(input.targetFolderPath ?? "");
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to move.");
  if (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`)) throw new Error("Folders cannot be moved into themselves.");
  const source = resolveWorkspacePath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Space root cannot be moved.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("Space item not found.");
  const targetFolder = resolveWorkspacePath(root, targetFolderPath || ".");
  if (!(await stat(targetFolder)).isDirectory()) throw new Error("Move items into a folder.");
  if (dirname(source) === targetFolder) throw new Error("That item is already in the selected folder.");
  const destination = join(targetFolder, basename(source));
  if (existsSync(destination)) throw new Error(`A file or folder named ${basename(source)} already exists there.`);
  await rename(source, destination);
  const movedInfo = await stat(destination);
  await touchWorkspace(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: basename(destination),
    kind: movedInfo.isDirectory() ? "folder" : "file",
    updatedAt: movedInfo.mtime.toISOString(),
  };
}

export async function renameWorkspaceEntry(
  rootPath: string,
  input: { path: string; newName: string },
): Promise<WorkspaceMovedEntry> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const sourcePath = normalizeRelative(input.path);
  if (!sourcePath || sourcePath === ".") throw new Error("Select a file or folder to rename.");
  const newName = safeFileName(input.newName);
  const source = resolveWorkspacePath(root, sourcePath);
  if (samePath(source, root)) throw new Error("The Space root cannot be renamed.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) throw notFound("Space item not found.");
  if (basename(source) === newName) throw new Error("That item already has this name.");
  const destination = join(dirname(source), newName);
  resolveWorkspacePath(root, normalizeRelative(relative(root, destination)));
  if (existsSync(destination)) throw new Error(`A file or folder named ${newName} already exists there.`);
  await rename(source, destination);
  const renamedInfo = await stat(destination);
  await touchWorkspace(root);
  return {
    fromPath: sourcePath,
    path: normalizeRelative(relative(root, destination)),
    name: newName,
    kind: renamedInfo.isDirectory() ? "folder" : "file",
    updatedAt: renamedInfo.mtime.toISOString(),
  };
}

export async function createWorkspaceFolder(
  rootPath: string,
  parentPath: string,
  name: string,
): Promise<WorkspaceCreatedEntry> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const parent = resolveWorkspacePath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create folders inside a Space folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  if (existsSync(destination)) throw new Error(`A file or folder named ${safeName} already exists there.`);
  await mkdir(destination, { recursive: false });
  const info = await stat(destination);
  await touchWorkspace(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "folder",
    updatedAt: info.mtime.toISOString(),
  };
}

export async function createWorkspaceTextFile(
  rootPath: string,
  parentPath: string,
  name: string,
  text = "",
): Promise<WorkspaceCreatedEntry> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const parent = resolveWorkspacePath(root, parentPath || ".");
  if (!(await stat(parent)).isDirectory()) throw new Error("Create files inside a Space folder.");
  const safeName = safeFileName(name);
  const destination = join(parent, safeName);
  if (Buffer.byteLength(text, "utf8") > maxPreviewBytes) throw new Error("The new file is too large (2 MB maximum).");
  await writeFile(destination, text, { encoding: "utf8", flag: "wx" });
  const info = await stat(destination);
  await touchWorkspace(root);
  return {
    path: normalizeRelative(relative(root, destination)),
    name: safeName,
    kind: "file",
    sizeBytes: info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function deleteWorkspaceEntry(rootPath: string, relativePath: string): Promise<{ deleted: true; path: string; kind: "file" | "folder" }> {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") throw new Error("Select a file or folder to delete.");
  const path = resolveWorkspacePath(root, normalized);
  if (samePath(path, root)) throw new Error("The Space root cannot be deleted.");
  const info = await stat(path).catch(() => null);
  if (!info || (!info.isFile() && !info.isDirectory())) throw notFound("Space item not found.");
  await rm(path, { recursive: info.isDirectory(), force: false });
  await touchWorkspace(root);
  return { deleted: true, path: normalized, kind: info.isDirectory() ? "folder" : "file" };
}

export async function writeUploadedFiles(
  rootPath: string,
  targetFolderPath: string,
  files: Array<{ fileName: string; relativePath?: string; data: Buffer }>,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const targetFolder = resolveWorkspacePath(rootPath, targetFolderPath || ".");
  await mkdir(targetFolder, { recursive: true });
  const written: Array<{ path: string; sizeBytes: number }> = [];
  for (const file of files) {
    const uploadPath = safeUploadPath(file.relativePath || file.fileName);
    const desired = resolveWorkspacePath(targetFolder, uploadPath);
    await mkdir(dirname(desired), { recursive: true });
    const destination = await nextAvailableFile(desired);
    await writeFile(destination, file.data, { flag: "wx" });
    written.push({ path: normalizeRelative(relative(rootPath, destination)), sizeBytes: file.data.byteLength });
  }
  await touchWorkspace(rootPath);
  return written;
}

export async function copyPathIntoWorkspace(
  sourcePath: string,
  workspaceRoot: string,
  targetFolderPath: string,
): Promise<string> {
  const targetFolder = resolveWorkspacePath(workspaceRoot, targetFolderPath || ".");
  await mkdir(targetFolder, { recursive: true });
  const destination = await nextAvailablePath(join(targetFolder, safeFileName(basename(sourcePath))));
  await copyVisiblePath(sourcePath, destination);
  await touchWorkspace(workspaceRoot);
  return normalizeRelative(relative(workspaceRoot, destination));
}

export function resolveWorkspacePath(rootPath: string, relativePath: string): string {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const normalized = normalizeRelative(relativePath || ".");
  if (isAbsolute(relativePath) || normalized.split("/").includes("..")) {
    throw new Error("Path escapes the selected Space.");
  }
  const path = resolve(root, normalized || ".");
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Path escapes the selected Space.");
  assertNoLinkSegments(root, path);
  return path;
}

export function ensureSafeWorkspaceRoot(rootPath: string): string {
  const resolved = resolve(rootPath);
  if (!isAbsolute(resolved) || resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Space.");
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) throw new Error("A Space cannot be a symbolic link or junction.");
  return resolved;
}

export function assertWorkspaceDoesNotContainState(rootPath: string): void {
  const root = ensureSafeWorkspaceRoot(rootPath);
  const stateRoot = resolve(workspaceStateRoot());
  if (pathContains(root, stateRoot)) {
    throw new Error("Choose a narrower folder that does not contain Workspace application data.");
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function registerWorkspace(input: Omit<WorkspaceSummary, "id" | "createdAt" | "updatedAt">): Promise<WorkspaceSummary> {
  return withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const rootPath = resolve(input.rootPath);
    const existing = registry.workspaces.find((workspace) => samePath(workspace.rootPath, rootPath));
    if (existing) {
      if (registry.pendingRemovals.some((intent) => intent.workspaceId === existing.id)) {
        throw new Error("This Space is still being removed. Restart Workspace to retry its cleanup.");
      }
      await writePortableManifest(existing);
      return existing;
    }
    const portableIdentity = await readExistingSpaceManifest(rootPath);
    const now = new Date().toISOString();
    if (portableIdentity) {
      const identityOwner = registry.workspaces.find((workspace) => workspace.id === portableIdentity.id);
      if (identityOwner) {
        if (registry.pendingRemovals.some((intent) => intent.workspaceId === identityOwner.id)) {
          throw new Error("This Space is still being removed. Restart Workspace to retry its cleanup.");
        }
        if (existsSync(identityOwner.rootPath)) {
          throw new Error("This Space identity is already linked to another folder.");
        }
        identityOwner.name = portableIdentity.name;
        identityOwner.rootPath = rootPath;
        identityOwner.location = input.location;
        identityOwner.createdAt = portableIdentity.createdAt;
        identityOwner.updatedAt = now;
        await commitRegistryAndPortableManifest(registry, identityOwner);
        return identityOwner;
      }
    }
    const id = portableIdentity?.id ?? stableWorkspaceId(rootPath);
    const identityCollision = registry.workspaces.find((workspace) => workspace.id === id);
    if (identityCollision) throw new Error("This Space identity is already registered to another folder.");
    const workspace: WorkspaceSummary = {
      ...input,
      id,
      name: portableIdentity?.name ?? input.name,
      rootPath,
      createdAt: portableIdentity?.createdAt ?? now,
      updatedAt: now,
    };
    registry.workspaces.push(workspace);
    await commitRegistryAndPortableManifest(registry, workspace);
    return workspace;
  });
}

async function touchWorkspace(rootPath: string): Promise<void> {
  await withRegistryMutation(async () => {
    const registry = await readRegistry({ strict: true });
    const workspace = registry.workspaces.find((item) => samePath(item.rootPath, rootPath));
    if (!workspace || registry.pendingRemovals.some((intent) => intent.workspaceId === workspace.id)) return;
    workspace.updatedAt = new Date().toISOString();
    try {
      await commitRegistryAndPortableManifest(registry, workspace);
    } catch {
      // The content mutation already succeeded. Leave both metadata records at their
      // previous values and retry maintenance on a later mutation or Space listing.
    }
  });
}

async function readRegistry(options: { strict?: boolean } = {}): Promise<WorkspaceRegistry> {
  const file = workspaceRegistryFile();
  if (!existsSync(file)) return emptyWorkspaceRegistry();
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<WorkspaceRegistry>;
    if (!Array.isArray(parsed.workspaces)) throw new Error("Workspace registry Spaces are invalid.");
    const workspaces = parsed.workspaces.map((workspace) => {
      if (!isWorkspaceSummary(workspace)) throw new Error("Workspace registry contains an invalid Space.");
      return { ...workspace, rootPath: resolve(workspace.rootPath) };
    });
    const pendingRemovals = parsed.pendingRemovals === undefined
      ? []
      : parsed.pendingRemovals.map((intent) => workspaceRemovalIntent(intent));
    const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    if (new Set(pendingRemovals.map((intent) => intent.workspaceId)).size !== pendingRemovals.length
      || new Set(pendingRemovals.map((intent) => intent.transactionId)).size !== pendingRemovals.length
      || pendingRemovals.some((intent) => {
        const workspace = workspaceById.get(intent.workspaceId);
        return !workspace
          || !samePath(workspace.rootPath, intent.rootPath)
          || workspace.location.storage !== intent.storage;
      })) {
      throw new Error("Workspace registry removal intents are inconsistent.");
    }
    return {
      version: 1,
      workspaces,
      pendingRemovals,
    };
  } catch (error) {
    if (options.strict) throw new Error("Workspace registry could not be read safely.", { cause: error });
    return emptyWorkspaceRegistry();
  }
}

async function writeRegistry(registry: WorkspaceRegistry): Promise<void> {
  const file = workspaceRegistryFile();
  await mkdir(dirname(file), { recursive: true });
  await atomicJsonWrite(file, registry);
}

function emptyWorkspaceRegistry(): WorkspaceRegistry {
  return { version: 1, workspaces: [], pendingRemovals: [] };
}

function removalIo(overrides: Partial<WorkspaceRemovalIo>): WorkspaceRemovalIo {
  return {
    persistRegistry: writeRegistry,
    claimManagedRoot: async (rootPath, claimPath) => {
      await rename(rootPath, claimPath);
      await syncDirectoriesBestEffort([dirname(rootPath), dirname(claimPath)]);
    },
    restoreMismatchedManagedClaim: async (claimPath, rootPath) => {
      await rename(claimPath, rootPath);
      await syncDirectoriesBestEffort([dirname(claimPath), dirname(rootPath)]);
    },
    removeClaimedManagedRoot: async (claimPath) => {
      await rm(claimPath, { recursive: true, force: true });
      await syncDirectoriesBestEffort([dirname(claimPath)]);
    },
    removeWorkspaceState: async (rootPath) => rm(workspaceStateDir(rootPath), { recursive: true, force: true }),
    ...overrides,
  };
}

type ManagedRootStatus = "matching" | "absent" | "mismatch" | "unavailable";

async function captureManagedRootIdentity(rootPath: string, managedBase: string): Promise<ManagedWorkspaceRootIdentity> {
  const initialInfo = await lstat(rootPath, { bigint: true });
  if (!initialInfo.isDirectory() || initialInfo.isSymbolicLink()) {
    throw new Error("A managed Space root must be an ordinary directory.");
  }
  if (initialInfo.ino === 0n) throw new Error("This filesystem does not expose a stable managed Space directory identity.");
  const [realPath, managedBaseRealPath] = await Promise.all([realpath(rootPath), realpath(managedBase)]);
  const confirmedInfo = await lstat(rootPath, { bigint: true });
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
  intent: Pick<WorkspaceRemovalIntent, "rootPath" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  return managedDirectoryStatus(intent, intent.rootPath, intent.managedRootIdentity?.realPath ?? intent.rootPath);
}

async function managedClaimStatus(
  intent: Pick<WorkspaceRemovalIntent,
    "transactionId" | "rootPath" | "storage" | "managedBase" | "managedRootIdentity">,
): Promise<ManagedRootStatus> {
  const claimPath = managedRemovalClaimPath(intent);
  return managedDirectoryStatus(intent, claimPath, claimPath);
}

async function managedDirectoryStatus(
  intent: Pick<WorkspaceRemovalIntent, "storage" | "managedBase" | "managedRootIdentity">,
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
  intent: Pick<WorkspaceRemovalIntent, "transactionId" | "storage" | "managedRootIdentity">,
): string {
  if (intent.storage !== "managed" || !intent.managedRootIdentity
    || !/^workspace-removal_[0-9a-f-]{36}$/.test(intent.transactionId)) {
    throw new Error("Managed Space removal intent cannot derive a safe claim path.");
  }
  const claimPath = resolve(
    intent.managedRootIdentity.managedBaseRealPath,
    `.workspace-removal-${intent.transactionId.slice("workspace-removal_".length)}`,
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

async function writePortableManifest(workspace: WorkspaceSummary): Promise<void> {
  const file = workspaceManifestFile(workspace.rootPath);
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
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
  await atomicJsonWrite(file, manifest);
}

async function commitRegistryAndPortableManifest(registry: WorkspaceRegistry, workspace: WorkspaceSummary): Promise<void> {
  const manifestFile = workspaceManifestFile(workspace.rootPath);
  const previousManifest = await snapshotFile(manifestFile);
  await writePortableManifest(workspace);
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

async function readExistingSpaceManifest(workspaceRoot: string): Promise<PortableSpaceManifest | null> {
  for (const file of [workspaceManifestFile(workspaceRoot), legacyWorkspaceManifestFile(workspaceRoot)]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PortableSpaceManifest>;
      if (!isWorkspaceId(parsed.id) || typeof parsed.name !== "string") continue;
      if (typeof parsed.createdAt !== "string" || !isValidTimestamp(parsed.createdAt)) continue;
      if (typeof parsed.updatedAt !== "string" || !isValidTimestamp(parsed.updatedAt)) continue;
      return {
        version: 1,
        id: parsed.id,
        name: normalizeWorkspaceName(parsed.name),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      // An invalid or partially written manifest must not make its folder unusable.
    }
  }
  return null;
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
): Promise<TreeEntry[]> {
  const entries = (await limit(() => readdir(directory, { withFileTypes: true })))
    .filter((entry) => !entry.isSymbolicLink() && !isAlwaysHiddenWorkspaceEntry(entry.name) && !isOfficeLockFileName(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile());

  // Every entry needs its own stat for size and modification time. Inspecting a
  // folder's entries together turns one round trip per entry into one bounded
  // batch per folder, which is what a Space with a large flat folder pays for.
  const inspected = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    // A tree walk races ordinary file activity, so an entry that disappears
    // between readdir and stat is skipped rather than failing the whole Space.
    const info = await limit(() => stat(path).catch(() => null));
    if (!info) return null;
    const relativePath = normalizeRelative(relative(root, path));
    const ignored = isWorkspaceIgnored(relativePath, ignorePatterns);
    if (ignored && !includeIgnored) return null;
    return { entry, path, info, relativePath, ignored };
  }));

  const result: TreeEntry[] = [];
  for (const item of inspected) {
    if (!item) continue;
    if (item.entry.isDirectory()) {
      const childrenLoaded = depth < maxDepth;
      const children = childrenLoaded
        ? await scanDirectory(root, item.path, depth + 1, maxDepth, ignorePatterns, includeIgnored, limit)
        : [];
      const descendantIgnoredCount = children.reduce((total, child) => total + (child.ignored ? 1 : 0) + (child.descendantIgnoredCount ?? 0), 0);
      result.push({
        name: item.entry.name,
        path: item.relativePath,
        kind: "folder",
        updatedAt: item.info.mtime.toISOString(),
        ...(item.ignored ? { ignored: true } : {}),
        ...(descendantIgnoredCount ? { descendantIgnoredCount } : {}),
        hasChildren: childrenLoaded
          ? children.length > 0
          : await directoryHasVisibleEntries(root, item.path, ignorePatterns, includeIgnored, limit),
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
    if (entry.isSymbolicLink() || isAlwaysHiddenWorkspaceEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const relativePath = normalizeRelative(relative(root, join(directory, entry.name)));
    if (!includeIgnored && isWorkspaceIgnored(relativePath, ignorePatterns)) continue;
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
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function visitWorkspaceFiles(root: string, directory: string, visitor: (relativePath: string, name: string) => void): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || isAlwaysHiddenWorkspaceEntry(entry.name) || isOfficeLockFileName(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visitWorkspaceFiles(root, path, visitor);
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

function normalizeWorkspaceName(value: string): string {
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

function stableWorkspaceId(rootPath: string): string {
  const normalized = process.platform === "win32" ? resolve(rootPath).toLocaleLowerCase() : resolve(rootPath);
  return `ws-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && /^ws-[a-f0-9]{16}$/.test(value);
}

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLocaleLowerCase() === resolve(right).toLocaleLowerCase() : resolve(left) === resolve(right);
}

function assertLinkedWorkspaceStateSeparation(rootPath: string): void {
  if (linkedWorkspaceStateSeparated(rootPath)) return;
  throw new Error("Linked folders cannot contain, or be contained by, Workspace application data. Choose a different folder.");
}

function linkedWorkspaceStateSeparated(rootPath: string): boolean {
  const root = resolve(rootPath);
  const stateRoot = resolve(workspaceStateRoot());
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

function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceSummary>;
  return typeof item.id === "string" && typeof item.name === "string" && typeof item.rootPath === "string"
    && item.location?.kind === "local" && (item.location.storage === "managed" || item.location.storage === "linked")
    && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function workspaceRemovalIntent(value: unknown): WorkspaceRemovalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workspace registry contains an invalid removal intent.");
  }
  const item = value as Partial<WorkspaceRemovalIntent>;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== [
    "transactionId", "workspaceId", "rootPath", "storage", "managedBase", "managedRootIdentity", "managedRootClaimed", "phase", "requestedAt",
  ].sort().join("\0")
    || typeof item.transactionId !== "string"
    || !/^workspace-removal_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.transactionId)
    || !isWorkspaceId(item.workspaceId)
    || typeof item.rootPath !== "string"
    || (item.storage !== "managed" && item.storage !== "linked")
    || typeof item.managedRootClaimed !== "boolean"
    || (item.phase !== "requested" && item.phase !== "app-state-removed")
    || typeof item.requestedAt !== "string" || !isValidTimestamp(item.requestedAt)) {
    throw new Error("Workspace registry contains an invalid removal intent.");
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
  const intent: WorkspaceRemovalIntent = {
    transactionId: item.transactionId,
    workspaceId: item.workspaceId,
    rootPath: lexicalWorkspaceRoot(item.rootPath),
    storage: item.storage,
    managedBase: item.managedBase === null ? null : resolve(item.managedBase!),
    managedRootIdentity: item.managedRootIdentity === null ? null : managedRootIdentity(item.managedRootIdentity),
    managedRootClaimed: item.managedRootClaimed,
    phase: item.phase,
    requestedAt: item.requestedAt,
  };
  validateWorkspaceRemovalIntent(intent);
  return intent;
}

function validateWorkspaceRemovalIntent(intent: WorkspaceRemovalIntent): void {
  const rootPath = lexicalWorkspaceRoot(intent.rootPath);
  if (intent.storage === "managed") {
    const base = resolve(intent.managedBase!);
    if (samePath(rootPath, base) || !pathContains(base, rootPath)) {
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

function lexicalWorkspaceRoot(rootPath: string): string {
  if (!isAbsolute(rootPath)) throw new Error("Space removal intent root must be absolute.");
  const resolved = resolve(rootPath);
  if (resolved === parse(resolved).root) throw new Error("A filesystem root cannot be used as a Space removal intent.");
  return resolved;
}

function managedRootIdentity(value: unknown): ManagedWorkspaceRootIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Managed Space removal intent has an invalid root identity.");
  }
  const item = value as Partial<ManagedWorkspaceRootIdentity>;
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
  if (!isWorkspaceId(value)) throw new Error("Invalid Space id.");
}

function notFound(message: string): Error {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 404;
  return error;
}
