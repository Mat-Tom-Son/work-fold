/**
 * The machine-local record of published pages (docs/pages.md, "Identity and
 * links"): for each page folder ever published, its work-folder id and path,
 * the page id chosen the first time, what was last published, and what the
 * last check-in learned. It lives under the state root at
 * `pages/publications.json`, never in a work-folder: the page id is the only
 * thing that grants access to the page, so it must not travel with a folder.
 * Every change is one atomic file replacement, serialized in process.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../agent/turn-store.js";
import { workFoldStateRoot } from "../state-paths.js";

const storeFormat = "work-fold.page-publications/1";
const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

/** `pg_` plus 26 lowercase base32 characters: 130 random bits. */
export const pageIdPattern = /^pg_[a-z2-7]{26}$/u;

/** A new page id from 130 bits of the operating system's randomness. */
export function createPageId(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(17);
  let text = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && text.length < 26) {
      text += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `pg_${text}`;
}

/** The first 8 characters of a page id: what receipts, logs, and the overview name. */
export function pageIdPrefix(pageId: string): string {
  return pageId.slice(0, 8);
}

export interface PagePublicationRecord {
  workFolderId: string;
  /** The page folder's work-folder-relative path. */
  path: string;
  pageId: string;
  title: string;
  status: "online" | "unpublished";
  revision: number;
  /** Null until the first publish succeeds. */
  publishedAt: string | null;
  updatedAt: string | null;
  /** The content digest of what was last published; null until then. */
  publishedDigest: string | null;
  /** What was uploaded last: the files that went into the document. */
  uploaded: { files: number; bytes: number } | null;
  /** The page service's data revision at the last check-in. */
  dataRevision: number;
  /** The data revision of the `data.sqlite` work-fold last wrote into the page folder. */
  folderDataRevision: number | null;
  entries: number | null;
  lastCheckIn: string | null;
  /** Online entries: "What's new" markers, per table. */
  lastSeen: Record<string, string>;
}

interface PagePublicationFile {
  format: typeof storeFormat;
  pagesOrigin: string | null;
  records: PagePublicationRecord[];
}

export function pagePublicationStorePath(stateRoot = workFoldStateRoot()): string {
  return join(stateRoot, "pages", "publications.json");
}

export class PagePublicationStore {
  readonly #path: string;
  #file: PagePublicationFile | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { path?: string } = {}) {
    this.#path = options.path ?? pagePublicationStorePath();
  }

  get path(): string {
    return this.#path;
  }

  async list(): Promise<PagePublicationRecord[]> {
    return (await this.#load()).records.map(copyRecord);
  }

  async get(workFolderId: string, path: string): Promise<PagePublicationRecord | null> {
    const record = (await this.#load()).records.find((candidate) => candidate.workFolderId === workFolderId && candidate.path === path);
    return record ? copyRecord(record) : null;
  }

  async byPageId(pageId: string): Promise<PagePublicationRecord | null> {
    const record = (await this.#load()).records.find((candidate) => candidate.pageId === pageId);
    return record ? copyRecord(record) : null;
  }

  async pagesOrigin(): Promise<string | null> {
    return (await this.#load()).pagesOrigin;
  }

  /**
   * The page's record, creating it with a new page id the first time. The new
   * record is written before anything is uploaded, so a publish interrupted
   * after the upload still knows its page.
   */
  async ensure(workFolderId: string, path: string, title: string): Promise<PagePublicationRecord> {
    return this.#mutate((file) => {
      const existing = file.records.find((candidate) => candidate.workFolderId === workFolderId && candidate.path === path);
      if (existing) return copyRecord(existing);
      const taken = new Set(file.records.map((record) => record.pageId));
      let pageId = createPageId();
      while (taken.has(pageId)) pageId = createPageId();
      const record: PagePublicationRecord = {
        workFolderId,
        path,
        pageId,
        title,
        status: "unpublished",
        revision: 0,
        publishedAt: null,
        updatedAt: null,
        publishedDigest: null,
        uploaded: null,
        dataRevision: 0,
        folderDataRevision: null,
        entries: null,
        lastCheckIn: null,
        lastSeen: {},
      };
      file.records.push(record);
      return copyRecord(record);
    });
  }

  /** Changes one record by page id. Returns the updated record, or null when there is none. */
  async update(pageId: string, change: (record: PagePublicationRecord) => void): Promise<PagePublicationRecord | null> {
    return this.#mutate((file) => {
      const record = file.records.find((candidate) => candidate.pageId === pageId);
      if (!record) return null;
      const draft = copyRecord(record);
      change(draft);
      Object.assign(record, sanitizeRecord(draft) ?? record);
      return copyRecord(record);
    });
  }

  async setPagesOrigin(origin: string | null): Promise<void> {
    const current = (await this.#load()).pagesOrigin;
    if (origin === current || origin === null) return;
    await this.#mutate((file) => { file.pagesOrigin = origin; });
  }

  async #load(): Promise<PagePublicationFile> {
    if (this.#file) return this.#file;
    let text: string | null = null;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (text === null) {
      this.#file = { format: storeFormat, pagesOrigin: null, records: [] };
      return this.#file;
    }
    const parsed = parseStore(text);
    if (!parsed) {
      // Keep the damaged file for a person to look at; start a fresh record.
      await rename(this.#path, `${this.#path}.damaged-${Date.now()}`).catch(() => undefined);
      this.#file = { format: storeFormat, pagesOrigin: null, records: [] };
      return this.#file;
    }
    this.#file = parsed;
    return this.#file;
  }

  #mutate<T>(change: (file: PagePublicationFile) => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const current = await this.#load();
      const draft: PagePublicationFile = { format: storeFormat, pagesOrigin: current.pagesOrigin, records: current.records.map(copyRecord) };
      const result = change(draft);
      await mkdir(join(this.#path, ".."), { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(draft, null, 2)}\n`);
      this.#file = draft;
      return result;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

function parseStore(text: string): PagePublicationFile | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const file = value as Record<string, unknown>;
  if (file.format !== storeFormat || !Array.isArray(file.records)) return null;
  const records: PagePublicationRecord[] = [];
  for (const entry of file.records) {
    const record = sanitizeRecord(entry);
    if (record) records.push(record);
  }
  return { format: storeFormat, pagesOrigin: typeof file.pagesOrigin === "string" ? file.pagesOrigin : null, records };
}

function sanitizeRecord(value: unknown): PagePublicationRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.workFolderId !== "string" || !record.workFolderId) return null;
  if (typeof record.path !== "string" || !record.path) return null;
  if (typeof record.pageId !== "string" || !pageIdPattern.test(record.pageId)) return null;
  const count = (input: unknown): number => (typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0);
  const time = (input: unknown): string | null => (typeof input === "string" && input ? input : null);
  const lastSeen: Record<string, string> = {};
  if (record.lastSeen && typeof record.lastSeen === "object" && !Array.isArray(record.lastSeen)) {
    for (const [table, seen] of Object.entries(record.lastSeen as Record<string, unknown>)) {
      if (typeof seen === "string" && /^[a-z][a-z0-9_]{0,40}$/u.test(table)) lastSeen[table] = seen;
    }
  }
  const uploaded = record.uploaded && typeof record.uploaded === "object" && !Array.isArray(record.uploaded)
    ? { files: count((record.uploaded as Record<string, unknown>).files), bytes: count((record.uploaded as Record<string, unknown>).bytes) }
    : null;
  return {
    workFolderId: record.workFolderId,
    path: record.path,
    pageId: record.pageId,
    title: typeof record.title === "string" ? record.title : "",
    status: record.status === "online" ? "online" : "unpublished",
    revision: count(record.revision),
    publishedAt: time(record.publishedAt),
    updatedAt: time(record.updatedAt),
    publishedDigest: typeof record.publishedDigest === "string" && /^[0-9a-f]{64}$/u.test(record.publishedDigest) ? record.publishedDigest : null,
    uploaded,
    dataRevision: count(record.dataRevision),
    folderDataRevision: typeof record.folderDataRevision === "number" && Number.isSafeInteger(record.folderDataRevision) && record.folderDataRevision >= 0
      ? record.folderDataRevision
      : null,
    entries: typeof record.entries === "number" && Number.isSafeInteger(record.entries) && record.entries >= 0 ? record.entries : null,
    lastCheckIn: time(record.lastCheckIn),
    lastSeen,
  };
}

function copyRecord(record: PagePublicationRecord): PagePublicationRecord {
  return { ...record, uploaded: record.uploaded ? { ...record.uploaded } : null, lastSeen: { ...record.lastSeen } };
}
