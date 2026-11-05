/**
 * The native right-click menu for a work-folder tab, or for a Chat in the
 * Chats list: the Chat's own actions, then the tab strip's. Browser tabs have
 * their own menu in built-in-browser.ts.
 */
export type NativeTabMenuCommand =
  | "rename"
  | "copy"
  | "resume"
  | "archive"
  | "restore"
  | "delete"
  | "close"
  | "close-others"
  | "close-right"
  | "reopen"
  | `snooze:${string}`;

export interface NativeTabMenuSnoozePreset {
  id: string;
  label: string;
  detail: string;
}

export interface NativeTabMenuRequest {
  /** The Chat's actions; absent for a tab that holds no saved Chat. */
  chat?: { lifecycle: "active" | "snoozed" | "archived"; snooze: NativeTabMenuSnoozePreset[] };
  /** The tab strip's actions; absent when the menu opens from the Chats list. */
  tab?: { hasOthers: boolean; hasRight: boolean; canReopen: boolean };
  point: { x: number; y: number };
}

export type NativeTabMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeTabMenuCommand; sublabel?: string; enabled?: false }
  | { type: "submenu"; label: string; items: NativeTabMenuItem[] };

const requestKeys = new Set(["chat", "tab", "point"]);
const chatKeys = new Set(["lifecycle", "snooze"]);
const presetKeys = new Set(["id", "label", "detail"]);
const tabKeys = new Set(["hasOthers", "hasRight", "canReopen"]);
const pointKeys = new Set(["x", "y"]);
const lifecycles = new Set(["active", "snoozed", "archived"]);

export function parseNativeTabMenuRequest(value: unknown): NativeTabMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The tab menu request is invalid.");
  const { chat, tab, point } = value;
  if (chat === undefined && tab === undefined) throw new Error("The tab menu request is invalid.");
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("The tab menu position is invalid.");
  }
  const request: NativeTabMenuRequest = {
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
  if (chat !== undefined) {
    if (!isRecord(chat) || !hasOnlyKeys(chat, chatKeys) || !lifecycles.has(chat.lifecycle as string)) {
      throw new Error("The Chat menu request is invalid.");
    }
    if (!Array.isArray(chat.snooze) || chat.snooze.length > 8) throw new Error("The Chat's snooze times are invalid.");
    const snooze = chat.snooze.map((preset): NativeTabMenuSnoozePreset => {
      if (!isRecord(preset) || !hasOnlyKeys(preset, presetKeys)
        || typeof preset.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(preset.id)
        || !isShortText(preset.label) || !isShortText(preset.detail)) {
        throw new Error("The Chat's snooze times are invalid.");
      }
      return { id: preset.id, label: preset.label, detail: preset.detail };
    });
    request.chat = { lifecycle: chat.lifecycle as "active" | "snoozed" | "archived", snooze };
  }
  if (tab !== undefined) {
    if (!isRecord(tab) || !hasOnlyKeys(tab, tabKeys) || ![tab.hasOthers, tab.hasRight, tab.canReopen].every((flag) => typeof flag === "boolean")) {
      throw new Error("The tab menu request is invalid.");
    }
    request.tab = { hasOthers: tab.hasOthers as boolean, hasRight: tab.hasRight as boolean, canReopen: tab.canReopen as boolean };
  }
  return request;
}

export function nativeTabMenuItems(request: NativeTabMenuRequest): NativeTabMenuItem[] {
  const items: NativeTabMenuItem[] = [];
  const { chat, tab } = request;
  if (chat) {
    items.push(
      { type: "item", label: "Rename…", command: "rename" },
      { type: "item", label: "Make a Copy", command: "copy" },
      { type: "separator" },
    );
    if (chat.lifecycle === "snoozed") items.push({ type: "item", label: "Resume Now", command: "resume" });
    else if (chat.lifecycle === "active" && chat.snooze.length) {
      items.push({
        type: "submenu",
        label: "Snooze",
        items: chat.snooze.map((preset) => ({ type: "item", label: preset.label, sublabel: preset.detail, command: `snooze:${preset.id}` })),
      });
    }
    items.push(
      chat.lifecycle === "archived"
        ? { type: "item", label: "Restore to Active", command: "restore" }
        : { type: "item", label: "Archive", command: "archive" },
      { type: "item", label: "Delete Chat", command: "delete" },
    );
  }
  if (tab) {
    if (items.length) items.push({ type: "separator" });
    const item = (label: string, command: NativeTabMenuCommand, enabled: boolean): NativeTabMenuItem =>
      enabled ? { type: "item", label, command } : { type: "item", label, command, enabled: false };
    items.push(
      item("Close Tab", "close", true),
      item("Close Other Tabs", "close-others", tab.hasOthers),
      item("Close Tabs to the Right", "close-right", tab.hasRight),
      { type: "separator" },
      item("Reopen Closed Tab", "reopen", tab.canReopen),
    );
  }
  return items;
}

function isShortText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 80 && !/[\0\r\n]/.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
