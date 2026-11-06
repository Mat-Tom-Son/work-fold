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
