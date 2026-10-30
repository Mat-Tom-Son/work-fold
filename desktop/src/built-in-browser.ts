/**
 * The built-in browser's desktop host (docs/built-in-browser.md). It owns one
 * Chromium page per browser tab, all sharing one persistent profile, and
 * shows a page over its tab's placeholder in the main window the same way
 * app views are shown. Pages outlive their placeholder: a tab in the
 * background, a window that closes and reopens, and a page only a Worker
 * is using all keep running.
 *
 * Workers drive pages through the Chrome DevTools Protocol on Electron's own
 * debugger, so the browser needs no extension and no setup. Attaching the
 * debugger with focus emulation also makes a background page render and
 * take input as if it were in front; it detaches after a quiet period.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import {
  BrowserWindow,
  Menu,
  WebContentsView,
  clipboard,
  dialog,
  nativeImage,
  screen,
  shell,
  systemPreferences,
  session as electronSession,
  type BrowserWindowConstructorOptions,
  type ContextMenuParams,
  type Debugger,
  type HandlerDetails,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Rectangle,
  type Session,
  type WebContents,
  type WebContentsViewConstructorOptions,
  type WindowOpenHandlerResponse,
} from "electron";

import { BrowserHistoryStore, type BrowserHistoryEntry } from "./browser-history.js";
import { BrowserStatusBubble } from "./browser-status-bubble.js";
import { macSpellingGuesses } from "./mac-spelling.js";
import { BrowserSitePermissionStore } from "./browser-site-permissions.js";
import { parseBrowserKeys, type BrowserKeyPress } from "../../src/shared/browser-keys.js";
import { backendNodeIdForRef, findInSnapshot, formatAccessibilitySnapshot, type AccessibilityNode } from "../../src/shared/browser-snapshot.js";
import {
  browserAddressFor,
  browserPartition,
  browserPermissionPhrase,
  browserUserAgent,
  bubbleText,
  permissionKinds,
  siteOrigin,
  browserSearchUrl,
  browserSitePermissions,
  isBrowserPageId,
  isBrowserUrl,
  type BrowserPermissionRequest,
  type BrowserSiteDecision,
  type BrowserSitePermission,
  type BrowserActionResult,
  type BrowserDownload,
  type BrowserDownloadRecord,
  type BrowserTarget,
  type BrowserFindResult,
  type BrowserOpenTabCommand,
  type BrowserPageState,
  type BrowserShortcut,
  type BrowserTabMenuCommand,
  type BrowserTabSummary,
  type BrowserTabsSync,
  type BrowserToolHost,
  type BrowserViewRequest,
} from "../../src/shared/browser.js";

export const browserChannels = {
  state: "work-fold:browser:state",
  openTab: "work-fold:browser:open-tab",
  closeTab: "work-fold:browser:close-tab",
  shortcut: "work-fold:browser:shortcut",
  findResult: "work-fold:browser:find-result",
  download: "work-fold:browser:download",
} as const;

export type BrowserCommand =
  | { type: "back" | "forward" | "reload" | "stop" | "focus" | "stop-find" | "inspect" | "zoom-in" | "zoom-out" | "zoom-reset" | "dismiss-notice" | "print" | "save-pdf" | "open-blocked-popup" | "allow-popups" | "dismiss-blocked-popup" }
  | { type: "mute"; muted: boolean }
  | { type: "find"; text: string; forward: boolean; newSearch: boolean }
  | { type: "forget-permission" | "open-privacy-settings"; kind: BrowserSitePermission };

export interface BuiltInBrowserOptions {
  /** The window browser tabs show in; null while there is none. */
  window: () => BrowserWindow | null;
  /** Delivers an event to the main window's renderer, when there is one. */
  send: (channel: (typeof browserChannels)[keyof typeof browserChannels], payload: unknown) => void;
  openExternal: (url: string) => Promise<void>;
  downloadsPath: () => string;
  /** The file that keeps what the person allowed or blocked for each site. */
  sitePermissionsPath: string;
  /** The file that keeps the pages browser tabs visited. */
  historyPath: string;
  /** The app's own product token for the user agent, such as `work-fold/0.13.0`. */
  userAgentProduct: string;
  /** Runs after a page joins the window, so host overlays stay above it. */
  onViewAttached?: () => void;
  partition?: string;
}

interface BrowserPage {
  pageId: string;
  view: WebContentsView;
  openedBy: "person" | "agent";
  /** The Chat that opened an agent tab; only it may close the tab. */
  owner: string | null;
  /** The end of this page's queue of Worker input operations. */
  operations: Promise<void>;
  favicon: string | null;
  faviconUrl: string | null;
  error: BrowserPageState["error"];
  crashed: boolean;
  layout: { sequence: number; bounds: Rectangle; active: boolean; occluded: boolean } | null;
  attachedTo: BrowserWindow | null;
  console: string[];
  debuggerReady: Promise<Debugger> | null;
  debuggerIdle: ReturnType<typeof setTimeout> | null;
  fullscreen: { restoreWindowFullScreen: boolean } | null;
  /** When the renderer was last asked to show this page as a tab. */
  announcedAt: number;
  closed: boolean;
  /** The site's questions for the person, oldest first; the first one shows. */
  permissions: Array<{ request: BrowserPermissionRequest; resolve: (decision: BrowserSiteDecision | null) => void }>;
  /** Why something the person allowed still cannot work, such as macOS keeping the camera off. */
  notice: { kind: BrowserSitePermission; text: string } | null;
  /** When a person, or a Worker's click or key, last pressed something in the page: what lets it open a tab or pop-up. */
  lastInputAt: number;
  blockedPopup: BrowserPageState["blockedPopup"];
  /** The Chat whose Worker is using the page, kept a moment after its last step so the marker does not flicker. */
  worker: { owner: string } | null;
  workerSteps: Map<string, number>;
  workerLinger: ReturnType<typeof setTimeout> | null;
}

/** A page a Worker opened but no window has shown yet still lays out at this size. */
const defaultPageSize = { width: 1280, height: 800 };
const agentIdleDetachMs = 120_000;
const navigationTimeoutMs = 30_000;
const actionSettleMs = 10_000;
const readChunkLength = 50_000;
const consoleLimit = 300;
const fullPageMaxHeight = 8_000;
const isolatedWorldId = 1_001;
/** A page may open a tab or pop-up this long after a press, as Chrome allows after a click. */
const popupGestureMs = 5_000;
/** How long the Worker marker stays after a Worker's last step on a page. */
const workerLingerMs = 3_000;
const gestureInputTypes = new Set(["mouseDown", "keyDown", "rawKeyDown", "touchStart", "gestureTap"]);
/** Granted without asking, as Chrome does: full screen, writing what the page copies, pointer and keyboard lock, saving to a file the person picked, and protected media. */
const silentPermissions = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock", "keyboardLock", "fileSystem", "mediaKeySystem", "speaker-selection", "storage-access", "top-level-storage-access", "display-capture"]);

export class BuiltInBrowser {
  readonly session: Session;
  readonly toolHost: BrowserToolHost;
  readonly #options: BuiltInBrowserOptions;
  readonly #pages = new Map<string, BrowserPage>();
  /** Files this browser downloaded during this run: the only paths it shows in the file manager. */
  readonly #downloads = new Set<string>();
  readonly #downloadRecords = new Map<string, BrowserDownloadRecord>();
  /** Paths downloads are still writing to, so two downloads never share one. */
  readonly #pendingDownloads = new Set<string>();
  readonly #sitePermissions: BrowserSitePermissionStore;
  readonly #history: BrowserHistoryStore;
  readonly #bubble = new BrowserStatusBubble();
  #backgroundWindow: BrowserWindow | null = null;
  readonly #backgroundPages = new Set<BrowserPage>();
  #synced: BrowserTabsSync = { tabs: [], viewingPageId: null };

  constructor(options: BuiltInBrowserOptions) {
    this.#options = options;
    this.#sitePermissions = new BrowserSitePermissionStore(options.sitePermissionsPath);
    this.#history = new BrowserHistoryStore(options.historyPath);
    this.session = electronSession.fromPartition(options.partition ?? browserPartition);
    this.#configureSession();
    this.toolHost = this.#createToolHost();
  }

  // ── Renderer-facing operations ────────────────────────────────────────────

  /** Shows a tab's page over its placeholder, creating it from its address when needed. */
  mount(request: BrowserViewRequest): BrowserPageState | null {
    const page = this.#pages.get(request.pageId) ?? (request.url ? this.#createPage(request.pageId, request.url, "person") : null);
    if (!page) return null;
    this.#applyRequest(page, request);
    return this.#state(page);
  }

  layout(request: BrowserViewRequest): void {
    const page = this.#pages.get(request.pageId);
    if (page) this.#applyRequest(page, request);
  }

  /** The placeholder went away (its tab closed or the window reloaded); the page keeps running. */
  detach(pageId: string): void {
    const page = this.#pages.get(pageId);
    if (!page) return;
    page.layout = null;
    this.#hide(page);
  }

  navigate(pageId: string, input: string): BrowserPageState {
    const url = browserAddressFor(input);
    if (!url) throw new Error("Type an address or something to search for.");
    const existing = this.#pages.get(pageId);
    if (!existing) return this.#state(this.#createPage(pageId, url, "person"));
    this.#load(existing, url);
    return this.#state(existing);
  }

  command(pageId: string, command: BrowserCommand): void {
    const page = this.#pages.get(pageId);
    if (!page) return;
    const contents = page.view.webContents;
    switch (command.type) {
      case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload":
        page.error = null;
        page.crashed = false;
        contents.reload();
        break;
      case "stop": contents.stop(); break;
      case "focus": contents.focus(); break;
      // Electron's findNext means "start a new search", not "go to the next match".
      case "find": if (command.text) contents.findInPage(command.text, { forward: command.forward, findNext: command.newSearch }); break;
      case "stop-find": contents.stopFindInPage("clearSelection"); break;
      case "inspect": contents.openDevTools({ mode: "detach" }); break;
      // Zoom belongs to a site, so every tab showing it changes together.
      case "zoom-in": contents.setZoomLevel(Math.min(contents.getZoomLevel() + 0.5, 5)); this.#emitAll(); break;
      case "zoom-out": contents.setZoomLevel(Math.max(contents.getZoomLevel() - 0.5, -5)); this.#emitAll(); break;
      case "zoom-reset": contents.setZoomLevel(0); this.#emitAll(); break;
      case "mute":
        contents.setAudioMuted(command.muted);
        this.#emit(page);
        break;
      case "print": this.#print(page); break;
      case "save-pdf": void this.#savePdf(page); break;
      case "open-blocked-popup":
      case "allow-popups": {
        const blocked = page.blockedPopup;
        page.blockedPopup = null;
        const origin = blocked?.origin ?? null;
        if (command.type === "allow-popups" && origin) void this.#sitePermissions.set(origin, ["popups"], "allow").then(() => this.#emitSite(origin));
        if (blocked) this.#openTab(blocked.url, true, page.openedBy, page.owner);
        this.#emit(page);
        break;
      }
      case "dismiss-blocked-popup":
        page.blockedPopup = null;
        this.#emit(page);
        break;
      case "dismiss-notice":
        page.notice = null;
        this.#emit(page);
        break;
      case "forget-permission": {
        const origin = siteOrigin(contents.getURL());
        if (origin) void this.#sitePermissions.forget(origin, command.kind).then(() => this.#emitSite(origin));
        break;
      }
      case "open-privacy-settings": void this.#openPrivacySettings(command.kind); break;
    }
  }

  /**
   * A browser tab's right-click menu. The page's own actions run here; the
   * tab strip's (duplicate, close, reopen) are handed back to the renderer.
   */
  popupTabMenu(pageId: string, url: string, point: { x: number; y: number }, options: { canReopen: boolean; hasOthers: boolean }): Promise<BrowserTabMenuCommand | null> {
    const window = this.#options.window();
    if (!window) return Promise.resolve(null);
    const page = this.#pages.get(pageId);
    const contents = page && !page.view.webContents.isDestroyed() ? page.view.webContents : null;
    const address = contents?.getURL() || url;
    const web = /^https?:/i.test(address);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (command: BrowserTabMenuCommand | null) => {
        if (settled) return;
        settled = true;
        resolve(command);
      };
      const template: MenuItemConstructorOptions[] = [
        { label: "Reload", enabled: Boolean(page), click: () => this.command(pageId, { type: "reload" }) },
        { label: "Duplicate", enabled: Boolean(address), click: () => finish("duplicate") },
        { type: "separator" },
        { label: "Copy Address", enabled: Boolean(address), click: () => clipboard.writeText(address) },
        { label: "Open in Your Web Browser", enabled: web, click: () => { void this.#options.openExternal(address).catch(() => undefined); } },
        { type: "separator" },
        contents?.isAudioMuted()
          ? { label: "Unmute Tab", click: () => this.command(pageId, { type: "mute", muted: false }) }
          : { label: "Mute Tab", enabled: Boolean(page), click: () => this.command(pageId, { type: "mute", muted: true }) },
        { label: "Print…", enabled: Boolean(page), click: () => this.command(pageId, { type: "print" }) },
        { label: "Save as PDF…", enabled: Boolean(page), click: () => this.command(pageId, { type: "save-pdf" }) },
        { type: "separator" },
        { label: "Close Tab", click: () => finish("close") },
        { label: "Close Other Browser Tabs", enabled: options.hasOthers, click: () => finish("close-others") },
        { label: "Reopen Closed Tab", enabled: options.canReopen, click: () => finish("reopen-closed") },
      ];
      // The point is in the app's CSS pixels; the menu goes where the pointer is in the zoomed window.
      const zoom = window.webContents.getZoomFactor() || 1;
      Menu.buildFromTemplate(template).popup({ window, x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), callback: () => setTimeout(() => finish(null), 0) });
    });
  }

  /** The person answered a site's question in the tab. */
  respondPermission(pageId: string, requestId: string, decision: BrowserSiteDecision): void {
    const page = this.#pages.get(pageId);
    const index = page?.permissions.findIndex((entry) => entry.request.requestId === requestId) ?? -1;
    if (!page || index < 0) return;
    const [entry] = page.permissions.splice(index, 1);
    entry!.resolve(decision);
    this.#emit(page);
  }

  /** The person closed the tab. */
  close(pageId: string): void {
    const page = this.#pages.get(pageId);
    this.#synced = { ...this.#synced, tabs: this.#synced.tabs.filter((tab) => tab.pageId !== pageId) };
    if (page) this.#destroy(page);
  }

  /** The renderer's open browser tabs. Pages a Worker opened that it has not shown are offered again. */
  sync(value: BrowserTabsSync): void {
    this.#synced = value;
    const known = new Set(value.tabs.map((tab) => tab.pageId));
    const now = Date.now();
    for (const page of this.#pages.values()) {
      if (known.has(page.pageId) || page.closed || now - page.announcedAt < 3_000) continue;
      this.#announce(page, false);
    }
  }

  /** Shows a file this browser downloaded in Finder or Explorer. */
  showDownload(path: string): void {
    if (!this.#downloads.has(path)) throw new Error("That file is not one this browser downloaded.");
    shell.showItemInFolder(path);
  }

  /** Pages from history that match what someone is typing in the address bar. */
  suggest(text: string): BrowserHistoryEntry[] {
    return this.#history.suggest(text);
  }

  /** The most recently visited pages, for a new tab. */
  recentHistory(): BrowserHistoryEntry[] {
    return this.#history.recent();
  }

  clearHistory(): Promise<void> {
    return this.#history.clear();
  }

  states(): BrowserPageState[] {
    return [...this.#pages.values()].filter((page) => !page.closed).map((page) => this.#state(page));
  }

  /** Takes every page off a window that is closing; they come back when a window shows them again. */
  detachWindow(window: BrowserWindow): void {
    for (const page of this.#pages.values()) {
      if (page.attachedTo !== window) continue;
      if (!window.isDestroyed()) window.contentView.removeChildView(page.view);
      page.attachedTo = null;
      page.layout = null;
    }
  }

  dispose(): void {
    for (const page of [...this.#pages.values()]) this.#destroy(page, { announce: false });
    this.#bubble.close();
    this.#backgroundWindow?.destroy();
    this.#backgroundWindow = null;
    void this.#history.flush();
  }

  // ── Pages ─────────────────────────────────────────────────────────────────

  #createPage(pageId: string, url: string, openedBy: BrowserPage["openedBy"], adopt?: WebContentsViewConstructorOptions, owner: string | null = null): BrowserPage {
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    if (this.#pages.has(pageId)) throw new Error("That browser tab already exists.");
    const view = new WebContentsView(adopt ?? { webPreferences: this.#webPreferences() });
    view.setBackgroundColor("#ffffff");
    view.setBounds({ x: 0, y: 0, ...defaultPageSize });
    const page: BrowserPage = {
      pageId,
      view,
      openedBy,
      owner: openedBy === "agent" ? owner : null,
      operations: Promise.resolve(),
      favicon: null,
      faviconUrl: null,
      error: null,
      crashed: false,
      layout: null,
      attachedTo: null,
      console: [],
      debuggerReady: null,
      debuggerIdle: null,
      fullscreen: null,
      announcedAt: 0,
      closed: false,
      permissions: [],
      notice: null,
      lastInputAt: 0,
      blockedPopup: null,
      worker: null,
      workerSteps: new Map(),
      workerLinger: null,
    };
    this.#pages.set(pageId, page);
    this.#wire(page);
    if (!adopt) this.#load(page, url);
    return page;
  }

  #webPreferences(): Electron.WebPreferences {
    return {
      session: this.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      // Chromium's PDF viewer is plugin-backed.
      plugins: true,
      spellcheck: true,
      safeDialogs: true,
      devTools: true,
    };
  }

  #load(page: BrowserPage, url: string): Promise<void> {
    page.error = null;
    page.crashed = false;
    if (!isBrowserUrl(url)) {
      void this.#openOutside(url);
      return Promise.resolve();
    }
    return page.view.webContents.loadURL(url).catch(() => undefined);
  }

  #wire(page: BrowserPage): void {
    const contents = page.view.webContents;
    const emit = () => this.#emit(page);
    contents.on("did-start-loading", emit);
    contents.on("did-stop-loading", emit);
    contents.on("did-navigate", (_event, url) => {
      page.error = null;
      page.crashed = false;
      this.#history.record(url, contents.getTitle());
      emit();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.#history.record(url, contents.getTitle());
      emit();
    });
    // A question belongs to the page that asked it; leaving the page drops it.
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      page.notice = null;
      page.blockedPopup = null;
      this.#dropPermissions(page);
    });
    // Real presses only: these come from the window, never from page script.
    contents.on("input-event", (_event, input) => {
      if (gestureInputTypes.has(input.type)) page.lastInputAt = Date.now();
    });
    contents.on("update-target-url", (_event, url) => this.#hover(page, url));
    // Pinch and Control-scroll ask to zoom; the browser decides how much.
    contents.on("zoom-changed", (_event, direction) => this.command(page.pageId, { type: direction === "in" ? "zoom-in" : "zoom-out" }));
    contents.on("page-title-updated", (_event, title) => {
      this.#history.retitle(contents.getURL(), title);
      emit();
    });
    contents.on("audio-state-changed", emit);
    contents.on("page-favicon-updated", (_event, favicons) => { void this.#updateFavicon(page, favicons[0] ?? null); });
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load, which another navigation replaced.
      if (!isMainFrame || code === -3) return;
      page.error = { code, description, url };
      emit();
    });
    contents.on("render-process-gone", () => {
      page.crashed = true;
      page.debuggerReady = null;
      emit();
    });
    contents.on("console-message", (event) => {
      const where = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : "";
      pushBounded(page.console, `[${event.level}] ${event.message}${where}`);
    });
    contents.on("found-in-page", (_event, result) => {
      const found: BrowserFindResult = { pageId: page.pageId, matches: result.matches, activeMatch: result.activeMatchOrdinal, final: result.finalUpdate };
      this.#options.send(browserChannels.findResult, found);
    });
    contents.on("enter-html-full-screen", () => this.#enterFullScreen(page));
    contents.on("leave-html-full-screen", () => this.#leaveFullScreen(page));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => this.#guardNavigation(event, event.url));
    contents.on("will-redirect", (event) => this.#guardNavigation(event, event.url));
    contents.on("context-menu", (_event, params) => { void this.#contextMenu(page, params); });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (this.#handleKey(page, input)) event.preventDefault();
    });
    contents.setWindowOpenHandler((details) => this.#windowOpen(page, details));
    contents.on("did-create-window", (window) => this.#configurePopup(window, page));
    contents.on("destroyed", () => {
      this.#dropPermissions(page);
      if (this.#pages.get(page.pageId) !== page) return;
      this.#pages.delete(page.pageId);
      if (!page.closed) {
        page.closed = true;
        this.#options.send(browserChannels.closeTab, { pageId: page.pageId });
      }
    });
  }

  #guardNavigation(event: Electron.Event, url: string): void {
    if (isBrowserUrl(url)) return;
    event.preventDefault();
    void this.#openOutside(url);
  }

  /** Mail links go to the mail app; other non-web addresses are refused. */
  async #openOutside(url: string): Promise<void> {
    if (!/^mailto:/i.test(url)) return;
    await this.#options.openExternal(url).catch(() => undefined);
  }

  #windowOpen(opener: BrowserPage, details: HandlerDetails): WindowOpenHandlerResponse {
    if (!isBrowserUrl(details.url) && details.url !== "") {
      void this.#openOutside(details.url);
      return { action: "deny" };
    }
    // A site opens a tab or pop-up only right after a press, unless the person allowed it pop-ups.
    if (!this.#canOpenPopup(opener.view.webContents, opener)) {
      this.#blockPopup(opener, opener.view.webContents, details.url);
      return { action: "deny" };
    }
    // A sized pop-up, such as "Sign in with…", keeps its own small window and
    // its link back to the page that opened it, which sign-in flows rely on.
    if (details.disposition === "new-window") {
      const parent = this.#options.window();
      const overrideBrowserWindowOptions: BrowserWindowConstructorOptions = {
        ...(parent && !parent.isDestroyed() ? { parent } : {}),
        autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
      };
      return { action: "allow", overrideBrowserWindowOptions };
    }
    const show = details.disposition !== "background-tab";
    return {
      action: "allow",
      createWindow: (options) => {
        const page = this.#createPage(newPageId(this.#pages), details.url, opener.openedBy, options as WebContentsViewConstructorOptions, opener.owner);
        this.#announce(page, show, details.url);
        return page.view.webContents;
      },
    };
  }

  /** One policy for tabs and pop-up windows; a press is consumed by its first opening. */
  #canOpenPopup(contents: WebContents, input: { lastInputAt: number }): boolean {
    const origin = siteOrigin(contents.getURL());
    if (origin && this.#sitePermissions.get(origin, "popups") === "allow") return true;
    if (!input.lastInputAt || Date.now() - input.lastInputAt > popupGestureMs) return false;
    input.lastInputAt = 0;
    return true;
  }

  /** Pop-up windows use the original tab's bar, retaining the site that actually asked. */
  #blockPopup(page: BrowserPage, contents: WebContents, url: string): void {
    if (page.closed || !url || !isBrowserUrl(url)) return;
    page.blockedPopup = { url, origin: siteOrigin(contents.getURL()) };
    this.#emit(page);
  }

  /** Pop-up windows a page opened: links in them become tabs under the same popup rules. */
  #configurePopup(window: BrowserWindow, opener: BrowserPage): void {
    const contents = window.webContents;
    const input = { lastInputAt: 0 };
    contents.on("input-event", (_event, event) => {
      if (gestureInputTypes.has(event.type)) input.lastInputAt = Date.now();
    });
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) input.lastInputAt = 0;
    });
    contents.setWindowOpenHandler((details) => {
      if (!isBrowserUrl(details.url)) {
        void this.#openOutside(details.url);
      } else if (this.#canOpenPopup(contents, input)) {
        this.#openTab(details.url, true, "person");
      } else {
        this.#blockPopup(opener, contents, details.url);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => this.#guardNavigation(event, event.url));
    contents.on("will-attach-webview", (event) => event.preventDefault());
  }

  #openTab(url: string, show: boolean, openedBy: BrowserPage["openedBy"], owner: string | null = null): BrowserPage {
    const page = this.#createPage(newPageId(this.#pages), url, openedBy, undefined, owner);
    this.#announce(page, show, url);
    return page;
  }

  #announce(page: BrowserPage, show: boolean, url = page.view.webContents.getURL()): void {
    page.announcedAt = Date.now();
    const command: BrowserOpenTabCommand = {
      pageId: page.pageId,
      url: url || page.view.webContents.getURL(),
      title: page.view.webContents.getTitle() || displayHost(url) || "New Tab",
      show,
    };
    this.#options.send(browserChannels.openTab, command);
  }

  #destroy(page: BrowserPage, options: { announce?: boolean } = {}): void {
    if (page.closed) return;
    page.closed = true;
    this.#dropPermissions(page);
    if (page.debuggerIdle) clearTimeout(page.debuggerIdle);
    if (page.workerLinger) clearTimeout(page.workerLinger);
    this.#pages.delete(page.pageId);
    if (page.fullscreen) this.#leaveFullScreen(page);
    // During quit Electron may already have torn the view down.
    const contents = page.view.webContents as WebContents | undefined;
    if (contents && !contents.isDestroyed()) {
      this.#hide(page);
      contents.close({ waitForBeforeUnload: false });
    }
    if (options.announce !== false) this.#options.send(browserChannels.closeTab, { pageId: page.pageId });
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  #applyRequest(page: BrowserPage, request: BrowserViewRequest): void {
    if (page.layout && request.sequence < page.layout.sequence) return;
    page.layout = { sequence: request.sequence, bounds: request.bounds, active: request.active, occluded: request.occluded };
    this.#applyLayout(page);
  }

  #applyLayout(page: BrowserPage): void {
    const window = this.#options.window();
    if (page.attachedTo && page.attachedTo !== window) {
      if (!page.attachedTo.isDestroyed()) page.attachedTo.contentView.removeChildView(page.view);
      page.attachedTo = null;
    }
    const layout = page.layout;
    if (!window || window.isDestroyed() || !layout || page.view.webContents.isDestroyed()) {
      this.#hide(page);
      return;
    }
    const content = window.getContentBounds();
    const bounds = page.fullscreen
      ? { x: 0, y: 0, width: content.width, height: content.height }
      : clippedViewBounds(layout.bounds, content, window.webContents.getZoomFactor());
    const visible = (page.fullscreen !== null || (layout.active && !layout.occluded))
      && bounds.width > 0 && bounds.height > 0 && window.isVisible() && !window.isMinimized();
    if (!visible) {
      // The page keeps its last size, so a Worker using it in the background sees the same layout.
      this.#hide(page);
      return;
    }
    this.#unpark(page);
    window.contentView.addChildView(page.view);
    page.attachedTo = window;
    page.view.setBounds(bounds);
    page.view.setVisible(true);
    this.#options.onViewAttached?.();
  }

  #hide(page: BrowserPage): void {
    if (page.attachedTo) this.#bubble.hide();
    this.#unpark(page);
    page.view.setVisible(false);
    if (page.attachedTo && !page.attachedTo.isDestroyed()) page.attachedTo.contentView.removeChildView(page.view);
    page.attachedTo = null;
    if (page.debuggerReady) this.#park(page);
  }

  /** Linux needs a native parent for trusted mouse presses, even in a background page. */
  #park(page: BrowserPage): void {
    if (process.platform !== "linux" || page.closed || page.attachedTo || this.#backgroundPages.has(page)) return;
    this.#backgroundWindow ??= new BrowserWindow({
      show: false, focusable: false, skipTaskbar: true,
      width: defaultPageSize.width, height: defaultPageSize.height,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.#backgroundWindow.webContents.setBackgroundThrottling(false);
    this.#backgroundWindow.contentView.addChildView(page.view);
    page.view.setVisible(true);
    page.view.webContents.setBackgroundThrottling(false);
    this.#backgroundPages.add(page);
  }

  #unpark(page: BrowserPage): void {
    if (!this.#backgroundPages.delete(page)) return;
    if (this.#backgroundWindow && !this.#backgroundWindow.isDestroyed()) this.#backgroundWindow.contentView.removeChildView(page.view);
    page.view.setVisible(false);
    const contents = page.view.webContents as WebContents | undefined;
    if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
  }

  #enterFullScreen(page: BrowserPage): void {
    const window = this.#options.window();
    if (!window || window.isDestroyed()) return;
    page.fullscreen = { restoreWindowFullScreen: !window.isFullScreen() };
    if (!window.isFullScreen()) window.setFullScreen(true);
    this.#applyLayout(page);
    window.once("resize", () => { if (page.fullscreen) this.#applyLayout(page); });
  }

  #leaveFullScreen(page: BrowserPage): void {
    const restore = page.fullscreen?.restoreWindowFullScreen;
    page.fullscreen = null;
    const window = this.#options.window();
    if (restore && window && !window.isDestroyed() && window.isFullScreen()) window.setFullScreen(false);
    if (!page.closed) this.#applyLayout(page);
  }

  // ── State ─────────────────────────────────────────────────────────────────

  #state(page: BrowserPage): BrowserPageState {
    const contents = page.view.webContents;
    if (contents.isDestroyed()) {
      return { pageId: page.pageId, url: "", title: "", favicon: null, loading: false, canGoBack: false, canGoForward: false, error: null, crashed: true, audible: false, sitePermissions: [], permissionRequest: null, notice: null, muted: false, zoomPercent: 100, blockedPopup: null, worker: null };
    }
    const origin = siteOrigin(contents.getURL());
    return {
      pageId: page.pageId,
      url: contents.getURL(),
      title: contents.getTitle(),
      favicon: page.favicon,
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: page.error,
      crashed: page.crashed,
      audible: contents.isCurrentlyAudible(),
      sitePermissions: origin ? this.#sitePermissions.forSite(origin) : [],
      permissionRequest: page.permissions[0]?.request ?? null,
      notice: page.notice,
      muted: contents.isAudioMuted(),
      zoomPercent: Math.round(contents.getZoomFactor() * 100),
      blockedPopup: page.blockedPopup,
      worker: page.worker ? { owner: page.worker.owner } : null,
    };
  }

  #emitAll(): void {
    for (const page of this.#pages.values()) this.#emit(page);
  }

  /** Every page showing this site gets its new settings. */
  #emitSite(origin: string): void {
    for (const page of this.#pages.values()) {
      if (!page.view.webContents.isDestroyed() && siteOrigin(page.view.webContents.getURL()) === origin) this.#emit(page);
    }
  }

  #emit(page: BrowserPage): void {
    if (page.closed) return;
    this.#options.send(browserChannels.state, this.#state(page));
  }

  async #updateFavicon(page: BrowserPage, url: string | null): Promise<void> {
    if (url === page.faviconUrl) return;
    page.faviconUrl = url;
    let favicon: string | null = null;
    if (url && /^(https?|data):/i.test(url)) {
      try {
        favicon = url.startsWith("data:") ? (url.length <= 200_000 && /^data:image\//i.test(url) ? url : null) : await this.#fetchImage(url);
      } catch {
        favicon = null;
      }
    }
    if (page.faviconUrl !== url) return;
    page.favicon = favicon;
    this.#emit(page);
  }

  async #fetchImage(url: string): Promise<string | null> {
    const response = await this.session.fetch(url, { signal: AbortSignal.timeout(8_000) });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!response.ok || !type.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 150_000) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  }

  // ── Session ───────────────────────────────────────────────────────────────

  #configureSession(): void {
    const session = this.session;
    session.setUserAgent(browserUserAgent(this.#options.userAgentProduct));
    session.setPermissionRequestHandler((contents, permission, callback, details) => {
      void this.#requestPermission(contents, permission, details).then(callback, () => callback(false));
    });
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      if (silentPermissions.has(permission)) return true;
      const kinds = permissionKinds(permission, details.mediaType === "video" || details.mediaType === "audio" ? [details.mediaType] : []);
      const origin = siteOrigin(requestingOrigin || details.requestingUrl || "");
      return Boolean(origin && kinds.length && kinds.every((kind) => this.#sitePermissions.get(origin, kind) === "allow"));
    });
    // Screen sharing goes through the macOS picker (macOS 15 and later), where the person chooses what to share.
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
    session.on("will-download", (_event, item, contents) => {
      const directory = this.#options.downloadsPath();
      const path = uniquePath(directory, safeFileName(item.getFilename()), this.#pendingDownloads);
      this.#pendingDownloads.add(path);
      item.setSavePath(path);
      const page = contents && this.#pageForContentsId(contents.id);
      const record: BrowserDownloadRecord | null = page ? {
        id: randomBytes(8).toString("hex"), tab: page.pageId, url: item.getURL(),
        filename: item.getFilename(), state: "progressing", receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(), path: null,
      } : null;
      if (record) {
        this.#downloadRecords.set(record.id, record);
        // Keep recent finished downloads; an active transfer is never forgotten.
        for (const [id, entry] of this.#downloadRecords) {
          if (this.#downloadRecords.size <= 200) break;
          if (entry.state !== "progressing") this.#downloadRecords.delete(id);
        }
      }
      item.on("updated", () => {
        if (!record) return;
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
      });
      item.once("done", (_doneEvent, state) => {
        this.#pendingDownloads.delete(path);
        if (state === "completed") this.#downloads.add(path);
        if (record) {
          record.state = state;
          record.receivedBytes = item.getReceivedBytes();
          record.totalBytes = item.getTotalBytes();
          record.path = state === "completed" ? path : null;
        }
        const download: BrowserDownload = { filename: item.getFilename(), path, state };
        this.#options.send(browserChannels.download, download);
      });
    });
    session.webRequest.onCompleted((details) => {
      if (details.statusCode < 400 || details.webContentsId === undefined) return;
      const page = this.#pageForContentsId(details.webContentsId);
      if (page) pushBounded(page.console, `[network] ${details.statusCode} ${details.method} ${details.url}`);
    });
    session.webRequest.onErrorOccurred((details) => {
      if (details.webContentsId === undefined || details.error === "net::ERR_ABORTED") return;
      const page = this.#pageForContentsId(details.webContentsId);
      if (page) pushBounded(page.console, `[network] ${details.error} ${details.method} ${details.url}`);
    });
  }

  // ── Site permissions ──────────────────────────────────────────────────────

  async #requestPermission(contents: WebContents, permission: string, details: Electron.PermissionRequest | Electron.MediaAccessPermissionRequest): Promise<boolean> {
    if (silentPermissions.has(permission)) return true;
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const kinds = permissionKinds(permission, mediaTypes);
    const origin = siteOrigin(("securityOrigin" in details && details.securityOrigin) || details.requestingUrl || "");
    if (!kinds.length || !origin) return false;
    const saved = kinds.map((kind) => this.#sitePermissions.get(origin, kind));
    if (saved.includes("block")) return false;
    const page = this.#pageForContentsId(contents.id);
    if (saved.every((decision) => decision === "allow")) return await this.#systemAllows(kinds, page);
    const decision = page ? await this.#askOnPage(page, origin, kinds) : await this.#askInDialog(contents, origin, kinds);
    if (!decision) return false;
    await this.#sitePermissions.set(origin, kinds, decision).catch(() => undefined);
    this.#emitSite(origin);
    return decision === "allow" && await this.#systemAllows(kinds, page);
  }

  /** The question shows above the page in its tab; the person may be looking at another tab. */
  #askOnPage(page: BrowserPage, origin: string, kinds: BrowserSitePermission[]): Promise<BrowserSiteDecision | null> {
    return new Promise((resolve) => {
      const request: BrowserPermissionRequest = { requestId: randomBytes(8).toString("hex"), origin, kinds };
      page.permissions.push({ request, resolve });
      this.#emit(page);
    });
  }

  /** A pop-up window has no tab to ask in, so it asks with a dialog over that window. */
  async #askInDialog(contents: WebContents, origin: string, kinds: BrowserSitePermission[]): Promise<BrowserSiteDecision | null> {
    const window = BrowserWindow.fromWebContents(contents);
    const options = {
      type: "question" as const,
      buttons: ["Allow", "Block"],
      defaultId: 0,
      cancelId: 1,
      message: `${displayHost(origin) || origin} wants to ${browserPermissionPhrase(kinds)}.`,
    };
    const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return result.response === 0 ? "allow" : "block";
  }

  #dropPermissions(page: BrowserPage): void {
    if (!page.permissions.length) return;
    for (const entry of page.permissions.splice(0)) entry.resolve(null);
    this.#emit(page);
  }

  /** macOS keeps its own camera and microphone switches; ask once, and say so when they are off. */
  async #systemAllows(kinds: BrowserSitePermission[], page: BrowserPage | null): Promise<boolean> {
    if (process.platform !== "darwin") return true;
    for (const kind of kinds) {
      if (kind !== "camera" && kind !== "microphone") continue;
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === "granted") continue;
      if (status === "not-determined" && await systemPreferences.askForMediaAccess(kind)) continue;
      if (page) {
        const device = kind === "camera" ? "camera" : "microphone";
        page.notice = { kind, text: `macOS has the ${device} turned off for work-fold. Turn it on in System Settings, then reload the page.` };
        this.#emit(page);
      }
      return false;
    }
    return true;
  }

  async #openPrivacySettings(kind: BrowserSitePermission): Promise<void> {
    if (process.platform !== "darwin") return;
    const pane = kind === "camera" ? "Privacy_Camera" : kind === "microphone" ? "Privacy_Microphone" : kind === "location" ? "Privacy_LocationServices" : null;
    if (pane) await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`).catch(() => undefined);
  }

  // ── Print, PDF, and the link under the pointer ────────────────────────────

  #print(page: BrowserPage): void {
    const contents = page.view.webContents;
    if (!contents.isDestroyed()) contents.print({}, () => undefined);
  }

  /** Saves the page as a PDF where the person chooses, offering Downloads; it then shows like a download. */
  async #savePdf(page: BrowserPage): Promise<void> {
    const contents = page.view.webContents;
    if (contents.isDestroyed()) return;
    const window = page.attachedTo ?? this.#options.window();
    const name = `${safeFileName(contents.getTitle() || displayHost(contents.getURL()) || "page")}.pdf`;
    const options = { defaultPath: uniquePath(this.#options.downloadsPath(), name, this.#pendingDownloads), filters: [{ name: "PDF", extensions: ["pdf"] }] };
    const choice = window && !window.isDestroyed() ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath || contents.isDestroyed()) return;
    try {
      await writeFile(choice.filePath, await contents.printToPDF({ printBackground: true }));
      this.#downloads.add(choice.filePath);
      this.#options.send(browserChannels.download, { filename: choice.filePath.split(/[\\/]/).pop() ?? name, path: choice.filePath, state: "completed" } satisfies BrowserDownload);
    } catch {
      this.#options.send(browserChannels.download, { filename: name, path: choice.filePath, state: "interrupted" } satisfies BrowserDownload);
    }
  }

  /** The address of the link under the pointer, over the page in front. */
  #hover(page: BrowserPage, url: string): void {
    const window = page.attachedTo;
    if (!url || !window || window.isDestroyed() || page.closed) {
      this.#bubble.hideSoon();
      return;
    }
    const content = window.getContentBounds();
    const cursor = screen.getCursorScreenPoint();
    this.#bubble.show(window, page.view.getBounds(), bubbleText(url), { x: cursor.x - content.x, y: cursor.y - content.y });
  }

  // ── The Worker marker ─────────────────────────────────────────────────────

  /** Marks the page as used by a Worker while a step runs, so the person sees it and can stop that Chat. */
  async #using<T>(page: BrowserPage, owner: string | undefined, step: () => Promise<T>): Promise<T> {
    if (!owner) return await step();
    if (page.workerLinger) clearTimeout(page.workerLinger);
    page.workerLinger = null;
    // Insertion order follows the most recently started Chat, including repeated calls.
    const count = page.workerSteps.get(owner) ?? 0;
    page.workerSteps.delete(owner);
    page.workerSteps.set(owner, count + 1);
    if (page.worker?.owner !== owner) {
      page.worker = { owner };
      this.#emit(page);
    }
    try {
      return await step();
    } finally {
      const remaining = (page.workerSteps.get(owner) ?? 1) - 1;
      if (remaining) page.workerSteps.set(owner, remaining);
      else page.workerSteps.delete(owner);
      const activeOwner = [...page.workerSteps.keys()].at(-1);
      if (activeOwner && page.worker?.owner !== activeOwner) {
        page.worker = { owner: activeOwner };
        this.#emit(page);
      } else if (!activeOwner && !page.closed) {
        page.workerLinger = setTimeout(() => {
          page.workerLinger = null;
          page.worker = null;
          this.#emit(page);
        }, workerLingerMs);
        page.workerLinger.unref?.();
      }
    }
  }

  #pageForContentsId(id: number): BrowserPage | null {
    for (const page of this.#pages.values()) if (!page.view.webContents.isDestroyed() && page.view.webContents.id === id) return page;
    return null;
  }

  // ── Context menu and keys ─────────────────────────────────────────────────

  async #contextMenu(page: BrowserPage, params: ContextMenuParams): Promise<void> {
    const contents = page.view.webContents;
    // macOS often leaves Electron's suggestions empty; ask the system spell checker, as Chrome's menu does.
    const suggestions = params.misspelledWord && !params.dictionarySuggestions.length
      ? await macSpellingGuesses(params.misspelledWord)
      : params.dictionarySuggestions.slice(0, 5);
    if (contents.isDestroyed() || page.closed) return;
    const template: MenuItemConstructorOptions[] = [];
    if (params.linkURL && isBrowserUrl(params.linkURL)) {
      template.push(
        { label: "Open Link in New Tab", click: () => { this.#openTab(params.linkURL, false, "person"); } },
        { label: "Open Link in Your Web Browser", click: () => { void this.#options.openExternal(params.linkURL).catch(() => undefined); } },
        { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.mediaType === "image" && params.srcURL) {
      template.push(
        ...(isBrowserUrl(params.srcURL) ? [{ label: "Open Image in New Tab", click: () => { this.#openTab(params.srcURL, false, "person"); } }] : []),
        { label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) },
        { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
        { type: "separator" },
      );
    }
    if (params.misspelledWord) {
      const word = params.misspelledWord;
      template.push(
        ...suggestions.map((suggestion) => ({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) })),
        ...(suggestions.length ? [] : [{ label: "No Guesses Found", enabled: false }]),
        { label: "Add to Dictionary", click: () => { this.session.addWordToSpellCheckerDictionary(word); } },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      template.push(
        { label: "Undo", enabled: params.editFlags.canUndo, click: () => contents.undo() },
        { label: "Redo", enabled: params.editFlags.canRedo, click: () => contents.redo() },
        { type: "separator" },
        { label: "Cut", enabled: params.editFlags.canCut, click: () => contents.cut() },
        { label: "Copy", enabled: params.editFlags.canCopy, click: () => contents.copy() },
        { label: "Paste", enabled: params.editFlags.canPaste, click: () => contents.paste() },
        { label: "Select All", enabled: params.editFlags.canSelectAll, click: () => contents.selectAll() },
        { type: "separator" },
      );
    } else if (params.selectionText.trim()) {
      const selection = params.selectionText.trim();
      const shown = selection.length > 30 ? `${selection.slice(0, 29)}…` : selection;
      template.push(
        { label: "Copy", click: () => contents.copy() },
        { label: `Search Google for “${shown}”`, click: () => { this.#openTab(`${browserSearchUrl}${encodeURIComponent(selection)}`, true, "person"); } },
        { type: "separator" },
      );
    }
    if (!params.linkURL && !params.isEditable && !params.selectionText.trim()) {
      template.push(
        { label: "Back", enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: "Forward", enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: "Reload", click: () => contents.reload() },
        { type: "separator" },
        { label: "Print…", click: () => this.#print(page) },
        { label: "Save as PDF…", click: () => { void this.#savePdf(page); } },
        { type: "separator" },
      );
    }
    template.push({ label: "Inspect", click: () => contents.inspectElement(params.x, params.y) });
    const window = page.attachedTo ?? this.#options.window();
    Menu.buildFromTemplate(template).popup(window && !window.isDestroyed() ? { window } : {});
  }

  /** Browser keys while the page has focus. True when the key is handled here and must not reach the page. */
  #handleKey(page: BrowserPage, input: Electron.Input): boolean {
    const command = process.platform === "darwin" ? input.meta : input.control;
    const key = input.key.toLowerCase();
    const contents = page.view.webContents;
    if (command && !input.alt) {
      if (key === "r") {
        if (input.shift) contents.reloadIgnoringCache(); else contents.reload();
        return true;
      }
      if (key === "[" && !input.shift) { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); return true; }
      if (key === "]" && !input.shift) { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); return true; }
      if (key === "=" || key === "+") { this.command(page.pageId, { type: "zoom-in" }); return true; }
      if (key === "-") { this.command(page.pageId, { type: "zoom-out" }); return true; }
      if (key === "0") { this.command(page.pageId, { type: "zoom-reset" }); return true; }
      if (key === "p" && !input.shift) { this.#print(page); return true; }
      if ((key === "l" || key === "f" || key === "t") && !input.shift) return this.#forwardKey(page, input);
      // Cmd/Ctrl+Shift+T reopens the last closed browser tab, which the tab strip remembers.
      if (key === "t" && input.shift) return this.#forwardKey(page, input);
      if (/^[1-9]$/.test(key) && !input.shift) return this.#forwardKey(page, input);
    }
    if (input.control && !input.meta && !input.alt && key === "tab") return this.#forwardKey(page, input);
    return false;
  }

  #forwardKey(page: BrowserPage, input: Electron.Input): true {
    const shortcut: BrowserShortcut = {
      pageId: page.pageId,
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      shiftKey: input.shift,
      altKey: input.alt,
    };
    this.#options.send(browserChannels.shortcut, shortcut);
    return true;
  }

  // ── Worker operations ─────────────────────────────────────────────────────

  #createToolHost(): BrowserToolHost {
    const operations: BrowserToolHost = {
      tabs: async () => this.#tabSummaries(),
      open: async ({ url, show, signal, owner }) => {
        const address = browserAddressFor(url);
        if (!address || !isBrowserUrl(address)) throw new Error(`"${url}" is not a web address this browser can open.`);
        signal?.throwIfAborted();
        const page = this.#openTab(address, show === true, "agent", owner ?? null);
        return await this.#using(page, owner, async () => {
          await delay(50);
          await this.#waitForLoad(page, signal);
          return this.#summary(page);
        });
      },
      navigate: async ({ tab, to, signal }) => {
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const contents = page.view.webContents;
          const target = to.trim().toLowerCase();
          if (target === "back") {
            if (!contents.navigationHistory.canGoBack()) throw new Error("This tab has no earlier page.");
            contents.navigationHistory.goBack();
          } else if (target === "forward") {
            if (!contents.navigationHistory.canGoForward()) throw new Error("This tab has no later page.");
            contents.navigationHistory.goForward();
          } else if (target === "reload") {
            page.error = null;
            contents.reload();
          } else {
            const address = browserAddressFor(to);
            if (!address || !isBrowserUrl(address)) throw new Error(`"${to}" is not a web address this browser can open.`);
            void this.#load(page, address);
          }
          await delay(50);
          await this.#waitForLoad(page, signal);
          return this.#summary(page);
        });
      },
      read: async ({ tab, mode, find, offset }) => {
        const page = await this.#agentPage(tab);
        let text: string;
        if (mode === "text") {
          const result = await page.view.webContents.executeJavaScriptInIsolatedWorld(isolatedWorldId, [{ code: "document.body ? document.body.innerText : ''" }]);
          text = typeof result === "string" ? result.replace(/\n{3,}/g, "\n\n").trim() : "";
          if (find?.trim()) text = text.split("\n").filter((line) => line.toLowerCase().includes(find.trim().toLowerCase())).join("\n");
        } else {
          const cdp = await this.#debugger(page);
          const tree = await cdp.sendCommand("Accessibility.getFullAXTree") as { nodes: AccessibilityNode[] };
          text = formatAccessibilitySnapshot(tree.nodes);
          if (find?.trim()) text = findInSnapshot(text, find);
        }
        const start = Math.max(0, Math.min(offset ?? 0, text.length));
        const end = Math.min(text.length, start + readChunkLength);
        return { tab: this.#summary(page), text: text.slice(start, end), total: text.length, nextOffset: end < text.length ? end : null };
      },
      screenshot: async ({ tab, ref, fullPage }) => {
        const page = await this.#agentPage(tab);
        const contents = page.view.webContents;
        const cdp = await this.#debugger(page);
        const viewport = await this.#viewport(page);
        let image: NativeImage;
        if (fullPage) {
          const metrics = await cdp.sendCommand("Page.getLayoutMetrics") as { cssContentSize?: { width: number; height: number } };
          const width = Math.max(1, Math.ceil(metrics.cssContentSize?.width ?? viewport.width));
          const height = Math.max(1, Math.min(fullPageMaxHeight, Math.ceil(metrics.cssContentSize?.height ?? viewport.height)));
          if (process.platform === "linux" && this.#backgroundPages.has(page)) {
            const bounds = page.view.getBounds();
            try {
              // Only the hidden native view changes size; the person's window stays put.
              page.view.setBounds({ ...bounds, width, height });
              await Promise.race([
                contents.executeJavaScriptInIsolatedWorld(isolatedWorldId, [{ code: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))" }]),
                delay(2_000),
              ]);
              image = await contents.capturePage(undefined, { stayHidden: false, stayAwake: true });
            } finally {
              if (!page.closed && !contents.isDestroyed()) {
                page.view.setBounds(bounds);
                if (page.attachedTo) this.#applyLayout(page);
              }
            }
          } else {
            const shot = await cdp.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }) as { data: string };
            image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
          }
          image = image.resize({ width });
        } else if (ref) {
          const box = await this.#elementBox(page, ref);
          const rect = {
            x: Math.max(0, Math.floor(box.x)),
            y: Math.max(0, Math.floor(box.y)),
            width: Math.max(1, Math.min(Math.ceil(box.width), viewport.width)),
            height: Math.max(1, Math.min(Math.ceil(box.height), viewport.height)),
          };
          image = await contents.capturePage(rect, { stayHidden: process.platform !== "linux", stayAwake: true });
          image = image.resize({ width: rect.width });
        } else {
          image = await contents.capturePage(undefined, { stayHidden: process.platform !== "linux", stayAwake: true });
          image = image.resize({ width: viewport.width });
        }
        this.#touch(page);
        const size = image.getSize();
        if (image.isEmpty() || !size.width || !size.height) throw new Error("The page could not be captured. Try again after it finishes loading.");
        return { tab: this.#summary(page), data: image.toJPEG(82).toString("base64"), mimeType: "image/jpeg", width: size.width, height: size.height };
      },
      click: async ({ tab, ref, x, y, double, button = "left", modifiers = [], signal }) => {
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          const point = ref ? await this.#elementCenter(page, ref) : pointFrom(x, y);
          const bits = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
          const held = modifiers.reduce((value, key) => value | bits[key], 0);
          return await this.#observeAction(page, signal, async () => {
            await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers: held });
            for (let count = 1; count <= (double ? 2 : 1); count += 1) {
              // Stop during the move, or between two clicks, presses nothing more.
              signal?.throwIfAborted();
              await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, modifiers: held, clickCount: count });
              // A pressed button is always released, even after Stop, so the page is never left mid-click.
              await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, modifiers: held, clickCount: count });
            }
          });
        });
      },
      hover: async ({ tab, ref, x, y, signal }) => {
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          const point = ref ? await this.#elementCenter(page, ref) : pointFrom(x, y);
          return await this.#observeAction(page, signal, async () => {
            signal?.throwIfAborted();
            await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
          }, false);
        });
      },
      drag: async ({ tab, from, to, signal }) => {
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          const target = async (value: BrowserTarget) => value.ref ? this.#elementCenter(page, value.ref, false) : pointFrom(value.x, value.y);
          const start = await target(from);
          const end = await target(to);
          const viewport = await this.#viewport(page);
          for (const point of [start, end]) {
            if (point.x >= viewport.width || point.y >= viewport.height) throw new Error("Both drag targets must be visible in the viewport. Scroll and read the page first.");
          }
          return await this.#observeAction(page, signal, () => this.#drag(cdp, start, end, signal));
        });
      },
      upload: async ({ tab, ref, paths, signal }) => {
        signal?.throwIfAborted();
        if (paths.length > 100) throw new Error("Attach at most 100 files at once.");
        for (const path of paths) {
          signal?.throwIfAborted();
          if (!isAbsolute(path)) throw new Error("File uploads need absolute paths.");
          if (!(await stat(path)).isFile()) throw new Error(`The upload path is not a file: ${path}`);
        }
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          const backendNodeId = refNodeId(ref);
          const described = await cdp.sendCommand("DOM.describeNode", { backendNodeId }).catch(() => { throw staleRef(ref); });
          const attributes = described.node?.attributes as string[] | undefined;
          const pairs = new Map<string, string>();
          for (let index = 0; index < (attributes?.length ?? 0); index += 2) pairs.set(attributes![index]!, attributes![index + 1]!);
          const attribute = (name: string) => pairs.get(name);
          if (described.node?.nodeName !== "INPUT" || attribute("type")?.toLowerCase() !== "file") throw new Error("Use the ref of a file upload field from browser_read.");
          if (attribute("disabled") !== undefined) throw new Error("That file upload field is disabled.");
          if (attribute("webkitdirectory") !== undefined) throw new Error("Folder upload fields are not supported; choose a file upload field.");
          if (paths.length > 1 && attribute("multiple") === undefined) throw new Error("That field accepts only one file.");
          return await this.#observeAction(page, signal, async () => {
            signal?.throwIfAborted();
            if (paths.length) {
              await cdp.sendCommand("DOM.setFileInputFiles", { backendNodeId, files: paths });
            } else {
              // Chromium can leave the previous FileList in place for an empty
              // setFileInputFiles call. Emptying a file input's value is permitted.
              const objectId = await this.#resolve(cdp, ref);
              signal?.throwIfAborted();
              await cdp.sendCommand("Runtime.callFunctionOn", { objectId, functionDeclaration: "function() { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }" });
            }
          });
        });
      },
      downloads: async ({ tab, seconds = 0, signal }) => {
        const page = await this.#agentPage(tab, signal);
        const deadline = Date.now() + Math.min(60, Math.max(0, seconds)) * 1_000;
        const records = () => [...this.#downloadRecords.values()].filter((entry) => entry.tab === tab);
        while (records().some((entry) => entry.state === "progressing") && Date.now() < deadline) {
          signal?.throwIfAborted();
          await delay(100);
        }
        signal?.throwIfAborted();
        return { tab: this.#summary(page), downloads: records().slice(-50).reverse().map((entry) => ({ ...entry })) };
      },
      type: async ({ tab, ref, text, clear, submit, signal }) => {
        const page = await this.#agentPage(tab, signal);
        // Focus, selection, and insertion belong together: another Chat's typing waits its turn.
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          return await this.#observeAction(page, signal, async () => {
            if (ref) {
              const backendNodeId = refNodeId(ref);
              const described = await cdp.sendCommand("DOM.describeNode", { backendNodeId }).catch(() => { throw staleRef(ref); }) as { node?: { nodeName?: string } };
              if (described.node?.nodeName === "SELECT") {
                const object = await this.#resolve(cdp, ref);
                const chosen = await cdp.sendCommand("Runtime.callFunctionOn", { objectId: object, functionDeclaration: chooseOptionFunction, arguments: [{ value: text }], returnByValue: true }) as { result?: { value?: unknown } };
                if (typeof chosen.result?.value !== "string") throw new Error(`No option in that list matches "${text}". Read the page to see its options.`);
                return;
              }
              await cdp.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => undefined);
              signal?.throwIfAborted();
              await cdp.sendCommand("DOM.focus", { backendNodeId }).catch(async () => {
                const point = await this.#elementCenter(page, ref);
                signal?.throwIfAborted();
                await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
                await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
              });
            }
            if (clear ?? Boolean(ref)) {
              signal?.throwIfAborted();
              await cdp.sendCommand("Runtime.evaluate", { expression: selectFocusedContentsExpression });
              if (!text) await this.#press(cdp, parseBrowserKeys("Backspace"), signal);
            }
            signal?.throwIfAborted();
            if (text) await cdp.sendCommand("Input.insertText", { text });
            if (submit) await this.#press(cdp, parseBrowserKeys("Enter"), signal);
          });
        });
      },
      press: async ({ tab, ref, keys, signal }) => {
        const presses = parseBrowserKeys(keys);
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          return await this.#observeAction(page, signal, async () => {
            if (ref) {
              signal?.throwIfAborted();
              await cdp.sendCommand("DOM.focus", { backendNodeId: refNodeId(ref) }).catch(() => { throw staleRef(ref); });
            }
            await this.#press(cdp, presses, signal);
          });
        });
      },
      scroll: async ({ tab, ref, x, y, direction, amount, signal }) => {
        const page = await this.#agentPage(tab, signal);
        return await this.#exclusive(page, signal, async () => {
          const cdp = await this.#debugger(page);
          if (ref && !direction && amount === undefined) {
            signal?.throwIfAborted();
            await cdp.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId: refNodeId(ref) }).catch(() => { throw staleRef(ref); });
          } else {
            const viewport = await this.#viewport(page);
            const point = ref ? await this.#elementCenter(page, ref) : x !== undefined || y !== undefined ? pointFrom(x, y) : { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
            const screens = typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : 1;
            const along = direction === "left" || direction === "right" ? viewport.width : viewport.height;
            const distance = Math.round(along * 0.8 * screens) * (direction === "up" || direction === "left" ? -1 : 1);
            const horizontal = direction === "left" || direction === "right";
            signal?.throwIfAborted();
            await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
            signal?.throwIfAborted();
            await cdp.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: horizontal ? distance : 0,
              deltaY: horizontal ? 0 : distance,
            });
            // Wheel dispatch is queued by Chromium's compositor. Wait for its
            // frames before returning a page a caller can inspect, even when hidden.
            await abortable(Promise.race([
              cdp.sendCommand("Runtime.evaluate", { expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", awaitPromise: true }),
              delay(2_000),
            ]), signal);
          }
          this.#touch(page);
          return { tab: this.#summary(page), navigated: false };
        });
      },
      // A script may await a page event or navigation, so it cannot hold the input
      // queue. Scripts can mutate the page; prefer the queued tools for input.
      evaluate: async ({ tab, script, signal }) => {
        const page = await this.#agentPage(tab, signal);
        const cdp = await this.#debugger(page);
        signal?.throwIfAborted();
        const evaluation = cdp.sendCommand("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true, userGesture: true }) as Promise<{
          result?: { type?: string; value?: unknown; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>;
        const outcome = await abortable(evaluation, signal);
        this.#touch(page);
        if (outcome.exceptionDetails) throw new Error(`The script failed: ${outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text ?? "unknown error"}`);
        const value = outcome.result?.value;
        const result = value === undefined ? (outcome.result?.description ?? outcome.result?.type ?? "undefined") : typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
        return { tab: this.#summary(page), result };
      },
      wait: async ({ tab, text, seconds, signal }) => {
        const page = await this.#agentPage(tab);
        const contents = page.view.webContents;
        const deadline = Date.now() + Math.max(0, seconds) * 1_000;
        const needle = text?.trim().toLowerCase() ?? "";
        await this.#debugger(page);
        for (;;) {
          signal?.throwIfAborted();
          if (needle) {
            const body = await contents.executeJavaScriptInIsolatedWorld(isolatedWorldId, [{ code: "document.body ? document.body.innerText : ''" }]).catch(() => "");
            if (typeof body === "string" && body.toLowerCase().includes(needle)) return { tab: this.#summary(page), found: true };
          } else if (!contents.isLoading()) {
            return { tab: this.#summary(page), found: null };
          }
          if (Date.now() >= deadline) return { tab: this.#summary(page), found: needle ? false : null };
          await delay(250);
        }
      },
      console: async ({ tab }) => {
        const page = await this.#agentPage(tab);
        return { tab: this.#summary(page), entries: [...page.console] };
      },
      close: async ({ tab, owner }) => {
        const page = await this.#agentPage(tab);
        if (page.openedBy !== "agent") throw new Error("That tab is the person's. Close only tabs you opened.");
        if (!owner || page.owner !== owner) throw new Error("Another Chat opened that tab. Close only tabs this Chat opened.");
        this.#synced = { ...this.#synced, tabs: this.#synced.tabs.filter((item) => item.pageId !== page.pageId) };
        this.#destroy(page);
      },
    };
    // Every step a Chat's Worker takes in a page marks the page as in use by that Chat.
    const marked = <Input extends { tab: string; owner?: string; signal?: AbortSignal }, Result>(operation: (input: Input) => Promise<Result>) => async (input: Input): Promise<Result> => {
      if (!input.owner) return await operation(input);
      const page = await this.#agentPage(input.tab, input.signal);
      return await this.#using(page, input.owner, () => operation(input));
    };
    return {
      ...operations,
      navigate: marked(operations.navigate),
      read: marked(operations.read),
      screenshot: marked(operations.screenshot),
      click: marked(operations.click),
      hover: marked(operations.hover),
      drag: marked(operations.drag),
      upload: marked(operations.upload),
      downloads: marked(operations.downloads),
      type: marked(operations.type),
      press: marked(operations.press),
      scroll: marked(operations.scroll),
      evaluate: marked(operations.evaluate),
      wait: marked(operations.wait),
    };
  }

  #tabSummaries(): BrowserTabSummary[] {
    const result: BrowserTabSummary[] = [];
    const seen = new Set<string>();
    for (const tab of this.#synced.tabs) {
      seen.add(tab.pageId);
      const page = this.#pages.get(tab.pageId);
      result.push(page ? this.#summary(page) : { tab: tab.pageId, url: tab.url, title: tab.title, loading: false, viewing: tab.pageId === this.#synced.viewingPageId });
    }
    for (const page of this.#pages.values()) if (!seen.has(page.pageId) && !page.closed) result.push(this.#summary(page));
    return result;
  }

  #summary(page: BrowserPage): BrowserTabSummary {
    const contents = page.view.webContents;
    const destroyed = contents.isDestroyed();
    return {
      tab: page.pageId,
      url: destroyed ? "" : contents.getURL(),
      title: destroyed ? "" : contents.getTitle(),
      loading: destroyed ? false : contents.isLoading(),
      viewing: page.pageId === this.#synced.viewingPageId,
      ...(page.error ? { error: `${page.error.description || "The page did not load"} (${page.error.url})` } : {}),
      ...(page.crashed ? { error: "The page stopped unexpectedly. Reload it to try again." } : {}),
      ...(page.permissions[0] ? { asking: `The page is waiting for the person to let it ${browserPermissionPhrase(page.permissions[0].request.kinds)}.` } : {}),
    };
  }

  /** A tab a Worker named: a live page, or a restored tab that loads now. */
  async #agentPage(tab: string, signal?: AbortSignal): Promise<BrowserPage> {
    const pageId = tab.trim();
    const live = this.#pages.get(pageId);
    if (live && !live.closed && !live.view.webContents.isDestroyed()) return live;
    const restored = this.#synced.tabs.find((item) => item.pageId === pageId);
    if (restored && restored.url && isBrowserUrl(restored.url)) {
      const page = this.#createPage(pageId, restored.url, "person");
      await delay(50);
      await this.#waitForLoad(page, signal);
      return page;
    }
    throw new Error(`There is no browser tab "${tab}". Use browser_tabs to see the open tabs, or browser_open to open one.`);
  }

  async #debugger(page: BrowserPage): Promise<Debugger> {
    this.#touch(page);
    this.#park(page);
    const contents = page.view.webContents;
    if (page.debuggerReady && contents.debugger.isAttached()) return await page.debuggerReady;
    page.debuggerReady = (async () => {
      const cdp = contents.debugger;
      if (!cdp.isAttached()) cdp.attach("1.3");
      cdp.once("detach", () => { page.debuggerReady = null; this.#unpark(page); });
      // A background page then renders and takes input as if it were in front.
      await cdp.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await cdp.sendCommand("DOM.enable");
      return cdp;
    })();
    try {
      return await page.debuggerReady;
    } catch (error) {
      page.debuggerReady = null;
      throw new Error(`The page could not be controlled: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Keeps a page awake while a Worker uses it, and lets it rest after a quiet spell. */
  #touch(page: BrowserPage): void {
    if (page.debuggerIdle) clearTimeout(page.debuggerIdle);
    page.debuggerIdle = setTimeout(() => {
      page.debuggerIdle = null;
      const contents = page.view.webContents;
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        try { contents.debugger.detach(); } catch { /* already detached */ }
      }
      page.debuggerReady = null;
    }, agentIdleDetachMs);
    page.debuggerIdle.unref?.();
  }

  async #waitForLoad(page: BrowserPage, signal: AbortSignal | undefined, timeoutMs = navigationTimeoutMs): Promise<void> {
    const contents = page.view.webContents;
    const deadline = Date.now() + timeoutMs;
    while (!contents.isDestroyed() && contents.isLoading() && Date.now() < deadline) {
      signal?.throwIfAborted();
      await delay(100);
    }
    this.#touch(page);
  }

  /**
   * One Worker operation at a time on a page: two Chats typing at once would
   * otherwise move focus under each other. An operation waits for the one
   * before it to finish; Stop while waiting gives up the turn without acting.
   */
  async #exclusive<T>(page: BrowserPage, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const previous = page.operations;
    let finish!: () => void;
    const mine = new Promise<void>((resolve) => { finish = resolve; });
    page.operations = previous.then(() => mine);
    try {
      await abortable(previous, signal);
      signal?.throwIfAborted();
      return await operation();
    } finally {
      finish();
    }
  }

  /** Runs an input action and reports whether it led to a new page. */
  async #observeAction(page: BrowserPage, signal: AbortSignal | undefined, action: () => Promise<void>, gesture = true): Promise<BrowserActionResult> {
    const contents = page.view.webContents;
    const before = { url: contents.getURL(), index: contents.navigationHistory.getActiveIndex() };
    // Stop before any input reaches the page; an action already sent is not taken back.
    signal?.throwIfAborted();
    // A Worker's click or key counts as a press, so a link it opens in a new tab is not blocked.
    if (gesture) page.lastInputAt = Date.now();
    await action();
    await delay(300);
    await this.#waitForLoad(page, signal, actionSettleMs);
    const navigated = !contents.isDestroyed()
      && (contents.getURL() !== before.url || contents.navigationHistory.getActiveIndex() !== before.index);
    return { tab: this.#summary(page), navigated };
  }

  async #press(cdp: Debugger, presses: BrowserKeyPress[], signal?: AbortSignal): Promise<void> {
    for (const press of presses) {
      signal?.throwIfAborted();
      const base = { key: press.key, code: press.code, windowsVirtualKeyCode: press.keyCode, nativeVirtualKeyCode: press.keyCode, modifiers: press.modifiers };
      await cdp.sendCommand("Input.dispatchKeyEvent", {
        ...base,
        type: press.text ? "keyDown" : "rawKeyDown",
        ...(press.text ? { text: press.text, unmodifiedText: press.text } : {}),
        ...(press.commands ? { commands: press.commands } : {}),
      });
      await cdp.sendCommand("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    }
  }

  /** Real pointer drags, including Chromium's native HTML drag-and-drop path. */
  async #drag(cdp: Debugger, start: { x: number; y: number }, end: { x: number; y: number }, signal?: AbortSignal): Promise<void> {
    let data: Record<string, unknown> | null = null;
    let pressed = false;
    let dropped = false;
    let point = start;
    const intercept = (_event: Electron.Event, method: string, params: { data?: Record<string, unknown> }) => {
      if (method === "Input.dragIntercepted" && params.data) data = params.data;
    };
    cdp.on("message", intercept);
    try {
      signal?.throwIfAborted();
      await cdp.sendCommand("Input.setInterceptDrags", { enabled: true });
      signal?.throwIfAborted();
      await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
      signal?.throwIfAborted();
      await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
      pressed = true;
      for (let step = 1; step <= 12; step += 1) {
        signal?.throwIfAborted();
        point = { x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12 };
        await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "left", buttons: 1 });
        await abortable(delay(16), signal);
        if (data) break;
      }
      if (data) {
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          signal?.throwIfAborted();
          await cdp.sendCommand("Input.dispatchDragEvent", { type, ...end, data });
        }
        dropped = true;
        point = end;
      }
    } finally {
      // Release even after Stop; cancel an unfinished native drag before letting go.
      if (!dropped) await cdp.sendCommand("Input.cancelDragging").catch(() => undefined);
      if (pressed) await cdp.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
      await cdp.sendCommand("Input.setInterceptDrags", { enabled: false }).catch(() => undefined);
      cdp.removeListener("message", intercept);
    }
  }

  async #viewport(page: BrowserPage): Promise<{ width: number; height: number }> {
    const size = await page.view.webContents.executeJavaScriptInIsolatedWorld(isolatedWorldId, [{ code: "[innerWidth, innerHeight]" }]).catch(() => null);
    if (Array.isArray(size) && typeof size[0] === "number" && typeof size[1] === "number" && size[0] > 0 && size[1] > 0) return { width: size[0], height: size[1] };
    const bounds = page.view.getBounds();
    return { width: bounds.width || defaultPageSize.width, height: bounds.height || defaultPageSize.height };
  }

  async #resolve(cdp: Debugger, ref: string): Promise<string> {
    const resolved = await cdp.sendCommand("DOM.resolveNode", { backendNodeId: refNodeId(ref) }).catch(() => { throw staleRef(ref); }) as { object?: { objectId?: string } };
    if (!resolved.object?.objectId) throw staleRef(ref);
    return resolved.object.objectId;
  }

  async #elementCenter(page: BrowserPage, ref: string, scroll = true): Promise<{ x: number; y: number }> {
    const box = await this.#elementBox(page, ref, scroll);
    const viewport = await this.#viewport(page);
    const left = Math.max(0, box.x), top = Math.max(0, box.y);
    const right = Math.min(viewport.width, box.x + box.width), bottom = Math.min(viewport.height, box.y + box.height);
    if (right <= left || bottom <= top) throw new Error(`The element ${ref} is outside the viewport. Scroll to it first.`);
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }

  /** The element's box in the viewport, after scrolling it into view. */
  async #elementBox(page: BrowserPage, ref: string, scroll = true): Promise<{ x: number; y: number; width: number; height: number }> {
    const cdp = await this.#debugger(page);
    const backendNodeId = refNodeId(ref);
    if (scroll) await cdp.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => { throw staleRef(ref); });
    const quads = await cdp.sendCommand("DOM.getContentQuads", { backendNodeId }).catch(() => { throw staleRef(ref); }) as { quads?: number[][] };
    for (const quad of quads.quads ?? []) {
      if (quad.length < 8) continue;
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
      const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const width = Math.max(...xs) - x;
      const height = Math.max(...ys) - y;
      if (width >= 1 && height >= 1) return { x, y, width, height };
    }
    throw new Error(`The element ${ref} is not visible on the page, so it cannot be clicked. Read the page again, or scroll to it.`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A short, unused page id. */
export function newPageId(pages: ReadonlyMap<string, unknown>): string {
  for (;;) {
    const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
    if (id.length >= 6 && !pages.has(id)) return id;
  }
}

export function parseBrowserViewRequest(value: unknown): BrowserViewRequest {
  const record = objectRecord(value, "The browser view request is invalid.");
  const bounds = objectRecord(record.bounds, "The browser view bounds are invalid.");
  const numbers = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) < 100_000)) throw new Error("The browser view bounds are invalid.");
  if (!isBrowserPageId(record.pageId)) throw new Error("The browser tab id is invalid.");
  if (typeof record.url !== "string" || record.url.length > 32_768) throw new Error("The browser address is invalid.");
  if (typeof record.sequence !== "number" || !Number.isSafeInteger(record.sequence) || record.sequence < 0) throw new Error("The browser view sequence is invalid.");
  return {
    pageId: record.pageId,
    url: record.url && isBrowserUrl(record.url) ? record.url : "",
    sequence: record.sequence,
    bounds: { x: bounds.x as number, y: bounds.y as number, width: Math.max(0, bounds.width as number), height: Math.max(0, bounds.height as number) },
    active: record.active === true,
    occluded: record.occluded === true,
  };
}

export function parseBrowserTabsSync(value: unknown): BrowserTabsSync {
  const record = objectRecord(value, "The browser tab list is invalid.");
  if (!Array.isArray(record.tabs) || record.tabs.length > 1_000) throw new Error("The browser tab list is invalid.");
  const tabs = record.tabs.map((item) => {
    const tab = objectRecord(item, "The browser tab list is invalid.");
    if (!isBrowserPageId(tab.pageId) || typeof tab.url !== "string" || typeof tab.title !== "string") throw new Error("The browser tab list is invalid.");
    return { pageId: tab.pageId, url: tab.url.slice(0, 32_768), title: tab.title.slice(0, 1_000) };
  });
  const viewingPageId = isBrowserPageId(record.viewingPageId) ? record.viewingPageId : null;
  return { tabs, viewingPageId };
}

export function parseBrowserCommand(value: unknown): BrowserCommand {
  const record = objectRecord(value, "The browser command is invalid.");
  if (record.type === "find") {
    if (typeof record.text !== "string" || record.text.length > 1_000) throw new Error("The text to find is invalid.");
    return { type: "find", text: record.text, forward: record.forward !== false, newSearch: record.newSearch === true };
  }
  if (record.type === "forget-permission" || record.type === "open-privacy-settings") {
    const kind = browserSitePermissions.find((item) => item === record.kind);
    if (!kind) throw new Error("The site permission is invalid.");
    return { type: record.type, kind };
  }
  if (record.type === "mute") {
    if (typeof record.muted !== "boolean") throw new Error("The browser command is invalid.");
    return { type: "mute", muted: record.muted };
  }
  const simple = ["back", "forward", "reload", "stop", "focus", "stop-find", "inspect", "zoom-in", "zoom-out", "zoom-reset", "dismiss-notice", "print", "save-pdf", "open-blocked-popup", "allow-popups", "dismiss-blocked-popup"] as const;
  const type = simple.find((item) => item === record.type);
  if (!type) throw new Error("The browser command is invalid.");
  return { type };
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function clippedViewBounds(bounds: Rectangle, contentBounds: Rectangle, zoomFactor: number): Rectangle {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = Math.max(0, Math.round(bounds.x * scale));
  const y = Math.max(0, Math.round(bounds.y * scale));
  const right = Math.min(contentBounds.width, Math.round((bounds.x + bounds.width) * scale));
  const bottom = Math.min(contentBounds.height, Math.round((bounds.y + bounds.height) * scale));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pushBounded(list: string[], entry: string): void {
  list.push(entry.length > 2_000 ? `${entry.slice(0, 1_999)}…` : entry);
  if (list.length > consoleLimit) list.splice(0, list.length - consoleLimit);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 200) || "download";
}

/** A path in the folder no file and no unfinished download uses: "name (1).ext" after "name.ext". */
function uniquePath(directory: string, name: string, pending: ReadonlySet<string>): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let candidate = join(directory, name);
  for (let index = 1; existsSync(candidate) || pending.has(candidate); index += 1) candidate = join(directory, `${stem} (${index})${extension}`);
  return candidate;
}

function refNodeId(ref: string): number {
  const id = backendNodeIdForRef(ref);
  if (id === null) throw new Error(`"${ref}" is not an element ref. Refs look like e123 and come from browser_read.`);
  return id;
}

function staleRef(ref: string): Error {
  return new Error(`The element ${ref} is no longer on the page. Read the page again for current refs.`);
}

function pointFrom(x: number | undefined, y: number | undefined): { x: number; y: number } {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
    throw new Error("Give an element ref from browser_read, or both x and y in page pixels from a screenshot.");
  }
  return { x, y };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Stopped."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Chooses the option whose value or visible label matches, the way a person picks from a list. */
const chooseOptionFunction = `function (wanted) {
  const target = String(wanted).trim().toLowerCase();
  const options = Array.from(this.options);
  const option = options.find((item) => item.value.toLowerCase() === target)
    || options.find((item) => item.label.trim().toLowerCase() === target)
    || options.find((item) => item.label.trim().toLowerCase().includes(target));
  if (!option) return null;
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return option.label;
}`;

/** Selects what is in the focused field, so typing replaces it. */
const selectFocusedContentsExpression = `(() => {
  const element = document.activeElement;
  if (!element) return false;
  if (typeof element.select === "function") { element.select(); return true; }
  if (element.isContentEditable) { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true; }
  return false;
})()`;
