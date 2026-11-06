import { createEventSource } from "./api";
import type { LocalEventStream, WorkFolderFileEvent } from "../types";

/**
 * One shared file-change subscription per work-folder for page views, so
 * several page tabs and Files' page list don't each open a folder watcher.
 * Listeners get `{ path }` for a changed path, or `{ path: null }` when the
 * watcher (re)started or can't say what changed: requery everything then.
 */
export type WorkFolderFileChange = { path: string | null };

const subscriptions = new Map<string, { stream: LocalEventStream; listeners: Set<(change: WorkFolderFileChange) => void> }>();

export function subscribeWorkFolderFileChanges(workFolderId: string, listener: (change: WorkFolderFileChange) => void): () => void {
  let entry = subscriptions.get(workFolderId);
  if (!entry) {
    const stream = createEventSource(`/api/work-folders/${workFolderId}/file-events`);
    const created = { stream, listeners: new Set<(change: WorkFolderFileChange) => void>() };
    stream.onmessage = (event) => {
      let parsed: WorkFolderFileEvent;
      try { parsed = JSON.parse(event.data) as WorkFolderFileEvent; } catch { return; }
      if (parsed.type === "error") return;
      const change = { path: parsed.type === "file_event" ? parsed.path : null };
      for (const each of [...created.listeners]) {
        try { each(change); } catch { /* One view cannot break another. */ }
      }
    };
    subscriptions.set(workFolderId, created);
    entry = created;
  }
  entry.listeners.add(listener);
  const owned = entry;
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size || subscriptions.get(workFolderId) !== owned) return;
    subscriptions.delete(workFolderId);
    owned.stream.close();
  };
}

/** Whether a change (a path relative to the work-folder, or null) can touch this folder. */
export function changeTouchesFolder(change: WorkFolderFileChange, folder: string): boolean {
  if (change.path === null) return true;
  const path = change.path.replace(/^\/+/, "");
  return path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`);
}
