import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadedTreeRefreshConcurrency, spaceFileRefreshDelayMs } from "../constants";
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
  spaceTreePathMissing,
} from "../lib/tree";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import type { TreeEntry, SpaceFileEvent, SpaceSummary } from "../types";

export function useSpaceTree(space: SpaceSummary, onError: (message: string | null) => void, fixtureTree?: TreeEntry[]) {
  const [tree, setTreeState] = useState<TreeEntry[]>(fixtureTree ?? []);
  const [status, setStatus] = useState<"loading" | "refreshing" | "ready" | "error">(fixtureTree ? "ready" : "loading");
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => readTreeState(space.id).selectedPath);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => readTreeState(space.id).collapsedPaths);
  const [loadingFolderPaths, setLoadingFolderPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchHydrating, setSearchHydrating] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [movingTreePath, setMovingTreePath] = useState<string | null>(null);
  const [dropTargetFolderPath, setDropTargetFolderPath] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeSpaceIdRef = useRef(space.id);
  const treeCacheRef = useRef(new Map<string, TreeEntry[]>());
  const searchHydratedSpaceIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const eventPathsRef = useRef(new Set<string>());
  const needsFullRefreshRef = useRef(false);
  const treeRef = useRef(tree);
  const collapsedPathsRef = useRef(collapsedPaths);
  treeRef.current = tree;
  collapsedPathsRef.current = collapsedPaths;
  activeSpaceIdRef.current = space.id;

  const setTree: Dispatch<SetStateAction<TreeEntry[]>> = (update) => {
    setTreeState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      treeCacheRef.current.set(space.id, next);
      return next;
    });
  };

  useEffect(() => {
    const saved = fixtureTree ? { selectedPath: null, collapsedPaths: new Set<string>() } : readTreeState(space.id);
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
      treeCacheRef.current.set(space.id, fixtureTree);
      setTreeState(fixtureTree);
      setStatus("ready");
      return;
    }
    const cached = treeCacheRef.current.get(space.id);
    setTreeState(cached ?? []);
    setStatus(cached?.length ? "refreshing" : "loading");
    void refresh(false, { baseTree: cached });
  }, [space.id, fixtureTree]);

  useEffect(() => {
    if (fixtureTree) return;
    const source = createEventSource(`/api/spaces/${space.id}/file-events`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as SpaceFileEvent;
        if (parsed.type === "ready") return;
        if (parsed.type === "error") return onError(parsed.message || "File monitoring paused. Refresh this Space to resume.");
        scheduleRefresh(parsed.path ? [parsed.path] : undefined);
      } catch (caught) { onError(errorText(caught)); }
    };
    return () => { source.close(); clearScheduledRefresh(); };
  }, [space.id, fixtureTree]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || fixtureTree || searchHydratedSpaceIdsRef.current.has(space.id)) return;
    const timer = window.setTimeout(() => void hydrateForSearch(), 260);
    return () => window.clearTimeout(timer);
  }, [fixtureTree, query, space.id]);

  useEffect(() => {
    if (!tree.length || treeContainsUnloadedFolders(tree)) return;
    const folderPaths = new Set(collectFolderPaths(tree));
    setCollapsedPaths((current) => {
      const next = new Set([...current].filter((path) => folderPaths.has(path)));
      if (next.size !== current.size) writeTreeState(space.id, { selectedPath, collapsedPaths: [...next] });
      return next;
    });
    if (selectedPath && !findTreeEntry(tree, selectedPath)) setSelectedPath(null);
  }, [tree, space.id]);

  async function refresh(clearError = true, options: { eventPaths?: string[]; baseTree?: TreeEntry[] } = {}) {
    if (fixtureTree) return;
    const request = ++requestRef.current;
    const spaceId = space.id;
    const existing = options.baseTree ?? treeRef.current;
    if (clearError) onError(null);
    setStatus(existing.length ? "refreshing" : "loading");
    searchHydratedSpaceIdsRef.current.delete(spaceId);
    try {
      const root = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(spaceId, "", 0));
      if (request !== requestRef.current || activeSpaceIdRef.current !== spaceId) return;
      const refreshed = existing.length
        ? await refreshLoadedChildren(spaceId, root.tree, existing, collapsedPathsRef.current, options.eventPaths)
        : { tree: root.tree, truncated: false };
      const next = refreshed.tree;
      setTreeTruncated(Boolean(root.truncated) || refreshed.truncated);
      if (request !== requestRef.current || activeSpaceIdRef.current !== spaceId) return;
      treeCacheRef.current.set(spaceId, next);
      setTreeState(next);
      setStatus("ready");
    } catch (caught) {
      if (request !== requestRef.current || activeSpaceIdRef.current !== spaceId) return;
      setStatus("error"); onError(errorText(caught));
    }
  }

  async function loadFolderChildren(path: string) {
    if (fixtureTree || loadingFolderPaths.has(path)) return;
    const spaceId = space.id;
    setLoadingFolderPaths((current) => new Set(current).add(path));
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(spaceId, path, 0));
      if (activeSpaceIdRef.current !== spaceId) return;
      setTree((current) => setTreeEntryChildren(current, path, result.tree));
      if (result.truncated) setTreeTruncated(true);
    } catch (caught) {
      if (activeSpaceIdRef.current !== spaceId) return;
      const message = errorText(caught);
      if (spaceTreePathMissing(message)) {
        setTree((current) => removeTreeEntries(current, new Set([path])));
        onError(`That folder is no longer available: ${path}`);
      } else onError(message);
    } finally {
      if (activeSpaceIdRef.current === spaceId) setLoadingFolderPaths((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }

  async function hydrateForSearch() {
    if (fixtureTree || searchHydratedSpaceIdsRef.current.has(space.id)) return;
    const spaceId = space.id;
    setSearchHydrating(true);
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(spaceId, "", 6));
      if (activeSpaceIdRef.current !== spaceId) return;
      searchHydratedSpaceIdsRef.current.add(spaceId);
      treeCacheRef.current.set(spaceId, result.tree);
      setTreeState(result.tree);
      setTreeTruncated(Boolean(result.truncated));
    } catch (caught) { if (activeSpaceIdRef.current === spaceId) onError(errorText(caught)); }
    finally { if (activeSpaceIdRef.current === spaceId) setSearchHydrating(false); }
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
    }, spaceFileRefreshDelayMs);
  }

  function clearScheduledRefresh() {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null; needsFullRefreshRef.current = false; eventPathsRef.current.clear();
  }

  function setSelectedPath(path: string | null) {
    setSelectedPathState(path);
    writeTreeState(space.id, { selectedPath: path, collapsedPaths: [...collapsedPathsRef.current] });
  }

  function toggleFolder(path: string) {
    const entry = findTreeEntry(treeRef.current, path);
    if (!entry || entry.kind !== "folder") return;
    const opening = collapsedPathsRef.current.has(path) || treeEntryNeedsLazyChildren(entry);
    setCollapsedPaths((current) => {
      const next = new Set(current); if (opening) next.delete(path); else next.add(path);
      writeTreeState(space.id, { selectedPath, collapsedPaths: [...next] }); return next;
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

async function refreshLoadedChildren(spaceId: string, root: TreeEntry[], cached: TreeEntry[], collapsed: Set<string>, eventPaths?: string[]) {
  const loaded = collectLoadedFolderPaths(cached, collapsed, eventPaths);
  let next = root;
  let truncated = false;
  for (const paths of groupTreePathsByDepth(loaded)) {
    const refreshable = paths.filter((path) => findTreeEntry(next, path));
    const batch = await refreshFolderBatch(spaceId, refreshable);
    truncated ||= batch.truncated;
    for (const result of batch.results) if (result && findTreeEntry(next, result.path)) next = setTreeEntryChildren(next, result.path, result.children);
  }
  return { tree: next, truncated };
}

async function refreshFolderBatch(spaceId: string, paths: string[]) {
  const results = new Array<{ path: string; children: TreeEntry[] } | null>(paths.length).fill(null);
  let truncated = false;
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(loadedTreeRefreshConcurrency, paths.length) }, async () => {
    while (index < paths.length) {
      const current = index++; const path = paths[current]; if (!path) continue;
      try {
        const response = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(spaceId, path, 0));
        results[current] = { path, children: response.tree };
        truncated ||= Boolean(response.truncated);
      }
      catch (caught) { if (!spaceTreePathMissing(errorText(caught))) throw caught; }
    }
  }));
  return { results, truncated };
}

function treeApiPath(spaceId: string, path: string, maxDepth: number) {
  const params = new URLSearchParams({ maxDepth: String(maxDepth), includeIgnored: "1" }); if (path) params.set("path", path);
  return `/api/spaces/${spaceId}/tree?${params}`;
}

interface TreeState { selectedPath: string | null; collapsedPaths: Set<string> }
function treeStateKey(spaceId: string) { return `work-fold.space.tree-ui:${spaceId}`; }
function readTreeState(spaceId: string): TreeState {
  return readStoredJsonValue(treeStateKey(spaceId), (value) => {
    const record = (value && typeof value === "object" ? value : {}) as { selectedPath?: unknown; collapsedPaths?: unknown };
    return { selectedPath: typeof record.selectedPath === "string" ? record.selectedPath : null, collapsedPaths: new Set(Array.isArray(record.collapsedPaths) ? record.collapsedPaths.filter((path): path is string => typeof path === "string") : []) };
  }, { selectedPath: null, collapsedPaths: new Set<string>() });
}
function writeTreeState(spaceId: string, state: { selectedPath: string | null; collapsedPaths: string[] }) { writeStoredJsonValue(treeStateKey(spaceId), state); }
export function writeSpaceTreeUiState(spaceId: string, update: Partial<{ collapsedPaths: string[]; selectedPath: string | null }>) {
  const current = readTreeState(spaceId);
  writeTreeState(spaceId, { selectedPath: update.selectedPath === undefined ? current.selectedPath : update.selectedPath, collapsedPaths: update.collapsedPaths ?? [...current.collapsedPaths] });
}
