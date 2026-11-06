/**
 * Test entries (docs/pages.md, "Preview and test entries"): one preview
 * database per page under the state root, at
 * `pages/preview/<workFolderId>/<key>.sqlite`, keyed by the page folder's
 * work-folder-relative path. Never in the work-folder, never online.
 * Renaming the page folder starts a fresh test database.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { PageDeclaration, PageEngineEnvironment, PageSchemaStatus, PageSqlDatabase } from "../../shared/pages/index.js";
import {
  applyPageSchema,
  createPageVisitorId,
  ensurePageMetaTable,
  isValidPageVisitorId,
  purgeDeletedPageRows,
  readPageMeta,
  writePageMeta,
} from "../../shared/pages/index.js";
import { workFoldStateRoot } from "../state-paths.js";
import { PageFolderError } from "./page-folder-files.js";
import { openPageSqliteDatabase } from "./page-sqlite.js";

const workFolderIdPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export function pagePreviewRoot(): string {
  return join(workFoldStateRoot(), "pages", "preview");
}

/** A truncated SHA-256 of the page folder's work-folder-relative path. */
export function pagePreviewKey(pagePath: string): string {
  return createHash("sha256").update(pagePath, "utf8").digest("hex").slice(0, 32);
}

export function pagePreviewDatabasePath(workFolderId: string, pagePath: string): string {
  if (!workFolderIdPattern.test(workFolderId)) throw new PageFolderError(400, "That work-folder id isn't valid.");
  return join(pagePreviewRoot(), workFolderId, `${pagePreviewKey(pagePath)}.sqlite`);
}

export interface PagePreviewDatabase {
  db: PageSqlDatabase;
  /** Null while page.json has problems: the stored tables stay as they were. */
  schema: PageSchemaStatus | null;
}

/**
 * Opens a page's preview database, brings it in line with the declaration
 * (additively), purges rows deleted more than 30 days ago, runs `operation`,
 * and closes it. Every step inside `operation` is synchronous.
 */
export async function withPagePreviewDatabase<T>(
  workFolderId: string,
  pagePath: string,
  declaration: PageDeclaration | null,
  operation: (preview: PagePreviewDatabase) => T,
  environment: PageEngineEnvironment = {},
): Promise<T> {
  const path = pagePreviewDatabasePath(workFolderId, pagePath);
  await mkdir(join(pagePreviewRoot(), workFolderId), { recursive: true });
  const db = openPageSqliteDatabase(path);
  try {
    ensurePageMetaTable(db);
    if (readPageMeta(db, "pagePath") !== pagePath) writePageMeta(db, "pagePath", pagePath);
    if (readPageMeta(db, "workFolderId") !== workFolderId) writePageMeta(db, "workFolderId", workFolderId);
    const schema = declaration ? applyPageSchema(db, declaration, environment.now?.() ?? new Date()) : null;
    purgeDeletedPageRows(db, environment);
    return operation({ db, schema });
  } finally {
    db.close();
  }
}

/** The page's current preview visitor, or a fresh one that becomes current. */
export function currentPreviewVisitor(db: PageSqlDatabase, fresh: boolean): string {
  const current = readPageMeta(db, "previewVisitor");
  if (!fresh && isValidPageVisitorId(current)) return current;
  const visitor = createPageVisitorId();
  writePageMeta(db, "previewVisitor", visitor);
  return visitor;
}
