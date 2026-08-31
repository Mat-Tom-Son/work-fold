import type { ContextAttachment, ConversationSummary, SpaceFixtureConversation } from "../types";

export function fixtureConversationSummary(conversation: SpaceFixtureConversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    archivedAt: conversation.archivedAt ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
  };
}

export function createFixtureContextAttachment(path: string): ContextAttachment {
  const sourceFileName = path.split("/").pop() ?? path;
  return { sourcePath: path, sourceFileName, sourceSizeBytes: 128_000, mode: "full_original_text", includedInPrompt: true, reason: null, estimatedTokens: 2_900, budgetTokens: 120_000, provenance: [], warnings: [], userLabel: "Full text", detail: "Full document text included in the conversation context." };
}
