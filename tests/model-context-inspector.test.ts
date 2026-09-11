import assert from "node:assert/strict";
import test from "node:test";
import { installModelContextInspection, ModelContextInspector } from "../src/local/agent/model-context-inspector.js";

const owner = { spaceRoot: "/spaces/a", conversationId: "chat-a", sessionId: "session-a", taskId: "task-a", purpose: "chat" };
const model = { provider: "fixture", id: "any-model", api: "custom-transport" } as any;
const context = { systemPrompt: "Instructions", messages: [{ role: "user", content: "Request" }] } as any;
const enable = (options: ConstructorParameters<typeof ModelContextInspector>[0] = {}) => {
  const inspector = new ModelContextInspector(options); inspector.setEnabled(true); return inspector;
};
const fakeSession = (streamFn: (...args: any[]) => any) => ({ agent: { streamFn } }) as any;

test("inspector observes final native hook payload without mutating options, payload, return semantics, or stream", async () => {
  const inspector = enable();
  const original = { model: "provider-name", input: [{ text: "before" }] };
  const replacement = { model: "provider-name", input: [{ text: "after" }] };
  const stream = { result() { throw new Error("Inspector must never consume result"); } };
  let optionsSeen: any;
  const session = fakeSession((_model, _context, options) => { optionsSeen = options; return stream; });
  const cleanup = installModelContextInspection(session, inspector, () => owner);
  const options = { apiKey: "TRANSPORT-SECRET", headers: { authorization: "TRANSPORT-SECRET" }, env: { KEY: "TRANSPORT-SECRET" },
    onPayload: async (payload: unknown) => { assert.equal(payload, original); return replacement; } };
  assert.equal(session.agent.streamFn(model, context, options), stream);
  assert.equal(await optionsSeen.onPayload(original, model), replacement);
  let detail = inspector.get(inspector.list()[0]!.id)!;
  assert.deepEqual(detail.payloads[0]!.value, replacement);
  assert.equal(JSON.stringify(detail).includes("TRANSPORT-SECRET"), false);
  replacement.input[0]!.text = "later mutation";
  assert.equal((inspector.get(detail.id)!.payloads[0]!.value as any).input[0].text, "after");
  detail.owner.conversationId = "tampered";
  assert.equal(inspector.get(detail.id)!.owner.conversationId, "chat-a");
  await optionsSeen.onResponse({ status: 200, headers: { secret: "TRANSPORT-SECRET" } }, model);
  assert.equal(inspector.get(detail.id)!.status, "response_received");
  cleanup();

  const noReplacement = fakeSession((_model, _context, options) => options);
  installModelContextInspection(noReplacement, inspector, () => owner);
  const callback = noReplacement.agent.streamFn(model, context, { onPayload(payload: any) { payload.changed = true; } }).onPayload;
  const unchanged = {};
  assert.equal(await callback(unchanged, model), undefined);
  assert.deepEqual(unchanged, { changed: true });
  assert.deepEqual(inspector.get(inspector.list()[0]!.id)!.payloads[0]!.value, { changed: true });
});

test("auxiliary and custom providers are captured without requiring native extension callbacks; installation is idempotent", async () => {
  const inspector = enable();
  let ownerNow = { ...owner, purpose: "title" };
  const stream = { arbitrary: true };
  const original = () => stream;
  const session = fakeSession(original);
  const cleanup = installModelContextInspection(session, inspector, () => ownerNow);
  installModelContextInspection(session, inspector, () => ownerNow);
  assert.equal(session.agent.streamFn(model, context), stream);
  ownerNow = { ...ownerNow, conversationId: "other", purpose: "check" };
  session.agent.streamFn(model, context);
  assert.equal(inspector.list().length, 2);
  const first = inspector.list({ conversationId: "chat-a" })[0]!;
  assert.equal(first.owner.purpose, "title");
  assert.equal(first.stage, "assembled");
  assert.equal(first.payloadSamples, 0);
  assert.equal(inspector.get(first.id, { conversationId: "other" }), undefined);
  const newerWrapper = () => stream;
  session.agent.streamFn = newerWrapper;
  cleanup();
  assert.equal(session.agent.streamFn, newerWrapper, "cleanup must not overwrite another adapter");
});

test("clear and disable invalidate pending payload hooks and never repopulate cleared records", async () => {
  const inspector = enable();
  let resolve!: (value: any) => void;
  const nativeHook = new Promise((done) => { resolve = done; });
  const session = fakeSession((_model, _context, options) => options);
  installModelContextInspection(session, inspector, () => owner);
  const options = session.agent.streamFn(model, context, { onPayload: () => nativeHook });
  const pending = options.onPayload({ before: true }, model);
  inspector.clear();
  resolve({ after: true });
  assert.deepEqual(await pending, { after: true });
  await options.onResponse({ status: 200, headers: {} }, model);
  assert.equal(inspector.list().length, 0);
  const again = session.agent.streamFn(model, context);
  inspector.setEnabled(false); inspector.setEnabled(true);
  await again.onPayload({ late: true }, model);
  assert.equal(inspector.list().length, 0);
  inspector.setEnabled(false);
  assert.equal(session.agent.streamFn(model, context, undefined), undefined);
  assert.equal(inspector.inspect().enabled, false);
});

test("snapshot bounds redact credential fields and replace native/provider images without evaluating getters or proxies", async () => {
  const inspector = enable({ limits: { stringBytes: 128, depth: 5, nodes: 80, digestBytes: 32 } });
  let getters = 0;
  const nested: any = { text: "x".repeat(10_000), api_key: "HIDDEN", accessToken: "HIDDEN", images: [
    { type: "image", mimeType: "image/png", data: "abc" },
    { source: { type: "base64", media_type: "image/png", data: "x".repeat(5000) } },
    { image_url: { url: `data:image/png;base64,${"x".repeat(5000)}` } },
  ] };
  Object.defineProperty(nested, "getter", { enumerable: true, get() { getters += 1; throw new Error("must not execute"); } });
  nested.proxy = new Proxy({}, { ownKeys() { throw new Error("must not enumerate"); } });
  nested.cycle = nested;
  nested.deep = { a: { b: { c: { d: { e: "hidden" } } } } };
  const session = fakeSession(() => ({}));
  installModelContextInspection(session, inspector, () => owner);
  session.agent.streamFn(model, nested);
  const detail = inspector.get(inspector.list()[0]!.id)!;
  const serialized = JSON.stringify(detail);
  assert.equal(getters, 0);
  assert.equal(serialized.includes("HIDDEN"), false);
  assert.equal(serialized.includes("x".repeat(5000)), false);
  assert.match(serialized, /sha256OfEncodedData/);
  assert.match(serialized, /digest.*size limit/);
  assert.match(serialized, /Accessor property/);
  assert.match(serialized, /Proxy object/);
  assert.match(serialized, /circular object/);
  assert.match(serialized, /depth limit/);
  assert.equal(detail.truncated, true);
});

test("retention, record, sample and total memory bounds evict only diagnostic copies", async () => {
  let now = 1000;
  const inspector = enable({ now: () => now, limits: { records: 3, recordBytes: 8192, totalBytes: 8192, payloadSamples: 1, retentionMs: 100 } });
  const session = fakeSession((_model, _context, options) => options);
  installModelContextInspection(session, inspector, () => owner);
  for (let i = 0; i < 8; i += 1) {
    const options = session.agent.streamFn(model, { text: "x".repeat(12_000) });
    await options.onPayload({ text: "y".repeat(12_000) }, model);
    await options.onPayload({ text: "later" }, model);
    now += 1;
  }
  const records = inspector.list();
  assert.ok(records.length > 0 && records.length <= 3);
  assert.ok(records.reduce((bytes, record) => bytes + record.bytes, 0) <= 8192);
  assert.ok(records.every((record) => record.bytes <= 8192 && record.payloadSamples === 1 && record.truncated));
  assert.match(JSON.stringify(inspector.get(records[0]!.id)), /Additional provider payload samples/);
  now += 101;
  assert.equal(inspector.list().length, 0);
});

test("observation failures never fail native work; native hook/dispatch errors retain their identity", async () => {
  const inspector = enable();
  const stream = {};
  const session = fakeSession(() => stream);
  installModelContextInspection(session, inspector, () => { throw new Error("diagnostic failure"); });
  assert.equal(session.agent.streamFn(model, context), stream);
  installModelContextInspection(session, inspector, () => owner);
  inspector.begin = () => { throw new Error("capture failure"); };
  assert.equal(session.agent.streamFn(model, context), stream);

  const working = enable();
  const hookError = new Error("native hook failure");
  const hooks = fakeSession((_model, _context, options) => options);
  installModelContextInspection(hooks, working, () => owner);
  const options = hooks.agent.streamFn(model, context, { onPayload() { throw hookError; } });
  await assert.rejects(options.onPayload({}, model), (error: unknown) => error === hookError);
  const dispatchError = new Error("transport failed");
  const failing = fakeSession(async () => { throw dispatchError; });
  installModelContextInspection(failing, working, () => owner);
  await assert.rejects(failing.agent.streamFn(model, context), (error: unknown) => error === dispatchError);
  assert.equal(working.list()[0]!.status, "dispatch_error");
});

test("long owner identities remain exact and cannot disclose child context through a truncated parent filter", () => {
  const inspector = enable();
  const prefix = "/spaces/" + "a".repeat(248);
  const longOwner = { ...owner, spaceRoot: `${prefix}/child`, conversationId: "c".repeat(300), sessionId: "s".repeat(300) };
  const session = fakeSession(() => ({}));
  installModelContextInspection(session, inspector, () => longOwner);
  session.agent.streamFn(model, context);
  assert.equal(inspector.list({ spaceRoot: prefix }).length, 0);
  const detail = inspector.get(inspector.list()[0]!.id, { spaceRoot: longOwner.spaceRoot, conversationId: longOwner.conversationId });
  assert.deepEqual(detail!.owner, longOwner);
  longOwner.spaceRoot = "/changed";
  assert.notEqual(inspector.list()[0]!.owner.spaceRoot, longOwner.spaceRoot);
});

test("node and aggregate image hashing bounds omit excess work and expired records release without another read", async () => {
  const inspector = enable({ limits: { nodes: 16, digestBytes: 4, retentionMs: 20 } });
  const session = fakeSession((_model, _context, options) => options);
  installModelContextInspection(session, inspector, () => owner);
  const callbacks = session.agent.streamFn(model, {
    images: [{ type: "image", data: "abc", mimeType: "image/png" }, { type: "image", data: "abc", mimeType: "image/png" }],
    many: Array.from({ length: 1000 }, (_, i) => i),
  });
  const record = inspector.get(inspector.list()[0]!.id)!;
  assert.equal((JSON.stringify(record).match(/sha256OfEncodedData/g) ?? []).length, 1);
  assert.match(JSON.stringify(record), /node limit/);
  // Inspect the private storage here specifically to prove timer-driven removal,
  // rather than letting list()/get()'s lazy prune hide a missing expiry timer.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((inspector as any).records.size, 0);
  await callbacks.onPayload({ late: true }, model);
  assert.equal(inspector.list().length, 0);
});

test("snapshot omission never renames fields, overwrites a real omission key or compresses sparse array indices", () => {
  const inspector = enable();
  const session = fakeSession(() => ({}));
  installModelContextInspection(session, inspector, () => owner);
  const prefix = "x".repeat(256);
  session.agent.streamFn(model, {
    [prefix]: "original exact field",
    [`${prefix}a`]: "must not overwrite the original",
    [`${prefix}api_key`]: "LONG-NAME-CREDENTIAL-MUST-NOT-LEAK",
    sparse: ["first", , "third"],
    trailing: new Array(3),
    dataUrl: "data:image/svg+xml;charset=utf-8,%3Csvg%3EPRIVATE-IMAGE-BYTES%3C/svg%3E",
    longHeader: `data:image/png;${"p".repeat(160)},PRIVATE-IMAGE-BYTES`,
  });
  const detail = inspector.get(inspector.list()[0]!.id)!;
  const value = detail.assembled.value as any;
  assert.equal(value[prefix], "original exact field");
  assert.deepEqual(value.sparse, ["first"], "only source indices represented faithfully are retained");
  assert.deepEqual(value.trailing, []);
  assert.match(JSON.stringify(detail.assembled.omissions), /property name.*field omitted/);
  assert.match(JSON.stringify(detail.assembled.omissions), /Sparse array remainder/);
  assert.match(JSON.stringify(detail.assembled.omissions), /Image data URL header/);
  assert.ok(!JSON.stringify(detail).includes("LONG-NAME-CREDENTIAL-MUST-NOT-LEAK"));
  assert.ok(!JSON.stringify(detail).includes("PRIVATE-IMAGE-BYTES"));

  const bounded = enable({ limits: { nodes: 2 } });
  installModelContextInspection(session, bounded, () => owner);
  session.agent.streamFn(model, { "[omitted]": "a real field", another: "too many nodes" });
  const originalField = bounded.get(bounded.list()[0]!.id)!;
  assert.deepEqual(originalField.assembled.value, { "[omitted]": "a real field" });
  assert.match(JSON.stringify(originalField.assembled.omissions), /node limit/);

  session.agent.streamFn(model, { [`${prefix}one`]: "skipped", [`${prefix}two`]: "skipped", unreachable: "node cap must stop here" });
  const skipped = bounded.get(bounded.list()[0]!.id)!;
  assert.deepEqual(skipped.assembled.value, {});
  assert.match(JSON.stringify(skipped.assembled.omissions), /node limit/);
});

test("transport and hook receivers and native synchronous errors survive observation unchanged", async () => {
  const inspector = enable();
  const stream = {};
  const transportError = new Error("synchronous native failure");
  let actualOptions: any;
  const session = fakeSession(function (this: unknown, _model, _context, options) {
    assert.equal(this, session.agent);
    actualOptions = options;
    return stream;
  });
  installModelContextInspection(session, inspector, () => owner);
  const hookError = new Error("native response hook failure");
  const nativeOptions = {
    marker: "native receiver",
    onPayload(this: unknown, payload: unknown) { assert.equal(this, nativeOptions); return payload; },
    onResponse(this: unknown) { assert.equal(this, nativeOptions); throw hookError; },
  };
  assert.equal(session.agent.streamFn(model, context, nativeOptions), stream);
  const payload = { unchanged: true };
  assert.equal(await actualOptions.onPayload(payload, model), payload);
  await assert.rejects(actualOptions.onResponse({}, model), (error: unknown) => error === hookError);

  const failing = fakeSession(() => { throw transportError; });
  installModelContextInspection(failing, inspector, () => owner);
  assert.throws(() => failing.agent.streamFn(model, context), (error: unknown) => error === transportError);
  assert.equal(inspector.list()[0]!.status, "dispatch_error");
});
