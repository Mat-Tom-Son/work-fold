import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const workFoldTurnRecordSchema = "work-fold.turn.v1" as const;
export const maxDurableTurnRecords = 1_000;
export const maxDurableTurnTextChars = 2_000_000;
const turnJournalCompactBytes = 16 * 1024 * 1024;

export type WorkFoldDurableTurnStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";

export interface WorkFoldDurableTurnRecord {
  schema: typeof workFoldTurnRecordSchema;
  turnId: string;
  requestId: string;
  requestDigest: string;
  userMessageId: string;
  userMessageCreatedAt: string;
  spaceId: string;
  conversationId: string;
  actorKind: "assistant" | "cli" | "renderer" | "system";
  status: WorkFoldDurableTurnStatus;
  userMessagePersisted: boolean;
  acceptedAt: string;
  updatedAt: string;
  assistantText: string;
  messageId?: string;
  error?: string;
}

export interface WorkFoldTurnStoreOptions {
  stateRoot: string;
  now?: () => Date;
  maxRecords?: number;
  compactBytes?: number;
}

/**
 * Machine-local, append-only Assistant-turn journal. The portable transcript
 * remains the content authority; this store owns request deduplication, live
 * checkpoints, task-scoped outcomes, and honest restart recovery.
 */
export class WorkFoldTurnStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maxRecords: number;
  readonly #compactBytes: number;
  readonly #records = new Map<string, WorkFoldDurableTurnRecord>();
  readonly #requests = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: WorkFoldTurnStoreOptions) {
    this.path = join(options.stateRoot, "turns", "turns.jsonl");
    this.#now = options.now ?? (() => new Date());
    this.#maxRecords = options.maxRecords ?? maxDurableTurnRecords;
    this.#compactBytes = options.compactBytes ?? turnJournalCompactBytes;
  }

  static async create(options: WorkFoldTurnStoreOptions): Promise<WorkFoldTurnStore> {
    const store = new WorkFoldTurnStore(options);
    await store.#load();
    return store;
  }

  get(turnId: string): WorkFoldDurableTurnRecord | null {
    const record = this.#records.get(turnId);
    return record ? copyRecord(record) : null;
  }

  findRequest(spaceId: string, conversationId: string, requestId: string): WorkFoldDurableTurnRecord | null {
    const turnId = this.#requests.get(requestKey(spaceId, conversationId, requestId));
    return turnId ? this.get(turnId) : null;
  }

  findScopeRequest(spaceId: string, requestId: string): WorkFoldDurableTurnRecord | null {
    for (const record of [...this.#records.values()].reverse()) {
      if (record.spaceId === spaceId && record.requestId === requestId) return copyRecord(record);
    }
    return null;
  }

  list(): WorkFoldDurableTurnRecord[] {
    return [...this.#records.values()].map(copyRecord);
  }

  active(): WorkFoldDurableTurnRecord[] {
    return this.list().filter((record) => record.status === "accepted" || record.status === "running");
  }

  async accept(input: {
    turnId?: string;
    requestId: string;
    requestDigest: string;
    userMessageId: string;
    userMessageCreatedAt: string;
    spaceId: string;
    conversationId: string;
    actorKind: WorkFoldDurableTurnRecord["actorKind"];
  }): Promise<{ record: WorkFoldDurableTurnRecord; replayed: boolean }> {
    return this.#run(async () => {
      validateStableId(input.requestId, "request id");
      validateStableId(input.userMessageId, "user message id");
      validateStableId(input.spaceId, "Space id");
      validateStableId(input.conversationId, "conversation id");
      if (!/^[a-f0-9]{64}$/.test(input.requestDigest)) throw new Error("Turn request digest is invalid.");
      const existingId = this.#requests.get(requestKey(input.spaceId, input.conversationId, input.requestId));
      if (existingId) {
        const existing = this.#records.get(existingId)!;
        if (existing.requestDigest !== input.requestDigest) {
          throw new WorkFoldTurnReplayConflictError("This turn request id was already used for different input.");
        }
        return { record: copyRecord(existing), replayed: true };
      }
      const at = this.#now().toISOString();
      const record: WorkFoldDurableTurnRecord = {
        schema: workFoldTurnRecordSchema,
        turnId: input.turnId?.trim() || `turn-${randomUUID()}`,
        requestId: input.requestId,
        requestDigest: input.requestDigest,
        userMessageId: input.userMessageId,
        userMessageCreatedAt: input.userMessageCreatedAt,
        spaceId: input.spaceId,
        conversationId: input.conversationId,
        actorKind: input.actorKind,
        status: "accepted",
        userMessagePersisted: false,
        acceptedAt: at,
        updatedAt: at,
        assistantText: "",
      };
      validateStableId(record.turnId, "turn id");
      await this.#append(record);
      this.#remember(record);
      await this.#compactIfNeeded(false);
      return { record: copyRecord(record), replayed: false };
    });
  }

  markRunning(turnId: string): Promise<WorkFoldDurableTurnRecord | null> {
    return this.#update(turnId, (record) => ({ ...record, status: "running", userMessagePersisted: true }));
  }

  /**
   * Reopens a reservation only when its user message never reached the
   * transcript. This is safe on an explicit retry because the Agent cannot
   * start until after that append succeeds.
   */
  resumeUnpersisted(turnId: string): Promise<WorkFoldDurableTurnRecord | null> {
    return this.#update(turnId, (record) => {
      if (record.userMessagePersisted) return record;
      const { error: _error, messageId: _messageId, ...rest } = record;
      return { ...rest, status: "accepted" };
    }, { unpersistedOnly: true });
  }

  checkpoint(turnId: string, assistantText: string): Promise<WorkFoldDurableTurnRecord | null> {
    return this.#update(turnId, (record) => ({
      ...record,
      assistantText: assistantText.slice(0, maxDurableTurnTextChars),
    }), { activeOnly: true, skipUnchangedText: true });
  }

  settle(
    turnId: string,
    input: { status: Exclude<WorkFoldDurableTurnStatus, "accepted" | "running">; messageId?: string; error?: string; assistantText?: string },
  ): Promise<WorkFoldDurableTurnRecord | null> {
    return this.#update(turnId, (record) => ({
      ...record,
      status: input.status,
      userMessagePersisted: record.userMessagePersisted,
      assistantText: (input.assistantText ?? record.assistantText).slice(0, maxDurableTurnTextChars),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.error ? { error: input.error.slice(0, 2_048) } : {}),
    }));
  }

  flush(): Promise<void> {
    return this.#queue.then(() => undefined);
  }

  async #update(
    turnId: string,
    mutate: (record: WorkFoldDurableTurnRecord) => WorkFoldDurableTurnRecord,
    options: { activeOnly?: boolean; unpersistedOnly?: boolean; skipUnchangedText?: boolean } = {},
  ): Promise<WorkFoldDurableTurnRecord | null> {
    return this.#run(async () => {
      const current = this.#records.get(turnId);
      if (!current) return null;
      if (options.activeOnly && current.status !== "accepted" && current.status !== "running") return copyRecord(current);
      if (options.unpersistedOnly && current.userMessagePersisted) return copyRecord(current);
      const next = { ...mutate(current), updatedAt: this.#now().toISOString() };
      if (options.skipUnchangedText && next.assistantText === current.assistantText) return copyRecord(current);
      await this.#append(next);
      this.#remember(next);
      await this.#compactIfNeeded(false);
      return copyRecord(next);
    });
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result;
    return result;
  }

  async #load(): Promise<void> {
    const text = await readFile(this.path, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      try {
        this.#remember(parseRecord(JSON.parse(line)));
      } catch (error) {
        const isLastNonEmpty = lines.slice(index + 1).every((candidate) => !candidate.trim());
        if (isLastNonEmpty) break;
        throw new Error("work-fold could not read the durable turn journal.", { cause: error });
      }
    }
    this.#trimMemory();
    await this.#compactIfNeeded(true);
  }

  async #append(record: WorkFoldDurableTurnRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
  }

  async #compactIfNeeded(forceRepair: boolean): Promise<void> {
    const info = await stat(this.path).catch(() => null);
    if (!info || (!forceRepair && info.size <= this.#compactBytes)) return;
    this.#trimMemory();
    const records = [...this.#records.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const tempPath = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(tempPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
    await rename(tempPath, this.path);
    await syncDirectory(dirname(this.path));
  }

  #remember(record: WorkFoldDurableTurnRecord): void {
    this.#records.set(record.turnId, copyRecord(record));
    this.#requests.set(requestKey(record.spaceId, record.conversationId, record.requestId), record.turnId);
  }

  #trimMemory(): void {
    if (this.#records.size <= this.#maxRecords) return;
    const records = [...this.#records.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const record of records.slice(0, Math.max(0, records.length - this.#maxRecords))) {
      this.#records.delete(record.turnId);
      this.#requests.delete(requestKey(record.spaceId, record.conversationId, record.requestId));
    }
  }
}

export class WorkFoldTurnReplayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkFoldTurnReplayConflictError";
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

export function directorySyncUnsupported(error: unknown, platform = process.platform): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code ?? "";
  if (["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(code)) return true;
  return platform === "win32" && ["EPERM", "EACCES"].includes(code);
}

function parseRecord(value: unknown): WorkFoldDurableTurnRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn record must be an object.");
  const record = value as Partial<WorkFoldDurableTurnRecord>;
  if (record.schema !== workFoldTurnRecordSchema) throw new Error("Turn record schema is unsupported.");
  for (const [label, candidate] of [
    ["turn id", record.turnId], ["request id", record.requestId], ["user message id", record.userMessageId],
    ["Space id", record.spaceId], ["conversation id", record.conversationId],
  ] as const) validateStableId(candidate, label);
  if (typeof record.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.requestDigest)) throw new Error("Turn request digest is invalid.");
  if (typeof record.userMessageCreatedAt !== "string" || !Number.isFinite(Date.parse(record.userMessageCreatedAt))) throw new Error("Turn message time is invalid.");
  if (record.actorKind !== "assistant" && record.actorKind !== "cli" && record.actorKind !== "renderer" && record.actorKind !== "system") throw new Error("Turn actor is invalid.");
  if (!isStatus(record.status)) throw new Error("Turn status is invalid.");
  if (typeof record.userMessagePersisted !== "boolean") throw new Error("Turn persistence state is invalid.");
  if (typeof record.acceptedAt !== "string" || !Number.isFinite(Date.parse(record.acceptedAt))) throw new Error("Turn acceptance time is invalid.");
  if (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error("Turn update time is invalid.");
  if (typeof record.assistantText !== "string" || record.assistantText.length > maxDurableTurnTextChars) throw new Error("Turn checkpoint is invalid.");
  if (record.messageId !== undefined) validateStableId(record.messageId, "response message id");
  if (record.error !== undefined && (typeof record.error !== "string" || record.error.length > 2_048)) throw new Error("Turn error is invalid.");
  return record as WorkFoldDurableTurnRecord;
}

function validateStableId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`Turn ${label} is invalid.`);
  }
}

function isStatus(value: unknown): value is WorkFoldDurableTurnStatus {
  return value === "accepted" || value === "running" || value === "succeeded" || value === "failed" || value === "aborted" || value === "interrupted";
}

function requestKey(spaceId: string, conversationId: string, requestId: string): string {
  return `${spaceId}\u0000${conversationId}\u0000${requestId}`;
}

function copyRecord(record: WorkFoldDurableTurnRecord): WorkFoldDurableTurnRecord {
  return { ...record };
}
