import { extname, isAbsolute } from "node:path";

export type NativeFileMenuCommand =
  | "open"
  | "open-with"
  | "reveal"
  | "copy-path"
  | "attach-chat"
  | "version-history"
  | "share"
  | "new-folder"
  | "upload-here"
  | "refresh"
  | "give-worker"
  | "rename"
  | "delete";

export interface NativeFileMenuRequest {
  workFolderId: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
    /** The file type can be shared as a page; `shared` says it already is. */
    share: boolean;
    shared: boolean;
    /** A plain folder inside this work-folder that can become its own work-folder (optional; older renderers omit it). */
    worker?: boolean;
  };
  point: { x: number; y: number };
}

export type NativeFileMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeFileMenuCommand; icon?: "work-fold" };

const requestKeys = new Set(["workFolderId", "path", "kind", "capabilities", "point"]);
const capabilityKeys = new Set(["open", "attach", "history", "upload", "rename", "delete", "share", "shared", "worker"]);
const optionalCapabilityKeys = new Set(["worker"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeFileMenuRequest(value: unknown): NativeFileMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The native file menu request is invalid.");
  const workFolderId = typeof value.workFolderId === "string" ? value.workFolderId.trim() : "";
  if (typeof value.path !== "string") throw new Error("A safe relative work-folder path is required.");
  const path = value.path;
  const kind = value.kind;
  const capabilities = value.capabilities;
  const point = value.point;
  if (!workFolderId || workFolderId.length > 512) throw new Error("A valid work-folder id is required.");
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
  return {
    workFolderId,
    path,
    kind,
    capabilities: {
      open: capabilities.open as boolean,
      attach: capabilities.attach as boolean,
      history: capabilities.history as boolean,
      upload: capabilities.upload as boolean,
      rename: capabilities.rename as boolean,
      delete: capabilities.delete as boolean,
      share: capabilities.share as boolean,
      shared: capabilities.shared as boolean,
      ...(capabilities.worker === true ? { worker: true } : {}),
    },
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

export function nativeFileMenuItems(request: NativeFileMenuRequest): NativeFileMenuItem[] {
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
  if (request.kind === "file" && request.capabilities.attach) {
    items.push({ type: "item", label: "Attach to Chat", command: "attach-chat" });
  }
  if (request.kind === "file" && request.capabilities.history) {
    items.push({ type: "item", label: "Version History", command: "version-history" });
  }
  if (request.kind === "file" && request.capabilities.share) {
    items.push({ type: "item", label: request.capabilities.shared ? "Shared" : "Share", command: "share" });
  }
  if (request.kind === "folder") {
    items.push(
      { type: "separator" },
      { type: "item", label: "New Folder Here…", command: "new-folder" },
    );
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
      items.push({ type: "item", label: `Delete ${request.kind === "folder" ? "Folder" : "File"}`, command: "delete" });
    }
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
