import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { buildFixtureFolderAutomations } from "../fixtures/work-folder-fixture";
import type { FolderAutomationsResponse, FolderAutomationView } from "../../../src/shared/automation-presentation";

const automationsChanged = "work-fold:automations-changed";

/** Refresh work-folder views after an Automation action in this renderer. */
export function notifyFolderAutomationsChanged(): void {
  window.dispatchEvent(new Event(automationsChanged));
}

export function folderAutomationsPath(workFolderId: string): string {
  return `/api/work-folders/${encodeURIComponent(workFolderId)}/automations`;
}

/**
 * The automations whose trigger or steps name a work-folder, cached per work-folder
 * (docs/automations.md, F15 as amended 2026-09-24). The active work-folder is
 * read when it changes and whenever the window regains focus; the rail entry
 * shows only while its list is non-empty. The preview reads fixture data and
 * never touches the network.
 */
export function useFolderAutomations(activeWorkFolderId: string, fixtureMode: boolean) {
  const [byWorkFolder, setByWorkFolder] = useState<Record<string, FolderAutomationView[]>>(
    () => fixtureMode ? buildFixtureFolderAutomations() : {},
  );
  const requestRef = useRef<Record<string, number>>({});

  const refresh = useCallback(async (workFolderId: string): Promise<void> => {
    if (fixtureMode) return;
    const request = (requestRef.current[workFolderId] ?? 0) + 1;
    requestRef.current[workFolderId] = request;
    try {
      const response = await api<FolderAutomationsResponse>(folderAutomationsPath(workFolderId));
      if (requestRef.current[workFolderId] !== request) return;
      setByWorkFolder((current) => sameAutomations(current[workFolderId], response.automations)
        ? current
        : { ...current, [workFolderId]: response.automations });
    } catch {
      // A failed read keeps the last known list; the next focus retries.
    }
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    void refresh(activeWorkFolderId);
    const onFocus = () => { void refresh(activeWorkFolderId); };
    const onChange = () => {
      for (const workFolderId of new Set([activeWorkFolderId, ...Object.keys(requestRef.current)])) void refresh(workFolderId);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(automationsChanged, onChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(automationsChanged, onChange);
    };
  }, [activeWorkFolderId, fixtureMode, refresh]);

  return { byWorkFolder, refresh };
}

function sameAutomations(left: FolderAutomationView[] | undefined, right: FolderAutomationView[]): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}
