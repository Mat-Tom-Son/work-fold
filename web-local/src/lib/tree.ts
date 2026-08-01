import { normalizeSearchQuery } from "./format";
import type { TreeEntry } from "../types";

export function searchFileTree(entries: TreeEntry[], query: string): { entries: TreeEntry[]; matchCount: number } {
  const normalizedQuery = normalizeSearchQuery(query);
  let matchCount = 0;

  const filterEntry = (entry: TreeEntry): TreeEntry | null => {
    const selfMatches = treeEntryMatchesSearch(entry, normalizedQuery);
    if (selfMatches) matchCount += 1;
    if (entry.kind !== "folder") return selfMatches ? entry : null;
    if (selfMatches) return entry;
    const children = (entry.children ?? []).map(filterEntry).filter((child): child is TreeEntry => Boolean(child));
    return children.length ? { ...entry, children } : null;
  };

  return {
    entries: entries.map(filterEntry).filter((entry): entry is TreeEntry => Boolean(entry)),
    matchCount,
  };
}

export function treeEntryMatchesSearch(entry: TreeEntry, normalizedQuery: string): boolean {
  return entry.name.toLocaleLowerCase().includes(normalizedQuery) || entry.path.toLocaleLowerCase().includes(normalizedQuery);
}

export function spaceTreePathMissing(message: string): boolean {
  return message.includes("ENOENT") || message.includes("Requested space tree path is not a folder");
}

export function findTreeEntry(entries: TreeEntry[], path: string): TreeEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.kind === "folder" && entry.children?.length) {
      const found = findTreeEntry(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function treeEntryNeedsLazyChildren(entry: TreeEntry | null): boolean {
  return Boolean(entry?.kind === "folder" && entry.hasChildren && !entry.children?.length);
}

export function treeContainsUnloadedFolders(entries: TreeEntry[]): boolean {
  for (const entry of entries) {
    if (treeEntryNeedsLazyChildren(entry)) return true;
    if (entry.kind === "folder" && entry.children?.length && treeContainsUnloadedFolders(entry.children)) return true;
  }
  return false;
}

export function setTreeEntryChildren(entries: TreeEntry[], path: string, children: TreeEntry[]): TreeEntry[] {
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.path === path && entry.kind === "folder") {
      changed = true;
      return treeEntryWithChildren(entry, children, children.length > 0);
    }
    if (entry.kind === "folder" && entry.children?.length) {
      const nextChildren = setTreeEntryChildren(entry.children, path, children);
      if (nextChildren !== entry.children) {
        changed = true;
        return treeEntryWithChildren(entry, nextChildren, Boolean(entry.hasChildren || nextChildren.length));
      }
    }
    return entry;
  });
  return changed ? nextEntries : entries;
}

export function treeEntryWithChildren(entry: TreeEntry, children: TreeEntry[], hasChildren: boolean): TreeEntry {
  const descendantIgnoredCount = ignoredDescendantCount(children);
  const nextEntry = {
    ...entry,
    hasChildren,
    children,
  };
  if (descendantIgnoredCount) return { ...nextEntry, descendantIgnoredCount };
  const { descendantIgnoredCount: _ignored, ...withoutIgnoredCount } = nextEntry;
  return withoutIgnoredCount;
}

export function ignoredDescendantCount(entries: TreeEntry[]): number {
  return entries.reduce((total, entry) => total + (entry.ignored ? 1 : 0) + (entry.descendantIgnoredCount ?? 0), 0);
}

export function groupTreePathsByDepth(paths: string[]): string[][] {
  const groups: string[][] = [];
  for (const path of paths) {
    const depth = path.split("/").length;
    const group = groups[groups.length - 1];
    if (group?.[0]?.split("/").length === depth) {
      group.push(path);
    } else {
      groups.push([path]);
    }
  }
  return groups;
}

export function collectLoadedFolderPaths(entries: TreeEntry[], collapsedPaths: Set<string>, eventPaths?: string[]): string[] {
  const normalizedEventPaths = eventPaths?.map((path) => path.trim()).filter(Boolean) ?? [];
  const paths: string[] = [];
  const visit = (entry: TreeEntry) => {
    if (entry.kind !== "folder") return;
    const loaded = Boolean(entry.children?.length || (entry.hasChildren === false && !collapsedPaths.has(entry.path)));
    if (loaded && (!normalizedEventPaths.length || normalizedEventPaths.some((eventPath) => eventPathTouchesFolder(eventPath, entry.path)))) {
      paths.push(entry.path);
    }
    for (const child of entry.children ?? []) visit(child);
  };
  for (const entry of entries) visit(entry);
  return paths.sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
}

export function eventPathTouchesFolder(eventPath: string, folderPath: string): boolean {
  return eventPath === folderPath || eventPath.startsWith(`${folderPath}/`) || parentFolderPath(eventPath) === folderPath;
}

export function moveTreeEntry(entries: TreeEntry[], sourcePath: string, targetFolderPath: string): { entries: TreeEntry[]; movedPath: string; name: string } {
  if (!canMoveSpacePath(sourcePath, targetFolderPath)) return { entries, movedPath: sourcePath, name: sourcePath };
  const sourceEntry = findTreeEntry(entries, sourcePath);
  if (!sourceEntry) return { entries, movedPath: sourcePath, name: sourcePath.split("/").pop() ?? sourcePath };
  if (targetFolderPath && !findTreeEntry(entries, targetFolderPath)) return { entries, movedPath: sourcePath, name: sourceEntry.name };
  const movedPath = targetFolderPath ? `${targetFolderPath}/${sourceEntry.name}` : sourceEntry.name;
  const movedEntry = retargetTreeEntryPath(sourceEntry, movedPath);
  const withoutSource = removeTreeEntries(entries, new Set([sourcePath]));
  const withMoved = insertTreeEntry(withoutSource, targetFolderPath, movedEntry);
  return { entries: withMoved, movedPath, name: sourceEntry.name };
}

export function retargetTreeEntryPath(entry: TreeEntry, nextPath: string): TreeEntry {
  if (entry.kind !== "folder") return { ...entry, path: nextPath };
  const children = entry.children?.map((child) => {
    const childSuffix = child.path.slice(entry.path.length).replace(/^\/+/, "");
    return retargetTreeEntryPath(child, childSuffix ? `${nextPath}/${childSuffix}` : nextPath);
  });
  return { ...entry, path: nextPath, children };
}

export function insertTreeEntry(entries: TreeEntry[], targetFolderPath: string, movedEntry: TreeEntry): TreeEntry[] {
  if (!targetFolderPath) return sortTreeEntries([...entries, movedEntry]);
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.path === targetFolderPath && entry.kind === "folder") {
      changed = true;
      if (entry.hasChildren && !entry.children?.length) return entry;
      return {
        ...entry,
        hasChildren: true,
        children: sortTreeEntries([...(entry.children ?? []), movedEntry]),
      };
    }
    if (entry.kind === "folder" && entry.children?.length) {
      const nextChildren = insertTreeEntry(entry.children, targetFolderPath, movedEntry);
      if (nextChildren !== entry.children) {
        changed = true;
        return { ...entry, children: nextChildren, hasChildren: true };
      }
    }
    return entry;
  });
  return changed ? nextEntries : entries;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export function removeTreeEntries(entries: TreeEntry[], removedPaths: Set<string>): TreeEntry[] {
  let changed = false;
  const nextEntries: TreeEntry[] = [];
  for (const entry of entries) {
    if (removedPaths.has(entry.path)) {
      changed = true;
      continue;
    }
    if (entry.kind === "folder" && entry.children?.length) {
      const nextChildren = removeTreeEntries(entry.children, removedPaths);
      if (nextChildren !== entry.children) {
        changed = true;
        nextEntries.push({ ...entry, children: nextChildren });
        continue;
      }
    }
    nextEntries.push(entry);
  }
  return changed ? nextEntries : entries;
}

export function retargetMovedPath(path: string | null, sourcePath: string, movedPath: string): string | null {
  if (!path) return path;
  if (path === sourcePath) return movedPath;
  if (path.startsWith(`${sourcePath}/`)) return `${movedPath}${path.slice(sourcePath.length)}`;
  return path;
}

export function retargetMovedPathSet(paths: Set<string>, sourcePath: string, movedPath: string): Set<string> {
  return new Set([...paths].map((path) => retargetMovedPath(path, sourcePath, movedPath) ?? path));
}

export function canMoveSpacePath(sourcePath: string, targetFolderPath: string): boolean {
  if (!sourcePath) return false;
  if (sourcePath === targetFolderPath || targetFolderPath.startsWith(`${sourcePath}/`)) return false;
  return parentFolderPath(sourcePath) !== targetFolderPath;
}

export function fileExtension(path: string): string {
  const match = /\.[^.\\/]+$/.exec(path);
  return match ? match[0].toLowerCase() : "";
}

export function parentFolderPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function isInsideFolder(path: string, folderPath: string | null): boolean {
  if (folderPath === null) return false;
  if (folderPath === "") return true;
  return path !== folderPath && path.startsWith(`${folderPath}/`);
}

export function ancestorFolderPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

export function collectFolderPaths(entries: TreeEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "folder") continue;
    paths.push(entry.path);
    if (entry.children?.length) paths.push(...collectFolderPaths(entry.children));
  }
  return paths;
}

export function collectLoadedFileEntries(entries: TreeEntry[]): TreeEntry[] {
  const files: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "file") {
      files.push(entry);
      continue;
    }
    if (entry.children?.length) files.push(...collectLoadedFileEntries(entry.children));
  }
  return files;
}
