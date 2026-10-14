import { HistoryFileComparison } from "./HistoryFileComparison";
import { useWorkFolderIdentityResolver } from "../../lib/work-folder-appearance-context";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowSync16Regular,
  ArrowUpload16Regular,
  Chat16Regular,
  Checkmark12Regular,
  Checkmark16Regular,
  ChevronRight16Regular,
  Clock16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  Folder16Regular,
  Folder20Regular,
  FolderAdd16Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History16Regular,
  History20Regular,
  MoreHorizontal16Regular,
  Search16Regular,
} from "@fluentui/react-icons";
import { api, apiForm, errorText } from "../../lib/api";
import { ActivityDot } from "../chrome/ActivityDot";
import { descendantFolders, folderTreeRows } from "../../lib/folder-nesting";
import { aggregateChatActivityStatus, chatActivityKey, chatSnoozeTimeLabel, conversationLifecycleView, isRecentlyResurfaced } from "../../lib/chat-lifecycle";
import { shortFolderLocation } from "../../lib/folder-location";
import { formatChatListTime, formatItemCount } from "../../lib/format";
import { workFolderIdentityStyle } from "../../lib/work-folder-identity";
import type {
  ChatActivityStatus,
  ChatLifecycleView,
  ConversationSummary,
  TreeEntry,
  WorkFolderCheckpoint,
  WorkFolderCustomizationMap,
  WorkFolderSummary,
} from "../../types";
import { WorkFolderIconGlyph } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { TextInputModal } from "../modals/TextInputModal";
import { requestConfirm, showToast } from "../../ui/feedback";
import { ChatContentSearch } from "./ChatContentSearch";

export function WorkFoldersPane({
  workFolder,
  workFolders,
  identities,
  onCreate,
  onOpenFolder,
  onCustomize,
  onRemove,
  onDone,
}: {
  workFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  identities: WorkFolderCustomizationMap;
  onCreate: () => void;
  onOpenFolder: () => void;
  onCustomize: (workFolder: WorkFolderSummary) => void;
  onRemove?: (workFolder: WorkFolderSummary) => void;
  onDone?: () => void;
}) {
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const paneRef = useRef<HTMLDivElement>(null);

  // Choosing Manage work-folders closes the menu that had focus; land focus here
  // so Escape and Tab start from this pane instead of the page body.
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) paneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="work-folder-pane-content work-folders-pane professional-surface professional-work-folders" ref={paneRef} tabIndex={-1}>
      <div className="professional-work-folder-actions" aria-label="Add a work-folder">
        <button className="professional-work-folder-action" type="button" onClick={onOpenFolder}>
          <span className="professional-work-folder-action-icon" aria-hidden="true"><FolderOpen20Regular /></span>
          <strong>Use existing folder</strong>
        </button>
        <button className="professional-work-folder-action" type="button" onClick={onCreate}>
          <span className="professional-work-folder-action-icon" aria-hidden="true"><FolderAdd20Regular /></span>
          <strong>Create new work-folder</strong>
        </button>
      </div>

      <section className="work-folder-pane-section professional-section-card">
        <div className="professional-section-heading">
          <span>Your work-folders</span>
          <span className="work-folders-pane-heading-end">
            <strong>{formatItemCount(workFolders.length, "work-folder")}</strong>
            {onDone ? <button className="work-folders-pane-done" type="button" onClick={onDone}>Done</button> : null}
          </span>
        </div>
        <div className="work-folder-switcher">
          {workFolders.map((item) => {
            const identity = workFolderIdentityFor(item, identities);
            const active = item.id === workFolder.id;
            const deletesFolder = item.location.storage === "managed";
            const location = item.location.storage === "managed" ? "" : shortFolderLocation(item.workFolderRoot);
            const subtitle = item.location.providerHint === "google-drive" ? (location ? `Google Drive · ${location}` : "Google Drive") : location;
            return (
              <div className={active ? "work-folder-card-shell active" : "work-folder-card-shell"} key={item.id} style={workFolderIdentityStyle(identity)}>
                <div className="work-folder-card-row">
                  <button
                    className={active ? "work-folder-tab work-folder-card-main active" : "work-folder-tab work-folder-card-main"}
                    type="button"
                    onClick={() => onCustomize(item)}
                    aria-label={`Customize ${item.name}`}
                    title="Customize work-folder"
                  >
                    <span className="work-folder-tab-icon work-folder-identity-icon"><WorkFolderIconGlyph icon={identity.Icon} size={16} /></span>
                    <span className="work-folder-tab-copy">
                      <strong>{item.name}</strong>
                      {subtitle ? <span title={item.workFolderRoot || undefined}>{subtitle}</span> : null}
                    </span>
                    {active ? <span className="active-dot" aria-label="Active work-folder"><Checkmark12Regular /></span> : null}
                  </button>
                  <span className="work-folder-card-actions">
                    {onRemove ? (
                      <button
                        className="work-folder-card-delete"
                        type="button"
                        onClick={() => onRemove(item)}
                        aria-label={`${deletesFolder ? "Delete" : "Remove"} ${item.name}`}
                        title={deletesFolder ? "Delete work-folder" : "Remove work-folder"}
                      >
                        <Delete16Regular />
                      </button>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function ChatsPane({
  workFolder,
  workFolders,
  conversations,
  customizations,
  activeConversationId,
  onOpen,
  onNew,
  onActions,
  activityStatuses,
}: {
  workFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  conversations: Record<string, ConversationSummary[]>;
  customizations: WorkFolderCustomizationMap;
  activeConversationId?: string | null;
  onOpen: (workFolder: WorkFolderSummary, conversation: ConversationSummary) => void;
  onNew: (workFolder: WorkFolderSummary) => void;
  onActions: (workFolder: WorkFolderSummary, conversation: ConversationSummary, event: React.MouseEvent<HTMLElement>) => void;
  activityStatuses: Record<string, ChatActivityStatus>;
}) {
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [expandedOtherWorkFolderIds, setExpandedOtherWorkFolderIds] = useState<Set<string>>(() => new Set());
  // Snoozed and Archived are quiet rows at the bottom (2026-10-01), closed
  // until asked for, instead of a tab bar every visit has to read past.
  const [openShelves, setOpenShelves] = useState<Set<"snoozed" | "archived">>(() => new Set());
  const normalized = query.trim().toLocaleLowerCase();
  // The work-folders inside this one belong to it here: their Chats sit right
  // under its own, indented the way the work-folder switcher shows them.
  const nestedRows = useMemo(() => folderTreeRows(descendantFolders(workFolder, workFolders)), [workFolder, workFolders]);
  const nestedIds = new Set(nestedRows.map((row) => row.workFolder.id));
  const orderedWorkFolders = [workFolder, ...nestedRows.map((row) => row.workFolder), ...workFolders.filter((item) => item.id !== workFolder.id && !nestedIds.has(item.id))];
  const allChats = orderedWorkFolders.flatMap((item) => (conversations[item.id] ?? []).map((chat) => ({ item, chat })));
  const shelfChats = (view: "snoozed" | "archived") => allChats.filter(({ chat }) => conversationLifecycleView(chat, now) === view);

  useEffect(() => {
    if (!allChats.some(({ chat }) => conversationLifecycleView(chat, now) === "snoozed")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [allChats.map(({ chat }) => chat.snoozedUntil ?? "").join("|"), now]);

  useEffect(() => {
    setExpandedOtherWorkFolderIds(new Set());
  }, [workFolder.id]);

  const matchesQuery = (chat: ConversationSummary) => !normalized || chat.title.toLocaleLowerCase().includes(normalized);
  // While searching, every Chat is fair game, snoozed and archived included.
  function chatsFor(item: WorkFolderSummary): ConversationSummary[] {
    return (conversations[item.id] ?? []).filter((chat) =>
      (normalized ? true : conversationLifecycleView(chat, now) === "active") && matchesQuery(chat));
  }

  function toggle<T>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T): void {
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function chatSecondary(chat: ConversationSummary, item: WorkFolderSummary | null): string {
    const view = conversationLifecycleView(chat, now);
    const time = view === "snoozed" && chat.snoozedUntil
      ? chatSnoozeTimeLabel(chat.snoozedUntil)
      : view === "archived" && chat.archivedAt
        ? `Archived ${formatChatListTime(chat.archivedAt)}`
        : isRecentlyResurfaced(chat, now)
          ? "Back now"
          : formatChatListTime(chat.updatedAt);
    return item ? `${item.name} · ${time}` : time;
  }

  function renderChatRows(entries: Array<{ item: WorkFolderSummary; chat: ConversationSummary }>, showFolder: boolean): ReactNode {
    return entries.map(({ item, chat }) => {
      const status = activityStatuses[chatActivityKey(item.id, chat.id)];
      const resurfaced = conversationLifecycleView(chat, now) === "active" && isRecentlyResurfaced(chat, now);
      return (
        <div
          className={[
            "chat-work-folder-row-shell",
            chat.id === activeConversationId ? "active" : "",
            status ? `status-${status}` : "",
            resurfaced ? "resurfaced" : "",
          ].filter(Boolean).join(" ")}
          key={`${item.id}:${chat.id}`}
          onContextMenu={(event) => { event.preventDefault(); onActions(item, chat, event); }}
        >
          <button
            className="chat-work-folder-row"
            type="button"
            aria-current={chat.id === activeConversationId ? "page" : undefined}
            onClick={() => onOpen(item, chat)}
          >
            <span className="chat-work-folder-row-title">{chat.title}</span>
            <span className="chat-work-folder-row-meta">
              {status ? <ActivityDot status={status} labeled /> : null}
              <span className="chat-work-folder-row-time">{chatSecondary(chat, showFolder ? item : null)}</span>
            </span>
          </button>
          <button
            className="chat-work-folder-row-actions"
            type="button"
            aria-label={`Actions for ${chat.title}`}
            title="Chat actions"
            onClick={(event) => onActions(item, chat, event)}
          >
            <MoreHorizontal16Regular />
          </button>
        </div>
      );
    });
  }

  function renderChatList(item: WorkFolderSummary, list: ConversationSummary[], className: string, emptyText: string | null): ReactNode {
    return (
      <div className={`chat-work-folder-list ${className}`}>
        {renderChatRows(list.map((chat) => ({ item, chat })), false)}
        {!list.length && emptyText ? <span className="chat-work-folder-empty">{emptyText}</span> : null}
      </div>
    );
  }

  const currentList = chatsFor(workFolder);
  const currentIdentity = workFolderIdentityFor(workFolder, customizations);
  const otherWorkFolderGroups = workFolders
    .filter((item) => item.id !== workFolder.id && !nestedIds.has(item.id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => {
      const list = chatsFor(item);
      const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
      return { item, list, status };
    });
  const shelves = (["snoozed", "archived"] as const).map((view) => ({ view, entries: shelfChats(view) })).filter((shelf) => shelf.entries.length > 0);

  return (
    <div className="work-folder-pane-content chats-pane professional-surface professional-chats">
      <div className="file-tree-toolbar professional-pane-toolbar">
        <label className="file-tree-search">
          <Search16Regular aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Search Chats"
            aria-label="Search Chats"
          />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear Chat search" title="Clear Chat search"><Dismiss16Regular /></button> : null}
        </label>
      </div>
      <div className="chat-work-folder-groups">
        <section className="chat-work-folder-group chat-work-folder-group-current" style={workFolderIdentityStyle(currentIdentity)}>
          <div className="chat-work-folder-heading">
            <span className="work-folder-identity-icon" aria-hidden="true"><WorkFolderIconGlyph icon={currentIdentity.Icon} size={15} /></span>
            <strong>{workFolder.name}</strong>
            <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(workFolder)} aria-label={`New Chat in ${workFolder.name}`} title="New Chat"><Chat16Regular /></button>
          </div>
          {renderChatList(workFolder, currentList, "chat-work-folder-list-current", normalized ? null : nestedRows.length ? null : "No Chats yet")}
          {nestedRows.map(({ workFolder: item, depth }) => {
            const identity = workFolderIdentityFor(item, customizations);
            const list = chatsFor(item);
            if (normalized && !list.length) return null;
            const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
            return (
              <div className="chat-nested-work-folder" key={item.id} style={{ ...workFolderIdentityStyle(identity), "--folder-depth": depth + 1 } as CSSProperties}>
                <div className="chat-nested-work-folder-heading">
                  <span className="work-folder-identity-icon chat-other-work-folder-icon" aria-hidden="true"><WorkFolderIconGlyph icon={identity.Icon} size={13} /></span>
                  <span className="chat-nested-work-folder-name">{item.name}</span>
                  {status ? <ActivityDot status={status} /> : null}
                  <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                </div>
                {list.length ? renderChatList(item, list, "chat-work-folder-list-nested", null) : null}
              </div>
            );
          })}
        </section>
        {otherWorkFolderGroups.length ? (
          <section className="chat-other-work-folders" aria-label="Chats in other work-folders">
            {otherWorkFolderGroups.map(({ item, list, status }) => {
              const identity = workFolderIdentityFor(item, customizations);
              const expanded = Boolean(normalized) || expandedOtherWorkFolderIds.has(item.id);
              if (normalized && !list.length) return null;
              return (
                <div className={expanded ? "chat-other-work-folder expanded" : "chat-other-work-folder"} key={item.id} style={workFolderIdentityStyle(identity)}>
                  <div className="chat-other-work-folder-header">
                    <button
                      className="chat-other-work-folder-toggle"
                      type="button"
                      disabled={Boolean(normalized)}
                      aria-label={`${expanded ? "Hide" : "Show"} chats in ${item.name}`}
                      aria-expanded={expanded}
                      aria-controls={`chat-other-work-folder-${item.id}`}
                      onClick={() => toggle(setExpandedOtherWorkFolderIds, item.id)}
                    >
                      <span className="work-folder-identity-icon chat-other-work-folder-icon" aria-hidden="true"><WorkFolderIconGlyph icon={identity.Icon} size={14} /></span>
                      <span>{item.name}</span>
                      <ChevronRight16Regular aria-hidden="true" />
                      {status ? <ActivityDot status={status} /> : null}
                    </button>
                    <button className="ui-control ui-control--icon" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                  </div>
                  {expanded ? <div id={`chat-other-work-folder-${item.id}`}>{renderChatList(item, list, "chat-work-folder-list-other", "No Chats yet")}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        {!normalized && shelves.length ? (
          <section className="chat-shelves" aria-label="Snoozed and archived Chats">
            {shelves.map(({ view, entries }) => {
              const open = openShelves.has(view);
              return (
                <div className={open ? "chat-shelf open" : "chat-shelf"} key={view}>
                  <button
                    className="chat-shelf-toggle"
                    type="button"
                    aria-expanded={open}
                    aria-controls={`chat-shelf-${view}`}
                    onClick={() => toggle(setOpenShelves, view)}
                  >
                    <span>{view === "snoozed" ? "Snoozed" : "Archived"}</span>
                    <small>{entries.length}</small>
                    <ChevronRight16Regular aria-hidden="true" />
                  </button>
                  {open ? <div className="chat-work-folder-list chat-shelf-list" id={`chat-shelf-${view}`}>{renderChatRows(entries, true)}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <ChatContentSearch
          workFolders={orderedWorkFolders}
          conversations={conversations}
          query={query}
          now={now}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

interface HistoryRestorePreview {
  checkpointId: string;
  scope: "full" | "targeted";
  restoreFiles: string[];
  removePaths: string[];
  moves: Array<{ fromPath: string; toPath: string }>;
  excludedPaths: string[];
  uncoveredPaths: string[];
  conflicts: string[];
}

export function HistoryPane({ workFolder, fixtureItems, refreshRequest = 0, selectedCheckpointId, onOpen, onRestored, onError }: {
  workFolder: WorkFolderSummary;
  fixtureItems?: WorkFolderCheckpoint[];
  refreshRequest?: number;
  selectedCheckpointId?: string;
  onOpen?: (item: WorkFolderCheckpoint) => void;
  onRestored?: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<WorkFolderCheckpoint[]>(fixtureItems ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<HistoryRestorePreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [comparisonPath, setComparisonPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const inspectionQueue = useRef(Promise.resolve());
  useEffect(() => { setComparisonPath(""); setPathInput(""); }, [workFolder.id, selectedCheckpointId]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setPreviewError("");
    if (selectedCheckpointId && fixtureItems) setPreviewError("Restore previews are unavailable for demonstration data.");
    if (!fixtureItems) {
      // Both reads hold the host's History operation fence. Finish listing
      // before opening the preview instead of racing our own initial reads.
      const inspect = inspectionQueue.current.then(async () => {
        if (cancelled) return;
        const listed = await api<{ checkpoints: WorkFolderCheckpoint[] }>(`/api/work-folders/${workFolder.id}/history/checkpoints`);
        if (cancelled) return;
        setItems(listed.checkpoints);
        if (selectedCheckpointId) {
          const result = await api<{ preview: HistoryRestorePreview }>(`/api/work-folders/${workFolder.id}/history/checkpoints/${selectedCheckpointId}/preview`);
          if (!cancelled) setPreview(result.preview);
        }
      });
      // An obsolete read still drains before a newer effect starts, including
      // development Strict Mode replay and a rapidly changed restore point.
      inspectionQueue.current = inspect.catch(() => undefined);
      void inspect.catch((error) => {
        if (cancelled) return;
        if (selectedCheckpointId) setPreviewError(errorText(error));
        else onError(errorText(error));
      });
    }
    return () => { cancelled = true; };
  }, [workFolder.id, selectedCheckpointId, fixtureItems, refreshRequest, previewRevision]);

  useEffect(() => { setNotice(""); }, [workFolder.id, fixtureItems]);

  async function load() {
    try { setItems((await api<{ checkpoints: WorkFolderCheckpoint[] }>(`/api/work-folders/${workFolder.id}/history/checkpoints`)).checkpoints); }
    catch (caught) { onError(errorText(caught)); }
  }

  async function savePoint() {
    if (fixtureItems) return;
    setBusy(true);
    try {
      const result = await api<{ created: boolean }>(`/api/work-folders/${workFolder.id}/history/checkpoints`, { method: "POST", body: { label: "Manual Restore Point" } });
      setNotice(result.created ? "Restore point saved." : "Current files already match the latest restore point.");
      await load();
    }
    catch (caught) { setNotice(""); onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function restore(item: WorkFolderCheckpoint) {
    if (fixtureItems) return;
    if (selectedCheckpointId !== item.checkpointId && onOpen) { onOpen(item); return; }
    let reviewed: HistoryRestorePreview;
    try {
      reviewed = (await api<{ preview: HistoryRestorePreview }>(`/api/work-folders/${workFolder.id}/history/checkpoints/${item.checkpointId}/preview`)).preview;
      setPreview(reviewed);
    } catch (error) { setPreviewError(errorText(error)); return; }
    if (reviewed.conflicts.length) return;
    const confirmed = await requestConfirm({
      title: reviewed.scope === "targeted" ? "Undo these file changes?" : `Restore files in ${workFolder.name}?`,
      body: `${reviewed.restoreFiles.length} ${reviewed.restoreFiles.length === 1 ? "file" : "files"} restored, ${reviewed.removePaths.length} ${reviewed.removePaths.length === 1 ? "path" : "paths"} removed, and ${reviewed.moves.length} ${reviewed.moves.length === 1 ? "entry" : "entries"} moved. A safety restore point preserves the affected current content. Excluded content stays untouched.`,
      confirmLabel: reviewed.scope === "targeted" ? "Undo changes" : "Restore files", tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`/api/work-folders/${workFolder.id}/history/checkpoints/${item.checkpointId}/restore`, { method: "POST", body: {} });
      await load(); setPreviewRevision((value) => value + 1);
      setNotice("Restore complete. The previous files are preserved in a new safety restore point.");
      showToast({ text: "Files restored. Safety restore point saved in History.", tone: "success" });
      await onRestored?.();
    }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  if (selectedCheckpointId) {
    const selected = items.find((item) => item.checkpointId === selectedCheckpointId);
    return <div className="work-folder-pane-content history-pane professional-surface professional-history history-review">
      <h1>{selected?.label || "Review restore point"}</h1>
      {selected ? <p className="history-detail-meta">{formatDate(selected.createdAt)} · {selected.fileCount} captured {selected.fileCount === 1 ? "file" : "files"}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {previewError ? <p role="alert">{previewError}</p> : null}
      {!preview && !previewError ? <p role="status">Inspecting current files…</p> : null}
      {!fixtureItems ? <form className="history-file-picker" onSubmit={(event) => { event.preventDefault(); setComparisonPath(pathInput.trim()); }}>
        <label>Compare a file <input aria-label="File path to compare" placeholder="notes.txt" value={pathInput} onChange={(event) => setPathInput(event.target.value)} /></label>
        <button className="ui-control" type="submit" disabled={!pathInput.trim()}>Compare with current file</button>
      </form> : null}
      {comparisonPath && !fixtureItems ? <HistoryFileComparison workFolderId={workFolder.id} path={comparisonPath} fromCheckpointId={selectedCheckpointId} refreshRequest={refreshRequest + previewRevision} /> : null}
      {preview ? <>
        {preview.conflicts.map((conflict) => <p role="alert" key={conflict}>{conflict}</p>)}
        {([ ["Restore files", preview.restoreFiles], ["Remove paths", preview.removePaths],
          ["Move entries", preview.moves.map((move) => `${move.fromPath} → ${move.toPath}`)],
          ["Excluded from this restore point", preview.excludedPaths],
          ["Current content outside History coverage", preview.uncoveredPaths],
        ] as Array<[string, string[]]>).map(([title, paths]) => <section className={paths.length ? "history-restore-section" : "history-restore-section empty"} key={title}>
          <h2>{title} · {paths.length}</h2>
          {paths.length ? <ul>{paths.map((path) => <li key={path}><code>{path}</code>{(title === "Restore files" || title === "Remove paths") && !fixtureItems ? <button className="ui-control" type="button" onClick={() => { setPathInput(path); setComparisonPath(path); }}>Compare</button> : null}</li>)}</ul> : <p>None</p>}
        </section>)}
        <p className="history-coverage">A safety restore point preserves the current files before this change.{!preview.removePaths.length ? " No paths will be removed." : ""}{!preview.moves.length ? " No entries will be moved." : ""}{!preview.excludedPaths.length && !preview.uncoveredPaths.length ? " No content is excluded or outside History coverage." : ""}</p>
        <button className="ui-control ui-control--primary" type="button" disabled={busy || !selected || preview.conflicts.length > 0 || (preview.restoreFiles.length + preview.removePaths.length + preview.moves.length === 0)} onClick={() => selected && void restore(selected)}>
          {busy ? "Restoring…" : preview.scope === "targeted" ? "Undo these changes" : "Restore these files"}
        </button>
      </> : null}
    </div>;
  }

  return (
    <div className="work-folder-pane-content history-pane professional-surface professional-history">
      <div className="history-pane-actions">
        <div className="history-title"><h2>History</h2><span>{items.length} restore {items.length === 1 ? "point" : "points"}</span></div>
        {notice ? <p className="history-save-status" role="status"><Checkmark16Regular />{notice}</p> : null}
        <button className="ui-control ui-control--primary" type="button" onClick={() => void savePoint()} disabled={busy || Boolean(fixtureItems)}>
          {busy ? <ArrowSync16Regular className="spin" /> : <Clock16Regular />}Save restore point
        </button>
      </div>
      <div className="history-journal">
        {!items.length ? <EmptyState icon={<History20Regular />} title="No restore points yet" detail="Save a restore point to keep a version of this work-folder." /> : null}
        {historyDateGroups(items).map(({label,points}) => <section key={label} className="history-day"><h3>{label}</h3><div>{points.map(item => <button className={item.checkpointId===selectedCheckpointId ? "history-entry selected" : "history-entry"} aria-current={item.checkpointId===selectedCheckpointId ? "true" : undefined} type="button" key={item.checkpointId} disabled={!onOpen && (busy || Boolean(fixtureItems))} onClick={()=>onOpen ? onOpen(item) : void restore(item)} aria-label={`Review ${item.label || item.reason}`}>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</time>
          <span><strong>{item.label || item.reason}</strong><small>{item.fileCount} captured {item.fileCount === 1 ? 'file' : 'files'}</small></span>
          <ChevronRight16Regular aria-hidden="true"/>
        </button>)}</div></section>)}
      </div>
    </div>
  );
}

function historyDateGroups(items: WorkFolderCheckpoint[]): Array<{ label: string; points: WorkFolderCheckpoint[] }> {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const groups = new Map<string, { label: string; points: WorkFolderCheckpoint[] }>();
  for (const point of items) {
    const date = new Date(point.createdAt);
    const key = date.toDateString();
    const label = key === now.toDateString() ? "Today" : key === yesterday.toDateString() ? "Yesterday"
      : date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
    const group = groups.get(key) ?? { label, points: [] };
    group.points.push(point);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export { AiModelsPane, type ModelScope } from "./AiModelsPane";

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <div className="professional-empty-state">
      <span className="professional-empty-icon" aria-hidden="true">{icon}</span>
      <div><h2>{title}</h2>{detail ? <p>{detail}</p> : null}</div>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return <div className="professional-loading-row" role="status"><ArrowSync16Regular className="spin" />{label}</div>;
}

function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function findTreeEntry(entries: TreeEntry[], path: string): TreeEntry | null { for (const entry of entries) { if (entry.path === path) return entry; const child = entry.children ? findTreeEntry(entry.children, path) : null; if (child) return child; } return null; }
function filterTree(entries: TreeEntry[], query: string): TreeEntry[] { return entries.flatMap((entry) => { const children = entry.children ? filterTree(entry.children, query) : []; return entry.name.toLocaleLowerCase().includes(query) || children.length ? [{ ...entry, children }] : []; }); }
