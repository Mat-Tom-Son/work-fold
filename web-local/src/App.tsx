import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Settings24Regular } from "@fluentui/react-icons";
import { AlertTriangle, CirclePlus, Download, FolderOpen, Loader2, Search, X } from "lucide-react";
import {
  accentIdentityFromHex,
  normalizeWorkFolderAppearanceCustomization,
  upgradeWorkFolderAppearanceCustomization,
  type WorkFolderAppearanceState,
} from "../../src/shared/work-folder-appearance";

import { productName, workFolderCustomizationStorageKey, workFolderPathDragType } from "./constants";
import { copyToClipboard } from "./lib/clipboard";
import { deleteFolderConfirm } from "./ui-contract";
import { ChatActionsPopover } from "./components/chat/ChatActionsPopover";
import { ChatPanel } from "./components/chat/ChatPanel";
import { WorkFolderSurfaceTabBar } from "./components/chat/WorkFolderSurfaceTabBar";
import { WorkFoldLoadingState } from "./components/brand/WorkFoldBrand";
import { Banner, CenteredState, EmptyInline, WorkFolderIconGlyph } from "./components/chrome/common";
import { DesktopTitleBar } from "./components/chrome/DesktopTitleBar";
import { CommandPaletteHost, type CommandPaletteCommand } from "./components/modals/CommandPaletteHost";
import { CreateWorkFolderModal } from "./components/modals/CreateWorkFolderModal";
import { DesktopSettingsModal, type SettingsPage } from "./components/modals/DesktopSettingsModal";
import { FileVersionHistoryModal } from "./components/modals/FileVersionHistoryModal";
import { SkillsExtensionsModal } from "./components/modals/SkillsExtensionsModal";
import { WorkFolderAppearanceModal, type WorkFolderAppearanceSection } from "./components/modals/WorkFolderAppearanceModal";
import { TextInputModal } from "./components/modals/TextInputModal";
import { NewFolderModal, type NewFolderTarget } from "./components/modals/NewFolderModal";
import { subscribeControlEvents } from "./lib/control-events";
import { OnboardingFlow } from "./components/onboarding/OnboardingFlow";
import { FileDetailsPane } from "./components/panes/FileDetailsPane";
import { ChecksPane, ChecksToolbarButton } from "./components/panes/ChecksPane";
import { AppStudioPane } from "./components/panes/AppStudioPane";
import { CapabilitiesPane } from "./components/panes/CapabilitiesPane";
import { WorkFolderAutomationsPane } from "./components/panes/WorkFolderAutomationsPane";
import { ExtensionSurfacePane, ExtensionSurfaceUnavailable, ExtensionSurfaceView } from "./components/panes/ExtensionSurface";
import { RestrictedAppViewport } from "./components/panes/RestrictedAppViewport";
import { WorkFolderModeRail, WorkFolderPaneHeader } from "./components/panes/workFolderChrome";
import { FileContentSearch } from "./components/panes/FileContentSearch";
import { ChatsPane, HistoryPane, WorkFoldersPane, type ModelScope } from "./components/panes/workFolderPanes";
import { FileContextMenu } from "./components/tree/FileContextMenu";
import { useSharedPages } from "./hooks/useSharedPages";
import { activeSharedPageFor, isShareablePath, sharedPathsForWorkFolder } from "./lib/page-sharing";
import { FileTree, FileTreeLoadingState } from "./components/tree/FileTree";
import type { WorkFolderUiFixture } from "./fixtures/work-folder-fixture";
import { useApplicationAppearance } from "./hooks/useApplicationAppearance";
import { WorkFolderAppearanceProvider, useWorkFolderIdentityResolver } from "./lib/work-folder-appearance-context";
import { usePaneResize } from "./hooks/usePaneResize";
import { useModelConfigurationRevision } from "./hooks/useModelConfigurationRevision";
import { useBootstrapRefresh } from "./hooks/useBootstrapRefresh";
import { folderActivityStatuses, useChatActivity } from "./hooks/useChatActivity";
import { useRestrictedApps } from "./hooks/useRestrictedApps";
import { useSurfaceTabs } from "./hooks/useSurfaceTabs";
import { useWorkFolderTree } from "./hooks/useWorkFolderTree";
import { useWorkFolderChecks } from "./hooks/useWorkFolderChecks";
import { useFolderAutomations } from "./hooks/useFolderAutomations";
import { api, apiForm, apiUrl, errorText } from "./lib/api";
import { chatActivityKey, conversationLifecycleView } from "./lib/chat-lifecycle";
import { appChangeDraft, chatContextRequestForTab, chatDraftRequestForTab } from "./lib/chat-context-request";
import { contributedSurfaces, resolveSurfaceForKey, surfaceMatchesTab } from "./lib/capability-surfaces";
import { canOpenDirectly, hasNativeFiles, hasWorkFolderPathDrag, nativeOpenLabel } from "./lib/file-actions";
import { chatDisplayTitle, formatItemCount } from "./lib/format";
import { readStoredJsonValue, writeStoredJsonValue } from "./lib/storage";
import { isMacOS, workFolderEntryNativePath } from "./lib/platform";
import { resolveRestrictedAppOpenRequest, restrictedAppRailMode, restrictedAppRailLabel } from "./lib/restricted-app-navigation";
import { getLocalAppStudio, getLocalAppWorkFolderRemovalImpact, prepareRestrictedAppChange } from "./lib/restricted-apps";
import { collectLoadedFileEntries, findTreeEntry, isInsideFolder, moveTreeEntry, removeTreeEntries } from "./lib/tree";
import { normalizeWorkFolderCustomizations } from "./lib/work-folder-customization";
import { workFolderIdentityFor, workFolderIdentityStyle } from "./lib/work-folder-identity";
import { childFolderPaths, combineActivityStatuses, descendantFolders, folderAncestors, folderTreeRows } from "./lib/folder-nesting";
import type { MentionFolderOption } from "./components/chat/FolderMentionMenu";
import { mentionNames } from "./lib/folder-mentions";
import { removeWorkFolderConfirmText, surfacePanelDomId, surfaceTabDomId, workFolderHeaderSourceBadgeLabel } from "./lib/work-folder-ui";
import type { AgentCatalog, AgentExtensionSurface, AppTheme, AppThemePreference, SkillsExtensionsView, BootstrapResponse, ChatActionsState, ChatContextPathRequest, ChatDraftRequest, ConversationSummary, DesktopUpdateStatus, FileContextMenuState, RestrictedAppInstalled, TreeEntry, WorkFolderCustomization, WorkFolderCustomizationMap, WorkFolderCustomizationPatch, WorkFolderPane, WorkFolderRailMode, WorkFolderSummary } from "./types";
import { ConfirmDialogHost, requestConfirm, showToast, ToastHost } from "./ui/feedback";
import { workFolderIconOptions } from "./work-folder-icons";

const fixtureRequested = new URLSearchParams(window.location.search).get("fixture") === "work-folder";
const supportedWorkFolderIconNames = new Set(workFolderIconOptions.flatMap((option) => [option.name, ...(option.aliases ?? [])]));

interface DroppedUploadFile { file: File; relativePath: string }
type DesktopActionCommand = "new-chat" | "reload-work-folder-state" | "open-capabilities" | "open-skills" | "open-extensions" | "open-command-palette" | "close-tab" | "customize-work-folder" | "app-change-chat" | "open-app-build-chat" | "open-app-result-file" | "open-app-studio";
/** A cross-cutting request handled by the open work-folder view; app navigation from Settings carries the app or Chat it names. */
type DesktopAction = { id: number; command: DesktopActionCommand | "open-checks"; workFolderId?: string; app?: RestrictedAppInstalled; conversationId?: string; runtimeInstanceId?: string; path?: string };
interface PendingDelete {
  workFolderId: string;
  path: string;
  name: string;
  selectedPath: string | null;
  deletedTabPaths: Set<string>;
}
/**
 * A delete always goes through (docs/receipts-not-gates.md, F20). `recently-deleted` is
 * present when History could not keep a copy of everything, so the entry is
 * waiting in Settings → Recently Deleted instead of being gone.
 */
interface DeleteLocalFileResult {
  recentlyDeleted?: { entryId: string; restoreBy: string; uncoveredCount: number };
}
interface WorkFolderChecksControl {
  workFolderId: string;
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

export function App() {
  const appearance = useApplicationAppearance({ fixtureMode: fixtureRequested });
  const theme = appearance.theme;
  const themePreference = appearance.preferences.mode;
  const setThemePreference = useCallback((mode: AppThemePreference) => appearance.store.update({ mode }), [appearance.store]);
  const [fixture, setFixture] = useState<WorkFolderUiFixture | null>(null);
  const [boot, setBoot] = useState<BootstrapResponse | null>(null);
  const [activeWorkFolderId, setActiveWorkFolderId] = useState(() => localStorage.getItem("work-fold.work-folder.active") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [createWorkFolderOpen, setCreateWorkFolderOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>("appearance");
  const [settingsModelScope, setSettingsModelScope] = useState<ModelScope | undefined>(undefined);
  const [settingsFocusAiModel, setSettingsFocusAiModel] = useState(false);
  const [settingsWorkerWorkFolderId, setSettingsWorkerWorkFolderId] = useState<string | undefined>();
  const [settingsFocusWorkerInstructions, setSettingsFocusWorkerInstructions] = useState(false);
  const [settingsBackAction, setSettingsBackAction] = useState<(() => void) | null>(null);
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
  const [modelConfigurationRevision, modelConfigurationChanged] = useModelConfigurationRevision(!fixtureRequested);
  const activeChecksControlRef = useRef<WorkFolderChecksControl | null>(null);
  const [pendingWorkFolderOpen, setPendingWorkFolderOpen] = useState<{ id: number; workFolderId: string; view?: "checks" } | null>(null);
  const [desktopAction, setDesktopAction] = useState<DesktopAction | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const handleRestrictedAppError = useCallback((caught: unknown) => setError(errorText(caught)), []);
  // Installed apps live above the work-folder view so Settings → Apps and the rail read one list.
  const restrictedAppsState = useRestrictedApps({ activeWorkFolderId: boot ? activeWorkFolderId : "", workFolders: boot?.workFolders, fixtureMode: Boolean(fixture), onError: handleRestrictedAppError });
  const showDesktopTitleBar = window.workFoldDesktop?.app.platform === "win32";

  const openSettings = useCallback((page: SettingsPage = "appearance", modelScope?: ModelScope, focusAiModel = false, workerWorkFolderId?: string, focusWorkerInstructions = false, backToCustomization?: () => void) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settingsReturnFocusRef.current = focused && focused !== document.body && !focused.closest(".modal-backdrop")
      ? focused : document.querySelector<HTMLButtonElement>(".work-folder-pane-switch-trigger");
    setSettingsInitialPage(page);
    setSettingsModelScope(page === "ai-models" ? modelScope : undefined);
    setSettingsFocusAiModel(page === "ai-models" && focusAiModel);
    setSettingsWorkerWorkFolderId(page === "ai-models" ? workerWorkFolderId : undefined);
    setSettingsFocusWorkerInstructions(page === "ai-models" && focusWorkerInstructions);
    setSettingsBackAction(() => backToCustomization ?? null);
    setSettingsOpen(true);
  }, []);
  const openKeyboardShortcuts = useCallback(() => openSettings("shortcuts"), [openSettings]);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsBackAction(null);
    const target = settingsReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (target?.isConnected && !target.inert) target.focus(); });
  }, []);
  const updateActiveChecksControl = useCallback((control: WorkFolderChecksControl | null) => {
    if (control || activeChecksControlRef.current?.workFolderId === activeWorkFolderId) {
      activeChecksControlRef.current = control;
    }
  }, [activeWorkFolderId]);

  useScrollbarActivity();

  const refreshBootstrap = useBootstrapRefresh(!fixtureRequested, (result) => {
    setBoot(result);
    setActiveWorkFolderId((current) => result.workFolders.some((item) => item.id === current) ? current : result.workFolders[0]?.id ?? "");
  }, setError);

  useEffect(() => {
    if (fixtureRequested) return;
    return subscribeControlEvents((hint) => {
      if (hint === "work-folders" || hint === "reset") void refreshBootstrap();
    });
  }, [refreshBootstrap]);

  useEffect(() => {
    if (fixtureRequested) {
      void import("./fixtures/work-folder-fixture").then(({ buildWorkFolderFixture }) => {
        const next = buildWorkFolderFixture(); setFixture(next); setBoot({ workFolders: next.workFolders, agent: next.agent }); setActiveWorkFolderId(next.activeWorkFolderId);
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

  const activeWorkFolder = useMemo(() => boot?.workFolders.find((item) => item.id === activeWorkFolderId) ?? boot?.workFolders[0] ?? null, [activeWorkFolderId, boot]);
  useEffect(() => {
    if (!fixtureRequested && boot) {
      if (activeWorkFolder) localStorage.setItem("work-fold.work-folder.active", activeWorkFolder.id);
      else localStorage.removeItem("work-fold.work-folder.active");
    }
    if (activeWorkFolder) setActiveWorkFolderId(activeWorkFolder.id);
  }, [activeWorkFolder?.id, Boolean(boot)]);
  useEffect(() => {
    if (fixtureRequested) return;
    let cancelled = false;
    void window.workFoldDesktop?.workFolder.setActiveWorkFolder?.(activeWorkFolder?.id ?? null).catch(async (caught) => {
      if (cancelled) return;
      const current = await refreshBootstrap();
      if (!cancelled && (!activeWorkFolder || !current || current.workFolders.some((item) => item.id === activeWorkFolder.id))) setError(errorText(caught));
    });
    return () => { cancelled = true; };
  }, [activeWorkFolder?.id, activeWorkFolder?.name, activeWorkFolder?.workFolderRoot]);
  useEffect(() => {
    const desktopWorkFolder = window.workFoldDesktop?.workFolder;
    if (!desktopWorkFolder?.onOpenWorkFolder || !boot) return;
    return desktopWorkFolder.onOpenWorkFolder((workFolderId, view) => {
      setPendingWorkFolderOpen({ id: Date.now(), workFolderId, view });
      if (!boot.workFolders.some((workFolder) => workFolder.id === workFolderId)) void refreshBootstrap();
    });
  }, [boot?.workFolders, refreshBootstrap]);
  useEffect(() => {
    if (!pendingWorkFolderOpen || !boot?.workFolders.some((workFolder) => workFolder.id === pendingWorkFolderOpen.workFolderId)) return;
    setActiveWorkFolderId(pendingWorkFolderOpen.workFolderId);
    if (pendingWorkFolderOpen.view === "checks") setDesktopAction({ id: pendingWorkFolderOpen.id, command: "open-checks" });
    setPendingWorkFolderOpen(null);
  }, [pendingWorkFolderOpen, boot?.workFolders]);
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
    menu.setState({ workFolderOpen: Boolean(activeWorkFolder) });
    return menu.onCommand((command) => {
      if (command === "new-work-folder") setCreateWorkFolderOpen(true);
      else if (command === "open-local-folder") void openFolder();
      else if (command === "check-for-updates") void checkForUpdates();
      else if (command === "open-settings") openSettings();
      else if (command === "open-about") openSettings("about");
      else if (command === "open-keyboard-shortcuts") openKeyboardShortcuts();
      else if (command === "new-chat" || command === "reload-work-folder-state" || command === "open-capabilities" || command === "open-skills" || command === "open-extensions" || command === "open-command-palette" || command === "close-tab") {
        setDesktopAction({ id: Date.now(), command });
      }
    });
  }, [activeWorkFolder?.id, openKeyboardShortcuts, openSettings, refreshBootstrap]);
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
  useEffect(() => window.workFoldDesktop?.agent.onOpenSettings((scope) => openSettings("ai-models", scope, true)), [openSettings]);

  async function createWorkFolder(name: string) {
    if (fixtureRequested) { setCreateWorkFolderOpen(false); showToast({ text: "work-folder creation is disabled in the preview", tone: "info" }); return; }
    const checksControl = activeChecksControlRef.current;
    try {
      await checksControl?.suspend();
      const result = await api<{ workFolder: WorkFolderSummary }>("/api/work-folders", { method: "POST", body: { name } });
      await refreshBootstrap(); setActiveWorkFolderId(result.workFolder.id); setCreateWorkFolderOpen(false);
    } finally {
      void checksControl?.resume();
    }
  }

  async function openFolder() {
    const picker = window.workFoldDesktop?.workFolder;
    if (!picker) return setError("Folder selection is available in the desktop app.");
    let checksControl: WorkFolderChecksControl | null = null;
    try {
      const selected = await picker.chooseFolder(); if (!selected) return;
      checksControl = activeChecksControlRef.current;
      await checksControl?.suspend();
      const result = await api<{ workFolder: WorkFolderSummary }>("/api/work-folders/local-folder", { method: "POST", body: { workFolderRoot: selected.path, folderGrantId: selected.folderGrantId } });
      await refreshBootstrap(); setActiveWorkFolderId(result.workFolder.id);
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

  if (!boot || (fixtureRequested && !fixture)) return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>{showDesktopTitleBar ? <DesktopTitleBar /> : null}<WorkFoldLoadingState message={error ?? "Loading your work-folders and workers."} action={error ? <button className="ui-control" type="button" onClick={() => { setError(null); void refreshBootstrap(); }}>Try Again</button> : undefined} /></div>;

  return <div className={`app-shell${showDesktopTitleBar ? " desktop-chrome-shell" : ""}`} data-theme={theme}>
    {showDesktopTitleBar ? <DesktopTitleBar /> : null}
    {activeWorkFolder ? <WorkFolderAppearanceProvider palette={appearance.preferences.palette}><WorkFolderView workFolder={activeWorkFolder} workFolders={boot.workFolders} restrictedAppsStore={restrictedAppsState} agent={boot.agent} modelConfigurationRevision={modelConfigurationRevision} appearance={boot.appearance} fixture={fixture} desktopAction={desktopAction} updateStatus={updateStatus} themePreference={themePreference} onThemePreferenceChange={setThemePreference} onUpdateAction={() => void runUpdateAction()} onSwitchWorkFolder={(workFolder) => setActiveWorkFolderId(workFolder.id)} onRefreshBootstrap={refreshBootstrap} onCreateWorkFolder={() => setCreateWorkFolderOpen(true)} onOpenFolder={() => void openFolder()} onChecksControlChange={updateActiveChecksControl} onOpenSettings={openSettings} onOpenShortcuts={openKeyboardShortcuts} onError={setError} /></WorkFolderAppearanceProvider> : <OnboardingFlow onCreateWorkFolder={() => setCreateWorkFolderOpen(true)} onOpenFolder={() => void openFolder()} />}
    {error ? <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss"><X size={15} /></button></div> : null}
    {createWorkFolderOpen ? <CreateWorkFolderModal onClose={() => setCreateWorkFolderOpen(false)} onCreate={createWorkFolder} /> : null}
    {settingsOpen ? <DesktopSettingsModal appearance={appearance} onCustomizeWorkFolder={(workFolderId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "customize-work-folder", workFolderId }); }} workFolder={settingsWorkerWorkFolderId ? boot.workFolders.find((item) => item.id === settingsWorkerWorkFolderId) ?? null : activeWorkFolder} workFolders={boot.workFolders} restrictedApps={restrictedAppsState} onChangeApp={(app) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "app-change-chat", workFolderId: app.sourceWorkFolderId, app }); }} onOpenAppBuildChat={(workFolderId, conversationId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-build-chat", workFolderId, conversationId }); }} onOpenAppResultFile={(workFolderId, path) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-result-file", workFolderId, path }); }} onOpenAppStudio={(workFolderId, runtimeInstanceId) => { setSettingsOpen(false); setDesktopAction({ id: Date.now(), command: "open-app-studio", workFolderId, ...(runtimeInstanceId ? { runtimeInstanceId } : {}) }); }} agentStatus={boot.agent} fixtureMode={Boolean(fixture)} initialPage={settingsInitialPage} initialModelScope={settingsModelScope} focusAiModel={settingsFocusAiModel} focusWorkerInstructions={settingsFocusWorkerInstructions} onAgentConfigured={(agent) => setBoot((current) => current ? { ...current, agent } : current)} onModelChanged={modelConfigurationChanged} updateStatus={updateStatus} onUpdateAction={() => void runUpdateAction()} onBackToCustomization={settingsBackAction ? () => { setSettingsOpen(false); setSettingsBackAction(null); settingsBackAction(); } : undefined} onClose={closeSettings} /> : null}
    <ConfirmDialogHost /><ToastHost />
  </div>;
}

function WorkFolderView({ workFolder, workFolders, restrictedAppsStore, agent, modelConfigurationRevision, appearance, fixture, desktopAction, updateStatus, themePreference, onThemePreferenceChange, onUpdateAction, onSwitchWorkFolder, onRefreshBootstrap, onCreateWorkFolder, onOpenFolder, onChecksControlChange, onOpenSettings, onOpenShortcuts, onError }: {
  workFolder: WorkFolderSummary;
  workFolders: WorkFolderSummary[];
  restrictedAppsStore: ReturnType<typeof useRestrictedApps>;
  agent: BootstrapResponse["agent"];
  modelConfigurationRevision: number;
  appearance?: WorkFolderAppearanceState;
  fixture: WorkFolderUiFixture | null;
  desktopAction: DesktopAction | null;
  updateStatus: DesktopUpdateStatus | null;
  themePreference: AppThemePreference;
  onThemePreferenceChange: (theme: AppThemePreference) => void;
  onUpdateAction: () => void;
  onSwitchWorkFolder: (workFolder: WorkFolderSummary) => void;
  onRefreshBootstrap: () => Promise<unknown>;
  onCreateWorkFolder: () => void;
  onOpenFolder: () => void;
  onChecksControlChange: (control: WorkFolderChecksControl | null) => void;
  onOpenSettings: (page?: SettingsPage, modelScope?: ModelScope, focusAiModel?: boolean, workerWorkFolderId?: string, focusWorkerInstructions?: boolean, backToCustomization?: () => void) => void;
  onOpenShortcuts: () => void;
  onError: (message: string | null) => void;
}) {
  const initialStoredModeRef = useRef(fixture ? null : localStorage.getItem("work-fold.work-folder.mode"));
  const [activeMode, setActiveMode] = useState<WorkFolderRailMode>(() => fixture ? "files" : normalizeMode(initialStoredModeRef.current));
  const legacyCustomizationsRef = useRef<WorkFolderCustomizationMap>(fixture ? {} : readStoredJsonValue(
    workFolderCustomizationStorageKey,
    (value) => normalizeWorkFolderCustomizations(value, undefined, supportedWorkFolderIconNames),
    {},
  ));
  const [customizations, setCustomizations] = useState<WorkFolderCustomizationMap>(() => fixture
    ? fixture.customizations
    : normalizeWorkFolderCustomizations(
      { ...legacyCustomizationsRef.current, ...(appearance?.customizations ?? {}) },
      undefined,
      supportedWorkFolderIconNames,
    ));
  const customizationsRef = useRef(customizations);
  const appearanceStorageWarningShownRef = useRef(false);
  const appearanceWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const appearanceHistoryRef = useRef(new Map<string, WorkFolderCustomization[]>());
  const [, setAppearanceHistoryVersion] = useState(0);
  customizationsRef.current = customizations;
  useEffect(() => {
    if (fixture || !Object.keys(legacyCustomizationsRef.current).length) return;
    let cancelled = false;
    appearanceWriteQueueRef.current = appearanceWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = await api<{ appearance: WorkFolderAppearanceState }>("/api/appearance/migrate", {
          method: "POST",
          body: { customizations: legacyCustomizationsRef.current },
        });
        legacyCustomizationsRef.current = {};
        localStorage.removeItem(workFolderCustomizationStorageKey);
        if (!cancelled) {
          customizationsRef.current = result.appearance.customizations;
          setCustomizations(result.appearance.customizations);
        }
      })
      .catch((caught) => {
        if (!cancelled && !appearanceStorageWarningShownRef.current) {
          appearanceStorageWarningShownRef.current = true;
          showToast({ text: `work-fold could not migrate the saved work-folder appearance. ${errorText(caught)}`, tone: "info" });
        }
      });
    return () => { cancelled = true; };
  }, [fixture]);
  const [conversationGroups, setConversationGroups] = useState<Record<string, ConversationSummary[]>>(() => fixture ? fixtureConversationGroups(fixture) : {});
  const [surfaceCatalogs, setSurfaceCatalogs] = useState<Record<string, AgentExtensionSurface[]>>(() => fixture ? fixture.surfaces : {});
  const surfaceCatalogRequestRef = useRef(0);
  const chatActivity = useChatActivity(Boolean(fixture));
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  // The native macOS file menu needs to know whether a file is already shared.
  const sharedPages = useSharedPages(Boolean(fixture));
  const sharedPaths = useMemo(() => sharedPathsForWorkFolder(sharedPages, workFolder.id), [sharedPages, workFolder.id]);
  const [renameEntryRequest, setRenameEntryRequest] = useState<{ path: string; name: string } | null>(null);
  const [newFolderTarget, setNewFolderTarget] = useState<NewFolderTarget | null>(null);
  const [chatActions, setChatActions] = useState<ChatActionsState | null>(null);
  const [versionHistory, setVersionHistory] = useState<{ workFolder: WorkFolderSummary; path: string; name: string } | null>(null);
  const [appearanceWorkFolderId, setAppearanceWorkFolderId] = useState<string | null>(null);
  const [appearanceInitialSection, setAppearanceInitialSection] = useState<WorkFolderAppearanceSection>("banner");
  const appearanceWorkFolder = workFolders.find((item) => item.id === appearanceWorkFolderId);
  const appearanceReturnFocusRef = useRef<HTMLElement | null>(null);
  const [contextRequest, setContextRequest] = useState<ChatContextPathRequest | null>(null);
  const [draftRequest, setDraftRequest] = useState<ChatDraftRequest | null>(null);
  const draftRequestId = useRef(0);
  const appChangeRequests = useRef(new Map<string, string>());
  const [appStudioNavigation, setAppStudioNavigation] = useState<{ id: string; sourceWorkFolderId: string; runtimeInstanceId: string } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const commandPaletteReturnFocusRef = useRef<HTMLElement | null>(null);
  const [historyRefreshRequest, setHistoryRefreshRequest] = useState(0);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadTargetPath, setUploadTargetPath] = useState("");
  const uploadRef = useRef<HTMLInputElement>(null);
  const contextRequestId = useRef(0);
  const pendingDeletesRef = useRef(new Map<string, PendingDelete>());
  const activeWorkFolderIdRef = useRef(workFolder.id);
  activeWorkFolderIdRef.current = workFolder.id;
  const tree = useWorkFolderTree(workFolder, onError, fixture?.trees[workFolder.id]);
  const selectedPathRef = useRef(tree.selectedPath);
  selectedPathRef.current = tree.selectedPath;
  const paneResize = usePaneResize(Boolean(fixture));
  const tabs = useSurfaceTabs({
    workFolder,
    workFolders,
    fixtureMode: Boolean(fixture),
    onSwitchWorkFolder,
  });
  useEffect(() => {
    function openResult(event: Event) {
      const { workFolderId, path } = (event as CustomEvent<{ workFolderId: string; path: string }>).detail;
      const target = workFolders.find((item) => item.id === workFolderId);
      if (target && typeof path === "string") tabs.openFileSurfaceTab(target, path);
    }
    window.addEventListener("work-fold:open-result-file", openResult);
    return () => window.removeEventListener("work-fold:open-result-file", openResult);
  }, [workFolders, tabs.openFileSurfaceTab]);
  // Background Worker turns (handoffs into nested work-folders, CLI sends) light
  // the same dots as open Chat tabs. The host sends a content-free hint on
  // every turn start and end; the renderer requeries the running set.
  const watchedChatKeysRef = useRef<Set<string>>(new Set());
  watchedChatKeysRef.current = new Set(tabs.surfaceTabs.flatMap((tab) => tab.kind === "chat" && tab.conversationId ? [chatActivityKey(tab.workFolderId, tab.conversationId)] : []));
  const conversationGroupsRef = useRef(conversationGroups);
  conversationGroupsRef.current = conversationGroups;
  useEffect(() => {
    if (fixture) return;
    let disposed = false;
    let timer: number | null = null;
    // Only the newest answer counts: an older response resolving late would
    // re-add a finished turn and leave its dot pulsing.
    let generation = 0;
    const upsertConversations = (workFolderId: string) => {
      void api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${workFolderId}/conversations`)
        .then(({ conversations }) => {
          if (disposed) return;
          setConversationGroups((current) => {
            // Merge by id: a Chat this window just created may not be on the
            // server's list yet and must not disappear.
            const fresh = new Map(conversations.map((chat) => [chat.id, chat]));
            const localOnly = (current[workFolderId] ?? []).filter((chat) => !fresh.has(chat.id));
            return { ...current, [workFolderId]: [...conversations, ...localOnly].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) };
          });
        })
        .catch(() => {});
    };
    const refreshActivity = () => {
      const request = ++generation;
      void api<{ running: Array<{ workFolderId: string; conversationId: string }> }>("/api/work-folders/activity").then(({ running }) => {
        if (disposed || request !== generation) return;
        const finished = chatActivity.syncBackgroundRunning(new Set(running.map((item) => chatActivityKey(item.workFolderId, item.conversationId))), (key) => watchedChatKeysRef.current.has(key));
        // A handed-off Chat is new to its work-folder's list, and a finished one has
        // a new title and time: refresh those work-folders' lists.
        const workFolderIds = new Set([
          ...running.filter((item) => !conversationGroupsRef.current[item.workFolderId]?.some((chat) => chat.id === item.conversationId)).map((item) => item.workFolderId),
          ...finished.map((key) => key.slice(0, key.indexOf(":"))),
        ]);
        for (const workFolderId of workFolderIds) if (workFolderId) upsertConversations(workFolderId);
      }).catch(() => {});
    };
    refreshActivity();
    const unsubscribe = subscribeControlEvents((hint) => {
      if (hint !== "activity" && hint !== "reset") return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; refreshActivity(); }, 120);
    });
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); unsubscribe(); };
  }, [fixture, chatActivity.syncBackgroundRunning]);
  // Once every work-folder's Chat list has loaded, a saved mark for a Chat or work-folder
  // that no longer exists is gone for good.
  useEffect(() => {
    if (fixture || !workFolders.length || workFolders.some((item) => !conversationGroups[item.id])) return;
    const known = new Set(workFolders.flatMap((item) => (conversationGroups[item.id] ?? []).map((chat) => chatActivityKey(item.id, chat.id))));
    chatActivity.pruneAttention((key) => !known.has(key) && !watchedChatKeysRef.current.has(key));
  }, [fixture, workFolders, conversationGroups, chatActivity.pruneAttention]);
  const folderStatuses = useMemo(() => folderActivityStatuses(chatActivity.statuses, conversationGroups), [chatActivity.statuses, conversationGroups]);
  const restrictedAppsState = restrictedAppsStore;
  const [skillsExtensionsView, setSkillsExtensionsView] = useState<SkillsExtensionsView | null>(null);
  const activeTab = tabs.surfaceTabs.find((tab) => tab.id === tabs.activeSurfaceTabId) ?? null;
  const checks = useWorkFolderChecks(workFolder, Boolean(fixture), activeTab?.kind !== "checks");
  const folderAutomations = useFolderAutomations(workFolder.id, Boolean(fixture));
  const hasFolderAutomations = (folderAutomations.byWorkFolder[workFolder.id]?.length ?? 0) > 0;
  useEffect(() => {
    const control = { workFolderId: workFolder.id, suspend: checks.suspend, resume: checks.resume };
    onChecksControlChange(control);
    return () => onChecksControlChange(null);
  }, [checks.resume, checks.suspend, onChecksControlChange, workFolder.id]);
  const workFolderIdentityFor = useWorkFolderIdentityResolver();
  const identity = workFolderIdentityFor(workFolder, customizations);
  const nestedFolderViews = useMemo(() => new Map([...childFolderPaths(workFolder, workFolders)].map(([path, child]) => [path, {
    workFolder: child,
    identity: workFolderIdentityFor(child, customizations),
    status: combineActivityStatuses([child, ...descendantFolders(child, workFolders)].map((item) => folderStatuses[item.id])),
  }])), [customizations, folderStatuses, workFolder, workFolderIdentityFor, workFolders]);
  // The Workers a Chat can address with @ (2026-10-01): the work-folders inside
  // this one first, then the ones containing it, then everything else.
  const mentionFoldersFor = useCallback((target: WorkFolderSummary): MentionFolderOption[] => {
    const inside = folderTreeRows(descendantFolders(target, workFolders)).map((row) => row.workFolder);
    const containing = folderAncestors(target, workFolders).reverse();
    const seen = new Set([target.id, ...inside.map((item) => item.id), ...containing.map((item) => item.id)]);
    const others = workFolders.filter((item) => !seen.has(item.id)).sort((left, right) => left.name.localeCompare(right.name));
    const names = mentionNames(workFolders);
    return [...inside, ...containing, ...others].map((item) => {
      const itemIdentity = workFolderIdentityFor(item, customizations);
      return {
        id: item.id,
        name: names.get(item.id) ?? item.name,
        icon: <WorkFolderIconGlyph icon={itemIdentity.Icon} size={13} filled />,
        style: workFolderIdentityStyle(itemIdentity),
        status: folderStatuses[item.id] ?? null,
      };
    });
  }, [customizations, folderStatuses, workFolderIdentityFor, workFolders]);
  const surfaceCatalogKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, workFolder.id);
  const restrictedAppCatalogKnown = restrictedAppsState.knownWorkFolderIds.has(workFolder.id);
  const restrictedApps = restrictedAppsState.appsByWorkFolder[workFolder.id] ?? [];
  useEffect(() => {
    tabs.reconcileRestrictedAppSurfaceTabs(
      restrictedAppsState.appsByWorkFolder,
      restrictedAppsState.knownWorkFolderIds,
    );
  }, [restrictedAppsState.appsByWorkFolder, restrictedAppsState.knownWorkFolderIds, tabs.reconcileRestrictedAppSurfaceTabs]);
  const surfaces = useMemo(() => contributedSurfaces(workFolder.id, surfaceCatalogs[workFolder.id] ?? []), [surfaceCatalogs, workFolder.id]);
  const activeSurfaceKey = extensionSurfaceIdForMode(activeMode);
  const activeSurface = activeSurfaceKey ? resolveSurfaceForKey(surfaces, activeSurfaceKey) : null;
  const activeRestrictedApp = restrictedApps.find((app) => restrictedAppRailMode(workFolder.id, app.manifest.id, app.featureInstallationId) === activeMode) ?? null;
  const previewLocalFile = useCallback((path: string) => {
    const previewFile = window.workFoldDesktop?.workFolder.previewFile;
    if (!isMacOS() || !previewFile) return;
    void previewFile(workFolder.id, path).catch((caught) => onError(errorText(caught)));
  }, [onError, workFolder.id]);

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

  useEffect(() => { if (!fixture) localStorage.setItem("work-fold.work-folder.mode", activeMode); }, [activeMode, fixture]);
  // Manage work-folders replaces the pane's content; Done and Escape return to
  // whatever the person was doing before they opened it.
  const modeBeforeManagingRef = useRef<WorkFolderRailMode>(activeMode === "work-folders" ? "files" : activeMode);
  useEffect(() => { if (activeMode !== "work-folders") modeBeforeManagingRef.current = activeMode; }, [activeMode]);
  useEffect(() => {
    if (tree.status === "ready" && activeTab?.kind !== "checks") void checks.refresh();
  }, [activeTab?.kind, checks.refresh, tree.status, tree.tree]);
  useEffect(() => {
    if (!isMacOS() || !window.workFoldDesktop?.workFolder.previewFile) return;
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
      const installed = restrictedAppsState.appsByWorkFolder[command.workFolderId]?.find((app) => (
        app.manifest.id === command.appId && app.digest === command.digest && app.featureInstallationId === command.featureInstallationId
      ));
      const targetWorkFolder = workFolders.find((item) => item.id === command.workFolderId);
      if (!installed || !targetWorkFolder) return;
      if (command.type === "open" && command.tab) {
        tabs.openRestrictedAppSurfaceTab(targetWorkFolder, { appId: command.appId, digest: command.digest, featureInstallationId: command.featureInstallationId }, command.tab);
      } else if (command.type === "update" && command.tab) {
        tabs.updateRestrictedAppSurfaceTab(command.workFolderId, { appId: command.appId, digest: command.digest, featureInstallationId: command.featureInstallationId }, command.tab);
      } else if (command.type === "close" && command.sourceAppTabId) {
        tabs.closeRestrictedAppSurfaceTab(command.workFolderId, command.appId, command.digest, command.sourceAppTabId, command.featureInstallationId);
      }
    });
  }, [restrictedAppsState.appsByWorkFolder, tabs, workFolders]);
  useEffect(() => {
    const desktop = window.workFoldDesktop?.restrictedApps;
    if (!desktop) return;
    return desktop.onOpenRequest((request) => {
      const target = resolveRestrictedAppOpenRequest(request, workFolders);
      if (!target) return;
      if (target.workFolder.id !== workFolder.id) onSwitchWorkFolder(target.workFolder);
      setActiveMode(target.mode);
    });
  }, [onSwitchWorkFolder, workFolder.id, workFolders]);
  useEffect(() => {
    // A temporarily missing or moved folder is not the same thing as an
    // explicit work-folder removal. Keep appearance keyed by the portable work-folder id
    // so relinking that folder restores its identity on this computer.
    const next = normalizeWorkFolderCustomizations(customizationsRef.current, undefined, supportedWorkFolderIconNames);
    if (JSON.stringify(next) !== JSON.stringify(customizationsRef.current)) {
      customizationsRef.current = next;
      setCustomizations(next);
    }
  }, [workFolders.map((item) => item.id).join("|")]);
  // A restore from Settings → Recently Deleted can bring back a Chat transcript
  // or a file; the pane cannot reach this state, so it announces the restore.
  useEffect(() => {
    if (fixture) return;
    function onRecentlyDeletedRestored(): void { void loadConversationGroups(); void tree.refresh(false); }
    window.addEventListener("work-fold:recently-deleted-restored", onRecentlyDeletedRestored);
    return () => window.removeEventListener("work-fold:recently-deleted-restored", onRecentlyDeletedRestored);
  }, [fixture, workFolders.map((item) => item.id).join("|")]);
  useEffect(() => { if (fixture) { setConversationGroups(fixtureConversationGroups(fixture)); return; } void loadConversationGroups(); }, [fixture, workFolders.map((item) => item.id).join("|")]);
  useEffect(() => {
    if (fixture) {
      setSurfaceCatalogs(fixture.surfaces);
      return;
    }
    const requestId = ++surfaceCatalogRequestRef.current;
    void api<AgentCatalog>(`/api/work-folders/${workFolder.id}/agent/catalog`).then((catalog) => {
      if (surfaceCatalogRequestRef.current !== requestId) return;
      setSurfaceCatalogs((current) => ({ ...current, [workFolder.id]: catalog.surfaces ?? [] }));
    }).catch((caught) => {
      if (surfaceCatalogRequestRef.current === requestId) onError(errorText(caught));
    });
    return () => { surfaceCatalogRequestRef.current += 1; };
  }, [fixture, workFolder.id]);
  useEffect(() => {
    if (!surfaceCatalogKnown || !restrictedAppCatalogKnown || !activeSurfaceKey || activeSurface) return;
    setActiveMode("files");
  }, [activeSurface, activeSurfaceKey, restrictedAppCatalogKnown, surfaceCatalogKnown, workFolder.id]);
  useEffect(() => { tabs.syncSurfaceTabConversationTitles(conversationGroups); }, [conversationGroups]);
  useEffect(() => {
    function closeMenus(event: PointerEvent) { if (event.target instanceof Element && event.target.closest(".context-menu")) return; setFileContextMenu(null); }
    document.addEventListener("pointerdown", closeMenus); return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);
  useEffect(() => {
    if (!desktopAction) return;
    if (desktopAction.command === "open-checks") tabs.openChecksSurfaceTab(workFolder);
    else if (desktopAction.command === "customize-work-folder") { const target = workFolders.find((item) => item.id === desktopAction.workFolderId); if (target) openWorkFolderAppearance(target); }
    else if (desktopAction.command === "new-chat") openChat(workFolder, null);
    else if (desktopAction.command === "reload-work-folder-state") void refreshWorkFolderState();
    else if (desktopAction.command === "open-capabilities" || desktopAction.command === "open-skills" || desktopAction.command === "open-extensions") setSkillsExtensionsView("installed");
    else if (desktopAction.command === "app-change-chat" && desktopAction.app) void startAppChangeChat(desktopAction.app).catch((caught) => onError(errorText(caught)));
    else if (desktopAction.command === "open-app-build-chat" && desktopAction.workFolderId && desktopAction.conversationId) void openAppBuildChat(desktopAction.workFolderId, desktopAction.conversationId).catch((caught) => onError(errorText(caught)));
    else if (desktopAction.command === "open-app-result-file" && desktopAction.workFolderId && desktopAction.path) {
      const target = workFolders.find((item) => item.id === desktopAction.workFolderId);
      if (target) tabs.openFileSurfaceTab(target, desktopAction.path);
      else onError("The result's work-folder is unavailable.");
    }
    else if (desktopAction.command === "open-app-studio" && desktopAction.workFolderId) openAppStudio(desktopAction.workFolderId, desktopAction.runtimeInstanceId);
    else if (desktopAction.command === "open-command-palette") openCommandPalette();
    else if (desktopAction.command === "close-tab" && tabs.activeSurfaceTabId) tabs.closeSurfaceTab(tabs.activeSurfaceTabId);
  }, [desktopAction?.id, openCommandPalette]);
  // Tab-strip keyboard reach without focusing the tablist: Ctrl+Tab cycles,
  // Cmd/Ctrl+1..9 jumps (9 is the last tab), Cmd/Ctrl+T opens a new Chat tab,
  // and Ctrl+W covers close on platforms whose menu does not own it.
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.altKey || document.querySelector('[role="dialog"]')) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.ctrlKey && !event.metaKey && event.key === "Tab") {
        if (!tabs.surfaceTabs.length) return;
        event.preventDefault();
        const index = tabs.surfaceTabs.findIndex((tab) => tab.id === tabs.activeSurfaceTabId);
        const step = event.shiftKey ? -1 : 1;
        const next = tabs.surfaceTabs[(index + step + tabs.surfaceTabs.length) % tabs.surfaceTabs.length];
        if (next) tabs.setActiveSurfaceTabId(next.id);
        return;
      }
      if (!command || event.shiftKey) return;
      if (event.key.toLocaleLowerCase() === "t") {
        event.preventDefault();
        openChat(workFolder, null);
        return;
      }
      if (!isMacOS() && event.key.toLocaleLowerCase() === "w") {
        if (!tabs.activeSurfaceTabId) return;
        event.preventDefault();
        tabs.closeSurfaceTab(tabs.activeSurfaceTabId);
        return;
      }
      if (event.key >= "1" && event.key <= "9") {
        if (!tabs.surfaceTabs.length) return;
        const target = event.key === "9"
          ? tabs.surfaceTabs.at(-1)
          : tabs.surfaceTabs[Number(event.key) - 1];
        if (!target) return;
        event.preventDefault();
        tabs.setActiveSurfaceTabId(target.id);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [tabs.surfaceTabs, tabs.activeSurfaceTabId, workFolder.id]);
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
    const pairs = await Promise.all(workFolders.map(async (item) => {
      try { return [item.id, (await api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${item.id}/conversations`)).conversations] as const; }
      catch { return [item.id, []] as const; }
    }));
    setConversationGroups(Object.fromEntries(pairs));
  }

  async function refreshWorkFolderState() {
    if (fixture) {
      showToast({ text: "Preview data is already up to date.", tone: "info" });
      return;
    }
    onError(null);
    await Promise.all([onRefreshBootstrap(), tree.refresh(false), loadConversationGroups()]);
    setHistoryRefreshRequest((current) => current + 1);
    showToast({ text: `${workFolder.name} refreshed`, tone: "success" });
  }

  function openWorkFolderAppearance(target: WorkFolderSummary) {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Menu items and Settings disappear as the popup opens. Return to the
    // persistent work-folder header instead of a detached invoking control.
    appearanceReturnFocusRef.current = focused && focused !== document.body && !focused.closest("[role='menu'], .modal-backdrop")
      ? focused
      : document.querySelector<HTMLButtonElement>(".work-folder-pane-switch-trigger");
    setAppearanceWorkFolderId(target.id);
    setAppearanceInitialSection("banner");
  }

  function closeWorkFolderAppearance() {
    setAppearanceWorkFolderId(null);
    const returnFocus = appearanceReturnFocusRef.current;
    window.requestAnimationFrame(() => { if (returnFocus?.isConnected && !returnFocus.inert) returnFocus.focus(); });
  }

  function rememberWorkFolderAppearance(workFolderId: string) {
    const history = appearanceHistoryRef.current.get(workFolderId) ?? [];
    history.push(structuredClone(customizationsRef.current[workFolderId] ?? {}));
    if (history.length > 20) history.shift();
    appearanceHistoryRef.current.set(workFolderId, history);
    setAppearanceHistoryVersion((current) => current + 1);
  }

  function persistWorkFolderCustomization(
    workFolderId: string,
    customization: WorkFolderCustomization | undefined,
    options: { remember?: boolean } = {},
  ) {
    if (options.remember !== false) rememberWorkFolderAppearance(workFolderId);
    const next = { ...customizationsRef.current };
    if (customization && Object.keys(customization).length) next[workFolderId] = customization;
    else delete next[workFolderId];
    customizationsRef.current = next;
    setCustomizations(next);
    if (fixture) return;
    appearanceWriteQueueRef.current = appearanceWriteQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const result = customization && Object.keys(customization).length
          ? await api<{ appearance: WorkFolderAppearanceState }>(`/api/work-folders/${workFolderId}/appearance`, {
            method: "PUT",
            body: { customization },
          })
          : await api<{ appearance: WorkFolderAppearanceState }>(`/api/work-folders/${workFolderId}/appearance`, { method: "DELETE" });
      })
      .catch((caught) => {
        if (appearanceStorageWarningShownRef.current) return;
        appearanceStorageWarningShownRef.current = true;
        showToast({ text: `This appearance works for this session, but work-fold could not save it on this computer. ${errorText(caught)}`, tone: "info" });
      });
  }

  function customizeWorkFolder(workFolderId: string, patch: WorkFolderCustomizationPatch) {
    const current = upgradeWorkFolderAppearanceCustomization(customizationsRef.current[workFolderId] ?? {});
    const merged: WorkFolderCustomization = { ...current, ...patch, schema: 2 };
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
    const normalized = normalizeWorkFolderCustomizations(
      { [workFolderId]: normalizeWorkFolderAppearanceCustomization(merged) },
      new Set([workFolderId]),
      supportedWorkFolderIconNames,
    )[workFolderId];
    persistWorkFolderCustomization(workFolderId, normalized);
  }

  function replaceWorkFolderCustomization(workFolderId: string, customization: WorkFolderCustomization) {
    const normalized = normalizeWorkFolderCustomizations(
      { [workFolderId]: upgradeWorkFolderAppearanceCustomization(customization) },
      new Set([workFolderId]),
      supportedWorkFolderIconNames,
    )[workFolderId];
    persistWorkFolderCustomization(workFolderId, normalized);
    showToast({ text: "Appearance proposal applied to this work-folder.", tone: "success" });
  }

  function undoWorkFolderCustomization(workFolderId: string) {
    const history = appearanceHistoryRef.current.get(workFolderId) ?? [];
    const previous = history.pop();
    appearanceHistoryRef.current.set(workFolderId, history);
    setAppearanceHistoryVersion((current) => current + 1);
    if (!previous) return;
    persistWorkFolderCustomization(workFolderId, Object.keys(previous).length ? previous : undefined, { remember: false });
    showToast({ text: "Undid the last appearance change.", tone: "success" });
  }

  function resetWorkFolderCustomization(workFolderId: string) {
    persistWorkFolderCustomization(workFolderId, undefined);
    showToast({ text: "work-folder appearance reset to defaults.", tone: "success" });
  }

  async function renameWorkFolder(target: WorkFolderSummary, name: string) {
    if (fixture) { showToast({ text: "work-folder rename is disabled in the preview", tone: "info" }); return; }
    await checks.suspend();
    try { await api(`/api/work-folders/${target.id}`, { method: "PATCH", body: { name } }); await onRefreshBootstrap(); showToast({ text: `Renamed work-folder to ${name}`, tone: "success" }); }
    catch (caught) { onError(errorText(caught)); throw caught; }
    finally { void checks.resume(); }
  }

  async function removeWorkFolder(target: WorkFolderSummary) {
    if (fixture) { showToast({ text: "work-folder removal is disabled in the preview", tone: "info" }); return; }
    let appStudio;
    let appRemovalImpact;
    try {
      [appStudio, appRemovalImpact] = await Promise.all([
        getLocalAppStudio(target.id),
        getLocalAppWorkFolderRemovalImpact(target.id),
      ]);
    } catch (caught) {
      onError(`work-fold could not verify ${target.name}'s App Studio state. ${errorText(caught)}`);
      return;
    }
    if (appRemovalImpact.activeSourceInstanceCount || appRemovalImpact.activeTargetInstanceCount) {
      onError(`Uninstall every release-backed App sourced by or installed in ${target.name} before removing this work-folder.`);
      return;
    }
    if (appRemovalImpact.retainedDataCount) {
      onError(`Purge ${target.name}'s retained App data in App Studio before removing this source work-folder.`);
      return;
    }
    const confirmed = await requestConfirm({ title: target.location.storage === "linked" ? `Remove ${target.name}?` : `Delete ${target.name}?`, body: removeWorkFolderConfirmText(target, {
      ...appStudio,
      incomingPreparedOperationCount: appRemovalImpact.incomingPreparedOperationCount,
    }), confirmLabel: target.location.storage === "linked" ? "Remove work-folder" : "Delete work-folder", tone: "danger" });
    if (!confirmed) return;
    const suspendedChecks = target.id === activeWorkFolderIdRef.current;
    let removed = false;
    try {
      if (suspendedChecks) await checks.suspend();
      const removal = await api<{
        cleanupPending: boolean;
        deleted: boolean;
        recentlyDeleted?: { entryId: string; restoreBy: string } | null;
      }>(`/api/work-folders/${target.id}`, { method: "DELETE" });
      removed = true;
      const nextCustomizations = { ...customizationsRef.current };
      delete nextCustomizations[target.id];
      customizationsRef.current = nextCustomizations;
      setCustomizations(nextCustomizations);
      tabs.removeWorkFolderSurfaceTabs(target.id);
      await onRefreshBootstrap();
      showToast({
        text: removal.cleanupPending
          ? target.location.storage === "managed" && !removal.deleted
            ? `${target.name} was removed. work-fold will retry deleting its managed folder when it next starts.`
            : `${target.name} was removed. work-fold will finish machine-local cleanup when it next starts.`
          : target.location.storage === "linked"
            ? `${target.name} removed. The folder and its files remain on your computer.`
            : removal.recentlyDeleted
              ? `${target.name} was deleted. Its folder is in Recently Deleted until `
                + `${new Date(removal.recentlyDeleted.restoreBy).toLocaleDateString()}; Settings → Recently Deleted puts it back.`
              : `${target.name} and its managed folder were deleted.`,
        tone: removal.cleanupPending ? "info" : "success",
      });
    } catch (caught) {
      if (suspendedChecks && !removed) void checks.resume();
      onError(errorText(caught));
    }
  }

  function openChat(targetWorkFolder: WorkFolderSummary, conversation: ConversationSummary | null) {
    if (conversation) chatActivity.setAttention(chatActivityKey(targetWorkFolder.id, conversation.id), false);
    tabs.openChatSurfaceTab(targetWorkFolder, conversation);
  }

  /** Opens a fresh Chat with the app-building starter text, cursor at the end. */
  async function startAppChangeChat(app: RestrictedAppInstalled) {
    const source = workFolders.find((item) => item.id === app.sourceWorkFolderId);
    if (!source) throw new Error("The app's source work-folder is unavailable. Refresh work-folders before changing it.");
    const key = `${app.featureInstallationId}:${app.digest}`;
    const requestId = appChangeRequests.current.get(key) ?? crypto.randomUUID();
    appChangeRequests.current.set(key, requestId);
    const change = await prepareRestrictedAppChange(app, requestId);
    const surfaceTabId = tabs.openChatSurfaceTab(source, null);
    setDraftRequest({ id: ++draftRequestId.current, text: appChangeDraft(change), workFolderId: source.id, surfaceTabId });
    appChangeRequests.current.delete(key);
  }

  async function openAppBuildChat(sourceWorkFolderId: string, conversationId: string) {
    const source = workFolders.find((item) => item.id === sourceWorkFolderId);
    if (!source) throw new Error("The app's source work-folder is unavailable.");
    const { conversations } = await api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${encodeURIComponent(source.id)}/conversations`);
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("That build Chat is no longer available.");
    setConversationGroups((current) => ({ ...current, [source.id]: conversations }));
    openChat(source, conversation);
  }

  function openAppStudio(sourceWorkFolderId: string, runtimeInstanceId?: string): void {
    const source = workFolders.find((item) => item.id === sourceWorkFolderId);
    if (!source) { onError("The app's source work-folder is unavailable."); return; }
    setAppStudioNavigation(runtimeInstanceId ? { id: crypto.randomUUID(), sourceWorkFolderId: source.id, runtimeInstanceId } : null);
    tabs.openAppStudioSurfaceTab(source);
  }

  function openChatActions(
    targetWorkFolder: WorkFolderSummary,
    conversation: ConversationSummary,
    event: React.MouseEvent<HTMLElement>,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget;
    const rect = returnFocusTarget.getBoundingClientRect();
    const invokedFromKeyboard = event.clientX === 0 && event.clientY === 0;
    setChatActions({
      workFolder: targetWorkFolder,
      conversation,
      x: invokedFromKeyboard ? Math.round(rect.right - 8) : Math.round(event.clientX),
      y: invokedFromKeyboard ? Math.round(rect.bottom + 4) : Math.round(event.clientY),
      returnFocusTarget,
    });
  }
  function attachToChat(path: string) {
    const existing = tabs.surfaceTabs.find((tab) => tab.kind === "chat" && tab.workFolderId === workFolder.id && (!tab.conversationId || tab.id === tabs.activeSurfaceTabId));
    const surfaceTabId = existing?.id ?? tabs.openChatSurfaceTab(workFolder, null);
    if (existing) tabs.setActiveSurfaceTabId(existing.id);
    setContextRequest({ id: ++contextRequestId.current, path, workFolderId: workFolder.id, surfaceTabId });
  }

  async function openContextMenu(entry: TreeEntry, event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    const returnFocusTarget = event.currentTarget as HTMLElement;
    const point = { x: Math.round(event.clientX), y: Math.round(event.clientY) };
    const popupFileMenu = window.workFoldDesktop?.workFolder.popupFileMenu;
    if (isMacOS() && popupFileMenu) {
      setFileContextMenu(null);
      try {
        const command = await popupFileMenu({
          workFolderId: workFolder.id,
          path: entry.path,
          kind: entry.kind,
          capabilities: {
            open: entry.kind === "folder" || canOpenDirectly(entry.path),
            attach: entry.kind === "file",
            history: entry.kind === "file",
            upload: entry.kind === "folder",
            rename: Boolean(entry.path) && !holdsNestedFolder(entry),
            delete: Boolean(entry.path) && !holdsNestedFolder(entry),
            share: entry.kind === "file" && isShareablePath(entry.path),
            shared: entry.kind === "file" && Boolean(activeSharedPageFor(sharedPages, workFolder.id, entry.path)),
            worker: canGiveOwnWorker(entry),
          },
          point,
        });
        if (command === "open") {
          if (entry.kind === "file") {
            tree.setSelectedPath(entry.path);
            tabs.openFileSurfaceTab(workFolder, entry.path);
            await openLocalPath(entry.path, nativeOpenLabel(entry).office ? "open-native" : "open");
          } else await openLocalPath(entry.path, "open");
        } else if (command === "open-with") await openLocalPath(entry.path, "open-with");
        else if (command === "reveal") await openLocalPath(entry.path, "reveal");
        else if (command === "copy-path") await copyPath(entry.path);
        else if (command === "attach-chat") attachToChat(entry.path);
        else if (command === "version-history") openVersionHistory(workFolder, entry.path);
        else if (command === "share") shareFile(entry.path);
        else if (command === "new-folder") requestNewFolder(entry.path);
        else if (command === "upload-here") chooseUpload(entry.path);
        else if (command === "refresh") await tree.refresh(false);
        else if (command === "give-worker") await giveOwnWorker(entry.path);
        else if (command === "rename") renameEntry(entry.path);
        else if (command === "delete") await deleteEntry(entry.path);
      } catch (caught) { onError(errorText(caught)); }
      return;
    }
    setFileContextMenu({ entry, x: Math.min(point.x, window.innerWidth - 250), y: Math.min(point.y, window.innerHeight - 420), returnFocusTarget });
  }
  // "Make a work-folder" (2026-10-01): any plain folder below this
  // work-folder's root can become a nested work-folder; its row turns into the door row.
  function canGiveOwnWorker(entry: TreeEntry): boolean {
    return !fixture && entry.kind === "folder" && Boolean(entry.path) && !entry.nestedFolder;
  }

  // A folder that holds a nested work-folder cannot be renamed or deleted from
  // here (the host refuses), so the menus never offer it.
  function holdsNestedFolder(entry: TreeEntry): boolean {
    if (entry.kind !== "folder" || !entry.path) return false;
    const prefix = `${entry.path.toLocaleLowerCase()}/`;
    return [...nestedFolderViews.keys()].some((path) => path.toLocaleLowerCase().startsWith(prefix));
  }

  async function giveOwnWorker(path: string): Promise<void> {
    try {
      const { workFolder: created } = await api<{ workFolder: WorkFolderSummary }>(`/api/work-folders/${workFolder.id}/nested-folders`, { method: "POST", body: { path } });
      await Promise.all([onRefreshBootstrap(), tree.refresh(false)]);
      showToast({ text: `${created.name} is now a work-folder.`, actionLabel: "Open", onAction: () => onSwitchWorkFolder(created) });
    } catch (caught) {
      onError(errorText(caught));
    }
  }

  function openRootContextMenu(event: React.MouseEvent<HTMLElement>) { if ((event.target as HTMLElement).closest("[data-tree-row]")) return; openContextMenu({ name: workFolder.name, path: "", kind: "folder" }, event); }

  async function uploadFiles(files: DroppedUploadFile[], targetFolderPath: string) {
    if (!files.length || fixture) return;
    const form = new FormData();
    form.set("targetFolderPath", targetFolderPath);
    form.set("relativePaths", JSON.stringify(files.map((item) => item.relativePath)));
    files.forEach((item) => form.append("files", item.file, item.file.name));
    setUploadingFiles(true);
    onError(null);
    try {
      await apiForm(`/api/work-folders/${workFolder.id}/upload-local-files`, form);
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
      const result = await apiForm<{ uploaded: Array<{ path: string }> }>(`/api/work-folders/${workFolder.id}/upload-local-files`, form);
      void tree.refresh();
      showToast({ text: `${formatItemCount(files.length, "file")} added to ${targetFolderPath}`, tone: "success" });
      return result.uploaded.map((item) => item.path);
    } finally {
      setUploadingFiles(false);
    }
  }
  function chooseUpload(targetPath = "") { setUploadTargetPath(targetPath); uploadRef.current?.click(); }

  function requestNewFolder(parentPath = "") {
    setNewFolderTarget({ workFolderId: workFolder.id, workFolderName: workFolder.name, parentPath });
  }
  async function folderCreated(folder: { path: string; name: string }, target: NewFolderTarget) {
    showHistorySaved(`Created ${folder.name}`);
    if (activeWorkFolderIdRef.current !== target.workFolderId) return;
    tree.setQuery("");
    await tree.refresh();
    if (activeWorkFolderIdRef.current !== target.workFolderId) return;
    if (target.parentPath) tree.toggleFolder(target.parentPath, true);
  }

  async function moveEntry(sourcePath: string, targetFolderPath: string) {
    if (fixture || !sourcePath || sourcePath === targetFolderPath || isInsideFolder(targetFolderPath, sourcePath)) return;
    tree.setMovingTreePath(sourcePath);
    try {
      const result = await api<{ moved: { path: string; name: string }; safetyCheckpointId: string }>(`/api/work-folders/${workFolder.id}/move-local-entry`, { method: "POST", body: { sourcePath, targetFolderPath } });
      const preview = moveTreeEntry(tree.tree, sourcePath, targetFolderPath);
      tree.setTree(preview.entries);
      tabs.retargetFileSurfaceTabsForMove(workFolder.id, sourcePath, result.moved.path);
      showHistorySaved(`Moved ${result.moved.name}`);
    }
    catch (caught) { onError(errorText(caught)); }
    finally { tree.setMovingTreePath(null); }
  }

  async function deleteEntry(path: string) {
    if (!path || fixture) return;
    const entry = findTreeEntry(tree.tree, path);
    if (entry?.kind === "folder") {
      const confirmed = await requestConfirm({ title: deleteFolderConfirm.title(entry.name), body: deleteFolderConfirm.body, confirmLabel: deleteFolderConfirm.confirmLabel, tone: "danger" });
      if (!confirmed) return;
    }
    const selectedPath = tree.selectedPath && (tree.selectedPath === path || tree.selectedPath.startsWith(`${path}/`)) ? tree.selectedPath : null;
    const deletedTabPaths = new Set(tabs.surfaceTabs.flatMap((tab) => tab.kind === "file" && tab.workFolderId === workFolder.id && (tab.path === path || tab.path.startsWith(`${path}/`)) ? [tab.path] : []));
    const pending: PendingDelete = { workFolderId: workFolder.id, path, name: entry?.name ?? path, selectedPath, deletedTabPaths };
    pendingDeletesRef.current.set(pendingDeleteKey(pending), pending);
    tree.setTree((current) => removeTreeEntries(current, new Set([path])));
    showToast({ text: `Removed ${pending.name}`, tone: "success", actionLabel: "Undo", durationMs: 6500,
      onAction: () => {
        if (pendingDeletesRef.current.get(pendingDeleteKey(pending)) !== pending) return;
        pendingDeletesRef.current.delete(pendingDeleteKey(pending));
        if (pending.workFolderId !== activeWorkFolderIdRef.current) return;
        const restoreSelection = Boolean(pending.selectedPath && (!selectedPathRef.current || selectedPathRef.current === pending.selectedPath));
        void refreshTreeWithPendingDeletes().then(() => {
          if (pending.workFolderId === activeWorkFolderIdRef.current && pending.selectedPath && restoreSelection) tree.setSelectedPath(pending.selectedPath);
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
    const result = await api<{ renamed: { path: string }; safetyCheckpointId: string }>(`/api/work-folders/${workFolder.id}/rename-local-entry`, {
      method: "POST",
      body: { path: renameEntryRequest.path, newName: name },
    });
    tabs.retargetFileSurfaceTabsForMove(workFolder.id, renameEntryRequest.path, result.renamed.path);
    await tree.refresh();
    showHistorySaved(`Renamed ${renameEntryRequest.name}`);
  }

  async function openLocalPath(path: string, action: "reveal" | "open" | "open-native" | "open-with", targetWorkFolder = workFolder) {
    if (fixture) { showToast({ text: "Opening files is disabled in the preview", tone: "info" }); return; }
    const desktop = window.workFoldDesktop;
    try {
      if (action === "open-with") {
        const openPathWith = desktop?.workFolder.openPathWith;
        if (!path || !openPathWith) return;
        const result = await openPathWith(targetWorkFolder.id, path);
        if (result.opened && result.appName) showToast({ text: `Opened in ${result.appName}`, tone: "success" });
        return;
      }
      if (!path) await desktop?.workFolder.revealFolder?.(targetWorkFolder.id); else if (desktop?.workFolder.openPath) await desktop.workFolder.openPath(targetWorkFolder.id, path, action); else await desktop?.workFolder.revealFolder?.(targetWorkFolder.id);
    }
    catch (caught) { onError(errorText(caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "")); }
  }
  const canOpenWith = !fixture && typeof window.workFoldDesktop?.workFolder.openPathWith === "function";
  // Files-menu Share: open the file's tab and let that tab share it (or show
  // its link when it is already shared). Sharing runs on the click.
  const [shareRequest, setShareRequest] = useState<{ id: number; workFolderId: string; path: string } | null>(null);
  function shareFile(path: string) {
    tree.setSelectedPath(path);
    tabs.openFileSurfaceTab(workFolder, path);
    setShareRequest({ id: Date.now(), workFolderId: workFolder.id, path });
  }
  const openSharingSettings = (page: "shared-pages" | "web-access") => onOpenSettings(page);
  function openVersionHistory(targetWorkFolder: WorkFolderSummary, path: string) {
    if (fixture) { showToast({ text: "Version history is disabled in the preview", tone: "info" }); return; }
    setVersionHistory({ workFolder: targetWorkFolder, path, name: path.split("/").pop() ?? path });
  }
  async function copyPath(path: string) { const full = workFolderEntryNativePath(workFolder.workFolderRoot, path); await copyToClipboard({ text: full }); showToast({ text: "Path copied", tone: "success" }); }

  function updateDropTarget(event: React.DragEvent<HTMLElement>, target: string) { event.preventDefault(); if (hasNativeFiles(event) || hasWorkFolderPathDrag(event)) { event.dataTransfer.dropEffect = hasNativeFiles(event) ? "copy" : "move"; tree.setDropTargetFolderPath(target); } }
  function clearDropTarget(event?: React.DragEvent<HTMLElement>) { if (event && event.currentTarget.contains(event.relatedTarget as Node | null)) return; tree.setDropTargetFolderPath(null); }
  async function dropOnTarget(event: React.DragEvent<HTMLElement>, target: string) {
    event.preventDefault();
    tree.setDropTargetFolderPath(null);
    if (hasNativeFiles(event)) {
      try {
        const files = await collectDroppedUploadFiles(event.dataTransfer);
        if (!files.length) {
            onError("Drop one or more files. Empty folders cannot be added.");
          return;
        }
        await uploadFiles(files, target);
      }
      catch (caught) { onError(errorText(caught)); }
      return;
    }
    const source = hasWorkFolderPathDrag(event) ? event.dataTransfer.getData(workFolderPathDragType) || event.dataTransfer.getData("text/plain") : "";
    if (source) await moveEntry(source, target);
  }
  function startTreeDrag(path: string, event: React.DragEvent<HTMLElement>) { tree.setMovingTreePath(path); event.dataTransfer.setData(workFolderPathDragType, path); event.dataTransfer.setData("text/plain", path); event.dataTransfer.effectAllowed = "move"; }
  function endTreeDrag() { tree.setMovingTreePath(null); tree.setDropTargetFolderPath(null); }

  function startNativeFileDrag(path: string, event: React.DragEvent<HTMLElement>) {
    if (!event.altKey || !window.workFoldDesktop?.workFolder.startDrag) return false;
    event.preventDefault();
    void window.workFoldDesktop.workFolder.startDrag(workFolder.id, path).catch((caught) => onError(errorText(caught)));
    return true;
  }

  async function commitPendingDelete(pending: PendingDelete) {
    const key = pendingDeleteKey(pending);
    if (pendingDeletesRef.current.get(key) !== pending) return;
    pendingDeletesRef.current.delete(key);
    try {
      const result = await deleteLocalFileRequest(pending);
      tabs.closeFileSurfaceTabsForDeletedPaths(pending.workFolderId, pending.deletedTabPaths);
      if (result.recentlyDeleted) {
        showToast({
          text: `${pending.name} is in Recently Deleted — History could not keep a copy of everything in it.`,
          tone: "info",
          durationMs: 8000,
        });
      }
    } catch (caught) {
      onError(errorText(caught));
      if (pending.workFolderId === activeWorkFolderIdRef.current) {
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
    const pendingPaths = new Set([...pendingDeletesRef.current.values()].filter((item) => item.workFolderId === workFolder.id).map((item) => item.path));
    if (pendingPaths.size) tree.setTree((current) => removeTreeEntries(current, pendingPaths));
  }

  function showHistorySaved(text: string) {
    showToast({ text: `${text}. Restore point saved in History.`, tone: "success" });
  }

  async function saveRestorePoint() {
    if (fixture) return;
    try {
      const result = await api<{ created: boolean }>(`/api/work-folders/${workFolder.id}/history/checkpoints`, { method: "POST", body: { label: "Manual Restore Point" } });
      setHistoryRefreshRequest((current) => current + 1);
      setActiveMode("history");
      showToast(result.created
        ? { text: "Restore point saved", tone: "success" }
        : { text: "Current files already match the latest restore point", tone: "info" });
    } catch (caught) { onError(errorText(caught)); }
  }

  async function renameChat(targetWorkFolder: WorkFolderSummary, conversation: ConversationSummary, title: string) {
    if (fixture) { const updated = { ...conversation, title }; replaceConversationSummary(targetWorkFolder.id, updated); tabs.updateSurfaceTabConversationTitle(targetWorkFolder.id, updated); return; }
    const result = await api<{ conversation: ConversationSummary }>(`/api/work-folders/${targetWorkFolder.id}/conversations/${conversation.id}`, { method: "PATCH", body: { title } });
    replaceConversationSummary(targetWorkFolder.id, result.conversation);
    tabs.updateSurfaceTabConversationTitle(targetWorkFolder.id, result.conversation);
  }

  function replaceConversationSummary(workFolderId: string, conversation: ConversationSummary): void {
    setConversationGroups((current) => ({
      ...current,
      [workFolderId]: (current[workFolderId] ?? []).map((item) => item.id === conversation.id ? conversation : item),
    }));
  }

  async function updateChatLifecycle(
    targetWorkFolder: WorkFolderSummary,
    conversation: ConversationSummary,
    patch: { archived?: boolean; snoozedUntil?: string | null },
    options: { announce?: boolean } = {},
  ): Promise<ConversationSummary> {
    const previous = conversation;
    const updated = fixture
      ? applyFixtureChatLifecycle(conversation, patch)
      : (await api<{ conversation: ConversationSummary }>(
          `/api/work-folders/${targetWorkFolder.id}/conversations/${conversation.id}`,
          { method: "PATCH", body: patch },
        )).conversation;
    replaceConversationSummary(targetWorkFolder.id, updated);

    const lifecycle = conversationLifecycleView(updated);
    const openTab = tabs.surfaceTabs.find((tab) =>
      tab.kind === "chat"
      && tab.workFolderId === targetWorkFolder.id
      && tab.conversationId === conversation.id);
    if (lifecycle !== "active") {
      if (openTab) tabs.closeSurfaceTab(openTab.id);
      chatActivity.setRunning(chatActivityKey(targetWorkFolder.id, conversation.id), false);
      chatActivity.setAttention(chatActivityKey(targetWorkFolder.id, conversation.id), false);
    }
    if (options.announce === false) return updated;

    const feedback = chatLifecycleFeedback(previous, updated);
    showToast({
      text: feedback.text,
      tone: "success",
      actionLabel: "Undo",
      durationMs: 6500,
      onAction: () => {
        const latest = (conversationGroups[targetWorkFolder.id] ?? []).find((item) => item.id === conversation.id) ?? updated;
        void updateChatLifecycle(targetWorkFolder, latest, feedback.undo, { announce: false })
          .then((restored) => { if (openTab) openChat(targetWorkFolder, restored); })
          .catch((caught) => onError(errorText(caught)));
      },
    });
    return updated;
  }

  async function deleteChat(targetWorkFolder: WorkFolderSummary, conversation: ConversationSummary): Promise<void> {
    const recentlyDeleted = fixture
      ? null
      : (await api<{ deleted: { conversationId: string; recentlyDeleted: { entryId: string; restoreBy: string } } }>(
          `/api/work-folders/${targetWorkFolder.id}/conversations/${conversation.id}`,
          { method: "DELETE" },
        )).deleted.recentlyDeleted;
    setConversationGroups((current) => ({
      ...current,
      [targetWorkFolder.id]: (current[targetWorkFolder.id] ?? []).filter((item) => item.id !== conversation.id),
    }));
    for (const tab of tabs.surfaceTabs) {
      if (tab.kind === "chat" && tab.workFolderId === targetWorkFolder.id && tab.conversationId === conversation.id) tabs.closeSurfaceTab(tab.id);
    }
    chatActivity.setRunning(chatActivityKey(targetWorkFolder.id, conversation.id), false);
    chatActivity.setAttention(chatActivityKey(targetWorkFolder.id, conversation.id), false);
    showToast({
      text: `Moved "${chatDisplayTitle({ serverTitle: conversation.title })}" to Recently Deleted`,
      tone: "success",
      durationMs: 6500,
      ...(recentlyDeleted ? {
        actionLabel: "Undo",
        onAction: () => {
          void api(`/api/settings/recently-deleted/${recentlyDeleted.entryId}/restore`, { method: "POST", body: {} })
            .then(() => api<{ conversations: ConversationSummary[] }>(`/api/work-folders/${targetWorkFolder.id}/conversations`))
            .then(({ conversations }) => setConversationGroups((current) => ({ ...current, [targetWorkFolder.id]: conversations })))
            .catch((caught) => onError(errorText(caught)));
        },
      } : {}),
    });
  }

  function selectRailMode(mode: WorkFolderRailMode): void {
    // Automations opens its work-folder's own tab and leaves the navigator pane as it was.
    if (mode === "automations") { tabs.openWorkFolderAutomationsSurfaceTab(workFolder); return; }
    setActiveMode(mode);
    if (mode.startsWith("app:restricted:")) return;
    const surfaceKey = extensionSurfaceIdForMode(mode);
    if (!surfaceKey) return;
    const surface = resolveSurfaceForKey(surfaces, surfaceKey);
    const firstView = surface?.views[0];
    if (!surface || !firstView) return;
    const activeMatches = activeTab?.kind === "extension" && surfaceMatchesTab(surface, activeTab);
    if (!activeMatches) tabs.openExtensionSurfaceTab(workFolder, surface, firstView);
  }

  function openInstalledRestrictedApp(targetWorkFolder: WorkFolderSummary, app: RestrictedAppInstalled): void {
    restrictedAppsState.upsertApp(app);
    if (targetWorkFolder.id !== workFolder.id) onSwitchWorkFolder(targetWorkFolder);
    setActiveMode(restrictedAppRailMode(targetWorkFolder.id, app.manifest.id, app.featureInstallationId));
  }

  function updateSurfaceCatalog(targetWorkFolderId: string, catalog: AgentCatalog): void {
    setSurfaceCatalogs((current) => ({ ...current, [targetWorkFolderId]: catalog.surfaces ?? [] }));
  }

  const commands = useMemo<CommandPaletteCommand[]>(() => [
    ...(["files", "chats", "history"] as WorkFolderPane[]).map((mode) => ({ id: `go:${mode}`, groupId: "go-to" as const, groupLabel: "Go to", label: mode[0]!.toUpperCase() + mode.slice(1), defaultVisible: true, run: () => selectRailMode(mode) })),
    { id: "go:work-folder-apps", groupId: "go-to" as const, groupLabel: "Go to", label: "Apps", defaultVisible: true, run: () => onOpenSettings("apps") },
    { id: "go:assistant-tools", groupId: "go-to" as const, groupLabel: "Go to", label: "Skills & Extensions", defaultVisible: true, run: () => setSkillsExtensionsView("installed") },
    ...([{ id: "go:checks", groupId: "go-to" as const, groupLabel: "Go to", label: "Checks", detail: checks.status?.needsAttention ? `${checks.status.needsAttention} need attention` : undefined, defaultVisible: true, run: () => tabs.openChecksSurfaceTab(workFolder) }]),
    { id: "action:discover-skills-extensions", groupId: "actions" as const, groupLabel: "Actions", label: "Discover Skills & Extensions", keywords: ["capabilities", "discover", "install", "tools", "browse"], run: () => setSkillsExtensionsView("discover") },
    ...surfaces.map((surface) => ({ id: `app:${surface.key}`, groupId: "go-to" as const, groupLabel: "Go to", label: surface.title, detail: surface.scope === "project" ? "Pi Extension · This work-folder only" : "Pi Extension · Everywhere", run: () => selectRailMode(`app:${surface.key}`) })),
    ...restrictedApps.map((app) => ({ id: `restricted-app:${app.featureInstallationId}`, groupId: "go-to" as const, groupLabel: "Go to", label: restrictedAppRailLabel(app, restrictedApps), detail: "App · This work-folder", run: () => selectRailMode(restrictedAppRailMode(workFolder.id, app.manifest.id, app.featureInstallationId)) })),
    ...workFolders.map((item) => ({ id: `work-folder:${item.id}`, groupId: "switch-work-folder" as const, groupLabel: "Switch work-folder", label: item.name, detail: workFolderHeaderSourceBadgeLabel(item), matchTargets: [item.name, item.workFolderRoot], run: () => onSwitchWorkFolder(item) })),
    ...Object.entries(conversationGroups).flatMap(([workFolderId, conversations]) => conversations.map((conversation) => {
      const lifecycle = conversationLifecycleView(conversation);
      return {
        id: `chat:${workFolderId}:${conversation.id}`,
        groupId: "chats" as const,
        groupLabel: "Chats",
        label: conversation.title,
        detail: lifecycle === "archived" ? "Archived" : lifecycle === "snoozed" ? "Snoozed" : undefined,
        run: () => { const target = workFolders.find((item) => item.id === workFolderId); if (target) openChat(target, conversation); },
      };
    })),
    ...collectLoadedFileEntries(tree.tree).flatMap((entry) => {
      const matchTargets = [entry.name, entry.path];
      return [
        { id: `reveal-file:${workFolder.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Reveal in Files: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => { setActiveMode("files"); tree.setSelectedPath(entry.path); tabs.openFileSurfaceTab(workFolder, entry.path); } },
        { id: `attach-file:${workFolder.id}:${entry.path}`, groupId: "files" as const, groupLabel: "Files", label: `Attach to Chat: ${entry.name}`, detail: entry.path, matchTargets, minQueryLength: 2, run: () => attachToChat(entry.path) },
      ];
    }),
    { id: "action:new-chat", groupId: "actions", groupLabel: "Actions", label: "New Chat", keywords: ["chat", "conversation", "assistant"], defaultVisible: true, run: () => openChat(workFolder, null) },
    ...(!fixture ? [{ id: "action:save-restore-point", groupId: "actions" as const, groupLabel: "Actions", label: "Save Restore Point", keywords: ["history", "checkpoint", "backup"], defaultVisible: true, run: () => { void saveRestorePoint(); } }] : []),
    // Files has no toolbar buttons (2026-10-01): its actions live in the
    // right-click menu and here, so the keyboard reaches them too.
    { id: "action:files-new-subfolder", groupId: "files", groupLabel: "Files", label: "New Folder in Files", keywords: ["mkdir", "directory", "subfolder"], run: () => { setActiveMode("files"); requestNewFolder(); } },
    { id: "action:files-add", groupId: "files", groupLabel: "Files", label: "Add Files", keywords: ["upload", "import", "drop"], run: () => { setActiveMode("files"); chooseUpload(""); } },
    { id: "action:files-refresh", groupId: "files", groupLabel: "Files", label: "Refresh Files", keywords: ["reload", "rescan"], run: () => { void tree.refresh(false); } },
    { id: "action:new-work-folder", groupId: "actions", groupLabel: "Actions", label: "Create new work-folder", defaultVisible: true, run: onCreateWorkFolder },
    { id: "action:open-folder", groupId: "actions", groupLabel: "Actions", label: "Use existing folder", defaultVisible: true, run: onOpenFolder },
    { id: "action:settings", groupId: "actions", groupLabel: "Actions", label: "Settings", defaultVisible: true, run: onOpenSettings },
    { id: "action:shortcuts", groupId: "actions", groupLabel: "Actions", label: "Shortcut Keys", run: onOpenShortcuts },
    ...(["light", "dark", "system"] as AppThemePreference[]).map((preference) => ({ id: `theme:${preference}`, groupId: "actions" as const, groupLabel: "Actions", label: preference === "system" ? "Use device theme" : `Use ${preference} theme`, detail: themePreference === preference ? "Current" : undefined, keywords: ["appearance", "color", "mode"], run: () => onThemePreferenceChange(preference) })),
  ], [checks.status, conversationGroups, fixture, restrictedApps, surfaces, themePreference, tree.selectedPath, tree.tree, workFolders, workFolder.id]);

  const layoutStyle = { ...(workFolderIdentityStyle(identity)), ...(paneResize.sidebarWidth ? { "--work-folder-sidebar-width": `${paneResize.sidebarWidth}px` } : {}) } as CSSProperties;

  function leaveManageFolders(): void {
    selectRailMode(modeBeforeManagingRef.current);
  }

  // Escape leaves Manage work-folders only when nothing inside the pane claimed it:
  // an open switcher menu, a dialog, or a modal keeps its own Escape.
  function leaveManageFoldersOnEscape(event: import("react").KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.defaultPrevented || activeMode !== "work-folders") return;
    if (event.currentTarget.querySelector('[aria-expanded="true"]')) return;
    if ((event.target as Element).closest?.('[role="menu"], [role="dialog"]') || document.querySelector('[aria-modal="true"]')) return;
    event.preventDefault();
    leaveManageFolders();
  }

  return <main className={paneResize.sidebarResizing ? "work-folder-layout resizing" : "work-folder-layout"} ref={paneResize.workFolderLayoutRef} style={layoutStyle}>
    <WorkFolderModeRail activeMode={activeMode} workFolder={workFolder} surfaces={surfaces} apps={restrictedApps} onModeChange={selectRailMode} onOpenSkillsExtensions={setSkillsExtensionsView} accountControl={<button className="work-folder-rail-account-button" type="button" onClick={() => onOpenSettings()} aria-label="Settings"><Settings24Regular aria-hidden="true" /></button>} automations={hasFolderAutomations ? { active: activeTab?.kind === "work-folder-automations" && activeTab.workFolderId === workFolder.id } : null} updateControl={updateStatus && updateNeedsAttention(updateStatus) ? <DesktopUpdateButton status={updateStatus} onClick={onUpdateAction} /> : undefined} />
    <section className={`work-folder-mode-pane work-folder-mode-pane-${activeMode}`} id="work-folder-file-panel" onKeyDown={activeMode === "work-folders" ? leaveManageFoldersOnEscape : undefined}>
      <WorkFolderPaneHeader workFolder={workFolder} identity={identity} workFolders={workFolders} workFolderCustomizations={customizations} folderStatuses={folderStatuses} onSwitchWorkFolder={onSwitchWorkFolder} onCreateWorkFolder={onCreateWorkFolder} onOpenFolder={onOpenFolder} onManageWorkFolders={() => setActiveMode("work-folders")} managingWorkFolders={activeMode === "work-folders"} onNewChat={() => openChat(workFolder, null)} onOpenAppearance={() => openWorkFolderAppearance(workFolder)} {...(!fixture && typeof window.workFoldDesktop?.workFolder.revealFolder === "function" ? { onRevealFolder: () => void openLocalPath("", "reveal") } : {})} />
      {activeMode === "work-folders" ? <WorkFoldersPane workFolder={workFolder} workFolders={workFolders} identities={customizations} onCreate={onCreateWorkFolder} onOpenFolder={onOpenFolder} onCustomize={openWorkFolderAppearance} onRemove={(target) => void removeWorkFolder(target)} onDone={leaveManageFolders} /> : null}
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
          {tree.treeTruncated ? <span className="file-tree-truncated" title="This work-folder holds more items than Files lists at once. Open a folder to see its contents, or search by name or contents.">Partial list</span> : null}
          <ChecksToolbarButton status={checks.status} loading={checks.loading} unavailable={checks.unavailable} onClick={() => tabs.openChecksSurfaceTab(workFolder)} />
        </div>
        <div
          className={["file-tree-shell", uploadingFiles ? "uploading-files" : "", tree.dropTargetFolderPath === "" ? "root-drop-target" : ""].filter(Boolean).join(" ")}
          onContextMenu={openRootContextMenu}
          onDragEnter={(event) => updateDropTarget(event, "")}
          onDragOver={(event) => updateDropTarget(event, "")}
          onDragLeave={clearDropTarget}
          onDrop={(event) => void dropOnTarget(event, "")}
          onClick={(event) => { if (!(event.target as HTMLElement).closest("[data-tree-row]")) tree.setSelectedPath(null); }}
          onKeyDown={(event) => { if (event.key === "Escape" && tree.selectedPath) { event.preventDefault(); tree.setSelectedPath(null); } }}
        >
          {uploadingFiles ? <div className="file-upload-progress" aria-live="polite"><Loader2 className="spin" size={14} />Adding files</div> : null}
          {tree.status === "refreshing" ? <div className="file-tree-refresh-progress" aria-live="polite"><span className="file-tree-refresh-pill delayed-loading"><Loader2 className="spin" size={13} />Updating files</span></div> : null}
      {tree.status === "loading" ? <FileTreeLoadingState /> : tree.status === "error" ? <div className="empty-inline file-tree-error"><span>Couldn't load this folder.</span><button className="ui-control ui-control--quiet" type="button" onClick={() => void tree.refresh(false)}>Try again</button></div> : <FileTree entries={tree.visibleEntries} collapsedPaths={tree.query ? new Set() : tree.collapsedPaths} loadingFolderPaths={tree.loadingFolderPaths} selectedPath={tree.selectedPath} movingTreePath={tree.movingTreePath} dropTargetFolderPath={tree.dropTargetFolderPath} checkAttentionPaths={checks.attentionPaths} sharedPaths={sharedPaths} searchQuery={tree.query} emptyText={tree.query ? "No file or folder names match." : undefined} onToggleFolder={tree.toggleFolder} onSelectFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workFolder, path); }} onFocusEntry={tree.setSelectedPath} onPreviewFile={isMacOS() ? previewLocalFile : undefined} onOpenFile={(path) => void openLocalPath(path, "open")} onOpenContextMenu={openContextMenu} onRenameEntry={renameEntry} onDeleteEntry={(path) => void deleteEntry(path)} onUpdateDropTarget={updateDropTarget} onDropOnTarget={dropOnTarget} onNativeDragStartFile={startNativeFileDrag} onDragStartEntry={startTreeDrag} onDragEndEntry={endTreeDrag} nestedFolders={nestedFolderViews} onOpenNestedFolder={onSwitchWorkFolder} />}
        </div>
        {fixture ? null : (
          <FileContentSearch
            workFolderId={workFolder.id}
            query={tree.query}
            onOpenFile={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workFolder, path); }}
          />
        )}
      </div> : null}
      {activeMode === "chats" ? <ChatsPane workFolder={workFolder} workFolders={workFolders} conversations={conversationGroups} customizations={customizations} activityStatuses={chatActivity.statuses} activeConversationId={activeTab?.kind === "chat" ? activeTab.conversationId ?? undefined : undefined} onOpen={(target, conversation) => openChat(target, conversation)} onNew={(target) => openChat(target, null)} onActions={openChatActions} /> : null}
      {activeMode === "history" ? <HistoryPane onRestored={async () => { setHistoryRefreshRequest((value) => value + 1); await tree.refresh(false); await checks.refresh(); }} workFolder={workFolder} fixtureItems={fixture?.checkpoints[workFolder.id]} refreshRequest={historyRefreshRequest} onOpen={(item) => tabs.openHistorySurfaceTab(workFolder, item.checkpointId, item.label || "Restore point")} onError={onError} /> : null}
      {activeSurface ? <ExtensionSurfacePane surface={activeSurface} activeViewId={activeTab?.kind === "extension" && surfaceMatchesTab(activeSurface, activeTab) ? activeTab.viewId : null} onOpenView={(view) => tabs.openExtensionSurfaceTab(workFolder, activeSurface, view)} /> : null}
      {activeRestrictedApp ? <RestrictedAppViewport key={`${activeRestrictedApp.featureInstallationId}:${activeRestrictedApp.digest}`} app={activeRestrictedApp} placement="navigator" route="/" active /> : null}
    </section>
    <button className="work-folder-resizer" type="button" role="separator" aria-label="Resize the navigation pane and work area" aria-controls="work-folder-file-panel work-folder-chat-panel" aria-orientation="vertical" aria-valuemin={Math.round(paneResize.sidebarResizeBounds.min)} aria-valuemax={Math.round(paneResize.sidebarResizeBounds.max)} aria-valuenow={paneResize.sidebarResizeValue} title="Resize panes" onPointerDown={paneResize.startSidebarResize} onDoubleClick={paneResize.resetWorkFolderSidebarWidth} onKeyDown={paneResize.handleSidebarResizeKeyDown}><span className="sr-only">Resize panes</span></button>
    <aside className="right-rail" id="work-folder-chat-panel">
      <WorkFolderSurfaceTabBar tabs={tabs.surfaceTabs} workFolders={workFolders} workFolderCustomizations={customizations} conversations={conversationGroups} chatActivityStatuses={chatActivity.statuses} activeTabId={tabs.activeSurfaceTabId} newChatWorkFolderId={workFolder.id} onActivate={tabs.setActiveSurfaceTabId} onClose={tabs.closeSurfaceTab} onReorder={tabs.reorderSurfaceTabs} onNewChatInWorkFolder={(target) => openChat(target, null)} onChatActions={openChatActions} isSharedFile={(workFolderId, path) => Boolean(activeSharedPageFor(sharedPages, workFolderId, path))} />
      {tabs.surfaceTabs.length ? tabs.surfaceTabs.map((tab) => {
        const targetWorkFolder = workFolders.find((item) => item.id === tab.workFolderId);
        if (!targetWorkFolder) return null;
        const active = tab.id === tabs.activeSurfaceTabId;
        const targetIdentity = workFolderIdentityFor(targetWorkFolder, customizations);
        const targetConversation = tab.kind === "chat" && tab.conversationId
          ? conversationGroups[targetWorkFolder.id]?.find((conversation) => conversation.id === tab.conversationId) ?? null
          : null;
        const targetConversationLifecycle = targetConversation ? conversationLifecycleView(targetConversation) : "active";
        return (
          <div className="work-folder-surface-body" role="tabpanel" id={surfacePanelDomId(tab.id)} aria-labelledby={surfaceTabDomId(tab.id)} hidden={!active} key={tab.id} style={workFolderIdentityStyle(targetIdentity)}>
            {tab.kind === "file" && tab.path ? (
              <FileDetailsPane workFolder={targetWorkFolder} path={tab.path} entry={targetWorkFolder.id === workFolder.id ? findTreeEntry(tree.tree, tab.path) : null} fixtureMode={Boolean(fixture)} onOpenLocal={(path, action) => openLocalPath(path, action, targetWorkFolder)} onAddToChatContext={attachToChat} onShowVersionHistory={(path) => openVersionHistory(targetWorkFolder, path)} onRename={targetWorkFolder.id === workFolder.id ? renameEntry : undefined} canOpenWith={canOpenWith} shareRequestId={shareRequest && shareRequest.workFolderId === targetWorkFolder.id && shareRequest.path === tab.path ? shareRequest.id : undefined} onOpenSettings={openSharingSettings} />
            ) : tab.kind === "work-folder-automations" ? (
              <WorkFolderAutomationsPane
                workFolder={targetWorkFolder}
                automations={folderAutomations.byWorkFolder[targetWorkFolder.id]}
                active={active}
                fixtureMode={Boolean(fixture)}
                onRefresh={() => folderAutomations.refresh(targetWorkFolder.id)}
                onOpenAllAutomations={() => onOpenSettings("automations")}
              />
            ) : tab.kind === "checks" ? (
              <ChecksPane
                workFolder={targetWorkFolder}
                active={active}
                onOpenFile={(path) => {
                  if (targetWorkFolder.id === workFolder.id) {
                    setActiveMode("files");
                    tree.setSelectedPath(path);
                  }
                  tabs.openFileSurfaceTab(targetWorkFolder, path);
                }}
                onChecksChanged={() => targetWorkFolder.id === workFolder.id ? checks.refresh() : undefined}
                onAskWorker={(text) => {
                  const surfaceTabId = tabs.openChatSurfaceTab(targetWorkFolder, null);
                  setDraftRequest({ id: ++draftRequestId.current, text, workFolderId: targetWorkFolder.id, surfaceTabId });
                }}
              />
            ) : tab.kind === "app-studio" ? (
              <AppStudioPane
                workFolder={targetWorkFolder}
                navigation={appStudioNavigation?.sourceWorkFolderId === targetWorkFolder.id ? appStudioNavigation : null}
                workFolders={workFolders}
                active={active}
                previewRevision={(restrictedAppsState.appsByWorkFolder[targetWorkFolder.id] ?? [])
                  .filter((app) => app.runtimeInstanceKind === "development")
                  .map((app) => `${app.featureInstallationId}:${app.digest}:${app.updatedAt}`)
                  .sort()
                  .join("|")}
                fixtureMode={Boolean(fixture)}
                onAppsChanged={(workFolderId, runtimeInstanceId, apps) => {
                  restrictedAppsState.replaceRuntimeInstanceApps(workFolderId, runtimeInstanceId, apps);
                  void restrictedAppsState.refresh(workFolderId);
                }}
                onError={onError}
              />
            ) : tab.kind === "history" ? (
              <HistoryPane onRestored={async () => { setHistoryRefreshRequest((value) => value + 1); await tree.refresh(false); await checks.refresh(); }} workFolder={targetWorkFolder} fixtureItems={fixture?.checkpoints[targetWorkFolder.id]} refreshRequest={targetWorkFolder.id === workFolder.id ? historyRefreshRequest : 0} selectedCheckpointId={tab.checkpointId} onOpen={(item) => tabs.openHistorySurfaceTab(targetWorkFolder, item.checkpointId, item.label || "Restore point")} onError={onError} />
            ) : tab.kind === "extension" ? (() => {
              const targetSurfaceInventoryKnown = Object.prototype.hasOwnProperty.call(surfaceCatalogs, targetWorkFolder.id);
              if (!targetSurfaceInventoryKnown) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app view" text="Checking the tools installed for this work-folder." />;
              const targetSurfaces = contributedSurfaces(targetWorkFolder.id, surfaceCatalogs[targetWorkFolder.id] ?? []);
              const surface = targetSurfaces.find((item) => surfaceMatchesTab(item, tab));
              const view = surface?.views.find((item) => item.id === tab.viewId);
              return surface && view ? <ExtensionSurfaceView surface={surface} view={view} /> : <ExtensionSurfaceUnavailable surfaceId={tab.surfaceId} viewId={tab.viewId} execution={tab.surfaceExecution} />;
            })() : tab.kind === "restricted-app" ? (() => {
              if (!restrictedAppsState.knownWorkFolderIds.has(targetWorkFolder.id)) return <CenteredState icon={<Loader2 className="spin" size={24} />} title="Loading app" text="Checking the apps installed for this work-folder." />;
              const app = restrictedAppsState.appsByWorkFolder[targetWorkFolder.id]?.find((item) => item.manifest.id === tab.appId && item.digest === tab.digest && item.featureInstallationId === tab.featureInstallationId);
              return app
                ? <RestrictedAppViewport app={app} placement="tab" appTabId={tab.appTabId} route={tab.route} state={tab.state} active={active} />
                : <CenteredState icon={<AlertTriangle size={24} />} title="App unavailable" text="This tab belongs to an app revision that is no longer installed in this work-folder." />;
            })() : tab.kind === "chat" ? (
              <ChatPanel surfaceTabId={tab.id} workFolder={targetWorkFolder} workFolderCustomizations={customizations} modelConfigurationRevision={modelConfigurationRevision} active={active} targetConversationId={tab.conversationId ?? null} lifecycleView={targetConversationLifecycle} onResumeConversation={targetConversation ? () => updateChatLifecycle(targetWorkFolder, targetConversation, targetConversationLifecycle === "archived" ? { archived: false } : { snoozedUntil: null }).then(() => {}).catch((caught) => onError(errorText(caught))) : undefined} contextPathRequest={chatContextRequestForTab(contextRequest, targetWorkFolder.id, tab.id)} draftRequest={chatDraftRequestForTab(draftRequest, targetWorkFolder.id, tab.id)} onAddPathToChatContext={active && targetWorkFolder.id === workFolder.id ? attachToChat : undefined} onUploadDroppedFiles={active && targetWorkFolder.id === workFolder.id ? uploadDroppedFilesForChat : undefined} onOpenWorkFolderFile={active && targetWorkFolder.id === workFolder.id ? (path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workFolder, path); } : undefined} selectedPath={active && targetWorkFolder.id === workFolder.id ? tree.selectedPath : null} onConversationActivated={(conversation) => tabs.handleTabConversationActivated(tab.id, targetWorkFolder, conversation)} onConversationsChanged={(conversations) => setConversationGroups((current) => ({ ...current, [targetWorkFolder.id]: conversations }))} onRunningChange={(conversationId, running) => chatActivity.setRunning(chatActivityKey(targetWorkFolder.id, conversationId), running)} onSettled={(conversationId, needsAttention) => chatActivity.setAttention(chatActivityKey(targetWorkFolder.id, conversationId), needsAttention)} onViewed={(conversationId) => chatActivity.setAttention(chatActivityKey(targetWorkFolder.id, conversationId), false)} onAgentFinished={() => targetWorkFolder.id === workFolder.id ? tree.refresh() : undefined} onOpenModelSettings={() => onOpenSettings("ai-models", "work-folder", true, targetWorkFolder.id)} onRestrictedAppProposalRequested={() => tabs.setActiveSurfaceTabId(tab.id)} onRestrictedAppInstalled={(app) => openInstalledRestrictedApp(targetWorkFolder, app)} fixtureMode={Boolean(fixture)} fixtureConversations={fixture && (tab.conversationId || tab.id === `chat:${targetWorkFolder.id}:new`) ? fixture.conversations[targetWorkFolder.id] : undefined} fixtureTreeEntries={fixture?.trees[targetWorkFolder.id]} mentionFolders={mentionFoldersFor(targetWorkFolder)} />
            ) : null}
          </div>
        );
      }) : <WorkFolderSurfaceEmptyState workFolder={workFolder} identity={identity} onNewChat={() => openChat(workFolder, null)} />}
    </aside>
    {appearanceWorkFolder ? <WorkFolderAppearanceModal
      key={appearanceWorkFolder.id}
      workFolder={appearanceWorkFolder}
      initialSection={appearanceInitialSection}
      identity={workFolderIdentityFor(appearanceWorkFolder, customizations)}
      customization={customizations[appearanceWorkFolder.id]}
      canUndo={(appearanceHistoryRef.current.get(appearanceWorkFolder.id)?.length ?? 0) > 0}
      onRenameWorkFolder={renameWorkFolder}
      onCustomizeWorkFolder={customizeWorkFolder}
      onReplaceWorkFolder={replaceWorkFolderCustomization}
      onUndoWorkFolder={undoWorkFolderCustomization}
      onResetWorkFolder={resetWorkFolderCustomization}
      onOpenWorkerSettings={(section, returnSection) => {
        setAppearanceWorkFolderId(null);
        onOpenSettings("ai-models", "work-folder", section === "model", appearanceWorkFolder.id, section === "instructions", () => {
          setAppearanceInitialSection(returnSection);
          setAppearanceWorkFolderId(appearanceWorkFolder.id);
        });
      }}
      onClose={closeWorkFolderAppearance}
    /> : null}
    {fileContextMenu ? <FileContextMenu state={fileContextMenu} onSelect={(path) => { tree.setSelectedPath(path); tabs.openFileSurfaceTab(workFolder, path); }} onOpenLocal={openLocalPath} canOpenWith={canOpenWith} onAddToChatContext={attachToChat} onCopyPath={copyPath} onShowVersionHistory={(path) => openVersionHistory(workFolder, path)} onRename={fileContextMenu.entry.path && !holdsNestedFolder(fileContextMenu.entry) ? renameEntry : undefined} onNewFolder={requestNewFolder} onUploadHere={chooseUpload} onRefresh={() => void tree.refresh(false)} onGiveWorker={canGiveOwnWorker(fileContextMenu.entry) ? (path) => void giveOwnWorker(path) : undefined} onDelete={deleteEntry} canDelete={!holdsNestedFolder(fileContextMenu.entry)} onShare={shareFile} shareWorkFolderId={workFolder.id} fixtureMode={Boolean(fixture)} onClose={() => setFileContextMenu(null)} /> : null}
    {newFolderTarget ? <NewFolderModal target={newFolderTarget} fixtureMode={Boolean(fixture)} onCreated={(folder) => void folderCreated(folder, newFolderTarget)} onClose={() => setNewFolderTarget(null)} /> : null}
    {renameEntryRequest ? <TextInputModal title={`Rename ${renameEntryRequest.name}`} label="Name" initialValue={renameEntryRequest.name} confirmLabel="Rename" onSubmit={submitEntryRename} onClose={() => setRenameEntryRequest(null)} /> : null}
    {chatActions ? <ChatActionsPopover state={chatActions} onRename={renameChat} onLifecycle={(target, conversation, patch) => updateChatLifecycle(target, conversation, patch).then(() => {})} onDelete={deleteChat} onClose={() => setChatActions(null)} /> : null}
    {versionHistory ? <FileVersionHistoryModal workFolder={versionHistory.workFolder} filePath={versionHistory.path} fileName={versionHistory.name} onClose={() => setVersionHistory(null)} onRestored={() => void tree.refresh()} /> : null}
    {skillsExtensionsView ? <SkillsExtensionsModal workFolder={workFolder} status={agent} initialView={skillsExtensionsView} fixtureMode={Boolean(fixture)} onError={onError} onCatalogChanged={(catalog) => updateSurfaceCatalog(workFolder.id, catalog)} onClose={() => setSkillsExtensionsView(null)} /> : null}
    {commandPaletteOpen ? <CommandPaletteHost commands={commands} onClose={closeCommandPalette} /> : null}
  </main>;
}

function WorkFolderSurfaceEmptyState({ workFolder, identity, onNewChat }: { workFolder: WorkFolderSummary; identity: ReturnType<typeof workFolderIdentityFor>; onNewChat: () => void }) {
  return <div className="work-folder-surface-body work-folder-surface-body-empty"><div className="work-folder-surface-empty" style={workFolderIdentityStyle(identity)}><span className="work-folder-surface-empty-icon"><WorkFolderIconGlyph icon={identity.Icon} size={24} /></span><h2>{workFolder.name}</h2><button className="ui-control ui-control--primary" type="button" onClick={onNewChat}><CirclePlus size={16} />New Chat</button></div></div>;
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

function pendingDeleteKey(pending: Pick<PendingDelete, "workFolderId" | "path">) {
  return `${pending.workFolderId}:${pending.path}`;
}

async function deleteLocalFileRequest(pending: PendingDelete, keepalive = false): Promise<DeleteLocalFileResult> {
  const sessionHeaders = await window.workFoldDesktop?.api.getSessionHeaders?.();
  const response = await fetch(apiUrl(`/api/work-folders/${pending.workFolderId}/local-file`), {
    method: "DELETE",
    headers: { "content-type": "application/json", ...(sessionHeaders ?? {}) },
    body: JSON.stringify({ path: pending.path }),
    keepalive,
  });
  if (response.ok) {
    // A delete History could not fully keep a copy of still succeeds: the
    // entry is waiting in Recently Deleted instead (docs/receipts-not-gates.md).
    try { return await response.json() as DeleteLocalFileResult; } catch { return {}; }
  }
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

function fixtureConversationGroups(fixture: WorkFolderUiFixture): Record<string, ConversationSummary[]> { return Object.fromEntries(Object.entries(fixture.conversations).map(([id, conversations]) => [id, conversations.map(({ messages: _messages, ...summary }) => summary)])); }
function normalizeMode(value: string | null): WorkFolderRailMode {
  if (value?.startsWith("app:") && /^[a-z0-9][a-z0-9:_-]{0,255}$/i.test(value.slice(4))) return value as WorkFolderRailMode;
  return (["files", "chats", "history"] as WorkFolderRailMode[]).includes(value as WorkFolderRailMode) ? value as WorkFolderRailMode : "files";
}

function extensionSurfaceIdForMode(mode: WorkFolderRailMode): string | null {
  return mode.startsWith("app:") && !mode.startsWith("app:restricted:") ? mode.slice(4) : null;
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
