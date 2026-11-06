/**
 * The page rules engine (docs/pages.md, "What a page's code can use", "The
 * Data view"). Every page call is checked against the declaration for the
 * viewer's role; visitors' browsers never send SQL. Deleting is a soft delete
 * (`_deleted`), page calls never see deleted rows, and deleted rows are purged
 * after 30 days. Unique and limits are enforced here on live rows.
 */
import type { PageColumnDeclaration, PageColumnType, PageDeclaration, PageTableDeclaration, PageVisitorPermission } from "./page-declaration.js";
import { findPageTable } from "./page-declaration.js";
import { PageCallError } from "./page-errors.js";
import type { PageSqlDatabase, PageSqlRow, PageSqlValue } from "./page-sql.js";
import { quotePageIdentifier, runInPageTransaction } from "./page-sql.js";
import { describePageSchema, listStoredPageTables, readPageMeta, storedColumnNames, writePageMeta } from "./page-schema.js";
import type { PageValue } from "./page-values.js";
import { normalizePageValue, normalizePageValues } from "./page-values.js";

export const pageDataLimits = Object.freeze({
  /** Same request id within this window returns the row it already created. */
  requestDedupeMs: 10 * 60 * 1000,
  /** Deleted rows are purged after this many days. */
  deletedRetentionDays: 30,
  listDefaultLimit: 100,
  listMaxLimit: 1_000,
  /** `mine` returns at most this many of the visitor's newest rows. */
  mineMaxRows: 1_000,
  /** The Data view reads at most this many rows of one table at a time. */
  dataViewMaxRows: 100_000,
  maxIdsPerCall: 100_000,
  maxIdLength: 128,
  maxRequestIdLength: 128,
});

/** `_visitor` on rows the owner added: never a valid visitor id, which is at least eight characters. */
export const pageOwnerMarker = "owner";

const visitorIdPattern = /^[A-Za-z0-9_-]{8,128}$/u;
const requestIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;

export type PageViewer = { role: "visitor"; visitor: string } | { role: "owner" };

export const pageCallOps = ["add", "mine", "list", "count", "update", "remove", "isOwner"] as const;
export type PageCallOp = (typeof pageCallOps)[number];

/** One call from a page's code, as the host received it. */
export interface PageCall {
  op: PageCallOp;
  table?: string;
  values?: unknown;
  id?: unknown;
  where?: unknown;
  options?: unknown;
  requestId?: unknown;
}

/** A row as page code sees it. The owner also sees `visitor`. */
export type PageRow = { id: string; createdAt: string; updatedAt: string; visitor?: string | null } & Record<string, PageValue | undefined>;

/** A row as the Data view sees it: every stored column, declared or retired. */
export type PageDataRow = {
  id: string;
  visitor: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
} & Record<string, PageValue>;

export interface PageEngineEnvironment {
  now?: () => Date;
  /** New row ids; defaults to `crypto.randomUUID()`. */
  newId?: () => string;
}

/** A fresh opaque visitor id, for previews and (later) online visitors. */
export function createPageVisitorId(newId: () => string = () => globalThis.crypto.randomUUID()): string {
  return `v_${newId().replaceAll("-", "")}`;
}

export function isValidPageVisitorId(value: unknown): value is string {
  return typeof value === "string" && visitorIdPattern.test(value) && value !== pageOwnerMarker;
}

/** Checks the viewer a host passes in; throws INVALID for anything else. */
export function parsePageViewer(value: unknown): PageViewer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PageCallError("INVALID", "Choose who is viewing the page.");
  const viewer = value as { role?: unknown; visitor?: unknown };
  if (viewer.role === "owner") return { role: "owner" };
  if (viewer.role === "visitor") {
    if (!isValidPageVisitorId(viewer.visitor)) throw new PageCallError("INVALID", "The visitor id isn't valid.");
    return { role: "visitor", visitor: viewer.visitor };
  }
  throw new PageCallError("INVALID", "The viewer's role must be visitor or owner.");
}

/** Checks the call shape a host passes in; throws INVALID for anything else. */
export function parsePageCall(value: unknown): PageCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PageCallError("INVALID", "A page call must be an object.");
  const call = value as Record<string, unknown>;
  if (typeof call.op !== "string" || !(pageCallOps as readonly string[]).includes(call.op)) {
    throw new PageCallError("INVALID", `Unknown page call: ${typeof call.op === "string" ? call.op : "(none)"}.`);
  }
  if (call.table !== undefined && typeof call.table !== "string") throw new PageCallError("INVALID", "The table name must be text.");
  return {
    op: call.op as PageCallOp,
    ...(call.table !== undefined ? { table: call.table as string } : {}),
    ...(call.values !== undefined ? { values: call.values } : {}),
    ...(call.id !== undefined ? { id: call.id } : {}),
    ...(call.where !== undefined ? { where: call.where } : {}),
    ...(call.options !== undefined ? { options: call.options } : {}),
    ...(call.requestId !== undefined && call.requestId !== null ? { requestId: call.requestId } : {}),
  };
}

/**
 * Runs one page call for `viewer`. The result is JSON-ready: a row, a list of
 * rows, a number, or a boolean. Refusals throw `PageCallError`.
 */
export function runPageCall(
  db: PageSqlDatabase,
  declaration: PageDeclaration,
  viewer: PageViewer,
  call: PageCall,
  environment: PageEngineEnvironment = {},
): PageRow | PageRow[] | number | boolean {
  if (call.op === "isOwner") return viewer.role === "owner";
  const table = requireDeclaredTable(declaration, call.table);
  const now = environment.now?.() ?? new Date();
  switch (call.op) {
    case "add":
      return addRow(db, table, viewer, call.values, call.requestId, now, environment.newId ?? (() => globalThis.crypto.randomUUID()));
    case "mine": {
      permit(viewer, table, "see-own");
      const rows = db.all(
        `SELECT * FROM ${quotePageIdentifier(table.name)} WHERE "_visitor" = ? AND "_deleted" IS NULL ORDER BY "_created" DESC, rowid DESC LIMIT ?`,
        [visitorKey(viewer), pageDataLimits.mineMaxRows],
      );
      return rows.map((row) => toPageRow(table, row, viewer));
    }
    case "list": {
      permit(viewer, table, "see-all");
      const { limit, newestFirst } = parseListOptions(call.options);
      const order = newestFirst ? `"_created" DESC, rowid DESC` : `"_created" ASC, rowid ASC`;
      const rows = db.all(
        `SELECT * FROM ${quotePageIdentifier(table.name)} WHERE "_deleted" IS NULL ORDER BY ${order} LIMIT ?`,
        [limit],
      );
      return rows.map((row) => toPageRow(table, row, viewer));
    }
    case "count": {
      const conditions: string[] = [`"_deleted" IS NULL`];
      const params: PageSqlValue[] = [];
      for (const [column, value] of parseWhere(table, call.where)) {
        if (value === null) conditions.push(`${quotePageIdentifier(column)} IS NULL`);
        else {
          conditions.push(`${quotePageIdentifier(column)} = ?`);
          params.push(toSqlValue(value));
        }
      }
      const row = db.get(`SELECT COUNT(*) AS "count" FROM ${quotePageIdentifier(table.name)} WHERE ${conditions.join(" AND ")}`, params);
      return Number(row?.count ?? 0);
    }
    case "update": {
      permit(viewer, table, "edit-own");
      const id = requireRowId(call.id);
      return runInPageTransaction(db, () => {
        requireOwnLiveRow(db, table.name, id, viewer);
        const stored = updateRowValues(db, table, id, call.values, now);
        return toPageRow(table, stored, viewer);
      });
    }
    case "remove": {
      permit(viewer, table, "delete-own");
      const id = requireRowId(call.id);
      return runInPageTransaction(db, () => {
        requireOwnLiveRow(db, table.name, id, viewer);
        db.run(`UPDATE ${quotePageIdentifier(table.name)} SET "_deleted" = ? WHERE "_id" = ? AND "_deleted" IS NULL`, [now.toISOString(), id]);
        return true;
      });
    }
  }
}

function addRow(
  db: PageSqlDatabase,
  table: PageTableDeclaration,
  viewer: PageViewer,
  rawValues: unknown,
  rawRequestId: unknown,
  now: Date,
  newId: () => string,
): PageRow {
  permit(viewer, table, "add");
  const requestId = parseRequestId(rawRequestId);
  const values = normalizePageValues(table, rawValues, "add");
  const tableName = quotePageIdentifier(table.name);
  return runInPageTransaction(db, () => {
    // A retry carries the same request id: return the row it already
    // created, before the limit or unique checks could refuse it.
    if (requestId !== null) {
      const since = new Date(now.getTime() - pageDataLimits.requestDedupeMs).toISOString();
      const existing = db.get(
        `SELECT * FROM ${tableName} WHERE "_request" = ? AND "_visitor" = ? AND "_deleted" IS NULL AND "_created" >= ? ORDER BY "_created" DESC LIMIT 1`,
        [requestId, visitorKey(viewer), since],
      );
      if (existing) return toPageRow(table, existing, viewer);
    }
    assertBelowLimit(db, table, 1);
    assertUnique(db, table, values, null);
    const id = newId();
    const timestamp = now.toISOString();
    const columns = ["_id", "_visitor", "_created", "_updated", "_deleted", "_request", ...values.keys()];
    const params: PageSqlValue[] = [id, visitorKey(viewer), timestamp, timestamp, null, requestId, ...[...values.values()].map(toSqlValue)];
    db.run(
      `INSERT INTO ${tableName} (${columns.map(quotePageIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      params,
    );
    return toPageRow(table, requireStoredRow(db, table.name, id), viewer);
  });
}

/** Applies checked values to one live row and returns the stored row. */
function updateRowValues(db: PageSqlDatabase, table: PageTableDeclaration, id: string, rawValues: unknown, now: Date): PageSqlRow {
  const values = normalizePageValues(table, rawValues, "update");
  if (!values.size) return requireStoredRow(db, table.name, id);
  assertUnique(db, table, values, id);
  const assignments = [...values.keys()].map((column) => `${quotePageIdentifier(column)} = ?`);
  db.run(
    `UPDATE ${quotePageIdentifier(table.name)} SET ${assignments.join(", ")}, "_updated" = ? WHERE "_id" = ? AND "_deleted" IS NULL`,
    [...[...values.values()].map(toSqlValue), now.toISOString(), id],
  );
  return requireStoredRow(db, table.name, id);
}

function assertBelowLimit(db: PageSqlDatabase, table: PageTableDeclaration, adding: number): void {
  const live = Number(db.get(`SELECT COUNT(*) AS "count" FROM ${quotePageIdentifier(table.name)} WHERE "_deleted" IS NULL`)?.count ?? 0);
  if (live + adding > table.limit) {
    throw new PageCallError("LIMIT_REACHED", `No more entries can be added: the limit of ${table.limit.toLocaleString("en-US")} has been reached.`);
  }
}

/** Unique columns are unique among live rows only; `exceptId` is the row being changed. */
function assertUnique(db: PageSqlDatabase, table: PageTableDeclaration, values: Map<string, PageValue>, exceptId: string | null): void {
  for (const column of table.columns) {
    if (!column.unique) continue;
    const value = values.get(column.name);
    if (value === undefined || value === null) continue;
    const params: PageSqlValue[] = [toSqlValue(value)];
    let sql = `SELECT "_id" FROM ${quotePageIdentifier(table.name)} WHERE ${quotePageIdentifier(column.name)} = ? AND "_deleted" IS NULL`;
    if (exceptId !== null) {
      sql += ` AND "_id" <> ?`;
      params.push(exceptId);
    }
    if (db.get(`${sql} LIMIT 1`, params)) {
      throw new PageCallError("DUPLICATE", `An entry with this ${column.name} already exists.`, column.name);
    }
  }
}

function requireOwnLiveRow(db: PageSqlDatabase, table: string, id: string, viewer: PageViewer): PageSqlRow {
  const row = db.get(`SELECT * FROM ${quotePageIdentifier(table)} WHERE "_id" = ? AND "_deleted" IS NULL`, [id]);
  if (!row) throw new PageCallError("NOT_FOUND", "That entry doesn't exist.");
  if (viewer.role === "visitor" && row._visitor !== viewer.visitor) {
    throw new PageCallError("NOT_ALLOWED", "Only the visitor who added this entry can change it.");
  }
  return row;
}

function requireStoredRow(db: PageSqlDatabase, table: string, id: string): PageSqlRow {
  const row = db.get(`SELECT * FROM ${quotePageIdentifier(table)} WHERE "_id" = ?`, [id]);
  if (!row) throw new PageCallError("NOT_FOUND", "That entry doesn't exist.");
  return row;
}

const permissionRefusals: Record<PageVisitorPermission, (table: string) => string> = {
  "add": (table) => `Visitors can't add entries to ${table}.`,
  "see-own": (table) => `Visitors can't see their entries in ${table}.`,
  "see-all": (table) => `Visitors can't see the entries in ${table}.`,
  "edit-own": (table) => `Visitors can't change entries in ${table}.`,
  "delete-own": (table) => `Visitors can't remove entries from ${table}.`,
};

function permit(viewer: PageViewer, table: PageTableDeclaration, permission: PageVisitorPermission): void {
  if (viewer.role === "owner") return;
  if (!table.visitors.includes(permission)) throw new PageCallError("NOT_ALLOWED", permissionRefusals[permission](table.name));
}

function requireDeclaredTable(declaration: PageDeclaration, name: unknown): PageTableDeclaration {
  if (typeof name !== "string" || !name) throw new PageCallError("INVALID", "Name the table this call is for.");
  const table = findPageTable(declaration, name);
  if (!table) throw new PageCallError("NOT_FOUND", `This page has no table named "${name}".`);
  return table;
}

function requireRowId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > pageDataLimits.maxIdLength) {
    throw new PageCallError("INVALID", "Name the entry by its id.");
  }
  return value;
}

function parseRequestId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !requestIdPattern.test(value)) {
    throw new PageCallError("INVALID", "The request id must be 1–128 letters, digits, or . _ : - characters.");
  }
  return value;
}

function parseListOptions(value: unknown): { limit: number; newestFirst: boolean } {
  if (value === undefined || value === null) return { limit: pageDataLimits.listDefaultLimit, newestFirst: false };
  if (typeof value !== "object" || Array.isArray(value)) throw new PageCallError("INVALID", "List options must be an object.");
  const options = value as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (key !== "limit" && key !== "newestFirst") throw new PageCallError("INVALID", `Unknown list option: ${key}.`);
  }
  let limit: number = pageDataLimits.listDefaultLimit;
  if (options.limit !== undefined && options.limit !== null) {
    if (typeof options.limit !== "number" || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > pageDataLimits.listMaxLimit) {
      throw new PageCallError("INVALID", `The list limit must be a whole number from 1 to ${pageDataLimits.listMaxLimit.toLocaleString("en-US")}.`);
    }
    limit = options.limit;
  }
  let newestFirst = false;
  if (options.newestFirst !== undefined && options.newestFirst !== null) {
    if (typeof options.newestFirst !== "boolean") throw new PageCallError("INVALID", "newestFirst must be true or false.");
    newestFirst = options.newestFirst;
  }
  return { limit, newestFirst };
}

function parseWhere(table: PageTableDeclaration, value: unknown): Array<[string, PageValue]> {
  if (value === undefined || value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) throw new PageCallError("INVALID", "where must be an object of column names and values.");
  const result: Array<[string, PageValue]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const column = table.columns.find((candidate) => candidate.name === key);
    if (!column) throw new PageCallError("INVALID", `This page doesn't collect "${key}".`, key);
    result.push([key, normalizePageValue(column, raw)]);
  }
  return result;
}

function visitorKey(viewer: PageViewer): string {
  return viewer.role === "owner" ? pageOwnerMarker : viewer.visitor;
}

function toSqlValue(value: PageValue): PageSqlValue {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** A stored value back in its column's form; anything unexpected reads as missing. */
function fromStoredValue(type: PageColumnType, value: unknown): PageValue {
  if (value === undefined || value === null) return null;
  if (type === "boolean" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function toPageRow(table: PageTableDeclaration, stored: PageSqlRow, viewer: PageViewer): PageRow {
  const row: PageRow = {
    id: String(stored._id),
    createdAt: String(stored._created),
    updatedAt: String(stored._updated),
  };
  for (const column of table.columns) row[column.name] = fromStoredValue(column.type, stored[column.name]);
  if (viewer.role === "owner") row.visitor = typeof stored._visitor === "string" ? stored._visitor : null;
  return row;
}

// ---------------------------------------------------------------------------
// The owner's Data view.

export interface PageDataColumn {
  name: string;
  type: PageColumnType;
  /** No longer in page.json: the data is kept but nothing collects it. */
  retired: boolean;
  required?: boolean;
  unique?: boolean;
  max?: number;
  min?: number;
  integer?: boolean;
  options?: string[];
}

export interface PageDataTableSummary {
  name: string;
  retired: boolean;
  /** The declared row limit; null for a retired table. */
  limit: number | null;
  live: number;
  deleted: number;
  /** Live rows added after `lastSeen` (all live rows when it was never set). */
  newCount: number;
  lastSeen: string | null;
}

export interface PageDataTableView {
  table: string;
  retired: boolean;
  limit: number | null;
  deleted: boolean;
  columns: PageDataColumn[];
  rows: PageDataRow[];
  /** Every matching row, even when `rows` stops at the Data view's bound. */
  total: number;
  lastSeen: string | null;
}

/** Every stored page table, declared or retired, with counts for "What's new". */
export function listPageDataTables(db: PageSqlDatabase, declaration: PageDeclaration | null): PageDataTableSummary[] {
  return describePageSchema(db, declaration).map((table) => {
    const name = quotePageIdentifier(table.name);
    const lastSeen = readPageMeta(db, lastSeenKey(table.name));
    const counts = db.get(
      `SELECT SUM(CASE WHEN "_deleted" IS NULL THEN 1 ELSE 0 END) AS "live", SUM(CASE WHEN "_deleted" IS NULL THEN 0 ELSE 1 END) AS "deleted", `
        + `SUM(CASE WHEN "_deleted" IS NULL AND (? IS NULL OR "_created" > ?) THEN 1 ELSE 0 END) AS "fresh" FROM ${name}`,
      [lastSeen, lastSeen],
    );
    return {
      name: table.name,
      retired: table.retired,
      limit: declaration ? findPageTable(declaration, table.name)?.limit ?? null : null,
      live: Number(counts?.live ?? 0),
      deleted: Number(counts?.deleted ?? 0),
      newCount: Number(counts?.fresh ?? 0),
      lastSeen,
    };
  });
}

/** One table's rows for the Data view, newest first: live rows, or the Deleted list. */
export function readPageDataTable(
  db: PageSqlDatabase,
  declaration: PageDeclaration | null,
  tableName: string,
  options: { deleted?: boolean } = {},
): PageDataTableView {
  const status = requireStoredTable(db, declaration, tableName);
  const declared = declaration ? findPageTable(declaration, tableName) : undefined;
  const columns = dataColumns(status.columns, declared);
  const deleted = options.deleted === true;
  const filter = deleted ? `"_deleted" IS NOT NULL` : `"_deleted" IS NULL`;
  const name = quotePageIdentifier(tableName);
  const total = Number(db.get(`SELECT COUNT(*) AS "count" FROM ${name} WHERE ${filter}`)?.count ?? 0);
  const order = deleted ? `"_deleted" DESC, rowid DESC` : `"_created" DESC, rowid DESC`;
  const rows = db.all(`SELECT * FROM ${name} WHERE ${filter} ORDER BY ${order} LIMIT ?`, [pageDataLimits.dataViewMaxRows])
    .map((row) => toDataRow(columns, row));
  return {
    table: tableName,
    retired: status.retired,
    limit: declared?.limit ?? null,
    deleted,
    columns,
    rows,
    total,
    lastSeen: readPageMeta(db, lastSeenKey(tableName)),
  };
}

/** The owner changes values on one live row, checked against the declaration. */
export function updatePageDataRow(
  db: PageSqlDatabase,
  declaration: PageDeclaration,
  tableName: string,
  id: unknown,
  values: unknown,
  environment: PageEngineEnvironment = {},
): PageDataRow {
  const table = findPageTable(declaration, tableName);
  if (!table) {
    if (listStoredPageTables(db).includes(tableName)) {
      throw new PageCallError("NOT_ALLOWED", `${tableName} is no longer collected, so its entries can't be edited.`);
    }
    throw new PageCallError("NOT_FOUND", `This page has no table named "${tableName}".`);
  }
  const rowId = requireRowId(id);
  const now = environment.now?.() ?? new Date();
  if (values && typeof values === "object" && !Array.isArray(values)) {
    const stored = new Set(storedColumnNames(db, tableName));
    for (const key of Object.keys(values)) {
      if (!table.columns.some((column) => column.name === key) && stored.has(key)) {
        throw new PageCallError("INVALID", `${key} is no longer collected, so it can't be edited.`, key);
      }
    }
  }
  return runInPageTransaction(db, () => {
    requireOwnLiveRow(db, tableName, rowId, { role: "owner" });
    const stored = updateRowValues(db, table, rowId, values, now);
    const status = describePageSchema(db, declaration).find((candidate) => candidate.name === tableName);
    return toDataRow(dataColumns(status?.columns ?? [], table), stored);
  });
}

/** Moves live rows to the Deleted list. Returns how many were live and now are deleted. */
export function deletePageDataRows(
  db: PageSqlDatabase,
  declaration: PageDeclaration | null,
  tableName: string,
  ids: unknown,
  environment: PageEngineEnvironment = {},
): number {
  requireStoredTable(db, declaration, tableName);
  const rowIds = requireRowIds(ids);
  const now = (environment.now?.() ?? new Date()).toISOString();
  return runInPageTransaction(db, () => {
    let deleted = 0;
    for (const id of rowIds) {
      deleted += db.run(`UPDATE ${quotePageIdentifier(tableName)} SET "_deleted" = ? WHERE "_id" = ? AND "_deleted" IS NULL`, [now, id]).changes;
    }
    return deleted;
  });
}

/**
 * Brings deleted rows back. Restoring is refused as a whole when it would pass
 * the table's limit or duplicate a unique value among live rows.
 */
export function restorePageDataRows(
  db: PageSqlDatabase,
  declaration: PageDeclaration | null,
  tableName: string,
  ids: unknown,
): number {
  requireStoredTable(db, declaration, tableName);
  const rowIds = requireRowIds(ids);
  const table = declaration ? findPageTable(declaration, tableName) : undefined;
  const name = quotePageIdentifier(tableName);
  return runInPageTransaction(db, () => {
    const restoring = rowIds
      .map((id) => db.get(`SELECT * FROM ${name} WHERE "_id" = ? AND "_deleted" IS NOT NULL`, [id]))
      .filter((row): row is PageSqlRow => row !== undefined);
    if (!restoring.length) return 0;
    if (table) {
      assertBelowLimit(db, table, restoring.length);
      for (const column of table.columns.filter((candidate) => candidate.unique)) {
        const seen = new Set<string>();
        for (const row of restoring) {
          const value = row[column.name];
          if (value === null || value === undefined) continue;
          const key = `${typeof value}:${String(value)}`;
          const clash = seen.has(key) || db.get(
            `SELECT "_id" FROM ${name} WHERE ${quotePageIdentifier(column.name)} = ? AND "_deleted" IS NULL LIMIT 1`,
            [value as PageSqlValue],
          );
          if (clash) throw new PageCallError("DUPLICATE", `An entry with this ${column.name} already exists, so it can't be restored.`, column.name);
          seen.add(key);
        }
      }
    }
    let restored = 0;
    for (const row of restoring) {
      restored += db.run(`UPDATE ${name} SET "_deleted" = NULL WHERE "_id" = ? AND "_deleted" IS NOT NULL`, [String(row._id)]).changes;
    }
    return restored;
  });
}

/** Records that the owner has looked at a table now; "What's new" counts from here. */
export function markPageDataTableSeen(
  db: PageSqlDatabase,
  declaration: PageDeclaration | null,
  tableName: string,
  environment: PageEngineEnvironment = {},
): string {
  requireStoredTable(db, declaration, tableName);
  const lastSeen = (environment.now?.() ?? new Date()).toISOString();
  writePageMeta(db, lastSeenKey(tableName), lastSeen);
  return lastSeen;
}

/** Erases rows deleted more than 30 days ago, in every page table. Returns how many. */
export function purgeDeletedPageRows(db: PageSqlDatabase, environment: PageEngineEnvironment = {}): number {
  const now = environment.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - pageDataLimits.deletedRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  return runInPageTransaction(db, () => {
    let purged = 0;
    for (const table of listStoredPageTables(db)) {
      if (!storedColumnNames(db, table).includes("_deleted")) continue;
      purged += db.run(`DELETE FROM ${quotePageIdentifier(table)} WHERE "_deleted" IS NOT NULL AND "_deleted" < ?`, [cutoff]).changes;
    }
    return purged;
  });
}

/**
 * A table's live rows as CSV, newest first: the data columns (declared, then
 * retired), then when each row was added and changed, the visitor, and the id.
 * Text that a spreadsheet would read as a formula is prefixed with `'`.
 */
export function exportPageDataTableCsv(db: PageSqlDatabase, declaration: PageDeclaration | null, tableName: string): string {
  const view = readPageDataTable(db, declaration, tableName);
  const header = [...view.columns.map((column) => column.name), "createdAt", "updatedAt", "visitor", "id"];
  const lines = [header.map(csvCell).join(",")];
  for (const row of view.rows) {
    lines.push([
      ...view.columns.map((column) => row[column.name] ?? null),
      row.createdAt,
      row.updatedAt,
      row.visitor,
      row.id,
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function csvCell(value: PageValue): string {
  if (value === null) return "";
  let text = typeof value === "string" ? value : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function requireStoredTable(db: PageSqlDatabase, declaration: PageDeclaration | null, tableName: string) {
  const status = describePageSchema(db, declaration).find((table) => table.name === tableName);
  if (!status) throw new PageCallError("NOT_FOUND", `This page has no table named "${tableName}".`);
  return status;
}

function requireRowIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > pageDataLimits.maxIdsPerCall) {
    throw new PageCallError("INVALID", "Choose at least one entry by id.");
  }
  return [...new Set(value.map(requireRowId))];
}

function dataColumns(
  statusColumns: ReadonlyArray<{ name: string; type: PageColumnType; retired: boolean }>,
  declared: PageTableDeclaration | undefined,
): PageDataColumn[] {
  return statusColumns.map((column) => {
    const declaration: PageColumnDeclaration | undefined = column.retired ? undefined : declared?.columns.find((candidate) => candidate.name === column.name);
    if (!declaration) return { name: column.name, type: column.type, retired: true };
    return {
      name: column.name,
      type: declaration.type,
      retired: false,
      required: declaration.required,
      unique: declaration.unique,
      ...(declaration.max !== undefined ? { max: declaration.max } : {}),
      ...(declaration.min !== undefined ? { min: declaration.min } : {}),
      ...(declaration.integer ? { integer: true } : {}),
      ...(declaration.options ? { options: [...declaration.options] } : {}),
    };
  });
}

function toDataRow(columns: readonly PageDataColumn[], stored: PageSqlRow): PageDataRow {
  const row: PageDataRow = {
    id: String(stored._id),
    visitor: typeof stored._visitor === "string" ? stored._visitor : null,
    createdAt: String(stored._created),
    updatedAt: String(stored._updated),
    deletedAt: typeof stored._deleted === "string" ? stored._deleted : null,
  };
  for (const column of columns) row[column.name] = fromStoredValue(column.type, stored[column.name]);
  return row;
}

function lastSeenKey(table: string): string {
  return `lastSeen.${table}`;
}
