import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultAgentSdkDir } from "../src/local/agent/agent-data-dir.js";
import { parseTestArguments, parseTestShard, selectRequestedTestFiles, selectTestFiles } from "../scripts/test-selection.mjs";

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

test("a focused run names suite files and never mixes them with a shard", () => {
  assert.deepEqual(parseTestArguments([]), { shard: null, files: null });
  assert.deepEqual(parseTestArguments(["--shard=2/4"]), { shard: { index: 2, count: 4 }, files: null });
  assert.deepEqual(parseTestArguments(["tests/a.test.ts", "tests/b.test.ts"]), { shard: null, files: ["tests/a.test.ts", "tests/b.test.ts"] });
  for (const args of [["tests/a.test.ts", "--shard=1/4"], ["--shard=1/4", "tests/a.test.ts"], ["tests/a.ts"], ["-tests/a.test.ts"]]) {
    assert.throws(() => parseTestArguments(args), /Invalid test arguments/, JSON.stringify(args));
  }

  const root = resolve("/repo");
  const suite = [join(root, "tests", "a.test.ts"), join(root, "tests", "b.test.ts")];
  assert.deepEqual(
    selectRequestedTestFiles(suite, ["tests/b.test.ts", join(root, "tests", "a.test.ts"), "tests/b.test.ts"], root),
    [suite[1], suite[0]],
  );
  for (const missing of ["tests/missing.test.ts", "tests/fixtures/a.test.ts", "a.test.ts"]) {
    assert.throws(() => selectRequestedTestFiles(suite, [missing], root), /Unknown test file/, missing);
  }
});

test("the npm test entrypoint rejects invalid and empty shards before launching any suites", () => {
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  for (const arg of ["--shard=", "--shard=5/4", "--shard=9007199254740991/9007199254740991", "tests/does-not-exist.test.ts"]) {
    const result = spawnSync(process.execPath, [runner, arg], { encoding: "utf8", timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `${arg}: ${result.stderr}`);
    assert.match(result.stderr, /Invalid test|is empty|Unknown test file/);
    assert.doesNotMatch(result.stdout, /Application test shard|TAP version|Subtest/);
  }
});

test("the suite runs with a temporary Pi folder, never the developer's real one", () => {
  // scripts/run-tests.mjs provides this folder. A file run outside the runner
  // would read and write the real ~/.pi, so this fails there on purpose.
  const isolated = process.env.PI_CODING_AGENT_DIR;
  assert.ok(isolated, "Run tests through npm test (npm test -- tests/<name>.test.ts for one file), which isolates Pi.");
  assert.equal(relative(tmpdir(), isolated).startsWith(".."), false, `${isolated} is a temporary folder`);
  const realPi = join(homedir(), ".pi");
  assert.equal(isolated === realPi || isolated.startsWith(`${realPi}${sep}`), false);
  assert.equal(getAgentDir(), isolated);
  assert.equal(defaultAgentSdkDir(), isolated);
  assert.equal(process.env.WORKFOLD_AGENT_DIR, undefined, "a developer's own work-fold agent override cannot reach tests");
  assert.ok(process.env.WORKFOLD_TEST_REAL_PI_DIRS?.split(delimiter).includes(realPi));
});

test("the real-Pi guard records changes beneath protected folders and nothing else", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-real-pi-guard-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const realPi = join(sandbox, "real-pi");
  const log = join(sandbox, "writes.jsonl");
  const guard = fileURLToPath(new URL("../scripts/test-real-pi-guard.mjs", import.meta.url));
  const script = `
    import fs from "node:fs";
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const [realPi, elsewhere] = process.argv.slice(1);
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(join(realPi, "agent", "sessions", "work-fold", "space-1"), { recursive: true });
    await writeFile(join(realPi, "agent", "settings.json"), "{}");
    await mkdir(join(realPi, "agent", "auth.json.lock"));
    fs.closeSync(fs.openSync(join(realPi, "agent", "settings.json"), "r"));
    fs.readFileSync(join(realPi, "agent", "settings.json"), "utf8");
    fs.renameSync(join(realPi, "agent", "settings.json"), join(elsewhere, "moved.json"));
    fs.writeFileSync(join(elsewhere, "note.txt"), "fine");
  `;
  const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "--eval", script, realPi, join(sandbox, "elsewhere")], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, WORKFOLD_TEST_REAL_PI_DIRS: realPi, WORKFOLD_TEST_REAL_PI_WRITE_LOG: log },
  });
  assert.equal(result.status, 0, result.stderr);
  const writes = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { operation: string; path: string });
  assert.deepEqual(writes.map(({ operation, path }) => [operation, relative(sandbox, path)]), [
    ["mkdirSync", join("real-pi", "agent", "sessions", "work-fold", "space-1")],
    ["writeFile", join("real-pi", "agent", "settings.json")],
    ["mkdir", join("real-pi", "agent", "auth.json.lock")],
    ["renameSync", join("real-pi", "agent", "settings.json")],
  ]);
});
