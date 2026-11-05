import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PageCallError,
  normalizePageValue,
  normalizePageValues,
  pageDeclarationDigest,
  pageDeclarationToJson,
  pageSha256Hex,
  parsePageDeclaration,
  parsePageDeclarationText,
  type PageColumnDeclaration,
  type PageDeclaration,
} from "../src/shared/pages/index.js";

/**
 * page.json parsing and column values (docs/pages.md, "page.json",
 * "Column types"): strict, with every problem naming the field's path.
 */

const rsvp = {
  format: "work-fold.page/1",
  title: "Garden Party RSVP",
  tables: {
    rsvps: {
      columns: {
        name: { type: "text", required: true },
        email: { type: "email", required: true, unique: true },
        guests: { type: "number", min: 0, max: 10 },
        bringing: { type: "choice", options: ["Salad", "Dessert", "Drinks"] },
      },
      visitors: ["add", "see-own", "edit-own"],
      limit: 50,
    },
  },
};

function parsed(value: unknown): PageDeclaration {
  const result = parsePageDeclaration(value);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return (result as { declaration: PageDeclaration }).declaration;
}

function problemsOf(value: unknown): Array<{ path: string; message: string }> {
  const result = parsePageDeclaration(value);
  assert.equal(result.ok, false, "expected problems");
  return result.problems;
}

function withTable(table: unknown): unknown {
  return { format: "work-fold.page/1", title: "T", tables: { things: table } };
}

test("the contract's RSVP example parses with defaults filled in", () => {
  const declaration = parsed(rsvp);
  assert.equal(declaration.title, "Garden Party RSVP");
  assert.equal(declaration.entry, "index.html");
  assert.equal(declaration.description, undefined);
  assert.equal(declaration.tables.length, 1);
  const table = declaration.tables[0]!;
  assert.equal(table.name, "rsvps");
  assert.equal(table.limit, 50);
  assert.deepEqual(table.visitors, ["add", "see-own", "edit-own"]);
  assert.deepEqual(table.columns.map((column) => column.name), ["name", "email", "guests", "bringing"]);
  assert.deepEqual(table.columns[0], { name: "name", type: "text", required: true, unique: false, max: 500 });
  assert.deepEqual(table.columns[2], { name: "guests", type: "number", required: false, unique: false, min: 0, max: 10 });
  assert.deepEqual(table.columns[3]!.options, ["Salad", "Dessert", "Drinks"]);
});

test("a page without tables saves nothing and defaults apply", () => {
  const declaration = parsed({ format: "work-fold.page/1", title: "  Announcement  ", description: "Hi", entry: "pages/home.html" });
  assert.deepEqual(declaration.tables, []);
  assert.equal(declaration.title, "Announcement");
  assert.equal(declaration.entry, "pages/home.html");
  const table = parsed(withTable({ columns: { note: { type: "long-text" } } })).tables[0]!;
  assert.equal(table.limit, 10_000);
  assert.deepEqual(table.visitors, []);
  assert.equal(table.columns[0]!.max, 10_000);
});

test("unknown fields anywhere are errors that name the field path", () => {
  const problems = problemsOf({
    ...rsvp,
    theme: "dark",
    tables: {
      rsvps: {
        ...rsvp.tables.rsvps,
        sort: "name",
        columns: { ...rsvp.tables.rsvps.columns, name: { type: "text", placeholder: "Your name" }, guests: { type: "number", options: ["1"] } },
      },
    },
  });
  const paths = problems.map((problem) => problem.path);
  assert.ok(paths.includes("theme"));
  assert.ok(paths.includes("tables.rsvps.sort"));
  assert.ok(paths.includes("tables.rsvps.columns.name.placeholder"));
  const options = problems.find((problem) => problem.path === "tables.rsvps.columns.guests.options");
  assert.match(options?.message ?? "", /isn't used by "number" columns/);
});

test("required top-level fields, formats, and bounds are checked", () => {
  assert.deepEqual(problemsOf({}).map((problem) => problem.path).sort(), ["format", "title"]);
  assert.match(problemsOf({ format: "work-fold.page/2", title: "x" })[0]!.message, /exactly "work-fold.page\/1"/);
  assert.equal(problemsOf({ format: "work-fold.page/1", title: "   " })[0]!.path, "title");
  assert.equal(problemsOf({ format: "work-fold.page/1", title: "x".repeat(121) })[0]!.path, "title");
  assert.ok(parsePageDeclaration({ format: "work-fold.page/1", title: "x".repeat(120) }).ok);
  assert.equal(problemsOf({ format: "work-fold.page/1", title: "x", description: "d".repeat(501) })[0]!.path, "description");
  for (const entry of ["/index.html", "../index.html", "a/../index.html", "index.htm", ".hidden/index.html", "https://example.com/x.html", "", 5]) {
    assert.equal(problemsOf({ format: "work-fold.page/1", title: "x", entry })[0]!.path, "entry", String(entry));
  }
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`t${index}`, { columns: { a: { type: "text" } } }]));
  assert.ok(problemsOf({ format: "work-fold.page/1", title: "x", tables: many }).some((problem) => problem.path === "tables"));
  assert.equal(problemsOf(["not", "an", "object"])[0]!.path, "");
  assert.equal(parsePageDeclarationText("{ nope").ok, false);
  assert.match((parsePageDeclarationText("{ nope") as { problems: Array<{ message: string }> }).problems[0]!.message, /isn't valid JSON/);
  assert.equal(parsePageDeclarationText(`\uFEFF${JSON.stringify(rsvp)}`).ok, true, "a byte-order mark is allowed");
});

test("table and column names, visitors, limits, and type extras are checked", () => {
  assert.ok(problemsOf({ format: "work-fold.page/1", title: "x", tables: { "Bad-Name": { columns: { a: { type: "text" } } } } })
    .some((problem) => problem.path === "tables.Bad-Name"));
  assert.match(problemsOf({ format: "work-fold.page/1", title: "x", tables: { sqlite_stuff: { columns: { a: { type: "text" } } } } })[0]!.message, /sqlite_/);
  assert.ok(problemsOf(withTable({ columns: { _id: { type: "text" } } })).some((problem) => problem.path === "tables.things.columns._id"));
  assert.match(problemsOf(withTable({ columns: { id: { type: "text" } } }))[0]!.message, /used by work-fold/);
  assert.match(problemsOf(withTable({ columns: { visitor: { type: "text" } } }))[0]!.message, /used by work-fold/);
  assert.ok(problemsOf(withTable({ columns: {} })).some((problem) => problem.path === "tables.things.columns"));
  assert.ok(problemsOf(withTable({})).some((problem) => problem.path === "tables.things.columns"));
  const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`c${index}`, { type: "text" }]));
  assert.ok(problemsOf(withTable({ columns: tooMany })).some((problem) => problem.path === "tables.things.columns"));
  assert.ok(problemsOf(withTable({ columns: { a: { type: "text" } }, visitors: ["add", "see-everything"] }))
    .some((problem) => problem.path === "tables.things.visitors[1]"));
  assert.match(problemsOf(withTable({ columns: { a: { type: "text" } }, visitors: ["add", "add"] }))[0]!.message, /listed twice/);
  for (const limit of [0, 100_001, 1.5, "50"]) {
    assert.equal(problemsOf(withTable({ columns: { a: { type: "text" } }, limit }))[0]!.path, "tables.things.limit", String(limit));
  }
  assert.equal(problemsOf(withTable({ columns: { a: { type: "paragraph" } } }))[0]!.path, "tables.things.columns.a.type");
  assert.equal(problemsOf(withTable({ columns: { a: { required: true } } }))[0]!.path, "tables.things.columns.a.type");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "text", required: "yes" } } }))[0]!.path, "tables.things.columns.a.required");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "text", max: 10_001 } } }))[0]!.path, "tables.things.columns.a.max");
  assert.ok(parsePageDeclaration(withTable({ columns: { a: { type: "long-text", max: 100_000 } } })).ok);
  assert.equal(problemsOf(withTable({ columns: { a: { type: "long-text", max: 100_001 } } }))[0]!.path, "tables.things.columns.a.max");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "number", min: 5, max: 1 } } }))[0]!.path, "tables.things.columns.a.min");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "choice" } } }))[0]!.path, "tables.things.columns.a.options");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "choice", options: [] } } }))[0]!.path, "tables.things.columns.a.options");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "choice", options: ["x", "x"] } } }))[0]!.path, "tables.things.columns.a.options[1]");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "choice", options: ["x", ""] } } }))[0]!.path, "tables.things.columns.a.options[1]");
  assert.equal(problemsOf(withTable({ columns: { a: { type: "email", max: 4 } } }))[0]!.path, "tables.things.columns.a.max");
});

test("the declaration digest is stable, round-trips through page.json form, and is a real SHA-256", () => {
  const declaration = parsed(rsvp);
  assert.equal(pageDeclarationDigest(declaration), pageDeclarationDigest(parsed(JSON.parse(JSON.stringify(rsvp)))));
  assert.deepEqual(parsed(pageDeclarationToJson(declaration)), declaration);
  const changed = parsed({ ...rsvp, title: "Changed" });
  assert.notEqual(pageDeclarationDigest(changed), pageDeclarationDigest(declaration));
  for (const text of ["", "abc", "x".repeat(1000), "héllo ✓ 🌱"]) {
    assert.equal(pageSha256Hex(text), createHash("sha256").update(text, "utf8").digest("hex"));
  }
});

function column(partial: Partial<PageColumnDeclaration> & Pick<PageColumnDeclaration, "type">): PageColumnDeclaration {
  return { name: "field", required: false, unique: false, ...partial };
}

function refusal(action: () => unknown): PageCallError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PageCallError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

test("values are checked and normalized per column type", () => {
  const text = column({ type: "text", max: 5 });
  assert.equal(normalizePageValue(text, "  hi  "), "hi");
  assert.equal(normalizePageValue(text, ""), null, "empty strings count as missing");
  assert.equal(normalizePageValue(text, "   "), null);
  assert.equal(normalizePageValue(text, undefined), null);
  assert.equal(refusal(() => normalizePageValue(text, "a\nb")).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(text, "toolong")).field, "field");
  assert.equal(refusal(() => normalizePageValue(text, 5)).code, "INVALID");
  assert.equal(normalizePageValue(column({ type: "text", max: 2 }), "🌱🌱"), "🌱🌱", "length counts characters, not UTF-16 units");
  assert.equal(normalizePageValue(column({ type: "long-text", max: 50 }), "line one\nline two "), "line one\nline two ");

  const number = column({ type: "number", min: 0, max: 10, integer: true });
  assert.equal(normalizePageValue(number, 3), 3);
  assert.equal(normalizePageValue(number, "4"), 4, "a number typed as text is accepted");
  assert.equal(refusal(() => normalizePageValue(number, 2.5)).message, "field must be a whole number.");
  assert.equal(refusal(() => normalizePageValue(number, 11)).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(number, -1)).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(column({ type: "number" }), Number.NaN)).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(column({ type: "number" }), "12abc")).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(column({ type: "number" }), true)).code, "INVALID");

  const flag = column({ type: "boolean" });
  assert.equal(normalizePageValue(flag, true), true);
  assert.equal(normalizePageValue(flag, false), false);
  assert.equal(normalizePageValue(flag, "true"), true);
  assert.equal(refusal(() => normalizePageValue(flag, 1)).code, "INVALID");

  const date = column({ type: "date" });
  assert.equal(normalizePageValue(date, "2026-11-05"), "2026-11-05");
  assert.equal(normalizePageValue(date, "2026-11-05T18:30"), "2026-11-05T18:30");
  assert.equal(normalizePageValue(date, "2026-11-05T18:30:15.123Z"), "2026-11-05T18:30:15.123Z");
  assert.equal(normalizePageValue(date, "2024-02-29"), "2024-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "11/05/2026", "2026-11-05T25:00", "yesterday"]) {
    assert.equal(refusal(() => normalizePageValue(date, bad)).code, "INVALID", bad);
  }

  const email = column({ type: "email" });
  assert.equal(normalizePageValue(email, "  Ada@Example.COM "), "ada@example.com");
  assert.equal(refusal(() => normalizePageValue(email, "not an email")).code, "INVALID");

  const url = column({ type: "url" });
  assert.equal(normalizePageValue(url, "https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(refusal(() => normalizePageValue(url, "javascript:alert(1)")).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(url, "ftp://example.com")).code, "INVALID");
  assert.equal(refusal(() => normalizePageValue(url, "example.com")).code, "INVALID");

  const choice = column({ type: "choice", options: ["Salad", "Dessert"] });
  assert.equal(normalizePageValue(choice, "Salad"), "Salad");
  assert.equal(refusal(() => normalizePageValue(choice, "salad")).code, "INVALID");
});

test("a values object refuses undeclared columns, requires required ones, and bounds its size", () => {
  const table = parsed(rsvp).tables[0]!;
  const values = normalizePageValues(table, { name: "Ada", email: "ADA@example.com", guests: 2, bringing: "" }, "add");
  assert.deepEqual([...values.entries()], [["name", "Ada"], ["email", "ada@example.com"], ["guests", 2], ["bringing", null]]);
  const undeclared = refusal(() => normalizePageValues(table, { name: "Ada", email: "a@b.co", plusOne: true }, "add"));
  assert.equal(undeclared.code, "INVALID");
  assert.equal(undeclared.field, "plusOne");
  assert.equal(refusal(() => normalizePageValues(table, { email: "a@b.co" }, "add")).field, "name");
  assert.equal(refusal(() => normalizePageValues(table, { name: "", email: "a@b.co" }, "add")).field, "name");
  assert.equal(normalizePageValues(table, { guests: 3 }, "update").size, 1, "an update may change one column");
  assert.equal(refusal(() => normalizePageValues(table, { name: null }, "update")).field, "name", "an update can't clear a required column");
  assert.equal(refusal(() => normalizePageValues(table, ["Ada"], "add")).code, "INVALID");
  assert.equal(refusal(() => normalizePageValues(table, { name: "x".repeat(1024 * 1024 + 1), email: "a@b.co" }, "add")).code, "TOO_LARGE");
});
