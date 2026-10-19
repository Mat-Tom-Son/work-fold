import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkPrecisionCases, type PrecisionCase } from "../scripts/harness-eval/precision-audit.js";

test("the supplemental verifier catches floating-point cents accepted by small-value tests", async () => {
  const cases: PrecisionCase[] = JSON.parse(await readFile(new URL("../scripts/harness-eval/precision-cases.json", import.meta.url), "utf8")).cases;
  const approximate = (rows: PrecisionCase["rows"]) => {
    const totals: Record<string, number> = {};
    for (const row of rows) if (row.status === "settled") totals[row.currency] = (totals[row.currency] ?? 0) + Math.round(Number(row.amount) * 100);
    return Object.fromEntries(Object.entries(totals).map(([currency, value]) => [currency, (value / 100).toFixed(2)]));
  };
  assert.deepEqual(approximate([{ currency: "USD", amount: "0.10", status: "settled" }, { currency: "USD", amount: "0.20", status: "settled" }]), { USD: "0.30" });
  const result = checkPrecisionCases(approximate, cases);
  assert.ok(result.failures.some(item => item.name === "large-9007199254740991-10"));
  assert.ok(result.failures.some(item => item.name.startsWith("cancellation-")));
  assert.ok(result.passed < result.total);
  const exact = (rows: PrecisionCase["rows"]) => {
    const totals: Record<string, bigint> = {};
    for (const row of rows) if (row.status === "settled") totals[row.currency] = (totals[row.currency] ?? 0n) + BigInt(row.amount.replace(".", ""));
    return Object.fromEntries(Object.entries(totals).map(([currency, value]) => { const sign = value < 0n ? "-" : ""; const amount = value < 0n ? -value : value; return [currency, `${sign}${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`]; }));
  };
  assert.equal(checkPrecisionCases(exact, cases).passed, cases.length);
  assert.equal(checkPrecisionCases(() => { throw new Error("unsupported range"); }, cases).passed, 0);
});
