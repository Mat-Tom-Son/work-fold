import { useEffect, useRef } from "react";

import type { useRestrictedApps } from "../../hooks/useRestrictedApps";
import { RestrictedAppsSection } from "../panes/RestrictedAppsSection";
import { showToast } from "../../ui/feedback";
import type { RestrictedAppInstalled, SpaceSummary } from "../../types";

export type RestrictedAppsState = ReturnType<typeof useRestrictedApps>;

/**
 * Settings → Apps (2026-09-25): every installed app, listed by the Folder it
 * belongs to, with the grants, connections, automations, data, update and
 * removal controls the retired Folder-owned Apps tab used to hold. Opening
 * an app itself still happens from its rail entry.
 */
export function SettingsAppsPane({ spaces, apps, fixtureMode = false, onChangeApp, onOpenBuildChat, onOpenResultFile, onOpenAppStudio }: {
  spaces: SpaceSummary[];
  apps: RestrictedAppsState | null;
  fixtureMode?: boolean;
  onChangeApp?: (app: RestrictedAppInstalled) => void;
  onOpenBuildChat?: (spaceId: string, conversationId: string) => void;
  onOpenResultFile?: (spaceId: string, path: string) => void;
  onOpenAppStudio?: (spaceId: string, runtimeInstanceId?: string) => void;
}) {
  const knownSpaceIds = apps?.knownSpaceIds;
  const loadingSpaceIds = apps?.loadingSpaceIds;
  const refresh = apps?.refresh;
  const attemptedSpaceIds = useRef(new Set<string>());
  useEffect(() => {
    if (!refresh || !knownSpaceIds || !loadingSpaceIds) return;
    const registered = new Set(spaces.map((space) => space.id));
    for (const id of attemptedSpaceIds.current) if (!registered.has(id) || knownSpaceIds.has(id)) attemptedSpaceIds.current.delete(id);
    for (const space of spaces) {
      if (knownSpaceIds.has(space.id) || attemptedSpaceIds.current.has(space.id)) continue;
      // A failed read clears loading without making the catalog known. Record
      // the attempt (including a shared in-flight read) so that transition
      // exposes Retry instead of starting an unbounded request loop.
      attemptedSpaceIds.current.add(space.id);
      if (!loadingSpaceIds.has(space.id)) void refresh(space.id);
    }
  }, [knownSpaceIds, loadingSpaceIds, refresh, spaces]);

  const foldersWithApps = spaces.filter((space) => (apps?.appsBySpace[space.id] ?? []).length > 0);
  const loading = spaces.some((space) => loadingSpaceIds?.has(space.id));
  const failedSpaces = spaces.filter((space) => attemptedSpaceIds.current.has(space.id)
    && !knownSpaceIds?.has(space.id) && !loadingSpaceIds?.has(space.id));
  const report = (message: string | null) => { if (message) showToast({ text: message, tone: "error" }); };
  return (
    <section className="settings-section settings-apps" aria-labelledby="settings-apps-title">
      <div className="settings-section-heading"><h3 id="settings-apps-title">Apps</h3></div>
      {!foldersWithApps.length && !failedSpaces.length ? (
        <p className="settings-section-note">{loading ? "Loading apps…" : "No apps yet. To make one, open a chat in the folder it is for and describe what the app should do. The Worker builds it, and it shows up here."}</p>
      ) : null}
      {failedSpaces.length ? <p className="settings-section-note" role="status">
        Could not load apps in {failedSpaces.map((space) => space.name).join(", ")}.{" "}
        <button className="professional-button professional-button-secondary" type="button" onClick={() => {
          for (const space of failedSpaces) void refresh?.(space.id);
        }}>Retry Loading Apps</button>
      </p> : null}
      {foldersWithApps.map((space) => (
        <section className="settings-apps-folder" aria-label={`Apps in ${space.name}`} key={space.id}>
          <h4 className="settings-apps-folder-title">{space.name}</h4>
          <RestrictedAppsSection
            space={space}
            apps={apps?.appsBySpace[space.id] ?? []}
            loading={Boolean(loadingSpaceIds?.has(space.id))}
            fixtureMode={fixtureMode}
            presentation="page"
            onChangeApp={onChangeApp ? async (app) => onChangeApp(app) : undefined}
            onOpenBuildChat={onOpenBuildChat ? async (spaceId, conversationId) => onOpenBuildChat(spaceId, conversationId) : undefined}
            onOpenResultFile={onOpenResultFile ? async (spaceId, path) => onOpenResultFile(spaceId, path) : undefined}
            onOpenAppStudio={(spaceId, runtimeInstanceId) => onOpenAppStudio?.(spaceId ?? space.id, runtimeInstanceId)}
            onUpsertApp={(app) => apps?.upsertApp(app)}
            onRemoveApp={(featureInstallationId) => apps?.removeApp(space.id, featureInstallationId)}
            onError={report}
          />
        </section>
      ))}
    </section>
  );
}
