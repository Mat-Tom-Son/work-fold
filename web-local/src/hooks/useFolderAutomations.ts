import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { buildFixtureFolderAutomations } from "../fixtures/space-fixture";
import type { FolderAutomationsResponse, FolderAutomationView } from "../../../src/shared/routing-presentation";

const automationsChanged = "work-fold:automations-changed";

/** Refresh Folder views after an Automation action in this renderer. */
export function notifyFolderAutomationsChanged(): void {
  window.dispatchEvent(new Event(automationsChanged));
}

export function folderAutomationsPath(spaceId: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/automations`;
}

/**
 * The automations whose trigger or steps name a Folder, cached per Folder
 * (docs/fold-routings.md, F15 as amended 2026-09-24). The active Folder is
 * read when it changes and whenever the window regains focus; the rail entry
 * shows only while its list is non-empty. The preview reads fixture data and
 * never touches the network.
 */
export function useFolderAutomations(activeSpaceId: string, fixtureMode: boolean) {
  const [bySpace, setBySpace] = useState<Record<string, FolderAutomationView[]>>(
    () => fixtureMode ? buildFixtureFolderAutomations() : {},
  );
  const requestRef = useRef<Record<string, number>>({});

  const refresh = useCallback(async (spaceId: string): Promise<void> => {
    if (fixtureMode) return;
    const request = (requestRef.current[spaceId] ?? 0) + 1;
    requestRef.current[spaceId] = request;
    try {
      const response = await api<FolderAutomationsResponse>(folderAutomationsPath(spaceId));
      if (requestRef.current[spaceId] !== request) return;
      setBySpace((current) => sameAutomations(current[spaceId], response.automations)
        ? current
        : { ...current, [spaceId]: response.automations });
    } catch {
      // A failed read keeps the last known list; the next focus retries.
    }
  }, [fixtureMode]);

  useEffect(() => {
    if (fixtureMode) return;
    void refresh(activeSpaceId);
    const onFocus = () => { void refresh(activeSpaceId); };
    const onChange = () => {
      for (const spaceId of new Set([activeSpaceId, ...Object.keys(requestRef.current)])) void refresh(spaceId);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(automationsChanged, onChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(automationsChanged, onChange);
    };
  }, [activeSpaceId, fixtureMode, refresh]);

  return { bySpace, refresh };
}

function sameAutomations(left: FolderAutomationView[] | undefined, right: FolderAutomationView[]): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}
