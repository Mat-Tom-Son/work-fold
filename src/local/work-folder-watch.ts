import { realpath } from "node:fs/promises";

/**
 * Resolve the physical directory before handing it to libuv's Windows watcher.
 * Node 24's bundled libuv can abort when a watched root uses an 8.3 path but a
 * changed child is reported with its long path. Keep the logical work-folder root for
 * policy checks; only the native watcher needs this canonical path.
 */
export async function canonicalWorkFolderWatchRoot(workFolderRoot: string): Promise<string> {
  try {
    return await realpath(workFolderRoot);
  } catch {
    return workFolderRoot;
  }
}
