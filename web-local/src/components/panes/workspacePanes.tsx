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
  Bot20Regular,
  Chat16Regular,
  Checkmark12Regular,
  Checkmark16Regular,
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
import { chatActivityKey, chatSnoozeTimeLabel, conversationLifecycleView, isRecentlyResurfaced } from "../../lib/chat-lifecycle";
import { formatChatListTime, formatItemCount } from "../../lib/format";
import { workspaceIdentityFor, workspaceIdentityStyle } from "../../lib/workspace-identity";
import type {
  AgentModel,
  AgentStatus,
  ChatActivityStatus,
  ChatLifecycleView,
  ConversationSummary,
  TreeEntry,
  WorkspaceCheckpoint,
  WorkspaceCustomizationMap,
  WorkspaceSummary,
} from "../../types";
import { WorkspaceIconGlyph } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { TextInputModal } from "../modals/TextInputModal";
import { requestConfirm } from "../../ui/feedback";
import { WorkspaceRenameEditor } from "./workspaceChrome";
import { ChatContentSearch } from "./ChatContentSearch";

export function SpacesPane({
  workspace,
  workspaces,
  identities,
  onSwitch,
  onCreate,
  onOpenFolder,
  onCustomize,
  onRename,
  onRemove,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  identities: WorkspaceCustomizationMap;
  onSwitch: (workspace: WorkspaceSummary) => void;
  onCreate: () => void;
  onOpenFolder: () => void;
  onCustomize: (workspace: WorkspaceSummary) => void;
  onRename: (workspace: WorkspaceSummary, name: string) => Promise<void>;
  onRemove?: (workspace: WorkspaceSummary) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);

  return (
    <div className="workspace-pane-content workspaces-pane professional-surface professional-spaces">
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

      <section className="workspace-pane-section professional-section-card">
        <div className="professional-section-heading">
          <span>Your Spaces</span>
          <strong>{formatItemCount(workspaces.length, "Space")}</strong>
        </div>
        <div className="workspace-switcher">
          {workspaces.map((item) => {
            const identity = workspaceIdentityFor(item, identities);
            const active = item.id === workspace.id;
            return (
              <div className={active ? "workspace-card-shell active" : "workspace-card-shell"} key={item.id} style={workspaceIdentityStyle(identity)}>
                <div className="workspace-card-row">
                  <button className={active ? "workspace-tab workspace-card-main active" : "workspace-tab workspace-card-main"} type="button" onClick={() => onSwitch(item)}>
                    <span className="workspace-tab-icon workspace-identity-icon"><WorkspaceIconGlyph icon={identity.Icon} size={16} /></span>
                    <span className="workspace-tab-copy">
                      <strong>{item.name}</strong>
                      <span>{item.location.providerHint === "google-drive" ? "Google Drive" : item.location.storage === "linked" ? "Linked folder" : "Managed folder"}</span>
                    </span>
                    {active ? <span className="active-dot" aria-label="Active Space"><Checkmark12Regular /></span> : null}
                  </button>
                  <span className="workspace-card-actions">
                    <button className="workspace-card-rename" type="button" onClick={() => setRenamingId((current) => current === item.id ? null : item.id)} aria-label={`Rename ${item.name}`} title="Rename Space"><Edit16Regular /></button>
                    <button className="workspace-card-customize" type="button" onClick={() => onCustomize(item)} aria-label={`Customize ${item.name}`} title="Customize Space"><Color16Regular /></button>
                    {onRemove ? <button className="workspace-card-delete" type="button" onClick={() => onRemove(item)} aria-label={`Remove ${item.name}`} title="Remove Space"><Delete16Regular /></button> : null}
                  </span>
                </div>
                <WorkspaceRenameEditor open={renamingId === item.id} workspace={item} onRenameWorkspace={onRename} onClose={() => setRenamingId(null)} />
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function ChatsPane({
  workspace,
  workspaces,
  conversations,
  customizations,
  activeConversationId,
  onOpen,
  onNew,
  onActions,
  activityStatuses,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  conversations: Record<string, ConversationSummary[]>;
  customizations: WorkspaceCustomizationMap;
  activeConversationId?: string | null;
  onOpen: (workspace: WorkspaceSummary, conversation: ConversationSummary) => void;
  onNew: (workspace: WorkspaceSummary) => void;
  onActions: (workspace: WorkspaceSummary, conversation: ConversationSummary, event: React.MouseEvent<HTMLElement>) => void;
  activityStatuses: Record<string, ChatActivityStatus>;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ChatLifecycleView>("active");
  const [now, setNow] = useState(() => Date.now());
  const normalized = query.trim().toLocaleLowerCase();
  const orderedWorkspaces = [workspace, ...workspaces.filter((item) => item.id !== workspace.id)];
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

  return (
    <div className="workspace-pane-content chats-pane professional-surface professional-chats">
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
      <div className="chat-workspace-groups">
        {orderedWorkspaces.map((item) => {
          const list = (conversations[item.id] ?? []).filter((chat) =>
            conversationLifecycleView(chat, now) === view
            && (!normalized || chat.title.toLocaleLowerCase().includes(normalized)));
          if (!list.length && item.id !== workspace.id) return null;
          const identity = workspaceIdentityFor(item, customizations);
          return (
            <section className="chat-workspace-group" key={item.id} style={workspaceIdentityStyle(identity)}>
              <div className="chat-workspace-heading">
                <span className="workspace-identity-icon" aria-hidden="true"><WorkspaceIconGlyph icon={identity.Icon} size={15} /></span>
                <strong>{item.name}</strong>
                <button className="minimal-icon-button" type="button" onClick={() => onNew(item)} aria-label={`New Chat in ${item.name}`} title="New Chat"><Chat16Regular /></button>
              </div>
              <div className={item.id === workspace.id ? "chat-workspace-list chat-workspace-list-current" : "chat-workspace-list"}>
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
                        "chat-workspace-row-shell",
                        chat.id === activeConversationId ? "active" : "",
                        status ? `status-${status}` : "",
                        resurfaced ? "resurfaced" : "",
                      ].filter(Boolean).join(" ")}
                      key={chat.id}
                      onContextMenu={(event) => { event.preventDefault(); onActions(item, chat, event); }}
                    >
                      <button className="chat-workspace-row" type="button" onClick={() => onOpen(item, chat)}>
                        <span className="chat-workspace-row-title">{chat.title}</span>
                        <span className="chat-workspace-row-meta">
                          {status ? <ChatActivityIndicator status={status} /> : null}
                          <span className="chat-workspace-row-time">{secondary}</span>
                        </span>
                      </button>
                      <button
                        className="chat-workspace-row-actions"
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
                  <span className="chat-workspace-empty">
                    {normalized ? `No ${view} Chat titles match` : chatViewEmptyLabel(view)}
                  </span>
                ) : null}
              </div>
            </section>
          );
        })}
        <ChatContentSearch
          workspaces={orderedWorkspaces}
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

function ChatActivityIndicator({ status }: { status: ChatActivityStatus }) {
  return (
    <span className={`chat-activity-indicator ${status}`} role="status">
      <span aria-hidden="true" />
      <span className="sr-only">{status === "running" ? "Assistant working" : "New Assistant response"}</span>
    </span>
  );
}

function chatViewEmptyLabel(view: ChatLifecycleView): string {
  if (view === "snoozed") return "No snoozed Chats";
  if (view === "archived") return "No archived Chats";
  return "No active Chats yet";
}

export function LibraryPane({ workspace, fixtureTree, onError }: { workspace: WorkspaceSummary; fixtureTree?: TreeEntry[]; onError: (message: string | null) => void }) {
  const [tree, setTree] = useState<TreeEntry[]>(fixtureTree ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const selectedEntry = selected ? findTreeEntry(tree, selected) : null;

  useEffect(() => { if (!fixtureTree) void load(); }, [fixtureTree]);

  async function load() {
    try { setTree((await api<{ tree: TreeEntry[] }>("/api/resources/tree")).tree); }
    catch (caught) { onError(errorText(caught)); }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || fixtureTree) return;
    const form = new FormData();
    form.set("targetFolderPath", selectedEntry?.kind === "folder" ? selectedEntry.path : "");
    form.set("relativePaths", JSON.stringify(files.map((file) => file.webkitRelativePath || file.name)));
    files.forEach((file) => form.append("files", file, file.name));
    setBusy(true);
    try { await apiForm("/api/resources/upload", form); await load(); }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function createFolder(name: string) {
    if (fixtureTree) return;
    setBusy(true);
    try {
      await api("/api/resources/folders", { method: "POST", body: { parentPath: selectedEntry?.kind === "folder" ? selectedEntry.path : "", name } });
      await load();
    } finally { setBusy(false); }
  }

  async function copyToSpace() {
    if (!selected) return;
    if (fixtureTree) { setNotice(`Preview: ${selectedEntry?.name ?? "item"} would be copied to ${workspace.name}.`); return; }
    setBusy(true);
    setNotice("");
    try {
      const result = await api<{ copied: string[] }>("/api/resources/copy-to-workspace", { method: "POST", body: { workspaceId: workspace.id, paths: [selected], targetFolder: "From Library" } });
      setNotice(`Added ${result.copied[0] ?? selectedEntry?.name ?? "item"} to ${workspace.name}.`);
    } catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = normalizedQuery ? filterTree(tree, normalizedQuery) : tree;
  const libraryEmpty = tree.length === 0;
  const noMatches = !libraryEmpty && visible.length === 0;

  return (
    <div className="workspace-pane-content library-pane professional-surface professional-library">
      <div className="file-tree-toolbar professional-library-toolbar">
        <label className="file-tree-search">
          <Library20Regular />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" aria-label="Search Library" />
        </label>
        <div className="professional-toolbar-actions">
          <button className="minimal-icon-button" type="button" disabled={busy || Boolean(fixtureTree)} onClick={() => uploadRef.current?.click()} aria-label="Add files" title="Add files"><ArrowUpload16Regular /></button>
          <button className="minimal-icon-button" type="button" disabled={busy || Boolean(fixtureTree)} onClick={() => setFolderDialogOpen(true)} aria-label="New folder" title="New folder"><FolderAdd16Regular /></button>
        </div>
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
          <div className="library-tree"><LibraryTree entries={visible} selected={selected} onSelect={setSelected} /></div>
          <div className="library-detail">
            {selectedEntry ? (
              <div className="professional-resource-selection">
                <div className="professional-resource-heading">
                  <span className="professional-icon-tile" aria-hidden="true">{selectedEntry.kind === "folder" ? <Folder20Regular /> : <FileTypeIcon path={selectedEntry.path} />}</span>
                  <div><span className="professional-kicker">Library item</span><h2>{selectedEntry.name}</h2></div>
                </div>
                <code className="professional-resource-path">{selectedEntry.path}</code>
                <p>Workspace makes an independent copy under <strong>From Library</strong>. It is not automatically included in a Chat.</p>
                <div className="professional-actions">
                  <button className="professional-button professional-button-primary" type="button" disabled={busy} onClick={() => void copyToSpace()}>
                    {busy ? <ArrowSync16Regular className="spin" /> : <Copy16Regular />}Add to {workspace.name}
                  </button>
                </div>
                {notice ? <p className="professional-status" role="status"><Checkmark16Regular />{notice}</p> : null}
              </div>
            ) : (
              <EmptyState icon={<Library20Regular />} title="Choose a Library item" detail="Select a file or folder to see where it lives and add a copy to this Space." />
            )}
          </div>
        </div>
      )}
      {folderDialogOpen ? <TextInputModal title="New Library folder" description="Create a folder in the selected Library location." label="Folder name" confirmLabel="Create folder" onSubmit={createFolder} onClose={() => setFolderDialogOpen(false)} /> : null}
    </div>
  );
}

export function HistoryPane({ workspace, fixtureItems, refreshRequest = 0, selectedCheckpointId, onOpen, onError }: {
  workspace: WorkspaceSummary;
  fixtureItems?: WorkspaceCheckpoint[];
  refreshRequest?: number;
  selectedCheckpointId?: string;
  onOpen?: (item: WorkspaceCheckpoint) => void;
  onError: (message: string | null) => void;
}) {
  const [items, setItems] = useState<WorkspaceCheckpoint[]>(fixtureItems ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!fixtureItems) void load(); }, [workspace.id, fixtureItems]);
  useEffect(() => { if (!fixtureItems && refreshRequest > 0) void load(); }, [refreshRequest]);

  async function load() {
    try { setItems((await api<{ checkpoints: WorkspaceCheckpoint[] }>(`/api/workspaces/${workspace.id}/history/checkpoints`)).checkpoints); }
    catch (caught) { onError(errorText(caught)); }
  }

  async function savePoint() {
    if (fixtureItems) return;
    setBusy(true);
    try { await api(`/api/workspaces/${workspace.id}/history/checkpoints`, { method: "POST", body: { label: "Manual restore point" } }); await load(); }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  async function restore(item: WorkspaceCheckpoint) {
    if (fixtureItems) return;
    const confirmed = await requestConfirm({ title: `Restore ${workspace.name}?`, body: `Return the Space to ${formatDate(item.createdAt)}. Current files will be replaced by that restore point.`, confirmLabel: "Restore", tone: "danger" });
    if (!confirmed) return;
    setBusy(true);
    try { await api(`/api/workspaces/${workspace.id}/history/checkpoints/${item.checkpointId}/restore`, { method: "POST", body: {} }); await load(); }
    catch (caught) { onError(errorText(caught)); }
    finally { setBusy(false); }
  }

  return (
    <div className="workspace-pane-content history-pane professional-surface professional-history">
      <div className="history-pane-actions">
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
        {!items.length ? <EmptyState icon={<History20Regular />} title="No restore points yet" detail="Workspace creates restore points before important file changes. You can make one manually too." /> : null}
      </div>
    </div>
  );
}

export function AssistantSetupPane({ workspace, status, fixtureMode = false, embedded = false, onConfigured }: { workspace: WorkspaceSummary; status: AgentStatus; fixtureMode?: boolean; embedded?: boolean; onConfigured: (status: AgentStatus) => void }) {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [provider, setProvider] = useState(status.provider ?? "openrouter");
  const [model, setModel] = useState(status.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fixtureMode) {
      setModels([{ provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet", authConfigured: true, oauthSupported: false }]);
      setProvider("openrouter");
      setModel("anthropic/claude-sonnet-4");
      setLoading(false);
      return;
    }
    void api<{ models: AgentModel[] }>(`/api/agent/models?workspaceId=${encodeURIComponent(workspace.id)}`)
      .then((result) => {
        setModels(result.models);
        const first = result.models.find((item) => item.provider === provider) ?? result.models.find((item) => item.provider === "openrouter") ?? result.models[0];
        if (first) {
          setProvider(first.provider);
          setModel((current) => result.models.some((item) => item.provider === first.provider && item.id === current) ? current : first.id);
        }
      })
      .catch((caught) => setError(errorText(caught)))
      .finally(() => setLoading(false));
  }, [fixtureMode, workspace.id]);

  const providers = unique(models.map((item) => item.provider)).sort((left, right) =>
    providerDisplayName(models, left).localeCompare(providerDisplayName(models, right)));
  const providerModels = models.filter((item) => item.provider === provider);
  const oauthSupported = providerModels.some((item) => item.oauthSupported);
  const authConfigured = providerModels.some((item) => item.authConfigured);
  const subscriptionNote = oauthSupported ? providerSubscriptionNote(provider) : null;

  useEffect(() => {
    if (!providerModels.some((item) => item.id === model)) setModel(providerModels[0]?.id ?? "");
  }, [provider]);

  async function configure(oauth = false) {
    if (fixtureMode) { onConfigured({ ...status, configured: true, provider, model }); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ status: AgentStatus }>(oauth ? "/api/agent/oauth" : "/api/agent/configure", { method: "POST", body: { workspaceId: workspace.id, provider, model, ...(oauth ? {} : { apiKey: apiKey.trim() || undefined }) } });
      setModels((current) => current.map((item) => item.provider === provider ? { ...item, authConfigured: true } : item));
      setApiKey("");
      onConfigured(result.status);
    } catch (caught) { setError(errorText(caught)); }
    finally { setSaving(false); }
  }

  function submitSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void configure();
  }

  return (
    <div className={embedded ? "assistant-settings-panel professional-assistant" : "workspace-pane-content assistant-pane professional-surface professional-assistant"}>
      <section className="assistant-setup-card professional-card" aria-labelledby="assistant-setup-title">
        <div className="setup-intro">
          <span className="professional-icon-tile" aria-hidden="true"><Bot20Regular /></span>
          <div><h2 id="assistant-setup-title">Your Assistant, your provider</h2><p>Workspace uses Pi with its built-in tools, Skills, and Extensions.</p></div>
        </div>
        {loading ? <LoadingRow label="Loading Pi models" /> : (
          <form className="setup-grid" onSubmit={submitSetup}>
            {error ? <div className="inline-error" role="alert">{error}</div> : null}
            <label className="professional-field">
              <span className="professional-field-label">Provider</span>
              <select value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); }}>{providers.map((item) => <option value={item} key={item}>{providerDisplayName(models, item)}</option>)}</select>
            </label>
            <label className="professional-field">
              <span className="professional-field-label">Model</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>{providerModels.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}</select>
            </label>
            <label className="professional-field professional-field-wide">
              <span className="professional-field-label">API key</span>
              <span className="professional-field-hint">Stored securely on this computer</span>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={authConfigured ? "Saved credential available" : "Paste a key"} autoComplete="off" />
            </label>
            <div className="professional-actions professional-field-wide">
              <button className="professional-button professional-button-primary" type="submit" disabled={saving || !model || (!authConfigured && !apiKey.trim())}>
                {saving ? <ArrowSync16Regular className="spin" /> : <Checkmark16Regular />}Save setup
              </button>
              {oauthSupported ? <button className="professional-button professional-button-secondary" type="button" onClick={() => void configure(true)} disabled={saving}>{authConfigured ? "Reconnect account" : "Connect account"}</button> : null}
            </div>
            {subscriptionNote ? <p className="security-note professional-field-wide"><ShieldCheckmark16Regular />{subscriptionNote}</p> : null}
            <p className="security-note professional-field-wide"><ShieldCheckmark16Regular />Creating or registering a Space allows its local Pi configuration. Review packages separately before installing them.</p>
          </form>
        )}
      </section>
    </div>
  );
}

function LibraryTree({ entries, selected, onSelect, level = 0 }: { entries: TreeEntry[]; selected: string | null; onSelect: (path: string) => void; level?: number }) {
  return (
    <div className="file-tree">
      {entries.map((entry) => (
        <div className="file-tree-item" key={entry.path}>
          <button className={selected === entry.path ? "file-row selected" : "file-row"} style={{ paddingLeft: 12 + level * 16 }} type="button" onClick={() => onSelect(entry.path)}>
            {entry.kind === "folder" ? <Folder16Regular /> : <FileTypeIcon path={entry.path} />}
            <span className="file-name">{entry.name}</span>
          </button>
          {entry.children?.length ? <LibraryTree entries={entry.children} selected={selected} onSelect={onSelect} level={level + 1} /> : null}
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
function providerSubscriptionNote(_provider: string) {
  return "Workspace opens the provider's sign-in flow in your system browser and stores the resulting tokens in its encrypted desktop credential store. Availability and billing follow that provider's current account terms.";
}
function formatDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function findTreeEntry(entries: TreeEntry[], path: string): TreeEntry | null { for (const entry of entries) { if (entry.path === path) return entry; const child = entry.children ? findTreeEntry(entry.children, path) : null; if (child) return child; } return null; }
function filterTree(entries: TreeEntry[], query: string): TreeEntry[] { return entries.flatMap((entry) => { const children = entry.children ? filterTree(entry.children, query) : []; return entry.name.toLocaleLowerCase().includes(query) || children.length ? [{ ...entry, children }] : []; }); }
