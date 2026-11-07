import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Chat16Regular, ChevronLeft20Regular, ChevronRight16Regular, History16Regular } from "@fluentui/react-icons";

import { api, errorText } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { queueHistoryRequest } from "../../lib/history-queue";
import { rawFileObjectUrlAt } from "../../lib/raw-file";
import { readStoredJsonValue, writeStoredJsonValue } from "../../lib/storage";
import { showToast } from "../../ui/feedback";
import { subscribeControlEvents } from "../../lib/control-events";
import { notifyFolderAutomationsChanged } from "../../hooks/useFolderAutomations";
import { restorePointTitle } from "../panes/workFolderPanes";
import type { WorkFolderUiFixture } from "../../fixtures/work-folder-fixture";
import type { FolderAutomationView } from "../../../../src/shared/automation-presentation";
import { automationCardRows, type AutomationCardRow } from "./file-manager-automations";
import type { ConversationSummary, FileVersionEntry, TreeEntry, WorkFolderCheckpoint, WorkFolderSummary } from "../../types";
import { fileKindLabel, fileManagerIcon, formatFileManagerDate, historyTimeLabel } from "./file-manager-model";
import { placeApiBase, type FileManagerPlace } from "./file-manager-places";
import { TintedFolder } from "./file-manager-folder";
import type { WorkFolderIconOption } from "../../work-folder-icons";

type PanelTab = "info" | "history";
const tabStorageKey = "work-fold.file-manager.panel-tab.v1";
const previewableImage = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

type HistoryAction =
  | { kind: "undo" | "restore"; checkpointId: string }
  | { kind: "version"; path: string; hashSha256: string }
  | { kind: "current" };

interface HistoryRow { id: string; kind: "chat" | "change"; conversationId?: string; title: string; at: string; detail?: string; action?: HistoryAction }

/**
 * The file manager's right panel (docs/product-model.md, "2026-11-06 file
 * manager layout"), as the design draws it. In a work-folder, Info says what
 * the selection is and History lists its Chats and changes. A standard folder
 * offers to put the folder to work.
 */
export function FileManagerPanel({ place, workFolder, placeName, folderPath, folderName, folderColor, folderSymbol, receipt = null, arriving = false, itemCount, selection, automations, fixture, chat, composer, chatStatuses, searchItem, historyRefreshKey, onPutToWork, onOpenChat, onRestored, onError }: {
  place: FileManagerPlace;
  workFolder: WorkFolderSummary | null;
  placeName: string;
  placeRoot: string;
  folderPath: string;
  folderName: string;
  /** The work-folder's color when the panel describes its top level. */
  folderColor: string | null;
  /** The icon chosen in Customize work-folder, stamped on the folder. */
  folderSymbol?: WorkFolderIconOption["Icon"] | null;
  /** What the Worker's last reply changed, at the top of Info. */
  receipt?: ReactNode;
  itemCount: number;
  selection: TreeEntry[];
  automations: FolderAutomationView[];
  fixture: WorkFolderUiFixture | null;
  /**
   * The Chat the panel holds. While `open`, it replaces Info and History, as
   * in the design; closed, it stays mounted so a running reply keeps streaming.
   */
  chat: { open: boolean; title: string; onBack: () => void; content: ReactNode } | null;
  /** The panel was just shown: it slides in. */
  arriving?: boolean;
  /** The message box at the panel's foot in a work-folder; its suggestions show on Info only. */
  composer: ((options: { showSuggestions: boolean }) => ReactNode) | null;
  /** Changes whenever the work-folder's files change, so History reloads. */
  historyRefreshKey: number;
  /** A search result chosen in the list, which may be in another work-folder. */
  searchItem: { apiBase: string; entry: TreeEntry; where: string } | null;
  /** Chat activity by chatActivityKey, for History's dots. */
  chatStatuses: Readonly<Record<string, "running" | "attention">>;
  onPutToWork: () => void;
  onOpenChat: (conversationId: string, title: string) => void;
  onRestored: () => void;
  onError: (message: string | null) => void;
}) {
  const [storedTab, setTabState] = useState<PanelTab>(() => readStoredJsonValue(tabStorageKey, (value) => value === "history" ? "history" : "info", "info"));
  const setTab = (next: PanelTab) => { setTabState(next); writeStoredJsonValue(tabStorageKey, next); };
  // Only a work-folder has a Worker and History; elsewhere the panel is Info alone.
  const tabsShown = Boolean(workFolder);
  const tab = tabsShown ? storedTab : "info";
  const single = selection.length === 1 ? selection[0]! : null;
  const apiBase = placeApiBase(place);
  const fixtureMode = Boolean(fixture);
  const where = (path: string) => [placeName, ...path.split("/").filter(Boolean).slice(0, -1)].join(" › ");

  let info;
  if (searchItem) {
    info = <ItemInfo apiBase={searchItem.apiBase} entry={searchItem.entry} where={searchItem.where} fixtureMode={fixtureMode} />;
  } else if (single) {
    info = <ItemInfo apiBase={apiBase} entry={single} where={where(single.path)} fixtureMode={fixtureMode} />;
  } else if (selection.length > 1) {
    info = <SelectionInfo selection={selection} sizeOf={(entry) => entry.kind === "folder" ? "--" : typeof entry.sizeBytes === "number" ? formatBytes(entry.sizeBytes) : ""} />;
  } else if (folderPath) {
    info = <ItemInfo apiBase={apiBase} entry={{ name: folderName, path: folderPath, kind: "folder" }} where={where(folderPath)} fixtureMode={fixtureMode} itemCount={itemCount} />;
  } else if (workFolder) {
    info = <WorkFolderInfo workFolderId={workFolder.id} name={folderName} color={folderColor} symbol={folderSymbol ?? null} itemCount={itemCount} automations={automations} fixtureMode={fixtureMode} onError={onError} />;
  } else {
    info = <>
      <FolderHeader name={folderName} color={null} itemCount={itemCount} />
      <section className="fm-sec">
        <div className="fm-cta">
          <div className="fm-cta-t">No Worker here yet</div>
          <div className="fm-cta-s">Adds a Worker and History. Nothing moves.</div>
          <button type="button" className="fm-btn is-primary" onClick={onPutToWork}>Put This Folder to Work</button>
        </div>
      </section>
    </>;
  }

  const chatShown = Boolean(chat?.open);
  // Motion (2026-11-07): Info and History slide in from the side of the tab
  // you chose, and coming back from a Chat slides the panel in from the left,
  // as a Mac app's navigation does. Decided while rendering, so the first
  // frame of the new pane already has it.
  const shownRef = useRef<{ tab: PanelTab; chat: boolean } | null>(null);
  const previous = shownRef.current;
  const paneFrom = !previous ? "none" : previous.chat && !chatShown ? "left" : previous.tab !== tab ? (tab === "history" ? "right" : "left") : null;
  const paneFromRef = useRef<"left" | "right" | "none">("none");
  if (paneFrom) paneFromRef.current = paneFrom;
  useEffect(() => { shownRef.current = { tab, chat: chatShown }; });
  return <aside className={`fm-panel${chatShown ? " is-chat" : ""}${arriving ? " is-arriving" : ""}`} aria-label={chatShown ? "Chat" : tabsShown ? "Info and History" : "Info"}>
    {chatShown && chat ? <div className="fm-ph">
      <button type="button" className="fm-capbtn" onClick={chat.onBack} aria-label="Back to Info" title="Back"><ChevronLeft20Regular /></button>
      <div className="fm-ph-t" title={chat.title}>{chat.title}</div>
    </div> : null}
    {!chatShown && tabsShown ? <div className="fm-tabs">
      <div className="fm-seg has-thumb" role="tablist" aria-label="Panel" style={{ "--fm-seg-index": tab === "history" ? 1 : 0 } as CSSProperties}>
        <span className="fm-seg-thumb" aria-hidden="true" />
        <button type="button" role="tab" aria-selected={tab === "info"} className={`fm-seg-b${tab === "info" ? " is-on" : ""}`} onClick={() => setTab("info")}>Info</button>
        <button type="button" role="tab" aria-selected={tab === "history"} className={`fm-seg-b${tab === "history" ? " is-on" : ""}`} onClick={() => setTab("history")}>
          <span>History</span>
          {workFolder && Object.entries(chatStatuses).some(([key, status]) => status === "attention" && key.startsWith(`${workFolder.id}:`)) ? <span className="fm-dot is-done" aria-label="New reply" role="img" /> : null}
        </button>
      </div>
    </div> : null}
    {chatShown ? null : <div className={`fm-panel-scroll${tabsShown ? "" : " is-untabbed"}`} role={tabsShown ? "tabpanel" : undefined}>
      <div key={tab} className="fm-pane" data-from={paneFromRef.current}>
        {tab === "info" || !workFolder
          ? <>{receipt}{info}</>
          : <HistoryList workFolder={workFolder} file={single?.kind === "file" ? single : null} fixture={fixture} chatStatuses={chatStatuses} refreshKey={historyRefreshKey} onOpenChat={onOpenChat} onRestored={onRestored} onError={onError} />}
      </div>
    </div>}
    {chat ? <div className="fm-chat" hidden={!chatShown}>{chat.content}</div> : null}
    {chatShown || !composer ? null : composer({ showSuggestions: tab === "info" })}
  </aside>;
}

function FolderHeader({ name, color, symbol = null, itemCount }: { name: string; color: string | null; symbol?: WorkFolderIconOption["Icon"] | null; itemCount: number }) {
  return <div className="fm-hd">
    <div className="fm-pv">
      {color ? <TintedFolder color={color} symbol={symbol} /> : <span className="fm-ic fm-ic-folder" aria-hidden="true" />}
    </div>
    <div className="fm-pv-name" title={name}>{name}</div>
    <div className="fm-pv-meta">{itemCount === 1 ? "1 item" : `${itemCount} items`}</div>
  </div>;
}

/**
 * A work-folder's top level: its Automations, each with its on/off switch,
 * then the ready-made ones it hasn't turned on, which Turn on creates.
 */
function WorkFolderInfo({ workFolderId, name, color, symbol, itemCount, automations, fixtureMode, onError }: {
  workFolderId: string;
  name: string;
  color: string | null;
  symbol: WorkFolderIconOption["Icon"] | null;
  itemCount: number;
  automations: FolderAutomationView[];
  fixtureMode: boolean;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const rows = automationCardRows(workFolderId, automations);
  async function toggle(row: AutomationCardRow, on: boolean) {
    const bridge = window.workFoldDesktop?.automations;
    if (fixtureMode) { showToast({ text: "Automations are disabled in the preview", tone: "info" }); return; }
    if (!bridge) { showToast({ text: "Automations are available in the Mac app", tone: "info" }); return; }
    setBusy(row.automationId);
    try {
      if (!on) await bridge.disable(row.automationId);
      else if (row.templateId && !row.existing) {
        if (!bridge.enableTemplate) throw new Error("Update work-fold to turn on ready-made Automations.");
        await bridge.enableTemplate(workFolderId, row.templateId);
      } else if (row.templateId && bridge.enableTemplate) await bridge.enableTemplate(workFolderId, row.templateId);
      else await bridge.enable(row.automationId);
      notifyFolderAutomationsChanged();
    } catch (caught) {
      onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
    } finally {
      setBusy(null);
    }
  }
  return <>
    <FolderHeader name={name} color={color} symbol={symbol} itemCount={itemCount} />
    <section className="fm-sec">
      <h2 className="fm-sec-h">Automations</h2>
      <div className="fm-card">
        {rows.map((row) => <div className="fm-crow" key={row.automationId}>
          <span className="fm-crow-n" title={row.description ?? row.title}>{row.title}</span>
          <button
            type="button"
            className={`fm-sw${row.on ? " is-on" : ""}`}
            role="switch"
            aria-checked={row.on}
            aria-label={row.title}
            disabled={busy === row.automationId}
            onClick={() => void toggle(row, !row.on)}
          ><span className="fm-sw-knob" /></button>
        </div>)}
      </div>
    </section>
  </>;
}

/** One file or folder: the preview (a picture shows itself), then where it is, when it changed, and its size. */
function ItemInfo({ apiBase, entry, where, fixtureMode, itemCount }: { apiBase: string | null; entry: TreeEntry; where: string; fixtureMode: boolean; itemCount?: number }) {
  const [modifiedAt, setModifiedAt] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    setModifiedAt(null);
    if (fixtureMode || !apiBase) return;
    let cancelled = false;
    void api<{ modifiedAt: string }>(`${apiBase}/file-info?path=${encodeURIComponent(entry.path)}`)
      .then((result) => { if (!cancelled) setModifiedAt(result.modifiedAt); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [apiBase, entry.path, fixtureMode]);
  // A selected folder says how many items it holds, as the design does.
  useEffect(() => {
    setCount(null);
    if (entry.kind !== "folder" || itemCount !== undefined || fixtureMode || !apiBase) return;
    let cancelled = false;
    void api<{ tree: TreeEntry[] }>(`${apiBase}/tree?maxDepth=0&path=${encodeURIComponent(entry.path)}`)
      .then((result) => { if (!cancelled) setCount(result.tree.length); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [apiBase, entry.kind, entry.path, fixtureMode, itemCount]);
  useEffect(() => {
    setImageUrl(null);
    if (fixtureMode || !apiBase || entry.kind !== "file" || !previewableImage.test(entry.name)) return;
    const controller = new AbortController();
    let url: string | null = null;
    void rawFileObjectUrlAt(apiBase, entry.path, controller.signal)
      .then((created) => { url = created; if (!controller.signal.aborted) setImageUrl(created); else URL.revokeObjectURL(created); })
      .catch(() => undefined);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [apiBase, entry.kind, entry.name, entry.path, fixtureMode]);
  const icon = fileManagerIcon(entry);
  const folderCount = itemCount ?? count;
  const meta = entry.kind === "folder"
    ? folderCount === null ? "Folder" : folderCount === 1 ? "1 item" : `${folderCount} items`
    : `${fileKindLabel(entry)}${typeof entry.sizeBytes === "number" ? ` · ${formatBytes(entry.sizeBytes)}` : ""}`;
  return <>
    <div className="fm-hd">
      <div className="fm-pv">{imageUrl ? <img className="fm-pv-image" src={imageUrl} alt="" /> : <span className={icon.className} data-label={icon.label} aria-hidden="true" />}</div>
      <div className="fm-pv-name" title={entry.name}>{entry.name}</div>
      <div className="fm-pv-meta">{meta}</div>
    </div>
    <section className="fm-sec">
      <h2 className="fm-sec-h">Information</h2>
      <div className="fm-card">
        <div className="fm-crow"><span className="fm-crow-l">Where</span><span className="fm-crow-v" title={where}>{where}</span></div>
        {modifiedAt ?? entry.updatedAt ? <div className="fm-crow"><span className="fm-crow-l">Modified</span><span className="fm-crow-v">{formatFileManagerDate(modifiedAt ?? entry.updatedAt)}</span></div> : null}
        {entry.kind === "file" && typeof entry.sizeBytes === "number" ? <div className="fm-crow"><span className="fm-crow-l">Size</span><span className="fm-crow-v">{formatBytes(entry.sizeBytes)}</span></div> : null}
      </div>
    </section>
  </>;
}

function SelectionInfo({ selection, sizeOf }: { selection: TreeEntry[]; sizeOf: (entry: TreeEntry) => string }) {
  const sameKind = selection.every((entry) => fileKindLabel(entry) === fileKindLabel(selection[0]!));
  return <>
    <div className="fm-hd">
      <div className="fm-multi" aria-hidden="true">
        {selection.slice(0, 3).map((entry, index) => {
          const icon = fileManagerIcon(entry);
          return <span key={entry.path} className={`${icon.className} fm-multi-${index}`} data-label={icon.label} />;
        })}
      </div>
      <div className="fm-pv-name">{selection.length} items</div>
      <div className="fm-pv-meta">{sameKind ? `${selection.length} ${pluralKind(fileKindLabel(selection[0]!))}` : "Different kinds"}</div>
    </div>
    <section className="fm-sec">
      <h2 className="fm-sec-h">Selected</h2>
      <div className="fm-card">
        {selection.slice(0, 8).map((entry) => {
          const icon = fileManagerIcon(entry);
          return <div className="fm-crow" key={entry.path}>
            <span className="fm-crow-icon"><span className={icon.className} data-label={icon.label} aria-hidden="true" /></span>
            <span className="fm-crow-n" title={entry.name}>{entry.name}</span>
            <span className="fm-crow-s">{sizeOf(entry)}</span>
          </div>;
        })}
      </div>
    </section>
  </>;
}

/**
 * History as the design draws it: Chats open in the panel; a change says
 * Undo ("Before …") or Restore; one file's versions mark the Current one and
 * offer Restore on the others. Every restore leaves its own restore point,
 * and the toast's Undo goes back to it.
 */
function HistoryList({ workFolder, file, fixture, chatStatuses, refreshKey, onOpenChat, onRestored, onError }: {
  workFolder: WorkFolderSummary;
  file: TreeEntry | null;
  fixture: WorkFolderUiFixture | null;
  chatStatuses: Readonly<Record<string, "running" | "attention">>;
  refreshKey: number;
  onOpenChat: (conversationId: string, title: string) => void;
  onRestored: () => void;
  onError: (message: string | null) => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // A Worker turn starting or ending adds a Chat or a restore point.
  useEffect(() => {
    if (fixture) return;
    let timer: number | null = null;
    const unsubscribe = subscribeControlEvents((hint) => {
      if (hint !== "activity") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; setRevision((value) => value + 1); }, 300);
    });
    return () => { unsubscribe(); if (timer !== null) window.clearTimeout(timer); };
  }, [fixture]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // A reload keeps the rows on screen; only a different list starts from Loading.
    const key = `${workFolder.id}\0${file?.path ?? ""}`;
    if (key !== loadedKey) setRows(null);
    async function load(): Promise<HistoryRow[]> {
      if (fixture) {
        const chats = file ? [] : (fixture.conversations[workFolder.id] ?? []).map((chat) => chatRow(chat));
        const changes = file ? [] : (fixture.checkpoints[workFolder.id] ?? []).map(changeRow);
        return [...chats, ...changes];
      }
      if (file) {
        const [body, current] = await Promise.all([
          queueHistoryRequest(workFolder.id, () => api<{ versions: FileVersionEntry[] }>(`/api/work-folders/${workFolder.id}/history/file-versions?path=${encodeURIComponent(file.path)}`)),
          api<{ hashSha256: string | null }>(`/api/work-folders/${workFolder.id}/file-info?path=${encodeURIComponent(file.path)}`).catch(() => ({ hashSha256: null })),
        ]);
        let currentShown = false;
        return body.versions.map((version, index) => {
          const isCurrent = !currentShown && Boolean(current.hashSha256) && version.hashSha256 === current.hashSha256;
          if (isCurrent) currentShown = true;
          return {
            id: `version:${version.checkpointId}:${index}`,
            kind: "change" as const,
            title: version.checkpointLabel ? restorePointTitle({ label: version.checkpointLabel, reason: "" }) : "Saved version",
            at: version.capturedAt || version.modifiedAt,
            detail: formatBytes(version.sizeBytes),
            action: isCurrent ? { kind: "current" as const } : { kind: "version" as const, path: file.path, hashSha256: version.hashSha256 },
          };
        });
      }
      const [chats, checkpoints] = await Promise.all([
        api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${workFolder.id}/conversations`).then((body) => body.conversations).catch(() => [] as ConversationSummary[]),
        queueHistoryRequest(workFolder.id, () => api<{ checkpoints: WorkFolderCheckpoint[] }>(`/api/work-folders/${workFolder.id}/history/checkpoints`)).then((body) => body.checkpoints),
      ]);
      return [...chats.filter((chat) => !chat.archivedAt).map(chatRow), ...checkpoints.map(changeRow)];
    }
    load()
      .then((loaded) => { if (!cancelled) { setRows(loaded); setLoadedKey(key); } })
      .catch((caught) => { if (!cancelled) { setRows([]); onError(errorText(caught)); } });
    return () => { cancelled = true; };
  }, [file?.path, fixture, revision, refreshKey, workFolder.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changes on top and Chats below, newest first in each (owner decision 2026-11-07: no filter).
  const sections = useMemo(() => {
    const sorted = [...(rows ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { changes: sorted.filter((row) => row.kind === "change"), chats: sorted.filter((row) => row.kind === "chat") };
  }, [rows]);
  // Each section shows its newest few until the person asks for the rest.
  const [expanded, setExpanded] = useState<{ changes: boolean; chats: boolean }>({ changes: false, chats: false });
  useEffect(() => { setExpanded({ changes: false, chats: false }); }, [workFolder.id, file?.path]);

  async function restoreRestorePoint(checkpointId: string): Promise<{ safetyCheckpointId: string }> {
    return queueHistoryRequest(workFolder.id, () => api<{ safetyCheckpointId: string }>(`/api/work-folders/${workFolder.id}/history/checkpoints/${encodeURIComponent(checkpointId)}/restore`, { method: "POST", body: {} }));
  }

  async function run(row: HistoryRow) {
    const action = row.action;
    if (!action || action.kind === "current") return;
    if (fixture) { showToast({ text: "Restoring is disabled in the preview", tone: "info" }); return; }
    setBusy(row.id);
    try {
      const result = action.kind === "version"
        ? (await queueHistoryRequest(workFolder.id, () => api<{ result: { safetyCheckpointId: string } }>(`/api/work-folders/${workFolder.id}/history/file-versions`, { method: "POST", body: { path: action.path, hashSha256: action.hashSha256 } }))).result
        : await restoreRestorePoint(action.checkpointId);
      onRestored();
      setRevision((value) => value + 1);
      showToast({
        // "Before deleting budget.md" undone reads "Undid deleting budget.md".
        text: action.kind === "version" ? `Restored ${file?.name ?? "the file"}` : action.kind === "undo" ? `Undid ${row.title.replace(/^Before\s+/, "").replace(/^a /, "")}` : `Restored “${row.title}”`,
        tone: "success",
        actionLabel: "Undo",
        durationMs: 8000,
        onAction: () => {
          void restoreRestorePoint(result.safetyCheckpointId)
            .then(() => { onRestored(); setRevision((value) => value + 1); })
            .catch((caught) => onError(errorText(caught)));
        },
      });
    } catch (caught) {
      onError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const changeView = (row: HistoryRow) => <div className="fm-crow" key={row.id}>
    <span className="fm-crow-glyph" aria-hidden="true"><History16Regular /></span>
    <span className="fm-crow-t"><span title={row.title}>{row.title}</span><span className="fm-crow-s">{historyTimeLabel(row.at)}{row.detail ? ` · ${row.detail}` : ""}</span></span>
    {row.action?.kind === "current" ? <span className="fm-crow-tag">Current</span> : null}
    {row.action && row.action.kind !== "current" ? <button type="button" className="fm-btn is-small" disabled={busy !== null} onClick={() => void run(row)}>{row.action.kind === "undo" ? "Undo" : "Restore"}</button> : null}
  </div>;
  const chatView = (row: HistoryRow) => {
    const status = chatStatuses[`${workFolder.id}:${row.conversationId}`];
    return <button type="button" className="fm-crow fm-crow-btn" key={row.id} onClick={() => onOpenChat(row.conversationId!, row.title)}>
      <span className="fm-crow-glyph" aria-hidden="true"><Chat16Regular /></span>
      <span className="fm-crow-t"><span title={row.title}>{row.title}</span><span className="fm-crow-s">{historyTimeLabel(row.at)}</span></span>
      {status ? <span className={`fm-dot ${status === "running" ? "is-run" : "is-done"}`} aria-label={status === "running" ? "Working" : "New reply"} role="img" /> : null}
      <ChevronRight16Regular className="fm-crow-chev" aria-hidden="true" />
    </button>;
  };
  const section = (key: "changes" | "chats", title: string, items: HistoryRow[], empty: string, view: (row: HistoryRow) => ReactNode) => {
    const open = expanded[key] || items.length <= historySectionRows + 1;
    const shown = open ? items : items.slice(0, historySectionRows);
    return <section className="fm-sec" key={key}>
      <h2 className="fm-sec-h">{title}</h2>
      {items.length ? <div className="fm-card">
        {shown.map(view)}
        {items.length > historySectionRows + 1 ? <button type="button" className="fm-crow fm-crow-btn fm-crow-more" aria-expanded={expanded[key]} onClick={() => setExpanded((current) => ({ ...current, [key]: !current[key] }))}>
          {expanded[key] ? "Show Less" : `Show ${items.length - historySectionRows} More`}
        </button> : null}
      </div> : <p className="fm-sec-empty">{empty}</p>}
    </section>;
  };

  if (rows === null) return <p className="fm-panel-empty">Loading…</p>;
  return file
    ? section("changes", "Versions", sections.changes, "No earlier versions yet.", changeView)
    : <>
      {section("changes", "Changes", sections.changes, "No changes yet.", changeView)}
      {section("chats", "Chats", sections.chats, "No Chats yet.", chatView)}
    </>;
}

/** How many rows a History section shows before "Show More". */
const historySectionRows = 5;

function chatRow(chat: Pick<ConversationSummary, "id" | "title" | "updatedAt">): HistoryRow {
  return { id: `chat:${chat.id}`, kind: "chat", conversationId: chat.id, title: chat.title || "New Chat", at: chat.updatedAt };
}

function changeRow(checkpoint: WorkFolderCheckpoint): HistoryRow {
  const title = restorePointTitle(checkpoint);
  return {
    id: `change:${checkpoint.checkpointId}`,
    kind: "change",
    title,
    at: checkpoint.createdAt,
    detail: checkpoint.fileCount === 1 ? "1 file" : `${checkpoint.fileCount} files`,
    // A "Before …" restore point undoes what came after it; any other goes back to it.
    action: { kind: /^Before\b/.test(title) ? "undo" : "restore", checkpointId: checkpoint.checkpointId },
  };
}

function pluralKind(kind: string): string {
  return kind.endsWith("s") ? kind : `${kind}s`;
}

/**
 * The message box at the foot of the panel (docs/product-model.md,
 * 2026-11-06): "Work in <folder>", or "Work on this file" with the selection
 * shown as a removable chip. The selection goes to the Worker as path
 * references it reads with its own tools.
 */
export function FileManagerComposer({ placeholder, chips, suggestions, modelRow, dropActive = false, onDragOverBox, onDragLeaveBox, onDropBox, onRemoveChip, onSend }: {
  placeholder: string;
  chips: readonly TreeEntry[];
  /** Push buttons above the field that send at once; hidden while the person is typing. */
  suggestions: readonly string[];
  /** The small row under the field: the Worker's model, or Set Up AI. */
  modelRow?: ReactNode;
  /** Files dragged onto the box join the message's references. */
  dropActive?: boolean;
  onDragOverBox?: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeaveBox?: (event: DragEvent<HTMLDivElement>) => void;
  onDropBox?: (event: DragEvent<HTMLDivElement>) => void;
  onRemoveChip: (path: string) => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const first = chips[0];
  const firstIcon = first ? fileManagerIcon(first) : null;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };
  return <div className={`fm-comp${dropActive ? " is-drop-target" : ""}`} onDragOver={onDragOverBox} onDragLeave={onDragLeaveBox} onDrop={onDropBox}>
    {suggestions.length && !draft.trim() ? <div className="fm-suggests">
      {suggestions.map((suggestion) => <button key={suggestion} type="button" className="fm-btn fm-suggest" title={suggestion} onClick={() => onSend(suggestion)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.25h11v7.5H6.5l-3 2.5v-2.5h-1z" /></svg>
        <span>{suggestion}</span>
      </button>)}
    </div> : null}
    {first && firstIcon ? <div className="fm-ctx">
      <span className="fm-cchip is-removable" title={first.name}>
        <span className={firstIcon.className} data-label="" aria-hidden="true" />
        <span className="fm-cchip-n">{first.name}</span>
        <button type="button" className="fm-cx" aria-label={`Remove ${first.name}`} onClick={() => onRemoveChip(first.path)}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg>
        </button>
      </span>
      {chips.length > 1 ? <span className="fm-cchip is-more">+{chips.length - 1}</span> : null}
    </div> : null}
    <form className="fm-field" onSubmit={(event) => { event.preventDefault(); send(); }}>
      <input type="text" aria-label="Message the Worker" placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button type="submit" className={`fm-send${draft.trim() ? " is-ready" : ""}`} aria-label="Send" disabled={!draft.trim()}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 12.5v-9M4.25 7.25 8 3.5l3.75 3.75" /></svg>
      </button>
    </form>
    {modelRow}
  </div>;
}
