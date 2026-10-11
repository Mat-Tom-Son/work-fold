import type { RestrictedAppInstalled, WorkFolderRailMode, WorkFolderSummary } from "../types";

export interface RestrictedAppOpenRequest {
  workFolderId: string;
  appId: string;
  digest: string;
  featureInstallationId: string;
  permissionId: string;
}

export function restrictedAppRailMode(workFolderId: string, appId: string, featureInstallationId: string): WorkFolderRailMode {
  return `app:restricted:${workFolderId}:${appId}:${featureInstallationId}`;
}

export function resolveRestrictedAppOpenRequest(
  request: RestrictedAppOpenRequest,
  workFolders: readonly WorkFolderSummary[],
): { workFolder: WorkFolderSummary; mode: WorkFolderRailMode } | null {
  if (!request.workFolderId || !request.appId || !request.digest || !request.featureInstallationId || !request.permissionId) return null;
  const workFolder = workFolders.find((item) => item.id === request.workFolderId);
  return workFolder ? { workFolder, mode: restrictedAppRailMode(workFolder.id, request.appId, request.featureInstallationId) } : null;
}

/** Only disambiguate a preview when its installed sibling is also in this rail. */
export function restrictedAppRailLabel(app: RestrictedAppInstalled, apps: readonly RestrictedAppInstalled[]): string {
  return app.runtimeInstanceKind === "development" && apps.some((peer) => peer.manifest.id === app.manifest.id && peer.featureInstallationId !== app.featureInstallationId)
    ? `${app.manifest.title} · Preview` : app.manifest.title;
}
