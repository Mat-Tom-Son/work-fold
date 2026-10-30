import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AppWindow, Check, CirclePlus, Copy, ExternalLink, FolderOpen, History, Loader2, MoreHorizontal, PencilLine } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { copyToClipboard } from "../../lib/clipboard";
import { workFolderRawFileBlob, workFolderRawFileObjectUrl } from "../../lib/raw-file";
import { nativeOpenLabel, revealInFileManagerLabel } from "../../lib/file-actions";
import { formatBytes, formatDateTime } from "../../lib/format";
import { workFolderEntryNativePath } from "../../lib/platform";
import { fileExtension } from "../../lib/tree";
import type { TreeEntry, WorkFolderSummary } from "../../types";
import { showToast } from "../../ui/feedback";
import { EmptyInline } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { copyMarkdownToClipboard, MarkdownMessage } from "../chat/messages";
import { isShareablePath } from "../../lib/page-sharing";
import { FileShareControl } from "./FileSharePopover";

// Chromium's PDF viewer: no toolbar, no thumbnail pane, fit to width.
const pdfViewerParameters = "#toolbar=0&navpanes=0&view=FitH";
const copiedFeedbackMs = 1_600;

type FileMenuItem = { key: string; label: string; icon: ReactNode; run: () => void | Promise<void>; separatorBefore?: boolean };

type FilePreview = { kind: "text" | "image" | "pdf" | "none"; reason?: string; content?: string; truncated?: boolean; sizeBytes: number };

export function FileDetailsPane({ workFolder, path, entry, fixtureMode = false, canOpenWith = false, onOpenLocal, onAddToChatContext, onShowVersionHistory, onRename, shareRequestId, onOpenSettings }: {
  workFolder: WorkFolderSummary;
  path: string;
  entry: TreeEntry | null;
  fixtureMode?: boolean;
  canOpenWith?: boolean;
  onOpenLocal: (path: string, action: "reveal" | "open" | "open-native" | "open-with") => void | Promise<void>;
  onAddToChatContext: (path: string) => void;
  onShowVersionHistory: (path: string) => void;
  onRename?: (path: string) => void;
  /** A Files-menu Share for this file, handled once by this tab. */
  shareRequestId?: number;
  onOpenSettings?: (page: "shared-pages" | "web-access") => void;
}) {
  const [info, setInfo] = useState<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  // `undefined` while the preview is still being read; `null` when none exists.
  const [preview, setPreview] = useState<FilePreview | null | undefined>(undefined);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Which file content the preview reflects: work-folder, path, and modified time.
  // A new modified time refreshes the preview in place; a new path clears it.
  const [contentKey, setContentKey] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied">("idle");
  const copiedTimerRef = useRef<number | null>(null);
  const fileKey = `${workFolder.id}\0${path}`;
  const [shownFileKey, setShownFileKey] = useState(fileKey);
  if (shownFileKey !== fileKey) {
    setShownFileKey(fileKey);
    setPreview(undefined);
    setObjectUrl(null);
    setContentKey(null);
    setCopyState("idle");
  }
  useEffect(() => () => { if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current); }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setMissing(false); setInfo(null);
    if (fixtureMode) {
      setInfo(entry ? { name: entry.name, path: entry.path, kind: entry.kind, sizeBytes: entry.sizeBytes ?? 0, createdAt: workFolder.createdAt, modifiedAt: entry.updatedAt ?? workFolder.updatedAt, mimeType: "application/octet-stream" } : null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    void api<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string }>(`/api/work-folders/${workFolder.id}/file-info?path=${encodeURIComponent(path)}`)
      .then((result) => { if (!cancelled) { setInfo(result); setContentKey(`${fileKey}\0${result.modifiedAt}`); } })
      .catch((caught) => { if (!cancelled) { const message = errorText(caught); const gone = message.includes("not found") || message.includes("ENOENT") || message.includes("no longer"); setMissing(gone); if (!gone) setContentKey(`${fileKey}\0`); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry, fixtureMode, path, workFolder.id]);
  // The tab shows the file itself, not a card about it: bounded text, common
  // image types, and PDFs render inline; everything else keeps the actions.
  useEffect(() => {
    if (fixtureMode) { setPreview(null); return; }
    if (!contentKey) return;
    let cancelled = false;
    void api<{ preview: FilePreview }>(`/api/work-folders/${workFolder.id}/file-preview?path=${encodeURIComponent(path)}`)
      .then((result) => { if (!cancelled) setPreview(result.preview); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [contentKey, fixtureMode]);
  const previewKind = preview?.kind;
  useEffect(() => {
    if (!contentKey || (previewKind !== "image" && previewKind !== "pdf")) return;
    setObjectUrl(null);
    const controller = new AbortController();
    let created: string | null = null;
    void workFolderRawFileObjectUrl(workFolder.id, path, controller.signal)
      .then((url) => {
        if (controller.signal.aborted) { URL.revokeObjectURL(url); return; }
        created = url;
        setObjectUrl(url);
      })
      .catch(() => { if (!controller.signal.aborted) setPreview(null); });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [contentKey, previewKind]);
  const fileName = info?.name ?? entry?.name ?? path.split("/").pop() ?? path;
  const openLabel = nativeOpenLabel({ name: fileName, path, kind: "file" });
  const sizeBytes = info?.sizeBytes ?? entry?.sizeBytes;
  const modifiedAt = info?.modifiedAt ?? entry?.updatedAt;
  const metaLine = [
    typeof sizeBytes === "number" ? formatBytes(sizeBytes) : null,
    fileTypeLabel(path),
    modifiedAt ? `Modified ${formatDateTime(modifiedAt)}` : null,
  ].filter(Boolean).join(" · ");
  const markdown = [".md", ".markdown"].includes(fileExtension(path));
  const revealLabel = revealInFileManagerLabel();
  // Copy takes the whole file, not the bounded preview: a truncated preview
  // reads the rest through the raw-file route. Markdown copies like a Chat
  // reply, as formatted text with the Markdown source as its plain text.
  const copyable = preview?.kind === "text" && Boolean(preview.content);
  async function copyContents() {
    if (preview?.kind !== "text" || !preview.content || copyState === "copying") return;
    setCopyState("copying");
    try {
      const text = preview.truncated ? await (await workFolderRawFileBlob(workFolder.id, path)).text() : preview.content;
      if (markdown) await copyMarkdownToClipboard(text);
      else await copyToClipboard({ text });
      setCopyState("copied");
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => { copiedTimerRef.current = null; setCopyState("idle"); }, copiedFeedbackMs);
    } catch (caught) {
      setCopyState("idle");
      showToast({ text: `Couldn't copy ${fileName}. ${errorText(caught)}`, tone: "error" });
    }
  }
  async function copyPath() {
    try {
      await copyToClipboard({ text: workFolderEntryNativePath(workFolder.workFolderRoot, path) });
      showToast({ text: "Path copied", tone: "success" });
    } catch (caught) {
      showToast({ text: `Couldn't copy the path. ${errorText(caught)}`, tone: "error" });
    }
  }
  const copyLabel = copyState === "copied" ? "Copied" : "Copy";
  // The everyday actions keep their words in the header; the rest live in
  // one More menu instead of a row of unlabeled icons.
  const moreItems: FileMenuItem[] = [
    ...(canOpenWith ? [{ key: "open-with", label: "Open with", icon: <AppWindow size={15} />, run: () => onOpenLocal(path, "open-with") }] : []),
    ...(openLabel.text !== revealLabel ? [{ key: "reveal", label: revealLabel, icon: <FolderOpen size={15} />, run: () => onOpenLocal(path, "reveal") }] : []),
    { key: "copy-path", label: "Copy File Path", icon: <Copy size={15} />, run: copyPath },
    { key: "history", label: "Version History", icon: <History size={15} />, run: () => onShowVersionHistory(path) },
    ...(onRename ? [{ key: "rename", label: "Rename", icon: <PencilLine size={15} />, run: () => onRename(path), separatorBefore: true }] : []),
  ];
  if (missing) return <section className="file-details-pane file-details-empty"><EmptyInline text="This file is no longer in the work-folder" /></section>;
  return (
    <section className="file-details-pane" aria-label={`File details for ${fileName}`}>
      <header className="file-details-header">
        <div className="file-details-identity">
          <span className="file-details-icon" aria-hidden="true"><FileTypeIcon path={path} /></span>
          <div className="file-details-title">
            <h2 title={path}>{fileName}</h2>
            <p className="file-details-meta-line" title={metaLine || undefined}>
              {loading && !info && !entry ? <><Loader2 className="spin" size={12} />Loading</> : metaLine}
            </p>
          </div>
        </div>
        <div className="file-details-actions">
          {copyable ? <button className="ui-control compact no-margin file-details-copy" type="button" title={copyState === "copied" ? "Copied" : "Copy contents"} aria-label={copyState === "copied" ? "Copied" : "Copy contents"} aria-busy={copyState === "copying"} data-state={copyState} onClick={() => void copyContents()}>{copyState === "copied" ? <Check size={14} /> : <Copy size={14} />}<span className="file-details-action-label">{copyLabel}</span></button> : null}
          <button className="ui-control compact no-margin" type="button" title="Attach to Chat" aria-label="Attach to Chat" onClick={() => onAddToChatContext(path)}><CirclePlus size={14} /><span className="file-details-action-label">Attach to Chat</span></button>
          {isShareablePath(path) ? <FileShareControl workFolderId={workFolder.id} path={path} fileName={fileName} fixtureMode={fixtureMode} shareRequestId={shareRequestId} onOpenSettings={onOpenSettings} /> : null}
          <button className="ui-control ui-control--primary compact no-margin" type="button" onClick={() => void onOpenLocal(path, openLabel.office ? "open-native" : "open")}><ExternalLink size={14} />{openLabel.text}</button>
          <FileMoreMenu key={fileKey} items={moreItems} />
        </div>
      </header>
      {preview?.kind === "text" && preview.content ? (
        <div className={markdown ? "file-preview file-preview-document" : "file-preview file-preview-code"}>
          {markdown
            ? <div className="file-preview-markdown"><MarkdownMessage content={preview.content} /></div>
            : <pre className="file-preview-text">{preview.content}</pre>}
          {preview.truncated ? <p className="file-preview-truncated">Preview stops at 256 KB.</p> : null}
        </div>
      ) : null}
      {preview?.kind === "image" && objectUrl ? (
        <div className="file-preview file-preview-media">
          <img className="file-preview-image" src={objectUrl} alt={fileName} />
        </div>
      ) : null}
      {preview?.kind === "pdf" && objectUrl ? (
        <div className="file-preview file-preview-pdf">
          <iframe title={fileName} src={`${objectUrl}${pdfViewerParameters}`} />
        </div>
      ) : null}
      {preview === null || preview?.kind === "none" || (preview?.kind === "text" && !preview.content) ? (
        <div className="file-preview file-preview-none" aria-hidden="true"><FileTypeIcon path={path} /></div>
      ) : null}
    </section>
  );
}

/** The header's More button and its menu, keyboard-driven like the Files right-click menu. */
function FileMoreMenu({ items }: { items: FileMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && anchorRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const menuItems = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = Math.max(0, menuItems.findIndex((item) => item === document.activeElement));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      menuItems[(index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuItems[event.key === "Home" ? 0 : menuItems.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }
  return (
    <span className="file-details-more" ref={anchorRef}>
      <button ref={buttonRef} className="ui-control ui-control--icon" type="button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} /></button>
      {open ? (
        <div ref={menuRef} className="context-menu file-details-menu" role="menu" aria-label="More actions" onKeyDown={handleKeyDown}>
          {items.map((item) => (
            <Fragment key={item.key}>
              {item.separatorBefore ? <div className="context-menu-separator" role="separator" /> : null}
              <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setOpen(false); void item.run(); }}>{item.icon}{item.label}</button>
            </Fragment>
          ))}
        </div>
      ) : null}
    </span>
  );
}

function fileTypeLabel(path: string): string {
  const extension = fileExtension(path);
  const known = new Map([[".docx", "Word document"], [".xlsx", "Excel workbook"], [".csv", "CSV spreadsheet"], [".pptx", "PowerPoint presentation"], [".pdf", "PDF document"], [".txt", "Text file"], [".md", "Markdown file"], [".json", "JSON file"], [".png", "PNG image"], [".jpg", "JPEG image"], [".jpeg", "JPEG image"], [".svg", "SVG image"]]);
  return known.get(extension) ?? (extension ? `${extension.slice(1).toUpperCase()} file` : "File");
}
