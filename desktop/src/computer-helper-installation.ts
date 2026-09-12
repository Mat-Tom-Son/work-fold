import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
interface Options { sourceAppPath: string; stateRoot: string; verifySignature?: boolean }

/** macOS attributes nested helper capture to the enclosing app. Keep the exact
 * signed helper outside it; constructing this configuration never copies or launches. */
export class ComputerHelperInstallation {
  readonly helperAppPath: string;
  #pending?: Promise<void>;
  private constructor(private readonly options: Options, private readonly digest: string) {
    this.helperAppPath = join(resolve(options.stateRoot), "native-helpers", "computer", digest, "work-fold Computer.app");
  }
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
    if (await bundleDigest(path) !== this.digest) throw new Error("The computer helper differs from the signed copy supplied by this work-fold build. Open Computer control in Skills & Extensions and choose Check setup to repair it.");
    if (this.options.verifySignature !== false) await run("/usr/bin/codesign", ["--verify", "--strict", path]);
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
    await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
    const temporary = join(root, `.copy-${randomUUID()}`);
    const copy = join(temporary, "work-fold Computer.app");
    await mkdir(temporary, { mode: 0o700 });
    try {
      // ditto preserves the sealed bundle, extended attributes and notarization data.
      await run("/usr/bin/ditto", [this.options.sourceAppPath, copy]);
      await this.#verify(copy);
      if (replace) {
        await beforeReplace!();
        const target = join(root, this.digest), previous = join(root, `.replaced-${randomUUID()}`);
        await rename(target, previous);
        try { await rename(temporary, target); }
        catch (error) { await rename(previous, target); throw error; }
        await rm(previous, { recursive: true, force: true });
        return;
      }
      try { await rename(temporary, join(root, this.digest)); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await this.#verify(this.helperAppPath);
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
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
