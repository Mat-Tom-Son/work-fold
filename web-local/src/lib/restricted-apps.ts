import { api } from "./api";
import type {
  RestrictedAppAutomationRunReceipt,
  RestrictedAppConnectionStatus,
  RestrictedAppCredential,
  RestrictedAppInstalled,
  RestrictedAppProposal,
  RestrictedAppReview,
  RestrictedAppStorageUsage,
  RestrictedAppDataRecovery,
  LocalAppInstallOperation,
  LocalAppInstance,
  LocalAppOperation,
  LocalAppPresentation,
  LocalAppProject,
  LocalAppRelease,
  LocalAppReleaseDeletionResult,
  LocalAppRetainedData,
  LocalAppStudioSnapshot,
  LocalAppSpaceRemovalImpact,
  LocalAppUpdateOperation,
} from "../types";

function collectionPath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/restricted-apps`;
}

export interface RestrictedAppChangeDraft {
  id: string;
  sourceSpaceId: string;
  sourcePath: string;
  appId: string;
  title: string;
  version: string;
  baseDigest: string;
  buildConversationId: string | null;
}

export interface RestrictedAppBuildContext {
  sourceSpaceId: string;
  sourcePath: string | null;
  buildConversationId: string | null;
  updateTargetRuntimeInstanceId: string | null;
}

export async function getRestrictedAppBuildContext(app: RestrictedAppInstalled): Promise<RestrictedAppBuildContext> {
  return (await api<{ context: RestrictedAppBuildContext }>(`${collectionPath(app.spaceId)}/${encodeURIComponent(app.manifest.id)}/build-context?expectedDigest=${encodeURIComponent(app.digest)}&featureInstallationId=${encodeURIComponent(app.featureInstallationId)}`)).context;
}

export async function prepareRestrictedAppChange(app: RestrictedAppInstalled, requestId: string): Promise<RestrictedAppChangeDraft> {
  return (await api<{ change: RestrictedAppChangeDraft }>(`${collectionPath(app.spaceId)}/${encodeURIComponent(app.manifest.id)}/change`, {
    method: "POST", body: { requestId, expectedDigest: app.digest, featureInstallationId: app.featureInstallationId }, idempotent: true,
  })).change;
}

function proposalPath(spaceId: string, conversationId: string, proposalId?: string): string {
  const collection = `/api/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/restricted-app-proposals`;
  return proposalId ? `${collection}/${encodeURIComponent(proposalId)}` : collection;
}

function studioPath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/app-studio`;
}

export async function getLocalAppStudio(spaceId: string): Promise<LocalAppStudioSnapshot> {
  return (await api<{ studio: LocalAppStudioSnapshot }>(studioPath(spaceId))).studio;
}

export async function getLocalAppSpaceRemovalImpact(spaceId: string): Promise<LocalAppSpaceRemovalImpact> {
  return (await api<{ impact: LocalAppSpaceRemovalImpact }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/app-removal-impact`,
  )).impact;
}

export async function declareLocalAppProject(spaceId: string, presentation: LocalAppPresentation): Promise<LocalAppProject> {
  return (await api<{ project: LocalAppProject }>(studioPath(spaceId), {
    method: "PUT",
    body: presentation,
  })).project;
}

export async function prepareLocalAppRelease(spaceId: string, displayVersion: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(spaceId)}/releases/prepare`, {
    method: "POST",
    body: { displayVersion },
  })).release;
}

export async function publishLocalAppRelease(spaceId: string, releaseDigest: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(spaceId)}/releases/publish`, {
    method: "POST",
    body: { releaseDigest },
  })).release;
}

export async function deleteLocalAppRelease(
  spaceId: string,
  releaseDigest: string,
): Promise<LocalAppReleaseDeletionResult> {
  return (await api<{ deletion: LocalAppReleaseDeletionResult }>(
    `${studioPath(spaceId)}/releases/${encodeURIComponent(releaseDigest)}`,
    { method: "DELETE" },
  )).deletion;
}

export async function prepareLocalAppInstall(
  spaceId: string,
  targetSpaceId: string,
  releaseDigest: string,
): Promise<LocalAppInstallOperation> {
  return (await api<{ operation: LocalAppInstallOperation }>(`${studioPath(spaceId)}/installs/prepare`, {
    method: "POST",
    body: { targetSpaceId: targetSpaceId, releaseDigest },
  })).operation;
}

export async function prepareLocalAppUpdate(
  spaceId: string,
  runtimeInstanceId: string,
  releaseDigest: string,
  continuityPolicy: "eligible" | "reset" = "eligible",
): Promise<LocalAppUpdateOperation> {
  return (await api<{ operation: LocalAppUpdateOperation }>(`${studioPath(spaceId)}/instances/${encodeURIComponent(runtimeInstanceId)}/updates/prepare`, {
    method: "POST",
    body: { releaseDigest, continuityPolicy },
  })).operation;
}

export async function activateLocalAppOperation(
  spaceId: string,
  operationId: string,
): Promise<{ instance: LocalAppInstance; apps: RestrictedAppInstalled[] }> {
  return api(`${studioPath(spaceId)}/operations/${encodeURIComponent(operationId)}/activate`, { method: "POST" });
}

export async function cancelLocalAppOperation(spaceId: string, operationId: string): Promise<boolean> {
  return (await api<{ cancelled: boolean }>(`${studioPath(spaceId)}/operations/${encodeURIComponent(operationId)}`, {
    method: "DELETE",
  })).cancelled;
}

export async function uninstallLocalApp(
  targetSpaceId: string,
  runtimeInstanceId: string,
  dataDisposition: "retain" | "purge",
): Promise<{ removed: boolean; retainedData: LocalAppRetainedData[]; cleanupPending: boolean }> {
  return api(`/api/spaces/${encodeURIComponent(targetSpaceId)}/local-app-instances/${encodeURIComponent(runtimeInstanceId)}`, {
    method: "DELETE",
    body: { dataDisposition },
  });
}

export async function purgeLocalAppRetainedData(spaceId: string, retainedDataId: string): Promise<{ purged: boolean; cleanupPending: boolean }> {
  return api(`${studioPath(spaceId)}/retained-data/${encodeURIComponent(retainedDataId)}`, { method: "DELETE" });
}

export async function listRestrictedAppProposals(spaceId: string, conversationId: string): Promise<RestrictedAppProposal[]> {
  return (await api<{ proposals: RestrictedAppProposal[] }>(proposalPath(spaceId, conversationId))).proposals;
}

export async function installRestrictedAppProposal(spaceId: string, conversationId: string, proposalId: string): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${proposalPath(spaceId, conversationId, proposalId)}/install`, { method: "POST" })).app;
}

export async function dismissRestrictedAppProposal(spaceId: string, conversationId: string, proposalId: string): Promise<boolean> {
  return (await api<{ dismissed: boolean }>(proposalPath(spaceId, conversationId, proposalId), { method: "DELETE" })).dismissed;
}

function appPath(spaceId: string, appId: string): string {
  return `${collectionPath(spaceId)}/${encodeURIComponent(appId)}`;
}

export async function listRestrictedApps(spaceId: string): Promise<RestrictedAppInstalled[]> {
  return (await api<{ apps: RestrictedAppInstalled[] }>(collectionPath(spaceId))).apps;
}

export async function inspectRestrictedApp(spaceId: string, sourcePath: string): Promise<RestrictedAppReview> {
  return (await api<{ review: RestrictedAppReview }>(`${collectionPath(spaceId)}/inspect`, {
    method: "POST",
    body: { sourcePath },
  })).review;
}

export async function installRestrictedApp(spaceId: string, sourcePath: string, expectedDigest: string): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(collectionPath(spaceId), {
    method: "POST",
    body: { sourcePath, expectedDigest },
  })).app;
}

export async function removeRestrictedApp(app: RestrictedAppInstalled): Promise<boolean> {
  return (await api<{ removed: boolean }>(appPath(app.spaceId, app.manifest.id), {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).removed;
}

export async function listRestrictedAppConnections(app: RestrictedAppInstalled): Promise<RestrictedAppConnectionStatus[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ connections: RestrictedAppConnectionStatus[] }>(`${appPath(app.spaceId, app.manifest.id)}/connections?${query}`)).connections;
}

export async function setRestrictedAppNetworkGrant(
  app: RestrictedAppInstalled,
  destinationId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.spaceId, app.manifest.id)}/permissions/network/${encodeURIComponent(destinationId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function setRestrictedAppFileGrant(
  app: RestrictedAppInstalled,
  permissionId: string,
  granted: boolean,
  root?: string,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.spaceId, app.manifest.id)}/permissions/files/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, ...(granted ? { root } : {}) },
  })).app;
}

export async function setRestrictedAppCheckGrant(app: RestrictedAppInstalled, permissionId: string, selection: { checkId: string; declarationDigest: string } | null): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.spaceId, app.manifest.id)}/permissions/checks/${encodeURIComponent(permissionId)}`, {
    method: selection ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, ...selection },
  })).app;
}

export async function setRestrictedAppNotificationGrant(
  app: RestrictedAppInstalled,
  permissionId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.spaceId, app.manifest.id)}/permissions/notifications/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function setRestrictedAppAutomationEnabled(
  app: RestrictedAppInstalled,
  automationId: string,
  enabled: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.spaceId, app.manifest.id)}/automations/${encodeURIComponent(automationId)}`, {
    method: enabled ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function runRestrictedAppAutomationNow(
  app: RestrictedAppInstalled,
  automationId: string,
): Promise<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }> {
  return api<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }>(`${appPath(app.spaceId, app.manifest.id)}/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  });
}

export async function listRestrictedAppAutomationRuns(
  app: RestrictedAppInstalled,
  automationId: string,
): Promise<RestrictedAppAutomationRunReceipt[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ runs: RestrictedAppAutomationRunReceipt[] }>(`${appPath(app.spaceId, app.manifest.id)}/automations/${encodeURIComponent(automationId)}/runs?${query}`)).runs;
}

export async function getRestrictedAppStorageUsage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.spaceId, app.manifest.id)}/storage?${query}`)).usage;
}

export async function clearRestrictedAppStorage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.spaceId, app.manifest.id)}/storage`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).usage;
}

export async function exportRestrictedAppData(app: RestrictedAppInstalled): Promise<unknown> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ backup: unknown }>(`${appPath(app.spaceId, app.manifest.id)}/storage/export?${query}`)).backup;
}

export async function exportRetainedAppData(sourceSpaceId: string, retainedDataId: string): Promise<unknown> {
  return (await api<{ backup: unknown }>(`${studioPath(sourceSpaceId)}/retained-data/${encodeURIComponent(retainedDataId)}`)).backup;
}

export async function getRestrictedAppDataRecovery(app: RestrictedAppInstalled): Promise<RestrictedAppDataRecovery | null> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ recovery: RestrictedAppDataRecovery | null }>(`${appPath(app.spaceId, app.manifest.id)}/storage/recovery?${query}`)).recovery;
}

export async function restoreRestrictedAppData(app: RestrictedAppInstalled, expectedRevision: number, source: { backup: unknown } | { recoveryId: string }): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.spaceId, app.manifest.id)}/storage/restore`, {
    method: "POST", body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, expectedRevision, ...source },
  })).usage;
}

export async function setRestrictedAppConnection(
  app: RestrictedAppInstalled,
  destinationId: string,
  credential: RestrictedAppCredential,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.spaceId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "PUT",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, credential },
  })).connection;
}

export async function connectRestrictedAppOAuth(
  app: RestrictedAppInstalled,
  destinationId: string,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.spaceId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}/oauth`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).connection;
}

export async function deleteRestrictedAppConnection(app: RestrictedAppInstalled, destinationId: string): Promise<boolean> {
  return (await api<{ removed: boolean }>(`${appPath(app.spaceId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).removed;
}
