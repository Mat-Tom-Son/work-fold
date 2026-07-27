export const untitledConversationTitle = "New Chat";

export function normalizeConversationTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function conversationTitleFromFirstUserMessage(content: string | null | undefined): string | null {
  const normalized = content?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) return null;
  if (normalized.length <= 60) return normalized;
  const prefix = normalized.slice(0, 60);
  const wordBoundary = prefix.search(/\s+\S*$/);
  const trimmed = (wordBoundary > 0 ? prefix.slice(0, wordBoundary) : prefix).trim();
  return `${trimmed || prefix.trim()}...`;
}
