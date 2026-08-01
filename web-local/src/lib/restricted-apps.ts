import { api } from "./api";
import type {
  RestrictedAppAutomationRunReceipt,
  RestrictedAppConnectionStatus,
  RestrictedAppCredential,
  RestrictedAppInstalled,
  RestrictedAppProposal,
  RestrictedAppReview,
  RestrictedAppStorageUsage,
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

export async function removeRestrictedApp(spaceId: string, appId: string, expectedDigest: string): Promise<boolean> {
  return (await api<{ removed: boolean }>(appPath(spaceId, appId), {
    method: "DELETE",
    body: { expectedDigest },
  })).removed;
}

export async function listRestrictedAppConnections(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppConnectionStatus[]> {
  const query = new URLSearchParams({ expectedDigest });
  return (await api<{ connections: RestrictedAppConnectionStatus[] }>(`${appPath(spaceId, appId)}/connections?${query}`)).connections;
}

export async function setRestrictedAppNetworkGrant(
  spaceId: string,
  appId: string,
  destinationId: string,
  expectedDigest: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(spaceId, appId)}/permissions/network/${encodeURIComponent(destinationId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { expectedDigest },
  })).app;
}

export async function setRestrictedAppFileGrant(
  spaceId: string,
  appId: string,
  permissionId: string,
  expectedDigest: string,
  granted: boolean,
  root?: string,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(spaceId, appId)}/permissions/files/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { expectedDigest, ...(granted ? { root } : {}) },
  })).app;
}

export async function setRestrictedAppNotificationGrant(
  spaceId: string,
  appId: string,
  permissionId: string,
  expectedDigest: string,
  granted: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(spaceId, appId)}/permissions/notifications/${encodeURIComponent(permissionId)}`, {
    method: granted ? "PUT" : "DELETE",
    body: { expectedDigest },
  })).app;
}

export async function setRestrictedAppAutomationEnabled(
  spaceId: string,
  appId: string,
  automationId: string,
  expectedDigest: string,
  enabled: boolean,
): Promise<RestrictedAppInstalled> {
  return (await api<{ app: RestrictedAppInstalled }>(`${appPath(spaceId, appId)}/automations/${encodeURIComponent(automationId)}`, {
    method: enabled ? "PUT" : "DELETE",
    body: { expectedDigest },
  })).app;
}

export async function runRestrictedAppAutomationNow(
  spaceId: string,
  appId: string,
  automationId: string,
  expectedDigest: string,
): Promise<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }> {
  return api<{ app: RestrictedAppInstalled; run: RestrictedAppAutomationRunReceipt }>(`${appPath(spaceId, appId)}/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    body: { expectedDigest },
  });
}

export async function listRestrictedAppAutomationRuns(
  spaceId: string,
  appId: string,
  automationId: string,
  expectedDigest: string,
): Promise<RestrictedAppAutomationRunReceipt[]> {
  const query = new URLSearchParams({ expectedDigest });
  return (await api<{ runs: RestrictedAppAutomationRunReceipt[] }>(`${appPath(spaceId, appId)}/automations/${encodeURIComponent(automationId)}/runs?${query}`)).runs;
}

export async function getRestrictedAppStorageUsage(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppStorageUsage> {
  const query = new URLSearchParams({ expectedDigest });
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(spaceId, appId)}/storage?${query}`)).usage;
}

export async function clearRestrictedAppStorage(spaceId: string, appId: string, expectedDigest: string): Promise<RestrictedAppStorageUsage> {
  return (await api<{ usage: RestrictedAppStorageUsage }>(`${appPath(spaceId, appId)}/storage`, {
    method: "DELETE",
    body: { expectedDigest },
  })).usage;
}

export async function setRestrictedAppConnection(
  spaceId: string,
  appId: string,
  destinationId: string,
  expectedDigest: string,
  credential: RestrictedAppCredential,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(spaceId, appId)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "PUT",
    body: { expectedDigest, credential },
  })).connection;
}

export async function connectRestrictedAppOAuth(
  spaceId: string,
  appId: string,
  destinationId: string,
  expectedDigest: string,
): Promise<RestrictedAppConnectionStatus> {
  return (await api<{ connection: RestrictedAppConnectionStatus }>(`${appPath(spaceId, appId)}/connections/${encodeURIComponent(destinationId)}/oauth`, {
    method: "POST",
    body: { expectedDigest },
  })).connection;
}

export async function deleteRestrictedAppConnection(spaceId: string, appId: string, destinationId: string, expectedDigest: string): Promise<boolean> {
  return (await api<{ removed: boolean }>(`${appPath(spaceId, appId)}/connections/${encodeURIComponent(destinationId)}`, {
    method: "DELETE",
    body: { expectedDigest },
  })).removed;
}
