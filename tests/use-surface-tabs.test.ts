import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const surfaceTabsModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/hooks/useSurfaceTabs.ts")).href;
const {
  activeTabAfterConversationActivation,
  assistantToolsSurfaceTab,
  appStudioSurfaceTab,
  closeFileSurfaceTabs,
  fileSurfaceTab,
  librarySurfaceTab,
  migrateLegacyLibrarySurfaceTabState,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabWorkspaceRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForWorkspaces,
  retargetFileSurfaceTabs,
  restrictedAppSurfaceTabId,
  surfaceTabActivationForWorkspace,
  surfaceTabWorkspaceSwitchTarget,
  upsertSurfaceTab,
} = await import(surfaceTabsModuleUrl) as SurfaceTabsExports;

interface SpaceSummary {
  id: string;
  name: string;
  rootPath: string;
  location: { kind: "local"; storage: "managed" | "linked" };
  createdAt: string;
  updatedAt: string;
}

interface SurfaceTab {
  id: string;
  kind: "chat" | "file" | "history" | "library" | "appearance" | "app-studio" | "assistant-tools" | "extension" | "restricted-app";
  workspaceId: string;
  conversationId?: string | null;
  path?: string;
  checkpointId?: string;
  surfaceId?: string;
  surfaceExecution?: "full-trust-pi";
  viewId?: string;
  view?: "installed" | "discover";
  appId?: string;
  digest?: string;
  appTabId?: string;
  route?: string;
  state?: unknown;
  title: string;
}

interface SurfaceTabsExports {
  activeTabAfterConversationActivation: (currentActiveTabId: string | null, sourceTabId: string, duplicateTabId: string) => string | null;
  assistantToolsSurfaceTab: (space: SpaceSummary, view?: "installed" | "discover") => SurfaceTab;
  appStudioSurfaceTab: (space: SpaceSummary) => SurfaceTab;
  closeFileSurfaceTabs: (tabs: SurfaceTab[], workspaceId: string, deletedPaths: Set<string>) => SurfaceTab[];
  fileSurfaceTab: (space: SpaceSummary, path: string) => SurfaceTab;
  librarySurfaceTab: (space: SpaceSummary) => SurfaceTab;
  migrateLegacyLibrarySurfaceTabState: (
    state: { tabs: SurfaceTab[]; activeTabId: string | null },
    space: SpaceSummary,
    shouldMigrate: boolean,
  ) => { tabs: SurfaceTab[]; activeTabId: string | null };
  normalizeStoredSurfaceTabsValue: (parsed: unknown) => { tabs: SurfaceTab[]; activeTabId: string | null };
  recordActiveSurfaceTabWorkspaceRecency: (recent: Map<string, string>, tabs: SurfaceTab[], activeTabId: string | null) => void;
  readStoredSurfaceTabsState: (space: SpaceSummary, spaces: SpaceSummary[]) => { tabs: SurfaceTab[]; activeTabId: string | null };
  restoreStoredSurfaceTabsForWorkspaces: (
    state: { tabs: SurfaceTab[]; activeTabId: string | null },
    spaces: SpaceSummary[],
  ) => { tabs: SurfaceTab[]; activeTabId: string | null };
  retargetFileSurfaceTabs: (tabs: SurfaceTab[], workspaceId: string, sourcePath: string, movedPath: string) => SurfaceTab[];
  restrictedAppSurfaceTabId: (workspaceId: string, appId: string, digest: string, appTabId: string) => string;
  surfaceTabActivationForWorkspace: (input: {
    activeTabId: string | null;
    recentTabIdsByWorkspace: Map<string, string>;
    tabs: SurfaceTab[];
    workspace: SpaceSummary;
  }) => { tabId: string; tabToAdd?: SurfaceTab } | null;
  surfaceTabWorkspaceSwitchTarget: (input: {
    activeTabId: string | null;
    activeWorkspaceId: string;
    tabs: SurfaceTab[];
    workspaces: SpaceSummary[];
  }) => SpaceSummary | null;
  upsertSurfaceTab: (tabs: SurfaceTab[], tab: SurfaceTab) => SurfaceTab[];
}

const space: SpaceSummary = {
  id: "space-1",
  name: "First Space",
  rootPath: "C:/Spaces/First",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const otherSpace: SpaceSummary = {
  ...space,
  id: "space-2",
  name: "Other Space",
  rootPath: "C:/Spaces/Other",
};

test("file tabs upsert as one retargeting tab per Space", () => {
  const first = fileSurfaceTab(space, "Notes/Draft.md");
  const second = fileSurfaceTab(space, "Notes/Final.md");
  const tabs = upsertSurfaceTab(upsertSurfaceTab([], first), second);

  assert.equal(tabs.length, 1);
  assert.deepEqual(tabs[0], {
    id: "file:space-1",
    kind: "file",
    workspaceId: "space-1",
    path: "Notes/Final.md",
    title: "Final.md",
  });
});

test("file tabs follow moved paths and close when their file is deleted", () => {
  const tabs: SurfaceTab[] = [
    fileSurfaceTab(space, "Notes/Draft.md"),
    { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
  ];
  const moved = retargetFileSurfaceTabs(tabs, space.id, "Notes", "Archive/Notes");

  assert.equal(moved[0]?.path, "Archive/Notes/Draft.md");
  assert.equal(moved[0]?.title, "Draft.md");
  assert.deepEqual(
    closeFileSurfaceTabs(moved, space.id, new Set(["Archive/Notes/Draft.md"])).map((tab) => tab.id),
    ["chat:space-1:new"],
  );
});

test("tab restore falls back cleanly when persisted JSON is corrupt", () => {
  withStoredTabs("{not valid json", () => {
    assert.deepEqual(readStoredSurfaceTabsState(space, [space]), {
      tabs: [{ id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" }],
      activeTabId: "chat:space-1:new",
    });
  });
});

test("tab restore accepts only known, well-formed surface types", () => {
  assert.deepEqual(normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat", extra: true },
      { id: "mystery:space-1", kind: "mystery", workspaceId: "space-1", title: "Mystery" },
      { id: 4, kind: "file", workspaceId: "space-1", path: "Notes.md", title: "Notes.md" },
      { id: "file:space-1", kind: "file", workspaceId: "space-1", path: "Notes.md", title: "Notes.md", ignored: "yes" },
      { id: "history:space-1", kind: "history", workspaceId: "space-1", title: "History" },
      { id: "spoofed-library", kind: "library", workspaceId: "space-1", title: "Renamed Library" },
      { id: "spoofed-studio", kind: "app-studio", workspaceId: "space-1", title: "Renamed Studio" },
      { id: "spoofed-tools", kind: "assistant-tools", workspaceId: "space-1", view: "discover", title: "Renamed Tools" },
      { id: "broken-tools", kind: "assistant-tools", workspaceId: "space-1", view: "packages", title: "Broken Tools" },
      { id: "extension:space-1:inbox:overview", kind: "extension", workspaceId: "space-1", surfaceId: "inbox", viewId: "overview", title: "Overview", ignored: true },
      { id: "restricted:bad", kind: "restricted-app", workspaceId: "space-1", appId: "mail", digest: "bad", appTabId: "message:release", route: "/message/release", title: "Bad app tab" },
      { id: "app-controlled-spoof", kind: "restricted-app", workspaceId: "space-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
      { id: "extension:space-1:broken", kind: "extension", workspaceId: "space-1", surfaceId: "inbox", title: "Broken" },
    ],
    activeTabId: "file:space-1",
  }), {
    tabs: [
      { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
      { id: "file:space-1", kind: "file", workspaceId: "space-1", path: "Notes.md", title: "Notes.md" },
      { id: "history:space-1", kind: "history", workspaceId: "space-1", checkpointId: undefined, title: "History" },
      { id: "library:space-1", kind: "library", workspaceId: "space-1", title: "Library" },
      { id: "app-studio:space-1", kind: "app-studio", workspaceId: "space-1", title: "Renamed Studio" },
      { id: "assistant-tools:space-1", kind: "assistant-tools", workspaceId: "space-1", view: "discover", title: "Assistant tools" },
      { id: "extension:space-1:inbox:overview", kind: "extension", workspaceId: "space-1", surfaceId: "inbox", surfaceExecution: "full-trust-pi", viewId: "overview", title: "Overview" },
      { id: restrictedAppSurfaceTabId("space-1", "mail", "a".repeat(64), "message:release"), kind: "restricted-app", workspaceId: "space-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
    ],
    activeTabId: "file:space-1",
  });
});

test("restored tabs belonging to removed Spaces are discarded", () => {
  assert.deepEqual(restoreStoredSurfaceTabsForWorkspaces({
    tabs: [
      { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
      { id: "appearance:space-2", kind: "appearance", workspaceId: "space-2", title: "Customize Other Space" },
    ],
    activeTabId: "appearance:space-2",
  }, [space]), {
    tabs: [{ id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" }],
    activeTabId: "chat:space-1:new",
  });
});

test("each Space remembers its most recently active tab", () => {
  const recent = new Map<string, string>([["space-1", "chat:space-1:old"]]);
  const tabs: SurfaceTab[] = [
    { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
    { id: "history:space-2", kind: "history", workspaceId: "space-2", title: "History" },
  ];

  recordActiveSurfaceTabWorkspaceRecency(recent, tabs, "history:space-2");
  recordActiveSurfaceTabWorkspaceRecency(recent, tabs, "missing-tab");

  assert.equal(recent.get("space-1"), "chat:space-1:old");
  assert.equal(recent.get("space-2"), "history:space-2");
});

test("activating a draft conversation never steals focus from another surface", () => {
  assert.equal(
    activeTabAfterConversationActivation("library:space-1", "chat:space-1:new", "chat:space-1:existing"),
    "library:space-1",
  );
  assert.equal(
    activeTabAfterConversationActivation("chat:space-1:new", "chat:space-1:new", "chat:space-1:existing"),
    "chat:space-1:existing",
  );
  assert.equal(
    activeTabAfterConversationActivation(null, "chat:space-1:new", "chat:space-1:existing"),
    null,
  );
});

test("activating a cross-Space tab switches to the tab's Space", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
    appStudioSurfaceTab(otherSpace),
  ];

  assert.equal(surfaceTabWorkspaceSwitchTarget({
    activeTabId: "chat:space-1:new",
    activeWorkspaceId: "space-1",
    tabs,
    workspaces: [space, otherSpace],
  }), null);
  assert.deepEqual(surfaceTabWorkspaceSwitchTarget({
    activeTabId: "app-studio:space-2",
    activeWorkspaceId: "space-1",
    tabs,
    workspaces: [space, otherSpace],
  }), otherSpace);
});

test("App Studio uses one canonical persistent tab per Space", () => {
  const first = appStudioSurfaceTab(space);
  const second = appStudioSurfaceTab({ ...space, name: "Renamed Space" });

  assert.deepEqual(first, {
    id: "app-studio:space-1",
    kind: "app-studio",
    workspaceId: "space-1",
    title: "App Studio",
  });
  assert.deepEqual(upsertSurfaceTab(upsertSurfaceTab([], first), second), [second]);
});

test("Library uses one canonical persistent tab per Space", () => {
  const first = librarySurfaceTab(space);
  const second = librarySurfaceTab({ ...space, name: "Renamed Space" });

  assert.deepEqual(first, {
    id: "library:space-1",
    kind: "library",
    workspaceId: "space-1",
    title: "Library",
  });
  assert.deepEqual(upsertSurfaceTab(upsertSurfaceTab([], first), second), [second]);
});

test("a legacy Library rail selection migrates once to the owning Space tab", () => {
  const initial = {
    tabs: [appStudioSurfaceTab(space)],
    activeTabId: "app-studio:space-1",
  };
  const migrated = migrateLegacyLibrarySurfaceTabState(initial, space, true);

  assert.equal(migrated.activeTabId, "library:space-1");
  assert.deepEqual(migrated.tabs.map((tab) => tab.id), ["app-studio:space-1", "library:space-1"]);
  assert.deepEqual(migrateLegacyLibrarySurfaceTabState(migrated, space, true), migrated);
  assert.equal(migrateLegacyLibrarySurfaceTabState(initial, space, false), initial);
});

test("Assistant tools uses one canonical persistent tab per Space and updates its view", () => {
  const installed = assistantToolsSurfaceTab(space);
  const discover = assistantToolsSurfaceTab({ ...space, name: "Renamed Space" }, "discover");

  assert.deepEqual(installed, {
    id: "assistant-tools:space-1",
    kind: "assistant-tools",
    workspaceId: "space-1",
    view: "installed",
    title: "Assistant tools",
  });
  assert.deepEqual(upsertSurfaceTab(upsertSurfaceTab([], installed), discover), [discover]);
});

test("switching Spaces activates the recent tab, then draft, then creates a draft", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:space-1:new", kind: "chat", workspaceId: "space-1", conversationId: null, title: "New chat" },
    { id: "history:space-2", kind: "history", workspaceId: "space-2", title: "History" },
    { id: "chat:space-2:new", kind: "chat", workspaceId: "space-2", conversationId: null, title: "New chat" },
  ];

  assert.deepEqual(surfaceTabActivationForWorkspace({
    activeTabId: "chat:space-1:new",
    recentTabIdsByWorkspace: new Map([["space-2", "history:space-2"]]),
    tabs,
    workspace: otherSpace,
  }), { tabId: "history:space-2" });

  assert.deepEqual(surfaceTabActivationForWorkspace({
    activeTabId: "chat:space-1:new",
    recentTabIdsByWorkspace: new Map([["space-2", "missing-tab"]]),
    tabs,
    workspace: otherSpace,
  }), { tabId: "chat:space-2:new" });

  const thirdSpace = { ...space, id: "space-3", name: "Third Space", rootPath: "C:/Spaces/Third" };
  assert.deepEqual(surfaceTabActivationForWorkspace({
    activeTabId: "chat:space-1:new",
    recentTabIdsByWorkspace: new Map(),
    tabs,
    workspace: thirdSpace,
  }), {
    tabId: "chat:space-3:new",
    tabToAdd: { id: "chat:space-3:new", kind: "chat", workspaceId: "space-3", conversationId: null, title: "New chat" },
  });
});

function withStoredTabs(value: string, run: () => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => key === "workspace.surfaceTabs.v1" ? value : null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    },
  });
  try {
    run();
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
  }
}
