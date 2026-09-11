import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BoundedInferenceError, type BoundedInferenceOutcome, type BoundedInferenceRequest } from "../src/local/agent/bounded-inference.js";
import {
  RestrictedAppInferenceError,
  RestrictedAppInferenceLimiter,
  RestrictedAppInferenceService,
  parseRestrictedAppInferenceRequest,
  type RestrictedAppInferenceLimitOverrides,
  type RestrictedAppInferencePorts,
  type RestrictedAppInferenceScope,
} from "../src/local/agent/restricted-app-inference.js";
import { restrictedAppTaskAuthorityDigest, RestrictedAppTaskError } from "../src/local/agent/restricted-app-tasks.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";

const scope: RestrictedAppInferenceScope = {
  spaceId: "space-one",
  appId: "quotes",
  featureInstallationId: "feature-one",
  digest: "a".repeat(64),
  authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 1 }),
};

const model = { provider: "local", id: "app-model" };

function codeOf(error: unknown): string {
  return error instanceof RestrictedAppInferenceError ? error.code : `not-an-inference-error:${String(error)}`;
}

async function fixture(t: test.TestContext, overrides: RestrictedAppInferenceLimitOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-app-inference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "inference-receipts.jsonl");
  let now = new Date("2026-09-10T12:00:00.000Z");
  const current = new Map<string, RestrictedAppInferenceScope>([[scope.featureInstallationId, structuredClone(scope)]]);
  const calls: BoundedInferenceRequest[] = [];
  const held: Array<(outcome: BoundedInferenceOutcome | Error) => void> = [];
  let behavior: "reply" | "hold" | "fail" = "reply";
  const ports: RestrictedAppInferencePorts = {
    async pin(pinned) {
      // Stands in for the service's installed-revision lookup: the first use of
      // an installation fixes its authority, and `changeScope` moves it.
      const authoritative = current.get(pinned.featureInstallationId) ?? pinned;
      current.set(pinned.featureInstallationId, authoritative);
      if (JSON.stringify(pinned) !== JSON.stringify(authoritative)) {
        throw new RestrictedAppTaskError("TASK_DENIED", "This app's permissions changed. Open the app again.");
      }
    },
    async infer(spaceId, request) {
      assert.equal(spaceId, scope.spaceId);
      calls.push(request);
      if (behavior === "fail") throw new BoundedInferenceError("INFER_MODEL_UNAVAILABLE", "No model.");
      if (behavior === "hold") {
        return await new Promise<BoundedInferenceOutcome>((resolve, reject) => {
          const settle = (value: BoundedInferenceOutcome | Error) => {
            if (value instanceof Error) reject(value);
            else resolve(value);
          };
          held.push(settle);
          request.signal.addEventListener("abort", () => reject(new BoundedInferenceError("INFER_INTERRUPTED", "Interrupted.")), { once: true });
        });
      }
      return request.outputSchema
        ? { kind: "json", json: { echoed: request.input }, model, usage: { inputTokens: 3, outputTokens: 4, amountUsd: 0.002 } }
        : { kind: "text", text: `echo:${request.input}`, truncated: false, model, usage: { inputTokens: 3, outputTokens: 4 } };
    },
  };
  const options = { path, ports, now: () => now, limits: overrides };
  let service = await RestrictedAppInferenceService.create(options);
  return {
    path,
    calls,
    held,
    get service() { return service; },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    behave: (next: typeof behavior) => { behavior = next; },
    changeScope: (next: RestrictedAppInferenceScope) => { current.set(next.featureInstallationId, next); },
    restart: async () => { await service.flush(); service = await RestrictedAppInferenceService.create(options); },
    lines: async () => (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().length).map((line) => JSON.parse(line)),
  };
}

test("an inference request is parsed against every published bound", () => {
  const base = { instructions: "Summarize", input: "North $42" };
  const parsed = parseRestrictedAppInferenceRequest(base);
  assert.equal(parsed.input, "North $42");
  assert.equal(parsed.maxOutputBytes, restrictedAppInferenceLimits.defaultOutputBytes);
  assert.equal(parsed.outputSchema, undefined);
  // Non-text input is serialized once, host-side, so the app cannot control framing.
  assert.equal(parseRestrictedAppInferenceRequest({ ...base, input: { a: 1 } }).input, "{\n  \"a\": 1\n}");
  const schema = { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false };
  assert.deepEqual(parseRestrictedAppInferenceRequest({ ...base, outputSchema: schema }).outputSchema, schema);

  for (const [value, code] of [
    [{ ...base, extra: 1 }, "INFER_INVALID"],
    [{ instructions: "Summarize" }, "INFER_INVALID"],
    [{ ...base, instructions: "" }, "INFER_INVALID"],
    [{ ...base, instructions: 12 }, "INFER_INVALID"],
    [{ ...base, instructions: "Ignore\u0007this" }, "INFER_INVALID"],
    [{ ...base, maxOutputBytes: 0 }, "INFER_INVALID"],
    [{ ...base, maxOutputBytes: restrictedAppInferenceLimits.maxOutputBytes + 1 }, "INFER_INVALID"],
    [{ ...base, outputSchema: { type: "object", properties: {}, required: [] } }, "INFER_INVALID"],
    [{ ...base, outputSchema: { type: "unknown-kind" } }, "INFER_INVALID"],
    [{ ...base, input: "x".repeat(restrictedAppInferenceLimits.inputBytes + 1) }, "INFER_INPUT_TOO_LARGE"],
    ["not an object", "INFER_INVALID"],
  ] as const) {
    assert.throws(() => parseRestrictedAppInferenceRequest(value), (error) => codeOf(error) === code, JSON.stringify(value).slice(0, 60));
  }
  // Every bound names itself so an app can shrink instead of guessing.
  assert.throws(
    () => parseRestrictedAppInferenceRequest({ ...base, input: "x".repeat(restrictedAppInferenceLimits.inputBytes + 1) }),
    /262144-byte limit/,
  );
});

test("a bounded call reaches the transport unprompted and returns text with its model and usage", async (t) => {
  const f = await fixture(t);
  const result = await f.service.infer(scope, "view", { instructions: "Summarize", input: "North $42" });
  assert.deepEqual(result, { text: "echo:North $42", truncated: false, model, usage: { inputTokens: 3, outputTokens: 4 } });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.instructions, "Summarize");
  assert.equal((f.calls[0]?.timeoutMs ?? 0) > 0, true);
  const receipts = await f.lines();
  assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["accepted", "ok"]);
  assert.equal(receipts[0].id, receipts[1].id, "one call is one receipt identity");
  assert.deepEqual(receipts[1].model, model);
  assert.deepEqual(receipts[1].usage, { inputTokens: 3, outputTokens: 4 });
  assert.equal(receipts[1].surface, "view");
  assert.equal(receipts[1].schema, false);
  assert.equal(receipts[1].outputBytes, Buffer.byteLength("echo:North $42"));
});

test("a schema makes the result validated JSON and the usage cost stays off the app's copy", async (t) => {
  const f = await fixture(t);
  const outputSchema = { type: "object", properties: { echoed: { type: "string", maxLength: 100 } }, required: ["echoed"], additionalProperties: false };
  const result = await f.service.infer(scope, "worker", { instructions: "Echo", input: "south", outputSchema });
  assert.deepEqual(result, { json: { echoed: "south" }, model, usage: { inputTokens: 3, outputTokens: 4 } });
  assert.equal("amountUsd" in (result as { usage: Record<string, unknown> }).usage, false);
  const receipts = await f.lines();
  assert.equal(receipts.at(-1).usage.amountUsd, 0.002, "the receipt keeps what the provider charged");
  assert.equal(receipts.at(-1).schema, true);
  assert.equal(receipts.at(-1).surface, "worker");
});

test("four calls run at once per installation, the fifth waits, and a full queue is refused by name", async (t) => {
  const f = await fixture(t, { waitingPerInstallation: 2 });
  f.behave("hold");
  const running = [0, 1, 2, 3].map(() => f.service.infer(scope, "view", { instructions: "Hold", input: "x" }));
  await waitUntil(() => f.calls.length === 4);
  const waiting = [f.service.infer(scope, "view", { instructions: "Hold", input: "x" }), f.service.infer(scope, "view", { instructions: "Hold", input: "x" })];
  await waitUntil(() => f.service.occupancy(scope.featureInstallationId).waiting === 2);
  assert.deepEqual(f.service.occupancy(scope.featureInstallationId), { running: 4, waiting: 2 });
  const refused = await f.service.infer(scope, "view", { instructions: "Hold", input: "x" }).catch((error) => error);
  assert.equal(codeOf(refused), "INFER_BUSY");
  assert.match((refused as Error).message, /4 inference calls running and 2 waiting/);
  assert.match((refused as Error).message, /Settings → The fold → Limits/);
  f.behave("reply");
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "done", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal((await Promise.all(running)).length, 4);
  await waitUntil(() => f.calls.length === 6, "a waiting call starts when a slot frees");
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "done", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal((await Promise.all(waiting)).length, 2);
});

test("the machine-wide running cap holds across installations", async (t) => {
  const f = await fixture(t, { runningPerInstallation: 2, runningMachineWide: 3 });
  f.behave("hold");
  const other = { ...scope, featureInstallationId: "feature-two" };
  const first = [f.service.infer(scope, "view", { instructions: "Hold", input: "x" }), f.service.infer(scope, "view", { instructions: "Hold", input: "x" })];
  await waitUntil(() => f.calls.length === 2);
  // A second installation shares the machine-wide ceiling; only one more starts.
  const second = [f.service.infer(other, "view", { instructions: "Hold", input: "x" }), f.service.infer(other, "view", { instructions: "Hold", input: "x" })];
  await waitUntil(() => f.service.occupancy(other.featureInstallationId).waiting === 1);
  assert.deepEqual(f.service.occupancy(other.featureInstallationId), { running: 1, waiting: 1 });
  assert.equal(f.calls.length, 3);
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "done", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  await waitUntil(() => f.calls.length === 4);
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "done", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  await Promise.all([...first, ...second]);
});

test("a permission change before the call refuses without a receipt, and after the call fails the delivery", async (t) => {
  const f = await fixture(t);
  f.changeScope({ ...scope, authorityDigest: restrictedAppTaskAuthorityDigest({ generation: 2 }) });
  const refused = await f.service.infer(scope, "view", { instructions: "Summarize", input: "x" }).catch((error) => error);
  assert.equal(codeOf(refused), "INFER_UNAVAILABLE");
  assert.match((refused as Error).message, /permissions changed/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.path, "utf8"), /ENOENT/, "a refusal before admission writes nothing");

  f.changeScope(scope);
  f.behave("hold");
  const pending = f.service.infer(scope, "view", { instructions: "Summarize", input: "x" });
  await waitUntil(() => f.calls.length === 1);
  f.changeScope({ ...scope, digest: "b".repeat(64) });
  f.behave("reply");
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "late", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  assert.equal(codeOf(await pending.catch((error) => error)), "INFER_UNAVAILABLE");
  const receipts = await f.lines();
  assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["accepted", "error"]);
  assert.equal(receipts[1].errorCode, "INFER_UNAVAILABLE");
});

test("a transport failure becomes its own code and never carries provider text", async (t) => {
  const f = await fixture(t);
  f.behave("fail");
  const failure = await f.service.infer(scope, "view", { instructions: "Summarize", input: "x" }).catch((error) => error);
  assert.equal(codeOf(failure), "INFER_MODEL_UNAVAILABLE");
  const receipts = await f.lines();
  assert.equal(receipts.at(-1).errorCode, "INFER_MODEL_UNAVAILABLE");
  assert.equal(receipts.at(-1).outcome, "error");
});

test("the total budget covers queue time and stops a call that never settles", async (t) => {
  const f = await fixture(t, { timeoutMs: 60 });
  f.behave("hold");
  const stopped = await f.service.infer(scope, "view", { instructions: "Hold", input: "x" }).catch((error) => error);
  assert.equal(codeOf(stopped), "INFER_INTERRUPTED");
  assert.equal((await f.lines()).at(-1).errorCode, "INFER_INTERRUPTED");
});

test("a caller's abort while waiting for a slot stops that call only", async (t) => {
  const f = await fixture(t, { runningPerInstallation: 1 });
  f.behave("hold");
  const first = f.service.infer(scope, "view", { instructions: "Hold", input: "x" });
  await waitUntil(() => f.calls.length === 1);
  const controller = new AbortController();
  const waiting = f.service.infer(scope, "view", { instructions: "Hold", input: "x" }, { signal: controller.signal });
  await waitUntil(() => f.service.occupancy(scope.featureInstallationId).waiting === 1);
  controller.abort();
  assert.equal(codeOf(await waiting.catch((error) => error)), "INFER_INTERRUPTED");
  assert.equal(f.calls.length, 1, "the abandoned call never reached the model");
  for (const settle of f.held.splice(0)) settle({ kind: "text", text: "done", truncated: false, model, usage: { inputTokens: 1, outputTokens: 1 } });
  await first;
});

test("receipts survive a restart, list newest first for the installation, and a damaged journal never stops the app", async (t) => {
  const f = await fixture(t);
  await f.service.infer(scope, "view", { instructions: "One", input: "1" });
  f.advance(1_000);
  await f.service.infer(scope, "view", { instructions: "Two", input: "2" });
  await f.restart();
  const listed = await f.service.list(scope);
  assert.equal(listed.length, 4, "an accepted and a terminal line per call");
  assert.equal(listed[0].outcome, "ok");
  assert.equal(new Date(listed[0].at) >= new Date(listed.at(-1)!.at), true, "newest first");

  // A code change hides the earlier revision's receipts from the bridge but
  // leaves the whole installation visible to the Apps tab.
  const changed = { ...scope, digest: "c".repeat(64) };
  f.changeScope(changed);
  assert.equal((await f.service.list(changed)).length, 0);
  assert.equal((await f.service.list(changed, { ownership: "installation" })).length, 4);

  await f.service.flush();
  await writeFile(f.path, "{\"v\":1,\"id\":\"not-a-uuid\"}\n", "utf8");
  await f.restart();
  assert.equal((await f.service.list(changed, { ownership: "installation" })).length, 0);
  const after = await f.service.infer(changed, "view", { instructions: "Three", input: "3" });
  assert.equal("text" in after, true, "attribution damage never disables the lane");
});

test("the limiter releases exactly once and reports its own occupancy", async (t) => {
  void t;
  const limiter = new RestrictedAppInferenceLimiter({ runningPerInstallation: 1, waitingPerInstallation: 1, runningMachineWide: 4 });
  const controller = new AbortController();
  const release = await limiter.acquire("one", controller.signal);
  assert.deepEqual(limiter.snapshot("one"), { running: 1, waiting: 0 });
  release();
  release();
  assert.deepEqual(limiter.snapshot("one"), { running: 0, waiting: 0 });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(limiter.acquire("one", aborted.signal), (error) => codeOf(error) === "INFER_INTERRUPTED");
});

async function waitUntil(condition: () => boolean, message = "condition was never met"): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}
