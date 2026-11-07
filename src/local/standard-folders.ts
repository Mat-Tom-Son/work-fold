import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  getWorkFolderEntryInfo,
  listWorkFolders,
  nestedRegisteredWorkFolderPaths,
  resolveNestableFolderPath,
  resolveWorkFolderPath,
  scanWorkFolderTree,
  type TreeEntry,
  type WorkFolderEntryInfo,
} from "./work-folder.js";
import { isAlwaysHiddenWorkFolderEntry } from "./work-folder-ignore.js";
import { workFoldStateRoot } from "./state-paths.js";

/**
 * Standard Folders (docs/product-model.md, "2026-11-06 file manager layout"):
 * the person's Desktop, Documents, Downloads, Pictures, home folder, and
 * iCloud Drive, shown in the file manager's sidebar the way Finder shows them,
 * plus any folder the person added with the section's + button. The host
 * resolves each folder (from the home folder, or from the machine-local list
 * of added folders, which only the desktop folder picker writes); the renderer
 * names one only by id and a path inside it.
 *
 * A standard folder is not a work-folder. It has no Worker, History, or
 * `.work-fold/` record, and work-fold writes nothing into it except what the
 * person does by hand: rename, a new folder, Move to Trash (desktop), or
 * "Put This Folder to Work", which registers it. Anything inside a registered
 * work-folder belongs to that work-folder, so these routes refuse to change it
 * and the person uses it from the work-folders section instead.
 */
export const builtInStandardFolderIds = ["desktop", "documents", "downloads", "pictures", "home", "icloud"] as const;
export type BuiltInStandardFolderId = typeof builtInStandardFolderIds[number];
/** A built-in place, or a folder the person added (`added-` and 16 hex digits). */
export type StandardFolderId = BuiltInStandardFolderId | `added-${string}`;

const builtInFolders: Record<BuiltInStandardFolderId, { name: (home: string) => string; path: (home: string) => string }> = {
  desktop: { name: () => "Desktop", path: (home) => join(home, "Desktop") },
  documents: { name: () => "Documents", path: (home) => join(home, "Documents") },
  downloads: { name: () => "Downloads", path: (home) => join(home, "Downloads") },
  pictures: { name: () => "Pictures", path: (home) => join(home, "Pictures") },
  // The home folder goes by the person's account name, as in Finder.
  home: { name: (home) => basename(home) || "Home", path: (home) => home },
  icloud: { name: () => "iCloud Drive", path: (home) => join(home, "Library", "Mobile Documents", "com~apple~CloudDocs") },
};

export interface StandardFolderSummary {
  id: StandardFolderId;
  name: string;
  /** The folder on this computer, for Copy Path and nested work-folder matching. */
  root: string;
  /** Set when this folder is itself a registered work-folder; the sidebar then lists it there. */
  workFolderId: string | null;
  /** True for a folder the person added with +; only those can be removed from the sidebar. */
  added?: boolean;
}

interface AddedFolder { id: `added-${string}`; root: string; name: string }

export function isBuiltInStandardFolderId(value: unknown): value is BuiltInStandardFolderId {
  return typeof value === "string" && (builtInStandardFolderIds as readonly string[]).includes(value);
}

export function isStandardFolderId(value: unknown): value is StandardFolderId {
  return isBuiltInStandardFolderId(value) || (typeof value === "string" && addedFolders().some((folder) => folder.id === value));
}

export function standardFolderRoot(id: StandardFolderId, home = homedir()): string {
  if (isBuiltInStandardFolderId(id)) return builtInFolders[id].path(resolve(home));
  const added = addedFolders().find((folder) => folder.id === id);
  if (!added) throw Object.assign(new Error("That folder isn’t in the sidebar anymore."), { status: 404, statusCode: 404 });
  return added.root;
}

export function standardFolderName(id: StandardFolderId, home = homedir()): string {
  if (isBuiltInStandardFolderId(id)) return builtInFolders[id].name(resolve(home));
  return addedFolders().find((folder) => folder.id === id)?.name ?? "Folder";
}

/** The standard folders that exist on this computer. Stat only: listing one's contents is what asks macOS for access. */
export async function listStandardFolders(
  workFolders: ReadonlyArray<{ id: string; workFolderRoot: string }>,
  home = homedir(),
): Promise<StandardFolderSummary[]> {
  const folders: StandardFolderSummary[] = [];
  const places = [
    ...builtInStandardFolderIds.map((id) => ({ id: id as StandardFolderId, name: standardFolderName(id, home), root: standardFolderRoot(id, home), added: false })),
    ...addedFolders().map((folder) => ({ ...folder, added: true })),
  ];
  for (const place of places) {
    // Looking inside ~/Library/Mobile Documents is what asks macOS for iCloud
    // access, so iCloud Drive is listed when that folder exists and asks only once opened.
    const probe = place.id === "icloud" ? dirname(place.root) : place.root;
    const info = await lstat(probe).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const registered = workFolders.find((workFolder) => samePath(workFolder.workFolderRoot, place.root));
    folders.push({ id: place.id, name: place.name, root: place.root, workFolderId: registered?.id ?? null, ...(place.added ? { added: true } : {}) });
  }
  return folders;
}

/** One level of a standard folder, without what Finder hides (dotfiles, and Library in the home folder). */
export async function scanStandardFolder(id: StandardFolderId, relativePath: string, home = homedir()): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
  const root = standardFolderRoot(id, home);
  const atHomeRoot = samePath(root, resolve(home)) && !relativePath.split("/").some((part) => part && part !== ".");
  try {
    const scan = await scanWorkFolderTree(root, 0, relativePath, { includeIgnored: true, nestedFolderPaths: await nestedRegisteredWorkFolderPaths(root) });
    return {
      tree: scan.entries
        .filter((entry) => isShownStandardEntry(entry.name) && !(atHomeRoot && entry.name === "Library"))
        .map(({ children: _children, ...entry }) => entry),
      truncated: scan.truncated,
    };
  } catch (error) {
    throw accessError(error, id);
  }
}

export async function standardFolderEntryInfo(id: StandardFolderId, relativePath: string, home = homedir()): Promise<WorkFolderEntryInfo> {
  // Downloads holds multi-gigabyte installers; the Info panel never waits on a hash.
  try {
    return await getWorkFolderEntryInfo(standardFolderRoot(id, home), relativePath, { hash: false });
  } catch (error) {
    throw accessError(error, id);
  }
}

/** The file for a path inside a standard folder, under the same path policy as a work-folder's. */
export function resolveStandardFolderPath(id: StandardFolderId, relativePath: string, home = homedir()): string {
  return resolveWorkFolderPath(standardFolderRoot(id, home), relativePath);
}

/**
 * Refuses a change to anything a registered work-folder owns: the standard
 * folder itself when it is registered, a registered folder inside it, or
 * anything inside one. Those changes go through the work-folder, which keeps
 * History for them. Renaming or trashing a folder that holds a work-folder
 * would carry it along, so that is refused too; adding a folder next to one
 * (`allowContaining`) is not.
 */
export async function assertStandardFolderPathUnowned(
  id: StandardFolderId,
  relativePath: string,
  home = homedir(),
  options: { allowContaining?: boolean } = {},
): Promise<string> {
  const target = resolveStandardFolderPath(id, relativePath, home);
  for (const workFolder of await listWorkFolders()) {
    if (pathContains(workFolder.workFolderRoot, target) || (!options.allowContaining && pathContains(target, workFolder.workFolderRoot))) {
      throw Object.assign(
        new Error(`${workFolder.name} is a work-folder. Open it from the work-folders section to change it, so History keeps the change.`),
        { status: 409, statusCode: 409 },
      );
    }
  }
  return target;
}

export async function renameStandardFolderEntry(id: StandardFolderId, relativePath: string, newName: string, home = homedir()): Promise<{ path: string }> {
  if (!relativePath.trim()) throw badRequest(`${standardFolderName(id, home)} itself can’t be renamed.`);
  const source = await assertStandardFolderPathUnowned(id, relativePath, home);
  const name = validEntryName(newName);
  if (name === basename(source)) return { path: toRelative(id, source, home) };
  const destination = join(dirname(source), name);
  await assertStandardFolderPathUnowned(id, toRelative(id, destination, home), home, { allowContaining: true });
  const existing = await lstat(destination).catch(() => null);
  // A case-only rename on a case-insensitive disk finds the source itself.
  const sameItem = existing && name.toLocaleLowerCase() === basename(source).toLocaleLowerCase();
  if (existing && !sameItem) throw conflict(`An item named “${name}” already exists here.`);
  try {
    await rename(source, destination);
  } catch (error) {
    throw accessError(error, id);
  }
  return { path: toRelative(id, destination, home) };
}

export async function createStandardFolderFolder(id: StandardFolderId, parentPath: string, folderName: string, home = homedir()): Promise<{ path: string }> {
  const parent = await assertStandardFolderPathUnowned(id, parentPath, home, { allowContaining: true });
  const name = validEntryName(folderName);
  const destination = join(parent, name);
  if (await lstat(destination).catch(() => null)) throw conflict(`An item named “${name}” already exists here.`);
  try {
    await mkdir(destination);
  } catch (error) {
    throw accessError(error, id);
  }
  return { path: toRelative(id, destination, home) };
}

/** The folder "Put This Folder to Work" registers: the standard folder itself, or a folder inside it. */
export async function standardFolderRegistrationTarget(id: StandardFolderId, relativePath: string, home = homedir()): Promise<string> {
  const root = standardFolderRoot(id, home);
  if (relativePath.split("/").filter((part) => part && part !== ".").length) return resolveNestableFolderPath(root, relativePath);
  const info = await lstat(root).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error(`${standardFolderName(id, home)} isn’t on this computer.`), { status: 404, statusCode: 404 });
  return root;
}

export function isShownStandardEntry(name: string): boolean {
  return Boolean(name) && !name.startsWith(".") && name !== "Icon\r" && !isAlwaysHiddenWorkFolderEntry(name);
}

/** macOS answers EPERM until the person allows work-fold into Desktop, Documents, Downloads, Pictures, or iCloud Drive. */
export function accessError(error: unknown, id: StandardFolderId): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EPERM" || code === "EACCES") {
    return Object.assign(
      new Error(`work-fold isn’t allowed to open ${standardFolderName(id)}. Allow it in System Settings → Privacy & Security → Files and Folders.`),
      { status: 403, statusCode: 403 },
    );
  }
  return error;
}

/**
 * The folders the person added to the sidebar with +, kept on this computer
 * only. The desktop app's folder picker adds one; Remove from Sidebar takes
 * one away. Removing never touches the folder.
 */
export function addedFoldersFile(): string {
  return join(workFoldStateRoot(), "sidebar-folders.json");
}

let addedFoldersCache: { mtimeMs: number; folders: AddedFolder[] } | null = null;

function addedFolders(): AddedFolder[] {
  const file = addedFoldersFile();
  let mtimeMs: number;
  try { mtimeMs = statSync(file).mtimeMs; } catch { return []; }
  if (addedFoldersCache?.mtimeMs === mtimeMs) return addedFoldersCache.folders;
  let folders: AddedFolder[] = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; folders?: unknown };
    if (parsed.version === 1 && Array.isArray(parsed.folders)) {
      folders = parsed.folders.filter((item): item is AddedFolder => typeof item === "object" && item !== null
        && typeof (item as AddedFolder).id === "string" && /^added-[0-9a-f]{16}$/.test((item as AddedFolder).id)
        && typeof (item as AddedFolder).root === "string" && (item as AddedFolder).root.startsWith(sep)
        && typeof (item as AddedFolder).name === "string");
    }
  } catch { folders = []; }
  addedFoldersCache = { mtimeMs, folders };
  return folders;
}

function writeAddedFolders(folders: AddedFolder[]): void {
  const file = addedFoldersFile();
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, folders }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  addedFoldersCache = null;
}

/** Adds a folder the person chose in the folder picker; a folder already in the sidebar is returned as it is. */
export function addSidebarFolder(folderPath: string, home = homedir()): { id: StandardFolderId; name: string } {
  const root = resolve(folderPath);
  const info = statSync(root, { throwIfNoEntry: false });
  if (!info?.isDirectory()) throw badRequest("Choose a folder.");
  for (const id of builtInStandardFolderIds) {
    if (samePath(standardFolderRoot(id, home), root)) return { id, name: standardFolderName(id, home) };
  }
  const existing = addedFolders().find((folder) => samePath(folder.root, root));
  if (existing) return { id: existing.id, name: existing.name };
  const folder: AddedFolder = {
    id: `added-${createHash("sha256").update(comparisonPath(root)).digest("hex").slice(0, 16)}`,
    root,
    name: basename(root) || root,
  };
  writeAddedFolders([...addedFolders(), folder]);
  return { id: folder.id, name: folder.name };
}

/** Remove from Sidebar: only a folder the person added, and never the folder itself. */
export function removeSidebarFolder(id: string): void {
  if (isBuiltInStandardFolderId(id)) throw badRequest("Built-in folders stay in the sidebar.");
  const folders = addedFolders();
  if (!folders.some((folder) => folder.id === id)) throw Object.assign(new Error("That folder isn’t in the sidebar anymore."), { status: 404, statusCode: 404 });
  writeAddedFolders(folders.filter((folder) => folder.id !== id));
}

function validEntryName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === "..") throw badRequest("Enter a name.");
  if (/[/\\\0:]/.test(name)) throw badRequest("A name can’t contain / \\ or :.");
  if (name.startsWith(".")) throw badRequest("A name can’t start with a period.");
  if (Buffer.byteLength(name, "utf8") > 255) throw badRequest("That name is too long.");
  if (isAlwaysHiddenWorkFolderEntry(name)) throw badRequest("That name is reserved.");
  return name;
}

function toRelative(id: StandardFolderId, path: string, home: string): string {
  return relative(standardFolderRoot(id, home), path).split(sep).join("/");
}

function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

function pathContains(parentPath: string, childPath: string): boolean {
  const parent = comparisonPath(parentPath);
  const child = comparisonPath(childPath);
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** macOS and Windows disks ignore case by default; a wrongly cased path names the same folder. */
function comparisonPath(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { status: 409, statusCode: 409 });
}
