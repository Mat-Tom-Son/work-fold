import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { WorkspaceSurfaceTab } from "../web-local/src/types";

const tabBarModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/lib/surface-tab-groups.ts")).href;
const { groupSurfaceTabsByWorkspace } = await import(tabBarModuleUrl) as {
  groupSurfaceTabsByWorkspace: (
    tabs: WorkspaceSurfaceTab[],
  ) => Array<{ workspaceId: string; tabs: WorkspaceSurfaceTab[] }>;
};

test("optional tab grouping keeps both Space and tab order stable", () => {
  const tabs: WorkspaceSurfaceTab[] = [
    chatTab("space-1", "one", "First"),
    chatTab("space-2", "two", "Second"),
    chatTab("space-1", "three", "Third"),
    chatTab("space-2", "four", "Fourth"),
  ];

  const groups = groupSurfaceTabsByWorkspace(tabs);

  assert.deepEqual(groups.map((group) => group.workspaceId), ["space-1", "space-2"]);
  assert.deepEqual(groups[0]?.tabs.map((tab) => tab.title), ["First", "Third"]);
  assert.deepEqual(groups[1]?.tabs.map((tab) => tab.title), ["Second", "Fourth"]);
});

function chatTab(workspaceId: string, conversationId: string, title: string): WorkspaceSurfaceTab {
  return {
    id: `chat:${workspaceId}:${conversationId}`,
    kind: "chat",
    workspaceId,
    conversationId,
    title,
  };
}
