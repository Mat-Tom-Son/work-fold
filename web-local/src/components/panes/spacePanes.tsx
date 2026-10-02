import { HistoryFileComparison } from "./HistoryFileComparison";
import { useSpaceIdentityResolver } from "../../lib/space-appearance-context";
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
import { spaceIdentityStyle } from "../../lib/space-identity";
import type {
  ChatActivityStatus,
  ChatLifecycleView,
  ConversationSummary,
  TreeEntry,
  SpaceCheckpoint,
  SpaceCustomizationMap,
  SpaceSummary,
} from "../../types";
import { SpaceIconGlyph } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { TextInputModal } from "../modals/TextInputModal";
import { requestConfirm, showToast } from "../../ui/feedback";
import { ChatContentSearch } from "./ChatContentSearch";

export function SpacesPane({
  space,
  spaces,
  identities,
  onCreate,
  onOpenFolder,
  onCustomize,
  onRemove,
  onDone,
}: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  identities: SpaceCustomizationMap;
  onCreate: () => void;
  onOpenFolder: () => void;
  onCustomize: (space: SpaceSummary) => void;
  onRemove?: (space: SpaceSummary) => void;
  onDone?: () => void;
}) {
  const spaceIdentityFor = useSpaceIdentityResolver();
  const paneRef = useRef<HTMLDivElement>(null);

  // Choosing Manage folders closes the menu that had focus; land focus here
  // so Escape and Tab start from this pane instead of the page body.
  useEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body) paneRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="space-pane-content spaces-pane professional-surface professional-spaces" ref={paneRef} tabIndex={-1}>
      <div className="professional-space-actions" aria-label="Add a work-folder">
        <button className="professional-space-action" type="button" onClick={onOpenFolder}>
          <span className="professional-space-action-icon" aria-hidden="true"><FolderOpen20Regular /></span>
          <strong>Existing Folder</strong>
        </button>
        <button className="professional-space-action" type="button" onClick={onCreate}>
          <span className="professional-space-action-icon" aria-hidden="true"><FolderAdd20Regular /></span>
          <strong>New Folder</strong>
        </button>
      </div>

      <section className="space-pane-section professional-section-card">
        <div className="professional-section-heading">
          <span>Your work-folders</span>
          <span className="spaces-pane-heading-end">
            <strong>{formatItemCount(spaces.length, "folder")}</strong>
            {onDone ? <button className="spaces-pane-done" type="button" onClick={onDone}>Done</button> : null}
          </span>
        </div>
        <div className="space-switcher">
          {spaces.map((item) => {
            const identity = spaceIdentityFor(item, identities);
            const active = item.id === space.id;
            const deletesFolder = item.location.storage === "managed";
            const location = item.location.storage === "managed" ? "" : shortFolderLocation(item.spaceRoot);
            const subtitle = item.location.providerHint === "google-drive" ? (location ? `Google Drive · ${location}` : "Google Drive") : location;
            return (
              <div className={active ? "space-card-shell active" : "space-card-shell"} key={item.id} style={spaceIdentityStyle(identity)}>
                <div className="space-card-row">
                  <button
                    className={active ? "space-tab space-card-main active" : "space-tab space-card-main"}
                    type="button"
                    onClick={() => onCustomize(item)}
                    aria-label={`Customize ${item.name}`}
                    title="Customize work-folder"
                  >
                    <span className="space-tab-icon space-identity-icon"><SpaceIconGlyph icon={identity.Icon} size={16} /></span>
                    <span className="space-tab-copy">
                      <strong>{item.name}</strong>
                      {subtitle ? <span title={item.spaceRoot || undefined}>{subtitle}</span> : null}
                    </span>
                    {active ? <span className="active-dot" aria-label="Active work-folder"><Checkmark12Regular /></span> : null}
                  </button>
                  <span className="space-card-actions">
                    {onRemove ? (
                      <button
                        className="space-card-delete"
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
  space,
  spaces,
  conversations,
  customizations,
  activeConversationId,
  onOpen,
  onNew,
  onActions,
  activityStatuses,
}: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  conversations: Record<string, ConversationSummary[]>;
  customizations: SpaceCustomizationMap;
  activeConversationId?: string | null;
  onOpen: (space: SpaceSummary, conversation: ConversationSummary) => void;
  onNew: (space: SpaceSummary) => void;
  onActions: (space: SpaceSummary, conversation: ConversationSummary, event: React.MouseEvent<HTMLElement>) => void;
  activityStatuses: Record<string, ChatActivityStatus>;
}) {
  const spaceIdentityFor = useSpaceIdentityResolver();
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [expandedOtherSpaceIds, setExpandedOtherSpaceIds] = useState<Set<string>>(() => new Set());
  // Snoozed and Archived are quiet rows at the bottom (2026-10-01), closed
  // until asked for, instead of a tab bar every visit has to read past.
  const [openShelves, setOpenShelves] = useState<Set<"snoozed" | "archived">>(() => new Set());
  const normalized = query.trim().toLocaleLowerCase();
  // The Folders inside this one belong to it here: their Chats sit right
  // under its own, indented the way the Folder switcher shows them.
  const nestedRows = useMemo(() => folderTreeRows(descendantFolders(space, spaces)), [space, spaces]);
  const nestedIds = new Set(nestedRows.map((row) => row.space.id));
  const orderedSpaces = [space, ...nestedRows.map((row) => row.space), ...spaces.filter((item) => item.id !== space.id && !nestedIds.has(item.id))];
  const allChats = orderedSpaces.flatMap((item) => (conversations[item.id] ?? []).map((chat) => ({ item, chat })));
  const shelfChats = (view: "snoozed" | "archived") => allChats.filter(({ chat }) => conversationLifecycleView(chat, now) === view);

  useEffect(() => {
    if (!allChats.some(({ chat }) => conversationLifecycleView(chat, now) === "snoozed")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [allChats.map(({ chat }) => chat.snoozedUntil ?? "").join("|"), now]);

  useEffect(() => {
    setExpandedOtherSpaceIds(new Set());
  }, [space.id]);

  const matchesQuery = (chat: ConversationSummary) => !normalized || chat.title.toLocaleLowerCase().includes(normalized);
  // While searching, every Chat is fair game, snoozed and archived included.
  function chatsFor(item: SpaceSummary): ConversationSummary[] {
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

  function chatSecondary(chat: ConversationSummary, item: SpaceSummary | null): string {
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

  function renderChatRows(entries: Array<{ item: SpaceSummary; chat: ConversationSummary }>, showFolder: boolean): ReactNode {
    return entries.map(({ item, chat }) => {
      const status = activityStatuses[chatActivityKey(item.id, chat.id)];
      const resurfaced = conversationLifecycleView(chat, now) === "active" && isRecentlyResurfaced(chat, now);
      return (
        <div
          className={[
            "chat-space-row-shell",
            chat.id === activeConversationId ? "active" : "",
            status ? `status-${status}` : "",
            resurfaced ? "resurfaced" : "",
          ].filter(Boolean).join(" ")}
          key={`${item.id}:${chat.id}`}
          onContextMenu={(event) => { event.preventDefault(); onActions(item, chat, event); }}
        >
          <button
            className="chat-space-row"
            type="button"
            aria-current={chat.id === activeConversationId ? "page" : undefined}
            onClick={() => onOpen(item, chat)}
          >
            <span className="chat-space-row-title">{chat.title}</span>
            <span className="chat-space-row-meta">
              {status ? <ActivityDot status={status} labeled /> : null}
              <span className="chat-space-row-time">{chatSecondary(chat, showFolder ? item : null)}</span>
            </span>
          </button>
          <button
            className="chat-space-row-actions"
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

  function renderChatList(item: SpaceSummary, list: ConversationSummary[], className: string, emptyText: string | null): ReactNode {
    return (
      <div className={`chat-space-list ${className}`}>
        {renderChatRows(list.map((chat) => ({ item, chat })), false)}
        {!list.length && emptyText ? <span className="chat-space-empty">{emptyText}</span> : null}
      </div>
    );
  }

  const currentList = chatsFor(space);
  const currentIdentity = spaceIdentityFor(space, customizations);
  const otherSpaceGroups = spaces
    .filter((item) => item.id !== space.id && !nestedIds.has(item.id))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => {
      const list = chatsFor(item);
      const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
      return { item, list, status };
    });
  const shelves = (["snoozed", "archived"] as const).map((view) => ({ view, entries: shelfChats(view) })).filter((shelf) => shelf.entries.length > 0);

  return (
    <div className="space-pane-content chats-pane professional-surface professional-chats">
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
      <div className="chat-space-groups">
        <section className="chat-space-group chat-space-group-current" style={spaceIdentityStyle(currentIdentity)}>
          <div className="chat-space-heading">
            <span className="space-identity-icon" aria-hidden="true"><SpaceIconGlyph icon={currentIdentity.Icon} size={15} /></span>
            <strong>{space.name}</strong>
            <button className="minimal-icon-button" type="button" onClick={() => onNew(space)} aria-label={`New Chat in ${space.name}`} title="New Chat"><Chat16Regular /></button>
          </div>
          {renderChatList(space, currentList, "chat-space-list-current", normalized ? null : nestedRows.length ? null : "No Chats yet")}
          {nestedRows.map(({ space: item, depth }) => {
            const identity = spaceIdentityFor(item, customizations);
            const list = chatsFor(item);
            if (normalized && !list.length) return null;
            const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
            return (
              <div className="chat-nested-space" key={item.id} style={{ ...spaceIdentityStyle(identity), "--folder-depth": depth + 1 } as CSSProperties}>
                <div className="chat-nested-space-heading">
                  <span className="space-identity-icon chat-other-space-icon" aria-hidden="true"><SpaceIconGlyph icon={identity.Icon} size={13} /></span>
                  <span className="chat-nested-space-name">{item.name}</span>
                  {status ? <ActivityDot status={status} /> : null}
                  <button className="minimal-icon-button" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                </div>
                {list.length ? renderChatList(item, list, "chat-space-list-nested", null) : null}
              </div>
            );
          })}
        </section>
        {otherSpaceGroups.length ? (
          <section className="chat-other-spaces" aria-label="Chats in other work-folders">
            <div className="chat-other-spaces-heading">
              <span>Other work-folders</span>
              <small>{otherSpaceGroups.length}</small>
            </div>
            {otherSpaceGroups.map(({ item, list, status }) => {
              const identity = spaceIdentityFor(item, customizations);
              const expanded = Boolean(normalized) || expandedOtherSpaceIds.has(item.id);
              if (normalized && !list.length) return null;
              return (
                <div className={expanded ? "chat-other-space expanded" : "chat-other-space"} key={item.id} style={spaceIdentityStyle(identity)}>
                  <div className="chat-other-space-header">
                    <button
                      className="chat-other-space-toggle"
                      type="button"
                      disabled={Boolean(normalized)}
                      aria-label={`${expanded ? "Hide" : "Show"} chats in ${item.name}`}
                      aria-expanded={expanded}
                      aria-controls={`chat-other-space-${item.id}`}
                      onClick={() => toggle(setExpandedOtherSpaceIds, item.id)}
                    >
                      <span className="space-identity-icon chat-other-space-icon" aria-hidden="true"><SpaceIconGlyph icon={identity.Icon} size={14} /></span>
                      <span>{item.name}</span>
                      {status ? <ActivityDot status={status} /> : null}
                      <small>{list.length}</small>
                      <ChevronRight16Regular aria-hidden="true" />
                    </button>
                    <button className="minimal-icon-button" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                  </div>
                  {expanded ? <div id={`chat-other-space-${item.id}`}>{renderChatList(item, list, "chat-space-list-other", "No Chats yet")}</div> : null}
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
                  {open ? <div className="chat-space-list chat-shelf-list" id={`chat-shelf-${view}`}>{renderChatRows(entries, true)}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <ChatContentSearch
          spaces={orderedSpaces}
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

export function HistoryPane({ space, fixtureItems, refreshRequest = 0, selectedCheckpointId, onOpen, onRestored, onError }: {
  space: SpaceSummary;
  fixtureItems?: SpaceCheckpoint[];
  refreshRequest?: number;
  selectedCheckpointId?: string;
  onOpen?: (item: SpaceCheckpoint) => void;
  onRestored?: () => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<SpaceCheckpoint[]>(fixtureItems ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<HistoryRestorePreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewError, setPreviewError] = useState("");
  const [comparisonPath, setComparisonPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  useEffect(() => { setComparisonPath(""); setPathInput(""); }, [space.id, selectedCheckpointId]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setPreviewError("");
    if (selectedCheckpointId && fixtureItems) setPreviewError("Restore previews are unavailable for demonstration data.");
    if (selectedCheckpointId && !fixtureItems) {
      api<{ preview: HistoryRestorePreview }>(`/api/spaces/${space.id}/history/checkpoints/${selectedCheckpointId}/preview`)
        .then((result) => { if (!cancelled) setPreview(result.preview); })
        .catch((error) => { if (!cancelled) setPreviewError(errorText(error)); });
    }
    return () => { cancelled = true; };
  }, [space.id, selectedCheckpointId, fixtureItems, refreshRequest, previewRevision]);

  useEffect(() => { setNotice(""); if (!fixtureItems) void load(); }, [space.id, fixtureItems]);
  useEffect(() => { if (!fixtureItems && refreshRequest > 0) void load(); }, [refreshRequest]);

  async function load() {
    try { setItems((await api<{ checkpoints: SpaceCheckpoint[] }>(`/api/spaces/${space.id}/history/checkpoints`)).checkpoints); }
    catch (caught) { onError(errorText(caught)); }
  }

  async function savePoint() {
    if (fixtureItems) return;
    setBusy(true);
    try {
      const result = await api<{ created: boolean }>(`/api/spaces/${space.id}/history/checkpoints`, { method: "POST", body: { label: "Manual Restore Point" } });
      setNotice(result.created ? "Restore point saved." : "Current files already match the latest restore point.");
      await load();
    }
    catch (caught) { setNotice(""); onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function restore(item: SpaceCheckpoint) {
    if (fixtureItems) return;
    if (selectedCheckpointId !== item.checkpointId && onOpen) { onOpen(item); return; }
    let reviewed: HistoryRestorePreview;
    try {
      reviewed = (await api<{ preview: HistoryRestorePreview }>(`/api/spaces/${space.id}/history/checkpoints/${item.checkpointId}/preview`)).preview;
      setPreview(reviewed);
    } catch (error) { setPreviewError(errorText(error)); return; }
    if (reviewed.conflicts.length) return;
    const confirmed = await requestConfirm({
      title: reviewed.scope === "targeted" ? "Undo these file changes?" : `Restore files in ${space.name}?`,
      body: `${reviewed.restoreFiles.length} ${reviewed.restoreFiles.length === 1 ? "file" : "files"} restored, ${reviewed.removePaths.length} ${reviewed.removePaths.length === 1 ? "path" : "paths"} removed, and ${reviewed.moves.length} ${reviewed.moves.length === 1 ? "entry" : "entries"} moved. A safety restore point preserves the affected current content. Excluded content stays untouched.`,
      confirmLabel: reviewed.scope === "targeted" ? "Undo changes" : "Restore files", tone: "danger",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`/api/spaces/${space.id}/history/checkpoints/${item.checkpointId}/restore`, { method: "POST", body: {} });
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
    return <div className="space-pane-content history-pane professional-surface professional-history">
      <h1>{selected?.label || "Review restore point"}</h1>
      {notice ? <p role="status">{notice}</p> : null}
      {previewError ? <p role="alert">{previewError}</p> : null}
      {!preview && !previewError ? <p role="status">Inspecting current files…</p> : null}
      {!fixtureItems ? <form className="history-file-picker" onSubmit={(event) => { event.preventDefault(); setComparisonPath(pathInput.trim()); }}>
        <label>Compare a file <input aria-label="File path to compare" placeholder="notes.txt" value={pathInput} onChange={(event) => setPathInput(event.target.value)} /></label>
        <button className="professional-button professional-button-secondary" type="submit" disabled={!pathInput.trim()}>Compare with current file</button>
      </form> : null}
      {comparisonPath && !fixtureItems ? <HistoryFileComparison spaceId={space.id} path={comparisonPath} fromCheckpointId={selectedCheckpointId} refreshRequest={refreshRequest + previewRevision} /> : null}
      {preview ? <>
        {preview.conflicts.map((conflict) => <p role="alert" key={conflict}>{conflict}</p>)}
        {([ ["Restore files", preview.restoreFiles], ["Remove paths", preview.removePaths],
          ["Move entries", preview.moves.map((move) => `${move.fromPath} → ${move.toPath}`)],
          ["Excluded from this restore point", preview.excludedPaths],
          ["Current content outside History coverage", preview.uncoveredPaths],
        ] as Array<[string, string[]]>).map(([title, paths]) => <section key={title}>
          <h2>{title} · {paths.length}</h2>
          {paths.length ? <ul>{paths.map((path) => <li key={path}><code>{path}</code>{(title === "Restore files" || title === "Remove paths") && !fixtureItems ? <button className="professional-button professional-button-secondary" type="button" onClick={() => { setPathInput(path); setComparisonPath(path); }}>Compare</button> : null}</li>)}</ul> : <p>None</p>}
        </section>)}
        <button className="professional-button professional-button-primary" type="button" disabled={busy || !selected || preview.conflicts.length > 0 || (preview.restoreFiles.length + preview.removePaths.length + preview.moves.length === 0)} onClick={() => selected && void restore(selected)}>
          {busy ? "Restoring…" : preview.scope === "targeted" ? "Undo these changes" : "Restore these files"}
        </button>
      </> : null}
    </div>;
  }

  return (
    <div className="space-pane-content history-pane professional-surface professional-history">
      <div className="history-pane-actions">
        {notice ? <p className="history-save-status" role="status"><Checkmark16Regular />{notice}</p> : null}
        <button className="professional-button professional-button-primary" type="button" onClick={() => void savePoint()} disabled={busy || Boolean(fixtureItems)}>
          {busy ? <ArrowSync16Regular className="spin" /> : <Clock16Regular />}Save restore point
        </button>
      </div>
      <div className="history-list professional-history-list">
        {items.map((item) => (
          <article className={item.checkpointId === selectedCheckpointId ? "professional-history-card selected" : "professional-history-card"} key={item.checkpointId} aria-current={item.checkpointId === selectedCheckpointId ? "true" : undefined}>
            <span className="professional-icon-tile" aria-hidden="true"><History16Regular /></span>
            <div className="professional-history-copy"><strong>{item.label || item.reason}</strong><span>{formatDate(item.createdAt)} · {item.fileCount} captured {item.fileCount === 1 ? "file" : "files"}</span></div>
            <div className="professional-history-actions">
              {onOpen ? <button className="professional-button professional-button-secondary" type="button" onClick={() => onOpen(item)}>Open</button> : null}
              <button className="professional-button professional-button-secondary" type="button" disabled={busy || Boolean(fixtureItems)} onClick={() => void restore(item)}>Review restore</button>
            </div>
          </article>
        ))}
        {!items.length ? <EmptyState icon={<History20Regular />} title="No restore points yet" detail="work-fold creates restore points before important file changes. You can make one manually too." /> : null}
      </div>
    </div>
  );
}

export { AssistantSetupPane, type AssistantModelScope } from "./AssistantSetupPane";

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
