import type { TreeEntry } from "../types";

export type FileSortKey = "name" | "modified" | "size" | "kind";
export type FileSortDirection = "asc" | "desc";
export interface FileSort { key: FileSortKey; direction: FileSortDirection }

export const defaultFileSort: FileSort = { key: "name", direction: "asc" };
export const fileSortStorageKey = "work-fold.work-folder.file-sort.v1";

/** The menu's choices, in order, with the direction each starts in. */
export const fileSortOptions: ReadonlyArray<{ key: FileSortKey; label: string; firstDirection: FileSortDirection }> = [
  { key: "name", label: "Name", firstDirection: "asc" },
  { key: "modified", label: "Date modified", firstDirection: "desc" },
  { key: "size", label: "Size", firstDirection: "desc" },
  { key: "kind", label: "Kind", firstDirection: "asc" },
];

/** Choosing the current option again flips it; a new option starts in its natural direction. */
export function nextFileSort(current: FileSort, key: FileSortKey): FileSort {
  if (current.key === key) return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key, direction: fileSortOptions.find((option) => option.key === key)?.firstDirection ?? "asc" };
}

/** Reads a stored sort, falling back to the default for anything unexpected. */
export function normalizeFileSort(value: unknown): FileSort {
  if (!value || typeof value !== "object") return defaultFileSort;
  const { key, direction } = value as Partial<Record<keyof FileSort, unknown>>;
  if (!fileSortOptions.some((option) => option.key === key)) return defaultFileSort;
  if (direction !== "asc" && direction !== "desc") return defaultFileSort;
  return { key: key as FileSortKey, direction };
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareNames(left: TreeEntry, right: TreeEntry): number {
  return nameCollator.compare(left.name, right.name) || left.name.localeCompare(right.name);
}

function extensionOf(entry: TreeEntry): string {
  if (entry.kind === "folder") return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLocaleLowerCase() : "";
}

function timeOf(entry: TreeEntry): number | null {
  const time = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Orders one folder level: folders first, then files, each by the chosen key.
 * Entries without the key's value (a folder's size, an unknown date) sort by
 * name after the ones that have it, whichever direction is chosen.
 */
function compareEntries(left: TreeEntry, right: TreeEntry, sort: FileSort): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  const sign = sort.direction === "asc" ? 1 : -1;
  if (sort.key === "name") return sign * compareNames(left, right);
  if (sort.key === "kind") return sign * (nameCollator.compare(extensionOf(left), extensionOf(right)) || compareNames(left, right));
  const leftValue = sort.key === "size" ? (left.kind === "file" ? left.sizeBytes ?? null : null) : timeOf(left);
  const rightValue = sort.key === "size" ? (right.kind === "file" ? right.sizeBytes ?? null : null) : timeOf(right);
  if (leftValue === null || rightValue === null) {
    if (leftValue !== rightValue) return leftValue === null ? 1 : -1;
    return compareNames(left, right);
  }
  return sign * (leftValue - rightValue) || compareNames(left, right);
}

/** Sorts every level of a Files tree without changing its shape. */
export function sortFileTree(entries: TreeEntry[], sort: FileSort): TreeEntry[] {
  return [...entries]
    .sort((left, right) => compareEntries(left, right, sort))
    .map((entry) => entry.children?.length ? { ...entry, children: sortFileTree(entry.children, sort) } : entry);
}
