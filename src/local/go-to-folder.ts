import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isShownStandardEntry, listStandardFolders } from "./standard-folders.js";
import { isAlwaysHiddenWorkFolderEntry } from "./work-folder-ignore.js";

/**
 * Go to Folder (docs/product-model.md, "2026-11-06 file manager layout"), as
 * Finder's ⇧⌘G: a typed path becomes a place the file manager opens, a
 * registered work-folder (the deepest one holding the path) or a Standard
 * Folder (the most specific one), and the folders and files whose names start
 * with what is being typed are offered as completions. Nothing outside those
 * places is listed or opened.
 */
export interface GoToFolderPlace { kind: "work-folder" | "standard"; id: string }

export interface GoToFolderResult {
  /** Where the typed path opens, when it names a folder or file that exists; a file opens its folder with the file selected. */
  target: { place: GoToFolderPlace; path: string; select: string | null } | null;
  /** Names in the typed path's folder that start with its last part, folders first. */
  suggestions: Array<{ name: string; kind: "folder" | "file"; path: string }>;
  /** Why the path can't be opened, in plain words, when it can't. */
  message: string | null;
}

const maxSuggestions = 12;

export async function goToFolder(
  typed: string,
  workFolders: ReadonlyArray<{ id: string; workFolderRoot: string }>,
  home = homedir(),
): Promise<GoToFolderResult> {
  const full = expandTypedPath(typed, home);
  if (!full) return { target: null, suggestions: [], message: null };
  const places = await knownPlaces(workFolders, home);
  const endsWithSeparator = /[\\/]$/.test(typed.trim());
  // The folder whose names complete the typed path: the path itself after a "/", else its parent.
  const listedFolder = endsWithSeparator ? full : dirname(full);
  const partial = endsWithSeparator ? "" : basename(full);
  const listedPlace = placeFor(listedFolder, places);
  const suggestions = listedPlace ? await completions(listedFolder, partial) : [];

  const targetPlace = placeFor(full, places);
  if (!targetPlace) {
    return {
      target: null,
      suggestions,
      message: "work-fold opens folders in your home folder, iCloud Drive, a work-folder, or a folder in the sidebar.",
    };
  }
  const info = await stat(full).catch(() => null);
  if (!info) return { target: null, suggestions, message: suggestions.length ? null : "There’s no folder or file at that path." };
  const relativePath = toPlacePath(targetPlace.root, full);
  if (info.isDirectory()) return { target: { place: targetPlace.place, path: relativePath, select: null }, suggestions, message: null };
  const parentPath = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  return { target: { place: targetPlace.place, path: parentPath, select: relativePath }, suggestions, message: null };
}

/** "~" is the home folder; anything else must be a full path (the renderer resolves names relative to the folder shown). */
export function expandTypedPath(typed: string, home = homedir()): string | null {
  const value = typed.trim();
  if (!value) return null;
  if (value === "~") return resolve(home);
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
  if (!isAbsolute(value)) return null;
  return resolve(value);
}

interface KnownPlace { place: GoToFolderPlace; root: string }

async function knownPlaces(workFolders: ReadonlyArray<{ id: string; workFolderRoot: string }>, home: string): Promise<KnownPlace[]> {
  // The home folder holds the other Standard Folders; the deepest match wins, so it opens only what nothing else holds.
  const standard = await listStandardFolders(workFolders, home);
  return [
    ...workFolders.map((workFolder) => ({ place: { kind: "work-folder" as const, id: workFolder.id }, root: resolve(workFolder.workFolderRoot) })),
    ...standard.filter((folder) => !folder.workFolderId).map((folder) => ({ place: { kind: "standard" as const, id: folder.id }, root: resolve(folder.root) })),
  ];
}

/** The deepest known place holding a path; a work-folder wins over a Standard Folder at the same depth. */
function placeFor(path: string, places: readonly KnownPlace[]): KnownPlace | null {
  let best: KnownPlace | null = null;
  for (const candidate of places) {
    if (!contains(candidate.root, path)) continue;
    if (!best || candidate.root.length > best.root.length || (candidate.root.length === best.root.length && candidate.place.kind === "work-folder")) best = candidate;
  }
  return best;
}

async function completions(folder: string, partial: string): Promise<GoToFolderResult["suggestions"]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const needle = partial.toLocaleLowerCase();
  return entries
    .filter((entry) => isShownStandardEntry(entry.name) && !isAlwaysHiddenWorkFolderEntry(entry.name) && entry.name.toLocaleLowerCase().startsWith(needle))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? "folder" as const : "file" as const, path: join(folder, entry.name) }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1))
    .slice(0, maxSuggestions);
}

function contains(root: string, path: string): boolean {
  const parent = comparison(root);
  const child = comparison(path);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function toPlacePath(root: string, path: string): string {
  return relative(root, path).split(sep).filter(Boolean).join("/");
}

/** macOS and Windows disks ignore case by default. */
function comparison(value: string): string {
  const resolved = resolve(value).replace(/[\\/]+$/, "") || sep;
  return process.platform === "linux" ? resolved : resolved.toLocaleLowerCase();
}
