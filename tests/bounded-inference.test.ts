import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  BoundedInferenceError,
  boundedInferenceInputTokens,
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
import { parseRestrictedAppJsonSchema, restrictedAppJsonSchemaLimits } from "../src/local/agent/restricted-app-manifest.js";

const model = { provider: "test", id: "work-folder-model", maxTokens: 8192, contextWindow: 128_000 };
const schema = parseRestrictedAppJsonSchema({
  type: "object",
  additionalProperties: false,
  required: ["total"],
  properties: { total: { type: "number" }, note: { type: "string", maxLength: 20 } },
});
const usage = { input: 20, output: 10, cost: { total: 0.01 } };

type Reply = Partial<BoundedInferenceStreamResult> | ((options: BoundedInferenceStreamOptions | undefined) => Promise<BoundedInferenceStreamResult>);
function fakeSession(reply: Reply, options: {
  levels?: readonly ("off" | "minimal" | "low" | "medium" | "high")[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  model?: typeof model | null;
} = {}) {
  const calls: Array<{ model: unknown; context: BoundedInferenceContext; options: BoundedInferenceStreamOptions | undefined }> = [];
  const session: BoundedInferenceSession & { prompt(): never; messages: unknown[] } = {
    model: options.model === undefined ? model : options.model,
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    messages: [{ role: "user", content: "PRIVATE SPACE CONVERSATION" }],
    getAvailableThinkingLevels: () => options.levels ?? ["off"],
    prompt: () => { throw new Error("Must not enter a turn"); },
    agent: {
      streamFunction: async (streamModel, context, streamOptions) => {
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
  return { instructions: "Summarize the sales figures.", input: "North $42\nSouth $17", maxOutputBytes: 4096, signal: new AbortController().signal, ...overrides };
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
  assert.deepEqual(outcome, { kind: "text", text: "North leads by $25.", truncated: false, model: { provider: "test", id: "work-folder-model" }, usage: { inputTokens: 20, outputTokens: 10, amountUsd: 0.01 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, model);
  const transcript = calls[0]!.context;
  const context = { systemPrompt: getCurrentSystemPrompt(transcript.messages), messages: transcript.messages.filter((m) => m.role !== "system"), tools: getCurrentTools(transcript.messages) };
  assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, input.input);
  assert.equal(context.tools.length, 0);
  assert.ok(context.systemPrompt.startsWith(boundedInferenceSystemPrompt));
  assert.match(context.systemPrompt, /untrusted/);
  assert.match(context.systemPrompt, /App instructions:\nSummarize the sales figures\.$/);
  assert.ok(!JSON.stringify(context).includes("PRIVATE SPACE CONVERSATION"));
  const options = calls[0]!.options!;
  assert.equal(options.signal, input.signal);
  assert.equal(options.maxRetries, 2, "transient provider failures retry as they do in a Chat turn");
  assert.equal("timeoutMs" in options, false);
  assert.equal(options.maxTokens, model.maxTokens, "the model's own output limit, not one derived from maxOutputBytes");
  assert.equal("reasoning" in options, false);
});

test("reasoning follows the work-folder session's configured thinking level, never a forced lowest one", async () => {
  const configured = fakeSession({ content: [{ type: "text", text: "ok" }] }, { levels: ["off", "low", "medium", "high"], thinkingLevel: "high" });
  await runBoundedInference(configured.session, request());
  assert.equal(configured.calls[0]!.options!.reasoning, "high");
  const off = fakeSession({ content: [{ type: "text", text: "ok" }] }, { levels: ["off", "low", "high"], thinkingLevel: "off" });
  await runBoundedInference(off.session, request());
  assert.equal("reasoning" in off.calls[0]!.options!, false, "a work-folder with thinking off sends no reasoning option");
  const stale = fakeSession({ content: [{ type: "text", text: "ok" }] }, { levels: ["off", "low", "high"], thinkingLevel: "medium" });
  await runBoundedInference(stale.session, request());
  assert.equal("reasoning" in stale.calls[0]!.options!, false, "a level the model no longer offers leaves the model's default");
  const unset = fakeSession({ content: [{ type: "text", text: "ok" }] }, { levels: ["off", "low", "high"] });
  await runBoundedInference(unset.session, request());
  assert.equal("reasoning" in unset.calls[0]!.options!, false, "no configured level never becomes the lowest available one");
});

test("json inference carries the app schema as the single submit_result tool and returns plain validated data", async () => {
  const submitted = { total: 59, note: "two regions" };
  const { session, calls } = fakeSession({ stopReason: "toolUse", content: [{ type: "toolCall", name: boundedInferenceResultToolName, arguments: submitted }] });
  const outcome = await runBoundedInference(session, request({ outputSchema: schema }));
  assert.deepEqual(outcome, { kind: "json", json: submitted, model: { provider: "test", id: "work-folder-model" }, usage: { inputTokens: 20, outputTokens: 10, amountUsd: 0.01 } });
  assert.ok(outcome.kind === "json" && outcome.json !== submitted, "the app receives a JSON copy, not the provider object");
  const transcript = calls[0]!.context;
  const context = { systemPrompt: getCurrentSystemPrompt(transcript.messages), messages: transcript.messages.filter((m) => m.role !== "system"), tools: getCurrentTools(transcript.messages) };
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
  ["an output-length stop", { stopReason: "length", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1 } }] }, "INFER_OUTPUT_TOO_LARGE", /reached its 8192-token output limit/],
] as const) test(`json inference refuses ${label}`, async () => {
  const { session } = fakeSession(reply as Partial<BoundedInferenceStreamResult>);
  await rejectsWith(runBoundedInference(session, request({ outputSchema: schema })), code, pattern);
});

test("json inference refuses a valid result that serializes beyond maxOutputBytes", async () => {
  const { session } = fakeSession({ stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_result", arguments: { total: 1, note: "0123456789" } }] });
  await rejectsWith(runBoundedInference(session, request({ outputSchema: schema, maxOutputBytes: 16 })), "INFER_OUTPUT_TOO_LARGE", /16-byte output limit/);
});

test("text inference flags the model's own length stop and refuses, never cuts, an oversize reply", async () => {
  const short = fakeSession({ stopReason: "length", content: [{ type: "text", text: "North leads" }] });
  const shortOutcome = await runBoundedInference(short.session, request());
  assert.ok(shortOutcome.kind === "text");
  assert.deepEqual([shortOutcome.text, shortOutcome.truncated], ["North leads", true], "everything the model produced, flagged");
  const long = fakeSession({ stopReason: "stop", content: [{ type: "text", text: "aé" }] });
  await rejectsWith(runBoundedInference(long.session, request({ maxOutputBytes: 2 })), "INFER_OUTPUT_TOO_LARGE", /2-byte output limit/);
  const fits = fakeSession({ stopReason: "stop", content: [{ type: "text", text: "aé" }] });
  const fitsOutcome = await runBoundedInference(fits.session, request({ maxOutputBytes: 3 }));
  assert.ok(fitsOutcome.kind === "text");
  assert.deepEqual([fitsOutcome.text, fitsOutcome.truncated], ["aé", false]);
  const empty = fakeSession({ stopReason: "stop", content: [{ type: "thinking" }, { type: "text", text: "   " }] });
  await rejectsWith(runBoundedInference(empty.session, request()), "INFER_OUTPUT_INVALID", /returned no text/);
});

test("provider failures and interruptions map to closed codes without provider text", async () => {
  const failed = fakeSession({ stopReason: "error", errorMessage: "PRIVATE PROVIDER DIAGNOSTICS", content: [{ type: "text", text: "partial" }] });
  const failure = await rejectsWith(runBoundedInference(failed.session, request()), "INFER_FAILED", /provider connection in Settings → AI Models/);
  assert.ok(!failure.message.includes("PRIVATE"));
  for (const stopReason of ["pending", "deferred"] as const) {
    const unfinished = fakeSession({ stopReason, content: [{ type: "text", text: "partial" }] });
    await rejectsWith(runBoundedInference(unfinished.session, request()), "INFER_FAILED");
  }
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
  await rejectsWith(runBoundedInference(noModel.session, request()), "INFER_MODEL_UNAVAILABLE", /Connect a model for this work-folder in Settings → AI Models/);
  assert.equal(noModel.calls.length, 0);
  const small = fakeSession({ content: [{ type: "text", text: "never" }] }, { model: { ...model, contextWindow: 1_000 } });
  await rejectsWith(runBoundedInference(small.session, request({ input: "x".repeat(4_000) })), "INFER_INPUT_TOO_LARGE", /context allowance of 1000 tokens/);
  assert.equal(small.calls.length, 0);
});

test("the context window is the real input bound: a large request runs with the output budget it leaves", async () => {
  // 70,000 characters is 20,000 tokens at Pi's 3.5 characters per token. The
  // old precheck (two characters per token plus a fixed output reservation)
  // refused this against a 32,000-token window; it fits with room to answer.
  const windowed = { ...model, maxTokens: 16_384, contextWindow: 32_000 };
  const large = fakeSession({ content: [{ type: "text", text: "ok" }] }, { model: windowed });
  const largeRequest = request({ input: "x".repeat(70_000) });
  await runBoundedInference(large.session, largeRequest);
  assert.equal(large.calls.length, 1);
  const inputTokens = boundedInferenceInputTokens(buildBoundedInferenceContext(largeRequest));
  assert.equal(large.calls[0]!.options!.maxTokens, Math.min(windowed.maxTokens, windowed.contextWindow - inputTokens - 4_096));
  assert.ok(large.calls[0]!.options!.maxTokens >= 1_024, "at least a short answer always fits");
  const full = fakeSession({ content: [{ type: "text", text: "never" }] }, { model: windowed });
  await rejectsWith(runBoundedInference(full.session, request({ input: "x".repeat(100_000) })), "INFER_INPUT_TOO_LARGE", /context allowance of 32000 tokens/);
  assert.equal(full.calls.length, 0);
});

test("usage is copied defensively and the output budget is the model's own, reduced only to fit the window", async () => {
  const { session } = fakeSession({ content: [{ type: "text", text: "ok" }], usage: undefined });
  const outcome = await runBoundedInference(session, request());
  assert.deepEqual(outcome.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(boundedInferenceMaxTokens(model, 1_000), model.maxTokens);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100 }, 1_000), 100);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 0 }, 1_000), 8192, "only a model that declares no limit uses the fallback");
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100_000 }, 1_000), 100_000, "no fixed ceiling below the model's own");
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100_000 }, 100_000), 128_000 - 100_000 - 4_096);
  assert.equal(boundedInferenceMaxTokens({ ...model, maxTokens: 100_000, contextWindow: 0 }, 100_000), 100_000);
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
  for (let depth = 0; depth < restrictedAppJsonSchemaLimits.depth; depth++) nested = { type: "array", items: nested };
  assert.doesNotThrow(() => parseRestrictedAppJsonSchema(nested), "the published depth is reachable");
  nested = { type: "array", items: nested };
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
    { instructions: "Summarize.", input: "data", maxOutputBytes: 1024 },
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
    { instructions: "Summarize.", input: "data", maxOutputBytes: 1024, signal: caller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  caller.abort();
  await rejectsWith(forwardedCall, "INFER_INTERRUPTED");

  const stopped = fakeSession(waitForAbort);
  const client = new PiConversationClient("app-inference", tmpdir());
  (client as unknown as { ensureSession: () => Promise<unknown> }).ensureSession = async () => stopped.session;
  const stoppedCall = client.infer({ instructions: "Summarize.", input: "data", maxOutputBytes: 1024 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped.calls.length, 1);
  await client.stop();
  await rejectsWith(stoppedCall, "INFER_INTERRUPTED");
});
