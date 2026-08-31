import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import WebSocket from "ws";

import {
  RemoteAccessClient,
  RemoteBridgeRequestError,
  createRemoteBridgePublicationSync,
  deriveRemotePairingCode,
  generateRemoteDeviceKeys,
  runRemoteAccountRemoval,
  type RemotePairingPrompt,
  type RemoteViewerPageProvider,
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

test("remote revocation cascades desktop-local grant authority before uploads are purged", async () => {
  const events: string[] = [];
  const facade: WorkFoldRemoteFacade = {
    async execute(operation) {
      events.push(operation);
      return { stopped: { managementAborted: true, children: [] } };
    },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
    async revokeGrantAuthority(grantId) { events.push(`revoke-authority:${grantId ?? "all"}`); },
  };
  const client = clientFor(facade, events);
  client.rememberActiveTask("grant-1", { taskId: "management-1" }, {
    browserId: "browser-1", grantId: "grant-1", requestId: "request-1",
  });

  await client.revokeLocalGrant("grant-1");
  // Ordered desktop-local-first: tracked work stops, then the staged-act and
  // glance-marker cascade runs, then uploads purge — all before the caller's
  // bridge mutation (docs/fold-consecrations.md, browser revocation).
  assert.deepEqual(events, ["remove:grant-1", "management.stop", "revoke-authority:grant-1", "purge:grant-1"]);

  events.length = 0;
  await client.revokeAllLocalGrants();
  assert.deepEqual(events, ["remove:all", "revoke-authority:all", "purge:all"]);
});

test("a cascade failure never skips the upload purge and still surfaces the error", async () => {
  const events: string[] = [];
  const facade: WorkFoldRemoteFacade = {
    async execute() { throw new Error("Unexpected remote operation."); },
    async purgeUploads(grantId) { events.push(`purge:${grantId ?? "all"}`); },
    async revokeGrantAuthority() { throw new Error("staged-act store unavailable"); },
  };
  const client = clientFor(facade, events);

  await assert.rejects(() => client.revokeLocalGrant("grant-1"), /staged-act store unavailable/);
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

test("revocation refuses a queued decisions.decide before the desktop consumes it", async () => {
  const holdingBrowser = remoteTestBrowser("grant-holding");
  const revokedBrowser = remoteTestBrowser("grant-revoked-decide");
  const settings = remoteTestSettings([holdingBrowser, revokedBrowser]);
  let releaseHold!: () => void;
  const holdGate = new Promise<void>((resolve) => { releaseHold = resolve; });
  let markHoldStarted!: () => void;
  const holdStarted = new Promise<void>((resolve) => { markHoldStarted = resolve; });
  const executed: string[] = [];
  const fixture = remoteOperationClient(settings, {
    async execute(operation) {
      executed.push(operation);
      if (operation === "spaces.list") {
        markHoldStarted();
        await holdGate;
        return { spaces: [] };
      }
      if (operation === "management.stop") return { stopped: { managementAborted: true, children: [] } };
      return { decision: { id: "staged-1" }, receipted: true };
    },
    async purgeUploads() {},
    async revokeGrantAuthority() {},
  });
  await fixture.client.start();
  fixture.socket.open();

  // Hold the serialized authority queue with another grant's operation, queue
  // the decide behind it, then revoke the deciding grant. The fence raised at
  // the revocation call must refuse the decide before the facade — and so
  // before the decision path — ever runs: an in-flight decision from a
  // revoked browser is refused before consumption.
  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, holdingBrowser, "request-hold", "spaces.list")));
  await holdStarted;
  fixture.socket.receive(JSON.stringify(remoteOperationFrame(
    settings,
    revokedBrowser,
    "request-decide",
    "decisions.decide",
    { id: "staged-1", decision: "approved" },
  )));
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.event" && message.envelope?.header?.requestId === "request-decide";
    }),
    "the decide operation never queued behind the held authority block",
  );
  const revoke = fixture.client.revokeLocalGrant(revokedBrowser.grant.id);
  releaseHold();
  await revoke;
  await flushAsyncHandlers();
  await flushAsyncHandlers();

  assert.deepEqual(executed.filter((operation) => operation === "decisions.decide"), [],
    "a revoked grant's queued decide must never reach the decision path");
  assert.equal(
    fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { type?: string; envelope?: { header?: { requestId?: string } } };
      return message.type === "operation.complete" && message.envelope?.header?.requestId === "request-decide";
    }),
    false,
    "no completion may be disclosed to the revoked grant",
  );
  fixture.client.stop();
});

function decryptTestResponse(
  browser: RemoteTestBrowser,
  settings: RemoteAccessSettings,
  envelope: { header: Record<string, unknown>; iv: string; ciphertext: string },
): Record<string, unknown> {
  const key = testTransportKey(browser.encryptionPrivateJwk, settings.deviceEncryptionPublicJwk, browser.grant.id);
  const encrypted = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(testCanonicalize(envelope.header)));
  decipher.setAuthTag(encrypted.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8")) as Record<string, unknown>;
}

test("the glance projection crosses within its 64 KB bound and an oversized digest is an honest refusal", async () => {
  const browser = remoteTestBrowser("grant-glance");
  const settings = remoteTestSettings([browser]);
  const glances = new Map<string, unknown>([
    ["request-glance-ok", { glance: { cursor: "", running: [], needsYou: [], changes: [], checks: [], seen: {} } }],
    ["request-glance-huge", { glance: { padding: "x".repeat(80 * 1024) } }],
  ]);
  let nextGlance = "request-glance-ok";
  const fixture = remoteOperationClient(settings, {
    async execute(operation) {
      if (operation === "management.glance") return glances.get(nextGlance);
      if (operation === "decisions.list") return { decisions: [] };
      throw new Error(`unexpected operation ${operation}`);
    },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();

  const completions = () => fixture.socket.sent
    .map((value) => JSON.parse(value) as { type?: string; envelope?: { header?: Record<string, unknown>; iv?: string; ciphertext?: string } })
    .filter((message) => message.type === "operation.complete");

  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browser, "request-glance-ok", "management.glance")));
  await waitForRemoteTest(() => completions().length === 1, "the bounded digest never completed");
  const bounded = completions()[0]!.envelope as { header: Record<string, unknown>; iv: string; ciphertext: string };
  assert.equal(bounded.header.ok, true);
  const boundedPayload = decryptTestResponse(browser, settings, bounded);
  assert.deepEqual(Object.keys(boundedPayload), ["result"], "a served digest crosses as an ordinary result");

  nextGlance = "request-glance-huge";
  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browser, "request-glance-huge", "management.glance")));
  await waitForRemoteTest(() => completions().length === 2, "the oversized digest never settled");
  const oversized = completions()[1]!.envelope as { header: Record<string, unknown>; iv: string; ciphertext: string };
  assert.equal(oversized.header.ok, false, "an oversized digest is refused, never silently trimmed");
  const oversizedPayload = decryptTestResponse(browser, settings, oversized);
  assert.match(String(oversizedPayload.error), /64 KB/);

  // The decision vocabulary dispatches through the same allowlist.
  fixture.socket.receive(JSON.stringify(remoteOperationFrame(settings, browser, "request-decisions", "decisions.list")));
  await waitForRemoteTest(() => completions().length === 3, "decisions.list never completed");
  assert.equal((completions()[2]!.envelope as { header: Record<string, unknown> }).header.ok, true);
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

function viewerPageClient(
  initialSettings: RemoteAccessSettings,
  viewerPages: RemoteViewerPageProvider,
): { client: RemoteAccessClient; socket: FakeRemoteSocket; state: { settings: RemoteAccessSettings | null } } {
  const state = { settings: structuredClone(initialSettings) as RemoteAccessSettings | null };
  const socket = new FakeRemoteSocket();
  const client = new RemoteAccessClient({
    settingsStore: {
      async getRemoteAccess() { return structuredClone(state.settings); },
    } as never,
    facade: {
      async execute() { throw new Error("Unexpected remote operation."); },
      async purgeUploads() {},
    },
    promptPairing: async () => false,
    createSocket: () => socket as unknown as WebSocket,
    timers: new ManualRemoteTimers(),
    viewerPages,
  });
  return { client, socket, state };
}

function sentViewerPages(socket: FakeRemoteSocket): Array<Record<string, unknown>> {
  return socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === "viewer.page");
}

test("viewer.fetch answers with a device-signed viewer-page envelope built from the publication service", async () => {
  const settings = remoteTestSettings([]);
  const serves: string[] = [];
  const provider: RemoteViewerPageProvider = {
    async servePage(publicationId) {
      serves.push(publicationId);
      return {
        state: "served",
        publicationId,
        ciphertext: randomBytes(48).toString("base64url"),
        iv: randomBytes(12).toString("base64url"),
        contentDigest: "sha256:served-digest",
        servedAt: new Date().toISOString(),
        byteSize: 48,
        snapshotEnabled: true,
      };
    },
  };
  const { client, socket } = viewerPageClient(settings, provider);
  await client.start();
  socket.open();
  socket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "fetch-1", publicationId: "publication-1" }));
  await waitForRemoteTest(() => sentViewerPages(socket).length === 1, "expected one viewer.page reply");

  assert.deepEqual(serves, ["publication-1"]);
  const frame = sentViewerPages(socket)[0]!;
  assert.equal(frame.fetchId, "fetch-1");
  assert.equal(frame.publicationId, "publication-1");
  assert.equal(frame.state, undefined, "a served page carries an envelope, not a refusal state");
  const envelope = frame.envelope as { header: Record<string, unknown>; iv: string; ciphertext: string; signature: string };
  assert.deepEqual(envelope.header, {
    type: "work-fold.viewer-page.v1",
    accountId: settings.accountId,
    deviceId: settings.accountId,
    publicationId: "publication-1",
    fetchId: "fetch-1",
    contentDigest: "sha256:served-digest",
    servedAt: envelope.header.servedAt,
  });
  const signedText = `${testCanonicalize(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
  assert.equal(
    verify(
      "sha256",
      Buffer.from(signedText),
      { key: createPublicKey({ key: settings.deviceSigningPublicJwk as NodeJsonWebKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(envelope.signature, "base64url"),
    ),
    true,
    "the envelope verifies under the device signing key exactly as the bridge admits it",
  );
});

test("viewer.app.fetch relays the typed call and answers with a device-signed viewer-app envelope", async () => {
  const settings = remoteTestSettings([]);
  const serves: Array<{ publicationId: string; call: unknown }> = [];
  const provider: RemoteViewerPageProvider = {
    async servePage() {
      throw new Error("The app frame must never reach the page path.");
    },
    async serveAppCall(publicationId, call) {
      serves.push({ publicationId, call: structuredClone(call) });
      if (publicationId === "publication-app-gone") return { state: "nothing-here", publicationId };
      return {
        state: "served",
        publicationId,
        ciphertext: randomBytes(48).toString("base64url"),
        iv: randomBytes(12).toString("base64url"),
        contentDigest: "sha256:app-digest",
        callDigest: "sha256:call-digest",
        servedAt: new Date().toISOString(),
        byteSize: 48,
      };
    },
  };
  const { client, socket } = viewerPageClient(settings, provider);
  await client.start();
  socket.open();
  const call = { kind: "data.get", key: "public/greeting" };
  socket.receive(JSON.stringify({ type: "viewer.app.fetch", fetchId: "fetch-app-1", publicationId: "publication-app-1", call }));
  socket.receive(JSON.stringify({ type: "viewer.app.fetch", fetchId: "fetch-app-2", publicationId: "publication-app-gone", call: { kind: "entry" } }));
  const sentAppResults = () => socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((frame) => frame.type === "viewer.app.result");
  await waitForRemoteTest(() => sentAppResults().length === 2, "expected two viewer.app.result replies");

  assert.deepEqual(serves, [
    { publicationId: "publication-app-1", call },
    { publicationId: "publication-app-gone", call: { kind: "entry" } },
  ], "the desktop passes the relayed call to the publication service verbatim");
  const [served, refused] = sentAppResults() as [Record<string, unknown>, Record<string, unknown>];
  assert.equal(served.fetchId, "fetch-app-1");
  const envelope = served.envelope as { header: Record<string, unknown>; iv: string; ciphertext: string; signature: string };
  assert.deepEqual(envelope.header, {
    type: "work-fold.viewer-app.v1",
    accountId: settings.accountId,
    deviceId: settings.accountId,
    publicationId: "publication-app-1",
    fetchId: "fetch-app-1",
    callDigest: "sha256:call-digest",
    contentDigest: "sha256:app-digest",
    servedAt: envelope.header.servedAt,
  });
  const signedText = `${testCanonicalize(envelope.header)}.${envelope.iv}.${envelope.ciphertext}`;
  assert.equal(
    verify(
      "sha256",
      Buffer.from(signedText),
      { key: createPublicKey({ key: settings.deviceSigningPublicJwk as NodeJsonWebKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(envelope.signature, "base64url"),
    ),
    true,
    "the app envelope verifies under the device signing key exactly as the bridge admits it",
  );
  assert.deepEqual(refused, {
    type: "viewer.app.result",
    fetchId: "fetch-app-2",
    publicationId: "publication-app-gone",
    state: "nothing-here",
  }, "refusals stay typed and content-free");

  // A desktop without the app hook ignores the frame entirely, like an older
  // build; the bridge settles the viewer honestly.
  const { client: pageOnlyClient, socket: pageOnlySocket } = viewerPageClient(settings, {
    async servePage(publicationId) {
      return { state: "nothing-here", publicationId };
    },
  });
  await pageOnlyClient.start();
  pageOnlySocket.open();
  pageOnlySocket.receive(JSON.stringify({ type: "viewer.app.fetch", fetchId: "fetch-old", publicationId: "publication-any", call: { kind: "entry" } }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(pageOnlySocket.sent.filter((raw) => raw.includes("viewer.app.result")).length, 0,
    "a desktop without the app hook stays silent");
});

test("viewer.fetch refusals stay typed and content-free, and disabled or providerless desktops stay silent", async () => {
  const settings = remoteTestSettings([]);
  const results = new Map<string, RemoteViewerPageProvider["servePage"]>([
    ["publication-gone", async (publicationId: string) => ({ state: "nothing-here" as const, publicationId })],
    ["publication-broken", async () => { throw new Error("render exploded with /private/path/detail"); }],
  ]);
  const provider: RemoteViewerPageProvider = {
    async servePage(publicationId) {
      const serve = results.get(publicationId);
      if (!serve) throw new Error(`unexpected serve ${publicationId}`);
      return serve(publicationId);
    },
  };
  const { client, socket, state } = viewerPageClient(settings, provider);
  await client.start();
  socket.open();
  socket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "fetch-gone", publicationId: "publication-gone" }));
  socket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "fetch-broken", publicationId: "publication-broken" }));
  await waitForRemoteTest(() => sentViewerPages(socket).length === 2, "expected two viewer.page refusals");

  const frames = sentViewerPages(socket);
  assert.deepEqual(frames[0], { type: "viewer.page", fetchId: "fetch-gone", publicationId: "publication-gone", state: "nothing-here" });
  assert.deepEqual(
    frames[1],
    { type: "viewer.page", fetchId: "fetch-broken", publicationId: "publication-broken", state: "not-available" },
    "a host failure is a vague not-available; the reason never leaves the desktop",
  );
  assert.doesNotMatch(socket.sent.join("\n"), /private\/path\/detail/);

  const malformedBefore = socket.sent.length;
  socket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "bad fetch id", publicationId: "publication-gone" }));
  await waitForRemoteTest(
    () => socket.sent.slice(malformedBefore).some((raw) => (JSON.parse(raw) as { type?: string }).type === "protocol.error"),
    "a malformed viewer.fetch frame is a protocol error",
  );

  state.settings = { ...structuredClone(settings), enabled: false };
  const disabledBefore = sentViewerPages(socket).length;
  socket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "fetch-disabled", publicationId: "publication-gone" }));
  await flushAsyncHandlers();
  await flushAsyncHandlers();
  assert.equal(sentViewerPages(socket).length, disabledBefore, "disabled Remote access serves nothing");

  const bareSocket = new FakeRemoteSocket();
  const bareClient = new RemoteAccessClient({
    settingsStore: { async getRemoteAccess() { return remoteTestSettings([]); } } as never,
    facade: { async execute() { throw new Error("unused"); }, async purgeUploads() {} },
    promptPairing: async () => false,
    createSocket: () => bareSocket as unknown as WebSocket,
    timers: new ManualRemoteTimers(),
  });
  await bareClient.start();
  bareSocket.open();
  bareSocket.receive(JSON.stringify({ type: "viewer.fetch", fetchId: "fetch-old", publicationId: "publication-any" }));
  await flushAsyncHandlers();
  await flushAsyncHandlers();
  assert.equal(bareSocket.sent.filter((raw) => raw.includes("viewer.page")).length, 0,
    "a desktop without a publication provider ignores the frame like an older desktop");
});

test("device reconnect re-drives pending publication bridge work through the provider hook", async () => {
  const settings = remoteTestSettings([]);
  let redrives = 0;
  const provider: RemoteViewerPageProvider = {
    async servePage(publicationId) { return { state: "nothing-here", publicationId }; },
    async onDeviceConnected() { redrives += 1; },
  };
  const { client, socket } = viewerPageClient(settings, provider);
  await client.start();
  socket.open();
  await waitForRemoteTest(() => redrives === 1, "expected the redrive hook on connect");
});

test("the bridge's resting notice reaches the provider hook and malformed frames are protocol errors", async () => {
  const settings = remoteTestSettings([]);
  const noted: Array<{ publicationId: string; reason: string }> = [];
  const provider: RemoteViewerPageProvider = {
    async servePage(publicationId) { return { state: "nothing-here", publicationId }; },
    async noteResting(publicationId, reason) { noted.push({ publicationId, reason }); },
  };
  const { client, socket, state } = viewerPageClient(settings, provider);
  await client.start();
  socket.open();
  socket.receive(JSON.stringify({ type: "viewer.resting", publicationId: "publication-busy", reason: "byte-budget" }));
  await waitForRemoteTest(() => noted.length === 1, "expected one resting note");
  assert.deepEqual(noted, [{ publicationId: "publication-busy", reason: "byte-budget" }]);

  socket.receive(JSON.stringify({ type: "viewer.resting", publicationId: "publication-busy", reason: "made-up" }));
  await waitForRemoteTest(
    () => socket.sent.some((raw) => raw.includes("protocol.error")),
    "an unknown reason token is a protocol error",
  );
  assert.equal(noted.length, 1);

  // Disabled Remote access drops the note instead of recording under dead
  // authority; a provider without the hook ignores the frame entirely.
  state.settings = { ...structuredClone(settings), enabled: false };
  socket.receive(JSON.stringify({ type: "viewer.resting", publicationId: "publication-busy", reason: "serve-rate" }));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  assert.equal(noted.length, 1, "a disabled desktop records nothing");
});

test("the status view derives the isolated pages- viewer origin beside the management address", async () => {
  const settings = remoteTestSettings([]);
  const { client } = viewerPageClient(settings, {
    async servePage(publicationId) { return { state: "nothing-here", publicationId }; },
  });
  const status = await client.status();
  assert.equal(status.url, "https://operation-tests.bridge.example");
  assert.equal(
    status.viewerOrigin,
    "https://pages-operation-tests.bridge.example",
    "share links compose against the pages- origin, never the management origin",
  );
});

test("the publication bridge sync lane is content-free, idempotent, and honest about a missing address", async () => {
  const requests: Array<{ url: string; method: string; authorization: string; body: unknown }> = [];
  let nextResponse: { status: number; body: unknown } = { status: 200, body: { publication: {} } };
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: String((init?.headers as Record<string, string>).authorization),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const settings = remoteTestSettings([]);
  const state = { settings: settings as RemoteAccessSettings | null };
  const sync = createRemoteBridgePublicationSync(async () => state.settings, fetchFn);

  await sync.upsertSlot({
    publicationId: "publication-sync",
    operationId: "operation-sync-1",
    kind: "page",
    state: "active",
    serveRatePerMinute: 60,
    byteBudgetPerDay: 1024,
    snapshotEnabled: false,
  });
  assert.equal(requests[0]!.url, "https://bridge.example/api/device/publications/publication-sync");
  assert.equal(requests[0]!.method, "PUT");
  assert.equal(requests[0]!.authorization, `Bearer ${settings.deviceToken}`);
  assert.deepEqual(Object.keys(requests[0]!.body as Record<string, unknown>).sort(), [
    "byteBudgetPerDay", "kind", "operationId", "serveRatePerMinute", "snapshotEnabled", "state",
  ], "slot syncs carry only content-free fields — no titles, paths, keys, or bytes");

  nextResponse = { status: 200, body: { snapshot: {}, stored: true } };
  await sync.putSnapshot({
    publicationId: "publication-sync",
    ciphertext: "Y2lwaGVydGV4dA",
    iv: "aXYtdGVzdC0xMjM0",
    contentDigest: "sha256:seed",
    capturedAt: "2026-08-10T10:00:00.000Z",
  });
  assert.equal(requests[1]!.url, "https://bridge.example/api/device/publications/publication-sync/snapshot");
  assert.equal(requests[1]!.method, "PUT");
  assert.deepEqual(Object.keys(requests[1]!.body as Record<string, unknown>).sort(), [
    "capturedAt", "ciphertext", "contentDigest", "iv",
  ], "snapshot pushes carry exactly the bounded ciphertext fields");

  nextResponse = { status: 404, body: { ok: false, error: "Not found." } };
  await assert.rejects(
    sync.putSnapshot({
      publicationId: "publication-sync",
      ciphertext: "Y2lwaGVydGV4dA",
      iv: "aXYtdGVzdC0xMjM0",
      contentDigest: "sha256:seed",
      capturedAt: "2026-08-10T10:00:00.000Z",
    }),
    (error: unknown) => error instanceof RemoteBridgeRequestError && error.status === 404,
    "a snapshot push is not a deletion lane: a missing slot surfaces for the caller's best-effort catch",
  );
  await sync.deleteSlot("publication-sync");
  await sync.deleteSnapshot("publication-sync");
  assert.equal(requests[3]!.method, "DELETE");
  assert.equal(requests[4]!.url, "https://bridge.example/api/device/publications/publication-sync/snapshot");

  nextResponse = { status: 409, body: { ok: false, error: "That operation id was already used for a different publication sync." } };
  await assert.rejects(
    sync.upsertSlot({
      publicationId: "publication-sync",
      operationId: "operation-sync-1",
      kind: "page",
      state: "active",
      serveRatePerMinute: 60,
      byteBudgetPerDay: 1024,
      snapshotEnabled: false,
    }),
    (error: unknown) => error instanceof RemoteBridgeRequestError && error.status === 409,
    "conflicting syncs surface the bridge's status for the redrive lane",
  );

  state.settings = null;
  await sync.deleteSlot("publication-after-removal");
  await sync.deleteSnapshot("publication-after-removal");
  assert.equal(requests.length, 6, "deletions without an account are already satisfied and never invent a request");
  await assert.rejects(
    sync.putSnapshot({
      publicationId: "publication-after-removal",
      ciphertext: "Y2lwaGVydGV4dA",
      iv: "aXYtdGVzdC0xMjM0",
      contentDigest: "sha256:seed",
      capturedAt: "2026-08-10T10:00:00.000Z",
    }),
    /no address/,
    "a snapshot push without an enrolled address fails instead of pretending",
  );
  await assert.rejects(
    sync.upsertSlot({
      publicationId: "publication-no-address",
      operationId: "operation-no-address",
      kind: "page",
      state: "active",
      serveRatePerMinute: 60,
      byteBudgetPerDay: 1024,
      snapshotEnabled: false,
    }),
    /no address/,
    "slot creation without an enrolled address fails instead of pretending",
  );
});

test("a live watch streams sequenced progress events under its completion", async () => {
  const browser = remoteTestBrowser("grant-watch");
  const settings = remoteTestSettings([browser]);
  const fixture = remoteOperationClient(settings, {
    async execute() { throw new Error("management.watch must route through the watch port"); },
    async watch(input, _principal, emit) {
      assert.deepEqual(input, { conversationId: "management-chat" });
      emit({ activity: "Reading the folder" });
      emit({ assistantText: "Here is" });
      emit({ assistantDelta: " the reply." });
      emit({ activity: "Writing the reply" });
      return { state: "settled", settled: true };
    },
    async purgeUploads() {},
  });
  await fixture.client.start();
  fixture.socket.open();
  fixture.socket.receive(JSON.stringify(
    remoteOperationFrame(settings, browser, "request-watch", "management.watch", { conversationId: "management-chat" }),
  ));
  await waitForRemoteTest(
    () => fixture.socket.sent.some((value) => {
      const message = JSON.parse(value) as { envelope?: { header?: { eventKind?: string; requestId?: string } } };
      return message.envelope?.header?.requestId === "request-watch"
        && message.envelope.header.eventKind === "operation.complete";
    }),
    "the watch never completed",
  );
  const headers = fixture.socket.sent
    .map((value) => JSON.parse(value) as { envelope?: { header?: { eventKind?: string; sequence?: number; requestId?: string } } })
    .filter((message) => message.envelope?.header?.requestId === "request-watch")
    .map((message) => message.envelope?.header);
  // The running event, all encrypted progress ticks, then the completion — with
  // strictly increasing sequences so the bridge's monotonic guard admits all.
  assert.deepEqual(headers.map((header) => header?.eventKind), [
    "operation.event", "operation.event", "operation.event", "operation.event", "operation.event", "operation.complete",
  ]);
  assert.deepEqual(headers.map((header) => header?.sequence), [1, 2, 3, 4, 5, 6]);
});
