import assert from "node:assert/strict";
import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import WebSocket from "ws";

import {
  RemoteAccessClient,
  RemoteBridgeRequestError,
  deriveRemotePairingCode,
  generateRemoteDeviceKeys,
  runRemoteAccountRemoval,
  type RemotePairingPrompt,
} from "../desktop/src/remote-access.js";
import type { WorkFoldRemoteFacade, WorkFoldRemotePrincipal } from "../src/local/remote-management.js";
import type { RemoteAccessSettings, RemoteBrowserGrantSettings } from "../desktop/src/settings.js";

class FakeRemoteSocket extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(value: string): void {
    this.emit("message", Buffer.from(value));
  }

  fail(message: string): void {
    this.emit("error", new Error(message));
  }

  finishClose(code: number): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.alloc(0));
  }
}

class ManualRemoteTimers {
  readonly timeouts = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly intervals = new Map<ReturnType<typeof setTimeout>, () => void>();
  #nextId = 1;

  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const timer = { kind: "timeout", id: this.#nextId++ } as unknown as ReturnType<typeof setTimeout>;
    this.timeouts.set(timer, callback);
    return timer;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timeouts.delete(timer);
  }

  setInterval(callback: () => void): ReturnType<typeof setTimeout> {
    const timer = { kind: "interval", id: this.#nextId++ } as unknown as ReturnType<typeof setTimeout>;
    this.intervals.set(timer, callback);
    return timer;
  }

  clearInterval(timer: ReturnType<typeof setTimeout>): void {
    this.intervals.delete(timer);
  }
}

const lifecycleSettings = {
  enabled: true,
  bridgeUrl: "https://bridge.example/",
  accountId: "account-1",
  slug: "example-account",
  deviceToken: "x".repeat(32),
  grants: [],
} as unknown as RemoteAccessSettings;

const pairingSigningPublicJwk = {
  kty: "EC", crv: "P-256", use: "sig",
  x: "xEkeDeRgxDVFaj_PB7QX1eF5DT94ETgJA4N5bPNhIno",
  y: "GveHxVX5FBYWxKmO_riBPgetQ8bxxXEpYM1m353Bb3c",
};
const pairingEncryptionPublicJwk = {
  kty: "EC", crv: "P-256", use: "enc",
  x: "GmmMwHR9tTlnVdnPz3InF4Lx-Mj3otTYx8PXttps3oc",
  y: "UPGztQbOksSf3T7QrxgYFibxB2ZOCCjIqdvbPy3ks4E",
};
const substitutedEncryptionPublicJwk = {
  kty: "EC", crv: "P-256", use: "enc",
  x: "Gww7OYN9xo4od3Hm04wcifhvwf8R5m1ryJAClc_IrtE",
  y: "JbGvE8li4d1A37YEsDpyBLsh-C7zYkgKNGFeou1WxOE",
};

interface RemoteTestBrowser {
  grant: RemoteBrowserGrantSettings;
  signingPrivateJwk: JsonWebKey;
  encryptionPrivateJwk: JsonWebKey;
}

function remoteTestBrowser(id: string): RemoteTestBrowser {
  const signing = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const encryption = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    grant: {
      id,
      browserId: `browser-${id}`,
      label: `Browser ${id}`,
      signingPublicJwk: { ...signing.publicKey.export({ format: "jwk" }), use: "sig" },
      encryptionPublicJwk: { ...encryption.publicKey.export({ format: "jwk" }), use: "enc" },
      generation: 1,
      approvedAt: "2026-08-05T12:00:00.000Z",
    },
    signingPrivateJwk: signing.privateKey.export({ format: "jwk" }),
    encryptionPrivateJwk: encryption.privateKey.export({ format: "jwk" }),
  };
}

function remoteTestSettings(browsers: RemoteTestBrowser[]): RemoteAccessSettings {
  return {
    enabled: true,
    bridgeUrl: "https://bridge.example/",
    accountId: "account-operations",
    slug: "operation-tests",
    deviceToken: "d".repeat(32),
    ...generateRemoteDeviceKeys(),
    grants: browsers.map((browser) => structuredClone(browser.grant)),
  };
}

function remoteOperationFrame(
  settings: RemoteAccessSettings,
  browser: RemoteTestBrowser,
  requestId: string,
  operation = "spaces.list",
  input: unknown = {},
): { type: string; operation: Record<string, unknown>; envelope: Record<string, unknown> } {
  const operationId = `operation-${requestId}`;
  const header = {
    type: "work-fold.remote-request.v1",
    accountId: settings.accountId,
    deviceId: settings.accountId,
    grantId: browser.grant.id,
    generation: browser.grant.generation,
    requestId,
    operation,
    createdAt: new Date().toISOString(),
  };
  const key = testTransportKey(
    browser.encryptionPrivateJwk,
    settings.deviceEncryptionPublicJwk,
    browser.grant.id,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(testCanonicalize(header)));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ input })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
  const envelope = {
    header,
    iv: iv.toString("base64url"),
    ciphertext,
    signature: "",
  };
  envelope.signature = sign("sha256", Buffer.from(`${testCanonicalize(header)}.${envelope.iv}.${ciphertext}`), {
    key: createPrivateKey({ key: browser.signingPrivateJwk as NodeJsonWebKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    type: "operation.request",
    operation: {
      id: operationId,
      accountId: settings.accountId,
      browserGrantId: browser.grant.id,
      requestId,
      operation,
      generation: browser.grant.generation,
    },
    envelope,
  };
}

function testTransportKey(privateJwk: JsonWebKey, publicJwk: JsonWebKey, grantId: string): Buffer {
  const shared = diffieHellman({
    privateKey: createPrivateKey({ key: privateJwk as NodeJsonWebKey, format: "jwk" }),
    publicKey: createPublicKey({ key: publicJwk as NodeJsonWebKey, format: "jwk" }),
  });
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(grantId), Buffer.from("work-fold.remote-envelope.v1"), 32));
}

function testCanonicalize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(testCanonicalize).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("Test value is not JSON.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${testCanonicalize(record[key])}`).join(",")}}`;
}

function lifecycleClient(promptPairing: (pairing: RemotePairingPrompt) => Promise<boolean> = async () => false): {
  client: RemoteAccessClient;
  sockets: FakeRemoteSocket[];
  timers: ManualRemoteTimers;
} {
  const sockets: FakeRemoteSocket[] = [];
  const timers = new ManualRemoteTimers();
  const client = new RemoteAccessClient({
    settingsStore: {
      async getRemoteAccess() { return structuredClone(lifecycleSettings); },
    } as never,
    facade: {
      async execute() { throw new Error("Unexpected remote operation."); },
      async purgeUploads() {},
    },
    promptPairing,
    createSocket: () => {
      const socket = new FakeRemoteSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    timers,
  });
  return { client, sockets, timers };
}

function remoteOperationClient(
  initialSettings: RemoteAccessSettings,
  facade: WorkFoldRemoteFacade,
): {
  client: RemoteAccessClient;
  socket: FakeRemoteSocket;
  timers: ManualRemoteTimers;
  state: { settings: RemoteAccessSettings | null };
} {
  const state = { settings: structuredClone(initialSettings) as RemoteAccessSettings | null };
  const socket = new FakeRemoteSocket();
  const timers = new ManualRemoteTimers();
  const client = new RemoteAccessClient({
    settingsStore: {
      async getRemoteAccess() { return structuredClone(state.settings); },
      async removeRemoteBrowserGrant(grantId: string) {
        if (state.settings) state.settings.grants = state.settings.grants.filter((grant) => grant.id !== grantId);
      },
      async clearRemoteBrowserGrants() {
        if (state.settings) state.settings.grants = [];
      },
    } as never,
    facade,
    promptPairing: async () => false,
    createSocket: () => socket as unknown as WebSocket,
    timers,
  });
  return { client, socket, timers, state };
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForRemoteTest(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flushAsyncHandlers();
  }
  assert.fail(message);
}

function clientFor(
  facade: WorkFoldRemoteFacade,
  events: string[],
): RemoteAccessClient {
  return new RemoteAccessClient({
    settingsStore: {
      async removeRemoteBrowserGrant(grantId: string) { events.push(`remove:${grantId}`); },
      async clearRemoteBrowserGrants() { events.push("remove:all"); },
    } as never,
    facade,
    promptPairing: async () => false,
  });
}

test("remote revocation stops every tracked management task before purging uploads", async () => {
  const events: string[] = [];
  const operations: Array<{ operation: string; input: unknown }> = [];
  const facade: WorkFoldRemoteFacade = {
    async execute(operation, input) {
      operations.push({ operation, input });
      if (operation === "management.stop") return { stopped: { managementAborted: true, children: [] } };
      throw new Error(`Unexpected operation: ${operation}`);
    },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };

  for (let index = 0; index < 70; index += 1) {
    client.rememberActiveTask("grant-1", { taskId: `management-${index}` }, principal);
  }

  await client.revokeLocalGrant("grant-1");

  assert.equal(operations.filter((entry) => entry.operation === "management.stop").length, 70, "tracking never silently evicts an older live task");
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});

test("remote revocation still purges staged uploads when stopping a task fails", async () => {
  const events: string[] = [];
  const facade: WorkFoldRemoteFacade = {
    async execute() { throw new Error("stop failed"); },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  client.rememberActiveTask(
    "grant-1",
    { taskId: "management-task" },
    { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" },
  );

  await assert.rejects(() => client.revokeLocalGrant("grant-1"), /stop failed/);
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});

test("remote revocation treats locally tracked requests evicted after settlement as already inactive", async () => {
  const events: string[] = [];
  let calls = 0;
  const facade: WorkFoldRemoteFacade = {
    async execute(operation) {
      assert.equal(operation, "management.stop");
      calls += 1;
      if (calls <= 35) throw new Error("Remote request not found for this browser grant.");
      return { stopped: { managementAborted: true, children: [] } };
    },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };
  for (let index = 0; index < 135; index += 1) {
    client.rememberActiveTask("grant-1", { taskId: `management-${index}` }, principal);
  }

  await client.revokeLocalGrant("grant-1");

  assert.equal(calls, 135);
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});

test("terminal request projections retire tracked work before revocation", async () => {
  const events: string[] = [];
  const operations: string[] = [];
  const facade: WorkFoldRemoteFacade = {
    async execute(operation) { operations.push(operation); throw new Error("should not stop retired work"); },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  const principal: WorkFoldRemotePrincipal = { browserId: "browser-1", grantId: "grant-1", requestId: "request-1" };
  client.rememberActiveTask("grant-1", { taskId: "management-1" }, principal);
  client.retireSettledTask("grant-1", "management.summary", {}, {
    latestRequest: { taskId: "management-1", phase: "done" },
  });

  await client.revokeLocalGrant("grant-1");

  assert.deepEqual(operations, []);
  assert.deepEqual(events, ["remove:grant-1", "purge:grant-1"]);
});

test("an unrelated grant revocation cannot suppress a queued operation completion", async () => {
  const browserA = remoteTestBrowser("grant-a");
  const browserB = remoteTestBrowser("grant-b");
  const settings = remoteTestSettings([browserA, browserB]);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const calls: string[] = [];
  const fixture = remoteOperationClient(settings, {
    async execute(_operation, _input, principal) {
      calls.push(principal.requestId);
      if (principal.requestId === "request-a-first") {
        markFirstStarted();
        await firstGate;
      }
      return { spaces: [] };
    },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();

  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browserA, "request-a-first")));
  await firstStarted;
  const revokeBrowserB = fixture.client.revokeLocalGrant(browserB.grant.id);
  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browserA, "request-a-second")));
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.event" && message.envelope?.header?.requestId === "request-a-second";
    }),
    "the second operation never reached the serialized authority queue",
  );

  releaseFirst();
  await revokeBrowserB;
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.complete" && message.envelope?.header?.requestId === "request-a-second";
    }),
    "an unrelated grant revocation suppressed the valid completion",
  );

  assert.deepEqual(calls, ["request-a-first", "request-a-second"]);
  fixture.client.stop();
});

test("same-grant revocation suppresses a late completion and response-cache insertion", async () => {
  const browser = remoteTestBrowser("grant-revoked");
  const settings = remoteTestSettings([browser]);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  let calls = 0;
  const fixture = remoteOperationClient(settings, {
    async execute() {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await firstGate;
      }
      return { spaces: [] };
    },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();
  const frame = remoteOperationFrame(settings, browser, "request-revoked");

  fixture.socket.receive(JSON.stringify(frame));
  await firstStarted;
  const revoke = fixture.client.revokeLocalGrant(browser.grant.id);
  releaseFirst();
  await revoke;
  await flushAsyncHandlers();

  assert.equal(
    fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.complete" && message.envelope?.header?.requestId === "request-revoked";
    }),
    false,
    "a completion must not escape after its own grant is fenced",
  );

  fixture.state.settings!.grants = [structuredClone(browser.grant)];
  fixture.socket.receive(JSON.stringify(frame));
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.complete" && message.envelope?.header?.requestId === "request-revoked";
    }),
    "the re-authorized replay never completed",
  );
  assert.equal(calls, 2, "the fenced result was not inserted into the replay cache");
  fixture.client.stop();
});

test("the all-grants disable fence suppresses an in-flight completion", async () => {
  const browser = remoteTestBrowser("grant-disable");
  const settings = remoteTestSettings([browser]);
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
  let markExecutionStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => { markExecutionStarted = resolve; });
  const fixture = remoteOperationClient(settings, {
    async execute() {
      markExecutionStarted();
      await executionGate;
      return { spaces: [] };
    },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();

  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browser, "request-disable")));
  await executionStarted;
  const disableCleanup = fixture.client.stopActiveRemoteTasks();
  releaseExecution();
  await disableCleanup;
  await flushAsyncHandlers();

  assert.equal(
    fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.complete" && message.envelope?.header?.requestId === "request-disable";
    }),
    false,
    "an all-grants fence must win over a completion already in flight",
  );
  fixture.client.stop();
});

test("stale revoked-grant and disabled operation frames do not poison the current transport", async () => {
  const staleBrowser = remoteTestBrowser("grant-stale");
  const activeBrowser = remoteTestBrowser("grant-active");
  const settings = remoteTestSettings([activeBrowser]);
  const fixture = remoteOperationClient(settings, {
    async execute() { throw new Error("A stale frame must never execute."); },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();

  const staleFrame = remoteOperationFrame(settings, staleBrowser, "request-stale");
  staleFrame.envelope = { malformed: true };
  fixture.socket.receive(JSON.stringify(staleFrame));
  await flushAsyncHandlers();
  assert.deepEqual(fixture.socket.sent, [], "authority skew must not emit protocol.error");

  fixture.state.settings!.enabled = false;
  fixture.socket.receive(JSON.stringify({ type: "operation.request", operation: null, envelope: null }));
  await flushAsyncHandlers();
  fixture.state.settings!.enabled = true;
  assert.deepEqual(fixture.socket.sent, [], "disabled authority skew must be inert even before frame parsing");

  const heartbeat = [...fixture.timers.intervals.values()][0];
  assert.ok(heartbeat, "the connected socket has a heartbeat");
  heartbeat();
  assert.equal((JSON.parse(fixture.socket.sent.at(-1)!) as { type: string }).type, "device.heartbeat");
  assert.deepEqual(fixture.socket.closes, []);
  assert.equal((await fixture.client.status()).connection, "connected");

  const badActiveFrame = remoteOperationFrame(settings, activeBrowser, "request-bad-signature");
  badActiveFrame.envelope.signature = "AA";
  fixture.socket.receive(JSON.stringify(badActiveFrame));
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => (JSON.parse(value) as { type?: string }).type === "protocol.error"),
    "an active grant's bad signature was not rejected",
  );
  fixture.client.stop();
});

test("stop then start keeps one current socket and orphan events cannot flap it", async () => {
  const { client, sockets, timers } = lifecycleClient();

  await client.start();
  assert.equal(sockets.length, 1);
  const first = sockets[0]!;
  first.open();
  assert.equal((await client.status()).connection, "connected");

  client.stop();
  assert.equal(first.closes.length, 1);
  await client.start();
  assert.equal(sockets.length, 2);
  const second = sockets[1]!;
  second.open();

  first.receive("{");
  first.fail("orphaned socket error");
  first.finishClose(1006);
  await flushAsyncHandlers();

  assert.equal(sockets.length, 2, "an orphan close must not create a third connection");
  assert.equal(timers.timeouts.size, 0, "an orphan close must not schedule reconnect work");
  assert.equal(second.sent.length, 0, "an orphan message must not reply through the current socket");
  assert.equal(timers.intervals.size, 1, "an orphan close must not clear the current heartbeat");
  assert.equal((await client.status()).connection, "connected");
  assert.equal((await client.status()).lastError, null);

  client.stop();
});

test("concurrent starts share one connection attempt", async () => {
  const { client, sockets } = lifecycleClient();
  await Promise.all([client.start(), client.start(), client.start()]);
  assert.equal(sockets.length, 1);
  client.stop();
});

test("resume recovery displaces the prior socket without accepting its later events", async () => {
  const { client, sockets, timers } = lifecycleClient();
  await client.start();
  sockets[0]!.open();

  await client.recoverConnection();
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.closes.at(-1)?.code, 1001);
  sockets[1]!.open();
  sockets[0]!.finishClose(1006);
  await flushAsyncHandlers();

  assert.equal((await client.status()).connection, "connected");
  assert.equal(timers.timeouts.size, 0);
  client.stop();
});

test("peer protocol errors close terminally without sending an error reply", async () => {
  const { client, sockets, timers } = lifecycleClient();
  await client.start();
  const socket = sockets[0]!;
  socket.open();

  socket.receive(JSON.stringify({ type: "future.bridge.notification", detail: "ignored" }));
  await flushAsyncHandlers();
  assert.deepEqual(socket.sent, [], "unknown future frames are ignored for version compatibility");

  socket.receive(JSON.stringify({ type: "protocol.error", error: "The bridge rejected this protocol." }));
  await flushAsyncHandlers();
  assert.deepEqual(socket.sent, [], "protocol.error must never be answered with protocol.error");
  assert.equal(socket.closes.at(-1)?.code, 1002);
  assert.equal((await client.status()).connection, "error");
  assert.match((await client.status()).lastError ?? "", /bridge rejected/i);

  socket.finishClose(1002);
  assert.equal(timers.timeouts.size, 0, "a terminal protocol close must not reconnect-loop");
  client.stop();
});

test("peer close code 1002 is terminal even when the desktop did not initiate it", async () => {
  const { client, sockets, timers } = lifecycleClient();
  await client.start();
  const socket = sockets[0]!;
  socket.open();
  socket.finishClose(1002);
  await flushAsyncHandlers();

  assert.equal(timers.timeouts.size, 0);
  assert.equal((await client.status()).connection, "error");
  assert.match((await client.status()).lastError ?? "", /protocol error/i);
  client.stop();
});

test("malformed remote frames have a bounded error reply budget", async () => {
  const { client, sockets, timers } = lifecycleClient();
  await client.start();
  const socket = sockets[0]!;
  socket.open();

  socket.receive("{");
  await flushAsyncHandlers();
  assert.equal(socket.sent.length, 1);
  assert.equal((JSON.parse(socket.sent[0]!) as { type: string }).type, "protocol.error");

  socket.receive("{");
  await flushAsyncHandlers();
  assert.equal(socket.sent.length, 1, "only one error frame is allowed per connection");
  assert.equal(socket.closes.at(-1)?.code, 1002);
  socket.finishClose(1002);
  assert.equal(timers.timeouts.size, 0);
  client.stop();
});

test("desktop rejects pairing key and code substitution before prompting", async () => {
  let prompts = 0;
  const { client, sockets } = lifecycleClient(async () => { prompts += 1; return false; });
  await client.start();
  const socket = sockets[0]!;
  socket.open();
  const pairingId = "pairing-123";
  const browserId = "browser-456";
  const codeForOriginalKeys = deriveRemotePairingCode({
    pairingId,
    browserId,
    signingPublicJwk: pairingSigningPublicJwk,
    encryptionPublicJwk: pairingEncryptionPublicJwk,
  });

  socket.receive(JSON.stringify({
    type: "pairing.request",
    pairing: {
      id: pairingId,
      browserId,
      label: "Test browser",
      code: codeForOriginalKeys,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingPublicJwk: pairingSigningPublicJwk,
      encryptionPublicJwk: substitutedEncryptionPublicJwk,
    },
  }));
  await flushAsyncHandlers();

  assert.equal(prompts, 0);
  assert.equal((JSON.parse(socket.sent[0]!) as { type: string }).type, "protocol.error");
  assert.match((await client.status()).lastError ?? "", /did not match the browser keys/i);
  client.stop();
});

test("desktop prompts with its independently derived pairing commitment", async () => {
  const prompts: RemotePairingPrompt[] = [];
  const { client, sockets } = lifecycleClient(async (pairing) => { prompts.push(pairing); return false; });
  await client.start();
  const socket = sockets[0]!;
  socket.open();
  const pairingId = "pairing-123";
  const browserId = "browser-456";
  const code = deriveRemotePairingCode({
    pairingId,
    browserId,
    signingPublicJwk: pairingSigningPublicJwk,
    encryptionPublicJwk: pairingEncryptionPublicJwk,
  });

  socket.receive(JSON.stringify({
    type: "pairing.request",
    pairing: {
      id: pairingId,
      browserId,
      label: "Test browser",
      code,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingPublicJwk: pairingSigningPublicJwk,
      encryptionPublicJwk: pairingEncryptionPublicJwk,
    },
  }));
  await flushAsyncHandlers();

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]?.code, code);
  const decision = JSON.parse(socket.sent[0]!) as { type: string; approved: boolean };
  assert.deepEqual(decision, { type: "pairing.decision", pairingId, approved: false });
  client.stop();
});

test("remote account removal retains its device credential until bridge deletion is confirmed", async () => {
  const events: string[] = [];
  await assert.rejects(() => runRemoteAccountRemoval({
    async revokeLocalAuthority() { events.push("revoke-local"); },
    async disableLocalAccess() { events.push("disable-local"); },
    async deleteBridgeAccount() { events.push("delete-bridge"); throw new Error("bridge unavailable"); },
    async clearLocalCredentials() { events.push("clear-credentials"); },
  }), /bridge unavailable/);

  assert.deepEqual(events, ["revoke-local", "disable-local", "delete-bridge"]);
});

test("remote account removal attempts bridge cleanup after local failures", async () => {
  const events: string[] = [];
  await assert.rejects(() => runRemoteAccountRemoval({
    async revokeLocalAuthority() { events.push("revoke-local"); throw new Error("local revoke failed"); },
    async disableLocalAccess() { events.push("disable-local"); throw new Error("local disable failed"); },
    async deleteBridgeAccount() { events.push("delete-bridge"); },
    async clearLocalCredentials() { events.push("clear-credentials"); },
  }), /local revoke failed.*local disable failed/);

  assert.deepEqual(events, ["revoke-local", "disable-local", "delete-bridge", "clear-credentials"]);
});

test("remote account removal retries local clearing after confirmed deletion returns unauthorized", async () => {
  const events: string[] = [];
  let deletionAttempts = 0;
  let clearAttempts = 0;
  const steps = {
    async revokeLocalAuthority() { events.push("revoke-local"); },
    async disableLocalAccess() { events.push("disable-local"); },
    async deleteBridgeAccount() {
      deletionAttempts += 1;
      events.push(`delete-bridge:${deletionAttempts}`);
      if (deletionAttempts > 1) throw new RemoteBridgeRequestError(401, "Sign in to continue.");
    },
    async clearLocalCredentials() {
      clearAttempts += 1;
      events.push(`clear-credentials:${clearAttempts}`);
      if (clearAttempts === 1) throw new Error("settings write failed");
    },
  };

  await assert.rejects(() => runRemoteAccountRemoval(steps), /settings write failed/);
  await runRemoteAccountRemoval(steps);

  assert.deepEqual(events, [
    "revoke-local", "disable-local", "delete-bridge:1", "clear-credentials:1",
    "revoke-local", "disable-local", "delete-bridge:2", "clear-credentials:2",
  ]);
});

test("remote account removal never treats not-found, network, or server errors as deletion confirmation", async () => {
  for (const failure of [
    new RemoteBridgeRequestError(404, "Deletion route not found."),
    new Error("network unavailable"),
    new RemoteBridgeRequestError(500, "Bridge failed."),
  ]) {
    let cleared = false;
    await assert.rejects(() => runRemoteAccountRemoval({
      async revokeLocalAuthority() {},
      async disableLocalAccess() {},
      async deleteBridgeAccount() { throw failure; },
      async clearLocalCredentials() { cleared = true; },
    }), new RegExp(failure.message));
    assert.equal(cleared, false);
  }
});

test("local revocation still purges tasks and uploads when secure-settings mutation fails", async () => {
  const events: string[] = [];
  const client = new RemoteAccessClient({
    settingsStore: {
      async removeRemoteBrowserGrant() { events.push("remove"); throw new Error("settings write failed"); },
    } as never,
    facade: {
      async execute(operation) {
        events.push(operation);
        return { stopped: { managementAborted: true, children: [] } };
      },
      async purgeUploads() { events.push("purge"); },
    },
    promptPairing: async () => false,
  });
  client.rememberActiveTask("grant-1", { taskId: "management-1" }, {
    browserId: "browser-1", grantId: "grant-1", requestId: "request-1",
  });

  await assert.rejects(() => client.revokeLocalGrant("grant-1"), /settings write failed/);
  assert.deepEqual(events, ["remove", "management.stop", "purge"]);
});

test("pairing approval copy treats the browser label as unverified data", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function promptRemoteBrowserPairing");
  const end = main.indexOf("\n}\n\nasync function configureRemoteAccess", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const prompt = main.slice(start, end);

  assert.match(prompt, /message: "Approve this remote browser\?"/);
  assert.match(prompt, /Unverified browser-supplied label/);
  assert.match(prompt, /JSON\.stringify\(pairing\.label\)/);
  assert.doesNotMatch(prompt, /message:\s*`[^`]*\$\{pairing\.label\}/);
  assert.match(prompt, /This is a full-trust grant/);
});

test("remote bridge HTTP failures preserve their response status", async () => {
  const main = await readFile(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const start = main.indexOf("async function remoteBridgeRequest");
  const end = main.indexOf("\n}\n\nasync function createMainWindow", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const request = main.slice(start, end);

  assert.match(request, /throw new RemoteBridgeRequestError\(/);
  assert.match(request, /response\.status/);
  const error = new RemoteBridgeRequestError(503, "Unavailable.");
  assert.equal(error.status, 503);
  assert.equal(error.name, "RemoteBridgeRequestError");
});
