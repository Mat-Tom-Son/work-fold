import { mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { dirname, relative } from "node:path";

import { resolveSpacePath } from "../space.js";
import { inspectRestrictedAppPackage } from "./restricted-app-package.js";
import type { RestrictedAppChangeReceipt } from "./restricted-app-proposals.js";

/** Copy reviewed bytes only. Neither source tooling nor runtime data is executed or copied. */
export async function materializeRestrictedAppWorkingCopy(
  spaceRoot: string,
  change: RestrictedAppChangeReceipt,
  files: ReadonlyMap<string, Uint8Array>,
  checkpoint: (paths: string[]) => Promise<unknown>,
): Promise<void> {
  const destination = resolveSpacePath(spaceRoot, change.sourcePath);
  let temporary: string | undefined;
  let created = false;
  try {
    // A retry after interruption can finish an exact copy, but never overwrite edits.
    const existing = await inspectRestrictedAppPackage(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      temporary = await mkdtemp(resolveSpacePath(spaceRoot, `${change.sourcePath}-preparing-`));
      const directories = new Set<string>([temporary]);
      for (const [path, bytes] of files) {
        const target = resolveSpacePath(temporary, path);
        await mkdir(dirname(target), { recursive: true });
        for (let parent = dirname(target); parent.startsWith(temporary); parent = dirname(parent)) {
          directories.add(parent);
          if (parent === temporary) break;
        }
        const handle = await open(target, "wx", 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      }
      const inspected = await inspectRestrictedAppPackage(temporary);
      if (inspected.digest !== change.baseDigest) throw new Error("The app working copy does not match its installed revision.");
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
      // Destination is an unpredictable, receipt-owned UUID path. Never merge into an existing folder.
      await mkdir(destination);
      await rename(temporary, destination);
      temporary = undefined;
      created = true;
      await syncDirectory(spaceRoot);
    } else if (existing.digest !== change.baseDigest) {
      throw new Error(`The interrupted working copy has been edited. Keep ${change.sourcePath} and start a new app change.`);
    }
    await checkpoint([...files.keys()].map((path) => relative(spaceRoot, resolveSpacePath(destination, path)).replaceAll("\\", "/")));
  } catch (error) {
    if (created) {
      // Don't remove content somebody edited while History was being recorded.
      const current = await inspectRestrictedAppPackage(destination).catch(() => null);
      if (current?.digest === change.baseDigest) await rm(destination, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!["EINVAL", "ENOTSUP", "EBADF"].includes(code)
      && !(process.platform === "win32" && ["EISDIR", "EPERM"].includes(code))) throw error;
  } finally { await handle?.close(); }
}
