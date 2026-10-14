/**
 * One-time move of this renderer's saved preferences — open tabs, unsent Chat
 * drafts, the active work-folder and rail mode, pane widths, and tree state —
 * from the `work-fold.space.*` keys to the 2026-10-10 vocabulary
 * (scripts/vocabulary/GLOSSARY.md). App state on disk has its own migration
 * (src/local/vocabulary-migration.ts). A key whose new name already holds a
 * value is left alone, and nothing here throws: without storage the renderer
 * simply starts with defaults.
 *
 * Remove this module once no profile from before 2026-10-10 remains.
 */
const legacyPrefix = "work-fold.space.";
const nextPrefix = "work-fold.work-folder.";
const markerKey = "work-fold.vocabulary-migration.v1";

export function migrateRendererStorage(storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  try {
    if (storage.getItem(markerKey)) return;
    const legacyKeys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(legacyPrefix)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const value = storage.getItem(key);
      const next = nextPrefix + key.slice(legacyPrefix.length).replace("group-by-space", "group-by-work-folder");
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, migrateStoredValue(next, value));
      storage.removeItem(key);
    }
    storage.setItem(markerKey, new Date().toISOString());
  } catch {
    // Storage can be unavailable or full; the renderer falls back to defaults.
  }
}

function migrateStoredValue(key: string, value: string): string {
  if (key === `${nextPrefix}mode`) return value === "spaces" ? "work-folders" : value;
  if (key === `${nextPrefix}surface-tabs.v1` || key.startsWith(`${nextPrefix}pending-chat-send:`)) {
    try {
      return JSON.stringify(migrateRecord(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  return value;
}

const recordKeys: Readonly<Record<string, string>> = {
  spaceId: "workFolderId",
  addressedSpaceIds: "addressedWorkFolderIds",
};

function migrateRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(migrateRecord);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.startsWith("space-automations:")) return `work-folder-automations:${value.slice("space-automations:".length)}`;
    return value === "space-automations" ? "work-folder-automations" : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    Object.hasOwn(recordKeys, key) ? recordKeys[key]! : key,
    // Drafted words and file paths are never rewritten.
    key === "content" || key === "path" || key === "selectedPath" || key === "contextPaths" ? item : migrateRecord(item),
  ]));
}
