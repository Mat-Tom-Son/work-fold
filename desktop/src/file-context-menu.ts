import { extname, isAbsolute } from "node:path";
import { fileSelectionLabel } from "../../src/shared/file-selection.js";

export type NativeFileMenuCommand =
  | "open"
  | "open-with"
  | "reveal"
  | "copy-path"
  | "attach-chat"
  | "version-history"
  | "new-folder"
  | "upload-here"
  | "refresh"
  | "give-worker"
  | "rename"
  | "delete"
  | "copy"
  | "paste"
  | "duplicate"
  | "compress"
  | "new-folder-with-selection";

export interface NativeFileMenuRequest {
  /** Empty when the entry is in a standard folder instead. */
  workFolderId: string;
  /**
   * Set instead of a work-folder id for an entry in Desktop, Documents, or
   * Downloads (the file manager's Standard Folders, optional; older renderers
   * omit it). Delete there is the system's Move to Trash.
   */
  standardFolderId?: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
    /** A plain folder inside this work-folder that can become its own work-folder (optional; older renderers omit it). */
    worker?: boolean;
    /**
     * The file manager's Finder actions (2026-11-07): Copy, Duplicate, Compress,
     * and New Folder with Selection for items, and Paste on the folder (optional).
     */
    organize?: boolean;
    paste?: boolean;
  };
  /**
   * Set when the clicked row is one of several selected together (optional;
   * older renderers omit it). The menu then offers only the actions that apply
   * to all of them, and the renderer applies the command to the whole selection.
   */
  selection?: { files: number; folders: number };
  point: { x: number; y: number };
}

export type NativeFileMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeFileMenuCommand; icon?: "work-fold" };

const requestKeys = new Set(["workFolderId", "standardFolderId", "path", "kind", "capabilities", "selection", "point"]);
const capabilityKeys = new Set(["open", "attach", "history", "upload", "rename", "delete", "worker", "organize", "paste"]);
const optionalCapabilityKeys = new Set(["worker", "organize", "paste"]);
const pointKeys = new Set(["x", "y"]);
const selectionKeys = new Set(["files", "folders"]);
const maxSelectionCount = 1_000_000;

export function parseNativeFileMenuRequest(value: unknown): NativeFileMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The native file menu request is invalid.");
  const workFolderId = typeof value.workFolderId === "string" ? value.workFolderId.trim() : "";
  const standardFolderId = typeof value.standardFolderId === "string" ? value.standardFolderId.trim() : "";
  if (typeof value.path !== "string") throw new Error("A safe relative work-folder path is required.");
  const path = value.path;
  const kind = value.kind;
  const capabilities = value.capabilities;
  const point = value.point;
  if (value.standardFolderId !== undefined) {
    if (workFolderId || !standardFolderId || standardFolderId.length > 64) throw new Error("A valid standard folder id is required.");
  } else if (!workFolderId || workFolderId.length > 512) throw new Error("A valid work-folder id is required.");
  if (path.length > 4096 || path.includes("\0") || isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new Error("A safe relative work-folder path is required.");
  }
  if (kind !== "file" && kind !== "folder") throw new Error("A valid work-folder entry kind is required.");
  if (!path && kind !== "folder") throw new Error("The work-folder root must be a folder.");
  if (!isRecord(capabilities) || !hasOnlyKeys(capabilities, capabilityKeys)) throw new Error("Native file menu capabilities are invalid.");
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys)) throw new Error("The native file menu position is invalid.");
  for (const key of capabilityKeys) {
    if (optionalCapabilityKeys.has(key) && capabilities[key] === undefined) continue;
    if (typeof capabilities[key] !== "boolean") throw new Error("Native file menu capabilities are invalid.");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The native file menu position is invalid.");
  const selection = value.selection === undefined ? undefined : parseSelection(value.selection);
  return {
    workFolderId,
    ...(standardFolderId ? { standardFolderId } : {}),
    path,
    kind,
    capabilities: {
      open: capabilities.open as boolean,
      attach: capabilities.attach as boolean,
      history: capabilities.history as boolean,
      upload: capabilities.upload as boolean,
      rename: capabilities.rename as boolean,
      delete: capabilities.delete as boolean,
      ...(capabilities.worker === true ? { worker: true } : {}),
      ...(capabilities.organize === true ? { organize: true } : {}),
      ...(capabilities.paste === true ? { paste: true } : {}),
    },
    ...(selection ? { selection } : {}),
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

function parseSelection(value: unknown): { files: number; folders: number } {
  if (!isRecord(value) || !hasOnlyKeys(value, selectionKeys)) throw new Error("The native file menu selection is invalid.");
  const { files, folders } = value;
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= maxSelectionCount;
  if (!count(files) || !count(folders) || files + folders < 2) throw new Error("The native file menu selection is invalid.");
  return { files, folders };
}

export function nativeFileMenuItems(request: NativeFileMenuRequest): NativeFileMenuItem[] {
  if (request.selection) return nativeSelectionMenuItems(request, request.selection);
  const items: NativeFileMenuItem[] = [];
  if (request.capabilities.open) {
    items.push({
      type: "item",
      label: request.kind === "folder" ? "Open Folder" : nativeFileOpenLabel(request.path),
      command: "open",
    });
  }
  if (request.kind === "file") items.push({ type: "item", label: "Open With", command: "open-with" });
  items.push(
    { type: "item", label: "Show in Finder", command: "reveal" },
    { type: "item", label: `Copy ${request.kind === "folder" ? "Folder" : "File"} Path`, command: "copy-path" },
  );
  if (request.capabilities.organize && request.path) {
    const name = request.path.slice(request.path.lastIndexOf("/") + 1);
    items.push(
      { type: "separator" },
      { type: "item", label: `Copy “${name}”`, command: "copy" },
      { type: "item", label: "Duplicate", command: "duplicate" },
      { type: "item", label: `Compress “${name}”`, command: "compress" },
    );
  }
  if (request.kind === "file" && request.capabilities.attach) {
    items.push({ type: "item", label: "Attach to Chat", command: "attach-chat" });
  }
  if (request.kind === "file" && request.capabilities.history) {
    items.push({ type: "item", label: "Version History", command: "version-history" });
  }
  if (request.kind === "folder") {
    items.push(
      { type: "separator" },
      { type: "item", label: "New Folder Here…", command: "new-folder" },
    );
    if (request.capabilities.paste) items.push({ type: "item", label: "Paste Here", command: "paste" });
    if (request.capabilities.upload) items.push({ type: "item", label: "Add Files Here…", command: "upload-here" });
    // Files has no toolbar buttons (2026-10-01): refreshing lives here with the other folder actions.
    items.push({ type: "item", label: "Refresh", command: "refresh" });
    if (request.capabilities.worker) {
      items.push({ type: "separator" }, { type: "item", label: "Make a work-folder", command: "give-worker", icon: "work-fold" });
    }
  }
  if (request.path && (request.capabilities.rename || request.capabilities.delete)) {
    items.push({ type: "separator" });
    if (request.capabilities.rename) items.push({ type: "item", label: "Rename…", command: "rename" });
    if (request.capabilities.delete) {
      items.push({ type: "item", label: request.standardFolderId ? "Move to Trash" : `Delete ${request.kind === "folder" ? "Folder" : "File"}`, command: "delete" });
    }
  }
  return items;
}

/** Several rows selected together: attach (files only), copy their paths, delete them. Single-row actions are left out. */
function nativeSelectionMenuItems(request: NativeFileMenuRequest, selection: { files: number; folders: number }): NativeFileMenuItem[] {
  const items: NativeFileMenuItem[] = [];
  if (request.capabilities.attach && selection.folders === 0) items.push({ type: "item", label: "Attach to Chat", command: "attach-chat" });
  items.push({ type: "item", label: "Copy Paths", command: "copy-path" });
  if (request.capabilities.organize) {
    const count = selection.files + selection.folders;
    items.push(
      { type: "separator" },
      { type: "item", label: `Copy ${count} Items`, command: "copy" },
      { type: "item", label: "Duplicate", command: "duplicate" },
      { type: "item", label: `Compress ${count} Items`, command: "compress" },
      { type: "item", label: `New Folder with Selection (${count} Items)`, command: "new-folder-with-selection" },
    );
  }
  if (request.capabilities.delete) {
    items.push({ type: "separator" }, { type: "item", label: request.standardFolderId ? "Move to Trash" : `Delete ${fileSelectionLabel(selection.files, selection.folders)}`, command: "delete" });
  }
  return items;
}

function nativeFileOpenLabel(path: string): string {
  const extension = extname(path).toLocaleLowerCase();
  if (extension === ".docx" || extension === ".dotx") return "Open in Word";
  if (extension === ".xlsx" || extension === ".csv") return "Open in Excel";
  if (extension === ".pptx" || extension === ".potx") return "Open in PowerPoint";
  return "Open";
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
