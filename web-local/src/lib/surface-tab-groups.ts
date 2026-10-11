import type { WorkFolderSurfaceTab } from "../types";

export function groupSurfaceTabsByWorkFolder(
  tabs: WorkFolderSurfaceTab[],
): Array<{ workFolderId: string; tabs: WorkFolderSurfaceTab[] }> {
  const groups = new Map<string, WorkFolderSurfaceTab[]>();
  for (const tab of tabs) groups.set(tab.workFolderId, [...(groups.get(tab.workFolderId) ?? []), tab]);
  return [...groups.entries()]
    .map(([workFolderId, groupedTabs]) => ({ workFolderId, tabs: groupedTabs }));
}
