
/** The fields nesting reads; the renderer's and the kernel's Space records both fit. */
export interface NestableFolder {
  id: string;
  name: string;
  spaceRoot: string;
}

/**
 * Folders registered inside other Folders (2026-10-01). The registry already
 * allows nesting and the host treats each child as separately owned (History,
 * Search, Checks, routings); these helpers give the renderer and the host one
 * shared reading of that shape so the switcher, Files, the composer, and the
 * Workers' turn context agree.
 * The deepest containing Folder is the parent, matching the kernel's
 * cwd resolution.
 */

export interface FolderTreeRow<T extends NestableFolder = NestableFolder> {
  space: T;
  depth: number;
  parentId: string | null;
}

function slashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function comparablePath(value: string): string {
  const normalized = slashPath(value);
  // Drive-letter and UNC paths are Windows paths, which ignore case.
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

/** True when `childRoot` sits strictly inside `parentRoot`. */
export function folderRootContains(parentRoot: string, childRoot: string): boolean {
  const parent = comparablePath(parentRoot);
  const child = comparablePath(childRoot);
  return child !== parent && child.startsWith(`${parent}/`);
}

/** Each Folder's nearest containing Folder, or null for a top-level Folder. */
export function folderParentIds(spaces: readonly NestableFolder[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const space of spaces) {
    let parent: NestableFolder | null = null;
    for (const candidate of spaces) {
      if (candidate.id === space.id || !folderRootContains(candidate.spaceRoot, space.spaceRoot)) continue;
      if (!parent || comparablePath(candidate.spaceRoot).length > comparablePath(parent.spaceRoot).length) parent = candidate;
    }
    result.set(space.id, parent?.id ?? null);
  }
  return result;
}

/** Depth-first rows: top-level Folders A–Z, each followed by its children A–Z. */
export function folderTreeRows<T extends NestableFolder>(spaces: readonly T[]): FolderTreeRow<T>[] {
  const parents = folderParentIds(spaces);
  const childrenOf = new Map<string | null, T[]>();
  for (const space of spaces) {
    const parentId = parents.get(space.id) ?? null;
    const list = childrenOf.get(parentId) ?? [];
    list.push(space);
    childrenOf.set(parentId, list);
  }
  const rows: FolderTreeRow<T>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = [...(childrenOf.get(parentId) ?? [])].sort((left, right) => left.name.localeCompare(right.name));
    for (const space of list) {
      rows.push({ space, depth, parentId });
      visit(space.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The containing Folders of `space`, outermost first. */
export function folderAncestors<T extends NestableFolder>(space: NestableFolder, spaces: readonly T[]): T[] {
  const parents = folderParentIds(spaces);
  const byId = new Map(spaces.map((item) => [item.id, item]));
  const chain: T[] = [];
  let parentId = parents.get(space.id) ?? null;
  while (parentId && chain.length < spaces.length) {
    const parent = byId.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parents.get(parent.id) ?? null;
  }
  return chain;
}

/** The Folders directly inside `space`, A–Z. */
export function childFolders<T extends NestableFolder>(space: NestableFolder, spaces: readonly T[]): T[] {
  const parents = folderParentIds(spaces);
  return spaces
    .filter((item) => parents.get(item.id) === space.id)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Direct child Folders keyed by their path relative to `space`, as Files names entries. */
export function childFolderPaths<T extends NestableFolder>(space: NestableFolder, spaces: readonly T[]): Map<string, T> {
  // Slice the on-disk spelling, not the comparison form: Files and the host
  // name entries with their real case.
  const root = slashPath(space.spaceRoot);
  return new Map(childFolders(space, spaces).map((child) => [
    slashPath(child.spaceRoot).slice(root.length + 1),
    child,
  ]));
}

/** Every Folder nested anywhere inside `space`. */
export function descendantFolders<T extends NestableFolder>(space: NestableFolder, spaces: readonly T[]): T[] {
  return spaces.filter((item) => folderRootContains(space.spaceRoot, item.spaceRoot));
}
