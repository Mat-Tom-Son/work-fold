import assert from "node:assert/strict";
import test from "node:test";

import { migrateRendererStorage } from "../web-local/src/lib/storage-migration.js";

class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  get length() { return this.#items.size; }
  clear() { this.#items.clear(); }
  getItem(key: string) { return this.#items.get(key) ?? null; }
  key(index: number) { return [...this.#items.keys()][index] ?? null; }
  removeItem(key: string) { this.#items.delete(key); }
  setItem(key: string, value: string) { this.#items.set(key, String(value)); }
}

test("saved tabs, drafts, and preferences move to the work-folder keys once", () => {
  const storage = new MemoryStorage();
  storage.setItem("work-fold.space.active", "space-0123456789abcdef");
  storage.setItem("work-fold.space.mode", "spaces");
  storage.setItem("work-fold.space.chat-draft:space-0123456789abcdef:chat-1", "my space notes");
  storage.setItem("work-fold.space.surface-tabs.group-by-space.v1", "true");
  storage.setItem("work-fold.space.surface-tabs.v1", JSON.stringify({ version: 1, tabs: [
    { id: "space-automations:space-0123456789abcdef", kind: "space-automations", spaceId: "space-0123456789abcdef", title: "Automations" },
    { id: "file:x", kind: "file", spaceId: "space-0123456789abcdef", path: "space/notes.md", title: "notes.md" },
  ] }));
  storage.setItem("work-fold.space.sidebar-width", "320");
  storage.setItem("work-fold.work-folder.sidebar-width", "280");
  storage.setItem("unrelated", "kept");

  migrateRendererStorage(storage);

  assert.equal(storage.getItem("work-fold.work-folder.active"), "space-0123456789abcdef");
  assert.equal(storage.getItem("work-fold.work-folder.mode"), "work-folders");
  assert.equal(storage.getItem("work-fold.work-folder.chat-draft:space-0123456789abcdef:chat-1"), "my space notes", "a draft's words never change");
  assert.equal(storage.getItem("work-fold.work-folder.surface-tabs.group-by-work-folder.v1"), "true");
  assert.deepEqual(JSON.parse(storage.getItem("work-fold.work-folder.surface-tabs.v1")!).tabs, [
    { id: "work-folder-automations:space-0123456789abcdef", kind: "work-folder-automations", workFolderId: "space-0123456789abcdef", title: "Automations" },
    { id: "file:x", kind: "file", workFolderId: "space-0123456789abcdef", path: "space/notes.md", title: "notes.md" },
  ]);
  assert.equal(storage.getItem("work-fold.work-folder.sidebar-width"), "280", "a value already saved under the new key wins");
  assert.equal(storage.getItem("unrelated"), "kept");
  for (let index = 0; index < storage.length; index += 1) assert.ok(!storage.key(index)!.startsWith("work-fold.space."));

  storage.setItem("work-fold.space.active", "later");
  migrateRendererStorage(storage);
  assert.equal(storage.getItem("work-fold.space.active"), "later", "the migration runs once");
});

test("missing or failing storage is a no-op", () => {
  migrateRendererStorage(undefined);
  const broken = new MemoryStorage();
  broken.getItem = () => { throw new Error("denied"); };
  assert.doesNotThrow(() => migrateRendererStorage(broken));
});
