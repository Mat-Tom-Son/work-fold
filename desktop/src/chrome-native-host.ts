import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChromeDistribution } from "../../src/local/agent/included-chrome-connection.js";

interface Options {
  stateRoot: string;
  sourceDirectory: string;
  distribution: ChromeDistribution;
  /** Explicitly injected isolated browser root in tests; never supplied by a web page. */
  chromeUserDataRoot?: string;
  enabled: boolean;
  verifySignature?: boolean;
  platform?: NodeJS.Platform;
  appPath?: string;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

/** Installation evidence only; never reads a browser profile. */
export function googleChromeInstalled(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin") return ["/Applications/Google Chrome.app", join(homedir(), "Applications/Google Chrome.app")].some(path => existsSync(path));
  if (platform !== "linux") return false;
  return (env.PATH ?? "").split(":").filter(Boolean).some(directory => {
    try { accessSync(join(directory, "google-chrome"), constants.X_OK); return true; } catch { return false; }
  });
}

function chromeUserDataRoot(platform: NodeJS.Platform): string {
  return platform === "linux" ? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-chrome")
    : join(homedir(), "Library/Application Support/Google/Chrome");
}

/** Open the pinned Store listing in Google Chrome, never the default browser. */
export async function openChromeStore(storeId: string | null, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!storeId || !/^[a-p]{32}$/.test(storeId)) throw new Error("Chrome connection is not available yet.");
  const url = `https://chromewebstore.google.com/detail/${storeId}`;
  try {
    if (platform === "linux") {
      // A cold Chrome launch lives until the browser quits. Waiting for exit
      // holds connection setup's serialization lock and blocks its own native
      // bootstrap. Only wait for OS launch; authenticated polling owns readiness.
      await new Promise<void>((resolveLaunch, rejectLaunch) => {
        const browser = spawn("google-chrome", [url], { detached: true, stdio: "ignore" });
        browser.once("error", rejectLaunch);
        browser.once("spawn", () => { browser.unref(); resolveLaunch(); });
      });
    } else {
      await run("/usr/bin/open", ["-a", "Google Chrome", url]);
    }
  } catch { throw new Error("Google Chrome could not open the work-fold listing."); }
}

/** Register only this app's exact Store origin, never inspect or edit a Chrome profile. */
export class ChromeNativeHostRegistration {
  constructor(private readonly options: Options) {}
  /**
   * `explicit` claims Chrome's registration for this installation; a startup
   * refresh only renews one this installation already owns. `ifAbsent`
   * (2026-10-11) registers at launch only when Chrome is set up on this Mac and
   * no work-fold registration exists yet, so adding the extension first works;
   * it never replaces another installation's registration.
   */
  async register(explicit: boolean, ifAbsent = false): Promise<void> {
    const { distribution } = this.options;
    const platform = this.options.platform ?? process.platform;
    const verifySignature = platform === "darwin" && this.options.verifySignature !== false;
    if (!this.options.enabled) throw new Error("Chrome Store setup is available in the installed work-fold app.");
    if (ifAbsent && !explicit) {
      const chromeRoot = this.options.chromeUserDataRoot ?? chromeUserDataRoot(platform);
      if (!await stat(chromeRoot).then((info) => info.isDirectory(), () => false)) return;
      const existing = join(chromeRoot, "NativeMessagingHosts", `${distribution.nativeHostName}.json`);
      const present = await stat(existing).then(() => true, () => false);
      if (!present) return this.register(true);
      try { return await this.register(false); }
      catch { return; /* Another installation's registration stays as it is. */ }
    }
    if (!distribution.storeId || !/^[a-p]{32}$/.test(distribution.storeId) || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(distribution.nativeHostName)) throw new Error("The Chrome Store connection identity is not available.");
    const origin = `chrome-extension://${distribution.storeId}/`;
    const source = await realpath(join(this.options.sourceDirectory, "work-fold-chrome-host"));
    const provenance = JSON.parse(await readFile(join(this.options.sourceDirectory, "source.json"), "utf8"));
    if (provenance.schema !== "work-fold.chrome-native-host-source.v1" || provenance.origin !== origin || provenance.nativeHostName !== distribution.nativeHostName || provenance.bootstrapVersion !== distribution.bootstrapVersion) throw new Error("The signed Chrome bootstrap does not match this app's Store identity.");
    if (verifySignature) await run("/usr/bin/codesign", ["--verify", "--strict", source]);
    const bytes = await readFile(source), sha256 = digest(bytes);
    if (platform === "linux" && (provenance.target !== "x86_64-unknown-linux-gnu" || provenance.binarySha256 !== sha256)) throw new Error("The Linux Chrome bootstrap does not match its packaged provenance.");
    const root = resolve(this.options.stateRoot, "chrome", "native-host");
    await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const binary = join(root, `work-fold-chrome-host-${sha256.slice(0, 24)}`);
    const manifestPath = join(this.options.chromeUserDataRoot ?? (platform === "linux"
      ? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "google-chrome")
      : join(homedir(), "Library/Application Support/Google/Chrome")), "NativeMessagingHosts", `${distribution.nativeHostName}.json`);
    const receiptPath = join(root, "registration.json");
    const manifest = { name: distribution.nativeHostName, description: "Connect Chrome to work-fold", path: binary, type: "stdio", allowed_origins: [origin] };
    let current: { path?: string; allowed_origins?: string[]; name?: string; type?: string } | undefined;
    try { current = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !explicit) throw new Error("Chrome's existing work-fold registration could not be read. Connect Chrome again to repair it."); }
    if (!current && !explicit) throw new Error("Chrome's registration was removed. Connect Chrome again to restore it.");
    if (current && !explicit) {
      let receipt: { manifestPath?: string; binary?: string } | undefined;
      try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch { /* No owned receipt means no automatic replacement. */ }
      if (receipt?.manifestPath !== manifestPath || receipt.binary !== current.path || current.name !== distribution.nativeHostName || current.type !== "stdio" || JSON.stringify(current.allowed_origins) !== JSON.stringify([origin])) throw new Error("Another work-fold installation owns Chrome's registration. Connect Chrome explicitly to choose this installation.");
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
        if (verifySignature) await run("/usr/bin/codesign", ["--verify", "--strict", temporary]);
        await rename(temporary, binary);
      } finally { await rm(temporary, { force: true }); }
    }
    if (!(await stat(binary)).isFile()) throw new Error("Chrome bootstrap is not an ordinary executable.");
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicJson(manifestPath, manifest);
    await atomicJson(receiptPath, { version: 1, manifestPath, binary, sha256, ...(this.options.appPath ? { appPath: this.options.appPath } : {}) });
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
