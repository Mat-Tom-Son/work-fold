import { surfaceDomIdSuffix } from "../../lib/work-folder-ui";
import { FolderMentionMenu, type MentionFolderOption } from "./FolderMentionMenu";
import { activeFolderMention, addressedFolderIds, insertFolderMention, matchingMentionFolders } from "../../lib/folder-mentions";
import { useWorkFolderIdentityResolver } from "../../lib/work-folder-appearance-context";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkRequest } from "../../hooks/useWorkRequest";
import { WorkRequest, openWorkFile } from "./WorkRequest";
import type * as React from "react";
import { Add16Regular, ArrowDown20Regular, ArrowUp20Regular, Chat16Regular, ChevronDown16Regular, ChevronLeft16Regular, Desktop20Regular, Search16Regular } from "@fluentui/react-icons";
import { AlertTriangle, Archive, CircleCheck, Clock3, Loader2, Square, X } from "lucide-react";

import { chatDraftDebounceMs, genericChatEmptyGreetings, workFolderPathDragType } from "../../constants";
import { createFixtureContextAttachment, fixtureConversationSummary } from "../../fixtures/shared";
import { ApiError, api, createEventSource, errorText, isTransientNetworkError, rawErrorMessage } from "../../lib/api";
import { requestConnectAi } from "../../lib/connect-ai";
import { conversationLifecycleView } from "../../lib/chat-lifecycle";
import { createChatTurnStateGate, observeChatTurnState } from "../../lib/chat-turn-state";
import { hasNativeFiles } from "../../lib/file-actions";
import { displayModelLabel } from "../../lib/model-display";
import { thinkingLevelLabel } from "../../lib/thinking-levels";
import { composerModelFilterThreshold, composerModelListView } from "../../lib/composer-model-list";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import {
  chatDisplayTitle,
  chatDraftStorageKey,
  clearStoredChatDraft,
  clearStoredPendingChatSend,
  formatChatListTime,
  latestTranscriptTime,
  modelConversationTitle,
  readStoredChatDraft,
  readStoredPendingChatSend,
  writeStoredChatDraft,
  writeStoredPendingChatSend,
} from "../../lib/format";
import { latestAssistantMessageId as findLatestAssistantMessageId, settledTurnHasNewAssistantMessage } from "../../lib/chat-turn-artifacts";
import { assistantTurnView } from "../../lib/chat-work-trail";
import type { AssistantPresentation } from "../../../../src/shared/chat-presentation";
import { dismissRestrictedAppProposal, installRestrictedAppProposal } from "../../lib/restricted-apps";
import { resolveFixtureWorkFolderPathCandidates } from "../../lib/work-folder-path-links";
import { workFolderIdentityStyle, type WorkFolderIdentity } from "../../lib/work-folder-identity";
import type { AgentCatalog, AgentCommand, AgentModel, AgentStatus, ComposerState, ChatContextPathRequest,
  ChatDraftRequest, ChatLifecycleView, ChatMessage, ChatStreamEvent, ContextAttachment, ConversationRuntime, ConversationSummary, ExtensionUiRequest, PendingChatSend, RestrictedAppInstalled, RestrictedAppProposal, RuntimePreviewEntry, TreeEntry, WorkFolderCustomizationMap, WorkFolderFixtureConversation, WorkFolderSummary } from "../../types";
import type { WorkRequestView } from "../../../../src/shared/request-presentation";
import { ExtensionQuestions } from "./ExtensionQuestions";
import { AttachmentChip } from "./AttachmentChip";
import { Banner, FluentGlyph, WorkFolderIconGlyph } from "../chrome/common";
import { FileTypeIcon } from "../tree/FileTree";
import { RuntimeContextPreview } from "./activity";
import { composerCommandQuery, composerCommandValue, matchingComposerCommands } from "./command-menu";
import { QueuedMessageSync } from "../../lib/queued-message-sync";
import { ChatMessageRow, MarkdownMessage, continueInterruptedTurnMessage, copyMarkdownToClipboard } from "./messages";
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

const emptyMentionFolders: readonly MentionFolderOption[] = [];

export function ChatPanel({
  surfaceTabId,
  workFolder,
  workFolderCustomizations,
  modelConfigurationRevision = 0,
  active = true,
  targetConversationId = null,
  contextPathRequest,
  draftRequest = null,
  onAddPathToChatContext,
  onUploadDroppedFiles,
  onOpenWorkFolderFile,
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
  onOpenConversation,
  fixtureMode = false,
  fixtureConversations,
  fixtureTreeEntries = emptyFixtureTreeEntries,
  mentionFolders = emptyMentionFolders,
}: {
  surfaceTabId: string;
  workFolder: WorkFolderSummary;
  workFolderCustomizations: WorkFolderCustomizationMap;
  modelConfigurationRevision?: number;
  active?: boolean;
  targetConversationId?: string | null;
  contextPathRequest: ChatContextPathRequest | null;
  draftRequest?: ChatDraftRequest | null;
  onAddPathToChatContext?: (path: string) => void;
  onUploadDroppedFiles?: (dataTransfer: DataTransfer) => Promise<string[]>;
  onOpenWorkFolderFile?: (path: string) => void;
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
  /** Opens one of this work-folder's Chats, as its row in Chats does. */
  onOpenConversation?: (conversation: ConversationSummary) => void;
  fixtureMode?: boolean;
  fixtureConversations?: WorkFolderFixtureConversation[];
  fixtureTreeEntries?: TreeEntry[];
  /** Workers this composer can address with @ (2026-10-01), nested work-folders first. */
  mentionFolders?: readonly MentionFolderOption[];
}) {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const workState = useWorkRequest(!fixtureMode && conversation ? `/api/work-folders/${encodeURIComponent(workFolder.id)}/conversations/${encodeURIComponent(conversation.id)}/work` : null);
  const requestBusy = Boolean(workState.work?.canStop && workState.work.state !== "waiting");
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
  const conversationIdRef = useRef<string | null>(null);
  const turnPreviousAssistantMessageIdRef = useRef<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  // One draft queued behind the running turn: Enter mid-turn holds it as a
  // visible, cancellable bubble and it sends when the turn settles. Further
  // Enters append to it; Stop and cancel return it to the composer.
  const [queuedSend, setQueuedSend] = useState<string | null>(null);
  // True once the app holds the queued message (every window shows it and the
  // app sends it when the turn ends); false while it is only this window's.
  const [queuedOnServer, setQueuedOnServer] = useState(false);
  // A Stop held the app's queued message: it waits for the person, unsent.
  const [queuedHeld, setQueuedHeld] = useState(false);
  // The queue's truth for event handlers lives in queueSync, written at once;
  // React state only mirrors it (lib/queued-message-sync.ts).
  const queueSync = useRef(new QueuedMessageSync()).current;
  // True while this window's queue writes or Cancel are unanswered: the app may
  // already own the message, so this window must not send it itself.
  const [queueUnsettled, setQueueUnsettled] = useState(false);
  const publishQueue = () => {
    setQueuedSend(queueSync.content);
    setQueuedOnServer(queueSync.onServer);
    setQueuedHeld(queueSync.held);
    setQueueUnsettled(queueSync.unsettled);
  };
  // Queue writes go out one after another, and Cancel goes after the last of
  // them, so a write still in flight can never re-queue a cancelled message.
  const queueWritesRef = useRef<Promise<unknown>>(Promise.resolve());
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [settlementPending, setSettlementPending] = useState(false);
  const [streamingAssistant, setStreamingAssistant] = useState("");
  const [streamingPresentation, setStreamingPresentation] = useState<{ text: string; metadata?: AssistantPresentation }>({ text: "" });
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const pendingTextOrderRef = useRef<number | undefined>(undefined);
  const activeStreamTurnIdRef = useRef<string | null>(null);
  const [runtimePreviews, setRuntimePreviews] = useState<RuntimePreviewEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [contextAttachments, setContextAttachments] = useState<ContextAttachment[]>([]);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [dismissedCommandDraft, setDismissedCommandDraft] = useState<string | null>(null);
  const [composerCaret, setComposerCaret] = useState(0);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const [conversationRuntime, setConversationRuntime] = useState<ConversationRuntime | null>(null);
  const [modelStatus, setModelStatus] = useState<AgentStatus | null>(null);
  const [composerState, setComposerState] = useState<ComposerState | null>(null);
  const [composerModelRevision, setComposerModelRevision] = useState(0);
  const [extensionSnapshot, setExtensionSnapshot] = useState<{ conversationId: string; requests: ExtensionUiRequest[] } | null>(null);
  const extensionRequests = extensionSnapshot && extensionSnapshot.conversationId === conversation?.id ? extensionSnapshot.requests : [];
  const [appProposal, setAppProposal] = useState<RestrictedAppProposal | null>(null);
  const [appProposalBusy, setAppProposalBusy] = useState(false);
  const appProposalVersionsRef = useRef(new Map<string, Pick<RestrictedAppProposal, "status" | "updatedAt">>());
  const emptyStateGreeting = useMemo(() => randomChatEmptyGreeting(), []);
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const workFolderIdentity = useMemo(
    () => workFolderIdentityFor(workFolder, workFolderCustomizations),
    [workFolder, workFolderCustomizations, workFolderIdentityFor],
  );

  useEffect(() => {
    if (conversation?.id) onRunningChangeRef.current?.(conversation.id, running || requestBusy);
  }, [conversation?.id, running, requestBusy]);

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
  // Cmd/Ctrl+. stops the running turn from anywhere in the active Chat. The
  // listener calls the latest abortTurn: a first send creates the Chat while
  // the turn is already running, and an older closure would not know it.
  const abortTurnRef = useRef(abortTurn);
  abortTurnRef.current = abortTurn;
  useEffect(() => {
    if (!active || (!running && !workState.work?.canStop)) return;
    function stopKeydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === ".") {
        event.preventDefault();
        void abortTurnRef.current();
      }
    }
    window.addEventListener("keydown", stopKeydown);
    return () => window.removeEventListener("keydown", stopKeydown);
  }, [active, running, workState.work?.canStop]);
  const [userPinnedToBottom, setUserPinnedToBottom] = useState(true);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const userPinnedToBottomRef = useRef(true);
  const streamingBufferRef = useRef("");
  const streamingFlushRef = useRef<number | null>(null);
  const activeThinkingPreviewIdRef = useRef<string | null>(null);
  const runtimePreviewIdRef = useRef(0);
  const workFolderIdRef = useRef(workFolder.id);
  const messagesLoadGenerationRef = useRef(0);
  const settlingTurnRef = useRef(false);
  const settlementRetryTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    messagesLoadGenerationRef.current++;
    cancelSettlementRetry();
  }, [workFolder.id]);
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
      workFolder.id,
      targetConversationId ?? conversation?.id ?? null,
      surfaceTabId === `chat:${workFolder.id}:new` ? null : surfaceTabId,
    ),
    [workFolder.id, targetConversationId, conversation?.id, surfaceTabId],
  );
  const runtimePreviewScrollKey = useMemo(
    () => runtimePreviews.map((entry) => `${entry.id}:${entry.phase ?? ""}:${entry.text.length}:${entry.detail?.length ?? 0}`).join("|"),
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
  const activeMention = useMemo(() => mentionFolders.length ? activeFolderMention(draft, composerCaret) : null, [composerCaret, draft, mentionFolders.length]);
  const mentionSuggestions = useMemo(
    () => activeMention ? matchingMentionFolders(mentionFolders, activeMention.query) : [],
    [activeMention, mentionFolders],
  );
  const mentionKey = activeMention ? `${activeMention.start}:${draft}` : null;
  const mentionMenuOpen = !commandMenuOpen && mentionSuggestions.length > 0 && mentionKey !== dismissedMentionKey;
  const mentionMenuId = `composer-mentions-${surfaceDomIdSuffix(surfaceTabId)}`;
  useEffect(() => { setActiveMentionIndex(0); }, [activeMention?.start, activeMention?.query]);
  const composerModelPicker: ComposerModelPickerProps = {
    workFolderId: workFolder.id,
    fixtureMode,
    revision: modelConfigurationRevision,
    disabled: running,
    // An existing Chat keeps the model its session started with; the saved
    // work-folder model applies to the Chats that start after it.
    forNewChats: Boolean(conversationRuntime),
    shownModel: conversationRuntime?.model ?? composerState?.model ?? null,
    onSaved: handleComposerModelSaved,
    onOpenModelSettings,
  };
  // Reasoning shares the model's chip and menu. It applies to this Chat once
  // the Chat exists, and to new Chats before then.
  const reasoningState = conversationRuntime ?? composerState;
  const composerReasoning: ComposerReasoning | undefined = reasoningState && (reasoningState.thinkingLevels?.length ?? 0) > 1
    ? {
      level: reasoningState.thinkingLevel,
      levels: reasoningState.thinkingLevels ?? [],
      forThisChat: Boolean(conversationRuntime),
      onChange: (level) => changeThinkingLevel(conversationRuntime ? conversation?.id ?? null : null, level),
    }
    : undefined;
  runningRef.current = running;
  messagesRef.current = messages;
  conversationIdRef.current = conversation?.id ?? null;

  function beginTurnArtifactTracking(): void {
    if (turnPreviousAssistantMessageIdRef.current !== undefined) return;
    turnPreviousAssistantMessageIdRef.current = findLatestAssistantMessageId(messagesRef.current);
  }

  function resetTurnArtifactTracking(): void {
    turnPreviousAssistantMessageIdRef.current = undefined;
  }

  function cancelSettlementRetry(): void {
    if (settlementRetryTimerRef.current !== null) window.clearTimeout(settlementRetryTimerRef.current);
    settlementRetryTimerRef.current = null;
  }

  function clearTurnSettlement(): void {
    messagesLoadGenerationRef.current++;
    cancelSettlementRetry();
    settlingTurnRef.current = false;
    setSettlementPending(false);
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
    workFolderIdRef.current = workFolder.id;
    clearTurnSettlement();
    clearRuntimePreviews();
    resetTurnArtifactTracking();
    pendingSendRef.current = null;
    postingPendingSendRef.current = false;
    eventStreamReadyConversationIdRef.current = null;
    transientConversationIdsRef.current = new Set();
  }, [workFolder.id]);

  useEffect(() => {
    setAppProposal(null);
    setAppProposalBusy(false);
    appProposalVersionsRef.current.clear();
  }, [workFolder.id, conversation?.id]);

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
  }, [workFolder.id, fixtureMode]);

  useEffect(() => {
    let cancelled = false;
    setCommands([]);
    if (fixtureMode) {
      setCommands(fixtureComposerCommands);
      return;
    }
    void api<AgentCatalog>(`/api/work-folders/${workFolder.id}/agent/catalog`)
      .then((catalog) => {
        if (!cancelled) setCommands(catalog.commands ?? []);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workFolder.id, fixtureMode]);

  useEffect(() => {
    setActiveCommandIndex(0);
  }, [commandQuery, commands]);

  useEffect(() => {
    let cancelled = false;
    if (fixtureMode) {
      setModelStatus({
        ready: true,
        configured: true,
        provider: fixtureConversationRuntime.model?.provider ?? null,
        model: fixtureConversationRuntime.model?.id ?? null,
        piVersion: null,
        error: null,
      });
      setComposerState({
        model: fixtureConversationRuntime.model,
        thinkingLevel: fixtureConversationRuntime.thinkingLevel,
        thinkingLevels: fixtureConversationRuntime.thinkingLevels ?? [],
      });
      return;
    }
    void Promise.allSettled([
      api<{ status: AgentStatus }>(`/api/agent/status?workFolderId=${encodeURIComponent(workFolder.id)}`),
      api<{ composer: ComposerState }>(`/api/agent/composer?scope=work-folder&workFolderId=${encodeURIComponent(workFolder.id)}`),
    ]).then(([statusResult, composerResult]) => {
      if (cancelled) return;
      setModelStatus(statusResult.status === "fulfilled" ? statusResult.value.status : null);
      setComposerState(composerResult.status === "fulfilled" ? composerResult.value.composer : null);
    });
    return () => {
      cancelled = true;
    };
  }, [workFolder.id, fixtureMode, modelConfigurationRevision, composerModelRevision]);

  useEffect(() => {
    setConversationRuntime(null);
  }, [workFolder.id, conversation?.id]);

  useEffect(() => {
    let cancelled = false;
    const conversationId = conversation?.id;
    if (!conversationId || messages.length === 0) {
      setConversationRuntime(null);
      return;
    }
    if (!modelStatus || !modelStatus.configured) {
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
  }, [workFolder.id, conversation?.id, messages.length, running, fixtureMode, modelStatus?.configured, modelConfigurationRevision, composerModelRevision]);

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
    // `?agentEvents=1` previews the live steps strip and wins over a Chat's own
    // saved trail; while it runs, no reply text is shown so the rows stay open.
    const eventPreviews = fixtureRuntimePreviews();
    const fixturePreviews = eventPreviews.length ? eventPreviews : fixtureConversation?.runtimePreviews ?? [];
    commitConversations((fixtureConversations ?? []).map(fixtureConversationSummary));
    if (fixtureConversation && fixtureConversationSummaryValue) {
      setConversation(fixtureConversationSummaryValue);
      onConversationActivated?.(fixtureConversationSummaryValue);
      setMessages(fixtureConversation.messages.filter((message) => message.role !== "system"));
      setStreamingAssistant(fixtureConversation.streamingAssistant ?? (fixtureRunning && !eventPreviews.length ? "I’m reading the selected files and checking the generated outputs now." : ""));
      setContextAttachments(fixtureConversation.contextAttachments ?? []);
    } else {
      setConversation(null);
      onConversationActivated?.(null);
      setMessages([]);
      setStreamingAssistant("");
      setContextAttachments([]);
    }
    setRunning(fixtureRunning);
    setRuntimePreviews(fixturePreviews);
  }, [workFolder.id, fixtureMode, targetConversationId, fixtureConversations]);

  useEffect(() => {
    if (fixtureMode) return;
    if (!targetConversationId) {
      if (!conversation) return;
      clearTurnSettlement();
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
    active || running || settlementPending || Boolean(pendingSendRef.current)
  );

  useEffect(() => {
    if (!conversation || !shouldKeepEventStreamOpen) return;
    const conversationId = conversation.id;
    let openedOnce = false;
    const turnStateGate = createChatTurnStateGate();
    eventStreamReadyConversationIdRef.current = null;
    // Queue numbers belong to one Chat's stream; a new Chat starts from its own.
    queueSync.resetRevision();
    const source = createEventSource(`/api/work-folders/${workFolder.id}/conversations/${conversationId}/events`);
    source.onopen = () => {
      eventStreamReadyConversationIdRef.current = conversationId;
      setError(null);
      if (openedOnce && !pendingSendRef.current && !postingPendingSendRef.current) {
        // Reconcile messages that may have landed while Windows was asleep or
        // the renderer was disconnected. Runtime previews remain intact while
        // a turn is still active.
        void loadMessages(conversationId, false).catch(() => undefined);
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
        clearStoredPendingChatSend(workFolder.id, conversationId);
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
      if (data.conversationId !== conversationId) return;
      const turnFrame = data.type === "turn_state" || data.type === "turn_snapshot";
      if (!turnFrame && data.turnId && activeStreamTurnIdRef.current && data.turnId !== activeStreamTurnIdRef.current) return;
      if (data.type === "turn_state" || data.type === "turn_snapshot") {
        const sendTransitioning = pendingSendRef.current?.conversation.id === conversationId
          || postingPendingSendRef.current;
        const startingTurn = data.running === true && (!runningRef.current || settlingTurnRef.current
          || Boolean(data.turnId && activeStreamTurnIdRef.current && data.turnId !== activeStreamTurnIdRef.current));
        if (startingTurn) {
          // An answer or CLI message can start a turn without this composer's
          // send path. Retire the last reply and any older transcript request.
          clearTurnSettlement();
          setError(null);
          flushStreamingText();
          setStreamingAssistant("");
          clearRuntimePreviews();
          resetTurnArtifactTracking();
          if (!sendTransitioning) void loadMessages(conversationId, false).catch(() => undefined);
        }
        if (data.running && data.turnId) activeStreamTurnIdRef.current = data.turnId;
        if (data.type === "turn_snapshot" && typeof data.text === "string" && data.running === true) {
          // This frame replaces state at its cursor. Replaying it must not
          // append an older row or restart a thinking timer.
          cancelStreamingFlush();
          const snapshot = data.presentation;
          const text = snapshot?.text ?? data.text;
          setStreamingAssistant(text);
          setStreamingPresentation({ text, metadata: snapshot?.assistantPresentation });
          pendingTextOrderRef.current = undefined;
          setPreviewTruncated(snapshot?.truncated === true);
          if (snapshot) {
            setRuntimePreviews(snapshot.workTrail);
            activeThinkingPreviewIdRef.current = [...snapshot.workTrail].reverse().find((entry) => entry.kind === "thinking" && ["running", "streaming"].includes(entry.phase ?? ""))?.id ?? null;
          }
        }
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
          void loadMessages(conversationId, false, { settleStreamingTurn: true }).catch(() => undefined);
          void onAgentFinished();
          reportChatSettled(conversationId);
        }
      }
      if (data.type === "tool") {
        beginTurnArtifactTracking();
        const toolPreviewId = data.workTrailId ?? (data.toolCallId?.trim()
          ? `tool-${data.toolCallId.trim()}`
          : `tool-${++runtimePreviewIdRef.current}`);
        addRuntimePreview({
          id: toolPreviewId,
          kind: "tool",
          text: data.message?.trim() || data.toolName?.trim() || "Tool",
          ...(data.detail?.trim() ? { detail: data.detail.trim() } : {}),
          ...(data.toolName?.trim() ? { toolName: data.toolName.trim() } : {}),
          ...(data.toolTitle?.trim() ? { toolTitle: data.toolTitle.trim() } : {}),
          ...(data.order !== undefined ? { order: data.order } : {}),
          ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
          ...(data.edit ? { edit: data.edit } : {}),
          phase: data.phase ?? "running",
        });
      }
      if (data.type === "assistant_thinking") {
        beginTurnArtifactTracking();
        runningRef.current = true;
        setRunning(true);
        if (data.thinkingPhase === "start") startThinkingPreview(data);
        if (data.text) appendThinkingPreview(data.text, data);
        if (data.thinkingPhase === "end") finishThinkingPreview(data);
      }
      if (data.type === "assistant_delta" && data.text) {
        beginTurnArtifactTracking();
        runningRef.current = true;
        setRunning(true);
        pendingTextOrderRef.current = data.order;
        queueStreamingText(data.text);
      }
      if (data.type === "assistant_message" && typeof data.text === "string") {
        beginTurnArtifactTracking();
        flushStreamingText();
        setStreamingAssistant(data.text);
        setStreamingPresentation({ text: data.text, metadata: data.assistantPresentation });
        pendingTextOrderRef.current = undefined;
      }
      if (data.type === "extension_ui_request" && data.request) {
        if (data.request.method === "notify") {
          showToast({ text: data.request.message ?? "Extension notification", tone: "info" });
        } else {
          setExtensionSnapshot((current) => ({ conversationId, requests: [...(current?.conversationId === conversationId ? current.requests.filter((request) => request.id !== data.request!.id) : []), data.request!] }));
        }
      }
      if (data.type === "extension_ui_snapshot") setExtensionSnapshot({ conversationId, requests: data.requests ?? [] });
      if (data.type === "queued_message") {
        // The app's copy wins; an empty one clears only a message the app held,
        // never one this window is still holding for a turn not yet accepted.
        if (data.sentContextPaths?.length) {
          // Those files went out with the queued message; later messages do not repeat them.
          const sent = new Set(data.sentContextPaths);
          setContextAttachments((current) => current.filter((attachment) => !sent.has(attachment.sourcePath)));
        }
        if (queueSync.applyEvent(data)) publishQueue();
      }
      // A proposal installs inside the proposing turn; the Chat surfaces the
      // settled receipt (added, or failed with a retry), never a review.
      if (data.type === "restricted_app_proposal" && data.proposal?.workFolderId === workFolder.id && data.proposal.conversationId === conversationId && observeAppProposal(data.proposal)) {
        onRestrictedAppProposalRequested?.();
      }
      if (data.type === "restricted_app_proposal_settled" && data.proposal?.workFolderId === workFolder.id && data.proposal.conversationId === conversationId && observeAppProposal(data.proposal)) {
        const settled = data.proposal;
        if (settled.status === "installed" || settled.status === "failed") setAppProposal(settled);
        else setAppProposal((current) => current?.id === settled.id ? null : current);
      }
      if (data.type === "editor" && typeof data.text === "string") {
        setDraft((current) => data.editorMode === "replace" ? data.text ?? "" : `${current}${data.text ?? ""}`);
        window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
      }
      if (data.type === "error") {
        flushStreamingText();
        finishThinkingPreview();
        setError(data.message ?? "The Worker stopped because of an error.");
        runningRef.current = false;
        setRunning(false);
        void loadMessages(conversationId, false, { settleStreamingTurn: true })
          .catch(() => undefined);
        reportChatSettled(conversationId);
      }
      if (data.type === "done") {
        runningRef.current = false;
        flushStreamingText();
        finishThinkingPreview();
        // Keep the streamed bubble on screen until the persisted transcript
        // arrives, then swap in one commit so the reply never blinks out.
        void loadMessages(conversationId, false, { settleStreamingTurn: true }).catch(() => undefined);
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
  }, [conversation?.id, shouldKeepEventStreamOpen, workFolder.id]);

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
      textarea.scrollTop = textarea.scrollHeight;
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

  function startThinkingPreview(event?: ChatStreamEvent) {
    const id = event?.workTrailId ?? `thinking-${++runtimePreviewIdRef.current}`;
    activeThinkingPreviewIdRef.current = id;
    addRuntimePreview({
      id,
      kind: "thinking",
      text: "",
      phase: "streaming",
      startedAt: event?.startedAt ?? Date.now(),
      ...(event?.order !== undefined ? { order: event.order } : {}),
    });
  }

  function appendThinkingPreview(text: string, event?: ChatStreamEvent) {
    let id = event?.workTrailId ?? activeThinkingPreviewIdRef.current;
    if (!id) {
      startThinkingPreview(event);
      id = activeThinkingPreviewIdRef.current;
    }
    if (!id) return;
    setRuntimePreviews((current) => current.map((entry) => (
      entry.id === id
        ? { ...entry, text: `${entry.text}${text}`, phase: "streaming" }
        : entry
    )));
  }

  function finishThinkingPreview(event?: ChatStreamEvent) {
    const id = event?.workTrailId ?? activeThinkingPreviewIdRef.current;
    if (!id) return;
    activeThinkingPreviewIdRef.current = null;
    const endedAt = Date.now();
    setRuntimePreviews((current) => current.map((entry) => (
      entry.id === id
        ? { ...entry, phase: "complete", ...(event?.durationMs !== undefined ? { durationMs: event.durationMs } : entry.startedAt ? { durationMs: Math.max(0, endedAt - entry.startedAt) } : {}) }
        : entry
    )));
  }

  function clearRuntimePreviews() {
    activeThinkingPreviewIdRef.current = null;
    setRuntimePreviews([]);
    setStreamingPresentation({ text: "" });
    pendingTextOrderRef.current = undefined;
    activeStreamTurnIdRef.current = null;
    setPreviewTruncated(false);
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

  // Dev-only fixture script playback (`?fixture=work-folder&script=<conversationId>`): replays the
  // conversation's first user+assistant pair as live action — typed prompt,
  // model reasoning, and streamed reply — for product-video recording.
  function startScriptPlayback(conversation: WorkFolderFixtureConversation, initialDelayMs: number) {
    scriptPlaybackStateRef.current = "playing";
    setError(null);
    commitConversations((fixtureConversations ?? []).map(fixtureConversationSummary));
    setConversation(null);
    setMessages([]);
    setStreamingAssistant("");
    setRunning(false);
    setRuntimePreviews([]);
    setContextAttachments(conversation.contextAttachments ?? []);
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
    setConversation(null);
    setMessages([]);
    onConversationActivated?.(null);
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    try {
      const result = await api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${workFolder.id}/conversations`);
      commitConversations(result.conversations);
    } catch (conversationError) {
      setError(errorText(conversationError));
    }
  }

  async function switchConversation(selected: ConversationSummary) {
    if (fixtureMode) return;
    clearTurnSettlement();
    setConversation(selected);
    onConversationActivated?.(selected);
    setRunning(false);
    setError(null);
    setStreamingAssistant("");
    clearRuntimePreviews();
    cancelStreamingFlush();
    setContextAttachments([]);
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    const transcript = await loadMessages(selected.id, true);
    const stored = readStoredPendingChatSend(workFolder.id, selected.id);
    if (!stored) return;
    if (transcript.some((message) => message.role === "user" && message.id === stored.userMessageId)) {
      clearStoredPendingChatSend(workFolder.id, selected.id);
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
      contextPaths: stored.contextPaths,
      transientConversation: stored.transientConversation,
      draftStorageKey: stored.draftStorageKey,
      ...(stored.addressedWorkFolderIds?.length ? { addressedWorkFolderIds: stored.addressedWorkFolderIds } : {}),
    };
    if (stored.transientConversation) transientConversationIdsRef.current.add(selected.id);
    beginTurnArtifactTracking();
    runningRef.current = true;
    setRunning(true);
    setMessages((current) => [...current, localUserMessage]);
    if (eventStreamReadyConversationIdRef.current === selected.id) void postPendingMessage();
  }

  const liveTurnView = assistantTurnView(streamingAssistant, streamingPresentation.metadata, runtimePreviews, {
    canonicalText: streamingPresentation.text, pendingOrder: pendingTextOrderRef.current,
  });
  const hasVisibleRuntimePreview = runtimePreviews.some((entry) => (
    entry.kind === "tool"
    || Boolean(entry.text.trim())
    || (entry.durationMs ?? 0) > 0
    || entry.phase === "queued"
    || entry.phase === "running"
    || entry.phase === "streaming"
  ));
  const hasTranscript = messages.length > 0 || Boolean(streamingAssistant) || hasVisibleRuntimePreview || running;
  // A new Chat puts the composer under its greeting, with the work-folder's
  // recent Chats below, until the first message is sent (2026-10-27).
  const startLayout = !hasTranscript && !conversation && !targetConversationId && lifecycleView === "active";
  const recentChats = useMemo(() => startLayout
    ? conversations
      .filter((item) => conversationLifecycleView(item) === "active")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 3)
    : [], [conversations, startLayout]);

  async function loadConversationRuntime(conversationId: string): Promise<ConversationRuntime | null> {
    try {
      const result = await api<{ runtime: ConversationRuntime }>(
        `/api/work-folders/${workFolder.id}/conversations/${conversationId}/runtime`,
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
    // Reconnection may replace a pending settlement read. Its newer read
    // must carry the same settlement until an actual new turn cancels it.
    const settleStreamingTurn = options.settleStreamingTurn === true || settlingTurnRef.current;
    cancelSettlementRetry();
    if (settleStreamingTurn) {
      settlingTurnRef.current = true;
      setSettlementPending(true);
      // The host has settled the turn; a delayed transcript read must not
      // keep the Worker running or its composer in steering mode.
      runningRef.current = false;
      setRunning(false);
    }
    const generation = ++messagesLoadGenerationRef.current;
    let keepSettledTurnArtifacts = false;
    let transcript: ChatMessage[] = [];
    try {
      if (fixtureMode) return [];
      const result = await api<{ messages: ChatMessage[] }>(`/api/work-folders/${workFolder.id}/conversations/${conversationId}`);
      transcript = result.messages.filter((message) => message.role !== "system");
      if (generation !== messagesLoadGenerationRef.current) return transcript;
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
      if (pinToBottom) {
        userPinnedToBottomRef.current = true;
        setUserPinnedToBottom(true);
        scrollMessagesToBottom("auto");
      }
      if (settleStreamingTurn) {
        settlingTurnRef.current = false;
        setSettlementPending(false);
        setError(null);
        const hasPersistedWorkTrail = [...transcript].reverse()
          .find((message) => message.role === "assistant")
          ?.workTrail?.length;
        if (!keepSettledTurnArtifacts || hasPersistedWorkTrail) {
          clearRuntimePreviews();
        }
        resetTurnArtifactTracking();
        setStreamingAssistant("");
        setRunning(false);
      }
    } catch (error) {
      if (generation === messagesLoadGenerationRef.current) {
        setError(errorText(error));
        if (settleStreamingTurn && (isTransientNetworkError(rawErrorMessage(error)) || error instanceof ApiError && error.status >= 500)) {
          // Retain the last visible reply and steps until an authoritative
          // transcript replaces them. Only this read's owner may retry.
          settlementRetryTimerRef.current = window.setTimeout(() => {
            settlementRetryTimerRef.current = null;
            if (generation !== messagesLoadGenerationRef.current || !settlingTurnRef.current) return;
            void loadMessages(conversationId, false, { settleStreamingTurn: true }).catch(() => undefined);
          }, 1_500);
        }
      }
      throw error;
    }
    return transcript;
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

  async function sendMessage(contentOverride?: string, options: { withoutAttachments?: boolean } = {}) {
    const content = (contentOverride ?? draft).trim();
    // Continue sends only its own words: files staged for the person's draft stay staged.
    const attachmentsForSend = options.withoutAttachments ? [] : contextAttachments;
    if (!content || running) return;
    // While a fixture script is replaying, the composer belongs to the playback — ignore manual sends.
    if (fixtureMode && scriptPlaybackStateRef.current === "playing") return;
    // A typed `/compact` takes this Chat's compaction route, as `chat compact`
    // does (docs/act-ledger.md): the kernel compaction task and the capability
    // fence, not a turn. A Chat not created yet has nothing to compact.
    const compactCommand = /^\/compact(?:\s+([\s\S]*))?$/i.exec(content);
    if (compactCommand && !fixtureMode) {
      if (contentOverride === undefined) setDraft("");
      if (!conversation) {
        showToast({ text: "This Chat has no working context to compact yet.", tone: "info" });
        return;
      }
      void compactConversation(compactCommand[1]?.trim() || undefined, contentOverride === undefined ? content : undefined);
      return;
    }
    clearTurnSettlement();
    resetTurnArtifactTracking();
    beginTurnArtifactTracking();
    cancelStreamingFlush();
    setStreamingAssistant("");
    const sentDraftStorageKey = draftStorageKey;
    const addressedWorkFolderIds = addressedFolderIds(content, mentionFolders);
    if (contentOverride === undefined) setDraft("");
    setRunning(true);
    setError(null);
    clearRuntimePreviews();
    userPinnedToBottomRef.current = true;
    setUserPinnedToBottom(true);
    const now = Date.now();
    const requestId = clientTurnIdentity("request");
    const userMessageId = clientTurnIdentity("message");
    const sentAttachments = attachmentsForSend.map((attachment) => ({ kind: "file" as const, target: attachment.sourcePath, name: attachment.sourceFileName }));
    const localUserMessage: ChatMessage = {
      id: userMessageId,
      role: "user",
      content,
      createdAt: new Date(now).toISOString(),
      ...(sentAttachments.length ? { attachments: sentAttachments } : {}),
    };
    setMessages((current) => [...current, localUserMessage]);
    scrollMessagesToBottom("auto");
    if (fixtureMode) {
      const fixtureConversation = conversation ?? { id: "fixture-chat", title: "New Chat", updatedAt: new Date(now).toISOString() };
      if (!options.withoutAttachments) setContextAttachments([]);
      setConversation(fixtureConversation);
      onConversationActivated?.(fixtureConversation);
      commitConversations((current) => current.some((item) => item.id === fixtureConversation.id) ? current : [fixtureConversation, ...current]);
      window.setTimeout(() => {
        setMessages((current) => [
          ...current,
          {
            id: `fixture-reply-${now}`,
            role: "assistant",
            content: "This is a saved preview. Open the live app to continue with the Worker.",
            createdAt: new Date().toISOString(),
          },
        ]);
        setRunning(false);
        reportChatSettled(fixtureConversation.id);
      }, 240);
      return;
    }
    try {
      const activeConversation = conversation ?? (await api<{ conversation: ConversationSummary }>(`/api/work-folders/${workFolder.id}/conversations`, {
        method: "POST",
        idempotent: true,
        body: { conversationId: clientTurnIdentity("chat") },
      })).conversation;
      const shouldActivateConversation = !conversation || transientConversationIdsRef.current.has(activeConversation.id) || activeConversation.title === "work-fold chat";
      const activatedConversation = shouldActivateConversation
        ? { ...activeConversation, title: chatDisplayTitle({ serverTitle: activeConversation.title }), updatedAt: localUserMessage.createdAt }
        : activeConversation;
      if (!conversation) {
        transientConversationIdsRef.current.add(activeConversation.id);
      }
      if (shouldActivateConversation) {
        setConversation(activatedConversation);
        onConversationActivated?.(activatedConversation);
        commitConversations((current) => [activatedConversation, ...current.filter((item) => item.id !== activatedConversation.id)]);
      }
      const pending: PendingChatSend = {
        conversation: activeConversation,
        content,
        requestId,
        userMessageId,
        localUserMessage,
        contextPaths: attachmentsForSend.map((attachment) => attachment.sourcePath),
        transientConversation: transientConversationIdsRef.current.has(activeConversation.id),
        draftStorageKey: sentDraftStorageKey,
        ...(addressedWorkFolderIds.length ? { addressedWorkFolderIds } : {}),
      };
      pendingSendRef.current = pending;
      writeStoredPendingChatSend(workFolder.id, activeConversation.id, {
        version: 1,
        requestId,
        userMessageId,
        content,
        createdAt: localUserMessage.createdAt,
        contextPaths: pending.contextPaths,
        transientConversation: pending.transientConversation,
        draftStorageKey: sentDraftStorageKey,
        ...(pending.addressedWorkFolderIds ? { addressedWorkFolderIds: pending.addressedWorkFolderIds } : {}),
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
      const result = await api<{ accepted: boolean; message: ChatMessage }>(`/api/work-folders/${workFolder.id}/conversations/${conversation.id}/messages`, {
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
        queueFollowUp(content);
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
      const result = await api<{ accepted: boolean; message: ChatMessage }>(`/api/work-folders/${workFolder.id}/conversations/${pending.conversation.id}/messages`, {
        method: "POST",
        idempotent: true,
        body: {
          content: pending.content,
          contextPaths: pending.contextPaths,
          requestId: pending.requestId,
          userMessageId: pending.userMessageId,
          ...(pending.addressedWorkFolderIds?.length ? { addressedWorkFolderIds: pending.addressedWorkFolderIds } : {}),
        },
      });
      clearStoredChatDraft(pending.draftStorageKey);
      clearStoredPendingChatSend(workFolder.id, pending.conversation.id);
      // An attachment belongs to the message it went out with. Files attached
      // while this one was being delivered stay for the next message.
      const sentPaths = new Set(pending.contextPaths);
      if (sentPaths.size && conversationIdRef.current === pending.conversation.id) {
        setContextAttachments((current) => current.filter((attachment) => !sentPaths.has(attachment.sourcePath)));
      }
      const updatedConversation = {
        ...pending.conversation,
        title: chatDisplayTitle({ serverTitle: pending.conversation.title }),
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
      clearStoredPendingChatSend(workFolder.id, pending.conversation.id);
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
  // A message the app holds is sent by the app when the turn ends; only one
  // this window still holds (its turn was not accepted yet) is sent from here.
  useEffect(() => {
    if (running || workState.work?.canStop || !queuedSend || queuedOnServer || queueUnsettled || lifecycleView !== "active") return;
    const content = queuedSend;
    queueSync.clear();
    publishQueue();
    void sendMessage(content);
  }, [running, queuedSend, queuedOnServer, queueUnsettled, lifecycleView, workState.work?.canStop]);

  // One stable Continue handler, so a message row re-renders only when Continue appears or goes.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const continueInterruptedTurn = useCallback(() => {
    void sendMessageRef.current(continueInterruptedTurnMessage, { withoutAttachments: true });
  }, []);

  /** Adds to the Chat's queued message and hands it to the app while a turn runs. */
  function queueFollowUp(content: string) {
    const next = queueSync.append(content);
    publishQueue();
    if (!conversation || fixtureMode || pendingSendRef.current) return;
    const conversationId = conversation.id;
    const body = {
      content: next,
      contextPaths: contextAttachments.map((attachment) => attachment.sourcePath),
      addressedWorkFolderIds: addressedFolderIds(next, mentionFolders),
    };
    queueSync.writeStarted();
    setQueueUnsettled(true);
    const write = queueWritesRef.current.catch(() => undefined)
      .then(() => api<{ queued: { content: string }; revision: number }>(`/api/work-folders/${workFolder.id}/conversations/${conversationId}/queue`, { method: "PUT", body }));
    queueWritesRef.current = write;
    void write.then((result) => {
      // The text stays this window's newest; the app now holds a copy of it.
      queueSync.writeSettled(result.revision ?? 0);
      publishQueue();
    }, (caught) => {
      queueSync.writeSettled();
      publishQueue();
      // 409: the turn already ended, so this window sends it (the effect above).
      if (!(caught instanceof ApiError && caught.status === 409)) setError(errorText(caught));
    });
  }

  function returnQueuedSendToComposer() {
    const { content, needsDelete } = queueSync.cancel();
    if (!content) return;
    publishQueue();
    if (needsDelete && conversation && !fixtureMode) {
      const path = `/api/work-folders/${workFolder.id}/conversations/${conversation.id}/queue`;
      const cancel = queueWritesRef.current.catch(() => undefined)
        .then(() => api<{ revision: number }>(path, { method: "DELETE" }));
      queueWritesRef.current = cancel;
      void cancel.then((result) => queueSync.cancelSettled(result.revision ?? 0), () => queueSync.cancelSettled()).then(publishQueue);
    } else if (needsDelete) {
      queueSync.cancelSettled();
    }
    setDraft((current) => (current.trim() ? `${content}\n${current}` : content));
    window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
  }

  async function abortTurn() {
    if (!running && !workState.work?.canStop) return;
    // Stop means everything: a queued follow-up returns to the composer
    // instead of firing into the stopped turn's aftermath.
    returnQueuedSendToComposer();
    if (pendingSendRef.current) {
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      clearStoredPendingChatSend(workFolder.id, pending.conversation.id);
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
      if (workState.work?.canStop) { await workState.act("stop"); return; }
      await api<{ aborted: boolean }>(`/api/work-folders/${workFolder.id}/conversations/${conversation.id}/abort`, { method: "POST" });
    } catch (abortError) {
      setError(errorText(abortError));
    }
  }

  async function compactConversation(customInstructions?: string, typedCommand?: string) {
    if (running || fixtureMode || !conversation) return;
    setRunning(true);
    setError(null);
    try {
      await api<{ compacted: boolean }>(`/api/work-folders/${workFolder.id}/conversations/${conversation.id}/compact`, {
        method: "POST",
        ...(customInstructions ? { body: { customInstructions } } : {}),
      });
      setRunning(false);
      showToast({ text: "Compacted this Chat's working context.", tone: "success" });
      setConversationRuntime(await loadConversationRuntime(conversation.id));
    } catch (compactError) {
      setRunning(false);
      setError(errorText(compactError));
      // Put the command back only into an empty composer, as a failed send does.
      if (typedCommand) setDraft((current) => (current.trim() ? current : typedCommand));
    }
  }

  function handleComposerModelSaved(status: AgentStatus, model: AgentModel): void {
    setModelStatus(status);
    setComposerState((current) => current ? { ...current, model: { provider: model.provider, id: model.id, name: model.name } } : current);
    // Re-read the composer (its reasoning levels follow the model) and this Chat's runtime.
    setComposerModelRevision((current) => current + 1);
  }

  async function changeThinkingLevel(conversationId: string | null, level: string): Promise<void> {
    if (fixtureMode) {
      if (conversationId && conversationRuntime) {
        setConversationRuntime((current) => current ? { ...current, thinkingLevel: level } : current);
      } else {
        setComposerState((current) => current ? { ...current, thinkingLevel: level } : current);
      }
      showToast({ text: `Reasoning level: ${thinkingLevelLabel(level)}`, tone: "success" });
      return;
    }
    try {
      if (!conversationId || !conversationRuntime) {
        const result = await api<{ composer: ComposerState }>("/api/agent/thinking", {
          method: "POST",
          body: { scope: "work-folder", workFolderId: workFolder.id, level },
        });
        setComposerState(result.composer);
        showToast({ text: `Reasoning level: ${thinkingLevelLabel(result.composer.thinkingLevel)}`, tone: "success" });
        return;
      }
      const result = await api<{ thinking: { level: string; available: string[] }; runtime: ConversationRuntime }>(
        `/api/work-folders/${workFolder.id}/conversations/${conversationId}/thinking`,
        { method: "POST", body: { level } },
      );
      setConversationRuntime(result.runtime);
      showToast({ text: `Reasoning level: ${thinkingLevelLabel(result.thinking.level)}`, tone: "success" });
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
      const result = await api<{ attachment: ContextAttachment }>(`/api/work-folders/${workFolder.id}/context-attachments`, {
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

  const resolveWorkFolderPathLinks = useCallback(async (paths: string[]) => {
    if (fixtureMode) return resolveFixtureWorkFolderPathCandidates(paths, fixtureTreeEntries);
    const result = await api<{ existing: string[] }>(`/api/work-folders/${workFolder.id}/paths-exist`, {
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
  }, [fixtureMode, fixtureTreeEntries, workFolder.id]);

  function droppedWorkFolderPath(event: React.DragEvent<HTMLElement>): string {
    return event.dataTransfer.getData(workFolderPathDragType);
  }

  function hasWorkFolderPathDrag(event: React.DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types).includes(workFolderPathDragType);
  }

  function composerAcceptsWorkFolderPathDrag(event: React.DragEvent<HTMLElement>): boolean {
    return hasWorkFolderPathDrag(event) && Boolean(onAddPathToChatContext);
  }

  function composerAcceptsNativeFileDrag(event: React.DragEvent<HTMLElement>): boolean {
    return !fixtureMode && Boolean(onUploadDroppedFiles) && hasNativeFiles(event);
  }

  function handleComposerDragEnter(event: React.DragEvent<HTMLFormElement>): void {
    if (!composerAcceptsWorkFolderPathDrag(event) && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    setDragActive(true);
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLFormElement>): void {
    if (!composerAcceptsWorkFolderPathDrag(event) && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLFormElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
  }

  function handleComposerDrop(event: React.DragEvent<HTMLFormElement>): void {
    const acceptsWorkFolderPath = composerAcceptsWorkFolderPathDrag(event);
    if (!acceptsWorkFolderPath && !composerAcceptsNativeFileDrag(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (acceptsWorkFolderPath) {
      const path = droppedWorkFolderPath(event);
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

  const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;
  const suggestedNextPrompt = !running && !streamingAssistant
    ? latestAssistantMessage?.landing?.followUpPrompt?.trim() ?? ""
    : "";
  async function respondToExtension(request: ExtensionUiRequest, value: unknown, cancelled = false) {
    if (!conversation) return;
    const conversationId = conversation.id;
    await api(`/api/work-folders/${workFolder.id}/conversations/${conversationId}/extension-ui/${request.id}`, {
      method: "POST", body: { value, cancelled },
    });
    setExtensionSnapshot((current) => current?.conversationId === conversationId
      ? { ...current, requests: current.requests.filter((item) => item.id !== request.id) } : current);
  }

  function observeAppProposal(proposal: RestrictedAppProposal): boolean {
    const previous = appProposalVersionsRef.current.get(proposal.id);
    if (previous?.updatedAt && previous.updatedAt > proposal.updatedAt) return false;
    if (previous?.updatedAt === proposal.updatedAt && previous.status !== "pending" && proposal.status === "pending") return false;
    appProposalVersionsRef.current.set(proposal.id, { status: proposal.status, updatedAt: proposal.updatedAt });
    return true;
  }

  async function retryAppProposal() {
    if (!appProposal || appProposalBusy) return;
    const proposal = appProposal;
    setAppProposalBusy(true);
    try {
      const app = await installRestrictedAppProposal(workFolder.id, proposal.conversationId, proposal.id);
      showToast({ text: `Added ${app.manifest.title} to this work-folder.`, tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setAppProposalBusy(false);
    }
  }

  async function dismissAppProposal() {
    if (!appProposal || appProposalBusy) return;
    const proposal = appProposal;
    if (proposal.status !== "failed") { setAppProposal(null); return; }
    setAppProposalBusy(true);
    try {
      await dismissRestrictedAppProposal(workFolder.id, proposal.conversationId, proposal.id);
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

  function chooseMentionFolder(folder: MentionFolderOption): void {
    if (!activeMention) return;
    const next = insertFolderMention(draft, activeMention, folder);
    setDraft(next.value);
    setComposerCaret(next.caret);
    window.requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      composerTextareaRef.current?.setSelectionRange(next.caret, next.caret);
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
      className={startLayout ? "panel chat-panel is-start" : "panel chat-panel"}
    >
      <div className={error ? "chat-top-chrome" : "chat-top-chrome empty"}>
        <div className="chat-top-notice">
          {error ? <Banner tone="error" text={error} onDismiss={() => setError(null)} /> : null}
        </div>
      </div>
      <div className="chat-scroll-shell">
        <div className="message-list" ref={messageListRef} onScroll={updateScrollPosition}>
          {messages.map((message) => {
            const isLatestAssistantAtRest = message.role === "assistant" && message.id === latestAssistantMessageId && !running && !settlementPending && !streamingAssistant;
            const showRuntimePreview = isLatestAssistantAtRest && hasVisibleRuntimePreview;
            // Continue is offered only where it means something: the Chat's last
            // message, interrupted, with nothing running or queued behind it.
            const canContinue = isLatestAssistantAtRest && !!message.interruption && message.id === messages[messages.length - 1]?.id
              && !requestBusy && !queuedSend && lifecycleView === "active";
            return (
              <ChatMessageRow
                message={message}
                copied={copiedMessageId === message.id}
                showLanding={isLatestAssistantAtRest}
                suppressEnterAnimation={suppressMessageEnterIdsRef.current.has(message.id)}
                showRuntimePreview={showRuntimePreview}
                runtimePreviews={runtimePreviews}
                workFolderId={workFolder.id}
                workFolderRoot={workFolder.workFolderRoot}
                onOpenWorkFolderFile={onOpenWorkFolderFile}
                resolveWorkFolderPathLinks={resolveWorkFolderPathLinks}
                onCopyMessage={copyMessage}
                onContinue={canContinue ? continueInterruptedTurn : undefined}
                key={message.id}
              />
            );
          })}
          {running || settlementPending ? (
            <article className="message assistant streaming">
              <RuntimeContextPreview
                entries={liveTurnView.steps}
                running={running}
                replyStarted={liveTurnView.hasFinal}
                renderText={(content, links) => <MarkdownMessage content={content} workFolderLinks={links} onOpenWorkFolderFile={onOpenWorkFolderFile} />}
                workFolderRoot={workFolder.workFolderRoot}
                onOpenWorkFolderFile={onOpenWorkFolderFile}
                resolveWorkFolderPathLinks={resolveWorkFolderPathLinks}
              />
              {previewTruncated ? <p className="work-step-evidence-note" role="note">This live preview omits some earlier activity. The saved reply will appear when the turn ends.</p> : null}
              {liveTurnView.answer ? <MarkdownMessage content={liveTurnView.answer} /> : null}
            </article>
          ) : null}
          {!hasTranscript ? (
            <ChatEmptyState greeting={emptyStateGreeting} workFolder={workFolder} identity={workFolderIdentity} />
          ) : null}
          {queuedSend ? (
            <div className="queued-send-row">
              <div className="queued-send-bubble">
                {queuedSend}
                {queuedHeld ? <span className="queued-send-held">Not sent: the work was stopped.</span> : null}
              </div>
              <button type="button" className="queued-send-cancel" aria-label="Cancel queued message" title="Cancel" onClick={returnQueuedSendToComposer}>
                <X size={13} />
              </button>
            </div>
          ) : null}
          {failureShownInReply(workState.work, messages) ? null : <WorkRequest {...workState} showProgress={!running} showStop={!running && !requestBusy} onOpenFile={(workFolderId, path) => {
            if (workFolderId === workFolder.id && onOpenWorkFolderFile) onOpenWorkFolderFile(path); else return openWorkFile(workFolderId, path);
          }} />}
          {extensionSnapshot && extensionSnapshot.conversationId === conversation?.id ? <ExtensionQuestions requests={extensionRequests} scope={`${workFolder.id}/${conversation.id}`} respond={respondToExtension} /> : null}
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
            {lifecycleView === "archived" ? "Restore" : "Resume Now"}
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
          if (draft.trim() && !running && !requestBusy) void sendMessage();
        }}
      >
        {dragActive ? <div className="composer-drop-affordance" aria-hidden="true">Attach to Chat</div> : null}
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
                  <AttachmentChip key={attachment.sourcePath} path={attachment.sourcePath} name={attachment.sourceFileName} onRemove={() => removeContextAttachment(attachment.sourcePath)} />
                ))}
              </div>
            ) : null}
            {attachingPath ? (
              <div className="context-chip checking">
                <span className="file-icon">
                  <Loader2 className="spin" size={13} />
                </span>
                <span className="context-chip-name">Attaching</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="composer-input-shell">
          {mentionMenuOpen ? (
            <FolderMentionMenu id={mentionMenuId} folders={mentionSuggestions} activeIndex={activeMentionIndex} onHover={setActiveMentionIndex} onChoose={chooseMentionFolder} />
          ) : null}
          {commandMenuOpen ? (
            <div className="composer-command-menu" role="listbox" aria-label="Commands and Skills">
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
            aria-label="Message Worker"
            aria-autocomplete="list"
            aria-expanded={mentionMenuOpen}
            aria-controls={mentionMenuOpen ? mentionMenuId : undefined}
            aria-activedescendant={mentionMenuOpen ? `${mentionMenuId}-${activeMentionIndex}` : undefined}
            rows={1}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setComposerCaret(event.target.selectionStart ?? event.target.value.length);
              if (event.target.value !== dismissedCommandDraft) setDismissedCommandDraft(null);
            }}
            onSelect={(event) => setComposerCaret(event.currentTarget.selectionStart ?? 0)}
            onPaste={(event) => {
              // A pasted image (screenshot, copied picture) is an explicit act:
              // it lands in the work-folder's dated Dropped/ folder like a dropped
              // file and is attached to this turn as an image the model sees.
              const transfer = pastedImageTransfer(event.clipboardData);
              if (!transfer || !onUploadDroppedFiles) return;
              event.preventDefault();
              void attachDroppedNativeFiles(transfer);
            }}
            onKeyDown={(event) => {
              // An IME composition owns Enter, arrows, and Escape until it commits.
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              const plainKey = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
              if (mentionMenuOpen && plainKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActiveMentionIndex((current) => (current + step + mentionSuggestions.length) % mentionSuggestions.length);
                return;
              }
              if (mentionMenuOpen && plainKey && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                const folder = mentionSuggestions[activeMentionIndex];
                if (folder) chooseMentionFolder(folder);
                return;
              }
              if (mentionMenuOpen && event.key === "Escape") {
                event.preventDefault();
                setDismissedMentionKey(mentionKey);
                return;
              }
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
                if (requestBusy && !running) return;
                if (!draft.trim()) return;
                if (running) {
                  const content = draft.trim();
                  // A message that addresses another Worker starts its own turn:
                  // steering cannot carry the mention, so it waits like ⌘Enter.
                  if (event.metaKey || event.ctrlKey || pendingSendRef.current || fixtureMode || addressedFolderIds(content, mentionFolders).length) {
                    // ⌘/Ctrl+Enter holds the draft for after this turn; a turn
                    // that has not been accepted yet cannot be steered either.
                    queueFollowUp(content);
                    setDraft("");
                    scrollMessagesToBottom("auto");
                    return;
                  }
                  // Plain Enter mid-turn steers: the Worker reads it after
                  // its current step, the way typing during a Pi turn does.
                  setDraft("");
                  void steerMessage(content);
                  return;
                }
                void sendMessage();
              }
            }}
            placeholder={running && !pendingSendRef.current ? "Steer (Enter) · Queue (⌘Enter)" : "Message Worker"}
          />
          {/* What you add sits on the left; how the Worker runs and Send sit on
              the right (2026-10-27). */}
          <div className="composer-capability-bar">
            <ComposerAttachMenu
              workFolderId={workFolder.id}
              workFolderName={workFolder.name}
              identity={workFolderIdentity}
              fixtureMode={fixtureMode}
              fixtureTreeEntries={fixtureTreeEntries}
              attachedPaths={contextAttachments.map((attachment) => attachment.sourcePath)}
              onAttachPath={(path) => void attachContextPath(path)}
              onUploadFiles={onUploadDroppedFiles ? (transfer) => void attachDroppedNativeFiles(transfer) : undefined}
            />
            <button
              className={commandMenuOpen ? "composer-command-trigger active" : "composer-command-trigger"}
              type="button"
              onClick={toggleComposerCommands}
              aria-expanded={commandMenuOpen}
              title="Browse commands and Skills"
            >
              <span aria-hidden="true">/</span>
              <span>Commands</span>
            </button>
            <span className="composer-capability-spacer" />
            {modelStatus?.configured && conversationRuntime
              ? <ConversationContextMeter runtime={conversationRuntime} status={modelStatus} workFolderName={workFolder.name} picker={composerModelPicker} reasoning={composerReasoning} />
              : modelStatus?.configured && composerState?.model
                ? <ConfiguredModel model={composerState.model} workFolderName={workFolder.name} picker={composerModelPicker} reasoning={composerReasoning} />
                : modelStatus && !modelStatus.configured
                  ? <button className="composer-connect-ai" type="button" onClick={() => requestConnectAi()} title="Connect an AI provider so this Worker can start">Connect AI</button>
                  : null}
            {running || requestBusy ? (
              <button className="send-button stop-send-button" type="button" onClick={() => void abortTurn()} aria-label="Stop Worker" title="Stop Worker">
                <Square size={14} />
              </button>
            ) : (
              <button className="send-button" type="submit" disabled={!draft.trim()} aria-label="Send message">
                <FluentGlyph icon={ArrowUp20Regular} size={17} />
              </button>
            )}
          </div>
        </div>
      </form>
      {startLayout && recentChats.length && onOpenConversation ? <ChatRecentChats chats={recentChats} onOpen={onOpenConversation} /> : null}
      {appProposal ? <RestrictedAppAddedNotice proposal={appProposal} busy={appProposalBusy} onOpen={appProposal.installedApp && onRestrictedAppInstalled ? () => { onRestrictedAppInstalled(appProposal.installedApp!); setAppProposal(null); } : undefined} onRetry={() => void retryAppProposal()} onDismiss={() => void dismissAppProposal()} /> : null}
    </section>
  );
}

/** The proposing Chat's receipt: the app was added (with what still needs a person), or it failed and can be retried. */
function RestrictedAppAddedNotice({ proposal, busy, onOpen, onRetry, onDismiss }: {
  proposal: RestrictedAppProposal;
  busy: boolean;
  onOpen?: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const title = proposal.review.manifest.title;
  if (proposal.status === "failed") {
    return (
      <aside className="capability-code-warning danger restricted-app-added-notice" role="status">
        <AlertTriangle size={20} aria-hidden="true" />
        <div>
          <strong>Couldn’t add {title}</strong>
          <p>{proposal.error ?? "The app package could not be added."}</p>
          <div className="restricted-app-task-actions">
            <button className="ui-control ui-control--primary" type="button" disabled={busy} onClick={onRetry}>Try Again</button>
            <button className="ui-control" type="button" disabled={busy} onClick={onDismiss}>Dismiss</button>
          </div>
        </div>
      </aside>
    );
  }
  const needs = proposal.needs;
  const still = needs ? [
    ...(needs.connections.length ? [`Connect ${needs.connections.join(", ")} in Settings → Apps → ${title}`] : []),
    ...(needs.files.length ? [`Choose a file for ${needs.files.join(", ")}`] : []),
    ...(needs.checks.length ? [`Choose a Check for ${needs.checks.join(", ")}`] : []),
  ] : [];
  return (
    <aside className="capability-code-warning restricted-app-added-notice" role="status">
      <CircleCheck size={20} aria-hidden="true" />
      <div>
        <strong>Added {title} to this work-folder.</strong>
        {still.length ? <p>Still needs you: {still.join(" · ")}.</p> : <p>Every declared destination, folder, notification, and automation is on. Turn any of them off in Settings → Apps.</p>}
        <div className="restricted-app-task-actions">
          {onOpen ? <button className="ui-control ui-control--primary" type="button" disabled={busy} onClick={onOpen}>Open App</button> : null}
          <button className="ui-control" type="button" disabled={busy} onClick={onDismiss}>Close</button>
        </div>
      </div>
    </aside>
  );
}

function ConversationContextMeter({ runtime, status, workFolderName, picker, reasoning }: { runtime: ConversationRuntime; status: AgentStatus; workFolderName: string; picker: ComposerModelPickerProps; reasoning?: ComposerReasoning }) {
  const percent = runtime.usage.contextPercent === null
    ? null
    : Math.max(0, Math.min(100, runtime.usage.contextPercent));
  const contextLabel = runtime.usage.contextTokens === null
    ? "Context recalculates after the next reply"
    : `${formatTokenCount(runtime.usage.contextTokens)} of ${formatTokenCount(runtime.usage.contextWindow)} context`;
  const modelLabel = runtime.model?.name
    ?? runtime.model?.id
    ?? displayModelLabel(status.provider ?? "", status.model ?? "");
  const title = [
    modelLabel,
    contextLabel,
    `${formatTokenCount(runtime.usage.totalTokens)} processed this Chat`,
  ].join(" · ");
  return (
    <ComposerModelPicker
      {...picker}
      reasoning={reasoning}
      className={`conversation-context-meter${percent !== null && percent >= 85 ? " warning" : ""}`}
      ariaLabel={`Change the model saved for ${workFolderName}. ${title}`}
      title={`${title} · Change the model saved for ${workFolderName}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="track" cx="12" cy="12" r="9" pathLength="100" />
        {percent !== null ? <circle className="value" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${percent} 100`} /> : null}
      </svg>
      <span className="conversation-context-model">{modelLabel}</span>
      {percent !== null && percent >= 50 ? (
        <span className="conversation-context-value">{`${Math.round(percent)}% of context`}</span>
      ) : null}
    </ComposerModelPicker>
  );
}

// Composer chip menus are mutually exclusive: opening one closes any other,
// so no menu is left open (or half-closed) behind the one being used.
const openComposerChipMenus = new Set<() => void>();

/** Keep chip menus inside the Chat, including the centered New Chat composer. */
function useComposerMenuBounds(open: boolean, containerRef: React.RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const control = containerRef.current;
    const panel = control?.closest<HTMLElement>(".chat-panel");
    if (!open || !control || !panel) return;
    const update = () => {
      const bounds = panel.getBoundingClientRect();
      const anchor = control.getBoundingClientRect();
      const above = Math.max(0, anchor.top - bounds.top - 9);
      const below = Math.max(0, bounds.bottom - anchor.bottom - 9);
      control.dataset.menuPlacement = below > above ? "below" : "above";
      control.style.setProperty("--composer-menu-available-height", `${Math.max(above, below)}px`);
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(panel);
    observer?.observe(control);
    window.addEventListener("resize", update);
    return () => { observer?.disconnect(); window.removeEventListener("resize", update); };
  }, [open, containerRef]);
}

function useDismissOnOutsideInteraction(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  close: () => void,
  triggerRef?: React.RefObject<HTMLElement | null>,
): void {
  useComposerMenuBounds(open, containerRef);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const closeThis = () => closeRef.current();
    for (const closeOther of [...openComposerChipMenus]) closeOther();
    openComposerChipMenus.add(closeThis);
    function handlePointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && containerRef.current?.contains(event.target)) return;
      closeThis();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      // Escape inside the menu (such as its search field) returns focus to
      // the chip instead of dropping it on the page when the menu unmounts.
      if (triggerRef?.current && document.activeElement instanceof Node && containerRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        triggerRef.current.focus({ preventScroll: true });
      }
      closeThis();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      openComposerChipMenus.delete(closeThis);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, containerRef, triggerRef]);
}

type ComposerModelPickerProps = {
  workFolderId: string;
  fixtureMode: boolean;
  revision: number;
  disabled: boolean;
  forNewChats: boolean;
  shownModel: { provider: string; id: string; name: string } | null;
  onSaved: (status: AgentStatus, model: AgentModel) => void;
  onOpenModelSettings?: () => void;
};

/** The reasoning choice shown beside the model; present only when the model offers a choice. */
type ComposerReasoning = {
  level: string;
  levels: string[];
  /** True once the Chat exists: the choice changes this Chat, not new ones. */
  forThisChat: boolean;
  onChange: (level: string) => void | Promise<void>;
};

type ComposerModelList = { workFolderId: string; revision: number; models: AgentModel[]; status: AgentStatus };

// One lazily read model list per work-folder, reused across Chat tabs until the
// model configuration revision moves.
const composerModelLists = new Map<string, ComposerModelList>();

function ComposerModelPicker({
  workFolderId,
  fixtureMode,
  revision,
  disabled,
  forNewChats,
  shownModel,
  onSaved,
  onOpenModelSettings,
  reasoning,
  className,
  ariaLabel,
  title,
  children,
}: ComposerModelPickerProps & { reasoning?: ComposerReasoning; className: string; ariaLabel: string; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ComposerModelList | null>(() => composerModelLists.get(workFolderId) ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<"start" | "end" | null>(null);
  const menuId = useId();
  useDismissOnOutsideInteraction(open, containerRef, () => setOpen(false), triggerRef);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (open) return;
    setError(null);
    setQuery("");
  }, [open]);
  useEffect(() => {
    if (!open || fixtureMode) return;
    const cached = composerModelLists.get(workFolderId);
    if (cached && cached.revision === revision) {
      setList(cached);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ scope: "work-folder", workFolderId });
    void api<{ models: AgentModel[]; status: AgentStatus }>(`/api/agent/models?${params.toString()}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        const next = { workFolderId, revision, models: result.models, status: result.status };
        composerModelLists.set(workFolderId, next);
        setList(next);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, fixtureMode, workFolderId, revision]);

  const currentList = list?.workFolderId === workFolderId ? list : null;
  const models = fixtureMode
    ? shownModel ? [{ ...shownModel, authConfigured: true, oauthSupported: false } satisfies AgentModel] : []
    : (currentList?.models ?? []).filter((model) => model.authConfigured);
  const saved = !fixtureMode && currentList?.status.configured && currentList.status.provider && currentList.status.model
    ? { provider: currentList.status.provider, id: currentList.status.model }
    : shownModel;
  const filterable = models.length > composerModelFilterThreshold;
  const view = composerModelListView(models, filterable ? query : "", saved);
  const heading = forNewChats ? "Model for new Chats" : "Model";
  const noMatches = filterable && query.trim() !== "" && !view.groups.length;

  function focusOption(edge: "start" | "end"): boolean {
    const options = optionsRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)');
    const option = options?.[edge === "end" ? options.length - 1 : 0];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
    return Boolean(option);
  }

  useEffect(() => {
    if (!open) { pendingFocusRef.current = null; return; }
    if (pendingFocusRef.current && focusOption(pendingFocusRef.current)) pendingFocusRef.current = null;
  }, [open, models.length]);

  function navigateOptions(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)') ?? []);
    const next = nextMenuItemIndex(options.indexOf(document.activeElement as HTMLButtonElement), options.length, event.key as MenuNavigationKey);
    if (next === null) return;
    event.preventDefault();
    options[next]?.focus({ preventScroll: true });
    options[next]?.scrollIntoView({ block: "nearest" });
  }

  function renderOption(model: AgentModel) {
    const selected = saved?.provider === model.provider && saved.id === model.id;
    const key = `${model.provider}/${model.id}`;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={selected}
        className={selected ? "active" : undefined}
        disabled={Boolean(saving)}
        onClick={() => void choose(model)}
      >
        <span className="composer-model-name">{model.name || model.id}</span>
        {saving === key ? <Loader2 className="spin" size={12} aria-hidden="true" /> : null}
      </button>
    );
  }

  async function choose(model: AgentModel): Promise<void> {
    if (saving) return;
    // Keep keyboard focus when the selected option is disabled or unmounted.
    triggerRef.current?.focus({ preventScroll: true });
    if (fixtureMode || (saved?.provider === model.provider && saved.id === model.id)) {
      setOpen(false);
      return;
    }
    const key = `${model.provider}/${model.id}`;
    setSaving(key);
    setError(null);
    try {
      const result = await api<{ status: AgentStatus }>("/api/agent/configure", {
        method: "POST",
        body: { scope: "work-folder", workFolderId, provider: model.provider, model: model.id },
      });
      const cached = composerModelLists.get(workFolderId);
      if (cached) {
        const next = { ...cached, status: result.status };
        composerModelLists.set(workFolderId, next);
        setList(next);
      }
      setOpen(false);
      onSaved(result.status, model);
      showToast({ text: `${heading}: ${model.name || model.id}`, tone: "success" });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="composer-model-control" ref={containerRef} onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        className={open ? `${className} active` : className}
        type="button"
        aria-disabled={disabled || undefined}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={reasoning ? `${ariaLabel}. Reasoning: ${thinkingLevelLabel(reasoning.level)}` : ariaLabel}
        title={disabled ? "Model and reasoning changes apply between turns" : reasoning ? `${title} · Reasoning: ${thinkingLevelLabel(reasoning.level)}` : title}
        onClick={() => { if (!disabled) setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (disabled || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
          event.preventDefault();
          const edge = event.key === "ArrowUp" ? "end" : "start";
          pendingFocusRef.current = open && focusOption(edge) ? null : edge;
          setOpen(true);
        }}
      >
        {children}
        {reasoning ? <span className="composer-model-reasoning">{thinkingLevelLabel(reasoning.level)}</span> : null}
        <ChevronDown16Regular className="composer-model-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="composer-command-menu composer-model-menu" id={menuId}>
          <div className="composer-command-menu-heading"><span>{heading}</span></div>
          {filterable ? (
            <input
              className="composer-model-filter"
              type="search"
              value={query}
              placeholder="Search models"
              aria-label="Search models"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // The composer is a form; Enter here picks, never sends.
                  event.preventDefault();
                  const first = query.trim() ? view.groups[0]?.models[0] : undefined;
                  if (first) void choose(first);
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(event.key === "ArrowUp" ? "end" : "start");
                }
              }}
            />
          ) : null}
          {models.length ? (
            <div className="composer-model-options" role="listbox" aria-label={heading} ref={optionsRef} onKeyDown={navigateOptions}>
              {view.current ? (
                <div className="composer-model-group" role="group" aria-label="Current">
                  {view.groups.length ? <div className="composer-model-provider" aria-hidden="true">Current</div> : null}
                  {renderOption(view.current)}
                </div>
              ) : null}
              {view.groups.map((group) => (
                <div className="composer-model-group" role="group" aria-label={group.name} key={group.provider}>
                  {view.providerCount > 1 ? <div className="composer-model-provider" aria-hidden="true">{group.name}</div> : null}
                  {group.models.map(renderOption)}
                </div>
              ))}
              {noMatches ? <div className="composer-model-status" role="status">No matching models</div> : null}
            </div>
          ) : loading ? (
            <div className="composer-model-status" role="status">Loading models</div>
          ) : !error ? (
            <div className="composer-model-status" role="status">No connected models</div>
          ) : null}
          {error ? <div className="composer-model-error" role="alert">{error}</div> : null}
          {reasoning ? (
            <div className="composer-reasoning">
              <div className="composer-command-menu-heading" id={`${menuId}-reasoning`}>
                <span>{reasoning.forThisChat ? "Reasoning for this Chat" : "Reasoning"}</span>
              </div>
              <div className="composer-reasoning-levels" role="radiogroup" aria-labelledby={`${menuId}-reasoning`}>
                {reasoning.levels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={level === reasoning.level}
                    className={level === reasoning.level ? "active" : undefined}
                    onClick={() => {
                      setOpen(false);
                      triggerRef.current?.focus({ preventScroll: true });
                      if (level !== reasoning.level) void reasoning.onChange(level);
                    }}
                  >
                    {thinkingLevelLabel(level)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <button
            className="composer-model-settings"
            type="button"
            onClick={() => {
              setOpen(false);
              onOpenModelSettings?.();
            }}
          >
            Model settings
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConfiguredModel({ model, workFolderName, picker, reasoning }: { model: NonNullable<ComposerState["model"]>; workFolderName: string; picker: ComposerModelPickerProps; reasoning?: ComposerReasoning }) {
  const label = model.name || displayModelLabel(model.provider, model.id);
  return (
    <ComposerModelPicker
      {...picker}
      reasoning={reasoning}
      className="conversation-context-meter configured"
      ariaLabel={`Change the model saved for ${workFolderName}. Selected model: ${label}`}
      title={`Selected model for new Chats: ${label} · Change the model saved for ${workFolderName}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="track" cx="12" cy="12" r="9" pathLength="100" />
      </svg>
      <span className="conversation-context-model">{label}</span>
    </ComposerModelPicker>
  );
}

/** How deep the attach picker reads a work-folder, the same depth Files searches. */
const attachPickerTreeDepth = 6;
const attachPickerVisibleLimit = 60;

type AttachPickerFile = { path: string; name: string; folder: string; updatedAt: number };

/** Files a person can attach, without other work-folders nested inside this one. */
function attachPickerFiles(entries: TreeEntry[], output: AttachPickerFile[] = []): AttachPickerFile[] {
  for (const entry of entries) {
    if (entry.nestedFolder || entry.ignored) continue;
    if (entry.kind === "folder") {
      attachPickerFiles(entry.children ?? [], output);
      continue;
    }
    const slash = entry.path.lastIndexOf("/");
    output.push({
      path: entry.path,
      name: entry.name,
      folder: slash > 0 ? entry.path.slice(0, slash) : "",
      updatedAt: entry.updatedAt ? Date.parse(entry.updatedAt) || 0 : 0,
    });
  }
  return output;
}

/**
 * The composer's + button (2026-10-27): attach files from this work-folder,
 * or copy files from the computer into its Dropped folder and attach them,
 * the same explicit act as dropping them on the composer.
 */
function ComposerAttachMenu({
  workFolderId,
  workFolderName,
  identity,
  fixtureMode,
  fixtureTreeEntries,
  attachedPaths,
  onAttachPath,
  onUploadFiles,
}: {
  workFolderId: string;
  workFolderName: string;
  identity: WorkFolderIdentity;
  fixtureMode: boolean;
  fixtureTreeEntries: TreeEntry[];
  attachedPaths: string[];
  onAttachPath: (path: string) => void;
  onUploadFiles?: (transfer: DataTransfer) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"choose" | "files">("choose");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<AttachPickerFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuId = useId();
  useDismissOnOutsideInteraction(open, containerRef, () => setOpen(false), triggerRef);
  useEffect(() => {
    if (open) return;
    setView("choose");
    setQuery("");
    setError(null);
    // Files can be created, renamed or removed between visits to the picker.
    setFiles(null);
  }, [open]);
  useEffect(() => { setFiles(null); }, [workFolderId]);
  useEffect(() => {
    if (!open || view !== "files" || files) return;
    if (fixtureMode) {
      setFiles(attachPickerFiles(fixtureTreeEntries));
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ maxDepth: String(attachPickerTreeDepth) });
    void api<{ tree: TreeEntry[] }>(`/api/work-folders/${workFolderId}/tree?${params}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setFiles(attachPickerFiles(result.tree)); })
      .catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); });
    return () => controller.abort();
  }, [open, view, files, fixtureMode, fixtureTreeEntries, workFolderId]);

  const matches = useMemo(() => {
    if (!files) return [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [...files].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    return files
      .filter((file) => file.path.toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(!a.name.toLocaleLowerCase().includes(needle)) - Number(!b.name.toLocaleLowerCase().includes(needle)) || a.path.localeCompare(b.path));
  }, [files, query]);
  const visible = matches.slice(0, attachPickerVisibleLimit);
  const attached = new Set(attachedPaths);

  function attach(path: string): void {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
    if (!attached.has(path)) onAttachPath(path);
  }

  function focusOption(edge: "start" | "end"): void {
    const options = optionsRef.current?.querySelectorAll<HTMLButtonElement>("button");
    options?.[edge === "end" ? options.length - 1 : 0]?.focus({ preventScroll: true });
  }

  return (
    <div className="composer-attach-control" ref={containerRef}>
      <button
        ref={triggerRef}
        className={open ? "composer-attach-trigger active" : "composer-attach-trigger"}
        type="button"
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Attach files"
        onClick={() => setOpen((current) => !current)}
      >
        <Add16Regular aria-hidden="true" />
      </button>
      {onUploadFiles ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={(event) => {
            const chosen = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (!chosen.length) return;
            const transfer = new DataTransfer();
            chosen.forEach((file) => transfer.items.add(file));
            onUploadFiles(transfer);
          }}
        />
      ) : null}
      {open && view === "choose" ? (
        <div className="composer-command-menu composer-attach-menu" id={menuId} role="menu" aria-label="Attach files">
          <button type="button" role="menuitem" autoFocus onClick={() => setView("files")}>
            <span className="composer-attach-option-icon" style={workFolderIdentityStyle(identity)}><WorkFolderIconGlyph icon={identity.Icon} size={18} /></span>
            <span className="composer-attach-option-copy">
              <strong>From {workFolderName}</strong>
              <small>Pick files in this work-folder</small>
            </span>
          </button>
          {onUploadFiles ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); fileInputRef.current?.click(); }}>
              <span className="composer-attach-option-icon"><Desktop20Regular aria-hidden="true" /></span>
              <span className="composer-attach-option-copy">
                <strong>From This Computer</strong>
                <small>Copies them into the Dropped folder</small>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
      {open && view === "files" ? (
        <div className="composer-command-menu composer-attach-menu composer-attach-picker" id={menuId} role="dialog" aria-label={`Attach from ${workFolderName}`}>
          <div className="composer-attach-search">
            <button type="button" className="composer-attach-back" aria-label="Back" title="Back" onClick={() => setView("choose")}>
              <ChevronLeft16Regular aria-hidden="true" />
            </button>
            <Search16Regular className="composer-attach-search-icon" aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={`Search ${workFolderName}`}
              aria-label={`Search ${workFolderName}`}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  // The composer is a form; Enter here attaches, never sends.
                  event.preventDefault();
                  if (visible[0]) attach(visible[0].path);
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  focusOption(event.key === "ArrowUp" ? "end" : "start");
                }
              }}
            />
          </div>
          {error ? <div className="composer-model-error" role="alert">{error}</div>
            : !files ? <div className="composer-model-status" role="status">Loading files</div>
              : !visible.length ? <div className="composer-model-status" role="status">{query.trim() ? "No matching files" : "No files yet"}</div>
                : (
                  <div
                    className="composer-attach-options"
                    role="listbox"
                    aria-label={`Files in ${workFolderName}`}
                    ref={optionsRef}
                    onKeyDown={(event) => {
                      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                      const options = Array.from(optionsRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
                      const next = nextMenuItemIndex(options.indexOf(document.activeElement as HTMLButtonElement), options.length, event.key as MenuNavigationKey);
                      if (next === null) return;
                      event.preventDefault();
                      options[next]?.focus({ preventScroll: true });
                      options[next]?.scrollIntoView({ block: "nearest" });
                    }}
                  >
                    {visible.map((file) => (
                      <button key={file.path} type="button" role="option" aria-selected={attached.has(file.path)} title={file.path} onClick={() => attach(file.path)}>
                        <FileTypeIcon path={file.path} />
                        <span className="composer-attach-file-name">{file.name}</span>
                        {file.folder ? <span className="composer-attach-file-folder">{file.folder}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
          {matches.length > visible.length ? <div className="composer-model-status">Type to narrow {matches.length.toLocaleString()} files</div> : null}
        </div>
      ) : null}
    </div>
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

function ChatEmptyState({
  greeting,
  workFolder,
  identity,
}: {
  greeting: string;
  workFolder: WorkFolderSummary;
  identity: WorkFolderIdentity;
}) {
  const Icon = identity.Icon;
  return (
    <div className="chat-empty-state" style={workFolderIdentityStyle(identity)}>
      <strong>{greeting}</strong>
      <span className="chat-empty-work-folder">
        <WorkFolderIconGlyph icon={Icon} size={15} />
        <span>{workFolder.name}</span>
      </span>
    </div>
  );
}

/** Up to three of this work-folder's Chats, newest first, on a new Chat's start screen. */
function ChatRecentChats({ chats, onOpen }: { chats: ConversationSummary[]; onOpen: (conversation: ConversationSummary) => void }) {
  const headingId = useId();
  return (
    <section className="chat-recent" aria-labelledby={headingId}>
      <h2 id={headingId}>Recent Chats</h2>
      <ul>
        {chats.map((chat) => (
          <li key={chat.id}>
            <button type="button" onClick={() => onOpen(chat)}>
              <Chat16Regular className="chat-recent-icon" aria-hidden="true" />
              <span className="chat-recent-title">{chat.title}</span>
              <time className="chat-recent-time" dateTime={chat.updatedAt}>{formatChatListTime(chat.updatedAt)}</time>
            </button>
          </li>
        ))}
      </ul>
    </section>
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
// conversation claims it, so extra tabs for the same work-folder never restart the show.
let fixtureScriptPlaybackClaimed = false;

function fixtureScriptPlayback(): { conversationId: string; delayMs: number } | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("fixture") !== "work-folder") return null;
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
      durationMs: 6_400,
    },
    {
      id: "fixture-tool-read",
      kind: "tool",
      toolName: "read",
      text: "Read finished",
      detail: "Kitchen refresh/ideas.md",
      phase: "complete",
    },
    {
      id: "fixture-thinking-hidden",
      kind: "thinking",
      text: "",
      phase: "complete",
      durationMs: 2_800,
    },
    {
      id: "fixture-tool-search",
      kind: "tool",
      toolName: "bash",
      text: "Bash finished",
      detail: "rg -n \"allowance|cabinetry\" \"Kitchen refresh/ideas.md\" | head -20 && wc -l \"Kitchen refresh/ideas.md\"",
      phase: "complete",
    },
    {
      id: "fixture-thinking-formatting",
      kind: "thinking",
      text: "**Organizing the result**\n\nI’m separating the cost differences from the open questions so the next action is easy to see:\n\n```\n| Option | Best for | Main risk | A note that is only here so the line is long enough to need wrapping inside the thought |\n```",
      phase: "complete",
      durationMs: 3_100,
    },
    {
      id: "fixture-tool-read-budget",
      kind: "tool",
      toolName: "read",
      text: running ? "Read running" : "Read finished",
      detail: "Kitchen refresh/budget.xlsx",
      phase: running ? "running" : "complete",
    },
  ];
  if (running) {
    previews.push({
      id: "fixture-thinking-next",
      kind: "thinking",
      text: "",
      phase: "streaming",
      startedAt: Date.now() - 1_500,
    });
  }
  return previews;
}

/**
 * A failed turn whose reply already says why, with nothing else to show (no
 * questions, other Workers, or files), needs no second "Couldn't finish" line.
 */
function failureShownInReply(work: WorkRequestView | null, messages: ChatMessage[]): boolean {
  if (!work || work.state !== "failed" || work.children.length || work.questions.length || work.result?.files.length) return false;
  const last = messages.at(-1);
  return last?.role === "assistant" && Boolean(last.interruption);
}
