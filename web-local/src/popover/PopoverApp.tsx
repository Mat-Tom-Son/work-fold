import { ExtensionQuestions } from "../components/chat/ExtensionQuestions";
import { WorkRequest } from "../components/chat/WorkRequest";
import { useApplicationAppearance } from "../hooks/useApplicationAppearance";
import { useWorkRequest } from "../hooks/useWorkRequest";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, File, History, Link2, Search, SquarePen, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { ApiError, api, createEventSource, errorText } from "../lib/api";
import { WorkFoldLockup } from "../components/brand/WorkFoldBrand";
import type { AssistantComposerState, ConversationRuntime, ChatStreamEvent, ExtensionUiRequest } from "../types";

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
  conversation: { id: string; title: string } | null;
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

interface FoldChat {
  id: string;
  title: string;
  updatedAt: string;
  archivedAt?: string | null;
  snoozedUntil?: string | null;
  requestState: string | null;
  needsAnswer?: boolean;
}

const fixtureChats: FoldChat[] = [
  { id: "fixture-fold", title: "Catch up on my Spaces", updatedAt: "2026-09-11T19:30:00Z", requestState: "done" },
  { id: "fixture-plan", title: "Plan next week’s workshop", updatedAt: "2026-09-10T16:00:00Z", requestState: "waiting", needsAnswer: true },
  { id: "fixture-notes", title: "Organize the field notes", updatedAt: "2026-09-09T15:00:00Z", requestState: "done" },
];

const activePhases = new Set(["working", "handed_off"]);
const terminalPhases = new Set(["done", "failed", "stopped"]);
const pollIntervalMs = 1_500;
const idlePollIntervalMs = 5_000;
const popoverFixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "fold";
const extensionFixtureRequested = popoverFixtureRequested && new URLSearchParams(window.location.search).get("extensions") === "1";

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
  useApplicationAppearance({ fixtureMode: popoverFixtureRequested });
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
  const [chats, setChats] = useState<FoldChat[]>(popoverFixtureRequested ? fixtureChats : []);
  const [chatTitle, setChatTitle] = useState(popoverFixtureRequested ? fixtureChats[0].title : "New chat");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [loadingChat, setLoadingChat] = useState(false);
  const workState = useWorkRequest(!popoverFixtureRequested && conversationId && !startingNewChat ? `/api/management/conversations/${encodeURIComponent(conversationId)}/work` : null);
  const [stopping, setStopping] = useState(false);
  const [banner, setBanner] = useState<string>("");
  const [dropActive, setDropActive] = useState(false);
  const [activity, setActivity] = useState<string>("");
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [managementComposer, setManagementComposer] = useState<AssistantComposerState | null>(popoverFixtureRequested ? popoverFixtureComposer : null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntime | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef<string | null>(popoverFixtureRequested ? "fixture-fold" : null);
  const refreshGeneration = useRef(0);
  const [extensionSnapshot, setExtensionSnapshot] = useState<{ conversationId: string; requests: ExtensionUiRequest[] } | null>(extensionFixtureRequested ? {
    conversationId: "fixture-fold", requests: [
      { id: "fixture-extension", method: "select", title: "Which account should I use for the report?", options: ["Work account", "Personal account"] },
    ],
  } : null);
  const draftsRef = useRef(new Map<string, { text: string; staged: StagedItem[] }>());
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
      if (selectionRef.current === id) setConversationRuntime(result.runtime);
    } catch {
      if (selectionRef.current === id) setConversationRuntime(null);
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
    const generation = ++refreshGeneration.current;
    const selectedId = selectionRef.current;
    try {
      const [summary, history] = await Promise.all([
        api<ManagementSummary>(selectedId ? `/api/management/summary?conversationId=${encodeURIComponent(selectedId)}` : "/api/management/summary"),
        api<{ conversations: FoldChat[] }>("/api/management/conversations").then(
          (result) => ({ chats: result.conversations, error: "" }),
          (error) => ({ chats: null, error: errorText(error) }),
        ),
      ]);
      if (generation !== refreshGeneration.current) return;
      if (history.chats) setChats(history.chats);
      setHistoryError(history.error);
      setAvailable(summary.available);
      setUnavailableReason(summary.available ? "" : summary.reason ?? "");
      if (startingNewChatRef.current) return;
      const nextConversationId = summary.conversation?.id ?? null;
      if (!nextConversationId) {
        // An empty desktop is a new-chat draft too. Another surface creating
        // a conversation later must not silently become this draft's target.
        startingNewChatRef.current = true;
        setStartingNewChat(true);
        setRequest(null);
        setMessages([]);
        replaceStreamingAssistant("");
        return;
      }
      const transcript = await api<{ messages: ManagementMessage[] }>(`/api/management/conversations/${encodeURIComponent(nextConversationId)}`);
      if (generation !== refreshGeneration.current) return;
      selectionRef.current = nextConversationId;
      setConversationId(nextConversationId);
      setChatTitle(summary.conversation?.title || "Untitled chat");
      setRequest(summary.latestRequest);
      const next = transcript.messages.filter((message) =>
        (message.role === "user" || message.role === "assistant") && (!message.kind || message.kind === "assistant_continuation"));
      // Polling refetches the same transcript most ticks; keeping the old
      // array identity for identical content spares re-renders and the
      // follow-scroll effect.
      setMessages((current) => (sameTranscript(current, next) ? current : next));
      if (!summary.latestRequest || !activePhases.has(summary.latestRequest.phase)) replaceStreamingAssistant("");
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (error instanceof ApiError && error.status === 404) {
        setRequest(null);
        setMessages([]);
        replaceStreamingAssistant("");
        setAvailable(true);
        setBanner("This chat is no longer available. Choose another chat or start a new one.");
        return;
      }
      const message = errorText(error);
      setAvailable(false);
      setUnavailableReason(message);
    } finally {
      if (generation === refreshGeneration.current) setLoadingChat(false);
    }
  }, [replaceStreamingAssistant]);

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
      if (selectionRef.current !== conversationId) return;
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(raw.data) as ChatStreamEvent;
      } catch {
        return;
      }
      if (event.type === "extension_ui_snapshot") setExtensionSnapshot({ conversationId, requests: event.requests ?? [] });
      if (event.type === "extension_ui_request" && event.request?.method === "notify") setActivity(event.request.message ?? "");
      if (event.type === "editor" && typeof event.text === "string") setText((current) => event.editorMode === "replace" ? event.text! : current + event.text);
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

  // Refresh saved Chats without replacing the person's selected conversation.
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
  // it — no running work hiding the composer — and focus has not landed
  // anywhere yet, the composer takes it.
  useEffect(() => {
    if (available !== true) return;
    // `phase` is a dependency so the composer regains focus the moment a
    // settled request brings it back, not only on the next window focus.
    const focusComposerFirst = () => {
      if (document.visibilityState === "hidden") return;
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
  }, [available, phase]);

  // Hiding the popover releases focus parked on a button or strip: Chromium
  // keeps DOM focus across hide/show, and a stale button would otherwise
  // swallow both the reopen keystrokes and the composer's first-focus claim.
  // Text entry (the composer) keeps its focus across reopens.
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

  const send = useCallback(async () => {
    const content = text.trim();
    const currentRequest = requestRef.current;
    if (!content || sending || loadingChat || stopping || (currentRequest && activePhases.has(currentRequest.phase))) return;
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
        conversationId: selectionRef.current,
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
      } else if (selectionRef.current) {
        body.conversationId = selectionRef.current;
        if (current?.phase === "needs_you") body.continuationTaskId = current.taskId;
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
      draftsRef.current.delete(selectionRef.current ?? "new");
      selectionRef.current = result.conversationId;
      setConversationId(result.conversationId);
      await refreshConversation();
    } catch (error) {
      setBanner(errorText(error));
    } finally {
      setSending(false);
    }
  }, [text, staged, sending, loadingChat, stopping, refreshConversation, replaceStreamingAssistant]);

  const selectChat = useCallback((id: string | null) => {
    if (sending || stopping || workState.busy) return;
    setHistoryOpen(false);
    setHistoryQuery("");
    if (id === selectionRef.current && (id || startingNewChatRef.current)) {
      window.setTimeout(() => composerRef.current?.focus(), 0);
      return;
    }
    draftsRef.current.set(selectionRef.current ?? "new", { text, staged });
    const draft = draftsRef.current.get(id ?? "new");
    setText(draft?.text ?? "");
    setStaged(draft?.staged ?? []);
    refreshGeneration.current++;
    selectionRef.current = id;
    startingNewChatRef.current = id === null;
    pendingSendIdentityRef.current = null;
    setStartingNewChat(id === null);
    setLoadingChat(Boolean(id) && !popoverFixtureRequested);
    setChatTitle(id ? chats.find((chat) => chat.id === id)?.title || "Untitled chat" : "New chat");
    setRequest(null);
    requestRef.current = null;
    setConversationId(id);
    setConversationRuntime(null);
    setMessages(popoverFixtureRequested && id ? popoverFixtureMessages : []);
    setActivity("");
    replaceStreamingAssistant("");
    setBanner("");
    void refreshConversation();
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }, [sending, stopping, workState.busy, text, staged, chats, refreshConversation, replaceStreamingAssistant]);
  const startNewChat = useCallback(() => selectChat(null), [selectChat]);

  useEffect(() => {
    if (historyOpen) searchRef.current?.focus();
  }, [historyOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Cancelling an IME composition must not dismiss the surface.
      if (event.isComposing) return;
      if (event.key === "Escape") {
        if (historyOpen) { setHistoryOpen(false); window.setTimeout(() => composerRef.current?.focus(), 0); }
        else bridge?.management?.hide();
      }
      // ⌘N/Ctrl+N mirrors the direct header action.
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge, startNewChat, historyOpen]);

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
  if (available === false && !conversationId) {
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
  const managementModelLabel = composerThinking?.model?.name || composerThinking?.model?.id || "Choose model";
  const visibleBanner = banner || (available === false ? unavailableReason : "");
  const backgroundChats = chats.filter((chat) => chat.id !== conversationId && (chat.requestState === "working" || chat.requestState === "handed_off"));
  const filteredChats = chats.filter((chat) => chat.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()));
  const navigationBusy = sending || stopping || workState.busy;

  const changeThinkingLevel = async (level: string) => {
    if (requestRunning || loadingChat || level === composerThinking?.thinkingLevel) return;
    const selectedId = selectionRef.current;
    try {
      if (conversationId && conversationRuntime && !startingNewChat) {
        const result = await api<{ runtime: ConversationRuntime }>(`/api/management/conversations/${encodeURIComponent(conversationId)}/thinking`, {
          method: "POST",
          body: { level },
        });
        if (selectionRef.current === selectedId) setConversationRuntime(result.runtime);
      } else {
        const result = await api<{ composer: AssistantComposerState }>("/api/agent/thinking", {
          method: "POST",
          body: { scope: "management", level },
        });
        setManagementComposer(result.composer);
      }
    } catch (error) {
      if (selectionRef.current === selectedId) setBanner(errorText(error));
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
          <button className="popover-new-chat" type="button" aria-expanded={historyOpen} aria-controls="fold-chat-history"
            onClick={() => { setHistoryOpen((open) => !open); void refreshConversation(); }}>
            <History aria-hidden="true" /><span>Chats</span>
          </button>
          <button
            className="popover-new-chat"
            type="button"
            onClick={startNewChat}
            disabled={navigationBusy}
            title="Start a new chat. This chat stays saved on your desktop."
          >
            <SquarePen aria-hidden="true" />
            <span>New chat</span>
          </button>
        </div>
      </header>

      {visibleBanner ? (
        <div className="banner" role="alert">
          <span className="banner-text">{visibleBanner}</span>
          <button className="banner-dismiss" type="button" aria-label="Dismiss" onClick={() => setBanner("")}><X aria-hidden="true" /></button>
        </div>
      ) : null}

      {historyOpen ? (
        <section className="fold-chat-history" id="fold-chat-history" aria-label="Saved fold chats">
          <div className="fold-history-heading">
            <button type="button" className="fold-back" aria-label="Back to chat" onClick={() => { setHistoryOpen(false); window.setTimeout(() => composerRef.current?.focus(), 0); }}><ArrowLeft aria-hidden="true" /></button>
            <h1>Chats</h1><span>On this desktop</span>
          </div>
          <label className="fold-chat-search"><Search aria-hidden="true" /><input ref={searchRef} type="search" aria-label="Search chats" placeholder="Search chats" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} /></label>
          {historyError ? <p className="error-line" role="alert">{historyError} <button type="button" onClick={() => void refreshConversation()}>Try again</button></p> : null}
          <div className="fold-chat-list">
            {draftsRef.current.get("new")?.text || draftsRef.current.get("new")?.staged.length ? <button className="fold-chat-row" type="button" disabled={navigationBusy} onClick={startNewChat}><span>New chat</span><small>Draft</small></button> : null}
            {filteredChats.map((chat) => (
              <button key={chat.id} className="fold-chat-row" type="button" aria-current={chat.id === conversationId ? "page" : undefined} disabled={navigationBusy} onClick={() => selectChat(chat.id)}>
                <span>{chat.title || "Untitled chat"}</span>
                <small><time dateTime={chat.updatedAt}>{chatDateLabel(chat.updatedAt)}</time>{chat.needsAnswer ? <em>Needs your answer</em> : chat.requestState === "working" || chat.requestState === "handed_off" ? <em>Working</em> : chat.archivedAt ? <em>Archived</em> : chat.snoozedUntil && Date.parse(chat.snoozedUntil) > now ? <em>Snoozed</em> : draftsRef.current.get(chat.id)?.text || draftsRef.current.get(chat.id)?.staged.length ? <em>Draft</em> : null}</small>
              </button>
            ))}
            {!filteredChats.length ? <p className="fold-history-empty">{historyQuery ? "No chats match your search." : "Your chats will appear here after you send a message."}</p> : null}
          </div>
        </section>
      ) : null}

      {backgroundChats.length ? <button type="button" className="fold-background-work" onClick={() => selectChat(backgroundChats[0].id)} disabled={navigationBusy}><span className="spinner" aria-hidden="true" /><span>{backgroundChats.length === 1 ? backgroundChats[0].title : `${backgroundChats.length} chats`} · Working</span><ChevronRight aria-hidden="true" /></button> : null}

      <div className="popover-chat" hidden={historyOpen}>
      <h1 className="fold-chat-title" title={chatTitle}>{chatTitle}</h1>

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
          {loadingChat ? <p className="muted small" role="status">Loading chat…</p> : !messages.length && !streamingAssistant && !request ? <div className="fold-chat-empty"><p>What would you like to work on?</p><span>Pick up a saved chat, or start here.</span></div> : null}
          {messages.map((message) => (
            <article
              className={message.kind === "assistant_continuation" ? "work-continuation" : `popover-message ${message.role}`}
              key={message.id}
              title={`${message.source === "remote_web" ? "Sent from the web · " : ""}${timestampTitle(message.createdAt)}`}
            >
              <div className="popover-message-body">
                {message.kind === "assistant_continuation" ? "Continuing with the results from delegated work." : message.role === "assistant"
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
          {request && request.phase === "handed_off" && !workState.work ? (
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
            <ResultEntry request={request} showState={!workState.work} />
          ) : null}
          {conversationId && extensionSnapshot?.conversationId === conversationId ? <ExtensionQuestions requests={extensionSnapshot.requests} scope={`management/${conversationId}`} respond={async (question, value, cancelled = false) => {
            const selectedId = conversationId;
            if (!popoverFixtureRequested) await api(`/api/management/conversations/${encodeURIComponent(selectedId)}/extension-ui/${encodeURIComponent(question.id)}`, { method: "POST", body: { value, cancelled } });
            setExtensionSnapshot((current) => current?.conversationId === selectedId ? { ...current, requests: current.requests.filter((item) => item.id !== question.id) } : current);
          }} /> : null}
          <WorkRequest {...workState} showProgress={request?.phase !== "working"} showStop={request?.phase === "needs_you"} />
        </section>
          {request && activePhases.has(request.phase) ? (
            <div className="fold-tail">
              {request.phase === "working" ? (
                <p className="working-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span className="working-copy">{activity || "Thinking…"}</span>
                  {elapsedLabel ? <span className="working-elapsed">{elapsedLabel}</span> : null}
                </p>
              ) : !workState.work ? (
                <p className="working-line" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span className="working-copy">Working in {request.children.filter((child) => child.state === "running").length === 1 ? "a Space" : "Spaces"}…</span></p>
              ) : null}
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
            disabled={requestRunning ? stopping : sending || loadingChat || available === false || !text.trim()}
          >
            {requestRunning
              ? stopping ? "Stopping…" : "Stop"
              : sending ? "Sending…" : staged.length ? "Fold it in" : "Send"}
          </button>
        </div>
      </section>
      </div>
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

function chatDateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/**
 * The settled request's inline conversation entry — the same host-recorded
 * outcome the old result card carried, absorbed into the one narrator.
 */
function ResultEntry({ request, showState = true }: { request: ManagementRequestView; showState?: boolean }) {
  const showOutcome = request.phase === "failed"
    || request.phase === "stopped"
    || request.dispositions.length > 0
    || request.actions.some((action) => action.command !== "files.add");
  if (!showOutcome) return null;
  return (
    <article className="popover-entry">
      {showState && request.phase === "failed" ? (
        <p className="error-line">Couldn't finish{request.error ? `: ${request.error}` : "."}</p>
      ) : null}
      {showState && request.phase === "stopped" ? <p>Stopped before it finished.</p> : null}
      <DispositionTrail request={showState ? request : { ...request, actions: request.actions.filter((action) => action.command !== "chat.send") }} />
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
