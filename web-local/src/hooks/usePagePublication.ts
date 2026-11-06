import { useCallback, useEffect, useRef, useState } from "react";

import { subscribePagePublicationChanges, type PagePublication, type PagePublicationState, type PagesClient } from "../lib/pages";

/** How often an open page tab reads its publication again, for "last checked in". */
export const pagePublicationRefreshMs = 60_000;

export interface PagePublicationHandle {
  /** Null until first read, or while the local API can't say. */
  state: PagePublicationState | null;
  /** The first read finished, whatever it answered. */
  known: boolean;
  refresh: () => void;
  /** A publish, unpublish, or check-in answered the new publication; without one, it is read again. */
  apply: (publication: PagePublication | null) => void;
}

/**
 * Whether a page is online, and whether it can be published (docs/pages.md,
 * "Publishing (stage 2)"). Read when the tab is shown, again after the page's
 * files change (Publish Changes depends on them), and every minute while
 * shown, since work-fold checks in every minute.
 */
export function usePagePublication({
  client,
  workFolderId,
  path,
  enabled,
  revision,
}: {
  client: PagesClient;
  workFolderId: string;
  path: string;
  enabled: boolean;
  revision: number;
}): PagePublicationHandle {
  const [state, setState] = useState<{ key: string; value: PagePublicationState | null; known?: boolean }>({ key: "", value: null });
  const key = `${workFolderId}\n${path}`;
  const generationRef = useRef(0);
  const loadedRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    const generation = ++generationRef.current;
    void client.publication(workFolderId, path).then((value) => {
      if (generation === generationRef.current) setState({ key, value, known: true });
    }, () => {
      // An older local API, or a passing hiccup: keep what was last known,
      // and read again on the next change or minute.
      if (generation === generationRef.current) setState((current) => current.key === key ? { ...current, known: true } : { key, value: null, known: true });
    });
  }, [client, key, path, workFolderId]);

  useEffect(() => {
    if (!enabled) return;
    const loadKey = `${key}\n${revision}`;
    if (loadedRef.current !== loadKey) { loadedRef.current = loadKey; refresh(); }
    const timer = window.setInterval(refresh, pagePublicationRefreshMs);
    return () => window.clearInterval(timer);
  }, [enabled, key, refresh, revision]);

  // Settings → Published changed this page.
  useEffect(() => subscribePagePublicationChanges((change) => {
    if (change.workFolderId === workFolderId && change.page === path) refresh();
  }), [path, refresh, workFolderId]);

  const apply = useCallback((publication: PagePublication | null) => {
    if (!publication) { refresh(); return; }
    generationRef.current++;
    setState((current) => ({ key, value: { ...(current.key === key && current.value ? current.value : { available: true, unavailableReason: null }), publication }, known: true }));
  }, [key, refresh]);

  return { state: state.key === key ? state.value : null, known: state.key === key && state.known === true, refresh, apply };
}
