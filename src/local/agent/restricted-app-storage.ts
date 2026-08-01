import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  parseDataNamespaceId,
  parseFeatureInstallationId,
  parseRuntimeInstanceId,
  parseTenantId,
  type DataNamespaceId,
  type FeatureInstallationId,
  type RuntimeInstanceId,
  type TenantId,
} from "./app-platform-contract.js";

export const restrictedAppStorageLimits = {
  appBytes: 5 * 1024 * 1024,
  keys: 512,
  keyBytes: 256,
  valueBytes: 128 * 1024,
  transactionBytes: 160 * 1024,
  transactionOperations: 128,
  jsonDepth: 32,
  fileBytes: 6 * 1024 * 1024,
} as const;

export type RestrictedAppStorageJsonValue =
  | null
  | boolean
  | number
  | string
  | RestrictedAppStorageJsonValue[]
  | { [key: string]: RestrictedAppStorageJsonValue };

export interface RestrictedAppStorageOwner {
  ownerClass: "instance";
  tenantId: TenantId;
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  dataNamespaceId: DataNamespaceId;
}

export interface RestrictedAppStorageSetOperation {
  key: string;
  value: RestrictedAppStorageJsonValue;
}

export interface RestrictedAppStorageTransaction {
  expectedRevision?: number;
  clear?: boolean;
  set?: RestrictedAppStorageSetOperation[];
  delete?: string[];
}

export type RestrictedAppStorageCommitAuthorizer = () => void | Promise<void>;

export interface RestrictedAppStorageUsage {
  revision: number;
  usageBytes: number;
  quotaBytes: number;
  keyCount: number;
  keyLimit: number;
}

export interface RestrictedAppStorageMutationResult extends RestrictedAppStorageUsage {
  changed: boolean;
  changedKeys: string[];
}

export type RestrictedAppStorageErrorCode =
  | "STORAGE_INVALID"
  | "STORAGE_QUOTA"
  | "STORAGE_CONFLICT"
  | "STORAGE_CORRUPT"
  | "STORAGE_UNSAFE";

export class RestrictedAppStorageError extends Error {
  constructor(
    readonly code: RestrictedAppStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RestrictedAppStorageError";
  }
}

interface RestrictedAppStorageFile {
  schemaVersion: 3;
  ownerClass: "instance";
  tenantId: TenantId;
  runtimeInstanceId: RuntimeInstanceId;
  featureInstallationId: FeatureInstallationId;
  dataNamespaceId: DataNamespaceId;
  revision: number;
  usageBytes: number;
  entries: RestrictedAppStorageEntry[];
}

interface RestrictedAppStorageEntry {
  key: string;
  value: RestrictedAppStorageJsonValue;
}

interface NormalizedTransaction {
  expectedRevision?: number;
  clear: boolean;
  set: RestrictedAppStorageSetOperation[];
  delete: string[];
}

/**
 * Host-owned, instance-shared JSON storage for one explicit data lineage.
 * Package digests are intentionally absent: reviewed updates retain the same
 * Data Namespace only after the service has approved compatibility. Runtime
 * Instance and Feature Installation identities remain embedded so adopting a
 * retained namespace requires an explicit host migration, never an id swap.
 */
export class FileRestrictedAppStorage {
  readonly #rootPath: string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(rootPath: string) {
    this.#rootPath = resolve(rootPath);
  }

  async usage(owner: RestrictedAppStorageOwner): Promise<RestrictedAppStorageUsage> {
    const normalized = normalizeOwner(owner);
    return await this.#enqueue(normalized, async () => usageFromFile(await this.#read(normalized)));
  }

  async keys(owner: RestrictedAppStorageOwner, prefix = ""): Promise<string[]> {
    const normalized = normalizeOwner(owner);
    const safePrefix = storagePrefix(prefix);
    return await this.#enqueue(normalized, async () => (await this.#read(normalized)).entries
      .map((entry) => entry.key)
      .filter((key) => key.startsWith(safePrefix)));
  }

  async get(owner: RestrictedAppStorageOwner, key: string): Promise<RestrictedAppStorageJsonValue | undefined> {
    const normalized = normalizeOwner(owner);
    const safeKey = storageKey(key);
    return await this.#enqueue(normalized, async () => {
      const entry = (await this.#read(normalized)).entries.find((item) => item.key === safeKey);
      return entry ? cloneJson(entry.value) : undefined;
    });
  }

  async set(
    owner: RestrictedAppStorageOwner,
    key: string,
    value: RestrictedAppStorageJsonValue,
    authorizeCommit?: RestrictedAppStorageCommitAuthorizer,
  ): Promise<RestrictedAppStorageMutationResult> {
    return await this.transaction(owner, { set: [{ key, value }] }, authorizeCommit);
  }

  async delete(owner: RestrictedAppStorageOwner, key: string, authorizeCommit?: RestrictedAppStorageCommitAuthorizer): Promise<RestrictedAppStorageMutationResult> {
    return await this.transaction(owner, { delete: [key] }, authorizeCommit);
  }

  async clear(owner: RestrictedAppStorageOwner, authorizeCommit?: RestrictedAppStorageCommitAuthorizer): Promise<RestrictedAppStorageMutationResult> {
    return await this.transaction(owner, { clear: true }, authorizeCommit);
  }

  async transaction(
    owner: RestrictedAppStorageOwner,
    transaction: RestrictedAppStorageTransaction,
    authorizeCommit?: RestrictedAppStorageCommitAuthorizer,
  ): Promise<RestrictedAppStorageMutationResult> {
    const normalizedOwner = normalizeOwner(owner);
    const normalizedTransaction = normalizeTransaction(transaction);
    return await this.#enqueue(normalizedOwner, async () => {
      const current = await this.#read(normalizedOwner);
      if (normalizedTransaction.expectedRevision !== undefined
        && normalizedTransaction.expectedRevision !== current.revision) {
        throw new RestrictedAppStorageError("STORAGE_CONFLICT", "Restricted app storage changed before the transaction was committed.");
      }

      const entries = new Map(current.entries.map((entry) => [entry.key, entry.value]));
      const before = new Map([...entries].map(([key, value]) => [key, JSON.stringify(value)]));
      if (normalizedTransaction.clear) entries.clear();
      for (const key of normalizedTransaction.delete) entries.delete(key);
      for (const operation of normalizedTransaction.set) entries.set(operation.key, operation.value);

      const nextEntries = [...entries]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value }));
      if (nextEntries.length > restrictedAppStorageLimits.keys) {
        throw new RestrictedAppStorageError("STORAGE_QUOTA", `Restricted app storage cannot contain more than ${restrictedAppStorageLimits.keys} keys.`);
      }
      const usageBytes = storageUsage(nextEntries);
      if (usageBytes > restrictedAppStorageLimits.appBytes) {
        throw new RestrictedAppStorageError("STORAGE_QUOTA", "Restricted app storage exceeds its 5 MiB quota.");
      }

      const after = new Map(nextEntries.map((entry) => [entry.key, JSON.stringify(entry.value)]));
      const changedKeys = [...new Set([...before.keys(), ...after.keys()])]
        .filter((key) => before.get(key) !== after.get(key))
        .sort((left, right) => left.localeCompare(right));
      if (!changedKeys.length) return mutationResult(current, false, []);
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage revision is exhausted.");
      }
      const next: RestrictedAppStorageFile = {
        schemaVersion: 3,
        ...normalizedOwner,
        revision: current.revision + 1,
        usageBytes,
        entries: nextEntries,
      };
      await this.#write(normalizedOwner, next, authorizeCommit);
      return mutationResult(next, true, changedKeys);
    });
  }

  async deleteApp(owner: RestrictedAppStorageOwner): Promise<boolean> {
    const normalized = normalizeOwner(owner);
    return await this.#enqueue(normalized, async () => {
      const paths = this.#paths(normalized);
      const root = await safeInfo(this.#rootPath);
      if (!root) return false;
      assertDirectory(root, "Restricted app storage root");
      const shard = await safeInfo(paths.shard);
      if (!shard) return false;
      assertDirectory(shard, "Restricted app storage shard");
      const directory = await safeInfo(paths.directory);
      if (!directory) return false;
      assertDirectory(directory, "Restricted app storage owner directory");
      assertContained(this.#rootPath, paths.directory);
      await rm(paths.directory, { recursive: true, force: true });
      return true;
    });
  }

  async #read(owner: RestrictedAppStorageOwner): Promise<RestrictedAppStorageFile> {
    const paths = this.#paths(owner);
    const root = await safeInfo(this.#rootPath);
    if (!root) return emptyFile(owner);
    assertDirectory(root, "Restricted app storage root");
    const shard = await safeInfo(paths.shard);
    if (!shard) return emptyFile(owner);
    assertDirectory(shard, "Restricted app storage shard");
    const directory = await safeInfo(paths.directory);
    if (!directory) return emptyFile(owner);
    assertDirectory(directory, "Restricted app storage owner directory");
    const file = await safeInfo(paths.file);
    if (!file) return emptyFile(owner);
    if (file.isSymbolicLink() || !file.isFile()) {
      throw new RestrictedAppStorageError("STORAGE_UNSAFE", "Restricted app storage is not a regular file.");
    }
    if (file.size > restrictedAppStorageLimits.fileBytes) {
      throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file exceeds its safety limit.");
    }
    try {
      const bytes = await readFile(paths.file);
      if (bytes.byteLength > restrictedAppStorageLimits.fileBytes) {
        throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file exceeds its safety limit.");
      }
      return normalizeFile(JSON.parse(bytes.toString("utf8")), owner);
    } catch (error) {
      if (error instanceof RestrictedAppStorageError) throw error;
      throw new RestrictedAppStorageError("STORAGE_CORRUPT", `work-fold could not read restricted app storage: ${errorMessage(error)}`);
    }
  }

  async #write(
    owner: RestrictedAppStorageOwner,
    data: RestrictedAppStorageFile,
    authorizeCommit?: RestrictedAppStorageCommitAuthorizer,
  ): Promise<void> {
    const paths = this.#paths(owner);
    await ensureSafeRoot(this.#rootPath);
    await ensureSafeChildDirectory(this.#rootPath, paths.shard, "Restricted app storage shard");
    await ensureSafeChildDirectory(paths.shard, paths.directory, "Restricted app storage owner directory");
    const existing = await safeInfo(paths.file);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new RestrictedAppStorageError("STORAGE_UNSAFE", "Restricted app storage is not a regular file.");
    }
    const source = JSON.stringify(data);
    if (Buffer.byteLength(source, "utf8") > restrictedAppStorageLimits.fileBytes) {
      throw new RestrictedAppStorageError("STORAGE_QUOTA", "Restricted app storage file exceeds its safety limit.");
    }
    const temporary = join(paths.directory, `storage.json.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await authorizeCommit?.();
      await rename(temporary, paths.file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #paths(owner: RestrictedAppStorageOwner): { shard: string; directory: string; file: string } {
    return this.#pathsForHash(ownerHash(owner));
  }

  #pathsForHash(hash: string): { shard: string; directory: string; file: string } {
    const shard = join(this.#rootPath, hash.slice(0, 2));
    const directory = join(shard, hash);
    const file = join(directory, "storage.json");
    assertContained(this.#rootPath, file);
    return { shard, directory, file };
  }

  async #enqueue<T>(owner: RestrictedAppStorageOwner, operation: () => Promise<T>): Promise<T> {
    const key = ownerHash(owner);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#queues.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#queues.get(key) === tail) this.#queues.delete(key);
    }
  }
}

function normalizeOwner(value: RestrictedAppStorageOwner): RestrictedAppStorageOwner {
  if (!value || typeof value !== "object") throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage owner is invalid.");
  if (Object.keys(value).some((key) => ![
    "ownerClass", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId",
  ].includes(key)) || value.ownerClass !== "instance") {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage requires an exact instance owner.");
  }
  try {
    return {
      ownerClass: "instance",
      tenantId: parseTenantId(value.tenantId),
      runtimeInstanceId: parseRuntimeInstanceId(value.runtimeInstanceId),
      featureInstallationId: parseFeatureInstallationId(value.featureInstallationId),
      dataNamespaceId: parseDataNamespaceId(value.dataNamespaceId),
    };
  } catch (error) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", `Restricted app storage owner is invalid: ${errorMessage(error)}`);
  }
}

function ownerHash(owner: RestrictedAppStorageOwner): string {
  return createHash("sha256")
    .update("work-fold.restricted-app-storage.v3\0")
    .update(owner.tenantId)
    .update("\0")
    .update(owner.dataNamespaceId)
    .digest("hex");
}

function normalizeTransaction(value: RestrictedAppStorageTransaction): NormalizedTransaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage transaction is invalid.");
  }
  const unknown = Object.keys(value).find((key) => !["expectedRevision", "clear", "set", "delete"].includes(key));
  if (unknown) throw new RestrictedAppStorageError("STORAGE_INVALID", `Restricted app storage transaction contains unsupported field ${unknown}.`);
  const expectedRevision = value.expectedRevision;
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage expected revision is invalid.");
  }
  if (value.clear !== undefined && typeof value.clear !== "boolean") {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage clear flag is invalid.");
  }
  if (value.set !== undefined && !Array.isArray(value.set)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage set operations are invalid.");
  }
  if (value.delete !== undefined && !Array.isArray(value.delete)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage delete operations are invalid.");
  }
  const set = (value.set ?? []).map((operation) => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || Object.keys(operation).some((key) => key !== "key" && key !== "value")) {
      throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage set operation is invalid.");
    }
    const key = storageKey(operation.key);
    const normalizedValue = cloneJson(operation.value);
    if (jsonBytes(normalizedValue) > restrictedAppStorageLimits.valueBytes) {
      throw new RestrictedAppStorageError("STORAGE_QUOTA", "Restricted app storage value exceeds the 128 KiB limit.");
    }
    return { key, value: normalizedValue };
  });
  const deleted = (value.delete ?? []).map(storageKey);
  const setKeys = set.map((operation) => operation.key);
  if (new Set(setKeys).size !== setKeys.length || new Set(deleted).size !== deleted.length
    || setKeys.some((key) => deleted.includes(key))) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage transaction contains duplicate or conflicting keys.");
  }
  if (set.length + deleted.length > restrictedAppStorageLimits.transactionOperations) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", `Restricted app storage transaction cannot exceed ${restrictedAppStorageLimits.transactionOperations} operations.`);
  }
  const normalized: NormalizedTransaction = {
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    clear: value.clear === true,
    set,
    delete: deleted,
  };
  if (jsonBytes(normalized) > restrictedAppStorageLimits.transactionBytes) {
    throw new RestrictedAppStorageError("STORAGE_QUOTA", "Restricted app storage transaction exceeds the 160 KiB limit.");
  }
  return normalized;
}

function normalizeFile(value: unknown, owner: RestrictedAppStorageOwner): RestrictedAppStorageFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file is invalid.");
  }
  if (Object.keys(value).some((key) => ![
    "schemaVersion", "ownerClass", "tenantId", "runtimeInstanceId", "featureInstallationId", "dataNamespaceId",
    "revision", "usageBytes", "entries",
  ].includes(key))) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file contains unsupported metadata.");
  }
  const record = value as Partial<RestrictedAppStorageFile>;
  if (record.schemaVersion !== 3 || record.ownerClass !== owner.ownerClass || record.tenantId !== owner.tenantId
    || record.runtimeInstanceId !== owner.runtimeInstanceId || record.featureInstallationId !== owner.featureInstallationId
    || record.dataNamespaceId !== owner.dataNamespaceId
    || !Number.isSafeInteger(record.revision) || record.revision! < 0 || !Number.isSafeInteger(record.usageBytes)
    || record.usageBytes! < 0 || !Array.isArray(record.entries)) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file identity or metadata is invalid.");
  }
  if (record.entries.length > restrictedAppStorageLimits.keys) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file contains too many keys.");
  }
  let entries: RestrictedAppStorageEntry[];
  try {
    entries = record.entries.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).some((key) => key !== "key" && key !== "value")) {
        throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage entry is invalid.");
      }
      const candidate = entry as Partial<RestrictedAppStorageEntry>;
      const key = storageKey(candidate.key);
      const normalizedValue = cloneJson(candidate.value);
      if (jsonBytes(normalizedValue) > restrictedAppStorageLimits.valueBytes) {
        throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file contains an oversized value.");
      }
      return { key, value: normalizedValue };
    });
  } catch (error) {
    if (error instanceof RestrictedAppStorageError && error.code === "STORAGE_CORRUPT") throw error;
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", `Restricted app storage file contains invalid data: ${errorMessage(error)}`);
  }
  const keys = entries.map((entry) => entry.key);
  const sorted = [...keys].sort((left, right) => left.localeCompare(right));
  if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index])) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file contains duplicate or unsorted keys.");
  }
  const usageBytes = storageUsage(entries);
  if (usageBytes !== record.usageBytes || usageBytes > restrictedAppStorageLimits.appBytes) {
    throw new RestrictedAppStorageError("STORAGE_CORRUPT", "Restricted app storage file usage metadata is invalid.");
  }
  return {
    schemaVersion: 3,
    ...owner,
    revision: record.revision!,
    usageBytes,
    entries,
  };
}

function emptyFile(owner: RestrictedAppStorageOwner): RestrictedAppStorageFile {
  return { schemaVersion: 3, ...owner, revision: 0, usageBytes: 0, entries: [] };
}

function usageFromFile(file: RestrictedAppStorageFile): RestrictedAppStorageUsage {
  return {
    revision: file.revision,
    usageBytes: file.usageBytes,
    quotaBytes: restrictedAppStorageLimits.appBytes,
    keyCount: file.entries.length,
    keyLimit: restrictedAppStorageLimits.keys,
  };
}

function mutationResult(file: RestrictedAppStorageFile, changed: boolean, changedKeys: string[]): RestrictedAppStorageMutationResult {
  return { ...usageFromFile(file), changed, changedKeys };
}

function storageKey(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > restrictedAppStorageLimits.keyBytes
    || /[\0-\x1f\x7f]/.test(value)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage key is invalid.");
  }
  return value;
}

function storagePrefix(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > restrictedAppStorageLimits.keyBytes
    || /[\0-\x1f\x7f]/.test(value)) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage key prefix is invalid.");
  }
  return value;
}

function cloneJson(value: unknown, depth = 0, ancestors = new Set<object>()): RestrictedAppStorageJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values must contain only finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object" || depth >= restrictedAppStorageLimits.jsonDepth) {
    throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values must be bounded JSON-compatible data.");
  }
  if (ancestors.has(value)) throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values must contain only plain objects.");
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values cannot contain symbol properties.");
    }
    const result: { [key: string]: RestrictedAppStorageJsonValue } = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new RestrictedAppStorageError("STORAGE_INVALID", "Restricted app storage values cannot contain accessors.");
      }
      Object.defineProperty(result, key, {
        value: cloneJson(descriptor.value, depth + 1, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function storageUsage(entries: RestrictedAppStorageEntry[]): number {
  return entries.reduce((total, entry) => total + jsonBytes([entry.key, entry.value]), 0);
}

async function ensureSafeRoot(rootPath: string): Promise<void> {
  await mkdir(rootPath, { recursive: true, mode: 0o700 });
  const info = await safeInfo(rootPath);
  if (!info) throw new RestrictedAppStorageError("STORAGE_UNSAFE", "Restricted app storage root could not be created.");
  assertDirectory(info, "Restricted app storage root");
}

async function ensureSafeChildDirectory(parent: string, child: string, label: string): Promise<void> {
  assertContained(parent, child);
  const parentInfo = await safeInfo(parent);
  if (!parentInfo) throw new RestrictedAppStorageError("STORAGE_UNSAFE", `${label} parent is missing.`);
  assertDirectory(parentInfo, `${label} parent`);
  try {
    await mkdir(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  const info = await safeInfo(child);
  if (!info) throw new RestrictedAppStorageError("STORAGE_UNSAFE", `${label} could not be created.`);
  assertDirectory(info, label);
}

function assertDirectory(info: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RestrictedAppStorageError("STORAGE_UNSAFE", `${label} is not a safe directory.`);
  }
}

async function safeInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

function assertContained(rootPath: string, candidatePath: string): void {
  const child = relative(resolve(rootPath), resolve(candidatePath));
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new RestrictedAppStorageError("STORAGE_UNSAFE", "Restricted app storage path escapes its root.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
