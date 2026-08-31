import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { workFoldStateRoot } from "./state-paths.js";

export const FOLD_AUTHORITY_SCHEMA_VERSION = 1;
export const FOLD_AUTHORITY_CHANGE_JOURNAL_MAX_BYTES = 256 * 1024;

export const FOLD_AUTHORITY_MODES = ["reviewed", "unrestricted"] as const;
export type FoldAuthorityMode = (typeof FOLD_AUTHORITY_MODES)[number];

export interface FoldAuthorityStatus {
  mode: FoldAuthorityMode;
  revision: number;
  updatedAt: string | null;
  damaged: boolean;
  damageReason?: string;
}

interface FoldAuthorityFile {
  schemaVersion: typeof FOLD_AUTHORITY_SCHEMA_VERSION;
  mode: FoldAuthorityMode;
  revision: number;
  updatedAt: string;
  attestation: string;
}

export interface FoldAuthorityChangeRecordV1 {
  v: 1;
  at: string;
  from: FoldAuthorityMode;
  to: FoldAuthorityMode;
  revision: number;
  attestation: string;
}

export interface FoldAuthorityStoreOptions {
  path?: string;
  journalPath?: string;
  now?: () => Date;
  maxJournalBytes?: number;
}

export type FoldAuthorityErrorCode =
  | "STORE_DAMAGED"
  | "SETTINGS_ONLY"
  | "INPUT_INVALID"
  | "JOURNAL_UNAVAILABLE";

export class FoldAuthorityError extends Error {
  readonly code: FoldAuthorityErrorCode;

  constructor(code: FoldAuthorityErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FoldAuthorityError";
    this.code = code;
  }
}

/**
 * Root-authority changes are local Settings acts. The marker is intentionally
 * separate from the act facade and remote facade: assistants and approved
 * browsers inherit the selected mode but cannot select it.
 */
export interface FoldAuthoritySettingsWriter {
  readonly lane: "desktop-settings";
  readonly authority: "fold-root";
}

const SETTINGS_WRITERS = new WeakSet<FoldAuthoritySettingsWriter>();

export function mintFoldAuthoritySettingsWriter(): FoldAuthoritySettingsWriter {
  const writer: FoldAuthoritySettingsWriter = Object.freeze({
    lane: "desktop-settings",
    authority: "fold-root",
  });
  SETTINGS_WRITERS.add(writer);
  return writer;
}

export function foldAuthorityFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "authority.json");
}

export function foldAuthorityChangesFile(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "fold", "authority-changes.jsonl");
}

/**
 * Machine-local root-authority state. Missing state means Reviewed. A damaged
 * or live-tampered file also reads as Reviewed and cannot be overwritten by
 * the app, so corruption can never silently widen authority.
 *
 * `runIfUnrestricted` holds the same serialized lane used by Settings writes
 * for the complete automatic decision. Turning the mode off therefore waits
 * for an already-admitted decision to settle, and no later decision can slip
 * through on a stale mode read.
 */
export class FoldAuthorityStore {
  readonly path: string;
  readonly journalPath: string;
  readonly rotatedJournalPath: string;
  readonly #now: () => Date;
  readonly #maxJournalBytes: number;
  #file: FoldAuthorityFile | null = null;
  #damagedReason: string | null = null;
  #blessedBytes: string | null = null;
  #initialized = false;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: Required<Pick<FoldAuthorityStoreOptions, "now" | "maxJournalBytes">> & {
    path: string;
    journalPath: string;
  }) {
    this.path = options.path;
    this.journalPath = options.journalPath;
    this.rotatedJournalPath = rotatedSibling(options.journalPath);
    this.#now = options.now;
    this.#maxJournalBytes = options.maxJournalBytes;
  }

  static async create(options: FoldAuthorityStoreOptions = {}): Promise<FoldAuthorityStore> {
    const store = new FoldAuthorityStore({
      path: resolve(options.path ?? foldAuthorityFile()),
      journalPath: resolve(options.journalPath ?? foldAuthorityChangesFile()),
      now: options.now ?? (() => new Date()),
      maxJournalBytes: options.maxJournalBytes ?? FOLD_AUTHORITY_CHANGE_JOURNAL_MAX_BYTES,
    });
    await store.#run(async () => { await store.#sync(true); });
    return store;
  }

  /** Re-checks durable state before answering; damaged state fails to Reviewed. */
  async status(): Promise<FoldAuthorityStatus> {
    return await this.#run(async () => {
      await this.#sync(false);
      return this.#status();
    });
  }

  async setMode(writer: FoldAuthoritySettingsWriter, mode: FoldAuthorityMode): Promise<FoldAuthorityStatus> {
    return await this.#run(async () => {
      this.#assertWriter(writer);
      if (!FOLD_AUTHORITY_MODES.includes(mode)) {
        throw new FoldAuthorityError("INPUT_INVALID", "Choose Reviewed or Unrestricted authority.");
      }
      await this.#sync(false);
      this.#assertOperational();
      const previous = this.#file?.mode ?? "reviewed";
      if (previous === mode) return this.#status();
      const next: FoldAuthorityFile = {
        schemaVersion: FOLD_AUTHORITY_SCHEMA_VERSION,
        mode,
        revision: (this.#file?.revision ?? 0) + 1,
        updatedAt: this.#now().toISOString(),
        attestation: "",
      };
      next.attestation = authorityAttestation(next);
      await this.#appendChange({
        v: 1,
        at: next.updatedAt,
        from: previous,
        to: mode,
        revision: next.revision,
        attestation: next.attestation,
      });
      await this.#write(next);
      return this.#status();
    });
  }

  /**
   * Executes only while the effective mode is Unrestricted, holding the mode
   * serialization lane until the operation settles. `matched: false` is the
   * normal Reviewed/damaged result and performs no work.
   */
  async runIfUnrestricted<T>(operation: (status: FoldAuthorityStatus) => Promise<T>): Promise<
    | { matched: false; status: FoldAuthorityStatus }
    | { matched: true; status: FoldAuthorityStatus; value: T }
  > {
    return await this.#run(async () => {
      await this.#sync(false);
      const status = this.#status();
      if (status.mode !== "unrestricted" || status.damaged) return { matched: false, status } as const;
      return { matched: true, status, value: await operation(status) } as const;
    });
  }

  #status(): FoldAuthorityStatus {
    if (this.#damagedReason !== null) {
      return {
        mode: "reviewed",
        revision: this.#file?.revision ?? 0,
        updatedAt: this.#file?.updatedAt ?? null,
        damaged: true,
        damageReason: this.#damagedReason,
      };
    }
    return {
      mode: this.#file?.mode ?? "reviewed",
      revision: this.#file?.revision ?? 0,
      updatedAt: this.#file?.updatedAt ?? null,
      damaged: false,
    };
  }

  async #sync(atOpen: boolean): Promise<void> {
    const bytes = await readFile(this.path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (bytes === null) {
      if (this.#initialized && this.#blessedBytes !== null) {
        this.#damagedReason = "The authority file disappeared while work-fold was running.";
      }
      this.#initialized = true;
      return;
    }
    const parsed = parseAuthorityFile(bytes);
    if (typeof parsed === "string") {
      this.#damagedReason = parsed;
      return;
    }
    if (this.#initialized && this.#blessedBytes === null) {
      this.#damagedReason = "The authority file appeared outside Settings while work-fold was running.";
      return;
    }
    if (!atOpen && this.#blessedBytes !== null && bytes !== this.#blessedBytes) {
      this.#damagedReason = "The authority file changed outside Settings while work-fold was running.";
      return;
    }
    this.#file = parsed;
    this.#blessedBytes = bytes;
    this.#damagedReason = null;
    this.#initialized = true;
  }

  async #write(file: FoldAuthorityFile): Promise<void> {
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, bytes, { mode: 0o600, flush: true });
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#file = structuredClone(file);
    this.#blessedBytes = bytes;
    this.#damagedReason = null;
    this.#initialized = true;
  }

  async #appendChange(record: FoldAuthorityChangeRecordV1): Promise<void> {
    try {
      await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 });
      const info = await stat(this.journalPath).catch(() => null);
      if (info && info.size > this.#maxJournalBytes) {
        await rm(this.rotatedJournalPath, { force: true });
        await rename(this.journalPath, this.rotatedJournalPath);
      }
      await appendFile(this.journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flush: true });
    } catch (error) {
      throw new FoldAuthorityError(
        "JOURNAL_UNAVAILABLE",
        "work-fold could not journal the authority change, so the mode was not changed.",
        { cause: error },
      );
    }
  }

  #assertWriter(writer: FoldAuthoritySettingsWriter): void {
    if (!SETTINGS_WRITERS.has(writer)) {
      throw new FoldAuthorityError("SETTINGS_ONLY", "The fold's root authority can be changed only in desktop Settings.");
    }
  }

  #assertOperational(): void {
    if (this.#damagedReason !== null) {
      throw new FoldAuthorityError(
        "STORE_DAMAGED",
        `work-fold is using Reviewed authority because the authority store is damaged: ${this.#damagedReason}`,
      );
    }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.catch(() => undefined).then(operation);
    this.#queue = next;
    return next;
  }
}

function authorityAttestation(file: Omit<FoldAuthorityFile, "attestation"> | FoldAuthorityFile): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: file.schemaVersion,
      mode: file.mode,
      revision: file.revision,
      updatedAt: file.updatedAt,
    }))
    .digest("hex");
}

function parseAuthorityFile(bytes: string): FoldAuthorityFile | string {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    return "The authority file is not valid JSON.";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "The authority file must be an object.";
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["attestation", "mode", "revision", "schemaVersion", "updatedAt"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return "The authority file has unsupported fields.";
  if (record.schemaVersion !== FOLD_AUTHORITY_SCHEMA_VERSION) return "The authority file uses an unsupported schema version.";
  if (!FOLD_AUTHORITY_MODES.includes(record.mode as FoldAuthorityMode)) return "The authority mode is invalid.";
  if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) return "The authority revision is invalid.";
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) return "The authority timestamp is invalid.";
  if (typeof record.attestation !== "string" || !/^[a-f0-9]{64}$/.test(record.attestation)) return "The authority attestation is invalid.";
  const file = record as unknown as FoldAuthorityFile;
  if (authorityAttestation(file) !== file.attestation) return "The authority attestation does not match its contents.";
  return structuredClone(file);
}

function rotatedSibling(path: string): string {
  return path.endsWith(".jsonl") ? `${path.slice(0, -6)}.1.jsonl` : `${path}.1`;
}
