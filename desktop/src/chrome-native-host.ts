import { execFile } from "node:child_process";
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
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const run = promisify(execFile);

/** Register only this app's exact Store origin, never inspect or edit a Chrome profile. */
export class ChromeNativeHostRegistration {
  constructor(private readonly options: Options) {}
  async register(explicit: boolean): Promise<void> {
    const { distribution } = this.options;
    if (!this.options.enabled) throw new Error("Chrome Store setup is available in the installed work-fold app.");
    if (!distribution.storeId || !/^[a-p]{32}$/.test(distribution.storeId) || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(distribution.nativeHostName)) throw new Error("The Chrome Store connection identity is not available.");
    const origin = `chrome-extension://${distribution.storeId}/`;
    const source = await realpath(join(this.options.sourceDirectory, "work-fold-chrome-host"));
    const provenance = JSON.parse(await readFile(join(this.options.sourceDirectory, "source.json"), "utf8"));
    if (provenance.schema !== "work-fold.chrome-native-host-source.v1" || provenance.origin !== origin || provenance.nativeHostName !== distribution.nativeHostName || provenance.bootstrapVersion !== distribution.bootstrapVersion) throw new Error("The signed Chrome bootstrap does not match this app's Store identity.");
    if (this.options.verifySignature !== false) await run("/usr/bin/codesign", ["--verify", "--strict", source]);
    const bytes = await readFile(source), sha256 = digest(bytes);
    const root = resolve(this.options.stateRoot, "chrome", "native-host");
    await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const binary = join(root, `work-fold-chrome-host-${sha256.slice(0, 24)}`);
    const manifestPath = join(this.options.chromeUserDataRoot ?? join(homedir(), "Library/Application Support/Google/Chrome"), "NativeMessagingHosts", `${distribution.nativeHostName}.json`);
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
        if (this.options.verifySignature !== false) await run("/usr/bin/codesign", ["--verify", "--strict", temporary]);
        await rename(temporary, binary);
      } finally { await rm(temporary, { force: true }); }
    }
    if (!(await stat(binary)).isFile()) throw new Error("Chrome bootstrap is not an ordinary executable.");
    await mkdir(dirname(manifestPath), { recursive: true });
    await atomicJson(manifestPath, manifest);
    await atomicJson(receiptPath, { version: 1, manifestPath, binary, sha256 });
  }
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
