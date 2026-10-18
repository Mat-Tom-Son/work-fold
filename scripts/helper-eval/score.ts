#!/usr/bin/env tsx
/**
 * Scores helper-evaluation runs against the hidden expectations and prints a
 * per-task table of quality, parent-context growth, usage, cost and latency.
 * Quality checks are line-level evidence (the right file and the right value
 * on the same line or table row); every answer should still be read by a
 * person, and `--answers` prints them for that.
 *
 * Usage: tsx scripts/helper-eval/score.ts --fixtures <dir> <campaign-dir>... [--answers] [--json <out>]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface Result {
  runId: string; taskId: string; arm: string; rep: number; outcome: string; latencyMs: number | null; answer: string | null;
  parent: { modelCalls: number; firstContextTokens: number; lastContextTokens: number; peakContextTokens: number; contextGrowthTokens: number; toolResultChars: number;
    toolCalls: Array<{ name: string; args: string }>; continuation?: { turns: number; modelCalls: number; costUsd: number } } | null;
  children: Array<{ modelCalls: number; toolResultChars: number; usage: { costUsd: number } }>;
  providerCalls: { total: { calls: number; promptTokens: number; cachedTokens: number; outputTokens: number; reasoningTokens: number; costUsd: number };
    byPurpose: Record<string, { calls: number; promptTokens: number; outputTokens: number; costUsd: number }> };
  turnRecords: Array<{ helpers?: Array<{ outcome: string; modelCalls: number; activity: unknown[] }> }>;
  stop: unknown;
}

const args = process.argv.slice(2);
const fixtures = resolve(args[args.indexOf("--fixtures") + 1]!);
const showAnswers = args.includes("--answers");
const jsonOut = args.includes("--json") ? resolve(args[args.indexOf("--json") + 1]!) : null;
const campaigns = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--fixtures" && args[index - 1] !== "--json");
const expected = JSON.parse(await readFile(join(fixtures, "expected.json"), "utf8")) as Record<string, { answer: any }>;

const results: Result[] = [];
for (const campaign of campaigns) {
  for (const task of await readdir(campaign)) {
    const dir = join(campaign, task, "results");
    if (!existsSync(dir)) continue;
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".json") && !name.includes("-stop"))) {
      results.push(JSON.parse(await readFile(join(dir, file), "utf8")) as Result);
    }
  }
}

const lines = (text: string) => text.split(/\n/);
const has = (line: string, ...needles: Array<string | RegExp>) => needles.every((needle) => typeof needle === "string" ? line.includes(needle) : needle.test(line));
const anyLine = (text: string, ...needles: Array<string | RegExp>) => lines(text).some((line) => has(line, ...needles));

/** Sections of an answer keyed by the (a)/(b)/(c) or A/B/C markers the question asked for. */
function sections(text: string): Record<"a" | "b" | "c", string> {
  const out = { a: "", b: "", c: "" };
  let current: "a" | "b" | "c" | null = null;
  for (const line of lines(text)) {
    const marker = /^\s*(?:#+\s*|\*\*)?\(?([abcABC])[).:]\s/.exec(line) ?? /^\s*#+\s*(?:Part\s+)?\(?([abcABC])\)?\b/.exec(line);
    if (marker) current = marker[1]!.toLowerCase() as "a" | "b" | "c";
    if (current) out[current] += `${line}\n`;
  }
  if (out.a || out.b || out.c) return out;
  // No (a)/(b)/(c) markers: take the answer's first three headings in order.
  const keys = ["a", "b", "c"] as const;
  let index = -1;
  for (const line of lines(text)) {
    if (/^\s*#{1,4}\s/.test(line) && index < 2) index += 1;
    if (index >= 0) out[keys[index]!] += `${line}\n`;
  }
  return out;
}

type Score = { points: number; max: number; notes: string[] };

function scoreOffice(answer: string): Score {
  const notes: string[] = [];
  let points = 0;
  const check = (ok: boolean, label: string) => { if (ok) points += 1; else notes.push(`missing ${label}`); };
  const firstLines = lines(answer).filter((line) => line.trim()).slice(0, 3).join(" ");
  check(/17 May 2027|May 17,? 2027|2027-05-17/.test(firstLines), "final date up front");
  check(anyLine(answer, /W0?5\b|week 0?5\b/i, /1 March|March 1/), "W05 → 1 March");
  check(anyLine(answer, /W11\b|week 11\b/i, /12 April|April 12/), "W11 → 12 April");
  check(anyLine(answer, /W19\b|week 19\b/i, /17 May|May 17/), "W19 → 17 May");
  check(anyLine(answer, "launch-plan", /12 April|April 12/), "launch-plan.md stale");
  check(anyLine(answer, "faq-for-staff", /1 March|March 1/), "faq-for-staff.md stale");
  if (anyLine(answer, /opening|opens|go-live/i, /2 May 2027|May 2,? 2027/) && !anyLine(answer, /handover/i, /2 May/)) { points -= 1; notes.push("treats 2 May as the opening"); }
  return { points, max: 6, notes };
}

function scoreTravel(answer: string): Score {
  const notes: string[] = [];
  let points = 0;
  const check = (ok: boolean, label: string, value = 1) => { if (ok) points += value; else notes.push(`missing ${label}`); };
  check(/\$220/.test(answer), "$220");
  check(anyLine(answer, /\$220/, /2026[- ]amendments/i), "$220 source");
  check(/£260/.test(answer), "£260");
  check(anyLine(answer, /£260/, /emea-v2|version 2|EMEA \(version 2\)/i), "£260 source");
  check(/\$75/.test(answer), "$75");
  check(anyLine(answer, /\$75/, /2026[- ]amendments/i), "$75 source");
  check(anyLine(answer, "faq", /\$190/), "faq.md $190");
  const handbook = lines(answer).filter((line) => /onboarding-handbook|New starter handbook/i.test(line)).join(" ");
  check(/\$65/.test(handbook), "handbook $65", 0.5);
  check(/£230/.test(handbook), "handbook £230", 0.5);
  for (const wrong of ["expense-tool-help", "learning-budget", "relocation.md"]) {
    const flagged = lines(answer).some((line) => line.includes(wrong) && /incorrect|wrong|outdated|stale|\$190|\$65|£230/i.test(line)
      && !/current|correct|matches|consistent|right/i.test(line));
    if (flagged) { points -= 1; notes.push(`flags ${wrong}`); }
  }
  return { points, max: 8, notes };
}

function scoreRename(answer: string, key: any): Score {
  const notes: string[] = [];
  const part = sections(answer);
  const filesIn = (text: string) => new Set([...text.matchAll(/[\w./-]+\.md/g)].map((match) => match[0].replace(/^\.\//, "")));
  const a = filesIn(part.a);
  const needs: string[] = key.needsChange;
  const found = needs.filter((file) => a.has(file));
  const extras = [...a].filter((file) => !needs.includes(file));
  if (found.length < needs.length) notes.push(`(a) missing ${needs.filter((file) => !a.has(file)).join(", ")}`);
  if (extras.length) notes.push(`(a) extra ${extras.join(", ")}`);
  const b = part.b;
  const bChecks = [/ORBIT_API_KEY/.test(b), /partners\.md/.test(b), /astronomy/.test(b), /orbit-logistics\.md|Orbit Logistics/.test(b)];
  ["ORBIT_API_KEY", "partners.md", "astronomy post", "Orbit Logistics name"].forEach((label, index) => { if (!bChecks[index]) notes.push(`(b) missing ${label}`); });
  const c = filesIn(part.c);
  const internal: string[] = key.internalOnly;
  const cFound = internal.filter((file) => c.has(file));
  if (cFound.length < internal.length) notes.push(`(c) missing ${internal.filter((file) => !c.has(file)).join(", ")}`);
  const points = (found.length / needs.length) * 4 - extras.length * 0.5 + bChecks.filter(Boolean).length * 0.75 + (cFound.length / internal.length);
  return { points: Math.round(points * 100) / 100, max: 8, notes };
}

function scoreExport(answer: string, key: any): Score {
  const notes: string[] = [];
  let points = 0;
  for (const reporter of key.reporters as Array<{ name: string; version: string; file: string }>) {
    const base = reporter.file.split("/").pop()!;
    const ok = anyLine(answer, reporter.name, base) && anyLine(answer, reporter.name, new RegExp(`\\b${reporter.version.replace(/\./g, "\\.")}\\b`));
    if (ok) points += 1;
    else notes.push(`missing ${reporter.name} ${reporter.version}`);
  }
  for (const distractor of key.distractors as Array<{ name: string; file: string }>) {
    const base = distractor.file.split("/").pop()!;
    if (lines(answer).some((line) => line.includes(base) && !/import|PDF|works great|not (?:the|an?) export|excluded|not included|isn't|wasn't|not count/i.test(line))) {
      points -= 1;
      notes.push(`includes ${distractor.name}`);
    }
  }
  return { points, max: 5, notes };
}

function score(result: Result): Score {
  const answer = result.answer ?? "";
  const key = expected[result.taskId]!.answer;
  if (!answer) return { points: 0, max: 1, notes: ["no answer"] };
  switch (result.taskId) {
    case "office-launch": return scoreOffice(answer);
    case "travel-policy": return scoreTravel(answer);
    case "rename-survey": return scoreRename(answer, key);
    case "export-bug": return scoreExport(answer, key);
    default: return { points: 0, max: 1, notes: ["unknown task"] };
  }
}

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const range = (values: number[], digits = 0) => values.length
  ? `${mean(values).toFixed(digits)} (${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)})`
  : "–";

const rows: Array<Record<string, unknown>> = [];
const order = ["a", "b", "c", "c0"];
const tasks = [...new Set(results.map((result) => result.taskId))].sort();
for (const task of tasks) {
  console.log(`\n### ${task}\n`);
  console.log("| Arm | n | Quality | Parent growth (tokens) | Parent peak | Total prompt tokens | Output tokens | Cost (USD) | Latency (s) | Calls (session/title/helper) | Helper used |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const arm of order) {
    const group = results.filter((result) => result.taskId === task && result.arm === arm).sort((left, right) => left.rep - right.rep);
    if (!group.length) continue;
    const scores = group.map(score);
    const helperRuns = group.map((result) => result.turnRecords.flatMap((record) => record.helpers ?? []).length);
    const by = (purpose: string) => group.map((result) => result.providerCalls.byPurpose[purpose]?.calls ?? 0);
    console.log(`| ${arm} | ${group.length} | ${scores.map((item) => `${item.points}/${item.max}`).join(", ")} | ${range(group.map((result) => result.parent?.contextGrowthTokens ?? NaN))} | ${range(group.map((result) => result.parent?.peakContextTokens ?? NaN))} | ${range(group.map((result) => result.providerCalls.total.promptTokens))} | ${range(group.map((result) => result.providerCalls.total.outputTokens))} | ${range(group.map((result) => result.providerCalls.total.costUsd), 4)} | ${range(group.map((result) => (result.latencyMs ?? NaN) / 1000), 1)} | ${mean(by("session")).toFixed(1)}/${mean(by("title")).toFixed(1)}/${mean(by("helper")).toFixed(1)} | ${helperRuns.join(",")} |`);
    for (const [index, result] of group.entries()) {
      rows.push({
        runId: result.runId, task, arm, rep: result.rep, quality: scores[index]!.points, qualityMax: scores[index]!.max, notes: scores[index]!.notes,
        parentGrowth: result.parent?.contextGrowthTokens, parentPeak: result.parent?.peakContextTokens, parentToolResultChars: result.parent?.toolResultChars,
        promptTokens: result.providerCalls.total.promptTokens, cachedTokens: result.providerCalls.total.cachedTokens, outputTokens: result.providerCalls.total.outputTokens,
        costUsd: result.providerCalls.total.costUsd, latencyS: (result.latencyMs ?? NaN) / 1000, byPurpose: result.providerCalls.byPurpose,
        continuation: result.parent?.continuation, helperRuns: helperRuns[index], children: result.children.length,
      });
    }
    const flagged = group.map((result, index) => ({ runId: result.runId, notes: scores[index]!.notes })).filter((item) => item.notes.length);
    for (const item of flagged) console.log(`|  | ${item.runId} | ${item.notes.join("; ")} | | | | | | | | |`);
  }
}
if (showAnswers) {
  for (const result of results.sort((left, right) => left.runId.localeCompare(right.runId))) {
    console.log(`\n===== ${result.runId}\n${result.answer}`);
  }
}
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify(rows, null, 2)}\n`);
