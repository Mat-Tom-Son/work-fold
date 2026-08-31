import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { ArrowDown20Regular, ArrowUp20Regular } from "@fluentui/react-icons";
import { AlertTriangle, Archive, CircleCheck, Clock3, Loader2, Square, X } from "lucide-react";

import { chatDraftDebounceMs, genericChatEmptyGreetings, spacePathDragType } from "../../constants";
import { createFixtureContextAttachment, fixtureConversationSummary } from "../../fixtures/shared";
import { ApiError, api, createEventSource, errorText, isTransientNetworkError, rawErrorMessage } from "../../lib/api";
import { createChatTurnStateGate, observeChatTurnState } from "../../lib/chat-turn-state";
import { hasNativeFiles } from "../../lib/file-actions";
import { displayAssistantModelLabel } from "../../lib/model-display";
import {
  chatDisplayTitle,
  chatDraftStorageKey,
  clearStoredChatDraft,
  clearStoredPendingChatSend,
  formatBytes,
  latestTranscriptTime,
  modelConversationTitle,
  readStoredChatDraft,
  readStoredPendingChatSend,
  writeStoredChatDraft,
  writeStoredPendingChatSend,
} from "../../lib/format";
import { latestAssistantMessageId as findLatestAssistantMessageId, settledTurnHasNewAssistantMessage } from "../../lib/chat-turn-artifacts";
import { dismissRestrictedAppProposal, installRestrictedAppProposal } from "../../lib/restricted-apps";
import { resolveFixtureSpacePathCandidates } from "../../lib/space-path-links";
import { spaceIdentityFor, spaceIdentityStyle, type SpaceIdentity } from "../../lib/space-identity";
import type { AgentCatalog, AgentCommand, AgentStatus, AssistantComposerState, ChatContextPathRequest,
  ChatDraftRequest, ChatLifecycleView, ChatMessage, ChatStreamEvent, ContextAttachment, ConversationRuntime, ConversationSummary, ExtensionUiRequest, PendingChatSend, RestrictedAppInstalled, RestrictedAppProposal, RuntimePreviewEntry, TreeEntry, SpaceCustomizationMap, SpaceFixtureConversation, SpaceSummary } from "../../types";
import { useModalDialog } from "../../hooks/useModalDialog";
import { Banner, FluentGlyph, SpaceIconGlyph } from "../chrome/common";
import { RestrictedAppReviewDialog } from "../panes/RestrictedAppsSection";
import { FileTypeIcon } from "../tree/FileTree";
import { RuntimeContextPreview } from "./activity";
import { composerCommandQuery, composerCommandValue, matchingComposerCommands } from "./command-menu";
import { ChatMessageRow, MarkdownMessage, copyMarkdownToClipboard } from "./messages";
import { showToast } from "../../ui/feedback";

const emptyFixtureTreeEntries: TreeEntry[] = [];
const fixtureComposerCommands: AgentCommand[] = [
  { name: "skill:trip-planner", description: "Plan a trip from confirmed details and preferences", source: "skill" },
  { name: "compact", description: "Compact this Chat's working context", source: "builtin" },
  { name: "model", description: "Choose the model for this Chat", source: "builtin" },
];
const fixtureConversationRuntime: ConversationRuntime = {
  sessionId: "fixture-session",
  model: { provider: "openrouter", id: "anthropic/claude-sonnet-4", name: "Claude Sonnet" },
  usage: {
    contextTokens: 18_400,
    contextWindow: 128_000,
    contextPercent: 14.375,
    totalTokens: 26_700,
    cost: 0,
  },
  thinkingLevel: "medium",
  thinkingLevels: ["off", "minimal", "low", "medium", "high"],
  activeTools: [],
  isStreaming: false,
  isCompacting: false,
};

/**
 * Extracts pasted image files from the clipboard as a fresh DataTransfer with
 * descriptive names, or null when the paste carries no images (plain text
 * pastes stay untouched).
 */
export function pastedImageTransfer(clipboard: DataTransfer | null, now: Date = new Date()): DataTransfer | null {
  if (!clipboard) return null;
  const images = Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
  if (!images.length) return null;
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}.${String(now.getMinutes()).padStart(2, "0")}.${String(now.getSeconds()).padStart(2, "0")}`;
  const transfer = new DataTransfer();
  images.forEach((file, index) => {
    const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : `.${file.type.split("/")[1] ?? "png"}`;
    const name = file.name && file.name !== `image${extension}`
      ? file.name
      : `Pasted image ${stamp}${images.length > 1 ? ` (${index + 1})` : ""}${extension}`;
    transfer.items.add(new File([file], name, { type: file.type, lastModified: file.lastModified }));
  });
  return transfer;
}

function clientTurnIdentity(prefix: "request" | "message" | "chat"): string {
  const value = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export function ChatPanel({
  surfaceTabId,
  space,
  spaceCustomizations,
  assistantConfigurationRevision = 0,
  active = true,
  targetConversationId = null,
  contextPathRequest,
  draftRequest = null,
  onAddPathToChatContext,
  onUploadDroppedFiles,
  onOpenSpaceFile,
  selectedPath,
  onConversationActivated,
  onConversationsChanged,
  onRunningChange,
  onSettled,
  onViewed,
  lifecycleView = "active",
  onResumeConversation,
  onAgentFinished,
  onRestrictedAppInstalled,
  onRestrictedAppProposalRequested,
  onOpenModelSettings,
  fixtureMode = false,
  fixtureConversations,
  fixtureTreeEntries = emptyFixtureTreeEntries,
}: {
  surfaceTabId: string;
  space: SpaceSummary;
  spaceCustomizations: SpaceCustomizationMap;
  assistantConfigurationRevision?: number;
  active?: boolean;
  targetConversationId?: string | null;
  contextPathRequest: ChatContextPathRequest | null;
  draftRequest?: ChatDraftRequest | null;
  onAddPathToChatContext?: (path: string) => void;
  onUploadDroppedFiles?: (dataTransfer: DataTransfer) => Promise<string[]>;
  onOpenSpaceFile?: (path: string) => void;
  selectedPath: string | null;
  onConversationActivated?: (conversation: ConversationSummary | null) => void;
  onConversationsChanged?: (conversations: ConversationSummary[]) => void;
  onRunningChange?: (conversationId: string, running: boolean) => void;
  onSettled?: (conversationId: string, needsAttention: boolean) => void;
  onViewed?: (conversationId: string) => void;
  lifecycleView?: ChatLifecycleView;
  onResumeConversation?: () => void | Promise<void>;
  onAgentFinished: () => void | Promise<void>;
  onRestrictedAppInstalled?: (app: RestrictedAppInstalled) => void;
  onRestrictedAppProposalRequested?: () => void;
  onOpenModelSettings?: () => void;
  fixtureMode?: boolean;
  fixtureConversations?: SpaceFixtureConversation[];
  fixtureTreeEntries?: TreeEntry[];
}) {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const activeRef = useRef(active);
  const onRunningChangeRef = useRef(onRunningChange);
  const onSettledRef = useRef(onSettled);
  const onViewedRef = useRef(onViewed);
  activeRef.current = active;
  onRunningChangeRef.current = onRunningChange;
  onSettledRef.current = onSettled;
  onViewedRef.current = onViewed;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<ChatMessage[]>([]);
  const turnPreviousAssistantMessageIdRef = useRef<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  // One draft queued behind the running turn: Enter mid-turn holds it as a
  // visible, cancellable bubble and it sends when the turn settles. Further
  // Enters append to it; Stop and cancel return it to the composer.
  const [queuedSend, setQueuedSend] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [runtimePreviews, setRuntimePreviews] = useState<RuntimePreviewEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contextAttachments, setContextAttachments] = useState<ContextAttachment[]>([]);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);
  const [activeContextPath, setActiveContextPath] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedCommandDraft, setDismissedCommandDraft] = useState<string | null>(null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntime | null>(null);
  const [configuredAssistant, setConfiguredAssistant] = useState<AgentStatus | null>(null);
  const [assistantComposer, setAssistantComposer] = useState<AssistantComposerState | null>(null);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest | null>(null);
  const [appProposal, setAppProposal] = useState<RestrictedAppProposal | null>(null);
  const [appProposalBusy, setAppProposalBusy] = useState(false);
  const appProposalVersionsRef = useRef(new Map<string, Pick<RestrictedAppProposal, "status" | "updatedAt">>());
  const emptyStateGreeting = useMemo(() => randomChatEmptyGreeting(), []);
  const spaceIdentity = useMemo(
    () => spaceIdentityFor(space, spaceCustomizations),
    [space, spaceCustomizations],
  );

  useEffect(() => {
    if (conversation?.id) onRunningChangeRef.current?.(conversation.id, running);
  }, [conversation?.id, running]);

  useEffect(() => {
    if (active && conversation?.id) onViewedRef.current?.(conversation.id);
  }, [active, conversation?.id]);
  // The composer takes focus whenever this Chat tab becomes the active one, so
  // typing works immediately — without stealing from a dialog, another text
  // field, or an editor the person is already in.
  useEffect(() => {
    if (!active || lifecycleView !== "active") return;
    // A zero timeout (not rAF) so the focus claim also lands while the window
    // is occluded or freshly restored, after the activation commit settles.
    const timer = window.setTimeout(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused !== document.body
        && (focused.matches("input, textarea, select, [contenteditable]") || focused.closest('[role="dialog"]'))) return;
      composerTextareaRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, conversation?.id, lifecycleView]);
  // Cmd/Ctrl+. stops the running turn from anywhere in the active Chat.
  useEffect(() => {
    if (!active || !running) return;
    function stopKeydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ".") {
        event.preventDefault();
        void abortTurn();
      }
    }
    window.addEventListener("keydown", stopKeydown);
    return () => window.removeEventListener("keydown", stopKeydown);
  }, [active, running]);
  const [userPinnedToBottom, setUserPinnedToBottom] = useState(true);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const userPinnedToBottomRef = useRef(true);
  const streamingBufferRef = useRef("");
  const streamingFlushRef = useRef<number | null>(null);
  const activeThinkingPreviewIdRef = useRef<string | null>(null);
  const runtimePreviewIdRef = useRef(0);
  const spaceIdRef = useRef(space.id);
  const eventStreamReadyConversationIdRef = useRef<string | null>(null);
  const pendingSendRef = useRef<PendingChatSend | null>(null);
  const postingPendingSendRef = useRef(false);
  const suppressMessageEnterIdsRef = useRef<Set<string>>(new Set());
  const transientConversationIdsRef = useRef<Set<string>>(new Set());
  const scriptPlaybackStateRef = useRef<"idle" | "playing" | "done">("idle");
  const scriptPlaybackTimerRef = useRef<number | null>(null);
  const activeDraftStorageKeyRef = useRef<string | null>(null);
  const draftRef = useRef(draft);
  const draftStorageKey = useMemo(
    () => chatDraftStorageKey(
      space.id,
      targetConversationId ?? conversation?.id ?? null,
      surfaceTabId === `chat:${space.id}:new` ? null : surfaceTabId,
    ),
    [space.id, targetConversationId, conversation?.id, surfaceTabId],
  );
  const runtimePreviewScrollKey = useMemo(
    () => runtimePreviews.map((entry) => `${entry.id}:${entry.phase ?? ""}:${entry.text.length}`).join("|"),
    [runtimePreviews],
  );
  const commandQuery = useMemo(() => composerCommandQuery(draft), [draft]);
  const commandSuggestions = useMemo(
    () => commandQuery === null ? [] : matchingComposerCommands(commands, commandQuery),
    [commandQuery, commands],
  );
  const commandMenuOpen = commandQuery !== null
    && dismissedCommandDraft !== draft
    && commandSuggestions.length > 0;
  runningRef.current = running;
  messagesRef.current = messages;

  function beginTurnArtifactTracking(): void {
    if (turnPreviousAssistantMessageIdRef.current !== undefined) return;
    turnPreviousAssistantMessageIdRef.current = findLatestAssistantMessageId(messagesRef.current);
  }

  function resetTurnArtifactTracking(): void {
    turnPreviousAssistantMessageIdRef.current = undefined;
  }

  function commitConversations(next: ConversationSummary[] | ((current: ConversationSummary[]) => ConversationSummary[])): void {
    const nextConversations = typeof next === "function" ? next(conversationsRef.current) : next;
    conversationsRef.current = nextConversations;
    setConversations(nextConversations);
    onConversationsChanged?.(nextConversations);
  }

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => () => {
    if (!fixtureMode && activeDraftStorageKeyRef.current) writeStoredChatDraft(activeDraftStorageKeyRef.current, draftRef.current);
    cancelStreamingFlush();
    releaseScriptPlayback();
  }, []);

  useEffect(() => {
    spaceIdRef.current = space.id;
    clearRuntimePreviews();
    resetTurnArtifactTracking();
    pendingSendRef.current = null;
    postingPendingSendRef.current = false;
    eventStreamReadyConversationIdRef.current = null;
    transientConversationIdsRef.current = new Set();
  }, [space.id]);

  useEffect(() => {
    setAppProposal(null);
    setAppProposalBusy(false);
    appProposalVersionsRef.current.clear();
  }, [space.id, conversation?.id]);

  useEffect(() => {
    if (fixtureMode) return;
    const previousKey = activeDraftStorageKeyRef.current;
    if (previousKey === draftStorageKey) return;
    if (previousKey) writeStoredChatDraft(previousKey, draft);
    activeDraftStorageKeyRef.current = draftStorageKey;
    setDraft(readStoredChatDraft(draftStorageKey));
  }, [draftStorageKey, fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    const key = draftStorageKey;
    const timerId = window.setTimeout(() => {
      if (activeDraftStorageKeyRef.current === key) writeStoredChatDraft(key, draft);
    }, chatDraftDebounceMs);
    return () => window.clearTimeout(timerId);
  }, [draft, draftStorageKey, fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    void loadConversationList();
  }, [space.id, fixtureMode]);

  useEffect(() => {
    let cancelled = false;
    setCommands([]);
    if (fixtureMode) {
      setCommands(fixtureComposerCommands);
      return;
    }
    void api<AgentCatalog>(`/api/spaces/${space.id}/agent/catalog`)
      .then((catalog) => {
        if (!cancelled) setCommands(catalog.commands ?? []);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [space.id, fixtureMode]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandQuery, commands]);

  useEffect(() => {
    let cancelled = false;
    if (fixtureMode) {
      setConfiguredAssistant({
        ready: true,
        configured: true,
        provider: fixtureConversationRuntime.model?.provider ?? null,
        model: fixtureConversationRuntime.model?.id ?? null,
        piVersion: null,
        error: null,
      });
      setAssistantComposer({
        model: fixtureConversationRuntime.model,
        thinkingLevel: fixtureConversationRuntime.thinkingLevel,
        thinkingLevels: fixtureConversationRuntime.thinkingLevels ?? [],
      });
      return;
    }
    void Promise.allSettled([
      api<{ status: AgentStatus }>(`/api/agent/status?spaceId=${encodeURIComponent(space.id)}`),
      api<{ composer: AssistantComposerState }>(`/api/agent/composer?scope=space&spaceId=${encodeURIComponent(space.id)}`),
    ]).then(([statusResult, composerResult]) => {
      if (cancelled) return;
      setConfiguredAssistant(statusResult.status === "fulfilled" ? statusResult.value.status : null);
      setAssistantComposer(composerResult.status === "fulfilled" ? composerResult.value.composer : null);
    });
    return () => {
      cancelled = true;
    };
  }, [space.id, fixtureMode, assistantConfigurationRevision]);

  useEffect(() => {
    setConversationRuntime(null);
  }, [space.id, conversation?.id]);

  useEffect(() => {
    let cancelled = false;
    const conversationId = conversation?.id;
    if (!conversationId || messages.length === 0) {
      setConversationRuntime(null);
      return;
    }
    if (!configuredAssistant || !configuredAssistant.configured) {
      setConversationRuntime(null);
      return;
    }
    if (running) return;
    if (fixtureMode) {
      setConversationRuntime(fixtureConversationRuntime);
      return;
    }
    void loadConversationRuntime(conversationId).then((runtime) => {
      if (!cancelled) setConversationRuntime(runtime);
    });
    return () => {
      cancelled = true;
    };
  }, [space.id, conversation?.id, messages.length, running, fixtureMode, configuredAssistant?.configured, assistantConfigurationRevision]);

  useEffect(() => {
    if (!fixtureMode) return;
    const script = fixtureScriptPlayback();
    const scriptConversation = script
      ? (fixtureConversations ?? []).find((item) => item.id === script.conversationId) ?? null
      : null;
    const scriptTargeted = Boolean(scriptConversation) && (!targetConversationId || targetConversationId === scriptConversation?.id);
    if (scriptPlaybackStateRef.current === "playing") {
      // Benign re-run mid-playback (e.g. the conversation is activated at send time) — leave the show alone.
      if (scriptTargeted) return;
      // The tab moved to a different conversation mid-playback — stop and hydrate normally below.
      cancelScriptPlayback();
    }
    if (script && scriptConversation && scriptTargeted && scriptPlaybackStateRef.current === "idle" && !fixtureScriptPlaybackClaimed) {
      fixtureScriptPlaybackClaimed = true;
      startScriptPlayback(scriptConversation, script.delayMs);
      return;
    }
    const fixtureConversation = targetConversationId
      ? fixtureConversations?.find((item) => item.id === targetConversationId) ?? null
      : fixtureConversations?.[0] ?? null;
    const fixtureConversationSummaryValue = fixtureConversation ? fixtureConversationSummary(fixtureConversation) : null;
    const fixtureRunning = fixtureConversation?.running ?? fixtureAgentRunning();
    setError(null);
    const fixturePreviews = fixtureConversation?.runtimePreviews ?? fixtureRuntimePreviews();
    commitConversations((fixtureConversations ?? []).map(fixtureConversationSummary));
    if (fixtureConversation && fixtureConversationSummaryValue) {
      setConversation(fixtureConversationSummaryValue);
      onConversationActivated?.(fixtureConversationSummaryValue);
      setMessages(fixtureConversation.messages.filter((message) => message.role !== "system"));
      setStreamingAssistant(fixtureConversation.streamingAssistant ?? (fixtureRunning ? "I’m reading the selected files and checking the generated outputs now." : ""));
      setContextAttachments(fixtureConversation.contextAttachments ?? []);
      setActiveContextPath(null);
    } else {
      setConversation(null);
      onConversationActivated?.(null);
      setMessages([]);
      setStreamingAssistant("");
      setContextAttachments([]);
      setActiveContextPath(null);
    }
    setRunning(fixtureRunning);
    setRuntimePreviews(fixturePreviews);
  }, [space.id, fixtureMode, targetConversationId, fixtureConversations]);

  useEffect(() => {
    if (fixtureMode) return;
    if (!targetConversationId) {
      if (!conversation) return;
      pendingSendRef.current = null;
      postingPendingSendRef.current = false;
      eventStreamReadyConversationIdRef.current = null;
      setConversation(null);
      setMessages([]);
      setStreamingAssistant("");
      setRunning(false);
      clearRuntimePreviews();
      cancelStreamingFlush();
      setContextAttachments([]);
      setActiveContextPath(null);
      userPinnedToBottomRef.current = true;
      setUserPinnedToBottom(true);
      onConversationActivated?.(null);
      return;
    }
    if (conversation?.id === targetConversationId) return;
    const selected = conversations.find((item) => item.id === targetConversationId);
    if (selected) void switchConversation(selected);
  }, [targetConversationId, conversations, conversation?.id, fixtureMode]);

  useEffect(() => {
    resizeComposerTextarea();
  }, [draft]);

  const shouldKeepEventStreamOpen = !fixtureMode && Boolean(conversation) && (
    active || running || Boolean(pendingSendRef.current)
  );

  useEffect(() => {
    if (!conversation || !shouldKeepEventStreamOpen) return;
    const conversationId = conversation.id;
    let openedOnce = false;
    const turnStateGate = createChatTurnStateGate();
    eventStreamReadyConversationIdRef.current = null;
    const source = createEventSource(`/api/spaces/${space.id}/conversations/${conversationId}/events`);
    source.onopen = () => {
      eventStreamReadyConversationIdRef.current = conversationId;
      setError(null);
      if (openedOnce && !pendingSendRef.current && !postingPendingSendRef.current) {
        // Reconcile messages that may have landed while Windows was asleep or
        // the renderer was disconnected. Runtime previews remain intact while
        // a turn is still active.
        void loadMessages(conversationId, false);
      }
      openedOnce = true;
      if (pendingSendRef.current?.conversation.id === conversationId) void postPendingMessage();
    };
    source.onerror = (streamError) => {
      if (eventStreamReadyConversationIdRef.current === conversationId) eventStreamReadyConversationIdRef.current = null;
      const pending = pendingSendRef.current;
      if (pending?.conversation.id === conversationId) {
        if (isTransientNetworkError(rawErrorMessage(streamError))) {
          setError(errorText(streamError));
          return;
        }
        pendingSendRef.current = null;
        clearStoredPendingChatSend(space.id, conversationId);
        postingPendingSendRef.current = false;
        runningRef.current = false;
        setRunning(false);
        clearRuntimePreviews();
        setError(errorText(streamError));
        setDraft(pending.content);
        setMessages((current) => current.filter((message) => message.id !== pending.localUserMessage.id));
        if (pending.transientConversation) {
          transientConversationIdsRef.current.delete(conversationId);
          setConversation(null);
          commitConversations((current) => current.filter((item) => item.id !== conversationId));
        }
        reportChatSettled(conversationId);
      } else {
        setError(errorText(streamError));
      }
    };
    source.onmessage = (event) => {
      const data = JSON.parse(event.data) as ChatStreamEvent;
      if (data.type === "turn_state" || data.type === "turn_snapshot") {
        if (data.type === "turn_snapshot" && typeof data.text === "string") {
          flushStreamingText();
          setStreamingAssistant(data.text);
        }
        const sendTransitioning = pendingSendRef.current?.conversation.id === conversationId
          || postingPendingSendRef.current;
        const decision = observeChatTurnState(turnStateGate, data.running === true, sendTransitioning);
        if (decision === "running") {
          beginTurnArtifactTracking();
          runningRef.current = true;
          setRunning(true);
        } else if (
          decision === "settle"
          && runningRef.current
        ) {
          // A reconnect can miss the terminal `done` frame. The server's
          // snapshot is authoritative, so settle from the persisted transcript.
          runningRef.current = false;
          void loadMessages(conversationId, false, { settleStreamingTurn: true });
          void onAgentFinished();
          reportChatSettled(conversationId);
        }
      }
      if (data.type === "tool") {
        beginTurnArtifactTracking();
      }
      if (data.type === "assistant_thinking") {
        beginTurnArtifactTracking();
        runningRef.current = true;
        setRunning(true);
        if (data.thinkingPhase === "start") startThinkingPreview();
        if (data.text) appendThinkingPreview(data.text);
        if (data.thinkingPhase === "end") finishThinkingPreview();
      }
      if (data.type === "assistant_delta" && data.text) {
        beginTurnArtifactTracking();
        runningRef.current = true;
        setRunning(true);
        queueStreamingText(data.text);
      }
      if (data.type === "assistant_message" && typeof data.text === "string") {
        beginTurnArtifactTracking();
        flushStreamingText();
        setStreamingAssistant(data.text);
      }
      if (data.type === "extension_ui_request" && data.request) {
        if (data.request.method === "notify") {
          showToast({ text: data.request.message ?? "Extension notification", tone: "info" });
        } else {
          setExtensionRequest(data.request);
        }
      }
      if (data.type === "restricted_app_proposal" && data.proposal?.status === "pending" && data.proposal.spaceId === space.id && data.proposal.conversationId === conversationId && observeAppProposal(data.proposal)) {
        setAppProposal(data.proposal);
        onRestrictedAppProposalRequested?.();
      }
      if (data.type === "restricted_app_proposal_settled" && data.proposal?.spaceId === space.id && data.proposal.conversationId === conversationId && observeAppProposal(data.proposal)) {
        setAppProposal((current) => current?.id === data.proposal?.id ? null : current);
      }
      if (data.type === "editor" && typeof data.text === "string") {
        setDraft((current) => data.editorMode === "replace" ? data.text ?? "" : `${current}${data.text ?? ""}`);
        window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
      }
      if (data.type === "error") {
        flushStreamingText();
        finishThinkingPreview();
        setError(data.message ?? "Agent error");
        runningRef.current = false;
        setRunning(false);
        void loadMessages(conversationId, false, { settleStreamingTurn: true })
          .then(() => setError(null))
          .catch((loadError) => setError(errorText(loadError)));
        reportChatSettled(conversationId);
      }
      if (data.type === "done") {
        runningRef.current = false;
        flushStreamingText();
        finishThinkingPreview();
        // Keep the streamed bubble on screen until the persisted transcript
        // arrives, then swap in one commit so the reply never blinks out.
        void loadMessages(conversationId, false, { settleStreamingTurn: true });
        void onAgentFinished();
        reportChatSettled(conversationId);
      }
    };
    return () => {
      if (eventStreamReadyConversationIdRef.current === conversationId) eventStreamReadyConversationIdRef.current = null;
      source.close();
      cancelStreamingFlush();
      activeThinkingPreviewIdRef.current = null;
    };
  }, [conversation?.id, shouldKeepEventStreamOpen, space.id]);

  useEffect(() => {
    if (!contextPathRequest) return;
    void attachContextPath(contextPathRequest.path);
  }, [contextPathRequest?.id]);

  useEffect(() => {
    if (!draftRequest) return;
    // Seed the composer and leave the caret at the end so the person simply
    // keeps typing what they want.
    setDraft(draftRequest.text);
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      resizeComposerTextarea();
    });
  }, [draftRequest?.id]);

  useEffect(() => {
    if (userPinnedToBottomRef.current) scrollMessagesToBottom("auto");
  }, [messages, streamingAssistant, runtimePreviewScrollKey, running]);

  function scrollMessagesToBottom(behavior: ScrollBehavior = "smooth") {
    window.requestAnimationFrame(() => {
      const list = messageListRef.current;
      const sentinel = messageEndRef.current;
      if (sentinel) sentinel.scrollIntoView({ behavior, block: "end", inline: "nearest" });
      else if (list) list.scrollTo({ top: list.scrollHeight, behavior });
      userPinnedToBottomRef.current = true;
      setUserPinnedToBottom(true);
    });
  }

  function updateScrollPosition() {
    const list = messageListRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    const isPinned = distanceFromBottom < 120;
    userPinnedToBottomRef.current = isPinned;
    setUserPinnedToBottom(isPinned);
  }

  function queueStreamingText(text: string) {
    streamingBufferRef.current += text;
    if (streamingFlushRef.current !== null) return;
    streamingFlushRef.current = window.requestAnimationFrame(() => {
      streamingFlushRef.current = null;
      flushStreamingText();
    });
  }

  function flushStreamingText() {
    const nextText = streamingBufferRef.current;
    if (!nextText) return;
    streamingBufferRef.current = "";
    setStreamingAssistant((current) => `${current}${nextText}`);
  }

  function cancelStreamingFlush() {
    if (streamingFlushRef.current !== null) window.cancelAnimationFrame(streamingFlushRef.current);
    streamingFlushRef.current = null;
    streamingBufferRef.current = "";
  }

  function addRuntimePreview(preview: RuntimePreviewEntry) {
    setRuntimePreviews((current) => {
      const existingIndex = current.findIndex((item) => item.id === preview.id);
      if (existingIndex >= 0) {
        const updated = [...current];
        updated[existingIndex] = { ...updated[existingIndex], ...preview };
        return updated;
      }
      return [...current, preview];
    });
  }

  function startThinkingPreview() {
    const id = `thinking-${++runtimePreviewIdRef.current}`;
    activeThinkingPreviewIdRef.current = id;
    addRuntimePreview({
      id,
      kind: "thinking",
      text: "",
      phase: "streaming",
    });
  }

  function appendThinkingPreview(text: string) {
    let id = activeThinkingPreviewIdRef.current;
    if (!id) {
      startThinkingPreview();
      id = activeThinkingPreviewIdRef.current;
    }
    if (!id) return;
    setRuntimePreviews((current) => current.map((entry) => (
      entry.id === id
        ? { ...entry, text: `${entry.text}${text}`, phase: "streaming" }
        : entry
    )));
  }

  function finishThinkingPreview() {
    const id = activeThinkingPreviewIdRef.current;
    if (!id) return;
    activeThinkingPreviewIdRef.current = null;
    setRuntimePreviews((current) => current.map((entry) => (
      entry.id === id
        ? { ...entry, phase: "complete" }
        : entry
    )));
  }

  function clearRuntimePreviews() {
    activeThinkingPreviewIdRef.current = null;
    setRuntimePreviews([]);
  }

  function reportChatSettled(conversationId: string): void {
    onSettledRef.current?.(conversationId, !activeRef.current);
  }

  function cancelScriptPlayback() {
    if (scriptPlaybackTimerRef.current !== null) {
      window.clearTimeout(scriptPlaybackTimerRef.current);
      scriptPlaybackTimerRef.current = null;
    }
    if (scriptPlaybackStateRef.current === "playing") scriptPlaybackStateRef.current = "done";
  }

  // Unmount variant of cancelScriptPlayback: releases the page-level claim instead of marking the
  // playback done, so React StrictMode's simulated dev unmount/remount replays cleanly.
  function releaseScriptPlayback() {
    if (scriptPlaybackTimerRef.current !== null) {
      window.clearTimeout(scriptPlaybackTimerRef.current);
      scriptPlaybackTimerRef.current = null;
    }
    if (scriptPlaybackStateRef.current === "playing") {
      scriptPlaybackStateRef.current = "idle";
      fixtureScriptPlaybackClaimed = false;
    }
  }

  // Dev-only fixture script playback (`?fixture=space&script=<conversationId>`): replays the
  // conversation's first user+assistant pair as live action — typed prompt,
  // model reasoning, and streamed reply — for product-video recording.
  function startScriptPlayback(conversation: SpaceFixtureConversation, initialDelayMs: number) {
    scriptPlaybackStateRef.current = "playing";
    setError(null);
    commitConversations((fixtureConversations ?? []).map(fixtureConversationSummary));
    setConversation(null);
    setMessages([]);
    setStreamingAssistant("");
    setRunning(false);
    setRuntimePreviews([]);
    setContextAttachments(conversation.contextAttachments ?? []);
    setActiveContextPath(null);
    setDraft("");
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    composerTextareaRef.current?.focus();
    const firstUser = conversation.messages.find((message) => message.role === "user");
    const firstAssistant = conversation.messages.find((message) => message.role === "assistant");
    if (!firstUser || !firstAssistant) {
      scriptPlaybackStateRef.current = "done";
      return;
    }
    const firstPreview = (conversation.runtimePreviews ?? []).find((entry) => entry.kind === "thinking") ?? null;
    const prompt = firstUser.content;
    const chunks = scriptAssistantChunks(firstAssistant.content);

    const schedule = (delayMs: number, step: () => void) => {
      scriptPlaybackTimerRef.current = window.setTimeout(() => {
        scriptPlaybackTimerRef.current = null;
        if (scriptPlaybackStateRef.current !== "playing") return;
        step();
      }, delayMs);
    };

    const finish = () => {
      setMessages([firstUser, firstAssistant]);
      setStreamingAssistant("");
      setRunning(false);
      setRuntimePreviews(conversation.runtimePreviews ?? []);
      scriptPlaybackStateRef.current = "done";
      reportChatSettled(conversation.id);
    };

    const streamChunk = (index: number) => {
      if (index >= chunks.length) {
        schedule(350, finish);
        return;
      }
      setStreamingAssistant((current) => `${current}${chunks[index]}`);
      schedule(30 + Math.random() * 30, () => streamChunk(index + 1));
    };

    const startStreaming = () => {
      if (firstPreview) setRuntimePreviews([firstPreview]);
      schedule(420, () => streamChunk(0));
    };

    const sendPrompt = () => {
      const summary = fixtureConversationSummary(conversation);
      setDraft("");
      setConversation(summary);
      onConversationActivated?.(summary);
      setMessages([firstUser]);
      setRunning(true);
      userPinnedToBottomRef.current = true;
      setUserPinnedToBottom(true);
      scrollMessagesToBottom("auto");
      schedule(650, startStreaming);
    };

    const typeChar = (index: number) => {
      setDraft(prompt.slice(0, index + 1));
      if (index + 1 >= prompt.length) {
        schedule(400, sendPrompt);
        return;
      }
      schedule(26 + Math.random() * 20, () => typeChar(index + 1));
    };

    schedule(initialDelayMs, () => typeChar(0));
  }

  function resizeComposerTextarea() {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight);
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  async function loadConversationList() {
    if (fixtureMode) return;
    pendingSendRef.current = null;
    postingPendingSendRef.current = false;
    eventStreamReadyConversationIdRef.current = null;
    transientConversationIdsRef.current = new Set();
    setError(null);
    setRunning(false);
    setStreamingAssistant("");
    clearRuntimePreviews();
    resetTurnArtifactTracking();
    setContextAttachments([]);
    setActiveContextPath(null);
    setConversation(null);
    setMessages([]);
    onConversationActivated?.(null);
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    try {
      const result = await api<{ conversations: ConversationSummary[] }>(`/api/spaces/${space.id}/conversations`);
      commitConversations(result.conversations);
    } catch (conversationError) {
      setError(errorText(conversationError));
    }
  }

  async function newConversation() {
    if (fixtureMode) {
      cancelScriptPlayback();
      setConversation(null);
      commitConversations((fixtureConversations ?? []).map(fixtureConversationSummary));
      setMessages([]);
      setDraft("");
      setRunning(false);
      setError(null);
      setStreamingAssistant("");
      clearRuntimePreviews();
      setContextAttachments([]);
      setActiveContextPath(null);
      onConversationActivated?.(null);
      return;
    }
    setRunning(false);
    setError(null);
    setStreamingAssistant("");
    clearRuntimePreviews();
    resetTurnArtifactTracking();
    setContextAttachments([]);
    setActiveContextPath(null);
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    const result = await api<{ conversation: ConversationSummary }>(`/api/spaces/${space.id}/conversations`, {
      method: "POST",
      idempotent: true,
      body: { conversationId: clientTurnIdentity("chat") },
    });
    transientConversationIdsRef.current.add(result.conversation.id);
    setConversation(result.conversation);
    onConversationActivated?.(result.conversation);
    setMessages([]);
    scrollMessagesToBottom("auto");
  }

  async function switchConversation(selected: ConversationSummary) {
    if (fixtureMode) return;
    setConversation(selected);
    onConversationActivated?.(selected);
    setRunning(false);
    setError(null);
    setStreamingAssistant("");
    clearRuntimePreviews();
    cancelStreamingFlush();
    setContextAttachments([]);
    setActiveContextPath(null);
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    const transcript = await loadMessages(selected.id, true);
    const stored = readStoredPendingChatSend(space.id, selected.id);
    if (!stored) return;
    if (transcript.some((message) => message.role === "user" && message.id === stored.userMessageId)) {
      clearStoredPendingChatSend(space.id, selected.id);
      return;
    }
    const localUserMessage: ChatMessage = {
      id: stored.userMessageId,
      role: "user",
      content: stored.content,
      createdAt: stored.createdAt,
      requestId: stored.requestId,
    };
    pendingSendRef.current = {
      conversation: selected,
      content: stored.content,
      requestId: stored.requestId,
      userMessageId: stored.userMessageId,
      localUserMessage,
      selectedPath: stored.selectedPath,
      contextPaths: stored.contextPaths,
      transientConversation: stored.transientConversation,
      draftStorageKey: stored.draftStorageKey,
    };
    if (stored.transientConversation) transientConversationIdsRef.current.add(selected.id);
    beginTurnArtifactTracking();
    runningRef.current = true;
    setRunning(true);
    setMessages((current) => [...current, localUserMessage]);
    if (eventStreamReadyConversationIdRef.current === selected.id) void postPendingMessage();
  }

  const hasVisibleRuntimePreview = runtimePreviews.some((entry) => entry.kind === "thinking" && Boolean(entry.text.trim()));
  const hasTranscript = messages.length > 0 || Boolean(streamingAssistant) || hasVisibleRuntimePreview || running;

  async function loadConversationRuntime(conversationId: string): Promise<ConversationRuntime | null> {
    try {
      const result = await api<{ runtime: ConversationRuntime }>(
        `/api/spaces/${space.id}/conversations/${conversationId}/runtime`,
      );
      return result.runtime;
    } catch {
      return null;
    }
  }

  async function loadMessages(
    conversationId: string,
    pinToBottom = false,
    options: { settleStreamingTurn?: boolean } = {},
  ): Promise<ChatMessage[]> {
    const settleStreamingTurn = options.settleStreamingTurn ?? false;
    let keepSettledTurnArtifacts = false;
    let transcript: ChatMessage[] = [];
    try {
      if (fixtureMode) return [];
      const result = await api<{ messages: ChatMessage[] }>(`/api/spaces/${space.id}/conversations/${conversationId}`);
      transcript = result.messages.filter((message) => message.role !== "system");
      if (settleStreamingTurn) {
        keepSettledTurnArtifacts = settledTurnHasNewAssistantMessage(
          turnPreviousAssistantMessageIdRef.current,
          transcript,
        );
      }
      setMessages((current) => {
        // Rows that replace content already on screen (the streamed reply)
        // must not replay the message-enter animation when they mount.
        if (settleStreamingTurn) {
          const knownIds = new Set(current.map((message) => message.id));
          for (const message of transcript) {
            if (!knownIds.has(message.id)) suppressMessageEnterIdsRef.current.add(message.id);
          }
        } else {
          suppressMessageEnterIdsRef.current.clear();
        }
        return transcript;
      });
      applyModelConversationTitle(conversationId, result.messages);
      applyKnownFirstUserConversationTitle(conversationId, result.messages);
      if (pinToBottom) {
        userPinnedToBottomRef.current = true;
        setUserPinnedToBottom(true);
        scrollMessagesToBottom("auto");
      }
    } finally {
      if (settleStreamingTurn) {
        if (!keepSettledTurnArtifacts) {
          clearRuntimePreviews();
        }
        resetTurnArtifactTracking();
        setStreamingAssistant("");
        setRunning(false);
      }
    }
    return transcript;
  }

  function applyKnownFirstUserConversationTitle(conversationId: string, transcript: ChatMessage[]) {
    const existing = conversationsRef.current.find((item) => item.id === conversationId) ?? conversation;
    if (!existing) return;
    const title = chatDisplayTitle({ serverTitle: existing.title, messages: transcript });
    if (existing.title === title) return;
    const updatedAt = latestTranscriptTime(transcript) ?? existing.updatedAt;
    const updatedConversation = { ...existing, title, updatedAt };
    setConversation((current) => current?.id === conversationId ? updatedConversation : current);
    commitConversations((current) => {
      const next = current.some((item) => item.id === conversationId)
        ? current.map((item) => item.id === conversationId ? updatedConversation : item)
        : [updatedConversation, ...current];
      return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    if (conversation?.id === conversationId || targetConversationId === conversationId) {
      onConversationActivated?.(updatedConversation);
    }
  }

  function applyModelConversationTitle(conversationId: string, transcript: ChatMessage[]) {
    const title = modelConversationTitle(transcript);
    if (!title) return;
    const updatedAt = latestTranscriptTime(transcript) ?? new Date().toISOString();
    const existing = conversationsRef.current.find((item) => item.id === conversationId) ?? conversation;
    if (!existing || (existing.title === title && existing.updatedAt === updatedAt)) return;
    const updatedConversation = { ...existing, title, updatedAt };
    setConversation((current) => current?.id === conversationId ? updatedConversation : current);
    commitConversations((current) => {
      const next = current.some((item) => item.id === conversationId)
        ? current.map((item) => item.id === conversationId ? updatedConversation : item)
        : [updatedConversation, ...current];
      return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    if (conversation?.id === conversationId || targetConversationId === conversationId) {
      onConversationActivated?.(updatedConversation);
    }
  }

  async function sendMessage(contentOverride?: string) {
    const content = (contentOverride ?? draft).trim();
    if (!content || running) return;
    // While a fixture script is replaying, the composer belongs to the playback — ignore manual sends.
    if (fixtureMode && scriptPlaybackStateRef.current === "playing") return;
    beginTurnArtifactTracking();
    const sentDraftStorageKey = draftStorageKey;
    if (contentOverride === undefined) setDraft("");
    setRunning(true);
    setError(null);
    clearRuntimePreviews();
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    const now = Date.now();
    const requestId = clientTurnIdentity("request");
    const userMessageId = clientTurnIdentity("message");
    const localUserMessage: ChatMessage = { id: userMessageId, role: "user", content, createdAt: new Date(now).toISOString() };
    setMessages((current) => [...current, localUserMessage]);
    scrollMessagesToBottom("auto");
    if (fixtureMode) {
      const fixtureConversation = conversation ?? { id: "fixture-chat", title: "New chat", updatedAt: new Date(now).toISOString() };
      setConversation(fixtureConversation);
      onConversationActivated?.(fixtureConversation);
      commitConversations((current) => current.some((item) => item.id === fixtureConversation.id) ? current : [fixtureConversation, ...current]);
      window.setTimeout(() => {
        setMessages((current) => [
          ...current,
          {
            id: `fixture-reply-${now}`,
            role: "assistant",
            content: "This is a saved preview. Open the live app to continue with the Assistant.",
            createdAt: new Date().toISOString(),
          },
        ]);
        setRunning(false);
        reportChatSettled(fixtureConversation.id);
      }, 240);
      return;
    }
    try {
      const activeConversation = conversation ?? (await api<{ conversation: ConversationSummary }>(`/api/spaces/${space.id}/conversations`, {
        method: "POST",
        idempotent: true,
        body: { conversationId: clientTurnIdentity("chat") },
      })).conversation;
      const shouldUseOptimisticFirstPromptTitle = !conversation || transientConversationIdsRef.current.has(activeConversation.id) || activeConversation.title === "work-fold chat";
      const optimisticConversation = shouldUseOptimisticFirstPromptTitle
        ? {
            ...activeConversation,
            title: chatDisplayTitle({ firstUserMessage: content }),
            updatedAt: localUserMessage.createdAt,
          }
        : activeConversation;
      if (!conversation) {
        transientConversationIdsRef.current.add(activeConversation.id);
      }
      if (shouldUseOptimisticFirstPromptTitle) {
        setConversation(optimisticConversation);
        onConversationActivated?.(optimisticConversation);
        commitConversations((current) => [optimisticConversation, ...current.filter((item) => item.id !== optimisticConversation.id)]);
      }
      const pending: PendingChatSend = {
        conversation: activeConversation,
        content,
        requestId,
        userMessageId,
        localUserMessage,
        selectedPath,
        contextPaths: contextAttachments.map((attachment) => attachment.sourcePath),
        transientConversation: transientConversationIdsRef.current.has(activeConversation.id),
        draftStorageKey: sentDraftStorageKey,
      };
      pendingSendRef.current = pending;
      writeStoredPendingChatSend(space.id, activeConversation.id, {
        version: 1,
        requestId,
        userMessageId,
        content,
        createdAt: localUserMessage.createdAt,
        selectedPath,
        contextPaths: pending.contextPaths,
        transientConversation: pending.transientConversation,
        draftStorageKey: sentDraftStorageKey,
      });
      if (eventStreamReadyConversationIdRef.current === activeConversation.id) void postPendingMessage();
    } catch (sendError) {
      setRunning(false);
      clearRuntimePreviews();
      resetTurnArtifactTracking();
      setError(errorText(sendError));
      // Restore the failed message only into an empty composer — never over a
      // newer draft — and put the cursor back where retrying happens.
      setDraft((current) => (current.trim() ? current : content));
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
      setMessages((current) => current.filter((message) => message.id !== localUserMessage.id));
    }
  }

  async function steerMessage(content: string): Promise<void> {
    if (!conversation || fixtureMode) return;
    const requestId = clientTurnIdentity("request");
    const userMessageId = clientTurnIdentity("message");
    const localMessage: ChatMessage = {
      id: userMessageId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      delivery: "steer",
    };
    setMessages((current) => [...current, localMessage]);
    scrollMessagesToBottom("auto");
    try {
      const result = await api<{ accepted: boolean; message: ChatMessage }>(`/api/spaces/${space.id}/conversations/${conversation.id}/messages`, {
        method: "POST",
        idempotent: true,
        body: { content, delivery: "steer", requestId, userMessageId },
      });
      suppressMessageEnterIdsRef.current.add(result.message.id);
      setMessages((current) => current.map((message) => message.id === localMessage.id ? result.message : message));
    } catch (caught) {
      setMessages((current) => current.filter((message) => message.id !== localMessage.id));
      if (caught instanceof ApiError && caught.status === 409) {
        // The turn settled before the message could reach it: send it as the
        // next message instead, which the queued-send effect does the moment
        // `running` clears.
        setQueuedSend((current) => (current ? `${current}\n${content}` : content));
        return;
      }
      setError(errorText(caught));
      setDraft((current) => (current.trim() ? current : content));
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    }
  }

  async function postPendingMessage() {
    const pending = pendingSendRef.current;
    if (!pending || postingPendingSendRef.current) return;
    if (eventStreamReadyConversationIdRef.current !== pending.conversation.id) return;
    postingPendingSendRef.current = true;
    pendingSendRef.current = null;
    try {
      const result = await api<{ accepted: boolean; message: ChatMessage }>(`/api/spaces/${space.id}/conversations/${pending.conversation.id}/messages`, {
        method: "POST",
        idempotent: true,
        body: {
          content: pending.content,
          selectedPath: pending.selectedPath,
          contextPaths: pending.contextPaths,
          requestId: pending.requestId,
          userMessageId: pending.userMessageId,
        },
      });
      clearStoredChatDraft(pending.draftStorageKey);
      clearStoredPendingChatSend(space.id, pending.conversation.id);
      const shouldUseFirstPromptTitle = pending.transientConversation || pending.conversation.title === "work-fold chat";
      const updatedConversation = {
        ...pending.conversation,
        title: shouldUseFirstPromptTitle ? chatDisplayTitle({ firstUserMessage: pending.content }) : chatDisplayTitle({ serverTitle: pending.conversation.title }),
        updatedAt: result.message.createdAt,
      };
      transientConversationIdsRef.current.delete(pending.conversation.id);
      setConversation((current) => current?.id === pending.conversation.id ? updatedConversation : current);
      commitConversations((current) => [updatedConversation, ...current.filter((item) => item.id !== updatedConversation.id)]);
      onConversationActivated?.(updatedConversation);
      // The optimistic bubble is already visible; its persisted replacement
      // must mount without replaying the enter animation.
      suppressMessageEnterIdsRef.current.add(result.message.id);
      setMessages((current) => current.map((message) => message.id === pending.localUserMessage.id ? result.message : message));
    } catch (sendError) {
      if (isTransientNetworkError(rawErrorMessage(sendError))) {
        pendingSendRef.current = pending;
        setError(errorText(sendError));
        return;
      }
      clearStoredPendingChatSend(space.id, pending.conversation.id);
      setRunning(false);
      clearRuntimePreviews();
      resetTurnArtifactTracking();
      setError(errorText(sendError));
      setDraft((current) => (current.trim() ? current : pending.content));
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
      setMessages((current) => current.filter((message) => message.id !== pending.localUserMessage.id));
      if (pending.transientConversation) {
        transientConversationIdsRef.current.delete(pending.conversation.id);
        setConversation(null);
        commitConversations((current) => current.filter((item) => item.id !== pending.conversation.id));
      }
    } finally {
      postingPendingSendRef.current = false;
    }
  }

  // The queued draft fires through the ordinary send path the moment the
  // turn settles; the Enter that queued it was the explicit act.
  useEffect(() => {
    if (running || !queuedSend || lifecycleView !== "active") return;
    const content = queuedSend;
    setQueuedSend(null);
    void sendMessage(content);
  }, [running, queuedSend, lifecycleView]);

  function returnQueuedSendToComposer() {
    if (!queuedSend) return;
    const content = queuedSend;
    setQueuedSend(null);
    setDraft((current) => (current.trim() ? `${content}\n${current}` : content));
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  async function abortTurn() {
    if (!running) return;
    // Stop means everything: a queued follow-up returns to the composer
    // instead of firing into the stopped turn's aftermath.
    returnQueuedSendToComposer();
    if (pendingSendRef.current) {
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      clearStoredPendingChatSend(space.id, pending.conversation.id);
      postingPendingSendRef.current = false;
      setRunning(false);
      clearRuntimePreviews();
      resetTurnArtifactTracking();
      setMessages((current) => current.filter((message) => message.id !== pending.localUserMessage.id));
      if (pending.transientConversation) {
        transientConversationIdsRef.current.delete(pending.conversation.id);
        setConversation(null);
      }
      return;
    }
    if (fixtureMode) {
      cancelScriptPlayback();
      setRunning(false);
      setStreamingAssistant("");
      clearRuntimePreviews();
      resetTurnArtifactTracking();
      return;
    }
    if (!conversation) return;
    try {
      await api<{ aborted: boolean }>(`/api/spaces/${space.id}/conversations/${conversation.id}/abort`, { method: "POST" });
    } catch (abortError) {
      setError(errorText(abortError));
    }
  }

  async function compactConversation() {
    if (running || fixtureMode || !conversation) return;
    setRunning(true);
    setError(null);
    try {
      await api<{ compacted: boolean }>(`/api/spaces/${space.id}/conversations/${conversation.id}/compact`, { method: "POST" });
      setRunning(false);
      setConversationRuntime(await loadConversationRuntime(conversation.id));
    } catch (compactError) {
      setRunning(false);
      setError(errorText(compactError));
    }
  }

  async function changeThinkingLevel(conversationId: string | null, level: string): Promise<void> {
    if (fixtureMode) {
      if (conversationId && conversationRuntime) {
        setConversationRuntime((current) => current ? { ...current, thinkingLevel: level } : current);
      } else {
        setAssistantComposer((current) => current ? { ...current, thinkingLevel: level } : current);
      }
      showToast({ text: `Thinking level: ${level}`, tone: "success" });
      return;
    }
    try {
      if (!conversationId || !conversationRuntime) {
        const result = await api<{ composer: AssistantComposerState }>("/api/agent/thinking", {
          method: "POST",
          body: { scope: "space", spaceId: space.id, level },
        });
        setAssistantComposer(result.composer);
        showToast({ text: `Thinking level: ${result.composer.thinkingLevel}`, tone: "success" });
        return;
      }
      const result = await api<{ thinking: { level: string; available: string[] }; runtime: ConversationRuntime }>(
        `/api/spaces/${space.id}/conversations/${conversationId}/thinking`,
        { method: "POST", body: { level } },
      );
      setConversationRuntime(result.runtime);
      showToast({ text: `Thinking level: ${result.thinking.level}`, tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  async function attachContextPath(path: string) {
    setError(null);
    setAttachingPath(path);
    try {
      if (contextAttachments.some((attachment) => attachment.sourcePath === path)) return;
      if (fixtureMode) {
        setContextAttachments((current) => [...current, createFixtureContextAttachment(path)]);
        return;
      }
      const result = await api<{ attachment: ContextAttachment }>(`/api/spaces/${space.id}/context-attachments`, {
        method: "POST",
        body: { path },
      });
      setContextAttachments((current) => current.some((item) => item.sourcePath === result.attachment.sourcePath)
        ? current
        : [...current, result.attachment]);
    } catch (attachError) {
      setError(errorText(attachError));
    } finally {
      setAttachingPath(null);
      setDragActive(false);
    }
  }

  function removeContextAttachment(sourcePath: string) {
    setContextAttachments((current) => current.filter((attachment) => attachment.sourcePath !== sourcePath));
    if (activeContextPath === sourcePath) setActiveContextPath(null);
  }

  const copyMessage = useCallback(async (messageId: string, content: string) => {
    try {
      await copyMarkdownToClipboard(content);
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? null : current), 1600);
    } catch (copyError) {
      setError(errorText(copyError));
    }
  }, []);

  const resolveSpacePathLinks = useCallback(async (paths: string[]) => {
    if (fixtureMode) return resolveFixtureSpacePathCandidates(paths, fixtureTreeEntries);
    const result = await api<{ existing: string[] }>(`/api/spaces/${space.id}/paths-exist`, {
      method: "POST",
      body: { paths },
    });
    const byCandidate = new Map<string, string>();
    for (const path of paths) {
      const direct = result.existing.find((existingPath) => existingPath === path);
      if (direct) {
        byCandidate.set(path, direct);
        continue;
      }
      if (path.includes("/")) continue;
      const bareNameMatches = result.existing.filter((existingPath) => (existingPath.split("/").pop() ?? "").toLocaleLowerCase() === path.toLocaleLowerCase());
      if (bareNameMatches.length === 1 && bareNameMatches[0]) byCandidate.set(path, bareNameMatches[0]);
    }
    return byCandidate;
  }, [fixtureMode, fixtureTreeEntries, space.id]);

  function droppedSpacePath(event: React.DragEvent<HTMLElement>): string {
    return event.dataTransfer.getData(spacePathDragType);
  }

  function hasSpacePathDrag(event: React.DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes(spacePathDragType);
  }

  function composerAcceptsSpacePathDrag(event: React.DragEvent<HTMLElement>): boolean {
    return hasSpacePathDrag(event) && Boolean(onAddPathToChatContext);
  }

  function composerAcceptsNativeFileDrag(event: React.DragEvent<HTMLElement>): boolean {
    return !fixtureMode && Boolean(onUploadDroppedFiles) && hasNativeFiles(event);
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLFormElement>): void {
    if (!composerAcceptsSpacePathDrag(event) && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLFormElement>): void {
    if (!composerAcceptsSpacePathDrag(event) && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLFormElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
  }

  function handleComposerDrop(event: React.DragEvent<HTMLFormElement>): void {
    const acceptsSpacePath = composerAcceptsSpacePathDrag(event);
    if (!acceptsSpacePath && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (acceptsSpacePath) {
      const path = droppedSpacePath(event);
      if (path) onAddPathToChatContext?.(path);
      return;
    }
    void attachDroppedNativeFiles(event.dataTransfer);
  }

  async function attachDroppedNativeFiles(dataTransfer: DataTransfer): Promise<void> {
    if (!onUploadDroppedFiles) return;
    setError(null);
    // Start the upload callback synchronously: dropped directory entries are
    // only readable while the drop event's DataTransfer is alive.
    const upload = onUploadDroppedFiles(dataTransfer);
    setAttachingPath("__dropped_files__");
    try {
      for (const path of await upload) await attachContextPath(path);
    } catch (dropError) {
      setError(errorText(dropError));
    } finally {
      setAttachingPath(null);
    }
  }

  const activeContextAttachment = contextAttachments.find((attachment) => attachment.sourcePath === activeContextPath) ?? null;
  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;
  const suggestedNextPrompt = !running && !streamingAssistant
    ? latestAssistantMessage?.landing?.followUpPrompt?.trim() ?? ""
    : "";
  async function respondToExtension(value: unknown, cancelled = false) {
    if (!extensionRequest || !conversation) return;
    const request = extensionRequest;
    setExtensionRequest(null);
    try {
      await api(`/api/spaces/${space.id}/conversations/${conversation.id}/extension-ui/${request.id}`, {
        method: "POST",
        body: { value, cancelled },
      });
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  function observeAppProposal(proposal: RestrictedAppProposal): boolean {
    const previous = appProposalVersionsRef.current.get(proposal.id);
    if (previous?.updatedAt && previous.updatedAt > proposal.updatedAt) return false;
    if (previous?.updatedAt === proposal.updatedAt && previous.status !== "pending" && proposal.status === "pending") return false;
    appProposalVersionsRef.current.set(proposal.id, { status: proposal.status, updatedAt: proposal.updatedAt });
    return true;
  }

  async function installAppProposal() {
    if (!appProposal || running) return;
    const proposal = appProposal;
    setAppProposalBusy(true);
    try {
      const app = await installRestrictedAppProposal(space.id, proposal.conversationId, proposal.id);
      setAppProposal(null);
      onRestrictedAppInstalled?.(app);
      showToast({ text: `${app.manifest.title} installed. Review its access in this Space’s Apps tab when you are ready to connect it.`, tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setAppProposalBusy(false);
    }
  }

  async function dismissAppProposal() {
    if (!appProposal || appProposalBusy) return;
    const proposal = appProposal;
    setAppProposalBusy(true);
    try {
      await dismissRestrictedAppProposal(space.id, proposal.conversationId, proposal.id);
      setAppProposal(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setAppProposalBusy(false);
    }
  }

  function applySuggestedPrompt(prompt: string): void {
    if (!prompt || running) return;
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  function chooseComposerCommand(command: AgentCommand): void {
    const value = composerCommandValue(command);
    setDraft(value);
    setDismissedCommandDraft(value);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(value.length, value.length);
    });
  }

  function toggleComposerCommands(): void {
    if (commandMenuOpen) {
      setDismissedCommandDraft(draft);
      return;
    }
    if (draft && commandQuery === null) {
      composerTextareaRef.current?.focus();
      return;
    }
    setDraft("/");
    setDismissedCommandDraft(null);
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  return (
    <section
      className="panel chat-panel"
    >
      <div className={error ? "chat-top-chrome" : "chat-top-chrome empty"}>
        <div className="chat-top-notice">
          {error ? <Banner tone="error" text={error} onDismiss={() => setError(null)} /> : null}
        </div>
      </div>
      <div className="chat-scroll-shell">
        <div className="message-list" ref={messageListRef} onScroll={updateScrollPosition}>
          {messages.map((message) => {
            const isLatestAssistantAtRest = message.role === "assistant" && message.id === latestAssistantMessageId && !running && !streamingAssistant;
            const showRuntimePreview = isLatestAssistantAtRest && hasVisibleRuntimePreview;
            return (
              <ChatMessageRow
                message={message}
                copied={copiedMessageId === message.id}
                showLanding={isLatestAssistantAtRest}
                suppressEnterAnimation={suppressMessageEnterIdsRef.current.has(message.id)}
                showRuntimePreview={showRuntimePreview}
                runtimePreviews={runtimePreviews}
                spaceId={space.id}
                onOpenSpaceFile={onOpenSpaceFile}
                resolveSpacePathLinks={resolveSpacePathLinks}
                onCopyMessage={copyMessage}
                key={message.id}
              />
            );
          })}
          {running && (streamingAssistant || hasVisibleRuntimePreview) ? (
            <article className="message assistant streaming">
              {hasVisibleRuntimePreview ? <RuntimeContextPreview entries={runtimePreviews} running={running} /> : null}
              {streamingAssistant ? <MarkdownMessage content={streamingAssistant} /> : null}
            </article>
          ) : null}
          {running && !streamingAssistant && !hasVisibleRuntimePreview ? (
            <article className="message assistant streaming working-message">
              <div className="typing-line"><Loader2 className="spin" size={14} /> Working</div>
            </article>
          ) : null}
          {!hasTranscript ? (
            <ChatEmptyState greeting={emptyStateGreeting} space={space} identity={spaceIdentity} />
          ) : null}
          {queuedSend ? (
            <div className="queued-send-row">
              <div className="queued-send-bubble">{queuedSend}</div>
              <button type="button" className="queued-send-cancel" aria-label="Cancel queued message" title="Cancel" onClick={returnQueuedSendToComposer}>
                <X size={13} />
              </button>
            </div>
          ) : null}
          <div className="message-end-sentinel" ref={messageEndRef} aria-hidden="true" />
        </div>
        {!userPinnedToBottom ? (
          <button className="jump-to-latest" type="button" onClick={() => scrollMessagesToBottom()}>
            <FluentGlyph icon={ArrowDown20Regular} size={15} />
            Latest
          </button>
        ) : null}
      </div>
      {lifecycleView !== "active" ? (
        <div className={`chat-lifecycle-gate ${lifecycleView}`} role="note">
          <span className="chat-lifecycle-gate-icon" aria-hidden="true">
            {lifecycleView === "archived" ? <Archive size={16} /> : <Clock3 size={16} />}
          </span>
          <span>
            <strong>{lifecycleView === "archived" ? "This Chat is archived" : "This Chat is snoozed"}</strong>
            <small>{lifecycleView === "archived" ? "Restore it before continuing the conversation." : "Resume it now to continue before its scheduled return."}</small>
          </span>
          <button type="button" onClick={() => void onResumeConversation?.()}>
            {lifecycleView === "archived" ? "Restore" : "Resume now"}
          </button>
        </div>
      ) : null}
      <form
        className={dragActive ? "composer composer-drop-active" : "composer"}
        hidden={lifecycleView !== "active"}
        onDragEnter={handleComposerDragEnter}
        onDragOver={handleComposerDragOver}
        onDragLeave={handleComposerDragLeave}
        onDrop={handleComposerDrop}
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && !running) void sendMessage();
        }}
      >
        {dragActive ? <div className="composer-drop-affordance" aria-hidden="true">Attach to chat</div> : null}
        {suggestedNextPrompt ? (
          <div className="suggested-prompt-row">
            <button
              className="suggested-prompt-button"
              type="button"
              onClick={() => applySuggestedPrompt(suggestedNextPrompt)}
              title={suggestedNextPrompt}
              aria-label={`Use suggested prompt: ${suggestedNextPrompt}`}
            >
              <span>{suggestedNextPrompt}</span>
            </button>
          </div>
        ) : null}
        {contextAttachments.length || attachingPath ? (
          <div
            className="context-tray"
            aria-label="Attached files"
          >
            {contextAttachments.length ? (
              <div className="context-pill-list">
                {contextAttachments.map((attachment) => (
                  <div className={`context-chip ${attachment.mode}`} key={attachment.sourcePath}>
                    <button
                      className="context-chip-main"
                      type="button"
                      onClick={() => setActiveContextPath((current) => current === attachment.sourcePath ? null : attachment.sourcePath)}
                      title={attachment.detail}
                      aria-label={`Show attachment details for ${attachment.sourceFileName}`}
                    >
                      <FileTypeIcon path={attachment.sourcePath} />
                      <span className="context-chip-name">{attachment.sourceFileName}</span>
                      <ContextModeIcon attachment={attachment} />
                    </button>
                    <button className="context-chip-remove" type="button" onClick={() => removeContextAttachment(attachment.sourcePath)} aria-label={`Remove ${attachment.sourceFileName}`}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            {attachingPath ? (
              <div className="context-chip checking">
                <span className="file-icon file-icon-unknown">
                  <Loader2 className="spin" size={13} />
                </span>
                <span className="context-chip-name">Checking</span>
              </div>
            ) : null}
            {activeContextAttachment ? (
              <ContextAttachmentPopover attachment={activeContextAttachment} onClose={() => setActiveContextPath(null)} />
            ) : null}
          </div>
        ) : null}
        <div className="composer-input-shell">
          {commandMenuOpen ? (
            <div className="composer-command-menu" role="listbox" aria-label="Assistant commands">
              <div className="composer-command-menu-heading">
                <span>Commands and Skills</span>
                <kbd>Enter</kbd>
              </div>
              {commandSuggestions.map((command, index) => (
                <button
                  className={index === activeCommandIndex ? "active" : ""}
                  type="button"
                  role="option"
                  aria-selected={index === activeCommandIndex}
                  key={`${command.source}:${command.name}`}
                  onMouseEnter={() => setActiveCommandIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseComposerCommand(command)}
                >
                  <span className="composer-command-name">/{command.name}</span>
                  <span className="composer-command-description">{command.description || commandSourceLabel(command.source)}</span>
                  <span className={`composer-command-source ${command.source}`}>{commandSourceLabel(command.source)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            ref={composerTextareaRef}
            aria-label="Message Assistant"
            rows={2}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (event.target.value !== dismissedCommandDraft) setDismissedCommandDraft(null);
            }}
            onPaste={(event) => {
              // A pasted image (screenshot, copied picture) is an explicit act:
              // it lands in the Space's dated Dropped/ folder like a dropped
              // file and is attached to this turn as an image the model sees.
              const transfer = pastedImageTransfer(event.clipboardData);
              if (!transfer || !onUploadDroppedFiles) return;
              event.preventDefault();
              void attachDroppedNativeFiles(transfer);
            }}
            onKeyDown={(event) => {
              if (commandMenuOpen && event.key === "ArrowDown") {
                event.preventDefault();
                setActiveCommandIndex((current) => (current + 1) % commandSuggestions.length);
                return;
              }
              if (commandMenuOpen && event.key === "ArrowUp") {
                event.preventDefault();
                setActiveCommandIndex((current) => (current - 1 + commandSuggestions.length) % commandSuggestions.length);
                return;
              }
              if (commandMenuOpen && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                const command = commandSuggestions[activeCommandIndex];
                if (command) chooseComposerCommand(command);
                return;
              }
              if (commandMenuOpen && event.key === "Escape") {
                event.preventDefault();
                setDismissedCommandDraft(draft);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!draft.trim()) return;
                if (running) {
                  const content = draft.trim();
                  if (event.metaKey || event.ctrlKey || pendingSendRef.current || fixtureMode) {
                    // ⌘/Ctrl+Enter holds the draft for after this turn; a turn
                    // that has not been accepted yet cannot be steered either.
                    setQueuedSend((current) => (current ? `${current}\n${content}` : content));
                    setDraft("");
                    scrollMessagesToBottom("auto");
                    return;
                  }
                  // Plain Enter mid-turn steers: the Assistant reads it after
                  // its current step, the way typing during a Pi turn does.
                  setDraft("");
                  void steerMessage(content);
                  return;
                }
                void sendMessage();
              }
            }}
            placeholder={running && !pendingSendRef.current ? "Steer the Assistant (Enter) · queue for after this turn (⌘Enter)" : "Message Assistant"}
          />
          <div className="composer-capability-bar">
            <button
              className={commandMenuOpen ? "composer-command-trigger active" : "composer-command-trigger"}
              type="button"
              onClick={toggleComposerCommands}
              aria-expanded={commandMenuOpen}
              title="Browse Assistant commands and Skills"
            >
              <span aria-hidden="true">/</span>
              <span>Commands</span>
            </button>
            {configuredAssistant?.configured && conversationRuntime
              ? <ConversationContextMeter runtime={conversationRuntime} status={configuredAssistant} spaceName={space.name} onOpenModelSettings={onOpenModelSettings} />
              : configuredAssistant?.configured && assistantComposer?.model
                ? <ConfiguredAssistantModel model={assistantComposer.model} spaceName={space.name} onOpenModelSettings={onOpenModelSettings} />
                : null}
            {configuredAssistant?.configured && (conversationRuntime ?? assistantComposer)
              ? (
                <ThinkingLevelControl
                  state={conversationRuntime ?? assistantComposer!}
                  disabled={running}
                  onChange={(level) => changeThinkingLevel(conversationRuntime ? conversation?.id ?? null : null, level)}
                />
              )
              : null}
          </div>
          {running ? (
            <button className="send-button stop-send-button" type="button" onClick={() => void abortTurn()} aria-label="Stop Assistant" title="Stop Assistant">
              <Square size={15} />
            </button>
          ) : (
            <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message">
              <FluentGlyph icon={ArrowUp20Regular} size={18} />
            </button>
          )}
        </div>
      </form>
      {extensionRequest ? <ExtensionRequestDialog request={extensionRequest} onRespond={respondToExtension} /> : null}
      {appProposal ? <RestrictedAppReviewDialog review={appProposal.review} sourcePath={appProposal.sourcePath} updating={false} busy={appProposalBusy} installDisabled={running} closeLabel="Decline" onInstall={() => void installAppProposal()} onClose={() => void dismissAppProposal()} /> : null}
    </section>
  );
}

function ConversationContextMeter({ runtime, status, spaceName, onOpenModelSettings }: { runtime: ConversationRuntime; status: AgentStatus; spaceName: string; onOpenModelSettings?: () => void }) {
  const percent = runtime.usage.contextPercent === null
    ? null
    : Math.max(0, Math.min(100, runtime.usage.contextPercent));
  const contextLabel = runtime.usage.contextTokens === null
    ? "Context recalculates after the next reply"
    : `${formatTokenCount(runtime.usage.contextTokens)} of ${formatTokenCount(runtime.usage.contextWindow)} context`;
  const modelLabel = runtime.model?.name
    ?? runtime.model?.id
    ?? displayAssistantModelLabel(status.provider ?? "", status.model ?? "");
  const title = [
    modelLabel,
    contextLabel,
    `${formatTokenCount(runtime.usage.totalTokens)} processed this Chat`,
  ].join(" · ");
  return (
    <button
      className={`conversation-context-meter${percent !== null && percent >= 85 ? " warning" : ""}`}
      type="button"
      onClick={onOpenModelSettings}
      aria-label={`Change the model saved for ${spaceName}. ${title}`}
      title={`${title} · Change the model saved for ${spaceName}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="track" cx="12" cy="12" r="9" pathLength="100" />
        {percent !== null ? <circle className="value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percent} 100`} /> : null}
      </svg>
      <span className="conversation-context-model">{modelLabel}</span>
      <span className="conversation-context-value">
        {percent === null ? "Context —" : `${Math.round(percent)}%`}
      </span>
    </button>
  );
}

function ThinkingLevelControl({
  state,
  disabled,
  onChange,
}: {
  state: Pick<ConversationRuntime, "thinkingLevel" | "thinkingLevels">;
  disabled: boolean;
  onChange: (level: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const levels = state.thinkingLevels ?? [];
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  // A model without adjustable thinking offers nothing to choose.
  if (levels.length < 2) return null;
  const title = `Reasoning level for this Chat: ${state.thinkingLevel}`;
  return (
    <div className="composer-thinking-control" ref={containerRef}>
      <button
        className={open ? "composer-command-trigger composer-thinking-trigger active" : "composer-command-trigger composer-thinking-trigger"}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={title}
        title={disabled ? "Thinking level changes apply between turns" : title}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="composer-thinking-label">{state.thinkingLevel}</span>
      </button>
      {open ? (
        <div className="composer-command-menu composer-thinking-menu" role="listbox" aria-label="Reasoning level">
          <div className="composer-command-menu-heading"><span>Reasoning</span></div>
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              role="option"
              aria-selected={level === state.thinkingLevel}
              className={level === state.thinkingLevel ? "active" : undefined}
              onClick={() => {
                setOpen(false);
                if (level !== state.thinkingLevel) void onChange(level);
              }}
            >
              <span className="composer-command-name">{level}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConfiguredAssistantModel({ model, spaceName, onOpenModelSettings }: { model: NonNullable<AssistantComposerState["model"]>; spaceName: string; onOpenModelSettings?: () => void }) {
  const label = model.name || displayAssistantModelLabel(model.provider, model.id);
  return (
    <button
      className="conversation-context-meter configured"
      type="button"
      onClick={onOpenModelSettings}
      aria-label={`Change the model saved for ${spaceName}. Selected model: ${label}`}
      title={`Selected model for new Chats: ${label} · Change the model saved for ${spaceName}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="track" cx="12" cy="12" r="9" pathLength="100" />
      </svg>
      <span className="conversation-context-model">{label}</span>
    </button>
  );
}

function commandSourceLabel(source: AgentCommand["source"]): string {
  if (source === "skill") return "Skill";
  if (source === "prompt") return "Prompt";
  if (source === "extension") return "Extension";
  return "Built-in";
}

function formatTokenCount(value: number | null): string {
  if (value === null) return "unknown";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return value.toLocaleString();
}

function ExtensionRequestDialog({ request, onRespond }: { request: ExtensionUiRequest; onRespond: (value: unknown, cancelled?: boolean) => Promise<void> }) {
  const [value, setValue] = useState(request.initialValue ?? "");
  // The Assistant's question rides the shared dialog contract like every
  // other modal: focus enters and stays, Escape cancels, Enter answers an
  // input, and focus returns to the invoking control after close.
  const entryFieldRef = useRef<HTMLElement | null>(null);
  const dialogRef = useModalDialog({
    onClose: () => void onRespond(null, true),
    initialFocusRef: entryFieldRef,
  });
  return <div className="modal-backdrop extension-request-backdrop" role="presentation" onMouseDown={() => void onRespond(null, true)}>
    <section ref={dialogRef} tabIndex={-1} className="modal-card extension-request-dialog" role="dialog" aria-modal="true" aria-labelledby={`extension-request-${request.id}`} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id={`extension-request-${request.id}`}>{request.title || "Extension request"}</h2>{request.message ? <p>{request.message}</p> : null}</div><button className="minimal-icon-button" type="button" onClick={() => void onRespond(null, true)} aria-label="Cancel extension request"><X size={16} /></button></header>
      <div className="modal-body extension-dialog-content">
        {request.method === "select" ? <div className="select-options">{request.options?.map((option) => <button className="secondary-button" type="button" key={option} onClick={() => void onRespond(option)}>{option}</button>)}</div> : null}
        {request.method === "confirm" ? <div className="modal-actions"><button className="secondary-button" type="button" onClick={() => void onRespond(false)}>No</button><button className="primary-button" type="button" onClick={() => void onRespond(true)}>Yes</button></div> : null}
        {request.method === "input" || request.method === "editor" ? <form onSubmit={(event) => { event.preventDefault(); void onRespond(value); }}><label>{request.method === "editor" ? "Response" : "Value"}{request.method === "editor" ? <textarea ref={(node) => { entryFieldRef.current = node; }} rows={9} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} /> : <input ref={(node) => { entryFieldRef.current = node; }} type={request.secret ? "password" : "text"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} autoComplete={request.secret ? "off" : undefined} />}</label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => void onRespond(null, true)}>Cancel</button><button className="primary-button" type="submit">Continue</button></div></form> : null}
      </div>
    </section>
  </div>;
}

function ContextModeIcon({ attachment }: { attachment: ContextAttachment }) {
  if (attachment.mode === "path_only_reference") {
    return <AlertTriangle className="context-chip-status blocked" size={12} aria-hidden="true" />;
  }
  if (attachment.warnings.length) {
    return <AlertTriangle className="context-chip-status review" size={12} aria-hidden="true" />;
  }
  return <CircleCheck className="context-chip-status verified" size={12} aria-hidden="true" />;
}

function ContextAttachmentPopover({ attachment, onClose }: { attachment: ContextAttachment; onClose: () => void }) {
  const chatSpacePercent = attachment.budgetTokens > 0 ? Math.round((attachment.estimatedTokens / attachment.budgetTokens) * 100) : 0;
  const chatSpaceLabel = chatSpacePercent === 0 ? "under 1%" : `about ${chatSpacePercent}% of the limit`;
  return (
    <div className="context-meta-popover">
      <div className="context-meta-title">
        <FileTypeIcon path={attachment.sourcePath} />
        <strong>{attachment.sourceFileName}</strong>
        <button type="button" onClick={onClose} aria-label="Close context details">
          <X size={13} />
        </button>
      </div>
      <dl className="context-meta-grid">
        <div>
          <dt>Attached as</dt>
          <dd>{attachment.userLabel}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(attachment.sourceSizeBytes)}</dd>
        </div>
        <div>
          <dt>Chat space</dt>
          <dd>{chatSpaceLabel}</dd>
        </div>
      </dl>
      <p>{attachment.detail}</p>
      {attachment.provenance.length ? <p>{attachment.provenance.join("; ")}</p> : null}
      {attachment.warnings.length ? <p>Review notes: {attachment.warnings.join("; ")}</p> : null}
    </div>
  );
}

function ChatEmptyState({
  greeting,
  space,
  identity,
}: {
  greeting: string;
  space: SpaceSummary;
  identity: SpaceIdentity;
}) {
  const Icon = identity.Icon;
  return (
    <div className="chat-empty-state" style={spaceIdentityStyle(identity)}>
      <strong>{greeting}</strong>
      <span className="chat-empty-space">
        <SpaceIconGlyph icon={Icon} size={15} />
        <span>{space.name}</span>
      </span>
    </div>
  );
}

function randomChatEmptyGreeting(): string {
  const templates = genericChatEmptyGreetings;
  const template = templates[Math.floor(Math.random() * templates.length)] ?? "Hello.";
  return template;
}

function fixtureAgentRunning(): boolean {
  return new URLSearchParams(window.location.search).get("agentState") === "running";
}

// One playback per page load: the first ChatPanel whose fixture conversations contain the script
// conversation claims it, so extra tabs for the same space never restart the show.
let fixtureScriptPlaybackClaimed = false;

function fixtureScriptPlayback(): { conversationId: string; delayMs: number } | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("fixture") !== "space") return null;
  const conversationId = params.get("script");
  if (!conversationId) return null;
  const parsedDelay = Number.parseInt(params.get("scriptDelay") ?? "", 10);
  const delayMs = Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 1500;
  return { conversationId, delayMs };
}

function scriptAssistantChunks(content: string): string[] {
  const parts = content.split(/(\s+)/);
  const chunks: string[] = [];
  let buffer = "";
  for (const part of parts) {
    buffer += part;
    if (buffer.trim().length >= 8) {
      chunks.push(buffer);
      buffer = "";
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function fixtureRuntimePreviews(): RuntimePreviewEntry[] {
  if (new URLSearchParams(window.location.search).get("agentEvents") !== "1") return [];
  const running = fixtureAgentRunning();
  const previews: RuntimePreviewEntry[] = [
    {
      id: "fixture-thinking-context",
      kind: "thinking",
      text: "I need to compare the project notes, inspect the spreadsheet, and identify the decisions that need the user’s attention.\n\n**Checking the files**\n\nI’m matching the notes against the budget so the answer can point to the exact files involved.",
      phase: "complete",
    },
    {
      id: "fixture-thinking-formatting",
      kind: "thinking",
      text: "**Organizing the result**\n\nI’m separating the cost differences from the open questions so the next action is easy to see.",
      phase: running ? "streaming" : "complete",
    },
  ];
  if (running) {
    previews.push({
      id: "fixture-thinking-next",
      kind: "thinking",
      text: "",
      phase: "streaming",
    });
  }
  return previews;
}
