/** Outcome-based live evaluation: prompts never prescribe tools or an execution sequence. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertExactSupportingQuote } from "./assertions.js";
import { seedAutonomousCase, repairSource, reconciliationSource } from "./fixtures.js";
import { summarizeAutonomousTrace, autonomousHostArguments, stableJson, sha256 } from "./frozen.js";
const exec = promisify(execFile);
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]!; };
const model = arg("--model", "openrouter/openai/gpt-6-luna");
const scenario = arg("--case", "research");
const base = resolve(arg("--out", `out/autonomous-eval/${scenario}-${Date.now()}`));
const rows = async (path: string): Promise<any[]> => (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const latest = (records: any[], key: string): any[] => [...new Map(records.map(record => [record[key], record])).values()];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function verify() {
  const meta = JSON.parse(await readFile(join(base, "case.json"), "utf8")); const folder: string = meta.folder;
  const errors: string[] = [];
  try {
    if (meta.scenario === "research") {
      const actual = JSON.parse(await readFile(join(folder, "findings.json"), "utf8"));
      assert.deepEqual(actual.map((item: any) => item.id).sort(), meta.expected.map((item: any) => item.id).sort());
      for (const item of actual) { const expected = meta.expected.find((entry: any) => entry.id === item.id); assert.equal(item.path, expected.path); assertExactSupportingQuote(item.quote, expected.quote, await readFile(join(folder, expected.path), "utf8")); }
      assert.ok((await readFile(join(folder, "findings.md"), "utf8")).length > 100);
    } else if (meta.scenario === "reconcile") {
      assert.equal(await readFile(join(folder, "payments.csv"), "utf8"), reconciliationSource.replace("K,EUR,5.00", "K,EUR,8.00"), "Only the person's exact source correction is allowed");
      const actual = JSON.parse(await readFile(join(folder, "reconciliation.json"), "utf8"));
      assert.deepEqual(actual.totals, meta.expected.totals);
      for (const key of ["includedIds", "excludedIds"]) assert.deepEqual([...actual[key]].sort(), [...meta.expected[key]].sort());
      assert.ok((await readFile(join(folder, "reconciliation.md"), "utf8")).length > 100);
    } else {
      assert.equal(await readFile(join(folder, "ledger.mjs"), "utf8"), meta.expected.original);
      assert.equal(await readFile(join(folder, "personal-draft.txt"), "utf8"), meta.expected.draft);
      const isolated = await mkdtemp(join(tmpdir(), "work-fold-patch-check-"));
      await writeFile(join(isolated, "ledger.mjs"), repairSource);
      const patch = join(folder, "candidate.patch"); await exec("git", ["apply", "--check", patch], { cwd: isolated }); await exec("git", ["apply", patch], { cwd: isolated });
      const script = `import assert from 'node:assert/strict';import {summarize} from ${JSON.stringify(pathToFileURL(join(isolated, "ledger.mjs")).href)};for(let seed=0;seed<25;seed++){const rows=[];const cents={USD:0,EUR:0};for(let i=0;i<50;i++){const amount=((seed*53+i*97)%4001)-2000;const currency=i%2?'USD':'EUR';const status=i%7?'settled':'pending';rows.push({currency,status,amount:(amount/100).toFixed(2)});if(status==='settled')cents[currency]+=amount;}assert.deepEqual(summarize(rows),Object.fromEntries(Object.entries(cents).map(([key,cents])=>[key,(cents/100).toFixed(2)])));}assert.deepEqual(summarize([]),{});console.log('26 independent cases passed');`;
      await writeFile(join(isolated, "verify.mjs"), script);
      await exec(process.execPath, [join(isolated, "verify.mjs")], { cwd: isolated, env: { PATH: process.env.PATH }, timeout: 30_000 });
      assert.ok((await readFile(join(folder, "validation.md"), "utf8")).length > 100);
    }
    for (const [path, hash] of Object.entries(meta.sourceHashes)) assert.equal(digest(await readFile(join(folder, path), "utf8")), hash, `Source changed: ${path}`);
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const host = JSON.parse(await readFile(join(base, "host/host.json"), "utf8"));
  const requests = latest(await rows(join(host.stateBase, "requests/requests.jsonl")), "requestId"); const root = requests.find(record => record.parentRequestId === null);
  if (root?.state !== "done") errors.push(`Request state: ${root?.state}`);
  const entries: any[] = [];
  async function walk(path: string) { for (const item of await readdir(path, { withFileTypes: true })) { const file = join(path, item.name); if (item.isDirectory()) await walk(file); else if (item.name.endsWith(".jsonl")) entries.push(...await rows(file)); } }
  await walk(join(host.agentDir, "sessions"));
  const results = entries.map(entry => entry.message).filter(message => message?.role === "toolResult");
  const calls = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content.filter((part: any) => part.type === "toolCall").map((call: any) => ({ ...call, failed: results.find(result => result.toolCallId === call.id)?.isError ?? true })) : []);
  calls.push(...results.flatMap(result => (result.nestedCalls?.calls ?? []).map((call: any) => ({ ...call, arguments: call.arguments ?? {}, failed: call.status !== "ok" }))));
  const counts: Record<string, number> = {}; for (const call of calls) counts[call.name] = (counts[call.name] ?? 0) + 1;
  const provider = await rows(host.tapLog);
  const progressRecords = entries.filter(entry => entry.type === "custom" && entry.customType === "work-fold-progress.v1");
  const trace = summarizeAutonomousTrace(entries, provider, folder);
  const summary = { ...trace, settledDoneWithInvalidOutput: root?.state === "done" && errors.length > 0, outcome: errors.length ? "failed" : "passed", model: meta.model, scenario: meta.scenario, fixtureRevision: meta.fixtureRevision ?? 1, promptSha256: digest(meta.prompt), sourceCommit: meta.sourceCommit, sourceDiffSha256: meta.sourceDiffSha256, durationSeconds: meta.durationSeconds, requestState: root?.state, parentTurns: root?.turns.length, compactions: entries.filter(entry => entry.type === "compaction").length, progressRecordsRetained: progressRecords.length, toolCalls: counts, toolErrors: calls.filter(call => call.failed).length, evidenceReads: calls.filter(call => call.name === "progress" && !call.failed && (call.arguments.input ?? call.arguments).action === "read").length, findingsSaved: progressRecords.filter(entry => entry.data?.kind === "finding").length, providerCalls: provider.length, providerCost: provider.reduce((sum, call) => sum + (call.usage?.cost ?? 0), 0), errors };
  await writeFile(join(base, "summary.json"), JSON.stringify(summary, null, 2)); return summary;
}

if (process.argv.includes("--verify")) { const summary = await verify(); console.log(JSON.stringify(summary)); process.exit(summary.outcome === "passed" ? 0 : 1); }
if (!process.env.OPENROUTER_API_KEY) throw new Error("Provide OPENROUTER_API_KEY explicitly for live evaluation.");
await mkdir(base, { recursive: true }); if (existsSync(join(base, "case.json"))) throw new Error("Choose a fresh --out; never replay an evaluation.");
const folder = await mkdtemp(join(tmpdir(), `work-fold-autonomous-${scenario}-`));
const spec = await seedAutonomousCase(scenario, folder);
const sourceHashes: Record<string, string> = {};
async function sources(path: string, prefix = "") { for (const item of await readdir(path, { withFileTypes: true })) { const name = join(prefix, item.name); if (item.isDirectory()) await sources(join(path, item.name), name); else sourceHashes[name] = digest(await readFile(join(folder, name), "utf8")); } }
await sources(folder);
if (scenario === "repair") { await exec("git", ["init", "-q"], { cwd: folder }); await exec("git", ["add", "ledger.mjs", "visible-test.mjs"], { cwd: folder }); await exec("git", ["-c", "user.name=Evaluation", "-c", "user.email=eval@example.invalid", "commit", "-qm", "Seed candidate task"], { cwd: folder }); }
if (process.argv.includes("--frozen-plan")) {
  const plan = JSON.parse(await readFile(arg("--frozen-plan", ""), "utf8"));
  assert.equal(sha256(stableJson({ ...spec, sourceHashes })), plan.cases[scenario].digest, "Fixture or prompt differs from the frozen plan");
}
const meta = { scenario, model, folder, initialSourceHashes: { ...sourceHashes }, context: process.argv.includes("--compact-at") ? "stressed" : "normal", hostArguments: autonomousHostArguments(process.argv.slice(2)), ...spec, sourceHashes, fixtureRevision: scenario === "research" ? 3 : 1, sourceCommit: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(), sourceDiffSha256: digest((await exec("git", ["diff", "HEAD"])).stdout), durationSeconds: 0 };
await writeFile(join(base, "case.json"), JSON.stringify(meta, null, 2)); await writeFile(join(base, "prompt.txt"), spec.prompt);
const host = spawn(process.execPath, ["--import", "tsx", "scripts/helper-eval/host.ts", "--out", join(base, "host"), "--model", model, "--thinking", "high", ...autonomousHostArguments(process.argv.slice(2))], { stdio: ["ignore", "pipe", "pipe"] });
let log = ""; host.stdout.on("data", data => { log += data; }); host.stderr.on("data", data => { log += data; });
const closed = new Promise<void>(done => host.once("close", () => done())); const startedAt = Date.now();
const pause = () => new Promise(done => setTimeout(done, 250));
let drive: ReturnType<typeof spawn> | undefined;
process.on("SIGTERM", () => { drive?.kill("SIGTERM"); host.kill("SIGTERM"); });
try {
  while (!existsSync(join(base, "host/host.json"))) { if (host.exitCode !== null || Date.now() - startedAt > 60_000) throw new Error(log.slice(-2000)); await pause(); }
  const info = JSON.parse(await readFile(join(base, "host/host.json"), "utf8"));
  const response = await fetch(`${info.origin}/api/work-folders/local-folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workFolderRoot: folder }) });
  const registered = await response.json() as any; assert.ok(response.ok, JSON.stringify(registered)); const workFolderId = registered.workFolder.id;
  drive = spawn(process.execPath, ["--import", "tsx", "scripts/work-fold-drive.ts", "--attach", info.origin, "--work-folder-id", workFolderId, "--prompt-file", join(base, "prompt.txt"), "--timeout", "900", "--json", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errors = ""; drive.stdout!.on("data", data => { output += data; }); drive.stderr!.on("data", data => { errors += data; });
  const answered = new Set<string>(); let lastPulse = 0;
  while (Date.now() - startedAt < 900_000) {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (elapsedSeconds - lastPulse >= 30) { lastPulse = elapsedSeconds; console.log(JSON.stringify({ stage: "running", model, scenario, elapsedSeconds })); }
    if (host.exitCode !== null) throw new Error("Host closed: " + log.slice(-1500));
    const questions = latest(await rows(join(info.stateBase, "requests/questions.jsonl")), "questionId");
    for (const question of questions.filter(question => question.respondent === "person" && question.state === "open" && !answered.has(question.questionId))) {
      if (answered.size >= 5) throw new Error("More than five clarification questions; evaluation needs attention.");
      if (scenario === "reconcile" && !answered.size) { const path = join(folder, "payments.csv"); assert.equal(await readFile(path, "utf8"), reconciliationSource, "The model changed the source before the person's correction"); const corrected = reconciliationSource.replace("K,EUR,5.00", "K,EUR,8.00"); await writeFile(path, corrected); meta.sourceHashes["payments.csv"] = digest(corrected); }
      const owner = latest(await rows(join(info.stateBase, "requests/requests.jsonl")), "requestId").find(record => record.requestId === question.requestId);
      const answer = await exec(join(info.binDir, "work-fold"), ["chat", "answer", "--work-folder", owner?.owner.workFolderId ?? workFolderId, "--question", question.questionId, "--answer", spec.answer, "--json"], { cwd: base, timeout: 30_000 });
      answered.add(question.questionId); await writeFile(join(base, `answer-${answered.size}.json`), answer.stdout);
    }
    const records = latest(await rows(join(info.stateBase, "requests/requests.jsonl")), "requestId"); const root = records.find(record => record.parentRequestId === null);
    if (root && ["done", "partial", "failed", "stopped", "expired"].includes(root.state) && !questions.some(question => question.state === "open" || (question.state === "answered" && !question.continuationTaskId)) && drive.exitCode !== null) break;
    await pause();
  }
  await writeFile(join(base, "drive.json"), output); await writeFile(join(base, "drive.log"), errors);
  meta.durationSeconds = Math.round((Date.now() - startedAt) / 1000); await writeFile(join(base, "case.json"), JSON.stringify(meta, null, 2));
  const summary = await verify(); console.log(JSON.stringify(summary)); if (summary.outcome !== "passed") process.exitCode = 1;
} catch (error) {
  meta.durationSeconds = Math.round((Date.now() - startedAt) / 1000); await writeFile(join(base, "case.json"), JSON.stringify(meta, null, 2));
  await writeFile(join(base, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  try { await verify(); } catch { /* The batch retains infrastructure failures too. */ }
  throw error;
}
finally { if (drive?.exitCode === null) drive.kill("SIGTERM"); host.kill("SIGTERM"); await closed; await writeFile(join(base, "host.log"), log); }
