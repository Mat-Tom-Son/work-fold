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
  inputSchema: { type: "object", properties: { quote: { type: "string", maxLength: 8_192 } }, required: ["quote"], additionalProperties: false } };
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
      assert.equal(durable.records.find((item: any) => item.id === record.id).status, "dispatching", "approval is durable before a Chat can be accepted");
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

test("app Assistant requests are inert, exact-reviewed and idempotently dispatched into their own Chat", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const [first, replay] = await Promise.all([f.service.request(scope, request), f.service.request(scope, request)]);
  assert.deepEqual(first, replay);
  assert.equal(first.status, "pending");
  assert.equal(f.dispatched.length, 0);
  assert.deepEqual(Object.keys(first).sort(), ["actionId", "createdAt", "id", "requestId", "status", "title", "updatedAt"]);
  await assert.rejects(f.service.request(scope, { ...request, input: { quote: "different" } }), /different input/);
  await assert.rejects(f.service.approve(scope, request.requestId, "invented"), /Review it again/);
  const review = await f.service.review(scope, request.requestId);
  assert.equal(review.conversationId, null);
  assert.equal(review.instructions, action.instructions);
  assert.equal(review.inputJson, '{"quote":"North: $42"}');
  const [accepted, retry] = await Promise.all([f.service.approve(scope, request.requestId, review.reviewDigest), f.service.approve(scope, request.requestId, review.reviewDigest)]);
  assert.equal(accepted.status, "running");
  assert.deepEqual(retry, accepted);
  assert.equal(f.dispatched.length, 1);
  assert.equal((await f.service.review(scope, request.requestId)).conversationId, f.dispatched[0]!.conversationId);
  const turn = f.turns.get(first.id)!;
  turn.assistantText = "Private partial thought must not be delivered while running";
  assert.equal((await f.service.get(scope, request.requestId)).result, undefined);
  turn.status = "succeeded";
  turn.assistantText = "Comparison saved to comparison.md. North is cheaper.";
  assert.deepEqual((await f.service.get(scope, request.requestId)).result, { text: turn.assistantText, truncated: false });
  await f.restart();
  assert.equal((await f.service.approve(scope, request.requestId, review.reviewDigest)).status, "succeeded");
  assert.equal(f.dispatched.length, 1);
});

test("app Assistant requests deny malformed, oversized, undeclared, stale and foreign inputs", async (t) => {
  const f = await fixture(t);
  for (const bad of [null, {}, f.request({ requestId: "" }), f.request({ requestedAt: "yesterday" }), f.request({ actionId: "fold" }),
    f.request({ spaceId: "other" }), f.request({ input: { quote: "x", arbitrary: true } }), f.request({ input: { quote: "界".repeat(4_000) } }),
    f.request({ requestedAt: "2026-09-07T13:00:00.000Z" })]) await assert.rejects(f.service.request(scope, bad));
  const request = f.request();
  await f.service.request(scope, request);
  const review = await f.service.review(scope, request.requestId);
  for (const key of ["spaceId", "appId", "featureInstallationId", "digest", "authorityDigest"] as const) {
    const foreign = { ...scope, [key]: `different-${key}` };
    f.changeScope(foreign);
    await assert.rejects(f.service.get(foreign, request.requestId), /unavailable to this app revision/);
    await assert.rejects(f.service.approve(scope, request.requestId, review.reviewDigest), /stale or foreign/);
  }
  f.changeScope(scope);
  await assert.rejects(f.service.request(scope, f.request(), () => { throw new Error("view revoked"); }), /view revoked/);
  assert.equal((await f.service.list(scope)).length, 1);
  assert.equal(f.dispatched.length, 0);
});

test("uncertain admission and restart reconcile the accepted task without replay or private error leaks", async (t) => {
  for (const behavior of ["before-failure", "after-failure", "missing"] as const) {
    await t.test(behavior, async (t) => {
      const f = await fixture(t);
      f.dispatchBehavior(behavior);
      const request = f.request();
      const pending = await f.service.request(scope, request);
      const review = await f.service.review(scope, request.requestId);
      const accepted = await f.service.approve(scope, request.requestId, review.reviewDigest);
      assert.equal(accepted.status, behavior === "after-failure" ? "running" : behavior === "missing" ? "interrupted" : "failed");
      assert.ok(!JSON.stringify(accepted).includes("secret"));
      if (behavior === "after-failure") f.turns.get(pending.id)!.status = "interrupted";
      await f.restart();
      assert.equal((await f.service.approve(scope, request.requestId, review.reviewDigest)).status, behavior === "before-failure" ? "failed" : "interrupted");
      assert.equal(f.dispatched.length, 1);
    });
  }
});

test("pending dismissal and running cancellation affect only the owned task and await actual settlement", async (t) => {
  const f = await fixture(t);
  const pending = await f.service.request(scope, f.request());
  assert.equal((await f.service.cancel(scope, pending.requestId)).status, "cancelled");
  const cancelledReview = await f.service.review(scope, pending.requestId);
  await assert.rejects(f.service.approve(scope, pending.requestId, cancelledReview.reviewDigest), /no longer waiting/);
  const running = await f.service.request(scope, f.request());
  const review = await f.service.review(scope, running.requestId);
  await f.service.approve(scope, running.requestId, review.reviewDigest);
  const stop = await f.service.cancel(scope, running.requestId);
  assert.equal(stop.status, "running");
  assert.equal(stop.cancellationRequested, true);
  assert.deepEqual(f.cancelled, [`turn-${running.id}`]);
  f.turns.get(running.id)!.status = "aborted";
  assert.equal((await f.service.get(scope, running.requestId)).status, "cancelled");
  assert.equal((await f.service.get(scope, pending.requestId)).status, "cancelled");
});

test("request capacity, review expiry and timestamp-based replay refusal survive pruning", async (t) => {
  const f = await fixture(t);
  const original = f.request();
  await f.service.request(scope, original);
  for (let index = 0; index < 3; index++) await f.service.request(scope, f.request());
  await assert.rejects(f.service.request(scope, f.request()), /Finish or dismiss/);
  f.advance(24 * 60 * 60_000 + 1);
  assert.equal((await f.service.get(scope, original.requestId)).status, "expired");
  const review = await f.service.review(scope, original.requestId);
  await assert.rejects(f.service.approve(scope, original.requestId, review.reviewDigest), /no longer waiting/);
  f.advance(24 * 60 * 60_000 + 1);
  await f.service.request(scope, f.request());
  await assert.rejects(f.service.request(scope, original), /too old/);
  assert.equal((await f.service.list(scope)).length, 1);
});

test("one app cannot multiply concurrent tasks and final replies are bounded UTF-8", async (t) => {
  const f = await fixture(t);
  const first = await f.service.request(scope, f.request());
  const second = await f.service.request(scope, f.request());
  const firstReview = await f.service.review(scope, first.requestId);
  const secondReview = await f.service.review(scope, second.requestId);
  await f.service.approve(scope, first.requestId, firstReview.reviewDigest);
  await assert.rejects(f.service.approve(scope, second.requestId, secondReview.reviewDigest), /already has an Assistant task/);
  const turn = f.turns.get(first.id)!;
  turn.status = "succeeded";
  turn.assistantText = "🐈".repeat(20_000);
  const result = (await f.service.get(scope, first.requestId)).result!;
  assert.equal(Buffer.byteLength(result.text), 32_768);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes("�"));
  await f.service.approve(scope, second.requestId, secondReview.reviewDigest);
  assert.equal(f.dispatched.length, 2);
});

test("foreign turn responses fail closed; damaged journals disable only the task lane without overwriting evidence", async (t) => {
  const f = await fixture(t);
  const first = await f.service.request(scope, f.request());
  const review = await f.service.review(scope, first.requestId);
  await f.service.approve(scope, first.requestId, review.reviewDigest);
  f.turns.get(first.id)!.spaceId = "foreign";
  await assert.rejects(f.service.get(scope, first.requestId), /outcome is unavailable/);
  f.turns.get(first.id)!.spaceId = scope.spaceId;
  const file = join(f.root, "tasks.json");
  const good = JSON.parse(await readFile(file, "utf8"));
  for (const modify of [
    (data: any) => { data.schema = "legacy.tasks"; },
    (data: any) => { data.records.push(data.records[0]); },
    (data: any) => { data.records[0].inputJson = '{}'; },
    (data: any) => { data.records[0].scope.extra = "power"; },
    (data: any) => { data.records[0].approvedAt = 0; },
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
