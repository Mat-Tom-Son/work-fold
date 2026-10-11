import { api } from "./api";
import type {
  RestrictedAppAutomationRunReceipt,
  RestrictedAppConnectionStatus,
  RestrictedAppCredential,
  RestrictedAppInstalled,
  RestrictedAppReview,
  RestrictedAppStorageUsage,
  RestrictedAppDataRecovery,
  LocalAppInstallOperation,
  LocalAppInstance,
  LocalAppPresentation,
  LocalAppProject,
  LocalAppRelease,
  LocalAppReleaseDeletionResult,
  LocalAppRetainedData,
  LocalAppStudioSnapshot,
  LocalAppWorkFolderRemovalImpact,
  LocalAppUpdateOperation,
} from "../types";

function collectionPath(workFolderId: string): string {
  return `/api/work-folders/${encodeURIComponent(workFolderId)}/restricted-apps`;
}

export interface RestrictedAppChangeDraft {
  id: string;
  sourceWorkFolderId: string;
  sourcePath: string;
  appId: string;
  title: string;
  version: string;
  baseDigest: string;
  buildConversationId: string | null;
}

export interface RestrictedAppBuildContext {
  sourceWorkFolderId: string;
  sourcePath: string | null;
  buildConversationId: string | null;
  updateTargetRuntimeInstanceId: string | null;
}

export async function getRestrictedAppBuildContext(app: RestrictedAppInstalled): Promise<RestrictedAppBuildContext> {
  return (await api<{ context: RestrictedAppBuildContext }>(`${collectionPath(app.workFolderId)}/${encodeURIComponent(app.manifest.id)}/build-context?expectedDigest=${encodeURIComponent(app.digest)}&featureInstallationId=${encodeURIComponent(app.featureInstallationId)}`)).context;
}

export async function prepareRestrictedAppChange(app: RestrictedAppInstalled, requestId: string): Promise<RestrictedAppChangeDraft> {
  return (await api<{ change: RestrictedAppChangeDraft }>(`${collectionPath(app.workFolderId)}/${encodeURIComponent(app.manifest.id)}/change`, {
    method: "POST", body: { requestId, expectedDigest: app.digest, featureInstallationId: app.featureInstallationId }, idempotent: true,
  })).change;
}

function proposalPath(workFolderId: string, conversationId: string, proposalId?: string): string {
  const collection = `/api/work-folders/${encodeURIComponent(workFolderId)}/conversations/${encodeURIComponent(conversationId)}/restricted-app-proposals`;
  return proposalId ? `${collection}/${encodeURIComponent(proposalId)}` : collection;
}

function studioPath(workFolderId: string): string {
  return `/api/work-folders/${encodeURIComponent(workFolderId)}/app-studio`;
}

export async function getLocalAppStudio(workFolderId: string): Promise<LocalAppStudioSnapshot> {
  return (await api<{ studio: LocalAppStudioSnapshot }>(studioPath(workFolderId))).studio;
}

export async function getLocalAppWorkFolderRemovalImpact(workFolderId: string): Promise<LocalAppWorkFolderRemovalImpact> {
  return (await api<{ impact: LocalAppWorkFolderRemovalImpact }>(
    `/api/work-folders/${encodeURIComponent(workFolderId)}/app-removal-impact`,
  )).impact;
}

export async function declareLocalAppProject(workFolderId: string, presentation: LocalAppPresentation): Promise<LocalAppProject> {
  return (await api<{ project: LocalAppProject }>(studioPath(workFolderId), {
    method: "PUT",
    body: presentation,
  })).project;
}

export async function prepareLocalAppRelease(workFolderId: string, displayVersion: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(workFolderId)}/releases/prepare`, {
    method: "POST",
    body: { displayVersion },
  })).release;
}

export async function publishLocalAppRelease(workFolderId: string, releaseDigest: string): Promise<LocalAppRelease> {
  return (await api<{ release: LocalAppRelease }>(`${studioPath(workFolderId)}/releases/publish`, {
    method: "POST",
    body: { releaseDigest },
  })).release;
}

export async function deleteLocalAppRelease(
  workFolderId: string,
  releaseDigest: string,
): Promise<LocalAppReleaseDeletionResult> {
  return (await api<{ deletion: LocalAppReleaseDeletionResult }>(
    `${studioPath(workFolderId)}/releases/${encodeURIComponent(releaseDigest)}`,
    { method: "DELETE" },
  )).deletion;
}

export async function prepareLocalAppInstall(
  workFolderId: string,
  targetWorkFolderId: string,
  releaseDigest: string,
): Promise<LocalAppInstallOperation> {
  return (await api<{ operation: LocalAppInstallOperation }>(`${studioPath(workFolderId)}/installs/prepare`, {
    method: "POST",
    body: { targetWorkFolderId: targetWorkFolderId, releaseDigest },
  })).operation;
}

export async function prepareLocalAppUpdate(
  workFolderId: string,
  runtimeInstanceId: string,
  releaseDigest: string,
  continuityPolicy: "eligible" | "reset" = "eligible",
): Promise<LocalAppUpdateOperation> {
  return (await api<{ operation: LocalAppUpdateOperation }>(`${studioPath(workFolderId)}/instances/${encodeURIComponent(runtimeInstanceId)}/updates/prepare`, {
    method: "POST",
    body: { releaseDigest, continuityPolicy },
  })).operation;
}

export async function activateLocalAppOperation(
  workFolderId: string,
  operationId: string,
): Promise<{ instance: LocalAppInstance; apps: RestrictedAppInstalled[] }> {
  return api(`${studioPath(workFolderId)}/operations/${encodeURIComponent(operationId)}/activate`, { method: "POST" });
}

export async function cancelLocalAppOperation(workFolderId: string, operationId: string): Promise<boolean> {
  return (await api<{ cancelled: boolean }>(`${studioPath(workFolderId)}/operations/${encodeURIComponent(operationId)}`, {
    method: "DELETE",
  })).cancelled;
}

export async function uninstallLocalApp(
  targetWorkFolderId: string,
  runtimeInstanceId: string,
  dataDisposition: "retain" | "purge",
): Promise<{ removed: boolean; retainedData: LocalAppRetainedData[]; cleanupPending: boolean }> {
  return api(`/api/work-folders/${encodeURIComponent(targetWorkFolderId)}/local-app-instances/${encodeURIComponent(runtimeInstanceId)}`, {
    method: "DELETE",
    body: { dataDisposition },
  });
}

export async function purgeLocalAppRetainedData(workFolderId: string, retainedDataId: string): Promise<{ purged: boolean; cleanupPending: boolean }> {
  return api(`${studioPath(workFolderId)}/retained-data/${encodeURIComponent(retainedDataId)}`, { method: "DELETE" });
}
export async function installRestrictedAppProposal(workFolderId: string, conversationId: string, proposalId: string): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${proposalPath(workFolderId, conversationId, proposalId)}/install`, { method: "POST" })).app;
}

export async function dismissRestrictedAppProposal(workFolderId: string, conversationId: string, proposalId: string): Promise<boolean> {
  return (await api<{ dismissed: boolean }>(proposalPath(workFolderId, conversationId, proposalId), { method: "DELETE" })).dismissed;
}

function appPath(workFolderId: string, appId: string): string {
  return `${collectionPath(workFolderId)}/${encodeURIComponent(appId)}`;
}

export async function listRestrictedApps(workFolderId: string): Promise<RestrictedAppInstalled[]> {
  return (await api<{ apps: RestrictedAppInstalled[] }>(collectionPath(workFolderId))).apps;
}

export async function inspectRestrictedApp(workFolderId: string, sourcePath: string): Promise<RestrictedAppReview> {
  return (await api<{ review: RestrictedAppReview }>(`${collectionPath(workFolderId)}/inspect`, {
    method: "POST",
    body: { sourcePath },
  })).review;
}

export async function installRestrictedApp(workFolderId: string, sourcePath: string, expectedDigest: string): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(collectionPath(workFolderId), {
    method: "POST",
    body: { sourcePath, expectedDigest },
  })).app;
}

/**
 * Removing a preview takes its data with it, so the host leaves a recoverable
 * copy in Recently deleted first (docs/receipts-not-gates.md, F20) and names
 * the entry here.
 */
export async function removeRestrictedApp(
  app: RestrictedAppInstalled,
): Promise<{ removed: boolean; recentlyDeleted: { entryId: string; restoreBy: string } | null }> {
  return await api<{ removed: boolean; recentlyDeleted: { entryId: string; restoreBy: string } | null }>(appPath(app.workFolderId, app.manifest.id), {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  });
}

export async function listRestrictedAppConnections(app: RestrictedAppInstalled): Promise<RestrictedAppConnectionStatus[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ connections: RestrictedAppConnectionStatus[] }>(`${appPath(app.workFolderId, app.manifest.id)}/connections?${query}`)).connections;
}

export async function setRestrictedAppNetworkGrant(
  app: RestrictedAppInstalled,
  destinationId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.workFolderId, app.manifest.id)}/permissions/network/${encodeURIComponent(destinationId)}`, {
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
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.workFolderId, app.manifest.id)}/permissions/files/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, ...(granted ? { root } : {}) },
  })).app;
}

export async function listRestrictedAppAssistantTasks(app: RestrictedAppInstalled) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ tasks: import("../../../src/shared/restricted-app-tasks").RestrictedAppAssistantTask[] }>(`${appPath(app.workFolderId, app.manifest.id)}/assistant-tasks?${query}`)).tasks;
}

export async function readRestrictedAppAssistantTask(app: RestrictedAppInstalled, requestId: string) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ detail: import("../../../src/shared/restricted-app-tasks").RestrictedAppTaskDetail }>(`${appPath(app.workFolderId, app.manifest.id)}/assistant-tasks/${encodeURIComponent(requestId)}?${query}`)).detail;
}

export async function cancelRestrictedAppAssistantTask(app: RestrictedAppInstalled, requestId: string) {
  return (await api<{ task: import("../../../src/shared/restricted-app-tasks").RestrictedAppAssistantTask }>(`${appPath(app.workFolderId, app.manifest.id)}/assistant-tasks/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST", body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).task;
}

/**
 * Bounded inference receipts for this installation, across code changes
 * (docs/receipts-not-gates.md, F22: disclosure is after the fact). Every
 * `assistant.infer` call leaves one, with the effective model and its usage.
 */
export async function listRestrictedAppInferenceReceipts(app: RestrictedAppInstalled) {
  const query = new URLSearchParams({ featureInstallationId: app.featureInstallationId, expectedDigest: app.digest });
  return (await api<{ receipts: import("../../../src/shared/restricted-app-inference").RestrictedAppInferenceReceipt[] }>(
    `${appPath(app.workFolderId, app.manifest.id)}/inference-receipts?${query}`,
  )).receipts;
}

export async function setRestrictedAppCheckGrant(app: RestrictedAppInstalled, permissionId: string, selection: { checkId: string; declarationDigest: string } | null): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.workFolderId, app.manifest.id)}/permissions/checks/${encodeURIComponent(permissionId)}`, {
    method: selection ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, ...selection },
  })).app;
}

export async function setRestrictedAppNotificationGrant(
  app: RestrictedAppInstalled,
  permissionId: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.workFolderId, app.manifest.id)}/permissions/notifications/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function setRestrictedAppAutomationEnabled(
  app: RestrictedAppInstalled,
  appAutomationId: string,
  enabled: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(app.workFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}`, {
    method: enabled ? "PUT" : "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).app;
}

export async function runRestrictedAppAutomationNow(
  app: RestrictedAppInstalled,
  appAutomationId: string,
): Promise<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }> {
  return api<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }>(`${appPath(app.workFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}/run`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  });
}

export async function listRestrictedAppAutomationRuns(
  app: RestrictedAppInstalled,
  appAutomationId: string,
): Promise<RestrictedAppAutomationRunReceipt[]> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ runs: RestrictedAppAutomationRunReceipt[] }>(`${appPath(app.workFolderId, app.manifest.id)}/automations/${encodeURIComponent(appAutomationId)}/runs?${query}`)).runs;
}

export async function getRestrictedAppStorageUsage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.workFolderId, app.manifest.id)}/storage?${query}`)).usage;
}

export async function clearRestrictedAppStorage(app: RestrictedAppInstalled): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.workFolderId, app.manifest.id)}/storage`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).usage;
}

export async function exportRestrictedAppData(app: RestrictedAppInstalled): Promise<unknown> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ backup: unknown }>(`${appPath(app.workFolderId, app.manifest.id)}/storage/export?${query}`)).backup;
}

export async function exportRetainedAppData(sourceWorkFolderId: string, retainedDataId: string): Promise<unknown> {
  return (await api<{ backup: unknown }>(`${studioPath(sourceWorkFolderId)}/retained-data/${encodeURIComponent(retainedDataId)}`)).backup;
}

export async function getRestrictedAppDataRecovery(app: RestrictedAppInstalled): Promise<RestrictedAppDataRecovery | null> {
  const query = new URLSearchParams({ expectedDigest: app.digest, featureInstallationId: app.featureInstallationId });
  return (await api<{ recovery: RestrictedAppDataRecovery | null }>(`${appPath(app.workFolderId, app.manifest.id)}/storage/recovery?${query}`)).recovery;
}

export async function restoreRestrictedAppData(app: RestrictedAppInstalled, expectedRevision: number, source: { backup: unknown } | { recoveryId: string }): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(app.workFolderId, app.manifest.id)}/storage/restore`, {
    method: "POST", body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, expectedRevision, ...source },
  })).usage;
}

export async function setRestrictedAppConnection(
  app: RestrictedAppInstalled,
  destinationId: string,
  credential: RestrictedAppCredential,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.workFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "PUT",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest, credential },
  })).connection;
}

export async function connectRestrictedAppOAuth(
  app: RestrictedAppInstalled,
  destinationId: string,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(app.workFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}/oauth`, {
    method: "POST",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).connection;
}

export async function deleteRestrictedAppConnection(app: RestrictedAppInstalled, destinationId: string): Promise<boolean> {
  return (await api<{ removed: boolean }>(`${appPath(app.workFolderId, app.manifest.id)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "DELETE",
    body: { featureInstallationId: app.featureInstallationId, expectedDigest: app.digest },
  })).removed;
}
