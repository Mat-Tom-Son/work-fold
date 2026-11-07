import { useCallback, useEffect, useRef, useState } from "react";

import { api, createEventSource, errorText } from "../../lib/api";
import { eventPathTouchesFolder, findTreeEntry } from "../../lib/tree";
import type { TreeEntry, WorkFolderFileEvent } from "../../types";
import { placeApiBase, placeEventsUrl, placeKey, type FileManagerPlace } from "./file-manager-places";

export type FolderListingStatus = "loading" | "ready" | "error";

interface ListingState {
  key: string;
  entries: TreeEntry[];
  status: FolderListingStatus;
  truncated: boolean;
  error: string | null;
}

const refreshDelayMs = 200;

/**
 * One folder's contents, one level deep, as the file manager shows them: the
 * same `/tree` route Files uses, asked for a single level, for a work-folder
 * or a standard folder. File events keep it current; a refresh never blanks
 * rows already shown.
 */
export function useFolderListing(place: FileManagerPlace, path: string, fixtureTree?: TreeEntry[]) {
  const key = `${placeKey(place)}\0${path}`;
  const apiBase = placeApiBase(place);
  const eventsUrl = placeEventsUrl(place, path);
  const [state, setState] = useState<ListingState>(() => ({ key, entries: [], status: "loading", truncated: false, error: null }));
  const requestRef = useRef(0);
  // Counts file changes anywhere in the place, so History can reload when a
  // change it records (a delete, a Worker's edit) happens outside this folder.
  const [changeCount, setChangeCount] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    const requestKey = key;
    if (fixtureTree) {
      const folder = path ? findTreeEntry(fixtureTree, path) : null;
      const children = path ? folder?.children ?? [] : fixtureTree;
      setState({ key: requestKey, entries: children.map(withoutChildren), status: "ready", truncated: false, error: null });
      return;
    }
    try {
      const query = new URLSearchParams({ maxDepth: "0" });
      if (path) query.set("path", path);
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(`${apiBase}/tree?${query.toString()}`);
      if (request !== requestRef.current || keyRef.current !== requestKey) return;
      setState({ key: requestKey, entries: result.tree.map(withoutChildren), status: "ready", truncated: Boolean(result.truncated), error: null });
    } catch (caught) {
      if (request !== requestRef.current || keyRef.current !== requestKey) return;
      setState((current) => ({ ...current, key: requestKey, status: current.key === requestKey && current.status === "ready" ? "ready" : "error", error: errorText(caught) }));
    }
  }, [apiBase, fixtureTree, key, path]);

  useEffect(() => {
    setState((current) => current.key === key ? current : { key, entries: [], status: "loading", truncated: false, error: null });
    void load();
  }, [key, load]);

  // File watchers have no replay cursor, so every "ready" requeries too.
  useEffect(() => {
    if (fixtureTree) return;
    let timer: number | null = null;
    let changeTimer: number | null = null;
    const noteChange = () => {
      if (changeTimer !== null) window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => { changeTimer = null; setChangeCount((count) => count + 1); }, 400);
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void load(); }, refreshDelayMs);
    };
    const source = createEventSource(eventsUrl);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WorkFolderFileEvent;
        if (parsed.type === "ready") return schedule();
        if (parsed.type !== "file_event") return;
        noteChange();
        if (!parsed.path || eventPathTouchesFolder(parsed.path, path)) schedule();
      } catch {
        schedule();
      }
    };
    return () => { source.close(); if (timer !== null) window.clearTimeout(timer); if (changeTimer !== null) window.clearTimeout(changeTimer); };
  }, [eventsUrl, fixtureTree, load, path]);

  const shown = state.key === key ? state : { key, entries: [], status: "loading" as const, truncated: false, error: null };

  /** Rows already handled here (a delete waiting on Undo) leave at once. */
  const removeLocally = useCallback((paths: ReadonlySet<string>) => {
    setState((current) => ({ ...current, entries: current.entries.filter((entry) => !paths.has(entry.path)) }));
  }, []);

  return { ...shown, changeCount, refresh: load, removeLocally };
}

function withoutChildren(entry: TreeEntry): TreeEntry {
  if (!entry.children) return entry;
  const { children, ...rest } = entry;
  return { ...rest, hasChildren: rest.hasChildren ?? children.length > 0 };
}
