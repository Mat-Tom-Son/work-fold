import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { workFolderPagesGuide } from "../src/local/agent/work-folder-operations-guide.js";

/**
 * The example page built the way the Worker's guide teaches (docs/pages.md):
 * an RSVP form saved by the form helper, a live "N of 50 spots taken" count,
 * and the visitor's own RSVP. It has to stay a valid page folder — a
 * work-fold.page/1 page.json and an entry that reaches only files inside its
 * own folder, with no network — and keep using only what the guide teaches.
 */
const folder = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages", "garden-party-rsvp");
const read = (name: string) => readFile(join(folder, name), "utf8");

interface ExamplePage {
  format: string;
  title: string;
  tables: Record<string, {
    columns: Record<string, { type: string; required?: boolean; unique?: boolean; options?: string[] }>;
    visitors: string[];
    limit: number;
  }>;
}

test("the garden party example's page.json is valid JSON in the work-fold.page/1 format", async () => {
  const page = JSON.parse(await read("page.json")) as ExamplePage;
  assert.equal(page.format, "work-fold.page/1");
  assert.ok(page.title.length >= 1 && page.title.length <= 120);
  assert.deepEqual(Object.keys(page).sort(), ["description", "format", "tables", "title"], "no unknown top-level fields");
  const rsvps = page.tables.rsvps!;
  assert.deepEqual(Object.keys(page.tables), ["rsvps"]);
  assert.deepEqual(Object.keys(rsvps).sort(), ["columns", "limit", "visitors"]);
  assert.equal(rsvps.limit, 50);
  assert.deepEqual(rsvps.visitors, ["add", "see-own", "delete-own"]);
  assert.deepEqual(Object.keys(rsvps.columns), ["name", "email", "bringing", "note"]);
  assert.deepEqual(rsvps.columns.email, { type: "email", required: true, unique: true });
  for (const name of [...Object.keys(page.tables), ...Object.keys(rsvps.columns)]) {
    assert.match(name, /^[a-z][a-z0-9_]{0,40}$/, `${name} is a valid table or column name`);
  }
});

test("the garden party example's HTML references only files inside its folder", async () => {
  const html = await read("index.html");
  const css = await read("style.css");
  const references = [
    ...[...html.matchAll(/\b(?:src|href|srcset|poster)\s*=\s*["']([^"']*)["']/gi)].map((match) => match[1]!),
    ...[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)].map((match) => (match[1] ?? match[2])!),
  ];
  assert.deepEqual([...references].sort(), ["app.js", "style.css"]);
  for (const reference of references) {
    assert.doesNotMatch(reference, /^[a-z][a-z0-9+.-]*:|^\/\//i, `${reference} is not a network or scheme address`);
    assert.equal(isAbsolute(reference), false, `${reference} is relative`);
    const inside = relative(folder, resolve(folder, reference));
    assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), `${reference} stays inside the page folder`);
    assert.ok((await stat(join(folder, inside))).isFile(), `${reference} exists`);
  }
  // Everything in a page folder becomes part of the page, so nothing stray sits in it.
  assert.deepEqual((await readdir(folder)).sort(), ["app.js", "index.html", "page.json", "style.css"]);
});

test("the garden party example follows the guide: the form helper, no network, and only the calls it teaches", async () => {
  const page = JSON.parse(await read("page.json")) as ExamplePage;
  const html = await read("index.html");
  const css = await read("style.css");
  const script = (await read("app.js")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const guide = workFolderPagesGuide().join("\n");

  // The form helper saves the form into a declared table, field by declared column.
  const form = html.match(/<form\b[^>]*data-page-table="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
  assert.ok(form, "the RSVP form uses data-page-table");
  const table = page.tables[form[1]!];
  assert.ok(table, "the form names a declared table");
  const fields = [...form[2]!.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]!);
  assert.deepEqual(fields, Object.keys(table.columns), "every field is a declared column, and every column has a field");
  for (const [name, column] of Object.entries(table.columns)) {
    if (column.required) assert.match(form[2]!, new RegExp(`name="${name}"[^>]*\\brequired\\b`), `${name} is required in the form too`);
    for (const option of column.options ?? []) assert.ok(form[2]!.includes(`<option>${option}</option>`), `${option} is offered`);
  }
  assert.match(form[2]!, /data-page-message/);
  assert.match(css, /form\[data-page-state="sending"\]/);
  assert.match(html, /<script src="app\.js"><\/script>\s*<\/body>/, "the script tag sits at the end of <body>");

  // The live count matches the table's limit, which the page cannot read from its own files.
  assert.match(html, />–<\/strong> of 50 spots taken/);
  assert.equal(Number(script.match(/const SPOTS = (\d+);/)?.[1]), table.limit);

  // No network, no own-file fetches, and no storage or dialogs a page does not have.
  for (const text of [html, css, script]) {
    assert.doesNotMatch(text, /https?:\/\/|["'(]\/\//, "no network addresses");
  }
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\bimport\s*\(|localStorage|sessionStorage|document\.cookie|\b(?:alert|confirm|prompt)\s*\(/);

  // Every call the example makes is one the guide teaches, and the table lets visitors make it.
  const calls = [...new Set([...script.matchAll(/\bpage\.(\w+)\(/g)].map((match) => match[1]!))].sort();
  assert.deepEqual(calls, ["count", "isOwner", "mine", "onChange", "remove"]);
  for (const call of calls) assert.ok(guide.includes(`\`${call}(`), `the guide teaches ${call}`);
  assert.ok(table.visitors.includes("add"), "the form helper adds rows");
  assert.ok(table.visitors.includes("see-own"), "mine needs see-own");
  assert.ok(table.visitors.includes("delete-own"), "remove needs delete-own");
  assert.match(script, /window\.workFoldPage/);
  assert.match(script, /addEventListener\("page:sent"/);
  assert.match(script, /LIMIT_REACHED/);
});
