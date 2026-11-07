/**
 * The native right-click menu for the work-folder header (macOS), with the
 * same actions as the in-app menu other platforms show (2026-11-05).
 */
export type NativeWorkFolderMenuCommand = "new-chat" | "customize" | "set-up" | "look" | "reveal" | "manage" | "skills" | "settings"
  | "put-to-work" | "remove-from-sidebar" | "create-work-folder" | "use-existing-folder" | "remove-work-folder";

export interface NativeWorkFolderMenuRequest {
  /**
   * Which of the header's actions this work-folder offers. Manage work-folders
   * is there unless `manage` is false. The file manager's Action menu
   * (2026-11-07) adds Skills & Extensions and Settings and leaves out Manage,
   * since its sidebar lists the work-folders; older renderers omit all three.
   */
  actions: {
    newChat: boolean; customize: boolean; setUp: boolean; reveal: boolean; skills?: boolean; settings?: boolean; manage?: boolean;
    /** The file manager's Standard Folders (2026-11-07): register the folder, or take an added one off the sidebar. */
    putToWork?: boolean; removeFromSidebar?: boolean;
    /** The file manager's + beside work-folders (2026-11-07). */
    createWorkFolder?: boolean; useExistingFolder?: boolean;
    /** The file manager's work-folder menus: stop using this folder as a work-folder. */
    remove?: boolean;
  };
  point: { x: number; y: number };
}

export type NativeWorkFolderMenuItem =
  | { type: "separator" }
  | { type: "item"; label: string; command: NativeWorkFolderMenuCommand };

const requestKeys = new Set(["actions", "point"]);
const actionKeys = new Set(["newChat", "customize", "setUp", "reveal"]);
const optionalActionKeys = new Set(["skills", "settings", "manage", "putToWork", "removeFromSidebar", "createWorkFolder", "useExistingFolder", "remove"]);
const pointKeys = new Set(["x", "y"]);

export function parseNativeWorkFolderMenuRequest(value: unknown): NativeWorkFolderMenuRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, requestKeys)) throw new Error("The work-folder menu request is invalid.");
  const { actions, point } = value;
  if (!isRecord(actions) || !hasOnlyKeys(actions, new Set([...actionKeys, ...optionalActionKeys]))
    || ![...actionKeys].every((key) => typeof actions[key] === "boolean")
    || ![...optionalActionKeys].every((key) => actions[key] === undefined || typeof actions[key] === "boolean")) {
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
      ...(actions.skills === true ? { skills: true } : {}),
      ...(actions.settings === true ? { settings: true } : {}),
      ...(actions.manage === false ? { manage: false } : {}),
      ...(actions.putToWork === true ? { putToWork: true } : {}),
      ...(actions.removeFromSidebar === true ? { removeFromSidebar: true } : {}),
      ...(actions.createWorkFolder === true ? { createWorkFolder: true } : {}),
      ...(actions.useExistingFolder === true ? { useExistingFolder: true } : {}),
      ...(actions.remove === true ? { remove: true } : {}),
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
  if (actions.createWorkFolder) items.push({ type: "item", label: "Create New work-folder…", command: "create-work-folder" });
  if (actions.useExistingFolder) items.push({ type: "item", label: "Use Existing Folder…", command: "use-existing-folder" });
  if (actions.newChat) items.push({ type: "item", label: "New Chat", command: "new-chat" });
  if (actions.customize) items.push({ type: "item", label: "Customize work-folder", command: "customize" });
  if (actions.setUp) {
    items.push(
      { type: "item", label: "Set Up for Me", command: "set-up" },
      { type: "item", label: "Just the Look", command: "look" },
    );
  }
  if (actions.reveal) items.push({ type: "item", label: "Show in Finder", command: "reveal" });
  if (actions.putToWork) items.push({ type: "item", label: "Put This Folder to Work", command: "put-to-work" });
  if (actions.skills) items.push({ type: "item", label: "Skills & Extensions…", command: "skills" });
  const tail: NativeWorkFolderMenuItem[] = [];
  if (actions.removeFromSidebar) tail.push({ type: "item", label: "Remove from Sidebar", command: "remove-from-sidebar" });
  if (actions.remove) tail.push({ type: "item", label: "Remove work-folder…", command: "remove-work-folder" });
  if (actions.manage !== false) tail.push({ type: "item", label: "Manage work-folders", command: "manage" });
  if (actions.settings) tail.push({ type: "item", label: "Settings…", command: "settings" });
  if (items.length && tail.length) items.push({ type: "separator" });
  items.push(...tail);
  return items;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
