import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowSync16Regular, Color20Regular, Settings24Regular } from "@fluentui/react-icons";
import { AlertTriangle, CirclePlus, Download, FolderOpen, Loader2, Search, Upload, X } from "lucide-react";
import {
  accentIdentityFromHex,
  normalizeSpaceAppearanceCustomization,
  upgradeSpaceAppearanceCustomization,
  type SpaceAppearanceState,
} from "../../src/shared/space-appearance";

import { defaultTypographyPreference, productName, textSizeValues, themePreferenceKey, typographyFontValues, typographyPreferenceKey, spaceCustomizationStorageKey, spacePathDragType } from "./constants";
import { ChatActionsPopover } from "./components/chat/ChatActionsPopover";
import { ChatPanel } from "./components/chat/ChatPanel";
import { SpaceSurfaceTabBar } from "./components/chat/SpaceSurfaceTabBar";
import { WorkFoldLoadingState } from "./components/brand/WorkFoldBrand";
import { Banner, CenteredState, EmptyInline, SpaceIconGlyph } from "./components/chrome/common";
import { DesktopTitleBar } from "./components/chrome/DesktopTitleBar";
import { CommandPaletteHost, type CommandPaletteCommand } from "./components/modals/CommandPaletteHost";
import { CreateSpaceModal } from "./components/modals/CreateSpaceModal";
import { DesktopSettingsModal, type SettingsPage } from "./components/modals/DesktopSettingsModal";
import { FileVersionHistoryModal } from "./components/modals/FileVersionHistoryModal";
import { KeyboardShortcutsModal } from "./components/modals/KeyboardShortcutsModal";
import { TextInputModal } from "./components/modals/TextInputModal";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { FileDetailsPane } from "./components/panes/FileDetailsPane";
import { ChecksPane, ChecksToolbarButton } from "./components/panes/ChecksPane";
import { AppStudioPane } from "./components/panes/AppStudioPane";
import { CapabilitiesPane } from "./components/panes/CapabilitiesPane";
import { ExtensionSurfacePane, ExtensionSurfaceUnavailable, ExtensionSurfaceView } from "./components/panes/ExtensionSurface";
import { RestrictedAppViewport } from "./components/panes/RestrictedAppViewport";
import { SpaceAppearancePanel, SpaceModeRail, SpacePaneHeader } from "./components/panes/spaceChrome";
import { FileContentSearch } from "./components/panes/FileContentSearch";
import { ChatsPane, HistoryPane, LibraryPane, SpacesPane } from "./components/panes/spacePanes";
import { FileContextMenu } from "./components/tree/FileContextMenu";
import { FileTree, FileTreeLoadingState } from "./components/tree/FileTree";
import type { SpaceUiFixture } from "./fixtures/space-fixture";
import { usePaneResize } from "./hooks/usePaneResize";
import { useChatActivity } from "./hooks/useChatActivity";
import { useRestrictedApps } from "./hooks/useRestrictedApps";
import { useSurfaceTabs } from "./hooks/useSurfaceTabs";
import { useSpaceTree } from "./hooks/useSpaceTree";
import { useSpaceChecks } from "./hooks/useSpaceChecks";
import { api, apiForm, apiUrl, errorText } from "./lib/api";
import { chatActivityKey, conversationLifecycleView } from "./lib/chat-lifecycle";
import { chatContextRequestForTab } from "./lib/chat-context-request";
import { contributedSurfaces, resolveSurfaceForKey, surfaceMatchesTab } from "./lib/capability-surfaces";
import { canOpenDirectly, hasNativeFiles, hasSpacePathDrag, nativeOpenLabel } from "./lib/file-actions";
import { formatItemCount } from "./lib/format";
import { readStoredJsonValue, readStoredValue, writeStoredJsonValue, writeStoredValue } from "./lib/storage";
import { isMacOS, typographyFontForPlatform, spaceEntryNativePath } from "./lib/platform";
import { resolveRestrictedAppOpenRequest, restrictedAppRailMode } from "./lib/restricted-app-navigation";
import { getLocalAppStudio, getLocalAppSpaceRemovalImpact } from "./lib/restricted-apps";
import { collectLoadedFileEntries, findTreeEntry, isInsideFolder, moveTreeEntry, removeTreeEntries } from "./lib/tree";
import { normalizeSpaceCustomizations } from "./lib/space-customization";
import { spaceIdentityFor, spaceIdentityStyle } from "./lib/space-identity";
import { removeSpaceConfirmText, surfacePanelDomId, surfaceTabDomId, spaceHeaderSourceBadgeLabel } from "./lib/space-ui";
import type { AgentCatalog, AgentExtensionSurface, AppTheme, AppThemePreference, AppTypographyFont, AppTypographyPreference, BootstrapResponse, ChatActionsState, ChatContextPathRequest, ConversationSummary, DesktopUpdateStatus, FileContextMenuState, RestrictedAppInstalled, TreeEntry, SpaceCustomization, SpaceCustomizationMap, SpaceCustomizationPatch, SpacePane, SpaceRailMode, SpaceSummary } from "./types";
import { ConfirmDialogHost, requestConfirm, showToast, ToastHost } from "./ui/feedback";
import { spaceIconOptions } from "./space-icons";

const fixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "space";
const supportedSpaceIconNames = new Set(spaceIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])]));

interface DroppedUploadFile { file: File; relativePath: string }
type DesktopActionCommand = "new-chat" | "reload-space-state" | "open-capabilities" | "open-skills" | "open-extensions" | "open-command-palette";
interface PendingDelete {
  spaceId: string;
  path: string;
  name: string;
  selectedPath: string | null;
  deletedTabPaths: Set<string>;
}
interface SpaceChecksControl {
  spaceId: string;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

export function App() {
  const [theme, themePreference, setThemePreference] = useThemePreference();
  const [typography, setTypography] = useTypographyPreference();
  const [fixture, setFixture] = useState<SpaceUiFixture | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState(() => localStorage.getItem("work-fold.space.active") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>("appearance");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const keyboardShortcutsReturnFocusRef = useRef<HTMLElement | null>(null);
  const activeChecksControlRef = useRef<SpaceChecksControl | null>(null);
  const [desktopAction, setDesktopAction] = useState<{ id: number; command: DesktopActionCommand } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const showDesktopTitleBar = window.workFoldDesktop?.app.platform === "win32";

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
  const updateActiveChecksControl = useCallback((control: SpaceChecksControl | null) => {
    if (control || activeChecksControlRef.current?.spaceId === activeSpaceId) {
      activeChecksControlRef.current = control;
    }
  }, [activeSpaceId]);

  useScrollbarActivity();
  useDesktopAccentColor();

  const refreshBootstrap = useCallback(async () => {
    if (fixtureRequested) return;
    try {
      const result = await api<BootstrapResponse>("/api/bootstrap");
      setBoot(result);
      setActiveSpaceId((current) => result.spaces.some((item) => item.id === current) ? current : result.spaces[0]?.id ?? "");
    } catch (caught) { setError(errorText(caught)); }
  }, []);

  useEffect(() => {
    if (fixtureRequested) {
      void import("./fixtures/space-fixture").then(({ buildSpaceFixture }) => {
        const next = buildSpaceFixture(); setFixture(next); setBoot({ spaces: next.spaces, agent: next.agent }); setActiveSpaceId(next.activeSpaceId);
      }).catch((caught) => setError(errorText(caught)));
      return;
    }
    void refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    if (fixtureRequested) return;
    function refreshOnReturn() {
      if (document.visibilityState !== "visible") return;
      void refreshBootstrap();
    }
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [refreshBootstrap]);

  const activeSpace = useMemo(() => boot?.spaces.find((item) => item.id === activeSpaceId) ?? boot?.spaces[0] ?? null, [activeSpaceId, boot]);
  useEffect(() => { if (activeSpace) { if (!fixtureRequested) localStorage.setItem("work-fold.space.active", activeSpace.id); setActiveSpaceId(activeSpace.id); } }, [activeSpace?.id]);
  useEffect(() => {
    if (fixtureRequested) return;
    void window.workFoldDesktop?.space.setActiveSpace?.(activeSpace?.id ?? null).catch((caught) => setError(errorText(caught)));
  }, [activeSpace?.id, activeSpace?.name, activeSpace?.rootPath]);
  useEffect(() => {
    const desktopSpace = window.workFoldDesktop?.space;
    if (!desktopSpace?.onOpenSpace || !boot) return;
    return desktopSpace.onOpenSpace((spaceId) => {
      if (boot.spaces.some((space) => space.id === spaceId)) setActiveSpaceId(spaceId);
    });
  }, [boot?.spaces]);
  useEffect(() => {
    const updates = window.workFoldDesktop?.updates;
    if (!updates) return;
    let cancelled = false;
    void updates.getStatus().then((status) => { if (!cancelled) setUpdateStatus(status); }).catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const unsubscribe = updates.onStatusChanged((status) => { if (!cancelled) setUpdateStatus(status); });
    return () => { cancelled = true; unsubscribe(); };
  }, []);
  useEffect(() => {
    const menu = window.workFoldDesktop?.menu;
    if (!menu) return;
    menu.setState({ spaceOpen: Boolean(activeSpace) });
    return menu.onCommand((command) => {
      if (command === "new-space") setCreateSpaceOpen(true);
      else if (command === "open-local-folder") void openFolder();
      else if (command === "check-for-updates") void checkForUpdates();
      else if (command === "open-settings") openSettings();
      else if (command === "open-about") openSettings("about");
      else if (command === "open-keyboard-shortcuts") openKeyboardShortcuts();
      else if (command === "new-chat" || command === "reload-space-state" || command === "open-capabilities" || command === "open-skills" || command === "open-extensions" || command === "open-command-palette") {
        setDesktopAction({ id: Date.now(), command });
      }
    });
  }, [activeSpace?.id, openKeyboardShortcuts, openSettings, refreshBootstrap]);
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
    const unsubscribe = window.workFoldDesktop?.runtime.onRendererRecovered?.(() => {
      showToast({ text: "work-fold recovered from a problem and reloaded.", tone: "info" });
    });
    return unsubscribe;
  }, []);
  useEffect(() => window.workFoldDesktop?.agent.onOpenSettings(() => openSettings("assistant")), [openSettings]);

  async function createSpace(name: string) {
    if (fixtureRequested) { setCreateSpaceOpen(false); showToast({ text: "Space creation is disabled in the preview", tone: "info" }); return; }
    const checksControl = activeChecksControlRef.current;
    try {
      await checksControl?.suspend();
      const result = await api<{ space: SpaceSummary }>("/api/spaces", { method: "POST", body: { name } });
      await refreshBootstrap(); setActiveSpaceId(result.space.id); setCreateSpaceOpen(false);
    } finally {
      void checksControl?.resume();
    }
  }

  async function openFolder() {
    const picker = window.workFoldDesktop?.space;
    if (!picker) return setError("Folder selection is available in the desktop app.");
    let checksControl: SpaceChecksControl | null = null;
    try {
      const selected = await picker.chooseFolder(); if (!selected) return;
      checksControl = activeChecksControlRef.current;
      await checksControl?.suspend();
      const result = await api<{ space: SpaceSummary }>("/api/spaces/local-folder", { method: "POST", body: { spaceRoot: selected.path, folderGrantId: selected.folderGrantId } });
      await refreshBootstrap(); setActiveSpaceId(result.space.id);
    } catch (caught) { setError(errorText(caught)); }
    finally { void checksControl?.resume(); }
  }

  async function checkForUpdates() {
    try { const status = await window.workFoldDesktop?.updates.check(); if (status) setUpdateStatus(status); } catch (caught) { setError(errorText(caught)); }
  }

  async function runUpdateAction() {
    const updates = window.workFoldDesktop?.updates;
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

  if (!boot || (fixtureRequested && !fixture)) return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>{showDesktopTitleBar ? <DesktopTitleBar /> : null}<WorkFoldLoadingState message={error ?? "Loading your Spaces and Assistant."} /></div>;

  return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>
    {showDesktopTitleBar ? <DesktopTitleBar /> : null}
    {activeSpace ? <SpaceView space={activeSpace} spaces={boot.spaces} agent={boot.agent} appearance={boot.appearance} fixture={fixture} desktopAction={desktopAction} updateStatus={updateStatus} themePreference={themePreference} onThemePreferenceChange={setThemePreference} onUpdateAction={() => void runUpdateAction()} onSwitchSpace={(space) => setActiveSpaceId(space.id)} onRefreshBootstrap={refreshBootstrap} onCreateSpace={() => setCreateSpaceOpen(true)} onOpenFolder={() => void openFolder()} onChecksControlChange={updateActiveChecksControl} onOpenSettings={openSettings} onOpenShortcuts={openKeyboardShortcuts} onError={setError} /> : <OnboardingFlow onCreateSpace={() => setCreateSpaceOpen(true)} onOpenFolder={() => void openFolder()} />}
    {error ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    {createSpaceOpen ? <CreateSpaceModal onClose={() => setCreateSpaceOpen(false)} onCreate={createSpace} /> : null}
    {settingsOpen ? <DesktopSettingsModal theme={theme} themePreference={themePreference} onThemePreferenceChange={setThemePreference} typography={typography} onTypographyChange={setTypography} space={activeSpace} agentStatus={boot.agent} fixtureMode={Boolean(fixture)} initialPage={settingsInitialPage} onAgentConfigured={(agent) => setBoot((current) => current ? { ...current, agent } : current)} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onClose={() => setSettingsOpen(false)} /> : null}
    {shortcutsOpen ? <KeyboardShortcutsModal onClose={closeKeyboardShortcuts} /> : null}
    <ConfirmDialogHost /><ToastHost />
  </div>;
}

function SpaceView({ space, spaces, agent, appearance, fixture, desktopAction, updateStatus, themePreference, onThemePreferenceChange, onUpdateAction, onSwitchSpace, onRefreshBootstrap, onCreateSpace, onOpenFolder, onChecksControlChange, onOpenSettings, onOpenShortcuts, onError }: {
  space: SpaceSummary;
  spaces: SpaceSummary[];
  agent: BootstrapResponse["agent"];
  appearance?: SpaceAppearanceState;
  fixture: SpaceUiFixture | null;
  desktopAction: { id: number; command: DesktopActionCommand } | null;
  updateStatus: DesktopUpdateStatus | null;
  themePreference: AppThemePreference;
  onThemePreferenceChange: (theme: AppThemePreference) => void;
  onUpdateAction: () => void;
  onSwitchSpace: (space: SpaceSummary) => void;
  onRefreshBootstrap: () => Promise<void>;
  onCreateSpace: () => void;
  onOpenFolder: () => void;
  onChecksControlChange: (control: SpaceChecksControl | null) => void;
  onOpenSettings: (page?: SettingsPage) => void;
  onOpenShortcuts: () => void;
  onError: (message: string | null) => void;
}) {
  const initialStoredModeRef = useRef(fixture ? null : localStorage.getItem("work-fold.space.mode"));
  const [activeMode, setActiveMode] = useState<SpaceRailMode>(() => fixture ? "files" : normalizeMode(initialStoredModeRef.current));
  const legacyCustomizationsRef = useRef<SpaceCustomizationMap>(fixture ? {} : readStoredJsonValue(
    spaceCustomizationStorageKey,
    (value) => normalizeSpaceCustomizations(value, undefined, supportedSpaceIconNames),
    {},
  ));
  const [customizations, setCustomizations] = useState<SpaceCustomizationMap>(() => fixture
    ? fixture.customizations
    : normalizeSpaceCustomizations(
      { ...legacyCustomizationsRef.current, ...(appearance?.customizations ?? {}) },
      undefined,
      supportedSpaceIconNames,
    ));
  const customizationsRef = useRef(customizations);
  const appearanceStorageWarningShownRef = useRef(false);
  const appearanceWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const appearanceHistoryRef = useRef(new Map<string, SpaceCustomization[]>());
  const [, setAppearanceHistoryVersion] = useState(0);
  customizationsRef.current = customizations;
  useEffect(() => {
    if (fixture || !Object.keys(legacyCustomizationsRef.current).length) return;
    let cancelled = false;
    appearanceWriteQueueRef.current = appearanceWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await api<{ appearance: SpaceAppearanceState }>("/api/appearance/migrate", {
          method: "POST",
          body: { customizations: legacyCustomizationsRef.current },
        });
        legacyCustomizationsRef.current = {};
        localStorage.removeItem(spaceCustomizationStorageKey);
        if (!cancelled) {
          customizationsRef.current = result.appearance.customizations;
          setCustomizations(result.appearance.customizations);
        }
      })
      .catch((caught) => {
        if (!cancelled && !appearanceStorageWarningShownRef.current) {
          appearanceStorageWarningShownRef.current = true;
          showToast({ text: `work-fold could not migrate the saved Space appearance. ${errorText(caught)}`, tone: "info" });
        }
      });
    return () => { cancelled = true; };
  }, [fixture]);
  const [conversationGroups, setConversationGroups] = useState<Record<string, ConversationSummary[]>>(() => fixture ? fixtureConversationGroups(fixture) : {});
  const [surfaceCatalogs, setSurfaceCatalogs] = useState<Record<string, AgentExtensionSurface[]>>(() => fixture ? fixture.surfaces : {});
  const surfaceCatalogRequestRef = useRef(0);
  const chatActivity = useChatActivity(Boolean(fixture));
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [renameEntryRequest, setRenameEntryRequest] = useState<{ path: string; name: string } | null>(null);
  const [chatActions, setChatActions] = useState<ChatActionsState | null>(null);
  const [versionHistory, setVersionHistory] = useState<{ space: SpaceSummary; path: string; name: string } | null>(null);
  const [contextRequest, setContextRequest] = useState<ChatContextPathRequest | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [historyRefreshRequest, setHistoryRefreshRequest] = useState(0);
  const [libraryTree, setLibraryTree] = useState<TreeEntry[]>(() => fixture?.library ?? []);
  const [libraryOpenRequests, setLibraryOpenRequests] = useState<Record<string, number>>({});
  const libraryTreeRequestRef = useRef(0);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const contextRequestId = useRef(0);
  const pendingDeletesRef = useRef(new Map<string, PendingDelete>());
  const activeSpaceIdRef = useRef(space.id);
  activeSpaceIdRef.current = space.id;
  const tree = useSpaceTree(space, onError, fixture?.trees[space.id]);
  const selectedPathRef = useRef(tree.selectedPath);
  selectedPathRef.current = tree.selectedPath;
  const paneResize = usePaneResize(Boolean(fixture));
  const tabs = useSurfaceTabs({
    space,
    spaces,
    fixtureMode: Boolean(fixture),
    migrateLegacyLibraryMode: initialStoredModeRef.current === "library",
    onSwitchSpace,
  });
  const handleRestrictedAppError = useCallback((caught: unknown) => onError(errorText(caught)), [onError]);
  const restrictedAppsState = useRestrictedApps({
    activeSpaceId: space.id,
    fixtureMode: Boolean(fixture),
    onError: handleRestrictedAppError,
  });
  const activeTab = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId) ?? null;
  const checks = useSpaceChecks(space, Boolean(fixture), activeTab?.kind !== "checks");
  useEffect(() => {
    const control = { spaceId: space.id, suspend: checks.suspend, resume: checks.resume };
    onChecksControlChange(control);
    return () => onChecksControlChange(null);
  }, [checks.resume, checks.suspend, onChecksControlChange, space.id]);
  const identity = spaceIdentityFor(space, customizations);
  const surfaceCatalogKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, space.id);
  const restrictedAppCatalogKnown = restrictedAppsState.knownSpaceIds.has(space.id);
  const restrictedApps = restrictedAppsState.appsBySpace[space.id] ?? [];
  useEffect(() => {
    tabs.reconcileRestrictedAppSurfaceTabs(
      restrictedAppsState.appsBySpace,
      restrictedAppsState.knownSpaceIds,
    );
  }, [restrictedAppsState.appsBySpace, restrictedAppsState.knownSpaceIds, tabs.reconcileRestrictedAppSurfaceTabs]);
  const surfaces = useMemo(() => contributedSurfaces(space.id, surfaceCatalogs[space.id] ?? []), [surfaceCatalogs, space.id]);
  const activeSurfaceKey = extensionSurfaceIdForMode(activeMode);
  const activeSurface = activeSurfaceKey ? resolveSurfaceForKey(surfaces, activeSurfaceKey) : null;
  const activeRestrictedApp = restrictedApps.find((app) => restrictedAppRailMode(space.id, app.manifest.id) === activeMode) ?? null;
  const previewLocalFile = useCallback((path: string) => {
    const previewFile = window.workFoldDesktop?.space.previewFile;
    if (!isMacOS() || !previewFile) return;
    void previewFile(space.id, path).catch((caught) => onError(errorText(caught)));
  }, [onError, space.id]);

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

  const refreshLibraryTree = useCallback(async () => {
    const requestId = ++libraryTreeRequestRef.current;
    if (fixture) {
      setLibraryTree(fixture.library);
      return;
    }
    try {
      const result = await api<{ tree: TreeEntry[] }>("/api/resources/tree");
      if (libraryTreeRequestRef.current === requestId) setLibraryTree(result.tree);
    } catch (caught) {
      if (libraryTreeRequestRef.current === requestId) onError(errorText(caught));
    }
  }, [fixture, onError]);

  function openLibrary(targetSpace: SpaceSummary): void {
    setLibraryOpenRequests((current) => ({
      ...current,
      [targetSpace.id]: (current[targetSpace.id] ?? 0) + 1,
    }));
    tabs.openLibrarySurfaceTab(targetSpace);
  }

  useEffect(() => { if (!fixture) localStorage.setItem("work-fold.space.mode", activeMode); }, [activeMode, fixture]);
  useEffect(() => {
    if (tree.status === "ready" && activeTab?.kind !== "checks") void checks.refresh();
  }, [activeTab?.kind, checks.refresh, tree.status, tree.tree]);
  useEffect(() => { void refreshLibraryTree(); }, [refreshLibraryTree]);
  useEffect(() => { setActiveMode((current) => current === "spaces" ? "files" : current); }, [space.id]);
  useEffect(() => {
    if (!isMacOS() || !window.workFoldDesktop?.space.previewFile) return;
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
    const desktop = window.workFoldDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onTabCommand((command) => {
      const installed = restrictedAppsState.appsBySpace[command.spaceId]?.find((app) => (
        app.manifest.id === command.appId && app.digest === command.digest
      ));
      const targetSpace = spaces.find((item) => item.id === command.spaceId);
      if (!installed || !targetSpace) return;
      if (command.type === "open" && command.tab) {
        tabs.openRestrictedAppSurfaceTab(targetSpace, { appId: command.appId, digest: command.digest }, command.tab);
      } else if (command.type === "update" && command.tab) {
        tabs.updateRestrictedAppSurfaceTab(command.spaceId, { appId: command.appId, digest: command.digest }, command.tab);
      } else if (command.type === "close" && command.sourceAppTabId) {
        tabs.closeRestrictedAppSurfaceTab(command.spaceId, command.appId, command.digest, command.sourceAppTabId);
      }
    });
  }, [restrictedAppsState.appsBySpace, tabs, spaces]);
  useEffect(() => {
    const desktop = window.workFoldDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onOpenRequest((request) => {
      const target = resolveRestrictedAppOpenRequest(request, spaces);
      if (!target) return;
      if (target.space.id !== space.id) onSwitchSpace(target.space);
      setActiveMode(target.mode);
    });
  }, [onSwitchSpace, space.id, spaces]);
  useEffect(() => {
    // A temporarily missing or moved folder is not the same thing as an
    // explicit Space removal. Keep appearance keyed by the portable Space id
    // so relinking that folder restores its identity on this computer.
    const next = normalizeSpaceCustomizations(customizationsRef.current, undefined, supportedSpaceIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) {
      customizationsRef.current = next;
      setCustomizations(next);
    }
  }, [spaces.map((item) => item.id).join("|")]);
  useEffect(() => { if (fixture) { setConversationGroups(fixtureConversationGroups(fixture)); return; } void loadConversationGroups(); }, [fixture, spaces.map((item) => item.id).join("|")]);
  useEffect(() => {
    if (fixture) {
      setSurfaceCatalogs(fixture.surfaces);
      return;
    }
    const requestId = ++surfaceCatalogRequestRef.current;
    void api<AgentCatalog>(`/api/spaces/${space.id}/agent/catalog`).then((catalog) => {
      if (surfaceCatalogRequestRef.current !== requestId) return;
      setSurfaceCatalogs((current) => ({ ...current, [space.id]: catalog.surfaces ?? [] }));
    }).catch((caught) => {
      if (surfaceCatalogRequestRef.current === requestId) onError(errorText(caught));
    });
  }, [fixture, space.id]);
  useEffect(() => {
    if (!surfaceCatalogKnown || !restrictedAppCatalogKnown || !activeSurfaceKey || activeSurface) return;
    setActiveMode("files");
  }, [activeSurface, activeSurfaceKey, restrictedAppCatalogKnown, surfaceCatalogKnown, space.id]);
  useEffect(() => { tabs.syncSurfaceTabConversationTitles(conversationGroups); }, [conversationGroups]);
  useEffect(() => {
    function closeMenus(event: PointerEvent) { if (event.target instanceof Element && event.target.closest(".context-menu")) return; setFileContextMenu(null); }
    document.addEventListener("pointerdown", closeMenus); return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);
  useEffect(() => {
    if (!desktopAction) return;
    if (desktopAction.command === "new-chat") openChat(space, null);
    else if (desktopAction.command === "reload-space-state") void refreshSpaceState();
    else if (desktopAction.command === "open-capabilities" || desktopAction.command === "open-skills" || desktopAction.command === "open-extensions") tabs.openAssistantToolsSurfaceTab(space, "installed");
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
    const pairs = await Promise.all(spaces.map(async (item) => {
      try { return [item.id, (await api<{ conversations: ConversationSummary[] }>(`/api/spaces/${item.id}/conversations`)).conversations] as const; }
      catch { return [item.id, []] as const; }
    }));
    setConversationGroups(Object.fromEntries(pairs));
  }

  async function refreshSpaceState() {
    if (fixture) {
      showToast({ text: "Preview data is already up to date.", tone: "info" });
      return;
    }
    onError(null);
    await Promise.all([onRefreshBootstrap(), tree.refresh(false), loadConversationGroups(), refreshLibraryTree()]);
    setHistoryRefreshRequest((current) => current + 1);
    showToast({ text: `${space.name} refreshed`, tone: "success" });
  }

  function rememberSpaceAppearance(spaceId: string) {
    const history = appearanceHistoryRef.current.get(spaceId) ?? [];
    history.push(structuredClone(customizationsRef.current[spaceId] ?? {}));
    if (history.length > 20) history.shift();
    appearanceHistoryRef.current.set(spaceId, history);
    setAppearanceHistoryVersion((current) => current + 1);
  }

  function persistSpaceCustomization(
    spaceId: string,
    customization: SpaceCustomization | undefined,
    options: { remember?: boolean } = {},
  ) {
    if (options.remember !== false) rememberSpaceAppearance(spaceId);
    const next = { ...customizationsRef.current };
    if (customization && Object.keys(customization).length) next[spaceId] = customization;
    else delete next[spaceId];
    customizationsRef.current = next;
    setCustomizations(next);
    if (fixture) return;
    appearanceWriteQueueRef.current = appearanceWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = customization && Object.keys(customization).length
          ? await api<{ appearance: SpaceAppearanceState }>(`/api/spaces/${spaceId}/appearance`, {
            method: "PUT",
            body: { customization },
          })
          : await api<{ appearance: SpaceAppearanceState }>(`/api/spaces/${spaceId}/appearance`, { method: "DELETE" });
      })
      .catch((caught) => {
        if (appearanceStorageWarningShownRef.current) return;
        appearanceStorageWarningShownRef.current = true;
        showToast({ text: `This appearance works for this session, but work-fold could not save it on this computer. ${errorText(caught)}`, tone: "info" });
      });
  }

  function customizeSpace(spaceId: string, patch: SpaceCustomizationPatch) {
    const current = upgradeSpaceAppearanceCustomization(customizationsRef.current[spaceId] ?? {});
    const merged: SpaceCustomization = { ...current, ...patch, schema: 2 };
    if (Object.prototype.hasOwnProperty.call(patch, "color")) {
      delete merged.color;
      if (patch.color) merged.primary = accentIdentityFromHex(patch.color);
      else delete merged.primary;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "color2")) {
      delete merged.color2;
      if (patch.color2) merged.secondary = accentIdentityFromHex(patch.color2);
      else delete merged.secondary;
    }
    const normalized = normalizeSpaceCustomizations(
      { [spaceId]: normalizeSpaceAppearanceCustomization(merged) },
      new Set([spaceId]),
      supportedSpaceIconNames,
    )[spaceId];
    persistSpaceCustomization(spaceId, normalized);
  }

  function replaceSpaceCustomization(spaceId: string, customization: SpaceCustomization) {
    const normalized = normalizeSpaceCustomizations(
      { [spaceId]: upgradeSpaceAppearanceCustomization(customization) },
      new Set([spaceId]),
      supportedSpaceIconNames,
    )[spaceId];
    persistSpaceCustomization(spaceId, normalized);
    showToast({ text: "Appearance proposal applied to this Space.", tone: "success" });
  }

  function undoSpaceCustomization(spaceId: string) {
    const history = appearanceHistoryRef.current.get(spaceId) ?? [];
    const previous = history.pop();
    appearanceHistoryRef.current.set(spaceId, history);
    setAppearanceHistoryVersion((current) => current + 1);
    if (!previous) return;
    persistSpaceCustomization(spaceId, Object.keys(previous).length ? previous : undefined, { remember: false });
    showToast({ text: "Undid the last appearance change.", tone: "success" });
  }

  function resetSpaceCustomization(spaceId: string) {
    persistSpaceCustomization(spaceId, undefined);
    showToast({ text: "Space appearance reset to defaults.", tone: "success" });
  }

  async function renameSpace(target: SpaceSummary, name: string) {
    if (fixture) { showToast({ text: "Space rename is disabled in the preview", tone: "info" }); return; }
    await checks.suspend();
    try { await api(`/api/spaces/${target.id}`, { method: "PATCH", body: { name } }); await onRefreshBootstrap(); showToast({ text: `Renamed Space to ${name}`, tone: "success" }); }
    catch (caught) { onError(errorText(caught)); throw caught; }
    finally { void checks.resume(); }
  }

  async function removeSpace(target: SpaceSummary) {
    if (fixture) { showToast({ text: "Space removal is disabled in the preview", tone: "info" }); return; }
    let appStudio;
    let appRemovalImpact;
    try {
      [appStudio, appRemovalImpact] = await Promise.all([
        getLocalAppStudio(target.id),
        getLocalAppSpaceRemovalImpact(target.id),
      ]);
    } catch (caught) {
      onError(`work-fold could not verify ${target.name}'s App Studio state. ${errorText(caught)}`);
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
    const confirmed = await requestConfirm({ title: target.location.storage === "linked" ? `Remove ${target.name}?` : `Delete ${target.name}?`, body: removeSpaceConfirmText(target, {
      ...appStudio,
      incomingPreparedOperationCount: appRemovalImpact.incomingPreparedOperationCount,
    }), confirmLabel: target.location.storage === "linked" ? "Remove Space" : "Delete Space", tone: "danger" });
    if (!confirmed) return;
    const suspendedChecks = target.id === activeSpaceIdRef.current;
    let removed = false;
    try {
      if (suspendedChecks) await checks.suspend();
      const removal = await api<{ cleanupPending: boolean; deleted: boolean }>(`/api/spaces/${target.id}`, { method: "DELETE" });
      removed = true;
      const nextCustomizations = { ...customizationsRef.current };
      delete nextCustomizations[target.id];
      customizationsRef.current = nextCustomizations;
      setCustomizations(nextCustomizations);
      tabs.removeSpaceSurfaceTabs(target.id);
      await onRefreshBootstrap();
      showToast({
        text: removal.cleanupPending
          ? target.location.storage === "managed" && !removal.deleted
            ? `${target.name} was removed. work-fold will retry deleting its managed folder when it next starts.`
            : `${target.name} was removed. work-fold will finish machine-local cleanup when it next starts.`
          : target.location.storage === "linked"
            ? `${target.name} removed. The folder and its files remain on your computer.`
            : `${target.name} and its managed folder were deleted.`,
        tone: removal.cleanupPending ? "info" : "success",
      });
    } catch (caught) {
      if (suspendedChecks && !removed) void checks.resume();
      onError(errorText(caught));
    }
  }

  function openChat(targetSpace: SpaceSummary, conversation: ConversationSummary | null) {
    if (conversation) chatActivity.setAttention(chatActivityKey(targetSpace.id, conversation.id), false);
    tabs.openChatSurfaceTab(targetSpace, conversation);
  }

  function openChatActions(
    targetSpace: SpaceSummary,
    conversation: ConversationSummary,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget;
    const rect = returnFocusTarget.getBoundingClientRect();
    const invokedFromKeyboard = event.clientX === 0 && event.clientY === 0;
    setChatActions({
      space: targetSpace,
      conversation,
      x: invokedFromKeyboard ? Math.round(rect.right - 8) : Math.round(event.clientX),
      y: invokedFromKeyboard ? Math.round(rect.bottom + 4) : Math.round(event.clientY),
      returnFocusTarget,
    });
  }
  function attachToChat(path: string) {
    const existing = tabs.surfaceTabs.find((tab) => tab.kind === "chat" && tab.spaceId === space.id && (!tab.conversationId || tab.id === tabs.activeSurfaceTabId));
    const surfaceTabId = existing?.id ?? tabs.openChatSurfaceTab(space, null);
    if (existing) tabs.setActiveSurfaceTabId(existing.id);
    setContextRequest({ id: ++contextRequestId.current, path, spaceId: space.id, surfaceTabId });
    showToast({ text: `Attached ${path.split("/").pop() ?? path} to Chat`, tone: "success" });
  }

  async function openContextMenu(entry: TreeEntry, event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget as HTMLElement;
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const popupFileMenu = window.workFoldDesktop?.space.popupFileMenu;
    if (isMacOS() && popupFileMenu) {
      setFileContextMenu(null);
      try {
        const command = await popupFileMenu({
          spaceId: space.id,
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
            tabs.openFileSurfaceTab(space, entry.path);
            await openLocalPath(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
          } else await openLocalPath(entry.path, "open");
        } else if (command === "reveal") await openLocalPath(entry.path, "reveal");
        else if (command === "copy-path") await copyPath(entry.path);
        else if (command === "attach-chat") attachToChat(entry.path);
        else if (command === "version-history") openVersionHistory(space, entry.path);
        else if (command === "upload-here") chooseUpload(entry.path);
        else if (command === "rename") renameEntry(entry.path);
        else if (command === "delete") await deleteEntry(entry.path);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setFileContextMenu({ entry, x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 390), returnFocusTarget });
  }
  function openRootContextMenu(event: React.MouseEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("[data-tree-row]")) return; openContextMenu({ name: space.name, path: "", kind: "folder" }, event); }

  async function uploadFiles(files: DroppedUploadFile[], targetFolderPath: string) {
    if (!files.length || fixture) return;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    onError(null);
    try {
      await apiForm(`/api/spaces/${space.id}/upload-local-files`, form);
      await tree.refresh();
      showToast({ text: formatItemCount(files.length, "file") + " added", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setUploadingFiles(false); }
  }
  async function uploadDroppedFilesForChat(dataTransfer: DataTransfer): Promise<string[]> {
    // Collect before the first await: dropped directory entries are only
    // readable while the drop event's DataTransfer is alive.
    const collected = collectDroppedUploadFiles(dataTransfer);
    if (fixture) return [];
    const files = await collected;
    if (!files.length) return [];
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const targetFolderPath = `Dropped/${localDate}`;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    try {
      const result = await apiForm<{ uploaded: Array<{ path: string }> }>(`/api/spaces/${space.id}/upload-local-files`, form);
      void tree.refresh();
      showToast({ text: `${formatItemCount(files.length, "file")} added to ${targetFolderPath}`, tone: "success" });
      return result.uploaded.map((item) => item.path);
    } finally {
      setUploadingFiles(false);
    }
  }
  function chooseUpload(targetPath = "") { setUploadTargetPath(targetPath); uploadRef.current?.click(); }

  async function moveEntry(sourcePath: string, targetFolderPath: string) {
    if (fixture || !sourcePath || sourcePath === targetFolderPath || isInsideFolder(targetFolderPath, sourcePath)) return;
    tree.setMovingTreePath(sourcePath);
    try {
      const result = await api<{ moved: { path: string; name: string }; safetyCheckpointId: string }>(`/api/spaces/${space.id}/move-local-entry`, { method: "POST", body: { sourcePath, targetFolderPath } });
      const preview = moveTreeEntry(tree.tree, sourcePath, targetFolderPath);
      tree.setTree(preview.entries);
      tabs.retargetFileSurfaceTabsForMove(space.id, sourcePath, result.moved.path);
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
    const deletedTabPaths = new Set(tabs.surfaceTabs.flatMap((tab) => tab.kind === "file" && tab.spaceId === space.id && (tab.path === path || tab.path.startsWith(`${path}/`)) ? [tab.path] : []));
    const pending: PendingDelete = { spaceId: space.id, path, name: entry?.name ?? path, selectedPath, deletedTabPaths };
    pendingDeletesRef.current.set(pendingDeleteKey(pending), pending);
    tree.setTree((current) => removeTreeEntries(current, new Set([path])));
    showToast({ text: `Removed ${pending.name}`, tone: "success", actionLabel: "Undo", durationMs: 6500,
      onAction: () => {
        if (pendingDeletesRef.current.get(pendingDeleteKey(pending)) !== pending) return;
        pendingDeletesRef.current.delete(pendingDeleteKey(pending));
        if (pending.spaceId !== activeSpaceIdRef.current) return;
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        void refreshTreeWithPendingDeletes().then(() => {
          if (pending.spaceId === activeSpaceIdRef.current && pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
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
    const result = await api<{ renamed: { path: string }; safetyCheckpointId: string }>(`/api/spaces/${space.id}/rename-local-entry`, {
      method: "POST",
      body: { path: renameEntryRequest.path, newName: name },
    });
    tabs.retargetFileSurfaceTabsForMove(space.id, renameEntryRequest.path, result.renamed.path);
    await tree.refresh();
    showHistorySaved(`Renamed ${renameEntryRequest.name}`);
  }

  async function openLocalPath(path: string, action: "reveal" | "open" | "open-native", targetSpace = space) {
    if (fixture) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const desktop = window.workFoldDesktop;
    try { if (!path) await desktop?.space.revealFolder?.(targetSpace.id); else if (desktop?.space.openPath) await desktop.space.openPath(targetSpace.id, path, action); else await desktop?.space.revealFolder?.(targetSpace.id); }
    catch (caught) { onError(errorText(caught)); }
  }
  function openVersionHistory(targetSpace: SpaceSummary, path: string) {
    if (fixture) { showToast({ text: "Version history is disabled in the preview", tone: "info" }); return; }
    setVersionHistory({ space: targetSpace, path, name: path.split("/").pop() ?? path });
  }
  async function copyPath(path: string) { const full = spaceEntryNativePath(space.rootPath, path); await navigator.clipboard.writeText(full); showToast({ text: "Path copied", tone: "success" }); }

  function updateDropTarget(event: React.DragEvent<HTMLElement>, target: string) { event.preventDefault(); if (hasNativeFiles(event) || hasSpacePathDrag(event)) { event.dataTransfer.dropEffect = hasNativeFiles(event) ? "copy" : "move"; tree.setDropTargetFolderPath(target); } }
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
    const source = hasSpacePathDrag(event) ? event.dataTransfer.getData(spacePathDragType) || event.dataTransfer.getData("text/plain") : "";
    if (source) await moveEntry(source, target);
  }
  function startTreeDrag(path: string, event: React.DragEvent<HTMLElement>) { tree.setMovingTreePath(path); event.dataTransfer.setData(spacePathDragType, path); event.dataTransfer.setData("text/plain", path); event.dataTransfer.effectAllowed = "move"; }
  function endTreeDrag() { tree.setMovingTreePath(null); tree.setDropTargetFolderPath(null); }

  function startNativeFileDrag(path: string, event: React.DragEvent<HTMLElement>) {
    if (!event.altKey || !window.workFoldDesktop?.space.startDrag) return false;
    event.preventDefault();
    void window.workFoldDesktop.space.startDrag(space.id, path).catch((caught) => onError(errorText(caught)));
    return true;
  }

  async function commitPendingDelete(pending: PendingDelete) {
    const key = pendingDeleteKey(pending);
    if (pendingDeletesRef.current.get(key) !== pending) return;
    pendingDeletesRef.current.delete(key);
    try {
      await deleteLocalFileRequest(pending);
      tabs.closeFileSurfaceTabsForDeletedPaths(pending.spaceId, pending.deletedTabPaths);
    } catch (caught) {
      onError(errorText(caught));
      if (pending.spaceId === activeSpaceIdRef.current) {
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
    const pendingPaths = new Set([...pendingDeletesRef.current.values()].filter((item) => item.spaceId === space.id).map((item) => item.path));
    if (pendingPaths.size) tree.setTree((current) => removeTreeEntries(current, pendingPaths));
  }

  function showHistorySaved(text: string) {
    showToast({ text: `${text}. Restore point saved in History.`, tone: "success" });
  }

  async function saveRestorePoint() {
    if (fixture) return;
    try {
      const result = await api<{ created: boolean }>(`/api/spaces/${space.id}/history/checkpoints`, { method: "POST", body: { label: "Manual restore point" } });
      setHistoryRefreshRequest((current) => current + 1);
      setActiveMode("history");
      showToast(result.created
        ? { text: "Restore point saved", tone: "success" }
        : { text: "Current files already match the latest restore point", tone: "info" });
    } catch (caught) { onError(errorText(caught)); }
  }

  async function renameChat(targetSpace: SpaceSummary, conversation: ConversationSummary, title: string) {
    if (fixture) { const updated = { ...conversation, title }; replaceConversationSummary(targetSpace.id, updated); tabs.updateSurfaceTabConversationTitle(targetSpace.id, updated); return; }
    const result = await api<{ conversation: ConversationSummary }>(`/api/spaces/${targetSpace.id}/conversations/${conversation.id}`, { method: "PATCH", body: { title } });
    replaceConversationSummary(targetSpace.id, result.conversation);
    tabs.updateSurfaceTabConversationTitle(targetSpace.id, result.conversation);
  }

  function replaceConversationSummary(spaceId: string, conversation: ConversationSummary): void {
    setConversationGroups((current) => ({
      ...current,
      [spaceId]: (current[spaceId] ?? []).map((item) => item.id === conversation.id ? conversation : item),
    }));
  }

  async function updateChatLifecycle(
    targetSpace: SpaceSummary,
    conversation: ConversationSummary,
    patch: { archived?: boolean; snoozedUntil?: string | null },
    options: { announce?: boolean } = {},
  ): Promise<ConversationSummary> {
    const previous = conversation;
    const updated = fixture
      ? applyFixtureChatLifecycle(conversation, patch)
      : (await api<{ conversation: ConversationSummary }>(
          `/api/spaces/${targetSpace.id}/conversations/${conversation.id}`,
          { method: "PATCH", body: patch },
        )).conversation;
    replaceConversationSummary(targetSpace.id, updated);

    const lifecycle = conversationLifecycleView(updated);
    const openTab = tabs.surfaceTabs.find((tab) =>
      tab.kind === "chat"
      && tab.spaceId === targetSpace.id
      && tab.conversationId === conversation.id);
    if (lifecycle !== "active") {
      if (openTab) tabs.closeSurfaceTab(openTab.id);
      chatActivity.setRunning(chatActivityKey(targetSpace.id, conversation.id), false);
      chatActivity.setAttention(chatActivityKey(targetSpace.id, conversation.id), false);
    }
    if (options.announce === false) return updated;

    const feedback = chatLifecycleFeedback(previous, updated);
    showToast({
      text: feedback.text,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: () => {
        const latest = (conversationGroups[targetSpace.id] ?? []).find((item) => item.id === conversation.id) ?? updated;
        void updateChatLifecycle(targetSpace, latest, feedback.undo, { announce: false })
          .then((restored) => { if (openTab) openChat(targetSpace, restored); })
          .catch((caught) => onError(errorText(caught)));
      },
    });
    return updated;
  }

  function selectRailMode(mode: SpaceRailMode): void {
    setActiveMode(mode);
    if (mode.startsWith("app:restricted:")) return;
    const surfaceKey = extensionSurfaceIdForMode(mode);
    if (!surfaceKey) return;
    const surface = resolveSurfaceForKey(surfaces, surfaceKey);
    const firstView = surface?.views[0];
    if (!surface || !firstView) return;
    const activeMatches = activeTab?.kind === "extension" && surfaceMatchesTab(surface, activeTab);
    if (!activeMatches) tabs.openExtensionSurfaceTab(space, surface, firstView);
  }

  function openInstalledRestrictedApp(targetSpace: SpaceSummary, app: RestrictedAppInstalled): void {
    restrictedAppsState.upsertApp(app);
    if (targetSpace.id !== space.id) onSwitchSpace(targetSpace);
    setActiveMode(restrictedAppRailMode(targetSpace.id, app.manifest.id));
  }

  function updateSurfaceCatalog(targetSpaceId: string, catalog: AgentCatalog): void {
    setSurfaceCatalogs((current) => ({ ...current, [targetSpaceId]: catalog.surfaces ?? [] }));
  }

  const commands = useMemo<CommandPaletteCommand[]>(() => [
    ...(["files", "chats", "history"] as SpacePane[]).map((mode) => ({ id: `go:${mode}`, groupId: "go-to" as const, groupLabel: "Go to", label: mode[0]!.toUpperCase() + mode.slice(1), defaultVisible: true, run: () => selectRailMode(mode) })),
    { id: "go:library", groupId: "go-to" as const, groupLabel: "Go to", label: "Library", detail: "Reusable personal files", defaultVisible: true, run: () => openLibrary(space) },
    { id: "go:assistant-tools", groupId: "go-to" as const, groupLabel: "Go to", label: "Assistant tools", detail: "Installed Skills, Extensions, and apps", defaultVisible: true, run: () => tabs.openAssistantToolsSurfaceTab(space, "installed") },
    ...(checks.status?.configured ? [{ id: "go:checks", groupId: "go-to" as const, groupLabel: "Go to", label: "Checks", detail: checks.status.needsAttention ? `${checks.status.needsAttention} need attention` : "Designated file expectations", defaultVisible: true, run: () => tabs.openChecksSurfaceTab(space) }] : []),
    { id: "action:discover-assistant-tools", groupId: "actions" as const, groupLabel: "Actions", label: "Browse Skills & Extensions", keywords: ["capabilities", "discover", "install", "tools"], run: () => tabs.openAssistantToolsSurfaceTab(space, "discover") },
    ...surfaces.map((surface) => ({ id: `app:${surface.key}`, groupId: "go-to" as const, groupLabel: "Go to", label: surface.title, detail: surface.scope === "project" ? "Pi Extension · This Space" : "Pi Extension · Personal", run: () => selectRailMode(`app:${surface.key}`) })),
    ...restrictedApps.map((app) => ({ id: `restricted-app:${app.manifest.id}`, groupId: "go-to" as const, groupLabel: "Go to", label: app.manifest.title, detail: "Sandboxed app · This Space", run: () => selectRailMode(restrictedAppRailMode(space.id, app.manifest.id)) })),
    ...spaces.map((item) => ({ id: `space:${item.id}`, groupId: "switch-space" as const, groupLabel: "Switch Space", label: item.name, detail: spaceHeaderSourceBadgeLabel(item), matchTargets: [item.rootPath], run: () => onSwitchSpace(item) })),
    ...Object.entries(conversationGroups).flatMap(([spaceId, conversations]) => conversations.map((conversation) => {
      const lifecycle = conversationLifecycleView(conversation);
      return {
        id: `chat:${spaceId}:${conversation.id}`,
        groupId: "chats" as const,
        groupLabel: "Chats",
        label: conversation.title,
        detail: lifecycle === "archived" ? "Archived" : lifecycle === "snoozed" ? "Snoozed" : undefined,
        run: () => { const target = spaces.find((item) => item.id === spaceId); if (target) openChat(target, conversation); },
      };
    })),
    ...collectLoadedFileEntries(tree.tree).flatMap((entry) => {
      const matchTargets = [entry.name, entry.path];
      return [
        { id: `reveal-file:${space.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Reveal in Files: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => { setActiveMode("files"); tree.setSelectedPath(entry.path); tabs.openFileSurfaceTab(space, entry.path); } },
        { id: `attach-file:${space.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Attach to Chat: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => attachToChat(entry.path) },
      ];
    }),
    { id: "action:new-chat", groupId: "actions", groupLabel: "Actions", label: "New Chat", keywords: ["chat", "conversation", "assistant"], defaultVisible: true, run: () => openChat(space, null) },
    ...(!fixture ? [{ id: "action:save-restore-point", groupId: "actions" as const, groupLabel: "Actions", label: "Save restore point", keywords: ["history", "checkpoint", "backup"], defaultVisible: true, run: () => { void saveRestorePoint(); } }] : []),
    { id: "action:new-space", groupId: "actions", groupLabel: "Actions", label: "Create a new Space", defaultVisible: true, run: onCreateSpace },
    { id: "action:open-folder", groupId: "actions", groupLabel: "Actions", label: "Turn a folder into a Space", defaultVisible: true, run: onOpenFolder },
    { id: "action:settings", groupId: "actions", groupLabel: "Actions", label: "Settings", defaultVisible: true, run: onOpenSettings },
    { id: "action:shortcuts", groupId: "actions", groupLabel: "Actions", label: "Keyboard shortcuts", run: onOpenShortcuts },
    ...(["light", "dark", "system"] as AppThemePreference[]).map((preference) => ({ id: `theme:${preference}`, groupId: "actions" as const, groupLabel: "Actions", label: preference === "system" ? "Use device theme" : `Use ${preference} theme`, detail: themePreference === preference ? "Current" : undefined, keywords: ["appearance", "color", "mode"], run: () => onThemePreferenceChange(preference) })),
  ], [checks.status, conversationGroups, fixture, restrictedApps, surfaces, themePreference, tree.selectedPath, tree.tree, spaces, space.id]);

  const layoutStyle = { ...(spaceIdentityStyle(identity)), ...(paneResize.sidebarWidth ? { "--space-sidebar-width": `${paneResize.sidebarWidth}px` } : {}) } as CSSProperties;

  return <main className={paneResize.sidebarResizing ? "space-layout resizing" : "space-layout"} ref={paneResize.spaceLayoutRef} style={layoutStyle}>
    <SpaceModeRail activeMode={activeMode} space={space} surfaces={surfaces} apps={restrictedApps} onModeChange={selectRailMode} onOpenLibrary={() => openLibrary(space)} onOpenAssistantTools={(view) => tabs.openAssistantToolsSurfaceTab(space, view)} onBuildApp={() => openChat(space, null)} accountControl={<button className="space-rail-account-button" type="button" onClick={() => onOpenSettings()} aria-label="Settings" data-rail-tooltip="Settings"><Settings24Regular aria-hidden="true" /></button>} onOpenKeyboardShortcuts={onOpenShortcuts} updateControl={updateStatus && updateNeedsAttention(updateStatus) ? <DesktopUpdateButton status={updateStatus} onClick={onUpdateAction} /> : undefined} />
    <section className={`space-mode-pane space-mode-pane-${activeMode}`} id="space-file-panel">
      <SpacePaneHeader space={space} identity={identity} spaces={spaces} spaceCustomizations={customizations} onSwitchSpace={onSwitchSpace} onCreateSpace={onCreateSpace} onOpenFolder={onOpenFolder} onManageSpaces={() => setActiveMode("spaces")} managingSpaces={activeMode === "spaces"} action={activeMode === "files" ? <button className="minimal-icon-button" type="button" disabled={uploadingFiles || tree.status === "refreshing"} onClick={() => void tree.refresh(false)} aria-label="Refresh files" title="Refresh files"><ArrowSync16Regular className={tree.status === "refreshing" ? "spin" : undefined} /></button> : undefined} />
      {activeMode === "spaces" ? <SpacesPane space={space} spaces={spaces} identities={customizations} onSwitch={onSwitchSpace} onCreate={onCreateSpace} onOpenFolder={onOpenFolder} onCustomize={(target) => tabs.openAppearanceSurfaceTab(target)} onRename={renameSpace} onRemove={(target) => void removeSpace(target)} /> : null}
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
          <ChecksToolbarButton status={checks.status} loading={checks.loading} unavailable={checks.unavailable} onClick={() => tabs.openChecksSurfaceTab(space)} />
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
          {tree.status === "loading" ? <FileTreeLoadingState /> : tree.status === "error" ? <EmptyInline text="Couldn't load this Space. Refresh to try again." /> : <FileTree entries={tree.visibleEntries} collapsedPaths={tree.query ? new Set() : tree.collapsedPaths} loadingFolderPaths={tree.loadingFolderPaths} selectedPath={tree.selectedPath} movingTreePath={tree.movingTreePath} dropTargetFolderPath={tree.dropTargetFolderPath} checkAttentionPaths={checks.attentionPaths} searchQuery={tree.query} emptyText={tree.query ? "No file or folder names match." : undefined} onToggleFolder={tree.toggleFolder} onSelectFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(space, path); }} onPreviewFile={isMacOS() ? previewLocalFile : undefined} onOpenFile={(path) => void openLocalPath(path, "open")} onOpenContextMenu={openContextMenu} onUpdateDropTarget={updateDropTarget} onDropOnTarget={dropOnTarget} onNativeDragStartFile={startNativeFileDrag} onDragStartEntry={startTreeDrag} onDragEndEntry={endTreeDrag} />}
        </div>
        {fixture ? null : (
          <FileContentSearch
            spaceId={space.id}
            query={tree.query}
            onOpenFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(space, path); }}
          />
        )}
      </div> : null}
      {activeMode === "chats" ? <ChatsPane space={space} spaces={spaces} conversations={conversationGroups} customizations={customizations} activityStatuses={chatActivity.statuses} activeConversationId={activeTab?.kind === "chat" ? activeTab.conversationId ?? undefined : undefined} onOpen={(target, conversation) => openChat(target, conversation)} onNew={(target) => openChat(target, null)} onActions={openChatActions} /> : null}
      {activeMode === "history" ? <HistoryPane space={space} fixtureItems={fixture?.checkpoints[space.id]} refreshRequest={historyRefreshRequest} onOpen={(item) => tabs.openHistorySurfaceTab(space, item.checkpointId, item.label || "Restore point")} onError={onError} /> : null}
      {activeSurface ? <ExtensionSurfacePane surface={activeSurface} activeViewId={activeTab?.kind === "extension" && surfaceMatchesTab(activeSurface, activeTab) ? activeTab.viewId : null} onOpenView={(view) => tabs.openExtensionSurfaceTab(space, activeSurface, view)} /> : null}
      {activeRestrictedApp ? <RestrictedAppViewport app={activeRestrictedApp} placement="navigator" route="/" active /> : null}
    </section>
    <button className="space-resizer" type="button" role="separator" aria-label="Resize the navigation pane and work area" aria-controls="space-file-panel space-chat-panel" aria-orientation="vertical" aria-valuemin={Math.round(paneResize.sidebarResizeBounds.min)} aria-valuemax={Math.round(paneResize.sidebarResizeBounds.max)} aria-valuenow={paneResize.sidebarResizeValue} title="Resize panes" onPointerDown={paneResize.startSidebarResize} onDoubleClick={paneResize.resetSpaceSidebarWidth} onKeyDown={paneResize.handleSidebarResizeKeyDown}><span className="sr-only">Resize panes</span></button>
    <aside className="right-rail" id="space-chat-panel">
      <SpaceSurfaceTabBar tabs={tabs.surfaceTabs} spaces={spaces} spaceCustomizations={customizations} conversations={conversationGroups} chatActivityStatuses={chatActivity.statuses} activeTabId={tabs.activeSurfaceTabId} newChatSpaceId={space.id} onActivate={tabs.setActiveSurfaceTabId} onClose={tabs.closeSurfaceTab} onNewChatInSpace={(target) => openChat(target, null)} onChatActions={openChatActions} />
      {tabs.surfaceTabs.length ? tabs.surfaceTabs.map((tab) => {
        const targetSpace = spaces.find((item) => item.id === tab.spaceId);
        if (!targetSpace) return null;
        const active = tab.id === tabs.activeSurfaceTabId;
        const targetIdentity = spaceIdentityFor(targetSpace, customizations);
        const targetConversation = tab.kind === "chat" && tab.conversationId
          ? conversationGroups[targetSpace.id]?.find((conversation) => conversation.id === tab.conversationId) ?? null
          : null;
        const targetConversationLifecycle = targetConversation ? conversationLifecycleView(targetConversation) : "active";
        return (
          <div className="space-surface-body" role="tabpanel" id={surfacePanelDomId(tab.id)} aria-labelledby={surfaceTabDomId(tab.id)} hidden={!active} key={tab.id} style={spaceIdentityStyle(targetIdentity)}>
            {tab.kind === "file" && tab.path ? (
              <FileDetailsPane space={targetSpace} path={tab.path} entry={targetSpace.id === space.id ? findTreeEntry(tree.tree, tab.path) : null} fixtureMode={Boolean(fixture)} onOpenLocal={(path, action) => openLocalPath(path, action, targetSpace)} onAddToChatContext={attachToChat} onShowVersionHistory={(path) => openVersionHistory(targetSpace, path)} onRename={targetSpace.id === space.id ? renameEntry : undefined} />
            ) : tab.kind === "library" ? (
              <LibraryPane
                space={targetSpace}
                spaces={spaces}
                tree={libraryTree}
                fixtureMode={Boolean(fixture)}
                destinationResetRequest={libraryOpenRequests[targetSpace.id] ?? 0}
                onRefresh={refreshLibraryTree}
                onError={onError}
              />
            ) : tab.kind === "assistant-tools" ? (
              <CapabilitiesPane
                space={targetSpace}
                status={agent}
                view={tab.view}
                fixtureMode={Boolean(fixture)}
                restrictedApps={restrictedAppsState.appsBySpace[targetSpace.id] ?? []}
                restrictedAppsLoading={restrictedAppsState.loadingSpaceIds.has(targetSpace.id)}
                onViewChange={(view) => tabs.openAssistantToolsSurfaceTab(targetSpace, view)}
                onOpenSettings={() => onOpenSettings("assistant")}
                onError={onError}
                onCatalogChanged={(catalog) => updateSurfaceCatalog(targetSpace.id, catalog)}
                onRestrictedAppChanged={restrictedAppsState.upsertApp}
                onRestrictedAppRemoved={(appId) => restrictedAppsState.removeApp(targetSpace.id, appId)}
                onBuildApp={() => openChat(targetSpace, null)}
                onOpenAppStudio={(sourceSpaceId) => tabs.openAppStudioSurfaceTab(spaces.find((item) => item.id === sourceSpaceId) ?? targetSpace)}
              />
            ) : tab.kind === "checks" ? (
              <ChecksPane
                space={targetSpace}
                active={active}
                onOpenFile={(path) => {
                  if (targetSpace.id === space.id) {
                    setActiveMode("files");
                    tree.setSelectedPath(path);
                  }
                  tabs.openFileSurfaceTab(targetSpace, path);
                }}
                onChecksChanged={() => targetSpace.id === space.id ? checks.refresh() : undefined}
              />
            ) : tab.kind === "app-studio" ? (
              <AppStudioPane
                space={targetSpace}
                spaces={spaces}
                active={active}
                previewRevision={(restrictedAppsState.appsBySpace[targetSpace.id] ?? [])
                  .filter((app) => app.runtimeInstanceKind === "development")
                  .map((app) => `${app.featureInstallationId}:${app.digest}:${app.updatedAt}`)
                  .sort()
                  .join("|")}
                fixtureMode={Boolean(fixture)}
                onAppsChanged={(spaceId, runtimeInstanceId, apps) => {
                  restrictedAppsState.replaceRuntimeInstanceApps(spaceId, runtimeInstanceId, apps);
                  void restrictedAppsState.refresh(spaceId);
                }}
                onError={onError}
              />
            ) : tab.kind === "appearance" ? (
              <div className="space-appearance-surface professional-appearance-surface">
                <div className="space-appearance-surface-heading">
                  <span className="space-appearance-surface-icon" aria-hidden="true"><Color20Regular /></span>
                  <div><h2>Customize {targetSpace.name}</h2><p>Give this Space a recognizable identity without changing the rest of work-fold.</p></div>
                </div>
                <SpaceAppearancePanel
                  space={targetSpace}
                  identity={targetIdentity}
                  customization={customizations[targetSpace.id]}
                  canUndo={(appearanceHistoryRef.current.get(targetSpace.id)?.length ?? 0) > 0}
                  onCustomizeSpace={customizeSpace}
                  onReplaceSpace={replaceSpaceCustomization}
                  onUndoSpace={undoSpaceCustomization}
                  onResetSpace={resetSpaceCustomization}
                />
              </div>
            ) : tab.kind === "history" ? (
              <HistoryPane space={targetSpace} fixtureItems={fixture?.checkpoints[targetSpace.id]} refreshRequest={targetSpace.id === space.id ? historyRefreshRequest : 0} selectedCheckpointId={tab.checkpointId} onOpen={(item) => tabs.openHistorySurfaceTab(targetSpace, item.checkpointId, item.label || "Restore point")} onError={onError} />
            ) : tab.kind === "extension" ? (() => {
              const targetSurfaceInventoryKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, targetSpace.id);
              if (!targetSurfaceInventoryKnown) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app view" text="Checking the tools installed for this Space." />;
              const targetSurfaces = contributedSurfaces(targetSpace.id, surfaceCatalogs[targetSpace.id] ?? []);
              const surface = targetSurfaces.find((item) => surfaceMatchesTab(item, tab));
              const view = surface?.views.find((item) => item.id === tab.viewId);
              return surface && view ? <ExtensionSurfaceView surface={surface} view={view} /> : <ExtensionSurfaceUnavailable surfaceId={tab.surfaceId} viewId={tab.viewId} execution={tab.surfaceExecution} />;
            })() : tab.kind === "restricted-app" ? (() => {
              if (!restrictedAppsState.knownSpaceIds.has(targetSpace.id)) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app" text="Checking the sandboxed apps installed for this Space." />;
              const app = restrictedAppsState.appsBySpace[targetSpace.id]?.find((item) => item.manifest.id === tab.appId && item.digest === tab.digest);
              return app
                ? <RestrictedAppViewport app={app} placement="tab" appTabId={tab.appTabId} route={tab.route} state={tab.state} active={active} />
                : <CenteredState icon={<AlertTriangle size={24} />} title="App unavailable" text="This tab belongs to an app revision that is no longer installed in this Space." />;
            })() : tab.kind === "chat" ? (
              <ChatPanel surfaceTabId={tab.id} space={targetSpace} spaceCustomizations={customizations} active={active} targetConversationId={tab.conversationId ?? null} lifecycleView={targetConversationLifecycle} onResumeConversation={targetConversation ? () => updateChatLifecycle(targetSpace, targetConversation, targetConversationLifecycle === "archived" ? { archived: false } : { snoozedUntil: null }).then(() => {}).catch((caught) => onError(errorText(caught))) : undefined} contextPathRequest={chatContextRequestForTab(contextRequest, targetSpace.id, tab.id)} onAddPathToChatContext={active && targetSpace.id === space.id ? attachToChat : undefined} onUploadDroppedFiles={active && targetSpace.id === space.id ? uploadDroppedFilesForChat : undefined} onOpenSpaceFile={active && targetSpace.id === space.id ? (path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(space, path); } : undefined} selectedPath={active && targetSpace.id === space.id ? tree.selectedPath : null} onConversationActivated={(conversation) => tabs.handleTabConversationActivated(tab.id, targetSpace, conversation)} onConversationsChanged={(conversations) => setConversationGroups((current) => ({ ...current, [targetSpace.id]: conversations }))} onRunningChange={(conversationId, running) => chatActivity.setRunning(chatActivityKey(targetSpace.id, conversationId), running)} onSettled={(conversationId, needsAttention) => chatActivity.setAttention(chatActivityKey(targetSpace.id, conversationId), needsAttention)} onViewed={(conversationId) => chatActivity.setAttention(chatActivityKey(targetSpace.id, conversationId), false)} onAgentFinished={() => targetSpace.id === space.id ? tree.refresh() : undefined} onRestrictedAppProposalRequested={() => tabs.setActiveSurfaceTabId(tab.id)} onRestrictedAppInstalled={(app) => openInstalledRestrictedApp(targetSpace, app)} fixtureMode={Boolean(fixture)} fixtureConversations={fixture && (tab.conversationId || tab.id === `chat:${targetSpace.id}:new`) ? fixture.conversations[targetSpace.id] : undefined} fixtureTreeEntries={fixture?.trees[targetSpace.id]} />
            ) : null}
          </div>
        );
      }) : <SpaceSurfaceEmptyState space={space} identity={identity} onNewChat={() => openChat(space, null)} />}
    </aside>
    {fileContextMenu ? <FileContextMenu state={fileContextMenu} onSelect={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(space, path); }} onOpenLocal={openLocalPath} onAddToChatContext={attachToChat} onCopyPath={copyPath} onShowVersionHistory={(path) => openVersionHistory(space, path)} onRename={fileContextMenu.entry.path ? renameEntry : undefined} onUploadHere={chooseUpload} onDelete={deleteEntry} onClose={() => setFileContextMenu(null)} /> : null}
    {renameEntryRequest ? <TextInputModal title={`Rename ${renameEntryRequest.name}`} description="Choose a new name. The item stays in the same folder." label="Name" initialValue={renameEntryRequest.name} confirmLabel="Rename" onSubmit={submitEntryRename} onClose={() => setRenameEntryRequest(null)} /> : null}
    {chatActions ? <ChatActionsPopover state={chatActions} onRename={renameChat} onLifecycle={(target, conversation, patch) => updateChatLifecycle(target, conversation, patch).then(() => {})} onClose={() => setChatActions(null)} /> : null}
    {versionHistory ? <FileVersionHistoryModal space={versionHistory.space} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void tree.refresh()} /> : null}
    {commandPaletteOpen ? <CommandPaletteHost commands={commands} onClose={closeCommandPalette} /> : null}
  </main>;
}

function SpaceSurfaceEmptyState({ space, identity, onNewChat }: { space: SpaceSummary; identity: ReturnType<typeof spaceIdentityFor>; onNewChat: () => void }) {
  return <div className="space-surface-body space-surface-body-empty"><div className="space-surface-empty" style={spaceIdentityStyle(identity)}><span className="space-surface-empty-icon"><SpaceIconGlyph icon={identity.Icon} size={24} /></span><h2>{space.name}</h2><p>Open a file, Chat, Library, restore point, or appearance tab here.</p><button className="primary-button" type="button" onClick={onNewChat}><CirclePlus size={16} />New Chat</button></div></div>;
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
  if (status.phase === "available") return `Download work-fold ${status.availableVersion ?? "update"}`;
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading update" : `Downloading update · ${Math.round(status.progressPercent)}%`;
  if (status.phase === "ready") return `Restart and install work-fold ${status.availableVersion ?? "update"}`;
  if (status.phase === "installing") return "Restarting to install update";
  if (status.phase === "error") return "Retry update";
  if (status.phase === "not_available") return "work-fold is up to date";
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

function pendingDeleteKey(pending: Pick<PendingDelete, "spaceId" | "path">) {
  return `${pending.spaceId}:${pending.path}`;
}

async function deleteLocalFileRequest(pending: PendingDelete, keepalive = false) {
  const sessionHeaders = await window.workFoldDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(`/api/spaces/${pending.spaceId}/local-file`), {
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

function fixtureConversationGroups(fixture: SpaceUiFixture): Record<string, ConversationSummary[]> { return Object.fromEntries(Object.entries(fixture.conversations).map(([id, conversations]) => [id, conversations.map(({ messages: _messages, ...summary }) => summary)])); }
function normalizeMode(value: string | null): SpaceRailMode {
  if (value === "space" || value === "spaces") return "files";
  if (value === "library" || value === "capabilities" || value === "skills" || value === "extensions") return "files";
  if (value?.startsWith("app:") && /^[a-z0-9][a-z0-9:_-]{0,255}$/i.test(value.slice(4))) return value as SpaceRailMode;
  return (["files", "chats", "history"] as SpaceRailMode[]).includes(value as SpaceRailMode) ? value as SpaceRailMode : "files";
}

function extensionSurfaceIdForMode(mode: SpaceRailMode): string | null {
  return mode.startsWith("app:") && !mode.startsWith("app:restricted:") ? mode.slice(4) : null;
}

function useThemePreference(): [AppTheme, AppThemePreference, (value: AppThemePreference) => void] {
  const [preference, setPreference] = useState<AppThemePreference>(() => { if (fixtureRequested) return "light"; const value = readStoredValue(themePreferenceKey); return value === "light" || value === "dark" || value === "system" ? value : "dark"; });
  const [system, setSystem] = useState<AppTheme>(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const theme = preference === "system" ? system : preference;
  useEffect(() => { const media = window.matchMedia?.("(prefers-color-scheme: dark)"); if (!media) return; const change = () => setSystem(media.matches ? "dark" : "light"); media.addEventListener("change", change); return () => media.removeEventListener("change", change); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; window.workFoldDesktop?.window.setTheme(theme, preference); if (!fixtureRequested) writeStoredValue(themePreferenceKey, preference); }, [preference, theme]);
  return [theme, preference, setPreference];
}

function useTypographyPreference(): [AppTypographyPreference, (update: Partial<AppTypographyPreference>) => void] {
  const [value, setValue] = useState<AppTypographyPreference>(() => fixtureRequested ? defaultTypographyPreference : readStoredJsonValue(typographyPreferenceKey, (raw) => { const record = raw as Partial<AppTypographyPreference>; const font = typographyFontValues.includes(record.font as AppTypographyFont) ? record.font as AppTypographyFont : defaultTypographyPreference.font; return { font: typographyFontForPlatform(font), textSize: textSizeValues.includes(record.textSize as AppTypographyPreference["textSize"]) ? record.textSize as AppTypographyPreference["textSize"] : defaultTypographyPreference.textSize }; }, defaultTypographyPreference));
  useEffect(() => { document.documentElement.dataset.workFoldFont = value.font; document.documentElement.dataset.workFoldTextSize = value.textSize; if (!fixtureRequested) writeStoredJsonValue(typographyPreferenceKey, value); }, [value]);
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
    const desktopWindow = window.workFoldDesktop?.window;
    if (!desktopWindow) return;
    let cancelled = false;
    const apply = (color: string | null) => {
      if (!color) {
        document.documentElement.style.removeProperty("--space-accent");
        document.documentElement.style.removeProperty("--ui-accent");
        document.documentElement.style.removeProperty("--ui-accent-hover");
        document.documentElement.style.removeProperty("--ui-accent-soft");
      } else if (/^#[0-9a-f]{6}$/i.test(color)) {
        document.documentElement.style.setProperty("--space-accent", color);
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
