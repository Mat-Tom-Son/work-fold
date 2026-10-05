import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChromeDistribution } from "../../src/local/agent/included-chrome-connection.js";
import { ensurePrivateDirectory } from "../../src/local/private-access.js";
import { peContentSha256 } from "./pe-image.js";

/** Chrome's per-user native messaging registration on Windows: a key whose default value names the manifest. */
export interface ChromeHostRegistry { read(): Promise<string | undefined>; write(manifestPath: string): Promise<void> }

interface Options {
  stateRoot: string;
  sourceDirectory: string;
  distribution: ChromeDistribution;
  /** Explicitly injected isolated browser root in tests; never supplied by a web page. */
  chromeUserDataRoot?: string;
  enabled: boolean;
  verifySignature?: boolean;
  platform?: NodeJS.Platform;
  /** Windows: the installed app the bootstrap may start for Chrome's Open work-fold. */
  appExecutable?: string;
  /** Windows: injected in tests; defaults to HKCU through reg.exe. */
  registry?: ChromeHostRegistry;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

/** Register only this app's exact Store origin, never inspect or edit a Chrome profile. */
export class ChromeNativeHostRegistration {
  constructor(private readonly options: Options) {}
  private get windows(): boolean { return (this.options.platform ?? process.platform) === "win32"; }
  async register(explicit: boolean): Promise<void> {
    const { distribution } = this.options;
    if (!this.options.enabled) throw new Error("Chrome Store setup is available in the installed work-fold app.");
    if (!distribution.storeId || !/^[a-p]{32}$/.test(distribution.storeId) || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(distribution.nativeHostName)) throw new Error("The Chrome Store connection identity is not available.");
    const origin = `chrome-extension://${distribution.storeId}/`;
    const windows = this.windows;
    const source = await realpath(join(this.options.sourceDirectory, windows ? "work-fold-chrome-host.exe" : "work-fold-chrome-host"));
    const provenance = JSON.parse(await readFile(join(this.options.sourceDirectory, "source.json"), "utf8"));
    if (provenance.schema !== "work-fold.chrome-native-host-source.v1" || provenance.origin !== origin || provenance.nativeHostName !== distribution.nativeHostName || provenance.bootstrapVersion !== distribution.bootstrapVersion) throw new Error("The signed Chrome bootstrap does not match this app's Store identity.");
    // Windows pins the reviewed build's exact bytes; there is no bundle seal to check.
    const verify = (path: string) => !windows && this.options.verifySignature !== false ? run("/usr/bin/codesign", ["--verify", "--strict", path]) : Promise.resolve();
    await verify(source);
    const bytes = await readFile(source), sha256 = digest(bytes);
    // Signing changes the bytes but not the PE content the build recorded.
    if (windows && provenance.executableContentSha256 !== peContentSha256(bytes)) throw new Error("The Chrome bootstrap does not match this app's reviewed build.");
    const root = resolve(this.options.stateRoot, "chrome", "native-host");
    // The bootstrap admits launch.json only from an owner-only directory.
    await ensurePrivateDirectory(root);
    const binary = join(root, `work-fold-chrome-host-${sha256.slice(0, 24)}${windows ? ".exe" : ""}`);
    // Chrome scans a profile directory on macOS; on Windows a registry value names the manifest.
    const manifestPath = windows
      ? join(root, `${distribution.nativeHostName}.json`)
      : join(this.options.chromeUserDataRoot ?? join(homedir(), "Library/Application Support/Google/Chrome"), "NativeMessagingHosts", `${distribution.nativeHostName}.json`);
    const registry = windows ? this.options.registry ?? windowsChromeHostRegistry(distribution.nativeHostName) : undefined;
    const receiptPath = join(root, "registration.json");
    const manifest = { name: distribution.nativeHostName, description: "Connect Chrome to work-fold", path: binary, type: "stdio", allowed_origins: [origin] };
    let registered: string | undefined = manifestPath;
    if (registry) {
      try { registered = await registry.read(); }
      catch { if (!explicit) throw new Error("Chrome's existing work-fold registration could not be read. Connect Chrome again to repair it."); registered = undefined; }
    }
    let current: { path?: string; allowed_origins?: string[]; name?: string; type?: string } | undefined;
    if (registered) {
      try { current = JSON.parse(await readFile(registered, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !explicit) throw new Error("Chrome's existing work-fold registration could not be read. Connect Chrome again to repair it."); }
    }
    if (!current && !explicit) throw new Error("Chrome's registration was removed. Connect Chrome again to restore it.");
    if (current && !explicit) {
      let receipt: { manifestPath?: string; binary?: string } | undefined;
      try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch { /* No owned receipt means no automatic replacement. */ }
      if (receipt?.manifestPath !== registered || receipt?.manifestPath !== manifestPath || receipt.binary !== current.path || current.name !== distribution.nativeHostName || current.type !== "stdio" || JSON.stringify(current.allowed_origins) !== JSON.stringify([origin])) throw new Error("Another work-fold installation owns Chrome's registration. Connect Chrome explicitly to choose this installation.");
    }
    let needsCopy = false;
    try { needsCopy = digest(await readFile(binary)) !== sha256; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") needsCopy = true; else throw error; }
    if (needsCopy) {
      if (!explicit) {
        try { await stat(binary); throw new Error("The installed Chrome bootstrap has changed. Connect Chrome again to repair it."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const temporary = `${binary}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, temporary); await chmod(temporary, 0o700);
        if (digest(await readFile(temporary)) !== sha256) throw new Error("The Chrome bootstrap copy did not match the signed app.");
        await verify(temporary);
        await rename(temporary, binary);
      } finally { await rm(temporary, { force: true }); }
    }
    if (!(await stat(binary)).isFile()) throw new Error("Chrome bootstrap is not an ordinary executable.");
    if (windows) {
      if (!this.options.appExecutable) throw new Error("Chrome setup requires the installed work-fold app.");
      await atomicJson(join(root, "app.json"), { version: 1, executable: resolve(this.options.appExecutable) });
    }
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicJson(manifestPath, manifest);
    await registry?.write(manifestPath);
    await atomicJson(receiptPath, { version: 1, manifestPath, binary, sha256 });
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

const registryTool = () => join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");

/** Reads a key's default REG_SZ value. The "(Default)" label is localized; REG_SZ is not. */
async function readRegistryDefault(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(registryTool(), ["query", key, "/ve"], { windowsHide: true });
    return /\sREG_SZ\s{4}(.+?)\s*$/m.exec(stdout)?.[1];
  } catch (error) {
    // reg.exe exits 1 when the key or value does not exist.
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}

/** HKCU registration only: one user's Chrome, never a machine-wide key. */
export function windowsChromeHostRegistry(nativeHostName: string): ChromeHostRegistry {
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${nativeHostName}`;
  return {
    read: () => readRegistryDefault(key),
    async write(manifestPath) { await run(registryTool(), ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { windowsHide: true }); },
  };
}

/** Google Chrome's executable from its per-user, then machine-wide, App Paths registration. */
export async function windowsChromeExecutable(): Promise<string | undefined> {
  for (const hive of ["HKCU", "HKLM"]) {
    const path = await readRegistryDefault(`${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`).catch(() => undefined);
    const executable = path?.replace(/^"|"$/g, "");
    if (executable && /\\chrome\.exe$/i.test(executable) && await stat(executable).then(info => info.isFile(), () => false)) return executable;
  }
  return undefined;
}
