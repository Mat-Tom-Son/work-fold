import type { SpaceSurfaceTab } from "../types";

export function groupSurfaceTabsBySpace(
  tabs: SpaceSurfaceTab[],
): Array<{ spaceId: string; tabs: SpaceSurfaceTab[] }> {
  const groups = new Map<string, SpaceSurfaceTab[]>();
  for (const tab of tabs) groups.set(tab.spaceId, [...(groups.get(tab.spaceId) ?? []), tab]);
  return [...groups.entries()]
    .map(([spaceId, groupedTabs]) => ({ spaceId, tabs: groupedTabs }));
}
