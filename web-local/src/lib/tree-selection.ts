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

/** The rows an action on the selection touches: a selected folder already carries whatever is selected inside it. */
export function outermostTreePaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].filter(Boolean);
  return unique.filter((path) => !unique.some((other) => other !== path && isInsideFolder(path, other)));
}

/** ⌘ on the Mac, Ctrl elsewhere: the key that adds a row to the selection or takes it out. */
export function isSelectionToggleKey(event: { metaKey: boolean; ctrlKey: boolean }, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}
