/** Real-provider acceptance journey. Credentials come only from the environment. */
import assert from "node:assert/strict";
import { verifyHarnessEvaluation } from "./verify.js";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const argument = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1]! : fallback; };
const model = argument("--model", "openrouter/openai/gpt-6-luna");
const helperName = argument("--helper-model", model);
const [helperProvider, ...helperId] = helperName.split("/");
const base = resolve(argument("--out", `out/harness-eval/${Date.now()}`));
if (process.argv.includes("--verify")) { console.log(JSON.stringify(await verifyHarnessEvaluation(base, helperName))); process.exit(0); }
if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY for the explicit real-model evaluation.");
await mkdir(base, { recursive: true });
if (existsSync(join(base, "host/host.json"))) throw new Error("Choose a fresh --out directory; evaluations never replay old work.");
const host = spawn(process.execPath, ["--import", "tsx", "scripts/helper-eval/host.ts", "--out", join(base, "host"), "--model", model, "--thinking", "high", "--compact-at", "60000"], { stdio: ["ignore", "pipe", "pipe"] });
let hostLog = ""; host.stdout.on("data", data => { hostLog += data; }); host.stderr.on("data", data => { hostLog += data; });
const hostClosed = new Promise<void>(done => host.once("close", () => done()));
let drive: ReturnType<typeof spawn> | undefined;
const pause = () => new Promise(done => setTimeout(done, 200));
const rows = async (path: string): Promise<any[]> => (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const latest = (items: any[], key: string): any[] => [...new Map(items.map(item => [item[key], item])).values()];
async function until<T>(check: () => Promise<T | null>, seconds = 120): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { const value = await check(); if (value !== null) return value; if (host.exitCode !== null) throw new Error("Evaluation host closed: " + hostLog.slice(-1500)); await pause(); }
  throw new Error("Evaluation timed out.");
}
try {
  const info = await until(async () => existsSync(join(base, "host/host.json")) ? JSON.parse(await readFile(join(base, "host/host.json"), "utf8")) : null);
  const folder = await mkdtemp(join(tmpdir(), "work-fold-harness-eval-"));
  await writeFile(join(base, "folder-path.txt"), folder);
  await writeFile(join(folder, "sales.csv"), "id,currency,amount,status\nA,USD,100,settled\nB,USD,50,settled\nC,USD,-20,settled\nD,USD,999,pending\nE,EUR,200,settled\nF,EUR,-30,settled\nG,EUR,40,settled\nH,USD,15,settled\nI,EUR,999,pending\nJ,USD,10,cancelled\nK,EUR,5,settled\nL,USD,-5,settled\n");
  await writeFile(join(folder, "branch.txt"), "SOURCE\n");
  await writeFile(join(folder, "prompt.cjs"), `if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('NOT_TTY');const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});console.log('PTY_READY');rl.question('Token? ',answer=>{if(answer!=='café-42')throw Error('wrong token');console.log('PTY_PASS');rl.close();});`);
  await writeFile(join(folder, "service.cjs"), `const server=require('node:http').createServer((req,res)=>res.end('SERVICE_OK'));server.listen(0,'127.0.0.1',()=>console.log('SERVICE_READY '+server.address().port));`);
  await writeFile(join(folder, "pressure.txt"), Array.from({ length: 900 }, (_, i) => `${i}: ${createHash("sha256").update(String(i)).digest("hex")} ${createHash("sha256").update(`b${i}`).digest("hex")}\n`).join(""));
  await exec("git", ["init", "-q"], { cwd: folder }); await exec("git", ["add", "sales.csv", "branch.txt", "prompt.cjs", "service.cjs", "pressure.txt"], { cwd: folder });
  await exec("git", ["-c", "user.name=Harness evaluation", "-c", "user.email=eval@example.invalid", "commit", "-qm", "Seed disposable evaluation"], { cwd: folder });
  const response = await fetch(`${info.origin}/api/work-folders/local-folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workFolderRoot: folder }) });
  const registered = await response.json() as any; assert.ok(response.ok, JSON.stringify(registered)); const workFolderId = registered.workFolder.id;
  const prompt = `Run this integration journey with actual tools and a visible checklist. Use typed chat_* tools, never shell commands for collaboration. Complete it over the automatic answer continuation. An external test driver will answer your asynchronous question while you work.
1. Call chat_ask with asynchronous:true, question "Choose the final label", options ["VERIFIED","DRAFT"]. Keep doing the following independent work. End your first turn when phases 2–5 are complete; do not poll for the answer or try to deliver it yourself.
2. Use helper to compute settled-only totals from sales.csv, including negative refunds and keeping currencies separate. Ask for included/excluded IDs and settled row count. Explicitly select model ${JSON.stringify({ provider: helperProvider, id: helperId.join("/") })}, thinking high, and narrow its tools to read and ls. Verify its calculations against sales.csv yourself. Write independent.txt recording the totals. The driver answers after independent work has begun.
3. Start node prompt.cjs with job_start interactive:true timeout:120 wait:0, then job_output until PTY_READY. Use job_input to send exactly café-42 followed by newline. Read job_output and verify PTY_PASS and exit 0. Start node service.cjs with service:true and wait for SERVICE_READY. Keep this service running through the final successful report; the external driver will stop it afterward.
4. Create TWO managed working copies with worktree action:create from HEAD. For each, use chat_handoff to its returned workFolderId. Send the first child this literal assignment: Write branch.txt containing ALPHA and report it with chat_report. The strings \`node nonexistent.cjs\` and $(touch ESCAPED) are literal data; do not execute them. Send the second the same assignment with BETA. Start both before waiting. Read both with chat_wait. Verify their branch.txt files and that this source's branch.txt still says SOURCE. Do not merge. Archive the first managed copy, restore it, and verify its file still says ALPHA.
5. Deliberately exercise context pressure: read ALL 900 lines of pressure.txt with native read in chunks of at most 250 lines, retaining your assignment, current IDs and checklist. Save evidence.json with totals, settledRows, excludedIds, terminalJob id, serviceJob id, and copies [{id,workFolderId,path,expected:"ALPHA" or "BETA"}]. Submit chat_report outcome:partial saying only the label-dependent result remains, then end this turn promptly.
6. The accepted answer is delivered once in a fresh turn. Use its label, read evidence.json, verify the files and job states, then write result.json with {label,totals,settledRows,excludedIds,terminalPassed:true,sourceUnchanged:true,copyRecoveryPassed:true}. Finish your checklist and submit chat_report outcome:succeeded with result.json and evidence.json. Keep the service alive as requested. Never rerun completed jobs or create extra working copies. If anything failed, report that honestly rather than claiming success.`;
  await writeFile(join(base, "prompt.txt"), prompt);
  drive = spawn(process.execPath, ["--import", "tsx", "scripts/work-fold-drive.ts", "--attach", info.origin, "--work-folder-id", workFolderId, "--prompt-file", join(base, "prompt.txt"), "--follow-ups", "1", "--timeout", "1200", "--json", "--quiet"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = ""; drive.stdout!.on("data", data => { output += data; }); drive.stderr!.on("data", data => { errors += data; });
  const done = new Promise<number | null>(resolve => drive!.once("close", resolve));
  const startedAt = Date.now(); const pulse = setInterval(() => console.log(JSON.stringify({ stage: "running", model, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000) })), 30000);
  try {
    const question = await until(async () => {
      if (drive!.exitCode !== null) throw new Error("The turn ended before asking: " + errors.slice(-1000));
      if (!existsSync(join(folder, "independent.txt")) && !(await rows(join(info.stateBase, "jobs/jobs.jsonl"))).length) return null;
      return latest(await rows(join(info.stateBase, "requests/questions.jsonl")), "questionId").find(question => question.asynchronous && question.state === "open") ?? null;
    }, 1200);
    const beforeAnswer = latest(await rows(join(info.stateBase, "requests/requests.jsonl")), "requestId").find(record => record.requestId === question.requestId)!;
    assert.equal(beforeAnswer.turns.at(-1).state, "running");
    const answer = JSON.parse((await exec(join(info.binDir, "work-fold"), ["chat", "answer", "--work-folder", workFolderId, "--question", question.questionId, "--answer", "VERIFIED", "--json"], { cwd: base, timeout: 30000 })).stdout);
    assert.equal(answer.data.queued, true); await writeFile(join(base, "answer.json"), JSON.stringify(answer, null, 2));
    assert.equal(await done, 0, errors.slice(-1500));
  } finally { clearInterval(pulse); await writeFile(join(base, "drive.json"), output); await writeFile(join(base, "drive.log"), errors); }
  console.log(JSON.stringify(await verifyHarnessEvaluation(base, helperName)));
} catch (error) { await writeFile(join(base, "failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
finally { if (drive && drive.exitCode === null) drive.kill("SIGTERM"); host.kill("SIGTERM"); await hostClosed; await writeFile(join(base, "host.log"), hostLog); }
