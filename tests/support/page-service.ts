/**
 * Starts the page service (services/pages) in-process on random loopback
 * ports with a temporary data folder, for the page-service-* suites.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { startPageService, type PageService, type PageServiceOptions } from "../../services/pages/src/service.js";

export const ownerAccount = "11111111-2222-4333-8444-555555555555";
export const otherAccount = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const internalSecret = "test-secret-0123456789abcdef0123456789abcdef";

const base32 = "abcdefghijklmnopqrstuvwxyz234567";

export function newPageId(): string {
  return `pg_${Array.from(randomBytes(26), (byte) => base32[byte % 32]).join("")}`;
}

export function rsvpDeclaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "work-fold.page/1",
    title: "Garden Party RSVP",
    tables: {
      rsvps: {
        columns: {
          name: { type: "text", required: true },
          email: { type: "email", required: true, unique: true },
          note: { type: "long-text" },
        },
        visitors: ["add", "see-own", "edit-own"],
        limit: 50,
      },
    },
    ...overrides,
  };
}

export function publishBody(options: { declaration?: Record<string, unknown>; html?: string; title?: string; contentDigest?: string; files?: unknown } = {}): Record<string, unknown> {
  return {
    title: options.title ?? "Garden Party RSVP",
    html: options.html ?? "<!doctype html><html><head><title>RSVP</title></head><body><form data-page-table=\"rsvps\"></form></body></html>",
    declaration: options.declaration ?? rsvpDeclaration(),
    files: options.files ?? [{ path: "index.html", bytes: 120 }, { path: "page.json", bytes: 300 }],
    contentDigest: options.contentDigest ?? "sha256:0000000000000001",
  };
}

export interface JsonAnswer {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

export async function startTestPageService(t: TestContext, options: Partial<PageServiceOptions> = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), "work-fold-page-service-"));
  const start = (overrides: Partial<PageServiceOptions> = {}) => startPageService({
    dataDir,
    port: 0,
    host: "127.0.0.1",
    internalPort: 0,
    internalSecret,
    log: () => undefined,
    ...options,
    ...overrides,
  });
  let service: PageService = await start();
  t.after(async () => {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const answer = async (response: Response): Promise<JsonAnswer> => {
    const text = await response.text();
    let body: unknown = null;
    if (response.headers.get("content-type")?.includes("json")) body = JSON.parse(text);
    return { status: response.status, headers: response.headers, body, text };
  };

  const internal = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonAnswer> => {
    const response = await fetch(`${service.internalUrl}${path}`, {
      method,
      headers: {
        "x-work-fold-pages-secret": internalSecret,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return answer(response);
  };

  const pagePath = (pageId: string, account = ownerAccount) => `/internal/accounts/${account}/pages/${pageId}`;
  const publish = (pageId: string, body: Record<string, unknown> = publishBody(), account = ownerAccount) => internal("PUT", pagePath(pageId, account), body);

  /** A visitor's page call; `cookie` is the `wfv=…` pair a previous answer set. */
  const call = async (pageId: string, pageCall: unknown, options: { cookie?: string | null; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${service.publicUrl}/p/${pageId}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers },
      body: JSON.stringify({ call: pageCall }),
    });
    const setCookie = response.headers.getSetCookie()[0] ?? null;
    return { ...(await answer(response)), setCookie, cookie: setCookie ? setCookie.split(";", 1)[0]! : options.cookie ?? null };
  };

  const get = async (path: string, headers: Record<string, string> = {}) => answer(await fetch(`${service.publicUrl}${path}`, { headers }));

  return {
    dataDir,
    get service() { return service; },
    async restart(overrides: Partial<PageServiceOptions> = {}) {
      await service.close();
      service = await start(overrides);
      return service;
    },
    internal,
    pagePath,
    publish,
    call,
    get,
  };
}
