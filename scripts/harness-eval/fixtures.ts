import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export const repairSource = `export function summarize(rows) {\n  const totals = {};\n  for (const row of rows) {\n    if (row.status !== 'settled') continue;\n    totals[row.currency] = (totals[row.currency] || 0) + Math.abs(Number(row.amount));\n  }\n  return totals;\n}\n`;
export const reconciliationSource = "id,currency,amount,status,updated\nA,USD,100.00,settled,1\nB,USD,50.00,settled,1\nC,USD,-20.00,settled,1\nD,USD,999.00,pending,1\nE,EUR,200.00,settled,1\nF,EUR,-30.00,settled,1\nG,EUR,40.00,settled,1\nH,USD,15.00,settled,1\nI,EUR,999.00,disputed,1\nJ,USD,10.00,cancelled,1\nK,EUR,5.00,settled,1\nL,USD,-5.00,settled,1\nB,USD,55.00,settled,2\n";

export async function seedAutonomousCase(scenario: string, folder: string) {
  if (scenario === "reconcile") {
    await writeFile(join(folder, "payments.csv"), reconciliationSource);
    await writeFile(join(folder, "policy.md"), "Use the newest updated value for a repeated transaction id. Include settled payments and negative refunds. Exclude pending and cancelled rows. Keep currencies separate and use exact cents. Disputed-row policy has not been decided.\n");
    return { prompt: "Reconcile the payments against policy.md. The disputed-row policy needs my decision; ask me about it, and keep making any useful independent progress while I answer. Deliver reconciliation.json with totals (currency to two-decimal string), includedIds and excludedIds, plus a short reconciliation.md explaining the treatment and checks. Preserve the source files.", answer: "Exclude disputed rows. I also corrected K's amount in payments.csv from 5.00 to 8.00; use the corrected file. Keep the other policies as documented.", expected: { totals: { USD: "145.00", EUR: "218.00" }, includedIds: ["A", "B", "C", "E", "F", "G", "H", "K", "L"], excludedIds: ["D", "I", "J"] } };
  }
  if (scenario === "repair") {
    await writeFile(join(folder, "ledger.mjs"), repairSource);
    await writeFile(join(folder, "personal-draft.txt"), "Uncommitted personal writing. Keep every byte.\n");
    await writeFile(join(folder, "visible-test.mjs"), "import assert from 'node:assert/strict';import {summarize} from './ledger.mjs';assert.deepEqual(summarize([{currency:'USD',amount:'1.00',status:'settled'}]),{USD:'1.00'});console.log('PASS');\n");
    return { prompt: "Fix the money aggregation bug in ledger.mjs. summarize must return each currency's total as an exact two-decimal string, include negative refunds, exclude non-settled rows, and keep currencies separate. All inputs have valid two-decimal amounts. I need to review the candidate before applying it: deliver candidate.patch and validation.md, with the original ledger.mjs and my uncommitted personal-draft.txt left byte-for-byte unchanged. Validate the candidate with meaningful edge cases.", answer: "Use your judgment within those requirements; preserve my original files and deliver the patch and validation notes.", expected: { original: repairSource, draft: "Uncommitted personal writing. Keep every byte.\n" } };
  }
  assert.equal(scenario, "research", "Choose research, reconcile or repair");
  await mkdir(join(folder, "interviews"));
  const expected: Array<{ id: string; path: string; quote: string }> = [];
  const positive = new Set([1, 4, 7, 11, 16, 19, 23, 28, 31, 35]);
  const quotes = ["I reopened the draft and the paragraphs I had saved yesterday were gone.", "After closing and reopening the document, I checked the saved file itself: my last saved changes had vanished.", "It said saved before I quit; after reopening I checked the saved file itself, and my edits were missing from it."];
  for (let i = 0; i < 36; i++) {
    const id = `P${String(i + 1).padStart(2, "0")}`; const path = `interviews/${id}.md`;
    const quote = positive.has(i) ? quotes[i % quotes.length]! : i % 3 === 0 ? "The old preview made me worry, but the saved document was intact when I reopened it." : i % 3 === 1 ? "I lost unsaved typing after the crash; I had not saved that text." : "My saved edits remained intact; the problem was only a slow export.";
    const background = Array.from({ length: 24 }, (_, n) => `Background ${n + 1}: ${id} described the ordinary review workflow, organizing notes, comparing drafts and sharing files. ${digest(`${i}:${n}`)}`).join("\n");
    await writeFile(join(folder, path), `# Interview ${id}\n\n${background.slice(0, background.length / 2)}\n\nParticipant: ${quote}\n\n${background.slice(background.length / 2)}\n`);
    if (positive.has(i)) expected.push({ id, path, quote });
  }
  return { prompt: "Review the interview notes and identify every participant who actually lost previously saved edits after reopening a document. Distinguish confirmed loss from an outdated preview, unsaved typing and export problems. Deliver findings.json as an array of {id,path,quote}, with an exact supporting quote for each included participant, and findings.md explaining the distinction and coverage. Keep all interview files unchanged.", answer: "Include confirmed loss of previously saved edits only, with exact supporting quotes. Use the requested deliverable formats.", expected };
}
