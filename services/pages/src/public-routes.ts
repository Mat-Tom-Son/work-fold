/**
 * Visitor routes on the public port (docs/pages.md, "Public routes"): the
 * trusted shell, the page's document, page calls for this visitor, the
 * sandbox intermediary, `/health`, and `robots.txt`. Unknown and unpublished
 * pages are indistinguishable: one "Nothing is published here." page.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PageCallOp } from "../../../src/shared/pages/index.js";
import { parsePageCall, runPageCall } from "../../../src/shared/pages/index.js";
import { PAGE_FRAME_HTML, PAGE_FRAME_SCRIPT } from "../../../src/local/pages/frame/page-frame-assets.js";
import { HttpError, clientAddress, isLoopbackHost, readCookie, readJsonObject, requestHostname, sendError, sendJson } from "./http.js";
import { isPageId, visitorCookiePattern } from "./ids.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  HOSTED_PAGE_FRAME_CONTENT_SECURITY_POLICY,
  NOT_PUBLISHED_HTML,
  NOT_PUBLISHED_TEXT,
  PAGE_SHELL_CONTENT_SECURITY_POLICY,
  PAGE_SHELL_CSS,
  PAGE_SHELL_PERMISSIONS_POLICY,
  PAGE_SHELL_SCRIPT,
  PAGE_SHELL_SCRIPT_PATH,
  PAGE_SHELL_STYLE_PATH,
  ROBOTS_TXT,
  pageShellHtml,
} from "./shell.js";
import type { PageRecord, PageStore } from "./store.js";
import { columnTypes } from "./store.js";

export interface VisitorLimits {
  /** Page calls a minute from one address, across every page. */
  callsPerAddressPerMinute: number;
  /** Page calls a minute to one page, from every address. */
  callsPerPagePerMinute: number;
  /** Document loads a minute from one address. */
  documentsPerAddressPerMinute: number;
  /** One call's body: values are at most 1 MiB of JSON, so this leaves room for the rest. */
  maxCallBytes: number;
}

export interface PublicContext {
  store: PageStore;
  limiter: RateLimiter;
  limits: VisitorLimits;
  trustProxy: boolean;
  publicOrigin: string | null;
  documents: DocumentCache;
  health: () => unknown;
}

export const visitorCookieName = "wfv";
/** About 400 days, the longest a browser keeps a cookie. */
const visitorCookieMaxAge = 400 * 24 * 60 * 60;
const mutatingOps: ReadonlySet<PageCallOp> = new Set<PageCallOp>(["add", "update", "remove"]);
const minuteMs = 60_000;

const staticAssets = new Map<string, { body: Buffer; type: string; etag: string; headers: Record<string, string> }>([
  ["/page-frame.html", asset(PAGE_FRAME_HTML, "text/html; charset=utf-8", {
    "content-security-policy": HOSTED_PAGE_FRAME_CONTENT_SECURITY_POLICY,
    "x-frame-options": "SAMEORIGIN",
  })],
  ["/page-frame.js", asset(PAGE_FRAME_SCRIPT, "text/javascript; charset=utf-8", { "content-security-policy": HOSTED_PAGE_FRAME_CONTENT_SECURITY_POLICY })],
  [PAGE_SHELL_SCRIPT_PATH, asset(PAGE_SHELL_SCRIPT, "text/javascript; charset=utf-8", {})],
  [PAGE_SHELL_STYLE_PATH, asset(PAGE_SHELL_CSS, "text/css; charset=utf-8", {})],
  ["/robots.txt", asset(ROBOTS_TXT, "text/plain; charset=utf-8", {})],
]);

export async function handlePublicRequest(req: IncomingMessage, res: ServerResponse, context: PublicContext): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = safePathname(req.url);
  const reading = method === "GET" || method === "HEAD";
  const base = baseHeaders(req, context);
  if (reading && pathname === "/health") {
    sendJson(res, 200, context.health(), base);
    return;
  }
  const staticAsset = reading ? staticAssets.get(pathname) : undefined;
  if (staticAsset) {
    sendStatic(req, res, staticAsset, base);
    return;
  }
  const route = /^\/p\/([^/]+)(\/(?:document|call)?)?$/u.exec(pathname);
  if (route) {
    const pageId = route[1]!;
    const rest = route[2] ?? "";
    if ((rest === "" || rest === "/") && reading) {
      const page = onlinePage(context.store, pageId);
      if (!page) return sendNotPublished(res, base);
      sendHtml(res, 200, pageShellHtml(page.title), base);
      return;
    }
    if (rest === "/document" && reading) {
      await sendDocument(req, res, pageId, context, base);
      return;
    }
    if (rest === "/call" && method === "POST") {
      await handleCall(req, res, pageId, context, base);
      return;
    }
  }
  sendNotPublished(res, base);
}

async function sendDocument(req: IncomingMessage, res: ServerResponse, pageId: string, context: PublicContext, base: Record<string, string>): Promise<void> {
  const page = onlinePage(context.store, pageId);
  if (!page) return sendJson(res, 404, notPublishedRefusal(), base);
  if (!context.limiter.take(`document:${clientAddress(req, context.trustProxy)}`, context.limits.documentsPerAddressPerMinute, minuteMs)) {
    return sendJson(res, 429, tooManyRefusal(), { ...base, "retry-after": "60" });
  }
  const etag = `"${page.revision}-${createHash("sha256").update(`${page.pageId}\n${page.revision}\n${page.contentDigest}`).digest("hex").slice(0, 24)}"`;
  const headers = { ...base, etag, "cache-control": "no-cache", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const body = await context.documents.get(page, context.store);
  if (!body) return sendJson(res, 404, notPublishedRefusal(), base);
  res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

async function handleCall(req: IncomingMessage, res: ServerResponse, pageId: string, context: PublicContext, base: Record<string, string>): Promise<void> {
  if (!onlinePage(context.store, pageId)) return sendJson(res, 404, notPublishedRefusal(), base);
  if (!fromThisOrigin(req, context)) {
    return sendError(res, new HttpError(403, "NOT_ALLOWED", "Page calls come only from the page itself."), base);
  }
  const address = clientAddress(req, context.trustProxy);
  if (!context.limiter.take(`address:${address}`, context.limits.callsPerAddressPerMinute, minuteMs)
    || !context.limiter.take(`page:${pageId}`, context.limits.callsPerPagePerMinute, minuteMs)) {
    return sendJson(res, 429, tooManyRefusal(), { ...base, "retry-after": "60" });
  }
  let cookie: string | null = null;
  try {
    const body = await readJsonObject(req, context.limits.maxCallBytes);
    let visitor = readCookie(req, visitorCookieName);
    if (!visitor || !visitorCookiePattern.test(visitor)) visitor = `v_${randomBytes(16).toString("hex")}`;
    // Every answer refreshes the cookie, so a returning visitor keeps their entries.
    cookie = visitorCookie(pageId, visitor, !isLoopbackHost(requestHostname(req, context.trustProxy)));
    const call = parsePageCall(body.call);
    // The page may have gone offline while the body arrived.
    const page = onlinePage(context.store, pageId);
    if (!page) return sendJson(res, 404, notPublishedRefusal(), base);
    const declaration = context.store.declarationOf(page);
    const viewer = { role: "visitor", visitor } as const;
    const result = mutatingOps.has(call.op)
      ? context.store.changeData(pageId, (db) => runPageCall(db, declaration, viewer, call))
      : context.store.readData(pageId, (db) => runPageCall(db, declaration, viewer, call));
    sendJson(res, 200, { result }, { ...base, "set-cookie": cookie });
  } catch (error) {
    sendError(res, error, cookie ? { ...base, "set-cookie": cookie } : base);
  }
}

/** The page when it exists and is online; null for anything else, so callers can't tell the two apart. */
function onlinePage(store: PageStore, pageId: string): PageRecord | null {
  if (!isPageId(pageId)) return null;
  const page = store.getPage(pageId);
  return page && page.status === "online" ? page : null;
}

/**
 * Page calls come from the shell's own script: a browser marks them
 * same-origin, and another site can't make one with this visitor's cookie.
 */
function fromThisOrigin(req: IncomingMessage, context: PublicContext): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (context.publicOrigin && origin === context.publicOrigin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const forwarded = context.trustProxy ? String(req.headers["x-forwarded-host"] ?? "").split(",")[0]!.trim() : "";
  const host = (forwarded || String(req.headers.host ?? "")).toLowerCase();
  return parsed.host.toLowerCase() === host && (parsed.protocol === "https:" || isLoopbackHost(parsed.hostname));
}

function visitorCookie(pageId: string, visitor: string, secure: boolean): string {
  return `${visitorCookieName}=${visitor}; Path=/p/${pageId}; Max-Age=${visitorCookieMaxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function notPublishedRefusal() {
  return { error: NOT_PUBLISHED_TEXT, code: "UNAVAILABLE", message: NOT_PUBLISHED_TEXT };
}

function tooManyRefusal() {
  const message = "This page is getting a lot of requests right now. Try again in a minute.";
  return { error: message, code: "UNAVAILABLE", message };
}

function baseHeaders(req: IncomingMessage, context: PublicContext): Record<string, string> {
  return {
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    ...(isLoopbackHost(requestHostname(req, context.trustProxy)) ? {} : { "strict-transport-security": "max-age=31536000" }),
  };
}

function htmlHeaders(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    "content-security-policy": PAGE_SHELL_CONTENT_SECURITY_POLICY,
    "permissions-policy": PAGE_SHELL_PERMISSIONS_POLICY,
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

function sendHtml(res: ServerResponse, status: number, html: string, base: Record<string, string>): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, { ...htmlHeaders(base), "content-type": "text/html; charset=utf-8", "content-length": body.length });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

function sendNotPublished(res: ServerResponse, base: Record<string, string>): void {
  sendHtml(res, 404, NOT_PUBLISHED_HTML, base);
}

function sendStatic(req: IncomingMessage, res: ServerResponse, item: { body: Buffer; type: string; etag: string; headers: Record<string, string> }, base: Record<string, string>): void {
  const headers = { ...base, ...item.headers, etag: item.etag, "cache-control": "no-cache" };
  if (req.headers["if-none-match"] === item.etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-type": item.type, "content-length": item.body.length });
  res.end(req.method === "HEAD" ? undefined : item.body);
}

function asset(text: string, type: string, headers: Record<string, string>) {
  const body = Buffer.from(text, "utf8");
  return { body, type, headers, etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 24)}"` };
}

function safePathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://pages.invalid").pathname;
  } catch {
    return "/";
  }
}

/**
 * Encoded `{ html, title, tables }` bodies of active revisions, kept in
 * memory up to a byte budget so a popular page isn't re-read and re-encoded
 * for every visitor.
 */
export class DocumentCache {
  private readonly entries = new Map<string, Buffer>();
  private bytes = 0;

  constructor(private readonly maximumBytes = 64 * 1024 * 1024) {}

  async get(page: PageRecord, store: PageStore): Promise<Buffer | null> {
    const key = `${page.pageId}:${page.revision}:${page.contentDigest}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    let html: string;
    try {
      html = await readFile(store.documentPath(page.pageId, page.revision), "utf8");
    } catch {
      return null;
    }
    const body = Buffer.from(JSON.stringify({ html, title: page.title, tables: columnTypes(store.declarationOf(page)) }), "utf8");
    if (body.length <= this.maximumBytes / 2) {
      this.entries.set(key, body);
      this.bytes += body.length;
      for (const [oldest, buffer] of this.entries) {
        if (this.bytes <= this.maximumBytes) break;
        this.entries.delete(oldest);
        this.bytes -= buffer.length;
      }
    }
    return body;
  }
}
