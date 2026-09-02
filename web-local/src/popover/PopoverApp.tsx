import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, File, Link2, SquarePen, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, api, createEventSource, errorText } from "../lib/api";
import { WorkFoldLockup } from "../components/brand/WorkFoldBrand";
import { NeedsYouStack, useNeedsYouDecisions } from "../components/NeedsYouDecisions";
import type { AssistantComposerState, ConversationRuntime } from "../types";

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
    /** `library` is Space-free: the attachment entered the personal Library through an attributed `library add`. */
    status: "placed" | "registered" | "library" | "unrecorded";
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

function managementTurnIdentity(prefix: "request" | "message"): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
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
const terminalPhases = new Set(["done", "failed", "stopped"]);
const pollIntervalMs = 1_500;
const idlePollIntervalMs = 5_000;
const popoverFixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "fold";

const popoverFixtureMessages: ManagementMessage[] = [
  {
    id: "fixture-user-1",
    role: "user",
    content: "What changed while I was away?",
    createdAt: "2026-09-02T13:30:00.000Z",
  },
  {
    id: "fixture-assistant-1",
    role: "assistant",
    content: [
      "Two Spaces moved forward:",
      "",
      "- **Launch plan** — the draft is ready and its Check passed.",
      "- **Field notes** — three duplicates need your choice.",
      "",
      "I can open either one or hand off the next step.",
    ].join("\n"),
    createdAt: "2026-09-02T13:31:00.000Z",
  },
];

const popoverFixtureComposer: AssistantComposerState = {
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet" },
  thinkingLevel: "medium",
  thinkingLevels: ["low", "medium", "high"],
};

export function PopoverApp() {
  const bridge = window.workFoldDesktop;
  const [available, setAvailable] = useState<boolean | null>(popoverFixtureRequested ? true : null);
  const [unavailableReason, setUnavailableReason] = useState<string>("");
  const [request, setRequest] = useState<ManagementRequestView | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(popoverFixtureRequested ? "fixture-fold" : null);
  const [messages, setMessages] = useState<ManagementMessage[]>(popoverFixtureRequested ? popoverFixtureMessages : []);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [startingNewChat, setStartingNewChat] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [banner, setBanner] = useState<string>("");
  const [dropActive, setDropActive] = useState(false);
  const [activity, setActivity] = useState<string>("");
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [managementComposer, setManagementComposer] = useState<AssistantComposerState | null>(popoverFixtureRequested ? popoverFixtureComposer : null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntime | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRef = useRef<HTMLElement | null>(null);
  const transcriptPinnedRef = useRef(true);
  const dragDepthRef = useRef(0);
  const streamingDeltaRef = useRef("");
  const streamingFrameRef = useRef<number | null>(null);
  const requestRef = useRef<ManagementRequestView | null>(null);
  const pendingSendIdentityRef = useRef<{
    signature: string;
    requestId: string;
    userMessageId: string;
  } | null>(null);
  const startingNewChatRef = useRef(false);
  requestRef.current = request;
  // Durable pending decisions are their own object, distinct from the
  // conversational needs_you phase; deciding here records surface "popover".
  const needsYou = useNeedsYouDecisions({ surface: "popover", enabled: !popoverFixtureRequested });
  const refreshNeedsYou = needsYou.refresh;

  const refreshManagementComposer = useCallback(async () => {
    if (popoverFixtureRequested) return;
    try {
      const result = await api<{ composer: AssistantComposerState }>("/api/agent/composer?scope=management");
      setManagementComposer(result.composer);
    } catch {
      // Model setup is a convenience affordance, not popover availability.
      // Keep the last known composer state if this optional read is unavailable.
    }
  }, []);

  const refreshConversationRuntime = useCallback(async (id: string) => {
    if (popoverFixtureRequested) return;
    try {
      const result = await api<{ runtime: ConversationRuntime }>(`/api/management/conversations/${encodeURIComponent(id)}/runtime`);
      setConversationRuntime(result.runtime);
    } catch {
      setConversationRuntime(null);
    }
  }, []);

  const flushStreamingAssistant = useCallback(() => {
    if (streamingFrameRef.current !== null) {
      window.cancelAnimationFrame(streamingFrameRef.current);
      streamingFrameRef.current = null;
    }
    const delta = streamingDeltaRef.current;
    streamingDeltaRef.current = "";
    if (delta) setStreamingAssistant((current) => current + delta);
  }, []);

  const queueStreamingAssistant = useCallback((delta: string) => {
    streamingDeltaRef.current += delta;
    if (streamingFrameRef.current !== null) return;
    streamingFrameRef.current = window.requestAnimationFrame(flushStreamingAssistant);
  }, [flushStreamingAssistant]);

  const replaceStreamingAssistant = useCallback((text: string) => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
    streamingFrameRef.current = null;
    streamingDeltaRef.current = "";
    setStreamingAssistant(text);
  }, []);

  useEffect(() => () => {
    if (streamingFrameRef.current !== null) window.cancelAnimationFrame(streamingFrameRef.current);
  }, []);

  const refreshConversation = useCallback(async () => {
    if (popoverFixtureRequested) return;
    void refreshNeedsYou();
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
        replaceStreamingAssistant("");
        return;
      }
      const transcript = await api<{ messages: ManagementMessage[] }>(`/api/management/conversations/${encodeURIComponent(nextConversationId)}`);
      const next = transcript.messages.filter((message) =>
        (message.role === "user" || message.role === "assistant") && !message.kind);
      // Polling refetches the same transcript most ticks; keeping the old
      // array identity for identical content spares re-renders and the
      // follow-scroll effect.
      setMessages((current) => (sameTranscript(current, next) ? current : next));
      if (!summary.latestRequest || !activePhases.has(summary.latestRequest.phase)) replaceStreamingAssistant("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setRequest(null);
        setConversationId(null);
        setMessages([]);
        replaceStreamingAssistant("");
        setAvailable(true);
        setBanner("That request belonged to an earlier app run. Start a new request to continue.");
        return;
      }
      const message = errorText(error);
      setAvailable(false);
      setUnavailableReason(message);
      setBanner(message);
    }
  }, [refreshNeedsYou, replaceStreamingAssistant]);

  useEffect(() => {
    void refreshConversation();
    void refreshManagementComposer();
  }, [refreshConversation, refreshManagementComposer]);

  // Staged material handed over by the tray (macOS icon drops).
  useEffect(() => {
    if (popoverFixtureRequested) return;
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
    if (!conversationId || popoverFixtureRequested) return;
    const stream = createEventSource(`/api/management/conversations/${encodeURIComponent(conversationId)}/events`);
    stream.onmessage = (raw) => {
      let event: { type?: string; message?: string; toolName?: string; text?: string; running?: boolean };
      try {
        event = JSON.parse(raw.data) as { type?: string; message?: string; toolName?: string; text?: string; running?: boolean };
      } catch {
        return;
      }
      if (event.type === "status" || event.type === "tool") {
        const message = typeof event.message === "string" && event.message !== "Connected." ? event.message.trim() : "";
        const tool = event.type === "tool" && typeof event.toolName === "string" ? event.toolName.trim() : "";
        if (message || tool) setActivity(message || tool);
      }
      if (event.type === "turn_snapshot" && typeof event.text === "string") {
        replaceStreamingAssistant(event.text);
      }
      if (event.type === "assistant_delta" && typeof event.text === "string") {
        queueStreamingAssistant(event.text);
      }
      if (event.type === "assistant_message" && typeof event.text === "string") {
        replaceStreamingAssistant(event.text);
      }
      if (event.type === "turn_state" || event.type === "done" || event.type === "error") {
        if (event.type === "done" || event.type === "error" || event.running === false) flushStreamingAssistant();
        if (event.type === "done" || event.type === "error" || event.running === false) void refreshConversationRuntime(conversationId);
        void refreshConversation();
      }
    };
    return () => stream.close();
  }, [conversationId, refreshConversation, refreshConversationRuntime, flushStreamingAssistant, queueStreamingAssistant, replaceStreamingAssistant]);

  useEffect(() => {
    if (popoverFixtureRequested) return;
    replaceStreamingAssistant("");
    if (conversationId) void refreshConversationRuntime(conversationId);
    else setConversationRuntime(null);
  }, [conversationId, refreshConversationRuntime, replaceStreamingAssistant]);

  // Poll quickly while work is active and quietly while idle. The latter keeps
  // the persistent popover aligned when the web surface starts a fresh chat.
  const phase = request?.phase ?? null;
  useEffect(() => {
    if (popoverFixtureRequested) return;
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
    if (popoverFixtureRequested) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        void refreshConversation();
        void refreshManagementComposer();
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refreshConversation, refreshManagementComposer]);

  // Pending decisions stay a compact disclosure above the always-visible
  // conversation. A newly pending decision opens once, and the disclosure
  // folds back when nothing remains.
  const decisionCount = needsYou.cards.length;
  const decisionNotice = needsYou.notice;
  const prevDecisionCountRef = useRef(0);
  useEffect(() => {
    const previous = prevDecisionCountRef.current;
    prevDecisionCountRef.current = decisionCount;
    if (decisionCount > 0 && previous === 0) setDecisionsOpen(true);
    else if (decisionCount === 0 && !decisionNotice) setDecisionsOpen(false);
  }, [decisionCount, decisionNotice]);

  useEffect(() => {
    transcriptPinnedRef.current = true;
  }, [conversationId]);

  // The transcript follows every streamed frame and compact status change only
  // while the person is at (or near) the bottom. A frame runs after layout so
  // a growing Markdown reply and the shrinking/growing live tail are measured
  // at their final height before the scroll is applied.
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !transcriptPinnedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (transcriptPinnedRef.current) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, phase, streamingAssistant, activity, conversationId]);

  // The door comes first: whenever the shown popover has nothing that outranks
  // it — no pending decision, no running work hiding the composer — and focus
  // has not landed anywhere yet, the composer takes it.
  useEffect(() => {
    if (available !== true) return;
    // `phase` is a dependency so the composer regains focus the moment a
    // settled request brings it back, not only on the next window focus.
    const focusComposerFirst = () => {
      if (document.visibilityState === "hidden") return;
      if (decisionCount > 0) return;
      const current = requestRef.current;
      if (current && activePhases.has(current.phase)) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      composerRef.current?.focus();
    };
    focusComposerFirst();
    window.addEventListener("focus", focusComposerFirst);
    document.addEventListener("visibilitychange", focusComposerFirst);
    return () => {
      window.removeEventListener("focus", focusComposerFirst);
      document.removeEventListener("visibilitychange", focusComposerFirst);
    };
  }, [available, decisionCount, phase]);

  // Hiding the popover releases focus parked on a button or strip: Chromium
  // keeps DOM focus across hide/show, and a stale button would otherwise
  // swallow both the reopen keystrokes and the composer's first-focus claim.
  // Text entry (composer, a decision note) keeps its focus across reopens.
  useEffect(() => {
    const releaseStaleFocus = () => {
      if (document.visibilityState !== "hidden") return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return;
      if (active.matches("textarea, input, [contenteditable]")) return;
      active.blur();
    };
    document.addEventListener("visibilitychange", releaseStaleFocus);
    return () => document.removeEventListener("visibilitychange", releaseStaleFocus);
  }, []);

  // The only disclosure left is the exceptional decision stack. Expanding it
  // moves focus into the card; the ordinary conversation never folds away.
  const toggleDecisions = useCallback(() => {
    const next = !decisionsOpen;
    setDecisionsOpen(next);
    if (!next) return;
    window.requestAnimationFrame(() => {
      const drawer = document.getElementById("popover-decisions");
      if (!drawer) return;
      const target = drawer.querySelector<HTMLElement>("button, [href], input, textarea, select, summary");
      (target ?? drawer).focus();
    });
  }, [decisionsOpen]);

  const send = useCallback(async () => {
    const content = text.trim();
    const currentRequest = requestRef.current;
    if (!content || sending || (currentRequest && activePhases.has(currentRequest.phase))) return;
    setSending(true);
    setBanner("");
    setActivity("");
    replaceStreamingAssistant("");
    try {
      const current = requestRef.current;
      const signature = JSON.stringify({
        content,
        attachments: staged.map((item) => item.value),
        newConversation: startingNewChatRef.current,
        conversationId: current?.phase === "needs_you" ? current.conversationId : null,
        continuationTaskId: current?.phase === "needs_you" ? current.taskId : null,
      });
      const identity = pendingSendIdentityRef.current?.signature === signature
        ? pendingSendIdentityRef.current
        : {
            signature,
            requestId: managementTurnIdentity("request"),
            userMessageId: managementTurnIdentity("message"),
          };
      pendingSendIdentityRef.current = identity;
      const body: Record<string, unknown> = {
        content,
        requestId: identity.requestId,
        userMessageId: identity.userMessageId,
      };
      if (staged.length) body.attachments = staged.map((item) => item.value);
      if (startingNewChatRef.current) {
        body.newConversation = true;
      } else if (current && current.phase === "needs_you") {
        body.conversationId = current.conversationId;
        body.continuationTaskId = current.taskId;
      }
      const result = await api<{ taskId: string; conversationId: string }>(
        "/api/management/messages",
        { method: "POST", body, idempotent: true },
      );
      startingNewChatRef.current = false;
      pendingSendIdentityRef.current = null;
      setStartingNewChat(false);
      // Clear only what was submitted; keystrokes that landed while the send
      // was in flight stay in the box.
      setText((current) => (current === text ? "" : current));
      setStaged([]);
      setConversationId(result.conversationId);
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setSending(false);
    }
  }, [text, staged, sending, refreshConversation, replaceStreamingAssistant]);

  const startNewChat = useCallback(() => {
    if (sending || startingNewChatRef.current) return;
    // While work runs, the request keeps its live tail and Stop on screen; a
    // clean slate now would orphan a turn that continues server-side.
    const current = requestRef.current;
    if (current && activePhases.has(current.phase)) return;
    startingNewChatRef.current = true;
    pendingSendIdentityRef.current = null;
    setStartingNewChat(true);
    setRequest(null);
    setConversationId(null);
    setMessages([]);
    setActivity("");
    replaceStreamingAssistant("");
    setBanner("New chat ready. Your previous chat is still saved on this desktop.");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [sending, replaceStreamingAssistant]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Cancelling an IME composition must not dismiss the surface.
      if (event.isComposing) return;
      if (event.key === "Escape") {
        bridge?.management?.hide();
      }
      // ⌘N/Ctrl+N mirrors the direct header action.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge, startNewChat]);

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
    dragDepthRef.current = 0;
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
    // A staged chip waits for its instruction — put the cursor where the
    // instruction goes.
    if (added) composerRef.current?.focus();
  }, [bridge]);

  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  }, []);

  // Pasting a lone link into an empty composer stages it as a reference chip,
  // the same treatment a dropped or tray-staged link gets. Pasting into or
  // around existing text stays plain text.
  const onComposerPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData.getData("text/plain").trim();
    if (!pasted || !looksLikeLink(pasted) || /\s/.test(pasted)) return;
    if (event.currentTarget.value.trim()) return;
    event.preventDefault();
    addStagedValue(pasted, setStaged);
  }, []);

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
        <header className="popover-header">
          <button className="popover-open-app" type="button" onClick={() => { void bridge?.management?.openMainWindow(); }}>Open app</button>
        </header>
        <div className="card">
          <p>Your fold is unavailable.</p>
          {unavailableReason ? <p className="muted small">{unavailableReason}</p> : null}
        </div>
      </div>
    );
  }

  const requestRunning = request !== null && activePhases.has(request.phase);
  const composerPlaceholder = requestRunning
    ? "Draft a follow-up"
    : request?.phase === "needs_you"
      ? "Reply to work-fold"
      : "Tell work-fold what to do";
  const composerThinking = conversationRuntime && !startingNewChat ? conversationRuntime : managementComposer;
  const thinkingLevels = composerThinking?.thinkingLevels ?? [];
  const managementModelLabel = managementComposer?.model?.name || managementComposer?.model?.id || "Choose model";

  const changeThinkingLevel = async (level: string) => {
    if (requestRunning || level === composerThinking?.thinkingLevel) return;
    try {
      if (conversationId && conversationRuntime && !startingNewChat) {
        const result = await api<{ runtime: ConversationRuntime }>(`/api/management/conversations/${encodeURIComponent(conversationId)}/thinking`, {
          method: "POST",
          body: { level },
        });
        setConversationRuntime(result.runtime);
      } else {
        const result = await api<{ composer: AssistantComposerState }>("/api/agent/thinking", {
          method: "POST",
          body: { scope: "management", level },
        });
        setManagementComposer(result.composer);
      }
    } catch (error) {
      setBanner(errorText(error));
    }
  };

  return (
    <div
      className={`popover${dropActive ? " drop-active" : ""}${popoverFixtureRequested ? " popover-fixture" : ""}`}
      onDragEnter={onDragEnter}
      onDragOver={(event) => { event.preventDefault(); }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="popover-header">
        <button className="popover-open-app" type="button" onClick={() => { void bridge?.management?.openMainWindow(); }}>Open app</button>
        <div className="popover-header-actions">
          <button
            className="popover-new-chat"
            type="button"
            onClick={startNewChat}
            disabled={sending || startingNewChat || (request !== null && activePhases.has(request.phase))}
            title="Start a new chat. This chat stays saved on your desktop."
          >
            <SquarePen aria-hidden="true" />
            <span>New chat</span>
          </button>
        </div>
      </header>

      {banner ? (
        <div className="banner" role="alert">
          <span className="banner-text">{banner}</span>
          <button className="banner-dismiss" type="button" aria-label="Dismiss" onClick={() => setBanner("")}><X aria-hidden="true" /></button>
        </div>
      ) : null}

      {decisionCount > 0 || decisionNotice ? (
        <section className="fold-section fold-section-decisions">
          {decisionCount > 0 ? (
            <button
              type="button"
              className="fold-strip fold-strip-decisions"
              aria-expanded={decisionsOpen}
              aria-controls="popover-decisions"
              onClick={toggleDecisions}
            >
              <span>{decisionCount === 1 ? "1 decision needs you" : `${decisionCount} decisions need you`}</span>
              <ChevronRight className="fold-strip-chevron" aria-hidden="true" />
            </button>
          ) : null}
          {decisionsOpen ? (
            <div id="popover-decisions" className="fold-drawer" tabIndex={-1}>
              <NeedsYouStack state={needsYou} presentation="single" />
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="fold-section fold-section-conversation">
        <section
          className="popover-transcript"
          id="popover-conversation"
          ref={transcriptRef}
          aria-label="Your fold" aria-live="polite"
          tabIndex={-1}
          onScroll={(event) => {
            const target = event.currentTarget;
            transcriptPinnedRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
          }}
        >
          {messages.map((message) => (
            <article
              className={`popover-message ${message.role}`}
              key={message.id}
              title={`${message.source === "remote_web" ? "Sent from the web · " : ""}${timestampTitle(message.createdAt)}`}
            >
              <div className="popover-message-body">
                {message.role === "assistant"
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                  : message.content}
              </div>
            </article>
          ))}
          {streamingAssistant ? (
            <article className="popover-message assistant streaming" aria-label="work-fold is replying">
              <div className="popover-message-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingAssistant}</ReactMarkdown>
              </div>
            </article>
          ) : null}
          {request && request.phase === "handed_off" ? (
            <article className="popover-entry">
              <ul className="trail">
                {request.children.map((child) => (
                  <li key={child.taskId}>
                    {child.state === "running" ? <span className="spinner" aria-hidden="true" /> : <Tick state={child.state} />}
                    <span>{child.spaceName}: {childStateLabel(child.state)}</span>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
          {request && !activePhases.has(request.phase) ? (
            <ResultEntry request={request} />
          ) : null}
        </section>
          {request && activePhases.has(request.phase) ? (
            <div className="fold-tail">
              {request.phase === "working" ? (
                <p className="working-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span className="working-copy">{activity || "Thinking…"}</span>
                  {elapsedLabel ? <span className="working-elapsed">{elapsedLabel}</span> : null}
                </p>
              ) : (
                <p className="working-line" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span className="working-copy">Working in {request.children.filter((child) => child.state === "running").length === 1 ? "a Space" : "Spaces"}…</span></p>
              )}
            </div>
          ) : null}
      </section>

      {staged.length ? (
        // Staged material renders even while a turn hides the composer, so a
        // mid-turn drop is confirmed on screen instead of surfacing later.
        <ul className="chips">
          {staged.map((item) => (
            <li key={item.value} className="chip" title={item.value}>
              <span className="chip-kind" aria-hidden="true">{item.isLink ? <Link2 /> : <File />}</span>
              <span className="chip-label">{item.label}</span>
              <button className="chip-remove" aria-label={`Remove ${item.label}`} onClick={() => removeStaged(item.value)}><X /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="composer">
        <div className="composer-field">
          <div className="composer-input">
            <textarea
              ref={composerRef}
              rows={1}
              aria-label={composerPlaceholder}
              placeholder={composerPlaceholder}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onPaste={onComposerPaste}
              onKeyDown={(event) => {
                // Enter sends when idle; while a turn streams, the composer is a
                // safe draft area and the action becomes Stop.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !requestRunning) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-controls">
              <button
                className="composer-model"
                type="button"
                onClick={() => { void bridge?.management?.openAssistantSettings(); }}
                aria-label={`Change the model used by The fold. Current model: ${managementModelLabel}`}
                title="Change the model used by The fold"
              >
                <span>{managementModelLabel}</span>
              </button>
              {thinkingLevels.length >= 2 && composerThinking ? (
                <select
                  className="composer-thinking"
                  value={composerThinking.thinkingLevel}
                  disabled={requestRunning}
                  onChange={(event) => { void changeThinkingLevel(event.target.value); }}
                  aria-label={`Reasoning level for this fold chat: ${composerThinking.thinkingLevel}`}
                  title={requestRunning ? "Reasoning can change between turns" : "Reasoning level for this fold chat"}
                >
                  {thinkingLevels.map((level) => <option key={level} value={level}>{formatThinkingLevel(level)}</option>)}
                </select>
              ) : null}
            </div>
          </div>
          <button
            className={`composer-action${requestRunning ? " composer-stop" : " primary"}`}
            onClick={() => { if (requestRunning) void stop(); else void send(); }}
            disabled={requestRunning ? stopping : sending || !text.trim()}
          >
            {requestRunning
              ? stopping ? "Stopping…" : "Stop"
              : sending ? "Sending…" : staged.length ? "Fold it in" : "Send"}
          </button>
        </div>
      </section>
      {dropActive ? (
        <div className="drop-overlay" role="status" aria-live="polite">
          <File aria-hidden="true" />
          <strong>Drop to add</strong>
          <span>Files, folders, or links</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The settled request's inline conversation entry — the same host-recorded
 * outcome the old result card carried, absorbed into the one narrator.
 */
function ResultEntry({ request }: { request: ManagementRequestView }) {
  const showOutcome = request.phase === "failed"
    || request.phase === "stopped"
    || request.dispositions.length > 0
    || request.actions.some((action) => action.command !== "files.add");
  if (!showOutcome) return null;
  return (
    <article className="popover-entry">
      {request.phase === "failed" ? (
        <p className="error-line">Couldn't finish{request.error ? `: ${request.error}` : "."}</p>
      ) : null}
      {request.phase === "stopped" ? <p>Stopped before it finished.</p> : null}
      <DispositionTrail request={request} />
    </article>
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
                : disposition.status === "library"
                  ? <>Added {disposition.attachment.name} to your Library</>
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

function timestampTitle(value: string): string | undefined {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : undefined;
}

function sameTranscript(current: ManagementMessage[], next: ManagementMessage[]): boolean {
  if (current.length !== next.length) return false;
  return current.every((message, index) => {
    const candidate = next[index];
    return candidate !== undefined && message.id === candidate.id && message.content === candidate.content;
  });
}

function formatThinkingLevel(level: string): string {
  return level ? `${level[0]?.toLocaleUpperCase() ?? ""}${level.slice(1)}` : "Reasoning";
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
