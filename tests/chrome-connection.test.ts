import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { IncludedChromeConnectionService, type ChromeDistribution } from "../src/local/agent/included-chrome-connection.js";
import type { ChromeBootstrapRequest, ChromeHostFacilities } from "../src/shared/chrome-connection.js";

const distribution: ChromeDistribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.chrome_test", bootstrapVersion: 1, extensionVersion: "1.0.0", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const origin = `chrome-extension://${distribution.storeId}/`;
const caller = () => ({ clientId: randomUUID(), clientProof: randomBytes(32).toString("hex") });
const request = (client: ReturnType<typeof caller>, action: ChromeBootstrapRequest["action"] = "connect"): ChromeBootstrapRequest => ({ version: 1, action, requestId: randomUUID(), ...client, extensionVersion: "1.0.0", bridge: distribution.bridge });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "workfold-chrome-authority-"));
  const stateRoot = join(root, "state");
  let registrations = 0, opened = 0, starts = 0, closes = 0;
  let activeFacilities: ChromeHostFacilities | undefined;
  const options = {
    stateRoot, distribution,
    registerNativeHost: async (_explicit: boolean) => { registrations++; }, openStore: async () => { opened++; },
    startTransport: async (facilities: ChromeHostFacilities) => { starts++; activeFacilities = facilities; return { close() { closes++; } }; },
    probe: async () => {
      const lease = await activeFacilities?.getChromeConnection();
      if (lease) activeFacilities?.reportChromeConnectionObservation({ connectionId: lease.connectionId, state: "connected", extensionVersion: "1.0.0" });
    },
  };
  const service = await IncludedChromeConnectionService.create(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, stateRoot, service, options, counts: () => ({ registrations, opened, starts, closes }) };
}

test("Chrome catalogs stay cold; simultaneous profile Connect binds one proof and readiness requires a browser observation", async t => {
  const { stateRoot, service, counts } = await fixture(t);
  assert.equal(service.status().state, "not_connected");
  assert.equal(await service.getChromeConnection(), undefined);
  assert.deepEqual(counts(), { registrations: 0, opened: 0, starts: 0, closes: 0 });
  await assert.rejects(access(stateRoot), { code: "ENOENT" });
  await service.prepare();
  const a = caller(), b = caller(), first = request(a);
  const results = await Promise.all([service.bootstrap(origin, first), service.bootstrap(origin, request(b))]);
  assert.equal(results[0]!.state, "lease_ready");
  assert.deepEqual(results[1]!.state === "status" && results[1]!.status.state, "profile_conflict");
  const lease = await service.getChromeConnection(); assert.ok(lease);
  assert.equal(service.status().state, "connecting", "issuing a lease is not an authenticated Chrome poll");
  assert.equal((await service.check()).state, "connected");
  const retry = await service.bootstrap(origin, first); assert.deepEqual(retry, results[0]);
  const forged = await service.bootstrap(origin, { ...first, requestId: randomUUID(), clientProof: randomBytes(32).toString("hex") });
  assert.equal(forged.state === "status" && forged.status.state, "profile_conflict");
  const alteredRetry = await service.bootstrap(origin, { ...first, action: "disconnect" });
  assert.equal(alteredRetry.state === "status" && alteredRetry.status.state, "connection_error");
  const saved = await readFile(join(stateRoot, "chrome/native-host/connection.json"), "utf8");
  for (const value of [a.clientProof, lease.leaseToken]) {
    assert.ok(!saved.includes(value)); assert.ok(!JSON.stringify(service.status()).includes(value));
  }
  assert.equal(counts().starts, 1);
});

test("Disconnect and Change profile refuse affected work, then revoke old lease/retries without touching a new owner", async t => {
  const { service, counts } = await fixture(t);
  await service.prepare(); const a = caller(), accepted = request(a);
  await service.bootstrap(origin, accepted);
  const lease = (await service.getChromeConnection())!;
  let revoked = 0; service.onChromeConnectionRevoked(() => revoked++);
  const end = service.beginChromeWork(lease.connectionId);
  assert.equal((await service.disconnect()).state, "busy");
  assert.equal((await service.changeProfile()).state, "busy");
  assert.equal(counts().opened, 1, "busy profile change does not open or navigate Chrome");
  const nativeBusy = await service.bootstrap(origin, request(a, "disconnect"));
  assert.equal(nativeBusy.state === "status" && nativeBusy.status.state, "busy");
  assert.equal(revoked, 0); assert.equal(counts().closes, 0);
  end(); end();
  assert.equal((await service.disconnect()).state, "not_connected");
  assert.equal(revoked, 1); assert.equal(counts().closes, 1);
  assert.equal(await service.getChromeConnection(), undefined);
  assert.throws(() => service.beginChromeWork(lease.connectionId), /changed before/);
  const retry = await service.bootstrap(origin, accepted);
  assert.equal(retry.state === "status" && retry.status.state, "not_connected");
  const resume = await service.bootstrap(origin, request(a, "resume"));
  assert.equal(resume.state === "status" && resume.status.state, "not_connected");
  assert.equal((await service.bootstrap(origin, request(caller()))).state, "lease_ready");
  const next = (await service.getChromeConnection())!;
  assert.notEqual(next.leaseToken, lease.leaseToken); assert.notEqual(next.connectionId, lease.connectionId);
  service.reportChromeConnectionObservation({ connectionId: lease.connectionId, state: "connected" });
  assert.equal(service.status().state, "connecting");
  const nextEnd = service.beginChromeWork(next.connectionId);
  assert.equal((await service.changeProfile()).state, "busy"); nextEnd();
  assert.equal((await service.changeProfile()).state, "not_connected");
  assert.equal(counts().opened, 2, "safe profile change opens the real Store through the trusted callback");
});

test("Chrome bootstrap checks exact origin, version/capabilities and its own launch bearer without accepting browser/CLI auth", async t => {
  const { service, stateRoot } = await fixture(t); await service.prepare();
  const descriptor = JSON.parse(await readFile(join(stateRoot, "chrome/native-host/launch.json"), "utf8"));
  const body = { version: 1, launchId: descriptor.launchId, extensionOrigin: origin, request: request(caller()) };
  const headers = { "content-type": "application/json", authorization: `Bearer ${descriptor.bootstrapToken}` };
  for (const badHeaders of [{ "x-work-fold-session": descriptor.bootstrapToken }, { ...headers, origin }, { ...headers, authorization: "Bearer forged" }]) {
    assert.equal((await fetch(descriptor.endpoint, { method: "POST", headers: badHeaders, body: JSON.stringify(body) })).status, 403);
  }
  assert.equal((await fetch(descriptor.endpoint, { method: "POST", headers, body: JSON.stringify({ ...body, launchId: randomUUID() }) })).status, 403);
  const accepted = await fetch(descriptor.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).state, "lease_ready");
  const wrongOrigin = await service.bootstrap("chrome-extension://" + "b".repeat(32) + "/", request(caller()));
  assert.equal(wrongOrigin.state === "status" && wrongOrigin.status.state, "connection_error");
  for (const [major, capabilities, expected] of [[4, distribution.bridge.capabilities, "update_app"], [2, distribution.bridge.capabilities, "update_extension"], [3, [], "update_extension"]] as const) {
    const value = await service.bootstrap(origin, { ...request(caller()), bridge: { major, minor: 0, capabilities } });
    assert.equal(value.state === "status" && value.status.state, expected);
  }
});

test("app restart renews launch secrets and old close cannot erase the newer descriptor", async t => {
  const { service, options, stateRoot } = await fixture(t); await service.prepare();
  const owner = caller(); await service.bootstrap(origin, request(owner));
  const oldLease = (await service.getChromeConnection())!;
  const next = await IncludedChromeConnectionService.create(options);
  t.after(() => next.close());
  await next.startIfEnabled();
  const before = await readFile(join(stateRoot, "chrome/native-host/launch.json"), "utf8");
  await service.close();
  assert.equal(await readFile(join(stateRoot, "chrome/native-host/launch.json"), "utf8"), before);
  const resumed = await next.bootstrap(origin, request(owner, "resume"));
  assert.equal(resumed.state, "lease_ready");
  assert.notEqual((await next.getChromeConnection())!.leaseToken, oldLease.leaseToken);
  assert.equal(next.status().state, "connecting", "restart never reconstructs a successful browser observation");
});

test("failed connection persistence publishes no selected profile or reusable lease", async t => {
  const { service, stateRoot } = await fixture(t); await service.prepare();
  const path = join(stateRoot, "chrome/native-host/connection.json");
  await rm(path); await mkdir(path);
  await assert.rejects(() => service.bootstrap(origin, request(caller())));
  assert.equal(service.status().hasSelection, false); assert.equal(await service.getChromeConnection(), undefined);
});

test("quit drains held Chrome registration without opening the Store or publishing a listener afterward", async t => {
  const { options, stateRoot } = await fixture(t);
  let release!: () => void, started!: () => void, opened = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const service = await IncludedChromeConnectionService.create({ ...options,
    registerNativeHost: async () => { started(); await held; }, openStore: async () => { opened++; },
  });
  const preparing = service.prepare(); await entered;
  const closing = service.close();
  assert.equal(service.status().state, "app_not_running");
  release(); await closing;
  assert.equal((await preparing).state, "app_not_running"); assert.equal(opened, 0);
  await assert.rejects(access(join(stateRoot, "chrome/native-host/launch.json")), { code: "ENOENT" });
  assert.equal(await service.getChromeConnection(), undefined);
});

test("quit drains a held Chrome transport and never returns a usable lease after shutdown", async t => {
  const { options, stateRoot } = await fixture(t);
  let release!: () => void, started!: () => void, closed = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const service = await IncludedChromeConnectionService.create({ ...options,
    startTransport: async () => { started(); await held; return { close() { closed++; } }; },
  });
  await service.prepare(); const connecting = service.bootstrap(origin, request(caller())); await entered;
  const closing = service.close(); release(); await closing;
  const result = await connecting;
  assert.equal(result.state === "status" && result.status.state, "app_not_running");
  assert.equal(closed, 1); assert.equal(await service.getChromeConnection(), undefined);
  await assert.rejects(access(join(stateRoot, "chrome/native-host/launch.json")), { code: "ENOENT" });
});

test("unreadable Chrome settings leave the app usable without replacing connection authority", async t => {
  const { options, stateRoot, counts } = await fixture(t);
  const root = join(stateRoot, "chrome/native-host"); await mkdir(root, { recursive: true });
  const record = join(root, "connection.json"); await writeFile(record, "malformed synthetic record");
  const service = await IncludedChromeConnectionService.create(options); t.after(() => service.close());
  assert.equal(service.status().state, "connection_error");
  assert.equal((await service.prepare()).state, "connection_error");
  await service.startIfEnabled();
  assert.equal(await readFile(record, "utf8"), "malformed synthetic record");
  assert.deepEqual(counts(), { registrations: 0, opened: 0, starts: 0, closes: 0 });
});
