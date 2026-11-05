/**
 * The Node side of the page rules engine's SQL interface: the built-in
 * `node:sqlite` `DatabaseSync` (Node 22.13+, Node 24, Electron 42). Loaded on
 * first use so starting the local API never depends on it.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { PageSqlDatabase, PageSqlRow, PageSqlValue } from "../../shared/pages/page-sql.js";

export interface PageSqliteDatabase extends PageSqlDatabase {
  close(): void;
}

const requireBuiltin = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | null = null;

function loadSqlite(): typeof import("node:sqlite") {
  sqliteModule ??= requireBuiltin("node:sqlite") as typeof import("node:sqlite");
  return sqliteModule;
}

/** Opens (creating when missing) one page database file, or `:memory:` for tests. */
export function openPageSqliteDatabase(path: string): PageSqliteDatabase {
  const { DatabaseSync: Database } = loadSqlite();
  const database: DatabaseSync = new Database(path, { enableForeignKeyConstraints: false });
  const statements = new Map<string, StatementSync>();
  const prepare = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = database.prepare(sql);
      // Identifiers vary per page, so the cache stays small and bounded.
      if (statements.size >= 256) statements.clear();
      statements.set(sql, statement);
    }
    return statement;
  };
  let depth = 0;
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, params = []) {
      const result = prepare(sql).run(...(params as PageSqlValue[]));
      return { changes: Number(result.changes) };
    },
    all(sql, params = []) {
      return prepare(sql).all(...(params as PageSqlValue[])) as PageSqlRow[];
    },
    get(sql, params = []) {
      return prepare(sql).get(...(params as PageSqlValue[])) as PageSqlRow | undefined;
    },
    transaction<T>(operation: () => T): T {
      // Nested calls join the outer transaction.
      if (depth > 0) return operation();
      database.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* The original error matters more. */ }
        throw error;
      } finally {
        depth -= 1;
      }
    },
    close() {
      statements.clear();
      if (database.isOpen) database.close();
    },
  };
}
