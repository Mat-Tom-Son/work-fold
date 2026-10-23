import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createBrowserTools, browserToolNames, describeBrowserTab } from "../src/local/agent/browser-tools.js";
import { parseBrowserKey, parseBrowserKeys } from "../src/shared/browser-keys.js";
import { backendNodeIdForRef, findInSnapshot, formatAccessibilitySnapshot, type AccessibilityNode } from "../src/shared/browser-snapshot.js";
import { BrowserHistoryStore, historyUrl } from "../desktop/src/browser-history.js";
import { BrowserSitePermissionStore, isSiteOrigin } from "../desktop/src/browser-site-permissions.js";
import { describeJobForModel } from "../src/local/agent/job-tools.js";
import { localServerAddress } from "../src/local/jobs/job-output.js";
import type { WorkFoldJobRecord } from "../src/local/jobs/job-records.js";
import { localServerHref } from "../web-local/src/lib/browser-links.js";
import {
  browserAddressFor,
  browserDisplayAddress,
  browserPermissionPhrase,
  browserUserAgent,
  isBrowserPageId,
  isBrowserUrl,
  permissionKinds,
  siteOrigin,
  type BrowserTabSummary,
  type BrowserToolHost,
} from "../src/shared/browser.js";
import type { WorkFolderSurfaceTab } from "../web-local/src/types";

const surfaceTabsModuleUrl = pathToFileURL(join(process.cwd(), "web-local/src/hooks/useSurfaceTabs.ts")).href;
const surfaceTabs = await import(surfaceTabsModuleUrl) as {
  browserSurfaceTab: (pageId: string, url: string, title?: string) => WorkFolderSurfaceTab;
  browserTabTitle: (title: string, url: string) => string;
  normalizeStoredSurfaceTabsValue: (value: unknown) => { tabs: WorkFolderSurfaceTab[]; activeTabId: string | null };
  restoreStoredSurfaceTabsForWorkFolders: (state: { tabs: WorkFolderSurfaceTab[]; activeTabId: string | null }, workFolders: Array<{ id: string }>) => { tabs: WorkFolderSurfaceTab[]; activeTabId: string | null };
  surfaceTabWorkFolderSwitchTarget: (input: { activeTabId: string | null; activeWorkFolderId: string; tabs: WorkFolderSurfaceTab[]; workFolders: Array<{ id: string; name: string }> }) => { id: string } | null;
  recordActiveSurfaceTabWorkFolderRecency: (recent: Map<string, string>, tabs: WorkFolderSurfaceTab[], activeTabId: string | null) => void;
};

test("the address bar turns hosts, local servers, and files into addresses and everything else into a search", () => {
  assert.equal(browserAddressFor("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(browserAddressFor("  example.com  "), "https://example.com");
  assert.equal(browserAddressFor("news.example.co.uk/today"), "https://news.example.co.uk/today");
  assert.equal(browserAddressFor("example.com:8080/x"), "https://example.com:8080/x");
  assert.equal(browserAddressFor("localhost:3000"), "http://localhost:3000");
  assert.equal(browserAddressFor("localhost"), "http://localhost");
  assert.equal(browserAddressFor("127.0.0.1:5173/app"), "http://127.0.0.1:5173/app");
  assert.equal(browserAddressFor("/Users/me/My Site/index.html"), "file:///Users/me/My%20Site/index.html");
  assert.equal(browserAddressFor("about:blank"), "about:blank");
  assert.equal(browserAddressFor("mailto:someone@example.com"), "mailto:someone@example.com");
  assert.equal(browserAddressFor("weather tomorrow"), "https://www.google.com/search?q=weather%20tomorrow");
  assert.equal(browserAddressFor("typescript"), "https://www.google.com/search?q=typescript");
  assert.equal(browserAddressFor("a.b"), "https://www.google.com/search?q=a.b", "a one-letter ending is not a domain");
  assert.equal(browserAddressFor("javascript:alert(1)"), "https://www.google.com/search?q=javascript%3Aalert(1)", "script addresses are never run from the address bar");
  assert.equal(browserAddressFor("   "), null);
});

test("browser tabs show only web pages, files, and a blank page", () => {
  assert.equal(isBrowserUrl("https://example.com/"), true);
  assert.equal(isBrowserUrl("http://localhost:3000/"), true);
  assert.equal(isBrowserUrl("file:///Users/me/index.html"), true);
  assert.equal(isBrowserUrl("about:blank"), true);
  assert.equal(isBrowserUrl("about:settings"), false);
  assert.equal(isBrowserUrl("javascript:alert(1)"), false);
  assert.equal(isBrowserUrl("mailto:someone@example.com"), false);
  assert.equal(isBrowserUrl("work-fold-desktop://app/index.html"), false);
  assert.equal(isBrowserUrl("chrome://settings"), false);
  assert.equal(isBrowserUrl("not a url"), false);
  assert.equal(browserDisplayAddress("about:blank"), "");
  assert.equal(isBrowserPageId("k3j9x2"), true);
  assert.equal(isBrowserPageId("browser:k3j9x2"), false);
  assert.equal(isBrowserPageId("abc"), false);
});

test("a page's structure lists text, headings, and usable elements with refs, without empty containers", () => {
  const nodes: AccessibilityNode[] = [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Shop" }, childIds: ["2", "3", "8", "12", "14"], backendDOMNodeId: 1 },
    { nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Welcome  back" }, properties: [{ name: "level", value: { value: 1 } }], childIds: ["20"], backendDOMNodeId: 5 },
    { nodeId: "20", parentId: "2", role: { value: "StaticText" }, name: { value: "Welcome back" } },
    { nodeId: "3", parentId: "1", role: { value: "generic" }, childIds: ["4", "5"], backendDOMNodeId: 6 },
    { nodeId: "4", parentId: "3", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "ada@example.com" }, properties: [{ name: "focusable", value: { value: true } }, { name: "required", value: { value: true } }], backendDOMNodeId: 9 },
    { nodeId: "5", parentId: "3", role: { value: "checkbox" }, name: { value: "Remember me" }, properties: [{ name: "checked", value: { value: "false" } }], backendDOMNodeId: 10 },
    { nodeId: "8", parentId: "1", role: { value: "paragraph" }, childIds: ["9", "10"], backendDOMNodeId: 11 },
    { nodeId: "9", parentId: "8", role: { value: "StaticText" }, name: { value: "Free shipping" } },
    { nodeId: "10", parentId: "8", role: { value: "generic" }, ignored: true, childIds: ["11"] },
    { nodeId: "11", parentId: "10", role: { value: "StaticText" }, name: { value: "over $50" } },
    { nodeId: "12", parentId: "1", role: { value: "link" }, name: { value: "Your orders" }, properties: [{ name: "url", value: { value: "https://shop.example/orders" } }], backendDOMNodeId: 21 },
    { nodeId: "14", parentId: "1", role: { value: "button" }, name: { value: "Sign in" }, properties: [{ name: "disabled", value: { value: true } }], childIds: ["15"], backendDOMNodeId: 30 },
    { nodeId: "15", parentId: "14", role: { value: "StaticText" }, name: { value: "Sign in" } },
  ];
  const snapshot = formatAccessibilitySnapshot(nodes);
  assert.equal(snapshot, [
    "- heading \"Welcome back\" [level=1]",
    "- textbox \"Email\" [required] value=\"ada@example.com\" [ref=e9]",
    "- checkbox \"Remember me\" [unchecked] [ref=e10]",
    "- paragraph: Free shipping over $50",
    "- link \"Your orders\" → https://shop.example/orders [ref=e21]",
    "- button \"Sign in\" [disabled] [ref=e30]",
  ].join("\n"));
  assert.equal(findInSnapshot(snapshot, "SIGN"), "- button \"Sign in\" [disabled] [ref=e30]");
  assert.equal(backendNodeIdForRef("e30"), 30);
  assert.equal(backendNodeIdForRef(" e7 "), 7);
  assert.equal(backendNodeIdForRef("30"), null);
  assert.equal(backendNodeIdForRef("e0"), null);
  assert.equal(formatAccessibilitySnapshot([]), "");
});

test("keys parse to the protocol's key presses, with macOS editing commands", () => {
  assert.deepEqual(parseBrowserKey("Enter"), { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
  assert.deepEqual(parseBrowserKey("Shift+Tab"), { key: "Tab", code: "Tab", keyCode: 9, modifiers: 8 });
  assert.deepEqual(parseBrowserKey("Meta+A"), { key: "a", code: "KeyA", keyCode: 65, modifiers: 4, commands: ["selectAll"] }, "a capital letter does not add Shift");
  assert.deepEqual(parseBrowserKey("Cmd+Shift+Z").commands, ["redo"]);
  assert.deepEqual(parseBrowserKey("Shift+a"), { key: "A", code: "KeyA", keyCode: 65, text: "A", modifiers: 8 });
  assert.deepEqual(parseBrowserKey("Control++"), { key: "+", code: "Equal", keyCode: 187, modifiers: 10 });
  assert.equal(parseBrowserKey("F5").keyCode, 116);
  assert.equal(parseBrowserKey("Shift+/").text, "?");
  assert.deepEqual(parseBrowserKeys("Tab  Tab Enter").map((press) => press.key), ["Tab", "Tab", "Enter"]);
  assert.throws(() => parseBrowserKey("Hyper+Q"), /not a modifier/);
  assert.throws(() => parseBrowserKey("Banana"), /not a key this browser knows/);
  assert.throws(() => parseBrowserKeys("  "), /at least one key/);
});

test("the browser tools name tabs plainly and follow the tab a Chat used", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const tabs: BrowserTabSummary[] = [
    { tab: "mine01", url: "https://example.com/", title: "Example", loading: false, viewing: true },
  ];
  const opened: BrowserTabSummary = { tab: "work01", url: "https://docs.example/", title: "Docs", loading: false, viewing: false };
  const host = {
    tabs: async () => tabs,
    open: async (input) => { calls.push({ method: "open", input }); tabs.push(opened); return opened; },
    read: async (input) => { calls.push({ method: "read", input }); return { tab: tabs.find((tab) => tab.tab === input.tab)!, text: "- heading \"Docs\"", total: 120_000, nextOffset: 50_000 }; },
    screenshot: async (input) => { calls.push({ method: "screenshot", input }); return { tab: opened, data: "AAAA", mimeType: "image/jpeg", width: 1280, height: 800 }; },
    click: async (input) => { calls.push({ method: "click", input }); return { tab: opened, navigated: true }; },
    close: async (input) => { calls.push({ method: "close", input }); },
  } as Partial<BrowserToolHost> as BrowserToolHost;
  const tools = new Map(createBrowserTools({ host }).map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], [...browserToolNames]);
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute("call", params as never, undefined as never, undefined as never, undefined as never) as { content: Array<{ type: string; text?: string; data?: string }> };
    return result;
  };

  // With nothing used yet, the default tab is the one the person is looking at.
  const firstRead = await run("browser_read", {});
  assert.deepEqual(calls.at(-1), { method: "read", input: { tab: "mine01", mode: "structure" } });
  assert.match(firstRead.content[0]!.text!, /^Tab mine01 "Example" · https:\/\/example\.com\/ \(the person is looking at it\)/);
  assert.match(firstRead.content[0]!.text!, /Read on with offset 50000\./);

  await run("browser_open", { url: "docs.example" });
  assert.deepEqual(calls.at(-1), { method: "open", input: { url: "docs.example" } });
  await run("browser_read", { find: "docs", offset: 50_000 });
  assert.deepEqual(calls.at(-1), { method: "read", input: { tab: "work01", mode: "structure", find: "docs", offset: 50_000 } }, "a Chat keeps using the tab it opened");

  const clicked = await run("browser_click", { ref: "e12" });
  assert.match(clicked.content[0]!.text!, /^Clicked e12\.\n.*\nIt led to a new page; read it again/s);

  const shot = await run("browser_screenshot", {});
  assert.equal(shot.content[1]!.type, "image");
  assert.equal(shot.content[1]!.data, "AAAA");

  await run("browser_close", { tab: "work01" });
  assert.deepEqual(calls.at(-1), { method: "close", input: { tab: "work01" } });

  // A Chat's tools carry its identity, so the tabs it opens are its own to close.
  const owned = new Map(createBrowserTools({ host, owner: "wf-1/chat-1" }).map((tool) => [tool.name, tool]));
  await owned.get("browser_open")!.execute("call", { url: "docs.example" } as never, undefined as never, undefined as never, undefined as never);
  assert.deepEqual(calls.at(-1), { method: "open", input: { url: "docs.example", owner: "wf-1/chat-1" } });
  await owned.get("browser_close")!.execute("call", { tab: "work01" } as never, undefined as never, undefined as never, undefined as never);
  assert.deepEqual(calls.at(-1), { method: "close", input: { tab: "work01", owner: "wf-1/chat-1" } });

  const empty = createBrowserTools({ host: { ...host, tabs: async () => [] } });
  await assert.rejects(
    empty.find((tool) => tool.name === "browser_read")!.execute("call", {} as never, undefined as never, undefined as never, undefined as never) as Promise<unknown>,
    /No browser tab is in use yet/,
  );
  assert.equal(describeBrowserTab({ tab: "t1abcd", url: "", title: "", loading: true, viewing: false, error: "net::ERR_NAME_NOT_RESOLVED (https://nowhere.invalid/)" }),
    "Tab t1abcd · blank (still loading)\nThe page did not load: net::ERR_NAME_NOT_RESOLVED (https://nowhere.invalid/)");
});

test("browser tabs survive a restart and belong to no work-folder", () => {
  const browser = surfaceTabs.browserSurfaceTab("k3j9x2", "https://example.com/docs", "");
  assert.deepEqual(browser, { id: "browser:k3j9x2", kind: "browser", workFolderId: null, pageId: "k3j9x2", url: "https://example.com/docs", title: "example.com" });
  const chat: WorkFolderSurfaceTab = { id: "chat:wf1:new", kind: "chat", workFolderId: "wf1", conversationId: null, title: "New Chat" };
  const stored = surfaceTabs.normalizeStoredSurfaceTabsValue(JSON.parse(JSON.stringify({
    tabs: [chat, { ...browser, title: "Docs" }, { kind: "browser", id: "browser:bad", pageId: "BAD ID", url: "", title: "x", workFolderId: null }],
    activeTabId: "browser:k3j9x2",
  })));
  assert.deepEqual(stored.tabs.map((tab) => tab.id), ["chat:wf1:new", "browser:k3j9x2"]);
  assert.equal(stored.activeTabId, "browser:k3j9x2");

  // Removing every work-folder the tabs belonged to leaves the browser tabs open.
  const restored = surfaceTabs.restoreStoredSurfaceTabsForWorkFolders(stored, [{ id: "wf2" }]);
  assert.deepEqual(restored.tabs.map((tab) => tab.id), ["browser:k3j9x2"]);

  // Selecting a browser tab keeps the open work-folder, and is never a work-folder's most recent tab.
  assert.equal(surfaceTabs.surfaceTabWorkFolderSwitchTarget({ activeTabId: "browser:k3j9x2", activeWorkFolderId: "wf2", tabs: stored.tabs, workFolders: [{ id: "wf1", name: "One" }, { id: "wf2", name: "Two" }] }), null);
  const recent = new Map<string, string>();
  surfaceTabs.recordActiveSurfaceTabWorkFolderRecency(recent, stored.tabs, "browser:k3j9x2");
  assert.equal(recent.size, 0);

  assert.equal(surfaceTabs.browserTabTitle("", ""), "New Tab");
  assert.equal(surfaceTabs.browserTabTitle("  Docs  ", "https://example.com/"), "Docs");
  assert.equal(surfaceTabs.browserTabTitle("", "file:///Users/me/My%20Site/index.html"), "index.html");
});

test("the tab strip offers a browser tab beside New Chat, and Workers get the tools in every session", async () => {
  const tabBar = await readFile("web-local/src/components/chat/WorkFolderSurfaceTabBar.tsx", "utf8");
  assert.match(tabBar, /aria-label="Open a browser tab"/);
  assert.match(tabBar, /surface-tab-new-browser[\s\S]*surface-tab-new-chat/, "the browser button sits beside New Chat");
  const piClient = await readFile("src/local/agent/pi-client.ts", "utf8");
  assert.match(piClient, /this\.options\.browser \? createBrowserTools\(\{ host: this\.options\.browser, \.\.\.\(this\.options\.browserOwner \? \{ owner: this\.options\.browserOwner \} : \{\}\) \}\)/);
  const server = await readFile("src/local/server.ts", "utf8");
  assert.match(server, /\.\.\.\(state\.browser \? \{ browser: state\.browser, browserOwner: `\$\{workFolderId\}\/\$\{conversationId\}` \} : \{\}\)/, "every scope, the work-fold agent included, gets the browser, with its own Chat identity");
  const main = await readFile("desktop/src/main.ts", "utf8");
  assert.match(main, /browser: ensureBuiltInBrowser\(\)\.toolHost/);
  // Pages never receive the app's preload or desktop powers.
  const host = await readFile("desktop/src/built-in-browser.ts", "utf8");
  assert.doesNotMatch(host, /preload:/);
  assert.match(host, /sandbox: true,\n\s+contextIsolation: true,\n\s+nodeIntegration: false/);
});

test("the browser names itself the way Claude's browser does, so Google's sign-in accepts it", () => {
  assert.equal(
    browserUserAgent("work-fold/0.13.0", "darwin", "148.0.7778.280"),
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) work-fold/0.13.0 Chrome/148.0.7778.280 Safari/537.36",
  );
  assert.match(browserUserAgent("work-fold/0.13.0", "win32", "148.0.1.2"), /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) .* work-fold\/0\.13\.0 Chrome\/148\.0\.1\.2 Safari\/537\.36$/);
  assert.doesNotMatch(browserUserAgent("work-fold/0.13.0"), /Electron/);
  // A malformed product token is left out rather than breaking the header.
  assert.doesNotMatch(browserUserAgent("work fold Local Smoke/1", "darwin", "148.0.0.1"), /Local Smoke/);
});

test("sites ask in plain words, and only for the kinds of access a person decides", () => {
  assert.equal(browserPermissionPhrase(["microphone", "camera"]), "use your camera and microphone");
  assert.equal(browserPermissionPhrase(["location"]), "know your location");
  assert.equal(browserPermissionPhrase(["notifications", "location", "camera"]), "use your camera, know your location and show notifications");
  assert.deepEqual(permissionKinds("media", ["audio", "video"]), ["camera", "microphone"]);
  assert.deepEqual(permissionKinds("media", ["audio"]), ["microphone"]);
  assert.deepEqual(permissionKinds("media", []), []);
  assert.deepEqual(permissionKinds("geolocation", []), ["location"]);
  assert.deepEqual(permissionKinds("clipboard-read", []), ["clipboard"]);
  assert.deepEqual(permissionKinds("openExternal", []), [], "anything else is never asked about");
  assert.equal(siteOrigin("https://meet.google.com/abc-defg-hij?authuser=0"), "https://meet.google.com");
  assert.equal(siteOrigin("file:///Users/me/index.html"), null);
  assert.equal(isSiteOrigin("https://meet.google.com"), true);
  assert.equal(isSiteOrigin("https://meet.google.com/"), false);
});

test("site decisions are saved per site and kind, forgotten on request, and a damaged file asks again", async () => {
  const folder = await mkdtemp(join(tmpdir(), "browser-site-permissions-"));
  try {
    const path = join(folder, "browser-site-permissions.json");
    const store = new BrowserSitePermissionStore(path);
    await store.set("https://meet.google.com", ["camera", "microphone"], "allow");
    await store.set("https://ads.example", ["notifications"], "block");
    await store.set("file:///etc", ["camera"], "allow");
    assert.equal(store.get("https://meet.google.com", "camera"), "allow");
    assert.equal(store.get("https://meet.google.com", "location"), null);
    assert.deepEqual(new BrowserSitePermissionStore(path).forSite("https://meet.google.com"), [{ kind: "camera", decision: "allow" }, { kind: "microphone", decision: "allow" }]);
    await store.forget("https://meet.google.com", "camera");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, sites: { "https://meet.google.com": { microphone: "allow" }, "https://ads.example": { notifications: "block" } } });
    await writeFile(path, "{ not json");
    assert.deepEqual(new BrowserSitePermissionStore(path).forSite("https://ads.example"), []);
    await writeFile(path, JSON.stringify({ version: 1, sites: { "https://ok.example": { camera: "allow", teleport: "allow", microphone: "maybe" }, "javascript:alert(1)": { camera: "allow" } } }));
    assert.deepEqual(new BrowserSitePermissionStore(path).forSite("https://ok.example"), [{ kind: "camera", decision: "allow" }]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("history remembers visited pages, suggests what was typed best-first, and clears", async () => {
  const folder = await mkdtemp(join(tmpdir(), "browser-history-"));
  try {
    const path = join(folder, "browser-history.json");
    let now = new Date("2026-10-23T12:00:00Z");
    const history = new BrowserHistoryStore(path, { now: () => now });
    history.record("https://news.example.com/today#top", "Today's news");
    history.record("https://docs.example.org/guide", "Example guide");
    history.record("https://www.github.com/work-fold", "work-fold on GitHub");
    now = new Date("2026-10-23T12:05:00Z");
    history.record("https://docs.example.org/guide");
    history.record("chrome://settings", "Settings");
    history.retitle("https://news.example.com/today", "Today's headlines");
    assert.equal(history.size, 3, "web pages only, one entry per address without its fragment");
    assert.deepEqual(history.recent().map((entry) => entry.url), ["https://docs.example.org/guide", "https://www.github.com/work-fold", "https://news.example.com/today"]);
    assert.equal(history.recent()[0]!.visits, 2);
    assert.equal(history.recent()[0]!.title, "Example guide", "a visit without a title keeps the one it had");
    assert.deepEqual(history.suggest("git").map((entry) => entry.url), ["https://www.github.com/work-fold"], "an address that starts with the text, ignoring www");
    assert.deepEqual(history.suggest("example").map((entry) => entry.url), ["https://docs.example.org/guide", "https://news.example.com/today"], "more visits rank higher");
    assert.deepEqual(history.suggest("today headlines").map((entry) => entry.url), ["https://news.example.com/today"], "every word must match the address or title");
    assert.deepEqual(history.suggest("   "), []);
    await history.flush();
    const reopened = new BrowserHistoryStore(path);
    assert.deepEqual(reopened.recent().map((entry) => entry.title), ["Example guide", "work-fold on GitHub", "Today's headlines"]);
    await reopened.clear();
    assert.equal(new BrowserHistoryStore(path).size, 0);
    await writeFile(path, "not json");
    assert.equal(new BrowserHistoryStore(path).size, 0, "a damaged file starts empty");
    assert.equal(historyUrl("https://example.com/a#b"), "https://example.com/a");
    assert.equal(historyUrl("file:///Users/me/a.html"), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a job's own announcement of a local server reaches the Worker, and Chat links to it open as browser tabs", () => {
  assert.equal(localServerAddress("\u001b[32m  ➜  Local:   \u001b[1mhttp://localhost:5173/\u001b[22m\n"), "http://localhost:5173/");
  assert.equal(localServerAddress("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."), "http://localhost:8000/");
  assert.equal(localServerAddress("Listening on http://127.0.0.1:3000."), "http://127.0.0.1:3000/");
  assert.equal(localServerAddress("ready - started server on [::]:3000, url: http://[::1]:3000"), "http://[::1]:3000/");
  assert.equal(localServerAddress("Deployed to https://example.com"), null, "only this computer");
  const job = {
    jobId: "job_1", name: "Dev server", state: "running", exitCode: null, signal: null, stoppedBy: null, error: null,
    startedAt: "2026-10-23T12:00:00Z", endedAt: null, createdAt: "2026-10-23T12:00:00Z", pid: 42, history: null, serving: "http://localhost:5173/",
  } as unknown as WorkFoldJobRecord;
  assert.match(describeJobForModel(job, null, new Date("2026-10-23T12:00:10Z")), /It is serving http:\/\/localhost:5173\/\. Look at it with browser_open/);
  assert.equal(localServerHref("http://localhost:5173/app"), "http://localhost:5173/app");
  assert.equal(localServerHref("http://0.0.0.0:8000/"), "http://localhost:8000/");
  assert.equal(localServerHref("http://my-app.localhost:3000/"), "http://my-app.localhost:3000/");
  assert.equal(localServerHref("https://example.com/"), null);
  assert.equal(localServerHref("file:///etc/hosts"), null);
});
