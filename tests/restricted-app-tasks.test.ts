import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RestrictedAppTaskService, restrictedAppTaskTurnRequestId, restrictedAppTaskAuthorityDigest, type RestrictedAppTaskPorts, type RestrictedAppTaskReceipt, type RestrictedAppTaskScope } from "../src/local/agent/restricted-app-tasks.js";
import type { RestrictedAppAssistantAction } from "../src/local/agent/restricted-app-manifest.js";
import type { WorkFoldDurableTurnRecord } from "../src/local/agent/turn-store.js";

const action: RestrictedAppAssistantAction = { id: "compare", title: "Compare quotes", instructions: "Compare the submitted quotes and write comparison.md.",
  inputSchema: { type: "object", properties: { quote: { type: "string", maxLength: 70_000 } }, required: ["quote"], additionalProperties: false } };
const scope: RestrictedAppTaskScope = { spaceId: "space-one", appId: "quotes", featureInstallationId: "feature-one", digest: "a".repeat(64), authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 1 }) };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-tasks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-09-07T12:00:00.000Z");
  let current = structuredClone(scope);
  const turns = new Map<string, WorkFoldDurableTurnRecord>();
  const dispatched: RestrictedAppTaskReceipt[] = [];
  const cancelled: string[] = [];
  let dispatchBehavior: "normal" | "before-failure" | "after-failure" | "missing" = "normal";
  const ports: RestrictedAppTaskPorts = {
    async withApp(pin, operation) { assert.deepEqual(pin, current, "host rejects stale or foreign authority"); return operation([action]); },
    async dispatch(record) {
      dispatched.push(record);
      const durable = JSON.parse(await readFile(join(root, "tasks.json"), "utf8"));
      assert.equal(durable.records.find((item: any) => item.id === record.id).status, "dispatching", "the receipt is durable before a Chat can be accepted");
      if (dispatchBehavior === "before-failure") throw new Error("private provider secret");
      if (dispatchBehavior !== "missing") turns.set(record.id, { schema: "work-fold.turn.v1", turnId: `turn-${record.id}`,
        requestId: restrictedAppTaskTurnRequestId(record), requestDigest: "d".repeat(64), userMessageId: `message-${record.id}`,
        userMessageCreatedAt: now.toISOString(), spaceId: record.scope.spaceId, conversationId: record.conversationId,
        actorKind: "system", status: "running", userMessagePersisted: true, acceptedAt: now.toISOString(), updatedAt: now.toISOString(), assistantText: "" });
      if (dispatchBehavior === "after-failure") throw new Error("uncertain transport failure");
    },
    findTurn(record) { return turns.get(record.id) ?? null; },
    async cancelTurn(record, turnId) { assert.equal(turnId, turns.get(record.id)?.turnId); cancelled.push(turnId); },
  };
  const options = { path: join(root, "tasks.json"), ports, now: () => now };
  let service = await RestrictedAppTaskService.create(options);
  return { root, ports, turns, dispatched, cancelled, get service() { return service; },
    request: (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), requestedAt: now.toISOString(), actionId: action.id, input: { quote: "North: $42" }, ...extra }),
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    changeScope: (next: RestrictedAppTaskScope) => { current = next; },
    dispatchBehavior: (next: typeof dispatchBehavior) => { dispatchBehavior = next; },
    restart: async () => { await service.flush(); service = await RestrictedAppTaskService.create(options); },
  };
}

test("app Assistant requests are journaled then dispatched once into their own Chat, and replay returns the same record", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const [first, replay] = await Promise.all([f.service.request(scope, request), f.service.request(scope, request)]);
  assert.deepEqual(first, replay);
  assert.equal(first.status, "running");
  assert.equal(f.dispatched.length, 1, "one envelope dispatches exactly one Chat");
  assert.deepEqual(Object.keys(first).sort(), ["actionId", "createdAt", "id", "requestId", "startedAt", "status", "title", "updatedAt"]);
  assert.equal("approvedAt" in first, false);
  await assert.rejects(f.service.request(scope, { ...request, input: { quote: "different" } }), /different input/);
  const detail = await f.service.detail(scope, request.requestId);
  assert.equal(detail.conversationId, f.dispatched[0]!.conversationId);
  assert.equal(detail.instructions, action.instructions);
  assert.equal(detail.inputJson, '{"quote":"North: $42"}');
  const turn = f.turns.get(first.id)!;
  turn.assistantText = "Private partial thought must not be delivered while running";
  assert.equal((await f.service.get(scope, request.requestId)).result, undefined);
  turn.status = "succeeded";
  turn.assistantText = "Comparison saved to comparison.md. North is cheaper.";
  assert.deepEqual((await f.service.get(scope, request.requestId)).result, { text: turn.assistantText, truncated: false });
  await f.restart();
  assert.equal((await f.service.request(scope, request)).status, "succeeded");
  assert.equal(f.dispatched.length, 1, "restart never redispatches");
});

test("app Assistant requests deny malformed, oversized, undeclared, stale and foreign inputs before any journal entry", async (t) => {
  const f = await fixture(t);
  for (const bad of [null, {}, f.request({ requestId: "" }), f.request({ requestedAt: "yesterday" }), f.request({ actionId: "fold" }),
    f.request({ spaceId: "other" }), f.request({ input: { quote: "x", arbitrary: true } }),
    f.request({ requestedAt: "2026-09-07T13:00:00.000Z" })]) await assert.rejects(f.service.request(scope, bad));
  await assert.rejects(f.service.request(scope, f.request({ input: { quote: "界".repeat(22_000) } })), /64 KiB.*Limits/);
  const request = f.request();
  await f.service.request(scope, request);
  for (const key of ["spaceId", "appId", "featureInstallationId", "digest", "authorityDigest"] as const) {
    const foreign = { ...scope, [key]: `different-${key}` };
    f.changeScope(foreign);
    await assert.rejects(f.service.get(foreign, request.requestId), /unavailable to this app revision/);
    await assert.rejects(f.service.request(scope, f.request()), /stale or foreign/);
  }
  f.changeScope(scope);
  await assert.rejects(f.service.request(scope, f.request(), () => { throw new Error("view revoked"); }), /view revoked/);
  assert.equal((await f.service.list(scope)).length, 1, "a refused request leaves no receipt");
  assert.equal(f.dispatched.length, 1);
});

test("uncertain admission and restart reconcile the dispatched task without replay or private error leaks", async (t) => {
  for (const behavior of ["before-failure", "after-failure", "missing"] as const) {
    await t.test(behavior, async (t) => {
      const f = await fixture(t);
      f.dispatchBehavior(behavior);
      const request = f.request();
      const task = await f.service.request(scope, request);
      assert.equal(task.status, behavior === "after-failure" ? "running" : behavior === "missing" ? "interrupted" : "failed");
      assert.ok(!JSON.stringify(task).includes("secret"));
      if (behavior === "after-failure") f.turns.get(task.id)!.status = "interrupted";
      await f.restart();
      assert.equal((await f.service.request(scope, request)).status, behavior === "before-failure" ? "failed" : "interrupted");
      assert.equal(f.dispatched.length, 1);
    });
  }
});

test("stopping a running task requests cancellation and settles only when the turn actually aborts", async (t) => {
  const f = await fixture(t);
  const running = await f.service.request(scope, f.request());
  const stop = await f.service.cancel(scope, running.requestId);
  assert.equal(stop.status, "running");
  assert.equal(stop.cancellationRequested, true);
  assert.deepEqual(f.cancelled, [`turn-${running.id}`]);
  f.turns.get(running.id)!.status = "aborted";
  assert.equal((await f.service.get(scope, running.requestId)).status, "cancelled");
  assert.deepEqual(await f.service.cancel(scope, running.requestId), await f.service.get(scope, running.requestId), "a settled task ignores a second stop");
});

test("four requests run per installation, the fifth names the limit, and old receipts prune with their timestamps", async (t) => {
  const f = await fixture(t);
  const original = f.request();
  await f.service.request(scope, original);
  const others = [];
  for (let index = 0; index < 3; index++) others.push(await f.service.request(scope, f.request()));
  await assert.rejects(f.service.request(scope, f.request()), (error: any) => error.code === "TASK_CONFLICT" && /4 Assistant requests/.test(error.message) && /Limits/.test(error.message));
  f.turns.get(others[0]!.id)!.status = "succeeded";
  f.turns.get(others[0]!.id)!.assistantText = "done";
  const admitted = await f.service.request(scope, f.request());
  assert.equal(admitted.status, "running", "settling one admits the next");
  for (const task of await f.service.list(scope)) { const turn = f.turns.get(task.id)!; turn.status = "succeeded"; turn.assistantText = "done"; }
  await f.service.list(scope); // settle every receipt at the current clock
  f.advance(24 * 60 * 60_000 + 1);
  await f.service.request(scope, f.request());
  await assert.rejects(f.service.request(scope, original), /too old/);
  assert.equal((await f.service.list(scope)).length, 1, "terminal receipts older than a day prune on submission");
});

test("final replies are bounded UTF-8 at 256 KiB", async (t) => {
  const f = await fixture(t);
  const first = await f.service.request(scope, f.request());
  const turn = f.turns.get(first.id)!;
  turn.status = "succeeded";
  turn.assistantText = "🐈".repeat(80_000);
  const result = (await f.service.get(scope, first.requestId)).result!;
  assert.equal(Buffer.byteLength(result.text), 262_144);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes("�"));
});

test("foreign turn responses fail closed; damaged journals disable only the task lane without overwriting evidence", async (t) => {
  const f = await fixture(t);
  const first = await f.service.request(scope, f.request());
  f.turns.get(first.id)!.spaceId = "foreign";
  await assert.rejects(f.service.get(scope, first.requestId), /outcome is unavailable/);
  f.turns.get(first.id)!.spaceId = scope.spaceId;
  const file = join(f.root, "tasks.json");
  const good = JSON.parse(await readFile(file, "utf8"));
  assert.equal(good.schema, "work-fold.app-assistant-tasks.v2");
  for (const modify of [
    (data: any) => { data.schema = "legacy.tasks"; },
    (data: any) => { data.records.push(data.records[0]); },
    (data: any) => { data.records[0].inputJson = '{}'; },
    (data: any) => { data.records[0].scope.extra = "power"; },
    (data: any) => { data.records[0].startedAt = 0; },
    (data: any) => { data.records[0].status = "pending"; },
  ]) {
    const data = structuredClone(good);
    modify(data);
    await writeFile(file, JSON.stringify(data));
    await f.restart();
    await assert.rejects(f.service.list(scope), { code: "TASK_UNAVAILABLE" });
    await assert.rejects(f.service.request(scope, f.request()), { code: "TASK_UNAVAILABLE" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), data);
  }
  await writeFile(file, JSON.stringify(good));
  await f.restart();
});

test("the trusted Apps tab sees an installation's tasks across revisions while the bridge stays revision-pinned", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const task = await f.service.request(scope, request);
  const next: RestrictedAppTaskScope = { ...scope, digest: "b".repeat(64), authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 2 }) };
  f.changeScope(next);
  await assert.rejects(f.service.get(next, request.requestId), /unavailable to this app revision/);
  assert.deepEqual(await f.service.list(next), [], "the bridge under the new revision cannot see the old revision's task");
  assert.equal((await f.service.list(next, "installation"))[0]?.id, task.id);
  assert.equal((await f.service.detail(next, request.requestId, "installation")).conversationId, task.id ? `chat-app-${task.id}` : "");
  const stopped = await f.service.cancel(next, request.requestId, () => {}, "installation");
  assert.equal(stopped.cancellationRequested, true);
  assert.deepEqual(f.cancelled, [`turn-${task.id}`]);
  const other: RestrictedAppTaskScope = { ...next, featureInstallationId: "feature-two" };
  f.changeScope(other);
  assert.deepEqual(await f.service.list(other, "installation"), [], "another installation never sees it");
});

test("a v1 journal loads with its inert and expired requests stopped and is rewritten as v2 on the next save", async (t) => {
  const f = await fixture(t);
  const file = join(f.root, "tasks.json");
  const started = await f.service.request(scope, f.request());
  const good = JSON.parse(await readFile(file, "utf8"));
  const [running] = good.records;
  const legacy = (overrides: Record<string, unknown>) => {
    const { startedAt: _startedAt, ...rest } = running;
    const id = randomUUID();
    const requestId = randomUUID();
    return { ...rest, id, requestId, conversationId: `chat-app-${id}`, ...overrides };
  };
  const v1 = { schema: "work-fold.app-assistant-tasks.v1", records: [
    { ...running, approvedAt: running.startedAt, startedAt: undefined },
    legacy({ status: "pending" }),
    legacy({ status: "expired" }),
  ].map((record) => JSON.parse(JSON.stringify(record))) };
  await writeFile(file, JSON.stringify(v1));
  await f.restart();
  const tasks = await f.service.list(scope);
  assert.deepEqual(tasks.map((task) => task.status).sort(), ["cancelled", "cancelled", "running"]);
  assert.equal(tasks.find((task) => task.id === started.id)?.startedAt, running.startedAt);
  assert.ok(tasks.every((task) => typeof task.startedAt === "string"));
  assert.equal(f.dispatched.length, 1, "loading never dispatches a legacy inert request");
  await f.service.request(scope, f.request());
  assert.equal(JSON.parse(await readFile(file, "utf8")).schema, "work-fold.app-assistant-tasks.v2");
});
