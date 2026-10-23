/**
 * The built-in browser (docs/built-in-browser.md): one set of browser tabs
 * that belongs to no work-folder. Every work-folder's tab strip shows them,
 * and every Worker and the work-fold agent can use them. These are the shapes
 * the desktop host, the renderer, and the agent tools share.
 */

/** One persistent profile for every browser tab: cookies and sign-ins survive restarts. */
export const browserPartition = "persist:work-fold-browser";

/** Where a search typed into the address bar goes. */
export const browserSearchUrl = "https://www.google.com/search?q=";

/** What a site can ask the person for; each is allowed or blocked per site. */
export const browserSitePermissions = ["camera", "microphone", "location", "notifications", "midi", "clipboard", "windows", "idle"] as const;
export type BrowserSitePermission = (typeof browserSitePermissions)[number];
export type BrowserSiteDecision = "allow" | "block";

/** A site's request the person has not answered yet. */
export interface BrowserPermissionRequest {
  requestId: string;
  origin: string;
  kinds: BrowserSitePermission[];
}

const permissionPhrases: Record<BrowserSitePermission, string> = {
  camera: "use your camera",
  microphone: "use your microphone",
  location: "know your location",
  notifications: "show notifications",
  midi: "use your MIDI devices",
  clipboard: "see what you copy",
  windows: "manage windows on all your displays",
  idle: "know when you're using this computer",
};

/** "use your camera and microphone", "know your location and show notifications". */
export function browserPermissionPhrase(kinds: readonly BrowserSitePermission[]): string {
  const ordered = browserSitePermissions.filter((kind) => kinds.includes(kind));
  const phrases = ordered.includes("camera") && ordered.includes("microphone")
    ? ["use your camera and microphone", ...ordered.filter((kind) => kind !== "camera" && kind !== "microphone").map((kind) => permissionPhrases[kind])]
    : ordered.map((kind) => permissionPhrases[kind]);
  if (phrases.length <= 1) return phrases[0] ?? "";
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/** What a saved decision is called in the site's settings: "Camera", "Location". */
export const browserPermissionNames: Record<BrowserSitePermission, string> = {
  camera: "Camera",
  microphone: "Microphone",
  location: "Location",
  notifications: "Notifications",
  midi: "MIDI devices",
  clipboard: "Clipboard",
  windows: "Window management",
  idle: "Activity",
};

/** What the renderer shows for one browser tab; the desktop host sends it on every change. */
export interface BrowserPageState {
  pageId: string;
  url: string;
  title: string;
  /** A `data:` image URL; null when the page has none or it could not be read. */
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The last failed main-frame load; the next navigation clears it. */
  error: { code: number; description: string; url: string } | null;
  crashed: boolean;
  audible: boolean;
  /** What the person decided for this page's site, shown in its site settings. */
  sitePermissions: Array<{ kind: BrowserSitePermission; decision: BrowserSiteDecision }>;
  /** The site is waiting for the person to allow or block something. */
  permissionRequest: BrowserPermissionRequest | null;
  /** Why something the person allowed still cannot work, such as macOS keeping the camera off. */
  notice: { kind: BrowserSitePermission; text: string } | null;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The renderer's placeholder for one browser tab: where the page shows, and whether it should. */
export interface BrowserViewRequest {
  pageId: string;
  /** Loaded when the page does not exist yet, as for a tab restored after a restart. */
  url: string;
  sequence: number;
  bounds: BrowserViewBounds;
  active: boolean;
  occluded: boolean;
}

/** The renderer's open browser tabs, so a Worker can list them and open a restored one. */
export interface BrowserTabsSync {
  tabs: Array<{ pageId: string; url: string; title: string }>;
  /** The browser tab in front, when the person is looking at one. */
  viewingPageId: string | null;
}

/** Asks the renderer to add a browser tab: a link that opens a new tab, or a Worker's page. */
export interface BrowserOpenTabCommand {
  pageId: string;
  url: string;
  title: string;
  /** Bring the tab to the front; a Worker's tabs open behind the person's. */
  show: boolean;
}

export interface BrowserFindResult {
  pageId: string;
  matches: number;
  activeMatch: number;
  final: boolean;
}

/** A browser key the renderer handles while the page has keyboard focus. */
export interface BrowserShortcut {
  pageId: string;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface BrowserDownload {
  filename: string;
  path: string;
  state: "completed" | "cancelled" | "interrupted";
}

/** A browser tab as a Worker sees it. */
export interface BrowserTabSummary {
  tab: string;
  url: string;
  title: string;
  loading: boolean;
  /** The person has this tab in front. */
  viewing: boolean;
  /** Why the page did not load, or that it stopped. */
  error?: string;
  /** What the page is waiting for the person to allow, in words. */
  asking?: string;
}

export interface BrowserActionResult {
  tab: BrowserTabSummary;
  /** The action led to a new page. */
  navigated: boolean;
}

/**
 * What the agent tools need from the desktop host. Present only in the
 * desktop app; a development API without Electron gives Workers no browser.
 */
export interface BrowserToolHost {
  tabs(): Promise<BrowserTabSummary[]>;
  /** `owner` names the Chat opening the tab; only that Chat may close it. */
  open(input: { url: string; show?: boolean; signal?: AbortSignal; owner?: string }): Promise<BrowserTabSummary>;
  navigate(input: { tab: string; to: string; signal?: AbortSignal }): Promise<BrowserTabSummary>;
  read(input: { tab: string; mode: "structure" | "text"; find?: string; offset?: number }): Promise<{ tab: BrowserTabSummary; text: string; total: number; nextOffset: number | null }>;
  screenshot(input: { tab: string; ref?: string; fullPage?: boolean }): Promise<{ tab: BrowserTabSummary; data: string; mimeType: string; width: number; height: number }>;
  click(input: { tab: string; ref?: string; x?: number; y?: number; double?: boolean; signal?: AbortSignal }): Promise<BrowserActionResult>;
  type(input: { tab: string; ref?: string; text: string; clear?: boolean; submit?: boolean; signal?: AbortSignal }): Promise<BrowserActionResult>;
  press(input: { tab: string; keys: string; signal?: AbortSignal }): Promise<BrowserActionResult>;
  scroll(input: { tab: string; ref?: string; direction?: "up" | "down" | "left" | "right"; amount?: number; signal?: AbortSignal }): Promise<BrowserActionResult>;
  evaluate(input: { tab: string; script: string; signal?: AbortSignal }): Promise<{ tab: BrowserTabSummary; result: string }>;
  wait(input: { tab: string; text?: string; seconds: number; signal?: AbortSignal }): Promise<{ tab: BrowserTabSummary; found: boolean | null }>;
  console(input: { tab: string }): Promise<{ tab: BrowserTabSummary; entries: string[] }>;
  close(input: { tab: string; owner?: string }): Promise<void>;
}

const pageIdPattern = /^[a-z0-9]{6,32}$/;

export function isBrowserPageId(value: unknown): value is string {
  return typeof value === "string" && pageIdPattern.test(value);
}

/** Schemes a browser tab may show. Anything else is handed to the system or refused. */
export function isBrowserUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:") return true;
  return url.protocol === "about:" && url.pathname === "blank";
}

const schemePattern = /^[a-z][a-z0-9+.-]*:/i;
const hostWithPortPattern = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?(?:[/?#].*)?$/i;
const domainPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;

/**
 * Turns what someone typed into the address bar into an address: a full
 * address stays as it is, a bare host gets https (http for this computer),
 * an absolute path becomes a file, and anything else becomes a search.
 */
export function browserAddressFor(input: string, searchUrl = browserSearchUrl): string | null {
  const text = input.trim();
  if (!text) return null;
  // macOS paths often hold spaces ("/Users/me/My Site/index.html").
  if (text.startsWith("/") && !text.startsWith("//")) return encodeFileUrl(text);
  if (schemePattern.test(text) && !/\s/.test(text)) {
    const scheme = text.slice(0, text.indexOf(":")).toLowerCase();
    // `localhost:3000` and `example.com:8080` read as a scheme; they are hosts.
    if (!hostWithPortPattern.test(text) && !domainPattern.test(text)) {
      if (scheme === "javascript") return `${searchUrl}${encodeURIComponent(text)}`;
      return text;
    }
  }
  if (!/\s/.test(text)) {
    if (hostWithPortPattern.test(text)) return `http://${text}`;
    if (domainPattern.test(text)) return `https://${text}`;
  }
  return `${searchUrl}${encodeURIComponent(text)}`;
}

function encodeFileUrl(path: string): string {
  return `file://${path.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

/** What the address bar shows for an address: nothing for a blank page. */
export function browserDisplayAddress(url: string): string {
  return url === "about:blank" ? "" : url;
}

/**
 * The browser's user agent: Chromium's, with the app's own product token and
 * without Electron's. Google's sign-in refuses an embedded browser that claims
 * to be plain Chrome but accepts one that names itself, as Claude's and other
 * Electron browsers do; sites that turn away an "Electron" token see none.
 */
export function browserUserAgent(product: string, platform: NodeJS.Platform = process.platform, chromeVersion = process.versions.chrome ?? "148.0.0.0"): string {
  const system = platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  const token = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._+-]+$/.test(product) ? `${product} ` : "";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) ${token}Chrome/${chromeVersion} Safari/537.36`;
}

/** The kinds of access one Electron permission asks for. */
export function permissionKinds(permission: string, mediaTypes: readonly string[]): BrowserSitePermission[] {
  switch (permission) {
    case "media": return browserSitePermissions.filter((kind) => (kind === "camera" && mediaTypes.includes("video")) || (kind === "microphone" && mediaTypes.includes("audio")));
    case "geolocation": return ["location"];
    case "notifications": return ["notifications"];
    case "midi":
    case "midiSysex": return ["midi"];
    case "clipboard-read":
    case "deprecated-sync-clipboard-read": return ["clipboard"];
    case "window-management": return ["windows"];
    case "idle-detection": return ["idle"];
    default: return [];
  }
}

/** The web origin a permission belongs to, or null for anything that is not a web page. */
export function siteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
