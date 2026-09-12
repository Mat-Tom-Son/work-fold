import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { IncludedChromeConnectionService } from "../../../src/local/agent/included-chrome-connection.ts";
import type { ChromeHostFacilities } from "../../../src/shared/chrome-connection.ts";

const root = await mkdtemp(join(tmpdir(), "workfold-chrome-readiness-"));
const reservation = createServer();
await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(resolve => reservation.close(() => resolve()));
process.env.PI_CHROME_BRIDGE_PORT = String(port);
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
const chrome = await jiti.import<any>(new URL("../../../resources/included-tools/chrome/index.ts", import.meta.url).pathname);
const distribution = { version: 1, storeId: "a".repeat(32), nativeHostName: "com.work_fold.readiness_test", bootstrapVersion: 1, extensionVersion: "1.0.0", bridge: { major: 3, minor: 0, capabilities: ["cancellation", "hard-background", "profile-binding"] } };
const origin = `chrome-extension://${distribution.storeId}/`;
const client = { clientId: randomUUID(), clientProof: randomBytes(32).toString("hex") };
const request = () => ({ version: 1 as const, action: "connect" as const, requestId: randomUUID(), ...client, extensionVersion: "1.0.0", bridge: distribution.bridge });
let observed = 0;
let probeReads = 0;
let afterProbeRead: (() => Promise<void>) | undefined;
let service: IncludedChromeConnectionService;
const facilities = (host: ChromeHostFacilities, gated = false): ChromeHostFacilities => ({
  getChromeConnection: async () => {
    if (gated && ++probeReads === 4) await afterProbeRead?.();
    return host.getChromeConnection();
  },
  reportChromeConnectionObservation: value => { observed++; host.reportChromeConnectionObservation(value); },
  onChromeConnectionRevoked: host.onChromeConnectionRevoked,
  beginChromeWork: host.beginChromeWork,
});
service = await IncludedChromeConnectionService.create({
  stateRoot: root, distribution, registerNativeHost: async () => {}, openStore: async () => {},
  startTransport: host => chrome.startIncludedChromeConnection(facilities(host)),
  probe: async () => { probeReads = 0; await chrome.probeIncludedChromeConnection(facilities(service, true)); },
});
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
async function until(predicate: () => boolean) {
  const deadline = realNow() + 2_000;
  while (!predicate()) { if (realNow() > deadline) throw new Error("Fixture observation timed out"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function openPoll() {
  const connection = (await service.getChromeConnection())!;
  const count = observed;
  const headers = { origin: origin.slice(0, -1), "x-pi-chrome-companion": connection.leaseToken, "x-pi-chrome-connection": connection.connectionId };
  const query = new URLSearchParams({ protocol: "3", version: "1.0.0", capabilities: JSON.stringify(distribution.bridge.capabilities) });
  const response = fetch(`http://127.0.0.1:${port}/next-v2?${query}`, { headers });
  await until(() => observed > count);
  return { headers, response };
}
async function answer(poll: Awaited<ReturnType<typeof openPoll>>, protocolVersion = 3) {
  const body = await (await poll.response).json() as any;
  assert.equal(body.command.action, "tab.version");
  const response = await fetch(`http://127.0.0.1:${port}/result`, { method: "POST", headers: { ...poll.headers, "content-type": "application/json" }, body: JSON.stringify({ id: body.command.id, bridgeEpoch: body.command.bridgeEpoch, ok: true,
    result: { extensionVersion: "1.0.0", capabilities: { protocolVersion, cancellation: true } } }) });
  assert.equal(response.status, 200);
}
try {
  await service.prepare();
  assert.equal((await service.bootstrap(origin, request())).state, "lease_ready");
  offset = 31_000; // Lease age alone cannot establish readiness.
  const firstPoll = await openPoll();
  assert.equal(service.status().state, "connected");
  const check = service.check();
  await answer(firstPoll);
  assert.equal((await check).state, "connected", "a successful probe must refresh readiness before a new browser poll exists");
  assert.equal(service.status().state, "connected");

  const failedPoll = await openPoll();
  const failed = service.check();
  await answer(failedPoll, 2);
  assert.equal((await failed).state, "connection_error", "an incompatible response cannot restore Ready");

  for (const change of ["disconnect", "replace", "quit"]) {
    const poll = await openPoll();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    afterProbeRead = async () => { entered(); await held; };
    const late = service.check();
    await answer(poll);
    await reached;
    const shutdown = change === "quit" ? service.close() : undefined;
    if (change !== "quit") assert.equal((await service.disconnect()).state, "not_connected");
    if (change === "replace") assert.equal((await service.bootstrap(origin, request())).state, "lease_ready");
    release();
    assert.equal((await late).state, change === "quit" ? "app_not_running" : change === "replace" ? "connecting" : "not_connected", "a late old probe must not report readiness or an error for a different connection");
    await shutdown;
    afterProbeRead = undefined;
    if (change === "disconnect") assert.equal((await service.bootstrap(origin, request())).state, "lease_ready");
  }
  console.log("PASS Chrome readiness: existing authenticated poll, successful probe, incompatible reply, disconnect, replacement and quit identity fencing");
} finally {
  Date.now = realNow;
  await service.close();
  await rm(root, { recursive: true, force: true });
}
