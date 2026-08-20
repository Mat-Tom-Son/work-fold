import type React from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { fileTreeFileIcon, fileTreeFolderIcon, fileTreeIconClassName, type FileTreeIconSpec } from "../../file-tree-icons";
import { hasNativeFiles, hasSpacePathDrag } from "../../lib/file-actions";
import { desktopFileDragHint } from "../../lib/platform";
import { isInsideFolder, parentFolderPath, treeEntryNeedsLazyChildren } from "../../lib/tree";
import type { TreeEntry } from "../../types";
import { EmptyInline } from "../chrome/common";

export function FileTree({
  entries,
  collapsedPaths,
  loadingFolderPaths,
  selectedPath,
  movingTreePath,
  dropTargetFolderPath,
  checkAttentionPaths = new Set<string>(),
  searchQuery = "",
  emptyText = "This Space is empty.",
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
}: {
  entries: TreeEntry[];
  collapsedPaths: Set<string>;
  loadingFolderPaths: Set<string>;
  selectedPath?: string | null;
  movingTreePath: string | null;
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
    <div className="file-tree" role={level === 1 ? "tree" : "group"} aria-label={level === 1 ? "Files in this Space" : undefined}>
      {entries.map((entry) => {
        const folderLoading = entry.kind === "folder" && loadingFolderPaths.has(entry.path);
        const folderCollapsed = entry.kind === "folder" && (collapsedPaths.has(entry.path) || (treeEntryNeedsLazyChildren(entry) && !folderLoading));
        const parentDropTarget = entry.kind === "file" ? parentFolderPath(entry.path) : entry.path;
        const exactCheckAttention = checkAttentionPaths.has(entry.path);
        const descendantCheckAttention = entry.kind === "folder" && hasAttentionDescendant(checkAttentionPaths, entry.path);
        const checkAttention = exactCheckAttention || descendantCheckAttention;
        const checkAttentionLabel = entry.kind === "folder" ? "contains a designated file that needs attention" : "needs attention";
        return (
          <div className="file-tree-item" key={entry.path}>
            <button
              className={[
                "file-row",
                entry.kind === "folder" ? "folder-row" : "file-row-entry",
                entry.kind === "folder" && dropTargetFolderPath === entry.path ? "drop-target" : "",
                isInsideFolder(entry.path, dropTargetFolderPath) ? "drop-descendant" : "",
                selectedPath === entry.path ? "selected" : "",
                movingTreePath === entry.path ? "moving" : "",
                exactCheckAttention ? "has-check-attention" : "",
                descendantCheckAttention ? "contains-check-attention" : "",
              ].filter(Boolean).join(" ")}
              type="button"
              role="treeitem"
              aria-level={level}
              aria-expanded={entry.kind === "folder" ? !folderCollapsed : undefined}
              aria-selected={entry.kind === "file" ? selectedPath === entry.path : undefined}
              aria-label={checkAttention ? `${entry.name}, ${checkAttentionLabel}` : entry.name}
              title={`${entry.kind === "file" ? desktopFileDragHint(entry.path) : entry.path}${checkAttention ? ` · ${checkAttentionLabel}` : ""}`}
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
                if (!hasNativeFiles(event) && !hasSpacePathDrag(event)) return;
                event.stopPropagation();
                onUpdateDropTarget(event, parentDropTarget);
              }}
              onDragOver={(event) => {
                if (!hasNativeFiles(event) && !hasSpacePathDrag(event)) return;
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
                  {folderLoading ? <Loader2 className="folder-chevron spin" size={15} /> : <ChevronRight className={folderCollapsed ? "folder-chevron" : "folder-chevron open"} size={15} />}
                  <FolderTypeIcon name={entry.name} expanded={!folderCollapsed} />
                  <HighlightedFileName name={entry.name} query={searchQuery} />
                </>
              ) : (
                <><FileTypeIcon path={entry.path} /><HighlightedFileName name={entry.name} query={searchQuery} /></>
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
                />
              </div>
            ) : entry.kind === "folder" && folderLoading ? <FolderLoadingRow /> : null}
          </div>
        );
      })}
    </div>
  );
}

export function FileTreeLoadingState() {
  return <div className="file-tree-loading" aria-live="polite" aria-label="Loading files"><div className="file-tree-loading-heading"><Loader2 className="spin" size={14} /><span>Loading files</span></div><div className="file-tree-skeleton" aria-hidden="true">{["root", "child", "child", "root", "child", "grandchild", "root"].map((indent, index) => <div className={`file-tree-skeleton-row ${indent}`} key={`${indent}-${index}`}><span className="file-tree-skeleton-icon" /><span className="file-tree-skeleton-name" /></div>)}</div></div>;
}

function FolderLoadingRow() {
  return <div className="file-children"><div className="folder-loading-row" aria-live="polite"><Loader2 className="spin" size={14} /><span>Loading folder</span></div></div>;
}

function HighlightedFileName({ name, query }: { name: string; query: string }) {
  const trimmed = query.trim();
  const matchIndex = trimmed ? name.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase()) : -1;
  if (matchIndex < 0) return <span className="file-name">{name}</span>;
  return <span className="file-name">{name.slice(0, matchIndex)}<mark>{name.slice(matchIndex, matchIndex + trimmed.length)}</mark>{name.slice(matchIndex + trimmed.length)}</span>;
}

export function FileTypeIcon({ path }: { path: string }) { return <FileTreeIconFrame iconSpec={fileTreeFileIcon(path)} />; }
function FolderTypeIcon({ name, expanded }: { name: string; expanded: boolean }) { return <FileTreeIconFrame iconSpec={fileTreeFolderIcon(name, expanded)} />; }
function FileTreeIconFrame({ iconSpec }: { iconSpec: FileTreeIconSpec }) { return <span className={`file-icon ${fileTreeIconClassName(iconSpec)}`} title={iconSpec.label} aria-hidden="true"><img className="file-icon-asset" src={iconSpec.src} alt="" draggable={false} /></span>; }

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
