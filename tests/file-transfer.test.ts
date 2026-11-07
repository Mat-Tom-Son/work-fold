import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import { compressInto, copyInto, finderCopyName, moveInto } from "../src/local/file-transfer.js";

async function folder(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "file-transfer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("copies are named as Finder names them, and nothing is ever replaced", async (t) => {
  assert.equal(finderCopyName("report.pdf", 1), "report copy.pdf");
  assert.equal(finderCopyName("report.pdf", 2), "report copy 2.pdf");
  assert.equal(finderCopyName("Photos", 1), "Photos copy");
  assert.equal(finderCopyName(".env", 1), ".env copy");
  const root = await folder(t);
  await mkdir(join(root, "A"));
  await mkdir(join(root, "B"));
  await writeFile(join(root, "A", "notes.txt"), "a");
  await writeFile(join(root, "B", "notes.txt"), "b");
  const pasted = await copyInto(join(root, "A", "notes.txt"), join(root, "B"));
  assert.equal(pasted, join(root, "B", "notes copy.txt"));
  assert.equal(await readFile(join(root, "B", "notes.txt"), "utf8"), "b", "the file already there stays");
  const duplicate = await copyInto(join(root, "A", "notes.txt"), join(root, "A"), { duplicate: true });
  assert.equal(duplicate, join(root, "A", "notes copy.txt"));
  await assert.rejects(copyInto(join(root, "A"), join(root, "A")), /into itself/);
});

test("a copied folder leaves a work-folder's identity behind, and a move lands beside what is there", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Trip", ".work-fold"), { recursive: true });
  await writeFile(join(root, "Trip", ".work-fold", "work-folder.json"), "{}");
  await writeFile(join(root, "Trip", "plan.md"), "plan");
  await mkdir(join(root, "Archive"));
  const copied = await copyInto(join(root, "Trip"), join(root, "Archive"));
  assert.ok(existsSync(join(copied, "plan.md")));
  assert.ok(!existsSync(join(copied, ".work-fold")), "the copy is not the same work-folder");
  await writeFile(join(root, "plan.md"), "loose");
  await writeFile(join(root, "Archive", "plan.md"), "kept");
  const moved = await moveInto(join(root, "plan.md"), join(root, "Archive"));
  assert.equal(moved, join(root, "Archive", "plan copy.md"));
  assert.ok(!existsSync(join(root, "plan.md")));
});

test("Compress makes name.zip for one item and Archive.zip for several", async (t) => {
  const root = await folder(t);
  await mkdir(join(root, "Quotes", ".work-fold"), { recursive: true });
  await writeFile(join(root, "Quotes", "a.txt"), "a");
  await writeFile(join(root, "b.txt"), "b");
  const single = await compressInto([join(root, "Quotes")], root);
  assert.equal(single, join(root, "Quotes.zip"));
  const names = Object.keys((await JSZip.loadAsync(await readFile(single))).files).sort();
  assert.deepEqual(names, ["Quotes/", "Quotes/a.txt"]);
  const several = await compressInto([join(root, "Quotes"), join(root, "b.txt")], root);
  assert.equal(several, join(root, "Archive.zip"));
  assert.equal(await compressInto([join(root, "b.txt")], root), join(root, "b.txt.zip"));
});

test("the transfer route reads its target as a place and a path inside it", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/local/server.ts", import.meta.url), "utf8"));
  const body = source.slice(source.indexOf("export async function transferFileEntries"));
  assert.match(body, /transferPlace\(targetRecord\?\.place\)/);
});
