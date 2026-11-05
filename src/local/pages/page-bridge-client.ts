/**
 * The desktop's client for the bridge's device page routes (docs/pages.md,
 * "Publishing (stage 2)" → "Bridge"): list, publish, unpublish, the data
 * snapshot, and the owner's data changes, each authenticated with the Web
 * Access device token as `Authorization: Bearer <token>`. The connection is
 * read at call time, so turning Web Access on, off, or removing it applies to
 * the very next call. The desktop builds it over the encrypted Web Access
 * settings (desktop/src/pages-bridge.ts); `npm run local:dev` builds the same
 * client over two development variables (src/local/server-dev-options.ts).
 *
 * Nothing here logs. Errors never carry the device token, a page id, or a
 * link: a page id grants access to the page, so it stays out of messages.
 */
import { PageCallError, pageCallErrorCodes, type PageCallErrorCode } from "../../shared/pages/index.js";

/** Where the bridge is and the device's bearer token. */
export interface PagesBridgeConnection {
  bridgeUrl: string;
  deviceToken: string;
}

/** Why publishing can't reach the bridge right now. */
export type PagesBridgeUnavailableReason = "not-set-up" | "turned-off";

export type PagesBridgeConnectionState = PagesBridgeConnection | { unavailable: PagesBridgeUnavailableReason };

/** A page as the page service reports it (docs/pages.md, "Internal routes"). */
export interface PagesBridgePage {
  pageId: string;
  title: string;
  status: "online" | "unpublished";
  revision: number;
  publishedAt: string | null;
  updatedAt: string | null;
  dataRevision: number;
  entries: number | null;
}

export interface PagesBridgeList {
  pages: PagesBridgePage[];
  /** The origin page links are composed against, e.g. `https://pages.work-fold.com`. */
  pagesOrigin: string | null;
}

/** One file that went into the assembled document, page-folder-relative. */
export interface PagesBridgePublishedFile {
  path: string;
  bytes: number;
}

/** `PUT /api/device/pages/:pageId`: publish or publish changes. */
export interface PagesBridgePublishBody {
  title: string;
  /** The assembled, self-contained document. */
  html: string;
  /** page.json in its own shape (`pageDeclarationToJson`). */
  declaration: Record<string, unknown>;
  files: PagesBridgePublishedFile[];
  /** Lowercase hex SHA-256 over the canonical declaration and the document. */
  contentDigest: string;
}

export interface PagesBridgeSnapshot {
  bytes: Uint8Array;
  /** `x-work-fold-data-revision`, or null when the bridge didn't say. */
  dataRevision: number | null;
}

export type PagesBridgeDataAction = "update" | "delete" | "restore";

/**
 * What the local API needs from the bridge. Optional on `LocalApiOptions`: a
 * test or development API without one reports publishing unavailable.
 */
export interface WorkFoldPagesBridge {
  /** Whether a call would reach the bridge now: Web Access set up and turned on. */
  connection(): Promise<PagesBridgeConnectionState>;
  list(): Promise<PagesBridgeList>;
  publish(pageId: string, body: PagesBridgePublishBody): Promise<{ page: PagesBridgePage; pagesOrigin: string | null }>;
  /** Resolves to null when the page service doesn't know the page (it is already gone). */
  unpublish(pageId: string): Promise<{ page: PagesBridgePage } | null>;
  downloadData(pageId: string): Promise<PagesBridgeSnapshot>;
  /** The owner's data change; answers the preview data routes' shapes (`{ row }`, `{ deleted }`, `{ restored }`). */
  changeData(pageId: string, action: PagesBridgeDataAction, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Bounds for one bridge call. */
export const pagesBridgeLimits = Object.freeze({
  /** The bridge accepts publish bodies up to 26 MiB. */
  maxPublishBodyBytes: 26 * 1024 * 1024,
  /** A page database snapshot read into memory before it is written into the page folder. */
  maxSnapshotBytes: 512 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  transferTimeoutMs: 180_000,
});

/** The bridge answered with a failure that isn't a page-call refusal. */
export class PagesBridgeError extends Error {
  readonly status: number;
  readonly statusCode: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PagesBridgeError";
    this.status = status;
    // An unreachable or failing service is a gateway problem for the local API.
    this.statusCode = status === 404 ? 404 : status === 413 ? 413 : status === 503 ? 503 : 502;
  }
}

/** Web Access isn't set up, or is turned off. */
export class PagesBridgeUnavailableError extends Error {
  readonly reason: PagesBridgeUnavailableReason;
  readonly statusCode = 409;
  readonly code = "WEB_ACCESS_REQUIRED";
  constructor(reason: PagesBridgeUnavailableReason) {
    super(pagesBridgeUnavailableMessage(reason));
    this.name = "PagesBridgeUnavailableError";
    this.reason = reason;
  }
}

export function pagesBridgeUnavailableMessage(reason: PagesBridgeUnavailableReason): string {
  return reason === "turned-off"
    ? "Publishing needs Web Access, which is turned off. Turn it on in Settings → Web Access."
    : "Publishing needs Web Access. Set it up in Settings → Web Access.";
}

const pageIdSegment = /^pg_[a-z2-7]{26}$/u;

export interface PagesBridgeClientOptions {
  /** Read on every call. */
  getConnection(): Promise<PagesBridgeConnectionState>;
  fetchFn?: typeof fetch;
}

export function createPagesBridgeClient(options: PagesBridgeClientOptions): WorkFoldPagesBridge {
  const fetchFn = options.fetchFn ?? fetch;

  const connect = async (): Promise<PagesBridgeConnection> => {
    const state = await options.getConnection();
    if ("unavailable" in state) throw new PagesBridgeUnavailableError(state.unavailable);
    return state;
  };

  const send = async (
    path: string,
    init: { method: "GET" | "PUT" | "DELETE" | "POST"; body?: string; timeoutMs?: number },
  ): Promise<Response> => {
    const connection = await connect();
    let url: URL;
    try {
      url = new URL(path, connection.bridgeUrl);
    } catch {
      throw new PagesBridgeError(502, "The Web Access address isn't a valid web address.");
    }
    try {
      return await fetchFn(url, {
        method: init.method,
        headers: {
          authorization: `Bearer ${connection.deviceToken}`,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(init.timeoutMs ?? pagesBridgeLimits.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new PagesBridgeError(502, timedOut
        ? "work-fold.com didn't answer in time. Try again in a moment."
        : "work-fold couldn't reach work-fold.com. Check the internet connection and try again.");
    }
  };

  const json = async <T>(response: Response): Promise<T> => {
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw bridgeFailure(response.status, body);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PagesBridgeError(502, "work-fold.com sent an answer work-fold couldn't read.");
    }
    return body as T;
  };

  const pagePath = (pageId: string, suffix = ""): string => {
    if (!pageIdSegment.test(pageId)) throw new PagesBridgeError(400, "That page id isn't valid.");
    return `/api/device/pages/${pageId}${suffix}`;
  };

  return {
    connection: () => options.getConnection(),

    async list() {
      const body = await json<{ pages?: unknown; pagesOrigin?: unknown }>(await send("/api/device/pages", { method: "GET" }));
      return {
        pages: Array.isArray(body.pages) ? body.pages.map(readBridgePage).filter((page): page is PagesBridgePage => page !== null) : [],
        pagesOrigin: readOrigin(body.pagesOrigin),
      };
    },

    async publish(pageId, publishBody) {
      const text = JSON.stringify(publishBody);
      if (Buffer.byteLength(text, "utf8") > pagesBridgeLimits.maxPublishBodyBytes) {
        throw new PagesBridgeError(413, "This page is too large to publish: with its images and files inlined it comes to more than 26 MiB. Make the images smaller or remove files it doesn't need.");
      }
      const body = await json<{ page?: unknown; pagesOrigin?: unknown }>(await send(pagePath(pageId), {
        method: "PUT",
        body: text,
        timeoutMs: pagesBridgeLimits.transferTimeoutMs,
      }));
      const page = readBridgePage(body.page);
      if (!page || page.pageId !== pageId) throw new PagesBridgeError(502, "work-fold.com sent an answer work-fold couldn't read.");
      return { page, pagesOrigin: readOrigin(body.pagesOrigin) };
    },

    async unpublish(pageId) {
      const response = await send(pagePath(pageId), { method: "DELETE" });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const body = await json<{ page?: unknown }>(response);
      const page = readBridgePage(body.page);
      if (!page) throw new PagesBridgeError(502, "work-fold.com sent an answer work-fold couldn't read.");
      return { page };
    },

    async downloadData(pageId) {
      const response = await send(pagePath(pageId, "/data.sqlite"), { method: "GET", timeoutMs: pagesBridgeLimits.transferTimeoutMs });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as unknown;
        throw bridgeFailure(response.status, body);
      }
      const bytes = await readBoundedBytes(response, pagesBridgeLimits.maxSnapshotBytes);
      const header = response.headers.get("x-work-fold-data-revision");
      const parsed = header === null ? Number.NaN : Number(header);
      return { bytes, dataRevision: Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null };
    },

    async changeData(pageId, action, changeBody) {
      return json<Record<string, unknown>>(await send(pagePath(pageId, `/data/${action}`), {
        method: "POST",
        body: JSON.stringify(changeBody),
      }));
    },
  };
}

function bridgeFailure(status: number, body: unknown): Error {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = typeof record.code === "string" && (pageCallErrorCodes as readonly string[]).includes(record.code)
    ? record.code as PageCallErrorCode
    : null;
  const message = typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : typeof record.error === "string" && record.error.trim() ? record.error.trim() : null;
  if (code) return new PageCallError(code, message ?? "work-fold.com refused this change.", typeof record.field === "string" ? record.field : undefined);
  if (status === 401 || status === 403) {
    return new PagesBridgeError(status, "work-fold.com didn't accept this computer's Web Access. Check Settings → Web Access.");
  }
  return new PagesBridgeError(status, message ?? `work-fold.com couldn't do this (${status}).`);
}

function readBridgePage(value: unknown): PagesBridgePage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pageId !== "string" || !pageIdSegment.test(record.pageId)) return null;
  const count = (input: unknown): number => (typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0);
  const time = (input: unknown): string | null => (typeof input === "string" && input ? input : null);
  return {
    pageId: record.pageId,
    title: typeof record.title === "string" ? record.title : "",
    status: record.status === "online" ? "online" : "unpublished",
    revision: count(record.revision),
    publishedAt: time(record.publishedAt),
    updatedAt: time(record.updatedAt),
    dataRevision: count(record.dataRevision),
    entries: typeof record.entries === "number" && Number.isSafeInteger(record.entries) && record.entries >= 0 ? record.entries : null,
  };
}

function readOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PagesBridgeError(413, "This page's online entries are too large to bring into the folder.");
  }
  if (!response.body) return new Uint8Array(Buffer.from(await response.arrayBuffer()));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PagesBridgeError(413, "This page's online entries are too large to bring into the folder.");
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}
