import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  LOCAL_VERIFICATION_STAGES,
  assertLocalReleaseVerification,
  assertVerifiedBuildOrder,
  cleanVerificationEnvironment,
  localVerificationPaths,
  readVerificationSource,
  runLocalReleaseVerification,
  withReleaseVerificationLock,
} from "../scripts/local-release-verification.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "work-fold-local-verification-"));
  for (const directory of ["node_modules", "services/bridge/node_modules"]) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  }
  let source = {
    sha: "a".repeat(40), tree: "b".repeat(40), sourceDigest: "c".repeat(64), buildFingerprint: "d".repeat(64),
    version: "0.4.36", nodeVersion: process.version, platform: "darwin", arch: "arm64",
  };
  const snapshot = async () => ({ ...source });
  const toolchain = async () => ({
    npmVersion: "11.16.0", npmCli: "/fake/npm.js", nodePath: process.execPath, browser: "/fake/chrome",
  });
  const commands: string[] = [];
  const runStage = async (stage: { id: string }, { logPath }: { logPath: string }) => {
    commands.push(stage.id);
    await mkdir(dirname(logPath), { recursive: true });
    await writeFile(logPath, `Verified ${stage.id}\n`);
  };
  return {
    root, commands, snapshot, toolchain, runStage,
    options: { snapshot, toolchain, runStage },
    changeSource: (change: Partial<typeof source>) => { source = { ...source, ...change }; },
    close: () => rm(root, { recursive: true, force: true }),
  };
}

async function readReceipt(root: string) {
  return JSON.parse(await readFile(localVerificationPaths(root).receipt, "utf8"));
}

async function writeReceipt(root: string, receipt: unknown) {
  await writeFile(localVerificationPaths(root).receipt, `${JSON.stringify(receipt)}\n`);
}

async function assertNoReceipt(root: string) {
  await assert.rejects(readFile(localVerificationPaths(root).receipt, "utf8"), { code: "ENOENT" });
}

test("local release verification records every required command and admits only complete success", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const receipt = await runLocalReleaseVerification(f.root, f.options);
  assert.equal(receipt.status, "success");
  assert.deepEqual(f.commands, LOCAL_VERIFICATION_STAGES.map((stage: { id: string }) => stage.id));
  assert.deepEqual(receipt.stages.map((stage: { id: string }) => stage.id), f.commands);
  for (const [index, stage] of receipt.stages.entries()) {
    assert.deepEqual(stage.args, LOCAL_VERIFICATION_STAGES[index].args);
    assert.equal(stage.exitCode, 0);
    assert.ok(stage.durationMs >= 0);
    assert.match(stage.log.sha256, /^[a-f0-9]{64}$/);
    assert.ok(stage.log.bytes > 0);
  }
  assert.deepEqual(await assertLocalReleaseVerification(f.root, f.options), receipt);
});

test("a successful receipt cannot authorize a different source commit, tree, bytes, or runtime", async (t) => {
  const cases = [
    { sha: "e".repeat(40) }, { tree: "e".repeat(40) }, { sourceDigest: "e".repeat(64) },
    { buildFingerprint: "e".repeat(64) }, { version: "0.4.37" }, { nodeVersion: "v24.99.0" },
    { arch: "x64" }, { platform: "linux" },
  ];
  for (const change of cases) {
    const f = await fixture();
    t.after(f.close);
    await runLocalReleaseVerification(f.root, f.options);
    f.changeSource(change);
    await assert.rejects(assertLocalReleaseVerification(f.root, f.options), undefined, JSON.stringify(change));
  }
});

test("dirty source and changed source during a stage cannot produce a usable receipt", async (t) => {
  const dirty = await fixture();
  t.after(dirty.close);
  await runLocalReleaseVerification(dirty.root, dirty.options);
  const snapshot = async () => { throw new Error("Working tree is dirty"); };
  await assert.rejects(assertLocalReleaseVerification(dirty.root, { ...dirty.options, snapshot }), /dirty/);
  await assert.rejects(runLocalReleaseVerification(dirty.root, { ...dirty.options, snapshot }), /dirty/);
  await assertNoReceipt(dirty.root);

  const changed = await fixture();
  t.after(changed.close);
  await assert.rejects(runLocalReleaseVerification(changed.root, {
    ...changed.options,
    runStage: async (...args: Parameters<typeof changed.runStage>) => {
      await changed.runStage(...args);
      changed.changeSource({ sourceDigest: "e".repeat(64) });
    },
  }));
  assert.equal(changed.commands.length, 1, "stop immediately when stage source changes");
  await assertNoReceipt(changed.root);
});

test("a failed rerun invalidates earlier success and never executes later stages", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await runLocalReleaseVerification(f.root, f.options);
  let calls = 0;
  await assert.rejects(runLocalReleaseVerification(f.root, {
    ...f.options,
    runStage: async (...args: Parameters<typeof f.runStage>) => {
      await f.runStage(...args);
      if (++calls === 2) throw new Error("Synthetic stage failure");
    },
  }), /Synthetic stage failure/);
  assert.equal(calls, 2);
  await assertNoReceipt(f.root);
  await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
});

test("missing, partial, reordered, non-successful, and changed-command receipts are rejected", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
  const complete = await runLocalReleaseVerification(f.root, f.options);
  const mutations = [
    (receipt: any) => { receipt.status = "running"; },
    (receipt: any) => { receipt.stages.pop(); },
    (receipt: any) => { receipt.stages.reverse(); },
    (receipt: any) => { receipt.stages[1].exitCode = 1; },
    (receipt: any) => { receipt.stages[1].args = ["run", "unrelated-command"]; },
    (receipt: any) => { receipt.stages[1].id = receipt.stages[0].id; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(complete);
    mutate(altered);
    await writeReceipt(f.root, altered);
    await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
  }
});

test("changing either installed dependency lock or any stage log invalidates local evidence", async (t) => {
  for (const dependency of ["node_modules/.package-lock.json", "services/bridge/node_modules/.package-lock.json"]) {
    const f = await fixture();
    t.after(f.close);
    await runLocalReleaseVerification(f.root, f.options);
    await writeFile(join(f.root, dependency), JSON.stringify({ lockfileVersion: 3, packages: { changed: true } }));
    await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
  }
  const f = await fixture();
  t.after(f.close);
  await runLocalReleaseVerification(f.root, f.options);
  const receipt = await readReceipt(f.root);
  const log = resolve(f.root, receipt.stages[0].log.path);
  const contents = await readFile(log, "utf8");
  await writeFile(log, `X${contents.slice(1)}`);
  await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
});

test("verification and publication are exclusive and only the lock owner may validate while held", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await runLocalReleaseVerification(f.root, f.options);
  await withReleaseVerificationLock(f.root, "publication", async (lockToken: unknown) => {
    await assertLocalReleaseVerification(f.root, { ...f.options, lockToken });
    await assert.rejects(assertLocalReleaseVerification(f.root, { ...f.options, lockToken: "not-the-owner" }));
    await assert.rejects(assertLocalReleaseVerification(f.root, f.options));
    await assert.rejects(withReleaseVerificationLock(f.root, "verification", async () => {}));
    await assert.rejects(runLocalReleaseVerification(f.root, f.options));
  });
  await assertLocalReleaseVerification(f.root, f.options);
  await assert.rejects(withReleaseVerificationLock(f.root, "verification", async () => {
    throw new Error("Synthetic interrupted operation");
  }), /Synthetic interrupted operation/);
  await withReleaseVerificationLock(f.root, "publication", async () => {});
});

test("release check environment cannot inherit test filters or a non-Mac Electron mode", () => {
  const supplied = {
    PATH: "/safe/bin", NODE_OPTIONS: "--test-only", npm_config_node_options: "--test-name-pattern=absent",
    NPM_CONFIG_NODE_OPTIONS: "--test-shard=1/8", NPM_CONFIG_SCRIPT_SHELL: "/usr/bin/true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_DRY_RUN: "true", NODE_ENV: "production",
    NODE_TEST_CONTEXT: "child-v8", ELECTRON_RUN_AS_NODE: "1",
    WORKFOLD_DESKTOP_RELEASE_PLATFORM: "win32", WORKFOLD_DESKTOP_RELEASE_ARCH: "x64",
  };
  const clean = cleanVerificationEnvironment(supplied);
  assert.equal(clean.PATH, `${dirname(process.execPath)}:${supplied.PATH}`);
  for (const name of ["NODE_OPTIONS", "NPM_CONFIG_NODE_OPTIONS", "NODE_TEST_CONTEXT", "ELECTRON_RUN_AS_NODE", "NODE_ENV", "NPM_CONFIG_SCRIPT_SHELL", "NPM_CONFIG_IGNORE_SCRIPTS", "NPM_CONFIG_DRY_RUN"]) {
    assert.ok(!clean[name], `${name} cannot change verification behavior`);
  }
  assert.equal(clean.WORKFOLD_DESKTOP_RELEASE_PLATFORM, "darwin");
  assert.equal(clean.WORKFOLD_DESKTOP_RELEASE_ARCH, "arm64");
  assert.equal(clean.npm_config_node_options, "--enable-source-maps", "a nonempty harmless option overrides npm user config");
  assert.equal(clean.npm_config_script_shell, "/bin/sh");
  assert.equal(clean.npm_config_ignore_scripts, "false");
  assert.equal(clean.npm_config_dry_run, "false");
  assert.equal(supplied.NODE_OPTIONS, "--test-only", "do not mutate the caller's environment");
});

test("npm user configuration cannot silently filter the verification suite", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const userConfig = join(f.root, "user.npmrc");
  await writeFile(userConfig, "node-options=--test-name-pattern=DOES_NOT_MATCH\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({
    name: "verification-environment-fixture", version: "1.0.0", scripts: { test: "node --test fixture.test.cjs" },
  }));
  await writeFile(join(f.root, "fixture.test.cjs"), `
const test = require("node:test");
test("verification fixture", () => { throw new Error("FIXTURE_WAS_EXECUTED"); });
`);
  const result = spawnSync("npm", ["--userconfig", userConfig, "--globalconfig", "/dev/null", "test"], {
    cwd: f.root, encoding: "utf8", timeout: 15_000, env: cleanVerificationEnvironment(),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, "the actual test failure must propagate despite the user's skip filter");
  assert.match(`${result.stdout}\n${result.stderr}`, /FIXTURE_WAS_EXECUTED/);
});

test("source snapshots require committed clean files and digest actual tracked bytes", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" }).trim();
  await writeFile(join(f.root, ".gitignore"), "node_modules/\nout/\n");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ version: "0.4.36" }));
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src", "fixture.txt"), "committed bytes\n");
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const clean = await readVerificationSource(f.root);
  assert.equal(clean.sha, git("rev-parse", "HEAD"));
  assert.equal(clean.tree, git("rev-parse", "HEAD^{tree}"));
  assert.match(clean.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(clean.buildFingerprint, /^[a-f0-9]{64}$/);
  await writeFile(join(f.root, "src", "fixture.txt"), "modified bytes\n");
  await assert.rejects(readVerificationSource(f.root), /clean|committed/);
  // A fresh receipt must not claim committed source when index flags hide
  // different working bytes from git status.
  git("update-index", "--assume-unchanged", "src/fixture.txt");
  await assert.rejects(readVerificationSource(f.root), /assume-unchanged|skip-worktree/);
  git("update-index", "--no-assume-unchanged", "src/fixture.txt");
  git("update-index", "--skip-worktree", "src/fixture.txt");
  await assert.rejects(readVerificationSource(f.root), /assume-unchanged|skip-worktree/);
});

test("a distribution must begin after and bind to the successful verification run", () => {
  const receipt = { runId: "verified-run", completedAt: "2026-09-26T10:00:00.000Z" };
  const state = { localVerificationRunId: receipt.runId, startedAt: "2026-09-26T10:00:01.000Z" };
  assert.doesNotThrow(() => assertVerifiedBuildOrder(state, receipt));
  assert.doesNotThrow(() => assertVerifiedBuildOrder({ ...state, startedAt: receipt.completedAt }, receipt));
  for (const changed of [
    { ...state, startedAt: "2026-09-26T09:59:59.999Z" },
    { ...state, startedAt: "not-a-date" },
    { ...state, localVerificationRunId: "previous-success" },
    { startedAt: state.startedAt },
  ]) {
    assert.throws(() => assertVerifiedBuildOrder(changed, receipt), /predates this local verification/);
  }
});
