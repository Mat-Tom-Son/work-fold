/**
 * The native right-click menu for the work-folder header (macOS), with the
 * same actions as the in-app menu other platforms show (2026-11-05).
 */
export type NativeWorkFolderMenuCommand = "new-chat" | "customize" | "set-up" | "look" | "reveal" | "manage";

export interface NativeWorkFolderMenuRequest {
  /** Which of the header's actions this work-folder offers; Manage work-folders is always there. */
  actions: { newChat: boolean; customize: boolean; setUp: boolean; reveal: boolean };
  point: { x: number; y: number };
}

export type NativeWorkFolderMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeWorkFolderMenuCommand };

const requestKeys = new Set(["actions", "point"]);
const actionKeys = new Set(["newChat", "customize", "setUp", "reveal"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeWorkFolderMenuRequest(value: unknown): NativeWorkFolderMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The work-folder menu request is invalid.");
  const { actions, point } = value;
  if (!isRecord(actions) || !hasOnlyKeys(actions, actionKeys) || ![...actionKeys].every((key) => typeof actions[key] === "boolean")) {
    throw new Error("The work-folder menu request is invalid.");
  }
  if (!isRecord(point) || !hasOnlyKeys(point, pointKeys) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("The work-folder menu position is invalid.");
  }
  return {
    actions: {
      newChat: actions.newChat as boolean,
      customize: actions.customize as boolean,
      setUp: actions.setUp as boolean,
      reveal: actions.reveal as boolean,
    },
    point: {
      x: Math.max(0, Math.min(1_000_000, Math.round(point.x as number))),
      y: Math.max(0, Math.min(1_000_000, Math.round(point.y as number))),
    },
  };
}

export function nativeWorkFolderMenuItems(request: NativeWorkFolderMenuRequest): NativeWorkFolderMenuItem[] {
  const { actions } = request;
  const items: NativeWorkFolderMenuItem[] = [];
  if (actions.newChat) items.push({ type: "item", label: "New Chat", command: "new-chat" });
  if (actions.customize) items.push({ type: "item", label: "Customize work-folder", command: "customize" });
  if (actions.setUp) {
    items.push(
      { type: "item", label: "Set Up for Me", command: "set-up" },
      { type: "item", label: "Just the Look", command: "look" },
    );
  }
  if (actions.reveal) items.push({ type: "item", label: "Show in Finder", command: "reveal" });
  if (items.length) items.push({ type: "separator" });
  items.push({ type: "item", label: "Manage work-folders", command: "manage" });
  return items;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
