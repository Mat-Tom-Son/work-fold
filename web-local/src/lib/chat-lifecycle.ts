import type { ChatActivityStatus, ChatLifecycleView, ConversationSummary } from "../types";

const hourMs = 60 * 60 * 1_000;

export interface ChatSnoozePreset {
  id: "hour" | "evening" | "tomorrow" | "next-week";
  label: string;
  detail: string;
  snoozedUntil: string;
}

export function conversationLifecycleView(
  conversation: ConversationSummary,
  now = Date.now(),
): ChatLifecycleView {
  if (conversation.archivedAt) return "archived";
  const snoozedUntil = conversation.snoozedUntil
    ? Date.parse(conversation.snoozedUntil)
    : Number.NaN;
  return Number.isFinite(snoozedUntil) && snoozedUntil > now ? "snoozed" : "active";
}

export function isRecentlyResurfaced(
  conversation: ConversationSummary,
  now = Date.now(),
): boolean {
  if (conversation.archivedAt || !conversation.snoozedUntil) return false;
  const snoozedUntil = Date.parse(conversation.snoozedUntil);
  return Number.isFinite(snoozedUntil)
    && snoozedUntil <= now
    && now - snoozedUntil < 24 * hourMs;
}

export function resolveChatSnoozePresets(now: Date): ChatSnoozePreset[] {
  const presets: ChatSnoozePreset[] = [];
  const inOneHour = new Date(now.getTime() + hourMs);
  presets.push(preset("hour", "In 1 hour", inOneHour, timeLabel(inOneHour)));

  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > hourMs) {
    presets.push(preset("evening", "This evening", evening, timeLabel(evening)));
  }

  const tomorrow = atHour(addDays(now, 1), 9);
  presets.push(preset("tomorrow", "Tomorrow", tomorrow, timeLabel(tomorrow)));

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), 9);
  presets.push(preset(
    "next-week",
    "Next week",
    nextWeek,
    `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeLabel(nextWeek)}`,
  ));
  return presets;
}

export function chatSnoozeTimeLabel(value: string, now = new Date()): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const time = timeLabel(date);
  const dayDelta = localDayOrdinal(date) - localDayOrdinal(now);
  if (dayDelta === 0) return `Today, ${time}`;
  if (dayDelta === 1) return `Tomorrow, ${time}`;
  if (dayDelta > 1 && dayDelta < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })}, ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function chatActivityKey(spaceId: string, conversationId: string): string {
  return `${spaceId}:${conversationId}`;
}

export function aggregateChatActivityStatus(
  spaceId: string,
  conversations: readonly ConversationSummary[],
  statuses: Readonly<Record<string, ChatActivityStatus>>,
): ChatActivityStatus | null {
  if (conversations.some((chat) => statuses[chatActivityKey(spaceId, chat.id)] === "running")) return "running";
  if (conversations.some((chat) => statuses[chatActivityKey(spaceId, chat.id)] === "attention")) return "attention";
  return null;
}

function preset(
  id: ChatSnoozePreset["id"],
  label: string,
  date: Date,
  detail: string,
): ChatSnoozePreset {
  return { id, label, detail, snoozedUntil: date.toISOString() };
}

function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const result = new Date(base);
  result.setHours(hour, 0, 0, 0);
  return result;
}

function addDays(base: Date, days: number): Date {
  const result = new Date(base);
  result.setDate(result.getDate() + days);
  return result;
}

function localDayOrdinal(value: Date): number {
  return Math.round(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / (24 * hourMs));
}
