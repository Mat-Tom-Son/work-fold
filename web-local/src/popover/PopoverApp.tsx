import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { File, Link2, SquarePen, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, api, createEventSource, errorText } from "../lib/api";
import { WorkFoldLockup } from "../components/brand/WorkFoldBrand";

/** Mirrors the server's WorkFoldActManagementRequest projection. */
interface ManagementRequestView {
  taskId: string;
  conversationId: string;
  phase: "working" | "needs_you" | "handed_off" | "done" | "failed" | "stopped";
  startedAt: string;
  endedAt: string | null;
  error: string | null;
  content: string;
  attachments: Array<{ kind: "file" | "folder" | "url"; target: string; name: string }>;
  dispositions: Array<{
    attachment: { kind: "file" | "folder" | "url"; target: string; name: string };
    status: "placed" | "registered" | "unrecorded";
    spaceName?: string;
    copied?: string[];
    checkpointId?: string | null;
  }>;
  actions: Array<{
    command: "files.add" | "spaces.create" | "spaces.register" | "chat.send";
    at: string;
    spaceId: string;
    spaceName: string;
    copied?: string[];
    checkpointId?: string | null;
    rootPath?: string;
    conversationId?: string;
    taskId?: string;
  }>;
  children: Array<{
    taskId: string;
    spaceId: string;
    spaceName: string;
    conversationId: string;
    state: "running" | "succeeded" | "failed" | "aborted" | "unknown";
    error: string | null;
  }>;
  reply: { messageId: string; content: string } | null;
}

interface ManagementSummary {
  available: boolean;
  reason?: string;
  conversation: { id: string } | null;
  state: "idle" | "running" | "compacting";
  latestRequest: ManagementRequestView | null;
}

interface ManagementMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  kind?: string;
  source?: string;
}

interface StagedItem {
  value: string;
  label: string;
  isLink: boolean;
}

const activePhases = new Set(["working", "handed_off"]);
const pollIntervalMs = 1_500;
const idlePollIntervalMs = 5_000;

export function PopoverApp() {
  const bridge = window.workFoldDesktop;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string>("");
  const [request, setRequest] = useState<ManagementRequestView | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ManagementMessage[]>([]);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [banner, setBanner] = useState<string>("");
  const [dropActive, setDropActive] = useState(false);
  const [activity, setActivity] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const requestRef = useRef<ManagementRequestView | null>(null);
  const startingNewChatRef = useRef(false);
  requestRef.current = request;

  const refreshConversation = useCallback(async () => {
    try {
      const summary = await api<ManagementSummary>("/api/management/summary");
      setAvailable(summary.available);
      setUnavailableReason(summary.available ? "" : summary.reason ?? "");
      if (startingNewChatRef.current) return;
      setRequest(summary.latestRequest);
      const nextConversationId = summary.conversation?.id ?? null;
      setConversationId(nextConversationId);
      if (!nextConversationId) {
        setMessages([]);
        return;
      }
      const transcript = await api<{ messages: ManagementMessage[] }>(`/api/management/conversations/${encodeURIComponent(nextConversationId)}`);
      setMessages(transcript.messages.filter((message) =>
        (message.role === "user" || message.role === "assistant") && !message.kind));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setRequest(null);
        setConversationId(null);
        setMessages([]);
        setAvailable(true);
        setBanner("That request belonged to an earlier app run. Start a new request to continue.");
        return;
      }
      const message = errorText(error);
      setAvailable(false);
      setUnavailableReason(message);
      setBanner(message);
    }
  }, []);

  useEffect(() => {
    void refreshConversation();
  }, [refreshConversation]);

  // Staged material handed over by the tray (macOS icon drops).
  useEffect(() => {
    const unsubscribe = bridge?.management?.onStaged((items) => {
      for (const item of items) {
        if (item.kind === "path") addStagedValue(item.value, setStaged);
        else if (looksLikeLink(item.value)) addStagedValue(item.value.trim(), setStaged);
        else setText((current) => (current ? `${current}\n${item.value}` : item.value));
      }
    });
    return () => unsubscribe?.();
  }, [bridge]);

  // Live turn events for the active request's conversation.
  useEffect(() => {
    if (!conversationId) return;
    const stream = createEventSource(`/api/management/conversations/${encodeURIComponent(conversationId)}/events`);
    stream.onmessage = (raw) => {
      let event: { type?: string; message?: string; toolName?: string };
      try {
        event = JSON.parse(raw.data) as { type?: string; message?: string; toolName?: string };
      } catch {
        return;
      }
      if (event.type === "status" || event.type === "tool") {
        const message = typeof event.message === "string" && event.message !== "Connected." ? event.message.trim() : "";
        const tool = event.type === "tool" && typeof event.toolName === "string" ? event.toolName.trim() : "";
        if (message || tool) setActivity(message || tool);
      }
      if (event.type === "turn_state" || event.type === "done" || event.type === "error") {
        void refreshConversation();
      }
    };
    return () => stream.close();
  }, [conversationId, refreshConversation]);

  // Poll quickly while work is active and quietly while idle. The latter keeps
  // the persistent popover aligned when the web surface starts a fresh chat.
  const phase = request?.phase ?? null;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshConversation();
      setNow(Date.now());
    }, request && phase && activePhases.has(phase) ? pollIntervalMs : idlePollIntervalMs);
    return () => window.clearInterval(timer);
  }, [request?.taskId, phase, refreshConversation]);

  // Electron keeps this renderer mounted while the popover is hidden. A turn
  // can settle while Chromium has throttled its timer and event stream, so a
  // newly shown/focused popover must reconcile the persisted request before it
  // renders the old Working state again.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") void refreshConversation();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshConversation]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") bridge?.management?.hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge]);

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setBanner("");
    setActivity("");
    try {
      const body: Record<string, unknown> = { content };
      if (staged.length) body.attachments = staged.map((item) => item.value);
      const current = requestRef.current;
      if (startingNewChatRef.current) {
        body.newConversation = true;
      } else if (current && current.phase === "needs_you") {
        body.conversationId = current.conversationId;
        body.continuationTaskId = current.taskId;
      }
      const result = await api<{ taskId: string; conversationId: string }>(
        "/api/management/messages",
        { method: "POST", body },
      );
      startingNewChatRef.current = false;
      setStartingNewChat(false);
      setText("");
      setStaged([]);
      setConversationId(result.conversationId);
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setSending(false);
    }
  }, [text, staged, sending, refreshConversation]);

  const startNewChat = useCallback(() => {
    if (sending || startingNewChatRef.current) return;
    startingNewChatRef.current = true;
    setStartingNewChat(true);
    setRequest(null);
    setConversationId(null);
    setMessages([]);
    setActivity("");
    setBanner("New chat ready. Your previous chat is still saved on this desktop.");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [sending]);

  const stop = useCallback(async () => {
    const current = requestRef.current;
    if (!current || stopping) return;
    setStopping(true);
    try {
      const result = await api<{
        stopped: { managementAborted: boolean; children: Array<{ aborted: boolean }> };
      }>(`/api/management/requests/${encodeURIComponent(current.taskId)}/stop`, { method: "POST", body: {} });
      if (!result.stopped.managementAborted && !result.stopped.children.some((child) => child.aborted)) {
        setBanner("No running work was stopped. It may have finished just before the request arrived.");
      }
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setStopping(false);
    }
  }, [stopping, refreshConversation]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const transfer = event.dataTransfer;
    let added = false;
    for (const file of Array.from(transfer.files)) {
      const path = bridge?.management?.getPathForFile(file) ?? "";
      if (path) {
        addStagedValue(path, setStaged);
        added = true;
      }
    }
    if (!added) {
      const uriList = transfer.getData("text/uri-list") || transfer.getData("text/plain");
      for (const line of uriList.split("\n")) {
        const value = line.trim();
        if (value && looksLikeLink(value)) {
          addStagedValue(value, setStaged);
          added = true;
        }
      }
    }
    if (!added && transfer.files.length) {
      setBanner("Dropped files need the work-fold desktop app; links and paths still work here.");
    }
  }, [bridge]);

  const removeStaged = useCallback((value: string) => {
    setStaged((current) => current.filter((item) => item.value !== value));
  }, []);

  const elapsedLabel = useMemo(() => {
    if (!request || request.phase !== "working") return "";
    const startedAt = Date.parse(request.startedAt);
    if (!Number.isFinite(startedAt)) return "";
    const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }, [request, now]);

  if (available === null) {
    return <div className="popover popover-loading"><WorkFoldLockup className="popover-loading-brand" animated /><p className="muted">Connecting…</p></div>;
  }
  if (available === false) {
    return (
      <div className="popover">
        <header className="popover-header"><WorkFoldLockup className="popover-brand" /></header>
        <div className="card">
          <p>The management conversation is unavailable.</p>
          {unavailableReason ? <p className="muted small">{unavailableReason}</p> : null}
        </div>
      </div>
    );
  }

  const showComposer = !request || !activePhases.has(request.phase);
  const composerPlaceholder = request?.phase === "needs_you"
    ? "Reply to work-fold"
    : "Tell work-fold what to do";

  return (
    <div
      className={`popover${dropActive ? " drop-active" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDropActive(true); }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={onDrop}
    >
      <header className="popover-header">
        <WorkFoldLockup className="popover-brand" />
        <div className="popover-header-actions">
          <button
            className="new-chat-button"
            type="button"
            onClick={startNewChat}
            disabled={sending || startingNewChat}
            title="Start a new chat. This chat stays saved on your desktop."
          >
            <SquarePen aria-hidden="true" />
            <span>New chat</span>
          </button>
          {request ? <PhasePill phase={request.phase} /> : null}
        </div>
      </header>

      {banner ? <div className="banner" role="alert">{banner}</div> : null}

      <section className="popover-transcript" ref={transcriptRef} aria-label="Management conversation" aria-live="polite">
        {messages.map((message) => (
          <article className={`popover-message ${message.role}`} key={message.id}>
            <div className="popover-message-role">{message.role === "assistant" ? "work-fold" : "You"}{message.source === "remote_web" ? " · Web" : ""}</div>
            <div className="popover-message-body">
              {message.role === "assistant"
                ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                : message.content}
            </div>
          </article>
        ))}
      </section>

      {request && request.phase === "working" ? (
        <section className="card">
          <p className="working-line" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{activity || "Working on your request"}</p>
          <p className="muted small">
            {request.attachments.length ? `${request.attachments.length} item${request.attachments.length === 1 ? "" : "s"} attached · ` : ""}
            {elapsedLabel ? `started ${elapsedLabel} ago` : "just started"}
          </p>
          <p className="muted small">You can close this popover — the work continues.</p>
          <div className="row-end">
            <button className="danger-quiet" onClick={() => { void stop(); }} disabled={stopping}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          </div>
        </section>
      ) : null}

      {request && request.phase === "handed_off" ? (
        <section className="card">
          <p>Handed off — work continues in {request.children.filter((child) => child.state === "running").length === 1 ? "a Space" : "Spaces"}.</p>
          <ul className="trail">
            {request.children.map((child) => (
              <li key={child.taskId}>
                {child.state === "running" ? <span className="spinner" aria-hidden="true" /> : <Tick state={child.state} />}
                <span>{child.spaceName}: {childStateLabel(child.state)}</span>
              </li>
            ))}
          </ul>
          <div className="row-end">
            <button className="danger-quiet" onClick={() => { void stop(); }} disabled={stopping}>
              {stopping ? "Stopping…" : "Stop remaining work"}
            </button>
          </div>
        </section>
      ) : null}

      {request && !activePhases.has(request.phase) ? (
        <ResultCard request={request} />
      ) : null}

      {showComposer ? (
        <section className="composer">
          {staged.length ? (
            <ul className="chips">
              {staged.map((item) => (
                <li key={item.value} className="chip" title={item.value}>
                  <span className="chip-kind" aria-hidden="true">{item.isLink ? <Link2 /> : <File />}</span>
                  <span className="chip-label">{item.label}</span>
                  <button className="chip-remove" aria-label={`Remove ${item.label}`} onClick={() => removeStaged(item.value)}><X /></button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="drop-hint">Drop files, folders, or links here</div>
          )}
          <textarea
            ref={composerRef}
            rows={3}
            aria-label={composerPlaceholder}
            placeholder={composerPlaceholder}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            {bridge?.management ? (
              <button className="ghost" onClick={() => { void bridge.management?.openMainWindow(); }}>Open work-fold</button>
            ) : <span />}
            <button className="primary" onClick={() => { void send(); }} disabled={sending || !text.trim()}>
              {sending ? "Sending…" : "Tell work-fold"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ResultCard({ request }: { request: ManagementRequestView }) {
  const showOutcome = request.phase === "failed"
    || request.phase === "stopped"
    || request.dispositions.length > 0
    || request.actions.some((action) => action.command !== "files.add");
  if (!showOutcome) return null;
  return (
    <section className="card">
      {request.phase === "failed" ? (
        <p className="error-line">Couldn't finish{request.error ? `: ${request.error}` : "."}</p>
      ) : null}
      {request.phase === "stopped" ? <p>Stopped before it finished.</p> : null}
      <DispositionTrail request={request} />
    </section>
  );
}

/**
 * Host-recorded trail: dispositions come from explicitly attributed act-lane
 * actions, not the Assistant's prose. An attachment with no recorded action is shown
 * as exactly that — nothing silently disappears from the story.
 */
function DispositionTrail({ request }: { request: ManagementRequestView }) {
  const extraActions = request.actions.filter((action) =>
    action.command === "spaces.create" || action.command === "spaces.register" || action.command === "chat.send");
  if (!request.dispositions.length && !extraActions.length) return null;
  return (
    <ul className="trail">
      {request.dispositions.map((disposition) => (
        <li key={`${disposition.attachment.kind}:${disposition.attachment.target}`}>
          {disposition.status === "unrecorded" ? <span className="dot" aria-hidden="true" /> : <Tick state="succeeded" />}
          <span>
            {disposition.status === "placed"
              ? <>Copied {disposition.attachment.name} to {disposition.spaceName}{disposition.checkpointId ? <span className="muted small"> · restore point {shortId(disposition.checkpointId)}</span> : null}</>
              : disposition.status === "registered"
                ? <>Registered {disposition.attachment.name} as the Space {disposition.spaceName}</>
                : <>{disposition.attachment.name}: no recorded placement — see the reply below</>}
          </span>
        </li>
      ))}
      {extraActions.map((action, index) => {
        const child = action.command === "chat.send"
          ? request.children.find((candidate) => candidate.taskId === action.taskId)
          : undefined;
        const state = child?.state ?? "succeeded";
        return (
          <li key={`${action.command}:${action.taskId ?? action.rootPath ?? index}`}>
            {state === "running" ? <span className="spinner" aria-hidden="true" /> : <Tick state={state} />}
            <span>
              {action.command === "chat.send"
                ? <>Work in {action.spaceName}: {childStateLabel(state)}</>
                : action.command === "spaces.create"
                  ? <>Created the Space {action.spaceName}</>
                  : <>Registered the Space {action.spaceName}</>}
              {child?.error ? <span className="muted small"> · {child.error}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PhasePill({ phase }: { phase: ManagementRequestView["phase"] }) {
  const labels: Record<ManagementRequestView["phase"], string> = {
    working: "Working",
    needs_you: "Needs you",
    handed_off: "Handed off",
    done: "Done",
    failed: "Couldn't finish",
    stopped: "Stopped",
  };
  return <span className={`pill pill-${phase}`}>{labels[phase]}</span>;
}

function Tick({ state }: { state: "running" | "succeeded" | "failed" | "aborted" | "unknown" }) {
  if (state === "succeeded") return <span className="tick" aria-hidden="true">✓</span>;
  if (state === "failed") return <span className="cross" aria-hidden="true">✕</span>;
  return <span className="dot" aria-hidden="true" />;
}

function childStateLabel(state: "running" | "succeeded" | "failed" | "aborted" | "unknown"): string {
  switch (state) {
    case "running": return "still working";
    case "succeeded": return "finished";
    case "failed": return "failed";
    case "aborted": return "stopped";
    default: return "state unknown";
  }
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function looksLikeLink(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function addStagedValue(value: string, setStaged: React.Dispatch<React.SetStateAction<StagedItem[]>>): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) return;
  const isLink = looksLikeLink(trimmed);
  const label = isLink
    ? trimmed.replace(/^https?:\/\//i, "").slice(0, 60)
    : trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
  setStaged((current) => {
    if (current.some((item) => item.value === trimmed)) return current;
    if (current.length >= 16) return current;
    return [...current, { value: trimmed, label, isLink }];
  });
}
