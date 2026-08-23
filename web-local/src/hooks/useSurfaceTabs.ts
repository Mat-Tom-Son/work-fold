import { useCallback, useEffect, useRef, useState } from "react";

import { chatDisplayTitle } from "../lib/format";
import { readStoredJsonValue, writeStoredJsonValue } from "../lib/storage";
import { retargetMovedPath } from "../lib/tree";
import type { AgentExtensionSurfaceView, AssistantToolsView, CapabilitySurface, ConversationSummary, RestrictedAppInstalled, SpaceSummary, SpaceSurfaceTab } from "../types";

const surfaceTabsStorageKey = "work-fold.space.surface-tabs.v1";

export function useSurfaceTabs({
  space,
  spaces,
  fixtureMode = false,
  migrateLegacyLibraryMode = false,
  openChatSpaceId,
  onOpenChatSpaceConsumed,
  onSwitchSpace,
}: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  fixtureMode?: boolean;
  migrateLegacyLibraryMode?: boolean;
  openChatSpaceId?: string | null;
  onOpenChatSpaceConsumed?: () => void;
  onSwitchSpace?: (space: SpaceSummary) => void;
}) {
  const initialStateRef = useRef<SurfaceTabsState | null>(null);
  const skipNextPersistRef = useRef(!fixtureMode && !migrateLegacyLibraryMode);
  const recentSurfaceTabIdsBySpaceRef = useRef<Map<string, string>>(new Map());
  const previousActiveSurfaceTabIdRef = useRef<string | null | undefined>(undefined);
  const previousSpaceCountRef = useRef(spaces.length);
  const previousSpaceIdRef = useRef(space.id);
  if (!initialStateRef.current) {
    const initialState = fixtureMode
      ? defaultSurfaceTabsState(space)
      : readStoredSurfaceTabsState(space, spaces);
    initialStateRef.current = migrateLegacyLibrarySurfaceTabState(initialState, space, migrateLegacyLibraryMode);
  }
  const [surfaceTabs, setSurfaceTabs] = useState<SpaceSurfaceTab[]>(() => initialStateRef.current?.tabs ?? [newChatSurfaceTab(space)]);
  const [activeSurfaceTabId, setActiveSurfaceTabId] = useState<string | null>(() => initialStateRef.current?.activeTabId ?? newChatSurfaceTabId(space.id));

  useEffect(() => {
    recordActiveSurfaceTabSpaceRecency(recentSurfaceTabIdsBySpaceRef.current, surfaceTabs, activeSurfaceTabId);
  }, [activeSurfaceTabId, surfaceTabs]);

  useEffect(() => {
    const activeChanged = previousActiveSurfaceTabIdRef.current !== activeSurfaceTabId;
    const spacesHydrated = previousSpaceCountRef.current === 0 && spaces.length > 0;
    previousActiveSurfaceTabIdRef.current = activeSurfaceTabId;
    previousSpaceCountRef.current = spaces.length;
    if (!activeChanged && !spacesHydrated) return;
    const targetSpace = surfaceTabSpaceSwitchTarget({
      activeTabId: activeSurfaceTabId,
      activeSpaceId: space.id,
      tabs: surfaceTabs,
      spaces,
    });
    if (targetSpace) onSwitchSpace?.(targetSpace);
  }, [activeSurfaceTabId, onSwitchSpace, surfaceTabs, space.id, spaces]);

  useEffect(() => {
    if (previousSpaceIdRef.current === space.id) return;
    previousSpaceIdRef.current = space.id;
    const resolution = surfaceTabActivationForSpace({
      activeTabId: activeSurfaceTabId,
      recentTabIdsBySpace: recentSurfaceTabIdsBySpaceRef.current,
      tabs: surfaceTabs,
      space,
    });
    if (!resolution || resolution.tabId === activeSurfaceTabId) return;
    if (resolution.tabToAdd) {
      const tabToAdd = resolution.tabToAdd;
      setSurfaceTabs((current) => current.some((tab) => tab.id === tabToAdd.id) ? current : [...current, tabToAdd]);
    }
    setActiveSurfaceTabId(resolution.tabId);
  }, [activeSurfaceTabId, surfaceTabs, space]);

  useEffect(() => {
    if (openChatSpaceId !== space.id) return;
    const existingDraftTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.spaceId === space.id && !tab.conversationId);
    if (existingDraftTab) {
      setActiveSurfaceTabId(existingDraftTab.id);
      onOpenChatSpaceConsumed?.();
      return;
    }
    const tab = newChatSurfaceTab(space);
    setSurfaceTabs((current) => current.some((item) => item.id === tab.id) ? current : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    onOpenChatSpaceConsumed?.();
  }, [openChatSpaceId, onOpenChatSpaceConsumed, surfaceTabs, space.id, space.name]);

  useEffect(() => {
    if (!spaces.length) return;
    setSurfaceTabs((current) => {
      const next = filterSurfaceTabsToSpaces(current, spaces);
      const resolved = next.length ? next : [newChatSurfaceTab(space)];
      setActiveSurfaceTabId((currentActiveTabId) => (
        currentActiveTabId && resolved.some((tab) => tab.id === currentActiveTabId)
          ? currentActiveTabId
          : resolved[0]?.id ?? null
      ));
      return resolved;
    });
  }, [space.id, space.name, spaces]);

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
      const refreshedConversation = groups[tab.spaceId]?.find((conversation) => conversation.id === tab.conversationId);
      if (!refreshedConversation) return tab;
      const title = chatDisplayTitle({ serverTitle: refreshedConversation.title });
      return tab.title === title ? tab : { ...tab, title };
    }));
  }

  function openChatSurfaceTab(targetSpace: SpaceSummary, conversation: ConversationSummary | null = null): string {
    if (conversation) {
      const existingTab = surfaceTabs.find((tab) => tab.kind === "chat" && tab.spaceId === targetSpace.id && tab.conversationId === conversation.id);
      if (existingTab) {
        setSurfaceTabs((current) => current.map((tab) => (
          tab.id === existingTab.id ? { ...tab, title: chatDisplayTitle({ serverTitle: conversation.title }) } : tab
        )));
        setActiveSurfaceTabId(existingTab.id);
        return existingTab.id;
      }
    }
    const tab = conversation ? chatSurfaceTab(targetSpace, conversation) : newChatSurfaceTab(targetSpace, { fresh: true });
    setSurfaceTabs((current) => conversation ? upsertSurfaceTab(current, tab) : [...current, tab]);
    setActiveSurfaceTabId(tab.id);
    return tab.id;
  }

  function openHistorySurfaceTab(targetSpace: SpaceSummary, checkpointId?: string, title = "History"): void {
    const tab = historySurfaceTab(targetSpace, checkpointId, title);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openLibrarySurfaceTab(targetSpace: SpaceSummary): void {
    const tab = librarySurfaceTab(targetSpace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openFileSurfaceTab(targetSpace: SpaceSummary, path: string): void {
    const tab = fileSurfaceTab(targetSpace, path);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAppearanceSurfaceTab(targetSpace: SpaceSummary): void {
    const tab = appearanceSurfaceTab(targetSpace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAppStudioSurfaceTab(targetSpace: SpaceSummary): void {
    const tab = appStudioSurfaceTab(targetSpace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openAssistantToolsSurfaceTab(targetSpace: SpaceSummary, view: AssistantToolsView = "installed"): void {
    const tab = assistantToolsSurfaceTab(targetSpace, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openChecksSurfaceTab(targetSpace: SpaceSummary): void {
    const tab = checksSurfaceTab(targetSpace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openSpaceAppsSurfaceTab(targetSpace: SpaceSummary): void {
    const tab = spaceAppsSurfaceTab(targetSpace);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openExtensionSurfaceTab(
    targetSpace: SpaceSummary,
    surface: CapabilitySurface,
    view: AgentExtensionSurfaceView,
  ): void {
    const tab = extensionSurfaceTab(targetSpace, surface, view);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function openRestrictedAppSurfaceTab(
    targetSpace: SpaceSummary,
    app: { appId: string; digest: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const tab = restrictedAppSurfaceTab(targetSpace.id, app, target);
    setSurfaceTabs((current) => upsertSurfaceTab(current, tab));
    setActiveSurfaceTabId(tab.id);
  }

  function updateRestrictedAppSurfaceTab(
    spaceId: string,
    app: { appId: string; digest: string },
    target: { appTabId: string; title: string; route: string; state?: unknown },
  ): void {
    const id = restrictedAppSurfaceTabId(spaceId, app.appId, app.digest, target.appTabId);
    setSurfaceTabs((current) => current.map((tab) => tab.id === id && tab.kind === "restricted-app"
      ? restrictedAppSurfaceTab(spaceId, app, target)
      : tab));
  }

  function closeRestrictedAppSurfaceTab(spaceId: string, appId: string, digest: string, appTabId: string): void {
    closeSurfaceTab(restrictedAppSurfaceTabId(spaceId, appId, digest, appTabId));
  }

  const reconcileRestrictedAppSurfaceTabs = useCallback((
    appsBySpace: Record<string, RestrictedAppInstalled[]>,
    knownSpaceIds: ReadonlySet<string>,
  ): void => {
    setSurfaceTabs((current) => {
      const next = closeUnavailableRestrictedAppSurfaceTabs(current, appsBySpace, knownSpaceIds);
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

  function handleTabConversationActivated(tabId: string, tabSpace: SpaceSummary, conversation: ConversationSummary | null): void {
    if (!conversation) return;
    const duplicate = surfaceTabs.find((tab) => tab.kind === "chat" && tab.id !== tabId && tab.spaceId === tabSpace.id && tab.conversationId === conversation.id);
    if (duplicate) {
      setSurfaceTabs((current) => current.filter((tab) => tab.id !== tabId));
      setActiveSurfaceTabId((current) => activeTabAfterConversationActivation(current, tabId, duplicate.id));
      return;
    }
    const nextTab: SpaceSurfaceTab = {
      id: tabId,
      kind: "chat",
      spaceId: tabSpace.id,
      conversationId: conversation.id,
      title: chatDisplayTitle({ serverTitle: conversation.title }),
    };
    setSurfaceTabs((current) => {
      return current.map((tab) => tab.id === tabId ? nextTab : tab);
    });
  }

  function removeSpaceSurfaceTabs(spaceId: string): void {
    setSurfaceTabs((current) => current.filter((tab) => tab.spaceId !== spaceId));
  }

  function retargetFileSurfaceTabsForMove(spaceId: string, sourcePath: string, movedPath: string): void {
    setSurfaceTabs((current) => retargetFileSurfaceTabs(current, spaceId, sourcePath, movedPath));
  }

  function closeFileSurfaceTabsForDeletedPaths(spaceId: string, deletedPaths: Set<string>): void {
    setSurfaceTabs((current) => closeFileSurfaceTabs(current, spaceId, deletedPaths));
  }

  function updateSurfaceTabConversationTitle(spaceId: string, conversation: ConversationSummary): void {
    setSurfaceTabs((current) => current.map((tab) => (
      tab.kind === "chat" && tab.spaceId === spaceId && tab.conversationId === conversation.id
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
    openSpaceAppsSurfaceTab,
    openExtensionSurfaceTab,
    openRestrictedAppSurfaceTab,
    updateRestrictedAppSurfaceTab,
    closeRestrictedAppSurfaceTab,
    reconcileRestrictedAppSurfaceTabs,
    closeSurfaceTab,
    handleTabConversationActivated,
    removeSpaceSurfaceTabs,
    retargetFileSurfaceTabsForMove,
    closeFileSurfaceTabsForDeletedPaths,
    updateSurfaceTabConversationTitle,
  };
}

function newChatSurfaceTab(space: SpaceSummary, options: { fresh?: boolean } = {}): SpaceSurfaceTab {
  return {
    id: options.fresh ? `chat:${space.id}:draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` : newChatSurfaceTabId(space.id),
    kind: "chat",
    spaceId: space.id,
    conversationId: null,
    title: "New chat",
  };
}

interface SurfaceTabsState {
  tabs: SpaceSurfaceTab[];
  activeTabId: string | null;
}

function defaultSurfaceTabsState(space: SpaceSummary): SurfaceTabsState {
  return {
    tabs: [newChatSurfaceTab(space)],
    activeTabId: newChatSurfaceTabId(space.id),
  };
}

function readStoredSurfaceTabsState(space: SpaceSummary, spaces: SpaceSummary[]): SurfaceTabsState {
  const stored = readStoredJsonValue<SurfaceTabsState>(surfaceTabsStorageKey, normalizeStoredSurfaceTabsValue, { tabs: [], activeTabId: null });
  if (!stored.tabs.length) return defaultSurfaceTabsState(space);
  if (!spaces.length) return normalizeActiveSurfaceTab(stored);
  const restored = restoreStoredSurfaceTabsForSpaces(stored, spaces);
  return restored.tabs.length ? restored : defaultSurfaceTabsState(space);
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

function normalizeStoredSurfaceTabs(tabs: unknown[]): SpaceSurfaceTab[] {
  const next: SpaceSurfaceTab[] = [];
  const seenIds = new Set<string>();
  for (const value of tabs) {
    const tab = normalizeStoredSurfaceTab(value);
    if (!tab || seenIds.has(tab.id)) continue;
    seenIds.add(tab.id);
    next.push(tab);
  }
  return next;
}

function normalizeStoredSurfaceTab(value: unknown): SpaceSurfaceTab | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.spaceId !== "string" || typeof record.title !== "string") return null;
  if (record.kind === "chat") {
    if (record.conversationId !== null && typeof record.conversationId !== "string") return null;
    return {
      id: record.id,
      kind: "chat",
      spaceId: record.spaceId,
      conversationId: record.conversationId,
      title: record.title,
    };
  }
  if (record.kind === "file") {
    if (typeof record.path !== "string") return null;
    return {
      id: record.id,
      kind: "file",
      spaceId: record.spaceId,
      path: record.path,
      title: record.title,
    };
  }
  if (record.kind === "history") {
    if (record.checkpointId !== undefined && typeof record.checkpointId !== "string") return null;
    return {
      id: record.id,
      kind: "history",
      spaceId: record.spaceId,
      checkpointId: typeof record.checkpointId === "string" ? record.checkpointId : undefined,
      title: record.title,
    };
  }
  if (record.kind === "library") {
    return {
      id: `library:${record.spaceId}`,
      kind: "library",
      spaceId: record.spaceId,
      title: "Library",
    };
  }
  if (record.kind === "appearance") {
    return {
      id: record.id,
      kind: "appearance",
      spaceId: record.spaceId,
      title: record.title,
    };
  }
  if (record.kind === "app-studio") {
    return {
      id: `app-studio:${record.spaceId}`,
      kind: "app-studio",
      spaceId: record.spaceId,
      title: record.title,
    };
  }
  if (record.kind === "assistant-tools") {
    if (record.view !== "installed" && record.view !== "discover") return null;
    return {
      id: `assistant-tools:${record.spaceId}`,
      kind: "assistant-tools",
      spaceId: record.spaceId,
      view: record.view,
      title: "Skills & Extensions",
    };
  }
  if (record.kind === "space-apps") {
    return {
      id: `space-apps:${record.spaceId}`,
      kind: "space-apps",
      spaceId: record.spaceId,
      title: "Apps",
    };
  }
  if (record.kind === "checks") {
    return {
      id: `checks:${record.spaceId}`,
      kind: "checks",
      spaceId: record.spaceId,
      title: "Checks",
    };
  }
  if (record.kind === "extension") {
    if (typeof record.surfaceId !== "string" || typeof record.viewId !== "string") return null;
    if (record.surfaceExecution !== undefined && record.surfaceExecution !== "full-trust-pi") return null;
    return {
      id: record.id,
      kind: "extension",
      spaceId: record.spaceId,
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
    const id = restrictedAppSurfaceTabId(record.spaceId, record.appId, record.digest, record.appTabId);
    return {
      id,
      kind: "restricted-app",
      spaceId: record.spaceId,
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

function restoreStoredSurfaceTabsForSpaces(state: SurfaceTabsState, spaces: SpaceSummary[]): SurfaceTabsState {
  return normalizeActiveSurfaceTab({
    tabs: filterSurfaceTabsToSpaces(state.tabs, spaces),
    activeTabId: state.activeTabId,
  });
}

function filterSurfaceTabsToSpaces(tabs: SpaceSurfaceTab[], spaces: SpaceSummary[]): SpaceSurfaceTab[] {
  const spaceIds = new Set(spaces.map((item) => item.id));
  return tabs.filter((tab) => spaceIds.has(tab.spaceId));
}

function normalizeActiveSurfaceTab(state: SurfaceTabsState): SurfaceTabsState {
  if (state.activeTabId && state.tabs.some((tab) => tab.id === state.activeTabId)) return state;
  return {
    tabs: state.tabs,
    activeTabId: state.tabs[0]?.id ?? null,
  };
}

function recordActiveSurfaceTabSpaceRecency(recentTabIdsBySpace: Map<string, string>, tabs: SpaceSurfaceTab[], activeTabId: string | null): void {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return;
  recentTabIdsBySpace.set(activeTab.spaceId, activeTab.id);
}

function activeTabAfterConversationActivation(currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string): string | null {
  return currentActiveTabId === sourceTabId ? duplicateTabId : currentActiveTabId;
}

function surfaceTabSpaceSwitchTarget({
  activeTabId,
  activeSpaceId,
  tabs,
  spaces,
}: {
  activeTabId: string | null;
  activeSpaceId: string;
  tabs: SpaceSurfaceTab[];
  spaces: SpaceSummary[];
}): SpaceSummary | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab || activeTab.spaceId === activeSpaceId) return null;
  return spaces.find((item) => item.id === activeTab.spaceId) ?? null;
}

function surfaceTabActivationForSpace({
  activeTabId,
  recentTabIdsBySpace,
  tabs,
  space,
}: {
  activeTabId: string | null;
  recentTabIdsBySpace: Map<string, string>;
  tabs: SpaceSurfaceTab[];
  space: SpaceSummary;
}): { tabId: string; tabToAdd?: SpaceSurfaceTab } | null {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (activeTab?.spaceId === space.id) return null;

  const recentTabId = recentTabIdsBySpace.get(space.id);
  const recentTab = recentTabId ? tabs.find((tab) => tab.id === recentTabId && tab.spaceId === space.id) : null;
  if (recentTab) return { tabId: recentTab.id };

  const draftTab = tabs.find((tab) => tab.kind === "chat" && tab.spaceId === space.id && !tab.conversationId);
  if (draftTab) return { tabId: draftTab.id };

  const tab = newChatSurfaceTab(space);
  return { tabId: tab.id, tabToAdd: tab };
}

function newChatSurfaceTabId(spaceId: string): string {
  return `chat:${spaceId}:new`;
}

function chatSurfaceTab(space: SpaceSummary, conversation: ConversationSummary): SpaceSurfaceTab {
  return {
    id: `chat:${space.id}:${conversation.id}`,
    kind: "chat",
    spaceId: space.id,
    conversationId: conversation.id,
    title: chatDisplayTitle({ serverTitle: conversation.title }),
  };
}

function historySurfaceTab(space: SpaceSummary, checkpointId?: string, title = "History"): SpaceSurfaceTab {
  return {
    id: checkpointId ? `history:${space.id}:${checkpointId}` : `history:${space.id}`,
    kind: "history",
    spaceId: space.id,
    checkpointId,
    title,
  };
}

export function librarySurfaceTab(space: SpaceSummary): SpaceSurfaceTab {
  return {
    id: `library:${space.id}`,
    kind: "library",
    spaceId: space.id,
    title: "Library",
  };
}

export function migrateLegacyLibrarySurfaceTabState(
  state: SurfaceTabsState,
  space: SpaceSummary,
  shouldMigrate: boolean,
): SurfaceTabsState {
  if (!shouldMigrate) return state;
  const tab = librarySurfaceTab(space);
  return {
    tabs: upsertSurfaceTab(state.tabs, tab),
    activeTabId: tab.id,
  };
}

function fileSurfaceTab(space: SpaceSummary, path: string): SpaceSurfaceTab {
  return {
    id: fileSurfaceTabId(space.id),
    kind: "file",
    spaceId: space.id,
    path,
    title: fileSurfaceTitle(path),
  };
}

function fileSurfaceTabId(spaceId: string): string {
  return `file:${spaceId}`;
}

function fileSurfaceTitle(path: string): string {
  return path.split("/").pop() || path;
}

function appearanceSurfaceTab(space: SpaceSummary): SpaceSurfaceTab {
  return {
    id: `appearance:${space.id}`,
    kind: "appearance",
    spaceId: space.id,
    title: `Customize ${space.name}`,
  };
}

export function appStudioSurfaceTab(space: SpaceSummary): SpaceSurfaceTab {
  return {
    id: `app-studio:${space.id}`,
    kind: "app-studio",
    spaceId: space.id,
    title: "App Studio",
  };
}

export function assistantToolsSurfaceTab(space: SpaceSummary, view: AssistantToolsView = "installed"): SpaceSurfaceTab {
  return {
    id: `assistant-tools:${space.id}`,
    kind: "assistant-tools",
    spaceId: space.id,
    view,
    title: "Skills & Extensions",
  };
}

/** One Space-owned tab for installed sandboxed apps: their access, connections, automations, and removal. */
export function spaceAppsSurfaceTab(space: SpaceSummary): SpaceSurfaceTab {
  return {
    id: `space-apps:${space.id}`,
    kind: "space-apps",
    spaceId: space.id,
    title: "Apps",
  };
}

export function checksSurfaceTab(space: SpaceSummary): SpaceSurfaceTab {
  return {
    id: `checks:${space.id}`,
    kind: "checks",
    spaceId: space.id,
    title: "Checks",
  };
}

function extensionSurfaceTab(
  space: SpaceSummary,
  surface: CapabilitySurface,
  view: AgentExtensionSurfaceView,
): SpaceSurfaceTab {
  return {
    id: `extension:${space.id}:${surface.key}:${view.id}`,
    kind: "extension",
    spaceId: space.id,
    surfaceId: surface.key,
    surfaceExecution: "full-trust-pi",
    viewId: view.id,
    title: view.title,
  };
}

function restrictedAppSurfaceTab(
  spaceId: string,
  app: { appId: string; digest: string },
  target: { appTabId: string; title: string; route: string; state?: unknown },
): SpaceSurfaceTab {
  return {
    id: restrictedAppSurfaceTabId(spaceId, app.appId, app.digest, target.appTabId),
    kind: "restricted-app",
    spaceId,
    appId: app.appId,
    digest: app.digest,
    appTabId: target.appTabId,
    route: target.route,
    ...(target.state !== undefined ? { state: structuredClone(target.state) } : {}),
    title: target.title,
  };
}

function restrictedAppSurfaceTabId(spaceId: string, appId: string, digest: string, appTabId: string): string {
  return `restricted-app:${spaceId}:${appId}:${digest}:${appTabId}`;
}

function closeUnavailableRestrictedAppSurfaceTabs(
  tabs: SpaceSurfaceTab[],
  appsBySpace: Record<string, Array<{ manifest: { id: string }; digest: string }>>,
  knownSpaceIds: ReadonlySet<string>,
): SpaceSurfaceTab[] {
  const next = tabs.filter((tab) => {
    if (tab.kind !== "restricted-app" || !knownSpaceIds.has(tab.spaceId)) return true;
    return (appsBySpace[tab.spaceId] ?? []).some((app) => app.manifest.id === tab.appId && app.digest === tab.digest);
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

function upsertSurfaceTab(tabs: SpaceSurfaceTab[], tab: SpaceSurfaceTab): SpaceSurfaceTab[] {
  const existing = tabs.find((item) => item.id === tab.id);
  if (existing) return tabs.map((item) => item.id === tab.id ? { ...existing, ...tab } : item);
  return [...tabs, tab];
}

function retargetFileSurfaceTabs(tabs: SpaceSurfaceTab[], spaceId: string, sourcePath: string, movedPath: string): SpaceSurfaceTab[] {
  return tabs.map((tab) => {
    if (tab.kind !== "file" || tab.spaceId !== spaceId || !tab.path) return tab;
    const nextPath = retargetMovedPath(tab.path, sourcePath, movedPath);
    if (!nextPath || nextPath === tab.path) return tab;
    return { ...tab, path: nextPath, title: fileSurfaceTitle(nextPath) };
  });
}

function closeFileSurfaceTabs(tabs: SpaceSurfaceTab[], spaceId: string, deletedPaths: Set<string>): SpaceSurfaceTab[] {
  return tabs.filter((tab) => tab.kind !== "file" || tab.spaceId !== spaceId || !tab.path || !deletedPaths.has(tab.path));
}

export {
  activeTabAfterConversationActivation,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  fileSurfaceTabId,
  historySurfaceTab,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabSpaceRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForSpaces,
  retargetFileSurfaceTabs,
  restrictedAppSurfaceTabId,
  surfaceTabActivationForSpace,
  surfaceTabSpaceSwitchTarget,
  upsertSurfaceTab,
};
