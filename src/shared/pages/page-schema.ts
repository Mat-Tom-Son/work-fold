/**
 * Additive schema updates (docs/pages.md, "Preview and test entries"). Each
 * declared table gets work-fold's own columns plus its declared columns; new
 * tables and columns are added; tables and columns that disappear from
 * `page.json` keep their data and are reported as retired. Nothing is ever
 * dropped. Unique is not a database constraint: the engine enforces it on
 * live rows, so adding `unique` later never fails on old duplicates.
 */
import type { PageColumnType, PageDeclaration } from "./page-declaration.js";
import {
  pageColumnTypes,
  pageDeclarationDigest,
  pageDeclarationToJson,
  pageNamePattern,
  parsePageDeclaration,
  reservedPageColumnNames,
} from "./page-declaration.js";
import type { PageSqlDatabase } from "./page-sql.js";
import { pageMetaTable, pageSystemColumns, quotePageIdentifier, runInPageTransaction } from "./page-sql.js";

/** Version of the storage layout this engine writes, kept in `_page_meta`. */
export const pageStorageFormat = "work-fold.page-data/1";

export interface PageSchemaColumnStatus {
  name: string;
  /** The declared type, or the type it had when it was last declared. */
  type: PageColumnType;
  retired: boolean;
}

export interface PageSchemaTableStatus {
  name: string;
  retired: boolean;
  columns: PageSchemaColumnStatus[];
}

export interface PageSchemaStatus {
  digest: string;
  appliedAt: string;
  /** What this application added; empty when the declaration was already in place. */
  added: { tables: string[]; columns: Array<{ table: string; column: string }> };
  tables: PageSchemaTableStatus[];
}

/** Creates `_page_meta` when it is missing. Safe to call on any page database. */
export function ensurePageMetaTable(db: PageSqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${quotePageIdentifier(pageMetaTable)} ("key" TEXT PRIMARY KEY NOT NULL, "value" TEXT NOT NULL)`);
}

export function readPageMeta(db: PageSqlDatabase, key: string): string | null {
  const row = db.get(`SELECT "value" FROM ${quotePageIdentifier(pageMetaTable)} WHERE "key" = ?`, [key]);
  return typeof row?.value === "string" ? row.value : null;
}

export function writePageMeta(db: PageSqlDatabase, key: string, value: string): void {
  db.run(
    `INSERT INTO ${quotePageIdentifier(pageMetaTable)} ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
    [key, value],
  );
}

/**
 * Brings the database in line with `declaration`, additively, and reports
 * every table with its columns, declared or retired.
 */
export function applyPageSchema(db: PageSqlDatabase, declaration: PageDeclaration, now: Date = new Date()): PageSchemaStatus {
  ensurePageMetaTable(db);
  const digest = pageDeclarationDigest(declaration);
  const added: PageSchemaStatus["added"] = { tables: [], columns: [] };
  return runInPageTransaction(db, () => {
    const existingTables = new Set(listStoredPageTables(db));
    for (const table of declaration.tables) {
      const tableName = quotePageIdentifier(table.name);
      if (!existingTables.has(table.name)) {
        const columns = [
          `"_id" TEXT PRIMARY KEY NOT NULL`,
          `"_visitor" TEXT`,
          `"_created" TEXT NOT NULL`,
          `"_updated" TEXT NOT NULL`,
          `"_deleted" TEXT`,
          `"_request" TEXT`,
          // No declared type: values keep exactly the form the engine bound.
          ...table.columns.map((column) => quotePageIdentifier(column.name)),
        ];
        db.exec(`CREATE TABLE ${tableName} (${columns.join(", ")})`);
        added.tables.push(table.name);
      } else {
        const stored = new Set(storedColumnNames(db, table.name));
        for (const system of pageSystemColumns) {
          // A table work-fold created always has these; one that lost them is
          // repaired additively rather than refused.
          if (!stored.has(system)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${quotePageIdentifier(system)}`);
        }
        for (const column of table.columns) {
          if (stored.has(column.name)) continue;
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${quotePageIdentifier(column.name)}`);
          added.columns.push({ table: table.name, column: column.name });
        }
      }
      for (const [suffix, column] of [["visitor", "_visitor"], ["request", "_request"], ["created", "_created"]] as const) {
        db.exec(`CREATE INDEX IF NOT EXISTS ${quotePageIdentifier(`_page_idx_${table.name}__${suffix}`)} ON ${tableName} (${quotePageIdentifier(column)})`);
      }
    }
    // An unchanged declaration that needed no additions writes nothing, so
    // reading test entries never rewrites the database.
    const unchanged = readPageMeta(db, "declarationDigest") === digest
      && readPageMeta(db, "appliedAt") !== null
      && !added.tables.length && !added.columns.length;
    if (!unchanged) {
      // Remember every column's last declared type, so a retired column keeps
      // its type in the Data view.
      const knownTypes = readKnownColumnTypes(db);
      for (const table of declaration.tables) {
        const tableTypes = knownTypes[table.name] ?? {};
        for (const column of table.columns) tableTypes[column.name] = column.type;
        knownTypes[table.name] = tableTypes;
      }
      writePageMeta(db, "columnTypes", JSON.stringify(knownTypes));
      // The last declaration applied, so the Data view keeps working while a
      // later page.json edit has problems.
      writePageMeta(db, "declaration", JSON.stringify(pageDeclarationToJson(declaration)));
      writePageMeta(db, "storageFormat", pageStorageFormat);
      writePageMeta(db, "declarationDigest", digest);
      writePageMeta(db, "appliedAt", now.toISOString());
    }
    return {
      digest,
      appliedAt: readPageMeta(db, "appliedAt") ?? now.toISOString(),
      added,
      tables: describePageSchema(db, declaration),
    };
  });
}

/** The declaration this database was last brought in line with, or null. */
export function readStoredPageDeclaration(db: PageSqlDatabase): PageDeclaration | null {
  const raw = readPageMeta(db, "declaration");
  if (!raw) return null;
  try {
    const parsed = parsePageDeclaration(JSON.parse(raw) as unknown);
    return parsed.ok ? parsed.declaration : null;
  } catch {
    return null;
  }
}

/** Every page table in the database, declared or retired, with its columns. */
export function describePageSchema(db: PageSqlDatabase, declaration: PageDeclaration | null): PageSchemaTableStatus[] {
  const knownTypes = readKnownColumnTypes(db);
  const stored = listStoredPageTables(db);
  const result: PageSchemaTableStatus[] = [];
  const declaredTables = declaration?.tables ?? [];
  for (const table of declaredTables) {
    if (!stored.includes(table.name)) continue;
    const storedColumns = storedColumnNames(db, table.name).filter(isPageDataColumnName);
    const declaredNames = new Set(table.columns.map((column) => column.name));
    result.push({
      name: table.name,
      retired: false,
      columns: [
        ...table.columns.filter((column) => storedColumns.includes(column.name)).map((column) => ({ name: column.name, type: column.type, retired: false })),
        ...storedColumns.filter((name) => !declaredNames.has(name)).map((name) => ({ name, type: knownType(knownTypes, table.name, name), retired: true })),
      ],
    });
  }
  for (const name of stored) {
    if (declaredTables.some((table) => table.name === name)) continue;
    result.push({
      name,
      retired: true,
      columns: storedColumnNames(db, name)
        .filter(isPageDataColumnName)
        .map((column) => ({ name: column, type: knownType(knownTypes, name, column), retired: true })),
    });
  }
  return result;
}

/** Page tables actually stored: names a declaration could have made, never work-fold's own. */
export function listStoredPageTables(db: PageSqlDatabase): string[] {
  return db.all(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string" && pageNamePattern.test(name) && !name.startsWith("sqlite_"));
}

export function storedColumnNames(db: PageSqlDatabase, table: string): string[] {
  return db.all(`SELECT "name" FROM pragma_table_info(?) ORDER BY "cid"`, [table])
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
}

/** A stored column that holds page data: a name a declaration could use, never work-fold's own. */
function isPageDataColumnName(name: string): boolean {
  return pageNamePattern.test(name) && !reservedPageColumnNames.has(name);
}

function readKnownColumnTypes(db: PageSqlDatabase): Record<string, Record<string, PageColumnType>> {
  const raw = readPageMeta(db, "columnTypes");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, Record<string, PageColumnType>> = {};
    for (const [table, columns] of Object.entries(parsed as Record<string, unknown>)) {
      if (!pageNamePattern.test(table) || !columns || typeof columns !== "object" || Array.isArray(columns)) continue;
      const tableTypes: Record<string, PageColumnType> = {};
      for (const [column, type] of Object.entries(columns as Record<string, unknown>)) {
        if (pageNamePattern.test(column) && typeof type === "string" && (pageColumnTypes as readonly string[]).includes(type)) {
          tableTypes[column] = type as PageColumnType;
        }
      }
      result[table] = tableTypes;
    }
    return result;
  } catch {
    return {};
  }
}

function knownType(knownTypes: Record<string, Record<string, PageColumnType>>, table: string, column: string): PageColumnType {
  return knownTypes[table]?.[column] ?? "text";
}
