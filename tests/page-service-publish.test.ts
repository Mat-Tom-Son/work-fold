import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { openPageSqliteDatabase } from "../src/local/pages/page-sqlite.js";
import { readPageMeta } from "../src/shared/pages/index.js";
import { startPageService } from "../services/pages/src/service.js";
import { internalSecret, newPageId, otherAccount, ownerAccount, publishBody, rsvpDeclaration, startTestPageService } from "./support/page-service.js";

/**
 * The page service's publisher and owner API (docs/pages.md, "Page service",
 * internal routes): the secret, publishing and publishing changes, account
 * isolation, unpublishing, data revisions, the data snapshot, and the
 * owner's Data view.
 */

test("internal routes need the secret, and don't start without one", async (t) => {
  const pages = await startTestPageService(t);
  const list = `/internal/accounts/${ownerAccount}/pages`;
  for (const headers of [{ "x-work-fold-pages-secret": "" }, { "x-work-fold-pages-secret": "wrong" }, { "x-work-fold-pages-secret": `${internalSecret}x` }]) {
    const refused = await pages.internal("GET", list, undefined, headers);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "NOT_ALLOWED");
  }
  const missing = await fetch(`${pages.service.internalUrl}${list}`);
  assert.equal(missing.status, 401);
  const unknownPath = await fetch(`${pages.service.internalUrl}/anything`);
  assert.equal(unknownPath.status, 401, "the secret is checked before anything else");
  assert.deepEqual((await pages.internal("GET", list)).body, { pages: [] });
  assert.equal((await pages.get(list)).status, 404, "the public port has no internal routes");
  assert.equal(pages.service.health().internal, "on");

  for (const secret of [null, "", "too-short"]) {
    const service = await startPageService({ dataDir: pages.dataDir, port: 0, host: "127.0.0.1", internalPort: 0, internalSecret: secret, log: () => undefined });
    try {
      assert.equal(service.internalUrl, null);
      assert.equal(service.health().internal, "off");
      const health = await fetch(`${service.publicUrl}/health`);
      assert.equal((await health.json() as { internal: string }).internal, "off");
    } finally {
      await service.close();
    }
  }
});

test("publishing stores the page; the same digest makes no new revision", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  const first = await pages.publish(pageId);
  assert.equal(first.status, 200);
  const page = first.body.page;
  assert.deepEqual(Object.keys(page).sort(), ["dataRevision", "entries", "pageId", "publishedAt", "revision", "status", "title", "updatedAt"]);
  assert.equal(page.pageId, pageId);
  assert.equal(page.status, "online");
  assert.equal(page.revision, 1);
  assert.equal(page.title, "Garden Party RSVP");
  assert.equal(page.entries, 0);
  assert.equal(page.dataRevision, 1, "creating the page's tables is its first data change");
  assert.ok(existsSync(join(pages.dataDir, "registry.sqlite")));
  assert.equal(await readFile(join(pages.dataDir, "pages", pageId, "rev-1.html"), "utf8"), publishBody().html);
  assert.ok(existsSync(join(pages.dataDir, "pages", pageId, "data.sqlite")));

  const again = await pages.publish(pageId, publishBody({ html: "<p>ignored</p>" }));
  assert.deepEqual(again.body.page, page, "the same content digest changes nothing");
  assert.equal(await readFile(join(pages.dataDir, "pages", pageId, "rev-1.html"), "utf8"), publishBody().html);

  const second = await pages.publish(pageId, publishBody({ html: "<p>two</p>", contentDigest: "sha256:0000000000000002", title: "  Garden Party  " }));
  assert.equal(second.body.page.revision, 2);
  assert.equal(second.body.page.title, "Garden Party");
  assert.equal(second.body.page.dataRevision, 1, "an unchanged declaration is no data change");
  const third = await pages.publish(pageId, publishBody({ html: "<p>three</p>", contentDigest: "sha256:0000000000000003" }));
  assert.equal(third.body.page.revision, 3);
  const files = (await readdir(join(pages.dataDir, "pages", pageId))).filter((name) => name.endsWith(".html")).sort();
  assert.deepEqual(files, ["rev-2.html", "rev-3.html"], "the active document and the one before it are kept");
  assert.deepEqual((await pages.internal("GET", pages.pagePath(pageId))).body, { page: third.body.page });
  assert.deepEqual((await pages.internal("GET", `/internal/accounts/${ownerAccount}/pages`)).body, { pages: [third.body.page] });
  assert.deepEqual(await readdir(join(pages.dataDir, "tmp")), [], "no temporary files are left behind");

  await pages.restart();
  assert.deepEqual((await pages.internal("GET", pages.pagePath(pageId))).body, { page: third.body.page }, "the page survives a restart");
  assert.equal((await pages.get(`/p/${pageId}`)).status, 200);
});

test("publish changes applies page.json additively and keeps the data", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const added = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ADA@example.com " } });
  assert.equal(added.status, 200);

  const changed = rsvpDeclaration({
    tables: {
      rsvps: {
        columns: { name: { type: "text", required: true }, guests: { type: "number", min: 0, max: 10 } },
        visitors: ["add", "see-own"],
        limit: 50,
      },
      notes: { columns: { text: { type: "long-text" } }, visitors: ["add"] },
    },
  });
  const update = await pages.publish(pageId, publishBody({ declaration: changed, contentDigest: "sha256:0000000000000002" }));
  assert.equal(update.status, 200);
  assert.equal(update.body.page.revision, 2);
  assert.equal(update.body.page.entries, 1);
  assert.equal(update.body.page.dataRevision, 3, "adding a column and a table is a data change");

  const view = await pages.internal("GET", `${pages.pagePath(pageId)}/data?table=rsvps`);
  assert.deepEqual(view.body.columns.map((column: { name: string; retired: boolean }) => [column.name, column.retired]), [["name", false], ["guests", false], ["email", true], ["note", true]]);
  assert.equal(view.body.rows[0].email, "ada@example.com", "a column that's no longer collected keeps its data");
  const tables = await pages.internal("GET", `${pages.pagePath(pageId)}/data`);
  assert.deepEqual(tables.body.tables.map((table: { name: string }) => table.name), ["rsvps", "notes"]);

  assert.equal((await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", guests: "2" } }, { cookie: added.cookie })).body.result.guests, 2);
  const refused = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Cy", email: "cy@example.com" } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "INVALID");
  assert.equal(refused.body.field, "email");

  const limitOnly = rsvpDeclaration({ tables: { ...(changed.tables as object), rsvps: { ...((changed.tables as Record<string, Record<string, unknown>>).rsvps), limit: 40 } } });
  const before = (await pages.internal("GET", pages.pagePath(pageId))).body.page.dataRevision;
  const third = await pages.publish(pageId, publishBody({ declaration: limitOnly, contentDigest: "sha256:0000000000000003" }));
  assert.equal(third.body.page.dataRevision, before, "a declaration change that adds nothing isn't a data change");
});

test("a page belongs to one account forever", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  const published = await pages.publish(pageId);
  const unknown = await pages.internal("GET", pages.pagePath(newPageId(), otherAccount));
  assert.equal(unknown.status, 404);

  const takeover = await pages.publish(pageId, publishBody({ title: "Mine now", contentDigest: "sha256:00000000000000ff" }), otherAccount);
  assert.equal(takeover.status, 404);
  assert.deepEqual(takeover.body, unknown.body, "another account's page looks like no page at all");
  for (const [method, suffix] of [["GET", ""], ["DELETE", ""], ["GET", "/data"], ["GET", "/data.sqlite"], ["GET", "/data/export?table=rsvps"]] as const) {
    const refused = await pages.internal(method, `${pages.pagePath(pageId, otherAccount)}${suffix}`);
    assert.equal(refused.status, 404, `${method} ${suffix}`);
    assert.deepEqual(refused.body, unknown.body);
  }
  const change = await pages.internal("POST", `${pages.pagePath(pageId, otherAccount)}/data/delete`, { table: "rsvps", ids: ["x"] });
  assert.equal(change.status, 404);
  assert.deepEqual((await pages.internal("GET", `/internal/accounts/${otherAccount}/pages`)).body, { pages: [] });
  assert.deepEqual((await pages.internal("GET", pages.pagePath(pageId))).body, { page: published.body.page }, "the owner's page is untouched");
  assert.equal((await pages.get(`/p/${pageId}`)).status, 200);

  assert.equal((await pages.internal("GET", "/internal/accounts/not-an-account/pages")).status, 400);
  assert.equal((await pages.internal("GET", `/internal/accounts/${otherAccount.toUpperCase()}/pages`)).status, 400);
  for (const badId of ["pg_short", `pg_${"A".repeat(26)}`, `pg_${"1".repeat(26)}`, `xx_${"a".repeat(26)}`, "..", "%2e%2e"]) {
    assert.equal((await pages.publish(badId)).status, 404, badId);
  }
});

test("unpublishing answers like an unknown id; publishing again brings back the same link", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const added = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  const unpublished = await pages.internal("DELETE", pages.pagePath(pageId));
  assert.equal(unpublished.status, 200);
  assert.equal(unpublished.body.page.status, "unpublished");
  assert.equal(unpublished.body.page.entries, 1, "unpublishing keeps the entries");
  assert.equal((await pages.internal("DELETE", pages.pagePath(pageId))).body.page.status, "unpublished", "unpublishing twice is fine");

  const gone = await pages.get(`/p/${pageId}`);
  const never = await pages.get(`/p/${newPageId()}`);
  const malformed = await pages.get("/p/not-a-page");
  assert.equal(gone.status, 404);
  for (const other of [never, malformed]) {
    assert.equal(other.status, 404);
    assert.equal(other.text, gone.text);
    for (const header of ["content-type", "content-security-policy", "content-length", "cache-control"]) assert.equal(other.headers.get(header), gone.headers.get(header), header);
  }
  assert.match(gone.text, /Nothing is published here\./);
  assert.equal(gone.headers.get("set-cookie"), null);

  const goneDocument = await pages.get(`/p/${pageId}/document`);
  assert.equal(goneDocument.status, 404);
  assert.deepEqual(goneDocument.body, (await pages.get(`/p/${newPageId()}/document`)).body);
  const goneCall = await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: added.cookie });
  assert.equal(goneCall.status, 404);
  assert.deepEqual(goneCall.body, (await pages.call(newPageId(), { op: "mine", table: "rsvps" })).body);
  assert.equal(goneCall.setCookie, null);

  const data = await pages.internal("GET", `${pages.pagePath(pageId)}/data?table=rsvps`);
  assert.equal(data.body.rows.length, 1, "the owner still sees the entries");

  const back = await pages.publish(pageId);
  assert.equal(back.body.page.status, "online");
  assert.equal(back.body.page.revision, 1, "the same content comes back as the same revision");
  assert.ok(back.body.page.publishedAt >= unpublished.body.page.publishedAt);
  assert.equal((await pages.get(`/p/${pageId}`)).status, 200);
  const mine = await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: added.cookie });
  assert.deepEqual(mine.body.result.map((row: { name: string }) => row.name), ["Ada"], "the visitor's entry is still theirs");
});

test("the data revision moves with every data change, and only then", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const revision = async () => (await pages.internal("GET", pages.pagePath(pageId))).body.page.dataRevision as number;
  assert.equal(await revision(), 1);

  const visitor = await pages.call(pageId, { op: "count", table: "rsvps" });
  await pages.call(pageId, { op: "mine", table: "rsvps" }, { cookie: visitor.cookie });
  assert.equal(await revision(), 1, "reads change nothing");
  const added = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" }, requestId: "req-1" }, { cookie: visitor.cookie });
  assert.equal(await revision(), 2);
  const retried = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" }, requestId: "req-1" }, { cookie: visitor.cookie });
  assert.equal(retried.body.result.id, added.body.result.id);
  assert.equal(await revision(), 2, "a retried add returns the row it made without changing anything");
  const refused = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", email: "ada@example.com" } });
  assert.equal(refused.body.code, "DUPLICATE");
  assert.equal(await revision(), 2, "a refused call changes nothing");
  await pages.call(pageId, { op: "update", table: "rsvps", id: added.body.result.id, values: { note: "Bringing cake" } }, { cookie: visitor.cookie });
  assert.equal(await revision(), 3);

  const id = added.body.result.id as string;
  const path = pages.pagePath(pageId);
  assert.equal((await pages.internal("POST", `${path}/data/update`, { table: "rsvps", id, values: { name: "Ada L." } })).body.row.name, "Ada L.");
  assert.equal(await revision(), 4);
  assert.deepEqual((await pages.internal("POST", `${path}/data/delete`, { table: "rsvps", ids: [id] })).body, { deleted: 1 });
  assert.equal(await revision(), 5);
  assert.deepEqual((await pages.internal("POST", `${path}/data/delete`, { table: "rsvps", ids: [id, "missing"] })).body, { deleted: 0 });
  assert.equal(await revision(), 5, "deleting nothing changes nothing");
  assert.deepEqual((await pages.internal("POST", `${path}/data/restore`, { table: "rsvps", ids: [id] })).body, { restored: 1 });
  assert.equal(await revision(), 6);
  await pages.publish(pageId);
  assert.equal(await revision(), 6, "publishing the same content changes nothing");
  assert.equal((await pages.internal("GET", path)).body.page.entries, 1);
});

test("the data snapshot is a consistent SQLite file that carries its data revision", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const visitor = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", email: "bo@example.com" } }, { cookie: visitor.cookie });

  const response = await fetch(`${pages.service.internalUrl}${pages.pagePath(pageId)}/data.sqlite`, { headers: { "x-work-fold-pages-secret": internalSecret } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/vnd.sqlite3");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-work-fold-data-revision"), "3");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 16).toString("latin1"), "SQLite format 3\0");
  assert.equal(Number(response.headers.get("content-length")), bytes.length);

  const copy = join(pages.dataDir, "..", `${pageId}-copy.sqlite`);
  await writeFile(copy, bytes);
  t.after(() => rm(copy, { force: true }));
  const db = openPageSqliteDatabase(copy);
  try {
    assert.deepEqual(db.all(`SELECT "name", "email", "_visitor" AS "visitor" FROM "rsvps" ORDER BY "_created"`).map((row) => [row.name, row.email, row.visitor]), [
      ["Ada", "ada@example.com", visitor.cookie!.slice(4)],
      ["Bo", "bo@example.com", visitor.cookie!.slice(4)],
    ]);
    assert.equal(readPageMeta(db, "dataRevision"), "3", "the file says which revision it is");
    assert.equal(db.get("PRAGMA journal_mode")?.journal_mode, "delete", "one finished file, no write-ahead log");
  } finally {
    db.close();
  }
  assert.deepEqual(await readdir(join(pages.dataDir, "tmp")), [], "the snapshot's temporary file is removed");
});

test("the owner's Data view routes answer like the preview's", async (t) => {
  const pages = await startTestPageService(t);
  const pageId = newPageId();
  await pages.publish(pageId);
  const path = pages.pagePath(pageId);
  const ada = await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "=SUM(A1)", email: "ada@example.com" } });
  await pages.call(pageId, { op: "add", table: "rsvps", values: { name: "Bo", email: "bo@example.com" } });

  const summary = await pages.internal("GET", `${path}/data`);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.tables.map((table: Record<string, unknown>) => [table.name, table.live, table.deleted, table.limit, table.retired]), [["rsvps", 2, 0, 50, false]]);
  const view = await pages.internal("GET", `${path}/data?table=rsvps`);
  assert.equal(view.body.total, 2);
  assert.deepEqual(view.body.rows.map((row: { name: string }) => row.name), ["Bo", "=SUM(A1)"]);
  assert.ok(view.body.rows.every((row: { visitor: string }) => /^v_[0-9a-f]{32}$/u.test(row.visitor)), "the owner sees visitor ids");
  assert.notEqual(view.body.rows[0].visitor, view.body.rows[1].visitor, "two browsers are two visitors");

  const invalidEdit = await pages.internal("POST", `${path}/data/update`, { table: "rsvps", id: ada.body.result.id, values: { email: "not an email" } });
  assert.equal(invalidEdit.status, 400);
  assert.equal(invalidEdit.body.code, "INVALID");
  assert.equal(invalidEdit.body.field, "email");
  assert.equal((await pages.internal("GET", `${path}/data?table=nope`)).status, 404);
  assert.equal((await pages.internal("POST", `${path}/data/delete`, { table: "rsvps", ids: [ada.body.result.id] })).body.deleted, 1);
  const deleted = await pages.internal("GET", `${path}/data?table=rsvps&deleted=1`);
  assert.deepEqual(deleted.body.rows.map((row: { id: string }) => row.id), [ada.body.result.id]);
  assert.ok(deleted.body.rows[0].deletedAt);

  await pages.internal("POST", `${path}/data/restore`, { table: "rsvps", ids: [ada.body.result.id] });
  const response = await fetch(`${pages.service.internalUrl}${path}/data/export?table=rsvps`, { headers: { "x-work-fold-pages-secret": internalSecret } });
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), "attachment; filename=\"rsvps.csv\"");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a byte-order mark, so spreadsheets read UTF-8");
  const csv = bytes.subarray(3).toString("utf8");
  assert.ok(csv.startsWith("name,email,note,createdAt,updatedAt,visitor,id\r\n"), csv.slice(0, 60));
  assert.match(csv, /\r\n'=SUM\(A1\),ada@example\.com,/u, "formulas are never run");
});

test("publish bodies are checked", async (t) => {
  const pages = await startTestPageService(t, { limits: { maxPublishBytes: 64 * 1024 } });
  const pageId = newPageId();
  const broken = await pages.publish(pageId, publishBody({ declaration: { format: "work-fold.page/1", title: "x", surprise: true } }));
  assert.equal(broken.status, 400);
  assert.equal(broken.body.code, "INVALID");
  assert.deepEqual(broken.body.problems.map((problem: { path: string }) => problem.path), ["surprise"]);
  const fromText = await pages.publish(newPageId(), { ...publishBody(), declaration: JSON.stringify(rsvpDeclaration()) });
  assert.equal(fromText.status, 200, "page.json may also arrive as its text");
  for (const body of [{ ...publishBody(), html: "" }, { ...publishBody(), contentDigest: "short" }, { ...publishBody(), title: 7 }, { ...publishBody(), files: [{ bytes: 3 }] }, { ...publishBody(), files: "index.html" }]) {
    const refused = await pages.publish(pageId, body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const tooLarge = await pages.publish(pageId, publishBody({ html: "x".repeat(70 * 1024) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.code, "TOO_LARGE");
  const notJson = await pages.internal("PUT", pages.pagePath(pageId), "{}", { "content-type": "text/plain" });
  assert.equal(notJson.status, 415);
  assert.equal((await pages.internal("GET", pages.pagePath(pageId))).status, 404, "nothing was published");
});
