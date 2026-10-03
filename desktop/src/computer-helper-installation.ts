import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensurePrivateDirectory } from "../../src/local/private-access.js";

const run = promisify(execFile);
interface Options { sourceAppPath: string; stateRoot: string; verifySignature?: boolean; platform?: NodeJS.Platform }

/** The helper bundle's directory name on each platform that ships one. */
export function computerHelperBundleName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "work-fold Computer" : "work-fold Computer.app";
}

/** The executable the host launches inside a helper bundle. */
export function computerHelperExecutable(bundlePath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(bundlePath, "work-fold Computer.exe") : join(bundlePath, "Contents", "MacOS", "bridge");
}

/** macOS attributes nested helper capture to the enclosing app, so the exact
 * signed helper lives outside it. Windows keeps the same private, versioned copy
 * so an update never replaces a running helper. Constructing this configuration
 * never copies or launches. */
export class ComputerHelperInstallation {
  readonly helperAppPath: string;
  #pending?: Promise<void>;
  private constructor(private readonly options: Options, private readonly digest: string) {
    this.helperAppPath = join(resolve(options.stateRoot), "native-helpers", "computer", digest, computerHelperBundleName(this.platform));
  }
  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  static async create(options: Options): Promise<ComputerHelperInstallation> {
    return new ComputerHelperInstallation(options, await bundleDigest(options.sourceAppPath));
  }
  prepare = (): Promise<void> => {
    if (!this.#pending) {
      const pending = this.#prepare(); this.#pending = pending;
      void pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; }).catch(() => {});
    }
    return this.#pending;
  };
  /** Only trusted setup calls this while the global capability fence is held. */
  repair = async (beforeReplace: () => Promise<void>): Promise<void> => {
    await this.#pending?.catch(() => {});
    const pending = this.#prepare(beforeReplace); this.#pending = pending;
    try { await pending; } finally { if (this.#pending === pending) this.#pending = undefined; }
  };
  async #verify(path: string) {
    if (await bundleDigest(path) !== this.digest) throw new Error("The computer helper differs from the copy supplied by this work-fold build. Open Computer control in Skills & Extensions and choose Check setup to repair it.");
    // Windows has no bundle seal; the digest pins the exact bytes this build shipped.
    if (this.platform === "darwin" && this.options.verifySignature !== false) await run("/usr/bin/codesign", ["--verify", "--strict", path]);
  }
  async #prepare(beforeReplace?: () => Promise<void>) {
    await this.#verify(this.options.sourceAppPath);
    let replace = false;
    try { await this.#verify(this.helperAppPath); return; }
    catch (error) {
      const exists = await lstat(this.helperAppPath).then(() => true, failure => {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw failure;
      });
      if (exists) { if (!beforeReplace) throw error; replace = true; }
      else if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const root = join(resolve(this.options.stateRoot), "native-helpers", "computer");
    await ensurePrivateDirectory(root);
    const temporary = join(root, `.copy-${randomUUID()}`);
    const copy = join(temporary, computerHelperBundleName(this.platform));
    await mkdir(temporary, { mode: 0o700 });
    try {
      // ditto preserves the sealed bundle, extended attributes and notarization data.
      if (this.platform === "darwin") await run("/usr/bin/ditto", [this.options.sourceAppPath, copy]);
      else await cp(this.options.sourceAppPath, copy, { recursive: true, errorOnExist: true, force: false });
      await this.#verify(copy);
      if (replace) {
        await beforeReplace!();
        const target = join(root, this.digest), previous = join(root, `.replaced-${randomUUID()}`);
        await renameFresh(target, previous, this.platform);
        try { await renameFresh(temporary, target, this.platform); }
        catch (error) { await renameFresh(previous, target, this.platform); throw error; }
        await rm(previous, { recursive: true, force: true });
        return;
      }
      try { await renameFresh(temporary, join(root, this.digest), this.platform); }
      catch (error) {
        // Windows refuses to rename onto an existing directory with EPERM.
        const lost = ["EEXIST", "ENOTEMPTY", ...(this.platform === "win32" ? ["EPERM"] : [])];
        if (!lost.includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await this.#verify(this.helperAppPath);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

/** A freshly written executable can be held briefly by Windows Defender or the
 * indexer. Retry only that transient refusal; an existing destination is never
 * transient, so a lost creation race still reaches the caller's verification. */
async function renameFresh(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (platform !== "win32" || attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (await lstat(to).then(() => true, () => false)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75 * (attempt + 1)));
    }
  }
}

async function bundleDigest(root: string): Promise<string> {
  const digest = createHash("sha256"); let entries = 0, bytes = 0;
  async function visit(relative: string) {
    const path = join(root, relative), info = await lstat(path);
    if (++entries > 128 || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("Unexpected computer helper bundle contents.");
    digest.update(`${info.isDirectory() ? "directory" : "file"}\0${relative}\0${info.mode & 0o777}\0`);
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(relative, name));
    else {
      bytes += info.size;
      if (bytes > 64 * 1024 * 1024) throw new Error("The computer helper bundle exceeds its expected size.");
      digest.update(await readFile(path)); digest.update("\0");
    }
  }
  await visit(""); return digest.digest("hex");
}
