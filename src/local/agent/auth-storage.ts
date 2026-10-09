import { join } from "node:path";
import { FileCredentialStore } from "@earendil-works/pi-coding-agent";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export type PiAuthStorageData = Record<string, Credential>;

/** Encrypted host persistence. Credential values never enter catalog/status APIs. */
export interface PiAuthStorageHost {
  load(): Promise<PiAuthStorageData | undefined>;
  save(data: PiAuthStorageData): Promise<void>;
}

export interface PersistentPiAuthStorage {
  credentials: CredentialStore;
  flush(): Promise<void>;
}

/** The native Pi file store, or a durable async CredentialStore for Electron safeStorage. */
export async function createPersistentPiAuthStorage(options: {
  agentDir: string;
  host?: PiAuthStorageHost;
}): Promise<PersistentPiAuthStorage> {
  if (!options.host) return {
    credentials: FileCredentialStore.create(join(options.agentDir, "auth.json")),
    flush: async () => undefined,
  };
  const credentials = await HostCredentialStore.create(options.host);
  return { credentials, flush: () => credentials.flush() };
}

/** Whole-store serialization prevents different providers overwriting encrypted snapshots. */
export class HostCredentialStore implements CredentialStore {
  private queue: Promise<void> = Promise.resolve();
  private constructor(private readonly host: PiAuthStorageHost, private data: PiAuthStorageData) {}

  static async create(host: PiAuthStorageHost): Promise<HostCredentialStore> {
    return new HostCredentialStore(host, structuredClone(await host.load() ?? {}));
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return structuredClone(Object.hasOwn(this.data, providerId) ? this.data[providerId] : undefined);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const credential = await fn(structuredClone(Object.hasOwn(this.data, providerId) ? this.data[providerId] : undefined));
      options?.signal?.throwIfAborted();
      if (credential !== undefined) {
        const next = { ...this.data, [providerId]: structuredClone(credential) };
        await this.host.save(structuredClone(next));
        this.data = next;
      }
      return structuredClone(Object.hasOwn(this.data, providerId) ? this.data[providerId] : undefined);
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      if (!Object.hasOwn(this.data, providerId)) return;
      const next = { ...this.data };
      delete next[providerId];
      await this.host.save(structuredClone(next));
      this.data = next;
    });
  }

  async flush(): Promise<void> { await this.queue; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
