import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { WorkFolderSurfaceTab } from "../web-local/src/types";

const tabBarModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/lib/surface-tab-groups.ts")).href;
const { groupSurfaceTabsByWorkFolder } = await import(tabBarModuleUrl) as {
  groupSurfaceTabsByWorkFolder: (
    tabs: WorkFolderSurfaceTab[],
  ) => Array<{ workFolderId: string; tabs: WorkFolderSurfaceTab[] }>;
};

test("optional tab grouping keeps both work-folder and tab order stable", () => {
  const tabs: WorkFolderSurfaceTab[] = [
    chatTab("work-folder-1", "one", "First"),
    chatTab("work-folder-2", "two", "Second"),
    chatTab("work-folder-1", "three", "Third"),
    chatTab("work-folder-2", "four", "Fourth"),
  ];

  const groups = groupSurfaceTabsByWorkFolder(tabs);

  assert.deepEqual(groups.map((group) => group.workFolderId), ["work-folder-1", "work-folder-2"]);
  assert.deepEqual(groups[0]?.tabs.map((tab) => tab.title), ["First", "Third"]);
  assert.deepEqual(groups[1]?.tabs.map((tab) => tab.title), ["Second", "Fourth"]);
});

function chatTab(workFolderId: string, conversationId: string, title: string): WorkFolderSurfaceTab {
  return {
    id: `chat:${workFolderId}:${conversationId}`,
    kind: "chat",
    workFolderId,
    conversationId,
    title,
  };
}
