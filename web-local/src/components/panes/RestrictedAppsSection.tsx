import { RestrictedAppCheckAccess } from "./RestrictedAppCheckAccess";
import { openWorkFile } from "../chat/WorkRequest";
import { RestrictedAppAssistantTasks } from "./RestrictedAppAssistantTasks";
import { RestrictedAppInferenceReceipts } from "./RestrictedAppInferenceReceipts";
import { RestrictedAppNotificationHistory } from "./RestrictedAppNotificationHistory";
import { reloadSharedPages, useSharedPages } from "../../hooks/useSharedPages";
import { activeSharedAppFor, appCanBeSharedAtAddress } from "../../lib/page-sharing";
import { appSharing } from "../../ui-contract";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Alert20Regular,
  ArrowSync16Regular,
  Clock20Regular,
  Delete16Regular,
  Dismiss20Regular,
  Globe20Regular,
  PlugConnected20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";

import { useModalDialog } from "../../hooks/useModalDialog";
import { ApiError, errorText } from "../../lib/api";
import { downloadAppData } from "../../lib/app-data-download";
import {
  restrictedAppAutomationOutcomeLabel,
} from "../../lib/restricted-app-automation";
import {
  deleteRestrictedAppConnection,
  clearRestrictedAppStorage,
  connectRestrictedAppOAuth,
  getRestrictedAppStorageUsage,
  exportRestrictedAppData,
  getRestrictedAppDataRecovery,
  getRestrictedAppBuildContext,
  type RestrictedAppBuildContext,
  restoreRestrictedAppData,
  listRestrictedAppAutomationRuns,
  listRestrictedAppConnections,
  removeRestrictedApp,
  runRestrictedAppAutomationNow,
  setRestrictedAppAutomationEnabled,
  setRestrictedAppConnection,
  setRestrictedAppFileGrant,
  setRestrictedAppNetworkGrant,
  setRestrictedAppNotificationGrant,
  shareRestrictedAppAtAddress,
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
  RestrictedAppStorageUsage,
  RestrictedAppDataRecovery,
  WorkFolderSummary,
} from "../../types";
import { requestConfirm, showToast } from "../../ui/feedback";
import { restrictedAppDataRestoreBytes } from "../../../../src/shared/restricted-app-storage-limits";

export function RestrictedAppsSection({
  workFolder,
  apps,
  loading,
  fixtureMode = false,
  onChangeApp,
  onOpenBuildChat,
  onOpenResultFile,
  onOpenAppStudio,
  onOpenSharedPages,
  onOpenWebAccess,
  onUpsertApp,
  onRemoveApp,
  onError,
}: {
  workFolder: WorkFolderSummary;
  apps: RestrictedAppInstalled[];
  loading: boolean;
  fixtureMode?: boolean;
  onChangeApp?: (app: RestrictedAppInstalled) => Promise<void>;
  onOpenBuildChat?: (workFolderId: string, conversationId: string) => Promise<void>;
  onOpenResultFile?: (workFolderId: string, path: string) => Promise<void>;
  onOpenAppStudio: (workFolderId?: string, runtimeInstanceId?: string) => void;
  onOpenSharedPages?: () => void;
  onOpenWebAccess?: () => void;
  onUpsertApp: (app: RestrictedAppInstalled) => void;
  onRemoveApp: (featureInstallationId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [selectedInstallationId, setSelectedInstallationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workFolderIdRef = useRef(workFolder.id);
  workFolderIdRef.current = workFolder.id;
  const selectedApp = selectedInstallationId ? apps.find((app) => app.featureInstallationId === selectedInstallationId) ?? null : null;

  useEffect(() => {
    setSelectedInstallationId(null);
    setBusy(false);
  }, [workFolder.id]);

  async function changeApp(app: RestrictedAppInstalled) {
    if (!onChangeApp || busy) return;
    setBusy(true);
    const workFolderId = workFolder.id;
    try { await onChangeApp(app); }
    catch (caught) { if (workFolderIdRef.current === workFolderId) onError(errorText(caught)); }
    finally { if (workFolderIdRef.current === workFolderId) setBusy(false); }
  }

  async function remove(app: RestrictedAppInstalled) {
    const confirmed = await requestConfirm({
      title: `Remove ${app.manifest.title} preview?`,
      body: "Removes the preview, access, and connections; moves app data to Recently Deleted. work-folder files remain.",
      confirmLabel: "Remove Preview",
      tone: "danger",
    });
    if (!confirmed || workFolderIdRef.current !== app.workFolderId) return;
    setBusy(true);
    try {
      const outcome = fixtureMode ? { removed: true, recentlyDeleted: null } : await removeRestrictedApp(app);
      if (workFolderIdRef.current !== app.workFolderId) return;
      onRemoveApp(app.featureInstallationId);
      setSelectedInstallationId(null);
      showToast({
        text: outcome.recentlyDeleted
          ? `${app.manifest.title} preview removed. Its data is in Recently Deleted.`
          : `${app.manifest.title} preview removed.`,
        tone: "success",
      });
    } catch (caught) {
      if (workFolderIdRef.current === app.workFolderId) onError(errorText(caught));
    } finally {
      if (workFolderIdRef.current === app.workFolderId) setBusy(false);
    }
  }

  return (
    <section className="restricted-apps-section" aria-label="Installed apps">
      {loading && !apps.length ? <div className="restricted-apps-loading"><ArrowSync16Regular className="spin" />Loading apps</div> : null}
      {apps.length ? (
        <div className="restricted-app-list">
          {apps.map((app) => {
            const access = restrictedAppAccessState(app);
            return <article className="restricted-app-card" key={app.featureInstallationId}>
              <div className="restricted-app-card-copy">
                <div className="restricted-app-card-title"><strong>{app.manifest.title}</strong><span>{app.runtimeInstanceKind === "development" ? "Local Preview" : "Installed App Feature"}</span></div>
                {app.manifest.description ? <p>{app.manifest.description}</p> : null}
                <div className="restricted-app-card-meta"><span>{app.runtimeInstanceKind === "development" ? "Previewing in this work-folder" : "Installed in this work-folder · Data on this device"}</span><span>{app.packageName} {app.version}</span></div>
                <small>{app.manifest.tools.length} {app.manifest.tools.length === 1 ? "action" : "actions"} · {app.networkGrants.length}/{app.manifest.permissions.network.length} network · {app.fileGrants.length}/{app.manifest.permissions.files.length} files · {app.notificationGrants.length}/{app.manifest.permissions.notifications.length} notifications{app.manifest.automations.length ? ` · ${app.automations.filter((automation) => automation.enabled).length}/${app.manifest.automations.length} automations on` : ""}</small>
              </div>
              <div className="restricted-app-card-actions"><span className={access.enabled ? "professional-status-badge enabled" : "professional-status-badge"}>{access.label}</span>{onChangeApp ? <button className="ui-control ui-control--quiet" type="button" disabled={busy || fixtureMode} onClick={() => void changeApp(app)}>Change This App</button> : null}<button className="ui-control" type="button" disabled={busy} onClick={() => setSelectedInstallationId(app.featureInstallationId)}>{access.total ? "Review Access" : "Details"}</button></div>
            </article>;
          })}
        </div>
      ) : null}
      {selectedApp ? <RestrictedAppDetailsDialog app={selectedApp} busy={busy} fixtureMode={fixtureMode} onAppChanged={onUpsertApp} onRemove={() => void remove(selectedApp)} onOpenBuildChat={onOpenBuildChat} onOpenResultFile={onOpenResultFile} onOpenAppStudio={(runtimeInstanceId) => { setSelectedInstallationId(null); onOpenAppStudio(selectedApp.sourceWorkFolderId, runtimeInstanceId); }} onOpenSharedPages={onOpenSharedPages ? () => { setSelectedInstallationId(null); onOpenSharedPages(); } : undefined} onOpenWebAccess={onOpenWebAccess ? () => { setSelectedInstallationId(null); onOpenWebAccess(); } : undefined} onError={onError} onClose={() => { if (!busy) setSelectedInstallationId(null); }} /> : null}
    </section>
  );
}

function restrictedAppAccessState(app: RestrictedAppInstalled): { enabled: boolean; label: string; total: number } {
  const total = app.manifest.permissions.network.length
    + app.manifest.permissions.files.length
    + (app.manifest.permissions.checks?.length ?? 0)
    + app.manifest.permissions.notifications.length
    + app.manifest.automations.length;
  const enabled = app.networkGrants.length
    + app.fileGrants.length
    + (app.checkGrants?.length ?? 0)
    + app.notificationGrants.length
    + app.automations.filter((automation) => automation.enabled).length;
  if (!total) return { enabled: false, label: "No Access Requested", total };
  if (!enabled) return { enabled: false, label: "Access Off", total };
  return { enabled: true, label: `${enabled} of ${total} enabled`, total };
}

function RestrictedAppDetailsDialog({ app, busy, fixtureMode, onAppChanged, onRemove, onOpenBuildChat, onOpenResultFile = openWorkFile, onOpenAppStudio, onOpenSharedPages, onOpenWebAccess, onError, onClose }: {
  app: RestrictedAppInstalled;
  busy: boolean;
  fixtureMode: boolean;
  onAppChanged: (app: RestrictedAppInstalled) => void;
  onRemove: () => void;
  onOpenBuildChat?: (workFolderId: string, conversationId: string) => Promise<void>;
  onOpenResultFile?: (workFolderId: string, path: string) => Promise<void>;
  onOpenAppStudio: (runtimeInstanceId?: string) => void;
  onOpenSharedPages?: () => void;
  onOpenWebAccess?: () => void;
  onError: (message: string | null) => void;
  onClose: () => void;
}) {
  const [connections, setConnections] = useState<RestrictedAppConnectionStatus[]>([]);
  const [storageUsage, setStorageUsage] = useState<RestrictedAppStorageUsage | null>(null);
  const [dataRecovery, setDataRecovery] = useState<RestrictedAppDataRecovery | null>(null);
  const [buildContext, setBuildContext] = useState<RestrictedAppBuildContext | null>(null);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const [appAutomationRuns, setAppAutomationRuns] = useState<Record<string, RestrictedAppAutomationRunReceipt[]>>({});
  const [appAutomationRunLoading, setAppAutomationRunLoading] = useState<Record<string, boolean>>({});
  const [appAutomationRunErrors, setAppAutomationRunErrors] = useState<Record<string, string>>({});
  const appAutomationRunRequests = useRef(new Set<string>());
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const dialogRef = useModalDialog({ onClose, blocked: busy || Boolean(actionBusy) });

  useEffect(() => {
    let cancelled = false;
    setConnections([]);
    setConnectionLoading(true);
    const load = fixtureMode
      ? Promise.resolve(app.manifest.permissions.network.map((destination) => ({ destinationId: destination.id, owner: "instance" as const, kind: destination.auth.some((auth) => auth.kind === "none") ? "none" as const : null, configured: destination.auth.some((auth) => auth.kind === "none") })))
      : listRestrictedAppConnections(app);
    void load.then((value) => { if (!cancelled) setConnections(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); }).finally(() => { if (!cancelled) setConnectionLoading(false); });
    const storage = fixtureMode
      ? Promise.resolve({ revision: 0, usageBytes: 0, quotaBytes: 5 * 1024 * 1024, keyCount: 0, keyLimit: 512 })
      : getRestrictedAppStorageUsage(app);
    void storage.then((value) => { if (!cancelled) setStorageUsage(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); });
    setDataRecovery(null);
    setBuildContext(null);
    if (!fixtureMode) void getRestrictedAppBuildContext(app).then((value) => { if (!cancelled) setBuildContext(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); });
    if (!fixtureMode) void getRestrictedAppDataRecovery(app).then((value) => { if (!cancelled) setDataRecovery(value); }).catch((caught) => { if (!cancelled) onError(errorText(caught)); });
    return () => { cancelled = true; };
  }, [app.digest, app.manifest.id, app.workFolderId, fixtureMode, onError]);

  async function openBuildChat() {
    if (!buildContext?.buildConversationId || !onOpenBuildChat) return;
    setActionBusy("build-chat");
    try {
      await onOpenBuildChat(buildContext.sourceWorkFolderId, buildContext.buildConversationId);
      onClose();
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  useEffect(() => {
    appAutomationRunRequests.current.clear();
    setAppAutomationRuns({});
    setAppAutomationRunLoading({});
    setAppAutomationRunErrors({});
  }, [app.digest, app.manifest.id, app.workFolderId]);

  async function changeGrant(destination: RestrictedAppNetworkDestination, granted: boolean) {
    if (granted) {
      const confirmed = await requestConfirm({
        title: `Allow network access to ${destinationLabel(destination)}?`,
        body: destination.target.kind === "loopback-http"
          ? `${app.manifest.title} will be able to use ${destination.methods.join(", ")} requests to this exact loopback address. work-fold verifies the address, but does not yet verify which local process owns the port.`
          : `${app.manifest.title} will be able to use ${destination.methods.join(", ")} requests to this exact origin through work-fold's network broker.`,
        confirmLabel: "Allow access",
      });
      if (!confirmed) return;
    }
    const key = `grant:${destination.id}`;
    setActionBusy(key);
    try {
      const updated = fixtureMode ? { ...app, networkGrants: granted ? [...new Set([...app.networkGrants, destination.id])] : app.networkGrants.filter((id) => id !== destination.id) } : await setRestrictedAppNetworkGrant(app, destination.id, granted);
      onAppChanged(updated);
      showToast({ text: granted ? `Network access allowed for ${destinationLabel(destination)}.` : `Network access revoked for ${destinationLabel(destination)}; any saved credential remains.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function saveCredential(destination: RestrictedAppNetworkDestination, credential: RestrictedAppCredential) {
    const key = `credential:${destination.id}`;
    setActionBusy(key);
    try {
      const status = fixtureMode ? { destinationId: destination.id, owner: "instance", kind: credential.kind, configured: true } as RestrictedAppConnectionStatus : await setRestrictedAppConnection(app, destination.id, credential);
      setConnections((current) => upsertConnectionStatus(current, status));
      showToast({ text: `Connection saved for ${destinationLabel(destination)}. Access is ${app.networkGrants.includes(destination.id) ? "allowed" : "still off"}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); throw caught; }
    finally { setActionBusy(null); }
  }

  async function disconnect(destination: RestrictedAppNetworkDestination) {
    const confirmed = await requestConfirm({ title: `Disconnect ${destinationLabel(destination)}?`, body: "work-fold will remove the saved sign-in. The separate access permission will not change.", confirmLabel: "Disconnect", tone: "danger" });
    if (!confirmed) return;
    const key = `credential:${destination.id}`;
    setActionBusy(key);
    try {
      if (!fixtureMode) await deleteRestrictedAppConnection(app, destination.id);
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
              message: "The provider metadata did not advertise PKCE; work-fold still enforced S256 for this connection.",
            }],
          }
        : await connectRestrictedAppOAuth(app, destination.id);
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
        body: `${app.manifest.title} will be limited to this ${permission.target} inside the work-folder. work-fold metadata, Pi configuration, links, and paths outside the work-folder remain blocked.`,
        confirmLabel: "Allow file access",
      });
      if (!confirmed) return;
    }
    setActionBusy(`file:${permission.id}`);
    try {
      const updated = fixtureMode
        ? { ...app, fileGrants: granted ? [{ id: permission.id, declarationId: permission.id, root, access: permission.access }] : app.fileGrants.filter((grant) => grant.declarationId !== permission.id) }
        : await setRestrictedAppFileGrant(app, permission.id, granted, root);
      onAppChanged(updated);
      showToast({ text: granted ? `File access allowed for ${root}.` : `File access revoked for ${permission.id}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function changeNotificationGrant(permission: RestrictedAppNotificationPermission, granted: boolean) {
    if (granted) {
      const confirmed = await requestConfirm({
        title: `Allow “${permission.title}” notifications?`,
        body: `${app.manifest.title} may show this exact notification only during an enabled automation while work-fold is running.\n\nTitle: work-fold · ${app.manifest.title} — ${permission.title}\nBody: ${permission.description}`,
        confirmLabel: "Allow notifications",
      });
      if (!confirmed) return;
    }
    setActionBusy(`notification:${permission.id}`);
    try {
      const updated = fixtureMode
        ? { ...app, notificationGrants: granted ? [...new Set([...app.notificationGrants, permission.id])] : app.notificationGrants.filter((id) => id !== permission.id) }
        : await setRestrictedAppNotificationGrant(app, permission.id, granted);
      onAppChanged(updated);
      showToast({ text: granted ? `Notifications allowed for ${permission.title}.` : `Notifications revoked for ${permission.title}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function changeAppAutomation(automation: RestrictedAppAutomation, enabled: boolean) {
    const key = `automation:${automation.id}`;
    setActionBusy(key);
    try {
      const updated = fixtureMode
        ? { ...app, automations: app.automations.map((state) => state.id === automation.id ? { ...state, enabled, nextRunAt: enabled ? nextAppAutomationRunAt(automation) : undefined } : state) }
        : await setRestrictedAppAutomationEnabled(app, automation.id, enabled);
      onAppChanged(updated);
      showToast({ text: `${automation.title} ${enabled ? "enabled" : "disabled"}.`, tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function runAppAutomation(automation: RestrictedAppAutomation) {
    const key = `app-automation-run:${automation.id}`;
    setActionBusy(key);
    try {
      const result = fixtureMode
        ? fixtureAppAutomationRun(app, automation)
        : await runRestrictedAppAutomationNow(app, automation.id);
      onAppChanged(result.app);
      setAppAutomationRuns((current) => ({ ...current, [automation.id]: [result.run, ...(current[automation.id] ?? []).filter((run) => run.runId !== result.run.runId)].slice(0, 20) }));
      setAppAutomationRunErrors((current) => ({ ...current, [automation.id]: "" }));
      showToast({ text: appAutomationRunToast(automation, result.run), tone: result.run.outcome === "success" ? "success" : "info" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function loadAppAutomationRuns(automation: RestrictedAppAutomation) {
    if (Object.prototype.hasOwnProperty.call(appAutomationRuns, automation.id) || appAutomationRunRequests.current.has(automation.id)) return;
    appAutomationRunRequests.current.add(automation.id);
    setAppAutomationRunLoading((current) => ({ ...current, [automation.id]: true }));
    setAppAutomationRunErrors((current) => ({ ...current, [automation.id]: "" }));
    try {
      const runs = fixtureMode
        ? fixtureAppAutomationRuns(automation)
        : await listRestrictedAppAutomationRuns(app, automation.id);
      setAppAutomationRuns((current) => ({ ...current, [automation.id]: runs }));
    } catch (caught) {
      setAppAutomationRunErrors((current) => ({ ...current, [automation.id]: errorText(caught) }));
    } finally {
      appAutomationRunRequests.current.delete(automation.id);
      setAppAutomationRunLoading((current) => ({ ...current, [automation.id]: false }));
    }
  }

  async function clearStorage() {
    const confirmed = await requestConfirm({ title: `Clear ${app.manifest.title} app data?`, body: "Clears app data. You can undo this until the app changes it again.", confirmLabel: "Clear app data", tone: "danger" });
    if (!confirmed) return;
    setActionBusy("storage");
    try {
      const usage = fixtureMode ? { revision: (storageUsage?.revision ?? 0) + 1, usageBytes: 0, quotaBytes: 5 * 1024 * 1024, keyCount: 0, keyLimit: 512 } : await clearRestrictedAppStorage(app);
      setStorageUsage(usage);
      if (!fixtureMode) setDataRecovery(await getRestrictedAppDataRecovery(app));
      showToast({ text: "Local app data cleared.", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function exportData() {
    setActionBusy("export-data");
    try {
      const backup = await exportRestrictedAppData(app);
      downloadAppData(app.manifest.id, backup);
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  async function restoreData(file?: File) {
    if (!storageUsage || (!file && !dataRecovery?.available)) return;
    const expectedRevision = storageUsage.revision;
    const recoveryId = dataRecovery?.id;
    setActionBusy("restore-data");
    try {
      // The host's own bound: every export work-fold makes fits.
      if (file && file.size > restrictedAppDataRestoreBytes) throw new Error("This file is larger than any app data export work-fold makes.");
      const backup: unknown = file ? JSON.parse(await file.text()) : undefined;
      const confirmed = await requestConfirm({
        title: file ? `Restore ${app.manifest.title} data?` : "Undo the last data change?",
        body: file ? "Replaces current app data. You can undo this until the app changes it again." : "Restores the data from before the last clear or restore.",
        confirmLabel: file ? "Restore data" : "Undo change",
      });
      if (!confirmed) return;
      const usage = await restoreRestrictedAppData(app, expectedRevision, file ? { backup } : { recoveryId: recoveryId! });
      setStorageUsage(usage);
      setDataRecovery(await getRestrictedAppDataRecovery(app));
      showToast({ text: "App data restored.", tone: "success" });
    } catch (caught) { onError(errorText(caught)); }
    finally { setActionBusy(null); }
  }

  const access = restrictedAppAccessState(app);
  const accessSummary = [
    { label: "Network", enabled: app.networkGrants.length, total: app.manifest.permissions.network.length },
    { label: "work-folder Files", enabled: app.fileGrants.length, total: app.manifest.permissions.files.length },
    ...(app.manifest.permissions.checks?.length ? [{ label: "Check Results", enabled: app.checkGrants?.length ?? 0, total: app.manifest.permissions.checks.length }] : []),
    { label: "Notifications", enabled: app.notificationGrants.length, total: app.manifest.permissions.notifications.length },
    { label: "Automations", enabled: app.automations.filter((automation) => automation.enabled).length, total: app.manifest.automations.length },
  ];

  return <div className="modal-backdrop capability-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="capability-dialog restricted-app-details-dialog" role="dialog" aria-modal="true" aria-labelledby="restricted-app-details-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-title"><div><h2 id="restricted-app-details-title">{app.manifest.title}</h2><p>{app.runtimeInstanceKind === "development" ? "Local Preview" : "Feature in installed App"} · This work-folder · Restricted runtime</p></div><button className="ui-control ui-control--icon" type="button" disabled={busy || Boolean(actionBusy)} onClick={onClose} aria-label="Close app details"><Dismiss20Regular /></button></div>
      <div className="capability-dialog-body">
        <p className="capability-details-summary">{app.manifest.description}</p>
        {app.manifest.assistantActions?.length ? <RestrictedAppAssistantTasks key={`${app.featureInstallationId}:${app.digest}`} app={app} disabled={busy || Boolean(actionBusy) || fixtureMode} onOpenFile={async (workFolderId, path) => { await onOpenResultFile(workFolderId, path); onClose(); }} onOpenChat={onOpenBuildChat ? async (workFolderId, conversationId) => { await onOpenBuildChat(workFolderId, conversationId); onClose(); } : undefined} /> : null}
        {/* `assistant.infer` needs no grant beyond installation, so its
            disclosure is after the fact and belongs here, under the app
            (docs/receipts-not-gates.md, F22). */}
        <RestrictedAppInferenceReceipts key={`infer:${app.featureInstallationId}:${app.digest}`} app={app} disabled={busy || Boolean(actionBusy) || fixtureMode} />
        <section className="restricted-app-access-overview" aria-label="App access overview">
          <div className="restricted-app-access-overview-heading">
            <ShieldCheckmark20Regular aria-hidden="true" />
            <div><strong>{access.enabled ? access.label : "Access is off"}</strong></div>
          </div>
          <div className="restricted-app-access-overview-counts">
            {accessSummary.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.enabled}/{item.total}</strong></div>)}
          </div>
        </section>
        {app.manifest.permissions.network.length ? <section className="restricted-app-connections" aria-labelledby="restricted-app-connections-title">
          <div className="restricted-app-connections-heading"><div><PlugConnected20Regular aria-hidden="true" /><h3 id="restricted-app-connections-title">Access & Connections</h3></div>{connectionLoading ? <span><ArrowSync16Regular className="spin" />Checking</span> : null}</div>
          {app.manifest.permissions.network.map((destination) => {
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
        </section> : null}
        {app.manifest.permissions.files.length ? <section className="restricted-app-connections" aria-labelledby="restricted-app-files-title">
          <div className="restricted-app-connections-heading"><div><ShieldCheckmark20Regular aria-hidden="true" /><h3 id="restricted-app-files-title">work-folder Files</h3></div></div>
          {app.manifest.permissions.files.map((permission) => <FilePermissionCard
            key={permission.id}
            permission={permission}
            grant={app.fileGrants.find((item) => item.declarationId === permission.id)}
            busy={Boolean(actionBusy)}
            active={actionBusy === `file:${permission.id}`}
            onChange={(root, granted) => void changeFileGrant(permission, root, granted)}
          />)}
        </section> : null}
        {app.manifest.permissions.checks?.length ? <RestrictedAppCheckAccess key={`${app.featureInstallationId}:${app.digest}`} app={app} busy={Boolean(actionBusy) || busy || fixtureMode} onAppChanged={onAppChanged} onError={onError} /> : null}
        {app.manifest.permissions.notifications.length ? <section className="restricted-app-connections" aria-labelledby="restricted-app-notifications-title">
          <div className="restricted-app-connections-heading"><div><Alert20Regular aria-hidden="true" /><h3 id="restricted-app-notifications-title">Notifications</h3></div></div>
          {app.manifest.permissions.notifications.map((permission) => {
            const granted = app.notificationGrants.includes(permission.id);
            return <article className="restricted-app-destination-card" key={permission.id}>
              <div className="restricted-app-destination-heading"><div><strong>work-fold · {app.manifest.title} — {permission.title}</strong><span>{permission.description}</span></div><code>{permission.id}</code></div>
              <div className="restricted-app-destination-states"><span className={granted ? "enabled" : ""}>Access: <strong>{granted ? "Allowed" : "Off"}</strong></span><span>Copy: <strong>Fixed to this reviewed revision</strong></span></div>
              <div className="restricted-app-destination-actions"><button className={granted ? "ui-control" : "ui-control ui-control--primary"} type="button" disabled={Boolean(actionBusy)} onClick={() => void changeNotificationGrant(permission, !granted)}>{actionBusy === `notification:${permission.id}` ? <ArrowSync16Regular className="spin" /> : null}{granted ? "Revoke notifications" : "Allow notifications"}</button></div>
            </article>;
          })}
          <RestrictedAppNotificationHistory key={`notifications:${app.featureInstallationId}`} app={app} disabled={fixtureMode} />
        </section> : null}
        {app.manifest.automations.length ? <section className="restricted-app-connections" aria-labelledby="restricted-app-automations-title">
          <div className="restricted-app-connections-heading"><div><Clock20Regular aria-hidden="true" /><h3 id="restricted-app-automations-title">Automations</h3></div></div>
          {app.manifest.automations.map((automation) => <AppAutomationCard
            key={automation.id}
            app={app}
            automation={automation}
            state={app.automations.find((item) => item.id === automation.id)}
            runs={appAutomationRuns[automation.id]}
            runsLoading={Boolean(appAutomationRunLoading[automation.id])}
            runsError={appAutomationRunErrors[automation.id]}
            busy={Boolean(actionBusy)}
            activeBusyKey={actionBusy}
            onEnabledChange={(enabled) => void changeAppAutomation(automation, enabled)}
            onRun={() => void runAppAutomation(automation)}
            onLoadRuns={() => void loadAppAutomationRuns(automation)}
          />)}
        </section> : null}
        <section className="restricted-app-lifecycle"><div><h3>App Data</h3><p>{storageUsage ? `${formatBytes(storageUsage.usageBytes)} · Saved on this computer` : "Checking usage…"}</p></div><div className="restricted-app-lifecycle-actions">
          <input ref={restoreInputRef} type="file" accept=".json,application/json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void restoreData(file); }} />
          <button className="ui-control" type="button" disabled={fixtureMode || Boolean(actionBusy) || !storageUsage} onClick={() => void exportData()}>Export data</button>
          <button className="ui-control" type="button" disabled={fixtureMode || Boolean(actionBusy) || !storageUsage} onClick={() => restoreInputRef.current?.click()}>Restore…</button>
          {dataRecovery?.available ? <button className="ui-control ui-control--quiet" type="button" disabled={Boolean(actionBusy)} onClick={() => void restoreData()}>Undo data change</button> : null}
          <button className="ui-control ui-control--quiet" type="button" disabled={Boolean(actionBusy) || !storageUsage?.keyCount} onClick={() => void clearStorage()}>{actionBusy === "storage" ? <ArrowSync16Regular className="spin" /> : null}Clear data</button>
        </div></section>
        <details className="restricted-app-package-details"><summary>Package & Runtime</summary><dl className="capability-review-facts"><div><dt>Package</dt><dd>{app.packageName} {app.version}</dd></div><div><dt>Installed revision</dt><dd><code>{shortDigest(app.digest)}</code></dd></div>{buildContext?.sourcePath ? <div><dt>Source folder</dt><dd><code>{buildContext.sourcePath}</code></dd></div> : null}<div><dt>Runtime</dt><dd>Protected local web app</dd></div><div><dt>UI entry</dt><dd>{app.manifest.runtime.entry}</dd></div><div><dt>Worker</dt><dd>{app.manifest.runtime.worker ?? "None"}</dd></div></dl></details>
        <section className="restricted-app-lifecycle">
          <div>
            <h3>Lifecycle</h3>
            <p>{app.runtimeInstanceKind === "development" ? "Preview" : "App Feature"} added {formatTimestamp(app.installedAt)} · Updated {formatTimestamp(app.updatedAt)}</p>
            {/* Only an installed Release that declares a viewer can be put at
                the address; its reviewed declaration says what that exposes. */}
            {app.manifest.viewer && appCanBeSharedAtAddress(app) ? <p className="restricted-app-share-note">{appSharing.viewerNote(app.manifest.viewer.entry, app.manifest.viewer.readable)}</p> : null}
          </div>
          <div className="restricted-app-lifecycle-actions">
            <button className="ui-control" type="button" disabled={busy || Boolean(actionBusy)} onClick={() => onOpenAppStudio(buildContext?.updateTargetRuntimeInstanceId ?? (app.runtimeInstanceKind === "app" ? app.runtimeInstanceId : undefined))}>{buildContext?.updateTargetRuntimeInstanceId || app.runtimeInstanceKind === "app" ? "Review updates" : "Open App Studio"}</button>
            {appCanBeSharedAtAddress(app) ? <ShareAppAtAddressButton app={app} disabled={busy || Boolean(actionBusy)} fixtureMode={fixtureMode} onOpenSharedPages={onOpenSharedPages} onOpenWebAccess={onOpenWebAccess} onError={onError} /> : null}
            {buildContext?.buildConversationId && onOpenBuildChat ? <button className="ui-control ui-control--quiet" type="button" disabled={busy || Boolean(actionBusy)} onClick={() => void openBuildChat()}>Open build Chat</button> : null}
            {app.runtimeInstanceKind === "development" ? <button className="ui-control professional-button-danger" type="button" disabled={busy || Boolean(actionBusy)} onClick={onRemove}><Delete16Regular />Remove Preview</button> : null}
          </div>
        </section>
      </div>
      <div className="capability-dialog-footer restricted-app-details-footer"><button className="ui-control ui-control--primary" type="button" disabled={busy || Boolean(actionBusy)} onClick={onClose}>Done</button></div>
    </section>
  </div>;
}

/**
 * "Share at your address" for an eligible installed app (docs/shared-pages.md,
 * rung 3). The click shares and says so, like sharing a file; the link is
 * revealed in Settings → Shared Pages, where Stop Sharing undoes it. The next
 * step stays in the dialog, because the dialog keeps everything behind it —
 * toasts included — out of reach: once shared, the button opens Shared Pages;
 * with no address, it opens Web Access.
 */
function ShareAppAtAddressButton({ app, disabled, fixtureMode, onOpenSharedPages, onOpenWebAccess, onError }: {
  app: RestrictedAppInstalled;
  disabled: boolean;
  fixtureMode: boolean;
  onOpenSharedPages?: () => void;
  onOpenWebAccess?: () => void;
  onError: (message: string | null) => void;
}) {
  const publications = useSharedPages(fixtureMode);
  const [sharing, setSharing] = useState(false);
  const [justShared, setJustShared] = useState(false);
  const [needsAddress, setNeedsAddress] = useState(false);
  const shared = justShared || Boolean(activeSharedAppFor(publications, app.featureInstallationId));

  async function share() {
    if (fixtureMode) {
      showToast({ text: appSharing.previewDisabled, tone: "info" });
      return;
    }
    setSharing(true);
    try {
      const result = await shareRestrictedAppAtAddress(app);
      setJustShared(true);
      setNeedsAddress(false);
      void reloadSharedPages({ afterMutation: true });
      showToast({ text: appSharing.sharedToast(result.publication.title), tone: "success" });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "NO_ADDRESS") {
        setNeedsAddress(true);
        showToast({ text: appSharing.noAddress, tone: "info" });
      } else {
        void reloadSharedPages({ afterMutation: true });
        onError(errorText(caught));
      }
    } finally {
      setSharing(false);
    }
  }

  if (shared) {
    return onOpenSharedPages
      ? <button className="ui-control ui-control--quiet" type="button" disabled={disabled} title={appSharing.shared} onClick={onOpenSharedPages}><Globe20Regular />{appSharing.openSharedPages}</button>
      : <span className="professional-status-badge enabled">{appSharing.shared}</span>;
  }
  if (needsAddress && onOpenWebAccess) {
    return <button className="ui-control" type="button" disabled={disabled} title={appSharing.noAddress} onClick={onOpenWebAccess}><Globe20Regular />{appSharing.webAccess}</button>;
  }
  return <button className="ui-control" type="button" disabled={disabled || sharing} onClick={() => void share()}>{sharing ? <ArrowSync16Regular className="spin" /> : <Globe20Regular />}{appSharing.share}</button>;
}

function AppAutomationCard({ app, automation, state, runs, runsLoading, runsError, busy, activeBusyKey, onEnabledChange, onRun, onLoadRuns }: {
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
    ? "Notifications require the schedule to be enabled."
    : null;
  return <article className="restricted-app-destination-card">
    <div className="restricted-app-destination-heading"><div><strong>{automation.title}</strong><span>{automation.description || `Runs the ${automation.handler} worker handler.`}</span></div><code>{automation.id}</code></div>
    <div className="restricted-app-destination-states">
      <span className={enabled ? "enabled" : ""}>Schedule: <strong>{enabled ? "On" : "Off"}</strong></span>
      <span>Frequency: <strong>{formatAppAutomationSchedule(automation)}</strong></span>
      <span>Next: <strong>{enabled ? state?.nextRunAt ? formatTimestamp(state.nextRunAt) : "Pending" : "Not scheduled"}</strong></span>
      <span>Last run: <strong>{state?.lastRunAt ? formatTimestamp(state.lastRunAt) : "Not Run Yet"}</strong></span>
    </div>
    <p className="restricted-app-oauth-note"><strong>Power subset:</strong> {appAutomationPowerSummary(app.manifest, automation)} · {appAutomationGrantedPowerSummary(app, automation)}</p>
    <p className="restricted-app-oauth-note">Worker handler <code>{automation.handler}</code> · {automation.catchUp === "latest" ? "Latest missed occurrence runs after resume" : "Missed occurrences are not run"} · Overlapping runs are skipped.</p>
    {state?.lastError ? <div className="restricted-app-oauth-note restricted-app-last-error"><strong>Last error:</strong> <AppErrorText text={state.lastError} /></div> : null}
    <div className="restricted-app-destination-actions">
      <button className="ui-control" type="button" disabled={busy} onClick={onRun}>{activeBusyKey === `app-automation-run:${automation.id}` ? <ArrowSync16Regular className="spin" /> : null}Run Now</button>
      <button className={enabled ? "ui-control" : "ui-control ui-control--primary"} type="button" disabled={busy} onClick={() => onEnabledChange(!enabled)}>{activeBusyKey === `automation:${automation.id}` ? <ArrowSync16Regular className="spin" /> : null}{enabled ? "Disable" : "Enable"}</button>
    </div>
    {notificationNote ? <p className="restricted-app-oauth-note">{notificationNote}</p> : null}
    <details className="restricted-app-connect-details" onToggle={(event) => { if (event.currentTarget.open) onLoadRuns(); }}>
      <summary>Recent Runs</summary>
      {runsLoading ? <p><ArrowSync16Regular className="spin" /> Loading run history…</p> : null}
      {runsError ? <p role="alert">Run history could not be loaded: {runsError}</p> : null}
      {!runsLoading && !runsError && runs ? runs.length ? <dl className="capability-review-facts">{runs.slice(0, 10).map((run) => {
        return <div key={run.receiptId}><dt>{restrictedAppAutomationOutcomeLabel(run)}</dt><dd>{formatAppAutomationReason(run.reason)} · Scheduled {formatTimestamp(run.scheduledAt)} · Started {formatTimestamp(run.startedAt)} · Finished {formatTimestamp(run.finishedAt)}{run.featureRevisionDigest !== app.artifactDigest ? " · Earlier revision" : ""}{run.error ? <AppErrorText text={run.error} /> : null}</dd></div>;
      })}</dl> : <p>No recorded runs.</p> : null}
    </details>
  </article>;
}

/** Past this, error text starts folded to a few lines. */
const appErrorFoldCharacters = 280;
const appErrorFoldLines = 4;

/**
 * An app's error text, kept whole (up to 16 KiB) but folded to a few lines
 * until the person opens it, so a long error never takes over the card.
 */
export function AppErrorText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > appErrorFoldCharacters || text.split("\n").length > appErrorFoldLines;
  return <span className={`restricted-app-error-text${long && !open ? " folded" : ""}`}>
    <span className="restricted-app-error-body">{text}</span>
    {long ? <button className="app-studio-text-button restricted-app-error-toggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>{open ? "Show less" : "Show all"}</button> : null}
  </span>;
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
  const wholeWorkFolder = grant?.root === ".";
  const rootChanged = Boolean(grant) && root.trim() !== "" && root.trim() !== grant?.root;
  return <article className="restricted-app-destination-card">
    <div className="restricted-app-destination-heading"><div><strong>{permission.access === "read-write" ? "Read and write" : "Read"} one {permission.target}</strong><span>{grant ? wholeWorkFolder ? "Whole work-folder" : `Granted: ${grant.root}` : "Choose a path inside this work-folder"}</span></div><code>{permission.id}</code></div>
    <div className="restricted-app-credential-fields"><label><span>work-folder-relative path</span><input value={root} disabled={busy} onChange={(event) => setRoot(event.target.value)} placeholder={permission.target === "directory" ? "data (or . for the whole work-folder)" : "data/report.json"} /></label></div>
    <div className="restricted-app-destination-actions">
      {/* An editable path needs a way to apply it: a granted folder can be
          narrowed or moved, and a granted single file can be pointed at a
          different file. Without this the field would accept an edit the
          neighbouring Revoke button silently discards. */}
      {grant && rootChanged ? <button className="ui-control" type="button" disabled={busy} onClick={() => onChange(root.trim(), true)}>{active ? <ArrowSync16Regular className="spin" /> : null}{permission.target === "directory" ? wholeWorkFolder ? "Limit to folder" : "Change folder" : "Change file"}</button> : null}
      <button className={grant ? "ui-control" : "ui-control ui-control--primary"} type="button" disabled={busy || (!grant && !root.trim())} onClick={() => onChange(grant?.root ?? root.trim(), !grant)}>{active && !rootChanged ? <ArrowSync16Regular className="spin" /> : null}{grant ? "Revoke access" : "Allow access"}</button>
    </div>
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
    </aside> : null}
    <div className="restricted-app-destination-actions"><button className={granted ? "ui-control" : "ui-control ui-control--primary"} type="button" disabled={busy || loading} onClick={() => onGrantChange(!granted)}>{activeBusyKey === `grant:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}{granted ? "Revoke access" : "Allow access"}</button>{!loading && oauth ? <button className="ui-control" type="button" disabled={busy} onClick={onOAuth}>{activeBusyKey === `oauth:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}{status?.kind === "oauth2-pkce" ? "Reconnect in browser" : "Connect in browser"}</button> : null}{!loading && status?.configured && status.kind !== "none" ? <button className="ui-control" type="button" disabled={busy} onClick={onDisconnect}>{activeBusyKey === `credential:${destination.id}` || activeBusyKey === `oauth:${destination.id}` ? <ArrowSync16Regular className="spin" /> : null}Disconnect</button> : null}</div>
    {!loading && supportedAuth.length ? <details className="restricted-app-connect-details"><summary>{status?.configured ? "Replace connection" : "Connect"}</summary><CredentialForm destination={destination} supportedAuth={supportedAuth} configuredKind={status?.kind} busy={busy} onSave={onSave} /></details> : null}
    {unsupportedOnly ? <p className="restricted-app-oauth-note">{destination.auth.map(authLabel).join(" or ")} is not supported by this work-fold version.</p> : null}
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
      // person can retry without work-fold ever reading a stored secret back.
    }
  }
  return <form className="restricted-app-credential-form" onSubmit={(event) => void submit(event)} autoComplete="off">
    <div className="restricted-app-credential-heading"><strong>{configuredKind ? "Replace connection" : "Connect"}</strong>{supportedAuth.length > 1 ? <label><span className="sr-only">Authentication type</span><select value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setSecret(""); setUsername(""); setPassword(""); }}>{supportedAuth.map((auth) => <option key={auth.kind} value={auth.kind}>{authLabel(auth)}</option>)}</select></label> : <span>{authLabel(selected)}</span>}</div>
    {kind === "basic" ? <div className="restricted-app-credential-fields"><label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" /></label><label><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></label></div> : <label className="restricted-app-secret-field"><span>{kind === "api-key" ? `API key · ${selected.kind === "api-key" ? selected.header : "manifest header"}` : "Bearer token"}</span><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="new-password" /></label>}
    <div><button className="ui-control" type="submit" disabled={busy || !ready}>{configuredKind ? "Replace connection" : "Connect"}</button></div>
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
  return unsupportedOnly ? "Sign-in unavailable" : "Not Connected";
}

function destinationLabel(destination: RestrictedAppNetworkDestination): string {
  if (destination.target.kind === "public-https") return destination.target.origin;
  return `http://${destination.target.host === "::1" ? "[::1]" : destination.target.host}:${destination.target.port}`;
}

function upsertConnectionStatus(items: RestrictedAppConnectionStatus[], status: RestrictedAppConnectionStatus): RestrictedAppConnectionStatus[] {
  return items.some((item) => item.destinationId === status.destinationId) ? items.map((item) => item.destinationId === status.destinationId ? status : item) : [...items, status];
}

function formatAppAutomationSchedule(automation: RestrictedAppAutomation): string {
  const minutes = automation.trigger.intervalMinutes;
  return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function appAutomationPowerSummary(manifest: RestrictedAppInstalled["manifest"], automation: RestrictedAppAutomation): string {
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

function appAutomationGrantedPowerSummary(app: RestrictedAppInstalled, automation: RestrictedAppAutomation): string {
  const total = automation.permissions.network.length + automation.permissions.files.length + automation.permissions.notifications.length;
  if (!total) return "no separate grants required";
  const granted = automation.permissions.network.filter((id) => app.networkGrants.includes(id)).length
    + automation.permissions.files.filter((id) => app.fileGrants.some((grant) => grant.declarationId === id)).length
    + automation.permissions.notifications.filter((id) => app.notificationGrants.includes(id)).length;
  return `${granted} of ${total} currently allowed`;
}

function nextAppAutomationRunAt(automation: RestrictedAppAutomation): string {
  return new Date(Date.now() + automation.trigger.intervalMinutes * 60_000).toISOString();
}

function formatAppAutomationReason(reason: RestrictedAppAutomationRunReceipt["reason"]): string {
  return reason === "manual" ? "Manual run" : reason === "resume" ? "Resume catch-up" : "Scheduled run";
}

function appAutomationRunToast(automation: RestrictedAppAutomation, run: RestrictedAppAutomationRunReceipt): string {
  if (run.outcome === "success") return `${automation.title} completed.`;
  if (run.outcome === "failure") return `${automation.title} finished with an error.`;
  if (run.outcome === "interrupted") return `${automation.title} was interrupted; completion is unknown.`;
  return `${automation.title} was ${run.outcome}.`;
}

function shortDigest(digest: string): string { return `${digest.slice(0, 12)}…${digest.slice(-8)}`; }
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
function formatTimestamp(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(); }

function fixtureAppAutomationRun(app: RestrictedAppInstalled, automation: RestrictedAppAutomation): { app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt } {
  const now = new Date().toISOString();
  const run: RestrictedAppAutomationRunReceipt = {
    receiptId: `receipt-fixture-${automation.id}-${Date.now()}`,
    verification: "captured",
    runId: `fixture-${automation.id}-${Date.now()}`,
    appAutomationId: automation.id,
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
    ...(previous?.enabled ? { nextRunAt: nextAppAutomationRunAt(automation) } : {}),
  };
  const automations = app.automations.some((item) => item.id === automation.id)
    ? app.automations.map((item) => item.id === automation.id ? state : item)
    : [...app.automations, state];
  return { app: { ...app, automations }, run };
}

function fixtureAppAutomationRuns(automation: RestrictedAppAutomation): RestrictedAppAutomationRunReceipt[] {
  const finishedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  return [{
    receiptId: `receipt-fixture-scheduled-${automation.id}`,
    verification: "captured",
    runId: `fixture-scheduled-${automation.id}`,
    appAutomationId: automation.id,
    reason: "scheduled",
    scheduledAt: new Date(Date.now() - 10 * 60_000 - 2_000).toISOString(),
    startedAt: new Date(Date.now() - 10 * 60_000 - 1_000).toISOString(),
    finishedAt,
    outcome: "success",
    state: "succeeded",
  }];
}
