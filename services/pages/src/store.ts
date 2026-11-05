/**
 * The page service's storage (docs/pages.md, "Page service"). Under the data
 * directory (the volume):
 *
 *   registry.sqlite                 every page: account, title, status, active
 *                                   revision, timestamps, data revision
 *   pages/<pageId>/rev-<n>.html     the assembled document of revision n
 *   pages/<pageId>/data.sqlite      the page's entries (the shared rules engine's layout)
 *   tmp/                            temporary files; emptied at startup
 *
 * The data revision lives in each page database's `_page_meta` and changes in
 * the same transaction as the data, so a snapshot always carries the revision
 * it was taken at; the registry mirrors it for listing. It moves whenever
 * entries change (visitor calls, the owner's edits, deletes and restores, the
 * 30-day purge) and when publishing adds tables or columns. Everything here is
 * synchronous except file writes; node:sqlite runs on the one event loop, so
 * two requests never interleave inside a database operation.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { PageDeclaration, PageSqlDatabase } from "../../../src/shared/pages/index.js";
import {
  applyPageSchema,
  ensurePageMetaTable,
  listStoredPageTables,
  pageDeclarationToJson,
  parsePageDeclaration,
  purgeDeletedPageRows,
  quotePageIdentifier,
  readPageMeta,
  runInPageTransaction,
  storedColumnNames,
  writePageMeta,
} from "../../../src/shared/pages/index.js";
import type { PageSqliteDatabase } from "../../../src/local/pages/page-sqlite.js";
import { openPageSqliteDatabase } from "../../../src/local/pages/page-sqlite.js";
import { HttpError } from "./http.js";
import { isAccountId, isPageId } from "./ids.js";

export type PageStatus = "online" | "unpublished";

/** A page as the internal routes answer it (docs/pages.md, "Internal routes"). */
export interface PublishedPage {
  pageId: string;
  title: string;
  status: PageStatus;
  revision: number;
  publishedAt: string;
  updatedAt: string;
  dataRevision: number;
  entries: number;
}

export interface PageRecord extends PublishedPage {
  accountId: string;
  contentDigest: string;
  /** The active declaration as stored; `PageStore.declarationOf` parses it once per revision. */
  declarationJson: string;
  files: PublishedFile[];
  createdAt: string;
  backupDataRevision: number | null;
  backupRevision: number | null;
}

export interface PublishedFile {
  path: string;
  bytes: number | null;
}

export interface PublishInput {
  title: string;
  html: string;
  declaration: PageDeclaration;
  files: PublishedFile[];
  contentDigest: string;
}

export interface PageStoreOptions {
  dataDir: string;
  now?: () => Date;
  /** Open page databases kept at once; older ones are closed. */
  maxOpenDatabases?: number;
}

const registrySchema = `
CREATE TABLE IF NOT EXISTS "pages" (
  "page_id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('online', 'unpublished')),
  "revision" INTEGER NOT NULL,
  "content_digest" TEXT NOT NULL,
  "declaration" TEXT NOT NULL,
  "files" TEXT NOT NULL,
  "created_at" TEXT NOT NULL,
  "published_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "data_revision" INTEGER NOT NULL DEFAULT 0,
  "entries" INTEGER NOT NULL DEFAULT 0,
  "backup_data_revision" INTEGER,
  "backup_revision" INTEGER
);
CREATE INDEX IF NOT EXISTS "pages_account_idx" ON "pages" ("account_id", "updated_at");
CREATE TABLE IF NOT EXISTS "registry_meta" ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL);
`;

const revisionFile = /^rev-(\d{1,9})\.html$/u;

export class PageStore {
  readonly dataDir: string;
  readonly tmpDir: string;
  private readonly now: () => Date;
  private readonly maxOpenDatabases: number;
  private registry: PageSqliteDatabase | null = null;
  private readonly databases = new Map<string, PageSqliteDatabase>();
  private readonly declarations = new Map<string, { revision: number; declaration: PageDeclaration }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: PageStoreOptions) {
    this.dataDir = options.dataDir;
    this.tmpDir = join(options.dataDir, "tmp");
    this.now = options.now ?? (() => new Date());
    this.maxOpenDatabases = Math.max(1, options.maxOpenDatabases ?? 64);
  }

  /** Creates the layout, opens the registry, and brings each page's mirrored data revision up to date. */
  open(): void {
    mkdirSync(join(this.dataDir, "pages"), { recursive: true });
    rmSync(this.tmpDir, { recursive: true, force: true });
    mkdirSync(this.tmpDir, { recursive: true });
    const registry = openPageSqliteDatabase(join(this.dataDir, "registry.sqlite"));
    registry.exec("PRAGMA journal_mode = WAL");
    registry.exec(registrySchema);
    this.registry = registry;
    for (const row of registry.all(`SELECT "page_id" FROM "pages"`)) {
      const pageId = String(row.page_id);
      if (isPageId(pageId)) this.pageDatabase(pageId);
    }
    this.closeDatabases();
  }

  close(): void {
    this.closeDatabases();
    this.registry?.close();
    this.registry = null;
  }

  private get db(): PageSqliteDatabase {
    if (!this.registry) throw new Error("The page store isn't open.");
    return this.registry;
  }

  pageDir(pageId: string): string {
    if (!isPageId(pageId)) throw new Error("Refusing an unexpected page id.");
    return join(this.dataDir, "pages", pageId);
  }

  documentPath(pageId: string, revision: number): string {
    return join(this.pageDir(pageId), `rev-${revision}.html`);
  }

  // -------------------------------------------------------------------------
  // The registry.

  getPage(pageId: string): PageRecord | null {
    if (!isPageId(pageId)) return null;
    const row = this.db.get(`SELECT * FROM "pages" WHERE "page_id" = ?`, [pageId]);
    return row ? this.toRecord(row) : null;
  }

  /** The page when it belongs to `accountId`; otherwise 404, exactly as for an unknown id. */
  requireOwnedPage(accountId: string, pageId: string): PageRecord {
    const page = this.getPage(pageId);
    if (!page || page.accountId !== accountId) throw new HttpError(404, "NOT_FOUND", "That page doesn't exist.");
    return page;
  }

  listPages(accountId: string): PageRecord[] {
    if (!isAccountId(accountId)) return [];
    return this.db.all(`SELECT * FROM "pages" WHERE "account_id" = ? ORDER BY "updated_at" DESC, "page_id" ASC`, [accountId])
      .map((row) => this.toRecord(row));
  }

  allPageIds(): string[] {
    return this.db.all(`SELECT "page_id" FROM "pages" ORDER BY "page_id"`).map((row) => String(row.page_id)).filter(isPageId);
  }

  /** Changes on every registry write except backup bookkeeping. */
  registryRevision(): number {
    return Number(readRegistryMeta(this.db, "registryRevision") ?? 0);
  }

  backedUpRegistryRevision(): number | null {
    const value = readRegistryMeta(this.db, "backupRegistryRevision");
    return value === null ? null : Number(value);
  }

  markRegistryBackedUp(revision: number): void {
    writeRegistryMeta(this.db, "backupRegistryRevision", String(revision));
  }

  markDataBackedUp(pageId: string, dataRevision: number): void {
    this.db.run(`UPDATE "pages" SET "backup_data_revision" = ? WHERE "page_id" = ?`, [dataRevision, pageId]);
  }

  markRevisionBackedUp(pageId: string, revision: number): void {
    this.db.run(`UPDATE "pages" SET "backup_revision" = ? WHERE "page_id" = ?`, [revision, pageId]);
  }

  // -------------------------------------------------------------------------
  // Publishing.

  /**
   * Publish or publish changes. The same content digest as the active
   * revision makes no new revision (an unpublished page just comes back
   * online); anything else writes the next revision's document, applies the
   * declaration additively, and only then switches the registry, so a failed
   * update leaves the old version up. A page belongs to one account forever.
   */
  publish(accountId: string, pageId: string, input: PublishInput): Promise<PageRecord> {
    return this.withLock(pageId, async () => {
      const existing = this.getPage(pageId);
      if (existing && existing.accountId !== accountId) throw new HttpError(404, "NOT_FOUND", "That page doesn't exist.");
      const now = this.now().toISOString();
      if (existing && existing.contentDigest === input.contentDigest) {
        if (existing.status === "online") return existing;
        this.transactRegistry(() => {
          this.db.run(`UPDATE "pages" SET "status" = 'online', "published_at" = ?, "updated_at" = ? WHERE "page_id" = ?`, [now, now, pageId]);
        });
        return this.getPage(pageId)!;
      }
      const revision = (existing?.revision ?? 0) + 1;
      await mkdir(this.pageDir(pageId), { recursive: true });
      await this.writeFileAtomically(this.documentPath(pageId, revision), input.html);
      // The page database comes up to the new declaration before the switch.
      this.applyDeclaration(pageId, input.declaration);
      const declarationJson = JSON.stringify(pageDeclarationToJson(input.declaration));
      const files = JSON.stringify(input.files);
      this.transactRegistry(() => {
        if (existing) {
          this.db.run(
            `UPDATE "pages" SET "title" = ?, "status" = 'online', "revision" = ?, "content_digest" = ?, "declaration" = ?, "files" = ?, "published_at" = ?, "updated_at" = ? WHERE "page_id" = ?`,
            [input.title, revision, input.contentDigest, declarationJson, files, now, now, pageId],
          );
        } else {
          this.db.run(
            `INSERT INTO "pages" ("page_id", "account_id", "title", "status", "revision", "content_digest", "declaration", "files", "created_at", "published_at", "updated_at") VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?, ?)`,
            [pageId, accountId, input.title, revision, input.contentDigest, declarationJson, files, now, now, now],
          );
        }
      });
      this.declarations.set(pageId, { revision, declaration: input.declaration });
      this.mirrorDataRevision(pageId);
      await this.removeOldRevisions(pageId, revision);
      return this.getPage(pageId)!;
    });
  }

  /** Takes a page offline; its entries and documents stay. */
  unpublish(accountId: string, pageId: string): Promise<PageRecord> {
    return this.withLock(pageId, async () => {
      const page = this.requireOwnedPage(accountId, pageId);
      if (page.status === "unpublished") return page;
      const now = this.now().toISOString();
      this.transactRegistry(() => {
        this.db.run(`UPDATE "pages" SET "status" = 'unpublished', "updated_at" = ? WHERE "page_id" = ?`, [now, pageId]);
      });
      return this.getPage(pageId)!;
    });
  }

  /** The active declaration, parsed once per revision. */
  declarationOf(page: PageRecord): PageDeclaration {
    const cached = this.declarations.get(page.pageId);
    if (cached && cached.revision === page.revision) return cached.declaration;
    const parsed = parsePageDeclaration(JSON.parse(page.declarationJson) as unknown);
    if (!parsed.ok) throw new Error("A stored page declaration no longer parses.");
    this.declarations.set(page.pageId, { revision: page.revision, declaration: parsed.declaration });
    return parsed.declaration;
  }

  // -------------------------------------------------------------------------
  // Page data.

  /** Runs a read against the page's database. */
  readData<T>(pageId: string, operation: (db: PageSqlDatabase) => T): T {
    return operation(this.pageDatabase(pageId));
  }

  /**
   * Runs a change against the page's database in one transaction. When it
   * changed any row, the data revision moves in that same transaction and the
   * registry's mirror follows.
   */
  changeData<T>(pageId: string, operation: (db: PageSqlDatabase) => T): T {
    const db = this.pageDatabase(pageId);
    return this.changeOpenData(pageId, db, operation, (before) => totalChanges(db) !== before);
  }

  /** The page's current data revision, as its database records it. */
  dataRevisionOf(pageId: string): number {
    return readDataRevision(this.pageDatabase(pageId));
  }

  /**
   * Writes a consistent copy of the page's database to a new temporary file
   * and returns it with the data revision it holds. The caller removes it.
   */
  snapshotPageData(pageId: string): { path: string; dataRevision: number } {
    const db = this.pageDatabase(pageId);
    const path = this.tempPath("data.sqlite");
    const dataRevision = readDataRevision(db);
    db.run("VACUUM INTO ?", [path]);
    return { path, dataRevision };
  }

  /** A consistent copy of the registry in a new temporary file, with the registry revision it holds. */
  snapshotRegistry(): { path: string; registryRevision: number } {
    const path = this.tempPath("registry.sqlite");
    const registryRevision = this.registryRevision();
    this.db.run("VACUUM INTO ?", [path]);
    return { path, registryRevision };
  }

  /** Erases rows deleted more than 30 days ago in every open page database. */
  purgeOpenDatabases(): void {
    for (const pageId of [...this.databases.keys()]) this.changeData(pageId, (db) => purgeDeletedPageRows(db, { now: this.now }));
  }

  tempPath(name: string): string {
    return join(this.tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}-${name}`);
  }

  async writeFileAtomically(path: string, contents: string | Buffer): Promise<void> {
    const temporary = this.tempPath("upload");
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    await syncDirectory(join(path, ".."));
  }

  // -------------------------------------------------------------------------

  private applyDeclaration(pageId: string, declaration: PageDeclaration): void {
    const db = this.pageDatabase(pageId);
    // Only additions count as a data change, so a page that collects nothing
    // never gets a data revision and never gets a data.sqlite in its folder.
    let added = false;
    this.changeOpenData(pageId, db, () => {
      const status = applyPageSchema(db, declaration, this.now());
      added = status.added.tables.length > 0 || status.added.columns.length > 0;
    }, () => added);
  }

  private changeOpenData<T>(pageId: string, db: PageSqliteDatabase, operation: (db: PageSqlDatabase) => T, changed: (before: number) => boolean): T {
    const before = totalChanges(db);
    let moved = false;
    const result = runInPageTransaction(db, () => {
      const value = operation(db);
      if (changed(before)) {
        writePageMeta(db, "dataRevision", String(readDataRevision(db) + 1));
        moved = true;
      }
      return value;
    });
    if (moved) this.mirrorDataRevision(pageId);
    return result;
  }

  /** Copies the page database's data revision and live entry count into the registry. */
  private mirrorDataRevision(pageId: string): void {
    const db = this.pageDatabase(pageId);
    const dataRevision = readDataRevision(db);
    const entries = countLiveEntries(db);
    const row = this.db.get(`SELECT "data_revision", "entries" FROM "pages" WHERE "page_id" = ?`, [pageId]);
    if (!row || (Number(row.data_revision) === dataRevision && Number(row.entries) === entries)) return;
    this.transactRegistry(() => {
      this.db.run(`UPDATE "pages" SET "data_revision" = ?, "entries" = ? WHERE "page_id" = ?`, [dataRevision, entries, pageId]);
    });
  }

  /** Opens (and caches) a page's database: the active declaration applied, old deleted rows purged. */
  private pageDatabase(pageId: string): PageSqliteDatabase {
    const cached = this.databases.get(pageId);
    if (cached) {
      this.databases.delete(pageId);
      this.databases.set(pageId, cached);
      return cached;
    }
    mkdirSync(this.pageDir(pageId), { recursive: true });
    const db = openPageSqliteDatabase(join(this.pageDir(pageId), "data.sqlite"));
    try {
      db.exec("PRAGMA journal_mode = WAL");
      ensurePageMetaTable(db);
    } catch (error) {
      db.close();
      throw error;
    }
    this.databases.set(pageId, db);
    while (this.databases.size > this.maxOpenDatabases) {
      const [oldest, database] = this.databases.entries().next().value as [string, PageSqliteDatabase];
      this.databases.delete(oldest);
      database.close();
    }
    const page = this.getPage(pageId);
    if (page) {
      this.applyDeclaration(pageId, this.declarationOf(page));
      this.changeOpenData(pageId, db, () => purgeDeletedPageRows(db, { now: this.now }), (before) => totalChanges(db) !== before);
      this.mirrorDataRevision(pageId);
    }
    return db;
  }

  private closeDatabases(): void {
    for (const database of this.databases.values()) database.close();
    this.databases.clear();
  }

  private transactRegistry(operation: () => void): void {
    runInPageTransaction(this.db, () => {
      operation();
      writeRegistryMeta(this.db, "registryRevision", String(this.registryRevision() + 1));
    });
  }

  /** Keeps the active revision's document and the one before it, for visitors still loading it. */
  private async removeOldRevisions(pageId: string, active: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.pageDir(pageId));
    } catch {
      return;
    }
    for (const name of names) {
      const revision = Number(revisionFile.exec(name)?.[1] ?? Number.NaN);
      if (Number.isInteger(revision) && revision < active - 1) await unlink(join(this.pageDir(pageId), name)).catch(() => undefined);
    }
  }

  private withLock<T>(pageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(pageId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.then(() => undefined, () => undefined);
    this.locks.set(pageId, settled);
    void settled.then(() => {
      if (this.locks.get(pageId) === settled) this.locks.delete(pageId);
    });
    return run;
  }

  private toRecord(row: Record<string, unknown>): PageRecord {
    let files: PublishedFile[] = [];
    try {
      const value = JSON.parse(String(row.files)) as unknown;
      if (Array.isArray(value)) files = value as PublishedFile[];
    } catch {
      files = [];
    }
    return {
      pageId: String(row.page_id),
      accountId: String(row.account_id),
      title: String(row.title),
      status: row.status === "online" ? "online" : "unpublished",
      revision: Number(row.revision),
      contentDigest: String(row.content_digest),
      declarationJson: String(row.declaration),
      files,
      createdAt: String(row.created_at),
      publishedAt: String(row.published_at),
      updatedAt: String(row.updated_at),
      dataRevision: Number(row.data_revision),
      entries: Number(row.entries),
      backupDataRevision: row.backup_data_revision === null || row.backup_data_revision === undefined ? null : Number(row.backup_data_revision),
      backupRevision: row.backup_revision === null || row.backup_revision === undefined ? null : Number(row.backup_revision),
    };
  }
}

/** The page fields the internal routes answer with. */
export function publicPage(page: PageRecord): PublishedPage {
  return {
    pageId: page.pageId,
    title: page.title,
    status: page.status,
    revision: page.revision,
    publishedAt: page.publishedAt,
    updatedAt: page.updatedAt,
    dataRevision: page.dataRevision,
    entries: page.entries,
  };
}

/** `{ table: { column: type } }`, what the form helper needs to read a form. */
export function columnTypes(declaration: PageDeclaration): Record<string, Record<string, string>> {
  return Object.fromEntries(declaration.tables.map((table) => [table.name, Object.fromEntries(table.columns.map((column) => [column.name, column.type]))]));
}

function totalChanges(db: PageSqlDatabase): number {
  return Number(db.get(`SELECT total_changes() AS "changes"`)?.changes ?? 0);
}

function readDataRevision(db: PageSqlDatabase): number {
  const value = Number(readPageMeta(db, "dataRevision") ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Live rows across every stored page table, declared or retired. */
function countLiveEntries(db: PageSqlDatabase): number {
  let entries = 0;
  for (const table of listStoredPageTables(db)) {
    if (!storedColumnNames(db, table).includes("_deleted")) continue;
    entries += Number(db.get(`SELECT COUNT(*) AS "count" FROM ${quotePageIdentifier(table)} WHERE "_deleted" IS NULL`)?.count ?? 0);
  }
  return entries;
}

function readRegistryMeta(db: PageSqlDatabase, key: string): string | null {
  const row = db.get(`SELECT "value" FROM "registry_meta" WHERE "key" = ?`, [key]);
  return typeof row?.value === "string" ? row.value : null;
}

function writeRegistryMeta(db: PageSqlDatabase, key: string, value: string): void {
  db.run(`INSERT INTO "registry_meta" ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`, [key, value]);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Not every platform can sync a directory; the rename itself is atomic.
  }
}
