/** Supplemental diagnostics, independent of the unchanged frozen outcome checker. */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, stableJson } from "./frozen.js";

export function recoveryActivity(entries: any[]) {
  const results = entries.map(entry => entry.message).filter(message => message?.role === "toolResult");
  const calls = entries.flatMap(entry => entry.message?.role === "assistant" ? entry.message.content
    .filter((part: any) => part.type === "toolCall")
    .map((call: any) => ({ name: call.name, arguments: call.arguments, ok: results.some(result => result.toolCallId === call.id && !result.isError) })) : []);
  calls.push(...results.flatMap(result => (result.nestedCalls?.calls ?? []).map((call: any) => ({ name: call.name, arguments: call.arguments, ok: call.status === "ok" }))));
  const ranges = new Map<string, number>(); let reads = 0; let lists = 0;
  for (const call of calls) {
    const input = call.arguments?.input;
    if (!call.ok || call.name !== "progress" || !["read", "list"].includes(input?.action)) continue;
    if (input.action === "read") reads++; else lists++;
    const key = stableJson(input);
    ranges.set(key, (ranges.get(key) ?? 0) + 1);
  }
  return { reads, lists, repeatedArguments: [...ranges.values()].reduce((n, count) => n + count - 1, 0),
    maxSameArguments: Math.max(0, ...ranges.values()), ranges: Object.fromEntries(ranges) };
}

async function sessions(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await sessions(child));
    else if (entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}
async function main() {
  const at = process.argv.indexOf("--results");
  if (at < 0 || !process.argv[at + 1]) throw new Error("--results <phase/results.json> is required");
  const path = resolve(process.argv[at + 1]); const phase = JSON.parse(await readFile(path, "utf8"));
  const rows = [];
  for (const row of phase.rows) {
    const files = await sessions(join(row.directory, "host", "pi-agent", "sessions", "work-fold"));
    if (!files.length) throw new Error(`No native sessions found for ${row.id}`);
    const journals = await Promise.all(files.map(async file => ({ file, activity: recoveryActivity((await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line))) })));
    rows.push({ id: row.id, journals });
  }
  const output = { analyzerSha256: sha256(await readFile(fileURLToPath(import.meta.url))), results: path,
    interpretation: "Repeated successful recovery arguments are a proxy. Index contents, freshness or purpose may have changed; no call is classified as unnecessary.", rows };
  const outputPath = join(resolve(path, ".."), "recovery-audit.json");
  await writeFile(outputPath, JSON.stringify(output, null, 2)); console.log(outputPath);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
