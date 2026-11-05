/**
 * Small HTTP helpers for the page service (docs/pages.md, "Page service"):
 * bounded body reading, JSON answers, and the refusal shape every route
 * shares, `{ error, code, message, field? }`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PageCallErrorCode } from "../../../src/shared/pages/index.js";
import { PageCallError } from "../../../src/shared/pages/index.js";

/** A refusal with an HTTP status. `code` is one of the page-call codes so pages and the bridge read one shape. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: PageCallErrorCode;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: PageCallErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const pageCallStatus: Record<PageCallErrorCode, number> = {
  NOT_ALLOWED: 403,
  INVALID: 400,
  DUPLICATE: 409,
  LIMIT_REACHED: 409,
  NOT_FOUND: 404,
  TOO_LARGE: 413,
  UNAVAILABLE: 503,
};

export function invalid(message: string, details: Record<string, unknown> = {}): HttpError {
  return new HttpError(400, "INVALID", message, details);
}

/** Reads the whole body, refusing anything over `maxBytes` with 413. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge(maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) throw tooLarge(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

/** Reads a JSON object body. Only `application/json` is accepted, so a plain HTML form can't post here. */
export async function readJsonObject(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const type = String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "INVALID", "Send the request as JSON.");
  const body = await readBody(req, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw invalid("The request body isn't valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("The request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function tooLarge(maxBytes: number): HttpError {
  const size = maxBytes >= 1024 * 1024 ? `${Math.floor(maxBytes / (1024 * 1024))} MiB` : `${Math.floor(maxBytes / 1024)} KiB`;
  return new HttpError(413, "TOO_LARGE", `That's too large: a request can be at most ${size}.`);
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string | number | string[]> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(res.req?.method === "HEAD" ? undefined : body);
}

/** The JSON refusal for any error: page-call refusals keep their code; anything unexpected is a plain 500. */
export function sendError(res: ServerResponse, error: unknown, headers: Record<string, string | number | string[]> = {}): void {
  if (error instanceof PageCallError) {
    sendJson(res, pageCallStatus[error.code], { error: error.message, ...error.toJSON() }, headers);
    return;
  }
  if (error instanceof HttpError) {
    const close: Record<string, string> = error.status === 413 ? { connection: "close" } : {};
    sendJson(res, error.status, { error: error.message, code: error.code, message: error.message, ...error.details }, { ...close, ...headers });
    return;
  }
  sendJson(res, 500, { error: "Something went wrong.", code: "UNAVAILABLE", message: "Something went wrong." }, headers);
}

/** Compares a presented secret with the expected one in constant time (both are hashed to equal length first). */
export function secretMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string" || !presented) return false;
  const given = createHash("sha256").update(presented, "utf8").digest();
  const wanted = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(given, wanted);
}

/** The request's host name, from `x-forwarded-host` only behind a trusted proxy. */
export function requestHostname(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? String(req.headers["x-forwarded-host"] ?? "").split(",")[0]!.trim() : "";
  const raw = forwarded || String(req.headers.host ?? "");
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** The visitor's address for limits: `x-real-ip` only behind a trusted proxy. */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers["x-real-ip"] ?? "").trim();
    if (forwarded && forwarded.length <= 64 && /^[0-9A-Fa-f:.]+$/u.test(forwarded)) return forwarded;
  }
  return String(req.socket.remoteAddress ?? "unknown").slice(0, 64);
}

/** Reads one cookie by name from the request. */
export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}
