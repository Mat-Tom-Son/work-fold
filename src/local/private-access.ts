import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Well-known principals that may always reach a user's private files, as root can on POSIX. */
export const windowsPrivateSids = { system: "S-1-5-18", administrators: "S-1-5-32-544" } as const;

const hardened = new Map<string, Promise<void>>();
let currentUser: Promise<string> | undefined;

function systemTool(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/** The signed-in user's SID, read once per process. */
export function currentWindowsUserSid(): Promise<string> {
  currentUser ??= run(systemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true }).then(({ stdout }) => {
    // Local and domain users are S-1-5-21-*, Microsoft Entra users S-1-12-1-*.
    const sid = /,"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(stdout)?.[1];
    if (!sid) throw new Error("The current Windows user could not be identified.");
    return sid;
  });
  currentUser.catch(() => { currentUser = undefined; });
  return currentUser;
}

/**
 * Creates a directory only the current user can reach, for secrets such as
 * tokens, launch descriptors and attachment manifests. POSIX uses mode 0700.
 * Windows ignores modes, and a profile's inherited ACL may admit other
 * principals, so the directory gets a protected DACL for this user, SYSTEM and
 * Administrators that every file created inside it inherits.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  const directory = resolve(path);
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") { await chmod(directory, 0o700); return; }
  // A directory recreated since it was hardened starts with an inherited DACL again.
  if (created !== undefined) hardened.delete(directory);
  let pending = hardened.get(directory);
  if (!pending) {
    pending = (async () => {
      const user = await currentWindowsUserSid();
      const grant = (sid: string) => `*${sid}:(OI)(CI)F`;
      await run(systemTool("icacls.exe"), [directory, "/inheritance:r", "/grant:r", grant(user), grant(windowsPrivateSids.system), grant(windowsPrivateSids.administrators), "/q"], { windowsHide: true });
    })();
    hardened.set(directory, pending);
    pending.catch(() => hardened.delete(directory));
  }
  await pending;
}
