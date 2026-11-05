import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { PAGE_FRAME_CONTENT_SECURITY_POLICY, PAGE_FRAME_HTML, PAGE_FRAME_SCRIPT } from "../src/local/pages/frame/page-frame-assets.js";
import { pagePreviewKey } from "../src/local/pages/page-preview-store.js";
import { openPageSqliteDatabase } from "../src/local/pages/page-sqlite.js";
import { readPageMeta } from "../src/shared/pages/index.js";
import { startLocalApi } from "../src/local/server.js";

/**
 * The pages local API (docs/pages.md, "Local API") through startLocalApi:
 * listing and inspecting page folders, the assembled document, preview calls
 * with test entries kept under the state root, and the owner's Data view.
 */

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages", "sign-up-sheet");
const session = "pages-session";

async function setup(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-page-routes-"));
  const stateBase = join(sandbox, "state");
  const api = await startLocalApi({ port: 0, stateBase, workFolderBase: join(sandbox, "content"), loadEnv: false, sessionToken: session });
  t.after(async () => {
    await api.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  const { workFolder } = await api.actFacade.createWorkFolder({ name: "Events" });
  await cp(fixture, join(workFolder.workFolderRoot, "Sign up"), { recursive: true });
  const base = `/api/work-folders/${encodeURIComponent(workFolder.id)}/pages`;
  const get = async (path: string, query: Record<string, string> = {}) => {
    const url = new URL(`${base}${path}`, api.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { "x-work-fold-session": session } });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: response.headers.get("content-type")?.includes("json") ? JSON.parse(text) as Record<string, unknown> : null };
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(`${base}${path}`, api.origin), {
      method: "POST",
      headers: { "content-type": "application/json", "x-work-fold-session": session },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const call = (viewer: unknown, pageCall: unknown, page = "Sign up") => post("/preview/call", { page, viewer, call: pageCall });
  return { api, sandbox, stateBase, workFolder, get, post, call };
}

test("the sandbox intermediary is served without a session, with its own policy", async (t) => {
  const { api } = await setup(t);
  for (const [path, body, type] of [["/page-frame.html", PAGE_FRAME_HTML, "text/html"], ["/page-frame.js", PAGE_FRAME_SCRIPT, "text/javascript"]] as const) {
    const response = await fetch(new URL(path, api.origin));
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", new RegExp(type));
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (PAGE_FRAME_CONTENT_SECURITY_POLICY) assert.equal(response.headers.get("content-security-policy"), PAGE_FRAME_CONTENT_SECURITY_POLICY);
    assert.equal(await response.text(), body);
  }
  const pages = await fetch(new URL("/api/work-folders/anything/pages", api.origin));
  assert.equal(pages.status, 401, "page routes need the ordinary local session");
});

test("pages are listed, inspected, and assembled", async (t) => {
  const { get, workFolder } = await setup(t);
  await cp(fixture, join(workFolder.workFolderRoot, "Drafts", "Broken"), { recursive: true });
  await writeFile(join(workFolder.workFolderRoot, "Drafts", "Broken", "index.html"), `<script src="https://cdn.example.com/x.js"></script>`);

  const list = await get("");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, {
    pages: [
      { path: "Drafts/Broken", title: "Volunteer Sign-up", problemCount: 2, errorCount: 1 },
      { path: "Sign up", title: "Volunteer Sign-up", problemCount: 1, errorCount: 0 },
    ],
    truncated: false,
  });

  const inspect = await get("/inspect", { page: "Sign up" });
  assert.equal(inspect.status, 200);
  const page = inspect.body!.page as { path: string; title: string; entry: string; tables: Array<{ name: string }> };
  assert.equal(page.path, "Sign up");
  assert.equal(page.entry, "index.html");
  assert.deepEqual(page.tables.map((table) => table.name), ["signups"]);
  assert.deepEqual((inspect.body!.summary as { files: number }).files, 9);
  assert.equal((inspect.body!.problems as unknown[]).length, 1);

  const document = await get("/document", { page: "Sign up" });
  assert.equal(document.status, 200);
  assert.match(String(document.body!.html), /^<!doctype html>/u);
  assert.match(String(document.body!.html), /data:image\/svg\+xml;base64,/u);
  const broken = await get("/document", { page: "Drafts/Broken" });
  assert.equal(broken.body!.html, null);
  assert.match(JSON.stringify(broken.body!.problems), /from the internet/);

  assert.equal((await get("/inspect", { page: "../outside" })).status, 400);
  assert.equal((await get("/inspect", { page: "Nowhere" })).status, 404);
  assert.equal((await get("/inspect")).status, 400);
  assert.equal((await get("/unknown")).status, 404);
});

test("preview calls keep test entries under the state root and apply the declared rules", async (t) => {
  const { post, call, get, stateBase, workFolder } = await setup(t);
  const before = await readdir(join(workFolder.workFolderRoot, "Sign up"));

  const first = await post("/preview/visitor", { page: "Sign up" });
  assert.equal(first.status, 200);
  const visitor = String(first.body.visitor);
  assert.match(visitor, /^v_[0-9a-f]{32}$/u);
  assert.equal((await post("/preview/visitor", { page: "Sign up" })).body.visitor, visitor, "the current preview visitor is kept");
  const fresh = String((await post("/preview/visitor", { page: "Sign up", fresh: true })).body.visitor);
  assert.notEqual(fresh, visitor);
  assert.equal((await post("/preview/visitor", { page: "Sign up" })).body.visitor, fresh, "a fresh visitor becomes current");

  const added = await call({ role: "visitor", visitor }, { op: "add", table: "signups", values: { name: "Ada", email: "Ada@Example.com", shift: "Morning" }, requestId: "r-1" });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const row = added.body.result as Record<string, unknown>;
  assert.equal(row.email, "ada@example.com");
  assert.equal(row.visitor, undefined);
  const retry = await call({ role: "visitor", visitor }, { op: "add", table: "signups", values: { name: "Ada", email: "ada@example.com" }, requestId: "r-1" });
  assert.equal((retry.body.result as { id: string }).id, row.id);

  assert.deepEqual((await call({ role: "visitor", visitor: fresh }, { op: "mine", table: "signups" })).body, { result: [] });
  assert.equal(((await call({ role: "visitor", visitor }, { op: "mine", table: "signups" })).body.result as unknown[]).length, 1);
  assert.deepEqual((await call({ role: "visitor", visitor: fresh }, { op: "count", table: "signups" })).body, { result: 1 });
  assert.deepEqual((await call({ role: "owner" }, { op: "isOwner" })).body, { result: true });
  const ownerList = await call({ role: "owner" }, { op: "list", table: "signups" });
  assert.equal((ownerList.body.result as Array<{ visitor: string }>)[0]!.visitor, visitor);

  const notAllowed = await call({ role: "visitor", visitor }, { op: "list", table: "signups" });
  assert.equal(notAllowed.status, 403);
  assert.equal(notAllowed.body.code, "NOT_ALLOWED");
  assert.equal(notAllowed.body.error, notAllowed.body.message, "the ordinary error shape carries the page refusal");
  const duplicate = await call({ role: "visitor", visitor: fresh }, { op: "add", table: "signups", values: { name: "Not Ada", email: "ada@example.com" } });
  assert.deepEqual([duplicate.status, duplicate.body.code, duplicate.body.field], [409, "DUPLICATE", "email"]);
  const invalid = await call({ role: "visitor", visitor: fresh }, { op: "add", table: "signups", values: { name: "Bea", email: "bea@example.com", shift: "Night" } });
  assert.deepEqual([invalid.status, invalid.body.code, invalid.body.field], [400, "INVALID", "shift"]);
  assert.equal((await call({ role: "visitor", visitor: "nope" }, { op: "mine", table: "signups" })).body.code, "INVALID");
  await call({ role: "visitor", visitor: fresh }, { op: "add", table: "signups", values: { name: "Bea", email: "bea@example.com" } });
  await call({ role: "owner" }, { op: "add", table: "signups", values: { name: "Cy", email: "cy@example.com" } });
  const full = await call({ role: "visitor", visitor: fresh }, { op: "add", table: "signups", values: { name: "Dee", email: "dee@example.com" } });
  assert.deepEqual([full.status, full.body.code], [409, "LIMIT_REACHED"]);

  // Test entries live under the state root, keyed by the page's path, never in the work-folder.
  assert.deepEqual(await readdir(join(workFolder.workFolderRoot, "Sign up")), before);
  const databasePath = join(stateBase, "pages", "preview", workFolder.id, `${pagePreviewKey("Sign up")}.sqlite`);
  assert.ok(existsSync(databasePath));
  const db = openPageSqliteDatabase(databasePath);
  try {
    assert.equal(readPageMeta(db, "pagePath"), "Sign up");
    assert.match(readPageMeta(db, "declarationDigest") ?? "", /^[0-9a-f]{64}$/u);
  } finally {
    db.close();
  }

  // Renaming the page folder starts a fresh test database.
  await rename(join(workFolder.workFolderRoot, "Sign up"), join(workFolder.workFolderRoot, "Volunteers"));
  assert.deepEqual((await call({ role: "owner" }, { op: "count", table: "signups" }, "Volunteers")).body, { result: 0 });
  assert.equal((await get("/preview/data", { page: "Volunteers" })).status, 200);
});

test("the Data view lists, edits, deletes, restores, marks seen, and exports test entries", async (t) => {
  const { post, call, get, workFolder } = await setup(t);
  const visitor = String((await post("/preview/visitor", { page: "Sign up" })).body.visitor);
  const ada = (await call({ role: "visitor", visitor }, { op: "add", table: "signups", values: { name: "Ada", email: "ada@example.com" } })).body.result as { id: string };
  await call({ role: "visitor", visitor }, { op: "add", table: "signups", values: { name: "Bea", email: "bea@example.com", notes: "=1+1" } });

  const tables = await get("/preview/data", { page: "Sign up" });
  assert.deepEqual(tables.body, { tables: [{ name: "signups", retired: false, limit: 3, live: 2, deleted: 0, newCount: 2, lastSeen: null }] });

  const view = await get("/preview/data", { page: "Sign up", table: "signups" });
  assert.equal(view.status, 200);
  assert.equal(view.body!.table, "signups");
  assert.equal(view.body!.total, 2);
  assert.deepEqual((view.body!.columns as Array<{ name: string; retired: boolean }>).map((column) => [column.name, column.retired]), [
    ["name", false], ["email", false], ["shift", false], ["notes", false],
  ]);
  assert.equal((view.body!.rows as Array<{ visitor: string }>)[0]!.visitor, visitor);

  const edited = await post("/preview/data/update", { page: "Sign up", table: "signups", id: ada.id, values: { shift: "Afternoon" } });
  assert.equal((edited.body.row as { shift: string }).shift, "Afternoon");
  const badEdit = await post("/preview/data/update", { page: "Sign up", table: "signups", id: ada.id, values: { shift: "Night" } });
  assert.deepEqual([badEdit.status, badEdit.body.code, badEdit.body.field], [400, "INVALID", "shift"]);

  assert.deepEqual((await post("/preview/data/delete", { page: "Sign up", table: "signups", ids: [ada.id] })).body, { deleted: 1 });
  const deleted = await get("/preview/data", { page: "Sign up", table: "signups", deleted: "true" });
  assert.deepEqual((deleted.body!.rows as Array<{ id: string }>).map((row) => row.id), [ada.id]);
  assert.deepEqual((await call({ role: "owner" }, { op: "count", table: "signups" })).body, { result: 1 });
  assert.deepEqual((await post("/preview/data/restore", { page: "Sign up", table: "signups", ids: [ada.id] })).body, { restored: 1 });

  const seen = await post("/preview/data/seen", { page: "Sign up", table: "signups" });
  assert.match(String(seen.body.lastSeen), /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(((await get("/preview/data", { page: "Sign up" })).body!.tables as Array<{ newCount: number }>)[0]!.newCount, 0);

  const exported = await get("/preview/data/export", { page: "Sign up", table: "signups" });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(exported.headers.get("content-disposition") ?? "", /signups\.csv/);
  // fetch's text() drops the byte-order mark that helps spreadsheets read UTF-8; the bytes keep it.
  assert.equal(Number(exported.headers.get("content-length")), Buffer.byteLength(`\uFEFF${exported.text}`));
  assert.match(exported.text, /^name,email,shift,notes,createdAt,updatedAt,visitor,id\r\n/u);
  assert.match(exported.text, /Bea,bea@example.com,,'=1\+1,/u);


  // Removing a column keeps its data as no longer collected; a broken page.json pauses calls, not the Data view.
  const pageJson = join(workFolder.workFolderRoot, "Sign up", "page.json");
  const declaration = JSON.parse(await readFile(pageJson, "utf8")) as { tables: { signups: { columns: Record<string, unknown> } } };
  delete declaration.tables.signups.columns.notes;
  declaration.tables.signups.columns.phone = { type: "text" };
  await writeFile(pageJson, JSON.stringify(declaration));
  const changed = await get("/preview/data", { page: "Sign up", table: "signups" });
  assert.deepEqual((changed.body!.columns as Array<{ name: string; retired: boolean }>).map((column) => [column.name, column.retired]), [
    ["name", false], ["email", false], ["shift", false], ["phone", false], ["notes", true],
  ]);
  assert.equal((changed.body!.rows as Array<{ notes: string | null }>).find((row) => row.notes)?.notes, "=1+1");

  await writeFile(pageJson, "{ broken");
  const unavailable = await call({ role: "owner" }, { op: "count", table: "signups" });
  assert.deepEqual([unavailable.status, unavailable.body.code], [503, "UNAVAILABLE"]);
  const stillThere = await get("/preview/data", { page: "Sign up", table: "signups" });
  assert.equal(stillThere.status, 200);
  assert.equal((stillThere.body!.columns as Array<{ retired: boolean }>)[0]!.retired, false, "the last applied declaration still describes the table");
});
