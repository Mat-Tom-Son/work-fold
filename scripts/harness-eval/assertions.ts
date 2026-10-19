import assert from "node:assert/strict";

/** Fixture-specific goldens allow surrounding verbatim context, never paraphrase. */
export function assertExactSupportingQuote(actual: unknown, expected: string, source: string): void {
  assert.ok(typeof actual === "string" && actual.length >= 35 && source.includes(actual)
    && (actual.includes(expected) || expected.includes(actual))
    && /reopen/i.test(actual) && /saved/i.test(actual) && /missing|vanished|gone/i.test(actual),
  "Expected a verbatim source quote supporting reopening, saved content and loss; surrounding source context is allowed.");
}
