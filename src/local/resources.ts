import { existsSync, lstatSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";

import { resourceLibraryRoot } from "./state-paths.js";
import {
  copyPathIntoWorkspace,
  resolveWorkspacePath,
  scanWorkspaceTree,
  writeUploadedFiles,
  type TreeEntry,
} from "./workspace.js";

export async function listResourceTree(): Promise<TreeEntry[]> {
  const root = await ensureResourceRoot();
  return (await scanWorkspaceTree(root)).entries;
}

export async function createResourceFolder(parentPath: string, name: string): Promise<{ path: string }> {
  const root = await ensureResourceRoot();
  const folderName = safeFolderName(name);
  const path = resolveWorkspacePath(root, [normalizePath(parentPath), folderName].filter(Boolean).join("/"));
  if (existsSync(path)) throw new Error("A Library folder with that name already exists.");
  await mkdir(path, { recursive: false });
  return { path: normalizePath(relative(root, path)) };
}

export async function uploadResourceFiles(
  targetFolderPath: string,
  files: Array<{ fileName: string; relativePath?: string; data: Buffer }>,
): Promise<Array<{ path: string; sizeBytes: number }>> {
  const root = await ensureResourceRoot();
  return writeUploadedFiles(root, targetFolderPath, files);
}

export async function copyResourcesToWorkspace(
  workspaceRoot: string,
  paths: string[],
  targetFolder: string,
): Promise<string[]> {
  if (!Array.isArray(paths) || !paths.length) throw new Error("Choose at least one Library item to add.");
  if (paths.length > 100) throw new Error("At most 100 Library items can be copied at once.");
  const root = await ensureResourceRoot();
  const copied: string[] = [];
  for (const path of paths) {
    const source = resolveWorkspacePath(root, path);
    const info = await stat(source).catch(() => null);
    if (!info) throw new Error(`Library item not found: ${path}`);
    if (lstatSync(source).isSymbolicLink()) throw new Error("Symbolic-link Library items cannot be copied.");
    copied.push(await copyPathIntoWorkspace(source, workspaceRoot, targetFolder));
  }
  return copied;
}

export async function ensureResourceRoot(): Promise<string> {
  const root = resourceLibraryRoot();
  await mkdir(root, { recursive: true });
  return root;
}

function safeFolderName(value: string): string {
  const name = basename(value.trim());
  if (!name || name === "." || name === ".." || dirname(value.trim()) !== "." || /[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new Error("Library folder name is not allowed.");
  }
  const windowsStem = name.split(".")[0]?.toLocaleUpperCase() ?? "";
  if (/[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)) {
    throw new Error("Library folder name is reserved by Windows.");
  }
  return name.slice(0, 120);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
