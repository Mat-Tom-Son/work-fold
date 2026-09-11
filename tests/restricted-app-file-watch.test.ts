import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  observeRestrictedAppGrantRoot,
  RestrictedAppFileWatch,
  type RestrictedAppFileWatchLimits,
  type RestrictedAppFileWatchTarget,
} from "../src/local/agent/restricted-app-file-watch.js";
import { restrictedAppSubscriptionLimits } from "../src/shared/restricted-app-tasks.js";

const limits: RestrictedAppFileWatchLimits = { ...restrictedAppSubscriptionLimits };

async function space(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-file-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "exports"), { recursive: true });
  await writeFile(join(root, "exports", "first.csv"), "a,b\n");
  return root;
}

function directoryTarget(root = "exports"): RestrictedAppFileWatchTarget {
  return { grant: { id: "exports", declarationId: "exports", root, access: "read-write" }, target: "directory" };
}

test("a granted folder is observed as metadata only, with reserved trees and links invisible", async (t) => {
  const root = await space(t);
  await mkdir(join(root, "exports", ".work-fold"), { recursive: true });
  await writeFile(join(root, "exports", ".work-fold", "space.json"), "{}");
  await mkdir(join(root, "exports", ".pi"), { recursive: true });
  await writeFile(join(root, "exports", ".pi", "config.json"), "{}");
  await mkdir(join(root, "exports", ".workspace"), { recursive: true });
  await writeFile(join(root, "exports", ".workspace", "legacy.json"), "{}");
  await symlink(join(root, "exports", "first.csv"), join(root, "exports", "link.csv"));

  const snapshot = await observeRestrictedAppGrantRoot(root, directoryTarget(), limits);
  assert.deepEqual(Object.keys(snapshot.entries).sort(), ["first.csv"]);
  assert.equal(snapshot.truncated, false);
  // A stamp is device, inode, size and times — never a byte of the file.
  assert.match(snapshot.entries["first.csv"]!, /^\d+:\d+:\d+:\d+:\d+$/);
  assert.ok(!JSON.stringify(snapshot).includes("a,b"));
});

test("the first observation rebaselines silently; a create, a change and a delete each fire once", async (t) => {
  const root = await space(t);
  const watch = new RestrictedAppFileWatch();
  const observe = async (now: number) => watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), limits), now, limits);

  assert.equal(await observe(0), null, "a new watch has no backlog");
  assert.equal(await observe(1_000), null, "an unchanged root is quiet");

  await writeFile(join(root, "exports", "second.csv"), "c,d\n");
  assert.equal(await observe(2_000), null, "a change waits out its debounce");
  assert.deepEqual(await observe(4_000), { truncated: false });
  assert.equal(await observe(6_000), null, "one change is one hint");

  await writeFile(join(root, "exports", "second.csv"), "c,d,e\n");
  assert.equal(await observe(8_000), null);
  assert.deepEqual(await observe(10_000), { truncated: false });

  await rm(join(root, "exports", "second.csv"));
  assert.equal(await observe(12_000), null);
  assert.deepEqual(await observe(14_000), { truncated: false });
});

test("a flapping file stays quiet until it holds still, and the cooldown caps the rate", async (t) => {
  const root = await space(t);
  const watch = new RestrictedAppFileWatch();
  const observe = async (now: number) => watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), limits), now, limits);
  assert.equal(await observe(0), null);

  for (let step = 1; step <= 4; step += 1) {
    await writeFile(join(root, "exports", `flap-${step}.csv`), "x\n");
    assert.equal(await observe(step * 500), null, "each new shape restarts the debounce");
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(await observe(10_000), { truncated: false });

  await writeFile(join(root, "exports", "after.csv"), "y\n");
  assert.equal(await observe(10_100), null);
  assert.equal(await observe(10_600), null, "a second hint waits out the cooldown");
  assert.deepEqual(await observe(12_000), { truncated: false });
});

test("a bound reached truncates rather than failing, and change detection still works", async (t) => {
  const root = await space(t);
  for (let index = 0; index < 6; index += 1) await writeFile(join(root, "exports", `bulk-${index}.csv`), "x\n");
  const tight: RestrictedAppFileWatchLimits = { ...limits, fileMaxFiles: 3 };
  const snapshot = await observeRestrictedAppGrantRoot(root, directoryTarget(), tight);
  assert.equal(snapshot.truncated, true);
  assert.equal(Object.keys(snapshot.entries).length, 3);

  await mkdir(join(root, "exports", "a", "b", "c"), { recursive: true });
  await writeFile(join(root, "exports", "a", "b", "c", "deep.csv"), "x\n");
  const shallow = await observeRestrictedAppGrantRoot(root, directoryTarget(), { ...limits, fileMaxDepth: 1 });
  assert.equal(shallow.truncated, true);
  assert.ok(!Object.keys(shallow.entries).some((path) => path.includes("deep.csv")));

  const visited = await observeRestrictedAppGrantRoot(root, directoryTarget(), { ...limits, fileMaxVisitedEntries: 2 });
  assert.equal(visited.truncated, true);

  const watch = new RestrictedAppFileWatch();
  assert.equal(watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), tight), 0, tight), null);
  await writeFile(join(root, "exports", "bulk-0.csv"), "changed\n");
  assert.equal(watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), tight), 1_000, tight), null);
  assert.deepEqual(watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), tight), 3_000, tight), { truncated: true });
});

test("an exact-file grant watches that one path and nothing beside it", async (t) => {
  const root = await space(t);
  const target: RestrictedAppFileWatchTarget = {
    grant: { id: "ledger", declarationId: "ledger", root: "exports/first.csv", access: "read" },
    target: "file",
  };
  const watch = new RestrictedAppFileWatch();
  const observe = async (now: number) => watch.observe(await observeRestrictedAppGrantRoot(root, target, limits), now, limits);
  assert.equal(await observe(0), null);

  await writeFile(join(root, "exports", "neighbour.csv"), "z\n");
  assert.equal(await observe(2_000), null, "a sibling is not this grant's business");
  assert.equal(await observe(4_000), null);

  await writeFile(join(root, "exports", "first.csv"), "a,b,c\n");
  assert.equal(await observe(6_000), null);
  assert.deepEqual(await observe(8_000), { truncated: false });
});

test("a missing or moved root fails the watch, which then emits nothing until it rebaselines", async (t) => {
  const root = await space(t);
  const watch = new RestrictedAppFileWatch();
  assert.equal(watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), limits), 0, limits), null);

  await rm(join(root, "exports"), { recursive: true, force: true });
  await assert.rejects(observeRestrictedAppGrantRoot(root, directoryTarget(), limits));
  watch.fail(new Error("The granted folder is gone."));
  assert.equal(watch.baseline, undefined);
  assert.equal(watch.failure, "The granted folder is gone.");

  await mkdir(join(root, "exports"), { recursive: true });
  await writeFile(join(root, "exports", "fresh.csv"), "x\n");
  assert.equal(watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), limits), 20_000, limits), null,
    "the first observation after a failure is a baseline, not news");

  await assert.rejects(
    observeRestrictedAppGrantRoot(root, { grant: { id: "away", declarationId: "away", root: "../elsewhere", access: "read" }, target: "directory" }, limits),
    /inside its Space/,
  );
});

test("a suspend-and-wake cycle never delivers what changed while the machine slept", async (t) => {
  const root = await space(t);
  const watch = new RestrictedAppFileWatch();
  const observe = async (now: number) => watch.observe(await observeRestrictedAppGrantRoot(root, directoryTarget(), limits), now, limits);
  assert.equal(await observe(0), null);

  watch.reset();
  await writeFile(join(root, "exports", "asleep.csv"), "x\n");
  assert.equal(await observe(100_000), null, "the first observation after waking rebaselines");
  assert.equal(await observe(102_000), null);

  await writeFile(join(root, "exports", "awake.csv"), "y\n");
  assert.equal(await observe(104_000), null);
  assert.deepEqual(await observe(106_000), { truncated: false }, "a real change after waking still fires");
});
