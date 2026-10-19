import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface ManagedWorktree {
  id: string;
  sourceWorkFolderId: string;
  source: string;
  path: string;
  commit: string;
  state: "creating" | "active" | "archiving" | "archived" | "failed";
  workFolderId?: string;
  error?: string;
}
/** Journaled working copies. Archive retains every byte and Git registration for recovery. */
export class ManagedWorktrees {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, readonly copiesRoot = `${root}-copies`) {}
  private async records(): Promise<ManagedWorktree[]> {
    const text = await readFile(join(this.root, "records.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    const records = new Map<string, ManagedWorktree>();
    for (const line of text.split("\n").filter(Boolean)) {
      let record: ManagedWorktree;
      try { record = JSON.parse(line); } catch { continue; }
      if (!/^worktree-[a-f0-9-]{36}$/.test(record.id) || resolve(record.path) !== resolve(this.copiesRoot, record.id)) continue;
      records.set(record.id, record);
    }
    return [...records.values()];
  }
  private async save(record: ManagedWorktree): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = await open(join(this.root, "records.jsonl"), "a", 0o600);
    try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); } finally { await file.close(); }
  }
  async list(sourceWorkFolderId: string): Promise<ManagedWorktree[]> { await this.queue; return (await this.records()).filter(record => record.sourceWorkFolderId === sourceWorkFolderId); }
  mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation); this.queue = run.catch(() => undefined); return run;
  }
  async create(sourceWorkFolderId: string, source: string, ref: string, register: (path: string) => Promise<string>): Promise<ManagedWorktree> {
    return this.mutate(async () => {
      const sourceReal = await realpath(source);
      const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: sourceReal })).stdout.trim();
      if (await realpath(top) !== sourceReal) throw new Error("Create a working copy from a work-folder whose folder is the Git repository root.");
      const commit = (await exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: sourceReal })).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Choose a committed Git revision.");
      const id = `worktree-${randomUUID()}`;
      let record: ManagedWorktree = { id, sourceWorkFolderId, source: sourceReal, path: join(this.copiesRoot, id), commit, state: "creating" };
      await this.save(record);
      try {
        await mkdir(this.copiesRoot, { recursive: true, mode: 0o700 });
        await exec("git", ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--no-checkout", "--", record.path, commit], { cwd: sourceReal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        // A committed portable identity/transcript belongs to the source,
        // not the new working context. Never materialize it in the copy.
        const sparsePath = resolve(record.path, (await exec("git", ["rev-parse", "--git-path", "info/sparse-checkout"], { cwd: record.path })).stdout.trim());
        await mkdir(dirname(sparsePath), { recursive: true });
        await writeFile(sparsePath, "/*\n!/.work-fold/\n", { mode: 0o600 });
        await exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false", "read-tree", "-mu", commit], { cwd: record.path, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
        record = { ...record, workFolderId: await register(record.path), state: "active" };
        await this.save(record);
        return record;
      } catch (error) {
        await this.save({ ...record, state: "failed", error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }
  async change(sourceWorkFolderId: string, id: string, action: "archive" | "restore", ports: { unregister(id: string, path: string): Promise<void>; register(path: string): Promise<string> }): Promise<ManagedWorktree> {
    return this.mutate(async () => {
      const record = (await this.records()).find(item => item.id === id && item.sourceWorkFolderId === sourceWorkFolderId);
      if (!record) throw new Error("That managed working copy does not belong to this work-folder.");
      // The Git marker must still name this managed copy; never adopt a substituted folder.
      const top = (await exec("git", ["rev-parse", "--show-toplevel"], { cwd: record.path })).stdout.trim();
      if (await realpath(top) !== await realpath(record.path) || dirname(resolve(record.path)) !== resolve(this.copiesRoot)) throw new Error("The working copy identity changed.");
      const common = async (cwd: string) => realpath(resolve(cwd, (await exec("git", ["rev-parse", "--git-common-dir"], { cwd })).stdout.trim()));
      if (await common(record.path) !== await common(record.source)) throw new Error("The working copy belongs to a different Git repository.");
      if (action === "archive") {
        if (record.state === "archived") return record;
        await this.save({ ...record, state: "archiving" });
        try { if (record.workFolderId) await ports.unregister(record.workFolderId, record.path); }
        catch (error) { await this.save(record); throw error; }
        const archived = { ...record, state: "archived" as const }; await this.save(archived); return archived;
      }
      const restored = { ...record, workFolderId: await ports.register(record.path), state: "active" as const };
      await this.save(restored); return restored;
    });
  }
}
