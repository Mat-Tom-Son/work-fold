import { Fragment, useEffect, useRef, useState } from "react";
import type * as React from "react";
import {
  ArrowClockwise20Regular,
  Checkmark16Regular,
  Dismiss20Regular,
  Delete20Regular,
  Flash20Regular,
  Info20Regular,
  PaintBrush20Regular,
  Power20Regular,
  Sparkle20Regular,
  Subtract20Regular,
  Window20Regular,
} from "@fluentui/react-icons";
import { useModalDialog } from "../../hooks/useModalDialog";
import { api, errorText } from "../../lib/api";
import { nextMenuItemIndex, type MenuNavigationKey } from "../../lib/menu-navigation";
import type { AgentStatus, DesktopUpdateStatus, SpaceSummary } from "../../types";
import { foldPublicationsSettings, remoteAccessSettings } from "../../ui-contract";
import {
  pageByteBudgetMaximumMiB,
  pageServeRateMaximum,
  setSharedPages,
  sharedPageHealth,
  type SharedPageConnection,
  type SharedPagesResponse,
  type SharedPageView,
} from "../../lib/page-sharing";
import { buildFixturePublications, fixtureShareLinkKey, fixtureViewerOrigin } from "../../fixtures/space-fixture";
import { showToast } from "../../ui/feedback";
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { AssistantSetupPane, type AssistantModelScope } from "../panes/AssistantSetupPane";
import type { ApplicationAppearanceController } from "../../hooks/useApplicationAppearance";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { FoldLimitsPane } from "./FoldLimitsPane";
import { FoldRoutingsPane } from "./FoldRoutingsPane";
import { FoldRecentlyDeletedPane } from "./RecentlyDeletedPane";

export type SettingsPage = "appearance" | "assistant" | "remote" | "web-access" | "shared-pages" | "automations" | "recently-deleted" | "general" | "desktop" | "about";
export type FoldSettingsSection = "routings" | "deleted" | "limits";
type SettingsTabId = "appearance" | "assistant" | "web-access" | "shared-pages" | "automations" | "recently-deleted" | "about";

/**
 * The tab a Settings page id opens. "remote", "general" and "desktop" are
 * older ids kept so existing callers still land somewhere sensible: the old
 * Desktop tab held Automations, Recently deleted and Limits, so "desktop"
 * with the "deleted" section opens Recently deleted and otherwise opens
 * Automations (where Limits now sits).
 */
export function settingsTabForPage(page: SettingsPage, section?: FoldSettingsSection): SettingsTabId {
  if (page === "remote") return "web-access";
  if (page === "general" || page === "desktop") return section === "deleted" ? "recently-deleted" : "automations";
  return page;
}

export function DesktopSettingsModal({ appearance, onCustomizeSpace, space, agentStatus, fixtureMode = false, initialPage = "appearance", initialSection, initialAssistantScope, focusAssistantModel = false, onAgentConfigured, onAssistantChanged, onClose, updateStatus, onUpdateAction }: {
  appearance: ApplicationAppearanceController;
  onCustomizeSpace?: (spaceId: string) => void;
  space: SpaceSummary | null;
  agentStatus: AgentStatus;
  fixtureMode?: boolean;
  initialPage?: SettingsPage;
  /** Older callers named a section of the former Desktop tab. */
  initialSection?: FoldSettingsSection;
  initialAssistantScope?: AssistantModelScope;
  focusAssistantModel?: boolean;
  onAgentConfigured: (status: AgentStatus) => void;
  onAssistantChanged?: (scope: AssistantModelScope, status: AgentStatus) => void;
  onClose: () => void;
  updateStatus: DesktopUpdateStatus | null;
  onUpdateAction?: () => void;
}) {
  const [narrowNavigation, setNarrowNavigation] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [page, setPage] = useState<SettingsTabId>(() => settingsTabForPage(initialPage, initialSection));
  const [assistantVisited, setAssistantVisited] = useState(initialPage === "assistant");
  const contentRef = useRef<HTMLDivElement>(null);
  const [closeToTray, setCloseToTray] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [closeToTrayBusy, setCloseToTrayBusy] = useState(false);
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null);
  const [closeToTrayNotice, setCloseToTrayNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });

  useEffect(() => { setPage(settingsTabForPage(initialPage, initialSection)); }, [initialPage, initialSection]);
  useEffect(() => {
    if (page === "assistant") setAssistantVisited(true);
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
    { id: "assistant", label: "AI Models", icon: <Sparkle20Regular /> },
    { id: "web-access", label: "Web access", icon: <Window20Regular /> },
    { id: "shared-pages", label: "Shared pages", icon: <Window20Regular /> },
    { id: "automations", label: "Automations", icon: <Flash20Regular /> },
    { id: "recently-deleted", label: "Recently deleted", icon: <Delete20Regular /> },
    { id: "about", label: "About", icon: <Info20Regular /> },
  ];
  const closeWindowControl = closeToTray?.supported ? (
    <>
      <div className="appearance-settings-row settings-close-window-row">
        <span>
          <span className="appearance-settings-label" id="window-close-settings-title">Closing the window</span>
          {closeToTrayBusy ? <small><ArrowClockwise20Regular className="spin" /> Updating</small> : closeToTrayNotice ? <small className="settings-save-status" role="status"><Checkmark16Regular />{closeToTrayNotice}</small> : null}
        </span>
        <div className="theme-segmented-control two-options" role="radiogroup" aria-labelledby="window-close-settings-title">
          <button className={closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={closeToTray.enabled} tabIndex={closeToTray.enabled ? 0 : -1} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(true)}>
            <Subtract20Regular /><span className="theme-choice-copy"><span>Keep work-fold running</span></span>
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
            <div><h2 id="settings-title">Settings</h2></div>
          </div>
          <button ref={closeRef} className="minimal-icon-button settings-close-button" type="button" onClick={onClose} aria-label="Close settings"><Dismiss20Regular /></button>
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
            {page === "appearance" ? (
              <div className="settings-tab-panel" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance">
                <AppearanceSettingsPane appearance={appearance} space={space} onCustomizeSpace={onCustomizeSpace} interfaceExtra={closeWindowControl} />
              </div>
            ) : null}
            {page === "assistant" || assistantVisited ? (
              <div hidden={page !== "assistant"} className="settings-tab-panel" id="settings-panel-assistant" role="tabpanel" aria-labelledby="settings-tab-assistant">
                <AssistantSetupPane active={page === "assistant"} space={space} status={agentStatus} fixtureMode={fixtureMode} embedded initialScope={initialAssistantScope} focusModelOnOpen={focusAssistantModel} onConfigured={onAgentConfigured} onAssistantChanged={onAssistantChanged} />
              </div>
            ) : null}
            {page === "web-access" ? (
              <div className="settings-tab-panel" id="settings-panel-web-access" role="tabpanel" aria-labelledby="settings-tab-web-access">
                <RemoteAccessPane />
              </div>
            ) : null}
            {page === "shared-pages" ? (
              <div className="settings-tab-panel" id="settings-panel-shared-pages" role="tabpanel" aria-labelledby="settings-tab-shared-pages">
                <FoldPublicationsPane fixtureMode={fixtureMode} onOpenWebAccess={() => setPage("web-access")} />
              </div>
            ) : null}
            {page === "automations" ? (
              <div className="settings-tab-panel" id="settings-panel-automations" role="tabpanel" aria-labelledby="settings-tab-automations">
                <FoldRoutingsPane />
                <FoldLimitsPane onOpenRecentlyDeleted={() => setPage("recently-deleted")} />
              </div>
            ) : null}
            {page === "recently-deleted" ? (
              <div className="settings-tab-panel" id="settings-panel-recently-deleted" role="tabpanel" aria-labelledby="settings-tab-recently-deleted">
                <FoldRecentlyDeletedPane />
              </div>
            ) : null}
            {page === "about" ? (
              <div className="settings-tab-panel" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about">
                <section className="settings-section">
                  <WorkFoldLockup className="about-work-fold-brand" />
                  <dl className="context-meta-grid"><div><dt>Version</dt><dd>{window.workFoldDesktop?.app.version ?? "Development"}</dd></div><div><dt>Storage</dt><dd>Local</dd></div><div><dt>License</dt><dd>MIT</dd></div></dl>
                </section>
                <section className="settings-section update-settings-section" aria-labelledby="desktop-update-settings-title">
                  <div><div className="settings-section-heading"><h3 id="desktop-update-settings-title">Updates</h3></div><p>{updateStatus?.message ?? "Updates require the desktop app."}</p>{updateStatus?.error ? <span className="settings-inline-error" role="alert">{updateStatus.error}</span> : null}{updateStatus?.phase === "downloading" && updateStatus.progressPercent !== null ? <progress max={100} value={updateStatus.progressPercent}>{Math.round(updateStatus.progressPercent)}%</progress> : null}</div>
                  {onUpdateAction && updateStatus?.supported ? <button className="secondary-button" type="button" disabled={updateStatus.phase === "checking" || updateStatus.phase === "downloading" || updateStatus.phase === "installing"} onClick={onUpdateAction}><ArrowClockwise20Regular className={updateStatus.phase === "checking" || updateStatus.phase === "downloading" ? "spin" : undefined} />{settingsUpdateActionLabel(updateStatus)}</button> : null}
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
        <div className="settings-section-heading"><h3 id="remote-access-title">work-fold on the web</h3></div>
        <p>Set up web access in the desktop app.</p>
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
        {status?.url ? <code className="remote-access-url">{status.url}</code> : null}
        <div className="remote-access-actions">
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy) || !status.enabled} onClick={() => void run("open", async () => remote.open())}>Open address</button> : null}
          {status?.configured ? <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run("toggle", () => remote.setEnabled(!status.enabled))}>{status.enabled ? "Disable" : "Enable"} web access</button> : null}
        </div>
        {status?.lastError ? <span className="settings-inline-error" role="alert">{status.lastError}</span> : null}
      </section>

      <section className="settings-section" aria-labelledby="remote-address-settings-title">
        <div className="settings-section-heading"><h3 id="remote-address-settings-title">{status?.configured ? "Change address or password" : "Set up work-fold on the web"}</h3></div>
        <div className="remote-access-fields">
          <label className="settings-field"><span>Web address</span><div className="remote-slug-field"><input value={slug} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="your-name" maxLength={32} disabled={Boolean(busy)} onChange={(event) => { setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setError(null); setNotice(null); }} /><span>.work-fold.com</span></div></label>
          <label className="settings-field"><span>{status?.configured ? "New password" : "Password"}</span><input type="password" value={password} autoComplete="new-password" minLength={8} maxLength={256} placeholder="At least 8 characters" disabled={Boolean(busy)} onChange={(event) => { setPassword(event.target.value); setError(null); setNotice(null); }} /></label>
          <label className="settings-field"><span>Confirm password</span><input type="password" value={confirmation} autoComplete="new-password" minLength={8} maxLength={256} disabled={Boolean(busy)} onChange={(event) => { setConfirmation(event.target.value); setError(null); setNotice(null); }} /></label>
        </div>
        <div className="settings-actions">{notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}<button className="primary-button" type="button" disabled={Boolean(busy) || !remoteSettingsChanged} onClick={() => void save()}>{busy === "save" ? "Saving…" : status?.configured ? "Save changes" : "Create private address"}</button></div>
        {error ? <span className="settings-inline-error" role="alert">{error}</span> : null}
      </section>

      {status?.configured ? (
        <section className="settings-section" aria-labelledby="paired-browsers-title">
          <div className="settings-section-heading"><h3 id="paired-browsers-title">Paired browsers</h3><span>{status.approvedBrowsers.length}</span></div>
          <p>{remoteAccessSettings.pairedBrowserTrust}</p>
          {status.approvedBrowsers.length ? <div className="remote-browser-list">{status.approvedBrowsers.map((browser) => (
            <div className="remote-browser-row" key={browser.id}><div><strong>{browser.label}</strong><small>Paired {new Date(browser.approvedAt).toLocaleDateString()}</small></div><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void run(`revoke-${browser.id}`, () => remote.revokeBrowser(browser.id))}>Revoke</button></div>
          ))}</div> : <div className="remote-browser-empty">No browser is paired yet.</div>}
          <div className="remote-access-danger-actions">
            <button className="secondary-button danger" type="button" disabled={Boolean(busy) || !status.approvedBrowsers.length} onClick={() => { if (window.confirm("Remove every paired browser? Each one has to be paired again from this desktop.")) void run("revoke-all", () => remote.revokeAll()); }}>Remove all browsers</button>
            <button className="secondary-button danger" type="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Remove this private address and all web access? This cannot be undone.")) void run("remove", () => remote.remove()); }}>Remove web access</button>
          </div>
        </section>
      ) : null}
    </>
  );
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
 * Settings → Shared pages (docs/fold-publishing.md, plan item 5; amended
 * 2026-09-24). Each row carries one quiet page state word — Live, Asleep,
 * Resting, Not available, Stopped — with the precise reason as its tooltip;
 * with the main-window glance panel gone, this row is where a page's
 * problems show. Revealing a link is a transient on-demand composition
 * against the viewer origin. Stop sharing, Budgets, and Sleep copy are
 * receipted acts on the renderer session: budgets narrow or widen in place
 * and the sleep copy turns on or off, while the slot, key, and link stay the
 * same (docs/receipts-not-gates.md, F19). A new page starts from a file's tab.
 */
function FoldPublicationsPane({ fixtureMode = false, onOpenWebAccess }: { fixtureMode?: boolean; onOpenWebAccess: () => void }) {
  const remote = fixtureMode ? undefined : window.workFoldDesktop?.remoteAccess;
  const [data, setData] = useState<SharedPagesResponse | null>(() => (
    fixtureMode ? { publications: buildFixturePublications(), status: { damaged: false, activeCount: 4, pendingBridgeWork: 1 } } : null
  ));
  const [connection, setConnection] = useState<(SharedPageConnection & { viewerOrigin: string | null }) | null>(() => (
    fixtureMode ? { configured: true, enabled: true, connection: "connected", viewerOrigin: fixtureViewerOrigin } : null
  ));
  const viewerOrigin = connection?.viewerOrigin ?? null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ publicationId: string; link: string } | null>(null);
  const [editingBudgets, setEditingBudgets] = useState<{ publicationId: string; serveRate: string; byteBudgetMiB: string } | null>(null);

  async function reload() {
    if (fixtureMode) return;
    try {
      const next = await api<SharedPagesResponse>("/api/settings/publications");
      setData(next);
      setSharedPages(next.status.damaged ? [] : next.publications);
      setLoadError(null);
    } catch (caught) {
      setLoadError(errorText(caught));
    }
  }
  useEffect(() => {
    if (fixtureMode) return;
    let cancelled = false;
    api<SharedPagesResponse>("/api/settings/publications")
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((caught) => { if (!cancelled) setLoadError(errorText(caught)); });
    if (remote) {
      const apply = (status: SharedPageConnection & { viewerOrigin: string | null }) => {
        if (!cancelled) setConnection({ configured: status.configured, enabled: status.enabled, connection: status.connection, viewerOrigin: status.viewerOrigin });
      };
      void remote.getStatus().then(apply).catch(() => undefined);
      const unsubscribe = remote.onStatusChanged(apply);
      return () => { cancelled = true; unsubscribe(); };
    }
    return () => { cancelled = true; };
  }, [remote, fixtureMode]);

  async function run(key: string, operation: () => Promise<void>) {
    if (busy) return;
    if (fixtureMode && !key.startsWith("reveal-")) {
      showToast({ text: foldPublicationsSettings.previewDisabled, tone: "info" });
      return;
    }
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

  async function revealLink(publication: SharedPageView) {
    if (!viewerOrigin) {
      setActionError(foldPublicationsSettings.noAddress);
      return;
    }
    await run(`reveal-${publication.publicationId}`, async () => {
      const response = fixtureMode
        ? { viewerPath: publication.viewerPath, key: fixtureShareLinkKey }
        : await api<{ viewerPath: string; key: string }>(
          `/api/settings/publications/${publication.publicationId}/reveal-link`,
          { method: "POST", body: {} },
        );
      // Composed transiently, held only in this pane's state until hidden.
      setRevealed({ publicationId: publication.publicationId, link: `${viewerOrigin}${response.viewerPath}#${response.key}` });
    });
  }

  /**
   * One Save for both budgets: a lower value narrows through the direct
   * verb, a higher one widens in place, each under its own receipt.
   */
  async function saveBudgets(publication: SharedPageView) {
    if (!editingBudgets || editingBudgets.publicationId !== publication.publicationId) return;
    const serveRate = Number(editingBudgets.serveRate);
    const byteBudgetMiB = Number(editingBudgets.byteBudgetMiB);
    if (!Number.isInteger(serveRate) || serveRate < 1 || serveRate > pageServeRateMaximum
      || !Number.isFinite(byteBudgetMiB) || byteBudgetMiB <= 0 || byteBudgetMiB > pageByteBudgetMaximumMiB) {
      setActionError(foldPublicationsSettings.budgetRange(pageServeRateMaximum, pageByteBudgetMaximumMiB));
      return;
    }
    const byteBudget = Math.max(1, Math.round(byteBudgetMiB * 1024 * 1024));
    const lower: { serveRatePerMinute?: number; byteBudgetPerDay?: number } = {};
    const higher: { serveRatePerMinute?: number; byteBudgetPerDay?: number } = {};
    if (serveRate < publication.serveRatePerMinute) lower.serveRatePerMinute = serveRate;
    if (serveRate > publication.serveRatePerMinute) higher.serveRatePerMinute = serveRate;
    if (byteBudget < publication.byteBudgetPerDay) lower.byteBudgetPerDay = byteBudget;
    if (byteBudget > publication.byteBudgetPerDay) higher.byteBudgetPerDay = byteBudget;
    await run(`budgets-${publication.publicationId}`, async () => {
      if (Object.keys(lower).length) {
        await api(`/api/settings/publications/${publication.publicationId}/narrow`, { method: "POST", body: lower });
      }
      if (Object.keys(higher).length) {
        await api(`/api/settings/publications/${publication.publicationId}/widen`, { method: "POST", body: higher });
      }
      setEditingBudgets(null);
      setNotice(foldPublicationsSettings.saved);
    });
  }

  function setSleepCopy(publication: SharedPageView, enabled: boolean) {
    void run(`sleep-copy-${publication.publicationId}`, async () => {
      await api(
        enabled
          ? `/api/settings/publications/${publication.publicationId}/widen`
          : `/api/settings/publications/${publication.publicationId}/snapshot-off`,
        { method: "POST", body: enabled ? { snapshotEnabled: true } : {} },
      );
      setNotice(foldPublicationsSettings.saved);
    });
  }

  const publications = data?.publications ?? [];
  const shown = publications.filter((publication) => publication.state !== "revoked" || publication.bridgeCleanup !== "ok");
  const hasAddress = Boolean(viewerOrigin || connection?.configured);
  const countersLine = (publication: SharedPageView): string => {
    const counters = publication.counters;
    if (!counters) return "Not served from this desktop yet";
    return `Served ${counters.served} time${counters.served === 1 ? "" : "s"} · ${formatPublicationBytes(counters.servedBytes)} · last ${new Date(counters.lastServedAt).toLocaleString()}`;
  };

  return (
    <section className="settings-section" aria-label={foldPublicationsSettings.heading}>
      {loadError ? <span className="settings-inline-error" role="alert">{loadError}</span> : null}
      {data?.status.damaged ? (
        <span className="settings-inline-error" role="alert">
          {data.status.damageReason ?? "The publication records could not be read."} Nothing changes until the records
          are recovered outside the app.
        </span>
      ) : null}
      {notice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{notice}</span> : null}
      {actionError ? <span className="settings-inline-error" role="alert">{actionError}</span> : null}
      {data && !shown.length && !hasAddress ? (
        <div className="remote-browser-empty fold-publication-empty">
          <span>{foldPublicationsSettings.emptyNoAddress}</span>
          <button className="secondary-button" type="button" onClick={onOpenWebAccess}>{foldPublicationsSettings.webAccess}</button>
        </div>
      ) : null}
      {data && !shown.length && hasAddress ? <div className="remote-browser-empty">{foldPublicationsSettings.empty}</div> : null}
      {shown.length ? (
        <div className="remote-browser-list fold-publication-list">
          {shown.map((publication) => {
            const health = sharedPageHealth(publication, connection);
            const editing = editingBudgets?.publicationId === publication.publicationId ? editingBudgets : null;
            return (
              <div className="fold-publication-row" key={publication.publicationId}>
                <div className="remote-browser-row">
                  <div className="fold-publication-summary" title={health.reason}>
                    <span className="fold-publication-title">
                      <strong>{publication.title}</strong>
                      <span className={`fold-publication-state ${health.state}`}>{foldPublicationsSettings.states[health.state]}</span>
                    </span>
                    <small>
                      {publication.kind === "app" && publication.app
                        ? <>{publication.spaceName ?? publication.spaceId}: App Instance {publication.app.appInstanceId} · Release <code>{shortReleaseDigest(publication.app.releaseDigest)}</code></>
                        : <>{publication.spaceName ?? publication.spaceId}: {publication.relativePath}</>}
                    </small>
                    {publication.kind === "app" && publication.app ? (
                      <small>
                        Viewer entry {publication.app.viewerEntry} · Viewer-readable surface: {publication.app.viewerSurface.join(", ")}
                      </small>
                    ) : null}
                    <small>{publication.serveRatePerMinute} serves/min · {formatPublicationBytes(publication.byteBudgetPerDay)}/day</small>
                    <small>{countersLine(publication)}</small>
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
                        aria-expanded={Boolean(editing)}
                        disabled={Boolean(busy)}
                        onClick={() => {
                          setActionError(null);
                          setNotice(null);
                          setEditingBudgets(editing ? null : {
                            publicationId: publication.publicationId,
                            serveRate: String(publication.serveRatePerMinute),
                            byteBudgetMiB: String(publication.byteBudgetPerDay / (1024 * 1024)),
                          });
                        }}
                      >
                        {foldPublicationsSettings.budgets}
                      </button>
                      <button
                        className="secondary-button danger"
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (fixtureMode) { showToast({ text: foldPublicationsSettings.previewDisabled, tone: "info" }); return; }
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
                    <small>{foldPublicationsSettings.linkMeaning}</small>
                  </div>
                ) : null}
                {editing ? (
                  <div className="fold-publication-budgets">
                    <label className="settings-field">
                      <span>{foldPublicationsSettings.servesPerMinute}</span>
                      <input
                        type="number"
                        min={1}
                        max={pageServeRateMaximum}
                        step={1}
                        value={editing.serveRate}
                        disabled={Boolean(busy)}
                        onChange={(event) => setEditingBudgets({ ...editing, serveRate: event.target.value })}
                      />
                    </label>
                    <label className="settings-field">
                      <span>{foldPublicationsSettings.mibPerDay}</span>
                      <input
                        type="number"
                        min={1}
                        max={pageByteBudgetMaximumMiB}
                        step={1}
                        value={editing.byteBudgetMiB}
                        disabled={Boolean(busy)}
                        onChange={(event) => setEditingBudgets({ ...editing, byteBudgetMiB: event.target.value })}
                      />
                    </label>
                    <div className="settings-actions">
                      <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void saveBudgets(publication)}>
                        {busy === `budgets-${publication.publicationId}` ? "Saving…" : foldPublicationsSettings.saveBudgets}
                      </button>
                    </div>
                  </div>
                ) : null}
                {/* Sleep copies are a page-only lane: an app at your address is
                    structurally snapshotless, so app rows carry no toggle. The
                    retention disclosure rides on the label's tooltip. */}
                {publication.kind === "page" && publication.state === "active" ? (
                  <label className="fold-publication-sleep-copy" title={foldPublicationsSettings.snapshotLabel}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={publication.snapshotEnabled}
                      disabled={Boolean(busy)}
                      onChange={(event) => setSleepCopy(publication, event.target.checked)}
                    />
                    {" "}{foldPublicationsSettings.sleepCopy}
                  </label>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
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
  if (status.phase === "available") return "Download update";
  if (status.phase === "ready") return "Restart and install";
  if (status.phase === "error") return "Retry";
  if (status.phase === "checking") return "Checking";
  if (status.phase === "downloading") return status.progressPercent === null ? "Downloading" : `${Math.round(status.progressPercent)}%`;
  return "Check for updates";
}
