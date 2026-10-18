#!/usr/bin/env tsx
/**
 * One measured run of the helper-tool evaluation against a running
 * scripts/helper-eval/host.ts. Copies a seeded task folder into a fresh
 * disposable work-folder, drives one real Pi turn with the existing driver
 * (`scripts/work-fold-drive.ts --attach`), then measures what that turn cost:
 * every provider call the host tapped (agent loop, child Chats, titles,
 * helper), the parent session's context at its first and last model call, the
 * request graph's states, and latency. Expected answers are never read here.
 *
 * Usage:
 *   tsx scripts/helper-eval/run.ts --eval <host-out-dir> --fixtures <fixtures-dir> --task <id> --arm a|b|c [--rep <n>]
 *   ... --stop-after <seconds>   Stop the request mid-turn instead of letting it finish.
 *   ... --stop-when-child        With --stop-after, start the clock once a child Chat or helper is running.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { helperEvalTasks, longHistoryDocument, longHistorySetupPrompt, type HelperEvalTaskId } from "./fixtures.js";
import { workFolderSessionDir } from "../../src/local/agent/agent-data-dir.js";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required`);
}

export const armHints = {
  a: "",
  b: "This needs a lot of reading. Keep your own context small: hand the reading to a fresh Chat in this same work-folder with `work-fold chat handoff` (to this work-folder, without --file), tell it exactly what to find and what to report back, then `work-fold chat wait` for its result and answer me from that result.",
  c: "This needs a lot of reading. Keep your own context small: give the reading to the `helper` tool, tell it exactly what to find and what to report back, and answer me from its result.",
  // Arm c without the hint: does the model reach for the tool by itself?
  c0: "",
} as const;
type Arm = keyof typeof armHints;

interface TapRecord {
  call: number;
  startedAt: string;
  durationMs: number;
  messageCount: number;
  toolNames: string[];
  systemHead: string;
  systemChars: number;
  status?: number;
  error?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

interface SessionCall { input: number; output: number; cacheRead: number; cacheWrite: number; timestamp?: number }
interface SessionSummary {
  file: string;
  firstUserText: string;
  calls: SessionCall[];
  toolCalls: Array<{ name: string; args: string }>;
  toolResultChars: number;
  /** Pi compaction entries written during this session. */
  compactions: number;
  /** Every `work-fold chat report` the session ran, with whether work-fold accepted it. */
  reports: Array<{ afterCompaction: boolean; accepted: boolean; taskArg: string | null; result: string }>;
}

const evalRoot = resolve(argument("--eval"));
const fixtures = resolve(argument("--fixtures"));
const taskId = argument("--task") as HelperEvalTaskId;
const arm = argument("--arm") as Arm;
const rep = Number(argument("--rep", "1"));
const stopAfter = process.argv.includes("--stop-after") ? Number(argument("--stop-after")) : null;
const stopWhenChild = process.argv.includes("--stop-when-child");
const task = helperEvalTasks[taskId];
if (!task) throw new Error(`Unknown task ${taskId}`);
if (!(arm in armHints)) throw new Error(`Unknown arm ${arm}`);

const host = JSON.parse(await readFile(join(evalRoot, "host.json"), "utf8")) as {
  origin: string; bridge: string; stateBase: string; agentDir: string; tapLog: string; model: unknown; helperTool: boolean;
};
const runId = `${taskId}-${arm}-r${rep}${stopAfter !== null ? "-stop" : ""}`;
const runDir = join(evalRoot, "runs", runId);
await rm(runDir, { recursive: true, force: true });
const workFolderRoot = join(runDir, task.folder);
await mkdir(runDir, { recursive: true });
await cp(join(fixtures, "tasks", taskId), workFolderRoot, { recursive: true });
const prompt = [task.question, armHints[arm]].filter(Boolean).join("\n\n");
const promptFile = join(runDir, "prompt.txt");
await writeFile(promptFile, `${prompt}\n`);

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload as T;
}
const tap = () => json<{ calls: number; inflight: number; quietMs: number }>("GET", `${host.bridge}/tap`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface DriverReport { outcome: string; durationMs: number; conversationId: string; workFolderId: string; assistantText: string; toolCalls: unknown[]; errors: string[] }
async function drive(file: string, conversation?: string): Promise<DriverReport> {
  // The existing real-Pi driver, attached to the host.
  const child = spawn(process.execPath, [
    join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "scripts", "work-fold-drive.ts"),
    "--attach", host.origin, "--work-folder-root", workFolderRoot, "--prompt-file", file, "--json", "--quiet", "--timeout", "2400",
    ...(conversation ? ["--conversation", conversation] : []),
  ], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  await new Promise<void>((done) => child.on("close", () => done()));
  return JSON.parse(stdout) as DriverReport;
}
async function waitForQuiet(): Promise<void> {
  for (let waited = 0; waited < 90_000; waited += 1000) {
    const status = await tap();
    if (status.inflight === 0 && status.quietMs >= 5000) return;
    await sleep(1000);
  }
}

// A task with a setup turn is asked as the second turn of a Chat that already
// holds a long pasted document. Only the second turn is measured.
const hasSetup = "setup" in task && task.setup === true;
const setupPrompt = hasSetup ? `${longHistorySetupPrompt}\n\n${longHistoryDocument()}` : null;
let setupReport: DriverReport | null = null;
if (setupPrompt && stopAfter === null) {
  const setupFile = join(runDir, "setup-prompt.txt");
  await writeFile(setupFile, `${setupPrompt}\n`);
  setupReport = await drive(setupFile);
  await waitForQuiet();
}
const tapBefore = (await tap()).calls;
const startedAt = Date.now();
let driverReport = null as DriverReport | null;
let stopReport: Record<string, unknown> | null = null;

if (stopAfter === null) {
  driverReport = await drive(promptFile, setupReport?.conversationId);
} else {
  stopReport = await stopRun(stopAfter);
}

// Let trailing calls (Chat titles for parent and children) finish.
await waitForQuiet();
const wallMs = Date.now() - startedAt;

// --- measurements -------------------------------------------------------------
const tapRecords = (await readFile(host.tapLog, "utf8")).split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as TapRecord).filter((record) => record.call > tapBefore);
const sessions = await readSessions(workFolderSessionDir(workFolderRoot, host.agentDir), startedAt);
const firstPrompt = setupPrompt ?? prompt;
const parentSession = sessions.find((session) => session.firstUserText.trim() === firstPrompt.trim()) ?? null;
const childSessions = sessions.filter((session) => session !== parentSession);

const promptTokens = (call: SessionCall) => call.input + call.cacheRead + call.cacheWrite;
const matchedCalls = new Set<number>();
const attribute = (session: SessionSummary | null) => {
  if (!session) return { calls: 0, promptTokens: 0, outputTokens: 0, costUsd: 0 };
  let cost = 0;
  for (const call of session.calls) {
    const match = tapRecords.find((record) => !matchedCalls.has(record.call)
      && record.usage?.prompt_tokens === promptTokens(call) && record.usage?.completion_tokens === call.output);
    if (match) { matchedCalls.add(match.call); cost += match.usage?.cost ?? 0; }
  }
  return {
    calls: session.calls.length,
    promptTokens: session.calls.reduce((sum, call) => sum + promptTokens(call), 0),
    outputTokens: session.calls.reduce((sum, call) => sum + call.output, 0),
    costUsd: cost,
  };
};
const parentUsage = attribute(parentSession);
const childUsage = childSessions.map(attribute);
const classify = (record: TapRecord) => record.systemHead.startsWith("Write a specific 3 to 7 word title") ? "title"
  : record.systemHead.startsWith("You are a read-only helper") ? "helper"
    : matchedCalls.has(record.call) ? "session" : "other";
const byPurpose: Record<string, { calls: number; promptTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number }> = {};
for (const record of tapRecords) {
  const purpose = classify(record);
  const bucket = byPurpose[purpose] ??= { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };
  bucket.calls += 1;
  bucket.promptTokens += record.usage?.prompt_tokens ?? 0;
  bucket.cachedTokens += record.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  bucket.outputTokens += record.usage?.completion_tokens ?? 0;
  bucket.reasoningTokens += record.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  bucket.costUsd += record.usage?.cost ?? 0;
}
const total = Object.values(byPurpose).reduce((sum, bucket) => ({
  calls: sum.calls + bucket.calls, promptTokens: sum.promptTokens + bucket.promptTokens, cachedTokens: sum.cachedTokens + bucket.cachedTokens,
  outputTokens: sum.outputTokens + bucket.outputTokens, reasoningTokens: sum.reasoningTokens + bucket.reasoningTokens, costUsd: sum.costUsd + bucket.costUsd,
}), { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 });

const requests = await readRequests(host.stateBase);
const conversationId = driverReport?.conversationId ?? (stopReport?.conversationId as string | undefined) ?? null;
const root = conversationId ? [...requests.values()].reverse().find((record) => record.owner?.conversationId === conversationId && !record.parentRequestId) : undefined;
const tree = root ? collectTree(requests, root.requestId) : [];
const turnRecords = await readTurnRecords(host.stateBase);

// A delegating parent can be continued by the host after its own turn ends
// (F28 synthesis). Split those calls out: they are a real cost of handoff,
// but not part of the turn the person waited for.
const originSettledAt = Date.parse(String((root?.turns[0] as { settledAt?: string } | undefined)?.settledAt ?? "")) || Infinity;
const parentCalls = (parentSession?.calls ?? []).filter((call) => (call.timestamp ?? 0) <= originSettledAt);
const continuationCalls = (parentSession?.calls ?? []).filter((call) => (call.timestamp ?? 0) > originSettledAt);
const result = {
  runId, taskId, arm, rep, model: host.model, helperTool: host.helperTool,
  workFolderRoot, prompt,
  outcome: driverReport?.outcome ?? "stopped-run",
  latencyMs: driverReport?.durationMs ?? null,
  setup: setupReport ? { outcome: setupReport.outcome, durationMs: setupReport.durationMs } : null,
  wallMs,
  answer: driverReport?.assistantText ?? null,
  driverToolCalls: driverReport?.toolCalls ?? null,
  driverErrors: driverReport?.errors ?? null,
  parent: parentSession ? {
    modelCalls: parentCalls.length,
    firstContextTokens: parentCalls[0] ? promptTokens(parentCalls[0]) : null,
    lastContextTokens: parentCalls.at(-1) ? promptTokens(parentCalls.at(-1)!) + parentCalls.at(-1)!.output : null,
    peakContextTokens: parentCalls.reduce((max, call) => Math.max(max, promptTokens(call)), 0),
    contextGrowthTokens: parentCalls.length ? promptTokens(parentCalls.at(-1)!) + parentCalls.at(-1)!.output - promptTokens(parentCalls[0]!) : null,
    toolResultChars: parentSession.toolResultChars,
    toolCalls: parentSession.toolCalls,
    compactions: parentSession.compactions,
    reports: parentSession.reports,
    usage: parentUsage,
    continuation: {
      turns: Math.max(0, (root?.turns.length ?? 1) - 1),
      modelCalls: continuationCalls.length,
      promptTokens: continuationCalls.reduce((sum, call) => sum + promptTokens(call), 0),
      outputTokens: continuationCalls.reduce((sum, call) => sum + call.output, 0),
      costUsd: continuationCalls.reduce((sum, call) => sum + (tapRecords.find((record) => record.usage?.prompt_tokens === promptTokens(call)
        && record.usage?.completion_tokens === call.output)?.usage?.cost ?? 0), 0),
    },
  } : null,
  children: childSessions.map((session, index) => ({
    firstUserText: session.firstUserText.slice(0, 2000),
    modelCalls: session.calls.length,
    peakContextTokens: session.calls.reduce((max, call) => Math.max(max, promptTokens(call)), 0),
    toolResultChars: session.toolResultChars,
    toolCalls: session.toolCalls.map((call) => call.name),
    compactions: session.compactions,
    reports: session.reports,
    usage: childUsage[index],
  })),
  providerCalls: { total, byPurpose },
  requestTree: tree.map((record) => ({
    requestId: record.requestId, kind: record.kind, depth: record.depth, state: record.state, stopRequestedAt: record.stopRequestedAt,
    settledAt: record.settledAt, turns: record.turns, usage: record.usage, results: record.results,
  })),
  turnRecords: turnRecords.filter((record) => tree.some((request) => request.turns.some((turn: { taskId: string }) => turn.taskId === record.turnId))),
  stop: stopReport,
};
await mkdir(join(evalRoot, "results"), { recursive: true });
await writeFile(join(evalRoot, "results", `${runId}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  runId, outcome: result.outcome, latencyS: result.latencyMs !== null ? Math.round(result.latencyMs / 100) / 10 : null,
  parentGrowth: result.parent?.contextGrowthTokens, parentPeak: result.parent?.peakContextTokens,
  children: result.children.length, calls: total.calls, promptTokens: total.promptTokens, outputTokens: total.outputTokens,
  costUsd: Math.round(total.costUsd * 1e5) / 1e5, byPurpose: Object.fromEntries(Object.entries(byPurpose).map(([key, value]) => [key, value.calls])),
}));

// --- helpers ----------------------------------------------------------------

/** Session summaries counting only what happened at or after `since` (ms), so a setup turn is left out. */
async function readSessions(dir: string, since: number): Promise<SessionSummary[]> {
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".jsonl"))) {
    const summary: SessionSummary = { file: join(dir, name), firstUserText: "", calls: [], toolCalls: [], toolResultChars: 0, compactions: 0, reports: [] };
    const pendingReports = new Map<string, string | null>();
    for (const line of (await readFile(join(dir, name), "utf8")).split("\n").filter(Boolean)) {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown; usage?: SessionCall; timestamp?: number; toolCallId?: string; isError?: boolean } };
      const at = typeof (entry as { timestamp?: unknown }).timestamp === "string" ? Date.parse((entry as { timestamp: string }).timestamp)
        : typeof entry.message?.timestamp === "number" ? entry.message.timestamp : 0;
      const message = entry.message;
      if (message?.role === "user" && !summary.firstUserText) {
        const content = message.content;
        summary.firstUserText = typeof content === "string" ? content
          : Array.isArray(content) ? (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("") : "";
      }
      if (at && at < since) continue;
      if (entry.type === "compaction") summary.compactions += 1;
      if (entry.type !== "message" || !message) continue;
      const parts = Array.isArray(message.content) ? message.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown }> : [];
      if (message.role === "assistant" && message.usage) {
        summary.calls.push({ ...message.usage, timestamp: message.timestamp });
        for (const part of parts) {
          if (part.type !== "toolCall") continue;
          const args = JSON.stringify(part.arguments ?? {});
          summary.toolCalls.push({ name: part.name ?? "?", args: args.slice(0, 300) });
          if (/work-fold chat report/.test(args)) pendingReports.set((part as { id?: string }).id ?? "", /--task\s+(\S+)/.exec(args)?.[1]?.replace(/[\\"]+$/, "") ?? null);
        }
      }
      if (message.role === "toolResult") {
        summary.toolResultChars += parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0);
        const id = message.toolCallId ?? "";
        if (pendingReports.has(id)) {
          const text = parts.map((part) => part.text ?? "").join("");
          summary.reports.push({ afterCompaction: summary.compactions > 0, accepted: !message.isError && /"resultId"/.test(text), taskArg: pendingReports.get(id)!, result: text.slice(0, 400) });
          pendingReports.delete(id);
        }
      }
    }
    out.push(summary);
  }
  return out;
}

type RequestRecord = { requestId: string; parentRequestId: string | null; childRequestIds: string[]; owner?: { conversationId?: string }; turns: Array<{ taskId: string }>; [key: string]: unknown };
async function readRequests(stateBase: string): Promise<Map<string, RequestRecord>> {
  const records = new Map<string, RequestRecord>();
  const path = join(stateBase, "requests", "requests.jsonl");
  if (!existsSync(path)) return records;
  for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line) as RequestRecord;
      if (record.requestId) records.set(record.requestId, record);
    } catch { /* torn tail */ }
  }
  return records;
}

function collectTree(records: Map<string, RequestRecord>, rootId: string): RequestRecord[] {
  const out: RequestRecord[] = [];
  const visit = (id: string) => {
    const record = records.get(id);
    if (!record) return;
    out.push(record);
    for (const child of record.childRequestIds ?? []) visit(child);
  };
  visit(rootId);
  return out;
}

async function readTurnRecords(stateBase: string): Promise<Array<{ turnId: string; [key: string]: unknown }>> {
  const path = join(stateBase, "turns", "turns.jsonl");
  if (!existsSync(path)) return [];
  const latest = new Map<string, { turnId: string; [key: string]: unknown }>();
  for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
    try {
      const record = JSON.parse(line) as { turnId?: string; record?: { turnId: string } };
      const value = (record.record ?? record) as { turnId: string };
      if (value.turnId) latest.set(value.turnId, { ...value, assistantText: undefined } as { turnId: string });
    } catch { /* torn tail */ }
  }
  return [...latest.values()];
}

/**
 * Stop lane: accept the turn over the local API, wait, press Stop (the same
 * conversation abort route the composer uses, which stops the whole request),
 * then time how long the parent, every child Chat, and the helper take to settle.
 */
async function stopRun(afterSeconds: number): Promise<Record<string, unknown>> {
  const { workFolder } = await json<{ workFolder: { id: string } }>("POST", `${host.origin}/api/work-folders/local-folder`, { workFolderRoot });
  const { conversation } = await json<{ conversation: { id: string } }>("POST", `${host.origin}/api/work-folders/${workFolder.id}/conversations`, { title: "helper-eval stop" });
  const events: Array<{ at: number; type: string; message?: string; toolName?: string; phase?: string }> = [];
  const controller = new AbortController();
  const stream = await fetch(`${host.origin}/api/work-folders/${workFolder.id}/conversations/${conversation.id}/events`, { signal: controller.signal });
  let doneAt: number | null = null;
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf("\n\n");
          const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!data) continue;
          try {
            const event = JSON.parse(data) as { type: string; message?: string; toolName?: string; phase?: string };
            events.push({ at: Date.now(), type: event.type, message: event.message, toolName: event.toolName, phase: event.phase });
            if ((event.type === "done" || event.type === "error") && doneAt === null) doneAt = Date.now();
          } catch { /* ignore */ }
        }
      }
    } catch { /* aborted */ }
  })();
  const sentAt = Date.now();
  await json("POST", `${host.origin}/api/work-folders/${workFolder.id}/conversations/${conversation.id}/messages`, { content: prompt });
  if (stopWhenChild) {
    for (let waited = 0; waited < 600_000; waited += 500) {
      const requests = await readRequests(host.stateBase);
      const root = [...requests.values()].reverse().find((record) => record.owner?.conversationId === conversation.id && !record.parentRequestId);
      const hasChild = (root?.childRequestIds?.length ?? 0) > 0;
      const helperRunning = events.some((event) => event.type === "tool" && event.toolName === "helper" && event.phase === "running");
      if (hasChild || helperRunning || doneAt !== null) break;
      await sleep(500);
    }
  }
  const childSeenAt = Date.now();
  await sleep(afterSeconds * 1000);
  const stopAt = Date.now();
  const abort = await json<Record<string, unknown>>("POST", `${host.origin}/api/work-folders/${workFolder.id}/conversations/${conversation.id}/abort`, {});
  const deadline = Date.now() + 120_000;
  while (doneAt === null && Date.now() < deadline) await sleep(100);
  // Then wait until every request in the tree has settled (or give up).
  let settledTree: RequestRecord[] = [];
  let treeSettledAt: number | null = null;
  while (Date.now() < deadline) {
    const requests = await readRequests(host.stateBase);
    const root = [...requests.values()].reverse().find((record) => record.owner?.conversationId === conversation.id && !record.parentRequestId);
    settledTree = root ? collectTree(requests, root.requestId) : [];
    const open = settledTree.some((record) => ["working", "handed_off"].includes(String(record.state))
      || record.turns.some((turn) => ["accepted", "running"].includes(String((turn as { state?: string }).state))));
    if (!open) { treeSettledAt = Date.now(); break; }
    await sleep(250);
  }
  const tapStatus = await tap();
  controller.abort();
  await reading.catch(() => undefined);
  return {
    conversationId: conversation.id,
    workFolderId: workFolder.id,
    stoppedAfterMs: stopAt - sentAt,
    stoppedAfterChildMs: stopWhenChild ? stopAt - childSeenAt : null,
    abortResponse: abort,
    parentSettledMs: doneAt !== null ? doneAt - stopAt : null,
    treeSettledMs: treeSettledAt !== null ? treeSettledAt - stopAt : null,
    providerInflightAtTreeSettle: tapStatus.inflight,
    toolEventsBeforeStop: events.filter((event) => event.type === "tool" && event.at <= stopAt && event.phase === "running").map((event) => event.toolName),
    lastEvents: events.slice(-8).map((event) => ({ ...event, at: event.at - stopAt })),
  };
}
