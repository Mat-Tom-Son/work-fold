import { useCallback, useEffect, useRef, useState } from "react";

import { listRestrictedApps } from "../lib/restricted-apps";
import { subscribeControlEvents } from "../lib/control-events";
import type { RestrictedAppInstalled, WorkFolderSummary } from "../types";

const emptyRestrictedAppFixtures: Record<string, RestrictedAppInstalled[]> = {};

export function useRestrictedApps({
  activeWorkFolderId,
  workFolders,
  fixtureMode = false,
  fixtureApps = emptyRestrictedAppFixtures,
  onError,
}: {
  activeWorkFolderId: string;
  workFolders?: readonly Pick<WorkFolderSummary, "id">[];
  fixtureMode?: boolean;
  fixtureApps?: Record<string, RestrictedAppInstalled[]>;
  onError: (error: unknown) => void;
}) {
  const [appsByWorkFolder, setAppsByWorkFolder] = useState<Record<string, RestrictedAppInstalled[]>>(fixtureApps);
  const [knownWorkFolderIds, setKnownWorkFolderIds] = useState<Set<string>>(() => new Set(Object.keys(fixtureApps)));
  const [loadingWorkFolderIds, setLoadingWorkFolderIds] = useState<Set<string>>(() => new Set());
  const requestVersionsRef = useRef(new Map<string, number>());
  const nextRequestRef = useRef(0);
  const registeredIdsRef = useRef<Set<string> | null>(null);
  registeredIdsRef.current = workFolders ? new Set(workFolders.map((workFolder) => workFolder.id)) : null;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestVersionsRef.current.clear(); };
  }, []);

  const refresh = useCallback(async (workFolderId: string) => {
    if (!workFolderId || !mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(workFolderId))) return;
    if (fixtureMode) {
      setAppsByWorkFolder((current) => ({ ...current, [workFolderId]: fixtureApps[workFolderId] ?? current[workFolderId] ?? [] }));
      setKnownWorkFolderIds((current) => new Set(current).add(workFolderId));
      return;
    }
    const requestVersion = ++nextRequestRef.current;
    requestVersionsRef.current.set(workFolderId, requestVersion);
    setLoadingWorkFolderIds((current) => new Set(current).add(workFolderId));
    try {
      const apps = await listRestrictedApps(workFolderId);
      if (!mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(workFolderId)) || requestVersionsRef.current.get(workFolderId) !== requestVersion) return;
      setAppsByWorkFolder((current) => ({ ...current, [workFolderId]: apps }));
      setKnownWorkFolderIds((current) => new Set(current).add(workFolderId));
    } catch (caught) {
      if (mountedRef.current && (!registeredIdsRef.current || registeredIdsRef.current.has(workFolderId)) && requestVersionsRef.current.get(workFolderId) === requestVersion) onError(caught);
    } finally {
      if (requestVersionsRef.current.get(workFolderId) === requestVersion) {
        setLoadingWorkFolderIds((current) => {
          const next = new Set(current);
          next.delete(workFolderId);
          return next;
        });
      }
    }
  }, [fixtureApps, fixtureMode, onError]);

  useEffect(() => {
    if (fixtureMode) {
      setAppsByWorkFolder({ ...fixtureApps, [activeWorkFolderId]: fixtureApps[activeWorkFolderId] ?? [] });
      setKnownWorkFolderIds(new Set([...Object.keys(fixtureApps), activeWorkFolderId]));
      return;
    }
    const registered = registeredIdsRef.current;
    if (registered) {
      for (const id of requestVersionsRef.current.keys()) if (!registered.has(id)) requestVersionsRef.current.delete(id);
      setAppsByWorkFolder((current) => Object.fromEntries(Object.entries(current).filter(([id]) => registered.has(id))));
      setKnownWorkFolderIds((current) => new Set([...current].filter((id) => registered.has(id))));
      setLoadingWorkFolderIds((current) => new Set([...current].filter((id) => registered.has(id))));
    }
    for (const id of new Set([...requestVersionsRef.current.keys(), activeWorkFolderId])) void refresh(id);
  }, [activeWorkFolderId, workFolders, fixtureApps, fixtureMode, refresh]);

  useEffect(() => {
    if (fixtureMode) return;
    return subscribeControlEvents((hint) => {
      if (hint === "work-folders" || hint === "reset") {
        // App re-reads the registry first. Invalidate pending old reads now;
        // its new work-folders prop will refresh only the surviving registrations.
        for (const [id, version] of requestVersionsRef.current) requestVersionsRef.current.set(id, version + 1);
        return;
      }
      if (hint !== "apps") return;
      const ids = new Set([...requestVersionsRef.current.keys(), activeWorkFolderId]);
      for (const id of ids) void refresh(id);
    });
  }, [activeWorkFolderId, fixtureMode, refresh]);

  const replaceApps = useCallback((workFolderId: string, apps: RestrictedAppInstalled[]) => {
    setAppsByWorkFolder((current) => ({ ...current, [workFolderId]: apps }));
    setKnownWorkFolderIds((current) => new Set(current).add(workFolderId));
  }, []);

  const upsertApp = useCallback((app: RestrictedAppInstalled) => {
    setAppsByWorkFolder((current) => {
      const existing = current[app.workFolderId] ?? [];
      const next = existing.some((item) => item.featureInstallationId === app.featureInstallationId)
        ? existing.map((item) => item.featureInstallationId === app.featureInstallationId ? app : item)
        : [...existing, app];
      return { ...current, [app.workFolderId]: next };
    });
    setKnownWorkFolderIds((current) => new Set(current).add(app.workFolderId));
  }, []);

  const removeApp = useCallback((workFolderId: string, featureInstallationId: string) => {
    setAppsByWorkFolder((current) => ({
      ...current,
      [workFolderId]: (current[workFolderId] ?? []).filter((item) => item.featureInstallationId !== featureInstallationId),
    }));
    setKnownWorkFolderIds((current) => new Set(current).add(workFolderId));
  }, []);

  const replaceRuntimeInstanceApps = useCallback((
    workFolderId: string,
    runtimeInstanceId: string,
    apps: RestrictedAppInstalled[],
  ) => {
    setAppsByWorkFolder((current) => {
      const preserved = (current[workFolderId] ?? []).filter((item) => item.runtimeInstanceId !== runtimeInstanceId);
      const replacements = apps.filter((item) => (
        item.workFolderId === workFolderId && item.runtimeInstanceId === runtimeInstanceId
      ));
      const next = [...preserved, ...replacements].sort((left, right) => (
        left.manifest.title.localeCompare(right.manifest.title) || left.manifest.id.localeCompare(right.manifest.id)
      ));
      return { ...current, [workFolderId]: next };
    });
    setKnownWorkFolderIds((current) => new Set(current).add(workFolderId));
  }, []);

  return {
    appsByWorkFolder,
    knownWorkFolderIds,
    loadingWorkFolderIds,
    refresh,
    replaceApps,
    replaceRuntimeInstanceApps,
    upsertApp,
    removeApp,
  };
}
