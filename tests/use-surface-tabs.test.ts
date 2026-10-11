import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const surfaceTabsModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/hooks/useSurfaceTabs.ts")).href;
const {
  activeTabAfterConversationActivation,
  appStudioSurfaceTab,
  checksSurfaceTab,
  closeFileSurfaceTabs,
  closeUnavailableRestrictedAppSurfaceTabs,
  fileSurfaceTab,
  normalizeStoredSurfaceTabsValue,
  recordActiveSurfaceTabWorkFolderRecency,
  readStoredSurfaceTabsState,
  restoreStoredSurfaceTabsForWorkFolders,
  retargetFileSurfaceTabs,
  reorderSurfaceTabList,
  restrictedAppSurfaceTabId,
  spaceAutomationsSurfaceTab,
  surfaceTabActivationForWorkFolder,
  surfaceTabWorkFolderSwitchTarget,
  upsertSurfaceTab,
  useSurfaceTabs,
} = await import(surfaceTabsModuleUrl) as SurfaceTabsExports;

interface WorkFolderSummary {
  id: string;
  name: string;
  workFolderRoot: string;
  location: { kind: "local"; storage: "managed" | "linked" };
  createdAt: string;
  updatedAt: string;
}

interface SurfaceTab {
  id: string;
  kind: "chat" | "file" | "history" | "app-studio" | "checks" | "work-folder-automations" | "extension" | "restricted-app";
  workFolderId: string;
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
  appStudioSurfaceTab: (workFolder: WorkFolderSummary) => SurfaceTab;
  checksSurfaceTab: (workFolder: WorkFolderSummary) => SurfaceTab;
  spaceAutomationsSurfaceTab: (workFolder: WorkFolderSummary) => SurfaceTab;
  closeFileSurfaceTabs: (tabs: SurfaceTab[], workFolderId: string, deletedPaths: Set<string>) => SurfaceTab[];
  closeUnavailableRestrictedAppSurfaceTabs: (
    tabs: SurfaceTab[],
    appsByWorkFolder: Record<string, Array<{ manifest: { id: string }; digest: string }>>,
    knownWorkFolderIds: ReadonlySet<string>,
  ) => SurfaceTab[];
  fileSurfaceTab: (workFolder: WorkFolderSummary, path: string) => SurfaceTab;
  normalizeStoredSurfaceTabsValue: (parsed: unknown) => { tabs: SurfaceTab[]; activeTabId: string | null };
  recordActiveSurfaceTabWorkFolderRecency: (recent: Map<string, string>, tabs: SurfaceTab[], activeTabId: string | null) => void;
  readStoredSurfaceTabsState: (workFolder: WorkFolderSummary, workFolders: WorkFolderSummary[]) => { tabs: SurfaceTab[]; activeTabId: string | null };
  restoreStoredSurfaceTabsForWorkFolders: (
    state: { tabs: SurfaceTab[]; activeTabId: string | null },
    workFolders: WorkFolderSummary[],
  ) => { tabs: SurfaceTab[]; activeTabId: string | null };
  retargetFileSurfaceTabs: (tabs: SurfaceTab[], workFolderId: string, sourcePath: string, movedPath: string) => SurfaceTab[];
  reorderSurfaceTabList: (tabs: SurfaceTab[], ids: string[]) => SurfaceTab[];
  restrictedAppSurfaceTabId: (workFolderId: string, appId: string, digest: string, appTabId: string) => string;
  surfaceTabActivationForWorkFolder: (input: {
    activeTabId: string | null;
    recentTabIdsByWorkFolder: Map<string, string>;
    tabs: SurfaceTab[];
    workFolder: WorkFolderSummary;
  }) => { tabId: string; tabToAdd?: SurfaceTab } | null;
  surfaceTabWorkFolderSwitchTarget: (input: {
    activeTabId: string | null;
    activeWorkFolderId: string;
    tabs: SurfaceTab[];
    workFolders: WorkFolderSummary[];
  }) => WorkFolderSummary | null;
  upsertSurfaceTab: (tabs: SurfaceTab[], tab: SurfaceTab) => SurfaceTab[];
  useSurfaceTabs: (input: { workFolder: WorkFolderSummary; workFolders: WorkFolderSummary[] }) => { surfaceTabs: SurfaceTab[]; activeSurfaceTabId: string | null; reorderSurfaceTabs: (ids: string[]) => void; setActiveSurfaceTabId: (id: string) => void };
}

const workFolder: WorkFolderSummary = {
  id: "work-folder-1",
  name: "First work-folder",
  workFolderRoot: "C:/work-folders/First",
  location: { kind: "local", storage: "linked" },
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const otherWorkFolder: WorkFolderSummary = {
  ...workFolder,
  id: "work-folder-2",
  name: "Other work-folder",
  workFolderRoot: "C:/work-folders/Other",
};

test("reordering preserves tab identities, active restoration, and tabs added during the gesture", () => {
  const tabs = [fileSurfaceTab(workFolder, "draft.md"), fileSurfaceTab(otherWorkFolder, "budget.csv"), checksSurfaceTab(workFolder)];
  const next = reorderSurfaceTabList(tabs, [tabs[2]!.id, "closed-tab", tabs[0]!.id, tabs[2]!.id]);
  assert.deepEqual(next, [tabs[2], tabs[1], tabs[0]]);
  assert.equal(next[0], tabs[2]); assert.equal(next[1], tabs[1]);
  assert.deepEqual(normalizeStoredSurfaceTabsValue({ tabs: next, activeTabId: tabs[0]!.id }), { tabs: next, activeTabId: tabs[0]!.id });
  assert.equal(reorderSurfaceTabList(next, next.map((tab) => tab.id)), next);
});

test("file tabs upsert as one retargeting tab per work-folder", () => {
  const first = fileSurfaceTab(workFolder, "Notes/Draft.md");
  const second = fileSurfaceTab(workFolder, "Notes/Final.md");
  const tabs = upsertSurfaceTab(upsertSurfaceTab([], first), second);

  assert.equal(tabs.length, 1);
  assert.deepEqual(tabs[0], {
    id: "file:work-folder-1",
    kind: "file",
    workFolderId: "work-folder-1",
    path: "Notes/Final.md",
    title: "Final.md",
  });
});

test("file tabs follow moved paths and close when their file is deleted", () => {
  const tabs: SurfaceTab[] = [
    fileSurfaceTab(workFolder, "Notes/Draft.md"),
    { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
  ];
  const moved = retargetFileSurfaceTabs(tabs, workFolder.id, "Notes", "Archive/Notes");

  assert.equal(moved[0]?.path, "Archive/Notes/Draft.md");
  assert.equal(moved[0]?.title, "Draft.md");
  assert.deepEqual(
    closeFileSurfaceTabs(moved, workFolder.id, new Set(["Archive/Notes/Draft.md"])).map((tab) => tab.id),
    ["chat:work-folder-1:new"],
  );
});

test("Checks use one canonical work-folder-owned work tab", () => {
  assert.deepEqual(checksSurfaceTab(workFolder), {
    id: "checks:work-folder-1",
    kind: "checks",
    workFolderId: "work-folder-1",
    title: "Checks",
  });
});

test("Automations use one canonical work-folder-owned tab", () => {
  // docs/automations.md, F15 as amended 2026-09-24.
  assert.deepEqual(spaceAutomationsSurfaceTab(workFolder), {
    id: "work-folder-automations:work-folder-1",
    kind: "work-folder-automations",
    workFolderId: "work-folder-1",
    title: "Automations",
  });
});

test("tab restore falls back cleanly when persisted JSON is corrupt", () => {
  withStoredTabs("{not valid json", () => {
    assert.deepEqual(readStoredSurfaceTabsState(workFolder, [workFolder]), {
      tabs: [{ id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" }],
      activeTabId: "chat:work-folder-1:new",
    });
  });
});

test("tab restore accepts only known, well-formed surface types", () => {
  assert.deepEqual(normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat", extra: true },
      { id: "mystery:work-folder-1", kind: "mystery", workFolderId: "work-folder-1", title: "Mystery" },
      { id: 4, kind: "file", workFolderId: "work-folder-1", path: "Notes.md", title: "Notes.md" },
      { id: "file:work-folder-1", kind: "file", workFolderId: "work-folder-1", path: "Notes.md", title: "Notes.md", ignored: "yes" },
      { id: "history:work-folder-1", kind: "history", workFolderId: "work-folder-1", title: "History" },
      { id: "spoofed-library", kind: "library", workFolderId: "work-folder-1", title: "Renamed Library" },
      { id: "spoofed-studio", kind: "app-studio", workFolderId: "work-folder-1", title: "Renamed Studio" },
      { id: "spoofed-tools", kind: "assistant-tools", workFolderId: "work-folder-1", view: "discover", title: "Renamed Tools" },
      { id: "broken-tools", kind: "assistant-tools", workFolderId: "work-folder-1", view: "packages", title: "Broken Tools" },
      { id: "spoofed-checks", kind: "checks", workFolderId: "work-folder-1", title: "All files are healthy" },
      { id: "spoofed-automations", kind: "work-folder-automations", workFolderId: "work-folder-1", title: "Everything is on" },
      { id: "extension:work-folder-1:inbox:overview", kind: "extension", workFolderId: "work-folder-1", surfaceId: "inbox", viewId: "overview", title: "Overview", ignored: true },
      { id: "restricted:bad", kind: "restricted-app", featureInstallationId: "feature-installation_original", workFolderId: "work-folder-1", appId: "mail", digest: "bad", appTabId: "message:release", route: "/message/release", title: "Bad app tab" },
      { id: "app-controlled-spoof", kind: "restricted-app", featureInstallationId: "feature-installation_original", workFolderId: "work-folder-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
      { id: "extension:work-folder-1:broken", kind: "extension", workFolderId: "work-folder-1", surfaceId: "inbox", title: "Broken" },
    ],
    activeTabId: "file:work-folder-1",
  }), {
    tabs: [
      { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
      { id: "file:work-folder-1", kind: "file", workFolderId: "work-folder-1", path: "Notes.md", title: "Notes.md" },
      { id: "history:work-folder-1", kind: "history", workFolderId: "work-folder-1", checkpointId: undefined, title: "History" },
      { id: "app-studio:work-folder-1", kind: "app-studio", workFolderId: "work-folder-1", title: "Renamed Studio" },
      { id: "checks:work-folder-1", kind: "checks", workFolderId: "work-folder-1", title: "Checks" },
      { id: "work-folder-automations:work-folder-1", kind: "work-folder-automations", workFolderId: "work-folder-1", title: "Automations" },
      { id: "extension:work-folder-1:inbox:overview", kind: "extension", workFolderId: "work-folder-1", surfaceId: "inbox", surfaceExecution: "full-trust-pi", viewId: "overview", title: "Overview" },
      { id: restrictedAppSurfaceTabId("work-folder-1", "mail", "a".repeat(64), "message:release", "feature-installation_original"), kind: "restricted-app", featureInstallationId: "feature-installation_original", workFolderId: "work-folder-1", appId: "mail", digest: "a".repeat(64), appTabId: "message:release", route: "/message/release", state: { selected: true }, title: "Release checklist" },
    ],
    activeTabId: "file:work-folder-1",
  });
});

test("restored tabs belonging to removed work-folders are discarded", () => {
  assert.deepEqual(restoreStoredSurfaceTabsForWorkFolders({
    tabs: [
      { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
      { id: "history:work-folder-2", kind: "history", workFolderId: "work-folder-2", title: "History" },
    ],
    activeTabId: "history:work-folder-2",
  }, [workFolder]), {
    tabs: [{ id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" }],
    activeTabId: "chat:work-folder-1:new",
  });
});

test("retired Customize tabs are discarded without losing other tabs or leaving a blank active tab", () => {
  assert.deepEqual(normalizeStoredSurfaceTabsValue({
    tabs: [
      { id: "appearance:work-folder-1", kind: "appearance", workFolderId: "work-folder-1", title: "Customize Old name" },
      { id: "chat:work-folder-1:keep", kind: "chat", workFolderId: "work-folder-1", conversationId: "keep", title: "Keep my Chat" },
    ],
    activeTabId: "appearance:work-folder-1",
  }), {
    tabs: [
      { id: "chat:work-folder-1:keep", kind: "chat", workFolderId: "work-folder-1", conversationId: "keep", title: "Keep my Chat" },
    ],
    activeTabId: "chat:work-folder-1:keep",
  });
  withStoredTabs(JSON.stringify({ tabs: [{ id: "appearance:work-folder-1", kind: "appearance", workFolderId: "work-folder-1", title: "Customize" }], activeTabId: "appearance:work-folder-1" }), () => {
    assert.deepEqual(readStoredSurfaceTabsState(workFolder, [workFolder]), {
      tabs: [{ id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" }],
      activeTabId: "chat:work-folder-1:new",
    });
  });
});

test("restricted app tabs close when their installed revision changes", () => {
  const currentDigest = "a".repeat(64);
  const staleDigest = "b".repeat(64);
  const tabs: SurfaceTab[] = [
    { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
    {
      id: restrictedAppSurfaceTabId("work-folder-1", "trip-studio", staleDigest, "destination:lisbon", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      workFolderId: "work-folder-1",
      appId: "trip-studio",
      digest: staleDigest,
      appTabId: "destination:lisbon",
      route: "/destination/lisbon",
      title: "Lisbon pulse",
    },
    {
      id: restrictedAppSurfaceTabId("work-folder-1", "trip-studio", currentDigest, "destination:copenhagen", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      workFolderId: "work-folder-1",
      appId: "trip-studio",
      digest: currentDigest,
      appTabId: "destination:copenhagen",
      route: "/destination/copenhagen",
      title: "Copenhagen pulse",
    },
    {
      id: restrictedAppSurfaceTabId("work-folder-2", "unknown", staleDigest, "overview", "feature-installation_original"),
      kind: "restricted-app", featureInstallationId: "feature-installation_original",
      workFolderId: "work-folder-2",
      appId: "unknown",
      digest: staleDigest,
      appTabId: "overview",
      route: "/",
      title: "Still loading",
    },
  ];

  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs(tabs, {
    "work-folder-1": [{ manifest: { id: "trip-studio" }, digest: currentDigest, featureInstallationId: "feature-installation_original" }],
  }, new Set(["work-folder-1"])), [tabs[0], tabs[2], tabs[3]]);
  assert.equal(closeUnavailableRestrictedAppSurfaceTabs(tabs, {}, new Set()), tabs);
});

test("each work-folder remembers its most recently active tab", () => {
  const recent = new Map<string, string>([["work-folder-1", "chat:work-folder-1:old"]]);
  const tabs: SurfaceTab[] = [
    { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
    { id: "history:work-folder-2", kind: "history", workFolderId: "work-folder-2", title: "History" },
  ];

  recordActiveSurfaceTabWorkFolderRecency(recent, tabs, "history:work-folder-2");
  recordActiveSurfaceTabWorkFolderRecency(recent, tabs, "missing-tab");

  assert.equal(recent.get("work-folder-1"), "chat:work-folder-1:old");
  assert.equal(recent.get("work-folder-2"), "history:work-folder-2");
});

test("activating a draft conversation never steals focus from another surface", () => {
  assert.equal(
    activeTabAfterConversationActivation("library:work-folder-1", "chat:work-folder-1:new", "chat:work-folder-1:existing"),
    "library:work-folder-1",
  );
  assert.equal(
    activeTabAfterConversationActivation("chat:work-folder-1:new", "chat:work-folder-1:new", "chat:work-folder-1:existing"),
    "chat:work-folder-1:existing",
  );
  assert.equal(
    activeTabAfterConversationActivation(null, "chat:work-folder-1:new", "chat:work-folder-1:existing"),
    null,
  );
});

test("activating a cross-work-folder tab switches to the tab's work-folder", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
    appStudioSurfaceTab(otherWorkFolder),
  ];

  assert.equal(surfaceTabWorkFolderSwitchTarget({
    activeTabId: "chat:work-folder-1:new",
    activeWorkFolderId: "work-folder-1",
    tabs,
    workFolders: [workFolder, otherWorkFolder],
  }), null);
  assert.deepEqual(surfaceTabWorkFolderSwitchTarget({
    activeTabId: "app-studio:work-folder-2",
    activeWorkFolderId: "work-folder-1",
    tabs,
    workFolders: [workFolder, otherWorkFolder],
  }), otherWorkFolder);
});

test("App Studio uses one canonical persistent tab per work-folder", () => {
  const first = appStudioSurfaceTab(workFolder);
  const second = appStudioSurfaceTab({ ...workFolder, name: "Renamed work-folder" });

  assert.deepEqual(first, {
    id: "app-studio:work-folder-1",
    kind: "app-studio",
    workFolderId: "work-folder-1",
    title: "App Studio",
  });
  assert.deepEqual(upsertSurfaceTab(upsertSurfaceTab([], first), second), [second]);
});

test("switching work-folders activates the recent tab, then draft, then creates a draft", () => {
  const tabs: SurfaceTab[] = [
    { id: "chat:work-folder-1:new", kind: "chat", workFolderId: "work-folder-1", conversationId: null, title: "New Chat" },
    { id: "history:work-folder-2", kind: "history", workFolderId: "work-folder-2", title: "History" },
    { id: "chat:work-folder-2:new", kind: "chat", workFolderId: "work-folder-2", conversationId: null, title: "New Chat" },
  ];

  assert.deepEqual(surfaceTabActivationForWorkFolder({
    activeTabId: "chat:work-folder-1:new",
    recentTabIdsByWorkFolder: new Map([["work-folder-2", "history:work-folder-2"]]),
    tabs,
    workFolder: otherWorkFolder,
  }), { tabId: "history:work-folder-2" });

  assert.deepEqual(surfaceTabActivationForWorkFolder({
    activeTabId: "chat:work-folder-1:new",
    recentTabIdsByWorkFolder: new Map([["work-folder-2", "missing-tab"]]),
    tabs,
    workFolder: otherWorkFolder,
  }), { tabId: "chat:work-folder-2:new" });

  const thirdWorkFolder = { ...workFolder, id: "work-folder-3", name: "Third work-folder", workFolderRoot: "C:/work-folders/Third" };
  assert.deepEqual(surfaceTabActivationForWorkFolder({
    activeTabId: "chat:work-folder-1:new",
    recentTabIdsByWorkFolder: new Map(),
    tabs,
    workFolder: thirdWorkFolder,
  }), {
    tabId: "chat:work-folder-3:new",
    tabToAdd: { id: "chat:work-folder-3:new", kind: "chat", workFolderId: "work-folder-3", conversationId: null, title: "New Chat" },
  });
});

function withStoredTabs(value: string, run: () => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => key === "work-fold.work-folder.surface-tabs.v1" ? value : null,
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

test("identical app revisions keep separate installation tabs and a reinstall cannot inherit an old tab", () => {
  const digest = "a".repeat(64);
  const original = { id: restrictedAppSurfaceTabId("work-folder-1", "mail", digest, "inbox", "feature-installation_original"),
    kind: "restricted-app" as const, workFolderId: "work-folder-1", appId: "mail", digest, featureInstallationId: "feature-installation_original",
    appTabId: "inbox", route: "/", title: "Inbox" };
  const sibling = { ...original, featureInstallationId: "feature-installation_sibling",
    id: restrictedAppSurfaceTabId("work-folder-1", "mail", digest, "inbox", "feature-installation_sibling") };
  assert.notEqual(original.id, sibling.id);
  const catalogue = (ids: string[]) => ({ "work-folder-1": ids.map((featureInstallationId) => ({ manifest: { id: "mail" }, digest, featureInstallationId })) });
  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs([original, sibling], catalogue([original.featureInstallationId, sibling.featureInstallationId]), new Set(["work-folder-1"])), [original, sibling]);
  assert.deepEqual(closeUnavailableRestrictedAppSurfaceTabs([original, sibling], catalogue(["feature-installation_reinstalled", sibling.featureInstallationId]), new Set(["work-folder-1"])), [sibling]);
  const { featureInstallationId: _identity, ...unpinned } = original;
  assert.deepEqual(normalizeStoredSurfaceTabsValue({ tabs: [unpinned], activeTabId: original.id }).tabs, [], "old unpinned tabs cannot attach to whichever installation is present");
});

test("the tab strip tightens early, fades its overflowing edges, and lists every open tab in its menu", async (t) => {
  const { createRequire, registerHooks } = await import("node:module");
  const { createElement } = await import("react");
  const { createDomHarness } = await import("./support/dom.js");
  const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  const assets = registerHooks({
    resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:tab-bar-icons", shortCircuit: true } : next(specifier, context); },
    load(url, context, next) {
      if (url === "test:tab-bar-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
      if (/\.(css|svg|png)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
      return next(url, context);
    },
  });
  const { WorkFolderSurfaceTabBar, surfaceTabCountTier, surfaceTabOverflow } = await import(pathToFileURL(join(process.cwd(), "web-local/src/components/chat/WorkFolderSurfaceTabBar.tsx")).href);
  assets.deregister();

  assert.equal(surfaceTabCountTier(3), "");
  assert.equal(surfaceTabCountTier(4), "tab-count-compact");
  assert.equal(surfaceTabCountTier(6), "tab-count-compact");
  assert.equal(surfaceTabCountTier(7), "tab-count-dense");
  assert.equal(surfaceTabOverflow(0, 600, 600), null);
  assert.equal(surfaceTabOverflow(0, 900, 600), "end");
  assert.equal(surfaceTabOverflow(150, 900, 600), "both");
  assert.equal(surfaceTabOverflow(300, 900, 600), "start");

  const dom = await createDomHarness(); t.after(() => dom.cleanup());
  const scrolled: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) { scrolled.push(this.querySelector("[role=tab]")?.id ?? ""); };
  const workFolder = { id: "work-folder-1", name: "Workshop", workFolderRoot: "/synthetic/workshop", location: { kind: "local", storage: "linked" }, createdAt: "", updatedAt: "" };
  const tabs = Array.from({ length: 6 }, (_, index) => ({ id: `chat:work-folder-1:${index}`, kind: "chat", workFolderId: "work-folder-1", title: `Chat ${index + 1}`, conversationId: `c${index}` }));
  const activated: string[] = [];
  await dom.render(createElement(WorkFolderSurfaceTabBar, {
    tabs, workFolders: [workFolder], workFolderCustomizations: {}, conversations: {}, chatActivityStatuses: {}, activeTabId: tabs[0]!.id, newChatWorkFolderId: "work-folder-1",
    onActivate: (id: string) => { activated.push(id); }, onClose() {}, onReorder() {}, onNewChatInWorkFolder() {}, onChatActions() {},
  }));
  const strip = document.querySelector<HTMLElement>(".surface-tabs")!;
  assert.match(strip.className, /tab-count-compact/);
  assert.equal(strip.hasAttribute("data-overflow"), false, "a strip that fits has no fade");
  assert.ok(scrolled.length > 0, "the active tab is revealed");

  await dom.act(() => document.querySelector<HTMLButtonElement>(".surface-tab-new-chat-trigger")!.click());
  const items = [...document.querySelectorAll<HTMLButtonElement>('#new-chat-work-folder-menu [role="menuitemradio"]')];
  assert.deepEqual(items.map((item) => item.textContent), tabs.map((tab) => tab.title));
  assert.equal(items[0]!.getAttribute("aria-checked"), "true");
  const navigable = [...document.querySelectorAll<HTMLButtonElement>('#new-chat-work-folder-menu [role^="menuitem"]')];
  navigable[0]!.focus();
  await dom.act(() => { document.querySelector("#new-chat-work-folder-menu")!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  assert.equal(document.activeElement, items[0], "arrow keys move from New Chat into the open tabs");
  await dom.act(() => items[3]!.click());
  assert.deepEqual(activated, [tabs[3]!.id]);
  assert.equal(document.querySelector("#new-chat-work-folder-menu"), null, "choosing a tab closes the menu");

  const storedValues = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => storedValues.set(key, value),
    removeItem: (key: string) => storedValues.delete(key),
  } });
  window.localStorage.setItem("work-fold.work-folder.surface-tabs.v1", JSON.stringify({ tabs, activeTabId: tabs[0]!.id }));
  const registeredWorkFolders = [workFolder];
  function Host() {
    const state = useSurfaceTabs({ workFolder, workFolders: registeredWorkFolders });
    return createElement("div", null,
      createElement(WorkFolderSurfaceTabBar, {
        tabs: state.surfaceTabs, workFolders: [workFolder], workFolderCustomizations: {}, conversations: {}, chatActivityStatuses: {}, activeTabId: state.activeSurfaceTabId, newChatWorkFolderId: workFolder.id,
        onActivate: state.setActiveSurfaceTabId, onReorder: state.reorderSurfaceTabs, onClose() {}, onNewChatInWorkFolder() {}, onChatActions() {},
      }),
      state.surfaceTabs.map(tab => createElement("input", { key: tab.id, "data-panel": tab.id, defaultValue: `Draft ${tab.id}` })),
    );
  }
  await dom.render(createElement(Host));
  const firstButton = document.querySelector<HTMLButtonElement>('[role="tab"]')!;
  const draft = document.querySelector<HTMLInputElement>("input")!;
  draft.value = "Unsent message";
  firstButton.focus();
  await dom.press("ArrowRight", { altKey: true, shiftKey: true });
  assert.deepEqual([...document.querySelectorAll("[role=tab]")].map(el => el.textContent), [tabs[1]!.title, tabs[0]!.title, ...tabs.slice(2).map(tab => tab.title)]);
  assert.equal(document.activeElement, firstButton, "keyboard reordering retains focus on the moved tab");
  assert.equal(firstButton.getAttribute("aria-selected"), "true", "reordering preserves selection");
  assert.equal(document.querySelector(`[data-panel="${tabs[0]!.id}"]`), draft, "work surfaces stay mounted");
  assert.equal(draft.value, "Unsent message");
  assert.match(document.querySelector('[role="status"]')!.textContent!, /position 2 of 6/);
  const stored = JSON.parse(window.localStorage.getItem("work-fold.work-folder.surface-tabs.v1")!);
  assert.deepEqual(stored.tabs.map((tab: SurfaceTab) => tab.id), [tabs[1]!.id, tabs[0]!.id, ...tabs.slice(2).map(tab => tab.id)]);
  assert.equal(stored.activeTabId, tabs[0]!.id);
});
