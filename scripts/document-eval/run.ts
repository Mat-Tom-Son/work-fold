#!/usr/bin/env tsx
/**
 * Runs the document-checking evaluation (2026-10-18) for one condition.
 *
 * For each seeded task it makes a disposable work-folder, drives one real
 * Worker turn with `npm run work-fold:drive -- --attach`, then scores the
 * deliverable with check.ts and records which checks the Worker ran.
 *
 * Conditions:
 *   engines     LibreOffice and Tesseract visible, as on a set-up Mac.
 *   no-engines  The host runs under no-engines.sb, so neither it nor any tool
 *               it starts can find LibreOffice, Tesseract or Microsoft Office.
 *
 * --host-repo runs the host from another checkout (for a baseline of an older
 * Skill); the drive client and checker always come from this one.
 *
 * The OpenRouter key is read from Pi's auth.json into the host's environment
 * only; it is never printed or written.
 *
 * Usage: tsx scripts/document-eval/run.ts --condition engines --out <dir> [--tasks budget,deck,report] [--repeat 1] [--host-repo <path>]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tasks } from "./fixtures.js";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argument = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
};
const condition = argument("--condition");
if (!["engines", "no-engines"].includes(condition)) throw new Error("--condition must be engines or no-engines");
const out = resolve(argument("--out"));
const selected = argument("--tasks", "budget,deck,report").split(",");
const repeat = Number(argument("--repeat", "1"));
const hostRepo = resolve(argument("--host-repo", repo));
const model = argument("--model", "openrouter/openai/gpt-6-luna");

function collect(child: ChildProcess) {
  let stdout = "", stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => child.once("close", (code) => done({ code, stdout, stderr })));
}

const auth = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "auth.json"), "utf8")) as Record<string, { type?: string; key?: string }>;
const key = process.env.OPENROUTER_API_KEY ?? (auth.openrouter?.type === "api_key" ? auth.openrouter.key : undefined);
if (!key) throw new Error("No OpenRouter key in the environment or Pi's auth.json.");

const hostOut = join(out, "host");
await mkdir(hostOut, { recursive: true });
const node = process.execPath;
const hostCommand = [node, "--import", "tsx", join(hostRepo, "scripts", "document-eval", "host.ts"), "--out", hostOut, "--model", model];
const command = condition === "no-engines" ? ["/usr/bin/sandbox-exec", "-f", join(repo, "scripts", "document-eval", "no-engines.sb"), ...hostCommand] : hostCommand;
const host = spawn(command[0]!, command.slice(1), { cwd: hostRepo, env: { ...process.env, OPENROUTER_API_KEY: key }, stdio: ["ignore", "pipe", "pipe"] });
const hostLog = collect(host);
let origin: string | undefined;
for (let attempt = 0; attempt < 600 && !origin; attempt++) {
  if (existsSync(join(hostOut, "host.json"))) origin = JSON.parse(await readFile(join(hostOut, "host.json"), "utf8")).origin;
  else await new Promise((done) => setTimeout(done, 250));
  if (host.exitCode !== null) break;
}
if (!origin) { host.kill(); const log = await hostLog; throw new Error(`The host did not start.\n${log.stderr.slice(-4000)}`); }
console.error(`[${condition}] host at ${origin}`);

async function sessionBehavior(since: number, folder: string) {
  const sessions: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl") && (await stat(path)).mtimeMs >= since) sessions.push(path);
    }
  };
  await walk(join(hostOut, "pi-agent"));
  const calls: Array<{ name: string; operation?: string; source?: string; images?: number }> = [];
  for (const path of sessions) {
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    if (!lines.some((line) => line.includes(folder))) continue;
    const byId = new Map<string, (typeof calls)[number]>();
    for (const line of lines) {
      let entry: any; try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.message ?? entry;
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const part of message.content) if (part?.type === "toolCall") {
          const input = part.arguments?.input ?? part.arguments ?? {};
          const call = { name: part.name, ...(input.operation ? { operation: input.operation } : {}), ...(input.source ? { source: input.source } : {}), ...(input.script ? { source: input.script } : {}) };
          calls.push(call); byId.set(part.id, call);
        }
      }
      if (message?.role === "toolResult" && Array.isArray(message.content)) {
        const images = message.content.filter((part: { type?: string }) => part?.type === "image").length;
        const call = byId.get(message.toolCallId);
        if (call && images) call.images = images;
      }
    }
  }
  const engine = (operation: string) => calls.filter((call) => call.name === "document_engine" && call.operation === operation).length;
  return {
    toolCalls: calls.length, documentRuns: calls.filter((call) => call.name === "document_run").length,
    engineStatus: engine("status"), renders: engine("render"), recalculations: engine("recalculate"), ocr: engine("ocr"),
    imagesViewed: calls.reduce((sum, call) => sum + (call.images ?? 0), 0),
    shellCalls: calls.filter((call) => call.name === "bash").length, calls,
  };
}

/** Registration changes are serialized by the host, so folders are registered one at a time before turns run together. */
async function register(folder: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${origin}/api/work-folders/local-folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workFolderRoot: folder }) });
    if (response.ok) return ((await response.json()) as { workFolder: { id: string } }).workFolder.id;
    if (response.status !== 409 || attempt > 120) throw new Error(`Registering ${folder} failed (${response.status}): ${await response.text()}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
}

async function prepare(taskId: string, attempt: number) {
  const task = tasks.find((item) => item.id === taskId)!;
  const base = join(out, `${task.id}-${attempt}`);
  const folder = join(base, "folder");
  await mkdir(folder, { recursive: true });
  for (const [name, content] of Object.entries(task.files)) await writeFile(join(folder, name), content);
  return { task, attempt, base, folder, workFolderId: await register(folder) };
}

async function runTask({ task, attempt, base, folder, workFolderId }: Awaited<ReturnType<typeof prepare>>) {
  const promptFile = join(base, "prompt.md");
  await writeFile(promptFile, task.prompt);
  const started = Date.now();
  const drive = spawn("npm", ["run", "--silent", "work-fold:drive", "--", "--attach", origin!, "--work-folder-id", workFolderId, "--prompt-file", promptFile, "--json", "--quiet", "--timeout", "2400"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(drive);
  let report: any = {};
  try { report = JSON.parse(result.stdout); } catch { report = { outcome: "unparsed", stdout: result.stdout.slice(-2000), stderr: result.stderr.slice(-2000) }; }
  delete report.events;
  await writeFile(join(base, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const behavior = await sessionBehavior(started, folder);
  await writeFile(join(base, "behavior.json"), `${JSON.stringify(behavior, null, 2)}\n`);
  const check = await collect(spawn(node, ["--import", "tsx", join(repo, "scripts", "document-eval", "check.ts"), task.id, folder, join(base, "check")], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }));
  let checked: any = {};
  try { checked = JSON.parse(check.stdout); } catch { checked = { error: check.stderr.slice(-2000) }; }
  const summary = { condition, task: task.id, attempt, outcome: report.outcome, minutes: Math.round((report.durationMs ?? 0) / 600) / 100, behavior: { ...behavior, calls: undefined }, check: { ...checked, cells: undefined }, finalMessage: report.assistantText };
  await writeFile(join(base, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.error(`[${condition}] ${task.id}-${attempt}: ${report.outcome} in ${summary.minutes} min`);
  return summary;
}

try {
  const prepared = [];
  for (let attempt = 1; attempt <= repeat; attempt++) for (const id of selected) prepared.push(await prepare(id, attempt));
  const summaries = await Promise.all(prepared.map(runTask));
  await writeFile(join(out, "summaries.json"), `${JSON.stringify(summaries, null, 2)}\n`);
} finally {
  host.kill("SIGTERM");
  const log = await hostLog;
  await writeFile(join(hostOut, "host.log"), log.stderr + log.stdout);
}
