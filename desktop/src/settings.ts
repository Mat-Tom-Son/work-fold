import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import type { PiAuthStorageData, PiAuthStorageHost } from "../../src/local/agent/auth-storage.js";

export interface SecureSettingsStatus {
  encryptionAvailable: boolean;
  configuredProviders: string[];
}

interface SecureSettingsFile {
  schemaVersion: 1;
  credentials: PiAuthStorageData;
}

const emptySettings = (): SecureSettingsFile => ({
  schemaVersion: 1,
  credentials: {},
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
    schemaVersion: 1,
    credentials: credentialRecord(record.credentials),
  };
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
