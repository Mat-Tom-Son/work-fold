export const untitledConversationTitle = "New Chat";

export function normalizeConversationTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

export function normalizeGeneratedConversationTitle(value: string | null | undefined): string | null {
  const firstLine = value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const unwrapped = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .trim();
  if (!unwrapped) return null;
  const concise = unwrapped.split(/\s+/).slice(0, 7).join(" ").replace(/[.!?,:;…]+$/g, "");
  return normalizeConversationTitle(concise) || null;
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
