import type React from "react";
import { workFolderPathDragType, workFolderPathsDragType } from "../constants";
import { desktopPlatform, type DesktopPlatform } from "./platform";
import { fileExtension } from "./tree";
import type { ChangeEntry, TreeEntry } from "../types";

function nativeOpenLabel(entry: TreeEntry, platform: DesktopPlatform = desktopPlatform()): { text: string; office: boolean } {
  if (entry.kind === "folder") return { text: "Open Folder", office: false };
  const extension = fileExtension(entry.path);
  if ([".doc", ".docm", ".dot", ".dotm", ".xls", ".xlsb", ".xlsm", ".ppt", ".pptm"].includes(extension)) return { text: revealInFileManagerLabel(platform), office: true };
  if ([".docx", ".dotx"].includes(extension)) return { text: "Open in Word", office: true };
  if ([".xlsx", ".csv"].includes(extension)) return { text: "Open in Excel", office: true };
  if ([".pptx", ".potx"].includes(extension)) return { text: "Open in PowerPoint", office: true };
  return { text: "Open", office: false };
}

function canOpenDirectly(path: string): boolean {
  const extension = fileExtension(path);
  return new Set([
    ".pdf",
    ".docx",
    ".dotx",
    ".xlsx",
    ".csv",
    ".pptx",
    ".potx",
    ".txt",
    ".md",
    ".markdown",
    ".rtf",
    ".json",
    ".xml",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
  ]).has(extension);
}

function revealInFileManagerLabel(platform: DesktopPlatform = desktopPlatform()): string {
  if (platform === "win32") return "Show in File Explorer";
  if (platform === "darwin") return "Show in Finder";
  return "Show in File Manager";
}

function hasNativeFiles(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function hasWorkFolderPathDrag(event: React.DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(workFolderPathDragType);
}

/**
 * The rows a Files drag carries: every selected row when several were dragged
 * together, else the one row. A single-row drag also sets the one-path type,
 * which older drop targets read.
 */
function draggedWorkFolderPaths(dataTransfer: DataTransfer): string[] {
  try {
    const several: unknown = JSON.parse(dataTransfer.getData(workFolderPathsDragType) || "null");
    if (Array.isArray(several) && several.length && several.every((path) => typeof path === "string" && path)) return several;
  } catch { /* not a several-row drag */ }
  const one = dataTransfer.getData(workFolderPathDragType) || dataTransfer.getData("text/plain");
  return one ? [one] : [];
}

function changeStatusText(change: ChangeEntry): string {
  if (change.kind === "created") return "New local file";
  if (change.kind === "modified") return "Modified locally";
  if (change.kind === "remote_deleted") return "Deleted outside work-fold. Restore it from History or remove the local record.";
  return "Deleted locally. You can restore it from History while a restore point is available.";
}

function treeChangeLabel(change: ChangeEntry): string {
  if (change.kind === "created") return "New local";
  if (change.kind === "modified") return "Edited local";
  if (change.kind === "remote_deleted") return "Deleted outside work-fold";
  return "Deleted local";
}

export { canOpenDirectly, changeStatusText, draggedWorkFolderPaths, hasNativeFiles, hasWorkFolderPathDrag, nativeOpenLabel, revealInFileManagerLabel, treeChangeLabel };
