import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
  parseWorkFoldCliActArgv,
  parseWorkFoldCliArgv,
  WorkFoldCliActReceipts,
  workFoldCliHelp,
} from "../src/local/cli/index.js";
import { createSpaceCheckpoint } from "../src/local/history.js";
import { startLocalApi } from "../src/local/server.js";
import { configureWorkFoldStateRoot, spaceHistoryRoot } from "../src/local/state-paths.js";

const actToken = "a".repeat(64);
const sessionToken = "history-review-test-session";
const firstText = "Heading\nPRIVATE_FIRST_CONTENT\nEnd\n";
const secondText = "Heading\nPRIVATE_SECOND_CONTENT\nEnd\n";
const currentText = "Heading\nPRIVATE_CURRENT_CONTENT\nEnd\n";

async function fixture(t: TestContext) {
  const sandbox = await mkdtemp(join(tmpdir(), "history-review-adapters-"));
  const stateRoot = join(sandbox, "state");
  const agentDir = join(sandbox, "agent");
  await mkdir(agentDir);
  const api = await startLocalApi({
    port: 0, stateBase: stateRoot, spaceBase: join(sandbox, "folders"), sessionToken, loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir }; } },
  });
  t.after(async () => {
    await api.close();
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  });
  const { space } = await api.actFacade.createSpace({ name: "Review Folder" });
  const { space: other } = await api.actFacade.createSpace({ name: "Other Folder" });
  const file = join(space.spaceRoot, "note.txt");
  await writeFile(file, firstText);
  await mkdir(join(space.spaceRoot, "child"));
  await writeFile(join(space.spaceRoot, "child", "private.txt"), "PRIVATE_NESTED_CONTENT");
  const first = await createSpaceCheckpoint(space.spaceRoot);
  await writeFile(file, secondText);
  const second = await createSpaceCheckpoint(space.spaceRoot);
  await writeFile(file, currentText);
  await writeFile(join(other.spaceRoot, "note.txt"), "PRIVATE_OTHER_CONTENT");
  const otherCheckpoint = await createSpaceCheckpoint(other.spaceRoot);
  const receipts = new WorkFoldCliActReceipts({ stateRoot });
  const request = (argv: string[], token = actToken) => createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd: sandbox, actToken: token });
  const execute = (value: ReturnType<typeof request>) => executeWorkFoldCliActRequest(value, {
    version: "test", getActFacade: () => ({ facade: api.actFacade, token: actToken }), receipts,
  });
  const fetchReview = (verb: "read" | "diff", params: Record<string, string>, options: { authenticated?: boolean; spaceId?: string } = {}) =>
    fetch(`${api.origin}/api/spaces/${options.spaceId ?? space.id}/history/${verb}?${new URLSearchParams(params)}`, {
      headers: options.authenticated === false ? {} : { "x-work-fold-session": sessionToken },
    });
  return { sandbox, api, space, other, first, second, otherCheckpoint, receipts, request, execute, fetchReview };
}

async function historySnapshot(root: string): Promise<Array<[string, string]>> {
  const base = spaceHistoryRoot(root);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name)).sort();
  return Promise.all(files.map(async (path): Promise<[string, string]> => [path, createHash("sha256").update(await readFile(path)).digest("hex")]));
}

test("History read/diff parse only in the act lane with an explicit Folder and exact selectors", () => {
  assert.deepEqual(parseWorkFoldCliActArgv(["history", "read", "--space", "folder", "--path", "note.txt", "--checkpoint", "cp-first", "--json"]), {
    name: "history.read", output: "json", space: "folder", path: "note.txt", checkpoint: "cp-first",
  });
  for (const to of [[], ["--to-checkpoint", "cp-second"]]) {
    assert.deepEqual(parseWorkFoldCliActArgv(["history", "diff", "--space", "folder", "--path", "note.txt", "--from-checkpoint", "cp-first", ...to]), {
      name: "history.diff", output: "human", space: "folder", path: "note.txt", fromCheckpoint: "cp-first",
      ...(to.length ? { toCheckpoint: "cp-second" } : {}),
    });
  }
  for (const verb of ["read", "diff"]) {
    const selector = verb === "read" ? "--checkpoint" : "--from-checkpoint";
    assert.throws(() => parseWorkFoldCliActArgv(["history", verb, "--path", "note.txt", selector, "cp-first"]), /explicit --space/);
    assert.throws(() => parseWorkFoldCliActArgv(["history", verb, "--space", "folder", "--path", "note.txt"]), /Provide --/);
    assert.throws(() => parseWorkFoldCliActArgv(["history", verb, "--space", "folder", selector, "cp-first"]), /--path/);
    assert.throws(() => parseWorkFoldCliActArgv(["history", verb, "--space", "folder", "--path", "a", "--path", "b", selector, "cp-first"]), /--path may be provided only once/);
    assert.throws(() => parseWorkFoldCliActArgv(["history", verb, "--space", "folder", "--path", "a", selector, "cp-first", "--parent-task", "task"]), /--parent-task/);
    assert.throws(() => parseWorkFoldCliArgv(["history", verb, "--space", "folder"]), /Unknown command/);
  }
  assert.throws(() => parseWorkFoldCliActArgv(["history", "read", "--space", "folder", "--path", "a", "--checkpoint", "cp", "--to-checkpoint", "other"]), /--to-checkpoint/);
  assert.throws(() => parseWorkFoldCliActArgv(["history", "diff", "--space", "folder", "--path", "a", "--from-checkpoint", "cp", "--checkpoint", "other"]), /--checkpoint/);
  assert.match(workFoldCliHelp("work-fold", "history"), /authenticated act lane/);
});

test("authenticated CLI History reads/diffs use the facade without changing files, and receipts exclude content", async (t) => {
  const setup = await fixture(t);
  const { space, first, second, request, execute, receipts } = setup;
  const baseline = await historySnapshot(space.spaceRoot);
  const readArgv = ["history", "read", "--space", space.id, "--path", "note.txt", "--checkpoint", first.checkpointId, "--json"];
  const unauthorized = await execute(request(readArgv, "b".repeat(64)));
  assert.notEqual(unauthorized.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(unauthorized), /PRIVATE_/);
  const acceptedRead = request(readArgv);
  const read = await execute(acceptedRead);
  assert.equal(read.exitCode, 0, read.stderr);
  const saved = JSON.parse(read.stdout).data;
  assert.equal(saved.space.id, space.id);
  assert.equal(saved.review.observation.text, firstText);
  assert.equal(saved.review.observation.checkpointId, first.checkpointId);
  assert.equal(saved.review.observation.hashVerified, true);
  const replayed = await execute(acceptedRead);
  assert.notEqual(replayed.exitCode, 0);
  assert.match(replayed.stderr, /already executed/);
  assert.doesNotMatch(replayed.stdout, /PRIVATE_/);

  const baseDiff = ["history", "diff", "--space", space.id, "--path", "note.txt", "--from-checkpoint", first.checkpointId];
  const savedDiff = await execute(request([...baseDiff, "--to-checkpoint", second.checkpointId, "--json"]));
  assert.equal(savedDiff.exitCode, 0, savedDiff.stderr);
  const comparison = JSON.parse(savedDiff.stdout).data.comparison;
  assert.equal(comparison.after.source, "checkpoint");
  assert.equal(comparison.after.checkpointId, second.checkpointId);
  assert.match(comparison.diff.text, /-PRIVATE_FIRST_CONTENT\n\+PRIVATE_SECOND_CONTENT/);
  assert.doesNotMatch(savedDiff.stdout, /PRIVATE_CURRENT_CONTENT/);
  const currentDiff = await execute(request([...baseDiff, "--json"]));
  assert.equal(currentDiff.exitCode, 0, currentDiff.stderr);
  const current = JSON.parse(currentDiff.stdout).data.comparison;
  assert.equal(current.after.source, "current");
  assert.ok(current.after.observedAt);
  assert.equal(current.after.checkpointId, undefined);
  assert.match(current.diff.text, /\+PRIVATE_CURRENT_CONTENT/);
  const humanRead = await execute(request(readArgv.filter((value) => value !== "--json")));
  assert.equal(humanRead.exitCode, 0, humanRead.stderr);
  assert.match(humanRead.stdout, /note.txt/);
  assert.match(humanRead.stdout, /PRIVATE_FIRST_CONTENT/);
  const humanDiff = await execute(request(baseDiff));
  assert.equal(humanDiff.exitCode, 0, humanDiff.stderr);
  assert.match(humanDiff.stdout, /modified/);
  assert.match(humanDiff.stdout, /\+PRIVATE_CURRENT_CONTENT/);

  assert.equal(await readFile(join(space.spaceRoot, "note.txt"), "utf8"), currentText);
  assert.deepEqual(await historySnapshot(space.spaceRoot), baseline, "review creates no checkpoint or content objects");
  const journal = await readFile(receipts.path, "utf8");
  assert.doesNotMatch(journal, /PRIVATE_|Heading|End|hashVerified|observedAt|\"text\"|\"diff\"/);
  const records = journal.trim().split("\n").map((line) => JSON.parse(line));
  const accepted = records.filter((record) => record.requestId === acceptedRead.id);
  assert.deepEqual(accepted.map((record) => record.outcome), ["accepted", "ok", "rejected"]);
  assert.equal(accepted[1].spaceId, space.id);
});

test("History API requires the renderer session and preserves selected checkpoint and current-file meaning", async (t) => {
  const { space, first, second, fetchReview } = await fixture(t);
  const baseline = await historySnapshot(space.spaceRoot);
  const params = { path: "note.txt", checkpointId: first.checkpointId };
  const unauthorized = await fetchReview("read", params, { authenticated: false });
  assert.equal(unauthorized.status, 401);
  assert.doesNotMatch(await unauthorized.text(), /PRIVATE_/);
  const read = await fetchReview("read", params);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).review.observation.text, firstText);
  const saved = await fetchReview("diff", { path: "note.txt", fromCheckpointId: first.checkpointId, toCheckpointId: second.checkpointId });
  assert.equal(saved.status, 200);
  const savedData = (await saved.json()).comparison;
  assert.equal(savedData.before.text, firstText);
  assert.equal(savedData.after.text, secondText);
  assert.equal(savedData.after.source, "checkpoint");
  const current = await fetchReview("diff", { path: "note.txt", fromCheckpointId: first.checkpointId });
  assert.equal(current.status, 200);
  const currentData = (await current.json()).comparison;
  assert.equal(currentData.after.source, "current");
  assert.equal(currentData.after.text, currentText);
  assert.equal(currentData.after.checkpointId, undefined);
  assert.equal(await readFile(join(space.spaceRoot, "note.txt"), "utf8"), currentText);
  assert.deepEqual(await historySnapshot(space.spaceRoot), baseline);
});

test("human History diff reports a bounded prefix as incomplete instead of implying a complete comparison", async (t) => {
  const { space, request, execute } = await fixture(t);
  const path = join(space.spaceRoot, "large-diff.txt");
  await writeFile(path, Array.from({ length: 700 }, (_, index) => `before ${index} ${"a".repeat(90)}\n`).join(""));
  const before = await createSpaceCheckpoint(space.spaceRoot);
  await writeFile(path, Array.from({ length: 700 }, (_, index) => `after ${index} ${"b".repeat(90)}\n`).join(""));
  const argv = ["history", "diff", "--space", space.id, "--path", "large-diff.txt", "--from-checkpoint", before.checkpointId];
  const json = await execute(request([...argv, "--json"]));
  assert.equal(json.exitCode, 0, json.stderr);
  const diff = JSON.parse(json.stdout).data.comparison.diff;
  assert.equal(diff.status, "limited");
  assert.equal(diff.reason, "output_limit");
  assert.equal(diff.truncated, true);
  assert.ok(diff.text, "this case must exercise a partial diff, not a refusal without text");
  const human = await execute(request(argv));
  assert.equal(human.exitCode, 0, human.stderr);
  assert.equal(/truncated|incomplete|output_limit/i.test(human.stdout), true, "human output must disclose the partial diff");
});

test("History API and CLI reject cross-Folder checkpoints, unsafe paths, nested ownership, and missing selectors", async (t) => {
  const { api, space, first, otherCheckpoint, request, execute, fetchReview } = await fixture(t);
  for (const params of [
    { path: "note.txt", checkpointId: otherCheckpoint.checkpointId },
    { path: "note.txt", checkpointId: "cp-does-not-exist" },
    { path: "note.txt", checkpointId: first.files[0]!.hashSha256 },
  ]) {
    const response = await fetchReview("read", params);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /PRIVATE_/);
    const cli = await execute(request(["history", "read", "--space", space.id, "--path", params.path, "--checkpoint", params.checkpointId, "--json"]));
    assert.notEqual(cli.exitCode, 0);
    assert.equal(JSON.parse(cli.stderr).error.code, "notFound");
    assert.doesNotMatch(JSON.stringify(cli), /PRIVATE_/);
  }
  for (const path of ["../outside.txt", ".work-fold/space.json", ".pi/settings.json"]) {
    const response = await fetchReview("read", { path, checkpointId: first.checkpointId });
    assert.equal(response.status, 400, await response.text());
  }
  for (const [verb, params] of [
    ["read", { path: "note.txt" }], ["read", { checkpointId: first.checkpointId }],
    ["diff", { path: "note.txt" }], ["diff", { fromCheckpointId: first.checkpointId }],
  ] as const) {
    assert.equal((await fetchReview(verb, params)).status, 400);
  }
  const wrongTarget = await fetchReview("diff", { path: "note.txt", fromCheckpointId: first.checkpointId, toCheckpointId: otherCheckpoint.checkpointId });
  assert.equal(wrongTarget.status, 404);
  assert.doesNotMatch(await wrongTarget.text(), /PRIVATE_/);
  await api.actFacade.registerSpace({ spaceRoot: join(space.spaceRoot, "child") });
  const nested = await fetchReview("read", { path: "child/private.txt", checkpointId: first.checkpointId });
  assert.equal(nested.status, 403);
  assert.doesNotMatch(await nested.text(), /PRIVATE_NESTED_CONTENT/);
  const nestedCli = await execute(request(["history", "read", "--space", space.id, "--path", "child/private.txt", "--checkpoint", first.checkpointId, "--json"]));
  assert.notEqual(nestedCli.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(nestedCli), /PRIVATE_NESTED_CONTENT/);
});
