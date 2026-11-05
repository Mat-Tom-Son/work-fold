import { ApiError, api, apiUrl, fetchApiWithRetry } from "./api";
import { createFixturePagesClient } from "../fixtures/pages-fixture";

/**
 * Pages (docs/pages.md): what the page tab and Files read from the local API.
 * Every route is scoped to `/api/work-folders/:id/pages` and names the page
 * by its work-folder-relative folder path.
 */

export interface PageSummary {
  path: string;
  title: string;
  problemCount: number;
}

export interface PageProblem {
  file?: string | null;
  message: string;
  severity: "error" | "warning" | string;
}

export interface PageColumnDeclaration {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface PageTableDeclaration {
  name: string;
  columns: PageColumnDeclaration[];
  visitors?: string[];
  limit?: number;
}

export interface PageInspection {
  page: {
    path: string;
    title: string;
    description?: string | null;
    entry?: string;
    /** In declared order, as page.json lists them. */
    tables: PageTableDeclaration[];
  } | null;
  problems: PageProblem[];
  summary?: { files: number; bytes: number };
}

export interface PageDocument {
  html: string | null;
  problems: PageProblem[];
}

export interface PageDataColumn {
  name: string;
  type: string;
  retired?: boolean;
  required?: boolean;
  unique?: boolean;
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface PageRow {
  id: string;
  createdAt: string;
  updatedAt?: string;
  visitor?: string | null;
  [column: string]: unknown;
}

export interface PageTableData {
  table: string;
  columns: PageDataColumn[];
  /** Newest first. */
  rows: PageRow[];
  /** Every matching entry, even when `rows` stops at the Data view's bound. */
  total: number;
  lastSeen: string | null;
  /** True when the table is no longer in page.json; its entries stay. */
  retired?: boolean;
}

/** One stored table, declared or no longer collected, with its counts. */
export interface PageTableSummary {
  name: string;
  retired: boolean;
  live: number;
  deleted: number;
  /** Live entries added after `lastSeen`; all of them when it was never set. */
  newCount: number;
  lastSeen: string | null;
}

export type PageViewerRole = "visitor" | "owner";

/** The owner sees every entry; a visitor is one opaque preview visitor. */
export type PageViewer = { role: "visitor"; visitor: string } | { role: "owner" };

export const pageCallOps = ["add", "mine", "list", "count", "update", "remove"] as const;
export type PageCallOp = typeof pageCallOps[number];

export interface PageCall {
  op: PageCallOp;
  table: string;
  values?: unknown;
  id?: unknown;
  where?: unknown;
  options?: unknown;
  requestId?: string;
}

export const pageErrorCodes = ["NOT_ALLOWED", "INVALID", "DUPLICATE", "LIMIT_REACHED", "NOT_FOUND", "TOO_LARGE", "UNAVAILABLE"] as const;
export type PageErrorCode = typeof pageErrorCodes[number];

/** How a refused page call reaches page code: `{ code, message, field? }`. */
export interface PageCallError {
  code: PageErrorCode;
  message: string;
  field?: string;
}

export class PageCallFailure extends Error {
  constructor(readonly failure: PageCallError) {
    super(failure.message);
    this.name = "PageCallFailure";
  }
}

/** The `{ code, message, field? }` behind any failed page call. */
export function pageCallErrorOf(error: unknown): PageCallError {
  if (error instanceof PageCallFailure) return error.failure;
  const failure = error && typeof error === "object" ? (error as { failure?: unknown }).failure : undefined;
  if (failure && typeof failure === "object" && typeof (failure as PageCallError).code === "string" && typeof (failure as PageCallError).message === "string") return failure as PageCallError;
  return { code: "UNAVAILABLE", message: error instanceof Error && error.message ? error.message : "Something went wrong. Try again." };
}

export interface PagesClient {
  list(workFolderId: string): Promise<PageSummary[]>;
  inspect(workFolderId: string, page: string): Promise<PageInspection>;
  document(workFolderId: string, page: string): Promise<PageDocument>;
  visitor(workFolderId: string, page: string, fresh: boolean): Promise<string>;
  call(workFolderId: string, page: string, viewer: PageViewer, call: PageCall): Promise<unknown>;
  tables(workFolderId: string, page: string): Promise<PageTableSummary[]>;
  data(workFolderId: string, page: string, table: string, deleted: boolean): Promise<PageTableData>;
  update(workFolderId: string, page: string, table: string, id: string, values: Record<string, unknown>): Promise<PageRow>;
  remove(workFolderId: string, page: string, table: string, ids: string[]): Promise<number>;
  restore(workFolderId: string, page: string, table: string, ids: string[]): Promise<number>;
  seen(workFolderId: string, page: string, table: string): Promise<string | null>;
  exportCsv(workFolderId: string, page: string, table: string): Promise<Blob>;
}

export function pagesPath(workFolderId: string): string {
  return `/api/work-folders/${encodeURIComponent(workFolderId)}/pages`;
}

function pageQuery(page: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ page, ...extra }).toString();
}

export const livePagesClient: PagesClient = {
  async list(workFolderId) {
    const result = await api<{ pages?: PageSummary[] }>(pagesPath(workFolderId));
    return (result.pages ?? []).filter((page) => page && typeof page.path === "string");
  },
  async inspect(workFolderId, page) {
    const result = await api<Partial<PageInspection>>(`${pagesPath(workFolderId)}/inspect?${pageQuery(page)}`);
    return { page: result.page ?? null, problems: result.problems ?? [], ...(result.summary ? { summary: result.summary } : {}) };
  },
  async document(workFolderId, page) {
    const result = await api<Partial<PageDocument>>(`${pagesPath(workFolderId)}/document?${pageQuery(page)}`);
    return { html: typeof result.html === "string" ? result.html : null, problems: result.problems ?? [] };
  },
  async visitor(workFolderId, page, fresh) {
    const result = await api<{ visitor: string }>(`${pagesPath(workFolderId)}/preview/visitor`, { method: "POST", body: { page, fresh } });
    return result.visitor;
  },
  async call(workFolderId, page, viewer, call) {
    // Never retried here: `add` carries its own request id, and page code
    // decides whether to try again.
    const response = await fetchApiWithRetry(`${pagesPath(workFolderId)}/preview/call`, async () => ({
      method: "POST",
      headers: await pageApiHeaders(),
      body: JSON.stringify({ page, viewer, call }),
    }), []).catch((error: unknown) => {
      throw new PageCallFailure({ code: "UNAVAILABLE", message: error instanceof Error ? error.message : "work-fold couldn't be reached. Try again." });
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new PageCallFailure(pageCallErrorFrom(body, response.status));
    return body && typeof body === "object" && "result" in body ? (body as { result: unknown }).result : null;
  },
  async tables(workFolderId, page) {
    const result = await api<{ tables?: unknown }>(`${pagesPath(workFolderId)}/preview/data?${pageQuery(page)}`);
    return Array.isArray(result.tables) ? result.tables.flatMap((value) => normalizeTableSummary(value) ?? []) : [];
  },
  async data(workFolderId, page, table, deleted) {
    const result = await api<Partial<PageTableData>>(`${pagesPath(workFolderId)}/preview/data?${pageQuery(page, { table, ...(deleted ? { deleted: "1" } : {}) })}`);
    return normalizeTableData(table, result);
  },
  async update(workFolderId, page, table, id, values) {
    const result = await api<{ row: PageRow }>(`${pagesPath(workFolderId)}/preview/data/update`, { method: "POST", body: { page, table, id, values } });
    return result.row;
  },
  async remove(workFolderId, page, table, ids) {
    const result = await api<{ deleted?: number }>(`${pagesPath(workFolderId)}/preview/data/delete`, { method: "POST", body: { page, table, ids } });
    return typeof result.deleted === "number" ? result.deleted : ids.length;
  },
  async restore(workFolderId, page, table, ids) {
    const result = await api<{ restored?: number }>(`${pagesPath(workFolderId)}/preview/data/restore`, { method: "POST", body: { page, table, ids } });
    return typeof result.restored === "number" ? result.restored : ids.length;
  },
  async seen(workFolderId, page, table) {
    const result = await api<{ lastSeen?: string | null }>(`${pagesPath(workFolderId)}/preview/data/seen`, { method: "POST", body: { page, table } });
    return result.lastSeen ?? null;
  },
  async exportCsv(workFolderId, page, table) {
    const response = await fetchApiWithRetry(`${pagesPath(workFolderId)}/preview/data/export?${pageQuery(page, { table })}`, async () => ({
      method: "GET",
      headers: await pageApiHeaders(),
    }), [250, 750]);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
      const message = typeof body?.error === "string" ? body.error : body?.error?.message;
      throw new ApiError(response.status, message || "The spreadsheet couldn't be made. Try again.");
    }
    return new Blob([await response.arrayBuffer()], { type: "text/csv;charset=utf-8" });
  },
};

let fixtureClient: PagesClient | null = null;

export function pagesClient(fixtureMode: boolean): PagesClient {
  if (!fixtureMode) return livePagesClient;
  fixtureClient ??= createFixturePagesClient();
  return fixtureClient;
}

async function pageApiHeaders(): Promise<HeadersInit> {
  const session = await window.workFoldDesktop?.api.getSessionHeaders?.();
  return { "content-type": "application/json", ...(session ?? {}) };
}

/** The refusal a page sees, from whichever error shape the local API used. */
export function pageCallErrorFrom(body: unknown, status: number): PageCallError {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const code = [nested.code, record.code].find((value): value is string => typeof value === "string");
  const message = [nested.message, typeof record.error === "string" ? record.error : undefined, record.message]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const field = [nested.field, record.field].find((value): value is string => typeof value === "string" && value.length > 0);
  const known = (pageErrorCodes as readonly string[]).includes(code ?? "") ? code as PageErrorCode
    : status === 403 ? "NOT_ALLOWED"
      : status === 404 ? "NOT_FOUND"
        : status === 409 ? "DUPLICATE"
          : status === 413 ? "TOO_LARGE"
            : status >= 400 && status < 500 ? "INVALID"
              : "UNAVAILABLE";
  return { code: known, message: message ?? "Something went wrong. Try again.", ...(field ? { field } : {}) };
}

export function normalizeTableData(table: string, value: Partial<PageTableData>): PageTableData {
  const rows = Array.isArray(value.rows) ? value.rows.filter((row): row is PageRow => Boolean(row) && typeof row === "object" && typeof (row as PageRow).id === "string") : [];
  return {
    table: typeof value.table === "string" ? value.table : table,
    columns: Array.isArray(value.columns) ? value.columns.filter((column) => column && typeof column.name === "string") : [],
    rows,
    total: typeof value.total === "number" ? value.total : rows.length,
    lastSeen: typeof value.lastSeen === "string" ? value.lastSeen : null,
    ...(value.retired === true ? { retired: true } : {}),
  };
}

function normalizeTableSummary(value: unknown): PageTableSummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name) return null;
  const count = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : 0;
  return {
    name: record.name,
    retired: record.retired === true,
    live: count("live"),
    deleted: count("deleted"),
    newCount: count("newCount"),
    lastSeen: typeof record.lastSeen === "string" ? record.lastSeen : null,
  };
}

export interface DeclaredTable {
  name: string;
  /** Column name to type, in declared order. */
  columns: Record<string, string>;
}

/** The tables a page declares, in declaration order, with each column's type. */
export function declaredTables(inspection: PageInspection | null): DeclaredTable[] {
  const tables: unknown = inspection?.page?.tables;
  // page.json's own shape (`{ rsvps: { columns: { name: {…} } } }`) is read too.
  const list: Array<[string, unknown]> = Array.isArray(tables)
    ? tables.flatMap((table) => table && typeof table === "object" && typeof (table as { name?: unknown }).name === "string" ? [[(table as { name: string }).name, table] as [string, unknown]] : [])
    : tables && typeof tables === "object" ? Object.entries(tables) : [];
  return list.flatMap(([name, table]) => {
    if (!table || typeof table !== "object") return [];
    const declared: unknown = (table as { columns?: unknown }).columns;
    const entries: Array<[string, unknown]> = Array.isArray(declared)
      ? declared.flatMap((column) => column && typeof column === "object" && typeof (column as { name?: unknown }).name === "string" ? [[(column as { name: string }).name, column] as [string, unknown]] : [])
      : declared && typeof declared === "object" ? Object.entries(declared) : [];
    const columns = Object.fromEntries(entries.flatMap(([column, declaration]) => (
      declaration && typeof declaration === "object" && typeof (declaration as { type?: unknown }).type === "string" ? [[column, (declaration as { type: string }).type]] : []
    )));
    return [{ name, columns }];
  });
}

/** `{ table: { column: type } }`, what the page runtime needs for the form helper. */
export function runtimeColumnTypes(inspection: PageInspection | null): Record<string, Record<string, string>> {
  return Object.fromEntries(declaredTables(inspection).map((table) => [table.name, table.columns]));
}

export function pageFolderName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** A page's title, or its folder's name while page.json has none. */
export function pageTitle(inspection: PageInspection | null, path: string): string {
  const title = inspection?.page?.title?.trim();
  return title || pageFolderName(path);
}

export function pageProblemsBySeverity(problems: readonly PageProblem[]): { errors: PageProblem[]; warnings: PageProblem[] } {
  return {
    errors: problems.filter((problem) => problem.severity !== "warning"),
    warnings: problems.filter((problem) => problem.severity === "warning"),
  };
}

// Changes to a page's test entries, from any view of it in this window: the
// Data view refreshes after a page call changes something, and the page in
// Preview hears about edits made in the Data view through onChange.

export interface PageDataChange {
  workFolderId: string;
  page: string;
  table: string | null;
  /** The view that made the change, so it doesn't hear its own echo. */
  source: string;
}

const pageDataListeners = new Set<(change: PageDataChange) => void>();

export function announcePageDataChange(change: PageDataChange): void {
  for (const listener of [...pageDataListeners]) {
    try { listener(change); } catch { /* One view cannot break another. */ }
  }
}

export function subscribePageDataChanges(listener: (change: PageDataChange) => void): () => void {
  pageDataListeners.add(listener);
  return () => { pageDataListeners.delete(listener); };
}

/** Saves a spreadsheet the way the app's other exports do: an ordinary download. */
export function saveSpreadsheet(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = spreadsheetFileName(name);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function spreadsheetFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${cleaned || "Page data"}.csv`;
}

/** Where the intermediary is served: the local API, which sends its policy header. */
export function pageFrameUrl(): string {
  return apiUrl("/page-frame.html");
}
