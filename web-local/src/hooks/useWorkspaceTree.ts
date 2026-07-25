import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { loadedTreeRefreshConcurrency, workspaceFileRefreshDelayMs } from "../constants";
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
  workspaceTreePathMissing,
} from "../lib/tree";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import type { TreeEntry, WorkspaceFileEvent, WorkspaceSummary } from "../types";

export function useWorkspaceTree(workspace: WorkspaceSummary, onError: (message: string | null) => void, fixtureTree?: TreeEntry[]) {
  const [tree, setTreeState] = useState<TreeEntry[]>(fixtureTree ?? []);
  const [status, setStatus] = useState<"loading" | "refreshing" | "ready" | "error">(fixtureTree ? "ready" : "loading");
  const [selectedPath, setSelectedPathState] = useState<string | null>(() => readTreeState(workspace.id).selectedPath);
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => readTreeState(workspace.id).collapsedPaths);
  const [loadingFolderPaths, setLoadingFolderPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [searchHydrating, setSearchHydrating] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [movingTreePath, setMovingTreePath] = useState<string | null>(null);
  const [dropTargetFolderPath, setDropTargetFolderPath] = useState<string | null>(null);
  const requestRef = useRef(0);
  const activeWorkspaceIdRef = useRef(workspace.id);
  const treeCacheRef = useRef(new Map<string, TreeEntry[]>());
  const searchHydratedWorkspaceIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const eventPathsRef = useRef(new Set<string>());
  const needsFullRefreshRef = useRef(false);
  const treeRef = useRef(tree);
  const collapsedPathsRef = useRef(collapsedPaths);
  treeRef.current = tree;
  collapsedPathsRef.current = collapsedPaths;
  activeWorkspaceIdRef.current = workspace.id;

  const setTree: Dispatch<SetStateAction<TreeEntry[]>> = (update) => {
    setTreeState((current) => {
      const next = typeof update === "function" ? update(current) : update;
      treeCacheRef.current.set(workspace.id, next);
      return next;
    });
  };

  useEffect(() => {
    const saved = fixtureTree ? { selectedPath: null, collapsedPaths: new Set<string>() } : readTreeState(workspace.id);
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
      treeCacheRef.current.set(workspace.id, fixtureTree);
      setTreeState(fixtureTree);
      setStatus("ready");
      return;
    }
    const cached = treeCacheRef.current.get(workspace.id);
    setTreeState(cached ?? []);
    setStatus(cached?.length ? "refreshing" : "loading");
    void refresh(false, { baseTree: cached });
  }, [workspace.id, fixtureTree]);

  useEffect(() => {
    if (fixtureTree) return;
    const source = createEventSource(`/api/workspaces/${workspace.id}/file-events`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WorkspaceFileEvent;
        if (parsed.type === "ready") return;
        if (parsed.type === "error") return onError(parsed.message || "File monitoring paused. Refresh this Space to resume.");
        scheduleRefresh(parsed.path ? [parsed.path] : undefined);
      } catch (caught) { onError(errorText(caught)); }
    };
    return () => { source.close(); clearScheduledRefresh(); };
  }, [workspace.id, fixtureTree]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || fixtureTree || searchHydratedWorkspaceIdsRef.current.has(workspace.id)) return;
    const timer = window.setTimeout(() => void hydrateForSearch(), 260);
    return () => window.clearTimeout(timer);
  }, [fixtureTree, query, workspace.id]);

  useEffect(() => {
    if (!tree.length || treeContainsUnloadedFolders(tree)) return;
    const folderPaths = new Set(collectFolderPaths(tree));
    setCollapsedPaths((current) => {
      const next = new Set([...current].filter((path) => folderPaths.has(path)));
      if (next.size !== current.size) writeTreeState(workspace.id, { selectedPath, collapsedPaths: [...next] });
      return next;
    });
    if (selectedPath && !findTreeEntry(tree, selectedPath)) setSelectedPath(null);
  }, [tree, workspace.id]);

  async function refresh(clearError = true, options: { eventPaths?: string[]; baseTree?: TreeEntry[] } = {}) {
    if (fixtureTree) return;
    const request = ++requestRef.current;
    const workspaceId = workspace.id;
    const existing = options.baseTree ?? treeRef.current;
    if (clearError) onError(null);
    setStatus(existing.length ? "refreshing" : "loading");
    searchHydratedWorkspaceIdsRef.current.delete(workspaceId);
    try {
      const root = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workspaceId, "", 0));
      if (request !== requestRef.current || activeWorkspaceIdRef.current !== workspaceId) return;
      const next = existing.length
        ? await refreshLoadedChildren(workspaceId, root.tree, existing, collapsedPathsRef.current, options.eventPaths)
        : root.tree;
      setTreeTruncated(Boolean(root.truncated));
      if (request !== requestRef.current || activeWorkspaceIdRef.current !== workspaceId) return;
      treeCacheRef.current.set(workspaceId, next);
      setTreeState(next);
      setStatus("ready");
    } catch (caught) {
      if (request !== requestRef.current || activeWorkspaceIdRef.current !== workspaceId) return;
      setStatus("error"); onError(errorText(caught));
    }
  }

  async function loadFolderChildren(path: string) {
    if (fixtureTree || loadingFolderPaths.has(path)) return;
    const workspaceId = workspace.id;
    setLoadingFolderPaths((current) => new Set(current).add(path));
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workspaceId, path, 0));
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setTree((current) => setTreeEntryChildren(current, path, result.tree));
    } catch (caught) {
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      const message = errorText(caught);
      if (workspaceTreePathMissing(message)) {
        setTree((current) => removeTreeEntries(current, new Set([path])));
        onError(`That folder is no longer available: ${path}`);
      } else onError(message);
    } finally {
      if (activeWorkspaceIdRef.current === workspaceId) setLoadingFolderPaths((current) => { const next = new Set(current); next.delete(path); return next; });
    }
  }

  async function hydrateForSearch() {
    if (fixtureTree || searchHydratedWorkspaceIdsRef.current.has(workspace.id)) return;
    const workspaceId = workspace.id;
    setSearchHydrating(true);
    try {
      const result = await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workspaceId, "", 6));
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      searchHydratedWorkspaceIdsRef.current.add(workspaceId);
      treeCacheRef.current.set(workspaceId, result.tree);
      setTreeState(result.tree);
      setTreeTruncated(Boolean(result.truncated));
    } catch (caught) { if (activeWorkspaceIdRef.current === workspaceId) onError(errorText(caught)); }
    finally { if (activeWorkspaceIdRef.current === workspaceId) setSearchHydrating(false); }
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
    }, workspaceFileRefreshDelayMs);
  }

  function clearScheduledRefresh() {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = null; needsFullRefreshRef.current = false; eventPathsRef.current.clear();
  }

  function setSelectedPath(path: string | null) {
    setSelectedPathState(path);
    writeTreeState(workspace.id, { selectedPath: path, collapsedPaths: [...collapsedPathsRef.current] });
  }

  function toggleFolder(path: string) {
    const entry = findTreeEntry(treeRef.current, path);
    if (!entry || entry.kind !== "folder") return;
    const opening = collapsedPathsRef.current.has(path) || treeEntryNeedsLazyChildren(entry);
    setCollapsedPaths((current) => {
      const next = new Set(current); if (opening) next.delete(path); else next.add(path);
      writeTreeState(workspace.id, { selectedPath, collapsedPaths: [...next] }); return next;
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

async function refreshLoadedChildren(workspaceId: string, root: TreeEntry[], cached: TreeEntry[], collapsed: Set<string>, eventPaths?: string[]) {
  const loaded = collectLoadedFolderPaths(cached, collapsed, eventPaths);
  let next = root;
  for (const paths of groupTreePathsByDepth(loaded)) {
    const refreshable = paths.filter((path) => findTreeEntry(next, path));
    const results = await refreshFolderBatch(workspaceId, refreshable);
    for (const result of results) if (result && findTreeEntry(next, result.path)) next = setTreeEntryChildren(next, result.path, result.children);
  }
  return next;
}

async function refreshFolderBatch(workspaceId: string, paths: string[]) {
  const results = new Array<{ path: string; children: TreeEntry[] } | null>(paths.length).fill(null);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(loadedTreeRefreshConcurrency, paths.length) }, async () => {
    while (index < paths.length) {
      const current = index++; const path = paths[current]; if (!path) continue;
      try { results[current] = { path, children: (await api<{ tree: TreeEntry[]; truncated?: boolean }>(treeApiPath(workspaceId, path, 0))).tree }; }
      catch (caught) { if (!workspaceTreePathMissing(errorText(caught))) throw caught; }
    }
  }));
  return results;
}

function treeApiPath(workspaceId: string, path: string, maxDepth: number) {
  const params = new URLSearchParams({ maxDepth: String(maxDepth), includeIgnored: "1" }); if (path) params.set("path", path);
  return `/api/workspaces/${workspaceId}/tree?${params}`;
}

interface TreeState { selectedPath: string | null; collapsedPaths: Set<string> }
function treeStateKey(workspaceId: string) { return `workspace.tree-ui:${workspaceId}`; }
function readTreeState(workspaceId: string): TreeState {
  return readStoredJsonValue(treeStateKey(workspaceId), (value) => {
    const record = (value && typeof value === "object" ? value : {}) as { selectedPath?: unknown; collapsedPaths?: unknown };
    return { selectedPath: typeof record.selectedPath === "string" ? record.selectedPath : null, collapsedPaths: new Set(Array.isArray(record.collapsedPaths) ? record.collapsedPaths.filter((path): path is string => typeof path === "string") : []) };
  }, { selectedPath: null, collapsedPaths: new Set<string>() });
}
function writeTreeState(workspaceId: string, state: { selectedPath: string | null; collapsedPaths: string[] }) { writeStoredJsonValue(treeStateKey(workspaceId), state); }
export function writeWorkspaceTreeUiState(workspaceId: string, update: Partial<{ collapsedPaths: string[]; selectedPath: string | null }>) {
  const current = readTreeState(workspaceId);
  writeTreeState(workspaceId, { selectedPath: update.selectedPath === undefined ? current.selectedPath : update.selectedPath, collapsedPaths: update.collapsedPaths ?? [...current.collapsedPaths] });
}
