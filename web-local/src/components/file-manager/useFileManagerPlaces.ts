import { useCallback, useEffect, useState } from "react";

import { api } from "../../lib/api";
import type { TreeEntry } from "../../types";
import type { StandardFolderSummary } from "./file-manager-places";
import { buildFixtureStandardFolders } from "./file-manager-fixture";

/** Desktop, Documents, and Downloads as the host found them. */
export function useStandardFolders(fixtureMode: boolean) {
  const [fixture] = useState(() => fixtureMode ? buildFixtureStandardFolders() : null);
  const [folders, setFolders] = useState<StandardFolderSummary[]>(() => fixture?.folders ?? []);
  const refresh = useCallback(async () => {
    if (fixture) return;
    try {
      setFolders((await api<{ folders: StandardFolderSummary[] }>("/api/standard-folders")).folders);
    } catch {
      // An older local API has no standard folders; the sidebar simply omits them.
      setFolders([]);
    }
  }, [fixture]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { folders, fixtureTrees: fixture?.trees ?? null, refresh } as {
    folders: StandardFolderSummary[];
    fixtureTrees: Record<string, TreeEntry[]> | null;
    refresh: () => Promise<void>;
  };
}
