/**
 * Local API routes for pages (docs/pages.md, "Local API"). Everything under
 * `/api/work-folders/:id/pages` requires the ordinary local session, which
 * `server.ts` checks before routing here. The sandbox intermediary
 * (`/page-frame.html`, `/page-frame.js`) is static and content-free, so it is
 * served before the session check: a frame cannot send the session header.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { PageCallErrorCode, PageDeclaration } from "../../shared/pages/index.js";
import {
  PageCallError,
  deletePageDataRows,
  exportPageDataTableCsv,
  listPageDataTables,
  markPageDataTableSeen,
  parsePageCall,
  parsePageViewer,
  readPageDataTable,
  readStoredPageDeclaration,
  restorePageDataRows,
  runPageCall,
  updatePageDataRow,
} from "../../shared/pages/index.js";
import { getWorkFolder } from "../work-folder.js";
import { PAGE_FRAME_CONTENT_SECURITY_POLICY, PAGE_FRAME_HTML, PAGE_FRAME_SCRIPT } from "./frame/page-frame-assets.js";
import { findPageFolders, PageFolderError } from "./page-folder-files.js";
import { analyzePageFolder, assemblePageFolder, inspectPageFolder, readPageFolderDeclaration } from "./page-inspection.js";
import { currentPreviewVisitor, withPagePreviewDatabase } from "./page-preview-store.js";

export interface PageRouteContext {
  /** Reads the request's JSON body with the server's ordinary bounds. */
  readJson(): Promise<unknown>;
}

const pageCallStatus: Record<PageCallErrorCode, number> = {
  NOT_ALLOWED: 403,
  INVALID: 400,
  DUPLICATE: 409,
  LIMIT_REACHED: 409,
  NOT_FOUND: 404,
  TOO_LARGE: 413,
  UNAVAILABLE: 503,
};

/** Serves the sandbox intermediary with its own policy. Returns false for any other request. */
export function servePageFrameAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const asset = pathname === "/page-frame.html"
    ? { body: PAGE_FRAME_HTML, type: "text/html; charset=utf-8" }
    : pathname === "/page-frame.js" ? { body: PAGE_FRAME_SCRIPT, type: "text/javascript; charset=utf-8" } : null;
  if (!asset) return false;
  res.writeHead(200, {
    "content-type": asset.type,
    "content-length": Buffer.byteLength(asset.body),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...(PAGE_FRAME_CONTENT_SECURITY_POLICY ? { "content-security-policy": PAGE_FRAME_CONTENT_SECURITY_POLICY } : {}),
  });
  res.end(method === "HEAD" ? undefined : asset.body);
  return true;
}

const pagesRoute = /^\/api\/work-folders\/([^/]+)\/pages(?:\/(.*))?$/u;

/**
 * Handles `/api/work-folders/:id/pages…`. Returns false when the path isn't a
 * page route. Refusals from page calls and the Data view answer with
 * `{ error, code, message, field? }`; anything else throws for the server's
 * ordinary error response.
 */
export async function handlePageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: PageRouteContext,
): Promise<boolean> {
  const matched = pagesRoute.exec(url.pathname);
  if (!matched) return false;
  const method = req.method ?? "GET";
  const workFolderId = decodePathSegment(matched[1] ?? "");
  const route = `${method} ${matched[2] ?? ""}`;
  try {
    const workFolder = await getWorkFolder(workFolderId);
    const root = workFolder.workFolderRoot;
    switch (route) {
      case "GET ":
      case "GET /": {
        const found = await findPageFolders(root);
        const pages = [];
        for (const path of found.pages) {
          try {
            const analysis = await analyzePageFolder(root, path, "check");
            pages.push({
              path,
              title: analysis.page.title,
              problemCount: analysis.problems.length,
              errorCount: analysis.problems.filter((problem) => problem.severity === "error").length,
            });
          } catch {
            // It changed while it was being read; it will show on the next refresh.
          }
        }
        sendJson(res, { pages, truncated: found.truncated });
        return true;
      }
      case "GET inspect":
        sendJson(res, await inspectPageFolder(root, url.searchParams.get("page")));
        return true;
      case "GET document":
        sendJson(res, await assemblePageFolder(root, url.searchParams.get("page")));
        return true;
      case "POST preview/call": {
        const body = await readBody(context);
        const read = await readPageFolderDeclaration(root, body.page);
        const declaration = read.declaration;
        if (!declaration) {
          throw new PageCallError("UNAVAILABLE", "This page can't save entries until the problems in page.json are fixed.");
        }
        const viewer = parsePageViewer(body.viewer);
        const call = parsePageCall(body.call);
        const result = await withPagePreviewDatabase(workFolder.id, read.path, declaration, ({ db }) => runPageCall(db, declaration, viewer, call));
        sendJson(res, { result });
        return true;
      }
      case "POST preview/visitor": {
        const body = await readBody(context);
        if (body.fresh !== undefined && typeof body.fresh !== "boolean") throw new PageFolderError(400, "fresh must be true or false.");
        const read = await readPageFolderDeclaration(root, body.page);
        const visitor = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) => currentPreviewVisitor(db, body.fresh === true));
        sendJson(res, { visitor });
        return true;
      }
      case "GET preview/data": {
        const read = await readPageFolderDeclaration(root, url.searchParams.get("page"));
        const table = url.searchParams.get("table");
        const deleted = /^(?:1|true)$/iu.test(url.searchParams.get("deleted") ?? "");
        const payload = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) => {
          const declaration = effectiveDeclaration(read.declaration, db);
          return table ? readPageDataTable(db, declaration, table, { deleted }) : { tables: listPageDataTables(db, declaration) };
        });
        sendJson(res, payload);
        return true;
      }
      case "POST preview/data/update": {
        const body = await readBody(context);
        const table = requireTableName(body.table);
        const read = await readPageFolderDeclaration(root, body.page);
        const row = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) => {
          const declaration = effectiveDeclaration(read.declaration, db);
          if (!declaration) throw new PageCallError("UNAVAILABLE", "Entries can't be edited until the problems in page.json are fixed.");
          return updatePageDataRow(db, declaration, table, body.id, body.values);
        });
        sendJson(res, { row });
        return true;
      }
      case "POST preview/data/delete":
      case "POST preview/data/restore": {
        const body = await readBody(context);
        const table = requireTableName(body.table);
        const read = await readPageFolderDeclaration(root, body.page);
        const restoring = route.endsWith("restore");
        const count = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) => {
          const declaration = effectiveDeclaration(read.declaration, db);
          return restoring ? restorePageDataRows(db, declaration, table, body.ids) : deletePageDataRows(db, declaration, table, body.ids);
        });
        sendJson(res, restoring ? { restored: count } : { deleted: count });
        return true;
      }
      case "POST preview/data/seen": {
        const body = await readBody(context);
        const table = requireTableName(body.table);
        const read = await readPageFolderDeclaration(root, body.page);
        const lastSeen = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) =>
          markPageDataTableSeen(db, effectiveDeclaration(read.declaration, db), table));
        sendJson(res, { lastSeen });
        return true;
      }
      case "GET preview/data/export": {
        const table = requireTableName(url.searchParams.get("table"));
        const read = await readPageFolderDeclaration(root, url.searchParams.get("page"));
        const csv = await withPagePreviewDatabase(workFolder.id, read.path, read.declaration, ({ db }) =>
          exportPageDataTableCsv(db, effectiveDeclaration(read.declaration, db), table));
        const fileName = `${table}.csv`;
        res.writeHead(200, {
          "content-type": "text/csv; charset=utf-8",
          "content-length": Buffer.byteLength(csv),
          "content-disposition": `attachment; filename="${fileName}"`,
          "cache-control": "no-store",
        });
        res.end(csv);
        return true;
      }
      default:
        throw new PageFolderError(404, "Not found.");
    }
  } catch (error) {
    if (error instanceof PageCallError) {
      sendJson(res, { error: error.message, ...error.toJSON() }, pageCallStatus[error.code]);
      return true;
    }
    throw error;
  }
}

/** The declaration now in page.json, or the last one applied while page.json has problems. */
function effectiveDeclaration(current: PageDeclaration | null, db: Parameters<typeof readStoredPageDeclaration>[0]): PageDeclaration | null {
  return current ?? readStoredPageDeclaration(db);
}

async function readBody(context: PageRouteContext): Promise<Record<string, unknown>> {
  const body = await context.readJson();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PageFolderError(400, "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

function requireTableName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 64) throw new PageFolderError(400, "Name the table.");
  return value;
}

function decodePathSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new PageFolderError(400, "That work-folder id isn't valid."); }
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
