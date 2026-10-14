import assert from "node:assert/strict";
import fsPromises, { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveWorkFoldAutomationProposalPath,
  scanWorkFoldAutomationProposals,
  workFoldAutomationProposalScanBounds,
} from "../src/local/automations/automation-proposal-scan.js";

const proposal = (name: string, trigger: unknown = { kind: "manual" }) => ({
  kind: "work-fold.automation-proposal",
  version: 2,
  name,
  createdBy: "assistant",
  createdAt: "2026-09-24T12:00:00.000Z",
  automation: {
    title: name,
    trigger,
    steps: [{ id: "hello", kind: "chat", workFolder: "space-0000000000000001", message: "Say hello." }],
  },
});

test("the proposal scan reads only top-level proposal files and reports problems by file name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-automation-proposal-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "a-valid.work-fold-automation.json"), JSON.stringify(proposal("Morning brief")), "utf8");
  await writeFile(join(root, "b-broken.work-fold-automation.json"), "{ not json", "utf8");
  await writeFile(join(root, "c-wrong.work-fold-automation.json"), JSON.stringify({ ...proposal("Wrong kind"), kind: "something-else" }), "utf8");
  await writeFile(
    join(root, "d-past.work-fold-automation.json"),
    JSON.stringify(proposal("Past", { kind: "at", at: "2020-01-01T00:00:00+00:00", ifMissed: "run" })),
    "utf8",
  );
  await writeFile(join(root, "e-big.work-fold-automation.json"), " ".repeat(workFoldAutomationProposalScanBounds.maxFileBytes + 1), "utf8");
  await symlink(join(root, "a-valid.work-fold-automation.json"), join(root, "f-link.work-fold-automation.json"));
  await writeFile(join(root, "notes.json"), JSON.stringify(proposal("Not a proposal file name")), "utf8");
  await writeFile(join(root, ".work-fold-automation.json"), JSON.stringify(proposal("Suffix only")), "utf8");
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "deep.work-fold-automation.json"), JSON.stringify(proposal("Nested")), "utf8");

  const scan = await scanWorkFoldAutomationProposals(root);
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.entries.map((entry) => entry.fileName), [
    "a-valid.work-fold-automation.json",
    "b-broken.work-fold-automation.json",
    "c-wrong.work-fold-automation.json",
    "d-past.work-fold-automation.json",
    "e-big.work-fold-automation.json",
    "f-link.work-fold-automation.json",
  ], "no recursion, no other names, and no bare suffix");

  const [valid, broken, wrong, past, big, link] = scan.entries;
  assert.equal(valid?.valid, true);
  if (valid?.valid) {
    assert.equal(valid.declaration.title, "Morning brief");
    assert.match(valid.declaration.id, /^automation-[a-f0-9]{16}$/, "the same content-derived id the CLI enables");
    assert.match(valid.digest, /^[a-f0-9]{64}$/);
    assert.equal(valid.path, join(root, "a-valid.work-fold-automation.json"));
  }
  assert.deepEqual(broken, { valid: false, path: join(root, "b-broken.work-fold-automation.json"), fileName: "b-broken.work-fold-automation.json", problem: "Not valid JSON." });
  assert.equal(wrong?.valid, false);
  assert.match(wrong?.valid === false ? wrong.problem : "", /kind must be work-fold\.automation-proposal/);
  assert.match(past?.valid === false ? past.problem : "", /in the future, and at most ten years ahead/);
  assert.deepEqual(big?.valid === false ? big.problem : "", `Larger than ${workFoldAutomationProposalScanBounds.maxFileBytes / (1024 * 1024)} MiB.`);
  assert.deepEqual(link?.valid === false ? link.problem : "", "Not a regular file.");
});

test("the proposal scan is bounded and a missing folder is empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-automation-proposal-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await scanWorkFoldAutomationProposals(join(root, "missing")), { entries: [], truncated: false });

  const total = workFoldAutomationProposalScanBounds.maxFiles + 3;
  for (let index = 0; index < total; index += 1) {
    await writeFile(join(root, `p-${String(index).padStart(3, "0")}.work-fold-automation.json`), "{}", "utf8");
  }
  const scan = await scanWorkFoldAutomationProposals(root);
  assert.equal(scan.entries.length, workFoldAutomationProposalScanBounds.maxFiles);
  assert.equal(scan.truncated, true);
});

test("turning on by path admits only a proposal file directly inside the folder", () => {
  const root = join(tmpdir(), "work-fold-agent");
  assert.equal(
    resolveWorkFoldAutomationProposalPath(root, join(root, "brief.work-fold-automation.json")),
    join(root, "brief.work-fold-automation.json"),
  );
  for (const path of [
    "brief.work-fold-automation.json",
    join(root, "nested", "brief.work-fold-automation.json"),
    join(root, "..", "brief.work-fold-automation.json"),
    join(root, "nested", "..", "..", "elsewhere", "brief.work-fold-automation.json"),
    join(tmpdir(), "elsewhere", "brief.work-fold-automation.json"),
    join(root, "AGENTS.md"),
    join(root, ".work-fold-automation.json"),
    "",
    42,
  ]) {
    assert.throws(() => resolveWorkFoldAutomationProposalPath(root, path), /absolute automation file path|Only automation files/, String(path));
  }
});

test("the proposal scan refuses a symlink substituted after the file metadata check", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-automation-proposal-race-"));
  const path = join(root, "pending.work-fold-automation.json");
  const outside = join(root, "outside.json");
  await writeFile(path, JSON.stringify(proposal("Original")));
  await writeFile(outside, JSON.stringify(proposal("Redirected")));
  const originalOpen = fsPromises.open;
  let substituted = false;
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    if (args[0] === path && !substituted) {
      substituted = true;
      await rename(path, join(root, "original.json"));
      await symlink(outside, path);
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });

  const scan = await scanWorkFoldAutomationProposals(root);
  assert.equal(substituted, true);
  assert.equal(scan.entries[0]?.valid, false, "the redirected declaration is never admitted");
});

test("the proposal scan bounds the descriptor read and refuses growth during it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-automation-proposal-growth-"));
  const path = join(root, "pending.work-fold-automation.json");
  const source = JSON.stringify(proposal("Original"));
  await writeFile(path, source);
  const originalOpen = fsPromises.open;
  let readBytes = 0;
  let grew = false;
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === path) {
      const originalRead = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        readBytes += length;
        if (!grew) {
          grew = true;
          await appendFile(path, " ".repeat(workFoldAutomationProposalScanBounds.maxFileBytes * 2));
        }
        return originalRead(buffer, offset, length, position);
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });

  const scan = await scanWorkFoldAutomationProposals(root);
  assert.equal(grew, true);
  assert.equal(readBytes, Buffer.byteLength(source), "growth cannot enlarge the admitted read");
  assert.equal(scan.entries[0]?.valid, false, "the changing document is never admitted");
});
