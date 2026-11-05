import { pageCallErrorOf, pageCallOps, type PageCall, type PageCallError } from "./pages";

/**
 * The host side of the page sandbox (docs/pages.md, "How a page runs"),
 * following the paired-browser app view's intermediary pattern
 * (services/bridge/public/browser-app.js). It embeds the intermediary served
 * at /page-frame.html with `sandbox="allow-scripts allow-forms"` and never
 * `allow-same-origin`, hands it the assembled page over a fresh per-view
 * channel, and accepts messages only from that exact intermediary window
 * carrying that channel. The message protocol is documented in
 * src/local/pages/frame/page-frame-assets.ts.
 */

export const pageFrameMessage = {
  ready: "work-fold.page.ready",
  init: "work-fold.page.init",
  loaded: "work-fold.page.loaded",
  call: "work-fold.page.call",
  result: "work-fold.page.result",
  link: "work-fold.page.link",
  changed: "work-fold.page.changed",
  navigated: "work-fold.page.navigated",
} as const;

export const pageFrameSandbox = "allow-scripts allow-forms";

/** Calls a view answers at once; page code queues more itself. */
export const maximumPageCallsInFlight = 8;
/** A call's JSON may hold every column at its longest. */
export const maximumPageCallCharacters = 8 * 1024 * 1024;
const mutatingOps = new Set<string>(["add", "update", "remove"]);

export type PageFrameFailure = "timeout" | "navigated";

export interface PageFrameOptions {
  container: HTMLElement;
  frameUrl: string;
  title: string;
  html: string;
  owner: boolean;
  tables: Record<string, Record<string, string>>;
  call: (call: PageCall) => Promise<unknown>;
  openLink: (href: string) => void;
  onLoaded?: () => void;
  onFailed?: (reason: PageFrameFailure) => void;
  /** A call from this view changed the page's data. */
  onMutated?: (table: string) => void;
  loadTimeoutMs?: number;
  /** Tests supply their own channel; the page tab makes a fresh one per view. */
  channel?: string;
}

export interface PageFrameHandle {
  frame: HTMLIFrameElement;
  channel: string;
  /** Tells the page its data changed (its onChange callbacks run). */
  notifyChanged: (table: string | null) => void;
  destroy: () => void;
}

export function mountPageFrame(options: PageFrameOptions): PageFrameHandle {
  const channel = options.channel ?? newChannel();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", pageFrameSandbox);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.className = "page-preview-frame";
  frame.title = options.title;
  frame.src = options.frameUrl;
  let html: string | null = options.html;
  let destroyed = false;
  let loaded = false;
  let inFlight = 0;
  const loadTimer = window.setTimeout(() => {
    if (!destroyed && !loaded) options.onFailed?.("timeout");
  }, options.loadTimeoutMs ?? 10_000);

  const post = (message: Record<string, unknown>) => {
    if (!destroyed) frame.contentWindow?.postMessage({ ...message, channel }, "*");
  };
  const respond = (callId: number, payload: { ok: true; result: unknown } | { ok: false; error: PageCallError }) => {
    post({ type: pageFrameMessage.result, callId, ...payload });
  };

  function receive(event: MessageEvent) {
    if (destroyed || event.source !== frame.contentWindow || event.source === null) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") return;
    if (data.type === pageFrameMessage.ready) {
      // One page per view: a second ready (the intermediary reloaded) gets nothing.
      if (html === null) return;
      frame.contentWindow!.postMessage({ type: pageFrameMessage.init, channel, html, title: options.title, owner: options.owner, tables: options.tables }, "*");
      html = null;
      return;
    }
    if (data.channel !== channel) return;
    if (data.type === pageFrameMessage.loaded) {
      if (!loaded) { loaded = true; window.clearTimeout(loadTimer); options.onLoaded?.(); }
      return;
    }
    if (data.type === pageFrameMessage.navigated) {
      options.onFailed?.("navigated");
      return;
    }
    if (data.type === pageFrameMessage.link) {
      const href = externalPageLink(data.href);
      if (href) options.openLink(href);
      return;
    }
    if (data.type !== pageFrameMessage.call) return;
    const callId = data.callId;
    if (typeof callId !== "number" || !Number.isSafeInteger(callId) || callId < 1) return;
    const call = pageCallFrom(data.call);
    if (!call) return respond(callId, { ok: false, error: { code: "INVALID", message: "That isn't something a page can ask for." } });
    let size = Infinity;
    try { size = JSON.stringify(call).length; } catch { /* refused below */ }
    if (size > maximumPageCallCharacters) return respond(callId, { ok: false, error: { code: "TOO_LARGE", message: "That's too much to save at once." } });
    if (inFlight >= maximumPageCallsInFlight) return respond(callId, { ok: false, error: { code: "UNAVAILABLE", message: "The page is busy. Try again in a moment." } });
    inFlight++;
    void options.call(call).then((result) => {
      if (destroyed) return;
      respond(callId, { ok: true, result: result === undefined ? null : result });
      if (mutatingOps.has(call.op)) {
        options.onMutated?.(call.table);
        post({ type: pageFrameMessage.changed, table: call.table });
      }
    }, (error: unknown) => {
      if (!destroyed) respond(callId, { ok: false, error: pageCallErrorOf(error) });
    }).finally(() => { inFlight--; });
  }

  window.addEventListener("message", receive);
  options.container.append(frame);
  return {
    frame,
    channel,
    notifyChanged(table) { post({ type: pageFrameMessage.changed, table }); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(loadTimer);
      window.removeEventListener("message", receive);
      frame.remove();
    },
  };
}

/** Only the documented calls, with their documented fields, cross into the host. */
export function pageCallFrom(value: unknown): PageCall | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.op !== "string" || !(pageCallOps as readonly string[]).includes(record.op)) return null;
  if (typeof record.table !== "string" || !record.table || record.table.length > 64) return null;
  const call: PageCall = { op: record.op as PageCall["op"], table: record.table };
  for (const key of ["values", "id", "where", "options"] as const) if (record[key] !== undefined) call[key] = record[key];
  if (record.requestId !== undefined) {
    if (typeof record.requestId !== "string" || !record.requestId || record.requestId.length > 128) return null;
    call.requestId = record.requestId;
  }
  return call;
}

/** A link a page may open outside itself: web and email addresses only. */
export function externalPageLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Opens a page's link the way the app opens other outside links. */
export function openPageLink(href: string): void {
  const shell = window.workFoldDesktop?.shell;
  if (shell) void shell.openExternal(href).catch(() => undefined);
  else window.open(href, "_blank", "noopener,noreferrer");
}

function newChannel(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
