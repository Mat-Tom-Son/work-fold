/**
 * The small SQL interface the page rules engine runs on (docs/pages.md,
 * "Storage and code layout"). Locally it is `node:sqlite`'s `DatabaseSync`
 * (src/local/pages/page-sqlite.ts), and the hosted page service will use the
 * same adapter. Every call is synchronous. Values always travel as bound
 * parameters; identifiers come only from validated declarations and are
 * quoted with `quotePageIdentifier`.
 */

export type PageSqlValue = string | number | null;
export type PageSqlRow = Record<string, unknown>;

export interface PageSqlDatabase {
  /** Runs one or more statements without parameters (schema changes). */
  exec(sql: string): void;
  /** Runs one statement with bound parameters; reports how many rows it changed. */
  run(sql: string, params?: readonly PageSqlValue[]): { changes: number };
  all(sql: string, params?: readonly PageSqlValue[]): PageSqlRow[];
  get(sql: string, params?: readonly PageSqlValue[]): PageSqlRow | undefined;
  /**
   * Runs `operation` atomically when the host supports it: every write lands
   * or none does. Without it, the engine still checks everything before it
   * writes, so a refusal never leaves a half-applied change.
   */
  transaction?<T>(operation: () => T): T;
}

/** Work-fold's own columns on every page table, in creation order. */
export const pageSystemColumns = ["_id", "_visitor", "_created", "_updated", "_deleted", "_request"] as const;
export type PageSystemColumn = (typeof pageSystemColumns)[number];

export const pageMetaTable = "_page_meta";

/** Page table and column names, plus work-fold's own `_`-prefixed names. */
const safeIdentifier = /^(?:[a-z][a-z0-9_]{0,40}|_[a-z][a-z0-9_]{0,63})$/u;

/** Double-quotes an identifier after checking it is one work-fold could have produced. */
export function quotePageIdentifier(name: string): string {
  if (!safeIdentifier.test(name)) throw new Error(`Refusing an unexpected SQL identifier: ${JSON.stringify(name)}`);
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

export function runInPageTransaction<T>(db: PageSqlDatabase, operation: () => T): T {
  return db.transaction ? db.transaction(operation) : operation();
}
