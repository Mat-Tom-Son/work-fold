import { useEffect, useState } from "react";
import { CirclePlus, ExternalLink, FolderOpen, History, Loader2, PencilLine } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { nativeOpenLabel, revealInFileManagerLabel } from "../../lib/file-actions";
import { formatBytes, formatDateTime } from "../../lib/format";
import { fileExtension, parentFolderPath } from "../../lib/tree";
import type { TreeEntry, SpaceSummary } from "../../types";
import { EmptyInline } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";

export function FileDetailsPane({ space, path, entry, fixtureMode = false, onOpenLocal, onAddToChatContext, onShowVersionHistory, onRename }: {
  space: SpaceSummary;
  path: string;
  entry: TreeEntry | null;
  fixtureMode?: boolean;
  onOpenLocal: (path: string, action: "reveal" | "open" | "open-native") => void | Promise<void>;
  onAddToChatContext: (path: string) => void;
  onShowVersionHistory: (path: string) => void;
  onRename?: (path: string) => void;
}) {
  const [info, setInfo] = useState<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setMissing(false); setInfo(null);
    if (fixtureMode) {
      setInfo(entry ? { name: entry.name, path: entry.path, kind: entry.kind, sizeBytes: entry.sizeBytes ?? 0, createdAt: space.createdAt, modifiedAt: entry.updatedAt ?? space.updatedAt, mimeType: "application/octet-stream" } : null);
      setLoading(false);
      return () => { cancelled = true; };
    }
    void api<{ name: string; path: string; kind: "file" | "folder"; sizeBytes: number; createdAt: string; modifiedAt: string; mimeType: string }>(`/api/spaces/${space.id}/file-info?path=${encodeURIComponent(path)}`)
      .then((result) => { if (!cancelled) setInfo(result); })
      .catch((caught) => { if (!cancelled) { const message = errorText(caught); setMissing(message.includes("not found") || message.includes("ENOENT") || message.includes("no longer")); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [entry, fixtureMode, path, space.id]);
  const fileName = info?.name ?? entry?.name ?? path.split("/").pop() ?? path;
  const openLabel = nativeOpenLabel({ name: fileName, path, kind: "file" });
  const metadata = [
    { label: "Size", value: info ? formatBytes(info.sizeBytes) : typeof entry?.sizeBytes === "number" ? formatBytes(entry.sizeBytes) : loading ? "Loading" : "—" },
    { label: "Modified", value: info?.modifiedAt ? formatDateTime(info.modifiedAt) : entry?.updatedAt ? formatDateTime(entry.updatedAt) : loading ? "Loading" : "—" },
    { label: "Created", value: info?.createdAt ? formatDateTime(info.createdAt) : loading ? "Loading" : "—" },
    { label: "Type", value: fileTypeLabel(path) },
    { label: "Location", value: space.location.storage === "linked" ? "Linked folder" : "Managed Space" },
  ];
  if (missing) return <section className="file-details-pane file-details-empty"><EmptyInline text="This file is no longer in the Space" /></section>;
  return (
    <section className="file-details-pane" aria-label={`File details for ${fileName}`}>
      <header className="file-details-header">
        <span className="file-details-icon" aria-hidden="true"><FileTypeIcon path={path} /></span>
        <div className="file-details-title"><h2>{fileName}</h2><p>{parentFolderPath(path) || space.name}</p></div>
      </header>
      <dl className="file-details-meta context-meta-grid">{metadata.map((item) => <div key={item.label}><dt>{item.label}</dt><dd title={item.value}>{item.value}</dd></div>)}</dl>
      {loading ? <div className="file-details-loading" aria-live="polite"><Loader2 className="spin" size={14} /><span>Loading file details</span></div> : null}
      <div className="file-details-actions">
        <button className="primary-button compact no-margin" type="button" onClick={() => void onOpenLocal(path, openLabel.office ? "open-native" : "open")}><ExternalLink size={15} />{openLabel.text}</button>
        <button className="secondary-button compact no-margin" type="button" onClick={() => void onOpenLocal(path, "reveal")}><FolderOpen size={15} />{revealInFileManagerLabel()}</button>
        <button className="secondary-button compact no-margin" type="button" onClick={() => onAddToChatContext(path)}><CirclePlus size={15} />Attach to chat</button>
        <button className="secondary-button compact no-margin" type="button" onClick={() => onShowVersionHistory(path)}><History size={15} />Version history</button>
        {onRename ? <button className="secondary-button compact no-margin" type="button" onClick={() => onRename(path)}><PencilLine size={15} />Rename</button> : null}
      </div>
    </section>
  );
}

function fileTypeLabel(path: string): string {
  const extension = fileExtension(path);
  const known = new Map([[".docx", "Word document"], [".xlsx", "Excel workbook"], [".csv", "CSV spreadsheet"], [".pptx", "PowerPoint presentation"], [".pdf", "PDF document"], [".txt", "Text file"], [".md", "Markdown file"], [".json", "JSON file"], [".png", "PNG image"], [".jpg", "JPEG image"], [".jpeg", "JPEG image"], [".svg", "SVG image"]]);
  return known.get(extension) ?? (extension ? `${extension.slice(1).toUpperCase()} file` : "File");
}
