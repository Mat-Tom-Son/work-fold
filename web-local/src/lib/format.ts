import { chatDraftKeyPrefix, chatDraftMaxStoredChars, chatDraftNewConversationId, untitledChatLabel } from "../constants";
import type { ChatMessage } from "../types";
import { conversationTitleFromFirstUserMessage } from "../../../src/shared/chat-title";
import { readStoredJsonValue, readStoredValue, writeStoredJsonValue, writeStoredValue } from "./storage";

export interface StoredPendingChatSend {
  version: 1;
  requestId: string;
  userMessageId: string;
  content: string;
  createdAt: string;
  selectedPath: string | null;
  contextPaths: string[];
  transientConversation: boolean;
  draftStorageKey: string;
  /** Folder Workers the message @-mentions (2026-10-01). */
  addressedSpaceIds?: string[];
}

export function normalizeSearchQuery(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function splitConfirmMessage(message: string): { title: string; body?: string } {
  const text = message.trim();
  const questionIndex = text.indexOf("?");
  if (questionIndex < 0) return { title: text };
  const title = text.slice(0, questionIndex + 1).trim();
  const body = text.slice(questionIndex + 1).trim();
  return body ? { title, body } : { title };
}

export function chatDraftStorageKey(spaceId: string, conversationId: string | null, surfaceTabId?: string | null): string {
  const subject = conversationId ?? (surfaceTabId ? `draft:${surfaceTabId}` : chatDraftNewConversationId);
  return `${chatDraftKeyPrefix}:${spaceId}:${subject}`;
}

export function readStoredChatDraft(key: string): string {
  return readStoredValue(key) ?? "";
}

export function writeStoredChatDraft(key: string, draft: string): void {
  if (!draft) {
    writeStoredValue(key, null);
    return;
  }
  if (draft.length > chatDraftMaxStoredChars) return;
  writeStoredValue(key, draft);
}

export function clearStoredChatDraft(key: string): void {
  writeStoredValue(key, null);
}

export function pendingChatSendStorageKey(spaceId: string, conversationId: string): string {
  return `work-fold.space.pending-chat-send:${spaceId}:${conversationId}`;
}

export function readStoredPendingChatSend(spaceId: string, conversationId: string): StoredPendingChatSend | null {
  return readStoredJsonValue(pendingChatSendStorageKey(spaceId, conversationId), normalizePendingChatSend, null);
}

export function writeStoredPendingChatSend(spaceId: string, conversationId: string, value: StoredPendingChatSend): boolean {
  return writeStoredJsonValue(pendingChatSendStorageKey(spaceId, conversationId), value);
}

export function clearStoredPendingChatSend(spaceId: string, conversationId: string): void {
  writeStoredValue(pendingChatSendStorageKey(spaceId, conversationId), null);
}

function normalizePendingChatSend(value: unknown): StoredPendingChatSend | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StoredPendingChatSend>;
  if (record.version !== 1
    || typeof record.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(record.requestId)
    || typeof record.userMessageId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(record.userMessageId)
    || typeof record.content !== "string" || !record.content.trim() || record.content.length > chatDraftMaxStoredChars
    || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
    || (record.selectedPath !== null && typeof record.selectedPath !== "string")
    || !Array.isArray(record.contextPaths) || record.contextPaths.some((path) => typeof path !== "string")
    || typeof record.transientConversation !== "boolean"
    || typeof record.draftStorageKey !== "string") return null;
  return {
    version: 1,
    requestId: record.requestId,
    userMessageId: record.userMessageId,
    content: record.content,
    createdAt: record.createdAt,
    selectedPath: record.selectedPath,
    contextPaths: record.contextPaths,
    transientConversation: record.transientConversation,
    draftStorageKey: record.draftStorageKey,
    ...(Array.isArray(record.addressedSpaceIds) && record.addressedSpaceIds.every((id) => typeof id === "string")
      ? { addressedSpaceIds: record.addressedSpaceIds }
      : {}),
  };
}
export function formatTimeAgo(value: string): string {
  const relative = formatChatListTime(value);
  return relative === "now" ? "Just now" : `${relative} ago`;
}

export function chatDisplayTitle({
  serverTitle,
}: {
  serverTitle?: string | null;
}): string {
  const normalizedServerTitle = serverTitle?.replace(/\s+/g, " ").trim() ?? "";
  return normalizedServerTitle || untitledChatLabel;
}

export function modelConversationTitle(messages: ChatMessage[]): string | null {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content;
  const legacyFallback = conversationTitleFromFirstUserMessage(firstUserMessage);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "system" || message.kind !== "conversation_title") continue;
    const title = message.content.replace(/\s+/g, " ").trim();
    if (message.titleSource === "placeholder" || message.titleSource === "attempted") continue;
    const hasRecordedAttempt = messages.slice(0, index).some((candidate) =>
      candidate.kind === "conversation_title" && candidate.titleSource === "attempted");
    if (message.titleSource === "generated" && title === legacyFallback && !hasRecordedAttempt) continue;
    if (index === 0 && title === untitledChatLabel) continue;
    if (title) return title.slice(0, 80);
  }
  for (const message of [...messages].reverse()) {
    const title = message.landing?.conversationTitle?.replace(/\s+/g, " ").trim();
    if (title) return title.slice(0, 80);
  }
  return null;
}

export function latestTranscriptTime(messages: ChatMessage[]): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role === "system" && message.kind === "conversation_title" && message.createdAt) return message.createdAt;
    if (message.role !== "system" && message.createdAt) return message.createdAt;
  }
  return null;
}export function formatItemCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatChatListTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (elapsedMs < minuteMs) return "now";
  if (elapsedMs < hourMs) return `${Math.floor(elapsedMs / minuteMs)}m`;
  if (elapsedMs < dayMs) return `${Math.floor(elapsedMs / hourMs)}h`;
  if (elapsedMs < 7 * dayMs) return `${Math.floor(elapsedMs / dayMs)}d`;
  if (elapsedMs < 8 * 7 * dayMs) return `${Math.floor(elapsedMs / (7 * dayMs))}w`;
  return `${Math.max(1, Math.floor(elapsedMs / (30 * dayMs)))}mo`;
}
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
