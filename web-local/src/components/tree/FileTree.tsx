import React, { useEffect, useRef } from "react";
import { ArrowRight, ChevronRight, Loader2, PageIcon } from "../chrome/icons";
import { fileTreeFileIcon, fileTreeFolderIcon, type FileTreeIconSpec } from "../../file-tree-icons";
import { FileIconFrame } from "./FileIconFrame";
import { hasNativeFiles, hasWorkFolderPathDrag } from "../../lib/file-actions";
import { desktopFileDragHint, isMacOS } from "../../lib/platform";
import { isInsideFolder, parentFolderPath, treeEntryNeedsLazyChildren } from "../../lib/tree";
import { isSelectionToggleKey } from "../../lib/tree-selection";
import { workFolderIdentityStyle, type WorkFolderIdentity } from "../../lib/work-folder-identity";
import type { ChatActivityStatus, WorkFolderSummary, TreeEntry } from "../../types";
import { ActivityDot } from "../chrome/ActivityDot";
import { EmptyInline, WorkFolderIconGlyph } from "../chrome/common";

/** A page folder (docs/pages.md): it shows a page icon and opens its page tab. */
export interface PageFolderView {
  title: string;
}

/** A work-folder registered inside this one, as Files shows it (2026-10-01). */
export interface NestedFolderView {
  workFolder: WorkFolderSummary;
  identity: WorkFolderIdentity;
  status?: ChatActivityStatus | null;
}

export function FileTree({
  entries,
  collapsedPaths,
  loadingFolderPaths,
  selectedPath,
  selectedPaths,
  movingTreePaths,
  dropTargetFolderPath,
  checkAttentionPaths = new Set<string>(),
  searchQuery = "",
  emptyText = "This folder is empty.",
  emptyContent,
  level = 1,
  onToggleFolder,
  onSelectFile,
  onFocusEntry,
  onToggleSelected,
  onSelectRange,
  onSelectAll,
  onPreviewFile,
  onOpenFile,
  onOpenContextMenu,
  onRenameEntry,
  onDeleteEntry,
  onUpdateDropTarget,
  onDropOnTarget,
  onNativeDragStartFile,
  onDragStartEntry,
  onDragEndEntry,
  nestedFolders,
  onOpenNestedFolder,
  pageFolders,
  onOpenPage,
}: {
  entries: TreeEntry[];
  /** Page folders keyed by their path; a plain click or Enter opens the page, the arrow opens the folder. */
  pageFolders?: ReadonlyMap<string, PageFolderView>;
  onOpenPage?: (path: string) => void;
  /** Child work-folders keyed by their path here; each row opens that work-folder instead of expanding. */
  nestedFolders?: ReadonlyMap<string, NestedFolderView>;
  onOpenNestedFolder?: (workFolder: WorkFolderSummary) => void;
  collapsedPaths: Set<string>;
  loadingFolderPaths: Set<string>;
  selectedPath?: string | null;
  /** Every selected row when several are; a plain click still selects only `selectedPath`. */
  selectedPaths?: ReadonlySet<string>;
  movingTreePaths?: ReadonlySet<string>;
  dropTargetFolderPath: string | null;
  checkAttentionPaths?: ReadonlySet<string>;
  searchQuery?: string;
  emptyText?: string;
  emptyContent?: React.ReactNode;
  level?: number;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  /** Keyboard focus lands on a row: move the visual selection with it without opening anything. */
  onFocusEntry?: (path: string) => void;
  /** ⌘-click (Ctrl-click off the Mac): adds the row to the selection, or takes it out. */
  onToggleSelected?: (path: string) => void;
  /** Shift-click or Shift+Arrow: the shown rows from the last clicked one to this one; `additive` keeps what was selected. */
  onSelectRange?: (path: string, additive: boolean) => void;
  onSelectAll?: () => void;
  onPreviewFile?: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenContextMenu: (entry: TreeEntry, event: React.MouseEvent<HTMLElement>) => void;
  onRenameEntry?: (path: string) => void;
  onDeleteEntry?: (path: string) => void;
  onUpdateDropTarget: (event: React.DragEvent<HTMLElement>, targetFolderPath: string) => void;
  onDropOnTarget: (event: React.DragEvent<HTMLElement>, targetFolderPath: string) => void | Promise<void>;
  onNativeDragStartFile?: (path: string, event: React.DragEvent<HTMLElement>) => boolean;
  onDragStartEntry: (path: string, event: React.DragEvent<HTMLElement>) => void;
  onDragEndEntry: () => void;
}) {
  // Opening one tree must not animate the same relative path in another.
  const openedFolder = useRef<{ path: string; at: number } | null>(null);
  useEffect(() => { openedFolder.current = null; }, [searchQuery]);
  function justOpened(path: string): boolean {
    const opened = openedFolder.current;
    return !searchQuery.trim() && opened?.path === path && performance.now() - opened.at < 1200;
  }
  if (!entries.length) return emptyContent ? <div className="empty-inline">{emptyContent}</div> : <EmptyInline text={emptyText} />;
  const searching = Boolean(searchQuery.trim());
  const severalSelected = (selectedPaths?.size ?? 0) > 1;
  const isSelected = (path: string) => selectedPaths ? selectedPaths.has(path) : selectedPath === path;
  // ⌘ on any Mac, the browser host included: there Ctrl-click is a right-click.
  const mac = isMacOS() || (typeof navigator !== "undefined" && /^Mac/i.test(navigator.platform));

  // A plain click selects one row (a file opens in its tab; a folder opens or
  // closes). ⌘ and Shift change the selection only, and never open anything.
  function handleRowClick(event: React.MouseEvent<HTMLButtonElement>, entry: TreeEntry, folderCollapsed: boolean) {
    const toggle = isSelectionToggleKey(event, mac);
    if (event.shiftKey && onSelectRange) { onSelectRange(entry.path, toggle); return; }
    if (toggle && onToggleSelected) { onToggleSelected(entry.path); return; }
    if (entry.kind === "file") onSelectFile(entry.path);
    else if (isPage(entry) && !(event.target as Element).closest?.(".folder-chevron")) onOpenPage!(entry.path);
    else if (!searching) toggleFolder(entry.path, folderCollapsed);
  }

  function isPage(entry: TreeEntry): boolean {
    return entry.kind === "folder" && Boolean(onOpenPage && pageFolders?.has(entry.path));
  }

  function toggleFolder(path: string, collapsed: boolean) {
    openedFolder.current = collapsed ? { path, at: performance.now() } : null;
    onToggleFolder(path);
  }

  // After a keyboard move lands focus on a row, the visual selection follows
  // it — the way Finder's arrow keys select — without opening any tab.
  function reportFocusedTreeRow() {
    if (!onFocusEntry) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.dataset.treeRow === "true" && focused.dataset.treePath) {
      onFocusEntry(focused.dataset.treePath);
    }
  }

  // Shift+Arrow grows or shrinks the selection with the focus.
  function extendSelectionToFocusedTreeRow() {
    const focused = document.activeElement;
    if (onSelectRange && focused instanceof HTMLElement && focused.dataset.treeRow === "true" && focused.dataset.treePath) onSelectRange(focused.dataset.treePath, false);
  }

  function handleTreeRowKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, entry: TreeEntry) {
    if (event.key === "Escape" && severalSelected && onFocusEntry) {
      // Back to just the focused row; the next Escape clears it.
      event.preventDefault();
      event.stopPropagation();
      onFocusEntry(entry.path);
      return;
    }
    if (onSelectAll && event.key.toLocaleLowerCase() === "a" && isSelectionToggleKey(event, mac) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onSelectAll();
      return;
    }
    if (event.shiftKey && onSelectRange && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      if (event.key === "Home" || event.key === "End") focusEdgeTreeRow(event.currentTarget, event.key === "Home" ? "first" : "last");
      else focusAdjacentTreeRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      extendSelectionToFocusedTreeRow();
      return;
    }
    if (entry.nestedFolder && (event.key === "Enter" || event.key === " " || event.key === "ArrowRight")) {
      event.preventDefault();
      const nested = nestedFolders?.get(entry.path);
      if (nested) onOpenNestedFolder?.(nested.workFolder);
      return;
    }
    if (entry.nestedFolder && event.key === "ArrowLeft") {
      event.preventDefault();
      focusParentTreeRow(event.currentTarget, entry.path);
      reportFocusedTreeRow();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      focusAdjacentTreeRow(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
      reportFocusedTreeRow();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusEdgeTreeRow(event.currentTarget, event.key === "Home" ? "first" : "last");
      reportFocusedTreeRow();
      return;
    }
    if (event.key === "F2" && onRenameEntry && !searching && !severalSelected) {
      event.preventDefault();
      onRenameEntry(entry.path);
      return;
    }
    if (onDeleteEntry && !searching
      && (event.key === "Delete" || (event.key === "Backspace" && (event.metaKey || event.ctrlKey)))) {
      event.preventDefault();
      onDeleteEntry(entry.path);
      return;
    }
    if (entry.kind === "folder") {
      const collapsed = collapsedPaths.has(entry.path) || treeEntryNeedsLazyChildren(entry);
      if (isPage(entry) && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        onOpenPage!(entry.path);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!searching) toggleFolder(entry.path, collapsed);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (collapsed && !searching) toggleFolder(entry.path, true);
        else {
          focusFirstChildTreeRow(event.currentTarget, entry.path);
          reportFocusedTreeRow();
        }
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (!collapsed && !searching) onToggleFolder(entry.path);
        else {
          focusParentTreeRow(event.currentTarget, entry.path);
          reportFocusedTreeRow();
        }
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusParentTreeRow(event.currentTarget, entry.path);
      reportFocusedTreeRow();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpenFile(entry.path);
    } else if (event.key === " ") {
      event.preventDefault();
      if (onPreviewFile && selectedPath === entry.path) onPreviewFile(entry.path);
      else onSelectFile(entry.path);
    }
  }

  return (
    <div className="file-tree" role={level === 1 ? "tree" : "group"} aria-label={level === 1 ? "Files in this folder" : undefined} aria-multiselectable={level === 1 && onToggleSelected ? true : undefined}>
      {entries.map((entry) => {
        if (entry.nestedFolder) {
          const nested = nestedFolders?.get(entry.path);
          const statusLabel = nested?.status === "running" ? ", Worker is working" : nested?.status === "attention" ? ", new reply" : "";
          const label = nested ? `Open ${nested.workFolder.name}${statusLabel}` : `${entry.name}, another work-folder`;
          return (
            <div className="file-tree-item" key={entry.path}>
              <button
                className={["file-row", "folder-row", "nested-folder-row", isSelected(entry.path) ? "selected" : ""].filter(Boolean).join(" ")}
                type="button"
                role="treeitem"
                aria-level={level}
                aria-label={label}
                title={label}
                data-tree-row="true"
                data-tree-path={entry.path}
                style={nested ? workFolderIdentityStyle(nested.identity) : undefined}
                onClick={() => nested && onOpenNestedFolder?.(nested.workFolder)}
                onKeyDown={(event) => handleTreeRowKeyDown(event, entry)}
                onContextMenu={(event) => event.preventDefault()}
                onDragOver={(event) => {
                  if (!hasNativeFiles(event) && !hasWorkFolderPathDrag(event)) return;
                  event.stopPropagation();
                  onUpdateDropTarget(event, parentFolderPath(entry.path));
                }}
                onDrop={(event) => {
                  event.stopPropagation();
                  void onDropOnTarget(event, parentFolderPath(entry.path));
                }}
              >
                <span className="folder-chevron nested-folder-spacer" aria-hidden="true" />
                <span className="nested-folder-icon" aria-hidden="true">
                  {nested ? <WorkFolderIconGlyph icon={nested.identity.Icon} size={12} filled /> : null}
                </span>
                <HighlightedFileName name={entry.name} query={searchQuery} />
                {nested?.status ? <ActivityDot status={nested.status} /> : null}
                <ArrowRight className="nested-folder-go" size={13} aria-hidden="true" />
              </button>
            </div>
          );
        }
        const folderLoading = entry.kind === "folder" && loadingFolderPaths.has(entry.path);
        const folderCollapsed = entry.kind === "folder" && (collapsedPaths.has(entry.path) || (treeEntryNeedsLazyChildren(entry) && !folderLoading));
        const parentDropTarget = entry.kind === "file" ? parentFolderPath(entry.path) : entry.path;
        const exactCheckAttention = checkAttentionPaths.has(entry.path);
        const descendantCheckAttention = entry.kind === "folder" && hasAttentionDescendant(checkAttentionPaths, entry.path);
        const checkAttention = exactCheckAttention || descendantCheckAttention;
        const checkAttentionLabel = entry.kind === "folder" ? "contains a designated file that needs attention" : "needs attention";
        const page = isPage(entry) ? pageFolders!.get(entry.path)! : null;
        const rowName = page ? `${entry.name}, page` : entry.name;
        const rowLabel = checkAttention ? `${rowName}, ${checkAttentionLabel}` : rowName;
        const selected = isSelected(entry.path);
        return (
          <div className="file-tree-item" key={entry.path}>
            <button
              className={[
                "file-row",
                entry.kind === "folder" ? "folder-row" : "file-row-entry",
                page ? "page-folder-row" : "",
                entry.kind === "folder" && entry.path === ".worker" ? "worker-scratch" : "",
                entry.kind === "folder" && dropTargetFolderPath === entry.path ? "drop-target" : "",
                isInsideFolder(entry.path, dropTargetFolderPath) ? "drop-descendant" : "",
                selected ? "selected" : "",
                movingTreePaths?.has(entry.path) ? "moving" : "",
                exactCheckAttention ? "has-check-attention" : "",
                descendantCheckAttention ? "contains-check-attention" : "",
              ].filter(Boolean).join(" ")}
              type="button"
              role="treeitem"
              aria-level={level}
              aria-expanded={entry.kind === "folder" ? !folderCollapsed : undefined}
              aria-selected={entry.kind === "file" || selected ? selected : undefined}
              aria-label={rowLabel}
              title={`${entry.kind === "file" ? desktopFileDragHint(entry.path) : page ? `Page: ${page.title}` : entry.path}${checkAttention ? ` · ${checkAttentionLabel}` : ""}`}
              data-page-folder={page ? "true" : undefined}
              data-tree-row="true"
              data-tree-path={entry.path}
              draggable
              onClick={(event) => handleRowClick(event, entry, folderCollapsed)}
              onDoubleClick={(event) => entry.kind === "file" && !event.shiftKey && !isSelectionToggleKey(event, mac) && onOpenFile(entry.path)}
              onKeyDown={(event) => handleTreeRowKeyDown(event, entry)}
              onContextMenu={(event) => onOpenContextMenu(entry, event)}
              onDragStart={(event) => {
                if (entry.kind === "file" && onNativeDragStartFile?.(entry.path, event)) return;
                onDragStartEntry(entry.path, event);
              }}
              onDragEnd={onDragEndEntry}
              onDragEnter={(event) => {
                if (!hasNativeFiles(event) && !hasWorkFolderPathDrag(event)) return;
                event.stopPropagation();
                onUpdateDropTarget(event, parentDropTarget);
              }}
              onDragOver={(event) => {
                if (!hasNativeFiles(event) && !hasWorkFolderPathDrag(event)) return;
                event.stopPropagation();
                onUpdateDropTarget(event, parentDropTarget);
              }}
              onDrop={(event) => {
                event.stopPropagation();
                void onDropOnTarget(event, parentDropTarget);
              }}
            >
              {entry.kind === "folder" ? (
                <>
                  <ChevronRight className={folderCollapsed ? "folder-chevron" : "folder-chevron open"} size={15} />
                  {page ? <span className="file-icon glyph-file-icon page-folder-icon" aria-hidden="true"><PageIcon size={16} /></span> : <FolderTypeIcon name={entry.name} expanded={!folderCollapsed} />}
                  <HighlightedFileName name={entry.name} query={searchQuery} />
                </>
              ) : (
                <><FileTypeIcon path={entry.path} /><HighlightedFileName name={entry.name} query={searchQuery} file /></>
              )}
              {checkAttention ? <span className="file-check-attention-marker" aria-hidden="true" /> : null}
            </button>
            {entry.kind === "folder" && entry.children?.length && !folderCollapsed ? (
              <div className={justOpened(entry.path) ? "file-children opening" : "file-children"} data-exit-motion={searching ? undefined : "collapse"}>
                <FileTree
                  entries={entry.children}
                  collapsedPaths={collapsedPaths}
                  loadingFolderPaths={loadingFolderPaths}
                  selectedPath={selectedPath}
                  selectedPaths={selectedPaths}
                  movingTreePaths={movingTreePaths}
                  dropTargetFolderPath={dropTargetFolderPath}
                  checkAttentionPaths={checkAttentionPaths}
                  searchQuery={searchQuery}
                  emptyText={emptyText}
                  level={level + 1}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  onFocusEntry={onFocusEntry}
                  onToggleSelected={onToggleSelected}
                  onSelectRange={onSelectRange}
                  onSelectAll={onSelectAll}
                  onPreviewFile={onPreviewFile}
                  onOpenFile={onOpenFile}
                  onOpenContextMenu={onOpenContextMenu}
                  onRenameEntry={onRenameEntry}
                  onDeleteEntry={onDeleteEntry}
                  onUpdateDropTarget={onUpdateDropTarget}
                  onDropOnTarget={onDropOnTarget}
                  onNativeDragStartFile={onNativeDragStartFile}
                  onDragStartEntry={onDragStartEntry}
                  onDragEndEntry={onDragEndEntry}
                  nestedFolders={nestedFolders}
                  onOpenNestedFolder={onOpenNestedFolder}
                  pageFolders={pageFolders}
                  onOpenPage={onOpenPage}
                />
              </div>
            ) : entry.kind === "folder" && folderLoading ? <FolderLoadingRow /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Files' first load: nothing that looks like files, and a quiet line only if the wait is noticeable. */
export function FileTreeLoadingState() {
  return <div className="file-tree-loading delayed-loading" aria-live="polite" aria-label="Loading files"><div className="file-tree-loading-heading"><Loader2 className="spin" size={14} /><span>Loading files</span></div></div>;
}

function FolderLoadingRow() {
  return <div className="file-children"><div className="folder-loading-row delayed-loading" aria-live="polite"><Loader2 className="spin" size={14} /><span>Loading folder</span></div></div>;
}

function HighlightedFileName({ name, query, file = false }: { name: string; query: string; file?: boolean }) {
  const trimmed = query.trim();
  const matchIndex = trimmed ? name.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase()) : -1;
  const match = matchIndex < 0 ? null : { start: matchIndex, end: matchIndex + trimmed.length };
  const extension = file ? fileNameExtension(name) : "";
  if (!extension) return <span className="file-name">{highlightedText(name, 0, match)}</span>;
  // A long name truncates before its extension, which stays visible in a
  // quieter color (2026-10-27).
  const stemLength = name.length - extension.length;
  return (
    <span className="file-name has-extension">
      <span className="file-name-stem">{highlightedText(name.slice(0, stemLength), 0, match)}</span>
      <span className="file-name-extension">{highlightedText(extension, stemLength, match)}</span>
    </span>
  );
}

/** A file's extension with its dot, when a name comes before it: ".txt", but nothing for ".gitignore". */
function fileNameExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
}

/** `text` starts at `offset` in the whole name; the part inside the search match is marked. */
function highlightedText(text: string, offset: number, match: { start: number; end: number } | null): React.ReactNode {
  if (!match) return text;
  const start = Math.max(match.start - offset, 0);
  const end = Math.min(match.end - offset, text.length);
  if (start >= end) return text;
  return <>{text.slice(0, start)}<mark>{text.slice(start, end)}</mark>{text.slice(end)}</>;
}

export function FileTypeIcon({ path }: { path: string }) { return <FileTreeIconFrame iconSpec={fileTreeFileIcon(path)} />; }
function FolderTypeIcon({ name, expanded }: { name: string; expanded: boolean }) { return <FileTreeIconFrame iconSpec={fileTreeFolderIcon(name, expanded)} />; }
function FileTreeIconFrame({ iconSpec }: { iconSpec: FileTreeIconSpec }) { return <FileIconFrame iconSpec={iconSpec} />; }

function hasAttentionDescendant(paths: ReadonlySet<string>, folderPath: string): boolean {
  const prefix = `${folderPath}/`;
  for (const path of paths) if (path.startsWith(prefix)) return true;
  return false;
}

function treeRows(currentRow: HTMLButtonElement) { return [...(currentRow.closest(".file-tree-shell")?.querySelectorAll<HTMLButtonElement>("button[data-tree-row='true']") ?? [])]; }
function focusAdjacentTreeRow(currentRow: HTMLButtonElement, direction: -1 | 1) { const rows = treeRows(currentRow); rows[rows.indexOf(currentRow) + direction]?.focus(); }
function focusEdgeTreeRow(currentRow: HTMLButtonElement, edge: "first" | "last") { const rows = treeRows(currentRow); rows[edge === "first" ? 0 : rows.length - 1]?.focus(); }
function focusParentTreeRow(currentRow: HTMLButtonElement, path: string) { const parent = parentFolderPath(path); if (parent) treeRows(currentRow).find((row) => row.dataset.treePath === parent)?.focus(); }
function focusFirstChildTreeRow(currentRow: HTMLButtonElement, path: string) { const rows = treeRows(currentRow); rows.slice(rows.indexOf(currentRow) + 1).find((row) => row.dataset.treePath?.startsWith(`${path}/`))?.focus(); }
