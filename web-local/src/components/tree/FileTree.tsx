import type React from "react";
import { ArrowRight, ChevronRight, Loader2, Share2 } from "lucide-react";
import { fileTreeFileIcon, fileTreeFolderIcon, type FileTreeIconSpec } from "../../file-tree-icons";
import { FileIconFrame } from "./FileIconFrame";
import { hasNativeFiles, hasWorkFolderPathDrag } from "../../lib/file-actions";
import { desktopFileDragHint } from "../../lib/platform";
import { isInsideFolder, parentFolderPath, treeEntryNeedsLazyChildren } from "../../lib/tree";
import { workFolderIdentityStyle, type WorkFolderIdentity } from "../../lib/work-folder-identity";
import type { ChatActivityStatus, WorkFolderSummary, TreeEntry } from "../../types";
import { fileSharing } from "../../ui-contract";
import { ActivityDot } from "../chrome/ActivityDot";
import { EmptyInline, WorkFolderIconGlyph } from "../chrome/common";

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
  movingTreePath,
  dropTargetFolderPath,
  checkAttentionPaths = new Set<string>(),
  sharedPaths = new Set<string>(),
  searchQuery = "",
  emptyText = "This folder is empty.",
  emptyContent,
  level = 1,
  onToggleFolder,
  onSelectFile,
  onFocusEntry,
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
}: {
  entries: TreeEntry[];
  /** Child work-folders keyed by their path here; each row opens that work-folder instead of expanding. */
  nestedFolders?: ReadonlyMap<string, NestedFolderView>;
  onOpenNestedFolder?: (workFolder: WorkFolderSummary) => void;
  collapsedPaths: Set<string>;
  loadingFolderPaths: Set<string>;
  selectedPath?: string | null;
  movingTreePath: string | null;
  dropTargetFolderPath: string | null;
  checkAttentionPaths?: ReadonlySet<string>;
  /** Files in this work-folder shared as a page; folders never carry the mark. */
  sharedPaths?: ReadonlySet<string>;
  searchQuery?: string;
  emptyText?: string;
  emptyContent?: React.ReactNode;
  level?: number;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  /** Keyboard focus lands on a row: move the visual selection with it without opening anything. */
  onFocusEntry?: (path: string) => void;
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
  if (!entries.length) return emptyContent ? <div className="empty-inline">{emptyContent}</div> : <EmptyInline text={emptyText} />;
  const searching = Boolean(searchQuery.trim());

  // After a keyboard move lands focus on a row, the visual selection follows
  // it — the way Finder's arrow keys select — without opening any tab.
  function reportFocusedTreeRow() {
    if (!onFocusEntry) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.dataset.treeRow === "true" && focused.dataset.treePath) {
      onFocusEntry(focused.dataset.treePath);
    }
  }

  function handleTreeRowKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, entry: TreeEntry) {
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
    if (event.key === "F2" && onRenameEntry && !searching) {
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
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!searching) onToggleFolder(entry.path);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (collapsed && !searching) onToggleFolder(entry.path);
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
    <div className="file-tree" role={level === 1 ? "tree" : "group"} aria-label={level === 1 ? "Files in this folder" : undefined}>
      {entries.map((entry) => {
        if (entry.nestedFolder) {
          const nested = nestedFolders?.get(entry.path);
          const statusLabel = nested?.status === "running" ? ", Worker is working" : nested?.status === "attention" ? ", new reply" : "";
          const label = nested ? `Open ${nested.workFolder.name}${statusLabel}` : `${entry.name}, another work-folder`;
          return (
            <div className="file-tree-item" key={entry.path}>
              <button
                className={["file-row", "folder-row", "nested-folder-row", selectedPath === entry.path ? "selected" : ""].filter(Boolean).join(" ")}
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
        const shared = entry.kind === "file" && sharedPaths.has(entry.path);
        const rowLabel = `${checkAttention ? `${entry.name}, ${checkAttentionLabel}` : entry.name}${shared ? ` · ${fileSharing.sharedMarkLabel}` : ""}`;
        return (
          <div className="file-tree-item" key={entry.path}>
            <button
              className={[
                "file-row",
                entry.kind === "folder" ? "folder-row" : "file-row-entry",
                entry.kind === "folder" && entry.path === ".worker" ? "worker-scratch" : "",
                entry.kind === "folder" && dropTargetFolderPath === entry.path ? "drop-target" : "",
                isInsideFolder(entry.path, dropTargetFolderPath) ? "drop-descendant" : "",
                selectedPath === entry.path ? "selected" : "",
                movingTreePath === entry.path ? "moving" : "",
                exactCheckAttention ? "has-check-attention" : "",
                descendantCheckAttention ? "contains-check-attention" : "",
                shared ? "is-shared" : "",
              ].filter(Boolean).join(" ")}
              type="button"
              role="treeitem"
              aria-level={level}
              aria-expanded={entry.kind === "folder" ? !folderCollapsed : undefined}
              aria-selected={entry.kind === "file" ? selectedPath === entry.path : undefined}
              aria-label={rowLabel}
              title={`${entry.kind === "file" ? desktopFileDragHint(entry.path) : entry.path}${checkAttention ? ` · ${checkAttentionLabel}` : ""}${shared ? ` · ${fileSharing.sharedMarkLabel}` : ""}`}
              data-tree-row="true"
              data-tree-path={entry.path}
              draggable
              onClick={() => entry.kind === "file" ? onSelectFile(entry.path) : !searching && onToggleFolder(entry.path)}
              onDoubleClick={() => entry.kind === "file" && onOpenFile(entry.path)}
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
                  <FolderTypeIcon name={entry.name} expanded={!folderCollapsed} />
                  <HighlightedFileName name={entry.name} query={searchQuery} />
                </>
              ) : (
                <><FileTypeIcon path={entry.path} /><HighlightedFileName name={entry.name} query={searchQuery} />{shared ? <SharedPageGlyph className="file-shared-marker" /> : null}</>
              )}
              {checkAttention ? <span className="file-check-attention-marker" aria-hidden="true" /> : null}
            </button>
            {entry.kind === "folder" && entry.children?.length && !folderCollapsed ? (
              <div className="file-children">
                <FileTree
                  entries={entry.children}
                  collapsedPaths={collapsedPaths}
                  loadingFolderPaths={loadingFolderPaths}
                  selectedPath={selectedPath}
                  movingTreePath={movingTreePath}
                  dropTargetFolderPath={dropTargetFolderPath}
                  checkAttentionPaths={checkAttentionPaths}
                  sharedPaths={sharedPaths}
                  searchQuery={searchQuery}
                  emptyText={emptyText}
                  level={level + 1}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  onFocusEntry={onFocusEntry}
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
                />
              </div>
            ) : entry.kind === "folder" && folderLoading ? <FolderLoadingRow /> : null}
          </div>
        );
      })}
    </div>
  );
}

/** The at-a-glance mark for a file shared as a page (Files rows and file tabs). */
export function SharedPageGlyph({ className }: { className: string }) {
  return <span className={className} title={fileSharing.sharedMarkTooltip} aria-hidden="true"><Share2 size={12} /></span>;
}

/** Files' first load: nothing that looks like files, and a quiet line only if the wait is noticeable. */
export function FileTreeLoadingState() {
  return <div className="file-tree-loading delayed-loading" aria-live="polite" aria-label="Loading files"><div className="file-tree-loading-heading"><Loader2 className="spin" size={14} /><span>Loading files</span></div></div>;
}

function FolderLoadingRow() {
  return <div className="file-children"><div className="folder-loading-row delayed-loading" aria-live="polite"><Loader2 className="spin" size={14} /><span>Loading folder</span></div></div>;
}

function HighlightedFileName({ name, query }: { name: string; query: string }) {
  const trimmed = query.trim();
  const matchIndex = trimmed ? name.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase()) : -1;
  if (matchIndex < 0) return <span className="file-name">{name}</span>;
  return <span className="file-name">{name.slice(0, matchIndex)}<mark>{name.slice(matchIndex, matchIndex + trimmed.length)}</mark>{name.slice(matchIndex + trimmed.length)}</span>;
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
