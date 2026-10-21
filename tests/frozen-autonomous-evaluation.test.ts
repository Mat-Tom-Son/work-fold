import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFrozenTrials, autonomousHostArguments, frozenTrials, sha256, stableJson, summarizeAutonomousTrace } from "../scripts/harness-eval/frozen.js";

test("normal autonomous trials leave native compaction defaults intact", () => {
  assert.deepEqual(autonomousHostArguments([]), []);
  assert.deepEqual(autonomousHostArguments(["--compact-at", "18000", "--keep-recent", "2000", "--out", "unused"]), ["--compact-at", "18000", "--keep-recent", "2000"]);
  assert.throws(() => autonomousHostArguments(["--keep-recent", "2000"]), /requires --compact-at/);
  assert.throws(() => autonomousHostArguments(["--compact-at", "--out"]), /requires a value/);
});

test("frozen trials cover every cell equally and aggregation retains failures", () => {
  const trials = frozenTrials(3);
  assert.equal(trials.length, 36); assert.equal(new Set(trials.map(trial => trial.id)).size, 36);
  const rows = trials.map(trial => ({ ...trial, outcome: trial.repetition === 2 ? "failed" : "passed", durationSeconds: trial.repetition * 10, settledDoneWithInvalidOutput: trial.repetition === 2 }));
  const groups = aggregateFrozenTrials(rows);
  assert.equal(groups.length, 12);
  for (const group of groups) { assert.equal(group.passed, 2); assert.equal(group.total, 3); assert.equal(group.medianSeconds, 20); assert.equal(group.settledDoneWithInvalidOutput, 1); }
  assert.throws(() => frozenTrials(1), /at least two/);
});

test("read repetition distinguishes changed source bytes, selection and errors", () => {
  const entries: any[] = [];
  for (const [index, hash, limit, failed] of [[1, "a", 20, false], [2, "a", 20, false], [3, "b", 20, false], [4, "a", 10, false], [5, "a", 20, true]] as const) {
    const id = `call-${index}`;
    entries.push({ message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "/folder/input.txt", limit } }] } },
      { message: { role: "toolResult", toolCallId: id, isError: failed } },
      { type: "custom", customType: "work-fold-progress.v1", data: { kind: "observation", tool: "read", taskId: "task", id: `ev-${sha256(`task\0${id}`).slice(0, 20)}`, sourceBinding: "bracketed", sources: [{ path: "input.txt", sha256: hash }] } });
  }
  // An untracked shell input is never counted as an unchanged read.
  entries.push({ message: { role: "toolResult", nestedCalls: { calls: [{ id: "nested", name: "read", status: "ok", arguments: { path: "input.txt", limit: 20 } }] } } });
  const summary = summarizeAutonomousTrace(entries, [{ usage: { prompt_tokens: 12, completion_tokens: 3 } }, { status: 503 }], "/folder");
  assert.equal(summary.repeatedUnchangedReads, 1); assert.equal(summary.readsWithFingerprints, 4);
  assert.equal(summary.providerInputTokens, 12); assert.equal(summary.maxProviderInputTokens, 12);
  assert.equal(summary.providerCallsWithoutUsage, 1); assert.equal(summary.providerFailures, 1);
});

test("fixture digests ignore key ordering and change with the expected answer", () => {
  assert.equal(stableJson({ prompt: "same", expected: { b: 2, a: 1 } }), stableJson({ expected: { a: 1, b: 2 }, prompt: "same" }));
  assert.notEqual(sha256(stableJson({ expected: 1 })), sha256(stableJson({ expected: 2 })));
});
