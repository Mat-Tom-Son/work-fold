import { useCallback, useEffect, useRef, useState } from "react";

import { listRestrictedApps } from "../lib/restricted-apps";
import { subscribeControlEvents } from "../lib/control-events";
import type { RestrictedAppInstalled, SpaceSummary } from "../types";

const emptyRestrictedAppFixtures: Record<string, RestrictedAppInstalled[]> = {};

export function useRestrictedApps({
  activeSpaceId,
  spaces,
  fixtureMode = false,
  fixtureApps = emptyRestrictedAppFixtures,
  onError,
}: {
  activeSpaceId: string;
  spaces?: readonly Pick<SpaceSummary, "id">[];
  fixtureMode?: boolean;
  fixtureApps?: Record<string, RestrictedAppInstalled[]>;
  onError: (error: unknown) => void;
}) {
  const [appsBySpace, setAppsBySpace] = useState<Record<string, RestrictedAppInstalled[]>>(fixtureApps);
  const [knownSpaceIds, setKnownSpaceIds] = useState<Set<string>>(() => new Set(Object.keys(fixtureApps)));
  const [loadingSpaceIds, setLoadingSpaceIds] = useState<Set<string>>(() => new Set());
  const requestVersionsRef = useRef(new Map<string, number>());
  const nextRequestRef = useRef(0);
  const registeredIdsRef = useRef<Set<string> | null>(null);
  registeredIdsRef.current = spaces ? new Set(spaces.map((space) => space.id)) : null;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestVersionsRef.current.clear(); };
  }, []);

  const refresh = useCallback(async (spaceId: string) => {
    if (!spaceId || !mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(spaceId))) return;
    if (fixtureMode) {
      setAppsBySpace((current) => ({ ...current, [spaceId]: fixtureApps[spaceId] ?? current[spaceId] ?? [] }));
      setKnownSpaceIds((current) => new Set(current).add(spaceId));
      return;
    }
    const requestVersion = ++nextRequestRef.current;
    requestVersionsRef.current.set(spaceId, requestVersion);
    setLoadingSpaceIds((current) => new Set(current).add(spaceId));
    try {
      const apps = await listRestrictedApps(spaceId);
      if (!mountedRef.current || (registeredIdsRef.current && !registeredIdsRef.current.has(spaceId)) || requestVersionsRef.current.get(spaceId) !== requestVersion) return;
      setAppsBySpace((current) => ({ ...current, [spaceId]: apps }));
      setKnownSpaceIds((current) => new Set(current).add(spaceId));
    } catch (caught) {
      if (mountedRef.current && (!registeredIdsRef.current || registeredIdsRef.current.has(spaceId)) && requestVersionsRef.current.get(spaceId) === requestVersion) onError(caught);
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
    const registered = registeredIdsRef.current;
    if (registered) {
      for (const id of requestVersionsRef.current.keys()) if (!registered.has(id)) requestVersionsRef.current.delete(id);
      setAppsBySpace((current) => Object.fromEntries(Object.entries(current).filter(([id]) => registered.has(id))));
      setKnownSpaceIds((current) => new Set([...current].filter((id) => registered.has(id))));
      setLoadingSpaceIds((current) => new Set([...current].filter((id) => registered.has(id))));
    }
    for (const id of new Set([...requestVersionsRef.current.keys(), activeSpaceId])) void refresh(id);
  }, [activeSpaceId, spaces, fixtureApps, fixtureMode, refresh]);

  useEffect(() => {
    if (fixtureMode) return;
    return subscribeControlEvents((hint) => {
      if (hint === "spaces" || hint === "reset") {
        // App re-reads the registry first. Invalidate pending old reads now;
        // its new spaces prop will refresh only the surviving registrations.
        for (const [id, version] of requestVersionsRef.current) requestVersionsRef.current.set(id, version + 1);
        return;
      }
      if (hint !== "apps") return;
      const ids = new Set([...requestVersionsRef.current.keys(), activeSpaceId]);
      for (const id of ids) void refresh(id);
    });
  }, [activeSpaceId, fixtureMode, refresh]);

  const replaceApps = useCallback((spaceId: string, apps: RestrictedAppInstalled[]) => {
    setAppsBySpace((current) => ({ ...current, [spaceId]: apps }));
    setKnownSpaceIds((current) => new Set(current).add(spaceId));
  }, []);

  const upsertApp = useCallback((app: RestrictedAppInstalled) => {
    setAppsBySpace((current) => {
      const existing = current[app.spaceId] ?? [];
      const next = existing.some((item) => item.featureInstallationId === app.featureInstallationId)
        ? existing.map((item) => item.featureInstallationId === app.featureInstallationId ? app : item)
        : [...existing, app];
      return { ...current, [app.spaceId]: next };
    });
    setKnownSpaceIds((current) => new Set(current).add(app.spaceId));
  }, []);

  const removeApp = useCallback((spaceId: string, featureInstallationId: string) => {
    setAppsBySpace((current) => ({
      ...current,
      [spaceId]: (current[spaceId] ?? []).filter((item) => item.featureInstallationId !== featureInstallationId),
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
