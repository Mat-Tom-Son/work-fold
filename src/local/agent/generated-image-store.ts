/**
 * Pictures generate_image makes (2026-10-11). Each is kept in work-fold's own
 * app state, outside every work-folder, so a Chat can show it inline and the
 * person can copy it or add it to the folder later. A Chat log carries only
 * the picture's id and size, never its bytes (docs/image-generation.md).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const idPattern = /^[0-9a-f]{32}$/;
const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export interface GeneratedImageRecord {
  id: string;
  /** The file name to use when the picture is added to a folder. */
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
  /** Where the person added it, by work-folder id: work-folder-relative paths. */
  added?: Record<string, string>;
}

export function isGeneratedImageId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

export class GeneratedImageStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Saves the bytes and returns the record plus the absolute path of the stored file. */
  async save(bytes: Buffer, mimeType: string, name: string): Promise<GeneratedImageRecord & { file: string }> {
    const extension = extensions[mimeType];
    if (!extension) throw new Error(`Unsupported picture type ${mimeType}.`);
    const id = randomBytes(16).toString("hex");
    const record: GeneratedImageRecord = {
      id,
      name: safeFileName(name, extension),
      mimeType,
      size: bytes.length,
      sha256: sha256(bytes),
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const file = this.filePath(id, mimeType);
    await writeFile(file, bytes, { mode: 0o600 });
    await this.#writeRecord(record);
    return { ...record, file };
  }

  async get(id: string): Promise<GeneratedImageRecord | null> {
    if (!isGeneratedImageId(id)) return null;
    try {
      const parsed = JSON.parse(await readFile(join(this.root, `${id}.json`), "utf8")) as GeneratedImageRecord;
      return parsed?.id === id && typeof parsed.mimeType === "string" && extensions[parsed.mimeType]
        && typeof parsed.size === "number" && typeof parsed.sha256 === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  async read(id: string): Promise<{ record: GeneratedImageRecord; bytes: Buffer } | null> {
    const record = await this.get(id);
    if (!record) return null;
    const bytes = await readFile(this.filePath(id, record.mimeType)).catch(() => null);
    return bytes ? { record, bytes } : null;
  }

  /** Remembers where the person added the picture, so the Chat can offer Show in Files. */
  async noteAdded(id: string, workFolderId: string, path: string): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    await this.#writeRecord({ ...record, added: { ...record.added, [workFolderId]: path } });
  }

  /** True while `file` is still this picture, so a different file under the same name never counts. */
  async matches(record: GeneratedImageRecord, file: string): Promise<boolean> {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size !== record.size) return false;
    return sha256(await readFile(file)) === record.sha256;
  }

  filePath(id: string, mimeType: string): string {
    return join(this.root, `${id}${extensions[mimeType] ?? ".png"}`);
  }

  async #writeRecord(record: GeneratedImageRecord): Promise<void> {
    const target = join(this.root, `${record.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A plain file name with the picture's own extension; never a path. */
function safeFileName(name: string, extension: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[\u0000-\u001f<>:"|?*]/g, "").trim().slice(0, 120);
  return `${base || "Image"}${extension}`;
}
