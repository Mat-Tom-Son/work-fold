import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PiPreferredModel } from "./pi-runtime-config.js";

interface AssistantModelPreferencesFile {
  version: 1;
  scopes: Record<string, PiPreferredModel & { updatedAt: string }>;
}

/**
 * Machine-local model choices for each portable Space identity and for the
 * fold. Provider credentials remain in Pi's shared AuthStorage.
 */
export class AssistantModelPreferenceStore {
  readonly #filePath: string;
  readonly #managementRoot?: string;
  #writeQueue = Promise.resolve();

  constructor(options: { filePath: string; managementRoot?: string }) {
    this.#filePath = options.filePath;
    this.#managementRoot = options.managementRoot ? rootKey(options.managementRoot) : undefined;
  }

  async get(spaceRoot: string): Promise<PiPreferredModel | undefined> {
    const data = await this.#read();
    const saved = data.scopes[await this.#scopeKey(spaceRoot)];
    return saved ? { provider: saved.provider, id: saved.id } : undefined;
  }

  async set(spaceRoot: string, model: PiPreferredModel): Promise<void> {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) throw new Error("A provider and model are required.");
    const scope = await this.#scopeKey(spaceRoot);
    const write = this.#writeQueue.then(async () => {
      const data = await this.#read();
      data.scopes[scope] = { provider, id, updatedAt: new Date().toISOString() };
      await mkdir(dirname(this.#filePath), { recursive: true });
      const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#filePath);
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  async #read(): Promise<AssistantModelPreferencesFile> {
    let source: string;
    try {
      source = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, scopes: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error("Assistant model preferences are not valid JSON.");
    }
    if (!isPreferencesFile(parsed)) throw new Error("Assistant model preferences are invalid.");
    return parsed;
  }

  async #scopeKey(spaceRoot: string): Promise<string> {
    const normalizedRoot = rootKey(spaceRoot);
    if (this.#managementRoot && normalizedRoot === this.#managementRoot) return "management";
    try {
      const source = await readFile(join(spaceRoot, ".work-fold", "space.json"), "utf8");
      const parsed = JSON.parse(source) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.trim()) return `space:${parsed.id.trim()}`;
    } catch {
      // Unregistered test and management roots fall back to a non-content path key.
    }
    return `root:${createHash("sha256").update(normalizedRoot).digest("hex")}`;
  }
}

function isPreferencesFile(value: unknown): value is AssistantModelPreferencesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; scopes?: unknown };
  if (candidate.version !== 1 || !candidate.scopes || typeof candidate.scopes !== "object" || Array.isArray(candidate.scopes)) return false;
  return Object.values(candidate.scopes).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const model = entry as { provider?: unknown; id?: unknown; updatedAt?: unknown };
    return typeof model.provider === "string" && Boolean(model.provider.trim())
      && typeof model.id === "string" && Boolean(model.id.trim())
      && typeof model.updatedAt === "string" && !Number.isNaN(Date.parse(model.updatedAt));
  });
}

function rootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
