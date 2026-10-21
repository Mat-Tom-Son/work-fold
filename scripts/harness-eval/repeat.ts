/** Paid, repeated first-attempt trials against a separately frozen evaluation plan. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { seedAutonomousCase } from "./fixtures.js";
import { aggregateFrozenTrials, frozenCases, frozenContexts, frozenModels, frozenTrials, sha256, stableJson } from "./frozen.js";

const exec = promisify(execFile);
const arg = (key: string, fallback?: string): string => { const i = process.argv.indexOf(key); const value = i < 0 ? fallback : process.argv[i + 1]; if (!value) throw new Error(`${key} is required`); return value; };
const evaluationFiles = ["scripts/harness-eval/fixtures.ts", "scripts/harness-eval/assertions.ts", "scripts/harness-eval/autonomous.ts", "scripts/harness-eval/frozen.ts", "scripts/harness-eval/repeat.ts", "scripts/helper-eval/host.ts", "scripts/work-fold-drive.ts"];
async function source() { return { sha: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(), tree: (await exec("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim(), dirty: (await exec("git", ["status", "--porcelain"])).stdout.trim() }; }
async function hashes(paths: string[]) { return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(path))]))); }
async function fixtureHashes(folder: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(join(folder, prefix), { withFileTypes: true })) {
    const path = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, await fixtureHashes(folder, path)); else result[path] = sha256(await readFile(join(folder, path)));
  }
  return result;
}

if (process.argv.includes("--create-plan")) {
  const path = resolve(arg("--create-plan"));
  assert.ok(!existsSync(path), "A frozen plan is immutable; choose a new filename");
  const revision = await source(); assert.equal(revision.dirty, "", "Commit the evaluator before freezing it");
  await mkdir(dirname(path), { recursive: true });
  const catalogPath = join(dirname(path), "model-catalog.json"); assert.ok(!existsSync(catalogPath), "Choose a fresh plan directory");
  await copyFile(join(homedir(), "Library", "Application Support", "work-fold", "model-catalogs", "openrouter.json"), catalogPath);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const cases: Record<string, unknown> = {};
  for (const scenario of frozenCases) {
    const folder = await mkdtemp(join(tmpdir(), "work-fold-freeze-fixture-"));
    try { const spec = await seedAutonomousCase(scenario, folder); const sourceHashes = await fixtureHashes(folder); cases[scenario] = { ...spec, sourceHashes, digest: sha256(stableJson({ ...spec, sourceHashes })) }; }
    finally { await rm(folder, { recursive: true, force: true }); }
  }
  const plan = { version: 1, createdAt: new Date().toISOString(), evaluatorSource: revision, evaluationFiles: await hashes(evaluationFiles),
    lockSha256: sha256(await readFile("package-lock.json")), nodeVersion: process.version, thinking: "high", concurrency: 3,
    catalogPath, catalogSha256: sha256(await readFile(catalogPath)),
    models: frozenModels.map(model => ({ model, contextWindow: catalog.models.find((item: any) => item.id === model.replace(/^openrouter\//, ""))?.contextWindow })),
    contexts: frozenContexts, cases, trials: frozenTrials(Number(arg("--repetitions", "3"))),
    grading: "Independent artifact/source/request checks; repeated unchanged reads are a proxy, not an assertion of waste. Every first attempt is retained. No tool choice is prescribed.",
  };
  assert.ok(plan.models.every(model => model.contextWindow > 18_000), "Both selected models need a known catalog window");
  await writeFile(path, JSON.stringify(plan, null, 2), { flag: "wx" }); console.log(JSON.stringify({ plan: path, sha256: sha256(await readFile(path)), trials: plan.trials.length }));
} else {
  const planPath = resolve(arg("--plan")); const planBytes = await readFile(planPath); const plan = JSON.parse(planBytes.toString());
  const out = resolve(arg("--out")); assert.ok(!existsSync(join(out, "phase.json")), "Never replay a phase; choose a fresh output directory");
  assert.deepEqual(await hashes(evaluationFiles), plan.evaluationFiles, "The evaluator changed after freezing");
  assert.equal(sha256(await readFile(plan.catalogPath)), plan.catalogSha256, "The frozen model catalog changed");
  assert.equal(sha256(await readFile("package-lock.json")), plan.lockSha256, "Dependencies changed after freezing");
  assert.equal(process.version, plan.nodeVersion, "Keep the frozen Node runtime");
  const revision = await source(); assert.equal(revision.dirty, "", "Every phase needs clean, committed product source");
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Provide OPENROUTER_API_KEY explicitly for live trials");
  await mkdir(out, { recursive: true });
  const phase = { startedAt: new Date().toISOString(), source: revision, plan: planPath, planSha256: sha256(planBytes), concurrency: plan.concurrency };
  await writeFile(join(out, "phase.json"), JSON.stringify(phase, null, 2));
  const rows: any[] = []; const active = new Set<ReturnType<typeof spawn>>(); let index = 0; let stop = false;
  const cancel = () => { stop = true; for (const child of active) child.kill("SIGTERM"); };
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const persist = async () => {
    const ordered = plan.trials.flatMap((trial: any) => rows.filter(row => row.id === trial.id));
    // The workers serialize snapshot writes by completing this chain, not by rename races.
    await writeFile(join(out, "results.json"), JSON.stringify({ ...phase, updatedAt: new Date().toISOString(), completed: rows.length, planned: plan.trials.length, rows: ordered, groups: aggregateFrozenTrials(ordered) }, null, 2));
  };
  let writes = Promise.resolve();
  async function worker() {
    while (!stop) {
      const trial = plan.trials[index++]; if (!trial) return;
      assert.deepEqual(await source(), revision, "Source changed during the frozen phase");
      const directory = join(out, trial.id); await mkdir(directory, { recursive: true });
      const log = createWriteStream(join(directory, "process.log")); const started = Date.now();
      console.log(JSON.stringify({ stage: "start", ...trial }));
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/harness-eval/autonomous.ts", "--model", trial.model, "--case", trial.scenario, "--out", directory, "--catalog-source", plan.catalogPath, "--frozen-plan", planPath, ...plan.contexts[trial.context]], { stdio: ["ignore", "pipe", "pipe"] });
      active.add(child); child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
      const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
      active.delete(child); log.end();
      assert.deepEqual(await source(), revision, "Source changed during a live trial");
      let summary: any; try { summary = JSON.parse(await readFile(join(directory, "summary.json"), "utf8")); } catch { summary = { outcome: "infrastructure-failure", errors: [(await readFile(join(directory, "failure.txt"), "utf8").catch(() => `Runner exited ${code}`)).slice(0, 2000)] }; }
      const wallSeconds = Math.round((Date.now() - started) / 1000);
      const row = { ...trial, ...summary, durationSeconds: summary.durationSeconds ?? wallSeconds, directory, exitCode: code, wallSeconds };
      if (code !== 0 && row.outcome === "passed") { row.outcome = "infrastructure-failure"; row.errors.push(`Runner exited ${code} after artifact verification`); }
      rows.push(row); writes = writes.then(persist); await writes;
      console.log(JSON.stringify({ stage: "settled", id: trial.id, outcome: row.outcome, durationSeconds: row.durationSeconds ?? row.wallSeconds, completed: rows.length, planned: plan.trials.length }));
    }
  }
  try { await Promise.all(Array.from({ length: plan.concurrency }, worker)); await writes; assert.equal(rows.length, plan.trials.length, "The phase was interrupted"); }
  finally { cancel(); }
  console.log(JSON.stringify({ stage: "complete", passed: rows.filter(row => row.outcome === "passed").length, total: rows.length, results: join(out, "results.json") }));
}
