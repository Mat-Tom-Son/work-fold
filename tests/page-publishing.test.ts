import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkFoldPagesBridge, PagesBridgePage, PagesBridgePublishBody } from "../src/local/pages/page-bridge-client.js";
import { createPagesBridgeClient, PagesBridgeError, PagesBridgeUnavailableError } from "../src/local/pages/page-bridge-client.js";
import { createPageId, PagePublicationStore, pageIdPattern, pageIdPrefix } from "../src/local/pages/page-publication-store.js";
import { pageContentDigest } from "../src/local/pages/page-publishing.js";
import { openPageSqliteDatabase, openPageSqliteReadOnly } from "../src/local/pages/page-sqlite.js";
import { WorkFoldCliActReceipts } from "../src/local/cli/act-receipts.js";
import { parseWorkFoldCliActArgv } from "../src/local/cli/act-commands.js";
import { workFoldCliHelp } from "../src/local/cli/commands.js";
import { createWorkFoldCliActRequest, executeWorkFoldCliActRequest } from "../src/local/cli/index.js";
import { WorkFoldCliError } from "../src/local/cli/protocol.js";
import { createDevelopmentPagesBridge } from "../src/local/server-dev-options.js";
import { startLocalApi } from "../src/local/server.js";
import { createDesktopPagesBridge } from "../desktop/src/pages-bridge.js";
import {
  applyPageSchema,
  deletePageDataRows,
  ensurePageMetaTable,
  parsePageDeclaration,
  restorePageDataRows,
  runPageCall,
  updatePageDataRow,
  type PageDeclaration,
} from "../src/shared/pages/index.js";

/**
 * Publishing pages from the desktop (docs/pages.md, "Publishing (stage 2)" →
 * "Desktop"): the record store and page ids, publish and unpublish through
 * the local API and the act lane with a fake bridge, checking in, Online
 * entries, and the development hook.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages", "sign-up-sheet");
const session = "publishing-session";
const token = "q".repeat(64);
const pagesOrigin = "https://pages.example.test";

interface FakePage {
  page: PagesBridgePage;
  body: PagesBridgePublishBody;
  declaration: PageDeclaration;
  dbPath: string;
}

/** A page service behind the bridge, in process: the real rules engine on a real file per page. */
class FakeBridge implements WorkFoldPagesBridge {
  readonly pages = new Map<string, FakePage>();
  readonly calls: string[] = [];
  state: "ready" | "not-set-up" | "turned-off" = "ready";
  failList = false;
  constructor(readonly directory: string) {}

  async connection() {
    return this.state === "ready" ? { bridgeUrl: "https://bridge.example.test", deviceToken: "device-token" } : { unavailable: this.state };
  }
  #require() {
    if (this.state !== "ready") throw new PagesBridgeUnavailableError(this.state);
  }
  async list() {
    this.#require();
    this.calls.push("list");
    if (this.failList) throw new PagesBridgeError(502, "work-fold couldn't reach work-fold.com.");
    return { pages: [...this.pages.values()].map((entry) => ({ ...entry.page })), pagesOrigin };
  }
  async publish(pageId: string, body: PagesBridgePublishBody) {
    this.#require();
    this.calls.push(`publish ${pageId}`);
    const parsed = parsePageDeclaration(body.declaration);
    assert.ok(parsed.ok, "the declaration uploads in page.json's own shape");
    const existing = this.pages.get(pageId);
    const dbPath = existing?.dbPath ?? join(this.directory, `${pageId}.sqlite`);
    const db = openPageSqliteDatabase(dbPath);
    try { applyPageSchema(db, parsed.declaration); } finally { db.close(); }
    const now = new Date().toISOString();
    const same = existing?.body.contentDigest === body.contentDigest;
    const page: PagesBridgePage = {
      pageId,
      title: body.title,
      status: "online",
      revision: same ? existing!.page.revision : (existing?.page.revision ?? 0) + 1,
      publishedAt: existing?.page.publishedAt ?? now,
      updatedAt: now,
      dataRevision: existing?.page.dataRevision ?? 0,
      entries: existing?.page.entries ?? 0,
    };
    this.pages.set(pageId, { page, body, declaration: parsed.declaration, dbPath });
    return { page: { ...page }, pagesOrigin: null };
  }
  async unpublish(pageId: string) {
    this.#require();
    this.calls.push(`unpublish ${pageId}`);
    const entry = this.pages.get(pageId);
    if (!entry) return null;
    entry.page = { ...entry.page, status: "unpublished" };
    return { page: { ...entry.page } };
  }
  async downloadData(pageId: string) {
    this.#require();
    this.calls.push(`download ${pageId}`);
    const entry = this.pages.get(pageId)!;
    return { bytes: new Uint8Array(await readFile(entry.dbPath)), dataRevision: entry.page.dataRevision };
  }
  async changeData(pageId: string, action: "update" | "delete" | "restore", body: Record<string, unknown>) {
    this.#require();
    this.calls.push(`${action} ${pageId}`);
    const entry = this.pages.get(pageId)!;
    const result = this.#withDb(entry, (db) => action === "update"
      ? { row: updatePageDataRow(db, entry.declaration, String(body.table), body.id, body.values) }
      : action === "delete"
        ? { deleted: deletePageDataRows(db, entry.declaration, String(body.table), body.ids) }
        : { restored: restorePageDataRows(db, entry.declaration, String(body.table), body.ids) });
    return result as Record<string, unknown>;
  }
  /** A visitor adds an entry online. */
  visitorAdds(pageId: string, values: Record<string, unknown>, visitor = `v_${"a".repeat(32)}`) {
    const entry = this.pages.get(pageId)!;
    return this.#withDb(entry, (db) => runPageCall(db, entry.declaration, { role: "visitor", visitor }, { op: "add", table: "signups", values, requestId: randomUUID() }));
  }
  #withDb<T>(entry: FakePage, operation: (db: ReturnType<typeof openPageSqliteDatabase>) => T): T {
    const db = openPageSqliteDatabase(entry.dbPath);
    try {
      const value = operation(db);
      const live = db.get(`SELECT COUNT(*) AS "count" FROM "signups" WHERE "_deleted" IS NULL`);
      entry.page = { ...entry.page, dataRevision: entry.page.dataRevision + 1, entries: Number(live?.count ?? 0) };
      return value;
    } finally {
      db.close();
    }
  }
}

async function setup(t: TestContext, options: { bridge?: "none" | "ready" } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-page-publishing-"));
  const stateBase = join(sandbox, "state");
  const serviceDirectory = join(sandbox, "service");
  await mkdir(serviceDirectory, { recursive: true });
  const bridge = new FakeBridge(serviceDirectory);
  const receipts = new WorkFoldCliActReceipts({ stateRoot: stateBase });
  const api = await startLocalApi({
    port: 0,
    stateBase,
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    sessionToken: session,
    actReceipts: receipts,
    pagesCheckInIntervalMs: 0,
    ...(options.bridge === "none" ? {} : { pagesBridge: bridge }),
  });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Events" });
  const pageFolder = join(workFolder.workFolderRoot, "Sign up");
  await cp(fixture, pageFolder, { recursive: true });
  const base = `/api/work-folders/${encodeURIComponent(workFolder.id)}/pages`;
  const request = async (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => {
    const url = new URL(path.startsWith("/api/pages") ? path : `${base}${path}`, api.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: { "x-work-fold-session": session, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as Record<string, any> : null };
  };
  const records: Array<Record<string, unknown>> = [];
  const run = (argv: string[]) => executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: api.actFacade, token }),
      receipts: {
        hasAccepted: async (requestId) => records.some((record) => record.requestId === requestId && record.outcome === "accepted"),
        append: async (record) => { records.push(structuredClone(record) as Record<string, unknown>); return true; },
      },
    },
  );
  const journal = async () => (await readFile(receipts.path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { api, sandbox, stateBase, bridge, workFolder, pageFolder, request, run, records, journal };
}

const onlyPageId = (bridge: FakeBridge): string => {
  assert.equal(bridge.pages.size, 1);
  return [...bridge.pages.keys()][0]!;
};

test("page ids are pg_ plus 26 lowercase base32 characters from 130 random bits", () => {
  for (let index = 0; index < 200; index += 1) assert.match(createPageId(), pageIdPattern);
  assert.equal(createPageId(() => new Uint8Array(17)), `pg_${"a".repeat(26)}`);
  assert.equal(createPageId(() => new Uint8Array(17).fill(0xff)), `pg_${"7".repeat(26)}`);
  // 0b00001 00010 00011 … : the first five bits of each byte pattern pick the alphabet in order.
  assert.equal(createPageId(() => Uint8Array.from([0x08, 0x86, 0x42, 0x98, 0xe8, ...new Array(12).fill(0)])).slice(0, 11), "pg_bcdefghi");
  const ids = new Set(Array.from({ length: 1000 }, () => createPageId()));
  assert.equal(ids.size, 1000);
  assert.equal(pageIdPrefix("pg_abcdefghijklmnopqrstuvwxyz"), "pg_abcde");
});

test("the record store keeps one id per page folder, writes atomically, and sets a damaged file aside", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "work-fold-page-records-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "pages", "publications.json");
  const store = new PagePublicationStore({ path });
  const first = await store.ensure("space-0123456789abcdef", "Sign up", "Volunteer Sign-up");
  assert.match(first.pageId, pageIdPattern);
  assert.equal(first.publishedAt, null);
  assert.equal((await store.ensure("space-0123456789abcdef", "Sign up", "Other")).pageId, first.pageId, "the id is kept for the folder");
  const second = await store.ensure("space-0123456789abcdef", "RSVP", "RSVP");
  assert.notEqual(second.pageId, first.pageId);
  await store.update(first.pageId, (draft) => { draft.lastSeen = { signups: "2026-11-05T00:00:00.000Z" }; draft.dataRevision = 4; });
  await store.setPagesOrigin(pagesOrigin);
  assert.deepEqual(await readdir(join(directory, "pages")), ["publications.json"], "no temporary file is left behind");

  const reopened = new PagePublicationStore({ path });
  const read = await reopened.get("space-0123456789abcdef", "Sign up");
  assert.equal(read?.pageId, first.pageId);
  assert.equal(read?.dataRevision, 4);
  assert.deepEqual(read?.lastSeen, { signups: "2026-11-05T00:00:00.000Z" });
  assert.equal(await reopened.pagesOrigin(), pagesOrigin);
  assert.equal((await reopened.byPageId(second.pageId))?.path, "RSVP");

  await writeFile(path, "{ not json");
  const fresh = new PagePublicationStore({ path });
  assert.deepEqual(await fresh.list(), []);
  assert.ok((await readdir(join(directory, "pages"))).some((name) => name.startsWith("publications.json.damaged-")));
});

test("publishing needs Web Access and a page without errors", async (t) => {
  const { request, bridge, pageFolder } = await setup(t, { bridge: "none" });
  const view = await request("GET", "/publication", undefined, { page: "Sign up" });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body, { available: false, unavailableReason: "Publishing needs Web Access. Set it up in Settings → Web Access.", publication: null });
  const refused = await request("POST", "/publish", { page: "Sign up" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.code, "WEB_ACCESS_REQUIRED");
  assert.equal(bridge.calls.length, 0);

  const second = await setup(t);
  second.bridge.state = "turned-off";
  const off = await second.request("GET", "/publication", undefined, { page: "Sign up" });
  assert.equal(off.body?.available, false);
  assert.match(String(off.body?.unavailableReason), /turned off/);
  assert.equal((await second.request("POST", "/publish", { page: "Sign up" })).body?.code, "WEB_ACCESS_REQUIRED");

  second.bridge.state = "ready";
  await writeFile(join(second.pageFolder, "index.html"), `<script src="https://cdn.example.com/x.js"></script>`);
  const problems = await second.request("POST", "/publish", { page: "Sign up" });
  assert.equal(problems.status, 422);
  assert.equal(problems.body?.code, "PAGE_HAS_PROBLEMS");
  assert.ok((problems.body?.problems as Array<{ severity: string }>).some((problem) => problem.severity === "error"));
  assert.equal(second.bridge.pages.size, 0, "nothing was uploaded");
  void pageFolder;
});

test("publish uploads the assembled page, records it, and journals a receipt without the id or link", async (t) => {
  const { request, bridge, pageFolder, journal, stateBase } = await setup(t);
  // Real visitors' data and hidden files are never part of the page.
  await writeFile(join(pageFolder, "data.sqlite"), "not really a database");
  await writeFile(join(pageFolder, ".notes.txt"), "private");
  const published = await request("POST", "/publish", { page: "Sign up" });
  assert.equal(published.status, 200, published.text);
  const pageId = onlyPageId(bridge);
  assert.match(pageId, pageIdPattern);
  const body = bridge.pages.get(pageId)!.body;
  assert.equal(body.title, "Volunteer Sign-up");
  assert.match(body.html, /<html|<!doctype/i);
  assert.equal(body.contentDigest, pageContentDigest(bridge.pages.get(pageId)!.declaration, body.html));
  const uploadedPaths = body.files.map((file) => file.path);
  assert.ok(uploadedPaths.includes("index.html") && uploadedPaths.includes("page.json"));
  assert.ok(!uploadedPaths.includes("data.sqlite") && !uploadedPaths.some((path) => path.startsWith(".")));

  assert.deepEqual(Object.keys(published.body!).sort(), ["publication", "uploaded"]);
  assert.deepEqual(published.body!.uploaded.files, body.files);
  assert.equal(published.body!.uploaded.bytes, body.files.reduce((total, file) => total + file.bytes, 0));
  const publication = published.body!.publication;
  assert.equal(publication.url, `${pagesOrigin}/p/${pageId}`);
  assert.equal(publication.status, "online");
  assert.equal(publication.revision, 1);
  assert.equal(publication.changesAvailable, false);
  assert.ok(publication.lastCheckIn, "publishing checks in");
  assert.deepEqual(Object.keys(publication).sort(), ["changesAvailable", "dataRevision", "entries", "lastCheckIn", "publishedAt", "revision", "status", "url"]);

  const view = await request("GET", "/publication", undefined, { page: "Sign up" });
  assert.deepEqual(view.body, { available: true, unavailableReason: null, publication });

  const receipts = (await journal()).filter((entry) => entry.command === "pages.publish");
  assert.deepEqual(receipts.map((entry) => entry.outcome), ["accepted", "ok"]);
  assert.match(String(receipts[1]!.detail), new RegExp(`^page\\.publish; page Sign up; id ${pageIdPrefix(pageId)}; revision 1; \\d+ files, \\d+ bytes$`));
  const everything = JSON.stringify(await journal());
  assert.ok(!everything.includes(pageId), "receipts never carry the whole page id");
  assert.ok(!everything.includes(pagesOrigin), "receipts never carry the link");

  // The record lives under the state root, never in the work-folder.
  assert.match(await readFile(join(stateBase, "pages", "publications.json"), "utf8"), new RegExp(pageId));
  const workFolderFiles = JSON.stringify(await readdir(dirname(pageFolder), { recursive: true }));
  assert.ok(!workFolderFiles.includes("publications"));
});

test("changesAvailable follows the assembled document and page.json", async (t) => {
  const { request, pageFolder, bridge } = await setup(t);
  await request("POST", "/publish", { page: "Sign up" });
  const view = async () => (await request("GET", "/publication", undefined, { page: "Sign up" })).body!.publication;
  assert.equal((await view()).changesAvailable, false);
  const original = await readFile(join(pageFolder, "index.html"), "utf8");
  await writeFile(join(pageFolder, "index.html"), original.replace("</body>", "<p>New line</p></body>"));
  assert.equal((await view()).changesAvailable, true);
  await writeFile(join(pageFolder, "index.html"), original);
  assert.equal((await view()).changesAvailable, false, "the same bytes again are not a change");
  const declaration = JSON.parse(await readFile(join(pageFolder, "page.json"), "utf8")) as { title: string };
  await writeFile(join(pageFolder, "page.json"), JSON.stringify({ ...declaration, title: "Spring Fair Sign-up" }, null, 2));
  assert.equal((await view()).changesAvailable, true, "page.json counts");
  // Whitespace in page.json is not a change: the canonical declaration is hashed.
  await writeFile(join(pageFolder, "page.json"), JSON.stringify(declaration));
  assert.equal((await view()).changesAvailable, false);
  // A change that breaks the page is still a change to publish (and publishing says what to fix).
  await writeFile(join(pageFolder, "index.html"), `<img src="missing.png">`);
  assert.equal((await view()).changesAvailable, true);

  // Publishing changes keeps the link and the id.
  await writeFile(join(pageFolder, "index.html"), original.replace("</body>", "<p>Changed</p></body>"));
  const again = await request("POST", "/publish", { page: "Sign up" });
  assert.equal(again.status, 200, again.text);
  assert.equal(bridge.pages.size, 1);
  assert.equal(again.body!.publication.revision, 2);
  assert.equal(again.body!.publication.changesAvailable, false);
});

test("unpublish takes the page offline, and publishing again brings back the same link", async (t) => {
  const { request, bridge, journal } = await setup(t);
  assert.equal((await request("POST", "/unpublish", { page: "Sign up" })).status, 404, "a page that was never published");
  const first = await request("POST", "/publish", { page: "Sign up" });
  const pageId = onlyPageId(bridge);
  const off = await request("POST", "/unpublish", { page: "Sign up" });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.body!.publication.status, "unpublished");
  assert.equal(off.body!.publication.url, first.body!.publication.url);
  assert.equal(bridge.pages.get(pageId)!.page.status, "unpublished");
  const back = await request("POST", "/publish", { page: "Sign up" });
  assert.equal(back.body!.publication.url, first.body!.publication.url);
  assert.equal(back.body!.publication.status, "online");
  const unpublishReceipt = (await journal()).find((entry) => entry.command === "pages.unpublish" && entry.outcome === "ok");
  assert.equal(unpublishReceipt?.detail, `page.unpublish; page Sign up; id ${pageIdPrefix(pageId)}; unpublished`);

  const listed = await request("GET", "/api/pages/published");
  assert.equal(listed.status, 200);
  assert.equal(listed.body!.publications.length, 1);
  const item = listed.body!.publications[0];
  assert.equal(item.workFolderName, "Events");
  assert.equal(item.path, "Sign up");
  assert.equal(item.title, "Volunteer Sign-up");
  assert.equal(item.url, first.body!.publication.url);
  assert.equal(item.status, "online");
  assert.equal(item.changesAvailable, false);
});

test("checking in writes data.sqlite as one finished file, and only when the data moved", async (t) => {
  const { request, bridge, pageFolder, api, stateBase } = await setup(t);
  await request("POST", "/publish", { page: "Sign up" });
  const pageId = onlyPageId(bridge);
  const target = join(pageFolder, "data.sqlite");
  await assert.rejects(stat(target), "no data yet, nothing written");

  bridge.visitorAdds(pageId, { name: "Ada", email: "ada@example.com", shift: "Morning" });
  bridge.calls.length = 0;
  const summary = await api.pages.checkIn();
  assert.deepEqual(summary, { checkedIn: true, written: 1, deferred: 0 });
  assert.deepEqual(bridge.calls, ["list", `download ${pageId}`]);
  const first = await stat(target);
  const sideFiles = (await readdir(pageFolder)).filter((name) => name.startsWith("data.sqlite") || name.startsWith(".data.sqlite"));
  assert.deepEqual(sideFiles, ["data.sqlite"], "no -journal, -wal, -shm, or temporary file");
  const db = openPageSqliteReadOnly(target);
  try {
    assert.equal(Number(db.get(`SELECT COUNT(*) AS "count" FROM "signups"`)?.count), 1);
  } finally {
    db.close();
  }

  bridge.calls.length = 0;
  assert.deepEqual(await api.pages.checkIn(), { checkedIn: true, written: 0, deferred: 0 });
  assert.deepEqual(bridge.calls, ["list"], "nothing moved, nothing downloaded");
  const unchanged = await stat(target);
  assert.equal(unchanged.ino, first.ino);
  assert.equal(unchanged.mtimeMs, first.mtimeMs);

  bridge.visitorAdds(pageId, { name: "Grace", email: "grace@example.com" }, `v_${"b".repeat(32)}`);
  await api.pages.checkIn();
  const replaced = await stat(target);
  assert.notEqual(replaced.ino, first.ino, "a new file is renamed into place");
  const record = JSON.parse(await readFile(join(stateBase, "pages", "publications.json"), "utf8")) as { records: Array<{ dataRevision: number; folderDataRevision: number; entries: number }> };
  assert.equal(record.records[0]!.folderDataRevision, record.records[0]!.dataRevision);
  assert.equal(record.records[0]!.entries, 2);

  // A deleted folder copy comes back at the next check-in.
  await rm(target);
  await api.pages.checkIn();
  assert.ok((await stat(target)).isFile());

  // Gone folders are skipped, and a failing bridge doesn't throw.
  await rm(pageFolder, { recursive: true, force: true });
  bridge.visitorAdds(pageId, { name: "Linus", email: "linus@example.com" }, `v_${"c".repeat(32)}`);
  assert.deepEqual(await api.pages.checkIn(), { checkedIn: true, written: 0, deferred: 0 });
  bridge.failList = true;
  const failed = await api.pages.checkIn();
  assert.equal(failed.checkedIn, false);
  assert.match(String(failed.error), /reach work-fold\.com/);
});

test("Online entries read the folder's data.sqlite read-only; changes go online and check in; Preview never reads it", async (t) => {
  const { request, bridge, pageFolder, api, journal } = await setup(t);
  assert.equal((await request("GET", "/online/data", undefined, { page: "Sign up" })).status, 404, "an unpublished page has no online entries");
  await request("POST", "/publish", { page: "Sign up" });
  const pageId = onlyPageId(bridge);

  // Before the first check-in brings data down, the declared tables show empty.
  const empty = await request("GET", "/online/data", undefined, { page: "Sign up" });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body!.tables.map((table: { name: string; live: number }) => [table.name, table.live]), [["signups", 0]]);

  const ada = bridge.visitorAdds(pageId, { name: "Ada", email: "ada@example.com", shift: "Morning" }) as { id: string };
  bridge.visitorAdds(pageId, { name: "Grace", email: "grace@example.com" }, `v_${"b".repeat(32)}`);
  await api.pages.checkIn();
  const before = (await readdir(pageFolder)).sort();

  const tables = await request("GET", "/online/data", undefined, { page: "Sign up" });
  assert.deepEqual(tables.body!.tables, [{ name: "signups", retired: false, limit: 3, live: 2, deleted: 0, newCount: 2, lastSeen: null }]);
  const rows = await request("GET", "/online/data", undefined, { page: "Sign up", table: "signups" });
  assert.equal(rows.body!.total, 2);
  assert.deepEqual(rows.body!.rows.map((row: { name: string }) => row.name).sort(), ["Ada", "Grace"]);
  assert.equal(rows.body!.lastSeen, null);
  const csv = await request("GET", "/online/data/export", undefined, { page: "Sign up", table: "signups" });
  assert.equal(csv.status, 200);
  // (fetch's text() drops the byte-order mark the export starts with.)
  assert.match(csv.text, /^\uFEFF?name,email,shift,notes,createdAt,updatedAt,visitor,id\r\n/u);
  assert.match(csv.text, /ada@example\.com/);
  assert.deepEqual((await readdir(pageFolder)).sort(), before, "reading creates no side files");

  // "What's new" markers are this computer's, kept in the record.
  const seen = await request("POST", "/online/data/seen", { page: "Sign up", table: "signups" });
  assert.equal(seen.status, 200);
  const afterSeen = await request("GET", "/online/data", undefined, { page: "Sign up" });
  assert.equal(afterSeen.body!.tables[0].newCount, 0);
  assert.equal(afterSeen.body!.tables[0].lastSeen, seen.body!.lastSeen);

  // Changes go to the page service, then check in.
  const updated = await request("POST", "/online/data/update", { page: "Sign up", table: "signups", id: ada.id, values: { shift: "Afternoon" } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.body!.row.shift, "Afternoon");
  const deleted = await request("POST", "/online/data/delete", { page: "Sign up", table: "signups", ids: [ada.id] });
  assert.deepEqual(deleted.body, { deleted: 1 });
  const afterDelete = await request("GET", "/online/data", undefined, { page: "Sign up" });
  assert.equal(afterDelete.body!.tables[0].live, 1, "the folder copy was refreshed");
  assert.deepEqual((await request("POST", "/online/data/restore", { page: "Sign up", table: "signups", ids: [ada.id] })).body, { restored: 1 });
  const refused = await request("POST", "/online/data/update", { page: "Sign up", table: "signups", id: ada.id, values: { email: "grace@example.com" } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body!.code, "DUPLICATE");
  const changeReceipts = (await journal()).filter((entry) => String(entry.command).startsWith("pages.data.") && entry.outcome === "ok");
  assert.deepEqual(changeReceipts.map((entry) => entry.command), ["pages.data.update", "pages.data.delete", "pages.data.restore"]);
  assert.ok(changeReceipts.every((entry) => !String(entry.detail).includes(pageId)));

  // Test entries are separate: Preview has none of the online rows.
  const preview = await request("GET", "/preview/data", undefined, { page: "Sign up" });
  assert.deepEqual(preview.body!.tables.map((table: { live: number }) => table.live), [0]);
  const previewCall = await request("POST", "/preview/call", { page: "Sign up", viewer: { role: "owner" }, call: { op: "count", table: "signups" } });
  assert.equal(previewCall.body!.result, 0);
});

test("the act lane publishes, lists, and unpublishes; receipts name the page by path and id prefix", async (t) => {
  const { run, records, workFolder, bridge, api } = await setup(t);
  const published = await run(["pages", "publish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  assert.equal(published.exitCode, 0, published.stderr);
  const pageId = onlyPageId(bridge);
  const json = JSON.parse(published.stdout) as { ok: true; command: string; data: { workFolder: { id: string }; publication: Record<string, unknown>; uploaded: { files: unknown[]; bytes: number } } };
  assert.equal(json.command, "pages.publish");
  assert.equal(json.data.workFolder.id, workFolder.id);
  assert.equal(json.data.publication.url, `${pagesOrigin}/p/${pageId}`, "--json returns the link to the caller");
  assert.equal(json.data.publication.idPrefix, pageIdPrefix(pageId));
  assert.equal(json.data.publication.path, "Sign up");
  assert.ok(json.data.uploaded.files.length > 0);
  const ok = records.find((record) => record.command === "pages.publish" && record.outcome === "ok")!;
  assert.equal(ok.workFolderId, workFolder.id);
  assert.match(String(ok.detail), new RegExp(`^page\\.publish; page Sign up; id ${pageIdPrefix(pageId)}; revision 1; \\d+ files, \\d+ bytes$`));

  const human = await run(["pages", "publish", "--work-folder", workFolder.id, "--page", "Sign up"]);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.match(human.stdout, /Published Volunteer Sign-up \[Sign up\]/);
  assert.match(human.stdout, new RegExp(`Link: ${pagesOrigin}/p/${pageId}`));
  assert.match(human.stdout, /- index\.html \(\d+ bytes\)/);

  const listed = await run(["pages", "list", "--json"]);
  assert.equal(listed.exitCode, 0, listed.stderr);
  const list = JSON.parse(listed.stdout) as { data: { publications: Array<Record<string, unknown>> } };
  assert.equal(list.data.publications.length, 1);
  assert.equal(list.data.publications[0]!.workFolderName, "Events");
  assert.equal(list.data.publications[0]!.url, `${pagesOrigin}/p/${pageId}`);
  assert.equal((await run(["pages", "list", "--work-folder", workFolder.id, "--json"])).exitCode, 0);

  const off = await run(["pages", "unpublish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  assert.equal(off.exitCode, 0, off.stderr);
  assert.equal((JSON.parse(off.stdout) as { data: { publication: { status: string } } }).data.publication.status, "unpublished");
  const again = await run(["pages", "unpublish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  assert.equal(again.exitCode, 0, "unpublishing an offline page is still fine");

  for (const record of records) {
    const text = JSON.stringify(record);
    assert.ok(!text.includes(pageId), `receipt ${String(record.command)} carries no whole page id`);
    assert.ok(!text.includes(pagesOrigin), `receipt ${String(record.command)} carries no link`);
  }
  assert.deepEqual(
    records.filter((record) => record.outcome === "ok").map((record) => [record.command, record.detail]),
    [
      ["pages.publish", records.find((record) => record.command === "pages.publish" && record.outcome === "ok")!.detail],
      ["pages.publish", records.filter((record) => record.command === "pages.publish" && record.outcome === "ok")[1]!.detail],
      ["pages.list", "pages 1"],
      ["pages.list", "pages 1"],
      ["pages.unpublish", `page Sign up; id ${pageIdPrefix(pageId)}; unpublished`],
      ["pages.unpublish", `page Sign up; id ${pageIdPrefix(pageId)}; unpublished`],
    ],
  );
  void api;
});

test("the act lane refuses publishing without Web Access, with problems, and while an Automation's work runs", async (t) => {
  const { run, workFolder, bridge, pageFolder, api } = await setup(t);
  bridge.state = "not-set-up";
  const noAccess = await run(["pages", "publish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  assert.notEqual(noAccess.exitCode, 0);
  const noAccessError = (JSON.parse(noAccess.stderr) as { error: { code: string; message: string } }).error;
  assert.equal(noAccessError.code, "unavailable");
  assert.match(noAccessError.message, /Settings → Web Access/);

  bridge.state = "ready";
  const original = await readFile(join(pageFolder, "index.html"), "utf8");
  await writeFile(join(pageFolder, "index.html"), `<script src="https://cdn.example.com/x.js"></script>`);
  const problems = await run(["pages", "publish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  const problemsError = (JSON.parse(problems.stderr) as { error: { code: string; message: string } }).error;
  assert.equal(problemsError.code, "conflict");
  assert.match(problemsError.message, /problem.* to fix before it can be published.*index\.html: .*Run pages validate/s);
  await writeFile(join(pageFolder, "index.html"), original);

  const notPublished = await run(["pages", "unpublish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  assert.equal((JSON.parse(notPublished.stderr) as { error: { code: string } }).error.code, "notFound");

  // An Automation's turn is running: the act lane won't publish.
  await api.requests.beginRoot({
    kind: "automation",
    owner: { workFolderId: workFolder.id, workFolderName: workFolder.name, conversationId: "automation-chat" },
    surface: "system",
    taskId: "task-automation-running",
    content: "Publish the page.",
  });
  const automation = await run(["pages", "publish", "--work-folder", workFolder.id, "--page", "Sign up", "--json"]);
  const automationError = (JSON.parse(automation.stderr) as { error: { code: string; message: string } }).error;
  assert.equal(automationError.code, "conflict");
  assert.match(automationError.message, /Automations can't publish pages/);
  assert.equal(bridge.pages.size, 0, "nothing was uploaded");
});

test("pages publish, unpublish, and list parse; help names them", () => {
  const usage = (argv: string[]): string => {
    try {
      parseWorkFoldCliActArgv(argv);
    } catch (error) {
      assert.ok(error instanceof WorkFoldCliError);
      assert.equal(error.code, "usage");
      return error.message;
    }
    assert.fail(`expected a usage error for ${argv.join(" ")}`);
  };
  assert.deepEqual(parseWorkFoldCliActArgv(["pages", "publish", "--work-folder", "Events", "--page", "Sign up", "--json"]), {
    name: "pages.publish", output: "json", workFolder: "Events", page: "Sign up",
  });
  assert.deepEqual(parseWorkFoldCliActArgv(["pages", "unpublish", "--work-folder", "Events", "--page", "Sign up/", "--parent-task", "task-1"]), {
    name: "pages.unpublish", output: "human", workFolder: "Events", page: "Sign up/", parentTaskId: "task-1",
  });
  assert.deepEqual(parseWorkFoldCliActArgv(["pages", "list", "--json"]), { name: "pages.list", output: "json" });
  assert.deepEqual(parseWorkFoldCliActArgv(["pages", "list", "--work-folder", "Events"]), { name: "pages.list", output: "human", workFolder: "Events" });
  assert.match(usage(["pages", "publish", "--page", "Sign up"]), /--work-folder/);
  assert.match(usage(["pages", "publish", "--work-folder", "Events"]), /Provide --page <page-folder-path>/);
  assert.match(usage(["pages", "publish", "--work-folder", "Events", "--page", "Sign up", "--title", "x"]), /--title cannot be used/);
  assert.match(usage(["pages", "list", "--parent-task", "t"]), /--parent-task cannot be used/);
  const help = workFoldCliHelp("work-fold", "pages");
  assert.match(help, /pages publish --work-folder <id-or-name> --page <page-folder-path>/);
  assert.match(help, /pages unpublish --work-folder <id-or-name> --page <page-folder-path>/);
  assert.match(help, /pages list \[--work-folder <id-or-name>\]/);
  assert.match(help, /Automations\s+can't publish/);
  assert.match(workFoldCliHelp("work-fold"), /pages validate\|publish\|unpublish\|list/);
});

test("the bridge client sends the device token, bounds the body, reads the snapshot revision, and never leaks an id", async () => {
  const pageId = createPageId();
  const seen: Array<{ url: string; method: string; authorization: string | null; body: string | null }> = [];
  let answer: (url: URL, init: RequestInit) => Response = () => new Response("{}", { status: 500 });
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    return answer(url, init ?? {});
  }) as typeof fetch;
  let connection: { bridgeUrl: string; deviceToken: string } | { unavailable: "not-set-up" | "turned-off" } = { bridgeUrl: "https://bridge.example.test/base/", deviceToken: "secret-device-token" };
  const client = createPagesBridgeClient({ getConnection: async () => connection, fetchFn });

  const page = { pageId, title: "T", status: "online", revision: 1, publishedAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z", dataRevision: 3, entries: 2 };
  answer = () => Response.json({ pages: [page, { pageId: "not-a-page" }], pagesOrigin: "https://pages.example.test/" });
  const list = await client.list();
  assert.equal(list.pagesOrigin, "https://pages.example.test");
  assert.equal(list.pages.length, 1);
  assert.equal(seen.at(-1)!.url, "https://bridge.example.test/api/device/pages");
  assert.equal(seen.at(-1)!.authorization, "Bearer secret-device-token");

  answer = () => Response.json({ page });
  const body = { title: "T", html: "<p>x</p>", declaration: { format: "work-fold.page/1", title: "T" }, files: [{ path: "index.html", bytes: 8 }], contentDigest: "0".repeat(64) };
  await client.publish(pageId, body);
  assert.equal(seen.at(-1)!.method, "PUT");
  assert.equal(seen.at(-1)!.url, `https://bridge.example.test/api/device/pages/${pageId}`);
  assert.deepEqual(JSON.parse(seen.at(-1)!.body!), body);
  const calls = seen.length;
  await assert.rejects(client.publish(pageId, { ...body, html: "x".repeat(26 * 1024 * 1024) }), (error: unknown) => error instanceof PagesBridgeError && error.status === 413);
  assert.equal(seen.length, calls, "an oversized body is never sent");

  answer = () => new Response(new Uint8Array([1, 2, 3]), { headers: { "x-work-fold-data-revision": "7" } });
  const snapshot = await client.downloadData(pageId);
  assert.deepEqual([...snapshot.bytes], [1, 2, 3]);
  assert.equal(snapshot.dataRevision, 7);
  assert.equal(seen.at(-1)!.url, `https://bridge.example.test/api/device/pages/${pageId}/data.sqlite`);

  answer = () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  assert.equal(await client.unpublish(pageId), null, "a page the service doesn't know is already offline");
  answer = () => Response.json({ error: "Nope", code: "DUPLICATE", message: "An entry with this email already exists.", field: "email" }, { status: 409 });
  await assert.rejects(client.changeData(pageId, "update", { table: "signups" }), (error: unknown) => error instanceof Error && (error as { code?: string }).code === "DUPLICATE" && (error as { field?: string }).field === "email");
  assert.equal(seen.at(-1)!.url, `https://bridge.example.test/api/device/pages/${pageId}/data/update`);
  answer = () => Response.json({ error: "Online pages aren't available yet." }, { status: 503 });
  await assert.rejects(client.list(), (error: unknown) => error instanceof PagesBridgeError && error.statusCode === 503 && /aren't available yet/.test(error.message));
  answer = () => { throw new TypeError("fetch failed"); };
  await assert.rejects(client.list(), (error: unknown) => error instanceof PagesBridgeError && /couldn't reach/.test(error.message) && !error.message.includes("secret-device-token"));

  connection = { unavailable: "turned-off" };
  await assert.rejects(client.list(), (error: unknown) => error instanceof PagesBridgeUnavailableError && error.code === "WEB_ACCESS_REQUIRED");
});

test("the desktop client reads Web Access settings at call time", async () => {
  let settings: { enabled: boolean; bridgeUrl: string; deviceToken: string } | null = null;
  const authorizations: Array<string | null> = [];
  const client = createDesktopPagesBridge(
    { getRemoteAccess: async () => settings as never },
    (async (_input: URL | RequestInfo, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ pages: [], pagesOrigin: null });
    }) as typeof fetch,
  );
  assert.deepEqual(await client.connection(), { unavailable: "not-set-up" });
  settings = { enabled: false, bridgeUrl: "https://bridge.example.test", deviceToken: "device" };
  assert.deepEqual(await client.connection(), { unavailable: "turned-off" });
  await assert.rejects(client.list(), PagesBridgeUnavailableError);
  settings = { ...settings, enabled: true };
  await client.list();
  assert.deepEqual(authorizations, ["Bearer device"]);
});

test("the development hook builds the same client from two variables", async () => {
  assert.equal(createDevelopmentPagesBridge({}), null);
  assert.equal(createDevelopmentPagesBridge({ WORKFOLD_DEV_BRIDGE_URL: "http://127.0.0.1:8787" }), null);
  const urls: string[] = [];
  const headers: Array<string | null> = [];
  const client = createDevelopmentPagesBridge(
    { WORKFOLD_DEV_BRIDGE_URL: "http://127.0.0.1:8787", WORKFOLD_DEV_DEVICE_TOKEN: "dev-token" },
    (async (input: URL | RequestInfo, init?: RequestInit) => {
      urls.push(String(input));
      headers.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ pages: [], pagesOrigin: "http://127.0.0.1:8790" });
    }) as typeof fetch,
  );
  assert.ok(client);
  assert.deepEqual(await client.list(), { pages: [], pagesOrigin: "http://127.0.0.1:8790" });
  assert.deepEqual(urls, ["http://127.0.0.1:8787/api/device/pages"]);
  assert.deepEqual(headers, ["Bearer dev-token"]);
  const devEntry = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "local", "server-dev.ts"), "utf8");
  assert.match(devEntry, /createDevelopmentPagesBridge\(\)/);
  assert.match(devEntry, /pagesBridge/);
});

test("a page that refers to data.sqlite can't reach it", async (t) => {
  const { request, pageFolder } = await setup(t);
  const db = openPageSqliteDatabase(join(pageFolder, "data.sqlite"));
  ensurePageMetaTable(db);
  db.close();
  const original = await readFile(join(pageFolder, "index.html"), "utf8");
  await writeFile(join(pageFolder, "index.html"), original.replace("</body>", `<a download href="data.sqlite">x</a><img src="data.sqlite"></body>`));
  const inspected = await request("GET", "/inspect", undefined, { page: "Sign up" });
  assert.ok((inspected.body!.problems as Array<{ file: string; message: string; severity: string }>).some((problem) => problem.severity === "error" && /data\.sqlite/.test(problem.message)));
});
