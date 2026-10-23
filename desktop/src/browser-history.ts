/**
 * The built-in browser's history (docs/built-in-browser.md): the pages its
 * tabs visited, kept in one machine-local JSON file beside the browser
 * profile. The address bar suggests from it, the new tab page lists recent
 * pages from it, and the person can clear it.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visits: number;
  lastVisitedAt: string;
}

/** The newest pages kept; the least recently visited go first. */
const entryLimit = 20_000;
const saveDelayMs = 1_000;

export class BrowserHistoryStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #entries: Map<string, BrowserHistoryEntry>;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string, options: { now?: () => Date } = {}) {
    this.#path = path;
    this.#now = options.now ?? (() => new Date());
    this.#entries = readEntries(path);
  }

  /** A page a tab arrived at; a repeat visit counts again and moves it to the front. */
  record(url: string, title = ""): void {
    const key = historyUrl(url);
    if (!key) return;
    const existing = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, {
      url: key,
      title: title.trim() || existing?.title || "",
      visits: (existing?.visits ?? 0) + 1,
      lastVisitedAt: this.#now().toISOString(),
    });
    this.#trim();
    this.#scheduleSave();
  }

  /** A page's title arrives after it loads. */
  retitle(url: string, title: string): void {
    const entry = this.#entries.get(historyUrl(url) ?? "");
    const trimmed = title.trim();
    if (!entry || !trimmed || entry.title === trimmed) return;
    entry.title = trimmed;
    this.#scheduleSave();
  }

  /**
   * Pages matching what someone typed, best first: every word must appear in
   * the address or title; an address that starts with the text ranks first,
   * then pages visited often and lately.
   */
  suggest(text: string, limit = 6): BrowserHistoryEntry[] {
    const query = text.trim().toLowerCase();
    if (!query) return [];
    const words = query.split(/\s+/);
    const now = this.#now().getTime();
    const scored: Array<{ entry: BrowserHistoryEntry; score: number }> = [];
    for (const entry of this.#entries.values()) {
      const address = bareAddress(entry.url);
      const haystack = `${address} ${entry.title.toLowerCase()}`;
      if (!words.every((word) => haystack.includes(word))) continue;
      const days = Math.max(0, (now - Date.parse(entry.lastVisitedAt)) / 86_400_000);
      let score = entry.visits / (1 + days / 7);
      if (address.startsWith(query)) score += 1_000;
      else if (address.split("/")[0]!.split(".").some((label) => label.startsWith(query))) score += 100;
      scored.push({ entry, score });
    }
    return scored.sort((left, right) => right.score - left.score).slice(0, limit).map((item) => ({ ...item.entry }));
  }

  /** The most recently visited pages, newest first, one per address. */
  recent(limit = 8): BrowserHistoryEntry[] {
    return [...this.#entries.values()].reverse().slice(0, limit).map((entry) => ({ ...entry }));
  }

  get size(): number {
    return this.#entries.size;
  }

  async clear(): Promise<void> {
    this.#entries.clear();
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    await this.#save();
  }

  /** Writes what is pending now, as the app quits. */
  async flush(): Promise<void> {
    if (!this.#saveTimer) return await this.#writing;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    await this.#save();
  }

  #trim(): void {
    while (this.#entries.size > entryLimit) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#save();
    }, saveDelayMs);
    this.#saveTimer.unref?.();
  }

  #save(): Promise<void> {
    const snapshot = { version: 1, entries: [...this.#entries.values()] };
    const write = async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    };
    this.#writing = this.#writing.then(write, write).catch(() => undefined);
    return this.#writing;
  }
}

/** The address a visit is kept under: web pages only, without a fragment. */
export function historyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/** "news.example.com/today" from "https://www.news.example.com/today". */
function bareAddress(url: string): string {
  return url.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
}

function readEntries(path: string): Map<string, BrowserHistoryEntry> {
  const entries = new Map<string, BrowserHistoryEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return entries;
  }
  const list = (parsed as { version?: unknown; entries?: unknown } | null)?.version === 1 ? (parsed as { entries?: unknown }).entries : null;
  if (!Array.isArray(list)) return entries;
  for (const item of list) {
    const record = item as Partial<BrowserHistoryEntry> | null;
    const url = typeof record?.url === "string" ? historyUrl(record.url) : null;
    if (!url || typeof record?.lastVisitedAt !== "string" || Number.isNaN(Date.parse(record.lastVisitedAt))) continue;
    entries.set(url, {
      url,
      title: typeof record.title === "string" ? record.title.slice(0, 1_000) : "",
      visits: typeof record.visits === "number" && Number.isFinite(record.visits) && record.visits > 0 ? Math.floor(record.visits) : 1,
      lastVisitedAt: record.lastVisitedAt,
    });
  }
  return entries;
}
