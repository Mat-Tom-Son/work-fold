import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserAppActionService, browserAppActionLimits as limits, type BrowserAppActionPorts } from "../src/local/agent/restricted-app-browser-actions.js";
import { restrictedAppTaskAuthorityDigest, type RestrictedAppTaskScope } from "../src/local/agent/restricted-app-tasks.js";
import type { RestrictedAppToolDeclaration } from "../src/local/agent/restricted-app-manifest.js";
import type { RestrictedAppActionExecution } from "../src/local/agent/restricted-app-service.js";
import { createAuthorityStamp, createTenantId, createRuntimeInstanceId, createDataNamespaceId, createPrincipalId } from "../src/local/agent/app-platform-contract.js";
import { parseAppPlatformArtifactDigest } from "../src/local/agent/app-platform-artifact.js";

const authority = createAuthorityStamp();
const provenance = { tenantId: createTenantId(), runtimeInstanceId: createRuntimeInstanceId(), dataNamespaceId: createDataNamespaceId(), principalId: createPrincipalId(),
  authority, runtimeInstanceKind: "development" as const, artifactDigest: parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"a".repeat(64)}`) };
const scope: RestrictedAppTaskScope = { spaceId: "space-one", appId: "quotes", featureInstallationId: "feature-one",
  digest: "a".repeat(64), authorityDigest: restrictedAppTaskAuthorityDigest(authority) };
const owner = { browserId: "browser-one", grantId: "grant-one" };
const action: RestrictedAppToolDeclaration = { name: "Save quote", description: "Save this quote in the app.", action: "save",
  inputSchema: { type: "object", properties: { quote: { type: "string", maxLength: 20_000 }, count: { type: "integer" } }, required: ["quote", "count"], additionalProperties: false },
  resultSchema: { type: "object", properties: { saved: { type: "boolean" }, note: { type: "string", maxLength: 200_000 } }, required: ["saved"], additionalProperties: false } };
const current = () => {};
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-browser-actions-"));
  const path = join(root, "actions.json");
  let now = new Date("2026-09-07T12:00:00.000Z");
  let appScope = structuredClone(scope);
  let appProvenance = structuredClone(provenance);
  let heldAdmission: ReturnType<typeof deferred<void>> | undefined;
  const calls: Array<{ execution: RestrictedAppActionExecution; input: unknown; outcome: ReturnType<typeof deferred<unknown>> }> = [];
  const ports: BrowserAppActionPorts = {
    async withApp(value, operation) { assert.deepEqual(value, appScope); await heldAdmission?.promise; return operation({ actions: [action], provenance: appProvenance }); },
    async invoke(value, name, input, execution) {
      assert.deepEqual(value, scope); assert.equal(name, "save");
      const data = JSON.parse(await readFile(path, "utf8"));
      assert.equal(data.records.find((item: any) => item.receipt.id === execution.invocationId).receipt.status, "running", "acceptance is durable before execution");
      execution.assertCurrent();
      const outcome = deferred<unknown>();
      const abort = () => outcome.reject(new Error("Stopped"));
      execution.signal.addEventListener("abort", abort, { once: true });
      calls.push({ execution, input, outcome });
      try { return await outcome.promise; } finally { execution.signal.removeEventListener("abort", abort); }
    },
  };
  const options = { path, ports, now: () => now };
  let service = await BrowserAppActionService.create(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, path, ports, calls, get service() { return service; },
    request: (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), requestedAt: now.toISOString(), action: "save", input: { quote: "North: $42", count: 10 }, ...extra }),
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    changeScope: () => { appScope = { ...scope, authorityDigest: "d".repeat(64) }; },
    renewAuthority: () => { appProvenance = { ...appProvenance, authority: createAuthorityStamp() }; appScope = { ...scope, authorityDigest: restrictedAppTaskAuthorityDigest(appProvenance.authority) }; return appScope; },
    hold: () => { heldAdmission = deferred<void>(); return () => { heldAdmission!.resolve(); heldAdmission = undefined; }; },
    restart: async () => { await service.close(); service = await BrowserAppActionService.create(options); },
    /** A request runs on acceptance: submitting it is the whole ceremony. */
    async accept() { const request = this.request(); await service.request(scope, owner, request, current); return request; },
  };
}
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected app action progress did not arrive.");
}

test("browser actions run on acceptance, accept once, expose no input, and recover the same result after restart", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const [first, duplicate] = await Promise.all([f.service.request(scope, owner, request, current), f.service.request(scope, owner, request, current)]);
  assert.deepEqual(first, duplicate); assert.equal(first.status, "running"); assert.ok(first.startedAt);
  assert.equal(Object.hasOwn(first, "reviewDigest"), false); assert.equal(Object.hasOwn(first, "inputJson"), false);
  assert.deepEqual(await f.service.request(scope, owner, { ...request, input: { count: 10, quote: "North: $42" } }, current), first, "object key order does not change request identity");
  await assert.rejects(f.service.request(scope, owner, { ...request, input: { quote: "South", count: 10 } }, current), /different input/);
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0]!.execution.invocationId, first.id, "the durable receipt id is the invocation id");
  f.calls[0]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "succeeded");
  assert.deepEqual((await f.service.get(scope, owner, request.requestId, current)).result, { saved: true });
  assert.equal(Object.hasOwn((await f.service.list(scope, owner, current))[0]!, "result"), false);
  const journal = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(Object.hasOwn(journal.records[0].receipt, "input"), false);
  assert.equal(Object.hasOwn(journal.records[0].receipt, "result"), false);
  await f.restart();
  assert.equal((await f.service.request(scope, owner, request, current)).status, "succeeded", "a retry after restart returns the outcome, never a second run");
  assert.equal(f.calls.length, 1);
});

test("browser actions reject malformed inputs, wrong owners, stale requests and changed authority", async (t) => {
  const f = await fixture(t);
  for (const invalid of [null, {}, f.request({ requestId: "not-a-uuid" }), f.request({ requestedAt: "yesterday" }),
    f.request({ action: "arbitrary" }), f.request({ grantId: "injected" }), f.request({ input: { quote: "x", count: 1, secret: true } }),
    f.request({ input: { quote: "界".repeat(6000), count: 1 } }), f.request({ requestedAt: "2026-09-07T13:00:00.000Z" })]) {
    await assert.rejects(f.service.request(scope, owner, invalid, current));
  }
  assert.equal(f.calls.length, 0, "nothing invalid reaches a worker");
  const request = f.request();
  await f.service.request(scope, owner, request, current);
  await until(() => f.calls.length === 1);
  for (const foreign of [{ ...owner, grantId: "other" }, { ...owner, browserId: "other" }]) {
    await assert.rejects(f.service.get(scope, foreign, request.requestId, current));
    await assert.rejects(f.service.cancel(scope, foreign, request.requestId, current));
  }
  f.advance(limits.requestAgeMs + 1);
  await assert.rejects(f.service.request(scope, owner, f.request({ requestedAt: request.requestedAt }), current), /too old/);
  f.changeScope();
  await assert.rejects(f.service.get(scope, owner, request.requestId, current));
  await assert.rejects(f.service.get({ ...scope, authorityDigest: "d".repeat(64) }, owner, request.requestId, current), /different app revision/);
});

test("Stop fences an active action immediately and cannot cancel another browser's run", async (t) => {
  const f = await fixture(t);
  const request = await f.accept();
  await until(() => f.calls.length === 1);
  await assert.rejects(f.service.cancel(scope, { ...owner, browserId: "foreign" }, request.requestId, current));
  assert.equal(f.calls[0]!.execution.signal.aborted, false);
  const stopping = f.service.cancel(scope, owner, request.requestId, current);
  assert.equal(f.calls[0]!.execution.signal.aborted, true);
  assert.throws(() => f.calls[0]!.execution.assertCurrent(), /stopped/);
  await stopping;
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "cancelled");
  assert.equal((await f.service.get(scope, owner, request.requestId, current)).result, undefined);
});

test("Stop racing admission fences dispatch even while the request is awaiting app authority", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const release = f.hold();
  const admission = f.service.request(scope, owner, request, current);
  release(); await admission;
  const cancellation = f.service.cancel(scope, owner, request.requestId, current);
  await cancellation;
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.calls.length, 0, "a stop that lands before dispatch keeps the worker from ever being invoked");
  assert.equal((await f.service.get(scope, owner, request.requestId, current)).result, undefined);
});

test("browser revocation stops only that grant and a live authority callback fences result delivery", async (t) => {
  const f = await fixture(t);
  const request = await f.accept(); await until(() => f.calls.length === 1);
  const sibling = { browserId: "browser-two", grantId: "grant-two" };
  let allowed = true;
  const assertCurrent = () => { if (!allowed) throw new Error("Revoked grant, private diagnostic"); };
  const siblingRequest = f.request(); await f.service.request(scope, sibling, siblingRequest, assertCurrent);
  await until(() => f.calls.length === 2);
  await f.service.revoke(owner.grantId);
  assert.equal((await f.service.get(scope, owner, request.requestId, current)).status, "cancelled");
  assert.equal(f.calls[0]!.execution.signal.aborted, true);
  assert.equal((await f.service.get(scope, sibling, siblingRequest.requestId, current)).status, "running", "another browser's run keeps its own authority");
  allowed = false;
  assert.throws(() => f.calls[1]!.execution.assertCurrent(), /Revoked/);
  f.calls[1]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, sibling, siblingRequest.requestId, current)).status === "failed");
  assert.equal((await f.service.get(scope, sibling, siblingRequest.requestId, current)).result, undefined);
  await assert.rejects(f.service.get(scope, sibling, siblingRequest.requestId, assertCurrent), /Revoked/);
});

test("browser action failures and oversized results remain failures without leaking worker diagnostics", async (t) => {
  const f = await fixture(t);
  for (const outcome of [{ arbitrary: "bad schema" }, { saved: true, note: "界".repeat(50_000) }, new Error("private provider secret")]) {
    const count = f.calls.length;
    const request = await f.accept(); await until(() => f.calls.length > count);
    if (outcome instanceof Error) f.calls[count]!.outcome.reject(outcome); else f.calls[count]!.outcome.resolve(outcome);
    await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "failed");
    const result = await f.service.get(scope, owner, request.requestId, current);
    assert.equal(Object.hasOwn(result, "result"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
});

test("an uncertain accepted journal becomes interrupted at startup and is never replayed", async (t) => {
  const f = await fixture(t);
  const request = await f.accept(); await until(() => f.calls.length === 1);
  const acceptedJournal = await readFile(f.path, "utf8");
  await f.service.close();
  await writeFile(f.path, acceptedJournal);
  await f.restart();
  assert.equal((await f.service.request(scope, owner, request, current)).status, "interrupted");
  assert.equal(f.calls.length, 1);
});

test("a queued record and an accepted receipt from an older build are read, expired, and never dispatched", async (t) => {
  const f = await fixture(t);
  const request = await f.accept(); await until(() => f.calls.length === 1);
  f.calls[0]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "succeeded");
  const journal = JSON.parse(await readFile(f.path, "utf8"));
  const done = journal.records[0];
  const { startedAt, ...legacyReceipt } = done.receipt;
  done.receipt = { ...legacyReceipt, approvedAt: startedAt };
  const queued = structuredClone(done);
  queued.receipt = { ...legacyReceipt, id: randomUUID(), requestId: randomUUID(), status: "pending" };
  delete queued.resultJson;
  await f.service.close();
  await writeFile(f.path, JSON.stringify({ ...journal, records: [done, queued] }));
  await f.restart();
  const recovered = await f.service.get(scope, owner, request.requestId, current);
  assert.equal(recovered.status, "succeeded"); assert.equal(recovered.startedAt, startedAt); assert.equal(Object.hasOwn(recovered, "approvedAt"), false);
  assert.equal((await f.service.get(scope, owner, queued.receipt.requestId, current)).status, "expired");
  assert.equal(f.calls.length, 1);
});

test("journal input changes and inconsistent terminal outcomes fail closed at startup", async (t) => {
  const f = await fixture(t);
  const request = f.request(); await f.service.request(scope, owner, request, current);
  await until(() => f.calls.length === 1);
  const original = JSON.parse(await readFile(f.path, "utf8"));
  const altered = structuredClone(original);
  altered.records[0].inputJson = '{"quote":"Changed","count":10}';
  await f.service.close(); await writeFile(f.path, JSON.stringify(altered)); await f.restart();
  await assert.rejects(f.service.get(scope, owner, request.requestId, current), /records could not be verified/);
  const falseResult = structuredClone(original);
  falseResult.records[0].resultJson = '{"saved":true}';
  await writeFile(f.path, JSON.stringify(falseResult)); await f.restart();
  await assert.rejects(f.service.get(scope, owner, request.requestId, current), /records could not be verified/);
});

test("damaged journals and acceptance write failure disable the lane without dispatch", async (t) => {
  const f = await fixture(t);
  await rm(f.path, { force: true }); await mkdir(f.path);
  await assert.rejects(f.service.request(scope, owner, f.request(), current), /records could not be verified/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.list(scope, owner, current), /records could not be verified/);
  await rm(f.path, { recursive: true }); await writeFile(f.path, '{"schema":"unexpected","records":[]}');
  await f.restart();
  await assert.rejects(f.service.request(scope, owner, f.request(), current), /records could not be verified/);
});

test("running bounds refuse an extra request with the bound named instead of parking it", async (t) => {
  const f = await fixture(t);
  const requests = [];
  for (let index = 0; index < limits.runningPerInstallation; index++) {
    const request = f.request(); requests.push(request); await f.service.request(scope, owner, request, current);
  }
  await until(() => f.calls.length === limits.runningPerInstallation);
  await assert.rejects(f.service.request(scope, owner, f.request(), current), new RegExp(`already running ${limits.runningPerInstallation} actions`));
  assert.equal(f.calls.length, limits.runningPerInstallation);
  f.calls[0]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, owner, requests[0]!.requestId, current)).status === "succeeded");
  await f.service.request(scope, owner, f.request(), current);
  await until(() => f.calls.length === limits.runningPerInstallation + 1);
});

test("the machine-wide browser action limit spans installations and names itself", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-browser-action-capacity-"));
  let invoked = 0;
  const service = await BrowserAppActionService.create({ path: join(root, "actions.json"), ports: {
    async withApp(_scope, operation) { return operation({ actions: [action], provenance }); },
    async invoke(_scope, _action, _input, execution) {
      execution.assertCurrent(); invoked++;
      await new Promise((_resolve, reject) => execution.signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }));
    },
  } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index <= limits.running; index++) {
    const appScope = { ...scope, featureInstallationId: `installation-${index}` };
    const request = { requestId: randomUUID(), requestedAt: new Date().toISOString(), action: "save", input: { quote: "North", count: 1 } };
    if (index < limits.running) assert.equal((await service.request(appScope, owner, request, current)).status, "running");
    else await assert.rejects(service.request(appScope, owner, request, current), new RegExp(`${limits.running} running on this computer`));
  }
  await until(() => invoked === limits.running);
  assert.equal(invoked, limits.running);
});

test("a new app authority cancels the old revision's records when the current app submits a request", async (t) => {
  const f = await fixture(t);
  const old = f.request(); await f.service.request(scope, owner, old, current);
  await until(() => f.calls.length === 1);
  const renewed = f.renewAuthority();
  const request = f.request();
  assert.equal((await f.service.request(renewed, owner, request, current)).status, "running");
  assert.equal((await f.service.list(renewed, owner, current)).length, 1);
  const journal = JSON.parse(await readFile(f.path, "utf8"));
  const stale = journal.records.find((record: any) => record.receipt.requestId === old.requestId);
  assert.equal(stale.receipt.cancellationRequested, true, "the old revision's run is fenced, not left running under stale authority");
  assert.equal(f.calls[0]!.execution.signal.aborted, true);
  // This fixture's worker port only knows the original scope, so the renewed
  // request settles on its own; the point here is that a restart never
  // dispatches it again.
  await until(async () => (await f.service.get(renewed, owner, request.requestId, current)).status !== "running");
  const dispatched = f.calls.length;
  await f.restart();
  assert.notEqual((await f.service.get(renewed, owner, request.requestId, current)).status, "running");
  assert.equal(f.calls.length, dispatched, "a restart replays nothing");
});
