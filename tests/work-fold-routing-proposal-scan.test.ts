import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveWorkFoldRoutingProposalPath,
  scanWorkFoldRoutingProposals,
  workFoldRoutingProposalScanBounds,
} from "../src/local/routings/routing-proposal-scan.js";

const proposal = (name: string, trigger: unknown = { kind: "manual" }) => ({
  kind: "work-fold.routing-proposal",
  version: 2,
  name,
  createdBy: "assistant",
  createdAt: "2026-09-24T12:00:00.000Z",
  routing: {
    title: name,
    trigger,
    steps: [{ id: "hello", kind: "chat", space: "space-0000000000000001", message: "Say hello." }],
  },
});

test("the proposal scan reads only top-level proposal files and reports problems by file name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-routing-proposal-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "a-valid.work-fold-routing.json"), JSON.stringify(proposal("Morning brief")), "utf8");
  await writeFile(join(root, "b-broken.work-fold-routing.json"), "{ not json", "utf8");
  await writeFile(join(root, "c-wrong.work-fold-routing.json"), JSON.stringify({ ...proposal("Wrong kind"), kind: "something-else" }), "utf8");
  await writeFile(
    join(root, "d-past.work-fold-routing.json"),
    JSON.stringify(proposal("Past", { kind: "at", at: "2020-01-01T00:00:00+00:00", ifMissed: "run" })),
    "utf8",
  );
  await writeFile(join(root, "e-big.work-fold-routing.json"), " ".repeat(workFoldRoutingProposalScanBounds.maxFileBytes + 1), "utf8");
  await symlink(join(root, "a-valid.work-fold-routing.json"), join(root, "f-link.work-fold-routing.json"));
  await writeFile(join(root, "notes.json"), JSON.stringify(proposal("Not a proposal file name")), "utf8");
  await writeFile(join(root, ".work-fold-routing.json"), JSON.stringify(proposal("Suffix only")), "utf8");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "deep.work-fold-routing.json"), JSON.stringify(proposal("Nested")), "utf8");

  const scan = await scanWorkFoldRoutingProposals(root);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.entries.map((entry) => entry.fileName), [
    "a-valid.work-fold-routing.json",
    "b-broken.work-fold-routing.json",
    "c-wrong.work-fold-routing.json",
    "d-past.work-fold-routing.json",
    "e-big.work-fold-routing.json",
    "f-link.work-fold-routing.json",
  ], "no recursion, no other names, and no bare suffix");

  const [valid, broken, wrong, past, big, link] = scan.entries;
  assert.equal(valid?.valid, true);
  if (valid?.valid) {
    assert.equal(valid.declaration.title, "Morning brief");
    assert.match(valid.declaration.id, /^routing-[a-f0-9]{16}$/, "the same content-derived id the CLI enables");
    assert.match(valid.digest, /^[a-f0-9]{64}$/);
    assert.equal(valid.path, join(root, "a-valid.work-fold-routing.json"));
  }
  assert.deepEqual(broken, { valid: false, path: join(root, "b-broken.work-fold-routing.json"), fileName: "b-broken.work-fold-routing.json", problem: "Not valid JSON." });
  assert.equal(wrong?.valid, false);
  assert.match(wrong?.valid === false ? wrong.problem : "", /kind must be work-fold\.routing-proposal/);
  assert.match(past?.valid === false ? past.problem : "", /between 1 minute and 366 days/);
  assert.deepEqual(big?.valid === false ? big.problem : "", "Larger than 256 KiB.");
  assert.deepEqual(link?.valid === false ? link.problem : "", "Not a regular file.");
});

test("the proposal scan is bounded and a missing folder is empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-routing-proposal-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanWorkFoldRoutingProposals(join(root, "missing")), { entries: [], truncated: false });

  const total = workFoldRoutingProposalScanBounds.maxFiles + 3;
  for (let index = 0; index < total; index += 1) {
    await writeFile(join(root, `p-${String(index).padStart(3, "0")}.work-fold-routing.json`), "{}", "utf8");
  }
  const scan = await scanWorkFoldRoutingProposals(root);
  assert.equal(scan.entries.length, workFoldRoutingProposalScanBounds.maxFiles);
  assert.equal(scan.truncated, true);
});

test("turning on by path admits only a proposal file directly inside the folder", () => {
  const root = join(tmpdir(), "work-fold-management");
  assert.equal(
    resolveWorkFoldRoutingProposalPath(root, join(root, "brief.work-fold-routing.json")),
    join(root, "brief.work-fold-routing.json"),
  );
  for (const path of [
    "brief.work-fold-routing.json",
    join(root, "nested", "brief.work-fold-routing.json"),
    join(root, "..", "brief.work-fold-routing.json"),
    join(root, "nested", "..", "..", "elsewhere", "brief.work-fold-routing.json"),
    join(tmpdir(), "elsewhere", "brief.work-fold-routing.json"),
    join(root, "AGENTS.md"),
    join(root, ".work-fold-routing.json"),
    "",
    42,
  ]) {
    assert.throws(() => resolveWorkFoldRoutingProposalPath(root, path), /absolute automation file path|Only automation files/, String(path));
  }
});
