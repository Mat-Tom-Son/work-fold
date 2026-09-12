import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, webcrypto } from "node:crypto";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../resources/included-tools/chrome/store/bootstrap.js", import.meta.url), "utf8");
const id = "a".repeat(32), origin = `chrome-extension://${id}/`;
const config = { nativeHostName: "com.work_fold.chrome", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const status = (state: string, hasSelection = false) => ({ version: 1, state: "status", status: { state, hasSelection, checkedAt: "2026-09-12T00:00:00Z" } });
const connection = () => ({ connectionId: randomUUID(), leaseToken: "f".repeat(64), extensionOrigin: origin, bridge: config.bridge });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function fixture(saved: Record<string, unknown> = {}) {
  let onMessage: Function, onInstalled: Function;
  const calls: any[] = [], tabs: any[] = [], access: string[] = [];
  let native: (request: any) => Promise<any> = async () => status("not_connected");
  const sandbox = { console, URL, Date, crypto: webcrypto, Uint8Array, Set, Promise,
    WORK_FOLD_CHROME_CONFIG: config, importScripts: (file: string) => assert.equal(file, "connection-config.js"),
    chrome: { storage: { local: {
      async setAccessLevel(value: { accessLevel: string }) { access.push(value.accessLevel); },
      async get(key: string) { return structuredClone({ [key]: saved[key] }); },
      async set(value: object) { Object.assign(saved, structuredClone(value)); },
    } }, runtime: { id, getManifest: () => ({ version: "1.0.0" }), getURL: (path: string) => origin + path,
      async sendNativeMessage(host: string, request: any) { assert.equal(host, config.nativeHostName); calls.push(structuredClone(request)); return native(request); },
      onMessage: { addListener(fn: Function) { onMessage = fn; } }, onInstalled: { addListener(fn: Function) { onInstalled = fn; } },
    }, tabs: { async create(value: unknown) { tabs.push(value); } } },
  };
  vm.runInNewContext(source, sandbox);
  return { saved, calls, tabs, access, api: (sandbox as any).workFoldChrome,
    respondWith(fn: typeof native) { native = fn; }, installed: (reason: string) => onInstalled({ reason }),
    send(action: string, sender = { id, url: origin + "popup.html" }) {
      return new Promise<any>(resolve => { const accepted = onMessage({ type: "work-fold.connection", action }, sender, resolve); if (!accepted) resolve(undefined); });
    },
  };
}

test("Store bootstrap is inert until explicit Connect, excludes secrets from popup, and only welcomes first install", async () => {
  const f = fixture(), lease = connection();
  await assert.rejects(f.api.config(), /not connected/); assert.equal(f.calls.length, 0);
  f.installed("update"); f.installed("chrome_update"); assert.equal(f.tabs.length, 0);
  f.installed("install"); assert.equal(f.tabs[0].url, origin + "welcome.html");
  f.respondWith(async () => ({ version: 1, state: "lease_ready", connection: lease }));
  const publicState = await f.send("connect");
  assert.equal(publicState.state, "connecting"); assert.equal(publicState.hasSelection, true);
  assert.equal(JSON.stringify(publicState).includes(lease.leaseToken), false);
  assert.equal((await f.api.config()).token, lease.leaseToken);
  assert.deepEqual(f.access, ["TRUSTED_CONTEXTS"]);
  const identity = f.saved["work-fold.connection.v1"] as any;
  assert.match(identity.clientProof, /^[a-f0-9]{64}$/); assert.equal(identity.enabled, true);
  assert.equal(JSON.stringify(f.saved).includes(lease.leaseToken), false);
  const before = f.calls.length;
  assert.equal(await f.send("connect", { id, url: "https://example.com/" }), undefined);
  assert.equal(await f.send("connect", { id: "b".repeat(32), url: origin + "popup.html" }), undefined);
  assert.equal(f.calls.length, before);
});

test("selected offline status preserves a lease; suspended worker resumes only its saved explicit identity", async () => {
  const f = fixture(), lease = connection();
  f.respondWith(async () => ({ version: 1, state: "lease_ready", connection: lease })); await f.send("connect");
  f.respondWith(async () => status("not_connected", true)); await f.send("status"); assert.equal((await f.api.config()).connectionId, lease.connectionId);
  const resumed = fixture(f.saved), fresh = connection();
  resumed.respondWith(async () => ({ version: 1, state: "lease_ready", connection: fresh }));
  assert.equal((await resumed.api.config()).connectionId, fresh.connectionId);
  assert.equal(resumed.calls[0].action, "resume"); assert.equal(resumed.calls[0].clientId, f.calls[0].clientId); assert.equal(resumed.calls[0].clientProof, f.calls[0].clientProof);
});

test("profile conflict and busy Disconnect never grant or silently stop another profile", async () => {
  const f = fixture(); f.respondWith(async () => status("profile_conflict", true));
  assert.equal((await f.send("connect")).state, "profile_conflict"); await assert.rejects(f.api.config(), /not connected/);
  const lease = connection(); f.respondWith(async () => ({ version: 1, state: "lease_ready", connection: lease })); await f.send("connect");
  f.respondWith(async () => status("busy", true)); assert.equal((await f.send("disconnect")).state, "busy"); assert.equal((await f.api.config()).connectionId, lease.connectionId);
  f.respondWith(async () => status("not_connected", false)); await f.send("disconnect");
  const count = f.calls.length; await assert.rejects(f.api.config()); assert.equal(f.calls.length, count);
});

test("late status cannot erase a newer Connect and duplicate clicks cannot release its serialization", async () => {
  const f = fixture(), old = deferred<any>(), connected = deferred<any>(), lease = connection();
  f.respondWith(request => request.action === "status" ? old.promise : connected.promise);
  const statusRead = f.send("status"); await tick();
  const connect = f.send("connect"); await tick();
  assert.equal((await f.send("connect")).state, "connecting");
  assert.equal((await f.send("disconnect")).state, "connecting"); assert.deepEqual(f.calls.map(value => value.action), ["status", "connect"]);
  connected.resolve({ version: 1, state: "lease_ready", connection: lease }); await connect;
  old.resolve(status("not_connected")); await statusRead;
  assert.equal((await f.api.config()).connectionId, lease.connectionId);
});

test("status requested during Connect waits for its accepted action instead of racing a stale native status", async () => {
  const f = fixture(), held = deferred<any>(), lease = connection();
  f.respondWith(request => request.action === "connect" ? held.promise : Promise.resolve(status("not_connected", false)));
  const connect = f.send("connect"); await tick();
  const read = f.send("status"); await tick();
  assert.deepEqual(f.calls.map(value => value.action), ["connect"]);
  held.resolve({ version: 1, state: "lease_ready", connection: lease });
  await connect; assert.equal((await read).state, "connecting");
  assert.equal((await f.api.config()).connectionId, lease.connectionId);
});

test("old HTTP responses cannot discard a newly issued lease; rejected native responses expose only typed status", async () => {
  const f = fixture(), initial = connection(), next = connection(), body = deferred<any>();
  f.respondWith(async () => ({ version: 1, state: "lease_ready", connection: initial })); await f.send("connect");
  const response = f.api.response({ status: 409, clone: () => ({ json: () => body.promise }) }, initial.connectionId);
  f.respondWith(async () => ({ version: 1, state: "lease_ready", connection: next })); await f.send("connect");
  body.resolve({ state: "update_extension" }); await response;
  await f.api.response({ status: 403 }, initial.connectionId); assert.equal((await f.api.config()).connectionId, next.connectionId);
  f.respondWith(async () => { throw new Error("Specified native messaging host not found /private/secret"); });
  const value = await f.send("status"); assert.equal(value.state, "native_host_missing"); assert.equal(JSON.stringify(value).includes("private"), false);
});
