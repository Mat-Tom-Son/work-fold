import type { PageDataColumn, PageRow } from "./pages";

/**
 * The Data view's grid, apart from React (docs/pages.md, "The Data view"):
 * which columns show, how a value reads, and how search, column filters,
 * and sorting pick and order the rows. Kept plain so a few thousand rows sort
 * and filter in one pass.
 */

export interface GridColumn {
  key: string;
  label: string;
  type: string;
  /** No longer in page.json; its values stay and can't be edited. */
  retired: boolean;
  /** work-fold's own: when an entry was added, changed, or deleted, and by whom. */
  system: boolean;
  width: number;
  options?: string[];
  required?: boolean;
  integer?: boolean;
}

export type GridSort = { key: string; direction: "asc" | "desc" } | null;

export const defaultGridSort: GridSort = { key: "createdAt", direction: "desc" };
export const defaultHiddenColumns: readonly string[] = ["updatedAt", "visitor"];

const columnWidths: Record<string, number> = {
  boolean: 96,
  number: 112,
  date: 140,
  email: 220,
  url: 220,
  choice: 150,
  text: 190,
  "long-text": 280,
};

export function humanizeName(name: string): string {
  return name.split(/[_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || name;
}

export function gridColumns(columns: readonly PageDataColumn[], options: { deleted?: boolean } = {}): GridColumn[] {
  const declared = columns.filter((column) => !column.name.startsWith("_")).map((column): GridColumn => ({
    key: column.name,
    label: humanizeName(column.name),
    type: column.type,
    retired: column.retired === true,
    system: false,
    width: columnWidths[column.type] ?? 180,
    ...(Array.isArray(column.options) ? { options: column.options.filter((option): option is string => typeof option === "string") } : {}),
    ...(column.required ? { required: true } : {}),
    ...(column.integer ? { integer: true } : {}),
  }));
  // Live columns first, then the ones page.json no longer collects.
  const ordered = [...declared.filter((column) => !column.retired), ...declared.filter((column) => column.retired)];
  return [
    ...ordered,
    { key: "createdAt", label: "Added", type: "timestamp", retired: false, system: true, width: 160 },
    { key: "updatedAt", label: "Changed", type: "timestamp", retired: false, system: true, width: 160 },
    ...(options.deleted ? [{ key: "deletedAt", label: "Deleted", type: "timestamp", retired: false, system: true, width: 160 }] : []),
    { key: "visitor", label: "Visitor", type: "visitor", retired: false, system: true, width: 120 },
  ];
}

/** Rows a page shows as "Visitor 1", "Visitor 2" in the order they first added something; the owner's are "You". */
export function visitorLabels(rows: readonly PageRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  const ordered = [...rows].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  let count = 0;
  for (const row of ordered) {
    const visitor = typeof row.visitor === "string" ? row.visitor : "";
    if (!visitor || labels.has(visitor) || visitor === "owner") continue;
    labels.set(visitor, `Visitor ${++count}`);
  }
  return labels;
}

const timestampFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const timestampWithYearFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

export function formatTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const date = new Date(time);
  return (date.getFullYear() === new Date().getFullYear() ? timestampFormat : timestampWithYearFormat).format(date);
}

/** How a value reads in a cell, the search, and the filters. */
export function displayValue(value: unknown, column: GridColumn, visitors: ReadonlyMap<string, string>): string {
  if (column.type === "visitor") {
    if (typeof value !== "string" || !value || value === "owner") return "You";
    return visitors.get(value) ?? "Visitor";
  }
  if (value === null || value === undefined || value === "") return "";
  if (column.type === "timestamp") return formatTimestamp(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return numberFormat.format(value);
  if (column.type === "date" && typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const time = Date.parse(`${value}T00:00:00Z`);
      return Number.isFinite(time) ? dateFormat.format(new Date(time)) : value;
    }
    return formatTimestamp(value);
  }
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export interface GridEntry {
  row: PageRow;
  /** Display text by column key. */
  text: Record<string, string>;
}

export function gridEntries(rows: readonly PageRow[], columns: readonly GridColumn[]): GridEntry[] {
  const visitors = visitorLabels(rows);
  return rows.map((row) => {
    const text: Record<string, string> = {};
    for (const column of columns) text[column.key] = displayValue(row[column.key], column, visitors);
    return { row, text };
  });
}

/** Search the shown columns; each column filter must match too. */
export function filterGridEntries(entries: readonly GridEntry[], columns: readonly GridColumn[], query: string, filters: Readonly<Record<string, string>>): GridEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const active = columns.filter((column) => (filters[column.key] ?? "").trim() !== "");
  if (!needle && !active.length) return [...entries];
  return entries.filter((entry) => {
    if (needle && !columns.some((column) => entry.text[column.key]?.toLocaleLowerCase().includes(needle))) return false;
    return active.every((column) => matchesFilter(entry.row[column.key], entry.text[column.key] ?? "", column, filters[column.key]!.trim()));
  });
}

export function matchesFilter(value: unknown, text: string, column: GridColumn, filter: string): boolean {
  if (filter === "(empty)") return value === null || value === undefined || value === "";
  if (column.type === "boolean") return filter === "yes" ? value === true : filter === "no" ? value === false : true;
  if (column.type === "choice") return text === filter;
  if (column.type === "number") {
    const comparison = filter.match(/^(<=|>=|<|>|=)?\s*(-?\d+(?:\.\d+)?)$/);
    if (comparison) {
      if (typeof value !== "number") return false;
      const target = Number(comparison[2]);
      switch (comparison[1]) {
        case "<": return value < target;
        case "<=": return value <= target;
        case ">": return value > target;
        case ">=": return value >= target;
        default: return value === target;
      }
    }
  }
  return text.toLocaleLowerCase().includes(filter.toLocaleLowerCase());
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Empty values sort last either way. */
export function sortGridEntries(entries: GridEntry[], columns: readonly GridColumn[], sort: GridSort): GridEntry[] {
  if (!sort) return entries;
  const column = columns.find((item) => item.key === sort.key);
  if (!column) return entries;
  const direction = sort.direction === "asc" ? 1 : -1;
  const key = column.key;
  const sortable = (entry: GridEntry): number | string | null => {
    const value = entry.row[key];
    if (value === null || value === undefined || value === "") return null;
    if (column.type === "timestamp" || (column.type === "date" && typeof value === "string")) {
      const time = Date.parse(String(value));
      return Number.isFinite(time) ? time : String(value);
    }
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return column.type === "visitor" ? entry.text[key] ?? "" : String(value);
  };
  return entries.map((entry, index) => ({ entry, index, value: sortable(entry) })).sort((left, right) => {
    if (left.value === null || right.value === null) return left.value === right.value ? left.index - right.index : left.value === null ? 1 : -1;
    const order = typeof left.value === "number" && typeof right.value === "number"
      ? left.value - right.value
      : collator.compare(String(left.value), String(right.value));
    return order === 0 ? left.index - right.index : order * direction;
  }).map((item) => item.entry);
}

export function nextSort(current: GridSort, key: string): GridSort {
  if (!current || current.key !== key) return { key, direction: key === "createdAt" || key === "updatedAt" || key === "deletedAt" ? "desc" : "asc" };
  if (current.direction === (key === "createdAt" || key === "updatedAt" || key === "deletedAt" ? "desc" : "asc")) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return defaultGridSort;
}

/** The first rows a person reads an entry by: its first filled, required text column. */
export function entryTitle(row: PageRow, columns: readonly GridColumn[]): string {
  const candidates = [...columns.filter((column) => !column.system && column.required && (column.type === "text" || column.type === "email")), ...columns.filter((column) => !column.system && column.type === "text")];
  for (const column of candidates) {
    const value = row[column.key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Entry";
}

/** What an edit sends: an empty field clears the value. */
export function editedValue(raw: string, column: GridColumn): unknown {
  if (column.type === "boolean") return raw === "yes" ? true : raw === "no" ? false : "";
  if (column.type === "number") {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : raw;
  }
  return raw;
}

export function editorText(value: unknown, column: GridColumn): string {
  if (value === null || value === undefined) return "";
  if (column.type === "boolean") return value === true ? "yes" : value === false ? "no" : "";
  return typeof value === "string" ? value : String(value);
}
