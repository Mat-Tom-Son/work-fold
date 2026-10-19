import assert from "node:assert/strict";
import test from "node:test";
import { assertExactSupportingQuote } from "../scripts/harness-eval/assertions.js";

test("autonomous quote verification accepts verbatim context and rejects paraphrase or incomplete support", () => {
  const quote = "After closing and reopening the document, I checked the saved file itself: my last saved changes had vanished.";
  const source = `# Interview\nParticipant: ${quote}\nEnd.`;
  assertExactSupportingQuote(quote, quote, source);
  assertExactSupportingQuote(`Participant: ${quote}`, quote, source);
  assertExactSupportingQuote("reopening the document, I checked the saved file itself: my last saved changes had vanished.", quote, source);
  assert.throws(() => assertExactSupportingQuote("I reopened it and the saved changes disappeared.", quote, source), /verbatim/);
  assert.throws(() => assertExactSupportingQuote("I checked the saved file itself: my last saved changes had vanished.", quote, source), /reopening/);
  assert.throws(() => assertExactSupportingQuote(quote, quote, "Different source"), /verbatim/);
});
