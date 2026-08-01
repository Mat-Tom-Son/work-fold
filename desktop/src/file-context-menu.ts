import { extname, isAbsolute } from "node:path";

export type NativeFileMenuCommand =
  | "open"
  | "reveal"
  | "copy-path"
  | "attach-chat"
  | "version-history"
  | "upload-here"
  | "rename"
  | "delete";

export interface NativeFileMenuRequest {
  spaceId: string;
  path: string;
  kind: "file" | "folder";
  capabilities: {
    open: boolean;
    attach: boolean;
    history: boolean;
    upload: boolean;
    rename: boolean;
    delete: boolean;
  };
  point: { x: number; y: number };
}

export type NativeFileMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeFileMenuCommand };

const requestKeys = new Set(["spaceId", "path", "kind", "capabilities", "point"]);
const capabilityKeys = new Set(["open", "attach", "history", "upload", "rename", "delete"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeFileMenuRequest(value: unknown): NativeFileMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The native file menu request is invalid.");
  const spaceId = typeof value.spaceId === "string" ? value.spaceId.trim() : "";
  if (typeof value.path !== "string") throw new Error("A safe relative Space path is required.");
  const path = value.path;
  const kind = value.kind;
  const capabilities = value.capabilities;
  const point = value.point;
  if (!spaceId || spaceId.length > 512) throw new Error("A valid Space id is required.");
  if (path.length > 4096 || path.includes("\0") || isAbsolute(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
    throw new Error("A safe relative Space path is required.");
  }
  if (kind !== "file" && kind !== "folder") throw new Error("A valid Space entry kind is required.");
  if (!path && kind !== "folder") throw new Error("The Space root must be a folder.");
  if (!isRecord(capabilities) || !hasOnlyKeys(capabilities, capabilityKeys)) throw new Error("Native file menu capabilities are invalid.");
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys)) throw new Error("The native file menu position is invalid.");
  for (const key of capabilityKeys) {
    if (typeof capabilities[key] !== "boolean") throw new Error("Native file menu capabilities are invalid.");
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The native file menu position is invalid.");
  return {
    spaceId,
    path,
    kind,
    capabilities: {
      open: capabilities.open as boolean,
      attach: capabilities.attach as boolean,
      history: capabilities.history as boolean,
      upload: capabilities.upload as boolean,
      rename: capabilities.rename as boolean,
      delete: capabilities.delete as boolean,
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
  if (request.kind === "folder" && request.capabilities.upload) {
    items.push(
      { type: "separator" },
      { type: "item", label: "Add Files Here…", command: "upload-here" },
    );
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
  return "Open in Default App";
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
