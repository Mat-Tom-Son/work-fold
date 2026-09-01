import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { PiPreferredModel } from "./pi-runtime-config.js";

// Keep one instructions value below the act broker's 8 KiB per-argument cap.
export const maximumAssistantInstructionsLength = 8_000;

interface AssistantPreferencesEntry {
  model?: PiPreferredModel;
  instructions?: string;
  updatedAt: string;
}

interface AssistantPreferencesFile {
  version: 2;
  scopes: Record<string, AssistantPreferencesEntry>;
}

interface LegacyAssistantModelPreferencesFile {
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
    const saved = data.scopes[await this.#scopeKey(spaceRoot)]?.model;
    return saved ? { provider: saved.provider, id: saved.id } : undefined;
  }

  async set(spaceRoot: string, model: PiPreferredModel): Promise<void> {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (!provider || !id) throw new Error("A provider and model are required.");
    const scope = await this.#scopeKey(spaceRoot);
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

  async getInstructions(spaceRoot: string): Promise<string> {
    const data = await this.#read();
    return data.scopes[await this.#scopeKey(spaceRoot)]?.instructions ?? "";
  }

  async setInstructions(spaceRoot: string, instructions: string): Promise<void> {
    const normalized = normalizeAssistantInstructions(instructions);
    const scope = await this.#scopeKey(spaceRoot);
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

  async #write(data: AssistantPreferencesFile): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
  }

  async #read(): Promise<AssistantPreferencesFile> {
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
      throw new Error("Assistant model preferences are not valid JSON.");
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
    if (!isPreferencesFile(parsed)) throw new Error("Assistant preferences are invalid.");
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

function isPreferencesFile(value: unknown): value is AssistantPreferencesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; scopes?: unknown };
  if (candidate.version !== 2 || !candidate.scopes || typeof candidate.scopes !== "object" || Array.isArray(candidate.scopes)) return false;
  return Object.values(candidate.scopes).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const preference = entry as { model?: unknown; instructions?: unknown; updatedAt?: unknown };
    if (typeof preference.updatedAt !== "string" || Number.isNaN(Date.parse(preference.updatedAt))) return false;
    if (preference.instructions !== undefined
      && (typeof preference.instructions !== "string"
        || preference.instructions.length > maximumAssistantInstructionsLength
        || preference.instructions !== normalizeAssistantInstructions(preference.instructions))) return false;
    if (preference.model === undefined) return typeof preference.instructions === "string" && Boolean(preference.instructions);
    if (!preference.model || typeof preference.model !== "object" || Array.isArray(preference.model)) return false;
    const model = preference.model as { provider?: unknown; id?: unknown };
    return typeof model.provider === "string" && Boolean(model.provider.trim())
      && typeof model.id === "string" && Boolean(model.id.trim());
  });
}

function isLegacyPreferencesFile(value: unknown): value is LegacyAssistantModelPreferencesFile {
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

export function normalizeAssistantInstructions(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length > maximumAssistantInstructionsLength) {
    throw new Error(`Space instructions must be ${maximumAssistantInstructionsLength.toLocaleString()} characters or fewer.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new Error("Space instructions contain unsupported control characters.");
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
