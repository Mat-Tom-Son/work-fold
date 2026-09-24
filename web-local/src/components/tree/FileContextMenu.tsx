import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AppWindow, CirclePlus, Copy, ExternalLink, FilePlus2, FolderOpen, FolderPlus, History, PencilLine, Trash2, Upload } from "lucide-react";
import { canOpenDirectly, nativeOpenLabel, revealInFileManagerLabel } from "../../lib/file-actions";
import type { FileContextMenuState } from "../../types";

export function FileContextMenu({
  state,
  onSelect,
  onOpenLocal,
  canOpenWith = false,
  onAddToChatContext,
  onCopyPath,
  onShowVersionHistory,
  onRename,
  onNewFolder,
  onNewFile,
  onUploadHere,
  onDelete,
  onClose,
}: {
  state: FileContextMenuState;
  onSelect: (path: string) => void;
  onOpenLocal: (path: string, action: "reveal" | "open" | "open-native" | "open-with") => void | Promise<void>;
  canOpenWith?: boolean;
  onAddToChatContext: (path: string) => void;
  onCopyPath: (path: string) => void | Promise<void>;
  onShowVersionHistory: (path: string) => void;
  onRename?: (path: string) => void;
  onNewFolder?: (parentPath: string) => void;
  onNewFile?: (parentPath: string) => void;
  onUploadHere?: (parentPath: string) => void;
  onDelete: (path: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { entry } = state;
  const openLabel = nativeOpenLabel(entry);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()); }, [entry.path]);

  function items() { return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []); }
  function closeAndReturnFocus() { onClose(); window.requestAnimationFrame(() => state.returnFocusTarget?.focus()); }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const menuItems = items();
    const index = Math.max(0, menuItems.findIndex((item) => item === document.activeElement));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuItems[event.key === "Home" ? 0 : menuItems.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault(); closeAndReturnFocus();
    }
  }
  const run = (action: () => void | Promise<void>) => { onClose(); void action(); };
  return (
    <div ref={menuRef} className="context-menu" style={{ left: state.x, top: state.y }} role="menu" onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()} onKeyDown={handleKeyDown}>
      {entry.kind === "file" && canOpenDirectly(entry.path) ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => { onSelect(entry.path); return onOpenLocal(entry.path, openLabel.office ? "open-native" : "open"); })}><ExternalLink size={15} />{openLabel.text}</button> : null}
      {entry.kind === "file" && canOpenWith ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onOpenLocal(entry.path, "open-with"))}><AppWindow size={15} />Open with</button> : null}
      {entry.kind === "folder" ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onOpenLocal(entry.path, "open"))}><FolderOpen size={15} />Open folder</button> : null}
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onOpenLocal(entry.path, "reveal"))}><FolderOpen size={15} />{revealInFileManagerLabel()}</button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onCopyPath(entry.path))}><Copy size={15} />Copy {entry.kind === "folder" ? "folder" : "file"} path</button>
      {entry.kind === "file" ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onAddToChatContext(entry.path))}><CirclePlus size={15} />Attach to chat</button> : null}
      {entry.kind === "file" ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onShowVersionHistory(entry.path))}><History size={15} />Version history</button> : null}
      {entry.kind === "folder" && (onNewFolder || onNewFile || onUploadHere) ? <div className="context-menu-separator" role="separator" /> : null}
      {entry.kind === "folder" && onNewFolder ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onNewFolder(entry.path))}><FolderPlus size={15} />New folder here</button> : null}
      {entry.kind === "folder" && onNewFile ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onNewFile(entry.path))}><FilePlus2 size={15} />New file here</button> : null}
      {entry.kind === "folder" && onUploadHere ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onUploadHere(entry.path))}><Upload size={15} />Add files here</button> : null}
      {entry.path ? <div className="context-menu-separator" role="separator" /> : null}
      {entry.path && onRename ? <button type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onRename(entry.path))}><PencilLine size={15} />Rename</button> : null}
      {entry.path ? <button className="danger" type="button" role="menuitem" tabIndex={-1} onClick={() => run(() => onDelete(entry.path))}><Trash2 size={15} />Delete {entry.kind}</button> : null}
    </div>
  );
}
