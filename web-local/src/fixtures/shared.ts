import type { ContextAttachment, ConversationSummary, WorkFolderFixtureConversation } from "../types";

export function fixtureConversationSummary(conversation: WorkFolderFixtureConversation): ConversationSummary {
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
  return { sourcePath: path, sourceFileName, sourceSizeBytes: 128_000, mode: "path_only_reference", includedInPrompt: false, reason: null, estimatedTokens: 0, budgetTokens: 0, provenance: [], warnings: [], userLabel: "File", detail: "The Worker can inspect this file with its tools when you send your message." };
}
