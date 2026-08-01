import type { AgentActivityEvent, ContextAttachment, ConversationSummary, SpaceFixtureConversation } from "../types";

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

export function fixtureAgentActivityEvents(): AgentActivityEvent[] {
  if (new URLSearchParams(window.location.search).get("agentEvents") !== "1") return [];
  return [
    { id: "fixture-files", message: "Reading project notes", detail: "Project Notes.docx", phase: "complete", toolName: "read" },
    { id: "fixture-search", message: "Searching files", detail: "8 matches", phase: "complete", toolName: "search" },
    { id: "fixture-command", message: "Organizing the Space", detail: "Created a reusable outline", phase: "complete", toolName: "write" },
  ];
}
