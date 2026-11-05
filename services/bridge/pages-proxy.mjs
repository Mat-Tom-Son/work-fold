// The bridge's half of online pages (docs/pages.md, "Publishing (stage 2)").
// The page service keeps every published page and its entries; its
// publisher/owner API is internal and trusts whoever holds the shared secret.
// The bridge authenticates the desktop (device token) and the owner (password
// session) and then calls that API with the account id in the path. Nothing
// here logs a page id, a link, or a request path: a page id is the only thing
// that grants a visitor access.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** `pg_` plus 26 lowercase RFC 4648 base32 characters (130 random bits). */
export const pageIdPattern = /^pg_[a-z2-7]{26}$/;
/** Publish bodies may be up to 26 MiB; every other page route keeps the bridge's ordinary JSON bound. */
export const maximumPagePublishBytes = 26 * 1024 * 1024;
export const pageServiceSecretHeader = "x-work-fold-pages-secret";
export const pagesUnavailableMessage = "Online pages aren't available yet.";
export const pagesUnreachableMessage = "Online pages can't be reached right now. Try again in a moment.";

const defaultPageServiceTimeoutMs = 60_000;
const minimumSecretLength = 16;

export function isValidPageId(value) {
  return typeof value === "string" && pageIdPattern.test(value);
}

/**
 * Reads the three page settings from the environment. All three or none: a
 * partial or invalid setup leaves online pages off with one warning (never the
 * values), so a pages mistake cannot take the chat relay down.
 */
export function pagesConfigurationFromEnvironment(environment = process.env, warn = console.warn) {
  const internalUrl = String(environment.WORKFOLD_PAGES_INTERNAL_URL ?? "").trim();
  const secret = String(environment.WORKFOLD_PAGES_INTERNAL_SECRET ?? "");
  const publicOrigin = String(environment.WORKFOLD_PAGES_PUBLIC_ORIGIN ?? "").trim();
  if (!internalUrl && !secret && !publicOrigin) return null;
  try {
    return normalizePagesConfiguration({ internalUrl, secret, publicOrigin });
  } catch (error) {
    warn(`work-fold bridge online pages are off: ${error instanceof Error ? error.message : "the page settings are invalid."}`);
    return null;
  }
}

/** Validates explicit settings; throws a plain message naming the setting, never its value. */
export function normalizePagesConfiguration(value) {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value !== "object") throw new TypeError("Online page settings must be an object.");
  let internal;
  try { internal = new URL(String(value.internalUrl ?? "")); } catch { throw new TypeError("WORKFOLD_PAGES_INTERNAL_URL must be an http or https URL."); }
  if ((internal.protocol !== "http:" && internal.protocol !== "https:") || internal.username || internal.password
    || internal.search || internal.hash) {
    throw new TypeError("WORKFOLD_PAGES_INTERNAL_URL must be an http or https URL without credentials, query, or fragment.");
  }
  const secret = String(value.secret ?? "");
  if (secret.length < minimumSecretLength || secret.length > 512 || !/^[\x21-\x7e]+$/.test(secret)) {
    throw new TypeError(`WORKFOLD_PAGES_INTERNAL_SECRET must be ${minimumSecretLength} to 512 visible ASCII characters.`);
  }
  let origin;
  try { origin = new URL(String(value.publicOrigin ?? "")); } catch { throw new TypeError("WORKFOLD_PAGES_PUBLIC_ORIGIN must be an origin such as https://pages.work-fold.com."); }
  const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) || origin.username || origin.password
    || (origin.pathname !== "/" && origin.pathname !== "") || origin.search || origin.hash) {
    throw new TypeError("WORKFOLD_PAGES_PUBLIC_ORIGIN must be an https origin (http only on loopback) with no path.");
  }
  const timeoutMs = Number.isInteger(value.timeoutMs) && value.timeoutMs > 0 ? value.timeoutMs : defaultPageServiceTimeoutMs;
  return Object.freeze({
    internalBase: `${internal.origin}${internal.pathname.replace(/\/+$/, "")}`,
    secret,
    publicOrigin: origin.origin,
    timeoutMs,
  });
}

/** The internal API path for one account, and optionally one page and a suffix. */
export function pageServicePath(accountId, pageId, suffix = "") {
  const account = `/internal/accounts/${encodeURIComponent(accountId)}/pages`;
  return pageId === undefined ? account : `${account}/${pageId}${suffix}`;
}

/**
 * Sends one internal request and resolves with the page service's response
 * stream once its headers arrive. `stream` forwards an incoming request body
 * chunk by chunk (with backpressure) and refuses it past `maximumBytes`; `json`
 * sends a small serialized body. Network failures reject with
 * `{ status: 502 }`; an oversized stream rejects with `{ status: 413 }`.
 */
export function sendPageServiceRequest(configuration, { method, path, query = [], json, stream, maximumBytes = Infinity, contentLength }) {
  const target = new URL(`${configuration.internalBase}${path}`);
  for (const [name, value] of query) target.searchParams.set(name, value);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  const body = json === undefined ? null : Buffer.from(JSON.stringify(json), "utf8");
  const headers = {
    [pageServiceSecretHeader]: configuration.secret,
    accept: "application/json, text/csv, application/octet-stream",
    ...(body ? { "content-type": "application/json; charset=utf-8", "content-length": String(body.length) } : {}),
    ...(stream ? { "content-type": "application/json; charset=utf-8" } : {}),
    ...(stream && contentLength !== undefined ? { "content-length": String(contentLength) } : {}),
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let detach = () => undefined;
    const upstream = transport(target, { method, headers, timeout: configuration.timeoutMs });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      detach();
      upstream.destroy();
      reject(error);
    };
    upstream.on("response", (incoming) => {
      if (settled) {
        incoming.resume();
        return;
      }
      settled = true;
      // An early answer (a refusal before the whole body was sent) stops the
      // forwarding; Node discards the rest of the caller's upload.
      detach();
      resolve(incoming);
    });
    upstream.on("timeout", () => upstream.destroy(new Error("The page service timed out.")));
    upstream.on("error", () => fail(pageProxyError(502, "UNAVAILABLE", pagesUnreachableMessage)));
    if (!stream) {
      upstream.end(body ?? undefined);
      return;
    }
    let size = 0;
    let ended = false;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) return fail(pageProxyError(413, "TOO_LARGE", "This page is too large to publish."));
      if (!upstream.write(chunk)) stream.pause();
    };
    const onDrain = () => stream.resume();
    const onEnd = () => {
      ended = true;
      detach();
      upstream.end();
    };
    const onClose = () => {
      if (!stream.complete) fail(pageProxyError(400, "INVALID", "The upload ended before it was complete."));
    };
    detach = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onClose);
      upstream.off("drain", onDrain);
      // Whatever the caller still sends is read and discarded, so it can
      // finish its upload and read the answer on the same connection.
      if (!ended) stream.resume();
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    stream.on("error", onClose);
    upstream.on("drain", onDrain);
  });
}

/** Reads a response body up to `maximumBytes`, rejecting past it. */
export async function readBoundedBody(stream, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximumBytes) {
      stream.destroy();
      throw pageProxyError(502, "UNAVAILABLE", pagesUnreachableMessage);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The refusal the bridge passes back for a page-service error: the status and
 * only the documented `{ error, code, message, field }` fields. A body that is
 * not that shape becomes a plain message for its status class.
 */
export function pageServiceErrorView(status, text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const plain = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
  const message = plain(object.message, 2_000) ?? plain(object.error, 2_000);
  const code = plain(object.code, 64);
  if (!message) {
    if (status >= 500) return { status: 502, body: { ok: false, error: pagesUnreachableMessage, code: "UNAVAILABLE", message: pagesUnreachableMessage } };
    const fallback = status === 404 ? "That page isn't published." : "The page service refused this request.";
    return { status, body: { ok: false, error: fallback, ...(code ? { code } : {}), message: fallback } };
  }
  const field = plain(object.field, 128);
  return {
    status,
    body: { ok: false, error: plain(object.error, 2_000) ?? message, ...(code ? { code } : {}), message, ...(field ? { field } : {}) },
  };
}

/** Headers copied from a successful page-service response; everything else is the bridge's own. */
export function passthroughPageHeaders(headers) {
  const result = {};
  const type = String(headers["content-type"] ?? "").toLowerCase();
  result["content-type"] = /^(?:application\/json|text\/csv|application\/vnd\.sqlite3|application\/x-sqlite3|application\/octet-stream)(?:\s*;.*)?$/.test(type)
    ? headers["content-type"]
    : "application/octet-stream";
  if (/^\d{1,15}$/.test(String(headers["content-length"] ?? ""))) result["content-length"] = headers["content-length"];
  const disposition = String(headers["content-disposition"] ?? "");
  if (/^attachment(?:;[^\r\n]{0,240})?$/i.test(disposition)) result["content-disposition"] = disposition;
  const revision = String(headers["x-work-fold-data-revision"] ?? "");
  if (/^\d{1,15}$/.test(revision)) result["x-work-fold-data-revision"] = revision;
  return result;
}

export function pageProxyError(status, code, message) {
  return Object.assign(new Error(message), { status, publicCode: code });
}
