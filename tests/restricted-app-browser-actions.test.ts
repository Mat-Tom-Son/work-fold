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
    async accept() { const request = this.request(); await service.request(scope, owner, request, current);
      const review = await service.review(scope, owner, request.requestId, current);
      await service.approve(scope, owner, request.requestId, review.reviewDigest, current);
      return request; },
  };
}
async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected app action progress did not arrive.");
}

test("browser actions stage inertly, review exact input, accept once and recover the same result after restart", async (t) => {
  const f = await fixture(t);
  const request = f.request();
  const [first, duplicate] = await Promise.all([f.service.request(scope, owner, request, current), f.service.request(scope, owner, request, current)]);
  assert.deepEqual(first, duplicate); assert.equal(first.status, "pending"); assert.equal(f.calls.length, 0);
  assert.equal(Object.hasOwn(first, "reviewDigest"), false); assert.equal(Object.hasOwn(first, "inputJson"), false);
  assert.deepEqual(await f.service.request(scope, owner, { ...request, input: { count: 10, quote: "North: $42" } }, current), first, "object key order does not change request identity");
  await assert.rejects(f.service.request(scope, owner, { ...request, input: { quote: "South", count: 10 } }, current), /different input/);
  const review = await f.service.review(scope, owner, request.requestId, current);
  assert.deepEqual(JSON.parse(review.inputJson), request.input);
  await assert.rejects(f.service.approve(scope, owner, request.requestId, "invented", current), /Review it again/);
  await Promise.all([f.service.approve(scope, owner, request.requestId, review.reviewDigest, current), f.service.approve(scope, owner, request.requestId, review.reviewDigest, current)]);
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0]!.execution.invocationId, first.id);
  f.calls[0]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "succeeded");
  assert.deepEqual((await f.service.get(scope, owner, request.requestId, current)).result, { saved: true });
  assert.equal(Object.hasOwn((await f.service.list(scope, owner, current))[0]!, "result"), false);
  const journal = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(Object.hasOwn(journal.records[0].receipt, "input"), false);
  assert.equal(Object.hasOwn(journal.records[0].receipt, "result"), false);
  await f.restart();
  assert.equal((await f.service.approve(scope, owner, request.requestId, review.reviewDigest, current)).status, "succeeded");
  assert.equal(f.calls.length, 1);
});

test("browser actions reject malformed inputs, wrong owners, changed authority and expired review", async (t) => {
  const f = await fixture(t);
  for (const invalid of [null, {}, f.request({ requestId: "not-a-uuid" }), f.request({ requestedAt: "yesterday" }),
    f.request({ action: "arbitrary" }), f.request({ grantId: "injected" }), f.request({ input: { quote: "x", count: 1, secret: true } }),
    f.request({ input: { quote: "界".repeat(6000), count: 1 } }), f.request({ requestedAt: "2026-09-07T13:00:00.000Z" })]) {
    await assert.rejects(f.service.request(scope, owner, invalid, current));
  }
  const request = f.request();
  await f.service.request(scope, owner, request, current);
  const review = await f.service.review(scope, owner, request.requestId, current);
  for (const foreign of [{ ...owner, grantId: "other" }, { ...owner, browserId: "other" }]) {
    await assert.rejects(f.service.get(scope, foreign, request.requestId, current));
    await assert.rejects(f.service.approve(scope, foreign, request.requestId, review.reviewDigest, current));
    await assert.rejects(f.service.cancel(scope, foreign, request.requestId, current));
  }
  f.advance(limits.requestAgeMs + 1);
  assert.equal((await f.service.approve(scope, owner, request.requestId, review.reviewDigest, current)).status, "expired");
  assert.equal(f.calls.length, 0);
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

test("Stop racing an approval fences dispatch even while admission is awaiting app authority", async (t) => {
  const f = await fixture(t);
  const request = f.request(); await f.service.request(scope, owner, request, current);
  const review = await f.service.review(scope, owner, request.requestId, current);
  const release = f.hold();
  const approval = f.service.approve(scope, owner, request.requestId, review.reviewDigest, current);
  const cancellation = f.service.cancel(scope, owner, request.requestId, current);
  release(); await approval; await cancellation;
  await until(async () => (await f.service.get(scope, owner, request.requestId, current)).status === "cancelled");
  assert.equal(f.calls.length, 0);
});

test("browser revocation stops only that grant and a live authority callback fences result delivery", async (t) => {
  const f = await fixture(t);
  const request = await f.accept(); await until(() => f.calls.length === 1);
  const sibling = { browserId: "browser-two", grantId: "grant-two" };
  const sameGrantPending = [f.request(), f.request()];
  for (const request of sameGrantPending) await f.service.request(scope, owner, request, current);
  const pending = f.request(); await f.service.request(scope, sibling, pending, current);
  await f.service.revoke(owner.grantId);
  assert.equal((await f.service.get(scope, owner, request.requestId, current)).status, "cancelled");
  for (const request of sameGrantPending) assert.equal((await f.service.get(scope, owner, request.requestId, current)).status, "cancelled");
  assert.equal((await f.service.get(scope, sibling, pending.requestId, current)).status, "pending");
  let allowed = true;
  const assertCurrent = () => { if (!allowed) throw new Error("Revoked grant, private diagnostic"); };
  const review = await f.service.review(scope, sibling, pending.requestId, assertCurrent);
  await f.service.approve(scope, sibling, pending.requestId, review.reviewDigest, assertCurrent);
  await until(() => f.calls.length === 2);
  allowed = false;
  assert.throws(() => f.calls[1]!.execution.assertCurrent(), /Revoked/);
  f.calls[1]!.outcome.resolve({ saved: true });
  await until(async () => (await f.service.get(scope, sibling, pending.requestId, current)).status === "failed");
  assert.equal((await f.service.get(scope, sibling, pending.requestId, current)).result, undefined);
  await assert.rejects(f.service.get(scope, sibling, pending.requestId, assertCurrent), /Revoked/);
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
  const review = await f.service.review(scope, owner, request.requestId, current);
  await f.service.close();
  await writeFile(f.path, acceptedJournal);
  await f.restart();
  assert.equal((await f.service.approve(scope, owner, request.requestId, review.reviewDigest, current)).status, "interrupted");
  assert.equal(f.calls.length, 1);
});

test("journal input changes and inconsistent terminal outcomes fail closed at startup", async (t) => {
  const f = await fixture(t);
  const request = f.request(); await f.service.request(scope, owner, request, current);
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
  const request = f.request(); await f.service.request(scope, owner, request, current);
  const review = await f.service.review(scope, owner, request.requestId, current);
  await rm(f.path); await mkdir(f.path);
  await assert.rejects(f.service.approve(scope, owner, request.requestId, review.reviewDigest, current), /records could not be verified/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.list(scope, owner, current), /records could not be verified/);
  await rm(f.path, { recursive: true }); await writeFile(f.path, '{"schema":"unexpected","records":[]}');
  await f.restart();
  await assert.rejects(f.service.request(scope, owner, f.request(), current), /records could not be verified/);
});

test("bounded pending requests and one active action prevent repeated approval from flooding workers", async (t) => {
  const f = await fixture(t);
  const requests = [];
  for (let index = 0; index < limits.pendingPerInstallation; index++) {
    const request = f.request(); requests.push(request); await f.service.request(scope, owner, request, current);
  }
  await assert.rejects(f.service.request(scope, owner, f.request(), current), /existing app requests/);
  for (let index = 0; index < 2; index++) {
    const request = requests[index]!; const review = await f.service.review(scope, owner, request.requestId, current);
    const accepting = f.service.approve(scope, owner, request.requestId, review.reviewDigest, current);
    if (index === 0) await accepting; else await assert.rejects(accepting, /already handling/);
  }
  await until(() => f.calls.length === 1);
});

test("the machine-wide browser action limit spans installations and leaves excess reviews pending", async (t) => {
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
    await service.request(appScope, owner, request, current);
    const review = await service.review(appScope, owner, request.requestId, current);
    if (index < limits.running) await service.approve(appScope, owner, request.requestId, review.reviewDigest, current);
    else {
      await assert.rejects(service.approve(appScope, owner, request.requestId, review.reviewDigest, current), /actions are busy/);
      assert.equal((await service.get(appScope, owner, request.requestId, current)).status, "pending");
    }
  }
  assert.equal(invoked, limits.running);
});

test("a new app authority does not inherit old reviews or their pending-request budget", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < limits.pendingPerInstallation; index++) await f.service.request(scope, owner, f.request(), current);
  const renewed = f.renewAuthority();
  const request = f.request();
  assert.equal((await f.service.request(renewed, owner, request, current)).status, "pending");
  assert.equal((await f.service.list(renewed, owner, current)).length, 1);
  const journal = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(journal.records.filter((record: any) => record.receipt.status === "cancelled").length, limits.pendingPerInstallation);
  await f.restart();
  assert.equal((await f.service.get(renewed, owner, request.requestId, current)).status, "pending");
});
