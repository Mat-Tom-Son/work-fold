import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseTestShard, selectTestFiles } from "../scripts/test-selection.mjs";

test("the default test selection includes every file without changing its input", () => {
  const files = ["z.test.ts", "a.test.ts", "middle.test.ts"];
  assert.equal(parseTestShard([]), null);
  assert.deepEqual(selectTestFiles(files, parseTestShard([])), ["a.test.ts", "middle.test.ts", "z.test.ts"]);
  assert.deepEqual(files, ["z.test.ts", "a.test.ts", "middle.test.ts"]);
  assert.deepEqual(selectTestFiles(files, parseTestShard(["--shard=1/1"])), selectTestFiles(files, null));
});

test("four shards cover the actual application suite exactly once regardless of discovery order", async () => {
  const entries = await readdir(new URL("../tests/", import.meta.url), { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts")).map((entry) => entry.name);
  const shards = [1, 2, 3, 4].map((index) => {
    const shard = parseTestShard([`--shard=${index}/4`]);
    const selected = selectTestFiles(files, shard);
    assert.deepEqual(selected, selectTestFiles([...files].reverse(), shard));
    assert.ok(selected.length > 0);
    return selected;
  });
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.ok(Math.max(...shards.map((files) => files.length)) - Math.min(...shards.map((files) => files.length)) <= 1);
});

test("invalid or ambiguous shard arguments never silently run a different test set", () => {
  for (const args of [
    [""], ["--shard"], ["--shard="], ["--shard=0/4"], ["--shard=1/0"], ["--shard=5/4"],
    ["--shard=-1/4"], ["--shard=1.5/4"], ["--shard=1/4/2"], ["--shard=01/4"],
    ["--shard=1/9007199254740992"], ["--shard=9007199254740992/9007199254740993"],
    ["--shard=1/4\n"], ["--shard=1/4", "--shard=2/4"], ["--shard=1/4", "--unexpected"], ["tests/example.test.ts"],
  ]) {
    assert.throws(() => parseTestShard(args), /Invalid test (?:arguments|shard)/, JSON.stringify(args));
  }
  assert.throws(() => selectTestFiles(["only.test.ts"], parseTestShard(["--shard=2/4"])), /shard 2\/4 is empty/);
});

test("the npm test entrypoint rejects invalid and empty shards before launching any suites", () => {
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  for (const arg of ["--shard=", "--shard=5/4", "--shard=9007199254740991/9007199254740991"]) {
    const result = spawnSync(process.execPath, [runner, arg], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${arg}: ${result.stderr}`);
    assert.match(result.stderr, /Invalid test|is empty/);
    assert.doesNotMatch(result.stdout, /Application test shard|TAP version|Subtest/);
  }
});
