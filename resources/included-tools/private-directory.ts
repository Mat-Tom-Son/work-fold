import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const hardened = new Map<string, Promise<void>>();

/**
 * An owner-only directory for included-tool secrets. Included tools load from
 * the app archive without src/, so this mirrors src/local/private-access.ts:
 * mode 0700 on POSIX, and on Windows a protected DACL for this user, SYSTEM
 * and Administrators that files created inside inherit.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  const directory = resolve(path);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
  if (created !== undefined) hardened.delete(directory);
  let pending = hardened.get(directory);
  if (!pending) {
    pending = (async () => {
      const tool = (name: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
      const { stdout } = await run(tool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
      const user = /,"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(stdout)?.[1];
      if (!user) throw new Error("The current Windows user could not be identified.");
      const grant = (sid: string) => `*${sid}:(OI)(CI)F`;
      await run(tool("icacls.exe"), [directory, "/inheritance:r", "/grant:r", grant(user), grant("S-1-5-18"), grant("S-1-5-32-544"), "/q"], { windowsHide: true });
    })();
    hardened.set(directory, pending);
    pending.catch(() => hardened.delete(directory));
  }
  await pending;
}
