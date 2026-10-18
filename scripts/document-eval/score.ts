#!/usr/bin/env tsx
/**
 * Prints Markdown tables from the document-checking evaluation's summaries.
 *
 * Usage: tsx scripts/document-eval/score.ts <runs-dir> [condition...]
 * Each condition is a folder written by run.ts (default: engines no-engines baseline).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [runsArgument, ...requested] = process.argv.slice(2);
const runs = resolve(runsArgument ?? ".");
const conditions = requested.length ? requested : ["engines", "no-engines", "no-libreoffice", "baseline"];
const summaries: any[] = [];
for (const condition of conditions) {
  const path = join(runs, condition, "summaries.json");
  if (existsSync(path)) summaries.push(...JSON.parse(await readFile(path, "utf8")).map((item: any) => ({ ...item, condition })));
}

const yes = (value: boolean) => value ? "yes" : "no";
const checksDone = (item: any) => `${item.behavior.engineStatus} / ${item.behavior.renders}${item.behavior.previews ? ` (+${item.behavior.previews} previews)` : ""} / ${item.behavior.recalculations} / ${item.behavior.imagesViewed}`;
const says = (item: any) => {
  const text = String(item.finalMessage ?? "");
  return [/check|verif|render|recalcul|look/i.test(text) ? "says what it checked" : "", /couldn.t|could not|wasn.t able|not able|unable|not (?:visually )?(?:checked|verified|calculated)|without libreoffice/i.test(text) ? "names a gap" : "", /set up/i.test(text) ? "points to Set Up" : ""].filter(Boolean).join(", ") || "none";
};
const row = (cells: unknown[]) => `| ${cells.join(" | ")} |`;

console.log("## Budget workbook\n");
console.log(row(["Condition", "Run", "Minutes", "Status / render / recalc / images", "Correct after recalculation", "Correct as delivered (cached)", "Formulas", "Formats", "Errors", "Final message"]));
console.log(row(Array(10).fill("---")));
for (const item of summaries.filter((entry) => entry.task === "budget")) {
  const check = item.check;
  console.log(row([item.condition, item.attempt, item.minutes, checksDone(item), check.exists ? `${check.calculatedCorrect}/${check.checks}` : "missing", check.exists ? `${check.cachedCorrect}/${check.checks}` : "", check.formulasOk ?? "", check.formatsOk ?? "", check.errorsAfterRecalculation?.length ?? "", says(item)]));
}

console.log("\n## Slide deck\n");
console.log(row(["Condition", "Run", "Minutes", "Status / render / recalc / images", "Slides", "Findings word for word", "Slides with text outside its box", "Autofit used", "Outside its box without autofit", "Final message"]));
console.log(row(Array(10).fill("---")));
for (const item of summaries.filter((entry) => entry.task === "deck")) {
  const check = item.check;
  console.log(row([item.condition, item.attempt, item.minutes, checksDone(item), check.slides ?? "missing", `${check.findingsWordForWord ?? 0}/8`, (check.slidesWithTextOutsideItsBox ?? []).join(", ") || "none", (check.autofit ?? []).length ? `slides ${check.autofit.join(", ")}` : "no", check.slidesWithTextOutsideItsBoxWithoutAutofit ? check.slidesWithTextOutsideItsBoxWithoutAutofit.join(", ") || "none" : "n/a", says(item)]));
}

console.log("\n## Word report\n");
console.log(row(["Condition", "Run", "Minutes", "Status / render / recalc / images", "Letter portrait", "Table rows × columns", "Workstreams / owners shown", "Pages", "Narrowest column (in)", "Final message"]));
console.log(row(Array(10).fill("---")));
for (const item of summaries.filter((entry) => entry.task === "report")) {
  const check = item.check;
  const letter = Array.isArray(check.pageInches) && Math.abs(check.pageInches[0] - 8.5) < 0.05 && Math.abs(check.pageInches[1] - 11) < 0.05;
  console.log(row([item.condition, item.attempt, item.minutes, checksDone(item), check.exists ? yes(letter) : "missing", check.mainTable ? `${check.mainTable.rows} × ${check.mainTable.columns}` : "none", `${check.workstreamsShown ?? 0} / ${check.ownersShown ?? 0}`, check.pages ?? "", check.narrowestColumnInches ?? "", says(item)]));
}
