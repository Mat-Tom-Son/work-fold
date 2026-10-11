import { useCallback, useEffect, useRef, useState } from "react";

import { chatDisplayTitle } from "../lib/format";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { retargetMovedPath } from "../lib/tree";
import type { AgentExtensionSurfaceView, CapabilitySurface, ConversationSummary, RestrictedAppInstalled, WorkFolderSummary, WorkFolderSurfaceTab } from "../types";

const surfaceTabsStorageKey = "work-fold.work-folder.surface-tabs.v1";

export function useSurfaceTabs({
  workFolder,
  workFolders,
  fixtureMode = false,
  openChatWorkFolderId,
  onOpenChatWorkFolderConsumed,
  onSwitchWorkFolder,
}: {
  workFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  fixtureMode?: boolean;
  openChatWorkFolderId?: string | null;
  onOpenChatWorkFolderConsumed?: () => void;
  onSwitchWorkFolder?: (workFolder: WorkFolderSummary) => void;
}) {
  const initialStateRef = useRef<SurfaceTabsState | null>(null);
  const skipNextPersistRef = useRef(!fixtureMode);
  const recentSurfaceTabIdsByWorkFolderRef = useRef<Map<string, string>>(new Map());
  const previousActiveSurfaceTabIdRef = useRef<string | null | undefined>(undefined);
  const previousWorkFolderCountRef = useRef(workFolders.length);
  const previousWorkFolderIdRef = useRef(workFolder.id);
  if (!initialStateRef.current) {
    const initialState = fixtureMode
      ? defaultSurfaceTabsState(workFolder)
      : readStoredSurfaceTabsState(workFolder, workFolders);
    initialStateRef.current = initialState;
  }
  const [surfaceTabs, setSurfaceTabs] = useState<WorkFolderSurfaceTab[]>(() => initialStateRef.current?.tabs ?? [newChatSurfaceTab(workFolder)]);
  const [activeSurfaceTabId, setActiveSurfaceTabId] = useState<string | null>(() => initialStateRef.current?.activeTabId ?? newChatSurfaceTabId(workFolder.id));

  useEffect(() => {
    recordActiveSurfaceTabWorkFolderRecency(recentSurfaceTabIdsByWorkFolderRef.current, surfaceTabs, activeSurfaceTabId);
  }, [activeSurfaceTabId, surfaceTabs]);

  useEffect(() => {
    const activeChanged = previousActiveSurfaceTabIdRef.current !== activeSurfaceTabId;
    const workFoldersHydrated = previousWorkFolderCountRef.current === 0 && workFolders.length > 0;
    previousActiveSurfaceTabIdRef.current = activeSurfaceTabId;
    previousWorkFolderCountRef.current = workFolders.length;
    if (!activeChanged && !workFoldersHydrated) return;
    const targetWorkFolder = surfaceTabWorkFolderSwitchTarget({
      activeTabId: activeSurfaceTabId,
      activeWorkFolderId: workFolder.id,
      tabs: surfaceTabs,
      workFolders,
    });
    if (targetWorkFolder) onSwitchWorkFolder?.(targetWorkFolder);
  }, [activeSurfaceTabId, onSwitchWorkFolder, surfaceTabs, workFolder.id, workFolders]);

  useEffect(() => {
    if (previousWorkFolderIdRef.current === workFolder.id) return;
    previousWorkFolderIdRef.current = workFolder.id;
    const resolution = surfaceTabActivationForWorkFolder({
      activeTabId: activeSurfaceTabId,
      recentTabIdsByWorkFolder: recentSurfaceTabIdsByWorkFolderRef.current,
      tabs: surfaceTabs,
      workFolder,
    });
    if (!resolution || resolution.tabId === activeSurfaceTabId) return;
    if (resolution.tabToAdd) {
      const tabToAdd = resolution.tabToAdd;
      setSurfaceTabs((current) => current.some((tab) => tab.id === tabToAdd.id) ? current : [...current, tabToAdd]);
    }
    setActiveSurfaceTabId(resolution.tabId);
  }, [activeSurfaceTabId, surfaceTabs, workFolder]);

  useEffect(() => {
    if (openChatWorkFolderId !== workFolder.id) return;
    const existingDraftTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.workFolderId === workFolder.id && !tab.conversationId);
    if (existingDraftTab) {
      setActiveSurfaceTabId(existingDraftTab.id);
      onOpenChatWorkFolderConsumed?.();
      return;
    }
    const tab = newChatSurfaceTab(workFolder);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    onOpenChatWorkFolderConsumed?.();
  }, [openChatWorkFolderId, onOpenChatWorkFolderConsumed, surfaceTabs, workFolder.id, workFolder.name]);

  useEffect(() => {
    if (!workFolders.length) return;
    setSurfaceTabs((current) => {
      const next = filterSurfaceTabsToWorkFolders(current, workFolders);
      const resolved = next.length ? next : [newChatSurfaceTab(workFolder)];
      setActiveSurfaceTabId((currentActiveTabId) => (
        currentActiveTabId && resolved.some((tab) => tab.id === currentActiveTabId)
          ? currentActiveTabId
          : resolved[0]?.id ?? null
      ));
      return resolved;
    });
  }, [workFolder.id, workFolder.name, workFolders]);

  useEffect(() => {
    setActiveSurfaceTabId((current) => {
      if (surfaceTabs.some((tab) => tab.id === current)) return current;
      return surfaceTabs[0]?.id ?? null;
    });
  }, [surfaceTabs]);

  useEffect(() => {
    if (fixtureMode) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    writeStoredSurfaceTabsState({ tabs: surfaceTabs, activeTabId: activeSurfaceTabId });
  }, [activeSurfaceTabId, fixtureMode, surfaceTabs]);

  function syncSurfaceTabConversationTitles(groups: Record<string, ConversationSummary[]>): void {
    setSurfaceTabs((current) => current.map((tab) => {
      if (tab.kind !== "chat" || !tab.conversationId) return tab;
      const refreshedConversation = groups[tab.workFolderId]?.find((conversation) => conversation.id === tab.conversationId);
      if (!refreshedConversation) return tab;
      const title = chatDisplayTitle({ serverTitle: refreshedConversation.title });
      return tab.title === title ? tab : { ...tab, title };
    }));
  }

  function openChatSurfaceTab(targetWorkFolder: WorkFolderSummary, conversation: ConversationSummary | null = null): string {
    if (conversation) {
      const existingTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.workFolderId === targetWorkFolder.id && tab.conversationId === conversation.id);
      if (existingTab) {
        setSurfaceTabs((current) => current.map((tab) => (
          tab.id === existingTab.id ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) } : tab
        )));
        setActiveSurfaceTabId(existingTab.id);
        return existingTab.id;
      }
    }
    const tab = conversation ? chatSurfaceTab(targetWorkFolder, conversation) : newChatSurfaceTab(targetWorkFolder, { fresh: true });
    setSurfaceTabs((current) => conversation ? upsertSurfaceTab(current, tab) : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    return tab.id;
  }

  function openHistorySurfaceTab(targetWorkFolder: WorkFolderSummary, checkpointId?: string, title = "History"): void {
    const tab = historySurfaceTab(targetWorkFolder, checkpointId, title);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openFileSurfaceTab(targetWorkFolder: WorkFolderSummary, path: string): void {
    const tab = fileSurfaceTab(targetWorkFolder, path);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAppStudioSurfaceTab(targetWorkFolder: WorkFolderSummary): void {
    const tab = appStudioSurfaceTab(targetWorkFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openChecksSurfaceTab(targetWorkFolder: WorkFolderSummary): void {
    const tab = checksSurfaceTab(targetWorkFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openWorkFolderAutomationsSurfaceTab(targetWorkFolder: WorkFolderSummary): void {
    const tab = spaceAutomationsSurfaceTab(targetWorkFolder);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openExtensionSurfaceTab(
    targetWorkFolder: WorkFolderSummary,
    surface: CapabilitySurface,
    view: AgentExtensionSurfaceView,
  ): void {
    const tab = extensionSurfaceTab(targetWorkFolder, surface, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openRestrictedAppSurfaceTab(
    targetWorkFolder: WorkFolderSummary,
    app: { appId: string; digest: string; featureInstallationId: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const tab = restrictedAppSurfaceTab(targetWorkFolder.id, app, target);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function updateRestrictedAppSurfaceTab(
    workFolderId: string,
    app: { appId: string; digest: string; featureInstallationId: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const id = restrictedAppSurfaceTabId(workFolderId, app.appId, app.digest, target.appTabId, app.featureInstallationId);
    setSurfaceTabs((current) => current.map((tab) => tab.id === id && tab.kind === "restricted-app"
      ? restrictedAppSurfaceTab(workFolderId, app, target)
      : tab));
  }

  function closeRestrictedAppSurfaceTab(workFolderId: string, appId: string, digest: string, appTabId: string, featureInstallationId: string): void {
    closeSurfaceTab(restrictedAppSurfaceTabId(workFolderId, appId, digest, appTabId, featureInstallationId));
  }

  const reconcileRestrictedAppSurfaceTabs = useCallback((
    appsByWorkFolder: Record<string, RestrictedAppInstalled[]>,
    knownWorkFolderIds: ReadonlySet<string>,
  ): void => {
    setSurfaceTabs((current) => {
      const next = closeUnavailableRestrictedAppSurfaceTabs(current, appsByWorkFolder, knownWorkFolderIds);
      if (next === current) return current;
      setActiveSurfaceTabId((currentActiveTabId) => {
        if (currentActiveTabId && next.some((tab) => tab.id === currentActiveTabId)) return currentActiveTabId;
        const removedActiveIndex = current.findIndex((tab) => tab.id === currentActiveTabId);
        const fallback = next[Math.max(0, Math.min(removedActiveIndex, next.length - 1))] ?? next[0];
        return fallback?.id ?? null;
      });
      return next;
    });
  }, []);

  function closeSurfaceTab(tabId: string): void {
    setSurfaceTabs((current) => {
      const index = current.findIndex((tab) => tab.id === tabId);
      if (index < 0) return current;
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveSurfaceTabId((currentActiveTabId) => {
        if (currentActiveTabId && currentActiveTabId !== tabId && next.some((tab) => tab.id === currentActiveTabId)) {
          return currentActiveTabId;
        }
        const fallback = next[Math.max(0, Math.min(index, next.length - 1))] ?? next[0];
        return fallback?.id ?? null;
      });
      return next;
    });
  }

  const reorderSurfaceTabs = useCallback((ids: string[]): void => {
    setSurfaceTabs((current) => reorderSurfaceTabList(current, ids));
  }, []);

  function handleTabConversationActivated(tabId: string, tabWorkFolder: WorkFolderSummary, conversation: ConversationSummary | null): void {
    if (!conversation) return;
    const duplicate = surfaceTabs.find((tab) => tab.kind === "chat" && tab.id !== tabId && tab.workFolderId === tabWorkFolder.id && tab.conversationId === conversation.id);
    if (duplicate) {
      setSurfaceTabs((current) => current.filter((tab) => tab.id !== tabId));
      setActiveSurfaceTabId((current) => activeTabAfterConversationActivation(current, tabId, duplicate.id));
      return;
    }
    const nextTab: WorkFolderSurfaceTab = {
      id: tabId,
      kind: "chat",
      workFolderId: tabWorkFolder.id,
      conversationId: conversation.id,
      title: chatDisplayTitle({ serverTitle: conversation.title }),
    };
    setSurfaceTabs((current) => {
      return current.map((tab) => tab.id === tabId ? nextTab : tab);
    });
  }

  function removeWorkFolderSurfaceTabs(workFolderId: string): void {
    setSurfaceTabs((current) => current.filter((tab) => tab.workFolderId !== workFolderId));
  }

  function retargetFileSurfaceTabsForMove(workFolderId: string, sourcePath: string, movedPath: string): void {
    setSurfaceTabs((current) => retargetFileSurfaceTabs(current, workFolderId, sourcePath, movedPath));
  }

  function closeFileSurfaceTabsForDeletedPaths(workFolderId: string, deletedPaths: Set<string>): void {
    setSurfaceTabs((current) => closeFileSurfaceTabs(current, workFolderId, deletedPaths));
  }

  function updateSurfaceTabConversationTitle(workFolderId: string, conversation: ConversationSummary): void {
    setSurfaceTabs((current) => current.map((tab) => (
      tab.kind === "chat" && tab.workFolderId === workFolderId && tab.conversationId === conversation.id
        ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) }
        : tab
    )));
  }

  return {
    surfaceTabs,
    activeSurfaceTabId,
    setActiveSurfaceTabId,
    syncSurfaceTabConversationTitles,
    openChatSurfaceTab,
    openHistorySurfaceTab,
    openFileSurfaceTab,
    openAppStudioSurfaceTab,
    openChecksSurfaceTab,
    openWorkFolderAutomationsSurfaceTab,
    openExtensionSurfaceTab,
    openRestrictedAppSurfaceTab,
    updateRestrictedAppSurfaceTab,
    closeRestrictedAppSurfaceTab,
    reconcileRestrictedAppSurfaceTabs,
    closeSurfaceTab,
    reorderSurfaceTabs,
    handleTabConversationActivated,
    removeWorkFolderSurfaceTabs,
    retargetFileSurfaceTabsForMove,
    closeFileSurfaceTabsForDeletedPaths,
    updateSurfaceTabConversationTitle,
  };
}

/** Reorder known slots without dropping tabs opened during the gesture. */
export function reorderSurfaceTabList(tabs: WorkFolderSurfaceTab[], ids: string[]): WorkFolderSurfaceTab[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ordered = [...new Set(ids)].flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const selected = new Set(ordered.map((tab) => tab.id));
  let index = 0;
  const next = tabs.map((tab) => selected.has(tab.id) ? ordered[index++]! : tab);
  return next.every((tab, position) => tab === tabs[position]) ? tabs : next;
}

function newChatSurfaceTab(workFolder: WorkFolderSummary, options: { fresh?: boolean } = {}): WorkFolderSurfaceTab {
  return {
    id: options.fresh ? `chat:${workFolder.id}:draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` : newChatSurfaceTabId(workFolder.id),
    kind: "chat",
    workFolderId: workFolder.id,
    conversationId: null,
    title: "New Chat",
  };
}

interface SurfaceTabsState {
  tabs: WorkFolderSurfaceTab[];
  activeTabId: string | null;
}

function defaultSurfaceTabsState(workFolder: WorkFolderSummary): SurfaceTabsState {
  return {
    tabs: [newChatSurfaceTab(workFolder)],
    activeTabId: newChatSurfaceTabId(workFolder.id),
  };
}

function readStoredSurfaceTabsState(workFolder: WorkFolderSummary, workFolders: WorkFolderSummary[]): SurfaceTabsState {
  const stored = readStoredJsonValue<SurfaceTabsState>(surfaceTabsStorageKey, normalizeStoredSurfaceTabsValue, { tabs: [], activeTabId: null });
  if (!stored.tabs.length) return defaultSurfaceTabsState(workFolder);
  if (!workFolders.length) return normalizeActiveSurfaceTab(stored);
  const restored = restoreStoredSurfaceTabsForWorkFolders(stored, workFolders);
  return restored.tabs.length ? restored : defaultSurfaceTabsState(workFolder);
}

function writeStoredSurfaceTabsState(state: SurfaceTabsState): void {
  writeStoredJsonValue(surfaceTabsStorageKey, {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
  });
}

function normalizeStoredSurfaceTabsValue(parsed: unknown): SurfaceTabsState {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { tabs: [], activeTabId: null };
  const record = parsed as Record<string, unknown>;
  const activeTabId = typeof record.activeTabId === "string" ? record.activeTabId : null;
  const tabs = Array.isArray(record.tabs) ? normalizeStoredSurfaceTabs(record.tabs) : [];
  return normalizeActiveSurfaceTab({ tabs, activeTabId });
}

function normalizeStoredSurfaceTabs(tabs: unknown[]): WorkFolderSurfaceTab[] {
  const next: WorkFolderSurfaceTab[] = [];
  const seenIds = new Set<string>();
  for (const value of tabs) {
    const tab = normalizeStoredSurfaceTab(value);
    if (!tab || seenIds.has(tab.id)) continue;
    seenIds.add(tab.id);
    next.push(tab);
  }
  return next;
}

function normalizeStoredSurfaceTab(value: unknown): WorkFolderSurfaceTab | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.workFolderId !== "string" || typeof record.title !== "string") return null;
  if (record.kind === "chat") {
    if (record.conversationId !== null && typeof record.conversationId !== "string") return null;
    return {
      id: record.id,
      kind: "chat",
      workFolderId: record.workFolderId,
      conversationId: record.conversationId,
      title: record.title,
    };
  }
  if (record.kind === "file") {
    if (typeof record.path !== "string") return null;
    return {
      id: record.id,
      kind: "file",
      workFolderId: record.workFolderId,
      path: record.path,
      title: record.title,
    };
  }
  if (record.kind === "history") {
    if (record.checkpointId !== undefined && typeof record.checkpointId !== "string") return null;
    return {
      id: record.id,
      kind: "history",
      workFolderId: record.workFolderId,
      checkpointId: typeof record.checkpointId === "string" ? record.checkpointId : undefined,
      title: record.title,
    };
  }
  if (record.kind === "app-studio") {
    return {
      id: `app-studio:${record.workFolderId}`,
      kind: "app-studio",
      workFolderId: record.workFolderId,
      title: record.title,
    };
  }
  if (record.kind === "checks") {
    return {
      id: `checks:${record.workFolderId}`,
      kind: "checks",
      workFolderId: record.workFolderId,
      title: "Checks",
    };
  }
  if (record.kind === "work-folder-automations") {
    return {
      id: `work-folder-automations:${record.workFolderId}`,
      kind: "work-folder-automations",
      workFolderId: record.workFolderId,
      title: "Automations",
    };
  }
  if (record.kind === "extension") {
    if (typeof record.surfaceId !== "string" || typeof record.viewId !== "string") return null;
    if (record.surfaceExecution !== undefined && record.surfaceExecution !== "full-trust-pi") return null;
    return {
      id: record.id,
      kind: "extension",
      workFolderId: record.workFolderId,
      surfaceId: record.surfaceId,
      surfaceExecution: "full-trust-pi",
      viewId: record.viewId,
      title: record.title,
    };
  }
  if (record.kind === "restricted-app") {
    if (typeof record.appId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(record.appId)) return null;
    if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) return null;
    if (typeof record.appTabId !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(record.appTabId)) return null;
    if (typeof record.route !== "string" || !validRestrictedAppRoute(record.route)) return null;
    if (typeof record.featureInstallationId !== "string" || !/^feature-installation_[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(record.featureInstallationId)) return null;
    const id = restrictedAppSurfaceTabId(record.workFolderId, record.appId, record.digest, record.appTabId, record.featureInstallationId);
    return {
      id,
      kind: "restricted-app",
      workFolderId: record.workFolderId,
      appId: record.appId,
      featureInstallationId: record.featureInstallationId,
      digest: record.digest,
      appTabId: record.appTabId,
      route: record.route,
      ...(record.state !== undefined ? { state: record.state } : {}),
      title: record.title,
    };
  }
  return null;
}

function restoreStoredSurfaceTabsForWorkFolders(state: SurfaceTabsState, workFolders: WorkFolderSummary[]): SurfaceTabsState {
  return normalizeActiveSurfaceTab({
    tabs: filterSurfaceTabsToWorkFolders(state.tabs, workFolders),
    activeTabId: state.activeTabId,
  });
}

function filterSurfaceTabsToWorkFolders(tabs: WorkFolderSurfaceTab[], workFolders: WorkFolderSummary[]): WorkFolderSurfaceTab[] {
  const workFolderIds = new Set(workFolders.map((item) => item.id));
  return tabs.filter((tab) => workFolderIds.has(tab.workFolderId));
}

function normalizeActiveSurfaceTab(state: SurfaceTabsState): SurfaceTabsState {
  if (state.activeTabId && state.tabs.some((tab) => tab.id === state.activeTabId)) return state;
  return {
    tabs: state.tabs,
    activeTabId: state.tabs[0]?.id ?? null,
  };
}

function recordActiveSurfaceTabWorkFolderRecency(recentTabIdsByWorkFolder: Map<string, string>, tabs: WorkFolderSurfaceTab[], activeTabId: string | null): void {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return;
  recentTabIdsByWorkFolder.set(activeTab.workFolderId, activeTab.id);
}

function activeTabAfterConversationActivation(currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string): string | null {
  return currentActiveTabId === sourceTabId ? duplicateTabId : currentActiveTabId;
}

function surfaceTabWorkFolderSwitchTarget({
  activeTabId,
  activeWorkFolderId,
  tabs,
  workFolders,
}: {
  activeTabId: string | null;
  activeWorkFolderId: string;
  tabs: WorkFolderSurfaceTab[];
  workFolders: WorkFolderSummary[];
}): WorkFolderSummary | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab || activeTab.workFolderId === activeWorkFolderId) return null;
  return workFolders.find((item) => item.id === activeTab.workFolderId) ?? null;
}

function surfaceTabActivationForWorkFolder({
  activeTabId,
  recentTabIdsByWorkFolder,
  tabs,
  workFolder,
}: {
  activeTabId: string | null;
  recentTabIdsByWorkFolder: Map<string, string>;
  tabs: WorkFolderSurfaceTab[];
  workFolder: WorkFolderSummary;
}): { tabId: string; tabToAdd?: WorkFolderSurfaceTab } | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (activeTab?.workFolderId === workFolder.id) return null;

  const recentTabId = recentTabIdsByWorkFolder.get(workFolder.id);
  const recentTab = recentTabId ? tabs.find((tab) => tab.id === recentTabId && tab.workFolderId === workFolder.id) : null;
  if (recentTab) return { tabId: recentTab.id };

  const draftTab = tabs.find((tab) => tab.kind === "chat" && tab.workFolderId === workFolder.id && !tab.conversationId);
  if (draftTab) return { tabId: draftTab.id };

  const tab = newChatSurfaceTab(workFolder);
  return { tabId: tab.id, tabToAdd: tab };
}

function newChatSurfaceTabId(workFolderId: string): string {
  return `chat:${workFolderId}:new`;
}

function chatSurfaceTab(workFolder: WorkFolderSummary, conversation: ConversationSummary): WorkFolderSurfaceTab {
  return {
    id: `chat:${workFolder.id}:${conversation.id}`,
    kind: "chat",
    workFolderId: workFolder.id,
    conversationId: conversation.id,
    title: chatDisplayTitle({ serverTitle: conversation.title }),
  };
}

function historySurfaceTab(workFolder: WorkFolderSummary, checkpointId?: string, title = "History"): WorkFolderSurfaceTab {
  return {
    id: checkpointId ? `history:${workFolder.id}:${checkpointId}` : `history:${workFolder.id}`,
    kind: "history",
    workFolderId: workFolder.id,
    checkpointId,
    title,
  };
}

function fileSurfaceTab(workFolder: WorkFolderSummary, path: string): WorkFolderSurfaceTab {
  return {
    id: fileSurfaceTabId(workFolder.id),
    kind: "file",
    workFolderId: workFolder.id,
    path,
    title: fileSurfaceTitle(path),
  };
}

function fileSurfaceTabId(workFolderId: string): string {
  return `file:${workFolderId}`;
}

function fileSurfaceTitle(path: string): string {
  return path.split("/").pop() || path;
}

export function appStudioSurfaceTab(workFolder: WorkFolderSummary): WorkFolderSurfaceTab {
  return {
    id: `app-studio:${workFolder.id}`,
    kind: "app-studio",
    workFolderId: workFolder.id,
    title: "App Studio",
  };
}

/**
 * One work-folder-owned tab onto the automations that touch this work-folder
 * (docs/automations.md, F15 as amended 2026-09-24).
 */
export function spaceAutomationsSurfaceTab(workFolder: WorkFolderSummary): WorkFolderSurfaceTab {
  return {
    id: `work-folder-automations:${workFolder.id}`,
    kind: "work-folder-automations",
    workFolderId: workFolder.id,
    title: "Automations",
  };
}

export function checksSurfaceTab(workFolder: WorkFolderSummary): WorkFolderSurfaceTab {
  return {
    id: `checks:${workFolder.id}`,
    kind: "checks",
    workFolderId: workFolder.id,
    title: "Checks",
  };
}

function extensionSurfaceTab(
  workFolder: WorkFolderSummary,
  surface: CapabilitySurface,
  view: AgentExtensionSurfaceView,
): WorkFolderSurfaceTab {
  return {
    id: `extension:${workFolder.id}:${surface.key}:${view.id}`,
    kind: "extension",
    workFolderId: workFolder.id,
    surfaceId: surface.key,
    surfaceExecution: "full-trust-pi",
    viewId: view.id,
    title: view.title,
  };
}

function restrictedAppSurfaceTab(
  workFolderId: string,
  app: { appId: string; digest: string; featureInstallationId: string },
  target: { appTabId: string; title: string; route: string; state?: unknown },
): WorkFolderSurfaceTab {
  return {
    id: restrictedAppSurfaceTabId(workFolderId, app.appId, app.digest, target.appTabId, app.featureInstallationId),
    kind: "restricted-app",
    workFolderId,
    appId: app.appId,
    featureInstallationId: app.featureInstallationId,
    digest: app.digest,
    appTabId: target.appTabId,
    route: target.route,
    ...(target.state !== undefined ? { state: structuredClone(target.state) } : {}),
    title: target.title,
  };
}

function restrictedAppSurfaceTabId(workFolderId: string, appId: string, digest: string, appTabId: string, featureInstallationId: string): string {
  return `restricted-app:${workFolderId}:${appId}:${featureInstallationId}:${digest}:${appTabId}`;
}

function closeUnavailableRestrictedAppSurfaceTabs(
  tabs: WorkFolderSurfaceTab[],
  appsByWorkFolder: Record<string, Array<{ manifest: { id: string }; digest: string; featureInstallationId: string }>>,
  knownWorkFolderIds: ReadonlySet<string>,
): WorkFolderSurfaceTab[] {
  const next = tabs.filter((tab) => {
    if (tab.kind !== "restricted-app" || !knownWorkFolderIds.has(tab.workFolderId)) return true;
    return (appsByWorkFolder[tab.workFolderId] ?? []).some((app) => app.manifest.id === tab.appId && app.digest === tab.digest && app.featureInstallationId === tab.featureInstallationId);
  });
  return next.length === tabs.length ? tabs : next;
}

function validRestrictedAppRoute(value: string): boolean {
  if (value.length > 2_048 || /[\\\0\r\n]/.test(value) || !value.startsWith("/") || value.startsWith("//")) return false;
  try {
    return new URL(value, "https://restricted-app.invalid").origin === "https://restricted-app.invalid";
  } catch {
    return false;
  }
}

function upsertSurfaceTab(tabs: WorkFolderSurfaceTab[], tab: WorkFolderSurfaceTab): WorkFolderSurfaceTab[] {
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) return tabs.map((item) => item.id === tab.id ? { ...existing, ...tab } : item);
  return [...tabs, tab];
}

function retargetFileSurfaceTabs(tabs: WorkFolderSurfaceTab[], workFolderId: string, sourcePath: string, movedPath: string): WorkFolderSurfaceTab[] {
  return tabs.map((tab) => {
    if (tab.kind !== "file" || tab.workFolderId !== workFolderId || !tab.path) return tab;
    const nextPath = retargetMovedPath(tab.path, sourcePath, movedPath);
    if (!nextPath || nextPath === tab.path) return tab;
    return { ...tab, path: nextPath, title: fileSurfaceTitle(nextPath) };
  });
}

function closeFileSurfaceTabs(tabs: WorkFolderSurfaceTab[], workFolderId: string, deletedPaths: Set<string>): WorkFolderSurfaceTab[] {
  return tabs.filter((tab) => tab.kind !== "file" || tab.workFolderId !== workFolderId || !tab.path || !deletedPaths.has(tab.path));
}

export {
  activeTabAfterConversationActivation,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  fileSurfaceTabId,
  historySurfaceTab,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabWorkFolderRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForWorkFolders,
  retargetFileSurfaceTabs,
  restrictedAppSurfaceTabId,
  surfaceTabActivationForWorkFolder,
  surfaceTabWorkFolderSwitchTarget,
  upsertSurfaceTab,
};
