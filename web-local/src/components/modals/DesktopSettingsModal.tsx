import { Fragment, useEffect, useRef, useState } from "react";
import type * as React from "react";
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
import { api, errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import type { AgentStatus, AppTheme, AppThemePreference, AppTypographyPreference, DesktopUpdateStatus, SpaceSummary } from "../../types";
import { foldAuthoritySettings, foldPoliciesSettings, foldPublicationsSettings } from "../../ui-contract";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { AssistantSetupPane } from "../panes/spacePanes";

export type SettingsPage = "appearance" | "assistant" | "remote" | "desktop" | "about";
type FoldSettingsSection = "access" | "pages" | "authority";

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
  const [foldSection, setFoldSection] = useState<FoldSettingsSection>("access");
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
    { id: "remote", label: "The fold" },
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
        <div className="settings-form" onKeyDown={settingsRovingKeyDown}>
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
                <AssistantSetupPane space={space} status={agentStatus} fixtureMode={fixtureMode} embedded onConfigured={onAgentConfigured} />
              </div>
            ) : null}
            {page === "remote" ? (
              <div className="settings-tab-panel" id="settings-panel-remote" role="tabpanel" aria-labelledby="settings-tab-remote">
                <div className="settings-subtabs" role="tablist" aria-label="The fold settings">
                  {([[
                    "access",
                    "Web access",
                  ], [
                    "pages",
                    "Shared pages",
                  ], [
                    "authority",
                    "Authority",
                  ]] as Array<[FoldSettingsSection, string]>).map(([id, label]) => (
                    <button className={foldSection === id ? "active" : ""} type="button" role="tab" aria-selected={foldSection === id} key={id} onClick={() => setFoldSection(id)}>{label}</button>
                  ))}
                </div>
                {foldSection === "access" ? <RemoteAccessPane /> : null}
                {foldSection === "pages" ? <FoldPublicationsPane /> : null}
                {foldSection === "authority" ? <FoldAuthorityPane /> : null}
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
  viewerOrigin: string | null;
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
        <div className="settings-section-heading"><h3 id="remote-access-title">Your fold on the web</h3></div>
        <p>Your fold on the web is set up from the installed desktop app.</p>
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
        <p>Private alpha. Your fold — the same conversation your menu bar opens — from any browser you approve. Content is application-encrypted in transit, but the hosted work-fold client is part of the trusted authority boundary.</p>
        {status?.url ? <code className="remote-access-url">{status.url}</code> : null}
        <div className="remote-access-actions">
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy) || !status.enabled} onClick={() => void run("open", async () => remote.open())}>Open address</button> : null}
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("toggle", () => remote.setEnabled(!status.enabled))}>{status.enabled ? "Disable" : "Enable"} web access</button> : null}
        </div>
        {status?.lastError ? <span className="settings-inline-error" role="alert">{status.lastError}</span> : null}
      </section>

      <section className="settings-section" aria-labelledby="remote-address-settings-title">
        <div className="settings-section-heading"><h3 id="remote-address-settings-title">{status?.configured ? "Change address or password" : "Set up your fold on the web"}</h3></div>
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
          <p>{foldAuthoritySettings.approvedBrowserInheritance}</p>
          {status.approvedBrowsers.length ? <div className="remote-browser-list">{status.approvedBrowsers.map((browser) => (
            <div className="remote-browser-row" key={browser.id}><div><strong>{browser.label}</strong><small>Approved {new Date(browser.approvedAt).toLocaleDateString()}</small></div><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run(`revoke-${browser.id}`, () => remote.revokeBrowser(browser.id))}>Revoke</button></div>
          ))}</div> : <div className="remote-browser-empty">No browser has been approved yet.</div>}
          <div className="remote-access-danger-actions">
            <button className="secondary-button danger" type="button" disabled={Boolean(busy) || !status.approvedBrowsers.length} onClick={() => { if (window.confirm("Revoke every approved browser? Each one will need desktop approval again.")) void run("revoke-all", () => remote.revokeAll()); }}>Revoke all browsers</button>
            <button className="secondary-button danger" type="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Remove this private address and all web access? This cannot be undone.")) void run("remove", () => remote.remove()); }}>Remove web access</button>
          </div>
        </section>
      ) : null}
    </>
  );
}

interface FoldPublicationView {
  publicationId: string;
  kind: "page" | "app";
  spaceId: string;
  spaceName?: string;
  /** Page slots only: the one designated Space-relative file. */
  relativePath?: string;
  /** Hosted-app slots only: the consecrated exposure binding. */
  app?: {
    appInstanceId: string;
    releaseDigest: string;
    viewerEntry: string;
    viewerSurface: string[];
  };
  title: string;
  state: "active" | "revoked" | "expired";
  live: boolean;
  serveRatePerMinute: number;
  byteBudgetPerDay: number;
  snapshotEnabled: boolean;
  createdAt: string;
  bridgeSlot: "pending" | "confirmed";
  bridgeCleanup?: "pending" | "ok";
  counters?: { served: number; servedBytes: number; lastServedAt: string };
  lastProblem?: { state: "not-available" | "resting"; reason: string; at: string };
  viewerPath: string;
}

interface FoldPublicationsResponse {
  publications: FoldPublicationView[];
  status: { damaged: boolean; damageReason?: string; activeCount: number; pendingBridgeWork: number };
}

function formatPublicationBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KiB`;
  return `${bytes} B`;
}

/** Release digest as a short id for row display, like a short commit hash. */
function shortReleaseDigest(value: string): string {
  const digest = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return `${digest.slice(0, 12)}…`;
}

/**
 * Settings → The fold → Pages your fold serves (docs/fold-publishing.md,
 * plan item 5). Reads and narrowing verbs only: revealing a link is a
 * transient on-demand composition against the viewer origin, and stop
 * sharing, budget cuts, and snapshot off are direct receipted acts on the
 * renderer session. Widening — a new page, raised budgets, snapshot on —
 * never happens here; it is staged through the fold and decided on a
 * needs-you card.
 */
function FoldPublicationsPane() {
  const remote = window.workFoldDesktop?.remoteAccess;
  const [data, setData] = useState<FoldPublicationsResponse | null>(null);
  const [viewerOrigin, setViewerOrigin] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ publicationId: string; link: string } | null>(null);
  const [narrowing, setNarrowing] = useState<{ publicationId: string; serveRate: string; byteBudgetMiB: string } | null>(null);

  async function reload() {
    try {
      setData(await api<FoldPublicationsResponse>("/api/settings/publications"));
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorText(caught));
    }
  }
  useEffect(() => {
    let cancelled = false;
    api<FoldPublicationsResponse>("/api/settings/publications")
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    if (remote) {
      void remote.getStatus()
        .then((status) => { if (!cancelled) setViewerOrigin(status.viewerOrigin); })
        .catch(() => undefined);
      const unsubscribe = remote.onStatusChanged((status) => {
        if (!cancelled) setViewerOrigin(status.viewerOrigin);
      });
      return () => { cancelled = true; unsubscribe(); };
    }
    return () => { cancelled = true; };
  }, [remote]);

  async function run(key: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      await operation();
      await reload();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function revealLink(publication: FoldPublicationView) {
    if (!viewerOrigin) {
      setActionError(foldPublicationsSettings.noAddress);
      return;
    }
    await run(`reveal-${publication.publicationId}`, async () => {
      const response = await api<{ viewerPath: string; key: string }>(
        `/api/settings/publications/${publication.publicationId}/reveal-link`,
        { method: "POST", body: {} },
      );
      // Composed transiently, held only in this pane's state until hidden.
      setRevealed({ publicationId: publication.publicationId, link: `${viewerOrigin}${response.viewerPath}#${response.key}` });
    });
  }

  async function applyNarrowing(publication: FoldPublicationView) {
    if (!narrowing || narrowing.publicationId !== publication.publicationId) return;
    const serveRate = Number(narrowing.serveRate);
    const byteBudget = Math.round(Number(narrowing.byteBudgetMiB) * 1024 * 1024);
    await run(`narrow-${publication.publicationId}`, async () => {
      await api(`/api/settings/publications/${publication.publicationId}/narrow`, {
        method: "POST",
        body: {
          ...(Number.isFinite(serveRate) && serveRate !== publication.serveRatePerMinute ? { serveRatePerMinute: serveRate } : {}),
          ...(Number.isFinite(byteBudget) && byteBudget !== publication.byteBudgetPerDay ? { byteBudgetPerDay: byteBudget } : {}),
        },
      });
      setNarrowing(null);
      setNotice("Budgets tightened");
    });
  }

  const publications = data?.publications ?? [];
  const shown = publications.filter((publication) => publication.state !== "revoked" || publication.bridgeCleanup !== "ok");
  const stateLine = (publication: FoldPublicationView): string => {
    if (publication.state === "revoked") {
      return publication.bridgeCleanup === "ok" ? "No longer shared" : "No longer shared — relay cleanup still confirming";
    }
    if (publication.state === "expired") return "Expired";
    return publication.live ? "Live from this desktop" : "Waiting on the relay to confirm";
  };
  const countersLine = (publication: FoldPublicationView): string => {
    const counters = publication.counters;
    if (!counters) return "Not served from this desktop yet";
    return `Served ${counters.served} time${counters.served === 1 ? "" : "s"} · ${formatPublicationBytes(counters.servedBytes)} · last ${new Date(counters.lastServedAt).toLocaleString()}`;
  };

  return (
    <section className="settings-section" aria-labelledby="fold-publications-title">
      <div className="settings-section-heading">
        <h3 id="fold-publications-title">{foldPublicationsSettings.heading}</h3>
        {data ? <span>{data.status.activeCount} shared</span> : null}
      </div>
      <p>{foldPublicationsSettings.intro}</p>
      <p>{foldPublicationsSettings.linkMeaning}</p>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {data?.status.damaged ? (
        <span className="settings-inline-error" role="alert">
          {data.status.damageReason ?? "The publication records could not be read."} Nothing changes until the records
          are recovered outside the app.
        </span>
      ) : null}
      {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {data && !shown.length ? <div className="remote-browser-empty">{foldPublicationsSettings.empty}</div> : null}
      {shown.length ? (
        <div className="remote-browser-list fold-publication-list">
          {shown.map((publication) => (
            <div className="fold-publication-row" key={publication.publicationId}>
              <div className="remote-browser-row">
                <div>
                  <strong>{publication.title}</strong>
                  <small>
                    {publication.kind === "app" && publication.app
                      ? <>{publication.spaceName ?? publication.spaceId}: App Instance {publication.app.appInstanceId} · Release <code>{shortReleaseDigest(publication.app.releaseDigest)}</code> — {stateLine(publication)}</>
                      : <>{publication.spaceName ?? publication.spaceId}: {publication.relativePath} — {stateLine(publication)}</>}
                  </small>
                  {publication.kind === "app" && publication.app ? (
                    <small>
                      Viewer entry {publication.app.viewerEntry} · Viewer-readable surface: {publication.app.viewerSurface.join(", ")}
                    </small>
                  ) : null}
                  <small>
                    {publication.serveRatePerMinute} serves/min · {formatPublicationBytes(publication.byteBudgetPerDay)}/day
                    {publication.kind === "page" ? <>{" · "}{publication.snapshotEnabled ? foldPublicationsSettings.snapshotOn : foldPublicationsSettings.snapshotOff}</> : null}
                  </small>
                  <small>{countersLine(publication)}</small>
                  {publication.lastProblem ? (
                    <small className="settings-inline-error" role="alert">
                      {publication.lastProblem.state === "resting" ? "Resting" : "Not reaching viewers"} — {publication.lastProblem.reason}
                    </small>
                  ) : null}
                </div>
                {publication.state === "active" ? (
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy) || !viewerOrigin}
                      title={viewerOrigin ? undefined : foldPublicationsSettings.noAddress}
                      onClick={() => {
                        if (revealed?.publicationId === publication.publicationId) setRevealed(null);
                        else void revealLink(publication);
                      }}
                    >
                      {revealed?.publicationId === publication.publicationId ? foldPublicationsSettings.hideLink : foldPublicationsSettings.revealLink}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setActionError(null);
                        setNotice(null);
                        setNarrowing(narrowing?.publicationId === publication.publicationId ? null : {
                          publicationId: publication.publicationId,
                          serveRate: String(publication.serveRatePerMinute),
                          byteBudgetMiB: String(Math.round(publication.byteBudgetPerDay / (1024 * 1024))),
                        });
                      }}
                    >
                      {foldPublicationsSettings.narrowBudgets}
                    </button>
                    {publication.snapshotEnabled ? (
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => void run(`snapshot-off-${publication.publicationId}`, async () => {
                          await api(`/api/settings/publications/${publication.publicationId}/snapshot-off`, { method: "POST", body: {} });
                          setNotice("Sleep copy off — the relay's stored copy is deleted");
                        })}
                      >
                        {foldPublicationsSettings.turnSnapshotOff}
                      </button>
                    ) : null}
                    <button
                      className="secondary-button danger"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!window.confirm(foldPublicationsSettings.stopSharingConfirm)) return;
                        setRevealed((current) => (current?.publicationId === publication.publicationId ? null : current));
                        void run(`revoke-${publication.publicationId}`, async () => {
                          await api(`/api/settings/publications/${publication.publicationId}/revoke`, { method: "POST", body: {} });
                          setNotice("Stopped sharing");
                        });
                      }}
                    >
                      {foldPublicationsSettings.stopSharing}
                    </button>
                  </div>
                ) : null}
              </div>
              {revealed?.publicationId === publication.publicationId ? (
                <div className="fold-publication-link">
                  <code className="remote-access-url">{revealed.link}</code>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => { void navigator.clipboard?.writeText(revealed.link).catch(() => undefined); setNotice("Link copied"); }}
                    >
                      {foldPublicationsSettings.copyLink}
                    </button>
                  </div>
                  <small>{foldPublicationsSettings.linkShownOnce}</small>
                </div>
              ) : null}
              {narrowing?.publicationId === publication.publicationId ? (
                <div className="fold-publication-narrow remote-access-fields">
                  <label className="settings-field">
                    <span>Serves per minute</span>
                    <input
                      type="number"
                      min={1}
                      max={publication.serveRatePerMinute}
                      value={narrowing.serveRate}
                      disabled={Boolean(busy)}
                      onChange={(event) => setNarrowing({ ...narrowing, serveRate: event.target.value })}
                    />
                  </label>
                  <label className="settings-field">
                    <span>MiB per day</span>
                    <input
                      type="number"
                      min={1}
                      max={Math.round(publication.byteBudgetPerDay / (1024 * 1024))}
                      value={narrowing.byteBudgetMiB}
                      disabled={Boolean(busy)}
                      onChange={(event) => setNarrowing({ ...narrowing, byteBudgetMiB: event.target.value })}
                    />
                  </label>
                  <small>{foldPublicationsSettings.narrowHint}</small>
                  <div className="settings-actions">
                    <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void applyNarrowing(publication)}>
                      {busy === `narrow-${publication.publicationId}` ? "Saving…" : "Apply"}
                    </button>
                  </div>
                </div>
              ) : null}
              {/* Sleep copies are a page-only lane: an app at your address is
                  structurally snapshotless, so app rows carry neither the
                  retention label nor a widening hint that has no act. */}
              {publication.kind === "page" && publication.state === "active" && publication.snapshotEnabled ? (
                <small className="fold-publication-snapshot-label">{foldPublicationsSettings.snapshotLabel}</small>
              ) : null}
              {publication.kind === "page" && publication.state === "active" && !publication.snapshotEnabled ? (
                <small className="fold-publication-snapshot-label">{foldPublicationsSettings.snapshotWidenHint}</small>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface FoldPolicyView {
  id: string;
  label: string;
  category: "make-runnable" | "widen-power";
  kind: string;
  match: Record<string, string>;
  enabled: boolean;
}

interface FoldPolicyStatusView {
  damaged: boolean;
  damageReason?: string;
  attested: boolean;
  attestationIssue?: string;
  policyCount: number;
  enabledCount: number;
}

interface FoldPolicyFieldView {
  name: string;
  label: string;
  required: boolean;
  values?: string[];
  hint?: string;
}

interface FoldPolicyKindView {
  kind: string;
  category: "make-runnable" | "widen-power";
  categoryLabel: string;
  label: string;
  fields: FoldPolicyFieldView[];
}

interface FoldPoliciesResponse {
  policies: FoldPolicyView[];
  status: FoldPolicyStatusView;
  contract: { cap: number; labelMaxChars: number; firstPartyRegistries: string[]; kinds: FoldPolicyKindView[] };
}

interface FoldAuthorityResponse {
  status: {
    mode: "reviewed" | "unrestricted";
    revision: number;
    updatedAt: string | null;
    damaged: boolean;
    damageReason?: string;
  };
}

/**
 * Visual thesis: one calm, explicit operating-mode choice above the narrower
 * policy editor. The mode is the dominant control; supporting copy is limited
 * to behavior and scope, and approved browsers are named at the decision.
 */
function FoldAuthorityPane() {
  const [authority, setAuthority] = useState<FoldAuthorityResponse["status"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<FoldAuthorityResponse>("/api/settings/fold-authority")
      .then((response) => {
        if (!cancelled) {
          setAuthority(response.status);
          setError(null);
        }
      })
      .catch((caught) => { if (!cancelled) setError(errorText(caught)); });
    return () => { cancelled = true; };
  }, []);

  async function setMode(mode: "reviewed" | "unrestricted") {
    if (!authority || busy || authority.damaged || authority.mode === mode) return;
    if (mode === "unrestricted" && !window.confirm(foldAuthoritySettings.unrestrictedConfirm)) return;
    const previous = authority;
    setAuthority({ ...authority, mode });
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api<FoldAuthorityResponse>("/api/settings/fold-authority", {
        method: "PUT",
        body: { mode },
      });
      setAuthority(response.status);
      setNotice("Saved");
    } catch (caught) {
      setAuthority(previous);
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="settings-section fold-authority-mode" aria-labelledby="fold-authority-mode-title">
        <div className="settings-section-heading">
          <h3 id="fold-authority-mode-title">{foldAuthoritySettings.heading}</h3>
          {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
        </div>
        <div className="theme-segmented-control two-options" role="radiogroup" aria-label="The fold operating mode">
          <button
            className={authority?.mode === "reviewed" ? "active" : ""}
            type="button"
            role="radio"
            aria-checked={authority?.mode === "reviewed"}
            disabled={!authority || busy || authority.damaged}
            onClick={() => void setMode("reviewed")}
          >
            <span className="theme-choice-copy"><span>{foldAuthoritySettings.reviewed}</span><small>{foldAuthoritySettings.reviewedDetail}</small></span>
          </button>
          <button
            className={authority?.mode === "unrestricted" ? "active unrestricted" : "unrestricted"}
            type="button"
            role="radio"
            aria-checked={authority?.mode === "unrestricted"}
            disabled={!authority || busy || authority.damaged}
            onClick={() => void setMode("unrestricted")}
          >
            <span className="theme-choice-copy"><span>{foldAuthoritySettings.unrestricted}</span><small>{foldAuthoritySettings.unrestrictedDetail}</small></span>
          </button>
        </div>
        {authority?.damaged ? (
          <span className="settings-inline-error" role="alert">
            {authority.damageReason ? `${authority.damageReason} ${foldAuthoritySettings.damaged}` : foldAuthoritySettings.damaged}
          </span>
        ) : null}
        {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      </section>
      {authority ? <FoldPoliciesPane dormant={authority.mode === "unrestricted"} /> : null}
    </>
  );
}

/**
 * Settings → The fold → Standing policies (docs/fold-consecrations.md
 * §Standing policies). Authoring happens only on this desktop Settings
 * surface, over renderer-session routes: the fold can cite policies, never
 * write them, and the kind picker offers policy-eligible kinds only —
 * destroy-category acts and page sharing have no policy vocabulary at all.
 * The category and kind pickers plus each kind's matcher fields come from the
 * host-composed contract, so the closed vocabulary lives server-side.
 */
function FoldPoliciesPane({ dormant = false }: { dormant?: boolean }) {
  const [data, setData] = useState<FoldPoliciesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState<"make-runnable" | "widen-power">("make-runnable");
  const [kind, setKind] = useState<string>("");
  const [matchFields, setMatchFields] = useState<Record<string, string>>({});
  // Inline label/matcher editor over the PATCH route. A policy's kind never
  // changes — the store refuses that with "delete and create instead" — so
  // the editor carries the kind only to render its matcher fields.
  const [editing, setEditing] = useState<{ policyId: string; kind: string; label: string; match: Record<string, string> } | null>(null);

  async function reload() {
    try {
      setData(await api<FoldPoliciesResponse>("/api/settings/fold-policies"));
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorText(caught));
    }
  }
  useEffect(() => {
    let cancelled = false;
    api<FoldPoliciesResponse>("/api/settings/fold-policies")
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    return () => { cancelled = true; };
  }, []);

  async function run(key: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    setNotice(null);
    try {
      await operation();
      await reload();
    } catch (caught) {
      setActionError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  const kinds = data?.contract.kinds ?? [];
  const categoryChoices = [
    { id: "make-runnable" as const, label: "Installs code that can run as you" },
    { id: "widen-power" as const, label: "Grants a standing power" },
  ].filter((choice) => kinds.some((item) => item.category === choice.id));
  const kindChoices = kinds.filter((item) => item.category === category);
  const selectedKind = kindChoices.find((item) => item.kind === kind) ?? null;

  function pickCategory(next: "make-runnable" | "widen-power") {
    setCategory(next);
    setKind("");
    setMatchFields({});
    setActionError(null);
    setNotice(null);
  }
  function pickKind(next: string) {
    setKind(next);
    setMatchFields({});
    setActionError(null);
    setNotice(null);
  }

  async function create() {
    if (!selectedKind) {
      setActionError("Choose what the policy pre-approves.");
      return;
    }
    if (!label.trim()) {
      setActionError("Name the policy first.");
      return;
    }
    const match: Record<string, string> = {};
    for (const field of selectedKind.fields) {
      const value = (matchFields[field.name] ?? "").trim();
      if (value) match[field.name] = value;
    }
    await run("create", async () => {
      await api("/api/settings/fold-policies", {
        method: "POST",
        body: { label: label.trim(), kind: selectedKind.kind, match },
      });
      setLabel("");
      setKind("");
      setMatchFields({});
      setNotice("Policy added");
    });
  }

  const status = data?.status ?? null;
  const matchSummary = (policy: FoldPolicyView): string =>
    Object.entries(policy.match).map(([name, value]) => `${name}: ${value}`).join(" · ");
  const kindLabel = (policy: FoldPolicyView): string =>
    kinds.find((item) => item.kind === policy.kind)?.label ?? policy.kind;

  function beginEdit(policy: FoldPolicyView) {
    setActionError(null);
    setNotice(null);
    setEditing({ policyId: policy.id, kind: policy.kind, label: policy.label, match: { ...policy.match } });
  }

  async function saveEdit() {
    const current = editing;
    if (!current) return;
    if (!current.label.trim()) {
      setActionError("Name the policy first.");
      return;
    }
    const fields = kinds.find((item) => item.kind === current.kind)?.fields ?? [];
    const match: Record<string, string> = {};
    for (const field of fields) {
      const value = (current.match[field.name] ?? "").trim();
      if (value) match[field.name] = value;
    }
    await run(`edit-${current.policyId}`, async () => {
      await api(`/api/settings/fold-policies/${current.policyId}`, {
        method: "PATCH",
        body: { label: current.label.trim(), match },
      });
      setEditing(null);
      setNotice("Policy updated");
    });
  }

  if (dormant) {
    return (
      <section className="settings-section" aria-labelledby="fold-policies-title">
        <div className="settings-section-heading"><h3 id="fold-policies-title">{foldPoliciesSettings.heading}</h3></div>
        <p>{foldAuthoritySettings.policiesPaused}</p>
      </section>
    );
  }

  return (
    <section className="settings-section" aria-labelledby="fold-policies-title">
      <div className="settings-section-heading">
        <h3 id="fold-policies-title">{foldPoliciesSettings.heading}</h3>
        {status ? <span>{status.enabledCount} of {status.policyCount} on</span> : null}
      </div>
      <p>{foldPoliciesSettings.intro}</p>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {status?.damaged ? (
        <span className="settings-inline-error" role="alert">
          {status.damageReason ?? "The standing-policy store is damaged."} Every policy is off, and work-fold will not
          overwrite damaged records; recover the file outside the app, then review and re-save here.
        </span>
      ) : null}
      {status && !status.damaged && !status.attested ? (
        <div className="settings-attestation-banner" role="alert">
          <span>{foldPoliciesSettings.attestationBroken}</span>
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run("reattest", async () => {
              await api("/api/settings/fold-policies/reattest", { method: "POST", body: {} });
              setNotice("Policies re-saved");
            })}
          >
            {busy === "reattest" ? "Saving…" : foldPoliciesSettings.reattest}
          </button>
        </div>
      ) : null}
      {data ? (
        data.policies.length ? (
          <div className="remote-browser-list fold-policy-list">
            {data.policies.map((policy) => (
              <Fragment key={policy.id}>
                <div className="remote-browser-row">
                  <div>
                    <strong>{policy.label}</strong>
                    <small>
                      {kindLabel(policy)}
                      {status?.attested === false || status?.damaged ? " — off until re-saved" : policy.enabled ? "" : " — off"}
                      {matchSummary(policy) ? ` — ${matchSummary(policy)}` : ""}
                    </small>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy) || Boolean(status && (status.damaged || !status.attested))}
                      onClick={() => (editing?.policyId === policy.id ? setEditing(null) : beginEdit(policy))}
                    >
                      {editing?.policyId === policy.id ? foldPoliciesSettings.editCancel : foldPoliciesSettings.edit}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(busy) || Boolean(status && (status.damaged || !status.attested))}
                      onClick={() => void run(`toggle-${policy.id}`, async () => {
                        await api(`/api/settings/fold-policies/${policy.id}/${policy.enabled ? "disable" : "enable"}`, { method: "POST", body: {} });
                        setNotice(policy.enabled ? "Policy turned off" : "Policy turned on");
                      })}
                    >
                      {policy.enabled ? foldPoliciesSettings.disable : foldPoliciesSettings.enable}
                    </button>
                    <button
                      className="secondary-button danger"
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!window.confirm(foldPoliciesSettings.removeConfirm)) return;
                        void run(`delete-${policy.id}`, async () => {
                          await api(`/api/settings/fold-policies/${policy.id}`, { method: "DELETE" });
                          if (editing?.policyId === policy.id) setEditing(null);
                          setNotice("Policy deleted");
                        });
                      }}
                    >
                      {foldPoliciesSettings.remove}
                    </button>
                  </div>
                </div>
                {editing?.policyId === policy.id ? (
                  <div className="fold-policy-edit" aria-label={foldPoliciesSettings.editHeading}>
                    <div className="remote-access-fields">
                      <label className="settings-field">
                        <span>Name</span>
                        <input
                          value={editing.label}
                          maxLength={data.contract.labelMaxChars}
                          disabled={Boolean(busy)}
                          onChange={(event) => {
                            const next = event.target.value;
                            setEditing((current) => current && { ...current, label: next });
                            setActionError(null);
                            setNotice(null);
                          }}
                        />
                      </label>
                      <PolicyMatcherFields
                        fields={kinds.find((item) => item.kind === policy.kind)?.fields ?? []}
                        values={editing.match}
                        disabled={Boolean(busy)}
                        onChange={(name, value) => {
                          setEditing((current) => current && { ...current, match: { ...current.match, [name]: value } });
                          setActionError(null);
                          setNotice(null);
                        }}
                      />
                    </div>
                    <div className="settings-actions">
                      <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setEditing(null)}>
                        {foldPoliciesSettings.editCancel}
                      </button>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={Boolean(busy) || !editing.label.trim()}
                        onClick={() => void saveEdit()}
                      >
                        {busy === `edit-${policy.id}` ? "Saving…" : foldPoliciesSettings.editSave}
                      </button>
                    </div>
                  </div>
                ) : null}
              </Fragment>
            ))}
          </div>
        ) : (
          <div className="remote-browser-empty">{foldPoliciesSettings.empty}</div>
        )
      ) : null}
      {data ? (
        <div className="fold-policy-add">
          <div className="settings-section-heading"><h3>{foldPoliciesSettings.addHeading}</h3></div>
          <div className="remote-access-fields">
            <label className="settings-field">
              <span>Name</span>
              <input
                value={label}
                maxLength={data.contract.labelMaxChars}
                placeholder='For example "Skill imports from the Anthropic marketplace"'
                disabled={Boolean(busy)}
                onChange={(event) => { setLabel(event.target.value); setActionError(null); setNotice(null); }}
              />
            </label>
            <label className="settings-field">
              <span>Category</span>
              <select value={category} disabled={Boolean(busy)} onChange={(event) => pickCategory(event.target.value as "make-runnable" | "widen-power")}>
                {categoryChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label}</option>)}
              </select>
            </label>
            <label className="settings-field">
              <span>Pre-approves</span>
              <select value={kind} disabled={Boolean(busy)} onChange={(event) => pickKind(event.target.value)}>
                <option value="">Choose an act kind</option>
                {kindChoices.map((item) => <option value={item.kind} key={item.kind}>{item.label}</option>)}
              </select>
            </label>
            {selectedKind ? (
              <PolicyMatcherFields
                fields={selectedKind.fields}
                values={matchFields}
                disabled={Boolean(busy)}
                onChange={(name, value) => setMatchFields((previous) => ({ ...previous, [name]: value }))}
              />
            ) : null}
          </div>
          <div className="settings-actions">
            {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
            <button
              className="primary-button"
              type="button"
              disabled={Boolean(busy) || !selectedKind || !label.trim()}
              onClick={() => void create()}
            >
              {busy === "create" ? "Adding…" : foldPoliciesSettings.create}
            </button>
          </div>
          {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One kind's typed matcher fields, rendered from the host-composed contract —
 * shared by the add form and the per-policy inline editor so both surfaces
 * offer exactly the closed vocabulary the store accepts at write.
 */
function PolicyMatcherFields({ fields, values, disabled, onChange }: {
  fields: FoldPolicyFieldView[];
  values: Record<string, string>;
  disabled: boolean;
  onChange: (name: string, value: string) => void;
}) {
  return <>
    {fields.map((field) => (
      <label className="settings-field" key={field.name}>
        <span>{field.label}{field.required ? "" : " (optional)"}</span>
        {field.values ? (
          <select
            value={values[field.name] ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(field.name, event.target.value)}
          >
            {field.required ? null : <option value="">Any</option>}
            {field.values.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        ) : (
          <input
            value={values[field.name] ?? ""}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={disabled}
            onChange={(event) => onChange(field.name, event.target.value)}
          />
        )}
        {field.hint ? <small>{field.hint}</small> : null}
      </label>
    ))}
  </>;
}

/**
 * Arrow keys rove and select inside the settings tablist and radio groups,
 * per the roles they already declare. Focus outside those groups (inputs,
 * plain buttons) is untouched.
 */
function settingsRovingKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  const key: MenuNavigationKey | null = event.key === "ArrowRight" || event.key === "ArrowDown" ? "ArrowDown"
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? "ArrowUp"
      : event.key === "Home" || event.key === "End" ? event.key : null;
  if (!key) return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;
  const group = focused.closest<HTMLElement>('[role="tablist"], [role="radiogroup"]');
  if (!group || !event.currentTarget.contains(group)) return;
  const items = Array.from(group.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')).filter((item) => !item.hasAttribute("disabled"));
  const next = nextMenuItemIndex(items.indexOf(focused), items.length, key);
  if (next === null) return;
  event.preventDefault();
  items[next]?.focus();
  items[next]?.click();
}

function settingsUpdateActionLabel(status: DesktopUpdateStatus) {
  if (status.phase === "available") return "Download update";
  if (status.phase === "ready") return "Restart and install";
  if (status.phase === "error") return "Retry";
  if (status.phase === "checking") return "Checking";
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading" : `${Math.round(status.progressPercent)}%`;
  return "Check for updates";
}
