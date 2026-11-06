/**
 * Publishing pages from the desktop (docs/pages.md, "Publishing (stage 2)" →
 * "Desktop"): what a publish uploads and how it is pinned, unpublishing,
 * checking in, and the Online entries the Data view reads.
 *
 * - **Publish** assembles the page folder exactly as Preview does, refuses
 *   with the validation problems when any is an error, and uploads the
 *   document with its title, declaration, file list, and content digest. The
 *   caller runs it as the prepared `page.publish` act (pinned work-folder,
 *   path, and content digest; journal first; at most once; receipt).
 * - **Checking in** asks the bridge for the account's pages and, for each page
 *   whose data revision moved, downloads `data.sqlite` and writes it into the
 *   page folder as one finished file: a temporary file in the same folder,
 *   then a rename. Nothing is written when nothing changed, a folder that is
 *   gone is skipped, and the write holds what other managed writes into a
 *   work-folder hold (the host's `withWorkFolderWrite`).
 * - **Online entries** are read from that `data.sqlite`, opened read-only and
 *   immutable, so reading never creates side files or changes it. Changes go
 *   to the bridge and are followed by a check-in. "What's new" markers for
 *   Online entries live in the publication record, not in the file.
 *
 * A page id grants access to its page, so nothing here puts a whole id or
 * link into an error message or a receipt detail: they name the page by path
 * and the id's first 8 characters.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import type { PageDataRow, PageDataTableSummary, PageDataTableView, PageDeclaration, PageProblem, PageSqlDatabase } from "../../shared/pages/index.js";
import {
  PageCallError,
  applyPageSchema,
  canonicalPageDeclaration,
  ensurePageMetaTable,
  exportPageDataTableCsv,
  listPageDataTables,
  pageDeclarationToJson,
  quotePageIdentifier,
  readPageDataTable,
  readStoredPageDeclaration,
} from "../../shared/pages/index.js";
import { resolveWorkFolderPath } from "../work-folder.js";
import {
  PagesBridgeError,
  PagesBridgeUnavailableError,
  pagesBridgeUnavailableMessage,
  type PagesBridgeDataAction,
  type PagesBridgePage,
  type PagesBridgePublishedFile,
  type WorkFoldPagesBridge,
} from "./page-bridge-client.js";
import { normalizePagePath, PageFolderError, resolvePageFolder } from "./page-folder-files.js";
import { analyzePageFolder, readPageFolderDeclaration } from "./page-inspection.js";
import { PagePublicationStore, pageIdPrefix, type PagePublicationRecord } from "./page-publication-store.js";
import { openPageSqliteDatabase, openPageSqliteReadOnly } from "./page-sqlite.js";

/** The page folder's real visitors' data, written only by checking in. */
export const pageDataFileName = "data.sqlite";
const temporaryDataPrefix = ".data.sqlite.";
const temporaryDataSuffix = ".tmp";
const sqliteHeader = Buffer.from("SQLite format 3\u0000", "latin1");
const pageIdText = /pg_[a-z2-7]{26}/gu;
const containsPageId = /pg_[a-z2-7]{26}/u;

export interface PagePublishingWorkFolder {
  id: string;
  name: string;
  workFolderRoot: string;
}

/** A write into a work-folder ran, or was skipped because something else holds the folder. */
export type PageWorkFolderWriteOutcome<T> = { ran: true; value: T } | { ran: false; reason: string };

export interface PagePublishingOptions {
  /** Absent when this API has no way to reach the bridge (tests, development without the variables). */
  bridge?: WorkFoldPagesBridge | null;
  store: PagePublicationStore;
  /** Registered work-folders, read without touching any folder on disk. */
  listWorkFolders(): Promise<PagePublishingWorkFolder[]>;
  /**
   * Runs one write into a work-folder while holding what other managed writes
   * into it hold. Answers `{ ran: false }` instead of waiting when the folder
   * is busy (a History restore, a deletion), so a check-in retries later.
   */
  withWorkFolderWrite<T>(workFolder: PagePublishingWorkFolder, operation: () => Promise<T>): Promise<PageWorkFolderWriteOutcome<T>>;
  now?: () => Date;
}

/** `{ url, status, revision, publishedAt, changesAvailable, lastCheckIn, dataRevision }`, plus entries. */
export interface PagePublicationView {
  /** The page's link; null until the bridge has said where pages are served. */
  url: string | null;
  status: "online" | "unpublished";
  revision: number;
  publishedAt: string | null;
  changesAvailable: boolean;
  lastCheckIn: string | null;
  dataRevision: number;
  /** Live entries online at the last check-in, when the page service said. */
  entries: number | null;
}

export interface PagePublishedListItem {
  workFolderId: string;
  /** Null when the work-folder is no longer registered here. */
  workFolderName: string | null;
  path: string;
  title: string;
  url: string | null;
  status: "online" | "unpublished";
  publishedAt: string | null;
  changesAvailable: boolean;
}

export interface PagePublishUploaded {
  files: PagesBridgePublishedFile[];
  bytes: number;
}

/** What a publish will upload, read and assembled from the page folder. */
export interface PreparedPagePublish {
  path: string;
  title: string;
  declaration: PageDeclaration;
  html: string;
  files: PagesBridgePublishedFile[];
  bytes: number;
  contentDigest: string;
}

export interface PagePublishResult {
  publication: PagePublicationView;
  uploaded: PagePublishUploaded;
  /** For receipts: path and id prefix, never the id or link. */
  receiptDetail: string;
  /** For the act lane's JSON: the record behind the view. */
  idPrefix: string;
  title: string;
  path: string;
}

/** A refusal the local API answers as `{ error, code, problems? }`. */
export class PagePublishError extends Error {
  readonly statusCode: number;
  readonly code: "WEB_ACCESS_REQUIRED" | "PAGE_HAS_PROBLEMS" | "NOT_PUBLISHED" | "PAGE_CHANGED";
  readonly problems?: PageProblem[];
  constructor(statusCode: number, code: PagePublishError["code"], message: string, problems?: PageProblem[]) {
    super(message);
    this.name = "PagePublishError";
    this.statusCode = statusCode;
    this.code = code;
    if (problems) this.problems = problems;
  }
}

export interface PageCheckInSummary {
  /** False when Web Access isn't available; nothing was asked. */
  checkedIn: boolean;
  /** Pages whose `data.sqlite` was written into the folder. */
  written: number;
  /** Pages whose folder copy is waiting for a later check-in (busy or failed). */
  deferred: number;
  error?: string;
}

/** The content digest a publish pins: the canonical declaration and the assembled document. */
export function pageContentDigest(declaration: PageDeclaration, html: string): string {
  return createHash("sha256")
    .update("work-fold.page-content/1\n", "utf8")
    .update(canonicalPageDeclaration(declaration), "utf8")
    .update("\n", "utf8")
    .update(html, "utf8")
    .digest("hex");
}

/** Replaces any whole page id in text with its first 8 characters. */
export function redactPageIds(text: string): string {
  return text.replace(pageIdText, (id) => `${pageIdPrefix(id)}…`);
}

export function pagePublicationReceiptDetail(action: string, record: { path: string; pageId: string }, extra = ""): string {
  const path = record.path.length > 200 ? `${record.path.slice(0, 199)}…` : record.path;
  return `${action}; page ${path}; id ${pageIdPrefix(record.pageId)}${extra ? `; ${extra}` : ""}`;
}

export class PagePublishingService {
  readonly #bridge: WorkFoldPagesBridge | null;
  readonly #store: PagePublicationStore;
  readonly #options: PagePublishingOptions;
  readonly #now: () => Date;
  readonly #pageLocks = new Map<string, Promise<unknown>>();
  #inFlight: Promise<PageCheckInSummary> | null = null;
  #queued: Promise<PageCheckInSummary> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #startup: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(options: PagePublishingOptions) {
    this.#bridge = options.bridge ?? null;
    this.#store = options.store;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get store(): PagePublicationStore {
    return this.#store;
  }

  // -------------------------------------------------------------------------
  // Availability and views.

  async availability(): Promise<{ available: boolean; unavailableReason: string | null }> {
    if (!this.#bridge) return { available: false, unavailableReason: pagesBridgeUnavailableMessage("not-set-up") };
    const connection = await this.#bridge.connection().catch(() => ({ unavailable: "not-set-up" as const }));
    return "unavailable" in connection
      ? { available: false, unavailableReason: pagesBridgeUnavailableMessage(connection.unavailable) }
      : { available: true, unavailableReason: null };
  }

  /** `GET …/pages/publication?page=`. */
  async publicationFor(workFolder: PagePublishingWorkFolder, page: unknown): Promise<{ available: boolean; unavailableReason: string | null; publication: PagePublicationView | null }> {
    const path = normalizePagePath(page);
    const [availability, record] = await Promise.all([this.availability(), this.#store.get(workFolder.id, path)]);
    return { ...availability, publication: record?.publishedAt ? await this.#view(record, workFolder.workFolderRoot) : null };
  }

  /** `GET /api/pages/published`: every page published from this computer, newest first. */
  async listPublished(): Promise<PagePublishedListItem[]> {
    const records = (await this.#store.list()).filter((record) => record.publishedAt);
    const workFolders = new Map((await this.#options.listWorkFolders()).map((workFolder) => [workFolder.id, workFolder]));
    const items: PagePublishedListItem[] = [];
    for (const record of records) {
      const workFolder = workFolders.get(record.workFolderId) ?? null;
      const view = await this.#view(record, workFolder?.workFolderRoot ?? null);
      items.push({
        workFolderId: record.workFolderId,
        workFolderName: workFolder?.name ?? null,
        path: record.path,
        title: record.title,
        url: view.url,
        status: view.status,
        publishedAt: view.publishedAt,
        changesAvailable: view.changesAvailable,
      });
    }
    return items.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.path.localeCompare(b.path, "en"));
  }

  /** The act lane's view of one record: the view plus the id prefix. */
  async actView(record: PagePublicationRecord, workFolderRoot: string | null): Promise<PagePublicationView & { idPrefix: string }> {
    return { ...(await this.#view(record, workFolderRoot)), idPrefix: pageIdPrefix(record.pageId) };
  }

  async #view(record: PagePublicationRecord, workFolderRoot: string | null): Promise<PagePublicationView> {
    return {
      url: await this.#url(record.pageId),
      status: record.status,
      revision: record.revision,
      publishedAt: record.publishedAt,
      changesAvailable: workFolderRoot ? await this.#changesAvailable(record, workFolderRoot) : false,
      lastCheckIn: record.lastCheckIn,
      dataRevision: record.dataRevision,
      entries: record.entries,
    };
  }

  async #url(pageId: string): Promise<string | null> {
    const origin = await this.#store.pagesOrigin();
    return origin ? `${origin}/p/${pageId}` : null;
  }

  /**
   * Compares the digest of the assembled document plus page.json with what was
   * last published. A page that can't be assembled now (it has errors) has
   * changes; a folder that is gone has none to publish.
   */
  async #changesAvailable(record: PagePublicationRecord, workFolderRoot: string): Promise<boolean> {
    let analysis: Awaited<ReturnType<typeof analyzePageFolder>>;
    try {
      analysis = await analyzePageFolder(workFolderRoot, record.path, "assemble");
    } catch {
      return false;
    }
    if (!analysis.html || !analysis.declaration) return true;
    return pageContentDigest(analysis.declaration, analysis.html) !== record.publishedDigest;
  }

  // -------------------------------------------------------------------------
  // Publishing.

  /** Throws WEB_ACCESS_REQUIRED unless a call would reach the bridge now. */
  async requireAvailable(): Promise<WorkFoldPagesBridge> {
    if (!this.#bridge) throw new PagePublishError(409, "WEB_ACCESS_REQUIRED", pagesBridgeUnavailableMessage("not-set-up"));
    const connection = await this.#bridge.connection();
    if ("unavailable" in connection) throw new PagePublishError(409, "WEB_ACCESS_REQUIRED", pagesBridgeUnavailableMessage(connection.unavailable));
    return this.#bridge;
  }

  /**
   * Reads, checks, and assembles the page folder exactly as Preview does.
   * Refuses with every problem when any is an error.
   */
  async prepare(workFolder: PagePublishingWorkFolder, page: unknown): Promise<PreparedPagePublish> {
    const analysis = await analyzePageFolder(workFolder.workFolderRoot, page, "assemble");
    const errors = analysis.problems.filter((problem) => problem.severity === "error");
    if (errors.length || !analysis.html || !analysis.declaration) {
      throw new PagePublishError(
        422,
        "PAGE_HAS_PROBLEMS",
        `${analysis.page.path} has ${errors.length || 1} problem${errors.length === 1 ? "" : "s"} to fix before it can be published.`,
        analysis.problems,
      );
    }
    const files = analysis.files.map((file) => ({ path: file.path, bytes: file.size }));
    return {
      path: analysis.page.path,
      title: analysis.declaration.title,
      declaration: analysis.declaration,
      html: analysis.html,
      files,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      contentDigest: pageContentDigest(analysis.declaration, analysis.html),
    };
  }

  /**
   * Uploads one prepared page under its page id (chosen and recorded the first
   * time), records what was published, and checks in. The caller has already
   * pinned and rechecked `prepared` (the `page.publish` act).
   */
  async upload(workFolder: PagePublishingWorkFolder, prepared: PreparedPagePublish): Promise<PagePublishResult> {
    const bridge = await this.requireAvailable();
    return this.#withPageLock(workFolder.id, prepared.path, async () => {
      const record = await this.#store.ensure(workFolder.id, prepared.path, prepared.title);
      let page: PagesBridgePage;
      let pagesOrigin: string | null;
      try {
        ({ page, pagesOrigin } = await bridge.publish(record.pageId, {
          title: prepared.title,
          html: prepared.html,
          declaration: pageDeclarationToJson(prepared.declaration),
          files: prepared.files,
          contentDigest: prepared.contentDigest,
        }));
      } catch (error) {
        throw scrubbed(error);
      }
      if (pagesOrigin) await this.#store.setPagesOrigin(pagesOrigin);
      const at = this.#now().toISOString();
      const updated = await this.#store.update(record.pageId, (draft) => {
        draft.title = prepared.title;
        draft.status = page.status;
        draft.revision = page.revision;
        draft.publishedAt = page.publishedAt ?? draft.publishedAt ?? at;
        draft.updatedAt = page.updatedAt ?? at;
        draft.publishedDigest = prepared.contentDigest;
        draft.uploaded = { files: prepared.files.length, bytes: prepared.bytes };
        draft.dataRevision = page.dataRevision;
        draft.entries = page.entries;
      });
      // The list says where pages are served and brings any data down.
      await this.checkIn().catch(() => undefined);
      const current = (await this.#store.byPageId(record.pageId)) ?? updated ?? record;
      return {
        publication: await this.#view(current, workFolder.workFolderRoot),
        uploaded: { files: prepared.files, bytes: prepared.bytes },
        receiptDetail: pagePublicationReceiptDetail("page.publish", current, `revision ${current.revision}; ${prepared.files.length} files, ${prepared.bytes} bytes`),
        idPrefix: pageIdPrefix(current.pageId),
        title: current.title,
        path: current.path,
      };
    });
  }

  /** Takes a published page offline. Its entries stay online and in the folder; publishing again brings back the same link. */
  async unpublish(workFolder: PagePublishingWorkFolder, page: unknown): Promise<{ publication: PagePublicationView; receiptDetail: string; record: PagePublicationRecord }> {
    const path = normalizePagePath(page);
    const record = await this.#store.get(workFolder.id, path);
    if (!record?.publishedAt) throw new PagePublishError(404, "NOT_PUBLISHED", `${path} isn't published.`);
    const bridge = await this.requireAvailable();
    return this.#withPageLock(workFolder.id, path, async () => {
      let answered: { page: PagesBridgePage } | null;
      try {
        answered = await bridge.unpublish(record.pageId);
      } catch (error) {
        throw scrubbed(error);
      }
      const at = this.#now().toISOString();
      const updated = (await this.#store.update(record.pageId, (draft) => {
        draft.status = "unpublished";
        draft.updatedAt = answered?.page.updatedAt ?? at;
        if (answered) {
          draft.revision = answered.page.revision;
          draft.dataRevision = answered.page.dataRevision;
          draft.entries = answered.page.entries;
        }
      })) ?? record;
      await this.checkIn().catch(() => undefined);
      const current = (await this.#store.byPageId(record.pageId)) ?? updated;
      return {
        publication: await this.#view(current, workFolder.workFolderRoot),
        receiptDetail: pagePublicationReceiptDetail("page.unpublish", current, answered ? "unpublished" : "was already offline"),
        record: current,
      };
    });
  }

  async #withPageLock<T>(workFolderId: string, path: string, operation: () => Promise<T>): Promise<T> {
    const key = `${workFolderId}\u0000${path}`;
    const previous = this.#pageLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const settled = run.catch(() => undefined);
    this.#pageLocks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#pageLocks.get(key) === settled) this.#pageLocks.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Checking in.

  /** Starts checking in now and then every `intervalMs` while running. 0 turns both off. */
  start(intervalMs: number): void {
    if (this.#closed || intervalMs <= 0 || !this.#bridge) return;
    this.#startup = setTimeout(() => { void this.checkIn().catch(() => undefined); }, 0);
    this.#startup.unref?.();
    this.#timer = setInterval(() => { void this.checkIn().catch(() => undefined); }, intervalMs);
    this.#timer.unref?.();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#startup) clearTimeout(this.#startup);
    if (this.#timer) clearInterval(this.#timer);
    this.#startup = null;
    this.#timer = null;
    await this.#inFlight?.catch(() => undefined);
    await this.#queued?.catch(() => undefined);
  }

  /**
   * One check-in: list the account's pages, record what changed, and bring
   * down `data.sqlite` for each page whose data revision moved. A check-in
   * asked for while one runs waits for it and runs once more after it.
   */
  checkIn(): Promise<PageCheckInSummary> {
    if (!this.#inFlight) {
      const run = this.#checkInOnce().finally(() => { if (this.#inFlight === run) this.#inFlight = null; });
      this.#inFlight = run;
      return run;
    }
    this.#queued ??= this.#inFlight.catch(() => undefined).then(() => {
      this.#queued = null;
      return this.checkIn();
    });
    return this.#queued;
  }

  async #checkInOnce(): Promise<PageCheckInSummary> {
    if (this.#closed || !this.#bridge) return { checkedIn: false, written: 0, deferred: 0 };
    const connection = await this.#bridge.connection().catch(() => ({ unavailable: "not-set-up" as const }));
    if ("unavailable" in connection) return { checkedIn: false, written: 0, deferred: 0 };
    // A record without publishedAt is a publish that may have been interrupted
    // after its upload; the list tells it what happened.
    const records = await this.#store.list();
    if (!records.length) {
      // Nothing published from here yet; nothing to bring down.
      return { checkedIn: true, written: 0, deferred: 0 };
    }
    let list: Awaited<ReturnType<WorkFoldPagesBridge["list"]>>;
    try {
      list = await this.#bridge.list();
    } catch (error) {
      return { checkedIn: false, written: 0, deferred: 0, error: redactPageIds(error instanceof Error ? error.message : String(error)) };
    }
    if (list.pagesOrigin) await this.#store.setPagesOrigin(list.pagesOrigin);
    const remote = new Map(list.pages.map((page) => [page.pageId, page]));
    const workFolders = new Map((await this.#options.listWorkFolders()).map((workFolder) => [workFolder.id, workFolder]));
    const at = this.#now().toISOString();
    let written = 0;
    let deferred = 0;
    for (const local of await this.#store.list()) {
      const page = remote.get(local.pageId);
      if (!page) continue;
      const record = (await this.#store.update(local.pageId, (draft) => {
        draft.status = page.status;
        draft.revision = page.revision;
        // A publish interrupted after its upload learns its page here.
        draft.publishedAt = page.publishedAt ?? draft.publishedAt;
        draft.updatedAt = page.updatedAt ?? draft.updatedAt;
        draft.dataRevision = page.dataRevision;
        draft.entries = page.entries;
        draft.lastCheckIn = at;
      })) ?? local;
      const workFolder = workFolders.get(record.workFolderId);
      if (!workFolder) continue;
      try {
        const outcome = await this.#bringDataDown(workFolder, record, page);
        if (outcome === "written") written += 1;
        if (outcome === "deferred") deferred += 1;
      } catch {
        deferred += 1;
      }
    }
    return { checkedIn: true, written, deferred };
  }

  /**
   * Writes the page's online database into its folder when the data revision
   * moved since the folder copy was written (or the copy is missing). The new
   * file is complete before it replaces the old one.
   */
  async #bringDataDown(workFolder: PagePublishingWorkFolder, record: PagePublicationRecord, page: PagesBridgePage): Promise<"unchanged" | "written" | "deferred" | "skipped"> {
    const bridge = this.#bridge;
    if (!bridge) return "skipped";
    const root = workFolder.workFolderRoot;
    try {
      await resolvePageFolder(root, record.path);
    } catch {
      return "skipped";
    }
    const target = resolveWorkFolderPath(root, `${record.path}/${pageDataFileName}`);
    const existing = await lstat(target).catch(() => null);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) return "skipped";
    // A page nobody has made an entry on gets no folder copy yet: an
    // announcement page never grows a data.sqlite.
    if (!existing && (page.dataRevision === 0 || page.entries === 0)) return "unchanged";
    if (existing && record.folderDataRevision === page.dataRevision) return "unchanged";
    const snapshot = await bridge.downloadData(record.pageId);
    const bytes = Buffer.from(snapshot.bytes.buffer, snapshot.bytes.byteOffset, snapshot.bytes.byteLength);
    if (bytes.length < sqliteHeader.length || !bytes.subarray(0, sqliteHeader.length).equals(sqliteHeader)) {
      throw new PagesBridgeError(502, "work-fold.com sent page data work-fold couldn't read.");
    }
    const revision = snapshot.dataRevision ?? page.dataRevision;
    if (existing) {
      const current = await readFile(target).catch(() => null);
      if (current && current.equals(bytes)) {
        await this.#store.update(record.pageId, (draft) => { draft.folderDataRevision = revision; });
        return "unchanged";
      }
    }
    const outcome = await this.#options.withWorkFolderWrite(workFolder, async () => {
      // Recheck inside the hold: the folder may have moved or changed meanwhile.
      const folder = await resolvePageFolder(root, record.path);
      const now = await lstat(target).catch(() => null);
      if (now && (!now.isFile() || now.isSymbolicLink())) return false;
      await removeLeftoverTemporaryFiles(folder);
      const temporary = join(folder, `${temporaryDataPrefix}${randomBytes(8).toString("hex")}${temporaryDataSuffix}`);
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close().catch(() => undefined);
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return true;
    });
    if (!outcome.ran) return "deferred";
    if (!outcome.value) return "skipped";
    await this.#store.update(record.pageId, (draft) => { draft.folderDataRevision = revision; });
    return "written";
  }

  // -------------------------------------------------------------------------
  // Online entries.

  /** `GET …/pages/online/data?page=`: every table, with this computer's "What's new" markers. */
  async onlineTables(workFolder: PagePublishingWorkFolder, page: unknown): Promise<{ tables: PageDataTableSummary[] }> {
    return this.#withOnlineData(workFolder, page, ({ db, declaration, record }) => ({
      tables: listPageDataTables(db, declaration).map((table) => {
        const lastSeen = record.lastSeen[table.name] ?? null;
        const name = quotePageIdentifier(table.name);
        const fresh = db.get(
          `SELECT COUNT(*) AS "count" FROM ${name} WHERE "_deleted" IS NULL AND (? IS NULL OR "_created" > ?)`,
          [lastSeen, lastSeen],
        );
        return { ...table, newCount: Number(fresh?.count ?? 0), lastSeen };
      }),
    }));
  }

  /** `GET …/pages/online/data?page=&table=&deleted=`. */
  async onlineTable(workFolder: PagePublishingWorkFolder, page: unknown, table: string, deleted: boolean): Promise<PageDataTableView> {
    return this.#withOnlineData(workFolder, page, ({ db, declaration, record }) => ({
      ...readPageDataTable(db, declaration, table, { deleted }),
      lastSeen: record.lastSeen[table] ?? null,
    }));
  }

  /** `GET …/pages/online/data/export?page=&table=`. */
  async onlineExport(workFolder: PagePublishingWorkFolder, page: unknown, table: string): Promise<string> {
    return this.#withOnlineData(workFolder, page, ({ db, declaration }) => exportPageDataTableCsv(db, declaration, table));
  }

  /** `POST …/pages/online/data/seen`: "What's new" counts from now, on this computer. */
  async markOnlineSeen(workFolder: PagePublishingWorkFolder, page: unknown, table: string): Promise<{ lastSeen: string }> {
    const record = await this.#requirePublished(workFolder, page);
    const lastSeen = this.#now().toISOString();
    await this.#store.update(record.pageId, (draft) => { draft.lastSeen = { ...draft.lastSeen, [table]: lastSeen }; });
    return { lastSeen };
  }

  /**
   * `POST …/pages/online/data/(update|delete|restore)`: the change goes to the
   * page service through the bridge, then work-fold checks in so the folder's
   * copy shows it. Answers the preview routes' shapes.
   */
  async changeOnline(
    workFolder: PagePublishingWorkFolder,
    action: PagesBridgeDataAction,
    body: Record<string, unknown>,
  ): Promise<{ value: { row: PageDataRow } | { deleted: number } | { restored: number }; receiptDetail: string }> {
    const record = await this.#requirePublished(workFolder, body.page);
    const table = typeof body.table === "string" ? body.table : "";
    const bridge = await this.requireAvailable();
    const change = action === "update"
      ? { table, id: body.id, values: body.values }
      : { table, ids: body.ids };
    let answer: Record<string, unknown>;
    try {
      answer = await bridge.changeData(record.pageId, action, change);
    } catch (error) {
      throw scrubbed(error);
    }
    await this.checkIn().catch(() => undefined);
    const count = (key: "deleted" | "restored"): number => (typeof answer[key] === "number" ? answer[key] as number : 0);
    if (action === "update") {
      if (!answer.row || typeof answer.row !== "object") throw new PagesBridgeError(502, "work-fold.com sent an answer work-fold couldn't read.");
      return { value: { row: answer.row as PageDataRow }, receiptDetail: pagePublicationReceiptDetail("page.data.update", record, `table ${table}; 1 entry`) };
    }
    const changed = count(action === "delete" ? "deleted" : "restored");
    return {
      value: action === "delete" ? { deleted: changed } : { restored: changed },
      receiptDetail: pagePublicationReceiptDetail(`page.data.${action}`, record, `table ${table}; ${changed} entr${changed === 1 ? "y" : "ies"}`),
    };
  }

  async #requirePublished(workFolder: PagePublishingWorkFolder, page: unknown): Promise<PagePublicationRecord> {
    const path = normalizePagePath(page);
    await resolvePageFolder(workFolder.workFolderRoot, path);
    const record = await this.#store.get(workFolder.id, path);
    if (!record?.publishedAt) throw new PagePublishError(404, "NOT_PUBLISHED", `${path} isn't published, so it has no online entries.`);
    return record;
  }

  /**
   * Opens the page folder's `data.sqlite` read-only and immutable. Before the
   * first check-in brings one down, the tables come from page.json with no
   * entries, in memory. The declaration is the one the page service applied
   * (stored in the file), or page.json's while there is no file.
   */
  async #withOnlineData<T>(
    workFolder: PagePublishingWorkFolder,
    page: unknown,
    operation: (input: { db: PageSqlDatabase; declaration: PageDeclaration | null; record: PagePublicationRecord }) => T,
  ): Promise<T> {
    const record = await this.#requirePublished(workFolder, page);
    const target = resolveWorkFolderPath(workFolder.workFolderRoot, `${record.path}/${pageDataFileName}`);
    const info = await lstat(target).catch(() => null);
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new PageCallError("UNAVAILABLE", `${record.path}/${pageDataFileName} isn't an ordinary file, so its online entries can't be read.`);
    }
    if (!info) {
      const read = await readPageFolderDeclaration(workFolder.workFolderRoot, record.path);
      const db = openPageSqliteDatabase(":memory:");
      try {
        ensurePageMetaTable(db);
        if (read.declaration) applyPageSchema(db, read.declaration, this.#now());
        return operation({ db, declaration: read.declaration, record });
      } finally {
        db.close();
      }
    }
    let db: ReturnType<typeof openPageSqliteReadOnly>;
    try {
      db = openPageSqliteReadOnly(target);
    } catch {
      await this.#store.update(record.pageId, (draft) => { draft.folderDataRevision = null; });
      throw new PageCallError("UNAVAILABLE", "The online entries in this page folder couldn't be read. work-fold brings a fresh copy at the next check-in.");
    }
    try {
      let declaration: PageDeclaration | null;
      try {
        declaration = readStoredPageDeclaration(db);
      } catch {
        await this.#store.update(record.pageId, (draft) => { draft.folderDataRevision = null; });
        throw new PageCallError("UNAVAILABLE", "The online entries in this page folder couldn't be read. work-fold brings a fresh copy at the next check-in.");
      }
      if (!declaration) declaration = (await readPageFolderDeclaration(workFolder.workFolderRoot, record.path)).declaration;
      return operation({ db, declaration, record });
    } finally {
      db.close();
    }
  }
}

/** Temporary files a check-in left behind when it was interrupted. Only work-fold makes them. */
async function removeLeftoverTemporaryFiles(folder: string): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (name.startsWith(temporaryDataPrefix) && name.endsWith(temporaryDataSuffix) && /^\.data\.sqlite\.[0-9a-f]{16}\.tmp$/u.test(name)) {
      await rm(join(folder, name), { force: true }).catch(() => undefined);
    }
  }
}

/** Errors leaving this module never carry a whole page id. */
function scrubbed(error: unknown): unknown {
  if (!(error instanceof Error) || !containsPageId.test(error.message)) return error;
  if (error instanceof PageCallError) return new PageCallError(error.code, redactPageIds(error.message), error.field);
  if (error instanceof PagesBridgeError) return new PagesBridgeError(error.status, redactPageIds(error.message));
  if (error instanceof PagesBridgeUnavailableError) return error;
  if (error instanceof PageFolderError) return new PageFolderError(error.statusCode, redactPageIds(error.message));
  return new Error(redactPageIds(error.message));
}
