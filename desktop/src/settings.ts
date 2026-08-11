import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { PiAuthStorageData, PiAuthStorageHost } from "../../src/local/agent/auth-storage.js";
import type { WorkFoldPublicationKeyStore } from "../../src/local/publications.js";

export interface SecureSettingsStatus {
  encryptionAvailable: boolean;
  configuredProviders: string[];
}

interface SecureSettingsFile {
  schemaVersion: 2;
  credentials: PiAuthStorageData;
  remoteAccess: RemoteAccessSettings | null;
  /**
   * Per-publication page keys for "pages your fold serves"
   * (docs/fold-publishing.md, rung 2): publicationId -> 32-byte base64url
   * AES-256-GCM key. Remote access material — operating-system-encrypted
   * beside the device and grant keys, never in the publication store and
   * never inside a Space folder. The share link's fragment is the only other
   * place a key exists.
   */
  publicationKeys: Record<string, string>;
}

export interface RemoteBrowserGrantSettings {
  id: string;
  browserId: string;
  label: string;
  signingPublicJwk: JsonWebKey;
  encryptionPublicJwk: JsonWebKey;
  generation: number;
  approvedAt: string;
}

export interface RemoteAccessSettings {
  enabled: boolean;
  bridgeUrl: string;
  accountId: string;
  slug: string;
  deviceToken: string;
  deviceSigningPrivateJwk: JsonWebKey;
  deviceSigningPublicJwk: JsonWebKey;
  deviceEncryptionPrivateJwk: JsonWebKey;
  deviceEncryptionPublicJwk: JsonWebKey;
  grants: RemoteBrowserGrantSettings[];
}

const emptySettings = (): SecureSettingsFile => ({
  schemaVersion: 2,
  credentials: {},
  remoteAccess: null,
  publicationKeys: {},
});

/** Encrypted, application-scoped credentials. Never stored inside a Space. */
export class SecureSettingsStore implements PiAuthStorageHost {
  private queue: Promise<void> = Promise.resolve();
  private cache: SecureSettingsFile | undefined;

  constructor(private readonly filePath: string) {}

  async status(): Promise<SecureSettingsStatus> {
    if (!safeStorage.isEncryptionAvailable()) {
      return { encryptionAvailable: false, configuredProviders: [] };
    }
    const data = await this.read();
    return {
      encryptionAvailable: true,
      configuredProviders: Object.keys(data.credentials).sort(),
    };
  }

  async load(): Promise<PiAuthStorageData | undefined> {
    const credentials = (await this.read()).credentials;
    return Object.keys(credentials).length ? credentials : undefined;
  }

  async save(credentials: PiAuthStorageData): Promise<void> {
    await this.update((data) => {
      data.credentials = { ...credentials };
    });
  }

  async getProviderApiKey(provider: string): Promise<string | undefined> {
    const credential = (await this.read()).credentials[normalizeProvider(provider)];
    return credential?.type === "api_key" ? credential.key : undefined;
  }

  async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
    const key = normalizeProvider(provider);
    const value = apiKey.trim();
    if (!value) throw new Error("API key cannot be empty.");
    await this.update((data) => {
      data.credentials[key] = { type: "api_key", key: value };
    });
  }

  async clearProviderApiKey(provider: string): Promise<void> {
    const key = normalizeProvider(provider);
    await this.update((data) => {
      delete data.credentials[key];
    });
  }

  async getRemoteAccess(): Promise<RemoteAccessSettings | null> {
    return (await this.read()).remoteAccess;
  }

  async setRemoteAccess(settings: RemoteAccessSettings): Promise<void> {
    const normalized = remoteAccessSettings(settings);
    if (!normalized) throw new Error("Web access settings are invalid.");
    await this.update((data) => { data.remoteAccess = normalized; });
  }

  async setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessSettings | null> {
    let result: RemoteAccessSettings | null = null;
    await this.update((data) => {
      if (!data.remoteAccess) return;
      data.remoteAccess.enabled = enabled;
      result = structuredClone(data.remoteAccess);
    });
    return result;
  }

  async saveRemoteBrowserGrant(grant: RemoteBrowserGrantSettings): Promise<void> {
    const normalized = remoteBrowserGrant(grant);
    if (!normalized) throw new Error("Remote browser grant is invalid.");
    await this.update((data) => {
      if (!data.remoteAccess) throw new Error("Web access is not configured.");
      data.remoteAccess.grants = [
        normalized,
        ...data.remoteAccess.grants.filter((item) => item.browserId !== normalized.browserId && item.id !== normalized.id),
      ].slice(0, 64);
    });
  }

  async removeRemoteBrowserGrant(grantId: string): Promise<void> {
    await this.update((data) => {
      if (data.remoteAccess) data.remoteAccess.grants = data.remoteAccess.grants.filter((item) => item.id !== grantId);
    });
  }

  async clearRemoteBrowserGrants(): Promise<void> {
    await this.update((data) => { if (data.remoteAccess) data.remoteAccess.grants = []; });
  }

  async clearRemoteAccess(): Promise<void> {
    await this.update((data) => { data.remoteAccess = null; });
  }

  async getPublicationKey(publicationId: string): Promise<string | null> {
    if (!stableId(publicationId, 128)) return null;
    return (await this.read()).publicationKeys[publicationId] ?? null;
  }

  async setPublicationKey(publicationId: string, keyBase64Url: string): Promise<void> {
    if (!stableId(publicationId, 128)) throw new Error("Publication id is invalid.");
    if (!publicationKeyBase64Url(keyBase64Url)) throw new Error("A publication key must be 32 bytes, base64url-encoded.");
    await this.update((data) => {
      data.publicationKeys[publicationId] = keyBase64Url;
    });
  }

  async removePublicationKey(publicationId: string): Promise<void> {
    await this.update((data) => {
      delete data.publicationKeys[publicationId];
    });
  }

  /**
   * The publication service's key-store seam
   * (src/local/publications.ts): revocation removes the key here in the same
   * cleanup pass that deletes the bridge slot, and a key never leaves secure
   * settings except inside the person's own share link.
   */
  publicationKeyStore(): WorkFoldPublicationKeyStore {
    return {
      get: (publicationId) => this.getPublicationKey(publicationId),
      set: (publicationId, keyBase64Url) => this.setPublicationKey(publicationId, keyBase64Url),
      remove: (publicationId) => this.removePublicationKey(publicationId),
    };
  }

  private async update(mutator: (data: SecureSettingsFile) => void): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const data = await this.read();
      mutator(data);
      await this.write(data);
    });
    this.queue = operation;
    await operation;
  }

  private async read(): Promise<SecureSettingsFile> {
    if (this.cache) return structuredClone(this.cache);
    if (!existsSync(this.filePath) && !existsSync(this.backupPath())) {
      this.cache = emptySettings();
      return structuredClone(this.cache);
    }
    this.assertEncryptionAvailable();
    let firstError: unknown;
    for (const candidate of [this.filePath, this.backupPath()]) {
      if (!existsSync(candidate)) continue;
      try {
        const decrypted = safeStorage.decryptString(await readFile(candidate));
        this.cache = normalizeSettings(JSON.parse(decrypted));
        return structuredClone(this.cache);
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new Error(`work-fold could not read secure settings: ${errorMessage(firstError)}`);
  }

  private async write(data: SecureSettingsFile): Promise<void> {
    this.assertEncryptionAvailable();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, safeStorage.encryptString(JSON.stringify(data)));
    try {
      if (existsSync(this.filePath)) await copyFile(this.filePath, this.backupPath());
      await rename(temporaryPath, this.filePath);
      this.cache = structuredClone(data);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private backupPath(): string {
    return `${this.filePath}.bak`;
  }

  private assertEncryptionAvailable(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Operating-system secure storage is not available for this session.");
    }
  }
}

function normalizeSettings(value: unknown): SecureSettingsFile {
  if (!value || typeof value !== "object") return emptySettings();
  const record = value as Partial<SecureSettingsFile>;
  return {
    schemaVersion: 2,
    credentials: credentialRecord(record.credentials),
    remoteAccess: remoteAccessSettings((record as { remoteAccess?: unknown }).remoteAccess),
    publicationKeys: publicationKeyRecord((record as { publicationKeys?: unknown }).publicationKeys),
  };
}

function publicationKeyRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const keys: Record<string, string> = {};
  for (const [publicationId, key] of Object.entries(value as Record<string, unknown>)) {
    if (!stableId(publicationId, 128) || !publicationKeyBase64Url(key)) continue;
    keys[publicationId] = key;
  }
  return keys;
}

function publicationKeyBase64Url(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").length === 32;
  } catch {
    return false;
  }
}

function remoteAccessSettings(value: unknown): RemoteAccessSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RemoteAccessSettings>;
  if (typeof record.enabled !== "boolean" || !validHttpsUrl(record.bridgeUrl)
    || !stableId(record.accountId, 160) || !stableSlug(record.slug)
    || typeof record.deviceToken !== "string" || record.deviceToken.length < 32 || record.deviceToken.length > 256
    || !privateEcJwk(record.deviceSigningPrivateJwk) || !publicEcJwk(record.deviceSigningPublicJwk)
    || !privateEcJwk(record.deviceEncryptionPrivateJwk) || !publicEcJwk(record.deviceEncryptionPublicJwk)) return null;
  return {
    enabled: record.enabled,
    bridgeUrl: record.bridgeUrl!,
    accountId: record.accountId!,
    slug: record.slug!,
    deviceToken: record.deviceToken,
    deviceSigningPrivateJwk: structuredClone(record.deviceSigningPrivateJwk),
    deviceSigningPublicJwk: structuredClone(record.deviceSigningPublicJwk),
    deviceEncryptionPrivateJwk: structuredClone(record.deviceEncryptionPrivateJwk),
    deviceEncryptionPublicJwk: structuredClone(record.deviceEncryptionPublicJwk),
    grants: Array.isArray(record.grants) ? record.grants.map(remoteBrowserGrant).filter((item): item is RemoteBrowserGrantSettings => Boolean(item)).slice(0, 64) : [],
  };
}

function remoteBrowserGrant(value: unknown): RemoteBrowserGrantSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<RemoteBrowserGrantSettings>;
  if (!stableId(record.id, 160) || !stableId(record.browserId, 160)
    || typeof record.label !== "string" || !record.label.trim() || record.label.length > 80
    || !publicEcJwk(record.signingPublicJwk) || !publicEcJwk(record.encryptionPublicJwk)
    || !Number.isInteger(record.generation) || Number(record.generation) < 1
    || typeof record.approvedAt !== "string" || !Number.isFinite(Date.parse(record.approvedAt))) return null;
  return {
    id: record.id!, browserId: record.browserId!, label: record.label.trim(),
    signingPublicJwk: structuredClone(record.signingPublicJwk),
    encryptionPublicJwk: structuredClone(record.encryptionPublicJwk),
    generation: Number(record.generation), approvedAt: record.approvedAt,
  };
}

function publicEcJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as JsonWebKey;
  return record.kty === "EC" && record.crv === "P-256" && typeof record.x === "string" && typeof record.y === "string" && record.d === undefined;
}

function privateEcJwk(value: unknown): value is JsonWebKey {
  return publicEcJwk({ ...(value as object), d: undefined }) && typeof (value as JsonWebKey).d === "string";
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && new Set(["127.0.0.1", "localhost"]).has(url.hostname))) && url.pathname === "/" && !url.username && !url.password;
  } catch { return false; }
}

function stableId(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
}

function stableSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(value);
}

function credentialRecord(value: unknown): PiAuthStorageData {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry) => {
    const credential = entry[1];
    if (!credential || typeof credential !== "object") return false;
    const record = credential as { type?: unknown; key?: unknown };
    return (record.type === "api_key" && typeof record.key === "string") || record.type === "oauth";
  })) as PiAuthStorageData;
}

function normalizeProvider(value: string): string {
  const provider = value.trim().toLocaleLowerCase();
  if (!provider || !/^[a-z0-9._-]+$/.test(provider)) throw new Error("Invalid provider name.");
  return provider;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
