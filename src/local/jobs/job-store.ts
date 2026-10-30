/**
 * The durable background job journal (docs/background-jobs.md, F31).
 *
 * Layout under `rootPath` (`jobs/` beneath the state root in production):
 *
 *   jobs.jsonl              append-only, whole-record, latest-wins by jobId
 *   jobs.1.jsonl            the generation a compaction replaced
 *   <jobId>/output.log      combined stdout and stderr, newest segment
 *   <jobId>/output.1.log    the segment before it
 *
 * Invariants, the same ones the request store keeps:
 *
 * - A record is appended before the process it describes is spawned, so a
 *   crash can never leave a running command with no record.
 * - Records are never replayed. `reconcile` settles what a previous run left
 *   `accepted` or `running` as `interrupted`; this store cannot start a process.
 * - A terminal record never moves again except to record its History
 *   coverage, its settle time, and its one delivery.
 * - A damaged middle line is skipped and counted, never thrown on.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { workFoldRequestLimits } from "../../shared/work-fold-limits.js";
import { syncDirectory } from "../agent/turn-store.js";
import {
  isWorkFoldJobTerminalState,
  parseWorkFoldJobRecord,
  workFoldJobIdPattern,
  type WorkFoldJobRecord,
} from "./job-records.js";

const defaultCompactBytes = 8 * 1024 * 1024;

export interface WorkFoldJobStoreOptions {
  rootPath: string;
  now?: () => Date;
  compactBytes?: number;
  retentionDays?: number;
}

export class WorkFoldJobStore {
  readonly rootPath: string;
  readonly journalPath: string;
  readonly #now: () => Date;
  readonly #compactBytes: number;
  readonly #retentionDays: number;
  readonly #records = new Map<string, WorkFoldJobRecord>();
  #damaged = 0;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(rootPath: string, options: WorkFoldJobStoreOptions) {
    this.rootPath = rootPath;
    this.journalPath = join(rootPath, "jobs.jsonl");
    this.#now = options.now ?? (() => new Date());
    this.#compactBytes = options.compactBytes ?? defaultCompactBytes;
    this.#retentionDays = options.retentionDays ?? workFoldRequestLimits.retentionDays;
  }

  static async open(options: WorkFoldJobStoreOptions): Promise<WorkFoldJobStore> {
    const rootPath = resolve(options.rootPath);
    await mkdir(rootPath, { recursive: true, mode: 0o700 });
    const store = new WorkFoldJobStore(rootPath, options);
    await store.#load();
    return store;
  }

  /** A fresh id in the request id style: `job-<yyyymmddhhmmss>-<8 hex>`. */
  newJobId(): string {
    return `job-${this.#now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  }

  outputDirectory(jobId: string): string {
    if (!workFoldJobIdPattern.test(jobId)) throw new Error("That background job id is invalid.");
    return join(this.rootPath, jobId);
  }

  damagedRecordCount(): number {
    return this.#damaged;
  }

  get(jobId: string): WorkFoldJobRecord | null {
    const record = this.#records.get(jobId);
    return record ? structuredClone(record) : null;
  }

  list(filter: {
    workFolderId?: string | null;
    conversationId?: string;
    requestId?: string;
    taskId?: string;
    running?: boolean;
  } = {}): WorkFoldJobRecord[] {
    return [...this.#records.values()]
      .filter((record) => filter.workFolderId === undefined
        || (filter.workFolderId === null ? record.workFolderId === undefined : record.workFolderId === filter.workFolderId))
      .filter((record) => filter.conversationId === undefined || record.conversationId === filter.conversationId)
      .filter((record) => filter.requestId === undefined || record.requestId === filter.requestId)
      .filter((record) => filter.taskId === undefined || record.taskId === filter.taskId)
      .filter((record) => filter.running === undefined || filter.running === !isWorkFoldJobTerminalState(record.state))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId))
      .map((record) => structuredClone(record));
  }

  /** Appends the first record. Refuses an id already on record. */
  create(record: WorkFoldJobRecord): Promise<WorkFoldJobRecord> {
    return this.#run(async () => {
      if (this.#records.has(record.jobId)) throw new Error("That background job is already on record.");
      return await this.#write(record);
    });
  }

  /** Whole-record update under the store's queue; `mutate` sees the current record. */
  update(jobId: string, mutate: (record: WorkFoldJobRecord) => WorkFoldJobRecord): Promise<WorkFoldJobRecord> {
    return this.#run(async () => {
      const current = this.#records.get(jobId);
      if (!current) throw new Error("That background job is not on record.");
      const next = mutate(structuredClone(current));
      if (next.jobId !== jobId) throw new Error("A background job cannot change its id.");
      return await this.#write(next);
    });
  }

  /**
   * Startup recovery: every job a previous run left `accepted` or `running`
   * becomes `interrupted`, keeping the process identity so the caller can
   * stop an orphan that is provably the same process. Nothing is re-run.
   */
  reconcile(reason: string): Promise<WorkFoldJobRecord[]> {
    return this.#run(async () => {
      const now = this.#now().toISOString();
      const settled: WorkFoldJobRecord[] = [];
      for (const record of [...this.#records.values()]) {
        if (isWorkFoldJobTerminalState(record.state)) continue;
        settled.push(await this.#write({
          ...record,
          state: "interrupted",
          endedAt: record.endedAt ?? now,
          settledAt: now,
          error: reason,
          history: record.history ?? null,
        }));
      }
      // A job that ended but whose History or request settle a crash cut off
      // is settled as it stands: its end is recorded, its delivery is not owed.
      for (const record of [...this.#records.values()]) {
        if (!isWorkFoldJobTerminalState(record.state) || record.settledAt !== null) continue;
        settled.push(await this.#write({
          ...record,
          settledAt: now,
          history: record.history?.status === "pending" ? { status: "unavailable", reason: "work-fold closed before it could save a checkpoint." } : record.history,
        }));
      }
      return settled.map((record) => structuredClone(record));
    });
  }

  /**
   * Retention: a settled job and its output leave once the request retention
   * window has passed since it settled. A running job is never removed.
   */
  purgeExpired(now?: Date): Promise<{ purged: number }> {
    return this.#run(async () => {
      const at = (now ?? this.#now()).getTime();
      const cutoff = at - this.#retentionDays * 24 * 60 * 60 * 1000;
      const doomed = [...this.#records.values()].filter((record) =>
        isWorkFoldJobTerminalState(record.state) && record.settledAt !== null && Date.parse(record.settledAt) <= cutoff);
      for (const record of doomed) {
        await rm(this.outputDirectory(record.jobId), { recursive: true, force: true }).catch(() => undefined);
        this.#records.delete(record.jobId);
      }
      if (doomed.length) await this.#compact(true);
      return { purged: doomed.length };
    });
  }

  flush(): Promise<void> {
    return this.#queue.then(() => undefined, () => undefined);
  }

  // --- internals -------------------------------------------------------------

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #write(record: WorkFoldJobRecord): Promise<WorkFoldJobRecord> {
    const next = parseWorkFoldJobRecord({ ...record, updatedAt: this.#now().toISOString() });
    await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    await appendFile(this.journalPath, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    this.#records.set(next.jobId, next);
    await this.#compact(false);
    return structuredClone(next);
  }

  async #load(): Promise<void> {
    for (const line of await this.#readJournal(this.journalPath)) {
      try {
        const record = parseWorkFoldJobRecord(JSON.parse(line));
        this.#records.set(record.jobId, record);
      } catch {
        this.#damaged += 1;
      }
    }
  }

  async #readJournal(path: string, countDamaged = true): Promise<string[]> {
    let text = await readFile(path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (text === null) {
      text = await readFile(rotatedPath(path), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
    }
    const lines = text.split("\n");
    const usable: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch {
        // Only a torn final line is an interrupted append; checking that
        // here, not for every line, keeps loading linear in the journal.
        if (lines.slice(index + 1).every((candidate) => !candidate.trim())) break;
        if (countDamaged) this.#damaged += 1;
        continue;
      }
      usable.push(line);
    }
    return usable;
  }

  /** Temp file, rotate the live generation aside, rename into place, fsync the directory. */
  async #compact(force: boolean): Promise<void> {
    if (!force) {
      const info = await stat(this.journalPath).catch(() => null);
      if (!info || info.size <= this.#compactBytes) return;
    }
    const records = [...this.#records.values()]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.jobId.localeCompare(right.jobId));
    const tempPath = `${this.journalPath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
    await rename(this.journalPath, rotatedPath(this.journalPath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rename(tempPath, this.journalPath);
    if (force) await rm(rotatedPath(this.journalPath), { force: true }).catch(() => undefined);
    await syncDirectory(dirname(this.journalPath));
  }
}

function rotatedPath(path: string): string {
  return path.replace(/\.jsonl$/, ".1.jsonl");
}
