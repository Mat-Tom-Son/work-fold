import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  BoundedInferenceError,
  boundedInferenceMaxTokens,
  boundedInferenceResultToolName,
  boundedInferenceSystemPrompt,
  buildBoundedInferenceContext,
  runBoundedInference,
  type BoundedInferenceContext,
  type BoundedInferenceSession,
  type BoundedInferenceStreamOptions,
  type BoundedInferenceStreamResult,
} from "../src/local/agent/bounded-inference.js";
import { parseRestrictedAppJsonSchema } from "../src/local/agent/restricted-app-manifest.js";
import { restrictedAppInferenceLimits } from "../src/shared/restricted-app-inference.js";

const model = { provider: "test", id: "space-model", maxTokens: 8192, contextWindow: 128_000 };
const schema = parseRestrictedAppJsonSchema({
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "number" }, note: { type: "string", maxLength: 20 } },
});
const usage = { input: 20, output: 10, cost: { total: 0.01 } };

type Reply = Partial<BoundedInferenceStreamResult> | ((options: BoundedInferenceStreamOptions | undefined) => Promise<BoundedInferenceStreamResult>);
function fakeSession(reply: Reply, options: { levels?: readonly ("off" | "low" | "high")[]; model?: typeof model | null } = {}) {
  const calls: Array<{ model: unknown; context: BoundedInferenceContext; options: BoundedInferenceStreamOptions | undefined }> = [];
  const session: BoundedInferenceSession & { prompt(): never; messages: unknown[] } = {
    model: options.model === undefined ? model : options.model,
    messages: [{ role: "user", content: "PRIVATE SPACE CONVERSATION" }],
    getAvailableThinkingLevels: () => options.levels ?? ["off"],
    prompt: () => { throw new Error("Must not enter a turn"); },
    agent: {
      streamFn: async (streamModel, context, streamOptions) => {
        calls.push({ model: streamModel, context, options: streamOptions });
        return {
          result: async () => typeof reply === "function"
            ? reply(streamOptions)
            : { stopReason: "stop" as const, content: [], usage, ...reply },
        };
      },
    },
  };
  return { session, calls };
}
function request(overrides: Partial<Parameters<typeof runBoundedInference>[1]> = {}) {
  return { instructions: "Summarize the sales figures.", input: "North $42\nSouth $17", maxOutputBytes: 4096, timeoutMs: 5_000, signal: new AbortController().signal, ...overrides };
}
async function rejectsWith(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<BoundedInferenceError> {
  let caught: unknown;
  await promise.then(() => assert.fail(`expected ${code}`), (error) => { caught = error; });
  assert.ok(caught instanceof BoundedInferenceError, `expected a BoundedInferenceError, received ${String(caught)}`);
  assert.equal(caught.code, code);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

test("text inference sends one untrusted user message on the configured stream path and never enters a turn", async () => {
  const { session, calls } = fakeSession({ content: [{ type: "thinking" }, { type: "text", text: "North leads " }, { type: "text", text: "by $25." }] });
  const input = request();
  const outcome = await runBoundedInference(session, input);
  assert.deepEqual(outcome, { kind: "text", text: "North leads by $25.", truncated: false, model: { provider: "test", id: "space-model" }, usage: { inputTokens: 20, outputTokens: 10, amountUsd: 0.01 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, model);
  const context = calls[0]!.context;
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, input.input);
  assert.equal("tools" in context, false);
  assert.ok(context.systemPrompt.startsWith(boundedInferenceSystemPrompt));
  assert.match(context.systemPrompt, /untrusted/);
  assert.match(context.systemPrompt, /App instructions:\nSummarize the sales figures\.$/);
  assert.ok(!JSON.stringify(context).includes("PRIVATE SPACE CONVERSATION"));
  const options = calls[0]!.options!;
  assert.equal(options.signal, input.signal);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.timeoutMs, 5_000);
  assert.equal(options.maxTokens, boundedInferenceMaxTokens(model, 4096));
  assert.equal(options.maxTokens, 2048);
  assert.equal("reasoning" in options, false);
});

test("reasoning is requested only when the model offers a level other than off", async () => {
  const { session, calls } = fakeSession({ content: [{ type: "text", text: "ok" }] }, { levels: ["off", "low", "high"] });
  await runBoundedInference(session, request());
  assert.equal(calls[0]!.options!.reasoning, "low");
});

test("json inference carries the app schema as the single submit_result tool and returns plain validated data", async () => {
  const submitted = { total: 59, note: "two regions" };
  const { session, calls } = fakeSession({ stopReason: "toolUse", content: [{ type: "toolCall", name: boundedInferenceResultToolName, arguments: submitted }] });
  const outcome = await runBoundedInference(session, request({ outputSchema: schema }));
  assert.deepEqual(outcome, { kind: "json", json: submitted, model: { provider: "test", id: "space-model" }, usage: { inputTokens: 20, outputTokens: 10, amountUsd: 0.01 } });
  assert.ok(outcome.kind === "json" && outcome.json !== submitted, "the app receives a JSON copy, not the provider object");
  const context = calls[0]!.context;
  assert.equal(context.tools?.length, 1);
  assert.equal(context.tools?.[0].name, "submit_result");
  assert.equal(context.tools?.[0].parameters, schema);
  assert.match(context.systemPrompt, /submit_result/);
  assert.match(context.systemPrompt, /App instructions:\nSummarize/);
});

for (const [label, reply, code, pattern] of [
  ["an undeclared property", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1, extra: true } }] }, "INFER_OUTPUT_INVALID", /Inference result contains undeclared property extra/],
  ["a missing required property", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { note: "x" } }] }, "INFER_OUTPUT_INVALID", /missing required property total/],
  ["a wrong type", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { total: "59" } }] }, "INFER_OUTPUT_INVALID", /Inference result\.total must have type number/],
  ["two submissions", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1 } }, { type: "toolCall", name: "submit_result", arguments: { total: 2 } }] }, "INFER_OUTPUT_INVALID", /did not return a result matching the requested shape/],
  ["a different tool name", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_review", arguments: { total: 1 } }] }, "INFER_OUTPUT_INVALID", /requested shape/],
  ["plain text instead of a submission", { stopReason: "stop", content: [{ type: "text", text: "{\"total\": 1}" }] }, "INFER_OUTPUT_INVALID", /requested shape/],
  ["a submission without arguments", { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: undefined }] }, "INFER_OUTPUT_INVALID", /requested shape/],
  ["an output-length stop", { stopReason: "length", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1 } }] }, "INFER_OUTPUT_TOO_LARGE", /exceeded the 4096-byte output limit/],
] as const) test(`json inference refuses ${label}`, async () => {
  const { session } = fakeSession(reply as Partial<BoundedInferenceStreamResult>);
  await rejectsWith(runBoundedInference(session, request({ outputSchema: schema })), code, pattern);
});

test("json inference refuses a valid result that serializes beyond maxOutputBytes", async () => {
  const { session } = fakeSession({ stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1, note: "0123456789" } }] });
  await rejectsWith(runBoundedInference(session, request({ outputSchema: schema, maxOutputBytes: 16 })), "INFER_OUTPUT_TOO_LARGE", /16-byte output limit/);
});

test("text inference marks a length stop as truncated and cuts oversize text on a UTF-8 boundary", async () => {
  const short = fakeSession({ stopReason: "length", content: [{ type: "text", text: "North leads" }] });
  const shortOutcome = await runBoundedInference(short.session, request());
  assert.ok(shortOutcome.kind === "text");
  assert.deepEqual([shortOutcome.text, shortOutcome.truncated], ["North leads", true]);
  const long = fakeSession({ stopReason: "stop", content: [{ type: "text", text: "aé" }] });
  const longOutcome = await runBoundedInference(long.session, request({ maxOutputBytes: 2 }));
  assert.ok(longOutcome.kind === "text");
  assert.deepEqual([longOutcome.text, longOutcome.truncated], ["a", true]);
  const empty = fakeSession({ stopReason: "stop", content: [{ type: "thinking" }, { type: "text", text: "   " }] });
  await rejectsWith(runBoundedInference(empty.session, request()), "INFER_OUTPUT_INVALID", /returned no text/);
});

test("provider failures and interruptions map to closed codes without provider text", async () => {
  const failed = fakeSession({ stopReason: "error", errorMessage: "PRIVATE PROVIDER DIAGNOSTICS", content: [{ type: "text", text: "partial" }] });
  const failure = await rejectsWith(runBoundedInference(failed.session, request()), "INFER_FAILED", /provider connection in Settings → Assistant/);
  assert.ok(!failure.message.includes("PRIVATE"));
  const aborted = fakeSession({ stopReason: "aborted", content: [] });
  await rejectsWith(runBoundedInference(aborted.session, request()), "INFER_INTERRUPTED", /interrupted/);
  const thrown = fakeSession(async () => { throw new Error("PRIVATE TRANSPORT ERROR"); });
  const thrownFailure = await rejectsWith(runBoundedInference(thrown.session, request()), "INFER_FAILED");
  assert.ok(!thrownFailure.message.includes("PRIVATE"));
  const controller = new AbortController();
  const thrownAfterAbort = fakeSession(async () => { controller.abort(); throw new Error("PRIVATE ABORT ERROR"); });
  await rejectsWith(runBoundedInference(thrownAfterAbort.session, request({ signal: controller.signal })), "INFER_INTERRUPTED");
  const preAborted = fakeSession({ content: [{ type: "text", text: "never" }] });
  await rejectsWith(runBoundedInference(preAborted.session, request({ signal: AbortSignal.abort() })), "INFER_INTERRUPTED");
  assert.equal(preAborted.calls.length, 0, "an already-interrupted call never reaches the provider");
});

test("missing model and context overflow are refused before any provider call", async () => {
  const noModel = fakeSession({ content: [{ type: "text", text: "never" }] }, { model: null });
  await rejectsWith(runBoundedInference(noModel.session, request()), "INFER_MODEL_UNAVAILABLE", /Connect a model for this Space in Settings → Assistant/);
  assert.equal(noModel.calls.length, 0);
  const small = fakeSession({ content: [{ type: "text", text: "never" }] }, { model: { ...model, contextWindow: 1_000 } });
  await rejectsWith(runBoundedInference(small.session, request({ input: "x".repeat(4_000) })), "INFER_INPUT_TOO_LARGE", /context allowance of 1000 tokens/);
  assert.equal(small.calls.length, 0);
});

test("usage is copied defensively and the output token budget follows the byte budget within model and fixed caps", async () => {
  const { session } = fakeSession({ content: [{ type: "text", text: "ok" }], usage: undefined });
  const outcome = await runBoundedInference(session, request());
  assert.deepEqual(outcome.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(boundedInferenceMaxTokens(model, 4096), 2048);
  assert.equal(boundedInferenceMaxTokens(model, 10), 256);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100 }, 4096), 100);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 0 }, 200_000), 8192);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100_000 }, 200_000), 32_768);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100_000 }, restrictedAppInferenceLimits.defaultOutputBytes), 32_768);
});

test("buildBoundedInferenceContext is the only shape the transport sends", () => {
  const text = buildBoundedInferenceContext({ instructions: "Do the thing.", input: "data" });
  assert.deepEqual(Object.keys(text).sort(), ["messages", "systemPrompt"]);
  assert.equal(text.messages[0].content, "data");
  assert.ok(Number.isFinite(text.messages[0].timestamp));
  const json = buildBoundedInferenceContext({ instructions: "Do the thing.", input: "data", outputSchema: schema });
  assert.deepEqual(Object.keys(json).sort(), ["messages", "systemPrompt", "tools"]);
  assert.deepEqual(json.tools?.map(({ name, description }) => ({ name, description })), [{ name: "submit_result", description: "Submit the result once, exactly matching the requested shape." }]);
});

test("parseRestrictedAppJsonSchema applies the tool-schema rules to a runtime schema", () => {
  assert.deepEqual(parseRestrictedAppJsonSchema({ type: "array", items: { type: "string", enum: ["a", "b"] }, maxItems: 5 }), { type: "array", items: { type: "string", enum: ["a", "b"] }, maxItems: 5 });
  let nested: unknown = { type: "string" };
  for (let depth = 0; depth < 7; depth++) nested = { type: "array", items: nested };
  assert.throws(() => parseRestrictedAppJsonSchema(nested), /exceeds the maximum nesting depth/);
  assert.throws(() => parseRestrictedAppJsonSchema({ type: "object", properties: {} }), /Restricted app schema must set additionalProperties to false/);
  assert.throws(() => parseRestrictedAppJsonSchema({ type: "string", pattern: "^a" }, "Inference output schema"), /Inference output schema/);
  assert.throws(() => parseRestrictedAppJsonSchema({ type: "number", enum: ["one"] }), /enum values must match its declared type/);
  assert.throws(() => parseRestrictedAppJsonSchema("string"), /Restricted app schema/);
});

test("PiConversationClient.infer forwards the caller's signal and stop() interrupts in-flight inference", async () => {
  const { PiConversationClient } = await import("../src/local/agent/pi-client.js");
  const settled = fakeSession({ content: [{ type: "text", text: "done" }] });
  const direct = await PiConversationClient.prototype.infer.call(
    { ensureSession: async () => settled.session, boundedCalls: new Set() } as never,
    { instructions: "Summarize.", input: "data", maxOutputBytes: 1024, timeoutMs: 1_000 },
  );
  assert.equal(direct.kind, "text");
  assert.ok(settled.calls[0]!.options!.signal instanceof AbortSignal);
  assert.notEqual(settled.calls[0]!.options!.signal.aborted, true);

  const waitForAbort = (options: BoundedInferenceStreamOptions | undefined) => new Promise<BoundedInferenceStreamResult>((resolve) => {
    options!.signal.addEventListener("abort", () => resolve({ stopReason: "aborted", content: [] }), { once: true });
  });
  const forwarded = fakeSession(waitForAbort);
  const caller = new AbortController();
  const forwardedCall = PiConversationClient.prototype.infer.call(
    { ensureSession: async () => forwarded.session, boundedCalls: new Set() } as never,
    { instructions: "Summarize.", input: "data", maxOutputBytes: 1024, timeoutMs: 1_000, signal: caller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  caller.abort();
  await rejectsWith(forwardedCall, "INFER_INTERRUPTED");

  const stopped = fakeSession(waitForAbort);
  const client = new PiConversationClient("app-inference", tmpdir());
  (client as unknown as { ensureSession: () => Promise<unknown> }).ensureSession = async () => stopped.session;
  const stoppedCall = client.infer({ instructions: "Summarize.", input: "data", maxOutputBytes: 1024, timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped.calls.length, 1);
  await client.stop();
  await rejectsWith(stoppedCall, "INFER_INTERRUPTED");
});
