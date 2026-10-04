import type { ChatMessage, RuntimePreviewEntry } from "../types";
import type { AssistantPresentation } from "../../../src/shared/chat-presentation";

export interface AssistantTurnView {
  steps: RuntimePreviewEntry[];
  answer: string;
  hasFinal: boolean;
  segmented: boolean;
}

/** Never infer historical text/tool ordering from array positions or prose. */
export function assistantTurnView(
  content: string,
  presentation: AssistantPresentation | undefined,
  entries: RuntimePreviewEntry[],
  live?: { canonicalText: string; pendingOrder?: number },
): AssistantTurnView {
  const fallback = { steps: entries, answer: content, hasFinal: false, segmented: false };
  const source = live?.canonicalText ?? content;
  const segments = presentation?.segments ?? [];
  if (presentation && (presentation.version !== 1 || presentation.truncated || !segments.length || segments.length > 256)) return fallback;
  if (!presentation && !(live && source === "" && validOrder(live.pendingOrder))) return fallback;
  if (!content.startsWith(source)) return fallback;
  const orders = new Set<number>();
  for (const entry of entries) {
    if (!validOrder(entry.order) || orders.has(entry.order)) return fallback;
    orders.add(entry.order);
  }
  let offset = 0;
  let finalOrder: number | undefined;
  let previousTextOrder = -1;
  const steps = [...entries];
  let answer = "";
  for (const [index, segment] of segments.entries()) {
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end)
      || segment.start !== offset || segment.end <= offset || segment.end > source.length
      || !validOrder(segment.order) || segment.order <= previousTextOrder || orders.has(segment.order)
      || !["progress", "final", "command"].includes(segment.kind)
      || (index > 0 && source.slice(offset - 2, offset) !== "\n\n") || finalOrder !== undefined) return fallback;
    const text = source.slice(segment.start, segment.end);
    if (!text.trim()) return fallback;
    orders.add(segment.order);
    previousTextOrder = segment.order;
    if (segment.kind === "final") { answer = text; finalOrder = segment.order; }
    else steps.push({ id: `text:${segment.order}`, kind: segment.kind, text, order: segment.order, phase: "complete" });
    offset = segment.end + 2;
  }
  if (segments.length && segments.at(-1)!.end !== source.length) return fallback;
  const tail = content.slice(source.length);
  if (tail.trim()) {
    const order = live?.pendingOrder;
    if (!validOrder(order)) return fallback;
    const last = segments.at(-1);
    if (last?.order === order) {
      const text = content.slice(last.start);
      const row = steps.find((entry) => entry.id === `text:${order}`);
      if (row) Object.assign(row, { text, phase: "streaming" });
      else { steps.push({ id: `text:${order}`, kind: "progress", text, order, phase: "streaming" }); answer = ""; finalOrder = undefined; }
    } else {
      if (orders.has(order)) return fallback;
      steps.push({ id: `text:${order}`, kind: "progress", text: tail.replace(/^\n\n/u, ""), order, phase: "streaming" });
    }
  }
  // A later native step means this text was not the final outcome after all.
  if (finalOrder !== undefined && steps.some((entry) => entry.order! > finalOrder!)) {
    steps.push({ id: `text:${finalOrder}`, kind: "progress", text: answer, order: finalOrder, phase: "complete" });
    answer = ""; finalOrder = undefined;
  }
  steps.sort((a, b) => a.order! - b.order!);
  return { steps, answer, hasFinal: finalOrder !== undefined, segmented: true };
}

function validOrder(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

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
