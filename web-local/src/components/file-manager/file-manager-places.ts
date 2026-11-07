/**
 * The places the file manager's sidebar opens (docs/product-model.md,
 * "2026-11-06 file manager layout"): a work-folder, or one of the Standard
 * Folders (Desktop, Documents, Downloads, Pictures, the home folder, iCloud
 * Drive, and any folder added with +).
 */
export type FileManagerPlace =
  | { kind: "work-folder"; id: string }
  | { kind: "standard"; id: string };

export interface FileManagerLocation { place: FileManagerPlace; path: string }

export interface StandardFolderSummary {
  id: string;
  name: string;
  root: string;
  /** Set when the folder is itself a registered work-folder. */
  workFolderId: string | null;
  /** A folder the person added with +, which Remove from Sidebar takes away. */
  added?: boolean;
}

export const standardFolderNames: Record<string, string> = { desktop: "Desktop", documents: "Documents", downloads: "Downloads", pictures: "Pictures", home: "Home", icloud: "iCloud Drive" };

export function placeKey(place: FileManagerPlace): string {
  return `${place.kind}:${place.id}`;
}

export function samePlace(left: FileManagerPlace, right: FileManagerPlace): boolean {
  return placeKey(left) === placeKey(right);
}

export function sameLocation(left: FileManagerLocation, right: FileManagerLocation): boolean {
  return samePlace(left.place, right.place) && left.path === right.path;
}

/** The local API routes for a place's files. */
export function placeApiBase(place: FileManagerPlace): string {
  return place.kind === "work-folder"
    ? `/api/work-folders/${encodeURIComponent(place.id)}`
    : `/api/standard-folders/${encodeURIComponent(place.id)}`;
}

export function placeEventsUrl(place: FileManagerPlace, path: string): string {
  const base = placeApiBase(place);
  if (place.kind === "work-folder") return `${base}/file-events`;
  return `${base}/events${path ? `?path=${encodeURIComponent(path)}` : ""}`;
}

/**
 * Standard Folders that are not registered work-folders. A registered one is
 * listed with the other work-folders instead, so it is never shown twice.
 */
export function sidebarStandardFolders(
  folders: readonly StandardFolderSummary[],
  workFolders: ReadonlyArray<{ id: string }>,
): StandardFolderSummary[] {
  const registered = new Set(workFolders.map((workFolder) => workFolder.id));
  return folders.filter((folder) => !folder.workFolderId || !registered.has(folder.workFolderId));
}
