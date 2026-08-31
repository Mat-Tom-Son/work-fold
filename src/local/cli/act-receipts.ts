import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { WORKFOLD_CLI_REQUEST_MAX_AGE_MS, workFoldCliBrokerPaths } from "./broker.js";
import { WorkFoldCliError, type WorkFoldCliErrorCode } from "./protocol.js";

export const WORKFOLD_CLI_ACT_RECEIPTS_MAX_BYTES = 1024 * 1024;

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
export interface WorkFoldCliActReceiptV1 {
  v: 1;
  at: string;
  requestId: string;
  command: string;
  spaceId?: string;
  conversationId?: string;
  outcome: "accepted" | "ok" | "error" | "rejected";
  errorCode?: WorkFoldCliErrorCode;
  checkpointId?: string;
  taskId?: string;
  /** Kernel task id of the management turn this act was performed for, when one was running. */
  parentTaskId?: string;
  detail?: string;
}

/**
 * Closed surface vocabulary shared between act receipts and consecration
 * decision records. `cli`, `popover`, and `remote_web` name the authenticated
 * surface that initiated an act; `main-window`, `policy`, and `unrestricted`
 * additionally appear on decision receipts. `remote_web` matches the
 * provenance spelling already durable in conversation logs.
 */
export const WORKFOLD_CLI_ACT_SURFACES = ["cli", "popover", "main-window", "remote_web", "policy", "unrestricted"] as const;

export type WorkFoldCliActSurface = (typeof WORKFOLD_CLI_ACT_SURFACES)[number];

/**
 * Typed pointer to the prior state an undo verb needs — identifiers, digests,
 * or short prior values (a title, a lifecycle state) only. Receipts never
 * grow file contents, message text, queries, or secrets.
 */
export interface WorkFoldCliActUndoRef {
  kind: string;
  value: string;
}

export interface WorkFoldCliActReceiptV2 extends Omit<WorkFoldCliActReceiptV1, "v"> {
  v: 2;
  surface?: WorkFoldCliActSurface;
  /** Links staging and execution receipts to the pending decision that authorized them. */
  decisionId?: string;
  /** Present exactly when a standing policy, not a click, satisfied a consecration. */
  policyId?: string;
  /** Approved remote browser identity, when the act arrived through remote access. */
  browserId?: string;
  grantId?: string;
  undoRef?: WorkFoldCliActUndoRef;
}

/** Journal lines are written at the current version; readers accept every version. */
export type WorkFoldCliActReceipt = WorkFoldCliActReceiptV1 | WorkFoldCliActReceiptV2;

export interface WorkFoldCliActReceiptsOptions {
  stateRoot: string;
  maxBytes?: number;
  now?: () => Date;
}

export class WorkFoldCliActReceipts {
  readonly path: string;
  readonly rotatedPath: string;
  readonly #directory: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkFoldCliActReceiptsOptions) {
    this.#directory = join(workFoldCliBrokerPaths(options.stateRoot).root, "receipts");
    this.path = join(this.#directory, "act.jsonl");
    this.rotatedPath = join(this.#directory, "act.1.jsonl");
    this.#maxBytes = options.maxBytes ?? WORKFOLD_CLI_ACT_RECEIPTS_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
  }

  /** Serialized best-effort append; resolves false when the receipt could not be written. */
  append(entry: Omit<WorkFoldCliActReceiptV2, "v" | "at">): Promise<boolean> {
    const operation = this.#queue.catch(() => undefined).then(async () => {
      try {
        const record: WorkFoldCliActReceiptV2 = {
          v: 2,
          at: this.#now().toISOString(),
          ...entry,
          command: scrubText(entry.command),
          ...(entry.detail !== undefined ? { detail: scrubText(entry.detail) } : {}),
          ...(entry.undoRef !== undefined
            ? { undoRef: { kind: entry.undoRef.kind, value: scrubText(entry.undoRef.value) } }
            : {}),
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
          throw new WorkFoldCliError("failure", "work-fold could not verify the act receipt journal.", { cause: error });
        });
        if (!text) continue;
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const record = JSON.parse(line) as Partial<WorkFoldCliActReceipt>;
            if (record.requestId === requestId && record.outcome === "accepted") return true;
          } catch (error) {
            // A damaged ledger cannot safely prove that this request id was
            // never accepted, so fail closed instead of risking a replay.
            throw new WorkFoldCliError("failure", "work-fold could not verify the act receipt journal.", { cause: error });
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
        if (Number.isFinite(at) && this.#now().getTime() - at < WORKFOLD_CLI_REQUEST_MAX_AGE_MS) return;
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
