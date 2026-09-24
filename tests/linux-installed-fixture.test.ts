import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The release harness is executable ESM, separate from the app.
import { prepareFixture } from "../scripts/linux-installed-smoke.mjs";

test("retained Linux fixtures refuse foreign, incomplete, missing or symlinked profiles", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workfold-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "fixture");
  const record = await prepareFixture(fixture, "seed");
  assert.equal(record.complete, false);
  await assert.rejects(prepareFixture(fixture, "seed"), /empty disposable/);
  await assert.rejects(prepareFixture(fixture, "verify"), /did not finish/);
  await assert.rejects(prepareFixture(join(root, "missing"), "verify"), /missing/);
  const foreign = join(root, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "precious"), "keep");
  await assert.rejects(prepareFixture(foreign, "seed"), /empty disposable/);
  assert.equal(await readFile(join(foreign, "precious"), "utf8"), "keep");
  if (process.platform !== "win32") {
    await symlink(fixture, join(root, "alias"));
    await assert.rejects(prepareFixture(join(root, "alias"), "seed"), /symlink/);
  }
  record.complete = true;
  await writeFile(join(fixture, "fixture.json"), JSON.stringify(record));
  await assert.rejects(prepareFixture(fixture, "verify"), /ENOENT/);
  await mkdir(join(fixture, "state"));
  assert.equal((await prepareFixture(fixture, "verify")).nonce, record.nonce);
});
