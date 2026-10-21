/** Independently verify saved native sessions, journals and files; no model requests. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const rows = async (path: string): Promise<any[]> => (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const latest = (items: any[], key: string): any[] => [...new Map(items.map(item => [item[key], item])).values()];
export async function verifyHarnessEvaluation(base: string, helperName: string) {
  const info = JSON.parse(await readFile(join(base, "host/host.json"), "utf8"));
  const model = `${info.model.provider}/${info.model.id}`;
  const folder = (await readFile(join(base, "folder-path.txt"), "utf8")).trim();
  const helperId = helperName.split("/").slice(1);
  const answer = JSON.parse(await readFile(join(base, "answer.json"), "utf8"));
  assert.equal(answer.data.queued, true);
  assert.equal(answer.data.continuation, null);
  assert.equal(answer.data.request.state, "working");
  const result = JSON.parse(await readFile(join(folder, "result.json"), "utf8")); const evidence = JSON.parse(await readFile(join(folder, "evidence.json"), "utf8"));
  assert.deepEqual(result.totals, { USD: 140, EUR: 215 }); assert.equal(result.label, "VERIFIED"); assert.equal(result.settledRows, 9); assert.deepEqual([...result.excludedIds].sort(), ["D", "I", "J"]);
  for (const key of ["terminalPassed", "sourceUnchanged", "copyRecoveryPassed"]) assert.equal(result[key], true);
  assert.equal((await readFile(join(folder, "branch.txt"), "utf8")).trim(), "SOURCE");
  assert.equal(existsSync(join(folder, "ESCAPED")), false);
  assert.equal(evidence.copies.length, 2);
  const copyHistory = await rows(join(info.stateBase, "worktrees/records.jsonl"));
  const managedCopies = latest(copyHistory, "id");
  assert.deepEqual(evidence.copies.map((copy: any) => copy.expected).sort(), ["ALPHA", "BETA"]);
  for (const copy of evidence.copies) {
    const owned = managedCopies.find(record => record.id === copy.id);
    assert.ok(owned, "The copy exists in the host's journal");
    assert.equal(owned.workFolderId, copy.workFolderId);
    assert.equal(resolve(owned.path), resolve(`${info.stateBase}-working-copies`, copy.id));
    // Resolve from the host's pinned identity, never a model-selected path.
    assert.equal((await readFile(join(owned.path, "branch.txt"), "utf8")).trim(), copy.expected);
    assert.equal(existsSync(join(owned.path, "ESCAPED")), false);
    if (copy.expected === "ALPHA") {
      assert.ok(copyHistory.some(record => record.id === copy.id && record.state === "archived"));
      assert.equal(owned.state, "active");
    }
  }
  const requests = latest(await rows(join(info.stateBase, "requests/requests.jsonl")), "requestId"); const root = requests.find(record => record.parentRequestId === null)!;
  const workFolderId: string = root.owner.workFolderId;
  assert.equal(root.state, "done"); assert.equal(root.turns.length, 2);
  const questions = latest(await rows(join(info.stateBase, "requests/questions.jsonl")), "questionId"); assert.equal(questions.length, 1); assert.equal(questions[0].continuationTaskId, root.turns[1].taskId);
  const jobs = latest(await rows(join(info.stateBase, "jobs/jobs.jsonl")), "jobId"); assert.equal(jobs.length, 2);
  const terminal = jobs.find(job => job.interactive)!; const service = jobs.find(job => job.service)!;
  assert.equal(terminal.command.trim(), "node prompt.cjs");
  assert.equal(service.command.trim(), "node service.cjs");
  assert.match(await readFile(join(info.stateBase, "jobs", terminal.jobId, "output.log"), "utf8"), /PTY_PASS/);
  assert.match(await readFile(join(info.stateBase, "jobs", service.jobId, "output.log"), "utf8"), /SERVICE_READY/);
  assert.equal(terminal.state, "exited"); assert.equal(terminal.exitCode, 0); const serviceAtCompletion = (await rows(join(info.stateBase, "jobs/jobs.jsonl"))).filter(job => job.jobId === service.jobId && Date.parse(job.updatedAt) <= Date.parse(root.settledAt)).at(-1); assert.equal(serviceAtCompletion?.state, "running");
  if (service.state === "running") {
  const stop = await exec(join(info.binDir, "work-fold"), ["jobs", "stop", "--work-folder", workFolderId, "--job", service.jobId, "--json"], { cwd: base, timeout: 30000 });
  await writeFile(join(base, "service-stop.json"), stop.stdout);
  }
  const turns = latest(await rows(join(info.stateBase, "turns/turns.jsonl")), "turnId"); const helpers = turns.flatMap(turn => turn.helpers ?? []);
  assert.equal(helpers.length, 1); assert.equal(helpers[0].outcome, "succeeded"); assert.equal(helpers[0].model.id, helperId.join("/"));
  const sessions: any[] = []; async function walk(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.name.endsWith(".jsonl")) sessions.push(await rows(file)); } }
  await walk(join(info.agentDir, "sessions")); const parent = sessions.find(entries => entries.some((entry: any) => entry.message?.role === "user" && JSON.stringify(entry.message).includes("Run this integration journey")))!;
  const calls = parent.flatMap((entry: any) => Array.isArray(entry.message?.content) ? entry.message.content.filter((part: any) => part.type === "toolCall") : []);
  for (const name of ["chat_ask", "helper", "job_start", "job_input", "job_output", "worktree", "chat_handoff", "chat_wait", "chat_report", "checklist"]) assert.ok(calls.some((call: any) => call.name === name || (call.name === "codemode" && JSON.stringify(call.arguments).includes(name))), `Expected actual ${name} use`);
  assert.ok(root.results.some((result: any) => result.taskId === root.turns[1].taskId && result.outcome === "succeeded"), "The current answer turn submitted success");
  const checklist = calls.filter((call: any) => call.name === "checklist").at(-1); assert.ok(checklist.arguments.items.every((item: any) => item.status === "done"));
  const providerCalls = await rows(info.tapLog);
  const helperCalls = providerCalls.filter(call => call.systemHead?.startsWith("You are a read-only helper"));
  assert.ok(helperCalls.length > 0);
  for (const call of helperCalls) { assert.equal(call.model, helperId.join("/")); assert.deepEqual([...call.toolNames].sort(), ["ls", "read", "submit_result"]); }
  const summary = { outcome: "passed", model, helperModel: helperName, durationSeconds: Math.round(JSON.parse(await readFile(join(base, "drive.json"), "utf8")).durationMs / 1000), compactions: parent.filter((entry: any) => entry.type === "compaction").length, parentTurns: root.turns.length, handleRecoveries: calls.filter((call: any) => call.name === "chat_children" || (call.name === "codemode" && JSON.stringify(call.arguments).includes("chat_children"))).length, childRequests: root.childRequestIds.length, helperRuns: helpers.length, jobs: jobs.map(job => ({ id: job.jobId, interactive: job.interactive ?? false, service: job.service ?? false, state: job.state })), result, providerCalls: providerCalls.length, providerCost: providerCalls.reduce((sum, call) => sum + (call.usage?.cost ?? 0), 0) };
  await writeFile(join(base, "summary.json"), JSON.stringify(summary, null, 2)); return summary;
}
