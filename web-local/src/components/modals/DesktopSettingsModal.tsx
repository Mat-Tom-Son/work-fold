import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowClockwise20Regular,
  Bot20Regular,
  Color20Regular,
  Desktop20Regular,
  Dismiss20Regular,
  Info20Regular,
  Laptop20Regular,
  Power20Regular,
  Settings20Regular,
  Subtract20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
} from "@fluentui/react-icons";
import { textSizeOptions, typographyFontOptionsForPlatform } from "../../constants";
import { useModalDialog } from "../../hooks/useModalDialog";
import { errorText } from "../../lib/api";
import type { AgentStatus, AppTheme, AppThemePreference, AppTypographyPreference, DesktopUpdateStatus, SpaceSummary } from "../../types";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { AssistantSetupPane } from "../panes/spacePanes";

export type SettingsPage = "appearance" | "assistant" | "desktop" | "about";

export function DesktopSettingsModal({ theme, themePreference, onThemePreferenceChange, typography, onTypographyChange, space, agentStatus, fixtureMode = false, initialPage = "appearance", onAgentConfigured, onClose, updateStatus, onUpdateAction }: {
  theme: AppTheme;
  themePreference: AppThemePreference;
  onThemePreferenceChange: (theme: AppThemePreference) => void;
  typography: AppTypographyPreference;
  onTypographyChange: (update: Partial<AppTypographyPreference>) => void;
  space: SpaceSummary | null;
  agentStatus: AgentStatus;
  fixtureMode?: boolean;
  initialPage?: SettingsPage;
  onAgentConfigured: (status: AgentStatus) => void;
  onClose: () => void;
  updateStatus: DesktopUpdateStatus | null;
  onUpdateAction?: () => void;
}) {
  const typographyFontOptions = typographyFontOptionsForPlatform(window.workFoldDesktop?.app.platform);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [closeToTray, setCloseToTray] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [closeToTrayBusy, setCloseToTrayBusy] = useState(false);
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });

  useEffect(() => { setPage(initialPage); }, [initialPage]);
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
    setCloseToTray({ ...closeToTray, enabled });
    try {
      setCloseToTray(await desktopWindow.setCloseToTray(enabled));
    } catch (caught) {
      setCloseToTray(previous);
      setCloseToTrayError(errorText(caught));
    } finally {
      setCloseToTrayBusy(false);
    }
  }

  const tabs: Array<{ id: SettingsPage; label: string; detail: string; icon: ReactNode }> = [
    { id: "appearance", label: "Appearance", detail: "Theme and type", icon: <Color20Regular /> },
    { id: "assistant", label: "Assistant", detail: "Provider and model", icon: <Bot20Regular /> },
    { id: "desktop", label: "Desktop", detail: "Window and updates", icon: <Desktop20Regular /> },
    { id: "about", label: "About", detail: "work-fold details", icon: <Info20Regular /> },
  ];

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title settings-title">
          <div className="settings-title-copy">
            <span className="settings-title-mark" aria-hidden="true"><Settings20Regular /></span>
            <div><h2 id="settings-title">Settings</h2></div>
          </div>
          <button ref={closeRef} className="minimal-icon-button" type="button" onClick={onClose} aria-label="Close settings"><Dismiss20Regular /></button>
        </div>
        <div className="settings-form">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {tabs.map((tab) => (
              <button
                className={page === tab.id ? "settings-tab active" : "settings-tab"}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={page === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                key={tab.id}
                onClick={() => setPage(tab.id)}
              >
                <span className="settings-tab-icon" aria-hidden="true">{tab.icon}</span>
                <span className="settings-tab-copy"><strong>{tab.label}</strong><small>{tab.detail}</small></span>
              </button>
            ))}
          </div>
          <div className="settings-content">
            {page === "appearance" ? (
              <div className="settings-tab-panel" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <div className="settings-quick-grid">
                  <section className="settings-section" aria-labelledby="appearance-theme-title">
                    <div className="settings-section-heading"><h3 id="appearance-theme-title">Theme</h3></div>
                    <div className="theme-segmented-control" role="radiogroup" aria-label="Color mode">
                      <button className={themePreference === "system" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "system"} aria-label={`Device setting, currently ${theme}`} onClick={() => onThemePreferenceChange("system")}>
                        <Laptop20Regular /><span className="theme-choice-copy"><span>Device setting</span><small>Match your device’s appearance</small></span>
                      </button>
                      <button className={themePreference === "light" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "light"} onClick={() => onThemePreferenceChange("light")}>
                        <WeatherSunny20Regular /><span className="theme-choice-copy"><span>Light</span></span>
                      </button>
                      <button className={themePreference === "dark" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "dark"} onClick={() => onThemePreferenceChange("dark")}>
                        <WeatherMoon20Regular /><span className="theme-choice-copy"><span>Dark</span></span>
                      </button>
                    </div>
                  </section>
                  <section className="settings-section typography-settings-section" aria-labelledby="appearance-typography-title">
                    <div className="settings-section-heading"><h3 id="appearance-typography-title">Typography</h3></div>
                    <div className="settings-choice-group">
                      <span className="settings-choice-label">Font</span>
                      <div className="font-choice-grid" role="radiogroup" aria-label="App font">
                        {typographyFontOptions.map((option) => (
                          <button className={typography.font === option.value ? "font-choice-button active" : "font-choice-button"} data-font-option={option.value} type="button" key={option.value} role="radio" aria-checked={typography.font === option.value} onClick={() => onTypographyChange({ font: option.value })}>
                            <span className="font-choice-sample" aria-hidden="true">Aa</span><span className="font-choice-copy"><strong>{option.label}</strong></span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-choice-group">
                      <span className="settings-choice-label">Text size</span>
                      <div className="text-size-segmented-control" role="radiogroup" aria-label="Text size">
                        {textSizeOptions.map((option) => (
                          <button className={typography.textSize === option.value ? "active" : ""} type="button" key={option.value} role="radio" aria-checked={typography.textSize === option.value} onClick={() => onTypographyChange({ textSize: option.value })}>
                            <span>{option.label}</span><small>{option.detail}</small>
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            ) : null}
            {page === "assistant" ? (
              <div className="settings-tab-panel" id="settings-panel-assistant" role="tabpanel" aria-labelledby="settings-tab-assistant">
                {space ? (
                  <AssistantSetupPane space={space} status={agentStatus} fixtureMode={fixtureMode} embedded onConfigured={onAgentConfigured} />
                ) : (
                  <section className="settings-section" aria-labelledby="assistant-settings-title">
                    <div className="settings-section-heading"><h3 id="assistant-settings-title">Assistant</h3></div>
                    <p>Create a Space or turn a folder into one before choosing a provider and model.</p>
                  </section>
                )}
              </div>
            ) : null}
            {page === "desktop" ? (
              <div className="settings-tab-panel" id="settings-panel-desktop" role="tabpanel" aria-labelledby="settings-tab-desktop">
                {closeToTray?.supported ? (
                  <section className="settings-section" aria-labelledby="window-close-settings-title">
                    <div className="settings-section-heading"><h3 id="window-close-settings-title">Closing the window</h3>{closeToTrayBusy ? <span><ArrowClockwise20Regular className="spin" /> Updating</span> : null}</div>
                    <div className="theme-segmented-control two-options" role="radiogroup" aria-label="Close button behavior">
                      <button className={closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={closeToTray.enabled} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(true)}>
                        <Subtract20Regular /><span className="theme-choice-copy"><span>Keep work-fold running</span><small>Hide to the system tray so active work can continue</small></span>
                      </button>
                      <button className={!closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={!closeToTray.enabled} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(false)}>
                        <Power20Regular /><span className="theme-choice-copy"><span>Quit work-fold</span><small>Stop the app when its window closes</small></span>
                      </button>
                    </div>
                    {closeToTrayError ? <span className="settings-inline-error" role="alert">{closeToTrayError}</span> : null}
                  </section>
                ) : null}
                <section className="settings-section update-settings-section" aria-labelledby="desktop-update-settings-title">
                  <div><div className="settings-section-heading"><h3 id="desktop-update-settings-title">Updates</h3></div><p>{updateStatus?.message ?? "Update status is available in the installed desktop app."}</p>{updateStatus?.error ? <span className="settings-inline-error" role="alert">{updateStatus.error}</span> : null}{updateStatus?.phase === "downloading" && updateStatus.progressPercent !== null ? <progress max={100} value={updateStatus.progressPercent}>{Math.round(updateStatus.progressPercent)}%</progress> : null}</div>
                  {onUpdateAction && updateStatus?.supported ? <button className="secondary-button" type="button" disabled={updateStatus.phase === "checking" || updateStatus.phase === "downloading" || updateStatus.phase === "installing"} onClick={onUpdateAction}><ArrowClockwise20Regular className={updateStatus.phase === "checking" || updateStatus.phase === "downloading" ? "spin" : undefined} />{settingsUpdateActionLabel(updateStatus)}</button> : null}
                </section>
              </div>
            ) : null}
            {page === "about" ? (
              <div className="settings-tab-panel" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about">
                <section className="settings-section">
                  <WorkFoldLockup className="about-work-fold-brand" />
                  <div className="settings-section-heading"><h3>About work-fold</h3></div>
                  <p>A local-first place for files, Chats, reusable materials, and Assistant tools.</p>
                  <dl className="context-meta-grid"><div><dt>Version</dt><dd>{window.workFoldDesktop?.app.version ?? "Development"}</dd></div><div><dt>Storage</dt><dd>Local</dd></div><div><dt>License</dt><dd>MIT</dd></div></dl>
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function settingsUpdateActionLabel(status: DesktopUpdateStatus) {
  if (status.phase === "available") return "Download update";
  if (status.phase === "ready") return "Restart and install";
  if (status.phase === "error") return "Retry";
  if (status.phase === "checking") return "Checking";
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading" : `${Math.round(status.progressPercent)}%`;
  return "Check for updates";
}
