import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseAppPlatformArtifactDigest } from "./app-platform-artifact.js";
import {
  parseFeatureInstallationId,
  parsePrincipalId,
  parseRuntimeInstanceId,
  parseSha256Digest,
  parseTenantId,
  type DeclarationDigest,
} from "./app-platform-contract.js";
import {
  normalizeRestrictedAppCredential,
  type RestrictedAppConnectionBinding,
  type RestrictedAppConnectionFeatureScope,
  type RestrictedAppConnectionInstanceScope,
  type RestrictedAppConnectionStore,
  type RestrictedAppCredential,
  type RestrictedAppEffectAuthorizer,
} from "./restricted-app-connections.js";

export interface RestrictedAppSecretEncryption {
  isAvailable(): boolean;
  encrypt(plaintext: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

interface ConnectionFile {
  schemaVersion: 3;
  records: ConnectionRecord[];
}

interface ConnectionRecord extends RestrictedAppConnectionBinding {
  recordVersion: 2;
  connectionId: string;
  credential: RestrictedAppCredential;
  updatedAt: string;
}

const maximumConnectionRecords = 1_024;

export class EncryptedRestrictedAppConnectionStore implements RestrictedAppConnectionStore {
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryption: RestrictedAppSecretEncryption,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined> {
    const normalized = normalizeBinding(binding);
    const data = await this.#read();
    const record = data.records.find((item) => bindingKey(item) === bindingKey(normalized));
    return record ? structuredClone(record.credential) : undefined;
  }

  async set(
    binding: RestrictedAppConnectionBinding,
    credential: RestrictedAppCredential,
    authorizeCommit?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    const normalized = normalizeBinding(binding);
    const safeCredential = normalizeRestrictedAppCredential(credential);
    await this.#update((data) => {
      const existing = data.records.find((item) => bindingKey(item) === bindingKey(normalized));
      data.records = data.records.filter((item) => bindingKey(item) !== bindingKey(normalized));
      data.records.push({
        recordVersion: 2,
        connectionId: existing?.connectionId ?? `connection_${randomUUID()}`,
        ...normalized,
        credential: safeCredential,
        updatedAt: this.now().toISOString(),
      });
    }, authorizeCommit);
  }

  async delete(binding: RestrictedAppConnectionBinding, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<boolean> {
    const normalized = normalizeBinding(binding);
    let removed = false;
    await this.#update((data) => {
      const next = data.records.filter((item) => bindingKey(item) !== bindingKey(normalized));
      removed = next.length !== data.records.length;
      data.records = next;
    }, authorizeCommit);
    return removed;
  }

  async deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void> {
    const normalized = normalizeFeatureScope(scope);
    await this.#update((data) => {
      data.records = data.records.filter((item) => featureScopeKey(item) !== featureScopeKey(normalized));
    });
  }

  async deleteRuntimeInstance(scope: RestrictedAppConnectionInstanceScope): Promise<void> {
    const normalized = normalizeInstanceScope(scope);
    await this.#update((data) => {
      data.records = data.records.filter((item) => item.tenantId !== normalized.tenantId
        || item.runtimeInstanceId !== normalized.runtimeInstanceId);
    });
  }

  async #update(
    mutator: (data: ConnectionFile) => void,
    authorizeCommit?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    let operationError: unknown;
    const operation = this.#queue.catch(() => undefined).then(async () => {
      try {
        const current = await this.#read();
        const data: ConnectionFile = current;
        mutator(data);
        data.records.sort((left, right) => bindingKey(left).localeCompare(bindingKey(right)));
        await this.#write(data, authorizeCommit);
      } catch (error) {
        operationError = error;
      }
    });
    this.#queue = operation;
    await operation;
    if (operationError) throw operationError;
  }

  async #read(): Promise<ConnectionFile> {
    if (!existsSync(this.filePath)) return { schemaVersion: 3, records: [] };
    this.#assertEncryption();
    const info = await lstat(this.filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Restricted app connection store is unsafe or too large.");
    try {
      const source = this.encryption.decrypt(await readFile(this.filePath));
      const value = JSON.parse(source) as unknown;
      const record = exactRecord(value, "Connection store", ["schemaVersion", "records"]);
      if (record.schemaVersion !== 3 || !Array.isArray(record.records)) throw new Error("Connection store version is unsupported.");
      if (record.records.length > maximumConnectionRecords) throw new Error("Connection store contains too many records.");
      const records = record.records.map((item) => normalizeRecord(item));
      const keys = records.map(bindingKey);
      if (new Set(keys).size !== keys.length) throw new Error("Connection store contains duplicate bindings.");
      const connectionIds = records.map((item) => item.connectionId);
      if (new Set(connectionIds).size !== connectionIds.length) throw new Error("Connection store contains duplicate connection ids.");
      return { schemaVersion: 3, records };
    } catch (error) {
      throw new Error(`work-fold could not read restricted app connections: ${errorMessage(error)}`);
    }
  }

  async #write(data: ConnectionFile, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<void> {
    this.#assertEncryption();
    if (data.records.length > maximumConnectionRecords) {
      throw new Error(`Restricted app connection store cannot contain more than ${maximumConnectionRecords} records.`);
    }
    if (existsSync(this.filePath)) {
      const info = await lstat(this.filePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Restricted app connection store is not a regular file.");
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const ciphertext = this.encryption.encrypt(JSON.stringify(data));
    if (ciphertext.byteLength > 2 * 1024 * 1024) throw new Error("Restricted app connection store exceeds the size limit.");
    await writeFile(temporary, ciphertext, { flag: "wx" });
    try {
      await authorizeCommit?.();
      await rename(temporary, this.filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #assertEncryption(): void {
    if (!this.encryption.isAvailable()) throw new Error("Operating-system secure storage is unavailable for restricted app connections.");
  }
}

function normalizeRecord(value: unknown): ConnectionRecord {
  const record = exactRecord(value, "Connection record", [
    "recordVersion", "connectionId", "tenantId", "runtimeInstanceId", "featureId", "featureInstallationId",
    "featureRevisionDigest", "declarationId", "declarationDigest", "targetIdentity", "owner", "credential", "updatedAt",
  ]);
  if (record.recordVersion !== 2) throw new Error("Connection record version is unsupported.");
  const connectionId = connectionIdentifier(record.connectionId);
  const binding = normalizeBinding(record as unknown as RestrictedAppConnectionBinding);
  const credential = normalizeRestrictedAppCredential(record.credential);
  const updatedAt = exactTimestamp(record.updatedAt, "Connection update time");
  return { recordVersion: 2, connectionId, ...binding, credential, updatedAt };
}

function normalizeBinding(value: RestrictedAppConnectionBinding): RestrictedAppConnectionBinding {
  const scope = normalizeFeatureScope(value);
  const declarationId = identifier(value.declarationId, "declaration id");
  const declarationDigest = parseDeclarationDigest(value.declarationDigest);
  let origin: URL;
  try {
    origin = new URL(value.targetIdentity);
  } catch {
    throw new Error("Restricted app connection target identity is invalid.");
  }
  if (origin.protocol !== "https:" || origin.origin !== value.targetIdentity || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("Restricted app connection target identity must be an exact HTTPS origin.");
  }
  const owner = normalizeConnectionOwner(value.owner, scope.runtimeInstanceId);
  return {
    ...scope,
    declarationId,
    declarationDigest,
    targetIdentity: origin.origin,
    owner,
  };
}

function normalizeFeatureScope(value: RestrictedAppConnectionFeatureScope): RestrictedAppConnectionFeatureScope {
  return {
    tenantId: parseTenantId(value.tenantId),
    runtimeInstanceId: parseRuntimeInstanceId(value.runtimeInstanceId),
    featureId: identifier(value.featureId, "feature id"),
    featureInstallationId: parseFeatureInstallationId(value.featureInstallationId),
    featureRevisionDigest: parseAppPlatformArtifactDigest(value.featureRevisionDigest),
  };
}

function normalizeInstanceScope(value: RestrictedAppConnectionInstanceScope): RestrictedAppConnectionInstanceScope {
  return {
    tenantId: parseTenantId(value.tenantId),
    runtimeInstanceId: parseRuntimeInstanceId(value.runtimeInstanceId),
  };
}

function normalizeConnectionOwner(
  value: RestrictedAppConnectionBinding["owner"],
  runtimeInstanceId: RestrictedAppConnectionBinding["runtimeInstanceId"],
): RestrictedAppConnectionBinding["owner"] {
  const record = exactRecord(value, "Connection owner", value?.kind === "instance"
    ? ["kind", "runtimeInstanceId"]
    : ["kind", "principalId"]);
  if (record.kind === "instance") {
    const ownerRuntimeInstanceId = parseRuntimeInstanceId(record.runtimeInstanceId);
    if (ownerRuntimeInstanceId !== runtimeInstanceId) {
      throw new Error("Restricted app instance-owned connection does not belong to its Runtime Instance.");
    }
    return { kind: "instance", runtimeInstanceId: ownerRuntimeInstanceId };
  }
  if (record.kind === "principal") {
    return { kind: "principal", principalId: parsePrincipalId(record.principalId) };
  }
  throw new Error("Restricted app connection owner kind is invalid.");
}

function identifier(value: unknown, label: string, maximum = 64): string {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`Restricted app connection ${label} is invalid.`);
  }
  return value;
}

function bindingKey(value: RestrictedAppConnectionBinding): string {
  return JSON.stringify([
    value.tenantId,
    value.runtimeInstanceId,
    value.featureId,
    value.featureInstallationId,
    value.featureRevisionDigest,
    value.declarationId,
    value.declarationDigest,
    value.targetIdentity,
    value.owner.kind,
    value.owner.kind === "instance" ? value.owner.runtimeInstanceId : value.owner.principalId,
  ]);
}

function featureScopeKey(value: RestrictedAppConnectionFeatureScope): string {
  return JSON.stringify([
    value.tenantId,
    value.runtimeInstanceId,
    value.featureId,
    value.featureInstallationId,
    value.featureRevisionDigest,
  ]);
}

function connectionIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^connection_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("Restricted app connection id is invalid.");
  }
  return value;
}

function parseDeclarationDigest(value: unknown): DeclarationDigest {
  const digest: string = parseSha256Digest(value, "connection declarationDigest");
  return digest as DeclarationDigest;
}

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64) throw new Error(`${label} is invalid.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object.`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  const actual = Object.keys(record);
  const unsupported = actual.find((key) => !expected.has(key));
  if (unsupported) throw new Error(`${label} contains unsupported field ${unsupported}.`);
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (missing) throw new Error(`${label} is missing field ${missing}.`);
  if (actual.length !== keys.length) throw new Error(`${label} has an invalid field count.`);
  return record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
