import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { LayoutPanelLeft } from "lucide-react";
import {
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  Checkmark16Regular,
  Dismiss20Regular,
  Delete20Regular,
  Flash20Regular,
  Info20Regular,
  Keyboard20Regular,
  PaintBrush20Regular,
  Power20Regular,
  Sparkle20Regular,
  Subtract20Regular,
} from "@fluentui/react-icons";
import { useModalDialog } from "../../hooks/useModalDialog";
import { errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import type { AgentStatus, DesktopUpdateStatus, WorkFolderSummary } from "../../types";
import { buildFixtureUpdateStatus, fixtureAppVersion } from "../../fixtures/settings-fixture";
import { showToast } from "../../ui/feedback";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { AiModelsPane, type AiModelsDraft, type ModelScope } from "../panes/AiModelsPane";
import type { ApplicationAppearanceController } from "../../hooks/useApplicationAppearance";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { WorkFoldLimitsPane } from "./WorkFoldLimitsPane";
import { SettingsAppsPane, type RestrictedAppsState } from "./SettingsAppsPane";
import { KeyboardShortcutsPane } from "./KeyboardShortcutsPane";
import { IconCredits } from "./IconCredits";
import type { RestrictedAppInstalled } from "../../types";
import { AutomationsPane } from "./AutomationsPane";
import { RecentlyDeletedPane } from "./RecentlyDeletedPane";

export type SettingsPage = "appearance" | "ai-models" | "automations" | "apps" | "recently-deleted" | "general" | "desktop" | "shortcuts" | "about";
export type SettingsSection = "automations" | "deleted" | "limits";
type SettingsTabId = "appearance" | "ai-models" | "automations" | "apps" | "recently-deleted" | "shortcuts" | "about";
// AI Models edits nobody saved yet: closing Settings and opening it again finds them as left.
const unsavedAiModelsEdits = new Map<string, AiModelsDraft>();

/**
 * The tab a Settings page id opens. "general" and "desktop" are older ids
 * kept so existing callers still land somewhere sensible: the old
 * Desktop tab held Automations, Recently deleted and Limits, so "desktop"
 * with the "deleted" section opens Recently deleted and otherwise opens
 * Automations (where Limits now sits).
 */
export function settingsTabForPage(page: SettingsPage, section?: SettingsSection): SettingsTabId {
  if (page === "general" || page === "desktop") return section === "deleted" ? "recently-deleted" : "automations";
  return page;
}

export function DesktopSettingsModal({ appearance, onCustomizeWorkFolder, workFolder, workFolders = [], restrictedApps = null, onChangeApp, onOpenAppBuildChat, onOpenAppResultFile, onOpenAppStudio, agentStatus, fixtureMode = false, initialPage = "appearance", initialSection, initialModelScope, focusAiModel = false, focusWorkerInstructions = false, onAgentConfigured, onModelChanged, onClose, onBackToCustomization, updateStatus, onUpdateAction, layout = "classic" }: {
  appearance: ApplicationAppearanceController;
  onCustomizeWorkFolder?: (workFolderId: string) => void;
  workFolder: WorkFolderSummary | null;
  /** Settings → Apps lists every installed app by work-folder (the work-folder-owned Apps tab was retired 2026-09-25). */
  workFolders?: WorkFolderSummary[];
  restrictedApps?: RestrictedAppsState | null;
  onChangeApp?: (app: RestrictedAppInstalled) => void;
  onOpenAppBuildChat?: (workFolderId: string, conversationId: string) => void;
  onOpenAppResultFile?: (workFolderId: string, path: string) => void;
  onOpenAppStudio?: (workFolderId: string, runtimeInstanceId?: string) => void;
  agentStatus: AgentStatus;
  fixtureMode?: boolean;
  /** Which window layout Settings opened over; Shortcut Keys lists that layout's keys. */
  layout?: "classic" | "file-manager";
  initialPage?: SettingsPage;
  /** Older callers named a section of the former Desktop tab. */
  initialSection?: SettingsSection;
  initialModelScope?: ModelScope;
  focusAiModel?: boolean;
  focusWorkerInstructions?: boolean;
  onAgentConfigured: (status: AgentStatus) => void;
  onModelChanged?: (scope: ModelScope, status: AgentStatus) => void;
  onClose: () => void;
  onBackToCustomization?: () => void;
  updateStatus: DesktopUpdateStatus | null;
  onUpdateAction?: () => void;
}) {
  const [narrowNavigation, setNarrowNavigation] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [page, setPage] = useState<SettingsTabId>(() => settingsTabForPage(initialPage, initialSection));
  const [aiModelsVisited, setAiModelsVisited] = useState(initialPage === "ai-models");
  const contentRef = useRef<HTMLDivElement>(null);
  const [closeToTray, setCloseToTray] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [closeToTrayBusy, setCloseToTrayBusy] = useState(false);
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null);
  const [closeToTrayNotice, setCloseToTrayNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });
  // The browser preview stands in for the shipped app: its version, and a check that found nothing newer.
  const [fixtureUpdateStatus] = useState(() => fixtureMode ? buildFixtureUpdateStatus() : null);
  const shownUpdateStatus = updateStatus ?? fixtureUpdateStatus;
  const updateAction = fixtureMode ? () => showToast({ text: "Checking for updates is disabled in the preview", tone: "info" }) : onUpdateAction;

  useEffect(() => { setPage(settingsTabForPage(initialPage, initialSection)); }, [initialPage, initialSection]);
  useEffect(() => {
    if (page === "ai-models") setAiModelsVisited(true);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setNarrowNavigation(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let cancelled = false;
    const desktopWindow = window.workFoldDesktop?.window;
    if (!desktopWindow?.getCloseToTray) return;
    void desktopWindow.getCloseToTray()
      .then((result) => { if (!cancelled) setCloseToTray(result); })
      .catch(() => { if (!cancelled) setCloseToTray(null); });
    return () => { cancelled = true; };
  }, []);
  async function updateCloseToTray(enabled: boolean) {
    const desktopWindow = window.workFoldDesktop?.window;
    if (!desktopWindow?.setCloseToTray || !closeToTray || closeToTrayBusy || closeToTray.enabled === enabled) return;
    const previous = closeToTray;
    setCloseToTrayBusy(true);
    setCloseToTrayError(null);
    setCloseToTrayNotice(null);
    setCloseToTray({ ...closeToTray, enabled });
    try {
      setCloseToTray(await desktopWindow.setCloseToTray(enabled));
      setCloseToTrayNotice("Saved");
    } catch (caught) {
      setCloseToTray(previous);
      setCloseToTrayError(errorText(caught));
    } finally {
      setCloseToTrayBusy(false);
    }
  }

  const tabs: Array<{ id: SettingsTabId; label: string; icon: React.ReactNode }> = [
    { id: "appearance", label: "Appearance", icon: <PaintBrush20Regular /> },
    { id: "ai-models", label: "AI Models", icon: <Sparkle20Regular /> },
    { id: "automations", label: "Automations", icon: <Flash20Regular /> },
    { id: "apps", label: "Apps", icon: <LayoutPanelLeft size={20} strokeWidth={1.5} aria-hidden="true" /> },
    { id: "recently-deleted", label: "Recently Deleted", icon: <Delete20Regular /> },
    { id: "shortcuts", label: "Shortcut Keys", icon: <Keyboard20Regular /> },
    { id: "about", label: "About", icon: <Info20Regular /> },
  ];
  const closeWindowControl = closeToTray?.supported ? (
    <>
      <div className="appearance-settings-row settings-close-window-row">
        <span>
          <span className="appearance-settings-label" id="window-close-settings-title">Closing the Window</span>
          {closeToTrayBusy ? <small><ArrowClockwise20Regular className="spin" /> Updating</small> : closeToTrayNotice ? <small className="settings-save-status" role="status"><Checkmark16Regular />{closeToTrayNotice}</small> : null}
        </span>
        <div className="theme-segmented-control two-options" role="radiogroup" aria-labelledby="window-close-settings-title">
          <button className={closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={closeToTray.enabled} tabIndex={closeToTray.enabled ? 0 : -1} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(true)}>
            <Subtract20Regular /><span className="theme-choice-copy"><span>Keep work-fold Running</span></span>
          </button>
          <button className={!closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={!closeToTray.enabled} tabIndex={!closeToTray.enabled ? 0 : -1} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(false)}>
            <Power20Regular /><span className="theme-choice-copy"><span>Quit work-fold</span></span>
          </button>
        </div>
      </div>
      {closeToTrayError ? <p className="appearance-settings-error" role="alert">{closeToTrayError}</p> : null}
    </>
  ) : null;
  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="settings-modal settings-window" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title settings-title">
          <div className="settings-title-copy">
            {onBackToCustomization ? <button className="ui-control ui-control--icon settings-customization-back" type="button" onClick={onBackToCustomization} aria-label="Back to Customize work-folder" title="Back to Customize work-folder"><ArrowLeft20Regular /></button> : null}
            <div><h2 id="settings-title">Settings</h2></div>
          </div>
          <button ref={closeRef} className="ui-control ui-control--icon settings-close-button" type="button" onClick={onClose} aria-label="Close Settings"><Dismiss20Regular /></button>
        </div>
        <div className="settings-form" onKeyDown={settingsRovingKeyDown}>
          <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation={narrowNavigation ? "horizontal" : "vertical"}>
            {tabs.map((tab) => (
              <button
                className={page === tab.id ? "settings-tab active" : "settings-tab"}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={page === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={page === tab.id ? 0 : -1}
                key={tab.id}
                onFocus={(event) => event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
                onClick={() => setPage(tab.id)}
              >
                <span className="settings-nav-icon" aria-hidden="true">{tab.icon}</span><span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="settings-content" ref={contentRef}>
            {/* Every Settings page opens with its name, so the page in view is never in doubt. */}
            <h2 className="settings-page-title" aria-hidden="true">{tabs.find((tab) => tab.id === page)?.label}</h2>
            {page === "appearance" ? (
              <div className="settings-tab-panel" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <AppearanceSettingsPane appearance={appearance} workFolder={workFolder} onCustomizeWorkFolder={onCustomizeWorkFolder} interfaceExtra={closeWindowControl} />
              </div>
            ) : null}
            {page === "ai-models" || aiModelsVisited ? (
              <div hidden={page !== "ai-models"} className="settings-tab-panel" id="settings-panel-ai-models" role="tabpanel" aria-labelledby="settings-tab-ai-models">
                <AiModelsPane active={page === "ai-models"} workFolder={workFolder} status={agentStatus} fixtureMode={fixtureMode} embedded drafts={unsavedAiModelsEdits} initialScope={initialModelScope} focusModelOnOpen={focusAiModel} focusInstructionsOnOpen={focusWorkerInstructions} onConfigured={onAgentConfigured} onModelChanged={onModelChanged} />
              </div>
            ) : null}
            {page === "automations" ? (
              <div className="settings-tab-panel" id="settings-panel-automations" role="tabpanel" aria-labelledby="settings-tab-automations">
                <AutomationsPane fixtureMode={fixtureMode} />
                <WorkFoldLimitsPane onOpenRecentlyDeleted={() => setPage("recently-deleted")} fixtureMode={fixtureMode} />
              </div>
            ) : null}
            {page === "apps" ? (
              <div className="settings-tab-panel" id="settings-panel-apps" role="tabpanel" aria-labelledby="settings-tab-apps">
                <SettingsAppsPane workFolders={workFolders} apps={restrictedApps} fixtureMode={fixtureMode} onChangeApp={onChangeApp} onOpenBuildChat={onOpenAppBuildChat} onOpenResultFile={onOpenAppResultFile} onOpenAppStudio={onOpenAppStudio} />
              </div>
            ) : null}
            {page === "recently-deleted" ? (
              <div className="settings-tab-panel" id="settings-panel-recently-deleted" role="tabpanel" aria-labelledby="settings-tab-recently-deleted">
                <RecentlyDeletedPane fixtureMode={fixtureMode} />
              </div>
            ) : null}
            {page === "shortcuts" ? (
              <div className="settings-tab-panel" id="settings-panel-shortcuts" role="tabpanel" aria-labelledby="settings-tab-shortcuts">
                <KeyboardShortcutsPane layout={layout} />
              </div>
            ) : null}
            {page === "about" ? (
              <div className="settings-tab-panel" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about">
                <section className="settings-section">
                  <WorkFoldLockup className="about-work-fold-brand" />
                  <dl className="context-meta-grid"><div><dt>Version</dt><dd>{window.workFoldDesktop?.app.version ?? (fixtureMode ? fixtureAppVersion : "Development")}</dd></div><div><dt>Storage</dt><dd>Local</dd></div><div><dt>License</dt><dd>MIT</dd></div></dl>
                  <IconCredits />
                </section>
                <section className="settings-section update-settings-section" aria-labelledby="desktop-update-settings-title">
                  <div><div className="settings-section-heading"><h3 id="desktop-update-settings-title">Updates</h3></div><p>{shownUpdateStatus?.message ?? "Updates require the desktop app."}</p>{shownUpdateStatus?.error ? <span className="settings-inline-error" role="alert">{shownUpdateStatus.error}</span> : null}{shownUpdateStatus?.phase === "downloading" && shownUpdateStatus.progressPercent !== null ? <progress max={100} value={shownUpdateStatus.progressPercent}>{Math.round(shownUpdateStatus.progressPercent)}%</progress> : null}</div>
                  {updateAction && shownUpdateStatus?.supported ? <button className="ui-control" type="button" disabled={shownUpdateStatus.phase === "checking" || shownUpdateStatus.phase === "downloading" || shownUpdateStatus.phase === "installing"} onClick={updateAction}><ArrowClockwise20Regular className={shownUpdateStatus.phase === "checking" || shownUpdateStatus.phase === "downloading" ? "spin" : undefined} />{settingsUpdateActionLabel(shownUpdateStatus)}</button> : null}
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function settingsRovingKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  const key: MenuNavigationKey | null = event.key === "ArrowRight" || event.key === "ArrowDown" ? "ArrowDown"
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? "ArrowUp"
      : event.key === "Home" || event.key === "End" ? event.key : null;
  if (!key) return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;
  const group = focused.closest<HTMLElement>('[role="tablist"], [role="radiogroup"]');
  if (!group || !event.currentTarget.contains(group)) return;
  const items = Array.from(group.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')).filter((item) => !item.hasAttribute("disabled") && item.closest('[role="tablist"], [role="radiogroup"]') === group);
  const next = nextMenuItemIndex(items.indexOf(focused), items.length, key);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
  items[next]?.click();
}

function settingsUpdateActionLabel(status: DesktopUpdateStatus) {
  if (status.phase === "available") return "Download Update";
  if (status.phase === "ready") return "Restart and Install";
  if (status.phase === "error") return "Retry";
  if (status.phase === "checking") return "Checking";
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading" : `${Math.round(status.progressPercent)}%`;
  return "Check for Updates";
}
