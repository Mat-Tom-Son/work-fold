/**
 * The publisher and owner API on the internal port (docs/pages.md, "Internal
 * routes"), reached only from the bridge over the private network. Every
 * request must carry `x-work-fold-pages-secret`; the bridge has already
 * authenticated the device or the owner and names the account in the path.
 * A page that doesn't belong to that account is answered exactly like one
 * that doesn't exist.
 */
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import {
  characterLength,
  deletePageDataRows,
  exportPageDataTableCsv,
  listPageDataTables,
  pageDeclarationLimits,
  parsePageDeclaration,
  parsePageDeclarationText,
  readPageDataTable,
  restorePageDataRows,
  updatePageDataRow,
} from "../../../src/shared/pages/index.js";
import { HttpError, invalid, readJsonObject, secretMatches, sendError, sendJson } from "./http.js";
import { isAccountId, isPageId } from "./ids.js";
import type { PageStore, PublishInput, PublishedFile } from "./store.js";
import { publicPage } from "./store.js";

export const internalSecretHeader = "x-work-fold-pages-secret";

export interface InternalLimits {
  /** A publish body: the assembled document plus page.json and the file list. */
  maxPublishBytes: number;
  /** An owner's data change, such as deleting many rows by id. */
  maxDataChangeBytes: number;
}

export interface InternalContext {
  store: PageStore;
  secret: string;
  limits: InternalLimits;
}

const maxFiles = 1_000;
const maxFilePathLength = 1_024;
const contentDigestPattern = /^[A-Za-z0-9:+/=._-]{8,200}$/u;

export async function handleInternalRequest(req: IncomingMessage, res: ServerResponse, context: InternalContext): Promise<void> {
  try {
    if (!secretMatches(req.headers[internalSecretHeader], context.secret)) throw new HttpError(401, "NOT_ALLOWED", "Not allowed.");
    await route(req, res, context);
  } catch (error) {
    sendError(res, error);
  }
}

async function route(req: IncomingMessage, res: ServerResponse, context: InternalContext): Promise<void> {
  const { store } = context;
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://pages.internal");
  const parts = url.pathname.split("/");
  // ["", "internal", "accounts", accountId, "pages", pageId?, ...rest]
  if (parts[1] !== "internal" || parts[2] !== "accounts" || parts[4] !== "pages" || parts.length < 5) throw notFound();
  const accountId = parts[3]!;
  if (!isAccountId(accountId)) throw invalid("That account id isn't valid.");
  const pageId = parts[5];
  const rest = parts.slice(6).join("/");

  if (pageId === undefined || (pageId === "" && parts.length === 6)) {
    if (method !== "GET") throw notAllowedMethod();
    sendJson(res, 200, { pages: store.listPages(accountId).map(publicPage) });
    return;
  }
  if (!isPageId(pageId)) throw notFound();

  const key = `${method} ${rest}`;
  switch (key) {
    case "PUT ": {
      const body = await readJsonObject(req, context.limits.maxPublishBytes);
      const page = await store.publish(accountId, pageId, parsePublishBody(body));
      sendJson(res, 200, { page: publicPage(page) });
      return;
    }
    case "DELETE ": {
      const page = await store.unpublish(accountId, pageId);
      sendJson(res, 200, { page: publicPage(page) });
      return;
    }
    case "GET ":
      sendJson(res, 200, { page: publicPage(store.requireOwnedPage(accountId, pageId)) });
      return;
    case "GET data.sqlite": {
      store.requireOwnedPage(accountId, pageId);
      const snapshot = store.snapshotPageData(pageId);
      try {
        const { size } = await stat(snapshot.path);
        res.writeHead(200, {
          "content-type": "application/vnd.sqlite3",
          "content-length": size,
          "content-disposition": "attachment; filename=\"data.sqlite\"",
          "cache-control": "no-store",
          "x-work-fold-data-revision": String(snapshot.dataRevision),
        });
        await pipeline(createReadStream(snapshot.path), res);
      } finally {
        await rm(snapshot.path, { force: true });
      }
      return;
    }
    case "GET data": {
      const page = store.requireOwnedPage(accountId, pageId);
      const declaration = store.declarationOf(page);
      const table = url.searchParams.get("table");
      const deleted = /^(?:1|true)$/iu.test(url.searchParams.get("deleted") ?? "");
      const payload = store.readData(pageId, (db) => (table
        ? readPageDataTable(db, declaration, requireTableName(table), { deleted })
        : { tables: listPageDataTables(db, declaration) }));
      sendJson(res, 200, payload);
      return;
    }
    case "POST data/update": {
      const page = store.requireOwnedPage(accountId, pageId);
      const body = await readJsonObject(req, context.limits.maxDataChangeBytes);
      const table = requireTableName(body.table);
      const declaration = store.declarationOf(page);
      const row = store.changeData(pageId, (db) => updatePageDataRow(db, declaration, table, body.id, body.values));
      sendJson(res, 200, { row });
      return;
    }
    case "POST data/delete":
    case "POST data/restore": {
      const page = store.requireOwnedPage(accountId, pageId);
      const body = await readJsonObject(req, context.limits.maxDataChangeBytes);
      const table = requireTableName(body.table);
      const declaration = store.declarationOf(page);
      if (rest === "data/restore") {
        sendJson(res, 200, { restored: store.changeData(pageId, (db) => restorePageDataRows(db, declaration, table, body.ids)) });
      } else {
        sendJson(res, 200, { deleted: store.changeData(pageId, (db) => deletePageDataRows(db, declaration, table, body.ids)) });
      }
      return;
    }
    case "GET data/export": {
      const page = store.requireOwnedPage(accountId, pageId);
      const table = requireTableName(url.searchParams.get("table"));
      const declaration = store.declarationOf(page);
      const csv = store.readData(pageId, (db) => exportPageDataTableCsv(db, declaration, table));
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-length": Buffer.byteLength(csv),
        "content-disposition": `attachment; filename="${table}.csv"`,
        "cache-control": "no-store",
      });
      res.end(csv);
      return;
    }
    default:
      throw notFound();
  }
}

/** Checks a publish body `{ title, html, declaration, files, contentDigest }`. Other fields are ignored. */
export function parsePublishBody(body: Record<string, unknown>): PublishInput {
  const parsed = typeof body.declaration === "string" ? parsePageDeclarationText(body.declaration) : parsePageDeclaration(body.declaration);
  if (!parsed.ok) throw invalid("page.json has problems, so the page can't be published.", { problems: parsed.problems });
  if (typeof body.html !== "string" || !body.html) throw invalid("Send the page's assembled document as html.");
  let title = parsed.declaration.title;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== "string") throw invalid("The title must be text.");
    const trimmed = body.title.trim();
    if (characterLength(trimmed) > pageDeclarationLimits.maxTitleLength) throw invalid(`The title can be at most ${pageDeclarationLimits.maxTitleLength} characters.`);
    if (trimmed) title = trimmed;
  }
  if (typeof body.contentDigest !== "string" || !contentDigestPattern.test(body.contentDigest)) {
    throw invalid("contentDigest must be the page's content digest.");
  }
  return { title, html: body.html, declaration: parsed.declaration, files: parseFiles(body.files), contentDigest: body.contentDigest };
}

function parseFiles(value: unknown): PublishedFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxFiles) throw invalid(`files must be a list of at most ${maxFiles.toLocaleString("en-US")} files.`);
  return value.map((item: unknown) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    const path = typeof item === "string" ? item : record && typeof record.path === "string" ? record.path : null;
    if (path === null || !path || path.length > maxFilePathLength) throw invalid("Each file must be a path, or { path, bytes }.");
    const bytes = record && typeof record.bytes === "number" && Number.isSafeInteger(record.bytes) && record.bytes >= 0 ? record.bytes : null;
    return { path, bytes };
  });
}

function requireTableName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 64) throw invalid("Name the table.");
  return value;
}

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "Not found.");
}

function notAllowedMethod(): HttpError {
  return new HttpError(405, "INVALID", "That method isn't supported here.");
}
