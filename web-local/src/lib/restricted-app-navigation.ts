import {
  restrictedAppOpenedFrom,
  restrictedAppRoute,
  restrictedAppState,
  type RestrictedAppOpenedFrom,
} from "../../../src/shared/restricted-app-navigation";
import type { RestrictedAppInstalled, WorkFolderRailMode, WorkFolderSummary } from "../types";

export interface RestrictedAppOpenRequest {
  workFolderId: string;
  appId: string;
  digest: string;
  featureInstallationId: string;
  permissionId: string;
  /** Where the app asked a click on this notification to open its left-pane view. */
  route?: string;
  state?: unknown;
}

/**
 * Where a notification click opens an app's left-pane view. The rail button
 * always opens the app at "/" with no state; a notification click opens the
 * same view, never a tab, at the route and state the app named.
 */
export interface RestrictedAppNavigatorTarget {
  mode: WorkFolderRailMode;
  route: string;
  state?: unknown;
  openedFrom: RestrictedAppOpenedFrom;
}

export function restrictedAppRailMode(workFolderId: string, appId: string, featureInstallationId: string): WorkFolderRailMode {
  return `app:restricted:${workFolderId}:${appId}:${featureInstallationId}`;
}

export function resolveRestrictedAppOpenRequest(
  request: RestrictedAppOpenRequest,
  workFolders: readonly WorkFolderSummary[],
): { workFolder: WorkFolderSummary; mode: WorkFolderRailMode; target: RestrictedAppNavigatorTarget } | null {
  if (!request.workFolderId || !request.appId || !request.digest || !request.featureInstallationId || !request.permissionId) return null;
  const workFolder = workFolders.find((item) => item.id === request.workFolderId);
  if (!workFolder) return null;
  let openedFrom: RestrictedAppOpenedFrom | null;
  try {
    openedFrom = restrictedAppOpenedFrom({ kind: "notification", permissionId: request.permissionId });
  } catch {
    return null;
  }
  if (!openedFrom) return null;
  const mode = restrictedAppRailMode(workFolder.id, request.appId, request.featureInstallationId);
  let route = "/";
  let state: unknown;
  try {
    route = request.route === undefined ? "/" : restrictedAppRoute(request.route);
    state = request.state === undefined ? undefined : restrictedAppState(request.state);
  } catch {
    // The host checked these already; a destination that no longer parses
    // still opens the app, at its home.
    route = "/";
    state = undefined;
  }
  return { workFolder, mode, target: { mode, route, ...(state !== undefined ? { state } : {}), openedFrom } };
}

/** Only disambiguate a preview when its installed sibling is also in this rail. */
export function restrictedAppRailLabel(app: RestrictedAppInstalled, apps: readonly RestrictedAppInstalled[]): string {
  return app.runtimeInstanceKind === "development" && apps.some((peer) => peer.manifest.id === app.manifest.id && peer.featureInstallationId !== app.featureInstallationId)
    ? `${app.manifest.title} · Preview` : app.manifest.title;
}
