import type { WorkFolderSurfaceTab } from "../types";

/**
 * Tabs grouped by the work-folder that owns them, in first-seen order.
 * Browser tabs belong to no work-folder and share one group, whose id is null.
 */
export function groupSurfaceTabsByWorkFolder(
  tabs: WorkFolderSurfaceTab[],
): Array<{ workFolderId: string | null; tabs: WorkFolderSurfaceTab[] }> {
  const groups = new Map<string | null, WorkFolderSurfaceTab[]>();
  for (const tab of tabs) groups.set(tab.workFolderId, [...(groups.get(tab.workFolderId) ?? []), tab]);
  return [...groups.entries()]
    .map(([workFolderId, groupedTabs]) => ({ workFolderId, tabs: groupedTabs }));
}
