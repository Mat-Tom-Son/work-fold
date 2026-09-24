import { useEffect, useState } from "react";
import { AppWindow, CirclePlus, ExternalLink, FolderOpen, History, Loader2, PencilLine } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { spaceRawFileObjectUrl } from "../../lib/raw-file";
import { nativeOpenLabel, revealInFileManagerLabel } from "../../lib/file-actions";
import { formatBytes, formatDateTime } from "../../lib/format";
import { fileExtension } from "../../lib/tree";
import type { TreeEntry, SpaceSummary } from "../../types";
import { EmptyInline } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { MarkdownMessage } from "../chat/messages";

// Chromium's PDF viewer: no toolbar, no thumbnail pane, fit to width.
const pdfViewerParameters = "#toolbar=0&navpanes=0&view=FitH";

type FilePreview = { kind: "text" | "image" | "pdf" | "none"; reason?: string; content?: string; truncated?: boolean; sizeBytes: number };

export function FileDetailsPane({ space, path, entry, fixtureMode = false, canOpenWith = false, onOpenLocal, onAddToChatContext, onShowVersionHistory, onRename }: {
  space: SpaceSummary;
  path: string;
  entry: TreeEntry | null;
  fixtureMode?: boolean;
  canOpenWith?: boolean;
  onOpenLocal: (path: string, action: "reveal" | "open" | "open-native" | "open-with") => void | Promise<void>;
  onAddToChatContext: (path: string) => void;
  onShowVersionHistory: (path: string) => void;
  onRename?: (path: string) => void;
}) {
  const [info, setInfo] = useState<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  // `undefined` while the preview is still being read; `null` when none exists.
  const [preview, setPreview] = useState<FilePreview | null | undefined>(undefined);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Which file content the preview reflects: Space, path, and modified time.
  // A new modified time refreshes the preview in place; a new path clears it.
  const [contentKey, setContentKey] = useState<string | null>(null);
  const fileKey = `${space.id}\0${path}`;
  const [shownFileKey, setShownFileKey] = useState(fileKey);
  if (shownFileKey !== fileKey) {
    setShownFileKey(fileKey);
    setPreview(undefined);
    setObjectUrl(null);
    setContentKey(null);
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setMissing(false); setInfo(null);
    if (fixtureMode) {
      setInfo(entry ? { name: entry.name, path: entry.path, kind: entry.kind, sizeBytes: entry.sizeBytes ?? 0, createdAt: space.createdAt, modifiedAt: entry.updatedAt ?? space.updatedAt, mimeType: "application/octet-stream" } : null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    void api<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string }>(`/api/spaces/${space.id}/file-info?path=${encodeURIComponent(path)}`)
      .then((result) => { if (!cancelled) { setInfo(result); setContentKey(`${fileKey}\0${result.modifiedAt}`); } })
      .catch((caught) => { if (!cancelled) { const message = errorText(caught); const gone = message.includes("not found") || message.includes("ENOENT") || message.includes("no longer"); setMissing(gone); if (!gone) setContentKey(`${fileKey}\0`); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry, fixtureMode, path, space.id]);
  // The tab shows the file itself, not a card about it: bounded text, common
  // image types, and PDFs render inline; everything else keeps the actions.
  useEffect(() => {
    if (fixtureMode) { setPreview(null); return; }
    if (!contentKey) return;
    let cancelled = false;
    void api<{ preview: FilePreview }>(`/api/spaces/${space.id}/file-preview?path=${encodeURIComponent(path)}`)
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
    void spaceRawFileObjectUrl(space.id, path, controller.signal)
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
  if (missing) return <section className="file-details-pane file-details-empty"><EmptyInline text="This file is no longer in the Space" /></section>;
  return (
    <section className="file-details-pane" aria-label={`File details for ${fileName}`}>
      <header className="file-details-header">
        <div className="file-details-identity">
          <span className="file-details-icon" aria-hidden="true"><FileTypeIcon path={path} /></span>
          <div className="file-details-title">
            <h2 title={path}>{fileName}</h2>
            <p className="file-details-meta-line">
              {loading && !info && !entry ? <><Loader2 className="spin" size={12} />Loading</> : metaLine}
            </p>
          </div>
        </div>
        <div className="file-details-actions">
          <button className="primary-button compact no-margin" type="button" onClick={() => void onOpenLocal(path, openLabel.office ? "open-native" : "open")}><ExternalLink size={14} />{openLabel.text}</button>
          {canOpenWith ? <button className="secondary-button compact no-margin" type="button" onClick={() => void onOpenLocal(path, "open-with")}><AppWindow size={14} />Open with</button> : null}
          <button className="minimal-icon-button" type="button" title={revealLabel} aria-label={revealLabel} onClick={() => void onOpenLocal(path, "reveal")}><FolderOpen size={15} /></button>
          <button className="minimal-icon-button" type="button" title="Attach to chat" aria-label="Attach to chat" onClick={() => onAddToChatContext(path)}><CirclePlus size={15} /></button>
          <button className="minimal-icon-button" type="button" title="Version history" aria-label="Version history" onClick={() => onShowVersionHistory(path)}><History size={15} /></button>
          {onRename ? <button className="minimal-icon-button" type="button" title="Rename" aria-label="Rename" onClick={() => onRename(path)}><PencilLine size={15} /></button> : null}
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

function fileTypeLabel(path: string): string {
  const extension = fileExtension(path);
  const known = new Map([[".docx", "Word document"], [".xlsx", "Excel workbook"], [".csv", "CSV spreadsheet"], [".pptx", "PowerPoint presentation"], [".pdf", "PDF document"], [".txt", "Text file"], [".md", "Markdown file"], [".json", "JSON file"], [".png", "PNG image"], [".jpg", "JPEG image"], [".jpeg", "JPEG image"], [".svg", "SVG image"]]);
  return known.get(extension) ?? (extension ? `${extension.slice(1).toUpperCase()} file` : "File");
}
