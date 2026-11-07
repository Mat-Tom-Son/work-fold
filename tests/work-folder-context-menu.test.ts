import assert from "node:assert/strict";
import test from "node:test";

import { nativeWorkFolderMenuItems, parseNativeWorkFolderMenuRequest } from "../desktop/src/work-folder-context-menu.js";

function outline(value: unknown): string[] {
  return nativeWorkFolderMenuItems(parseNativeWorkFolderMenuRequest(value)).map((item) => item.type === "separator" ? "—" : `${item.label} (${item.command})`);
}

const point = { x: 12.6, y: 40.2 };

test("the work-folder header's native menu offers the same actions as the in-app menu", () => {
  assert.deepEqual(outline({ actions: { newChat: true, customize: true, setUp: true, reveal: true }, point }), [
    "New Chat (new-chat)",
    "Customize work-folder (customize)",
    "Set Up for Me (set-up)",
    "Just the Look (look)",
    "Show in Finder (reveal)",
    "—",
    "Manage work-folders (manage)",
  ]);
  assert.deepEqual(outline({ actions: { newChat: false, customize: false, setUp: false, reveal: false }, point }), ["Manage work-folders (manage)"]);
  assert.deepEqual(parseNativeWorkFolderMenuRequest({ actions: { newChat: true, customize: false, setUp: false, reveal: false }, point }).point, { x: 13, y: 40 });
});

test("the work-folder header's native menu rejects malformed requests", () => {
  const actions = { newChat: true, customize: true, setUp: true, reveal: true };
  for (const bad of [
    null,
    { actions, point, extra: true },
    { actions: { ...actions, delete: true }, point },
    { actions: { ...actions, newChat: "yes" }, point },
    { actions: { newChat: true, customize: true, setUp: true }, point },
    { actions, point: { x: Number.NaN, y: 0 } },
  ]) {
    assert.throws(() => parseNativeWorkFolderMenuRequest(bad), /invalid/);
  }
});

test("the file manager's Action menu adds Skills & Extensions and Settings and leaves out Manage", () => {
  const request = parseNativeWorkFolderMenuRequest({
    actions: { newChat: false, customize: false, setUp: true, reveal: true, skills: true, settings: true, manage: false },
    point: { x: 10, y: 20 },
  });
  assert.deepEqual(nativeWorkFolderMenuItems(request).map((item) => item.type === "item" ? item.label : "—"), [
    "Set Up for Me", "Just the Look", "Show in Finder", "Skills & Extensions…", "—", "Settings…",
  ]);
  // Older renderers send only the four header actions and still get Manage work-folders.
  const header = parseNativeWorkFolderMenuRequest({ actions: { newChat: true, customize: true, setUp: false, reveal: false }, point: { x: 0, y: 0 } });
  assert.equal(nativeWorkFolderMenuItems(header).at(-1)?.type === "item" && (nativeWorkFolderMenuItems(header).at(-1) as { label: string }).label, "Manage work-folders");
  assert.throws(() => parseNativeWorkFolderMenuRequest({ actions: { newChat: true, customize: true, setUp: false, reveal: false, skills: "yes" }, point: { x: 0, y: 0 } }), /invalid/);
});

test("the file manager's sidebar menus: a Standard Folder's right-click and the + beside work-folders", () => {
  const labels = (actions: Record<string, boolean>) => nativeWorkFolderMenuItems(parseNativeWorkFolderMenuRequest({
    actions: { newChat: false, customize: false, setUp: false, reveal: false, manage: false, ...actions },
    point: { x: 0, y: 0 },
  })).map((item) => item.type === "item" ? item.label : "—");
  assert.deepEqual(labels({ reveal: true, putToWork: true }), ["Show in Finder", "Put This Folder to Work"]);
  assert.deepEqual(labels({ reveal: true, putToWork: true, removeFromSidebar: true }), ["Show in Finder", "Put This Folder to Work", "—", "Remove from Sidebar"]);
  assert.deepEqual(labels({ createWorkFolder: true, useExistingFolder: true }), ["Create New work-folder…", "Use Existing Folder…"]);
  assert.deepEqual(labels({ customize: true, settings: true, remove: true }), ["Customize work-folder", "—", "Remove work-folder…", "Settings…"]);
});
