import { useCallback, useEffect, useRef, useState } from "react";

import { listRestrictedApps } from "../lib/restricted-apps";
import type { RestrictedAppInstalled } from "../types";

const emptyRestrictedAppFixtures: Record<string, RestrictedAppInstalled[]> = {};

export function useRestrictedApps({
  activeSpaceId,
  fixtureMode = false,
  fixtureApps = emptyRestrictedAppFixtures,
  onError,
}: {
  activeSpaceId: string;
  fixtureMode?: boolean;
  fixtureApps?: Record<string, RestrictedAppInstalled[]>;
  onError: (error: unknown) => void;
}) {
  const [appsBySpace, setAppsBySpace] = useState<Record<string, RestrictedAppInstalled[]>>(fixtureApps);
  const [knownSpaceIds, setKnownSpaceIds] = useState<Set<string>>(() => new Set(Object.keys(fixtureApps)));
  const [loadingSpaceIds, setLoadingSpaceIds] = useState<Set<string>>(() => new Set());
  const requestVersionsRef = useRef(new Map<string, number>());

  const refresh = useCallback(async (spaceId: string) => {
    if (!spaceId) return;
    if (fixtureMode) {
      setAppsBySpace((current) => ({ ...current, [spaceId]: fixtureApps[spaceId] ?? current[spaceId] ?? [] }));
      setKnownSpaceIds((current) => new Set(current).add(spaceId));
      return;
    }
    const requestVersion = (requestVersionsRef.current.get(spaceId) ?? 0) + 1;
    requestVersionsRef.current.set(spaceId, requestVersion);
    setLoadingSpaceIds((current) => new Set(current).add(spaceId));
    try {
      const apps = await listRestrictedApps(spaceId);
      if (requestVersionsRef.current.get(spaceId) !== requestVersion) return;
      setAppsBySpace((current) => ({ ...current, [spaceId]: apps }));
      setKnownSpaceIds((current) => new Set(current).add(spaceId));
    } catch (caught) {
      if (requestVersionsRef.current.get(spaceId) === requestVersion) onError(caught);
    } finally {
      if (requestVersionsRef.current.get(spaceId) === requestVersion) {
        setLoadingSpaceIds((current) => {
          const next = new Set(current);
          next.delete(spaceId);
          return next;
        });
      }
    }
  }, [fixtureApps, fixtureMode, onError]);

  useEffect(() => {
    if (fixtureMode) {
      setAppsBySpace({ ...fixtureApps, [activeSpaceId]: fixtureApps[activeSpaceId] ?? [] });
      setKnownSpaceIds(new Set([...Object.keys(fixtureApps), activeSpaceId]));
      return;
    }
    void refresh(activeSpaceId);
  }, [activeSpaceId, fixtureApps, fixtureMode, refresh]);

  const replaceApps = useCallback((spaceId: string, apps: RestrictedAppInstalled[]) => {
    setAppsBySpace((current) => ({ ...current, [spaceId]: apps }));
    setKnownSpaceIds((current) => new Set(current).add(spaceId));
  }, []);

  const upsertApp = useCallback((app: RestrictedAppInstalled) => {
    setAppsBySpace((current) => {
      const existing = current[app.spaceId] ?? [];
      const next = existing.some((item) => item.manifest.id === app.manifest.id)
        ? existing.map((item) => item.manifest.id === app.manifest.id ? app : item)
        : [...existing, app];
      return { ...current, [app.spaceId]: next };
    });
    setKnownSpaceIds((current) => new Set(current).add(app.spaceId));
  }, []);

  const removeApp = useCallback((spaceId: string, appId: string) => {
    setAppsBySpace((current) => ({
      ...current,
      [spaceId]: (current[spaceId] ?? []).filter((item) => item.manifest.id !== appId),
    }));
    setKnownSpaceIds((current) => new Set(current).add(spaceId));
  }, []);

  const replaceRuntimeInstanceApps = useCallback((
    spaceId: string,
    runtimeInstanceId: string,
    apps: RestrictedAppInstalled[],
  ) => {
    setAppsBySpace((current) => {
      const preserved = (current[spaceId] ?? []).filter((item) => item.runtimeInstanceId !== runtimeInstanceId);
      const replacements = apps.filter((item) => (
        item.spaceId === spaceId && item.runtimeInstanceId === runtimeInstanceId
      ));
      const next = [...preserved, ...replacements].sort((left, right) => (
        left.manifest.title.localeCompare(right.manifest.title) || left.manifest.id.localeCompare(right.manifest.id)
      ));
      return { ...current, [spaceId]: next };
    });
    setKnownSpaceIds((current) => new Set(current).add(spaceId));
  }, []);

  return {
    appsBySpace,
    knownSpaceIds,
    loadingSpaceIds,
    refresh,
    replaceApps,
    replaceRuntimeInstanceApps,
    upsertApp,
    removeApp,
  };
}
