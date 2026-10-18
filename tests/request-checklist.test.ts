import assert from "node:assert/strict";
import test from "node:test";

import { createChecklistTool, describeChecklist } from "../src/local/agent/checklist-tool.js";
import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { parseWorkFoldChecklistItems } from "../src/local/requests/request-records.js";
import { workFoldRequestLimits } from "../src/shared/work-fold-limits.js";

test("checklist items are one-line steps with a known status, within generous bounds", () => {
  assert.deepEqual(parseWorkFoldChecklistItems([{ text: "  Read the\nquotes ", status: "doing" }]), [{ text: "Read the quotes", status: "doing" }]);
  assert.deepEqual(parseWorkFoldChecklistItems([]), []);
  assert.throws(() => parseWorkFoldChecklistItems([{ text: " ", status: "todo" }]), /cannot be empty/);
  assert.throws(() => parseWorkFoldChecklistItems([{ text: "Step", status: "later" }]), /status is invalid/);
  assert.throws(() => parseWorkFoldChecklistItems([{ text: "Step", status: "todo", extra: true }]), /unexpected field/);
  assert.throws(() => parseWorkFoldChecklistItems(Array.from({ length: workFoldRequestLimits.maxChecklistItems + 1 }, (_, index) => ({ text: `Step ${index}`, status: "todo" }))), /at most 200 items/);
});

test("the checklist tool saves the whole list for the running turn and reads it back", async () => {
  const saved: unknown[] = [];
  const tool = createChecklistTool({
    taskId: () => "task-running",
    host: { async set({ taskId, items }) { saved.push({ taskId, items }); const parsed = parseWorkFoldChecklistItems(items); return parsed.length ? { items: parsed, updatedAt: "2026-10-18T00:00:00.000Z", taskId } : null; } },
  });
  const result = await tool.execute("call-1", { items: [{ text: "Read the quotes", status: "done" }, { text: "Compare totals", status: "doing" }] }, undefined, undefined, undefined as never);
  assert.deepEqual(saved, [{ taskId: "task-running", items: [{ text: "Read the quotes", status: "done" }, { text: "Compare totals", status: "doing" }] }]);
  assert.match((result.content[0] as { text: string }).text, /1 of 2 done/);
  assert.match((result.content[0] as { text: string }).text, /\[x\] Read the quotes\n\[~\] Compare totals/);
  const cleared = await tool.execute("call-2", { items: [] }, undefined, undefined, undefined as never);
  assert.equal((cleared.content[0] as { text: string }).text, "Checklist cleared.");
  const outside = createChecklistTool({ taskId: () => undefined, host: { async set() { throw new Error("not reached"); } } });
  await assert.rejects(outside.execute("call-3", { items: [] }, undefined, undefined, undefined as never), /only inside a running turn/);
});

test("a later turn of the same request gets its checklist back in the turn context", () => {
  const items = [{ text: "Read the quotes", status: "done" as const }, { text: "Write the summary", status: "todo" as const }];
  const message = buildTurnContextMessage({ checklist: items });
  assert.match(message, /Your checklist for this request so far/);
  assert.ok(message.includes(describeChecklist(items)));
  assert.doesNotMatch(buildTurnContextMessage({}), /checklist/i);
});
