import { useEffect, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { refreshSharedPages, sharedPagesSnapshot, subscribeSharedPages, type SharedPageView, type SharedPagesResponse } from "../lib/page-sharing";
import { buildFixturePublications } from "../fixtures/space-fixture";

const fixturePublications = buildFixturePublications();

export function reloadSharedPages(options: { afterMutation?: boolean } = {}): Promise<void> {
  return refreshSharedPages(() => api<SharedPagesResponse>("/api/settings/publications"), options);
}

/**
 * The shared-pages list for the file tab's Share button and the Files
 * context menu. It reads the same Settings route as Shared pages and
 * refreshes when a surface that shows it mounts or the person returns to
 * the window, so Worker and CLI changes appear too. The preview uses the
 * fixture's sample pages instead.
 */
export function useSharedPages(fixtureMode: boolean): SharedPageView[] | null {
  const live = useSyncExternalStore(subscribeSharedPages, sharedPagesSnapshot, () => null);
  useEffect(() => {
    if (fixtureMode) return;
    void reloadSharedPages();
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void reloadSharedPages({ afterMutation: true });
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [fixtureMode]);
  return fixtureMode ? fixturePublications : live;
}
