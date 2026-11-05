import { isInsideFolder } from "./tree";
import type { TreeEntry } from "../types";

/*
 * Files selects several rows the way Finder's list view does (2026-11-05): a
 * plain click selects one row, ⌘-click (Ctrl-click off the Mac) adds or
 * removes one, and Shift-click selects the run of shown rows from the last
 * clicked row. Rows for nested work-folders open that work-folder and are
 * never part of a selection.
 */

/** Every selectable row the tree shows, top to bottom: an open folder's children follow it, a closed folder's do not. */
export function visibleTreePaths(entries: readonly TreeEntry[], collapsedPaths: ReadonlySet<string>): string[] {
  const paths: string[] = [];
  const visit = (items: readonly TreeEntry[]) => {
    for (const entry of items) {
      if (entry.nestedFolder) continue;
      paths.push(entry.path);
      if (entry.kind === "folder" && entry.children?.length && !collapsedPaths.has(entry.path)) visit(entry.children);
    }
  };
  visit(entries);
  return paths;
}

/** The shown rows from `anchor` to `target`, both included; empty when either is not shown. */
export function treeSelectionRange(order: readonly string[], anchor: string, target: string): string[] {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return [];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/**
 * The rows a selection may keep. Normally just the shown ones; while a search
 * hides rows for the moment, every row still in the tree, so clearing the
 * search shows them selected again. Actions still cover only shown rows.
 */
export function selectableTreePaths(tree: readonly TreeEntry[], shownPaths: readonly string[], searching: boolean): readonly string[] {
  return searching ? visibleTreePaths(tree, new Set()) : shownPaths;
}

/** Every loaded row by its path, for looking many up at once (⌘A on a large tree). */
export function treeEntriesByPath(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  const byPath = new Map<string, TreeEntry>();
  const visit = (items: readonly TreeEntry[]) => {
    for (const entry of items) {
      byPath.set(entry.path, entry);
      if (entry.children?.length) visit(entry.children);
    }
  };
  visit(entries);
  return byPath;
}

/**
 * The rows an action on the selection touches, in the order given: a selected
 * folder already carries whatever is selected inside it. Sorted so that "/"
 * comes before every other character, a folder's rows directly follow it, and
 * one pass keeps each path that is not inside the last one kept.
 */
export function outermostTreePaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].filter(Boolean);
  const sortKey = (path: string) => path.replaceAll("/", "\u0000");
  const sorted = unique.map((path) => ({ path, key: sortKey(path) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const kept = new Set<string>();
  let last: string | null = null;
  for (const { path } of sorted) {
    if (last !== null && isInsideFolder(path, last)) continue;
    kept.add(path);
    last = path;
  }
  return unique.filter((path) => kept.has(path));
}

/** ⌘ on the Mac, Ctrl elsewhere: the key that adds a row to the selection or takes it out. */
export function isSelectionToggleKey(event: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}
