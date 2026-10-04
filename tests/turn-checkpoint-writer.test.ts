import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { TurnCheckpointWriter, type TurnCheckpointWriterPorts } from "../src/local/agent/turn-checkpoint-writer.js";

function fixture(t: TestContext, overrides: Partial<TurnCheckpointWriterPorts> = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const active = new Map([["chat", "task-1"]]);
  const text = new Map([["chat", "first"]]);
  const writes: Array<{ taskId: string; text: string }> = [];
  const failures: Array<{ error: unknown; operation: "checkpoint" | "flush" }> = [];
  const writer = new TurnCheckpointWriter({
    activeTask: (key) => active.get(key),
    activeTasks: () => active,
    currentText: (key) => text.get(key) ?? "",
    writeCheckpoint: async (taskId, value) => { writes.push({ taskId, text: value }); },
    reportFailure: (error, operation) => { failures.push({ error, operation }); },
    ...overrides,
  });
  t.after(() => writer.close());
  return { writer, active, text, writes, failures };
}

test("stream checkpoints batch for 500ms and read the latest text without startup replay", async (t) => {
  const { writer, text, writes } = fixture(t);
  t.mock.timers.tick(5_000);
  assert.deepEqual(writes, [], "an active task alone never schedules work");
  writer.schedule("inactive");
  writer.schedule("chat");
  t.mock.timers.tick(250);
  text.set("chat", "latest streamed text");
  writer.schedule("chat");
  t.mock.timers.tick(249);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(writes, [{ taskId: "task-1", text: "latest streamed text" }]);
  t.mock.timers.tick(5_000);
  assert.equal(writes.length, 1, "a checkpoint never starts an unattended cadence");
});

test("a stale timer cannot checkpoint the replacement task in the same Chat", async (t) => {
  const { writer, active, text, writes } = fixture(t);
  writer.schedule("chat");
  active.set("chat", "task-2");
  text.set("chat", "replacement text");
  t.mock.timers.tick(500);
  assert.deepEqual(writes, []);
  writer.schedule("chat");
  t.mock.timers.tick(500);
  assert.deepEqual(writes, [{ taskId: "task-2", text: "replacement text" }]);
});

test("replacing a task gives it a fresh batch and obsolete flushes leave that timer intact", async (t) => {
  const { writer, active, text, writes } = fixture(t);
  writer.schedule("chat");
  t.mock.timers.tick(100);
  active.set("chat", "task-2");
  text.set("chat", "replacement text");
  writer.schedule("chat");
  await writer.flush("chat", "task-1");
  assert.deepEqual(writes, []);
  t.mock.timers.tick(400);
  assert.deepEqual(writes, []);
  t.mock.timers.tick(100);
  assert.deepEqual(writes, [{ taskId: "task-2", text: "replacement text" }]);
});

test("settlement and cancellation flush the current task and clear its pending timer", async (t) => {
  const { writer, active, text, writes } = fixture(t);
  writer.schedule("chat");
  text.set("chat", "partial response before stop");
  await writer.flush("chat", "task-1");
  active.delete("chat");
  t.mock.timers.tick(1_000);
  await writer.flush("chat", "task-1");
  assert.deepEqual(writes, [{ taskId: "task-1", text: "partial response before stop" }]);
});

test("shutdown clears orphan timers, flushes active streams once, and prevents rescheduling", async (t) => {
  const { writer, active, text, writes } = fixture(t);
  writer.schedule("chat");
  active.set("orphan", "task-orphan");
  writer.schedule("orphan");
  active.delete("orphan");
  active.set("unscheduled", "task-unscheduled");
  text.set("unscheduled", "last unscheduled text");
  const closing = writer.close();
  assert.equal(writer.close(), closing);
  await closing;
  assert.deepEqual(writes, [
    { taskId: "task-1", text: "first" },
    { taskId: "task-unscheduled", text: "last unscheduled text" },
  ]);
  active.set("orphan", "task-new");
  writer.schedule("orphan");
  t.mock.timers.tick(10_000);
  assert.equal(writes.length, 2);
});

test("an obsolete task flush waits for its own in-flight checkpoint without reading replacement text", async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const observed: string[] = [];
  const { writer, active, text } = fixture(t, {
    writeCheckpoint: async (taskId, value) => { observed.push(`${taskId}:${value}`); await pending; },
  });
  writer.schedule("chat");
  t.mock.timers.tick(500);
  active.set("chat", "task-2");
  text.set("chat", "replacement");
  let flushed = false;
  const flushing = writer.flush("chat", "task-1").then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  assert.deepEqual(observed, ["task-1:first"]);
  release();
  await flushing;
  assert.equal(flushed, true);
});

test("shutdown drains a timer write even after its task is removed from the active list", async (t) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { writer, active } = fixture(t, { writeCheckpoint: async () => pending });
  writer.schedule("chat");
  t.mock.timers.tick(500);
  active.clear();
  let closed = false;
  const closing = writer.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

test("checkpoint and flush errors are reported without retrying or poisoning later writes", async (t) => {
  const failure = new Error("disk unavailable");
  let fail = true;
  let calls = 0;
  const { writer, failures } = fixture(t, {
    writeCheckpoint: async () => { calls += 1; if (fail) throw failure; },
  });
  writer.schedule("chat");
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.deepEqual(failures, [{ error: failure, operation: "checkpoint" }]);
  t.mock.timers.tick(5_000);
  assert.equal(calls, 1, "failed writes are not replayed by the scheduler");
  await writer.flush("chat", "task-1");
  assert.deepEqual(failures.at(-1), { error: failure, operation: "flush" });
  fail = false;
  writer.schedule("chat");
  t.mock.timers.tick(500);
  await Promise.resolve();
  assert.equal(calls, 3);
  assert.equal(failures.length, 2);
});
