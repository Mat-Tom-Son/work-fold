import { chatDraftKeyPrefix, chatDraftMaxStoredChars, chatDraftNewConversationId, untitledChatLabel } from "../constants";
import type { ChangeEntry, ChangeKindCounts, ChatMessage } from "../types";
import { conversationTitleFromFirstUserMessage } from "../../../src/shared/chat-title";
import { readStoredValue, writeStoredValue } from "./storage";

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

export function chatDraftStorageKey(workspaceId: string, conversationId: string | null, surfaceTabId?: string | null): string {
  const subject = conversationId ?? (surfaceTabId ? `draft:${surfaceTabId}` : chatDraftNewConversationId);
  return `${chatDraftKeyPrefix}:${workspaceId}:${subject}`;
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

export function compactUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch {
    return value;
  }
}

export function formatTimeAgo(value: string): string {
  const relative = formatChatListTime(value);
  return relative === "now" ? "Just now" : `${relative} ago`;
}

export function optimisticChatTitleFromFirstUserMessage(content: string | null | undefined): string | null {
  return conversationTitleFromFirstUserMessage(content);
}

export function chatDisplayTitle({
  serverTitle,
  firstUserMessage,
  messages,
}: {
  serverTitle?: string | null;
  firstUserMessage?: string | null;
  messages?: ChatMessage[];
}): string {
  const normalizedServerTitle = serverTitle?.replace(/\s+/g, " ").trim() ?? "";
  if (normalizedServerTitle && normalizedServerTitle !== untitledChatLabel) return normalizedServerTitle;
  const knownFirstUserMessage = firstUserMessage ?? messages?.find((message) => message.role === "user")?.content;
  return (optimisticChatTitleFromFirstUserMessage(knownFirstUserMessage) ?? normalizedServerTitle) || untitledChatLabel;
}

export function modelConversationTitle(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "system" || message.kind !== "conversation_title") continue;
    const title = message.content.replace(/\s+/g, " ").trim();
    if (message.titleSource === "placeholder") continue;
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
}

export function countChangeKinds(changes: ChangeEntry[]): ChangeKindCounts {
  return changes.reduce<ChangeKindCounts>(
    (counts, change) => {
      counts[change.kind] += 1;
      return counts;
    },
    { created: 0, modified: 0, deleted: 0, remote_deleted: 0 },
  );
}

export function changeKindSummaryText(counts: ChangeKindCounts): string {
  const parts = [
    counts.created ? formatItemCount(counts.created, "new file", "new files") : null,
    counts.modified ? formatItemCount(counts.modified, "modified file", "modified files") : null,
    counts.deleted ? formatItemCount(counts.deleted, "local deletion") : null,
    counts.remote_deleted ? formatItemCount(counts.remote_deleted, "deleted outside Workspace") : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" / ") : "No pending updates";
}

export function formatItemCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatActivityLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
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

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
