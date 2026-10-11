
/** The fields nesting reads; the renderer's and the kernel's work-folder records both fit. */
export interface NestableFolder {
  id: string;
  name: string;
  workFolderRoot: string;
}

/**
 * work-folders registered inside other work-folders (2026-10-01). The registry already
 * allows nesting and the host treats each child as separately owned (History,
 * Search, Checks, automations); these helpers give the renderer and the host one
 * shared reading of that shape so the switcher, Files, the composer, and the
 * Workers' turn context agree.
 * The deepest containing work-folder is the parent, matching the kernel's
 * cwd resolution.
 */

export interface FolderTreeRow<T extends NestableFolder = NestableFolder> {
  workFolder: T;
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

/** Each work-folder's nearest containing work-folder, or null for a top-level work-folder. */
export function folderParentIds(workFolders: readonly NestableFolder[]): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const workFolder of workFolders) {
    let parent: NestableFolder | null = null;
    for (const candidate of workFolders) {
      if (candidate.id === workFolder.id || !folderRootContains(candidate.workFolderRoot, workFolder.workFolderRoot)) continue;
      if (!parent || comparablePath(candidate.workFolderRoot).length > comparablePath(parent.workFolderRoot).length) parent = candidate;
    }
    result.set(workFolder.id, parent?.id ?? null);
  }
  return result;
}

/** Depth-first rows: top-level work-folders A–Z, each followed by its children A–Z. */
export function folderTreeRows<T extends NestableFolder>(workFolders: readonly T[]): FolderTreeRow<T>[] {
  const parents = folderParentIds(workFolders);
  const childrenOf = new Map<string | null, T[]>();
  for (const workFolder of workFolders) {
    const parentId = parents.get(workFolder.id) ?? null;
    const list = childrenOf.get(parentId) ?? [];
    list.push(workFolder);
    childrenOf.set(parentId, list);
  }
  const rows: FolderTreeRow<T>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = [...(childrenOf.get(parentId) ?? [])].sort((left, right) => left.name.localeCompare(right.name));
    for (const workFolder of list) {
      rows.push({ workFolder, depth, parentId });
      visit(workFolder.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The containing work-folders of `work-folder`, outermost first. */
export function folderAncestors<T extends NestableFolder>(workFolder: NestableFolder, workFolders: readonly T[]): T[] {
  const parents = folderParentIds(workFolders);
  const byId = new Map(workFolders.map((item) => [item.id, item]));
  const chain: T[] = [];
  let parentId = parents.get(workFolder.id) ?? null;
  while (parentId && chain.length < workFolders.length) {
    const parent = byId.get(parentId);
    if (!parent) break;
    chain.unshift(parent);
    parentId = parents.get(parent.id) ?? null;
  }
  return chain;
}

/** The work-folders directly inside `work-folder`, A–Z. */
export function childFolders<T extends NestableFolder>(workFolder: NestableFolder, workFolders: readonly T[]): T[] {
  const parents = folderParentIds(workFolders);
  return workFolders
    .filter((item) => parents.get(item.id) === workFolder.id)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Direct child work-folders keyed by their path relative to `work-folder`, as Files names entries. */
export function childFolderPaths<T extends NestableFolder>(workFolder: NestableFolder, workFolders: readonly T[]): Map<string, T> {
  // Slice the on-disk spelling, not the comparison form: Files and the host
  // name entries with their real case.
  const root = slashPath(workFolder.workFolderRoot);
  return new Map(childFolders(workFolder, workFolders).map((child) => [
    slashPath(child.workFolderRoot).slice(root.length + 1),
    child,
  ]));
}

/** Every work-folder nested anywhere inside `work-folder`. */
export function descendantFolders<T extends NestableFolder>(workFolder: NestableFolder, workFolders: readonly T[]): T[] {
  return workFolders.filter((item) => folderRootContains(workFolder.workFolderRoot, item.workFolderRoot));
}
