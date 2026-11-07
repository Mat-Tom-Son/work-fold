import { lstat } from "node:fs/promises";
import { getWorkFolder, nestedRegisteredWorkFolderPaths, resolveWorkFolderPath } from "./work-folder.js";
import { isWorkFolderIgnored, readWorkFolderIgnoreState } from "./work-folder-ignore.js";

/**
 * Whether a file a Worker reported is still a visible file of its work-folder:
 * a regular file (not a link), not ignored, and not inside a nested
 * work-folder. Metadata only; nothing is read.
 */
export async function isWorkFolderFileVisible(workFolderId: string, relativePath: string): Promise<boolean> {
  try {
    const workFolder = await getWorkFolder(workFolderId);
    const path = await visiblePath(workFolderId, relativePath, workFolder.workFolderRoot);
    const file = await lstat(path);
    return file.isFile() && !file.isSymbolicLink() && await visiblePath(workFolderId, relativePath, workFolder.workFolderRoot) === path;
  } catch { return false; }
}

async function visiblePath(workFolderId: string, relativePath: string, expectedRoot: string): Promise<string> {
  if (typeof relativePath !== "string" || !relativePath || relativePath.length > 2048
    || relativePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) throw unavailable();
  const current = await getWorkFolder(workFolderId);
  if (current.workFolderRoot !== expectedRoot) throw unavailable();
  const path = resolveWorkFolderPath(expectedRoot, relativePath);
  const [ignore, nested] = await Promise.all([readWorkFolderIgnoreState(expectedRoot), nestedRegisteredWorkFolderPaths(expectedRoot)]);
  if (isWorkFolderIgnored(relativePath, ignore.patterns) || nested.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))) throw unavailable();
  return path;
}

function unavailable(): Error {
  return new Error("This file is unavailable, changed, or is outside this work-folder's visible files.");
}
