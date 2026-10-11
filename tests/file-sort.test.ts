import assert from "node:assert/strict";
import test from "node:test";

import { defaultFileSort, nextFileSort, normalizeFileSort, sortFileTree } from "../web-local/src/lib/file-sort.js";
import type { TreeEntry } from "../web-local/src/types.js";

const file = (name: string, sizeBytes: number, updatedAt: string): TreeEntry => ({ name, path: name, kind: "file", sizeBytes, updatedAt });
const folder = (name: string, children: TreeEntry[] = [], updatedAt?: string): TreeEntry => ({ name, path: name, kind: "folder", children, ...(updatedAt ? { updatedAt } : {}) });

const tree: TreeEntry[] = [
  file("10 - notes.md", 300, "2026-10-01T00:00:00Z"),
  folder("Receipts", [file("b.pdf", 5, "2026-10-03T00:00:00Z"), file("a.pdf", 50, "2026-10-02T00:00:00Z")], "2026-09-01T00:00:00Z"),
  file("2 - plan.txt", 9000, "2026-10-05T00:00:00Z"),
  folder("Archive", [], "2026-10-09T00:00:00Z"),
  file("budget.xlsx", 20, "2026-09-20T00:00:00Z"),
];
const names = (entries: TreeEntry[]) => entries.map((entry) => entry.name);

test("name sort keeps folders first and orders numbers naturally, at every level", () => {
  const sorted = sortFileTree(tree, defaultFileSort);
  assert.deepEqual(names(sorted), ["Archive", "Receipts", "2 - plan.txt", "10 - notes.md", "budget.xlsx"]);
  assert.deepEqual(names(sorted[1]!.children!), ["a.pdf", "b.pdf"]);
  assert.deepEqual(names(sortFileTree(tree, { key: "name", direction: "desc" })), ["Receipts", "Archive", "budget.xlsx", "10 - notes.md", "2 - plan.txt"]);
});

test("date, size, and kind sorts order files within folders-first", () => {
  assert.deepEqual(names(sortFileTree(tree, { key: "modified", direction: "desc" })), ["Archive", "Receipts", "2 - plan.txt", "10 - notes.md", "budget.xlsx"]);
  assert.deepEqual(names(sortFileTree(tree, { key: "size", direction: "desc" })), ["Archive", "Receipts", "2 - plan.txt", "10 - notes.md", "budget.xlsx"]);
  assert.deepEqual(names(sortFileTree(tree, { key: "size", direction: "asc" })), ["Archive", "Receipts", "budget.xlsx", "10 - notes.md", "2 - plan.txt"]);
  assert.deepEqual(names(sortFileTree(tree, { key: "kind", direction: "asc" })), ["Archive", "Receipts", "10 - notes.md", "2 - plan.txt", "budget.xlsx"]);
  assert.deepEqual(names(sortFileTree(tree, { key: "modified", direction: "desc" })[1]!.children!), ["b.pdf", "a.pdf"], "children follow the same order");
});

test("entries without the chosen value sort by name after the ones that have it", () => {
  const mixed = [file("b.md", 1, "not a date"), file("a.md", 1, "2026-10-01T00:00:00Z"), file("c.md", 1, "2026-10-02T00:00:00Z")];
  assert.deepEqual(names(sortFileTree(mixed, { key: "modified", direction: "desc" })), ["c.md", "a.md", "b.md"]);
  assert.deepEqual(names(sortFileTree(mixed, { key: "modified", direction: "asc" })), ["a.md", "c.md", "b.md"]);
});

test("choosing the current option flips it; a new option starts in its natural direction", () => {
  assert.deepEqual(nextFileSort(defaultFileSort, "name"), { key: "name", direction: "desc" });
  assert.deepEqual(nextFileSort(defaultFileSort, "modified"), { key: "modified", direction: "desc" });
  assert.deepEqual(nextFileSort({ key: "modified", direction: "desc" }, "modified"), { key: "modified", direction: "asc" });
  assert.deepEqual(nextFileSort(defaultFileSort, "kind"), { key: "kind", direction: "asc" });
});

test("a stored sort is validated before use", () => {
  assert.deepEqual(normalizeFileSort({ key: "size", direction: "asc" }), { key: "size", direction: "asc" });
  assert.deepEqual(normalizeFileSort({ key: "color", direction: "asc" }), defaultFileSort);
  assert.deepEqual(normalizeFileSort({ key: "size", direction: "sideways" }), defaultFileSort);
  assert.deepEqual(normalizeFileSort("name"), defaultFileSort);
});
