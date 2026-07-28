import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Add16Regular,
  Alert20Regular,
  ArrowSync16Regular,
  Clock20Regular,
  Delete16Regular,
  Dismiss20Regular,
  Info20Regular,
  PlugConnected20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { errorText } from "../../lib/api";
import {
  restrictedAppAutomationOutcomeLabel,
  restrictedAppAutomationVerificationLabel,
} from "../../lib/restricted-app-automation";
import {
  deleteRestrictedAppConnection,
  clearRestrictedAppStorage,
  connectRestrictedAppOAuth,
  getRestrictedAppStorageUsage,
  inspectRestrictedApp,
  installRestrictedApp,
  listRestrictedAppAutomationRuns,
  listRestrictedAppConnections,
  removeRestrictedApp,
  runRestrictedAppAutomationNow,
  setRestrictedAppAutomationEnabled,
  setRestrictedAppConnection,
  setRestrictedAppFileGrant,
  setRestrictedAppNetworkGrant,
  setRestrictedAppNotificationGrant,
} from "../../lib/restricted-apps";
import type {
  RestrictedAppAutomation,
  RestrictedAppAutomationRunReceipt,
  RestrictedAppAuthDeclaration,
  RestrictedAppConnectionStatus,
  RestrictedAppCredential,
  RestrictedAppFilePermission,
  RestrictedAppInstalled,
  RestrictedAppNetworkDestination,
  RestrictedAppNotificationPermission,
  RestrictedAppReview,
  RestrictedAppStorageUsage,
  WorkspaceSummary,
} from "../../types";
import { requestConfirm, showToast } from "../../ui/feedback";

export function RestrictedAppsSection({
  workspace,
  apps,
  totalApps = apps.length,
  filtered = false,
  loading,
  fixtureMode = false,
  onBuildApp,
  onOpenAppStudio,
  onUpsertApp,
  onRemoveApp,
  onError,
}: {
  workspace: WorkspaceSummary;
  apps: RestrictedAppInstalled[];
  totalApps?: number;
  filtered?: boolean;
  loading: boolean;
  fixtureMode?: boolean;
  onBuildApp: () => void;
  onOpenAppStudio: (workspaceId?: string) => void;
  onUpsertApp: (app: RestrictedAppInstalled) => void;
  onRemoveApp: (appId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourcePath, setSourcePath] = useState("");
  const [review, setReview] = useState<{ sourcePath: string; value: RestrictedAppReview } | null>(null);
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceIdRef = useRef(workspace.id);
  workspaceIdRef.current = workspace.id;
  const selectedApp = selectedAppId ? apps.find((app) => app.manifest.id === selectedAppId) ?? null : null;

  useEffect(() => {
    setSourceOpen(false);
    setSourcePath("");
    setReview(null);
    setSelectedAppId(null);
    setBusy(false);
  }, [workspace.id]);

  async function inspect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const path = sourcePath.trim();
    if (!path) return;
    const workspaceId = workspace.id;
    setBusy(true);
    try {
      const value = fixtureMode ? fixtureReview() : await inspectRestrictedApp(workspaceId, path);
      if (workspaceIdRef.current !== workspaceId) return;
      setSourceOpen(false);
      setReview({ sourcePath: path, value });
    } catch (caught) {
      if (workspaceIdRef.current === workspaceId) onError(errorText(caught));
    } finally {
      if (workspaceIdRef.current === workspaceId) setBusy(false);
    }
  }

  async function install() {
    if (!review) return;
    const workspaceId = workspace.id;
    setBusy(true);
    try {
      const app = fixtureMode
        ? fixtureInstalled(workspaceId, review.value)
        : await installRestrictedApp(workspaceId, review.sourcePath, review.value.digest);
      if (workspaceIdRef.current !== workspaceId) return;
      onUpsertApp(app);
      setReview(null);
      setSourcePath("");
      setSelectedAppId(app.manifest.id);
      showToast({ text: `${app.manifest.title} preview added with network, file, notification, and scheduled execution off.`, tone: "success" });
    } catch (caught) {
      if (workspaceIdRef.current === workspaceId) onError(errorText(caught));
    } finally {
      if (workspaceIdRef.current === workspaceId) setBusy(false);
    }
  }

  async function remove(app: RestrictedAppInstalled) {
    const confirmed = await requestConfirm({
      title: `Remove ${app.manifest.title} preview?`,
      body: "Workspace will stop this Development preview and remove its reviewed snapshot, saved credentials, grants, schedules, and local preview data. Files in the Space are left unchanged.",
      confirmLabel: "Remove preview",
      tone: "danger",
    });
    if (!confirmed || workspaceIdRef.current !== app.workspaceId) return;
    setBusy(true);
    try {
      if (!fixtureMode) await removeRestrictedApp(app.workspaceId, app.manifest.id, app.digest);
      if (workspaceIdRef.current !== app.workspaceId) return;
      onRemoveApp(app.manifest.id);
      setSelectedAppId(null);
      showToast({ text: `${app.manifest.title} preview removed.`, tone: "success" });
    } catch (caught) {
      if (workspaceIdRef.current === app.workspaceId) onError(errorText(caught));
    } finally {
      if (workspaceIdRef.current === app.workspaceId) setBusy(false);
    }
  }

  return (
    <section className="restricted-apps-section" aria-labelledby="restricted-apps-title">
      <div className="restricted-apps-heading">
        <div>
          <div className="restricted-apps-title-line"><h3 id="restricted-apps-title">Apps in this Space</h3><span>{filtered ? `${apps.length}/${totalApps}` : apps.length}</span></div>
          <p>{apps.length ? `Interactive tools exclusive to ${workspace.name}. Review each app to manage its access, connections, and automations.` : "No apps installed. Build one with the Assistant, or add a reviewed local preview."}</p>
        </div>
        <div className="restricted-apps-heading-actions"><button className="professional-button professional-button-quiet" type="button" disabled={busy} onClick={() => onOpenAppStudio(workspace.id)}>App Studio</button><button className={apps.length ? "professional-button professional-button-secondary" : "professional-button professional-button-primary"} type="button" disabled={busy} onClick={onBuildApp}><Add16Regular />{apps.length ? "Build app" : "Build with Assistant"}</button></div>
      </div>
      {loading && !apps.length ? <div className="restricted-apps-loading"><ArrowSync16Regular className="spin" />Loading sandboxed apps</div> : null}
      {apps.length ? (
        <div className="restricted-app-list">
          {apps.map((app) => {
            const access = restrictedAppAccessState(app);
            return <article className="restricted-app-card" key={app.featureInstallationId}>
              <div className="restricted-app-card-copy">
                <div className="restricted-app-card-title"><strong>{app.manifest.title}</strong><span>{app.runtimeInstanceKind === "development" ? "Local preview" : "Installed App Feature"}</span></div>
                <p>{app.manifest.description || "A Space-bound app running in Workspace's restricted browser runtime."}</p>
                <div className="restricted-app-card-meta"><span>{app.runtimeInstanceKind === "development" ? "Previewing in this Space" : "Installed in this Space · Data on this device"}</span><span>{app.packageName} {app.version}</span><span>Restricted app UI</span></div>
                <small>{app.manifest.tools.length} {app.manifest.tools.length === 1 ? "action" : "actions"} · {app.networkGrants.length}/{app.manifest.permissions.network.length} network · {app.fileGrants.length}/{app.manifest.permissions.files.length} files · {app.notificationGrants.length}/{app.manifest.permissions.notifications.length} notifications{app.manifest.automations.length ? ` · ${app.automations.filter((automation) => automation.enabled).length}/${app.manifest.automations.length} automations on` : ""}</small>
              </div>
              <div className="restricted-app-card-actions"><span className={access.enabled ? "professional-status-badge enabled" : "professional-status-badge"}>{access.label}</span><button className="professional-button professional-button-secondary" type="button" onClick={() => setSelectedAppId(app.manifest.id)}>{access.total ? "Review access" : "Details"}</button></div>
            </article>;
          })}
        </div>
      ) : null}
      <details className="restricted-app-advanced"><summary>Advanced local preview</summary><p>Review a restricted app package folder that already exists in this Space.</p><button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={() => setSourceOpen(true)}>Add local preview…</button></details>

      {sourceOpen ? <RestrictedAppSourceDialog sourcePath={sourcePath} busy={busy} onSourcePathChange={setSourcePath} onSubmit={inspect} onClose={() => { if (!busy) setSourceOpen(false); }} /> : null}
      {review ? <RestrictedAppReviewDialog review={review.value} sourcePath={review.sourcePath} updating={apps.some((app) => app.manifest.id === review.value.manifest.id)} busy={busy} onInstall={() => void install()} onClose={() => { if (!busy) setReview(null); }} /> : null}
      {selectedApp ? <RestrictedAppDetailsDialog app={selectedApp} busy={busy} fixtureMode={fixtureMode} onAppChanged={onUpsertApp} onRemove={() => void remove(selectedApp)} onOpenAppStudio={() => { setSelectedAppId(null); onOpenAppStudio(selectedApp.sourceWorkspaceId); }} onError={onError} onClose={() => { if (!busy) setSelectedAppId(null); }} /> : null}
    </section>
  );
}

function restrictedAppAccessState(app: RestrictedAppInstalled): { enabled: boolean; label: string; total: number } {
  const total = app.manifest.permissions.network.length
    + app.manifest.permissions.files.length
    + app.manifest.permissions.notifications.length
    + app.manifest.automations.length;
  const enabled = app.networkGrants.length
    + app.fileGrants.length
    + app.notificationGrants.length
    + app.automations.filter((automation) => automation.enabled).length;
  if (!total) return { enabled: false, label: "No access requested", total };
  if (!enabled) return { enabled: false, label: "Access off", total };
  return { enabled: true, label: `${enabled} of ${total} enabled`, total };
}

function RestrictedAppSourceDialog({ sourcePath, busy, onSourcePathChange, onSubmit, onClose }: {
  sourcePath: string;
  busy: boolean;
  onSourcePathChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalDialog({ onClose, blocked: busy, initialFocusRef: inputRef });
  return <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="capability-dialog restricted-app-source-dialog" role="dialog" aria-modal="true" aria-labelledby="restricted-app-source-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><h2 id="restricted-app-source-title">Add local preview package</h2><p>Enter a package folder that already exists inside this Space.</p></div><button className="minimal-icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close local preview setup"><Dismiss20Regular /></button></div>
      <form onSubmit={onSubmit}>
        <div className="capability-dialog-body restricted-app-source-body">
          <label><strong>Package path</strong><span>Enter a path relative to the root of this Space. Workspace inspects it without running package code.</span><input ref={inputRef} value={sourcePath} onChange={(event) => onSourcePathChange(event.target.value)} placeholder="apps/connected-inbox" aria-label="Space-relative app package folder" autoComplete="off" spellCheck={false} /></label>
          <aside className="capability-code-warning"><ShieldCheckmark20Regular aria-hidden="true" /><div><strong>Fixed to This Space</strong><p>Sandboxed previews belong to this Space's Development Instance. Their receipts, permissions, and credentials stay machine-local.</p></div></aside>
        </div>
        <div className="capability-dialog-footer"><button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="professional-button professional-button-primary" type="submit" disabled={busy || !sourcePath.trim()}>{busy ? <ArrowSync16Regular className="spin" /> : null}Review app</button></div>
      </form>
    </section>
  </div>;
}

export function RestrictedAppReviewDialog({ review, sourcePath, updating, busy, installDisabled = false, installLabel, closeLabel = "Not now", onInstall, onClose }: {
  review: RestrictedAppReview;
  sourcePath: string;
  updating: boolean;
  busy: boolean;
  installDisabled?: boolean;
  installLabel?: string;
  closeLabel?: string;
  onInstall: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDialog({ onClose, blocked: busy, initialFocusRef: cancelRef });
  const requestedAuthorityCount = review.manifest.permissions.network.length
    + review.manifest.permissions.files.length
    + review.manifest.permissions.notifications.length
    + review.manifest.automations.length;
  return <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="capability-dialog restricted-app-review-dialog" role="dialog" aria-modal="true" aria-labelledby="restricted-app-review-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><h2 id="restricted-app-review-title">Review {review.manifest.title}</h2><p>Confirm what this app adds and what it may ask you to allow later.</p></div><button className="minimal-icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Close app review"><Dismiss20Regular /></button></div>
      <div className="capability-dialog-body">
        <div className="restricted-app-review-summary">
          <span className="restricted-app-review-icon" aria-hidden="true"><PlugConnected20Regular /></span>
          <div>
            <span>{updating ? "Updated restricted app" : "New restricted app"}</span>
            <strong>{review.manifest.title}</strong>
            <p>{review.manifest.description || "An interactive app for this Space."}</p>
          </div>
          <span className="professional-status-badge">Access starts off</span>
        </div>
        <aside className="restricted-app-review-decision"><ShieldCheckmark20Regular aria-hidden="true" /><div><strong>One decision now</strong><p>{updating ? "Update to this exact reviewed revision. Existing access, connections, and automations reset to off." : "Add this exact reviewed revision to the Space. Network, files, notifications, and automations remain off."}</p></div></aside>
        <div className="restricted-app-review-included">
          <Add16Regular aria-hidden="true" />
          <div><strong>Added now</strong><p>An app destination and work tabs{review.manifest.tools.length ? ` · ${review.manifest.tools.length} Assistant ${review.manifest.tools.length === 1 ? "action" : "actions"}` : ""}</p></div>
          <span className="professional-status-badge enabled">Included</span>
        </div>
        <div className="restricted-app-review-heading"><div><h3>What you may approve later</h3><p>{requestedAuthorityCount ? `${requestedAuthorityCount} ${requestedAuthorityCount === 1 ? "permission or automation is" : "permissions or automations are"} declared. Each requires its own decision after the app is added.` : "This app declares no external access or automation."}</p></div><span>{requestedAuthorityCount} declared</span></div>
        <ReviewDeclarations review={review} />
        <details className="restricted-app-package-details"><summary>Package details</summary><dl className="capability-review-facts"><div><dt>Source</dt><dd>{sourcePath}</dd></div><div><dt>Package</dt><dd>{review.packageName} {review.version}</dd></div><div><dt>Files</dt><dd>{review.fileCount} · {formatBytes(review.totalBytes)}</dd></div><div><dt>Browser entry</dt><dd>{review.manifest.runtime.entry}</dd></div><div><dt>Reviewed revision</dt><dd><code>{shortDigest(review.digest)}</code></dd></div></dl></details>
        {updating ? <aside className="capability-code-warning danger"><Info20Regular aria-hidden="true" /><div><strong>This replaces the current preview</strong><p>The updated preview starts with network, file, notification, and automation permissions off and must have its access approved again.</p></div></aside> : null}
        {installDisabled && !busy ? <p className="restricted-app-install-wait">Finish the current Assistant turn before adding this reviewed preview.</p> : null}
      </div>
      <div className="capability-dialog-footer"><button ref={cancelRef} className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onClose}>{closeLabel}</button><button className="professional-button professional-button-primary" type="button" disabled={busy || installDisabled} onClick={onInstall}>{busy ? <ArrowSync16Regular className="spin" /> : null}{installLabel ?? (updating ? "Update and reset access" : "Add app with access off")}</button></div>
    </section>
  </div>;
}

function ReviewDeclarations({ review }: { review: RestrictedAppReview }) {
  return <div className="restricted-app-authority-list">
    <ReviewAuthorityGroup icon={<PlugConnected20Regular />} title="Network & connections" summary={review.manifest.permissions.network.length ? `${review.manifest.permissions.network.length} ${review.manifest.permissions.network.length === 1 ? "destination" : "destinations"} declared` : "None requested"} startsOff={Boolean(review.manifest.permissions.network.length)}>
      {review.manifest.permissions.network.length
        ? <div className="restricted-app-authority-items">{review.manifest.permissions.network.map((destination) => <article key={destination.id}>
          <strong>{destinationLabel(destination)}</strong>
          <span>{destination.methods.join(", ")} · {destination.auth.map(authLabel).join(" · ")}</span>
          {destination.auth.map((auth) => auth.kind === "oauth2-pkce"
            ? <OAuthDeclarationDetails auth={auth} key={`${destination.id}:${auth.kind}`} />
            : null)}
        </article>)}</div>
        : null}
    </ReviewAuthorityGroup>
    <ReviewAuthorityGroup icon={<ShieldCheckmark20Regular />} title="Space files" summary={review.manifest.permissions.files.length ? `${review.manifest.permissions.files.length} ${review.manifest.permissions.files.length === 1 ? "file choice" : "file choices"} declared` : "None requested"} startsOff={Boolean(review.manifest.permissions.files.length)}>
      {review.manifest.permissions.files.length ? <div className="restricted-app-authority-items">{review.manifest.permissions.files.map((permission) => <article key={permission.id}><strong>{permission.access === "read-write" ? "Read and write" : "Read"} a {permission.target} you choose</strong><span>Workspace blocks every path until you choose one.</span></article>)}</div> : null}
    </ReviewAuthorityGroup>
    <ReviewAuthorityGroup icon={<Alert20Regular />} title="Notifications" summary={review.manifest.permissions.notifications.length ? `${review.manifest.permissions.notifications.length} fixed ${review.manifest.permissions.notifications.length === 1 ? "notification" : "notifications"} declared` : "None requested"} startsOff={Boolean(review.manifest.permissions.notifications.length)}>
      {review.manifest.permissions.notifications.length ? <div className="restricted-app-authority-items">{review.manifest.permissions.notifications.map((permission) => <article key={permission.id}><strong>Workspace · {review.manifest.title} — {permission.title}</strong><span>{permission.description}</span></article>)}</div> : null}
    </ReviewAuthorityGroup>
    <ReviewAuthorityGroup icon={<Clock20Regular />} title="Automations" summary={review.manifest.automations.length ? `${review.manifest.automations.length} ${review.manifest.automations.length === 1 ? "schedule" : "schedules"} declared` : "None declared"} startsOff={Boolean(review.manifest.automations.length)}>
      {review.manifest.automations.length ? <div className="restricted-app-authority-items">{review.manifest.automations.map((automation) => <article key={automation.id}><strong>{automation.title}</strong><span>{automation.description || `Runs the ${automation.handler} handler.`}</span><small>{formatAutomationSchedule(automation)} · Power: {automationPowerSummary(review.manifest, automation)}</small></article>)}</div> : null}
    </ReviewAuthorityGroup>
  </div>;
}

function ReviewAuthorityGroup({ icon, title, summary, startsOff, children }: { icon: ReactNode; title: string; summary: string; startsOff: boolean; children?: ReactNode }) {
  return <section className="restricted-app-authority-group">
    <div className="restricted-app-authority-heading">
      <span aria-hidden="true">{icon}</span>
      <div><h4>{title}</h4><p>{summary}</p></div>
      <span className={startsOff ? "professional-status-badge" : "professional-status-badge enabled"}>{startsOff ? "Off when added" : "Included"}</span>
    </div>
    {children}
  </section>;
}

function RestrictedAppDetailsDialog({ app, busy, fixtureMode, onAppChanged, onRemove, onOpenAppStudio, onError, onClose }: {
  app: RestrictedAppInstalled;
  busy: boolean;
  fixtureMode: boolean;
  onAppChanged: (app: RestrictedAppInstalled) => void;
  onRemove: () => void;
  onOpenAppStudio: () => void;
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<RestrictedAppConnectionStatus[]>([]);
  const [storageUsage, setStorageUsage] = useState<RestrictedAppStorageUsage | null>(null);
  const [automationRuns, setAutomationRuns] = useState<Record<string, RestrictedAppAutomationRunReceipt[]>>({});
  const [automationRunLoading, setAutomationRunLoading] = useState<Record<string, boolean>>({});
  const [automationRunErrors, setAutomationRunErrors] = useState<Record<string, string>>({});
  const automationRunRequests = useRef(new Set<string>());
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const dialogRef = useModalDialog({ onClose, blocked: busy || Boolean(actionBusy) });

  useEffect(() => {
    let cancelled = false;
    setConnections([]);
    setConnectionLoading(true);
    const load = fixtureMode
      ? Promise.resolve(app.manifest.permissions.network.map((destination) => ({ destinationId: destination.id, owner: "instance" as const, kind: destination.auth.some((auth) => auth.kind === "none") ? "none" as const : null, configured: destination.auth.some((auth) => auth.kind === "none") })))
      : listRestrictedAppConnections(app.workspaceId, app.manifest.id, app.digest);
    void load.then((value) => { if (!cancelled) setConnections(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); }).finally(() => { if (!cancelled) setConnectionLoading(false); });
    const storage = fixtureMode
      ? Promise.resolve({ revision: 0, usageBytes: 0, quotaBytes: 5 * 1024 * 1024, keyCount: 0, keyLimit: 512 })
      : getRestrictedAppStorageUsage(app.workspaceId, app.manifest.id, app.digest);
    void storage.then((value) => { if (!cancelled) setStorageUsage(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [app.digest, app.manifest.id, app.workspaceId, fixtureMode, onError]);

  useEffect(() => {
    automationRunRequests.current.clear();
    setAutomationRuns({});
    setAutomationRunLoading({});
    setAutomationRunErrors({});
  }, [app.digest, app.manifest.id, app.workspaceId]);

  async function changeGrant(destination: RestrictedAppNetworkDestination, granted: boolean) {
    if (granted) {
      const confirmed = await requestConfirm({
        title: `Allow network access to ${destinationLabel(destination)}?`,
        body: destination.target.kind === "loopback-http"
          ? `${app.manifest.title} will be able to use ${destination.methods.join(", ")} requests to this exact loopback address. Workspace verifies the address, but does not yet verify which local process owns the port.`
          : `${app.manifest.title} will be able to use ${destination.methods.join(", ")} requests to this exact origin through Workspace's network broker.`,
        confirmLabel: "Allow access",
      });
      if (!confirmed) return;
    }
    const key = `grant:${destination.id}`;
    setActionBusy(key);
    try {
      const updated = fixtureMode ? { ...app, networkGrants: granted ? [...new Set([...app.networkGrants, destination.id])] : app.networkGrants.filter((id) => id !== destination.id) } : await setRestrictedAppNetworkGrant(app.workspaceId, app.manifest.id, destination.id, app.digest, granted);
      onAppChanged(updated);
      showToast({ text: granted ? `Network access allowed for ${destinationLabel(destination)}.` : `Network access revoked for ${destinationLabel(destination)}; any saved credential remains.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function saveCredential(destination: RestrictedAppNetworkDestination, credential: RestrictedAppCredential) {
    const key = `credential:${destination.id}`;
    setActionBusy(key);
    try {
      const status = fixtureMode ? { destinationId: destination.id, owner: "instance", kind: credential.kind, configured: true } as RestrictedAppConnectionStatus : await setRestrictedAppConnection(app.workspaceId, app.manifest.id, destination.id, app.digest, credential);
      setConnections((current) => upsertConnectionStatus(current, status));
      showToast({ text: `Connection saved for ${destinationLabel(destination)}. Access is ${app.networkGrants.includes(destination.id) ? "allowed" : "still off"}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); throw caught; }
    finally { setActionBusy(null); }
  }

  async function disconnect(destination: RestrictedAppNetworkDestination) {
    const confirmed = await requestConfirm({ title: `Disconnect ${destinationLabel(destination)}?`, body: "Workspace will remove the saved sign-in. The separate access permission will not change.", confirmLabel: "Disconnect", tone: "danger" });
    if (!confirmed) return;
    const key = `credential:${destination.id}`;
    setActionBusy(key);
    try {
      if (!fixtureMode) await deleteRestrictedAppConnection(app.workspaceId, app.manifest.id, destination.id, app.digest);
      const anonymous = destination.auth.some((auth) => auth.kind === "none");
      setConnections((current) => upsertConnectionStatus(current, { destinationId: destination.id, owner: "instance", kind: anonymous ? "none" : null, configured: anonymous }));
      showToast({ text: `Disconnected ${destinationLabel(destination)}. Access is ${app.networkGrants.includes(destination.id) ? "still allowed" : "off"}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function connectOAuth(destination: RestrictedAppNetworkDestination) {
    setActionBusy(`oauth:${destination.id}`);
    try {
      const status: RestrictedAppConnectionStatus = fixtureMode
        ? {
            destinationId: destination.id,
            owner: "instance" as const,
            kind: "oauth2-pkce" as const,
            configured: true,
            diagnostics: [{
              code: "METADATA_PKCE_UNDECLARED",
              issuer: "https://identity.example.com",
              message: "The provider metadata did not advertise PKCE; Workspace still enforced S256 for this connection.",
            }],
          }
        : await connectRestrictedAppOAuth(app.workspaceId, app.manifest.id, destination.id, app.digest);
      setConnections((current) => upsertConnectionStatus(current, status));
      showToast({
        text: status.diagnostics?.length
          ? `Browser sign-in connected for ${destinationLabel(destination)}. Review ${status.diagnostics.length === 1 ? "the provider note" : `${status.diagnostics.length} provider notes`} below.`
          : `Browser sign-in connected for ${destinationLabel(destination)}.`,
        tone: "success",
      });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function changeFileGrant(permission: RestrictedAppFilePermission, root: string, granted: boolean) {
    if (granted) {
      const confirmed = await requestConfirm({
        title: `Allow ${permission.access === "read-write" ? "changes to" : "reading"} ${root}?`,
        body: `${app.manifest.title} will be limited to this ${permission.target} inside the Space. Workspace metadata, Pi configuration, links, and paths outside the Space remain blocked.`,
        confirmLabel: "Allow file access",
      });
      if (!confirmed) return;
    }
    setActionBusy(`file:${permission.id}`);
    try {
      const updated = fixtureMode
        ? { ...app, fileGrants: granted ? [{ id: permission.id, declarationId: permission.id, root, access: permission.access }] : app.fileGrants.filter((grant) => grant.declarationId !== permission.id) }
        : await setRestrictedAppFileGrant(app.workspaceId, app.manifest.id, permission.id, app.digest, granted, root);
      onAppChanged(updated);
      showToast({ text: granted ? `File access allowed for ${root}.` : `File access revoked for ${permission.id}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function changeNotificationGrant(permission: RestrictedAppNotificationPermission, granted: boolean) {
    if (granted) {
      const confirmed = await requestConfirm({
        title: `Allow “${permission.title}” notifications?`,
        body: `${app.manifest.title} may show this exact notification only during an enabled automation while Workspace is running.\n\nTitle: Workspace · ${app.manifest.title} — ${permission.title}\nBody: ${permission.description}`,
        confirmLabel: "Allow notifications",
      });
      if (!confirmed) return;
    }
    setActionBusy(`notification:${permission.id}`);
    try {
      const updated = fixtureMode
        ? { ...app, notificationGrants: granted ? [...new Set([...app.notificationGrants, permission.id])] : app.notificationGrants.filter((id) => id !== permission.id) }
        : await setRestrictedAppNotificationGrant(app.workspaceId, app.manifest.id, permission.id, app.digest, granted);
      onAppChanged(updated);
      showToast({ text: granted ? `Notifications allowed for ${permission.title}.` : `Notifications revoked for ${permission.title}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function changeAutomation(automation: RestrictedAppAutomation, enabled: boolean) {
    if (enabled) {
      const confirmed = await requestConfirm({
        title: `Enable ${automation.title}?`,
        body: `${app.manifest.title} may run this automation ${formatAutomationSchedule(automation).toLowerCase()} while Workspace is running. Its reviewed power subset is ${automationPowerSummary(app.manifest, automation)}. Those powers still require their separate grants.`,
        confirmLabel: "Enable automation",
      });
      if (!confirmed) return;
    }
    const key = `automation:${automation.id}`;
    setActionBusy(key);
    try {
      const updated = fixtureMode
        ? { ...app, automations: app.automations.map((state) => state.id === automation.id ? { ...state, enabled, nextRunAt: enabled ? nextAutomationRunAt(automation) : undefined } : state) }
        : await setRestrictedAppAutomationEnabled(app.workspaceId, app.manifest.id, automation.id, app.digest, enabled);
      onAppChanged(updated);
      showToast({ text: `${automation.title} ${enabled ? "enabled" : "disabled"}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function runAutomation(automation: RestrictedAppAutomation) {
    const key = `automation-run:${automation.id}`;
    setActionBusy(key);
    try {
      const result = fixtureMode
        ? fixtureAutomationRun(app, automation)
        : await runRestrictedAppAutomationNow(app.workspaceId, app.manifest.id, automation.id, app.digest);
      onAppChanged(result.app);
      setAutomationRuns((current) => ({ ...current, [automation.id]: [result.run, ...(current[automation.id] ?? []).filter((run) => run.runId !== result.run.runId)].slice(0, 20) }));
      setAutomationRunErrors((current) => ({ ...current, [automation.id]: "" }));
      showToast({ text: automationRunToast(automation, result.run), tone: result.run.outcome === "success" ? "success" : "info" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function loadAutomationRuns(automation: RestrictedAppAutomation) {
    if (Object.prototype.hasOwnProperty.call(automationRuns, automation.id) || automationRunRequests.current.has(automation.id)) return;
    automationRunRequests.current.add(automation.id);
    setAutomationRunLoading((current) => ({ ...current, [automation.id]: true }));
    setAutomationRunErrors((current) => ({ ...current, [automation.id]: "" }));
    try {
      const runs = fixtureMode
        ? fixtureAutomationRuns(automation)
        : await listRestrictedAppAutomationRuns(app.workspaceId, app.manifest.id, automation.id, app.digest);
      setAutomationRuns((current) => ({ ...current, [automation.id]: runs }));
    } catch (caught) {
      setAutomationRunErrors((current) => ({ ...current, [automation.id]: errorText(caught) }));
    } finally {
      automationRunRequests.current.delete(automation.id);
      setAutomationRunLoading((current) => ({ ...current, [automation.id]: false }));
    }
  }

  async function clearStorage() {
    const confirmed = await requestConfirm({ title: `Clear ${app.manifest.title} app data?`, body: "This removes its machine-local settings and cached state. Connections and Space files are not changed.", confirmLabel: "Clear app data", tone: "danger" });
    if (!confirmed) return;
    setActionBusy("storage");
    try {
      const usage = fixtureMode ? { revision: (storageUsage?.revision ?? 0) + 1, usageBytes: 0, quotaBytes: 5 * 1024 * 1024, keyCount: 0, keyLimit: 512 } : await clearRestrictedAppStorage(app.workspaceId, app.manifest.id, app.digest);
      setStorageUsage(usage);
      showToast({ text: "Local app data cleared.", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  const access = restrictedAppAccessState(app);
  const accessSummary = [
    { label: "Network", enabled: app.networkGrants.length, total: app.manifest.permissions.network.length },
    { label: "Space files", enabled: app.fileGrants.length, total: app.manifest.permissions.files.length },
    { label: "Notifications", enabled: app.notificationGrants.length, total: app.manifest.permissions.notifications.length },
    { label: "Automations", enabled: app.automations.filter((automation) => automation.enabled).length, total: app.manifest.automations.length },
  ];

  return <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="capability-dialog restricted-app-details-dialog" role="dialog" aria-modal="true" aria-labelledby="restricted-app-details-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><h2 id="restricted-app-details-title">{app.manifest.title}</h2><p>{app.runtimeInstanceKind === "development" ? "Local preview" : "Feature in installed App"} · This Space · Restricted runtime</p></div><button className="minimal-icon-button" type="button" disabled={busy || Boolean(actionBusy)} onClick={onClose} aria-label="Close app details"><Dismiss20Regular /></button></div>
      <div className="capability-dialog-body">
        <p className="capability-details-summary">{app.manifest.description}</p>
        <section className="restricted-app-access-overview" aria-label="App access overview">
          <div className="restricted-app-access-overview-heading">
            <ShieldCheckmark20Regular aria-hidden="true" />
            <div><strong>{access.enabled ? access.label : "Access is off"}</strong><p>Each destination, file choice, notification, and automation is controlled separately.</p></div>
          </div>
          <div className="restricted-app-access-overview-counts">
            {accessSummary.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.enabled}/{item.total}</strong></div>)}
          </div>
        </section>
        <section className="restricted-app-connections" aria-labelledby="restricted-app-connections-title">
          <div className="restricted-app-connections-heading"><div><PlugConnected20Regular aria-hidden="true" /><h3 id="restricted-app-connections-title">Access & connections</h3></div>{connectionLoading ? <span><ArrowSync16Regular className="spin" />Checking</span> : null}</div>
          {!app.manifest.permissions.network.length ? <p>This app declares no network destinations.</p> : app.manifest.permissions.network.map((destination) => {
            const status = connections.find((item) => item.destinationId === destination.id);
            const granted = app.networkGrants.includes(destination.id);
            return <DestinationCard
              key={destination.id}
              destination={destination}
              granted={granted}
              status={status}
              loading={connectionLoading}
              busy={Boolean(actionBusy)}
              activeBusyKey={actionBusy}
              onGrantChange={(next) => void changeGrant(destination, next)}
              onSave={(credential) => saveCredential(destination, credential)}
              onOAuth={() => void connectOAuth(destination)}
              onDisconnect={() => void disconnect(destination)}
            />;
          })}
        </section>
        <section className="restricted-app-connections" aria-labelledby="restricted-app-files-title">
          <div className="restricted-app-connections-heading"><div><ShieldCheckmark20Regular aria-hidden="true" /><h3 id="restricted-app-files-title">Space files</h3></div></div>
          {!app.manifest.permissions.files.length ? <p>This app requests no Space files.</p> : app.manifest.permissions.files.map((permission) => <FilePermissionCard
            key={permission.id}
            permission={permission}
            grant={app.fileGrants.find((item) => item.declarationId === permission.id)}
            busy={Boolean(actionBusy)}
            active={actionBusy === `file:${permission.id}`}
            onChange={(root, granted) => void changeFileGrant(permission, root, granted)}
          />)}
        </section>
        <section className="restricted-app-connections" aria-labelledby="restricted-app-notifications-title">
          <div className="restricted-app-connections-heading"><div><Alert20Regular aria-hidden="true" /><h3 id="restricted-app-notifications-title">Notifications</h3></div></div>
          {!app.manifest.permissions.notifications.length ? <p>This app declares no notifications.</p> : app.manifest.permissions.notifications.map((permission) => {
            const granted = app.notificationGrants.includes(permission.id);
            return <article className="restricted-app-destination-card" key={permission.id}>
              <div className="restricted-app-destination-heading"><div><strong>Workspace · {app.manifest.title} — {permission.title}</strong><span>{permission.description}</span></div><code>{permission.id}</code></div>
              <div className="restricted-app-destination-states"><span className={granted ? "enabled" : ""}>Access: <strong>{granted ? "Allowed" : "Off"}</strong></span><span>Copy: <strong>Fixed to this reviewed revision</strong></span></div>
              <div className="restricted-app-destination-actions"><button className={granted ? "professional-button professional-button-secondary" : "professional-button professional-button-primary"} type="button" disabled={Boolean(actionBusy)} onClick={() => void changeNotificationGrant(permission, !granted)}>{actionBusy === `notification:${permission.id}` ? <ArrowSync16Regular className="spin" /> : null}{granted ? "Revoke notifications" : "Allow notifications"}</button></div>
              <p className="restricted-app-oauth-note">Shown only from an enabled automation while Workspace is running. System notification settings can still suppress it. Clicking opens this app in its owning Space.</p>
            </article>;
          })}
        </section>
        <section className="restricted-app-connections" aria-labelledby="restricted-app-automations-title">
          <div className="restricted-app-connections-heading"><div><Clock20Regular aria-hidden="true" /><h3 id="restricted-app-automations-title">Automations</h3></div></div>
          {app.manifest.automations.length ? <><p>Schedules are reviewed with the app and install off. Enable each one separately; Run now is an explicit one-off.</p>
          {app.manifest.automations.map((automation) => <AutomationCard
            key={automation.id}
            app={app}
            automation={automation}
            state={app.automations.find((item) => item.id === automation.id)}
            runs={automationRuns[automation.id]}
            runsLoading={Boolean(automationRunLoading[automation.id])}
            runsError={automationRunErrors[automation.id]}
            busy={Boolean(actionBusy)}
            activeBusyKey={actionBusy}
            onEnabledChange={(enabled) => void changeAutomation(automation, enabled)}
            onRun={() => void runAutomation(automation)}
            onLoadRuns={() => void loadAutomationRuns(automation)}
          />)}</> : <p>This app declares no scheduled automations.</p>}
        </section>
        <section className="restricted-app-lifecycle"><div><h3>Local app data</h3><p>{storageUsage ? `${formatBytes(storageUsage.usageBytes)} of ${formatBytes(storageUsage.quotaBytes)} · ${storageUsage.keyCount} of ${storageUsage.keyLimit} keys` : "Checking usage…"} · Machine-local and preserved across app updates</p></div><button className="professional-button professional-button-secondary" type="button" disabled={Boolean(actionBusy) || !storageUsage?.keyCount} onClick={() => void clearStorage()}>{actionBusy === "storage" ? <ArrowSync16Regular className="spin" /> : null}Clear data</button></section>
        <details className="restricted-app-package-details"><summary>Package & runtime</summary><dl className="capability-review-facts"><div><dt>Package</dt><dd>{app.packageName} {app.version}</dd></div><div><dt>Installed revision</dt><dd><code>{shortDigest(app.digest)}</code></dd></div><div><dt>Runtime</dt><dd>Sandboxed web app</dd></div><div><dt>UI entry</dt><dd>{app.manifest.runtime.entry}</dd></div><div><dt>Worker</dt><dd>{app.manifest.runtime.worker ?? "None"}</dd></div></dl></details>
        <section className="restricted-app-lifecycle"><div><h3>Lifecycle</h3><p>{app.runtimeInstanceKind === "development" ? "Preview" : "App Feature"} added {formatTimestamp(app.installedAt)} · Updated {formatTimestamp(app.updatedAt)}</p></div>{app.runtimeInstanceKind === "app" ? <button className="professional-button professional-button-secondary" type="button" disabled={busy || Boolean(actionBusy)} onClick={onOpenAppStudio}>Open App Studio</button> : <button className="professional-button professional-button-danger" type="button" disabled={busy || Boolean(actionBusy)} onClick={onRemove}><Delete16Regular />Remove preview</button>}</section>
      </div>
      <div className="capability-dialog-footer restricted-app-details-footer"><button className="professional-button professional-button-primary" type="button" disabled={busy || Boolean(actionBusy)} onClick={onClose}>Done</button></div>
    </section>
  </div>;
}

function AutomationCard({ app, automation, state, runs, runsLoading, runsError, busy, activeBusyKey, onEnabledChange, onRun, onLoadRuns }: {
  app: RestrictedAppInstalled;
  automation: RestrictedAppAutomation;
  state?: RestrictedAppInstalled["automations"][number];
  runs?: RestrictedAppAutomationRunReceipt[];
  runsLoading: boolean;
  runsError?: string;
  busy: boolean;
  activeBusyKey: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onRun: () => void;
  onLoadRuns: () => void;
}) {
  const enabled = state?.enabled ?? false;
  const notificationNote = automation.permissions.notifications.length
    ? "Run now works while the schedule is off, but notifications remain available only when this automation is enabled."
    : "Run now is available while the schedule is off and does not enable future runs.";
  return <article className="restricted-app-destination-card">
    <div className="restricted-app-destination-heading"><div><strong>{automation.title}</strong><span>{automation.description || `Runs the ${automation.handler} worker handler.`}</span></div><code>{automation.id}</code></div>
    <div className="restricted-app-destination-states">
      <span className={enabled ? "enabled" : ""}>Schedule: <strong>{enabled ? "On" : "Off"}</strong></span>
      <span>Frequency: <strong>{formatAutomationSchedule(automation)}</strong></span>
      <span>Next: <strong>{enabled ? state?.nextRunAt ? formatTimestamp(state.nextRunAt) : "Pending" : "Not scheduled"}</strong></span>
      <span>Last run: <strong>{state?.lastRunAt ? formatTimestamp(state.lastRunAt) : "Not run yet"}</strong></span>
    </div>
    <p className="restricted-app-oauth-note"><strong>Power subset:</strong> {automationPowerSummary(app.manifest, automation)} · {automationGrantedPowerSummary(app, automation)}</p>
    <p className="restricted-app-oauth-note">Worker handler <code>{automation.handler}</code> · {automation.catchUp === "latest" ? "Latest missed occurrence runs after resume" : "Missed occurrences are not run"} · Overlapping runs are skipped.</p>
    {state?.lastError ? <p className="restricted-app-oauth-note"><strong>Last error:</strong> {state.lastError}</p> : null}
    <div className="restricted-app-destination-actions">
      <button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onRun}>{activeBusyKey === `automation-run:${automation.id}` ? <ArrowSync16Regular className="spin" /> : null}Run now</button>
      <button className={enabled ? "professional-button professional-button-secondary" : "professional-button professional-button-primary"} type="button" disabled={busy} onClick={() => onEnabledChange(!enabled)}>{activeBusyKey === `automation:${automation.id}` ? <ArrowSync16Regular className="spin" /> : null}{enabled ? "Disable" : "Enable"}</button>
    </div>
    <p className="restricted-app-oauth-note">{notificationNote}</p>
    <details className="restricted-app-connect-details" onToggle={(event) => { if (event.currentTarget.open) onLoadRuns(); }}>
      <summary>Recent runs</summary>
      {runsLoading ? <p><ArrowSync16Regular className="spin" /> Loading run history…</p> : null}
      {runsError ? <p role="alert">Run history could not be loaded: {runsError}</p> : null}
      {!runsLoading && !runsError && runs ? runs.length ? <dl className="capability-review-facts">{runs.slice(0, 10).map((run) => {
        const verification = restrictedAppAutomationVerificationLabel(run.verification);
        return <div key={run.receiptId}><dt>{restrictedAppAutomationOutcomeLabel(run)}</dt><dd>{formatAutomationReason(run.reason)} · Scheduled {formatTimestamp(run.scheduledAt)} · Started {formatTimestamp(run.startedAt)} · Finished {formatTimestamp(run.finishedAt)}{verification ? ` · ${verification}` : ""}{run.error ? ` · ${run.error}` : ""}</dd></div>;
      })}</dl> : <p>No recorded runs.</p> : null}
    </details>
  </article>;
}

function FilePermissionCard({ permission, grant, busy, active, onChange }: {
  permission: RestrictedAppFilePermission;
  grant?: RestrictedAppInstalled["fileGrants"][number];
  busy: boolean;
  active: boolean;
  onChange: (root: string, granted: boolean) => void;
}) {
  const [root, setRoot] = useState(grant?.root ?? "");
  useEffect(() => setRoot(grant?.root ?? ""), [grant?.root, permission.target]);
  return <article className="restricted-app-destination-card">
    <div className="restricted-app-destination-heading"><div><strong>{permission.access === "read-write" ? "Read and write" : "Read"} one {permission.target}</strong><span>{grant ? `Granted: ${grant.root}` : "Choose a path inside this Space"}</span></div><code>{permission.id}</code></div>
    <div className="restricted-app-credential-fields"><label><span>Space-relative path</span><input value={root} disabled={busy || Boolean(grant)} onChange={(event) => setRoot(event.target.value)} placeholder={permission.target === "directory" ? "data (or . for the whole Space)" : "data/report.json"} /></label></div>
    <div className="restricted-app-destination-actions"><button className={grant ? "professional-button professional-button-secondary" : "professional-button professional-button-primary"} type="button" disabled={busy || (!grant && !root.trim())} onClick={() => onChange(grant?.root ?? root.trim(), !grant)}>{active ? <ArrowSync16Regular className="spin" /> : null}{grant ? "Revoke access" : "Allow access"}</button></div>
    <p className="restricted-app-oauth-note">Links, Workspace metadata, Pi configuration, and paths outside this Space are always blocked. App writes create History checkpoints.</p>
  </article>;
}

function DestinationCard({ destination, granted, status, loading, busy, activeBusyKey, onGrantChange, onSave, onOAuth, onDisconnect }: {
  destination: RestrictedAppNetworkDestination;
  granted: boolean;
  status?: RestrictedAppConnectionStatus;
  loading: boolean;
  busy: boolean;
  activeBusyKey: string | null;
  onGrantChange: (granted: boolean) => void;
  onSave: (credential: RestrictedAppCredential) => Promise<void>;
  onOAuth: () => void;
  onDisconnect: () => void;
}) {
  const supportedAuth = destination.auth.filter(isSupportedAuth);
  const oauth = destination.auth.find((auth) => auth.kind === "oauth2-pkce");
  const requiresCredential = !destination.auth.some((auth) => auth.kind === "none");
  const unsupportedOnly = requiresCredential && !supportedAuth.length && !oauth;
  return <article className="restricted-app-destination-card">
    <div className="restricted-app-destination-heading"><div><strong>{destinationLabel(destination)}</strong><span>{destination.methods.join(" · ")}</span></div><code>{destination.id}</code></div>
    <div className="restricted-app-destination-states"><span className={granted ? "enabled" : ""}>Access: <strong>{granted ? "Allowed" : "Off"}</strong></span><span className={status?.configured ? "enabled" : ""}>Connection: <strong>{loading ? "Checking…" : connectionLabel(destination, status, unsupportedOnly)}</strong></span></div>
    {oauth ? <OAuthDeclarationDetails auth={oauth} /> : null}
    {status?.diagnostics?.length ? <aside className="restricted-app-oauth-diagnostics" role="status">
      <strong>Provider compatibility {status.diagnostics.length === 1 ? "note" : "notes"}</strong>
      <ul>{status.diagnostics.map((diagnostic) => <li key={diagnostic.code}>{diagnostic.message}</li>)}</ul>
      <span>Workspace enforces these requirements directly; the connection completed successfully.</span>
    </aside> : null}
    <div className="restricted-app-destination-actions"><button className={granted ? "professional-button professional-button-secondary" : "professional-button professional-button-primary"} type="button" disabled={busy || loading} onClick={() => onGrantChange(!granted)}>{activeBusyKey === `grant:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}{granted ? "Revoke access" : "Allow access"}</button>{!loading && oauth ? <button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onOAuth}>{activeBusyKey === `oauth:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}{status?.kind === "oauth2-pkce" ? "Reconnect in browser" : "Connect in browser"}</button> : null}{!loading && status?.configured && status.kind !== "none" ? <button className="professional-button professional-button-secondary" type="button" disabled={busy} onClick={onDisconnect}>{activeBusyKey === `credential:${destination.id}` || activeBusyKey === `oauth:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}Disconnect</button> : null}</div>
    {!loading && supportedAuth.length ? <details className="restricted-app-connect-details"><summary>{status?.configured ? "Replace connection" : "Connect"}</summary><CredentialForm destination={destination} supportedAuth={supportedAuth} configuredKind={status?.kind} busy={busy} onSave={onSave} /></details> : null}
    {oauth ? <p className="restricted-app-oauth-note">Uses the system browser with PKCE. The package supplies a public native-client ID; Workspace keeps callback state and tokens in the encrypted host.</p> : null}
    {unsupportedOnly ? <p className="restricted-app-oauth-note">{destination.auth.map(authLabel).join(" or ")} is not supported by this Workspace version.</p> : null}
    {destination.target.kind === "loopback-http" ? <p className="restricted-app-oauth-note">Local process ownership is not verified. Allow this only while you recognize the service listening on this port.</p> : null}
  </article>;
}

function CredentialForm({ destination, supportedAuth, configuredKind, busy, onSave }: {
  destination: RestrictedAppNetworkDestination;
  supportedAuth: Array<Extract<RestrictedAppAuthDeclaration, { kind: "api-key" | "bearer" | "basic" }>>;
  configuredKind?: RestrictedAppConnectionStatus["kind"];
  busy: boolean;
  onSave: (credential: RestrictedAppCredential) => Promise<void>;
}) {
  const initialKind = configuredKind && isManualCredentialKind(configuredKind) ? configuredKind : supportedAuth[0]?.kind ?? "api-key";
  const [kind, setKind] = useState<"api-key" | "bearer" | "basic">(() => initialKind);
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const selected = supportedAuth.find((auth) => auth.kind === kind) ?? supportedAuth[0];
  useEffect(() => { setKind(initialKind); setSecret(""); setUsername(""); setPassword(""); }, [destination.id, initialKind, supportedAuth.map((auth) => auth.kind).join("|")]);
  if (!selected) return null;
  const ready = kind === "basic" ? Boolean(username.trim() && password) : Boolean(secret);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    const credential: RestrictedAppCredential = kind === "api-key" ? { kind, value: secret } : kind === "bearer" ? { kind, token: secret } : { kind, username: username.trim(), password };
    try {
      await onSave(credential);
      setSecret(""); setUsername(""); setPassword("");
    } catch {
      // The owner reports the host error and retains the entered value so the
      // person can retry without Workspace ever reading a stored secret back.
    }
  }
  return <form className="restricted-app-credential-form" onSubmit={(event) => void submit(event)} autoComplete="off">
    <div className="restricted-app-credential-heading"><strong>{configuredKind ? "Replace connection" : "Connect"}</strong>{supportedAuth.length > 1 ? <label><span className="sr-only">Authentication type</span><select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setSecret(""); setUsername(""); setPassword(""); }}>{supportedAuth.map((auth) => <option key={auth.kind} value={auth.kind}>{authLabel(auth)}</option>)}</select></label> : <span>{authLabel(selected)}</span>}</div>
    {kind === "basic" ? <div className="restricted-app-credential-fields"><label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label><label><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label></div> : <label className="restricted-app-secret-field"><span>{kind === "api-key" ? `API key · ${selected.kind === "api-key" ? selected.header : "manifest header"}` : "Bearer token"}</span><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label>}
    <div><button className="professional-button professional-button-secondary" type="submit" disabled={busy || !ready}>{configuredKind ? "Replace connection" : "Connect"}</button><small>Saved values are encrypted by the desktop host and are never shown again.</small></div>
  </form>;
}

function isSupportedAuth(auth: RestrictedAppAuthDeclaration): auth is Extract<RestrictedAppAuthDeclaration, { kind: "api-key" | "bearer" | "basic" }> {
  return auth.kind === "api-key" || auth.kind === "bearer" || auth.kind === "basic";
}

function isManualCredentialKind(kind: RestrictedAppConnectionStatus["kind"]): kind is "api-key" | "bearer" | "basic" {
  return kind === "api-key" || kind === "bearer" || kind === "basic";
}

function authLabel(auth: RestrictedAppAuthDeclaration): string {
  if (auth.kind === "api-key") return `API key (${auth.header})`;
  if (auth.kind === "bearer") return "Bearer token";
  if (auth.kind === "basic") return "Username and password";
  if (auth.kind === "none") return "No sign-in";
  return `OAuth browser sign-in (${new URL(auth.issuer).hostname})`;
}

function OAuthDeclarationDetails({ auth }: {
  auth: Extract<RestrictedAppAuthDeclaration, { kind: "oauth2-pkce" }>;
}) {
  const discovery = auth.discovery ?? "oauth-authorization-server";
  const discoveryLabel = discovery === "oauth-authorization-server"
    ? "OAuth server discovery"
    : discovery === "openid-configuration"
      ? "OpenID discovery"
      : "Pinned endpoints";
  return <dl className="restricted-app-oauth-contract" aria-label="OAuth request details">
    <div><dt>Issuer</dt><dd><code>{auth.issuer}</code></dd></div>
    <div><dt>Client</dt><dd><code>{auth.clientId}</code></dd></div>
    <div><dt>Scopes</dt><dd className="restricted-app-oauth-values">{auth.scopes.map((scope) => <code key={scope}>{scope}</code>)}</dd></div>
    <div><dt>Discovery</dt><dd>{discoveryLabel}</dd></div>
    {discovery === "pinned" ? <>
      <div><dt>Authorize at</dt><dd><code>{auth.authorizationEndpoint}</code></dd></div>
      <div><dt>Exchange at</dt><dd><code>{auth.tokenEndpoint}</code></dd></div>
    </> : null}
    <div><dt>Extra parameters</dt><dd className="restricted-app-oauth-values">
      {auth.authorizationParameters?.length
        ? auth.authorizationParameters.map((parameter) => <code key={parameter.name}>{parameter.name}={parameter.value}</code>)
        : <span>None</span>}
    </dd></div>
  </dl>;
}

function connectionLabel(destination: RestrictedAppNetworkDestination, status: RestrictedAppConnectionStatus | undefined, unsupportedOnly: boolean): string {
  if (destination.auth.some((auth) => auth.kind === "none")) return "No sign-in required";
  if (status?.configured) {
    if (status.kind === "api-key") return "Connected with API key";
    if (status.kind === "bearer") return "Connected with bearer token";
    if (status.kind === "basic") return "Connected with username and password";
    if (status.kind === "oauth2-pkce") return "Connected with OAuth";
  }
  return unsupportedOnly ? "Sign-in unavailable" : "Not connected";
}

function destinationLabel(destination: RestrictedAppNetworkDestination): string {
  if (destination.target.kind === "public-https") return destination.target.origin;
  return `http://${destination.target.host === "::1" ? "[::1]" : destination.target.host}:${destination.target.port}`;
}

function upsertConnectionStatus(items: RestrictedAppConnectionStatus[], status: RestrictedAppConnectionStatus): RestrictedAppConnectionStatus[] {
  return items.some((item) => item.destinationId === status.destinationId) ? items.map((item) => item.destinationId === status.destinationId ? status : item) : [...items, status];
}

function formatAutomationSchedule(automation: RestrictedAppAutomation): string {
  const minutes = automation.trigger.intervalMinutes;
  return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function automationPowerSummary(manifest: RestrictedAppReview["manifest"], automation: RestrictedAppAutomation): string {
  const network = automation.permissions.network.map((id) => {
    const destination = manifest.permissions.network.find((item) => item.id === id);
    return destination ? `network ${id} (${destinationLabel(destination)})` : `network ${id}`;
  });
  const files = automation.permissions.files.map((id) => {
    const permission = manifest.permissions.files.find((item) => item.id === id);
    return permission ? `${permission.access} file access ${id}` : `file access ${id}`;
  });
  const notifications = automation.permissions.notifications.map((id) => {
    const permission = manifest.permissions.notifications.find((item) => item.id === id);
    return permission ? `notification ${id} (“${permission.title}”)` : `notification ${id}`;
  });
  return [...network, ...files, ...notifications].join("; ") || "no network, file, or notification powers";
}

function automationGrantedPowerSummary(app: RestrictedAppInstalled, automation: RestrictedAppAutomation): string {
  const total = automation.permissions.network.length + automation.permissions.files.length + automation.permissions.notifications.length;
  if (!total) return "no separate grants required";
  const granted = automation.permissions.network.filter((id) => app.networkGrants.includes(id)).length
    + automation.permissions.files.filter((id) => app.fileGrants.some((grant) => grant.declarationId === id)).length
    + automation.permissions.notifications.filter((id) => app.notificationGrants.includes(id)).length;
  return `${granted} of ${total} currently allowed`;
}

function nextAutomationRunAt(automation: RestrictedAppAutomation): string {
  return new Date(Date.now() + automation.trigger.intervalMinutes * 60_000).toISOString();
}

function formatAutomationReason(reason: RestrictedAppAutomationRunReceipt["reason"]): string {
  return reason === "manual" ? "Manual run" : reason === "resume" ? "Resume catch-up" : "Scheduled run";
}

function automationRunToast(automation: RestrictedAppAutomation, run: RestrictedAppAutomationRunReceipt): string {
  if (run.outcome === "success") return `${automation.title} completed.`;
  if (run.outcome === "failure") return `${automation.title} finished with an error.`;
  if (run.outcome === "interrupted") return `${automation.title} was interrupted; completion is unknown.`;
  return `${automation.title} was ${run.outcome}.`;
}

function shortDigest(digest: string): string { return `${digest.slice(0, 12)}…${digest.slice(-8)}`; }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }

function fixtureAutomationRun(app: RestrictedAppInstalled, automation: RestrictedAppAutomation): { app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt } {
  const now = new Date().toISOString();
  const run: RestrictedAppAutomationRunReceipt = {
    receiptId: `receipt-fixture-${automation.id}-${Date.now()}`,
    verification: "captured",
    runId: `fixture-${automation.id}-${Date.now()}`,
    automationId: automation.id,
    reason: "manual",
    scheduledAt: now,
    startedAt: now,
    finishedAt: now,
    outcome: "success",
    state: "succeeded",
  };
  const previous = app.automations.find((state) => state.id === automation.id);
  const state = {
    id: automation.id,
    enabled: previous?.enabled ?? false,
    lastRunAt: now,
    ...(previous?.enabled ? { nextRunAt: nextAutomationRunAt(automation) } : {}),
  };
  const automations = app.automations.some((item) => item.id === automation.id)
    ? app.automations.map((item) => item.id === automation.id ? state : item)
    : [...app.automations, state];
  return { app: { ...app, automations }, run };
}

function fixtureAutomationRuns(automation: RestrictedAppAutomation): RestrictedAppAutomationRunReceipt[] {
  const finishedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  return [{
    receiptId: `receipt-fixture-scheduled-${automation.id}`,
    verification: "captured",
    runId: `fixture-scheduled-${automation.id}`,
    automationId: automation.id,
    reason: "scheduled",
    scheduledAt: new Date(Date.now() - 10 * 60_000 - 2_000).toISOString(),
    startedAt: new Date(Date.now() - 10 * 60_000 - 1_000).toISOString(),
    finishedAt,
    outcome: "success",
    state: "succeeded",
  }];
}

function fixtureReview(): RestrictedAppReview {
  return {
    packageName: "connected-inbox",
    version: "0.1.0",
    digest: "a".repeat(64),
    artifactDigest: `workspace-artifact-v1:sha256:${"b".repeat(64)}`,
    fileCount: 4,
    totalBytes: 4096,
    manifest: {
      version: 2,
      id: "connected-inbox",
      title: "Connected inbox",
      description: "Messages associated with this Space.",
      runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
      ui: { icon: "mail" },
      tools: [{ name: "inbox_search", description: "Search messages in the connected inbox.", action: "search", inputSchema: { type: "object" }, resultSchema: { type: "object" } }],
      automations: [{
        id: "refresh-inbox",
        title: "Refresh inbox",
        description: "Checks for new messages associated with this Space.",
        handler: "refresh-inbox",
        trigger: { kind: "interval", intervalMinutes: 30 },
        permissions: { network: ["mail-api"], files: ["export-folder"], notifications: ["new-messages"] },
        catchUp: "latest",
        overlap: "skip",
      }],
      permissions: {
        network: [{
          id: "mail-api",
          target: { kind: "public-https", origin: "https://mail.example.com" },
          methods: ["GET"],
          auth: [
            { kind: "api-key", header: "x-api-key" },
            { kind: "bearer" },
            {
              kind: "oauth2-pkce",
              issuer: "https://identity.example.com",
              clientId: "workspace-connected-inbox",
              scopes: ["mail.read", "mail.send"],
              discovery: "pinned",
              authorizationEndpoint: "https://identity.example.com/oauth/authorize",
              tokenEndpoint: "https://identity.example.com/oauth/token",
              authorizationParameters: [{ name: "access_type", value: "offline" }],
            },
          ],
        }],
        files: [{ id: "export-folder", target: "directory", access: "read-write" }],
        notifications: [{ id: "new-messages", title: "New messages", description: "New messages are ready in your connected inbox." }],
      },
    },
  };
}

function fixtureInstalled(workspaceId: string, review: RestrictedAppReview): RestrictedAppInstalled {
  const now = new Date().toISOString();
  const suffix = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-") || "fixture";
  return {
    ...review,
    workspaceId,
    sourceWorkspaceId: workspaceId,
    projectId: `project_${suffix}`,
    tenantId: "tenant_fixture",
    principalId: "principal_fixture-human",
    runtimeInstanceId: `runtime-instance_${suffix}`,
    runtimeInstanceKind: "development",
    releaseDigest: null,
    featureInstallationId: `feature-installation_${suffix}`,
    dataNamespaceId: `data-namespace_${suffix}`,
    authority: fixtureAuthorityStamp(),
    networkGrants: [],
    fileGrants: [],
    notificationGrants: [],
    automations: review.manifest.automations.map((automation) => ({ id: automation.id, enabled: false })),
    installedAt: now,
    updatedAt: now,
  };
}

function fixtureAuthorityStamp() {
  return {
    runtimeInstanceGeneration: "fixture-runtime",
    featureInstallationGeneration: "fixture-installation",
    grantGeneration: "fixture-grant",
    connectionGeneration: "fixture-connection",
    jobGeneration: "fixture-job",
    principalGeneration: "fixture-principal",
    dataGeneration: "fixture-data",
  };
}
