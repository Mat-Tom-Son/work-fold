import type { RestrictedAppInstalled, SpaceRailMode, SpaceSummary } from "../types";

export interface RestrictedAppOpenRequest {
  spaceId: string;
  appId: string;
  digest: string;
  featureInstallationId: string;
  permissionId: string;
}

export function restrictedAppRailMode(spaceId: string, appId: string, featureInstallationId: string): SpaceRailMode {
  return `app:restricted:${spaceId}:${appId}:${featureInstallationId}`;
}

export function resolveRestrictedAppOpenRequest(
  request: RestrictedAppOpenRequest,
  spaces: readonly SpaceSummary[],
): { space: SpaceSummary; mode: SpaceRailMode } | null {
  if (!request.spaceId || !request.appId || !request.digest || !request.featureInstallationId || !request.permissionId) return null;
  const space = spaces.find((item) => item.id === request.spaceId);
  return space ? { space, mode: restrictedAppRailMode(space.id, request.appId, request.featureInstallationId) } : null;
}

/** Only disambiguate a preview when its installed sibling is also in this rail. */
export function restrictedAppRailLabel(app: RestrictedAppInstalled, apps: readonly RestrictedAppInstalled[]): string {
  return app.runtimeInstanceKind === "development" && apps.some((peer) => peer.manifest.id === app.manifest.id && peer.featureInstallationId !== app.featureInstallationId)
    ? `${app.manifest.title} · Preview` : app.manifest.title;
}
