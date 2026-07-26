import type { WorkspaceSurfaceTab } from "../types";

export function groupSurfaceTabsByWorkspace(
  tabs: WorkspaceSurfaceTab[],
): Array<{ workspaceId: string; tabs: WorkspaceSurfaceTab[] }> {
  const groups = new Map<string, WorkspaceSurfaceTab[]>();
  for (const tab of tabs) groups.set(tab.workspaceId, [...(groups.get(tab.workspaceId) ?? []), tab]);
  return [...groups.entries()]
    .map(([workspaceId, groupedTabs]) => ({ workspaceId, tabs: groupedTabs }));
}
