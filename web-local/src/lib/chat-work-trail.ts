import type { ChatMessage, RuntimePreviewEntry } from "../types";

export function savedWorkTrailPreviews(message: ChatMessage): RuntimePreviewEntry[] {
  if (message.role !== "assistant") return [];
  if (message.workTrail?.length) {
    return message.workTrail.map((entry, index) => ({
      id: `saved-${entry.kind}-${message.id}-${index}`,
      ...entry,
      phase: entry.phase ?? "complete",
    }));
  }
  return (message.interruption?.activities ?? []).map((activity, index) => ({
    id: `saved-tool-${message.id}-${index}`,
    kind: "tool",
    text: activity.message,
    ...(activity.detail ? { detail: activity.detail } : {}),
    ...(activity.toolName ? { toolName: activity.toolName } : {}),
    phase: activity.phase ?? "complete",
  }));
}
