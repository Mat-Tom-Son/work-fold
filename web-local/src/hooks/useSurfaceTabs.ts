import { useCallback, useEffect, useRef, useState } from "react";

import { chatDisplayTitle } from "../lib/format";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { retargetMovedPath } from "../lib/tree";
import type { AgentExtensionSurfaceView, AssistantToolsView, CapabilitySurface, ConversationSummary, RestrictedAppInstalled, WorkspaceSummary, WorkspaceSurfaceTab } from "../types";

const surfaceTabsStorageKey = "workspace.surfaceTabs.v1";

export function useSurfaceTabs({
  workspace,
  workspaces,
  fixtureMode = false,
  migrateLegacyLibraryMode = false,
  openChatWorkspaceId,
  onOpenChatWorkspaceConsumed,
  onSwitchWorkspace,
}: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  fixtureMode?: boolean;
  migrateLegacyLibraryMode?: boolean;
  openChatWorkspaceId?: string | null;
  onOpenChatWorkspaceConsumed?: () => void;
  onSwitchWorkspace?: (workspace: WorkspaceSummary) => void;
}) {
  const initialStateRef = useRef<SurfaceTabsState | null>(null);
  const skipNextPersistRef = useRef(!fixtureMode && !migrateLegacyLibraryMode);
  const recentSurfaceTabIdsByWorkspaceRef = useRef<Map<string, string>>(new Map());
  const previousActiveSurfaceTabIdRef = useRef<string | null | undefined>(undefined);
  const previousWorkspaceCountRef = useRef(workspaces.length);
  const previousWorkspaceIdRef = useRef(workspace.id);
  if (!initialStateRef.current) {
    const initialState = fixtureMode
      ? defaultSurfaceTabsState(workspace)
      : readStoredSurfaceTabsState(workspace, workspaces);
    initialStateRef.current = migrateLegacyLibrarySurfaceTabState(initialState, workspace, migrateLegacyLibraryMode);
  }
  const [surfaceTabs, setSurfaceTabs] = useState<WorkspaceSurfaceTab[]>(() => initialStateRef.current?.tabs ?? [newChatSurfaceTab(workspace)]);
  const [activeSurfaceTabId, setActiveSurfaceTabId] = useState<string | null>(() => initialStateRef.current?.activeTabId ?? newChatSurfaceTabId(workspace.id));

  useEffect(() => {
    recordActiveSurfaceTabWorkspaceRecency(recentSurfaceTabIdsByWorkspaceRef.current, surfaceTabs, activeSurfaceTabId);
  }, [activeSurfaceTabId, surfaceTabs]);

  useEffect(() => {
    const activeChanged = previousActiveSurfaceTabIdRef.current !== activeSurfaceTabId;
    const workspacesHydrated = previousWorkspaceCountRef.current === 0 && workspaces.length > 0;
    previousActiveSurfaceTabIdRef.current = activeSurfaceTabId;
    previousWorkspaceCountRef.current = workspaces.length;
    if (!activeChanged && !workspacesHydrated) return;
    const targetWorkspace = surfaceTabWorkspaceSwitchTarget({
      activeTabId: activeSurfaceTabId,
      activeWorkspaceId: workspace.id,
      tabs: surfaceTabs,
      workspaces,
    });
    if (targetWorkspace) onSwitchWorkspace?.(targetWorkspace);
  }, [activeSurfaceTabId, onSwitchWorkspace, surfaceTabs, workspace.id, workspaces]);

  useEffect(() => {
    if (previousWorkspaceIdRef.current === workspace.id) return;
    previousWorkspaceIdRef.current = workspace.id;
    const resolution = surfaceTabActivationForWorkspace({
      activeTabId: activeSurfaceTabId,
      recentTabIdsByWorkspace: recentSurfaceTabIdsByWorkspaceRef.current,
      tabs: surfaceTabs,
      workspace,
    });
    if (!resolution || resolution.tabId === activeSurfaceTabId) return;
    if (resolution.tabToAdd) {
      const tabToAdd = resolution.tabToAdd;
      setSurfaceTabs((current) => current.some((tab) => tab.id === tabToAdd.id) ? current : [...current, tabToAdd]);
    }
    setActiveSurfaceTabId(resolution.tabId);
  }, [activeSurfaceTabId, surfaceTabs, workspace]);

  useEffect(() => {
    if (openChatWorkspaceId !== workspace.id) return;
    const existingDraftTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.workspaceId === workspace.id && !tab.conversationId);
    if (existingDraftTab) {
      setActiveSurfaceTabId(existingDraftTab.id);
      onOpenChatWorkspaceConsumed?.();
      return;
    }
    const tab = newChatSurfaceTab(workspace);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    onOpenChatWorkspaceConsumed?.();
  }, [openChatWorkspaceId, onOpenChatWorkspaceConsumed, surfaceTabs, workspace.id, workspace.name]);

  useEffect(() => {
    if (!workspaces.length) return;
    setSurfaceTabs((current) => {
      const next = filterSurfaceTabsToWorkspaces(current, workspaces);
      const resolved = next.length ? next : [newChatSurfaceTab(workspace)];
      setActiveSurfaceTabId((currentActiveTabId) => (
        currentActiveTabId && resolved.some((tab) => tab.id === currentActiveTabId)
          ? currentActiveTabId
          : resolved[0]?.id ?? null
      ));
      return resolved;
    });
  }, [workspace.id, workspace.name, workspaces]);

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
      const refreshedConversation = groups[tab.workspaceId]?.find((conversation) => conversation.id === tab.conversationId);
      if (!refreshedConversation) return tab;
      const title = chatDisplayTitle({ serverTitle: refreshedConversation.title });
      return tab.title === title ? tab : { ...tab, title };
    }));
  }

  function openChatSurfaceTab(targetWorkspace: WorkspaceSummary, conversation: ConversationSummary | null = null): string {
    if (conversation) {
      const existingTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.workspaceId === targetWorkspace.id && tab.conversationId === conversation.id);
      if (existingTab) {
        setSurfaceTabs((current) => current.map((tab) => (
          tab.id === existingTab.id ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) } : tab
        )));
        setActiveSurfaceTabId(existingTab.id);
        return existingTab.id;
      }
    }
    const tab = conversation ? chatSurfaceTab(targetWorkspace, conversation) : newChatSurfaceTab(targetWorkspace, { fresh: true });
    setSurfaceTabs((current) => conversation ? upsertSurfaceTab(current, tab) : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    return tab.id;
  }

  function openHistorySurfaceTab(targetWorkspace: WorkspaceSummary, checkpointId?: string, title = "History"): void {
    const tab = historySurfaceTab(targetWorkspace, checkpointId, title);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openLibrarySurfaceTab(targetWorkspace: WorkspaceSummary): void {
    const tab = librarySurfaceTab(targetWorkspace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openFileSurfaceTab(targetWorkspace: WorkspaceSummary, path: string): void {
    const tab = fileSurfaceTab(targetWorkspace, path);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAppearanceSurfaceTab(targetWorkspace: WorkspaceSummary): void {
    const tab = appearanceSurfaceTab(targetWorkspace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAppStudioSurfaceTab(targetWorkspace: WorkspaceSummary): void {
    const tab = appStudioSurfaceTab(targetWorkspace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAssistantToolsSurfaceTab(targetWorkspace: WorkspaceSummary, view: AssistantToolsView = "installed"): void {
    const tab = assistantToolsSurfaceTab(targetWorkspace, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openChecksSurfaceTab(targetWorkspace: WorkspaceSummary): void {
    const tab = checksSurfaceTab(targetWorkspace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openExtensionSurfaceTab(
    targetWorkspace: WorkspaceSummary,
    surface: CapabilitySurface,
    view: AgentExtensionSurfaceView,
  ): void {
    const tab = extensionSurfaceTab(targetWorkspace, surface, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openRestrictedAppSurfaceTab(
    targetWorkspace: WorkspaceSummary,
    app: { appId: string; digest: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const tab = restrictedAppSurfaceTab(targetWorkspace.id, app, target);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function updateRestrictedAppSurfaceTab(
    workspaceId: string,
    app: { appId: string; digest: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const id = restrictedAppSurfaceTabId(workspaceId, app.appId, app.digest, target.appTabId);
    setSurfaceTabs((current) => current.map((tab) => tab.id === id && tab.kind === "restricted-app"
      ? restrictedAppSurfaceTab(workspaceId, app, target)
      : tab));
  }

  function closeRestrictedAppSurfaceTab(workspaceId: string, appId: string, digest: string, appTabId: string): void {
    closeSurfaceTab(restrictedAppSurfaceTabId(workspaceId, appId, digest, appTabId));
  }

  const reconcileRestrictedAppSurfaceTabs = useCallback((
    appsByWorkspace: Record<string, RestrictedAppInstalled[]>,
    knownWorkspaceIds: ReadonlySet<string>,
  ): void => {
    setSurfaceTabs((current) => {
      const next = closeUnavailableRestrictedAppSurfaceTabs(current, appsByWorkspace, knownWorkspaceIds);
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

  function handleTabConversationActivated(tabId: string, tabWorkspace: WorkspaceSummary, conversation: ConversationSummary | null): void {
    if (!conversation) return;
    const duplicate = surfaceTabs.find((tab) => tab.kind === "chat" && tab.id !== tabId && tab.workspaceId === tabWorkspace.id && tab.conversationId === conversation.id);
    if (duplicate) {
      setSurfaceTabs((current) => current.filter((tab) => tab.id !== tabId));
      setActiveSurfaceTabId((current) => activeTabAfterConversationActivation(current, tabId, duplicate.id));
      return;
    }
    const nextTab: WorkspaceSurfaceTab = {
      id: tabId,
      kind: "chat",
      workspaceId: tabWorkspace.id,
      conversationId: conversation.id,
      title: chatDisplayTitle({ serverTitle: conversation.title }),
    };
    setSurfaceTabs((current) => {
      return current.map((tab) => tab.id === tabId ? nextTab : tab);
    });
  }

  function removeWorkspaceSurfaceTabs(workspaceId: string): void {
    setSurfaceTabs((current) => current.filter((tab) => tab.workspaceId !== workspaceId));
  }

  function retargetFileSurfaceTabsForMove(workspaceId: string, sourcePath: string, movedPath: string): void {
    setSurfaceTabs((current) => retargetFileSurfaceTabs(current, workspaceId, sourcePath, movedPath));
  }

  function closeFileSurfaceTabsForDeletedPaths(workspaceId: string, deletedPaths: Set<string>): void {
    setSurfaceTabs((current) => closeFileSurfaceTabs(current, workspaceId, deletedPaths));
  }

  function updateSurfaceTabConversationTitle(workspaceId: string, conversation: ConversationSummary): void {
    setSurfaceTabs((current) => current.map((tab) => (
      tab.kind === "chat" && tab.workspaceId === workspaceId && tab.conversationId === conversation.id
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
    openLibrarySurfaceTab,
    openFileSurfaceTab,
    openAppearanceSurfaceTab,
    openAppStudioSurfaceTab,
    openAssistantToolsSurfaceTab,
    openChecksSurfaceTab,
    openExtensionSurfaceTab,
    openRestrictedAppSurfaceTab,
    updateRestrictedAppSurfaceTab,
    closeRestrictedAppSurfaceTab,
    reconcileRestrictedAppSurfaceTabs,
    closeSurfaceTab,
    handleTabConversationActivated,
    removeWorkspaceSurfaceTabs,
    retargetFileSurfaceTabsForMove,
    closeFileSurfaceTabsForDeletedPaths,
    updateSurfaceTabConversationTitle,
  };
}

function newChatSurfaceTab(workspace: WorkspaceSummary, options: { fresh?: boolean } = {}): WorkspaceSurfaceTab {
  return {
    id: options.fresh ? `chat:${workspace.id}:draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` : newChatSurfaceTabId(workspace.id),
    kind: "chat",
    workspaceId: workspace.id,
    conversationId: null,
    title: "New chat",
  };
}

interface SurfaceTabsState {
  tabs: WorkspaceSurfaceTab[];
  activeTabId: string | null;
}

function defaultSurfaceTabsState(workspace: WorkspaceSummary): SurfaceTabsState {
  return {
    tabs: [newChatSurfaceTab(workspace)],
    activeTabId: newChatSurfaceTabId(workspace.id),
  };
}

function readStoredSurfaceTabsState(workspace: WorkspaceSummary, workspaces: WorkspaceSummary[]): SurfaceTabsState {
  const stored = readStoredJsonValue<SurfaceTabsState>(surfaceTabsStorageKey, normalizeStoredSurfaceTabsValue, { tabs: [], activeTabId: null });
  if (!stored.tabs.length) return defaultSurfaceTabsState(workspace);
  if (!workspaces.length) return normalizeActiveSurfaceTab(stored);
  const restored = restoreStoredSurfaceTabsForWorkspaces(stored, workspaces);
  return restored.tabs.length ? restored : defaultSurfaceTabsState(workspace);
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

function normalizeStoredSurfaceTabs(tabs: unknown[]): WorkspaceSurfaceTab[] {
  const next: WorkspaceSurfaceTab[] = [];
  const seenIds = new Set<string>();
  for (const value of tabs) {
    const tab = normalizeStoredSurfaceTab(value);
    if (!tab || seenIds.has(tab.id)) continue;
    seenIds.add(tab.id);
    next.push(tab);
  }
  return next;
}

function normalizeStoredSurfaceTab(value: unknown): WorkspaceSurfaceTab | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.workspaceId !== "string" || typeof record.title !== "string") return null;
  if (record.kind === "chat") {
    if (record.conversationId !== null && typeof record.conversationId !== "string") return null;
    return {
      id: record.id,
      kind: "chat",
      workspaceId: record.workspaceId,
      conversationId: record.conversationId,
      title: record.title,
    };
  }
  if (record.kind === "file") {
    if (typeof record.path !== "string") return null;
    return {
      id: record.id,
      kind: "file",
      workspaceId: record.workspaceId,
      path: record.path,
      title: record.title,
    };
  }
  if (record.kind === "history") {
    if (record.checkpointId !== undefined && typeof record.checkpointId !== "string") return null;
    return {
      id: record.id,
      kind: "history",
      workspaceId: record.workspaceId,
      checkpointId: typeof record.checkpointId === "string" ? record.checkpointId : undefined,
      title: record.title,
    };
  }
  if (record.kind === "library") {
    return {
      id: `library:${record.workspaceId}`,
      kind: "library",
      workspaceId: record.workspaceId,
      title: "Library",
    };
  }
  if (record.kind === "appearance") {
    return {
      id: record.id,
      kind: "appearance",
      workspaceId: record.workspaceId,
      title: record.title,
    };
  }
  if (record.kind === "app-studio") {
    return {
      id: `app-studio:${record.workspaceId}`,
      kind: "app-studio",
      workspaceId: record.workspaceId,
      title: record.title,
    };
  }
  if (record.kind === "assistant-tools") {
    if (record.view !== "installed" && record.view !== "discover") return null;
    return {
      id: `assistant-tools:${record.workspaceId}`,
      kind: "assistant-tools",
      workspaceId: record.workspaceId,
      view: record.view,
      title: "Assistant tools",
    };
  }
  if (record.kind === "checks") {
    return {
      id: `checks:${record.workspaceId}`,
      kind: "checks",
      workspaceId: record.workspaceId,
      title: "Checks",
    };
  }
  if (record.kind === "extension") {
    if (typeof record.surfaceId !== "string" || typeof record.viewId !== "string") return null;
    if (record.surfaceExecution !== undefined && record.surfaceExecution !== "full-trust-pi") return null;
    return {
      id: record.id,
      kind: "extension",
      workspaceId: record.workspaceId,
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
    const id = restrictedAppSurfaceTabId(record.workspaceId, record.appId, record.digest, record.appTabId);
    return {
      id,
      kind: "restricted-app",
      workspaceId: record.workspaceId,
      appId: record.appId,
      digest: record.digest,
      appTabId: record.appTabId,
      route: record.route,
      ...(record.state !== undefined ? { state: record.state } : {}),
      title: record.title,
    };
  }
  return null;
}

function restoreStoredSurfaceTabsForWorkspaces(state: SurfaceTabsState, workspaces: WorkspaceSummary[]): SurfaceTabsState {
  return normalizeActiveSurfaceTab({
    tabs: filterSurfaceTabsToWorkspaces(state.tabs, workspaces),
    activeTabId: state.activeTabId,
  });
}

function filterSurfaceTabsToWorkspaces(tabs: WorkspaceSurfaceTab[], workspaces: WorkspaceSummary[]): WorkspaceSurfaceTab[] {
  const workspaceIds = new Set(workspaces.map((item) => item.id));
  return tabs.filter((tab) => workspaceIds.has(tab.workspaceId));
}

function normalizeActiveSurfaceTab(state: SurfaceTabsState): SurfaceTabsState {
  if (state.activeTabId && state.tabs.some((tab) => tab.id === state.activeTabId)) return state;
  return {
    tabs: state.tabs,
    activeTabId: state.tabs[0]?.id ?? null,
  };
}

function recordActiveSurfaceTabWorkspaceRecency(recentTabIdsByWorkspace: Map<string, string>, tabs: WorkspaceSurfaceTab[], activeTabId: string | null): void {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return;
  recentTabIdsByWorkspace.set(activeTab.workspaceId, activeTab.id);
}

function activeTabAfterConversationActivation(currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string): string | null {
  return currentActiveTabId === sourceTabId ? duplicateTabId : currentActiveTabId;
}

function surfaceTabWorkspaceSwitchTarget({
  activeTabId,
  activeWorkspaceId,
  tabs,
  workspaces,
}: {
  activeTabId: string | null;
  activeWorkspaceId: string;
  tabs: WorkspaceSurfaceTab[];
  workspaces: WorkspaceSummary[];
}): WorkspaceSummary | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab || activeTab.workspaceId === activeWorkspaceId) return null;
  return workspaces.find((item) => item.id === activeTab.workspaceId) ?? null;
}

function surfaceTabActivationForWorkspace({
  activeTabId,
  recentTabIdsByWorkspace,
  tabs,
  workspace,
}: {
  activeTabId: string | null;
  recentTabIdsByWorkspace: Map<string, string>;
  tabs: WorkspaceSurfaceTab[];
  workspace: WorkspaceSummary;
}): { tabId: string; tabToAdd?: WorkspaceSurfaceTab } | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (activeTab?.workspaceId === workspace.id) return null;

  const recentTabId = recentTabIdsByWorkspace.get(workspace.id);
  const recentTab = recentTabId ? tabs.find((tab) => tab.id === recentTabId && tab.workspaceId === workspace.id) : null;
  if (recentTab) return { tabId: recentTab.id };

  const draftTab = tabs.find((tab) => tab.kind === "chat" && tab.workspaceId === workspace.id && !tab.conversationId);
  if (draftTab) return { tabId: draftTab.id };

  const tab = newChatSurfaceTab(workspace);
  return { tabId: tab.id, tabToAdd: tab };
}

function newChatSurfaceTabId(workspaceId: string): string {
  return `chat:${workspaceId}:new`;
}

function chatSurfaceTab(workspace: WorkspaceSummary, conversation: ConversationSummary): WorkspaceSurfaceTab {
  return {
    id: `chat:${workspace.id}:${conversation.id}`,
    kind: "chat",
    workspaceId: workspace.id,
    conversationId: conversation.id,
    title: chatDisplayTitle({ serverTitle: conversation.title }),
  };
}

function historySurfaceTab(workspace: WorkspaceSummary, checkpointId?: string, title = "History"): WorkspaceSurfaceTab {
  return {
    id: checkpointId ? `history:${workspace.id}:${checkpointId}` : `history:${workspace.id}`,
    kind: "history",
    workspaceId: workspace.id,
    checkpointId,
    title,
  };
}

export function librarySurfaceTab(workspace: WorkspaceSummary): WorkspaceSurfaceTab {
  return {
    id: `library:${workspace.id}`,
    kind: "library",
    workspaceId: workspace.id,
    title: "Library",
  };
}

export function migrateLegacyLibrarySurfaceTabState(
  state: SurfaceTabsState,
  workspace: WorkspaceSummary,
  shouldMigrate: boolean,
): SurfaceTabsState {
  if (!shouldMigrate) return state;
  const tab = librarySurfaceTab(workspace);
  return {
    tabs: upsertSurfaceTab(state.tabs, tab),
    activeTabId: tab.id,
  };
}

function fileSurfaceTab(workspace: WorkspaceSummary, path: string): WorkspaceSurfaceTab {
  return {
    id: fileSurfaceTabId(workspace.id),
    kind: "file",
    workspaceId: workspace.id,
    path,
    title: fileSurfaceTitle(path),
  };
}

function fileSurfaceTabId(workspaceId: string): string {
  return `file:${workspaceId}`;
}

function fileSurfaceTitle(path: string): string {
  return path.split("/").pop() || path;
}

function appearanceSurfaceTab(workspace: WorkspaceSummary): WorkspaceSurfaceTab {
  return {
    id: `appearance:${workspace.id}`,
    kind: "appearance",
    workspaceId: workspace.id,
    title: `Customize ${workspace.name}`,
  };
}

export function appStudioSurfaceTab(workspace: WorkspaceSummary): WorkspaceSurfaceTab {
  return {
    id: `app-studio:${workspace.id}`,
    kind: "app-studio",
    workspaceId: workspace.id,
    title: "App Studio",
  };
}

export function assistantToolsSurfaceTab(workspace: WorkspaceSummary, view: AssistantToolsView = "installed"): WorkspaceSurfaceTab {
  return {
    id: `assistant-tools:${workspace.id}`,
    kind: "assistant-tools",
    workspaceId: workspace.id,
    view,
    title: "Assistant tools",
  };
}

export function checksSurfaceTab(workspace: WorkspaceSummary): WorkspaceSurfaceTab {
  return {
    id: `checks:${workspace.id}`,
    kind: "checks",
    workspaceId: workspace.id,
    title: "Checks",
  };
}

function extensionSurfaceTab(
  workspace: WorkspaceSummary,
  surface: CapabilitySurface,
  view: AgentExtensionSurfaceView,
): WorkspaceSurfaceTab {
  return {
    id: `extension:${workspace.id}:${surface.key}:${view.id}`,
    kind: "extension",
    workspaceId: workspace.id,
    surfaceId: surface.key,
    surfaceExecution: "full-trust-pi",
    viewId: view.id,
    title: view.title,
  };
}

function restrictedAppSurfaceTab(
  workspaceId: string,
  app: { appId: string; digest: string },
  target: { appTabId: string; title: string; route: string; state?: unknown },
): WorkspaceSurfaceTab {
  return {
    id: restrictedAppSurfaceTabId(workspaceId, app.appId, app.digest, target.appTabId),
    kind: "restricted-app",
    workspaceId,
    appId: app.appId,
    digest: app.digest,
    appTabId: target.appTabId,
    route: target.route,
    ...(target.state !== undefined ? { state: structuredClone(target.state) } : {}),
    title: target.title,
  };
}

function restrictedAppSurfaceTabId(workspaceId: string, appId: string, digest: string, appTabId: string): string {
  return `restricted-app:${workspaceId}:${appId}:${digest}:${appTabId}`;
}

function closeUnavailableRestrictedAppSurfaceTabs(
  tabs: WorkspaceSurfaceTab[],
  appsByWorkspace: Record<string, Array<{ manifest: { id: string }; digest: string }>>,
  knownWorkspaceIds: ReadonlySet<string>,
): WorkspaceSurfaceTab[] {
  const next = tabs.filter((tab) => {
    if (tab.kind !== "restricted-app" || !knownWorkspaceIds.has(tab.workspaceId)) return true;
    return (appsByWorkspace[tab.workspaceId] ?? []).some((app) => app.manifest.id === tab.appId && app.digest === tab.digest);
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

function upsertSurfaceTab(tabs: WorkspaceSurfaceTab[], tab: WorkspaceSurfaceTab): WorkspaceSurfaceTab[] {
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) return tabs.map((item) => item.id === tab.id ? { ...existing, ...tab } : item);
  return [...tabs, tab];
}

function retargetFileSurfaceTabs(tabs: WorkspaceSurfaceTab[], workspaceId: string, sourcePath: string, movedPath: string): WorkspaceSurfaceTab[] {
  return tabs.map((tab) => {
    if (tab.kind !== "file" || tab.workspaceId !== workspaceId || !tab.path) return tab;
    const nextPath = retargetMovedPath(tab.path, sourcePath, movedPath);
    if (!nextPath || nextPath === tab.path) return tab;
    return { ...tab, path: nextPath, title: fileSurfaceTitle(nextPath) };
  });
}

function closeFileSurfaceTabs(tabs: WorkspaceSurfaceTab[], workspaceId: string, deletedPaths: Set<string>): WorkspaceSurfaceTab[] {
  return tabs.filter((tab) => tab.kind !== "file" || tab.workspaceId !== workspaceId || !tab.path || !deletedPaths.has(tab.path));
}

export {
  activeTabAfterConversationActivation,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  fileSurfaceTabId,
  historySurfaceTab,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabWorkspaceRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForWorkspaces,
  retargetFileSurfaceTabs,
  restrictedAppSurfaceTabId,
  surfaceTabActivationForWorkspace,
  surfaceTabWorkspaceSwitchTarget,
  upsertSurfaceTab,
};
