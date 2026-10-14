import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import {
  hasWorkFolderAppearanceCustomization,
  normalizeWorkFolderAppearanceCustomization,
  normalizeWorkFolderAppearanceState,
  workFolderAppearanceStateVersion,
  type NormalizeWorkFolderAppearanceOptions,
  type WorkFolderAppearanceState,
} from "../shared/work-folder-appearance.js";
import { workFolderAppearanceFile } from "./state-paths.js";

export interface WorkFolderAppearanceStoreOptions {
  path?: string;
  normalize?: NormalizeWorkFolderAppearanceOptions;
}

export class WorkFolderAppearanceStore {
  readonly #path: string;
  readonly #normalize: NormalizeWorkFolderAppearanceOptions;
  #state: WorkFolderAppearanceState;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: WorkFolderAppearanceStoreOptions, state: WorkFolderAppearanceState) {
    this.#path = options.path ?? workFolderAppearanceFile();
    this.#normalize = options.normalize ?? {};
    this.#state = state;
  }

  static async create(options: WorkFolderAppearanceStoreOptions = {}): Promise<WorkFolderAppearanceStore> {
    const path = options.path ?? workFolderAppearanceFile();
    const candidates = [path, backupPath(path)];
    let firstError: unknown;
    for (const candidate of candidates) {
      const source = await readFile(candidate, "utf8").catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
      if (source === null) continue;
      try {
        const parsed: unknown = JSON.parse(source);
        assertSupportedStateVersion(parsed);
        return new WorkFolderAppearanceStore(
          { ...options, path },
          normalizeWorkFolderAppearanceState(parsed, options.normalize),
        );
      } catch (error) {
        if (isUnsupportedVersionError(error)) throw error;
        firstError ??= error;
      }
    }
    if (firstError) {
      throw new Error(`work-fold could not read work-folder appearance settings: ${errorMessage(firstError)}`);
    }
    return new WorkFolderAppearanceStore(
      { ...options, path },
      { version: workFolderAppearanceStateVersion, revision: 0, customizations: {} },
    );
  }

  snapshot(): WorkFolderAppearanceState {
    return structuredClone(this.#state);
  }

  async replaceWorkFolder(
    workFolderId: string,
    value: unknown,
  ): Promise<WorkFolderAppearanceState> {
    const id = normalizeWorkFolderId(workFolderId);
    const customization = normalizeWorkFolderAppearanceCustomization(value, this.#normalize);
    return this.#update((customizations) => {
      if (hasWorkFolderAppearanceCustomization(customization)) customizations[id] = customization;
      else delete customizations[id];
      return true;
    });
  }

  async removeWorkFolder(workFolderId: string): Promise<WorkFolderAppearanceState> {
    const id = normalizeWorkFolderId(workFolderId);
    return this.#update((customizations) => {
      if (!customizations[id]) return false;
      delete customizations[id];
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  async #update(
    mutate: (customizations: WorkFolderAppearanceState["customizations"]) => boolean,
  ): Promise<WorkFolderAppearanceState> {
    const operation = this.#writeQueue.catch(() => undefined).then(async () => {
      const customizations = structuredClone(this.#state.customizations);
      if (!mutate(customizations)) return this.snapshot();
      const next: WorkFolderAppearanceState = {
        version: workFolderAppearanceStateVersion,
        revision: this.#state.revision + 1,
        customizations,
      };
      await writeAtomicJson(this.#path, next);
      this.#state = next;
      return this.snapshot();
    });
    this.#writeQueue = operation.then(() => undefined);
    return operation;
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await readFile(path).catch((error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (existing) await copyFile(path, backupPath(path));
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!isReplaceRenameError(error)) throw error;
      await unlink(path);
      await rename(temporary, path);
    }
    try {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directory handles are not consistently available on Windows.
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function backupPath(path: string): string {
  return `${path}.bak`;
}

function assertSupportedStateVersion(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const version = (value as Record<string, unknown>).version;
  if (typeof version === "number" && version > workFolderAppearanceStateVersion) {
    throw Object.assign(
      new Error(`work-folder appearance settings use unsupported version ${version}.`),
      { code: "ERR_WORK_FOLD_APPEARANCE_VERSION" },
    );
  }
}

function normalizeWorkFolderId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/.test(normalized)) {
    throw new Error("A valid work-folder id is required.");
  }
  return normalized;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isReplaceRenameError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error.code === "EEXIST" || error.code === "EPERM"),
  );
}

function isUnsupportedVersionError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && error.code === "ERR_WORK_FOLD_APPEARANCE_VERSION",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
