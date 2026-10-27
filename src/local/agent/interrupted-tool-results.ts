import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * A tool call that never recorded a result tells the model so honestly.
 *
 * Pi saves an assistant message when it ends and each tool result when that
 * tool finishes. When work-fold closes or crashes while a tool runs, the
 * session keeps the call and no result. Before every model request Pi fills
 * the gap with an error result reading only "No result provided", and the
 * model reads that as a failed call it can simply repeat — although the call
 * may have half-run (a partly written file, a sent request).
 *
 * This hook supplies that missing result itself, at the position Pi would,
 * with the truth: nothing was recorded, the call may have partly happened, and
 * its effects should be checked before running it again (Pi Durable's
 * "interrupted, not replayed" rule, 2026-10-27). Nothing is written to the
 * session and no tool is ever replayed.
 */

export const interruptedToolResultText = "No result was recorded for this call: work-fold closed, or the turn was stopped, while it was running. It may have partly happened. Check its effects (for example, the files it was changing) before running it again.";

type ContextMessage = {
  role: string;
  content?: unknown;
  stopReason?: string;
  toolCallId?: string;
  timestamp?: number;
};

type ToolCallBlock = { type: "toolCall"; id: string; name: string };

function toolCalls(message: ContextMessage): ToolCallBlock[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  // Pi drops errored and aborted assistant messages, with their calls, before sending.
  if (message.stopReason === "error" || message.stopReason === "aborted") return [];
  return message.content.filter((block): block is ToolCallBlock => !!block && typeof block === "object"
    && (block as { type?: unknown }).type === "toolCall" && typeof (block as { id?: unknown }).id === "string");
}

/**
 * Inserts an honest result for each tool call that has none, right before the
 * next message that would close the call's group (as Pi's own filler does).
 * Returns undefined when every call already has a result.
 */
export function fillInterruptedToolResults<T extends ContextMessage>(messages: T[]): T[] | undefined {
  const answered = new Set<string>();
  for (const message of messages) if (message.role === "toolResult" && typeof message.toolCallId === "string") answered.add(message.toolCallId);
  const missing = messages.flatMap(toolCalls).filter((call) => !answered.has(call.id));
  if (!missing.length) return undefined;
  const result: T[] = [];
  let pending: ToolCallBlock[] = [];
  let pendingAt = 0;
  const close = () => {
    for (const call of pending) {
      if (answered.has(call.id)) continue;
      result.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: interruptedToolResultText }],
        isError: true,
        timestamp: pendingAt,
      } as unknown as T);
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== "toolResult" && message.role !== "system") close();
    const calls = toolCalls(message);
    if (calls.length) {
      pending = calls;
      pendingAt = message.timestamp ?? Date.now();
    }
    result.push(message);
  }
  close();
  return result;
}

/** Built-in session extension that keeps interrupted tool calls honest in every model request. */
export function interruptedToolResultsExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const messages = fillInterruptedToolResults(event.messages as ContextMessage[]);
      return messages ? { messages: messages as typeof event.messages } : undefined;
    });
  };
}
