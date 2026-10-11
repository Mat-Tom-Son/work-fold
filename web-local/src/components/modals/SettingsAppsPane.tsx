import { useEffect, useRef } from "react";

import type { useRestrictedApps } from "../../hooks/useRestrictedApps";
import { RestrictedAppsSection } from "../panes/RestrictedAppsSection";
import { showToast } from "../../ui/feedback";
import type { RestrictedAppInstalled, WorkFolderSummary } from "../../types";

export type RestrictedAppsState = ReturnType<typeof useRestrictedApps>;

/**
 * Settings → Apps (2026-09-25): every installed app, listed by the work-folder it
 * belongs to, with the grants, connections, automations, data, update and
 * removal controls the retired work-folder-owned Apps tab used to hold. Opening
 * an app itself still happens from its rail entry.
 */
export function SettingsAppsPane({ workFolders, apps, fixtureMode = false, onChangeApp, onOpenBuildChat, onOpenResultFile, onOpenAppStudio }: {
  workFolders: WorkFolderSummary[];
  apps: RestrictedAppsState | null;
  fixtureMode?: boolean;
  onChangeApp?: (app: RestrictedAppInstalled) => void;
  onOpenBuildChat?: (workFolderId: string, conversationId: string) => void;
  onOpenResultFile?: (workFolderId: string, path: string) => void;
  onOpenAppStudio?: (workFolderId: string, runtimeInstanceId?: string) => void;
}) {
  const knownWorkFolderIds = apps?.knownWorkFolderIds;
  const loadingWorkFolderIds = apps?.loadingWorkFolderIds;
  const refresh = apps?.refresh;
  const attemptedWorkFolderIds = useRef(new Set<string>());
  useEffect(() => {
    if (!refresh || !knownWorkFolderIds || !loadingWorkFolderIds) return;
    const registered = new Set(workFolders.map((workFolder) => workFolder.id));
    for (const id of attemptedWorkFolderIds.current) if (!registered.has(id) || knownWorkFolderIds.has(id)) attemptedWorkFolderIds.current.delete(id);
    for (const workFolder of workFolders) {
      if (knownWorkFolderIds.has(workFolder.id) || attemptedWorkFolderIds.current.has(workFolder.id)) continue;
      // A failed read clears loading without making the catalog known. Record
      // the attempt (including a shared in-flight read) so that transition
      // exposes Retry instead of starting an unbounded request loop.
      attemptedWorkFolderIds.current.add(workFolder.id);
      if (!loadingWorkFolderIds.has(workFolder.id)) void refresh(workFolder.id);
    }
  }, [knownWorkFolderIds, loadingWorkFolderIds, refresh, workFolders]);

  const foldersWithApps = workFolders.filter((workFolder) => (apps?.appsByWorkFolder[workFolder.id] ?? []).length > 0);
  const loading = workFolders.some((workFolder) => loadingWorkFolderIds?.has(workFolder.id));
  const failedWorkFolders = workFolders.filter((workFolder) => attemptedWorkFolderIds.current.has(workFolder.id)
    && !knownWorkFolderIds?.has(workFolder.id) && !loadingWorkFolderIds?.has(workFolder.id));
  const report = (message: string | null) => { if (message) showToast({ text: message, tone: "error" }); };
  return (
    <section className="settings-section settings-apps" aria-labelledby="settings-apps-title">
      <div className="settings-section-heading"><h3 id="settings-apps-title">Apps</h3></div>
      {!foldersWithApps.length && !failedWorkFolders.length ? (
        <p className="settings-section-note">{loading ? "Loading apps…" : "No apps yet. To make one, open a chat in the work-folder it is for and describe what the app should do. The Worker builds it, and it shows up here."}</p>
      ) : null}
      {failedWorkFolders.length ? <p className="settings-section-note" role="status">
        Could not load apps in {failedWorkFolders.map((workFolder) => workFolder.name).join(", ")}.{" "}
        <button className="ui-control" type="button" onClick={() => {
          for (const workFolder of failedWorkFolders) void refresh?.(workFolder.id);
        }}>Retry Loading Apps</button>
      </p> : null}
      {foldersWithApps.map((workFolder) => (
        <section className="settings-apps-folder" aria-label={`Apps in ${workFolder.name}`} key={workFolder.id}>
          <h4 className="settings-apps-folder-title">{workFolder.name}</h4>
          <RestrictedAppsSection
            workFolder={workFolder}
            apps={apps?.appsByWorkFolder[workFolder.id] ?? []}
            loading={Boolean(loadingWorkFolderIds?.has(workFolder.id))}
            fixtureMode={fixtureMode}
            presentation="page"
            onChangeApp={onChangeApp ? async (app) => onChangeApp(app) : undefined}
            onOpenBuildChat={onOpenBuildChat ? async (workFolderId, conversationId) => onOpenBuildChat(workFolderId, conversationId) : undefined}
            onOpenResultFile={onOpenResultFile ? async (workFolderId, path) => onOpenResultFile(workFolderId, path) : undefined}
            onOpenAppStudio={(workFolderId, runtimeInstanceId) => onOpenAppStudio?.(workFolderId ?? workFolder.id, runtimeInstanceId)}
            onUpsertApp={(app) => apps?.upsertApp(app)}
            onRemoveApp={(featureInstallationId) => apps?.removeApp(workFolder.id, featureInstallationId)}
            onError={report}
          />
        </section>
      ))}
    </section>
  );
}
