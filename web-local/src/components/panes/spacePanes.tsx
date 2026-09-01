import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
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
  Color16Regular,
  Copy16Regular,
  Delete16Regular,
  Dismiss16Regular,
  Edit16Regular,
  Folder16Regular,
  Folder20Regular,
  FolderAdd16Regular,
  FolderAdd20Regular,
  FolderOpen20Regular,
  History16Regular,
  History20Regular,
  Library20Regular,
  ShieldCheckmark16Regular,
  MoreHorizontal16Regular,
} from "@fluentui/react-icons";
import { api, apiForm, errorText } from "../../lib/api";
import { resolveAssistantModelSelection } from "../../lib/assistant-model-selection";
import { aggregateChatActivityStatus, chatActivityKey, chatSnoozeTimeLabel, conversationLifecycleView, isRecentlyResurfaced } from "../../lib/chat-lifecycle";
import { formatChatListTime, formatItemCount } from "../../lib/format";
import { spaceIdentityFor, spaceIdentityStyle } from "../../lib/space-identity";
import type {
  AgentModel,
  AgentModelCatalog,
  AgentStatus,
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
import { requestConfirm } from "../../ui/feedback";
import { SpaceRenameEditor } from "./spaceChrome";
import { ChatContentSearch } from "./ChatContentSearch";

export function SpacesPane({
  space,
  spaces,
  identities,
  onSwitch,
  onCreate,
  onOpenFolder,
  onCustomize,
  onRename,
  onRemove,
}: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  identities: SpaceCustomizationMap;
  onSwitch: (space: SpaceSummary) => void;
  onCreate: () => void;
  onOpenFolder: () => void;
  onCustomize: (space: SpaceSummary) => void;
  onRename: (space: SpaceSummary, name: string) => Promise<void>;
  onRemove?: (space: SpaceSummary) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div className="space-pane-content spaces-pane professional-surface professional-spaces">
      <section className="professional-space-intro">
        <span className="professional-kicker">Spaces</span>
        <h1>Where does this work live?</h1>
        <p>Use an existing folder or create a clean one. Either way, it remains an ordinary folder you control.</p>
        <div className="professional-space-actions">
          <button className="professional-space-action" type="button" onClick={onOpenFolder}>
            <span className="professional-space-action-icon" aria-hidden="true"><FolderOpen20Regular /></span>
            <span className="professional-space-action-copy"><strong>Existing folder</strong><small>Turn it into a Space</small></span>
          </button>
          <button className="professional-space-action" type="button" onClick={onCreate}>
            <span className="professional-space-action-icon" aria-hidden="true"><FolderAdd20Regular /></span>
            <span className="professional-space-action-copy"><strong>New Space</strong><small>Start with a clean folder</small></span>
          </button>
        </div>
      </section>

      <section className="space-pane-section professional-section-card">
        <div className="professional-section-heading">
          <span>Your Spaces</span>
          <strong>{formatItemCount(spaces.length, "Space")}</strong>
        </div>
        <div className="space-switcher">
          {spaces.map((item) => {
            const identity = spaceIdentityFor(item, identities);
            const active = item.id === space.id;
            return (
              <div className={active ? "space-card-shell active" : "space-card-shell"} key={item.id} style={spaceIdentityStyle(identity)}>
                <div className="space-card-row">
                  <button className={active ? "space-tab space-card-main active" : "space-tab space-card-main"} type="button" onClick={() => onSwitch(item)}>
                    <span className="space-tab-icon space-identity-icon"><SpaceIconGlyph icon={identity.Icon} size={16} /></span>
                    <span className="space-tab-copy">
                      <strong>{item.name}</strong>
                      <span>{item.location.providerHint === "google-drive" ? "Google Drive" : item.location.storage === "linked" ? "Linked folder" : "Managed folder"}</span>
                    </span>
                    {active ? <span className="active-dot" aria-label="Active Space"><Checkmark12Regular /></span> : null}
                  </button>
                  <span className="space-card-actions">
                    <button className="space-card-rename" type="button" onClick={() => setRenamingId((current) => current === item.id ? null : item.id)} aria-label={`Rename ${item.name}`} title="Rename Space"><Edit16Regular /></button>
                    <button className="space-card-customize" type="button" onClick={() => onCustomize(item)} aria-label={`Customize ${item.name}`} title="Customize Space"><Color16Regular /></button>
                    {onRemove ? <button className="space-card-delete" type="button" onClick={() => onRemove(item)} aria-label={`Remove ${item.name}`} title="Remove Space"><Delete16Regular /></button> : null}
                  </span>
                </div>
                <SpaceRenameEditor open={renamingId === item.id} space={item} onRenameSpace={onRename} onClose={() => setRenamingId(null)} />
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
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ChatLifecycleView>("active");
  const [now, setNow] = useState(() => Date.now());
  const [expandedOtherSpaceIds, setExpandedOtherSpaceIds] = useState<Set<string>>(() => new Set());
  const normalized = query.trim().toLocaleLowerCase();
  const orderedSpaces = [space, ...spaces.filter((item) => item.id !== space.id)];
  const allConversations = Object.values(conversations).flat();
  const counts = {
    active: allConversations.filter((chat) => conversationLifecycleView(chat, now) === "active").length,
    snoozed: allConversations.filter((chat) => conversationLifecycleView(chat, now) === "snoozed").length,
    archived: allConversations.filter((chat) => conversationLifecycleView(chat, now) === "archived").length,
  };

  useEffect(() => {
    if (!allConversations.some((chat) => conversationLifecycleView(chat, now) === "snoozed")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [allConversations.map((chat) => chat.snoozedUntil ?? "").join("|"), now]);

  useEffect(() => {
    setExpandedOtherSpaceIds(new Set());
  }, [space.id]);

  function chatsFor(item: SpaceSummary): ConversationSummary[] {
    return (conversations[item.id] ?? []).filter((chat) =>
      conversationLifecycleView(chat, now) === view
      && (!normalized || chat.title.toLocaleLowerCase().includes(normalized)));
  }

  function toggleOtherSpace(spaceId: string): void {
    setExpandedOtherSpaceIds((current) => {
      const next = new Set(current);
      if (next.has(spaceId)) next.delete(spaceId);
      else next.add(spaceId);
      return next;
    });
  }

  function renderChatList(item: SpaceSummary, list: ConversationSummary[], current: boolean): ReactNode {
    return (
      <div className={current ? "chat-space-list chat-space-list-current" : "chat-space-list chat-space-list-other"}>
        {list.map((chat) => {
          const status = activityStatuses[chatActivityKey(item.id, chat.id)];
          const resurfaced = view === "active" && isRecentlyResurfaced(chat, now);
          const secondary = view === "snoozed" && chat.snoozedUntil
            ? chatSnoozeTimeLabel(chat.snoozedUntil)
            : view === "archived" && chat.archivedAt
              ? `Archived ${formatChatListTime(chat.archivedAt)}`
              : resurfaced
                ? "Back now"
                : formatChatListTime(chat.updatedAt);
          return (
            <div
              className={[
                "chat-space-row-shell",
                chat.id === activeConversationId ? "active" : "",
                status ? `status-${status}` : "",
                resurfaced ? "resurfaced" : "",
              ].filter(Boolean).join(" ")}
              key={chat.id}
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
                  {status ? <ChatActivityIndicator status={status} labeled /> : null}
                  <span className="chat-space-row-time">{secondary}</span>
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
        })}
        {!list.length ? (
          <span className="chat-space-empty">
            {normalized ? `No ${view} Chat titles match` : chatViewEmptyLabel(view)}
          </span>
        ) : null}
      </div>
    );
  }

  const currentList = chatsFor(space);
  const currentIdentity = spaceIdentityFor(space, customizations);
  const otherSpaceGroups = spaces
    .filter((item) => item.id !== space.id)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((item) => {
      const list = chatsFor(item);
      const status = aggregateChatActivityStatus(item.id, conversations[item.id] ?? [], activityStatuses);
      return { item, list, status };
    });

  return (
    <div className="space-pane-content chats-pane professional-surface professional-chats">
      <div className="file-tree-toolbar professional-pane-toolbar">
        <label className="file-tree-search">
          <Chat16Regular />
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
      <div
        className="chat-lifecycle-tabs"
        role="tablist"
        aria-label="Chat view"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const views: ChatLifecycleView[] = ["active", "snoozed", "archived"];
          const currentIndex = views.indexOf(view);
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
              ? views.length - 1
              : event.key === "ArrowRight"
                ? (currentIndex + 1) % views.length
                : (currentIndex - 1 + views.length) % views.length;
          const tablist = event.currentTarget;
          event.preventDefault();
          setView(views[nextIndex]!);
          window.requestAnimationFrame(() => {
            tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
          });
        }}
      >
        {(["active", "snoozed", "archived"] as ChatLifecycleView[]).map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === item}
            tabIndex={view === item ? 0 : -1}
            className={view === item ? "active" : ""}
            key={item}
            onClick={() => setView(item)}
          >
            <span>{item[0]!.toUpperCase() + item.slice(1)}</span>
            <small>{counts[item]}</small>
          </button>
        ))}
      </div>
      <div className="chat-space-groups">
        <section className="chat-space-group chat-space-group-current" style={spaceIdentityStyle(currentIdentity)}>
          <div className="chat-space-heading">
            <span className="space-identity-icon" aria-hidden="true"><SpaceIconGlyph icon={currentIdentity.Icon} size={15} /></span>
            <strong>{space.name}</strong>
            <button className="minimal-icon-button" type="button" onClick={() => onNew(space)} aria-label={`New Chat in ${space.name}`} title="New Chat"><Chat16Regular /></button>
          </div>
          {renderChatList(space, currentList, true)}
        </section>
        {otherSpaceGroups.length ? (
          <section className="chat-other-spaces" aria-label="Chats in other Spaces">
            <div className="chat-other-spaces-heading">
              <span>Other Spaces</span>
              <small>{otherSpaceGroups.length}</small>
            </div>
            {otherSpaceGroups.map(({ item, list, status }) => {
              const identity = spaceIdentityFor(item, customizations);
              const expanded = Boolean(normalized) || expandedOtherSpaceIds.has(item.id);
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
                      onClick={() => toggleOtherSpace(item.id)}
                    >
                      <span className="space-identity-icon chat-other-space-icon" aria-hidden="true"><SpaceIconGlyph icon={identity.Icon} size={14} /></span>
                      <span>{item.name}</span>
                      {status ? <ChatActivityIndicator status={status} /> : null}
                      <small>{list.length}</small>
                      <ChevronRight16Regular aria-hidden="true" />
                    </button>
                    <button className="minimal-icon-button" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
                  </div>
                  {expanded ? <div id={`chat-other-space-${item.id}`}>{renderChatList(item, list, false)}</div> : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <ChatContentSearch
          spaces={orderedSpaces}
          conversations={conversations}
          query={query}
          view={view}
          now={now}
          onOpen={onOpen}
        />
      </div>
    </div>
  );
}

function ChatActivityIndicator({ status, labeled = false }: { status: ChatActivityStatus; labeled?: boolean }) {
  const label = status === "running" ? "Working" : "New reply";
  return (
    <span className={`chat-activity-indicator ${status}${labeled ? " labeled" : ""}`} role="status">
      <span className="chat-activity-dot" aria-hidden="true" />
      <span className={labeled ? "chat-activity-label" : "sr-only"}>{label}</span>
    </span>
  );
}

function chatViewEmptyLabel(view: ChatLifecycleView): string {
  if (view === "snoozed") return "No snoozed Chats";
  if (view === "archived") return "No archived Chats";
  return "No active Chats yet";
}

export function LibraryPane({
  space,
  spaces,
  tree,
  fixtureMode,
  destinationResetRequest,
  onRefresh,
  onError,
}: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  tree: TreeEntry[];
  fixtureMode: boolean;
  destinationResetRequest: number;
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [destinationSpaceId, setDestinationSpaceId] = useState(space.id);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const selectedEntry = selected ? findTreeEntry(tree, selected) : null;
  const destinationSpace = spaces.find((item) => item.id === destinationSpaceId) ?? space;

  useEffect(() => {
    setDestinationSpaceId(space.id);
    setNotice("");
  }, [destinationResetRequest, space.id]);
  useEffect(() => {
    if (spaces.some((item) => item.id === destinationSpaceId)) return;
    setDestinationSpaceId(space.id);
    setNotice("");
  }, [destinationSpaceId, space.id, spaces]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || fixtureMode) return;
    const form = new FormData();
    form.set("targetFolderPath", "");
    form.set("relativePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
    files.forEach((file) => form.append("files", file, file.name));
    setBusy(true);
    try { await apiForm("/api/resources/upload", form); await onRefresh(); }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function createFolder(name: string) {
    if (fixtureMode) return;
    setBusy(true);
    try {
      await api("/api/resources/folders", { method: "POST", body: { parentPath: "", name } });
      await onRefresh();
    } finally { setBusy(false); }
  }

  async function copyToSpace() {
    if (!selected) return;
    if (fixtureMode) { setNotice(`Preview: ${selectedEntry?.name ?? "item"} would be copied to ${destinationSpace.name}.`); return; }
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ copied: string[] }>("/api/resources/copy-to-space", { method: "POST", body: { spaceId: destinationSpace.id, paths: [selected], targetFolder: "From Library" } });
      setNotice(`Added ${result.copied[0] ?? selectedEntry?.name ?? "item"} to ${destinationSpace.name}.`);
    } catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = normalizedQuery ? filterTree(tree, normalizedQuery) : tree;
  const libraryEmpty = tree.length === 0;
  const noMatches = !libraryEmpty && visible.length === 0;

  return (
    <div className="space-pane-content library-pane professional-surface professional-library">
      <header className="library-tab-header">
        <div>
          <span className="professional-kicker">Personal · available across Spaces</span>
          <h1>Library</h1>
          <p>Keep reusable files here once, then choose any registered Space when you need a copy.</p>
        </div>
        <div className="library-tab-actions">
          <button className="professional-button professional-button-primary" type="button" disabled={busy || fixtureMode} onClick={() => uploadRef.current?.click()}><ArrowUpload16Regular />Add files to Library</button>
          <button className="professional-button professional-button-secondary" type="button" disabled={busy || fixtureMode} onClick={() => setFolderDialogOpen(true)}><FolderAdd16Regular />New Library folder</button>
        </div>
      </header>
      <div className="file-tree-toolbar professional-library-toolbar">
        <label className="file-tree-search">
          <Library20Regular />
          <input type="search" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" aria-label="Search Library" />
        </label>
        <input hidden ref={uploadRef} type="file" multiple onChange={(event) => void upload(event)} />
      </div>

      {libraryEmpty || noMatches ? (
        <div className="professional-library-empty">
          <EmptyState
            icon={<Library20Regular />}
            title={noMatches ? "No Library items match" : "Your reusable Library"}
            detail={noMatches ? "Try a different search." : "Keep templates, examples, and reference files here so they can be copied into any Space."}
          />
        </div>
      ) : (
        <div className="library-split professional-library-split">
          <div className="library-tree"><LibraryTree entries={visible} selected={selected} onSelect={setSelected} disabled={busy} /></div>
          <div className="library-detail">
            {selectedEntry ? (
              <div className="professional-resource-selection">
                <div className="professional-resource-heading">
                  <span className="professional-icon-tile" aria-hidden="true">{selectedEntry.kind === "folder" ? <Folder20Regular /> : <FileTypeIcon path={selectedEntry.path} />}</span>
                  <div><span className="professional-kicker">Library item</span><h2>{selectedEntry.name}</h2></div>
                </div>
                <code className="professional-resource-path">{selectedEntry.path}</code>
                <p>work-fold makes an independent copy under <strong>From Library</strong>. It is not automatically included in a Chat.</p>
                <label className="professional-field library-destination-field">
                  <span className="professional-field-label">Add a copy to</span>
                  <select value={destinationSpace.id} disabled={busy} onChange={(event) => { setDestinationSpaceId(event.target.value); setNotice(""); }}>
                    {spaces.map((item) => <option value={item.id} key={item.id}>{libraryDestinationLabel(item, spaces)}</option>)}
                  </select>
                  <span className="professional-field-hint">Your Library stays unchanged; only the new copy belongs to the selected Space.</span>
                </label>
                <div className="professional-actions">
                  <button className="professional-button professional-button-primary" type="button" disabled={busy} onClick={() => void copyToSpace()}>
                    {busy ? <ArrowSync16Regular className="spin" /> : <Copy16Regular />}Add to {destinationSpace.name}
                  </button>
                </div>
                {notice ? <p className="professional-status" role="status"><Checkmark16Regular />{notice}</p> : null}
              </div>
            ) : (
              <EmptyState icon={<Library20Regular />} title="Choose a Library item" detail="Select a file or folder to see where it lives and add a copy to any registered Space." />
            )}
          </div>
        </div>
      )}
      {folderDialogOpen ? <TextInputModal title="New Library folder" description="Create a folder at the top level of your Library." label="Folder name" confirmLabel="Create folder" onSubmit={createFolder} onClose={() => setFolderDialogOpen(false)} /> : null}
    </div>
  );
}

export function HistoryPane({ space, fixtureItems, refreshRequest = 0, selectedCheckpointId, onOpen, onError }: {
  space: SpaceSummary;
  fixtureItems?: SpaceCheckpoint[];
  refreshRequest?: number;
  selectedCheckpointId?: string;
  onOpen?: (item: SpaceCheckpoint) => void;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<SpaceCheckpoint[]>(fixtureItems ?? []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

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
      const result = await api<{ created: boolean }>(`/api/spaces/${space.id}/history/checkpoints`, { method: "POST", body: { label: "Manual restore point" } });
      setNotice(result.created ? "Restore point saved." : "Current files already match the latest restore point.");
      await load();
    }
    catch (caught) { setNotice(""); onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function restore(item: SpaceCheckpoint) {
    if (fixtureItems) return;
    const confirmed = await requestConfirm({ title: `Restore ${space.name}?`, body: `Return the Space to ${formatDate(item.createdAt)}. Current files will be replaced by that restore point.`, confirmLabel: "Restore", tone: "danger" });
    if (!confirmed) return;
    setBusy(true);
    try { await api(`/api/spaces/${space.id}/history/checkpoints/${item.checkpointId}/restore`, { method: "POST", body: {} }); await load(); }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
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
            <div className="professional-history-copy"><strong>{item.label || item.reason}</strong><span>{formatDate(item.createdAt)} · {item.fileCount} {item.fileCount === 1 ? "file" : "files"}</span></div>
            <div className="professional-history-actions">
              {onOpen ? <button className="professional-button professional-button-secondary" type="button" onClick={() => onOpen(item)}>Open</button> : null}
              <button className="professional-button professional-button-secondary" type="button" disabled={busy || Boolean(fixtureItems)} onClick={() => void restore(item)}>Restore</button>
            </div>
          </article>
        ))}
        {!items.length ? <EmptyState icon={<History20Regular />} title="No restore points yet" detail="work-fold creates restore points before important file changes. You can make one manually too." /> : null}
      </div>
    </div>
  );
}

export type AssistantModelScope = "space" | "management";

export function AssistantSetupPane({ space, status, fixtureMode = false, embedded = false, initialScope, focusModelOnOpen = false, onConfigured, onAssistantChanged }: { space: SpaceSummary | null; status: AgentStatus; fixtureMode?: boolean; embedded?: boolean; initialScope?: AssistantModelScope; focusModelOnOpen?: boolean; onConfigured: (status: AgentStatus) => void; onAssistantChanged?: (scope: AssistantModelScope, status: AgentStatus) => void }) {
  const resolvedInitialScope = initialScope === "management" || (initialScope === "space" && space)
    ? initialScope
    : space ? "space" : "management";
  const [scope, setScope] = useState<AssistantModelScope>(resolvedInitialScope);
  const [scopeStatus, setScopeStatus] = useState<AgentStatus>(status);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [catalogs, setCatalogs] = useState<AgentModelCatalog[]>([]);
  const [provider, setProvider] = useState(status.provider ?? "openrouter");
  const [model, setModel] = useState(status.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [instructionsNotice, setInstructionsNotice] = useState<string | null>(null);

  useEffect(() => {
    setScope(initialScope === "management" || (initialScope === "space" && space)
      ? initialScope
      : space ? "space" : "management");
  }, [initialScope, space?.id]);

  useEffect(() => {
    if (fixtureMode) {
      setModels([{ provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet", authConfigured: true, oauthSupported: false }]);
      setCatalogs([{ provider: "openrouter", refreshable: true, source: "live", refreshedAt: new Date().toISOString(), modelCount: 1 }]);
      setProvider("openrouter");
      setModel("anthropic/claude-sonnet-4");
      setScopeStatus({ ...status, configured: true, provider: "openrouter", model: "anthropic/claude-sonnet-4" });
      setInstructions(scope === "space" ? "Keep answers concise and test changes in this Space." : "");
      setSavedInstructions(scope === "space" ? "Keep answers concise and test changes in this Space." : "");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    setInstructionsNotice(null);
    const params = assistantScopeParams(scope, space);
    void api<{ models: AgentModel[]; status: AgentStatus; catalogs: AgentModelCatalog[]; instructions: string | null }>(`/api/agent/models?${params}`)
      .then((result) => {
        setModels(result.models);
        setCatalogs(result.catalogs);
        setScopeStatus(result.status);
        setInstructions(result.instructions ?? "");
        setSavedInstructions(result.instructions ?? "");
        const first = result.models.find((item) => item.provider === result.status.provider)
          ?? result.models.find((item) => item.provider === "openrouter")
          ?? result.models[0];
        if (first) {
          setProvider(first.provider);
          setModel(resolveAssistantModelSelection(result.models, first.provider, result.status.model || ""));
        }
      })
      .catch((caught) => setError(errorText(caught)))
      .finally(() => setLoading(false));
  }, [fixtureMode, scope, space?.id]);

  const providers = unique(models.map((item) => item.provider)).sort((left, right) =>
    providerDisplayName(models, left).localeCompare(providerDisplayName(models, right)));
  const providerModels = models.filter((item) => item.provider === provider);
  const oauthSupported = providerModels.some((item) => item.oauthSupported);
  const accountOnly = providerAccountOnly(provider);
  const authConfigured = providerModels.some((item) => item.authConfigured);
  const providerAuth = providerModels.find((item) => item.authConfigured);
  const removableAuth = providerAuth?.authSource === "stored";
  const removeCredentialLabel = providerAuth?.authType === "oauth" ? "Disconnect account" : "Remove API key";
  const credentialStatus = assistantCredentialStatus(providerAuth);
  const setupChanged = !scopeStatus.configured || provider !== scopeStatus.provider || model !== scopeStatus.model || Boolean(apiKey.trim());
  const subscriptionNote = oauthSupported ? providerSubscriptionNote(provider) : null;
  const catalog = catalogs.find((item) => item.provider === provider);
  const scopeLabel = scope === "management" ? "The fold" : space?.name ?? "This Space";

  useEffect(() => {
    if (!models.length) return;
    setModel((current) => resolveAssistantModelSelection(models, provider, current));
  }, [models, provider]);

  async function configure(oauth = false) {
    if (fixtureMode) {
      const next = { ...scopeStatus, configured: true, provider, model };
      setScopeStatus(next);
      if (scope === "space") onConfigured(next);
      onAssistantChanged?.(scope, next);
      setNotice(oauth ? "Account connected" : "Setup saved");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const submittedApiKey = apiKey.trim();
      const result = await api<{ status: AgentStatus }>(oauth ? "/api/agent/oauth" : "/api/agent/configure", {
        method: "POST",
        body: { ...assistantScopeBody(scope, space), provider, model, ...(oauth ? {} : { apiKey: submittedApiKey || undefined }) },
      });
      if (oauth || submittedApiKey) {
        setModels((current) => current.map((item) => item.provider === provider ? {
          ...item,
          authConfigured: true,
          authSource: "stored",
          authType: oauth ? "oauth" : "api_key",
        } : item));
      }
      setApiKey("");
      setScopeStatus(result.status);
      if (scope === "space") onConfigured(result.status);
      onAssistantChanged?.(scope, result.status);
      setNotice(oauth ? "Account connected" : "Model saved");
    } catch (caught) { setError(errorText(caught)); }
    finally { setSaving(false); }
  }

  async function removeCredential() {
    if (fixtureMode || !removableAuth || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ models: AgentModel[]; status: AgentStatus }>("/api/agent/auth", {
        method: "DELETE",
        body: { ...assistantScopeBody(scope, space), provider },
      });
      setModels(result.models);
      setApiKey("");
      setScopeStatus(result.status);
      if (scope === "space") onConfigured(result.status);
      onAssistantChanged?.(scope, result.status);
      setNotice(providerAuth?.authType === "oauth" ? "Account disconnected" : "API key removed");
    } catch (caught) { setError(errorText(caught)); }
    finally { setSaving(false); }
  }

  async function refreshModels() {
    if (fixtureMode) {
      setNotice("1 model refreshed from OpenRouter");
      return;
    }
    setRefreshing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ models: AgentModel[]; status: AgentStatus; catalogs: AgentModelCatalog[]; refresh: { modelCount: number } }>("/api/agent/models/refresh", {
        method: "POST",
        body: { ...assistantScopeBody(scope, space), provider },
      });
      setModels(result.models);
      setCatalogs(result.catalogs);
      setScopeStatus(result.status);
      setModel((current) => resolveAssistantModelSelection(result.models, provider, current));
      onAssistantChanged?.(scope, result.status);
      setNotice(`${result.refresh.modelCount} models refreshed from OpenRouter`);
    } catch (caught) { setError(errorText(caught)); }
    finally { setRefreshing(false); }
  }

  async function saveInstructions() {
    if (scope !== "space" || !space || savingInstructions) return;
    if (fixtureMode) {
      setSavedInstructions(instructions.trim());
      setInstructions(instructions.trim());
      setInstructionsNotice("Instructions saved");
      return;
    }
    setSavingInstructions(true);
    setError(null);
    setInstructionsNotice(null);
    try {
      const result = await api<{ instructions: string }>("/api/agent/instructions", {
        method: "POST",
        body: { scope: "space", spaceId: space.id, instructions },
      });
      setInstructions(result.instructions);
      setSavedInstructions(result.instructions);
      setInstructionsNotice("Instructions saved");
    } catch (caught) { setError(errorText(caught)); }
    finally { setSavingInstructions(false); }
  }

  function submitSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void configure();
  }

  return (
    <div className={embedded ? "assistant-settings-panel professional-assistant" : "space-pane-content assistant-pane professional-surface professional-assistant"}>
      <section className="assistant-setup-card professional-card" aria-label="Assistant model settings">
        <div className="assistant-scope-control" role="radiogroup" aria-label="Use this model for">
          {space ? <button className={scope === "space" ? "active" : ""} type="button" role="radio" aria-checked={scope === "space"} onClick={() => setScope("space")}><span>This Space</span><small>{space.name}</small></button> : null}
          <button className={scope === "management" ? "active" : ""} type="button" role="radio" aria-checked={scope === "management"} onClick={() => setScope("management")}><span>The fold</span><small>Menu bar and web</small></button>
        </div>
        {loading ? <LoadingRow label="Loading Pi models" /> : (
          <form className="setup-grid" onSubmit={submitSetup}>
            {error ? <div className="inline-error" role="alert">{error}</div> : null}
            <label className="professional-field">
              <span className="professional-field-label">Provider</span>
              <select value={provider} onChange={(event) => { setProvider(event.target.value); setApiKey(""); setError(null); setNotice(null); }}>{providers.map((item) => <option value={item} key={item}>{providerDisplayName(models, item)}</option>)}</select>
            </label>
            <div className="professional-field">
              <div className="assistant-model-field-heading">
                <label className="professional-field-label" htmlFor="assistant-model">Model</label>
                {catalog?.refreshable ? <button className="assistant-refresh-models" type="button" disabled={saving || refreshing || !authConfigured} title={authConfigured ? "Refresh OpenRouter models" : "Connect OpenRouter before refreshing"} onClick={() => void refreshModels()}><ArrowSync16Regular className={refreshing ? "spin" : undefined} />{refreshing ? "Refreshing" : "Refresh"}</button> : null}
              </div>
              <select id="assistant-model" autoFocus={focusModelOnOpen} value={model} onChange={(event) => { setModel(event.target.value); setError(null); setNotice(null); }}>{providerModels.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}</select>
              {catalog?.source === "live" && catalog.refreshedAt ? <span className="professional-field-hint">OpenRouter list updated {formatCatalogDate(catalog.refreshedAt)}</span> : null}
            </div>
            {scope === "space" ? <>
              <label className="professional-field professional-field-wide assistant-instructions-field">
                <span className="professional-field-label">Space instructions</span>
                <textarea value={instructions} maxLength={8000} rows={6} onChange={(event) => { setInstructions(event.target.value); setError(null); setInstructionsNotice(null); }} placeholder="How should the Assistant work in this Space?" />
              </label>
              <div className="professional-actions professional-field-wide assistant-instructions-actions">
                <button className="professional-button professional-button-secondary" type="button" disabled={savingInstructions || instructions.trim() === savedInstructions} onClick={() => void saveInstructions()}>
                  {savingInstructions ? <ArrowSync16Regular className="spin" /> : <Checkmark16Regular />}Save instructions
                </button>
                {instructionsNotice ? <span className="professional-field-hint">{instructionsNotice}</span> : null}
              </div>
            </> : null}
            {!accountOnly ? <div className="professional-field professional-field-wide">
              <label className="professional-field-label" htmlFor="assistant-api-key">API key</label>
              <span className="professional-field-hint" id="assistant-api-key-hint">{credentialStatus ?? "Stored securely on this computer"}</span>
              <div className="assistant-credential-control">
                <input id="assistant-api-key" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setError(null); setNotice(null); }} placeholder={authConfigured ? "••••••••••••••••" : "Paste a key"} autoComplete="off" disabled={saving || authConfigured} aria-describedby="assistant-api-key-hint" />
                {removableAuth ? <button className="professional-button professional-button-secondary" type="button" onClick={() => void removeCredential()} disabled={saving}>{removeCredentialLabel}</button> : null}
              </div>
            </div> : null}
            <div className="professional-actions professional-field-wide">
              <button className="professional-button professional-button-primary" type="submit" disabled={saving || !model || !setupChanged || (!authConfigured && !apiKey.trim())}>
                {saving ? <ArrowSync16Regular className="spin" /> : <Checkmark16Regular />}Save model
              </button>
              {oauthSupported ? <button className="professional-button professional-button-secondary" type="button" onClick={() => void configure(true)} disabled={saving}>{assistantAccountAction(provider, providerAuth?.authType === "oauth")}</button> : null}
              {accountOnly && removableAuth ? <button className="professional-button professional-button-secondary" type="button" onClick={() => void removeCredential()} disabled={saving}>{removeCredentialLabel}</button> : null}
              {notice ? <span className="professional-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
            </div>
            {subscriptionNote ? <p className="security-note professional-field-wide"><ShieldCheckmark16Regular />{subscriptionNote}</p> : null}
            <p className="assistant-scope-summary professional-field-wide">Saved for {scopeLabel}. Provider connections are shared on this computer.</p>
          </form>
        )}
      </section>
    </div>
  );
}

function LibraryTree({ entries, selected, onSelect, disabled = false, level = 0 }: { entries: TreeEntry[]; selected: string | null; onSelect: (path: string) => void; disabled?: boolean; level?: number }) {
  return (
    <div className="file-tree">
      {entries.map((entry) => (
        <div className="file-tree-item" key={entry.path}>
          <button className={selected === entry.path ? "file-row selected" : "file-row"} style={{ paddingLeft: 12 + level * 16 }} type="button" disabled={disabled} onClick={() => onSelect(entry.path)}>
            {entry.kind === "folder" ? <Folder16Regular /> : <FileTypeIcon path={entry.path} />}
            <span className="file-name">{entry.name}</span>
          </button>
          {entry.children?.length ? <LibraryTree entries={entry.children} selected={selected} onSelect={onSelect} disabled={disabled} level={level + 1} /> : null}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="professional-empty-state">
      <span className="professional-empty-icon" aria-hidden="true">{icon}</span>
      <div><h2>{title}</h2><p>{detail}</p></div>
    </div>
  );
}

function LoadingRow({ label }: { label: string }) {
  return <div className="professional-loading-row" role="status"><ArrowSync16Regular className="spin" />{label}</div>;
}

function unique<T>(items: T[]) { return [...new Set(items)]; }
function providerDisplayName(models: AgentModel[], provider: string) { return models.find((item) => item.provider === provider)?.providerName || provider; }
function assistantCredentialStatus(model: AgentModel | undefined) {
  if (!model?.authConfigured) return null;
  if (model.authSource === "stored") return model.authType === "oauth" ? "Provider account connected on this computer" : "API key saved on this computer";
  if (model.authSource === "environment") return `API key supplied by ${model.authLabel || "the app environment"}`;
  if (model.authSource === "models_json_key" || model.authSource === "models_json_command") return "Credential configured in Pi models settings";
  return "Credential supplied outside work-fold";
}
function providerAccountOnly(provider: string) {
  return provider === "openai-codex" || provider === "github-copilot";
}
function assistantAccountAction(provider: string, configured: boolean) {
  if (configured) return "Reconnect account";
  if (provider === "openai-codex") return "Sign in with ChatGPT";
  if (provider === "github-copilot") return "Sign in with GitHub";
  if (provider === "anthropic") return "Connect Anthropic account";
  return "Connect account";
}
function providerSubscriptionNote(provider: string) {
  if (provider === "openai-codex") return "Connects to OpenAI’s Codex subscription service. Eligibility and limits follow your ChatGPT plan; OpenAI API usage is a separate connection under the OpenAI provider.";
  if (provider === "github-copilot") return "Connects through GitHub OAuth. GitHub controls account eligibility, available models, and billing.";
  if (provider === "anthropic") return "Anthropic recommends API-key authentication for third-party tools. A Claude subscription may not cover work-fold; usage credits and current account terms can apply.";
  return "Availability and limits follow the provider’s current account terms.";
}
function assistantScopeParams(scope: AssistantModelScope, space: SpaceSummary | null) {
  const params = new URLSearchParams({ scope });
  if (scope === "space" && space) params.set("spaceId", space.id);
  return params.toString();
}
function assistantScopeBody(scope: AssistantModelScope, space: SpaceSummary | null) {
  return scope === "management" ? { scope } : { scope, spaceId: space?.id };
}
function formatCatalogDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function libraryDestinationLabel(space: SpaceSummary, spaces: SpaceSummary[]) {
  const duplicateName = spaces.some((item) => item.id !== space.id && item.name.localeCompare(space.name, undefined, { sensitivity: "base" }) === 0);
  return duplicateName ? `${space.name} — ${space.rootPath}` : space.name;
}
function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function findTreeEntry(entries: TreeEntry[], path: string): TreeEntry | null { for (const entry of entries) { if (entry.path === path) return entry; const child = entry.children ? findTreeEntry(entry.children, path) : null; if (child) return child; } return null; }
function filterTree(entries: TreeEntry[], query: string): TreeEntry[] { return entries.flatMap((entry) => { const children = entry.children ? filterTree(entry.children, query) : []; return entry.name.toLocaleLowerCase().includes(query) || children.length ? [{ ...entry, children }] : []; }); }
