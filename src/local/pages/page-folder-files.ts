/**
 * Reading page folders inside a work-folder (docs/pages.md, "A page is a
 * folder"). Every read goes through the work-folder path policy
 * (`resolveWorkFolderPath`: no escapes, no reserved metadata, no link
 * segments), opens files no-follow, and rechecks the file's identity after
 * reading, the way other work-folder file reads do. Nothing here reads
 * outside the work-folder.
 */
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";

import { nestedRegisteredWorkFolderPaths, resolveWorkFolderPath } from "../work-folder.js";

/** File limits for one page (docs/pages.md, "How a page runs"). */
export const pageFolderLimits = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 10 * 1024 * 1024,
  maxPageBytes: 25 * 1024 * 1024,
  maxDeclarationBytes: 1024 * 1024,
  maxFolderDepth: 32,
  maxPagePathLength: 1_024,
});

/** Bounds for finding page folders in a work-folder. */
export const pageFinderLimits = Object.freeze({
  maxDepth: 8,
  maxPages: 200,
  maxFoldersVisited: 5_000,
});

export const pageDeclarationFileName = "page.json";

/** Real visitors' data and its SQLite side files, never part of the page (stage 2). */
const pageDataFileNames = new Set(["data.sqlite", "data.sqlite-journal", "data.sqlite-wal", "data.sqlite-shm"]);

/** Folder names the page finder never enters. Hidden names (`.work-fold`, `.pi`, `.git`) are skipped too. */
const skippedFinderFolders = new Set(["node_modules"]);

export class PageFolderError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "PageFolderError";
    this.statusCode = statusCode;
  }
}

/**
 * Checks a page folder's work-folder-relative path as a person or agent gives
 * it: `/`-separated, no hidden, empty, `.`, or `..` segments. Returns it
 * without a trailing slash.
 */
export function normalizePagePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PageFolderError(400, "Name the page folder with its path in the work-folder.");
  const trimmed = value.replace(/\/+$/u, "");
  if (trimmed.length > pageFolderLimits.maxPagePathLength) {
    throw new PageFolderError(400, `A page folder path can be at most ${pageFolderLimits.maxPagePathLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f\\]/u.test(trimmed) || trimmed.startsWith("/")) {
    throw new PageFolderError(400, "A page folder path is relative to the work-folder and uses / between folders.");
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new PageFolderError(400, "A page folder path can't contain empty, . or .. parts.");
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    throw new PageFolderError(400, "Hidden folders can't be pages.");
  }
  return segments.join("/");
}

/** The page folder's absolute path, after the work-folder path policy, or a 404 when it isn't a page folder. */
export async function resolvePageFolder(workFolderRoot: string, pagePath: string): Promise<string> {
  let absolute: string;
  try {
    absolute = resolveWorkFolderPath(workFolderRoot, pagePath);
  } catch (error) {
    throw new PageFolderError(400, error instanceof Error ? error.message : "That page folder path isn't allowed.");
  }
  const nested = await nestedRegisteredWorkFolderPaths(workFolderRoot);
  if (nested.some((boundary) => pathWithin(pagePath, boundary))) {
    throw new PageFolderError(404, `${pagePath} belongs to another work-folder. Open that work-folder to see this page.`);
  }
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new PageFolderError(404, `There's no folder at ${pagePath}.`);
  const declaration = await lstat(resolveWorkFolderPath(workFolderRoot, `${pagePath}/${pageDeclarationFileName}`)).catch(() => null);
  if (!declaration?.isFile() || declaration.isSymbolicLink()) {
    throw new PageFolderError(404, `${pagePath} isn't a page folder: it has no page.json.`);
  }
  return absolute;
}

/**
 * Reads one file of a page folder, no-follow, and only when it is still the
 * same file after reading. `relativePath` is work-folder-relative.
 */
export async function readWorkFolderFileBytes(workFolderRoot: string, relativePath: string, maxBytes: number): Promise<Uint8Array> {
  const path = resolveWorkFolderPath(workFolderRoot, relativePath);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${relativePath} isn't a regular file.`);
  if (before.size > maxBytes) throw new Error(`${relativePath} is larger than ${formatBytes(maxBytes)}.`);
  // A substituted FIFO must never stall the desktop, nor may a link redirect the read.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error(`${relativePath} changed while it was being read.`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(resolveWorkFolderPath(workFolderRoot, relativePath));
    if (offset !== opened.size || !sameFile(opened, after) || !sameFile(opened, named)) {
      throw new Error(`${relativePath} changed while it was being read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/** UTF-8 text of one page file, or an error naming the file. */
export async function readWorkFolderTextFile(workFolderRoot: string, relativePath: string, maxBytes: number): Promise<string> {
  const bytes = await readWorkFolderFileBytes(workFolderRoot, relativePath, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${relativePath} isn't UTF-8 text.`);
  }
}

export interface PageFolderFile {
  /** Page-folder-relative path, `/`-separated. */
  path: string;
  size: number;
}

export interface PageFolderWalkProblem {
  file: string;
  message: string;
  severity: "error" | "warning";
}

export interface PageFolderWalk {
  files: Map<string, PageFolderFile>;
  bytes: number;
  problems: PageFolderWalkProblem[];
}

/**
 * Lists the files that make up a page: everything in the folder except
 * `data.sqlite` and its side files, hidden entries (`.work-fold/`, `.pi/`,
 * dotfiles). Links, nested page folders, nested work-folders, and the
 * contract's limits are reported as errors.
 */
export async function walkPageFolder(workFolderRoot: string, pagePath: string): Promise<PageFolderWalk> {
  const files = new Map<string, PageFolderFile>();
  const problems: PageFolderWalkProblem[] = [];
  const nested = (await nestedRegisteredWorkFolderPaths(workFolderRoot))
    .filter((boundary) => pathWithin(boundary, pagePath) && boundary !== pagePath)
    .map((boundary) => boundary.slice(pagePath.length + 1));
  let bytes = 0;
  let tooMany = false;
  let tooLarge = false;

  const visit = async (relativeDir: string, depth: number): Promise<void> => {
    if (tooMany) return;
    if (depth > pageFolderLimits.maxFolderDepth) {
      problems.push({ file: relativeDir, message: `Folders are nested more than ${pageFolderLimits.maxFolderDepth} levels deep.`, severity: "error" });
      return;
    }
    const absoluteDir = resolveWorkFolderPath(workFolderRoot, relativeDir ? `${pagePath}/${relativeDir}` : pagePath);
    let entries: Dirent[];
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      problems.push({ file: relativeDir, message: "This folder couldn't be read.", severity: "error" });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (tooMany) return;
      const name = entry.name;
      if (name.startsWith(".")) continue;
      if (!relativeDir && pageDataFileNames.has(name)) continue;
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      if (entry.isSymbolicLink()) {
        problems.push({ file: relative, message: "Links aren't allowed in a page folder. Put the real file here instead.", severity: "error" });
        continue;
      }
      if (entry.isDirectory()) {
        if (nested.some((boundary) => pathWithin(relative, boundary))) {
          problems.push({ file: relative, message: "This folder is another work-folder; a page folder can't contain one.", severity: "error" });
          continue;
        }
        const childDeclaration = await lstat(resolveWorkFolderPath(workFolderRoot, `${pagePath}/${relative}/${pageDeclarationFileName}`)).catch(() => null);
        if (childDeclaration?.isFile()) {
          problems.push({ file: `${relative}/${pageDeclarationFileName}`, message: "A page folder can't contain another page folder. Move this page out, or remove its page.json.", severity: "error" });
        }
        await visit(relative, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        problems.push({ file: relative, message: "Only ordinary files and folders can be part of a page.", severity: "error" });
        continue;
      }
      if (files.size >= pageFolderLimits.maxFiles) {
        tooMany = true;
        problems.push({ file: "", message: `A page can have at most ${pageFolderLimits.maxFiles} files.`, severity: "error" });
        return;
      }
      let info: Stats;
      try {
        info = await lstat(resolveWorkFolderPath(workFolderRoot, `${pagePath}/${relative}`));
      } catch {
        problems.push({ file: relative, message: "This file couldn't be read.", severity: "error" });
        continue;
      }
      if (info.size > pageFolderLimits.maxFileBytes) {
        problems.push({ file: relative, message: `This file is ${formatBytes(info.size)}; each file in a page can be at most ${formatBytes(pageFolderLimits.maxFileBytes)}.`, severity: "error" });
      }
      bytes += info.size;
      if (!tooLarge && bytes > pageFolderLimits.maxPageBytes) {
        tooLarge = true;
        problems.push({ file: "", message: `A page can be at most ${formatBytes(pageFolderLimits.maxPageBytes)} in all.`, severity: "error" });
      }
      files.set(relative, { path: relative, size: info.size });
    }
  };
  await visit("", 0);
  return { files, bytes, problems };
}

/** Whether an ancestor folder of `pagePath` inside the work-folder is itself a page folder. */
export async function enclosingPageFolder(workFolderRoot: string, pagePath: string): Promise<string | null> {
  const segments = pagePath.split("/");
  for (let length = segments.length - 1; length >= 1; length -= 1) {
    const ancestor = segments.slice(0, length).join("/");
    const declaration = await lstat(resolveWorkFolderPath(workFolderRoot, `${ancestor}/${pageDeclarationFileName}`)).catch(() => null);
    if (declaration?.isFile()) return ancestor;
  }
  return null;
}

/**
 * Every page folder in a work-folder: a folder that contains `page.json`.
 * Hidden folders, `node_modules`, links, and nested work-folders are skipped;
 * a page folder's own subfolders aren't searched. Bounded in depth and count.
 */
export async function findPageFolders(workFolderRoot: string): Promise<{ pages: string[]; truncated: boolean }> {
  const nested = await nestedRegisteredWorkFolderPaths(workFolderRoot);
  const pages: string[] = [];
  let truncated = false;
  let visited = 0;
  const queue: Array<{ path: string; depth: number }> = [{ path: "", depth: 0 }];
  while (queue.length) {
    const { path, depth } = queue.shift()!;
    if (++visited > pageFinderLimits.maxFoldersVisited) {
      truncated = true;
      break;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(path ? resolveWorkFolderPath(workFolderRoot, path) : resolveWorkFolderPath(workFolderRoot, "."), { withFileTypes: true });
    } catch {
      continue;
    }
    if (path && entries.some((entry) => entry.name === pageDeclarationFileName && entry.isFile())) {
      pages.push(path);
      if (pages.length >= pageFinderLimits.maxPages) {
        truncated = true;
        break;
      }
      continue;
    }
    if (depth >= pageFinderLimits.maxDepth) continue;
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || skippedFinderFolders.has(entry.name)) continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (nested.some((boundary) => pathWithin(child, boundary))) continue;
      queue.push({ path: child, depth: depth + 1 });
    }
  }
  return { pages: pages.sort((a, b) => a.localeCompare(b, "en")), truncated };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
  if (bytes >= 1024) return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
  return `${bytes} bytes`;
}

/** `path` is `boundary` or inside it, comparing the way macOS and Windows file systems do. */
function pathWithin(path: string, boundary: string): boolean {
  const fold = (value: string) => (process.platform === "darwin" || process.platform === "win32" ? value.toLocaleLowerCase() : value);
  const candidate = fold(path);
  const container = fold(boundary);
  return candidate === container || candidate.startsWith(`${container}/`);
}

function sameFile(a: Stats, b: Stats): boolean {
  return b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
