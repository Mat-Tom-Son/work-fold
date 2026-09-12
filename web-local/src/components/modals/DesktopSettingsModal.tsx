import { Fragment, useEffect, useRef, useState } from "react";
import type * as React from "react";
import {
  ArrowClockwise20Regular,
  Checkmark16Regular,
  Dismiss20Regular,
  Info20Regular,
  Laptop20Regular,
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
import { WorkFoldLockup } from "../brand/WorkFoldBrand";
import { AssistantSetupPane, type AssistantModelScope } from "../panes/AssistantSetupPane";
import type { ApplicationAppearanceController } from "../../hooks/useApplicationAppearance";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { FoldLimitsPane } from "./FoldLimitsPane";
import { FoldRoutingsPane } from "./FoldRoutingsPane";
import { FoldRecentlyDeletedPane } from "./RecentlyDeletedPane";

export type SettingsPage = "appearance" | "assistant" | "remote" | "web-access" | "shared-pages" | "general" | "desktop" | "about";
type FoldSettingsSection = "routings" | "deleted" | "limits";

export function DesktopSettingsModal({ appearance, onCustomizeSpace, space, agentStatus, fixtureMode = false, initialPage = "appearance", initialAssistantScope, focusAssistantModel = false, onAgentConfigured, onAssistantChanged, onClose, updateStatus, onUpdateAction }: {
  appearance: ApplicationAppearanceController;
  onCustomizeSpace?: (spaceId: string) => void;
  space: SpaceSummary | null;
  agentStatus: AgentStatus;
  fixtureMode?: boolean;
  initialPage?: SettingsPage;
  initialAssistantScope?: AssistantModelScope;
  focusAssistantModel?: boolean;
  onAgentConfigured: (status: AgentStatus) => void;
  onAssistantChanged?: (scope: AssistantModelScope, status: AgentStatus) => void;
  onClose: () => void;
  updateStatus: DesktopUpdateStatus | null;
  onUpdateAction?: () => void;
}) {
  const [narrowNavigation, setNarrowNavigation] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [assistantVisited, setAssistantVisited] = useState(initialPage === "assistant");
  const contentRef = useRef<HTMLDivElement>(null);
  const [foldSection, setFoldSection] = useState<FoldSettingsSection>("routings");
  const [closeToTray, setCloseToTray] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [closeToTrayBusy, setCloseToTrayBusy] = useState(false);
  const [closeToTrayError, setCloseToTrayError] = useState<string | null>(null);
  const [closeToTrayNotice, setCloseToTrayNotice] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, initialFocusRef: closeRef });

  useEffect(() => { setPage(initialPage); }, [initialPage]);
  useEffect(() => {
    if (page === "assistant") setAssistantVisited(true);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page, foldSection]);
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

  const selectedPage = page === "remote" ? "web-access" : page === "general" ? "desktop" : page;
  const tabs: Array<{ id: Exclude<SettingsPage, "remote">; label: string; icon: React.ReactNode }> = [
    { id: "appearance", label: "Appearance", icon: <PaintBrush20Regular /> },
    { id: "assistant", label: "AI Models", icon: <Sparkle20Regular /> },
    { id: "web-access", label: "Web access", icon: <Window20Regular /> },
    { id: "shared-pages", label: "Shared pages", icon: <Window20Regular /> },
    { id: "desktop", label: "Desktop", icon: <Laptop20Regular /> },
    { id: "about", label: "About", icon: <Info20Regular /> },
  ];
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
                className={selectedPage === tab.id ? "settings-tab active" : "settings-tab"}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selectedPage === tab.id}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={selectedPage === tab.id ? 0 : -1}
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
                <AppearanceSettingsPane appearance={appearance} space={space} onCustomizeSpace={onCustomizeSpace} />
              </div>
            ) : null}
            {page === "assistant" || assistantVisited ? (
              <div hidden={page !== "assistant"} className="settings-tab-panel" id="settings-panel-assistant" role="tabpanel" aria-labelledby="settings-tab-assistant">
                <AssistantSetupPane active={page === "assistant"} space={space} status={agentStatus} fixtureMode={fixtureMode} embedded initialScope={initialAssistantScope} focusModelOnOpen={focusAssistantModel} onConfigured={onAgentConfigured} onAssistantChanged={onAssistantChanged} />
              </div>
            ) : null}
            {selectedPage === "web-access" ? (
              <div className="settings-tab-panel" id="settings-panel-web-access" role="tabpanel" aria-labelledby="settings-tab-web-access">
                <RemoteAccessPane />
              </div>
            ) : null}
            {selectedPage === "shared-pages" ? (
              <div className="settings-tab-panel" id="settings-panel-shared-pages" role="tabpanel" aria-labelledby="settings-tab-shared-pages">
                <FoldPublicationsPane />
              </div>
            ) : null}
            {selectedPage === "desktop" ? (
              <div className="settings-tab-panel" id="settings-panel-desktop" role="tabpanel" aria-labelledby="settings-tab-desktop">
                <div className="settings-subtabs" role="tablist" aria-label="Desktop settings">
                  {([["routings", "Automations"], ["deleted", "Recently deleted"], ["limits", "Limits"]] as Array<[FoldSettingsSection, string]>).map(([id, label]) => (
                    <button className={foldSection === id ? "active" : ""} type="button" role="tab" aria-selected={foldSection === id} tabIndex={foldSection === id ? 0 : -1} id={`fold-settings-tab-${id}`} aria-controls={`fold-settings-panel-${id}`} key={id} onClick={() => setFoldSection(id)}>{label}</button>
                  ))}
                </div>
                <div id={`fold-settings-panel-${foldSection}`} role="tabpanel" aria-labelledby={`fold-settings-tab-${foldSection}`} className="settings-fold-panel">
                  {foldSection === "routings" ? <FoldRoutingsPane /> : null}
                  {foldSection === "deleted" ? <FoldRecentlyDeletedPane /> : null}
                  {foldSection === "limits" ? <FoldLimitsPane onOpenRecentlyDeleted={() => setFoldSection("deleted")} /> : null}
                </div>
                {closeToTray?.supported ? (
                  <section className="settings-section" aria-labelledby="window-close-settings-title">
                    <div className="settings-section-heading"><h3 id="window-close-settings-title">Closing the window</h3>{closeToTrayBusy ? <span><ArrowClockwise20Regular className="spin" /> Updating</span> : closeToTrayNotice ? <span className="settings-save-status" role="status"><Checkmark16Regular />{closeToTrayNotice}</span> : null}</div>
                    <div className="theme-segmented-control two-options" role="radiogroup" aria-label="Close button behavior">
                      <button className={closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={closeToTray.enabled} tabIndex={closeToTray.enabled ? 0 : -1} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(true)}>
                        <Subtract20Regular /><span className="theme-choice-copy"><span>Keep work-fold running</span></span>
                      </button>
                      <button className={!closeToTray.enabled ? "active" : ""} type="button" role="radio" aria-checked={!closeToTray.enabled} tabIndex={!closeToTray.enabled ? 0 : -1} disabled={closeToTrayBusy} onClick={() => void updateCloseToTray(false)}>
                        <Power20Regular /><span className="theme-choice-copy"><span>Quit work-fold</span></span>
                      </button>
                    </div>
                    {closeToTrayError ? <span className="settings-inline-error" role="alert">{closeToTrayError}</span> : null}
                  </section>
                ) : null}
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

interface FoldPublicationView {
  publicationId: string;
  kind: "page" | "app";
  spaceId: string;
  spaceName?: string;
  /** Page slots only: the one designated Space-relative file. */
  relativePath?: string;
  /** Hosted-app slots only: the pinned exposure binding. */
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
 * Settings → Shared pages (docs/fold-publishing.md,
 * plan item 5). Reads and narrowing verbs only: revealing a link is a
 * transient on-demand composition against the viewer origin, and stop
 * sharing, budget cuts, and snapshot off are direct receipted acts on the
 * renderer session. Widening — a new page, raised budgets, snapshot on —
 * does not start here; the fold shares a page, and every such change runs at
 * once and leaves a receipt (docs/receipts-not-gates.md, F19).
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
                  <small>{foldPublicationsSettings.linkMeaning}</small>
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
            </div>
          ))}
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
