import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise20Regular,
  Checkmark16Regular,
  Dismiss20Regular,
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

export type SettingsPage = "appearance" | "assistant" | "remote" | "desktop" | "about";

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
  const [closeToTrayNotice, setCloseToTrayNotice] = useState<string | null>(null);
  const [appearanceNotice, setAppearanceNotice] = useState<string | null>(null);
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

  const tabs: Array<{ id: SettingsPage; label: string }> = [
    { id: "appearance", label: "Appearance" },
    { id: "assistant", label: "Assistant" },
    { id: "remote", label: "Remote access" },
    { id: "desktop", label: "Desktop" },
    { id: "about", label: "About" },
  ];

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={dialogRef} tabIndex={-1} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title settings-title">
          <div className="settings-title-copy">
            <span className="settings-title-mark" aria-hidden="true"><Settings20Regular /></span>
            <div><h2 id="settings-title">Settings</h2></div>
          </div>
          <button ref={closeRef} className="minimal-icon-button settings-close-button" type="button" onClick={onClose} aria-label="Close settings"><Dismiss20Regular /></button>
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
                <span>{tab.label}</span>
              </button>
            ))}
          </div>
          <div className="settings-content">
            {page === "appearance" ? (
              <div className="settings-tab-panel" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <p className="settings-save-status settings-appearance-status" role="status">{appearanceNotice ? <><Checkmark16Regular />{appearanceNotice}</> : "Changes save automatically"}</p>
                <div className="settings-quick-grid">
                  <section className="settings-section" aria-labelledby="appearance-theme-title">
                    <div className="settings-section-heading"><h3 id="appearance-theme-title">Theme</h3></div>
                    <div className="theme-segmented-control" role="radiogroup" aria-label="Color mode">
                      <button className={themePreference === "system" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "system"} aria-label={`Device setting, currently ${theme}`} onClick={() => { onThemePreferenceChange("system"); setAppearanceNotice("Saved"); }}>
                        <Laptop20Regular /><span className="theme-choice-copy"><span>Device setting</span><small>Match your device’s appearance</small></span>
                      </button>
                      <button className={themePreference === "light" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "light"} onClick={() => { onThemePreferenceChange("light"); setAppearanceNotice("Saved"); }}>
                        <WeatherSunny20Regular /><span className="theme-choice-copy"><span>Light</span></span>
                      </button>
                      <button className={themePreference === "dark" ? "active" : ""} type="button" role="radio" aria-checked={themePreference === "dark"} onClick={() => { onThemePreferenceChange("dark"); setAppearanceNotice("Saved"); }}>
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
                          <button className={typography.font === option.value ? "font-choice-button active" : "font-choice-button"} data-font-option={option.value} type="button" key={option.value} role="radio" aria-checked={typography.font === option.value} onClick={() => { onTypographyChange({ font: option.value }); setAppearanceNotice("Saved"); }}>
                            <span className="font-choice-sample" aria-hidden="true">Aa</span><span className="font-choice-copy"><strong>{option.label}</strong></span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="settings-choice-group">
                      <span className="settings-choice-label">Text size</span>
                      <div className="text-size-segmented-control" role="radiogroup" aria-label="Text size">
                        {textSizeOptions.map((option) => (
                          <button className={typography.textSize === option.value ? "active" : ""} type="button" key={option.value} role="radio" aria-checked={typography.textSize === option.value} onClick={() => { onTypographyChange({ textSize: option.value }); setAppearanceNotice("Saved"); }}>
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
            {page === "remote" ? (
              <div className="settings-tab-panel" id="settings-panel-remote" role="tabpanel" aria-labelledby="settings-tab-remote">
                <RemoteAccessPane />
              </div>
            ) : null}
            {page === "desktop" ? (
              <div className="settings-tab-panel" id="settings-panel-desktop" role="tabpanel" aria-labelledby="settings-tab-desktop">
                {closeToTray?.supported ? (
                  <section className="settings-section" aria-labelledby="window-close-settings-title">
                    <div className="settings-section-heading"><h3 id="window-close-settings-title">Closing the window</h3>{closeToTrayBusy ? <span><ArrowClockwise20Regular className="spin" /> Updating</span> : closeToTrayNotice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{closeToTrayNotice}</span> : null}</div>
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

interface RemoteAccessViewStatus {
  configured: boolean;
  enabled: boolean;
  connection: "stopped" | "connecting" | "connected" | "error";
  slug: string | null;
  url: string | null;
  lastError: string | null;
  approvedBrowsers: Array<{ id: string; browserId: string; label: string; approvedAt: string }>;
}

function RemoteAccessPane() {
  const remote = window.workFoldDesktop?.remoteAccess;
  const [status, setStatus] = useState<RemoteAccessViewStatus | null>(null);
  const [slug, setSlug] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!remote) return;
    let cancelled = false;
    void remote.getStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setSlug(next.slug ?? "");
      })
      .catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    const unsubscribe = remote.onStatusChanged((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [remote]);

  async function run(label: string, operation: () => Promise<RemoteAccessViewStatus | void>) {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      const next = await operation();
      if (next) {
        setStatus(next);
        setSlug(next.slug ?? "");
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (!remote) return;
    setNotice(null);
    if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(slug) || slug.length < 3) {
      setError("Choose 3–32 lowercase letters, numbers, or hyphens.");
      return;
    }
    if (password.length < 8) {
      setError("Use a password of at least 8 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    await run("save", async () => {
      const wasConfigured = Boolean(status?.configured);
      const next = await remote.configure({ slug, password });
      setPassword("");
      setConfirmation("");
      setNotice(wasConfigured ? "Changes saved" : "Private address created");
      return next;
    });
  }

  if (!remote) {
    return (
      <section className="settings-section" aria-labelledby="remote-access-title">
        <div className="settings-section-heading"><h3 id="remote-access-title">Remote access</h3></div>
        <p>Remote access can be configured from the installed desktop app.</p>
      </section>
    );
  }

  const connectionLabel = !status?.configured
    ? "Not set up"
    : !status.enabled
      ? "Disabled"
      : status.connection === "connected"
        ? "Desktop connected"
        : status.connection === "connecting"
          ? "Connecting"
          : "Needs attention";
  const remoteSettingsChanged = !status?.configured
    || slug !== (status.slug ?? "")
    || Boolean(password)
    || Boolean(confirmation);

  return (
    <>
      <section className="settings-section remote-access-overview" aria-labelledby="remote-access-title">
        <div className="settings-section-heading">
          <h3 id="remote-access-title">Your private web address</h3>
          <span className={`remote-access-state ${status?.connection ?? "stopped"}`}>{connectionLabel}</span>
        </div>
        <p>Private alpha. Use the same management Assistant and running log from a browser. Content is application-encrypted in transit, but the hosted work-fold client is part of the trusted authority boundary.</p>
        {status?.url ? <code className="remote-access-url">{status.url}</code> : null}
        <div className="remote-access-actions">
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy) || !status.enabled} onClick={() => void run("open", async () => remote.open())}>Open address</button> : null}
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("toggle", () => remote.setEnabled(!status.enabled))}>{status.enabled ? "Disable" : "Enable"} remote access</button> : null}
        </div>
        {status?.lastError ? <span className="settings-inline-error" role="alert">{status.lastError}</span> : null}
      </section>

      <section className="settings-section" aria-labelledby="remote-address-settings-title">
        <div className="settings-section-heading"><h3 id="remote-address-settings-title">{status?.configured ? "Change address or password" : "Set up remote access"}</h3></div>
        <div className="remote-access-fields">
          <label className="settings-field"><span>Web address</span><div className="remote-slug-field"><input value={slug} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="your-name" maxLength={32} disabled={Boolean(busy)} onChange={(event) => { setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setError(null); setNotice(null); }} /><span>.work-fold.com</span></div></label>
          <label className="settings-field"><span>{status?.configured ? "New password" : "Password"}</span><input type="password" value={password} autoComplete="new-password" minLength={8} maxLength={256} placeholder="At least 8 characters" disabled={Boolean(busy)} onChange={(event) => { setPassword(event.target.value); setError(null); setNotice(null); }} /></label>
          <label className="settings-field"><span>Confirm password</span><input type="password" value={confirmation} autoComplete="new-password" minLength={8} maxLength={256} disabled={Boolean(busy)} onChange={(event) => { setConfirmation(event.target.value); setError(null); setNotice(null); }} /></label>
        </div>
        <div className="settings-actions">{notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}<button className="primary-button" type="button" disabled={Boolean(busy) || !remoteSettingsChanged} onClick={() => void save()}>{busy === "save" ? "Saving…" : status?.configured ? "Save changes" : "Create private address"}</button></div>
        {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      </section>

      {status?.configured ? (
        <section className="settings-section" aria-labelledby="approved-browsers-title">
          <div className="settings-section-heading"><h3 id="approved-browsers-title">Approved browsers</h3><span>{status.approvedBrowsers.length}</span></div>
          <p>Every new browser must show a six-digit code that you approve on this desktop. Approval is full trust: that browser may ask work-fold to read or change accessible files and run local commands.</p>
          {status.approvedBrowsers.length ? <div className="remote-browser-list">{status.approvedBrowsers.map((browser) => (
            <div className="remote-browser-row" key={browser.id}><div><strong>{browser.label}</strong><small>Approved {new Date(browser.approvedAt).toLocaleDateString()}</small></div><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run(`revoke-${browser.id}`, () => remote.revokeBrowser(browser.id))}>Revoke</button></div>
          ))}</div> : <div className="remote-browser-empty">No browser has been approved yet.</div>}
          <div className="remote-access-danger-actions">
            <button className="secondary-button danger" type="button" disabled={Boolean(busy) || !status.approvedBrowsers.length} onClick={() => { if (window.confirm("Revoke every approved browser? Each one will need desktop approval again.")) void run("revoke-all", () => remote.revokeAll()); }}>Revoke all browsers</button>
            <button className="secondary-button danger" type="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Remove this private address and all remote access? This cannot be undone.")) void run("remove", () => remote.remove()); }}>Remove remote access</button>
          </div>
        </section>
      ) : null}
    </>
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
