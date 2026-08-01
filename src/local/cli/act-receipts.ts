import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { WORKSPACE_CLI_REQUEST_MAX_AGE_MS, workspaceCliBrokerPaths } from "./broker.js";
import { WorkspaceCliError, type WorkspaceCliErrorCode } from "./protocol.js";

export const WORKSPACE_CLI_ACT_RECEIPTS_MAX_BYTES = 1024 * 1024;

/**
 * Durable, append-only journal of act-lane commands. Every authorized command
 * writes an `accepted` line BEFORE its mutation runs — the executor refuses to
 * run anything it could not journal — and a terminal `ok`/`error` line after,
 * so a crash can interrupt the pair but can never leave an applied action
 * without a trace. `accepted` lines are also the at-most-once ledger: a
 * request id that already has one is refused instead of re-executed, which is
 * what makes a replayed mutation safe even after the broker's response file
 * has been cleaned up. Terminal appends stay best-effort (an applied mutation
 * must not be failed retroactively); the executor surfaces a warning when one
 * cannot be written.
 */
export interface WorkspaceCliActReceiptV1 {
  v: 1;
  at: string;
  requestId: string;
  command: string;
  spaceId?: string;
  conversationId?: string;
  outcome: "accepted" | "ok" | "error" | "rejected";
  errorCode?: WorkspaceCliErrorCode;
  checkpointId?: string;
  taskId?: string;
  detail?: string;
}

export interface WorkspaceCliActReceiptsOptions {
  stateRoot: string;
  maxBytes?: number;
  now?: () => Date;
}

export class WorkspaceCliActReceipts {
  readonly path: string;
  readonly rotatedPath: string;
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceCliActReceiptsOptions) {
    this.#directory = join(workspaceCliBrokerPaths(options.stateRoot).root, "receipts");
    this.path = join(this.#directory, "act.jsonl");
    this.rotatedPath = join(this.#directory, "act.1.jsonl");
    this.#maxBytes = options.maxBytes ?? WORKSPACE_CLI_ACT_RECEIPTS_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** Serialized best-effort append; resolves false when the receipt could not be written. */
  append(entry: Omit<WorkspaceCliActReceiptV1, "v" | "at">): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      try {
        const record: WorkspaceCliActReceiptV1 = {
          v: 1,
          at: this.#now().toISOString(),
          ...entry,
          command: scrubText(entry.command),
          ...(entry.detail !== undefined ? { detail: scrubText(entry.detail) } : {}),
        };
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await this.#rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
        return true;
      } catch {
        return false;
      }
    });
    this.#queue = operation;
    return operation;
  }

  /** True when this request id already has an accepted record (live or rotated). */
  hasAccepted(requestId: string): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      for (const path of [this.path, this.rotatedPath]) {
        const text = await readFile(path, "utf8").catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new WorkspaceCliError("failure", "Workspace could not verify the act receipt journal.", { cause: error });
        });
        if (!text) continue;
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const record = JSON.parse(line) as Partial<WorkspaceCliActReceiptV1>;
            if (record.requestId === requestId && record.outcome === "accepted") return true;
          } catch (error) {
            // A damaged ledger cannot safely prove that this request id was
            // never accepted, so fail closed instead of risking a replay.
            throw new WorkspaceCliError("failure", "Workspace could not verify the act receipt journal.", { cause: error });
          }
        }
      }
      return false;
    });
    this.#queue = operation;
    return operation;
  }

  async #rotateIfNeeded(): Promise<void> {
    const info = await stat(this.path).catch(() => null);
    if (!info || info.size <= this.#maxBytes) return;
    // Accepted records are the at-most-once ledger, and the broker refuses
    // requests older than its freshness window, so the ledger only needs to
    // stay findable for that long. While the live file still holds an entry
    // younger than the window, rotating (which discards the previous rotated
    // file) could drop a gate-relevant accepted id — so rotation waits and
    // the file temporarily overgrows instead.
    const firstLine = await this.#firstLine();
    if (firstLine) {
      try {
        const at = Date.parse((JSON.parse(firstLine) as { at?: string }).at ?? "");
        if (Number.isFinite(at) && this.#now().getTime() - at < WORKSPACE_CLI_REQUEST_MAX_AGE_MS) return;
      } catch {
        // An unreadable first line never blocks rotation.
      }
    }
    await rm(this.rotatedPath, { force: true });
    await rename(this.path, this.rotatedPath);
  }

  async #firstLine(): Promise<string | null> {
    const text = await readFile(this.path, "utf8").catch(() => null);
    if (!text) return null;
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  }
}

function scrubText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "\uFFFD");
}
