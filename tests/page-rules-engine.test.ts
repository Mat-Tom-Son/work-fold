import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  PageCallError,
  applyPageSchema,
  createPageVisitorId,
  deletePageDataRows,
  exportPageDataTableCsv,
  listPageDataTables,
  markPageDataTableSeen,
  parsePageCall,
  parsePageDeclaration,
  parsePageViewer,
  purgeDeletedPageRows,
  quotePageIdentifier,
  readPageDataTable,
  readPageMeta,
  readStoredPageDeclaration,
  restorePageDataRows,
  runPageCall,
  updatePageDataRow,
  type PageCall,
  type PageDeclaration,
  type PageEngineEnvironment,
  type PageRow,
  type PageViewer,
} from "../src/shared/pages/index.js";
import { openPageSqliteDatabase, type PageSqliteDatabase } from "../src/local/pages/page-sqlite.js";

/**
 * The page rules engine (docs/pages.md): every page call checked against the
 * declaration for visitors and the owner, request-id dedupe, limits, unique on
 * live rows, soft delete with restore and a 30-day purge, additive schema
 * changes, and the owner's Data view — over node:sqlite.
 */

function declare(tables: Record<string, unknown>, title = "Test page"): PageDeclaration {
  const parsed = parsePageDeclaration({ format: "work-fold.page/1", title, tables });
  assert.equal(parsed.ok, true, JSON.stringify(parsed.problems));
  return (parsed as { declaration: PageDeclaration }).declaration;
}

const rsvpTables = {
  rsvps: {
    columns: {
      name: { type: "text", required: true },
      email: { type: "email", required: true, unique: true },
      guests: { type: "number", min: 0, max: 10, integer: true },
      vegetarian: { type: "boolean" },
      bringing: { type: "choice", options: ["Salad", "Dessert", "Drinks"] },
    },
    visitors: ["add", "see-own", "edit-own", "delete-own"],
    limit: 3,
  },
  messages: {
    columns: { text: { type: "long-text", required: true } },
    visitors: ["add", "see-all"],
  },
  secrets: {
    columns: { note: { type: "text" } },
  },
};

interface Harness {
  db: PageSqliteDatabase;
  declaration: PageDeclaration;
  clock: { now: Date };
  environment: PageEngineEnvironment;
  call(viewer: PageViewer, call: PageCall): unknown;
  refuse(viewer: PageViewer, call: PageCall): PageCallError;
}

const ada: PageViewer = { role: "visitor", visitor: "v_ada000000000000" };
const bea: PageViewer = { role: "visitor", visitor: "v_bea000000000000" };
const owner: PageViewer = { role: "owner" };

function setup(t: TestContext, tables: Record<string, unknown> = rsvpTables): Harness {
  const db = openPageSqliteDatabase(":memory:");
  t.after(() => db.close());
  const declaration = declare(tables);
  const clock = { now: new Date("2026-11-05T12:00:00.000Z") };
  let sequence = 0;
  const environment: PageEngineEnvironment = { now: () => clock.now, newId: () => `row-${String(++sequence).padStart(4, "0")}` };
  applyPageSchema(db, declaration, clock.now);
  const call = (viewer: PageViewer, pageCall: PageCall) => runPageCall(db, declaration, viewer, pageCall, environment);
  return {
    db,
    declaration,
    clock,
    environment,
    call,
    refuse(viewer, pageCall) {
      try {
        call(viewer, pageCall);
      } catch (error) {
        assert.ok(error instanceof PageCallError, String(error));
        return error;
      }
      assert.fail(`expected ${pageCall.op} to be refused`);
    },
  };
}

const advance = (harness: Harness, ms: number) => { harness.clock.now = new Date(harness.clock.now.getTime() + ms); };

test("add returns the new row in the page's shape; the owner also sees the visitor", (t) => {
  const page = setup(t);
  const row = page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ADA@Example.com", guests: "2", vegetarian: true } }) as PageRow;
  assert.deepEqual(row, {
    id: "row-0001",
    createdAt: "2026-11-05T12:00:00.000Z",
    updatedAt: "2026-11-05T12:00:00.000Z",
    name: "Ada",
    email: "ada@example.com",
    guests: 2,
    vegetarian: true,
    bringing: null,
  });
  const listed = page.call(owner, { op: "list", table: "rsvps" }) as PageRow[];
  assert.equal(listed[0]!.visitor, "v_ada000000000000");
  assert.equal(page.call(owner, { op: "isOwner" }), true);
  assert.equal(page.call(ada, { op: "isOwner" }), false);
});

test("each call needs its declared visitor permission; the owner may do everything", (t) => {
  const page = setup(t);
  assert.equal(page.refuse(ada, { op: "add", table: "secrets", values: { note: "x" } }).code, "NOT_ALLOWED");
  assert.equal(page.refuse(ada, { op: "mine", table: "messages" }).code, "NOT_ALLOWED");
  assert.equal(page.refuse(ada, { op: "list", table: "rsvps" }).code, "NOT_ALLOWED");
  page.call(ada, { op: "add", table: "messages", values: { text: "hello" } });
  assert.equal(page.refuse(ada, { op: "update", table: "messages", id: "row-0001", values: { text: "edited" } }).code, "NOT_ALLOWED");
  assert.equal(page.refuse(ada, { op: "remove", table: "messages", id: "row-0001" }).code, "NOT_ALLOWED");
  assert.equal(page.call(ada, { op: "count", table: "secrets" }), 0, "count is always allowed");

  const secret = page.call(owner, { op: "add", table: "secrets", values: { note: "owner only" } }) as PageRow;
  assert.equal(secret.visitor, "owner");
  assert.equal((page.call(owner, { op: "list", table: "secrets" }) as PageRow[]).length, 1);
  assert.equal((page.call(owner, { op: "mine", table: "secrets" }) as PageRow[]).length, 1, "the owner's own rows");
  page.call(owner, { op: "update", table: "messages", id: "row-0001", values: { text: "owner edit" } });
  assert.equal(page.call(owner, { op: "remove", table: "messages", id: "row-0001" }), true);
  assert.equal(page.refuse(ada, { op: "add", table: "nope", values: {} }).code, "NOT_FOUND");
});

test("a visitor never sees, changes, or removes another visitor's rows", (t) => {
  const page = setup(t);
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  advance(page, 1000);
  page.call(bea, { op: "add", table: "rsvps", values: { name: "Bea", email: "bea@example.com" } });
  advance(page, 1000);
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada's friend", email: "friend@example.com" } });

  const adas = page.call(ada, { op: "mine", table: "rsvps" }) as PageRow[];
  assert.deepEqual(adas.map((row) => row.name), ["Ada's friend", "Ada"], "newest first");
  assert.equal(adas.some((row) => row.visitor !== undefined), false, "visitors never see visitor ids");
  assert.deepEqual((page.call(bea, { op: "mine", table: "rsvps" }) as PageRow[]).map((row) => row.name), ["Bea"]);
  const fresh: PageViewer = { role: "visitor", visitor: createPageVisitorId() };
  assert.deepEqual(page.call(fresh, { op: "mine", table: "rsvps" }), []);

  const beaRow = (page.call(bea, { op: "mine", table: "rsvps" }) as PageRow[])[0]!;
  assert.equal(page.refuse(ada, { op: "update", table: "rsvps", id: beaRow.id, values: { guests: 3 } }).code, "NOT_ALLOWED");
  assert.equal(page.refuse(ada, { op: "remove", table: "rsvps", id: beaRow.id }).code, "NOT_ALLOWED");
  assert.equal(page.refuse(ada, { op: "update", table: "rsvps", id: "missing", values: { guests: 3 } }).code, "NOT_FOUND");

  advance(page, 1000);
  const updated = page.call(bea, { op: "update", table: "rsvps", id: beaRow.id, values: { guests: 4, bringing: "Salad" } }) as PageRow;
  assert.equal(updated.guests, 4);
  assert.equal(updated.bringing, "Salad");
  assert.equal(updated.name, "Bea");
  assert.notEqual(updated.updatedAt, updated.createdAt);
  assert.equal(page.call(bea, { op: "remove", table: "rsvps", id: beaRow.id }), true);
  assert.deepEqual(page.call(bea, { op: "mine", table: "rsvps" }), [], "removed rows are gone from page calls");
  assert.equal(page.refuse(bea, { op: "update", table: "rsvps", id: beaRow.id, values: { guests: 1 } }).code, "NOT_FOUND");
  assert.equal(page.call(owner, { op: "count", table: "rsvps" }), 2);
});

test("list honors its limit and order; count filters on equality", (t) => {
  const page = setup(t);
  for (const text of ["one", "two", "three"]) {
    page.call(ada, { op: "add", table: "messages", values: { text } });
    advance(page, 1000);
  }
  assert.deepEqual((page.call(bea, { op: "list", table: "messages" }) as PageRow[]).map((row) => row.text), ["one", "two", "three"]);
  assert.deepEqual((page.call(bea, { op: "list", table: "messages", options: { limit: 2, newestFirst: true } }) as PageRow[]).map((row) => row.text), ["three", "two"]);
  assert.equal(page.refuse(bea, { op: "list", table: "messages", options: { limit: 1001 } }).code, "INVALID");
  assert.equal(page.refuse(bea, { op: "list", table: "messages", options: { sort: "text" } }).code, "INVALID");

  page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com", bringing: "Salad", vegetarian: true } });
  page.call(bea, { op: "add", table: "rsvps", values: { name: "Bea", email: "bea@example.com", bringing: "Salad" } });
  page.call(bea, { op: "add", table: "rsvps", values: { name: "Cy", email: "cy@example.com" } });
  assert.equal(page.call(bea, { op: "count", table: "rsvps", where: { bringing: "Salad" } }), 2);
  assert.equal(page.call(bea, { op: "count", table: "rsvps", where: { email: "ADA@example.com" } }), 1, "where values are normalized");
  assert.equal(page.call(bea, { op: "count", table: "rsvps", where: { vegetarian: true } }), 1);
  assert.equal(page.call(bea, { op: "count", table: "rsvps", where: { bringing: "" } }), 1, "an empty value matches missing ones");
  assert.equal(page.refuse(bea, { op: "count", table: "rsvps", where: { plusOne: true } }).field, "plusOne");
  assert.equal(page.refuse(bea, { op: "count", table: "rsvps", where: { bringing: "Cake" } }).code, "INVALID");
});

test("the same request id within ten minutes returns the row it already created", (t) => {
  const page = setup(t);
  const values = { name: "Ada", email: "ada@example.com" };
  const first = page.call(ada, { op: "add", table: "rsvps", values, requestId: "req-1" }) as PageRow;
  advance(page, 60_000);
  const retry = page.call(ada, { op: "add", table: "rsvps", values, requestId: "req-1" }) as PageRow;
  assert.equal(retry.id, first.id, "a retry is not a duplicate");
  assert.equal(page.call(owner, { op: "count", table: "rsvps" }), 1);
  // Another visitor's identical request id is theirs alone.
  assert.equal(page.refuse(bea, { op: "add", table: "rsvps", values, requestId: "req-1" }).code, "DUPLICATE");
  // After ten minutes the id no longer dedupes, so the unique column refuses.
  advance(page, 10 * 60_000);
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values, requestId: "req-1" }).code, "DUPLICATE");
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values, requestId: "bad id!" }).code, "INVALID");
});

test("the row limit counts live rows; a retry at the limit still returns its row", (t) => {
  const page = setup(t);
  for (const name of ["a", "b", "c"]) page.call(ada, { op: "add", table: "rsvps", values: { name, email: `${name}@example.com` }, requestId: `req-${name}` });
  const full = page.refuse(bea, { op: "add", table: "rsvps", values: { name: "d", email: "d@example.com" } });
  assert.equal(full.code, "LIMIT_REACHED");
  assert.match(full.message, /limit of 3/);
  assert.equal(page.refuse(owner, { op: "add", table: "rsvps", values: { name: "e", email: "e@example.com" } }).code, "LIMIT_REACHED", "the limit is the table's capacity, for everyone");
  assert.equal((page.call(ada, { op: "add", table: "rsvps", values: { name: "c", email: "c@example.com" }, requestId: "req-c" }) as PageRow).name, "c");
  const [row] = page.call(ada, { op: "mine", table: "rsvps" }) as PageRow[];
  page.call(ada, { op: "remove", table: "rsvps", id: row!.id });
  assert.equal((page.call(bea, { op: "add", table: "rsvps", values: { name: "d", email: "d@example.com" } }) as PageRow).name, "d", "removing a row frees a place");
});

test("unique is enforced on live rows: removed rows don't block, updates check others", (t) => {
  const page = setup(t);
  const adaRow = page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } }) as PageRow;
  const duplicate = page.refuse(bea, { op: "add", table: "rsvps", values: { name: "Not Ada", email: " Ada@EXAMPLE.com" } });
  assert.equal(duplicate.code, "DUPLICATE");
  assert.equal(duplicate.field, "email");
  assert.equal((page.call(ada, { op: "update", table: "rsvps", id: adaRow.id, values: { email: "ada@example.com", guests: 1 } }) as PageRow).guests, 1, "a row may keep its own value");
  const beaRow = page.call(bea, { op: "add", table: "rsvps", values: { name: "Bea", email: "bea@example.com" } }) as PageRow;
  assert.equal(page.refuse(bea, { op: "update", table: "rsvps", id: beaRow.id, values: { email: "ada@example.com" } }).field, "email");
  page.call(ada, { op: "remove", table: "rsvps", id: adaRow.id });
  assert.equal((page.call(bea, { op: "add", table: "rsvps", values: { name: "Ada again", email: "ada@example.com" } }) as PageRow).name, "Ada again");
});

test("invalid values and calls are refused with INVALID naming the field", (t) => {
  const page = setup(t);
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values: { name: "Ada" } }).field, "email");
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "a@b.co", guests: 11 } }).field, "guests");
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "a@b.co", bringing: "Cake" } }).field, "bringing");
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "a@b.co", _visitor: "v_someone_else" } }).field, "_visitor");
  assert.equal(page.refuse(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "a@b.co", notes: "x" } }).field, "notes");
  assert.equal(page.refuse(ada, { op: "update", table: "rsvps", id: 7 as unknown as string, values: {} }).code, "INVALID");
  assert.throws(() => parsePageCall({ op: "drop", table: "rsvps" }), (error: unknown) => error instanceof PageCallError && error.code === "INVALID");
  assert.throws(() => parsePageViewer({ role: "visitor", visitor: "owner" }), PageCallError);
  assert.throws(() => parsePageViewer({ role: "visitor", visitor: "short" }), PageCallError);
  assert.throws(() => parsePageViewer({ role: "admin" }), PageCallError);
  assert.deepEqual(parsePageViewer({ role: "owner", visitor: "ignored" }), { role: "owner" });
  const shaped = parsePageCall({ op: "add", table: "rsvps", values: { name: "x" }, requestId: "r1", extra: true });
  assert.deepEqual(shaped, { op: "add", table: "rsvps", values: { name: "x" }, requestId: "r1" });
  assert.deepEqual(new PageCallError("DUPLICATE", "Taken.", "email").toJSON(), { code: "DUPLICATE", message: "Taken.", field: "email" });
});

test("schema changes are additive: new tables and columns appear, removed ones are kept as retired", (t) => {
  const page = setup(t);
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com", bringing: "Salad", vegetarian: true } });
  page.call(owner, { op: "add", table: "secrets", values: { note: "keep me" } });
  const firstDigest = readPageMeta(page.db, "declarationDigest");
  const firstAppliedAt = readPageMeta(page.db, "appliedAt");

  // Re-applying the same declaration changes nothing.
  advance(page, 1000);
  const again = applyPageSchema(page.db, page.declaration, page.clock.now);
  assert.deepEqual(again.added, { tables: [], columns: [] });
  assert.equal(readPageMeta(page.db, "appliedAt"), firstAppliedAt);

  // Drop `bringing` and `vegetarian` and the `secrets` table; add `phone`, a unique `name`, and a `polls` table.
  const next = declare({
    rsvps: {
      columns: {
        name: { type: "text", required: true, unique: true },
        email: { type: "email", required: true, unique: true },
        guests: { type: "number", min: 0, max: 10 },
        phone: { type: "text" },
      },
      visitors: ["add", "see-own"],
      limit: 3,
    },
    messages: rsvpTables.messages,
    polls: { columns: { answer: { type: "choice", options: ["Yes", "No"] } }, visitors: ["add"] },
  });
  advance(page, 1000);
  const status = applyPageSchema(page.db, next, page.clock.now);
  assert.deepEqual(status.added, { tables: ["polls"], columns: [{ table: "rsvps", column: "phone" }] });
  assert.notEqual(readPageMeta(page.db, "declarationDigest"), firstDigest);
  assert.equal(readPageMeta(page.db, "appliedAt"), page.clock.now.toISOString());
  const rsvps = status.tables.find((table) => table.name === "rsvps")!;
  assert.deepEqual(rsvps.columns.map((column) => [column.name, column.type, column.retired]), [
    ["name", "text", false], ["email", "email", false], ["guests", "number", false], ["phone", "text", false],
    ["vegetarian", "boolean", true], ["bringing", "choice", true],
  ]);
  assert.deepEqual(status.tables.find((table) => table.name === "secrets"), {
    name: "secrets", retired: true, columns: [{ name: "note", type: "text", retired: true }],
  });

  // Page calls see only declared columns; the Data view keeps the retired data.
  const rows = runPageCall(page.db, next, owner, { op: "list", table: "rsvps" }) as PageRow[];
  assert.equal("bringing" in rows[0]!, false);
  const view = readPageDataTable(page.db, next, "rsvps");
  assert.equal(view.rows[0]!.bringing, "Salad");
  assert.equal(view.rows[0]!.vegetarian, true, "a retired boolean keeps reading as true/false");
  assert.equal(view.columns.find((column) => column.name === "bringing")?.retired, true);
  const secrets = readPageDataTable(page.db, next, "secrets");
  assert.equal(secrets.retired, true);
  assert.equal(secrets.rows[0]!.note, "keep me");
  assert.throws(() => runPageCall(page.db, next, owner, { op: "add", table: "secrets", values: { note: "x" } }), (error: unknown) => error instanceof PageCallError && error.code === "NOT_FOUND");

  // Adding `unique` later never fails on old duplicates; it applies to new rows.
  const dup = declare({ messages: { columns: { text: { type: "long-text", required: true, unique: true } }, visitors: ["add"] } });
  runPageCall(page.db, page.declaration, ada, { op: "add", table: "messages", values: { text: "same" } }, page.environment);
  runPageCall(page.db, page.declaration, bea, { op: "add", table: "messages", values: { text: "same" } }, page.environment);
  applyPageSchema(page.db, dup, page.clock.now);
  assert.throws(() => runPageCall(page.db, dup, ada, { op: "add", table: "messages", values: { text: "same" } }, page.environment),
    (error: unknown) => error instanceof PageCallError && error.code === "DUPLICATE");

  // Bringing a retired column back restores its data to page calls.
  applyPageSchema(page.db, page.declaration, page.clock.now);
  const restored = runPageCall(page.db, page.declaration, owner, { op: "list", table: "rsvps" }) as PageRow[];
  assert.equal(restored[0]!.bringing, "Salad");
  assert.deepEqual(readStoredPageDeclaration(page.db), page.declaration, "the last applied declaration is kept for the Data view");
});

test("identifiers are quoted only after checking them", () => {
  assert.equal(quotePageIdentifier("rsvps"), "\"rsvps\"");
  assert.equal(quotePageIdentifier("_page_meta"), "\"_page_meta\"");
  for (const bad of ["Robert\"); DROP TABLE x; --", "with space", "", "1abc", "Upper"]) {
    assert.throws(() => quotePageIdentifier(bad), /unexpected SQL identifier/, bad);
  }
});

test("the owner's Data view: rows, edits, delete and restore, What's new, and CSV export", (t) => {
  const page = setup(t);
  const adaRow = page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com", guests: 2 } }) as PageRow;
  advance(page, 1000);
  const beaRow = page.call(bea, { op: "add", table: "rsvps", values: { name: "Bea, \"B\"", email: "bea@example.com", bringing: "Dessert" } }) as PageRow;

  let tables = listPageDataTables(page.db, page.declaration);
  assert.deepEqual(tables.map((table) => [table.name, table.live, table.deleted, table.newCount, table.limit]), [
    ["rsvps", 2, 0, 2, 3], ["messages", 0, 0, 0, 10_000], ["secrets", 0, 0, 0, 10_000],
  ]);
  const seen = markPageDataTableSeen(page.db, page.declaration, "rsvps", page.environment);
  assert.equal(seen, page.clock.now.toISOString());
  advance(page, 1000);
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Cy", email: "cy@example.com" } });
  tables = listPageDataTables(page.db, page.declaration);
  assert.equal(tables[0]!.newCount, 1, "only rows added since the owner last looked");

  const view = readPageDataTable(page.db, page.declaration, "rsvps");
  assert.equal(view.total, 3);
  assert.equal(view.lastSeen, seen);
  assert.deepEqual(view.rows.map((row) => row.name), ["Cy", "Bea, \"B\"", "Ada"]);
  assert.equal(view.rows[2]!.visitor, "v_ada000000000000");
  assert.equal(view.rows[2]!.deletedAt, null);
  assert.deepEqual(view.columns.find((column) => column.name === "email"), { name: "email", type: "email", retired: false, required: true, unique: true });

  const edited = updatePageDataRow(page.db, page.declaration, "rsvps", adaRow.id, { guests: 5 }, page.environment);
  assert.equal(edited.guests, 5);
  assert.throws(() => updatePageDataRow(page.db, page.declaration, "rsvps", adaRow.id, { guests: 50 }), (error: unknown) => error instanceof PageCallError && error.field === "guests");
  assert.throws(() => updatePageDataRow(page.db, page.declaration, "rsvps", adaRow.id, { email: "bea@example.com" }), (error: unknown) => error instanceof PageCallError && error.code === "DUPLICATE");

  assert.equal(deletePageDataRows(page.db, page.declaration, "rsvps", [adaRow.id, beaRow.id, "missing"], page.environment), 2);
  assert.equal(deletePageDataRows(page.db, page.declaration, "rsvps", [adaRow.id], page.environment), 0, "already deleted");
  assert.equal(page.call(owner, { op: "count", table: "rsvps" }), 1, "page calls never see deleted rows");
  const deleted = readPageDataTable(page.db, page.declaration, "rsvps", { deleted: true });
  assert.equal(deleted.total, 2);
  assert.ok(deleted.rows.every((row) => row.deletedAt === page.clock.now.toISOString()));

  // Restoring past the limit or onto a taken unique value is refused as a whole.
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Dee", email: "dee@example.com" } });
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Eve", email: "ada@example.com" } });
  assert.throws(() => restorePageDataRows(page.db, page.declaration, "rsvps", [adaRow.id]), (error: unknown) => error instanceof PageCallError && error.code === "LIMIT_REACHED");
  deletePageDataRows(page.db, page.declaration, "rsvps", [(readPageDataTable(page.db, page.declaration, "rsvps").rows.find((row) => row.name === "Dee"))!.id], page.environment);
  assert.throws(() => restorePageDataRows(page.db, page.declaration, "rsvps", [adaRow.id]), (error: unknown) => error instanceof PageCallError && error.field === "email");
  assert.equal(restorePageDataRows(page.db, page.declaration, "rsvps", [beaRow.id]), 1);
  assert.equal(page.call(owner, { op: "count", table: "rsvps" }), 3);

  const csv = exportPageDataTableCsv(page.db, page.declaration, "rsvps");
  assert.ok(csv.startsWith("\uFEFFname,email,guests,vegetarian,bringing,createdAt,updatedAt,visitor,id\r\n"));
  assert.match(csv, /"Bea, ""B""",bea@example.com,,,Dessert,/);
  assert.equal(csv.trimEnd().split("\r\n").length, 4, "a header and the three live rows");

  assert.throws(() => readPageDataTable(page.db, page.declaration, "nope"), (error: unknown) => error instanceof PageCallError && error.code === "NOT_FOUND");
  assert.throws(() => deletePageDataRows(page.db, page.declaration, "rsvps", []), PageCallError);
});

test("CSV export keeps spreadsheet formulas from running", (t) => {
  const page = setup(t, { notes: { columns: { text: { type: "text" }, amount: { type: "number" } }, visitors: ["add"] } });
  page.call(ada, { op: "add", table: "notes", values: { text: "=HYPERLINK(\"http://x\")", amount: -5 } });
  const csv = exportPageDataTableCsv(page.db, page.declaration, "notes");
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/x""\)",-5,/);
});

test("rows deleted more than 30 days ago are purged; newer deletions stay restorable", (t) => {
  const page = setup(t);
  const old = page.call(ada, { op: "add", table: "rsvps", values: { name: "Old", email: "old@example.com" } }) as PageRow;
  page.call(ada, { op: "remove", table: "rsvps", id: old.id });
  advance(page, 20 * 24 * 60 * 60 * 1000);
  const recent = page.call(ada, { op: "add", table: "rsvps", values: { name: "Recent", email: "recent@example.com" } }) as PageRow;
  page.call(ada, { op: "remove", table: "rsvps", id: recent.id });
  advance(page, 11 * 24 * 60 * 60 * 1000);
  assert.equal(purgeDeletedPageRows(page.db, page.environment), 1);
  const deleted = readPageDataTable(page.db, page.declaration, "rsvps", { deleted: true });
  assert.deepEqual(deleted.rows.map((row) => row.name), ["Recent"]);
  assert.equal(restorePageDataRows(page.db, page.declaration, "rsvps", [old.id, recent.id]), 1);
});

test("a refused write leaves nothing behind", (t) => {
  const page = setup(t);
  page.call(ada, { op: "add", table: "rsvps", values: { name: "Ada", email: "ada@example.com" } });
  page.refuse(bea, { op: "add", table: "rsvps", values: { name: "Bea", email: "ada@example.com" } });
  assert.equal(readPageDataTable(page.db, page.declaration, "rsvps").total, 1);
  assert.throws(() => page.db.transaction!(() => {
    page.db.run(`UPDATE "rsvps" SET "name" = 'Changed'`);
    throw new Error("abort");
  }), /abort/);
  assert.equal(readPageDataTable(page.db, page.declaration, "rsvps").rows[0]!.name, "Ada", "the transaction rolled back");
});
