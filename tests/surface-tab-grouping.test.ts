import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { SpaceSurfaceTab } from "../web-local/src/types";

const tabBarModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/lib/surface-tab-groups.ts")).href;
const { groupSurfaceTabsBySpace } = await import(tabBarModuleUrl) as {
  groupSurfaceTabsBySpace: (
    tabs: SpaceSurfaceTab[],
  ) => Array<{ spaceId: string; tabs: SpaceSurfaceTab[] }>;
};

test("optional tab grouping keeps both Space and tab order stable", () => {
  const tabs: SpaceSurfaceTab[] = [
    chatTab("space-1", "one", "First"),
    chatTab("space-2", "two", "Second"),
    chatTab("space-1", "three", "Third"),
    chatTab("space-2", "four", "Fourth"),
  ];

  const groups = groupSurfaceTabsBySpace(tabs);

  assert.deepEqual(groups.map((group) => group.spaceId), ["space-1", "space-2"]);
  assert.deepEqual(groups[0]?.tabs.map((tab) => tab.title), ["First", "Third"]);
  assert.deepEqual(groups[1]?.tabs.map((tab) => tab.title), ["Second", "Fourth"]);
});

function chatTab(spaceId: string, conversationId: string, title: string): SpaceSurfaceTab {
  return {
    id: `chat:${spaceId}:${conversationId}`,
    kind: "chat",
    spaceId,
    conversationId,
    title,
  };
}
