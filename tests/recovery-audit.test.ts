import assert from "node:assert/strict";
import test from "node:test";
import { recoveryActivity } from "../scripts/harness-eval/recovery-audit.js";

test("recovery diagnostics distinguish new pages, failed calls and nested successful recoveries", () => {
  const read = (offset: number) => ({ input: { action: "read", id: "ev-a", offset } });
  const calls = [0, 0, 100, 100].map((offset, i) => ({ type: "toolCall", name: "progress", id: `call-${i}`, arguments: read(offset) }));
  const entries = [{ message: { role: "assistant", content: calls } }, ...calls.map((call, i) => ({ message: { role: "toolResult", toolCallId: call.id, isError: i === 3 } })),
    { message: { role: "toolResult", nestedCalls: { calls: [{ name: "progress", arguments: { input: { action: "list" } }, status: "ok" }] } } }];
  const result = recoveryActivity(entries);
  assert.equal(result.reads, 3); assert.equal(result.lists, 1);
  assert.equal(result.repeatedArguments, 1); assert.equal(result.maxSameArguments, 2);
});
