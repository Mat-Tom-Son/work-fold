import type { ChatMessage } from "../types";

export function latestAssistantMessageId(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message.id;
  }
  return null;
}

export function settledTurnHasNewAssistantMessage(
  previousAssistantMessageId: string | null | undefined,
  transcript: ChatMessage[],
): boolean {
  if (previousAssistantMessageId === undefined) return true;
  const latestMessageId = latestAssistantMessageId(transcript);
  return latestMessageId !== null && latestMessageId !== previousAssistantMessageId;
}
