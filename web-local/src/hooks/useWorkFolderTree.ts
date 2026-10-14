import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadedTreeRefreshConcurrency, workFolderFileRefreshDelayMs } from "../constants";
import { api, createEventSource, errorText } from "../lib/api";
import {
  collectFolderPaths,
  collectLoadedFolderPaths,
  findTreeEntry,
  groupTreePathsByDepth,
  removeTreeEntries,
  searchFileTree,
  setTreeEntryChildren,
  treeContainsUnloadedFolders,
  treeEntryNeedsLazyChildren,
  workFolderTreePathMissing,
} from "../lib/tree";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import type { TreeEntry, WorkFolderFileEvent, WorkFolderSummary } from "../types";

export function useWorkFolderTree(workFolder: WorkFolderSummary, onError: (message: string | null) => void, fixtureTree?: TreeEntry[]) {
  const [tree, setTreeState] = useState<TreeEntry[]>(fixtureTree ?? []);
  const [status, setStatus] = useState<"loading" | "refreshing" | "ready" | "error">(fixtureTree ? "ready" : "loading");
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => readTreeState(workFolder.id).selectedPath);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => readTreeState(workFolder.id).collapsedPaths);
  const [loadingFolderPaths, setLoadingFolderPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchHydrating, setSearchHydrating] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [movingTreePath, setMovingTreePath] = useState<string | null>(null);
  const [dropTargetFolderPath, setDropTargetFolderPath] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeWorkFolderIdRef = useRef(workFolder.id);
  const treeCacheRef = useRef(new Map<string, TreeEntry[]>());
  const searchHydratedWorkFolderIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const eventPathsRef = useRef(new Set<string>());
  const needsFullRefreshRef = useRef(false);
  const treeRef = useRef(tree);
  const collapsedPathsRef = useRef(collapsedPaths);
  treeRef.current = tree;
  collapsedPathsRef.current = collapsedPaths;
  activeWorkFolderIdRef.current = workFolder.id;

  const setTree: Dispatch<SetStateAction<TreeEntry[]>> = (update) => {
    setTreeState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      treeCacheRef.current.set(workFolder.id, next);
      return next;
    });
  };

  // A layout effect: the previous work-folder's files must never paint under the
  // new work-folder's header, even for one frame.
  useLayoutEffect(() => {
    activeWorkFolderIdRef.current = workFolder.id;
    const saved = fixtureTree ? { selectedPath: null, collapsedPaths: new Set<string>() } : readTreeState(workFolder.id);
    requestRef.current += 1;
    setSelectedPathState(saved.selectedPath);
    setCollapsedPaths(saved.collapsedPaths);
    setLoadingFolderPaths(new Set());
    setMovingTreePath(null);
    setDropTargetFolderPath(null);
    setQuery("");
    setSearchHydrating(false);
    setTreeTruncated(false);
    clearScheduledRefresh();
    if (fixtureTree) {
      treeCacheRef.current.set(workFolder.id, fixtureTree);
      setTreeState(fixtureTree);
      setStatus("ready");
      return;
    }
    const cached = treeCacheRef.current.get(workFolder.id);
    setTreeState(cached ?? []);
    setStatus(cached?.length ? "refreshing" : "loading");
    // Never fall back to the previous work-folder's tree: a first visit would show it
    // as "refreshing" and reopen its expanded folders under this work-folder.
    void refresh(false, { baseTree: cached ?? [] });
    return () => {
      requestRef.current += 1;
      activeWorkFolderIdRef.current = "";
      clearScheduledRefresh();
    };
  }, [workFolder.id, fixtureTree]);

  useEffect(() => {
    if (fixtureTree) return;
    const source = createEventSource(`/api/work-folders/${workFolder.id}/file-events`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WorkFolderFileEvent;
        // File watchers have no replay cursor. Requery after every ready,
        // including the first, to cover writes during opening or reconnect.
        if (parsed.type === "ready") { scheduleRefresh(); return; }
        if (parsed.type === "error") return onError(parsed.message || "File monitoring paused. Refresh this work-folder to resume.");
        scheduleRefresh(parsed.path ? [parsed.path] : undefined);
      } catch (caught) { onError(errorText(caught)); }
    };
    return () => { source.close(); clearScheduledRefresh(); };
  }, [workFolder.id, fixtureTree]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || fixtureTree || searchHydratedWorkFolderIdsRef.current.has(workFolder.id)) return;
    const timer = window.setTimeout(() => void hydrateForSearch(), 260);
    return () => window.clearTimeout(timer);
  }, [fixtureTree, query, workFolder.id]);

  useEffect(() => {
    if (!tree.length || treeContainsUnloadedFolders(tree)) return;
    const folderPaths = new Set(collectFolderPaths(tree));
    setCollapsedPaths((current) => {
      const next = new Set([...current].filter((path) => folderPaths.has(path)));
      if (next.size !== current.size) writeTreeState(workFolder.id, { selectedPath, collapsedPaths: [...next] });
      return next;
    });
    if (selectedPath && !findTreeEntry(tree, selectedPath)) setSelectedPath(null);
  }, [tree, workFolder.id]);

  async function refresh(clearError = true, options: { eventPaths?: string[]; baseTree?: TreeEntry[] } = {}) {
    if (fixtureTree) return;
    const request = ++requestRef.current;
    const workFolderId = workFolder.id;
    const existing = options.baseTree ?? treeRef.current;
    if (clearError) onError(null);
    setStatus(existing.length ? "refreshing" : "loading");
    searchHydratedWorkFolderIdsRef.current.delete(workFolderId);
    try {
      const root = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workFolderId, "", 0));
      if (request !== requestRef.current || activeWorkFolderIdRef.current !== workFolderId) return;
      const refreshed = existing.length
        ? await refreshLoadedChildren(workFolderId, root.tree, existing, collapsedPathsRef.current, options.eventPaths)
        : { tree: root.tree, truncated: false };
      const next = refreshed.tree;
      setTreeTruncated(Boolean(root.truncated) || refreshed.truncated);
      if (request !== requestRef.current || activeWorkFolderIdRef.current !== workFolderId) return;
      treeCacheRef.current.set(workFolderId, next);
      setTreeState(next);
      setStatus("ready");
    } catch (caught) {
      if (request !== requestRef.current || activeWorkFolderIdRef.current !== workFolderId) return;
      setStatus("error"); onError(errorText(caught));
    }
  }

  async function loadFolderChildren(path: string) {
    if (fixtureTree || loadingFolderPaths.has(path)) return;
    const workFolderId = workFolder.id;
    setLoadingFolderPaths((current) => new Set(current).add(path));
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workFolderId, path, 0));
      if (activeWorkFolderIdRef.current !== workFolderId) return;
      setTree((current) => setTreeEntryChildren(current, path, result.tree));
      if (result.truncated) setTreeTruncated(true);
    } catch (caught) {
      if (activeWorkFolderIdRef.current !== workFolderId) return;
      const message = errorText(caught);
      if (workFolderTreePathMissing(message)) {
        setTree((current) => removeTreeEntries(current, new Set([path])));
        onError(`That folder is no longer available: ${path}`);
      } else onError(message);
    } finally {
      if (activeWorkFolderIdRef.current === workFolderId) setLoadingFolderPaths((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }

  async function hydrateForSearch() {
    if (fixtureTree || searchHydratedWorkFolderIdsRef.current.has(workFolder.id)) return;
    const workFolderId = workFolder.id;
    setSearchHydrating(true);
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workFolderId, "", 6));
      if (activeWorkFolderIdRef.current !== workFolderId) return;
      searchHydratedWorkFolderIdsRef.current.add(workFolderId);
      treeCacheRef.current.set(workFolderId, result.tree);
      setTreeState(result.tree);
      setTreeTruncated(Boolean(result.truncated));
    } catch (caught) { if (activeWorkFolderIdRef.current === workFolderId) onError(errorText(caught)); }
    finally { if (activeWorkFolderIdRef.current === workFolderId) setSearchHydrating(false); }
  }

  function scheduleRefresh(paths?: string[]) {
    if (paths) {
      if (!needsFullRefreshRef.current) paths.forEach((path) => eventPathsRef.current.add(path));
    } else {
      needsFullRefreshRef.current = true; eventPathsRef.current.clear();
    }
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      const eventPaths = needsFullRefreshRef.current ? undefined : [...eventPathsRef.current];
      needsFullRefreshRef.current = false; eventPathsRef.current.clear();
      void refresh(false, { eventPaths });
    }, workFolderFileRefreshDelayMs);
  }

  function clearScheduledRefresh() {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null; needsFullRefreshRef.current = false; eventPathsRef.current.clear();
  }

  function setSelectedPath(path: string | null) {
    setSelectedPathState(path);
    writeTreeState(workFolder.id, { selectedPath: path, collapsedPaths: [...collapsedPathsRef.current] });
  }

  function toggleFolder(path: string, expanded?: boolean) {
    const entry = findTreeEntry(treeRef.current, path);
    if (!entry || entry.kind !== "folder") return;
    const opening = expanded ?? (collapsedPathsRef.current.has(path) || treeEntryNeedsLazyChildren(entry));
    setCollapsedPaths((current) => {
      const next = new Set(current); if (opening) next.delete(path); else next.add(path);
      writeTreeState(workFolder.id, { selectedPath, collapsedPaths: [...next] }); return next;
    });
    if (opening && treeEntryNeedsLazyChildren(entry)) void loadFolderChildren(path);
  }

  const search = useMemo(() => query.trim() ? searchFileTree(tree, query) : { entries: tree, matchCount: 0 }, [query, tree]);
  return {
    tree, setTree, status, refresh, selectedPath, setSelectedPath, collapsedPaths,
    loadingFolderPaths, query, setQuery, visibleEntries: search.entries, matchCount: search.matchCount,
    searchHydrating, treeTruncated, toggleFolder, movingTreePath, setMovingTreePath, dropTargetFolderPath, setDropTargetFolderPath,
  };
}

async function refreshLoadedChildren(workFolderId: string, root: TreeEntry[], cached: TreeEntry[], collapsed: Set<string>, eventPaths?: string[]) {
  const loaded = collectLoadedFolderPaths(cached, collapsed, eventPaths);
  let next = root;
  let truncated = false;
  for (const paths of groupTreePathsByDepth(loaded)) {
    const refreshable = paths.filter((path) => findTreeEntry(next, path));
    const batch = await refreshFolderBatch(workFolderId, refreshable);
    truncated ||= batch.truncated;
    for (const result of batch.results) if (result && findTreeEntry(next, result.path)) next = setTreeEntryChildren(next, result.path, result.children);
  }
  return { tree: next, truncated };
}

async function refreshFolderBatch(workFolderId: string, paths: string[]) {
  const results = new Array<{ path: string; children: TreeEntry[] } | null>(paths.length).fill(null);
  let truncated = false;
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(loadedTreeRefreshConcurrency, paths.length) }, async () => {
    while (index < paths.length) {
      const current = index++; const path = paths[current]; if (!path) continue;
      try {
        const response = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workFolderId, path, 0));
        results[current] = { path, children: response.tree };
        truncated ||= Boolean(response.truncated);
      }
      catch (caught) { if (!workFolderTreePathMissing(errorText(caught))) throw caught; }
    }
  }));
  return { results, truncated };
}

function treeApiPath(workFolderId: string, path: string, maxDepth: number) {
  const params = new URLSearchParams({ maxDepth: String(maxDepth), includeIgnored: "1" }); if (path) params.set("path", path);
  return `/api/work-folders/${workFolderId}/tree?${params}`;
}

interface TreeState { selectedPath: string | null; collapsedPaths: Set<string> }
function treeStateKey(workFolderId: string) { return `work-fold.work-folder.tree-ui:${workFolderId}`; }
function readTreeState(workFolderId: string): TreeState {
  return readStoredJsonValue(treeStateKey(workFolderId), (value) => {
    const record = (value && typeof value === "object" ? value : {}) as { selectedPath?: unknown; collapsedPaths?: unknown };
    return { selectedPath: typeof record.selectedPath === "string" ? record.selectedPath : null, collapsedPaths: new Set(Array.isArray(record.collapsedPaths) ? record.collapsedPaths.filter((path): path is string => typeof path === "string") : []) };
  }, { selectedPath: null, collapsedPaths: new Set<string>() });
}
function writeTreeState(workFolderId: string, state: { selectedPath: string | null; collapsedPaths: string[] }) { writeStoredJsonValue(treeStateKey(workFolderId), state); }
