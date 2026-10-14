import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PiPreferredModel } from "./pi-runtime-config.js";

/** Instructions ride every turn's system prompt; this only guards against a runaway value. */
export const maximumWorkerInstructionsLength = 1024 * 1024;

interface ModelPreferencesEntry {
  model?: PiPreferredModel;
  instructions?: string;
  updatedAt: string;
}

interface ModelPreferencesFile {
  version: 2;
  scopes: Record<string, ModelPreferencesEntry>;
}

interface LegacyModelPreferencesFile {
  version: 1;
  scopes: Record<string, PiPreferredModel & { updatedAt: string }>;
}

/**
 * Machine-local model choices for each portable work-folder identity and for the
 * work-fold agent. Provider credentials remain in Pi's shared AuthStorage.
 */
export class ModelPreferenceStore {
  readonly #filePath: string;
  readonly #workFoldAgentRootPath?: string;
  #writeQueue = Promise.resolve();

  constructor(options: { filePath: string; workFoldAgentRootPath?: string }) {
    this.#filePath = options.filePath;
    this.#workFoldAgentRootPath = options.workFoldAgentRootPath ? rootKey(options.workFoldAgentRootPath) : undefined;
  }

  async get(workFolderRoot: string): Promise<PiPreferredModel | undefined> {
    const data = await this.#read();
    const saved = data.scopes[await this.#scopeKey(workFolderRoot)]?.model;
    return saved ? { provider: saved.provider, id: saved.id } : undefined;
  }

  async set(workFolderRoot: string, model: PiPreferredModel): Promise<void> {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) throw new Error("A provider and model are required.");
    const scope = await this.#scopeKey(workFolderRoot);
    const write = this.#writeQueue.then(async () => {
      const data = await this.#read();
      data.scopes[scope] = {
        ...data.scopes[scope],
        model: { provider, id },
        updatedAt: new Date().toISOString(),
      };
      await this.#write(data);
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  async getInstructions(workFolderRoot: string): Promise<string> {
    const data = await this.#read();
    return data.scopes[await this.#scopeKey(workFolderRoot)]?.instructions ?? "";
  }

  async setInstructions(workFolderRoot: string, instructions: string): Promise<void> {
    const normalized = normalizeWorkerInstructions(instructions);
    const scope = await this.#scopeKey(workFolderRoot);
    const write = this.#writeQueue.then(async () => {
      const data = await this.#read();
      const current = data.scopes[scope];
      if (!normalized && !current?.model) {
        delete data.scopes[scope];
      } else {
        data.scopes[scope] = {
          ...(current?.model ? { model: current.model } : {}),
          ...(normalized ? { instructions: normalized } : {}),
          updatedAt: new Date().toISOString(),
        };
      }
      await this.#write(data);
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }

  async #write(data: ModelPreferencesFile): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
  }

  async #read(): Promise<ModelPreferencesFile> {
    let source: string;
    try {
      source = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: 2, scopes: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error("Model preferences are not valid JSON.");
    }
    if (isLegacyPreferencesFile(parsed)) {
      return {
        version: 2,
        scopes: Object.fromEntries(Object.entries(parsed.scopes).map(([scope, entry]) => [scope, {
          model: { provider: entry.provider, id: entry.id },
          updatedAt: entry.updatedAt,
        }])),
      };
    }
    if (!isPreferencesFile(parsed)) throw new Error("Model preferences are invalid.");
    return parsed;
  }

  async #scopeKey(workFolderRoot: string): Promise<string> {
    const normalizedRoot = rootKey(workFolderRoot);
    if (this.#workFoldAgentRootPath && normalizedRoot === this.#workFoldAgentRootPath) return "agent";
    try {
      const source = await readFile(join(workFolderRoot, ".work-fold", "work-folder.json"), "utf8");
      const parsed = JSON.parse(source) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.trim()) return `work-folder:${parsed.id.trim()}`;
    } catch {
      // Unregistered test and management roots fall back to a non-content path key.
    }
    return `root:${createHash("sha256").update(normalizedRoot).digest("hex")}`;
  }
}

function isPreferencesFile(value: unknown): value is ModelPreferencesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; scopes?: unknown };
  if (candidate.version !== 2 || !candidate.scopes || typeof candidate.scopes !== "object" || Array.isArray(candidate.scopes)) return false;
  return Object.values(candidate.scopes).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const preference = entry as { model?: unknown; instructions?: unknown; updatedAt?: unknown };
    if (typeof preference.updatedAt !== "string" || Number.isNaN(Date.parse(preference.updatedAt))) return false;
    if (preference.instructions !== undefined
      && (typeof preference.instructions !== "string"
        || preference.instructions.length > maximumWorkerInstructionsLength
        || preference.instructions !== normalizeWorkerInstructions(preference.instructions))) return false;
    if (preference.model === undefined) return typeof preference.instructions === "string" && Boolean(preference.instructions);
    if (!preference.model || typeof preference.model !== "object" || Array.isArray(preference.model)) return false;
    const model = preference.model as { provider?: unknown; id?: unknown };
    return typeof model.provider === "string" && Boolean(model.provider.trim())
      && typeof model.id === "string" && Boolean(model.id.trim());
  });
}

function isLegacyPreferencesFile(value: unknown): value is LegacyModelPreferencesFile {
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

export function normalizeWorkerInstructions(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximumWorkerInstructionsLength) {
    throw new Error(`Worker instructions must be ${maximumWorkerInstructionsLength.toLocaleString()} characters or fewer.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new Error("Worker instructions contain unsupported control characters.");
  }
  return normalized;
}

function rootKey(rootPath: string): string {
  const normalized = resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
