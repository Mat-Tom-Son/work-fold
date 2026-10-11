/**
 * The image model a person picked in Settings → AI Models (2026-10-11). One
 * machine-wide choice for every Worker and the work-fold agent; no choice
 * means Automatic (docs/image-generation.md). Machine-local app state, never
 * in a work-folder.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ImageModelChoice {
  provider: string;
  id: string;
}

interface ImageModelPreferenceFile {
  version: 1;
  model?: ImageModelChoice;
  updatedAt: string;
}

export function imageModelPreferencePath(stateRoot: string): string {
  return join(stateRoot, "image-model.json");
}

export class ImageModelPreference {
  readonly #filePath: string;
  #writes = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async get(): Promise<ImageModelChoice | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<ImageModelPreferenceFile>;
      return parsed?.version === 1 ? normalizeImageModelChoice(parsed.model) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Saves a model, or Automatic when `model` is null. */
  set(model: ImageModelChoice | null): Promise<void> {
    const write = this.#writes.catch(() => undefined).then(async () => {
      const file: ImageModelPreferenceFile = { version: 1, ...(model ? { model } : {}), updatedAt: new Date().toISOString() };
      await mkdir(dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filePath);
    });
    this.#writes = write;
    return write;
  }
}

export function normalizeImageModelChoice(value: unknown): ImageModelChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { provider, id } = value as Record<string, unknown>;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  const choice = { provider: provider.trim(), id: id.trim() };
  return choice.provider && choice.id && !/[\u0000-\u001f]/.test(`${choice.provider}${choice.id}`) ? choice : undefined;
}
