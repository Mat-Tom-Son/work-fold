import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants, createWriteStream, existsSync } from "node:fs";
import { access, lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { finished } from "node:stream/promises";
import { computeReleaseFingerprint } from "./mac-release-state.mjs";

export const LOCAL_VERIFICATION_STAGES = Object.freeze([
  { id: "dependencies", args: ["ci", "--ignore-scripts=false", "--dry-run=false", "--include=dev"] },
  { id: "bridge-dependencies", args: ["ci", "--prefix", "services/bridge", "--ignore-scripts=false", "--dry-run=false", "--include=dev"] },
  { id: "check", args: ["run", "check"] },
  { id: "test", args: ["test"] },
  { id: "bridge-test", args: ["test", "--prefix", "services/bridge"] },
  { id: "desktop", args: ["run", "desktop:prepare"] },
]);

export function localVerificationPaths(rootDir) {
  const directory = join(rootDir, "out", "release-checks");
  return { directory, receipt: join(directory, "local-verification.json"), lock: join(directory, "release-work.lock") };
}

// Shared by checks, distribution builds, and publication: npm ci and prepare
// must never rewrite dependencies or compiled output while packaging uses them.
export async function withReleaseVerificationLock(rootDir, kind, action) {
  const { directory, lock } = localVerificationPaths(rootDir);
  await mkdir(directory, { recursive: true });
  try { await mkdir(lock); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Release work is already locked at ${lock}. Wait for it to finish; after an interrupted process, confirm it has stopped before removing this lock directory.`);
  }
  const token = randomUUID();
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token, kind, pid: process.pid, startedAt: new Date().toISOString() }));
    return await action(token);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export function cleanVerificationEnvironment(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (["NODE_OPTIONS", "NODE_TEST_CONTEXT", "ELECTRON_RUN_AS_NODE", "NODE_ENV"].includes(key)
      || /^npm_config_(node_options|ignore_scripts|dry_run|script_shell|omit|production)$/i.test(key)) delete env[key];
  }
  return { ...env, PATH: `${dirname(process.execPath)}:${env.PATH ?? ""}`, CI: "1",
    npm_config_node_options: "--enable-source-maps", npm_config_script_shell: "/bin/sh", npm_config_ignore_scripts: "false", npm_config_dry_run: "false",
    WORKFOLD_DESKTOP_RELEASE_PLATFORM: "darwin", WORKFOLD_DESKTOP_RELEASE_ARCH: "arm64", WORKFOLD_MAC_RELEASE_BUILD: "0" };
}

export async function readToolchain(rootDir) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !process.version.startsWith("v24.")) {
    throw new Error("Local release verification requires an Apple-silicon Mac running Node 24.");
  }
  const npmCli = await realpath(process.env.npm_execpath || execFileSync("which", ["npm"], { encoding: "utf8" }).trim());
  const env = cleanVerificationEnvironment();
  const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], { cwd: rootDir, env, encoding: "utf8" }).trim();
  const [major, minor] = npmVersion.split(".").map(Number);
  if (!(major > 11 || (major === 11 && minor >= 16))) throw new Error("Local release verification requires npm 11.16.0 or newer.");
  const browser = process.env.WORKFOLD_CSS_BROWSER || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  await access(browser, constants.X_OK).catch(() => { throw new Error("Real CSS tests require Chrome. Install Chrome or set WORKFOLD_CSS_BROWSER to a Chromium executable."); });
  execFileSync(browser, ["--version"], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return { npmVersion, npmCli, nodePath: process.execPath, browser };
}

export async function readVerificationSource(rootDir) {
  const git = (...args) => execFileSync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const clean = () => {
    if (git("-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--untracked-files=all").trim()) {
      throw new Error("Local verification requires clean, committed source. Commit changes before recording release evidence.");
    }
  };
  clean();
  if (git("ls-files", "-v", "-z").split("\0").some(entry => /^[a-zS] /.test(entry))) {
    throw new Error("Release verification cannot use assume-unchanged or skip-worktree files; clear those Git index flags first.");
  }
  const sha = git("rev-parse", "HEAD").trim();
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const hash = createHash("sha256");
  for (const path of git("ls-files", "-z").split("\0").filter(Boolean).sort()) {
    const absolute = join(rootDir, path);
    const info = await lstat(absolute);
    hash.update(`${path}\0${info.mode & 0o777}\0`);
    hash.update(info.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
    hash.update("\0");
  }
  const { version, productName } = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const source = { sha, tree, sourceDigest: hash.digest("hex"), version, nodeVersion: process.version, platform: process.platform, arch: process.arch };
  source.buildFingerprint = await computeReleaseFingerprint(rootDir, { productName, version, arch: process.arch, mode: "local-verification", nodeVersion: process.version });
  clean();
  if (git("rev-parse", "HEAD").trim() !== sha) throw new Error("Source changed while reading verification inputs.");
  return source;
}

export async function runLocalReleaseVerification(rootDir, { snapshot = readVerificationSource, runStage = defaultRunStage, toolchain = readToolchain } = {}) {
  return withReleaseVerificationLock(rootDir, "local verification", async () => {
    const paths = localVerificationPaths(rootDir);
    // Invalidate first, including failed preflight and interrupted reruns.
    await rm(paths.receipt, { force: true });
    const source = await snapshot(rootDir);
    const runtime = await toolchain(rootDir);
    const runId = randomUUID();
    const logDirectory = join(paths.directory, runId);
    await mkdir(logDirectory);
    const receipt = { schemaVersion: 1, status: "running", runId, source, toolchain: runtime, startedAt: new Date().toISOString(), stages: [] };
    const env = { ...cleanVerificationEnvironment(), WORKFOLD_CSS_BROWSER: runtime.browser };
    for (const stage of LOCAL_VERIFICATION_STAGES) {
      same(source, await snapshot(rootDir), "Source changed during local verification");
      const logPath = join(logDirectory, `${stage.id}.log`);
      console.log(`[local release check] ${stage.id}: npm ${stage.args.join(" ")}`);
      const started = Date.now();
      await runStage(stage, { rootDir, logPath, env, toolchain: runtime });
      same(source, await snapshot(rootDir), "Source changed during local verification");
      receipt.stages.push({ id: stage.id, args: stage.args, exitCode: 0, durationMs: Date.now() - started, log: await fileReceipt(rootDir, logPath) });
    }
    receipt.dependencies = await dependencyReceipts(rootDir);
    receipt.completedAt = new Date().toISOString();
    receipt.status = "success";
    const temporary = `${paths.receipt}.${runId}.tmp`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    await rename(temporary, paths.receipt);
    return receipt;
  });
}

export async function assertLocalReleaseVerification(rootDir, { snapshot = readVerificationSource, toolchain = readToolchain, lockToken } = {}) {
  const paths = localVerificationPaths(rootDir);
  if (existsSync(paths.lock)) {
    const owner = JSON.parse(await readFile(join(paths.lock, "owner.json"), "utf8"));
    if (!lockToken || owner.token !== lockToken) throw new Error("Release work is in progress; saved verification cannot be consumed concurrently.");
  }
  const info = await lstat(paths.receipt).catch(() => null);
  if (!info?.isFile() || info.size > 1024 * 1024) throw new Error("No completed local release verification. Run npm run desktop:release:mac:check.");
  const receipt = JSON.parse(await readFile(paths.receipt, "utf8"));
  if (receipt.schemaVersion !== 1 || receipt.status !== "success" || !/^[a-f0-9-]{36}$/.test(receipt.runId ?? "")
    || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt) || !Array.isArray(receipt.stages)
    || receipt.stages.length !== LOCAL_VERIFICATION_STAGES.length) throw new Error("Local verification receipt is incomplete or malformed.");
  same(receipt.source, await snapshot(rootDir), "Local verification belongs to different source or runtime");
  same(receipt.toolchain, await toolchain(rootDir), "Local verification used a different toolchain");
  same(receipt.dependencies, await dependencyReceipts(rootDir), "Installed dependencies changed after verification");
  for (const [index, stage] of LOCAL_VERIFICATION_STAGES.entries()) {
    const saved = receipt.stages[index];
    if (saved.id !== stage.id || saved.exitCode !== 0 || !Number.isFinite(saved.durationMs) || saved.durationMs < 0) throw new Error("Local verification has a failed or missing stage.");
    same(saved.args, stage.args, "Local verification stage command does not match");
    const logPath = join(paths.directory, receipt.runId, `${stage.id}.log`);
    same(saved.log, await fileReceipt(rootDir, logPath), "Local verification log changed");
  }
  return receipt;
}

export function assertVerifiedBuildOrder(state, receipt) {
  if (state.localVerificationRunId !== receipt.runId || !Number.isFinite(Date.parse(state.startedAt))
    || Date.parse(state.startedAt) < Date.parse(receipt.completedAt)) {
    throw new Error("The signed build predates this local verification. Build a fresh distribution candidate from the verified dependencies.");
  }
}

async function dependencyReceipts(rootDir) {
  return Promise.all(["node_modules/.package-lock.json", "services/bridge/node_modules/.package-lock.json"].map(path => fileReceipt(rootDir, join(rootDir, path))));
}

async function fileReceipt(rootDir, path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Verification evidence is not a regular file: ${path}`);
  const bytes = await readFile(path);
  return { path: relative(rootDir, path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function same(expected, actual, message) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`${message}. Run npm run desktop:release:mac:check again.`);
}

async function defaultRunStage(stage, { rootDir, logPath, env, toolchain }) {
  const output = createWriteStream(logPath, { flags: "wx" });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [toolchain.npmCli, ...stage.args], { cwd: rootDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let outputError;
      const stopGroup = () => {
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      };
      child.stdout.on("data", data => { process.stdout.write(data); output.write(data); });
      child.stderr.on("data", data => { process.stderr.write(data); output.write(data); });
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (outputError || code !== 0) {
          stopGroup();
          reject(outputError || new Error(`${stage.id} failed (${signal || code}); see ${logPath}.`));
        } else resolve();
      });
      // Keep the work lock until the failed npm process has actually exited.
      output.on("error", error => { outputError = error; stopGroup(); });
    });
  } finally { output.end(); await finished(output); }
}
