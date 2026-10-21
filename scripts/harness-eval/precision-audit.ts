/** Supplemental exactness audit. Original frozen grades are never overwritten. */
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { repairSource } from "./fixtures.js";
import { aggregateFrozenTrials, sha256 } from "./frozen.js";

const exec = promisify(execFile);
export interface PrecisionCase { name: string; rows: Array<{ currency: string; amount: string; status: string }>; expected: Record<string, string> }
export function checkPrecisionCases(summarize: (rows: PrecisionCase["rows"]) => unknown, cases: PrecisionCase[]) {
  const failures: Array<{ name: string; expected: unknown; actual?: unknown; error?: string }> = [];
  for (const item of cases) {
    try { const actual = summarize(item.rows); if (!isDeepStrictEqual(actual, item.expected)) failures.push({ name: item.name, expected: item.expected, actual }); }
    catch (error) { failures.push({ name: item.name, expected: item.expected, error: String(error) }); }
  }
  return { passed: cases.length - failures.length, total: cases.length, failures };
}

const checkerFiles = ["scripts/harness-eval/precision-audit.ts", "scripts/harness-eval/precision-cases.json", "scripts/harness-eval/fixtures.ts", "scripts/harness-eval/frozen.ts"];
async function checkerHashes() { return Object.fromEntries(await Promise.all(checkerFiles.map(async path => [path, sha256(await readFile(path))]))); }
const arg = (name: string) => { const at = process.argv.indexOf(name); const value = at < 0 ? undefined : process.argv[at + 1]; if (!value) throw new Error(`${name} is required`); return value; };

async function main() {
  if (process.argv.includes("--freeze")) {
    const manifest = { version: 1, createdAt: new Date().toISOString(), nodeVersion: process.version, checkerFiles: await checkerHashes() };
    await writeFile(arg("--freeze"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    console.log(JSON.stringify(manifest)); return;
  }
  const manifestPath = resolve(arg("--manifest")); const manifestBytes = await readFile(manifestPath); const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.nodeVersion !== process.version || !isDeepStrictEqual(manifest.checkerFiles, await checkerHashes())) throw new Error("The supplemental precision checker changed after freezing");
  const inputPath = resolve(arg("--results")); const phase = JSON.parse(await readFile(inputPath, "utf8"));
  const casesPath = fileURLToPath(new URL("./precision-cases.json", import.meta.url));
  const rows: any[] = [];
  for (const row of phase.rows) {
    let precision: ReturnType<typeof checkPrecisionCases> | { error: string } | null = null;
    if (row.scenario === "repair") {
      try {
        const meta = JSON.parse(await readFile(join(row.directory, "case.json"), "utf8"));
        const folder = await mkdtemp(join(tmpdir(), "work-fold-frozen-precision-"));
        await writeFile(join(folder, "ledger.mjs"), repairSource);
        await exec("git", ["apply", "--check", join(meta.folder, "candidate.patch")], { cwd: folder, timeout: 30_000 });
        await exec("git", ["apply", join(meta.folder, "candidate.patch")], { cwd: folder, timeout: 30_000 });
        const resultPath = join(folder, "precision-result.json");
        const script = `import{readFileSync,writeFileSync}from'node:fs';import{checkPrecisionCases}from ${JSON.stringify(import.meta.url)};import{summarize}from ${JSON.stringify(pathToFileURL(join(folder, "ledger.mjs")).href)};const cases=JSON.parse(readFileSync(${JSON.stringify(casesPath)},'utf8')).cases;writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(checkPrecisionCases(summarize,cases),(_key,value)=>typeof value==='bigint'?{bigint:value.toString()}:value));`;
        await writeFile(join(folder, "audit.mjs"), script);
        await exec(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), join(folder, "audit.mjs")], { cwd: folder, env: { PATH: process.env.PATH }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        precision = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (error) { precision = { error: error instanceof Error ? error.message : String(error) }; }
    }
    const precisionPassed = precision === null || ("passed" in precision && precision.passed === precision.total);
    const outcome = row.outcome === "passed" && precisionPassed ? "passed" : "failed";
    rows.push({ ...row, originalOutcome: row.outcome, outcome, precisionAudit: precision,
      settledDoneWithInvalidOutput: row.settledDoneWithInvalidOutput || (row.requestState === "done" && outcome !== "passed") });
  }
  if (!isDeepStrictEqual(manifest.checkerFiles, await checkerHashes())) throw new Error("Precision checker changed during the audit");
  const output = { ...phase, supplementalManifest: manifestPath, supplementalManifestSha256: sha256(manifestBytes), originalResults: inputPath, rows, groups: aggregateFrozenTrials(rows) };
  const outputPath = join(resolve(inputPath, ".."), "audited-results.json");
  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ output: outputPath, passed: rows.filter(row => row.outcome === "passed").length, total: rows.length, precisionFailures: rows.filter(row => row.precisionAudit && ("error" in row.precisionAudit || row.precisionAudit.passed !== row.precisionAudit.total)).map(row => row.id) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
