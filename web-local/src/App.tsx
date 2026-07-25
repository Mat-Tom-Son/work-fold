import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowSync16Regular, Color20Regular, Settings24Regular } from "@fluentui/react-icons";
import { AlertTriangle, CirclePlus, Download, FolderOpen, Loader2, Search, Upload, X } from "lucide-react";

import { defaultTypographyPreference, productName, textSizeValues, themePreferenceKey, typographyFontValues, typographyPreferenceKey, workspaceCustomizationStorageKey, workspacePathDragType } from "./constants";
import { ChatActionsPopover } from "./components/chat/ChatActionsPopover";
import { ChatPanel } from "./components/chat/ChatPanel";
import { WorkspaceSurfaceTabBar } from "./components/chat/WorkspaceSurfaceTabBar";
import { Banner, CenteredState, EmptyInline, WorkspaceIconGlyph } from "./components/chrome/common";
import { DesktopTitleBar } from "./components/chrome/DesktopTitleBar";
import { CommandPaletteHost, type CommandPaletteCommand } from "./components/modals/CommandPaletteHost";
import { CreateSpaceModal } from "./components/modals/CreateSpaceModal";
import { DesktopSettingsModal, type SettingsPage } from "./components/modals/DesktopSettingsModal";
import { FileVersionHistoryModal } from "./components/modals/FileVersionHistoryModal";
import { KeyboardShortcutsModal } from "./components/modals/KeyboardShortcutsModal";
import { TextInputModal } from "./components/modals/TextInputModal";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { FileDetailsPane } from "./components/panes/FileDetailsPane";
import { AppStudioPane } from "./components/panes/AppStudioPane";
import { CapabilitiesPane } from "./components/panes/CapabilitiesPane";
import { ExtensionSurfacePane, ExtensionSurfaceUnavailable, ExtensionSurfaceView } from "./components/panes/ExtensionSurface";
import { RestrictedAppViewport } from "./components/panes/RestrictedAppViewport";
import { WorkspaceAppearancePanel, WorkspaceModeRail, WorkspacePaneHeader } from "./components/panes/workspaceChrome";
import { FileContentSearch } from "./components/panes/FileContentSearch";
import { ChatsPane, HistoryPane, LibraryPane, SpacesPane } from "./components/panes/workspacePanes";
import { FileContextMenu } from "./components/tree/FileContextMenu";
import { FileTree, FileTreeLoadingState } from "./components/tree/FileTree";
import type { WorkspaceUiFixture } from "./fixtures/workspace-fixture";
import { usePaneResize } from "./hooks/usePaneResize";
import { useChatActivity } from "./hooks/useChatActivity";
import { useRestrictedApps } from "./hooks/useRestrictedApps";
import { useSurfaceTabs } from "./hooks/useSurfaceTabs";
import { useWorkspaceTree } from "./hooks/useWorkspaceTree";
import { api, apiForm, apiUrl, errorText } from "./lib/api";
import { chatActivityKey, conversationLifecycleView } from "./lib/chat-lifecycle";
import { chatContextRequestForTab } from "./lib/chat-context-request";
import { contributedSurfaces, resolveSurfaceForKey, surfaceMatchesTab } from "./lib/capability-surfaces";
import { canOpenDirectly, hasNativeFiles, hasWorkspacePathDrag, nativeOpenLabel } from "./lib/file-actions";
import { formatItemCount } from "./lib/format";
import { readStoredJsonValue, readStoredValue, writeStoredJsonValue, writeStoredValue } from "./lib/storage";
import { isMacOS, typographyFontForPlatform, workspaceEntryNativePath } from "./lib/platform";
import { resolveRestrictedAppOpenRequest, restrictedAppRailMode } from "./lib/restricted-app-navigation";
import { getLocalAppStudio, getLocalAppWorkspaceRemovalImpact } from "./lib/restricted-apps";
import { collectLoadedFileEntries, findTreeEntry, isInsideFolder, moveTreeEntry, removeTreeEntries } from "./lib/tree";
import { normalizeWorkspaceCustomizations } from "./lib/workspace-customization";
import { workspaceIdentityFor, workspaceIdentityStyle } from "./lib/workspace-identity";
import { removeWorkspaceConfirmText, surfacePanelDomId, surfaceTabDomId, workspaceHeaderSourceBadgeLabel } from "./lib/workspace-ui";
import type { AgentCatalog, AgentExtensionSurface, AppTheme, AppThemePreference, AppTypographyFont, AppTypographyPreference, BootstrapResponse, ChatActionsState, ChatContextPathRequest, ConversationSummary, DesktopUpdateStatus, FileContextMenuState, RestrictedAppInstalled, TreeEntry, WorkspaceCustomizationMap, WorkspaceCustomizationPatch, WorkspacePane, WorkspaceRailMode, WorkspaceSummary } from "./types";
import { ConfirmDialogHost, requestConfirm, showToast, ToastHost } from "./ui/feedback";
import { workspaceIconOptions } from "./workspace-icons";

const fixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "workspace";
const supportedWorkspaceIconNames = new Set(workspaceIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])]));

interface DroppedUploadFile { file: File; relativePath: string }
type DesktopActionCommand = "new-chat" | "reload-workspace-state" | "open-capabilities" | "open-skills" | "open-extensions" | "open-command-palette";
interface PendingDelete {
  workspaceId: string;
  path: string;
  name: string;
  selectedPath: string | null;
  deletedTabPaths: Set<string>;
}

export function App() {
  const [theme, themePreference, setThemePreference] = useThemePreference();
  const [typography, setTypography] = useTypographyPreference();
  const [fixture, setFixture] = useState<WorkspaceUiFixture | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => localStorage.getItem("workspace.active") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>("appearance");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const keyboardShortcutsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [desktopAction, setDesktopAction] = useState<{ id: number; command: DesktopActionCommand } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const showDesktopTitleBar = window.workspaceDesktop?.app.platform === "win32";

  const openKeyboardShortcuts = useCallback(() => {
    keyboardShortcutsReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShortcutsOpen(true);
  }, []);
  const closeKeyboardShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    const returnFocus = keyboardShortcutsReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
  }, []);
  const openSettings = useCallback((page: SettingsPage = "appearance") => {
    setSettingsInitialPage(page);
    setSettingsOpen(true);
  }, []);

  useScrollbarActivity();
  useDesktopAccentColor();

  const refreshBootstrap = useCallback(async () => {
    if (fixtureRequested) return;
    try {
      const result = await api<BootstrapResponse>("/api/bootstrap");
      setBoot(result);
      setActiveWorkspaceId((current) => result.workspaces.some((item) => item.id === current) ? current : result.workspaces[0]?.id ?? "");
    } catch (caught) { setError(errorText(caught)); }
  }, []);

  useEffect(() => {
    if (fixtureRequested) {
      void import("./fixtures/workspace-fixture").then(({ buildWorkspaceFixture }) => {
        const next = buildWorkspaceFixture(); setFixture(next); setBoot({ workspaces: next.workspaces, agent: next.agent }); setActiveWorkspaceId(next.activeWorkspaceId);
      }).catch((caught) => setError(errorText(caught)));
      return;
    }
    void refreshBootstrap();
  }, [refreshBootstrap]);

  const activeWorkspace = useMemo(() => boot?.workspaces.find((item) => item.id === activeWorkspaceId) ?? boot?.workspaces[0] ?? null, [activeWorkspaceId, boot]);
  useEffect(() => { if (activeWorkspace) { if (!fixtureRequested) localStorage.setItem("workspace.active", activeWorkspace.id); setActiveWorkspaceId(activeWorkspace.id); } }, [activeWorkspace?.id]);
  useEffect(() => {
    if (fixtureRequested) return;
    void window.workspaceDesktop?.workspace.setActiveSpace?.(activeWorkspace?.id ?? null).catch((caught) => setError(errorText(caught)));
  }, [activeWorkspace?.id, activeWorkspace?.name, activeWorkspace?.rootPath]);
  useEffect(() => {
    const desktopWorkspace = window.workspaceDesktop?.workspace;
    if (!desktopWorkspace?.onOpenSpace || !boot) return;
    return desktopWorkspace.onOpenSpace((workspaceId) => {
      if (boot.workspaces.some((workspace) => workspace.id === workspaceId)) setActiveWorkspaceId(workspaceId);
    });
  }, [boot?.workspaces]);
  useEffect(() => {
    const updates = window.workspaceDesktop?.updates;
    if (!updates) return;
    let cancelled = false;
    void updates.getStatus().then((status) => { if (!cancelled) setUpdateStatus(status); }).catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const unsubscribe = updates.onStatusChanged((status) => { if (!cancelled) setUpdateStatus(status); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  useEffect(() => {
    const menu = window.workspaceDesktop?.menu;
    if (!menu) return;
    menu.setState({ spaceOpen: Boolean(activeWorkspace) });
    return menu.onCommand((command) => {
      if (command === "new-space") setCreateSpaceOpen(true);
      else if (command === "open-local-folder") void openFolder();
      else if (command === "check-for-updates") void checkForUpdates();
      else if (command === "open-settings") openSettings();
      else if (command === "open-about") openSettings("about");
      else if (command === "open-keyboard-shortcuts") openKeyboardShortcuts();
      else if (command === "new-chat" || command === "reload-workspace-state" || command === "open-capabilities" || command === "open-skills" || command === "open-extensions" || command === "open-command-palette") {
        setDesktopAction({ id: Date.now(), command });
      }
    });
  }, [activeWorkspace?.id, openKeyboardShortcuts, openSettings, refreshBootstrap]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "/" || event.code === "Slash")) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        openKeyboardShortcuts();
      }
    }
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [openKeyboardShortcuts]);
  useEffect(() => {
    const unsubscribe = window.workspaceDesktop?.runtime.onRendererRecovered?.(() => {
      showToast({ text: "Workspace recovered from a problem and reloaded.", tone: "info" });
    });
    return unsubscribe;
  }, []);
  useEffect(() => window.workspaceDesktop?.agent.onOpenSettings(() => openSettings("assistant")), [openSettings]);

  async function createSpace(name: string) {
    if (fixtureRequested) { setCreateSpaceOpen(false); showToast({ text: "Space creation is disabled in the preview", tone: "info" }); return; }
    const result = await api<{ workspace: WorkspaceSummary }>("/api/workspaces", { method: "POST", body: { name } });
    await refreshBootstrap(); setActiveWorkspaceId(result.workspace.id); setCreateSpaceOpen(false);
  }

  async function openFolder() {
    const picker = window.workspaceDesktop?.workspace;
    if (!picker) return setError("Folder selection is available in the desktop app.");
    try {
      const selected = await picker.chooseFolder(); if (!selected) return;
      const result = await api<{ workspace: WorkspaceSummary }>("/api/workspaces/local-folder", { method: "POST", body: { rootPath: selected.path, folderGrantId: selected.folderGrantId } });
      await refreshBootstrap(); setActiveWorkspaceId(result.workspace.id);
    } catch (caught) { setError(errorText(caught)); }
  }

  async function checkForUpdates() {
    try { const status = await window.workspaceDesktop?.updates.check(); if (status) setUpdateStatus(status); } catch (caught) { setError(errorText(caught)); }
  }

  async function runUpdateAction() {
    const updates = window.workspaceDesktop?.updates;
    if (!updates) return;
    try {
      const status = updateStatus?.phase === "ready"
        ? await updates.install()
        : updateStatus?.phase === "available" || updateStatus?.phase === "error"
          ? await updates.updateNow()
          : await updates.check();
      setUpdateStatus(status);
    } catch (caught) { setError(errorText(caught)); }
  }

  if (!boot || (fixtureRequested && !fixture)) return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>{showDesktopTitleBar ? <DesktopTitleBar /> : null}<CenteredState icon={<Loader2 className="spin" size={28} />} title={`Opening ${productName}`} text={error ?? "Loading your Spaces and Assistant."} /></div>;

  return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>
    {showDesktopTitleBar ? <DesktopTitleBar /> : null}
    {activeWorkspace ? <WorkspaceView workspace={activeWorkspace} workspaces={boot.workspaces} agent={boot.agent} fixture={fixture} desktopAction={desktopAction} updateStatus={updateStatus} themePreference={themePreference} onThemePreferenceChange={setThemePreference} onUpdateAction={() => void runUpdateAction()} onSwitchWorkspace={(workspace) => setActiveWorkspaceId(workspace.id)} onRefreshBootstrap={refreshBootstrap} onCreateSpace={() => setCreateSpaceOpen(true)} onOpenFolder={() => void openFolder()} onOpenSettings={openSettings} onOpenShortcuts={openKeyboardShortcuts} onError={setError} /> : <OnboardingFlow onCreateSpace={() => setCreateSpaceOpen(true)} onOpenFolder={() => void openFolder()} />}
    {error ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    {createSpaceOpen ? <CreateSpaceModal onClose={() => setCreateSpaceOpen(false)} onCreate={createSpace} /> : null}
    {settingsOpen ? <DesktopSettingsModal theme={theme} themePreference={themePreference} onThemePreferenceChange={setThemePreference} typography={typography} onTypographyChange={setTypography} workspace={activeWorkspace} agentStatus={boot.agent} fixtureMode={Boolean(fixture)} initialPage={settingsInitialPage} onAgentConfigured={(agent) => setBoot((current) => current ? { ...current, agent } : current)} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onClose={() => setSettingsOpen(false)} /> : null}
    {shortcutsOpen ? <KeyboardShortcutsModal onClose={closeKeyboardShortcuts} /> : null}
    <ConfirmDialogHost /><ToastHost />
  </div>;
}

function WorkspaceView({ workspace, workspaces, agent, fixture, desktopAction, updateStatus, themePreference, onThemePreferenceChange, onUpdateAction, onSwitchWorkspace, onRefreshBootstrap, onCreateSpace, onOpenFolder, onOpenSettings, onOpenShortcuts, onError }: {
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  agent: BootstrapResponse["agent"];
  fixture: WorkspaceUiFixture | null;
  desktopAction: { id: number; command: DesktopActionCommand } | null;
  updateStatus: DesktopUpdateStatus | null;
  themePreference: AppThemePreference;
  onThemePreferenceChange: (theme: AppThemePreference) => void;
  onUpdateAction: () => void;
  onSwitchWorkspace: (workspace: WorkspaceSummary) => void;
  onRefreshBootstrap: () => Promise<void>;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onOpenSettings: (page?: SettingsPage) => void;
  onOpenShortcuts: () => void;
  onError: (message: string | null) => void;
}) {
  const [activeMode, setActiveMode] = useState<WorkspaceRailMode>(() => fixture ? "files" : normalizeMode(localStorage.getItem("workspace.mode")));
  const [customizations, setCustomizations] = useState<WorkspaceCustomizationMap>(() => fixture ? fixture.customizations : readStoredJsonValue(workspaceCustomizationStorageKey, (value) => normalizeWorkspaceCustomizations(value, undefined, supportedWorkspaceIconNames), {}));
  const customizationsRef = useRef(customizations);
  const appearanceStorageWarningShownRef = useRef(false);
  customizationsRef.current = customizations;
  const [conversationGroups, setConversationGroups] = useState<Record<string, ConversationSummary[]>>(() => fixture ? fixtureConversationGroups(fixture) : {});
  const [surfaceCatalogs, setSurfaceCatalogs] = useState<Record<string, AgentExtensionSurface[]>>(() => fixture ? fixture.surfaces : {});
  const surfaceCatalogRequestRef = useRef(0);
  const chatActivity = useChatActivity(Boolean(fixture));
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [renameEntryRequest, setRenameEntryRequest] = useState<{ path: string; name: string } | null>(null);
  const [chatActions, setChatActions] = useState<ChatActionsState | null>(null);
  const [versionHistory, setVersionHistory] = useState<{ workspace: WorkspaceSummary; path: string; name: string } | null>(null);
  const [contextRequest, setContextRequest] = useState<ChatContextPathRequest | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [historyRefreshRequest, setHistoryRefreshRequest] = useState(0);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const contextRequestId = useRef(0);
  const pendingDeletesRef = useRef(new Map<string, PendingDelete>());
  const activeWorkspaceIdRef = useRef(workspace.id);
  activeWorkspaceIdRef.current = workspace.id;
  const tree = useWorkspaceTree(workspace, onError, fixture?.trees[workspace.id]);
  const selectedPathRef = useRef(tree.selectedPath);
  selectedPathRef.current = tree.selectedPath;
  const paneResize = usePaneResize(Boolean(fixture));
  const tabs = useSurfaceTabs({ workspace, workspaces, fixtureMode: Boolean(fixture), onSwitchWorkspace });
  const handleRestrictedAppError = useCallback((caught: unknown) => onError(errorText(caught)), [onError]);
  const restrictedAppsState = useRestrictedApps({
    activeWorkspaceId: workspace.id,
    fixtureMode: Boolean(fixture),
    onError: handleRestrictedAppError,
  });
  const activeTab = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId) ?? null;
  const identity = workspaceIdentityFor(workspace, customizations);
  const surfaceCatalogKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, workspace.id);
  const restrictedAppCatalogKnown = restrictedAppsState.knownWorkspaceIds.has(workspace.id);
  const restrictedApps = restrictedAppsState.appsByWorkspace[workspace.id] ?? [];
  const surfaces = useMemo(() => contributedSurfaces(workspace.id, surfaceCatalogs[workspace.id] ?? []), [surfaceCatalogs, workspace.id]);
  const activeSurfaceKey = extensionSurfaceIdForMode(activeMode);
  const activeSurface = activeSurfaceKey ? resolveSurfaceForKey(surfaces, activeSurfaceKey) : null;
  const activeRestrictedApp = restrictedApps.find((app) => restrictedAppRailMode(workspace.id, app.manifest.id) === activeMode) ?? null;
  const previewLocalFile = useCallback((path: string) => {
    const previewFile = window.workspaceDesktop?.workspace.previewFile;
    if (!isMacOS() || !previewFile) return;
    void previewFile(workspace.id, path).catch((caught) => onError(errorText(caught)));
  }, [onError, workspace.id]);

  const openCommandPalette = useCallback(() => {
    if (commandPaletteBlockedByDialog()) return;
    commandPaletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandPaletteOpen(true);
  }, []);
  const closeCommandPalette = useCallback((options: { restoreFocus?: boolean } = {}) => {
    setCommandPaletteOpen(false);
    if (options.restoreFocus === false) return;
    const returnFocus = commandPaletteReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus(); });
  }, []);


  useEffect(() => { if (!fixture) localStorage.setItem("workspace.mode", activeMode); }, [activeMode, fixture]);
  useEffect(() => { setActiveMode((current) => current === "workspaces" ? "files" : current); }, [workspace.id]);
  useEffect(() => {
    if (!isMacOS() || !window.workspaceDesktop?.workspace.previewFile) return;
    function previewSelectedFile(event: KeyboardEvent) {
      if (!isQuickLookShortcut(event) || activeMode !== "files") return;
      const path = selectedPathRef.current;
      if (!path || findTreeEntry(tree.tree, path)?.kind !== "file") return;
      event.preventDefault();
      previewLocalFile(path);
    }
    window.addEventListener("keydown", previewSelectedFile);
    return () => window.removeEventListener("keydown", previewSelectedFile);
  }, [activeMode, previewLocalFile, tree.tree]);
  useEffect(() => {
    if (!activeMode.startsWith("app:restricted:") || !restrictedAppCatalogKnown || activeRestrictedApp) return;
    setActiveMode("files");
  }, [activeMode, activeRestrictedApp, restrictedAppCatalogKnown]);
  useEffect(() => {
    const desktop = window.workspaceDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onTabCommand((command) => {
      const installed = restrictedAppsState.appsByWorkspace[command.workspaceId]?.find((app) => (
        app.manifest.id === command.appId && app.digest === command.digest
      ));
      const targetWorkspace = workspaces.find((item) => item.id === command.workspaceId);
      if (!installed || !targetWorkspace) return;
      if (command.type === "open" && command.tab) {
        tabs.openRestrictedAppSurfaceTab(targetWorkspace, { appId: command.appId, digest: command.digest }, command.tab);
      } else if (command.type === "update" && command.tab) {
        tabs.updateRestrictedAppSurfaceTab(command.workspaceId, { appId: command.appId, digest: command.digest }, command.tab);
      } else if (command.type === "close" && command.sourceAppTabId) {
        tabs.closeRestrictedAppSurfaceTab(command.workspaceId, command.appId, command.digest, command.sourceAppTabId);
      }
    });
  }, [restrictedAppsState.appsByWorkspace, tabs, workspaces]);
  useEffect(() => {
    const desktop = window.workspaceDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onOpenRequest((request) => {
      const target = resolveRestrictedAppOpenRequest(request, workspaces);
      if (!target) return;
      if (target.workspace.id !== workspace.id) onSwitchWorkspace(target.workspace);
      setActiveMode(target.mode);
    });
  }, [onSwitchWorkspace, workspace.id, workspaces]);
  useEffect(() => {
    // A temporarily missing or moved folder is not the same thing as an
    // explicit Space removal. Keep appearance keyed by the portable Space id
    // so relinking that folder restores its identity on this computer.
    const next = normalizeWorkspaceCustomizations(customizationsRef.current, undefined, supportedWorkspaceIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) persistWorkspaceCustomizations(next);
  }, [workspaces.map((item) => item.id).join("|")]);
  useEffect(() => { if (fixture) { setConversationGroups(fixtureConversationGroups(fixture)); return; } void loadConversationGroups(); }, [fixture, workspaces.map((item) => item.id).join("|")]);
  useEffect(() => {
    if (fixture) {
      setSurfaceCatalogs(fixture.surfaces);
      return;
    }
    const requestId = ++surfaceCatalogRequestRef.current;
    void api<AgentCatalog>(`/api/workspaces/${workspace.id}/agent/catalog`).then((catalog) => {
      if (surfaceCatalogRequestRef.current !== requestId) return;
      setSurfaceCatalogs((current) => ({ ...current, [workspace.id]: catalog.surfaces ?? [] }));
    }).catch((caught) => {
      if (surfaceCatalogRequestRef.current === requestId) onError(errorText(caught));
    });
  }, [fixture, workspace.id]);
  useEffect(() => {
    if (!surfaceCatalogKnown || !restrictedAppCatalogKnown || !activeSurfaceKey || activeSurface) return;
    setActiveMode("files");
  }, [activeSurface, activeSurfaceKey, restrictedAppCatalogKnown, surfaceCatalogKnown, workspace.id]);
  useEffect(() => { tabs.syncSurfaceTabConversationTitles(conversationGroups); }, [conversationGroups]);
  useEffect(() => {
    function closeMenus(event: PointerEvent) { if (event.target instanceof Element && event.target.closest(".context-menu")) return; setFileContextMenu(null); }
    document.addEventListener("pointerdown", closeMenus); return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);
  useEffect(() => {
    if (!desktopAction) return;
    if (desktopAction.command === "new-chat") openChat(workspace, null);
    else if (desktopAction.command === "reload-workspace-state") void refreshWorkspaceState();
    else if (desktopAction.command === "open-capabilities" || desktopAction.command === "open-skills" || desktopAction.command === "open-extensions") tabs.openAssistantToolsSurfaceTab(workspace, "installed");
    else if (desktopAction.command === "open-command-palette") openCommandPalette();
  }, [desktopAction?.id, openCommandPalette]);
  useEffect(() => {
    const flushBeforeUnload = () => flushAllPendingDeletes(true);
    window.addEventListener("beforeunload", flushBeforeUnload);
    window.addEventListener("pagehide", flushBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);
      window.removeEventListener("pagehide", flushBeforeUnload);
      flushBeforeUnload();
    };
  }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (isCommandPaletteShortcut(event)) {
        if (commandPaletteOpen) {
          event.preventDefault();
          closeCommandPalette();
          return;
        }
        if (commandPaletteBlockedByDialog()) return;
        event.preventDefault();
        openCommandPalette();
      }
    }
    window.addEventListener("keydown", keydown, true); return () => window.removeEventListener("keydown", keydown, true);
  }, [closeCommandPalette, commandPaletteOpen, openCommandPalette]);

  async function loadConversationGroups() {
    const pairs = await Promise.all(workspaces.map(async (item) => {
      try { return [item.id, (await api<{ conversations: ConversationSummary[] }>(`/api/workspaces/${item.id}/conversations`)).conversations] as const; }
      catch { return [item.id, []] as const; }
    }));
    setConversationGroups(Object.fromEntries(pairs));
  }

  async function refreshWorkspaceState() {
    if (fixture) {
      showToast({ text: "Preview data is already up to date.", tone: "info" });
      return;
    }
    onError(null);
    await Promise.all([onRefreshBootstrap(), tree.refresh(false), loadConversationGroups()]);
    setHistoryRefreshRequest((current) => current + 1);
    showToast({ text: `${workspace.name} refreshed`, tone: "success" });
  }

  function persistWorkspaceCustomizations(next: WorkspaceCustomizationMap) {
    customizationsRef.current = next;
    setCustomizations(next);
    if (fixture || writeStoredJsonValue(workspaceCustomizationStorageKey, next) || appearanceStorageWarningShownRef.current) return;
    appearanceStorageWarningShownRef.current = true;
    showToast({ text: "This appearance change works for this session, but Workspace could not save it on this computer.", tone: "info" });
  }

  function customizeWorkspace(workspaceId: string, patch: WorkspaceCustomizationPatch) {
    const next = normalizeWorkspaceCustomizations(
      { ...customizationsRef.current, [workspaceId]: { ...(customizationsRef.current[workspaceId] ?? {}), ...patch } },
      new Set(workspaces.map((item) => item.id)),
      supportedWorkspaceIconNames,
    );
    persistWorkspaceCustomizations(next);
  }

  function resetWorkspaceCustomization(workspaceId: string) {
    const next = { ...customizationsRef.current };
    delete next[workspaceId];
    persistWorkspaceCustomizations(next);
    showToast({ text: "Space appearance reset to defaults.", tone: "success" });
  }

  async function renameSpace(target: WorkspaceSummary, name: string) {
    if (fixture) { showToast({ text: "Space rename is disabled in the preview", tone: "info" }); return; }
    try { await api(`/api/workspaces/${target.id}`, { method: "PATCH", body: { name } }); await onRefreshBootstrap(); showToast({ text: `Renamed Space to ${name}`, tone: "success" }); }
    catch (caught) { onError(errorText(caught)); throw caught; }
  }

  async function removeSpace(target: WorkspaceSummary) {
    if (fixture) { showToast({ text: "Space removal is disabled in the preview", tone: "info" }); return; }
    let appStudio;
    let appRemovalImpact;
    try {
      [appStudio, appRemovalImpact] = await Promise.all([
        getLocalAppStudio(target.id),
        getLocalAppWorkspaceRemovalImpact(target.id),
      ]);
    } catch (caught) {
      onError(`Workspace could not verify ${target.name}'s App Studio state. ${errorText(caught)}`);
      return;
    }
    if (appRemovalImpact.activeSourceInstanceCount || appRemovalImpact.activeTargetInstanceCount) {
      onError(`Uninstall every release-backed App sourced by or installed in ${target.name} before removing this Space.`);
      return;
    }
    if (appRemovalImpact.retainedDataCount) {
      onError(`Purge ${target.name}'s retained App data in App Studio before removing this source Space.`);
      return;
    }
    const confirmed = await requestConfirm({ title: target.location.storage === "linked" ? `Remove ${target.name}?` : `Delete ${target.name}?`, body: removeWorkspaceConfirmText(target, {
      ...appStudio,
      incomingPreparedOperationCount: appRemovalImpact.incomingPreparedOperationCount,
    }), confirmLabel: target.location.storage === "linked" ? "Remove Space" : "Delete Space", tone: "danger" });
    if (!confirmed) return;
    try {
      const removal = await api<{ cleanupPending: boolean; deleted: boolean }>(`/api/workspaces/${target.id}`, { method: "DELETE" });
      const nextCustomizations = { ...customizationsRef.current };
      delete nextCustomizations[target.id];
      persistWorkspaceCustomizations(nextCustomizations);
      tabs.removeWorkspaceSurfaceTabs(target.id);
      await onRefreshBootstrap();
      showToast({
        text: removal.cleanupPending
          ? target.location.storage === "managed" && !removal.deleted
            ? `${target.name} was removed. Workspace will retry deleting its managed folder when it next starts.`
            : `${target.name} was removed. Workspace will finish machine-local cleanup when it next starts.`
          : target.location.storage === "linked"
            ? `${target.name} removed. The folder and its files remain on your computer.`
            : `${target.name} and its managed folder were deleted.`,
        tone: removal.cleanupPending ? "info" : "success",
      });
    } catch (caught) { onError(errorText(caught)); }
  }

  function openChat(targetWorkspace: WorkspaceSummary, conversation: ConversationSummary | null) {
    if (conversation) chatActivity.setAttention(chatActivityKey(targetWorkspace.id, conversation.id), false);
    tabs.openChatSurfaceTab(targetWorkspace, conversation);
  }

  function openChatActions(
    targetWorkspace: WorkspaceSummary,
    conversation: ConversationSummary,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget;
    const rect = returnFocusTarget.getBoundingClientRect();
    const invokedFromKeyboard = event.clientX === 0 && event.clientY === 0;
    setChatActions({
      workspace: targetWorkspace,
      conversation,
      x: invokedFromKeyboard ? Math.round(rect.right - 8) : Math.round(event.clientX),
      y: invokedFromKeyboard ? Math.round(rect.bottom + 4) : Math.round(event.clientY),
      returnFocusTarget,
    });
  }
  function attachToChat(path: string) {
    const existing = tabs.surfaceTabs.find((tab) => tab.kind === "chat" && tab.workspaceId === workspace.id && (!tab.conversationId || tab.id === tabs.activeSurfaceTabId));
    const surfaceTabId = existing?.id ?? tabs.openChatSurfaceTab(workspace, null);
    if (existing) tabs.setActiveSurfaceTabId(existing.id);
    setContextRequest({ id: ++contextRequestId.current, path, workspaceId: workspace.id, surfaceTabId });
    showToast({ text: `Attached ${path.split("/").pop() ?? path} to Chat`, tone: "success" });
  }

  async function openContextMenu(entry: TreeEntry, event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget as HTMLElement;
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const popupFileMenu = window.workspaceDesktop?.workspace.popupFileMenu;
    if (isMacOS() && popupFileMenu) {
      setFileContextMenu(null);
      try {
        const command = await popupFileMenu({
          workspaceId: workspace.id,
          path: entry.path,
          kind: entry.kind,
          capabilities: {
            open: entry.kind === "folder" || canOpenDirectly(entry.path),
            attach: entry.kind === "file",
            history: entry.kind === "file",
            upload: entry.kind === "folder",
            rename: Boolean(entry.path),
            delete: Boolean(entry.path),
          },
          point,
        });
        if (command === "open") {
          if (entry.kind === "file") {
            tree.setSelectedPath(entry.path);
            tabs.openFileSurfaceTab(workspace, entry.path);
            await openLocalPath(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
          } else await openLocalPath(entry.path, "open");
        } else if (command === "reveal") await openLocalPath(entry.path, "reveal");
        else if (command === "copy-path") await copyPath(entry.path);
        else if (command === "attach-chat") attachToChat(entry.path);
        else if (command === "version-history") openVersionHistory(workspace, entry.path);
        else if (command === "upload-here") chooseUpload(entry.path);
        else if (command === "rename") renameEntry(entry.path);
        else if (command === "delete") await deleteEntry(entry.path);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setFileContextMenu({ entry, x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 390), returnFocusTarget });
  }
  function openRootContextMenu(event: React.MouseEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("[data-tree-row]")) return; openContextMenu({ name: workspace.name, path: "", kind: "folder" }, event); }

  async function uploadFiles(files: DroppedUploadFile[], targetFolderPath: string) {
    if (!files.length || fixture) return;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    onError(null);
    try {
      await apiForm(`/api/workspaces/${workspace.id}/upload-local-files`, form);
      await tree.refresh();
      showToast({ text: formatItemCount(files.length, "file") + " added", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setUploadingFiles(false); }
  }
  function chooseUpload(targetPath = "") { setUploadTargetPath(targetPath); uploadRef.current?.click(); }

  async function moveEntry(sourcePath: string, targetFolderPath: string) {
    if (fixture || !sourcePath || sourcePath === targetFolderPath || isInsideFolder(targetFolderPath, sourcePath)) return;
    tree.setMovingTreePath(sourcePath);
    try {
      const result = await api<{ moved: { path: string; name: string }; safetyCheckpointId: string }>(`/api/workspaces/${workspace.id}/move-local-entry`, { method: "POST", body: { sourcePath, targetFolderPath } });
      const preview = moveTreeEntry(tree.tree, sourcePath, targetFolderPath);
      tree.setTree(preview.entries);
      tabs.retargetFileSurfaceTabsForMove(workspace.id, sourcePath, result.moved.path);
      showHistorySaved(`Moved ${result.moved.name}`);
    }
    catch (caught) { onError(errorText(caught)); }
    finally { tree.setMovingTreePath(null); }
  }

  async function deleteEntry(path: string) {
    if (!path || fixture) return;
    const entry = findTreeEntry(tree.tree, path);
    if (entry?.kind === "folder") {
      const confirmed = await requestConfirm({ title: `Delete ${entry.name}?`, body: "The folder and everything in it will be removed after the Undo window closes.", confirmLabel: "Delete folder", tone: "danger" });
      if (!confirmed) return;
    }
    const selectedPath = tree.selectedPath && (tree.selectedPath === path || tree.selectedPath.startsWith(`${path}/`)) ? tree.selectedPath : null;
    const deletedTabPaths = new Set(tabs.surfaceTabs.flatMap((tab) => tab.kind === "file" && tab.workspaceId === workspace.id && (tab.path === path || tab.path.startsWith(`${path}/`)) ? [tab.path] : []));
    const pending: PendingDelete = { workspaceId: workspace.id, path, name: entry?.name ?? path, selectedPath, deletedTabPaths };
    pendingDeletesRef.current.set(pendingDeleteKey(pending), pending);
    tree.setTree((current) => removeTreeEntries(current, new Set([path])));
    showToast({ text: `Removed ${pending.name}`, tone: "success", actionLabel: "Undo", durationMs: 6500,
      onAction: () => {
        if (pendingDeletesRef.current.get(pendingDeleteKey(pending)) !== pending) return;
        pendingDeletesRef.current.delete(pendingDeleteKey(pending));
        if (pending.workspaceId !== activeWorkspaceIdRef.current) return;
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        void refreshTreeWithPendingDeletes().then(() => {
          if (pending.workspaceId === activeWorkspaceIdRef.current && pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
        });
      },
      onClose: (reason) => { if (reason !== "action") void commitPendingDelete(pending); },
    });
  }

  function renameEntry(path: string) {
    if (!path) return;
    if (fixture) {
      showToast({ text: "File rename is disabled in the preview", tone: "info" });
      return;
    }
    const entry = findTreeEntry(tree.tree, path);
    setRenameEntryRequest({ path, name: entry?.name ?? path.split("/").pop() ?? path });
  }
  async function submitEntryRename(name: string) {
    if (!renameEntryRequest || name === renameEntryRequest.name) return;
    const result = await api<{ renamed: { path: string }; safetyCheckpointId: string }>(`/api/workspaces/${workspace.id}/rename-local-entry`, {
      method: "POST",
      body: { path: renameEntryRequest.path, newName: name },
    });
    tabs.retargetFileSurfaceTabsForMove(workspace.id, renameEntryRequest.path, result.renamed.path);
    await tree.refresh();
    showHistorySaved(`Renamed ${renameEntryRequest.name}`);
  }

  async function openLocalPath(path: string, action: "reveal" | "open" | "open-native", targetWorkspace = workspace) {
    if (fixture) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const desktop = window.workspaceDesktop;
    try { if (!path) await desktop?.workspace.revealFolder?.(targetWorkspace.id); else if (desktop?.workspace.openPath) await desktop.workspace.openPath(targetWorkspace.id, path, action); else await desktop?.workspace.revealFolder?.(targetWorkspace.id); }
    catch (caught) { onError(errorText(caught)); }
  }
  function openVersionHistory(targetWorkspace: WorkspaceSummary, path: string) {
    if (fixture) { showToast({ text: "Version history is disabled in the preview", tone: "info" }); return; }
    setVersionHistory({ workspace: targetWorkspace, path, name: path.split("/").pop() ?? path });
  }
  async function copyPath(path: string) { const full = workspaceEntryNativePath(workspace.rootPath, path); await navigator.clipboard.writeText(full); showToast({ text: "Path copied", tone: "success" }); }

  function updateDropTarget(event: React.DragEvent<HTMLElement>, target: string) { event.preventDefault(); if (hasNativeFiles(event) || hasWorkspacePathDrag(event)) { event.dataTransfer.dropEffect = hasNativeFiles(event) ? "copy" : "move"; tree.setDropTargetFolderPath(target); } }
  function clearDropTarget(event?: React.DragEvent<HTMLElement>) { if (event && event.currentTarget.contains(event.relatedTarget as Node | null)) return; tree.setDropTargetFolderPath(null); }
  async function dropOnTarget(event: React.DragEvent<HTMLElement>, target: string) {
    event.preventDefault();
    tree.setDropTargetFolderPath(null);
    if (hasNativeFiles(event)) {
      try {
        const files = await collectDroppedUploadFiles(event.dataTransfer);
        if (!files.length) {
          onError("Drop one or more files. Empty folders do not create Space entries.");
          return;
        }
        await uploadFiles(files, target);
      }
      catch (caught) { onError(errorText(caught)); }
      return;
    }
    const source = hasWorkspacePathDrag(event) ? event.dataTransfer.getData(workspacePathDragType) || event.dataTransfer.getData("text/plain") : "";
    if (source) await moveEntry(source, target);
  }
  function startTreeDrag(path: string, event: React.DragEvent<HTMLElement>) { tree.setMovingTreePath(path); event.dataTransfer.setData(workspacePathDragType, path); event.dataTransfer.setData("text/plain", path); event.dataTransfer.effectAllowed = "move"; }
  function endTreeDrag() { tree.setMovingTreePath(null); tree.setDropTargetFolderPath(null); }

  function startNativeFileDrag(path: string, event: React.DragEvent<HTMLElement>) {
    if (!event.altKey || !window.workspaceDesktop?.workspace.startDrag) return false;
    event.preventDefault();
    void window.workspaceDesktop.workspace.startDrag(workspace.id, path).catch((caught) => onError(errorText(caught)));
    return true;
  }

  async function commitPendingDelete(pending: PendingDelete) {
    const key = pendingDeleteKey(pending);
    if (pendingDeletesRef.current.get(key) !== pending) return;
    pendingDeletesRef.current.delete(key);
    try {
      await deleteLocalFileRequest(pending);
      tabs.closeFileSurfaceTabsForDeletedPaths(pending.workspaceId, pending.deletedTabPaths);
    } catch (caught) {
      onError(errorText(caught));
      if (pending.workspaceId === activeWorkspaceIdRef.current) {
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        await refreshTreeWithPendingDeletes();
        if (pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
      }
    }
  }

  function flushAllPendingDeletes(keepalive = false) {
    for (const pending of [...pendingDeletesRef.current.values()]) {
      if (!keepalive) {
        void commitPendingDelete(pending);
        continue;
      }
      const key = pendingDeleteKey(pending);
      if (pendingDeletesRef.current.get(key) !== pending) continue;
      pendingDeletesRef.current.delete(key);
      void deleteLocalFileRequest(pending, true).catch(() => {});
    }
  }

  async function refreshTreeWithPendingDeletes() {
    await tree.refresh();
    const pendingPaths = new Set([...pendingDeletesRef.current.values()].filter((item) => item.workspaceId === workspace.id).map((item) => item.path));
    if (pendingPaths.size) tree.setTree((current) => removeTreeEntries(current, pendingPaths));
  }

  function showHistorySaved(text: string) {
    showToast({ text: `${text}. Restore point saved in History.`, tone: "success" });
  }

  async function saveRestorePoint() {
    if (fixture) return;
    try {
      await api(`/api/workspaces/${workspace.id}/history/checkpoints`, { method: "POST", body: { label: "Manual restore point" } });
      setHistoryRefreshRequest((current) => current + 1);
      setActiveMode("history");
      showToast({ text: "Restore point saved", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
  }

  async function renameChat(targetWorkspace: WorkspaceSummary, conversation: ConversationSummary, title: string) {
    if (fixture) { const updated = { ...conversation, title }; replaceConversationSummary(targetWorkspace.id, updated); tabs.updateSurfaceTabConversationTitle(targetWorkspace.id, updated); return; }
    const result = await api<{ conversation: ConversationSummary }>(`/api/workspaces/${targetWorkspace.id}/conversations/${conversation.id}`, { method: "PATCH", body: { title } });
    replaceConversationSummary(targetWorkspace.id, result.conversation);
    tabs.updateSurfaceTabConversationTitle(targetWorkspace.id, result.conversation);
  }

  function replaceConversationSummary(workspaceId: string, conversation: ConversationSummary): void {
    setConversationGroups((current) => ({
      ...current,
      [workspaceId]: (current[workspaceId] ?? []).map((item) => item.id === conversation.id ? conversation : item),
    }));
  }

  async function updateChatLifecycle(
    targetWorkspace: WorkspaceSummary,
    conversation: ConversationSummary,
    patch: { archived?: boolean; snoozedUntil?: string | null },
    options: { announce?: boolean } = {},
  ): Promise<ConversationSummary> {
    const previous = conversation;
    const updated = fixture
      ? applyFixtureChatLifecycle(conversation, patch)
      : (await api<{ conversation: ConversationSummary }>(
          `/api/workspaces/${targetWorkspace.id}/conversations/${conversation.id}`,
          { method: "PATCH", body: patch },
        )).conversation;
    replaceConversationSummary(targetWorkspace.id, updated);

    const lifecycle = conversationLifecycleView(updated);
    const openTab = tabs.surfaceTabs.find((tab) =>
      tab.kind === "chat"
      && tab.workspaceId === targetWorkspace.id
      && tab.conversationId === conversation.id);
    if (lifecycle !== "active") {
      if (openTab) tabs.closeSurfaceTab(openTab.id);
      chatActivity.setRunning(chatActivityKey(targetWorkspace.id, conversation.id), false);
      chatActivity.setAttention(chatActivityKey(targetWorkspace.id, conversation.id), false);
    }
    if (options.announce === false) return updated;

    const feedback = chatLifecycleFeedback(previous, updated);
    showToast({
      text: feedback.text,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: () => {
        const latest = (conversationGroups[targetWorkspace.id] ?? []).find((item) => item.id === conversation.id) ?? updated;
        void updateChatLifecycle(targetWorkspace, latest, feedback.undo, { announce: false })
          .then((restored) => { if (openTab) openChat(targetWorkspace, restored); })
          .catch((caught) => onError(errorText(caught)));
      },
    });
    return updated;
  }

  function selectRailMode(mode: WorkspaceRailMode): void {
    setActiveMode(mode);
    if (mode.startsWith("app:restricted:")) return;
    const surfaceKey = extensionSurfaceIdForMode(mode);
    if (!surfaceKey) return;
    const surface = resolveSurfaceForKey(surfaces, surfaceKey);
    const firstView = surface?.views[0];
    if (!surface || !firstView) return;
    const activeMatches = activeTab?.kind === "extension" && surfaceMatchesTab(surface, activeTab);
    if (!activeMatches) tabs.openExtensionSurfaceTab(workspace, surface, firstView);
  }

  function openInstalledRestrictedApp(targetWorkspace: WorkspaceSummary, app: RestrictedAppInstalled): void {
    restrictedAppsState.upsertApp(app);
    if (targetWorkspace.id !== workspace.id) onSwitchWorkspace(targetWorkspace);
    setActiveMode(restrictedAppRailMode(targetWorkspace.id, app.manifest.id));
  }

  function updateSurfaceCatalog(targetWorkspaceId: string, catalog: AgentCatalog): void {
    setSurfaceCatalogs((current) => ({ ...current, [targetWorkspaceId]: catalog.surfaces ?? [] }));
  }

  const commands = useMemo<CommandPaletteCommand[]>(() => [
    ...(["files", "chats", "library", "history"] as WorkspacePane[]).map((mode) => ({ id: `go:${mode}`, groupId: "go-to" as const, groupLabel: "Go to", label: mode[0]!.toUpperCase() + mode.slice(1), defaultVisible: true, run: () => selectRailMode(mode) })),
    { id: "go:assistant-tools", groupId: "go-to" as const, groupLabel: "Go to", label: "Assistant tools", detail: "Installed Skills, Extensions, and apps", defaultVisible: true, run: () => tabs.openAssistantToolsSurfaceTab(workspace, "installed") },
    { id: "action:discover-assistant-tools", groupId: "actions" as const, groupLabel: "Actions", label: "Browse Skills & Extensions", keywords: ["capabilities", "discover", "install", "tools"], run: () => tabs.openAssistantToolsSurfaceTab(workspace, "discover") },
    ...surfaces.map((surface) => ({ id: `app:${surface.key}`, groupId: "go-to" as const, groupLabel: "Go to", label: surface.title, detail: surface.scope === "project" ? "Pi Extension · This Space" : "Pi Extension · Personal", run: () => selectRailMode(`app:${surface.key}`) })),
    ...restrictedApps.map((app) => ({ id: `restricted-app:${app.manifest.id}`, groupId: "go-to" as const, groupLabel: "Go to", label: app.manifest.title, detail: "Sandboxed app · This Space", run: () => selectRailMode(restrictedAppRailMode(workspace.id, app.manifest.id)) })),
    ...workspaces.map((item) => ({ id: `space:${item.id}`, groupId: "switch-workspace" as const, groupLabel: "Switch Space", label: item.name, detail: workspaceHeaderSourceBadgeLabel(item), matchTargets: [item.rootPath], run: () => onSwitchWorkspace(item) })),
    ...Object.entries(conversationGroups).flatMap(([workspaceId, conversations]) => conversations.map((conversation) => {
      const lifecycle = conversationLifecycleView(conversation);
      return {
        id: `chat:${workspaceId}:${conversation.id}`,
        groupId: "chats" as const,
        groupLabel: "Chats",
        label: conversation.title,
        detail: lifecycle === "archived" ? "Archived" : lifecycle === "snoozed" ? "Snoozed" : undefined,
        run: () => { const target = workspaces.find((item) => item.id === workspaceId); if (target) openChat(target, conversation); },
      };
    })),
    ...collectLoadedFileEntries(tree.tree).flatMap((entry) => {
      const matchTargets = [entry.name, entry.path];
      return [
        { id: `reveal-file:${workspace.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Reveal in Files: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => { setActiveMode("files"); tree.setSelectedPath(entry.path); tabs.openFileSurfaceTab(workspace, entry.path); } },
        { id: `attach-file:${workspace.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Attach to Chat: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => attachToChat(entry.path) },
      ];
    }),
    { id: "action:new-chat", groupId: "actions", groupLabel: "Actions", label: "New Chat", keywords: ["chat", "conversation", "assistant"], defaultVisible: true, run: () => openChat(workspace, null) },
    ...(!fixture ? [{ id: "action:save-restore-point", groupId: "actions" as const, groupLabel: "Actions", label: "Save restore point", keywords: ["history", "checkpoint", "backup"], defaultVisible: true, run: () => { void saveRestorePoint(); } }] : []),
    { id: "action:new-space", groupId: "actions", groupLabel: "Actions", label: "Create a new Space", defaultVisible: true, run: onCreateSpace },
    { id: "action:open-folder", groupId: "actions", groupLabel: "Actions", label: "Turn a folder into a Space", defaultVisible: true, run: onOpenFolder },
    { id: "action:settings", groupId: "actions", groupLabel: "Actions", label: "Settings", defaultVisible: true, run: onOpenSettings },
    { id: "action:shortcuts", groupId: "actions", groupLabel: "Actions", label: "Keyboard shortcuts", run: onOpenShortcuts },
    ...(["light", "dark", "system"] as AppThemePreference[]).map((preference) => ({ id: `theme:${preference}`, groupId: "actions" as const, groupLabel: "Actions", label: preference === "system" ? "Use device theme" : `Use ${preference} theme`, detail: themePreference === preference ? "Current" : undefined, keywords: ["appearance", "color", "mode"], run: () => onThemePreferenceChange(preference) })),
  ], [conversationGroups, fixture, restrictedApps, surfaces, themePreference, tree.selectedPath, tree.tree, workspaces, workspace.id]);

  const layoutStyle = { ...(workspaceIdentityStyle(identity)), ...(paneResize.sidebarWidth ? { "--workspace-sidebar-width": `${paneResize.sidebarWidth}px` } : {}) } as CSSProperties;

  return <main className={paneResize.sidebarResizing ? "workspace-layout resizing" : "workspace-layout"} ref={paneResize.workspaceLayoutRef} style={layoutStyle}>
    <WorkspaceModeRail activeMode={activeMode} workspace={workspace} workspaceIdentity={identity} surfaces={surfaces} apps={restrictedApps} onModeChange={selectRailMode} onOpenAssistantTools={(view) => tabs.openAssistantToolsSurfaceTab(workspace, view)} onBuildApp={() => openChat(workspace, null)} accountControl={<button className="workspace-rail-account-button" type="button" onClick={() => onOpenSettings()} aria-label="Settings" data-rail-tooltip="Settings"><Settings24Regular aria-hidden="true" /></button>} onOpenKeyboardShortcuts={onOpenShortcuts} updateControl={updateStatus && updateNeedsAttention(updateStatus) ? <DesktopUpdateButton status={updateStatus} onClick={onUpdateAction} /> : undefined} />
    <section className={`workspace-mode-pane workspace-mode-pane-${activeMode}`} id="workspace-file-panel">
      <WorkspacePaneHeader workspace={workspace} identity={identity} workspaces={workspaces} workspaceCustomizations={customizations} onSwitchWorkspace={onSwitchWorkspace} switchable={activeMode !== "workspaces"} action={activeMode === "files" ? <button className="minimal-icon-button" type="button" disabled={uploadingFiles || tree.status === "refreshing"} onClick={() => void tree.refresh(false)} aria-label="Refresh files" title="Refresh files"><ArrowSync16Regular className={tree.status === "refreshing" ? "spin" : undefined} /></button> : undefined} />
      {activeMode === "workspaces" ? <SpacesPane workspace={workspace} workspaces={workspaces} identities={customizations} onSwitch={onSwitchWorkspace} onCreate={onCreateSpace} onOpenFolder={onOpenFolder} onCustomize={(target) => tabs.openAppearanceSurfaceTab(target)} onRename={renameSpace} onRemove={(target) => void removeSpace(target)} /> : null}
      {activeMode === "files" ? <div className="local-files-panel">
        <input
          ref={uploadRef}
          className="hidden-file-input"
          type="file"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
            event.target.value = "";
            void uploadFiles(files, uploadTargetPath);
          }}
        />
        <div className="file-tree-toolbar">
          <label className="file-tree-search">
            <Search size={15} />
            <input
              aria-label="Search files"
              type="search"
              placeholder="Search files"
              value={tree.query}
              onChange={(event) => tree.setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && tree.query) {
                  event.preventDefault();
                  tree.setQuery("");
                }
              }}
            />
            {tree.query ? <button type="button" onClick={() => tree.setQuery("")} aria-label="Clear file search" title="Clear file search"><X size={14} /></button> : null}
          </label>
          {tree.query ? <span className="file-tree-search-count">{tree.searchHydrating ? "Searching" : formatItemCount(tree.matchCount, "match", "matches")}</span> : null}
          {tree.treeTruncated ? <span className="file-tree-truncated" title="This Space holds more items than Files lists at once. Open a folder to see its contents, or search by name or contents.">Partial list</span> : null}
          <button className="minimal-icon-button" type="button" disabled={uploadingFiles} onClick={() => chooseUpload("")} aria-label="Add files" title="Add files"><Upload size={15} /></button>
        </div>
        <div
          className={["file-tree-shell", uploadingFiles ? "uploading-files" : "", tree.status === "refreshing" ? "refreshing-files" : "", tree.dropTargetFolderPath === "" ? "root-drop-target" : ""].filter(Boolean).join(" ")}
          onContextMenu={openRootContextMenu}
          onDragEnter={(event) => updateDropTarget(event, "")}
          onDragOver={(event) => updateDropTarget(event, "")}
          onDragLeave={clearDropTarget}
          onDrop={(event) => void dropOnTarget(event, "")}
          onClick={(event) => { if (!(event.target as HTMLElement).closest("[data-tree-row]")) tree.setSelectedPath(null); }}
          onKeyDown={(event) => { if (event.key === "Escape" && tree.selectedPath) { event.preventDefault(); tree.setSelectedPath(null); } }}
        >
          {uploadingFiles ? <div className="file-upload-progress" aria-live="polite"><Loader2 className="spin" size={14} />Adding files</div> : null}
          {tree.status === "refreshing" ? <div className="file-tree-refresh-progress" aria-live="polite"><Loader2 className="spin" size={14} />Updating files</div> : null}
          {tree.status === "loading" ? <FileTreeLoadingState /> : tree.status === "error" ? <EmptyInline text="Couldn't load this Space. Refresh to try again." /> : <FileTree entries={tree.visibleEntries} collapsedPaths={tree.query ? new Set() : tree.collapsedPaths} loadingFolderPaths={tree.loadingFolderPaths} selectedPath={tree.selectedPath} movingTreePath={tree.movingTreePath} dropTargetFolderPath={tree.dropTargetFolderPath} searchQuery={tree.query} emptyText={tree.query ? "No file or folder names match." : undefined} onToggleFolder={tree.toggleFolder} onSelectFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workspace, path); }} onPreviewFile={isMacOS() ? previewLocalFile : undefined} onOpenFile={(path) => void openLocalPath(path, "open")} onOpenContextMenu={openContextMenu} onUpdateDropTarget={updateDropTarget} onDropOnTarget={dropOnTarget} onNativeDragStartFile={startNativeFileDrag} onDragStartEntry={startTreeDrag} onDragEndEntry={endTreeDrag} />}
        </div>
        {fixture ? null : (
          <FileContentSearch
            workspaceId={workspace.id}
            query={tree.query}
            onOpenFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workspace, path); }}
          />
        )}
      </div> : null}
      {activeMode === "chats" ? <ChatsPane workspace={workspace} workspaces={workspaces} conversations={conversationGroups} customizations={customizations} activityStatuses={chatActivity.statuses} activeConversationId={activeTab?.kind === "chat" ? activeTab.conversationId ?? undefined : undefined} onOpen={(target, conversation) => openChat(target, conversation)} onNew={(target) => openChat(target, null)} onActions={openChatActions} /> : null}
      {activeMode === "library" ? <LibraryPane workspace={workspace} fixtureTree={fixture?.library} onError={onError} /> : null}
      {activeMode === "history" ? <HistoryPane workspace={workspace} fixtureItems={fixture?.checkpoints[workspace.id]} refreshRequest={historyRefreshRequest} onOpen={(item) => tabs.openHistorySurfaceTab(workspace, item.checkpointId, item.label || "Restore point")} onError={onError} /> : null}
      {activeSurface ? <ExtensionSurfacePane surface={activeSurface} activeViewId={activeTab?.kind === "extension" && surfaceMatchesTab(activeSurface, activeTab) ? activeTab.viewId : null} onOpenView={(view) => tabs.openExtensionSurfaceTab(workspace, activeSurface, view)} /> : null}
      {activeRestrictedApp ? <RestrictedAppViewport app={activeRestrictedApp} placement="navigator" route="/" active /> : null}
    </section>
    <button className="workspace-resizer" type="button" role="separator" aria-label="Resize the navigation pane and work area" aria-controls="workspace-file-panel workspace-chat-panel" aria-orientation="vertical" aria-valuemin={Math.round(paneResize.sidebarResizeBounds.min)} aria-valuemax={Math.round(paneResize.sidebarResizeBounds.max)} aria-valuenow={paneResize.sidebarResizeValue} title="Resize panes" onPointerDown={paneResize.startSidebarResize} onDoubleClick={paneResize.resetWorkspaceSidebarWidth} onKeyDown={paneResize.handleSidebarResizeKeyDown}><span className="sr-only">Resize panes</span></button>
    <aside className="right-rail" id="workspace-chat-panel">
      <WorkspaceSurfaceTabBar tabs={tabs.surfaceTabs} workspaces={workspaces} workspaceCustomizations={customizations} conversations={conversationGroups} chatActivityStatuses={chatActivity.statuses} activeTabId={tabs.activeSurfaceTabId} newChatWorkspaceId={workspace.id} onActivate={tabs.setActiveSurfaceTabId} onClose={tabs.closeSurfaceTab} onNewChatInWorkspace={(target) => openChat(target, null)} onChatActions={openChatActions} />
      {tabs.surfaceTabs.length ? tabs.surfaceTabs.map((tab) => {
        const targetWorkspace = workspaces.find((item) => item.id === tab.workspaceId);
        if (!targetWorkspace) return null;
        const active = tab.id === tabs.activeSurfaceTabId;
        const targetIdentity = workspaceIdentityFor(targetWorkspace, customizations);
        const targetConversation = tab.kind === "chat" && tab.conversationId
          ? conversationGroups[targetWorkspace.id]?.find((conversation) => conversation.id === tab.conversationId) ?? null
          : null;
        const targetConversationLifecycle = targetConversation ? conversationLifecycleView(targetConversation) : "active";
        return (
          <div className="workspace-surface-body" role="tabpanel" id={surfacePanelDomId(tab.id)} aria-labelledby={surfaceTabDomId(tab.id)} hidden={!active} key={tab.id} style={workspaceIdentityStyle(targetIdentity)}>
            {tab.kind === "file" && tab.path ? (
              <FileDetailsPane workspace={targetWorkspace} path={tab.path} entry={targetWorkspace.id === workspace.id ? findTreeEntry(tree.tree, tab.path) : null} fixtureMode={Boolean(fixture)} onOpenLocal={(path, action) => openLocalPath(path, action, targetWorkspace)} onAddToChatContext={attachToChat} onShowVersionHistory={(path) => openVersionHistory(targetWorkspace, path)} onRename={targetWorkspace.id === workspace.id ? renameEntry : undefined} />
            ) : tab.kind === "assistant-tools" ? (
              <CapabilitiesPane
                workspace={targetWorkspace}
                status={agent}
                view={tab.view}
                fixtureMode={Boolean(fixture)}
                restrictedApps={restrictedAppsState.appsByWorkspace[targetWorkspace.id] ?? []}
                restrictedAppsLoading={restrictedAppsState.loadingWorkspaceIds.has(targetWorkspace.id)}
                onViewChange={(view) => tabs.openAssistantToolsSurfaceTab(targetWorkspace, view)}
                onOpenSettings={() => onOpenSettings("assistant")}
                onError={onError}
                onCatalogChanged={(catalog) => updateSurfaceCatalog(targetWorkspace.id, catalog)}
                onRestrictedAppChanged={restrictedAppsState.upsertApp}
                onRestrictedAppRemoved={(appId) => restrictedAppsState.removeApp(targetWorkspace.id, appId)}
                onBuildApp={() => openChat(targetWorkspace, null)}
                onOpenAppStudio={(sourceWorkspaceId) => tabs.openAppStudioSurfaceTab(workspaces.find((item) => item.id === sourceWorkspaceId) ?? targetWorkspace)}
              />
            ) : tab.kind === "app-studio" ? (
              <AppStudioPane
                workspace={targetWorkspace}
                workspaces={workspaces}
                active={active}
                previewRevision={(restrictedAppsState.appsByWorkspace[targetWorkspace.id] ?? [])
                  .filter((app) => app.runtimeInstanceKind === "development")
                  .map((app) => `${app.featureInstallationId}:${app.digest}:${app.updatedAt}`)
                  .sort()
                  .join("|")}
                fixtureMode={Boolean(fixture)}
                onAppsChanged={(workspaceId, runtimeInstanceId, apps) => {
                  restrictedAppsState.replaceRuntimeInstanceApps(workspaceId, runtimeInstanceId, apps);
                  void restrictedAppsState.refresh(workspaceId);
                }}
                onError={onError}
              />
            ) : tab.kind === "appearance" ? (
              <div className="workspace-appearance-surface professional-appearance-surface">
                <div className="workspace-appearance-surface-heading">
                  <span className="workspace-appearance-surface-icon" aria-hidden="true"><Color20Regular /></span>
                  <div><h2>Customize {targetWorkspace.name}</h2><p>Give this Space a recognizable identity without changing the rest of Workspace.</p></div>
                </div>
                <WorkspaceAppearancePanel workspace={targetWorkspace} identity={targetIdentity} customization={customizations[targetWorkspace.id]} onCustomizeWorkspace={customizeWorkspace} onResetWorkspace={resetWorkspaceCustomization} />
              </div>
            ) : tab.kind === "history" ? (
              <HistoryPane workspace={targetWorkspace} fixtureItems={fixture?.checkpoints[targetWorkspace.id]} refreshRequest={targetWorkspace.id === workspace.id ? historyRefreshRequest : 0} selectedCheckpointId={tab.checkpointId} onOpen={(item) => tabs.openHistorySurfaceTab(targetWorkspace, item.checkpointId, item.label || "Restore point")} onError={onError} />
            ) : tab.kind === "extension" ? (() => {
              const targetSurfaceInventoryKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, targetWorkspace.id);
              if (!targetSurfaceInventoryKnown) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app view" text="Checking the tools installed for this Space." />;
              const targetSurfaces = contributedSurfaces(targetWorkspace.id, surfaceCatalogs[targetWorkspace.id] ?? []);
              const surface = targetSurfaces.find((item) => surfaceMatchesTab(item, tab));
              const view = surface?.views.find((item) => item.id === tab.viewId);
              return surface && view ? <ExtensionSurfaceView surface={surface} view={view} /> : <ExtensionSurfaceUnavailable surfaceId={tab.surfaceId} viewId={tab.viewId} execution={tab.surfaceExecution} />;
            })() : tab.kind === "restricted-app" ? (() => {
              if (!restrictedAppsState.knownWorkspaceIds.has(targetWorkspace.id)) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app" text="Checking the sandboxed apps installed for this Space." />;
              const app = restrictedAppsState.appsByWorkspace[targetWorkspace.id]?.find((item) => item.manifest.id === tab.appId && item.digest === tab.digest);
              return app
                ? <RestrictedAppViewport app={app} placement="tab" appTabId={tab.appTabId} route={tab.route} state={tab.state} active={active} />
                : <CenteredState icon={<AlertTriangle size={24} />} title="App unavailable" text="This tab belongs to an app revision that is no longer installed in this Space." />;
            })() : tab.kind === "chat" ? (
              <ChatPanel surfaceTabId={tab.id} workspace={targetWorkspace} workspaceCustomizations={customizations} active={active} targetConversationId={tab.conversationId ?? null} targetConversationTitle={tab.conversationId ? tab.title : null} lifecycleView={targetConversationLifecycle} onResumeConversation={targetConversation ? () => updateChatLifecycle(targetWorkspace, targetConversation, targetConversationLifecycle === "archived" ? { archived: false } : { snoozedUntil: null }).then(() => {}).catch((caught) => onError(errorText(caught))) : undefined} contextPathRequest={chatContextRequestForTab(contextRequest, targetWorkspace.id, tab.id)} onAddPathToChatContext={active && targetWorkspace.id === workspace.id ? attachToChat : undefined} onOpenWorkspaceFile={active && targetWorkspace.id === workspace.id ? (path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workspace, path); } : undefined} selectedPath={active && targetWorkspace.id === workspace.id ? tree.selectedPath : null} onConversationActivated={(conversation) => tabs.handleTabConversationActivated(tab.id, targetWorkspace, conversation)} onConversationsChanged={(conversations) => setConversationGroups((current) => ({ ...current, [targetWorkspace.id]: conversations }))} onRunningChange={(conversationId, running) => chatActivity.setRunning(chatActivityKey(targetWorkspace.id, conversationId), running)} onSettled={(conversationId, needsAttention) => chatActivity.setAttention(chatActivityKey(targetWorkspace.id, conversationId), needsAttention)} onViewed={(conversationId) => chatActivity.setAttention(chatActivityKey(targetWorkspace.id, conversationId), false)} onAgentFinished={() => targetWorkspace.id === workspace.id ? tree.refresh() : undefined} onRestrictedAppProposalRequested={() => tabs.setActiveSurfaceTabId(tab.id)} onRestrictedAppInstalled={(app) => openInstalledRestrictedApp(targetWorkspace, app)} fixtureMode={Boolean(fixture)} fixtureConversations={fixture && (tab.conversationId || tab.id === `chat:${targetWorkspace.id}:new`) ? fixture.conversations[targetWorkspace.id] : undefined} fixtureTreeEntries={fixture?.trees[targetWorkspace.id]} />
            ) : null}
          </div>
        );
      }) : <WorkspaceSurfaceEmptyState workspace={workspace} identity={identity} onNewChat={() => openChat(workspace, null)} />}
    </aside>
    {fileContextMenu ? <FileContextMenu state={fileContextMenu} onSelect={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workspace, path); }} onOpenLocal={openLocalPath} onAddToChatContext={attachToChat} onCopyPath={copyPath} onShowVersionHistory={(path) => openVersionHistory(workspace, path)} onRename={fileContextMenu.entry.path ? renameEntry : undefined} onUploadHere={chooseUpload} onDelete={deleteEntry} onClose={() => setFileContextMenu(null)} /> : null}
    {renameEntryRequest ? <TextInputModal title={`Rename ${renameEntryRequest.name}`} description="Choose a new name. The item stays in the same folder." label="Name" initialValue={renameEntryRequest.name} confirmLabel="Rename" onSubmit={submitEntryRename} onClose={() => setRenameEntryRequest(null)} /> : null}
    {chatActions ? <ChatActionsPopover state={chatActions} onRename={renameChat} onLifecycle={(target, conversation, patch) => updateChatLifecycle(target, conversation, patch).then(() => {})} onClose={() => setChatActions(null)} /> : null}
    {versionHistory ? <FileVersionHistoryModal workspace={versionHistory.workspace} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void tree.refresh()} /> : null}
    {commandPaletteOpen ? <CommandPaletteHost commands={commands} onClose={closeCommandPalette} /> : null}
  </main>;
}

function WorkspaceSurfaceEmptyState({ workspace, identity, onNewChat }: { workspace: WorkspaceSummary; identity: ReturnType<typeof workspaceIdentityFor>; onNewChat: () => void }) {
  return <div className="workspace-surface-body workspace-surface-body-empty"><div className="workspace-surface-empty" style={workspaceIdentityStyle(identity)}><span className="workspace-surface-empty-icon"><WorkspaceIconGlyph icon={identity.Icon} size={24} /></span><h2>{workspace.name}</h2><p>Open a file, Chat, restore point, or appearance tab here.</p><button className="primary-button" type="button" onClick={onNewChat}><CirclePlus size={16} />New Chat</button></div></div>;
}

function applyFixtureChatLifecycle(
  conversation: ConversationSummary,
  patch: { archived?: boolean; snoozedUntil?: string | null },
): ConversationSummary {
  if (patch.archived !== undefined) {
    return {
      ...conversation,
      archivedAt: patch.archived ? new Date().toISOString() : null,
      snoozedUntil: patch.archived ? null : conversation.snoozedUntil ?? null,
    };
  }
  return { ...conversation, snoozedUntil: patch.snoozedUntil ?? null };
}

function chatLifecycleFeedback(
  previous: ConversationSummary,
  updated: ConversationSummary,
): {
  text: string;
  undo: { archived?: boolean; snoozedUntil?: string | null };
} {
  const before = conversationLifecycleView(previous);
  const after = conversationLifecycleView(updated);
  if (after === "archived") return { text: "Chat archived", undo: { archived: false } };
  if (after === "snoozed") {
    return {
      text: updated.snoozedUntil ? `Chat snoozed until ${new Date(updated.snoozedUntil).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "Chat snoozed",
      undo: before === "archived" ? { archived: true } : { snoozedUntil: previous.snoozedUntil ?? null },
    };
  }
  if (before === "archived") return { text: "Chat restored to Active", undo: { archived: true } };
  if (before === "snoozed") return { text: "Chat resumed", undo: { snoozedUntil: previous.snoozedUntil ?? null } };
  return { text: "Chat updated", undo: { snoozedUntil: previous.snoozedUntil ?? null } };
}

function DesktopUpdateButton({ status, onClick }: { status: DesktopUpdateStatus; onClick: () => void }) {
  const busy = status.phase === "checking" || status.phase === "downloading" || status.phase === "installing";
  const title = updateActionLabel(status);
  const tone = status.phase === "available" || status.phase === "ready" ? "available" : busy ? "working" : status.phase === "error" ? "error" : "idle";
  return <button className={`update-button rail-update-button ${tone}`} type="button" onClick={onClick} disabled={busy} aria-label={title} title={title}>{busy ? <Loader2 className="spin" size={16} /> : status.phase === "error" ? <AlertTriangle size={16} /> : <Download size={16} />}</button>;
}

function updateNeedsAttention(status: DesktopUpdateStatus) { return ["available", "downloading", "ready", "error"].includes(status.phase); }
function updateActionLabel(status: DesktopUpdateStatus) {
  if (status.phase === "available") return `Download Workspace ${status.availableVersion ?? "update"}`;
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading update" : `Downloading update · ${Math.round(status.progressPercent)}%`;
  if (status.phase === "ready") return `Restart and install Workspace ${status.availableVersion ?? "update"}`;
  if (status.phase === "installing") return "Restarting to install update";
  if (status.phase === "error") return "Retry update";
  if (status.phase === "not_available") return "Workspace is up to date";
  return "Check for updates";
}

function isCommandPaletteShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLocaleLowerCase() === "k";
}

function isQuickLookShortcut(event: KeyboardEvent) {
  if ((event.key !== " " && event.code !== "Space") || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (document.querySelector(".modal-backdrop, .publish-review-backdrop, [role='dialog'][aria-modal='true']")) return false;
  const target = event.target instanceof Element ? event.target : null;
  return !target?.closest("input, textarea, select, button, a[href], [contenteditable='true'], [role='button'], [role='textbox'], [data-tree-row]");
}

function commandPaletteBlockedByDialog() {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector(".modal-backdrop, .publish-review-backdrop, [role='dialog'][aria-modal='true']"));
}

function pendingDeleteKey(pending: Pick<PendingDelete, "workspaceId" | "path">) {
  return `${pending.workspaceId}:${pending.path}`;
}

async function deleteLocalFileRequest(pending: PendingDelete, keepalive = false) {
  const sessionHeaders = await window.workspaceDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(`/api/workspaces/${pending.workspaceId}/local-file`), {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(sessionHeaders ?? {}) },
    body: JSON.stringify({ path: pending.path }),
    keepalive,
  });
  if (response.ok) return;
  let message = response.statusText || `Request failed (${response.status}).`;
  try { message = (await response.json() as { error?: string }).error || message; } catch { /* keep the status message */ }
  throw new Error(message);
}

async function collectDroppedUploadFiles(dataTransfer: DataTransfer): Promise<DroppedUploadFile[]> {
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length) {
    const files: DroppedUploadFile[] = [];
    for (const entry of entries) await collectDroppedEntryFiles(entry, "", files);
    return files;
  }
  return Array.from(dataTransfer.files).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
}

async function collectDroppedEntryFiles(entry: FileSystemEntry, parentPath: string, output: DroppedUploadFile[]): Promise<void> {
  if (isDroppedFileEntry(entry)) {
    const file = await droppedFileFromEntry(entry);
    output.push({ file, relativePath: joinDropPath(parentPath, entry.name || file.name) });
    return;
  }
  if (!isDroppedDirectoryEntry(entry)) return;
  const directoryPath = joinDropPath(parentPath, entry.name);
  for (const child of await readDroppedDirectoryEntries(entry)) await collectDroppedEntryFiles(child, directoryPath, output);
}

function isDroppedFileEntry(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile && typeof (entry as Partial<FileSystemFileEntry>).file === "function";
}

function isDroppedDirectoryEntry(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory && typeof (entry as Partial<FileSystemDirectoryEntry>).createReader === "function";
}

function droppedFileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolvePromise, reject) => { entry.file(resolvePromise, reject); });
}

async function readDroppedDirectoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolvePromise, reject) => { reader.readEntries(resolvePromise, reject); });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

function joinDropPath(...segments: string[]) {
  return segments.map((segment) => segment.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}

function fixtureConversationGroups(fixture: WorkspaceUiFixture): Record<string, ConversationSummary[]> { return Object.fromEntries(Object.entries(fixture.conversations).map(([id, conversations]) => [id, conversations.map(({ messages: _messages, ...summary }) => summary)])); }
function normalizeMode(value: string | null): WorkspaceRailMode {
  if (value === "space" || value === "workspaces") return "files";
  if (value === "capabilities" || value === "skills" || value === "extensions") return "files";
  if (value?.startsWith("app:") && /^[a-z0-9][a-z0-9:_-]{0,255}$/i.test(value.slice(4))) return value as WorkspaceRailMode;
  return (["files", "chats", "library", "history"] as WorkspaceRailMode[]).includes(value as WorkspaceRailMode) ? value as WorkspaceRailMode : "files";
}

function extensionSurfaceIdForMode(mode: WorkspaceRailMode): string | null {
  return mode.startsWith("app:") && !mode.startsWith("app:restricted:") ? mode.slice(4) : null;
}

function useThemePreference(): [AppTheme, AppThemePreference, (value: AppThemePreference) => void] {
  const [preference, setPreference] = useState<AppThemePreference>(() => { if (fixtureRequested) return "light"; const value = readStoredValue(themePreferenceKey); return value === "light" || value === "dark" || value === "system" ? value : "system"; });
  const [system, setSystem] = useState<AppTheme>(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const theme = preference === "system" ? system : preference;
  useEffect(() => { const media = window.matchMedia?.("(prefers-color-scheme: dark)"); if (!media) return; const change = () => setSystem(media.matches ? "dark" : "light"); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; window.workspaceDesktop?.window.setTheme(theme, preference); if (!fixtureRequested) writeStoredValue(themePreferenceKey, preference); }, [preference, theme]);
  return [theme, preference, setPreference];
}

function useTypographyPreference(): [AppTypographyPreference, (update: Partial<AppTypographyPreference>) => void] {
  const [value, setValue] = useState<AppTypographyPreference>(() => fixtureRequested ? defaultTypographyPreference : readStoredJsonValue(typographyPreferenceKey, (raw) => { const record = raw as Partial<AppTypographyPreference>; const font = typographyFontValues.includes(record.font as AppTypographyFont) ? record.font as AppTypographyFont : defaultTypographyPreference.font; return { font: typographyFontForPlatform(font), textSize: textSizeValues.includes(record.textSize as AppTypographyPreference["textSize"]) ? record.textSize as AppTypographyPreference["textSize"] : defaultTypographyPreference.textSize }; }, defaultTypographyPreference));
  useEffect(() => { document.documentElement.dataset.workspaceFont = value.font; document.documentElement.dataset.workspaceTextSize = value.textSize; if (!fixtureRequested) writeStoredJsonValue(typographyPreferenceKey, value); }, [value]);
  return [value, (update) => setValue((current) => ({ ...current, ...update }))];
}

function useScrollbarActivity() {
  useEffect(() => {
    if (isMacOS()) return;
    const activeClass = "scrollbars-active";
    const nearClass = "scrollbar-near";
    let timer: number | null = null;
    let nearElement: HTMLElement | null = null;
    const clearTimer = () => { if (timer !== null) window.clearTimeout(timer); timer = null; };
    const active = () => {
      document.body.classList.add(activeClass);
      clearTimer();
      timer = window.setTimeout(() => { document.body.classList.remove(activeClass); timer = null; }, 900);
    };
    const scrollableAncestorFrom = (target: EventTarget | null) => {
      let node = target instanceof Element ? target : null;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement) {
          const style = window.getComputedStyle(node);
          const scrollsY = node.scrollHeight > node.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY);
          const scrollsX = node.scrollWidth > node.clientWidth && /(auto|scroll|overlay)/.test(style.overflowX);
          if (scrollsY || scrollsX) return node;
        }
        node = node.parentElement;
      }
      return null;
    };
    const setNearElement = (next: HTMLElement | null) => {
      if (nearElement === next) return;
      nearElement?.classList.remove(nearClass);
      nearElement = next;
      nearElement?.classList.add(nearClass);
    };
    const pointerMove = (event: PointerEvent) => {
      const scrollable = scrollableAncestorFrom(event.target);
      if (!scrollable) return setNearElement(null);
      const rect = scrollable.getBoundingClientRect();
      const threshold = 24;
      const nearVertical = scrollable.scrollHeight > scrollable.clientHeight && event.clientX >= rect.right - threshold && event.clientX <= rect.right + 2;
      const nearHorizontal = scrollable.scrollWidth > scrollable.clientWidth && event.clientY >= rect.bottom - threshold && event.clientY <= rect.bottom + 2;
      setNearElement(nearVertical || nearHorizontal ? scrollable : null);
    };
    const pointerLeave = () => setNearElement(null);
    document.addEventListener("scroll", active, true);
    document.addEventListener("wheel", active, { passive: true, capture: true });
    document.addEventListener("pointermove", pointerMove, { passive: true, capture: true });
    document.addEventListener("pointerleave", pointerLeave, true);
    return () => {
      clearTimer();
      document.body.classList.remove(activeClass);
      setNearElement(null);
      document.removeEventListener("scroll", active, true);
      document.removeEventListener("wheel", active, true);
      document.removeEventListener("pointermove", pointerMove, true);
      document.removeEventListener("pointerleave", pointerLeave, true);
    };
  }, []);
}

function useDesktopAccentColor() {
  useEffect(() => {
    const desktopWindow = window.workspaceDesktop?.window;
    if (!desktopWindow) return;
    let cancelled = false;
    const apply = (color: string | null) => {
      if (!color) {
        document.documentElement.style.removeProperty("--workspace-accent");
        document.documentElement.style.removeProperty("--ui-accent");
        document.documentElement.style.removeProperty("--ui-accent-hover");
        document.documentElement.style.removeProperty("--ui-accent-soft");
      } else if (/^#[0-9a-f]{6}$/i.test(color)) {
        document.documentElement.style.setProperty("--workspace-accent", color);
        document.documentElement.style.setProperty("--ui-accent", color);
        document.documentElement.style.setProperty("--ui-accent-hover", `color-mix(in srgb, ${color} 86%, black)`);
        document.documentElement.style.setProperty("--ui-accent-soft", `color-mix(in srgb, ${color} 12%, transparent)`);
      }
    };
    void desktopWindow.getAccentColor().then((color) => { if (!cancelled) apply(color); }).catch(() => {});
    const unsubscribe = desktopWindow.onAccentColorChanged(apply);
    return () => { cancelled = true; unsubscribe(); };
  }, []);
}
