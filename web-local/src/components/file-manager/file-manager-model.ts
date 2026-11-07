import type { TreeEntry } from "../../types";
import { descendantFolders, folderAncestors, folderTreeRows, type NestableFolder } from "../../../../src/shared/folder-nesting";

/**
 * Pure helpers for the file manager layout (docs/product-model.md, "File
 * manager layout"): ordering, labels, and selection, kept free of React so
 * tests can cover them directly.
 */

export type FileManagerSortKey = "name" | "modified" | "size" | "kind";
export interface FileManagerSort { key: FileManagerSortKey; ascending: boolean }
export type FileManagerView = "list" | "icons";

export const defaultFileManagerSort: FileManagerSort = { key: "name", ascending: true };

export function normalizeFileManagerSort(value: unknown): FileManagerSort {
  const candidate = value as Partial<FileManagerSort> | null;
  const key = candidate?.key;
  if (key !== "name" && key !== "modified" && key !== "size" && key !== "kind") return defaultFileManagerSort;
  return { key, ascending: candidate?.ascending !== false };
}

export function normalizeFileManagerView(value: unknown): FileManagerView {
  return value === "icons" ? "icons" : "list";
}

/** Clicking a column: the same column flips; a new one starts the way Finder does (newest and largest first). */
export function nextFileManagerSort(current: FileManagerSort, key: FileManagerSortKey): FileManagerSort {
  if (current.key === key) return { key, ascending: !current.ascending };
  return { key, ascending: key === "name" || key === "kind" };
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Finder order: folders and files mixed by name unless another column is chosen; name breaks ties. */
export function sortFileManagerEntries(entries: readonly TreeEntry[], sort: FileManagerSort, kindLabel: (entry: TreeEntry) => string = fileKindLabel): TreeEntry[] {
  const direction = sort.ascending ? 1 : -1;
  const byName = (a: TreeEntry, b: TreeEntry) => nameCollator.compare(a.name, b.name);
  return [...entries].sort((a, b) => {
    let order = 0;
    if (sort.key === "modified") order = timeValue(a.updatedAt) - timeValue(b.updatedAt);
    else if (sort.key === "size") order = sizeValue(a) - sizeValue(b);
    else if (sort.key === "kind") order = nameCollator.compare(kindLabel(a), kindLabel(b));
    else order = byName(a, b);
    return order !== 0 ? order * direction : byName(a, b);
  });
}

function timeValue(value: string | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function sizeValue(entry: TreeEntry): number {
  return entry.kind === "folder" ? -1 : entry.sizeBytes ?? 0;
}

const kindByExtension: Record<string, string> = {
  pdf: "PDF document",
  doc: "Word document", docx: "Word document",
  xls: "Excel spreadsheet", xlsx: "Excel spreadsheet",
  ppt: "PowerPoint presentation", pptx: "PowerPoint presentation",
  key: "Keynote presentation", numbers: "Numbers spreadsheet", pages: "Pages document",
  csv: "CSV document", tsv: "TSV document",
  txt: "Plain text", rtf: "Rich text document",
  md: "Markdown document", markdown: "Markdown document",
  json: "JSON document", yaml: "YAML document", yml: "YAML document", xml: "XML document",
  html: "HTML document", htm: "HTML document", css: "CSS stylesheet",
  js: "JavaScript source", mjs: "JavaScript source", cjs: "JavaScript source",
  ts: "TypeScript source", tsx: "TypeScript source", jsx: "JavaScript source",
  py: "Python source", rb: "Ruby source", go: "Go source", rs: "Rust source", swift: "Swift source",
  java: "Java source", c: "C source", h: "C header", cpp: "C++ source", sh: "Shell script",
  png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image", gif: "GIF image", heic: "HEIF image",
  webp: "WebP image", svg: "SVG image", tiff: "TIFF image", bmp: "BMP image",
  mp4: "MPEG-4 movie", mov: "QuickTime movie", m4v: "MPEG-4 movie",
  mp3: "MP3 audio", m4a: "Apple MPEG-4 audio", wav: "WAV audio", aiff: "AIFF audio",
  zip: "ZIP archive", gz: "Gzip archive", tar: "Tar archive",
  dmg: "Disk image", pkg: "Installer package", app: "Application",
  sqlite: "SQLite database", db: "Database",
};

export function fileKindLabel(entry: Pick<TreeEntry, "kind" | "name">): string {
  if (entry.kind === "folder") return "Folder";
  const dot = entry.name.lastIndexOf(".");
  if (dot <= 0 || dot === entry.name.length - 1) return "Document";
  const extension = entry.name.slice(dot + 1).toLowerCase();
  return kindByExtension[extension] ?? `${extension.toUpperCase()} file`;
}

export interface FileManagerIcon { className: string; label: string }

const iconByExtension: Record<string, { kind: "doc" | "img" | "media" | "box"; tag?: string; label?: string }> = {
  pdf: { kind: "doc", tag: "pdf", label: "PDF" },
  doc: { kind: "doc", tag: "word", label: "DOC" }, docx: { kind: "doc", tag: "word", label: "DOCX" }, pages: { kind: "doc", tag: "word", label: "PAGES" }, rtf: { kind: "doc", tag: "word", label: "RTF" },
  xls: { kind: "doc", tag: "sheet", label: "XLS" }, xlsx: { kind: "doc", tag: "sheet", label: "XLSX" }, numbers: { kind: "doc", tag: "sheet", label: "NUM" }, csv: { kind: "doc", tag: "sheet", label: "CSV" }, tsv: { kind: "doc", tag: "sheet", label: "TSV" },
  ppt: { kind: "doc", tag: "slides", label: "PPT" }, pptx: { kind: "doc", tag: "slides", label: "PPTX" }, key: { kind: "doc", tag: "slides", label: "KEY" },
  html: { kind: "doc", tag: "web", label: "HTML" }, htm: { kind: "doc", tag: "web", label: "HTML" }, css: { kind: "doc", tag: "web", label: "CSS" },
  json: { kind: "doc", tag: "data", label: "JSON" }, yaml: { kind: "doc", tag: "data", label: "YAML" }, yml: { kind: "doc", tag: "data", label: "YAML" }, xml: { kind: "doc", tag: "data", label: "XML" }, sqlite: { kind: "doc", tag: "data", label: "DB" }, db: { kind: "doc", tag: "data", label: "DB" },
  js: { kind: "doc", tag: "code", label: "JS" }, mjs: { kind: "doc", tag: "code", label: "JS" }, cjs: { kind: "doc", tag: "code", label: "JS" }, jsx: { kind: "doc", tag: "code", label: "JSX" },
  ts: { kind: "doc", tag: "code", label: "TS" }, tsx: { kind: "doc", tag: "code", label: "TSX" }, py: { kind: "doc", tag: "code", label: "PY" }, rb: { kind: "doc", tag: "code", label: "RB" },
  go: { kind: "doc", tag: "code", label: "GO" }, rs: { kind: "doc", tag: "code", label: "RS" }, swift: { kind: "doc", tag: "code", label: "SWIFT" }, java: { kind: "doc", tag: "code", label: "JAVA" },
  c: { kind: "doc", tag: "code", label: "C" }, h: { kind: "doc", tag: "code", label: "H" }, cpp: { kind: "doc", tag: "code", label: "C++" }, sh: { kind: "doc", tag: "code", label: "SH" },
  md: { kind: "doc", label: "MD" }, markdown: { kind: "doc", label: "MD" }, txt: { kind: "doc", label: "TXT" },
  png: { kind: "img" }, jpg: { kind: "img" }, jpeg: { kind: "img" }, gif: { kind: "img" }, heic: { kind: "img" }, webp: { kind: "img" }, svg: { kind: "img" }, tiff: { kind: "img" }, bmp: { kind: "img" },
  mp4: { kind: "media" }, mov: { kind: "media" }, m4v: { kind: "media" }, mp3: { kind: "media" }, m4a: { kind: "media" }, wav: { kind: "media" }, aiff: { kind: "media" },
  zip: { kind: "box" }, gz: { kind: "box" }, tar: { kind: "box" }, dmg: { kind: "box" }, pkg: { kind: "box" },
};

/** The mockup's Finder-shaped icon for a row: a folder, a page with a type band, a picture, or a package. */
export function fileManagerIcon(entry: Pick<TreeEntry, "kind" | "name">): FileManagerIcon {
  if (entry.kind === "folder") return { className: "fm-ic fm-ic-folder", label: "" };
  const dot = entry.name.lastIndexOf(".");
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  const known = iconByExtension[extension];
  if (known?.kind === "img") return { className: "fm-ic fm-ic-img", label: "" };
  if (known?.kind === "media") return { className: "fm-ic fm-ic-img fm-ic-media", label: "" };
  if (known?.kind === "box") return { className: "fm-ic fm-ic-box", label: "" };
  const label = known?.label ?? (extension && extension.length <= 5 ? extension.toUpperCase() : "");
  return { className: `fm-ic fm-ic-doc${known?.tag ? ` fm-tag-${known.tag}` : ""}`, label };
}

/** Finder's list-view dates: "Today at 9:12 AM", "Yesterday at 3:40 PM", "Nov 4, 2026 at 9:12 AM". */
export function formatFileManagerDate(value: string | undefined, now: Date = new Date()): string {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1_000;
  if (date.getTime() >= startOfToday && date.getTime() < startOfToday + day) return `Today at ${time}`;
  if (date.getTime() >= startOfToday - day && date.getTime() < startOfToday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${time}`;
}

/**
 * One path bar item. `path` is the folder it opens inside the place (null when
 * it opens nothing here); `nativePath` is where it is on this computer, which
 * clicking it copies. A collapsed run of folders is one "…" item.
 */
export interface FileManagerCrumb { label: string; path: string | null; nativePath: string; hidden?: string[] }

/**
 * Finder's path bar: the disk, every folder down to the place, the folders
 * inside it, then the selected item. The place and its folders can be
 * clicked; folders above the place and the selected item cannot.
 */
export function fileManagerPathBar(placeRoot: string, path: string, focusName?: string | null): FileManagerCrumb[] {
  const above = nativePathParts(placeRoot);
  const rootPaths = nativeAncestorPaths(placeRoot);
  const crumbs: FileManagerCrumb[] = above.map((label, index) => ({ label, path: index === above.length - 1 ? "" : null, nativePath: rootPaths[index] ?? placeRoot }));
  const parts = path.split("/").filter(Boolean);
  const join = (...items: string[]) => [placeRoot.replace(/[\\/]+$/, ""), ...items].join(placeRoot.includes("\\") && !placeRoot.includes("/") ? "\\" : "/");
  parts.forEach((part, index) => crumbs.push({ label: part, path: parts.slice(0, index + 1).join("/"), nativePath: join(...parts.slice(0, index + 1)) }));
  if (focusName) crumbs.push({ label: focusName, path: null, nativePath: join(...parts, focusName) });
  return crumbs;
}

/** The path of every item nativePathParts names, in the same order ("Macintosh HD" is "/"). */
function nativeAncestorPaths(root: string): string[] {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const volume = /^(\/Volumes\/[^/]+)(\/.*)?$/.exec(normalized);
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(normalized);
  const [base, rest] = volume ? [volume[1]!, volume[2] ?? ""] : drive ? [drive[1]!, drive[2] ?? ""] : ["/", normalized];
  const parts = rest.split("/").filter(Boolean);
  const separator = drive ? "\\" : "/";
  const paths = [drive ? `${base}\\` : base];
  parts.forEach((_, index) => paths.push(`${base === "/" ? "" : base}${separator}${parts.slice(0, index + 1).join(separator)}`));
  return paths;
}

/**
 * A long path as Finder's path bar keeps it readable: the disk, then "…" for
 * the folders in between, then the last few, which stay whole.
 */
export function collapseCrumbs(crumbs: readonly FileManagerCrumb[], keepTail = 4): FileManagerCrumb[] {
  if (crumbs.length <= keepTail + 2) return [...crumbs];
  const hidden = crumbs.slice(1, crumbs.length - keepTail);
  return [crumbs[0]!, { label: "…", path: null, nativePath: hidden.at(-1)!.nativePath, hidden: hidden.map((crumb) => crumb.label) }, ...crumbs.slice(crumbs.length - keepTail)];
}

/** A folder on this computer as Finder names it: the disk first, then each folder. */
export function nativePathParts(root: string): string[] {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const volume = /^\/Volumes\/([^/]+)(\/.*)?$/.exec(normalized);
  if (volume) return [volume[1]!, ...(volume[2] ?? "").split("/").filter(Boolean)];
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(normalized);
  if (drive) return [drive[1]!, ...(drive[2] ?? "").split("/").filter(Boolean)];
  return ["Macintosh HD", ...normalized.split("/").filter(Boolean)];
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** Shift-click: every row between the anchor and the clicked row, in shown order. */
export function rangeSelection(order: readonly string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target);
  if (end < 0) return [];
  const start = anchor ? order.indexOf(anchor) : -1;
  if (start < 0) return [target];
  const [low, high] = start <= end ? [start, end] : [end, start];
  return order.slice(low, high + 1);
}

/** Typing a name's first letters jumps to it, starting just after the current row. */
export function typeSelectMatch(entries: readonly TreeEntry[], typed: string, currentPath: string | null): string | null {
  const needle = typed.toLocaleLowerCase();
  if (!needle) return null;
  const startsWith = (entry: TreeEntry) => entry.name.toLocaleLowerCase().startsWith(needle);
  // A repeated single letter cycles through the names that start with it.
  if (needle.length === 1 && currentPath) {
    const from = entries.findIndex((entry) => entry.path === currentPath);
    for (let step = 1; step <= entries.length; step += 1) {
      const candidate = entries[(from + step) % entries.length];
      if (candidate && startsWith(candidate)) return candidate.path;
    }
    return null;
  }
  return entries.find(startsWith)?.path ?? null;
}

export type HistoryDay = "Today" | "Yesterday" | "This Week" | "Earlier";

/** History groups by day, the week starting Monday, as in the mockup. */
export function historyDay(value: string, now: Date = new Date()): HistoryDay {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Earlier";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1_000;
  if (time >= startOfToday) return "Today";
  if (time >= startOfToday - day) return "Yesterday";
  const sinceMonday = (now.getDay() + 6) % 7;
  if (time >= startOfToday - sinceMonday * day) return "This Week";
  return "Earlier";
}

/**
 * When a History row happened, in Finder's words: "Today at 1:39 AM",
 * "Yesterday at …", the weekday this week, else the date. History lists
 * changes and Chats in two sections rather than under day headings, so each
 * row carries its own day.
 */
export function historyTimeLabel(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const group = historyDay(value, now);
  if (group === "Today" || group === "Yesterday") return `${group} at ${time}`;
  if (group === "This Week") return `${date.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** "3 items", "1 of 12 selected", "2 of 12 selected". */
export function fileManagerStatusText(total: number, selected: number): string {
  if (selected > 0) return `${selected} of ${total} selected`;
  return `${total} ${total === 1 ? "item" : "items"}`;
}

/**
 * The suggested messages above the message box on the Info tab, as the
 * design shows them: up to four, or two when the folder already has
 * Automations on. These are plain fallbacks: the owner wants them written by
 * a model from the folder's context and its earlier Chats (2026-11-07), which
 * will replace this function's answers, not its place.
 */
export function fileManagerSuggestions(input: { selection: ReadonlyArray<{ kind: "file" | "folder" }>; inSubfolder: boolean; automationsOn?: boolean }): string[] {
  const { selection } = input;
  let suggestions: string[];
  if (selection.length > 1) suggestions = ["Summarize each", "Put these in a folder", "Give them clearer names"];
  else if (selection.length === 1 && selection[0]!.kind === "folder") suggestions = ["What’s in here?", "Organize this folder"];
  else if (selection.length === 1) suggestions = ["Summarize", "Give it a clearer name", "Where should this go?"];
  else if (input.inSubfolder) suggestions = ["What’s in here?", "Organize this folder", "What changed this week?"];
  else suggestions = ["What’s in here?", "What changed this week?", "Organize this folder", "Find duplicate files"];
  return suggestions.slice(0, !selection.length && input.automationsOn ? 2 : 4);
}

/** One work-folder row in the sidebar's tree. */
export interface SidebarWorkFolderRow<T extends NestableFolder> {
  workFolder: T;
  depth: number;
  /** Every work-folder inside it, at any depth: a caret shows when there is one. */
  inside: T[];
  open: boolean;
}

/**
 * The sidebar's work-folders (owner request, 2026-11-07): each sub
 * work-folder under its parent, A–Z at every level, shown only while every
 * work-folder around it is open.
 */
export function sidebarWorkFolderRows<T extends NestableFolder>(workFolders: readonly T[], open: readonly string[]): SidebarWorkFolderRow<T>[] {
  const openIds = new Set(open);
  return folderTreeRows(workFolders)
    .filter((row) => folderAncestors(row.workFolder, workFolders).every((ancestor) => openIds.has(ancestor.id)))
    .map((row) => ({ workFolder: row.workFolder, depth: row.depth, inside: descendantFolders(row.workFolder, workFolders), open: openIds.has(row.workFolder.id) }));
}

/** The closed work-folders around one, outermost first: opening them brings it into view. */
export function closedSidebarParents(workFolder: NestableFolder, workFolders: readonly NestableFolder[], open: readonly string[]): string[] {
  return folderAncestors(workFolder, workFolders).map((item) => item.id).filter((id) => !open.includes(id));
}

/** Where a navigation starts or ends: a place (by its key) and a folder path inside it. */
export interface NavigationStop { placeKey: string; path: string }

/** Which side a folder you go to comes in from: deeper or forward from the right, up or back from the left. */
export function navigationSide(from: NavigationStop, to: NavigationStop, history: "push" | "back" | "forward"): "left" | "right" | "none" {
  if (history === "back") return "left";
  if (history === "forward") return "right";
  if (from.placeKey !== to.placeKey) return "none";
  if (!from.path || to.path.startsWith(`${from.path}/`)) return to.path ? "right" : "none";
  if (!to.path || from.path.startsWith(`${to.path}/`)) return "left";
  return "none";
}
