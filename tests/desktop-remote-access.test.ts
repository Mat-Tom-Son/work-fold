import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import WebSocket from "ws";

import { RemoteAccessClient, runRemoteAccountRemoval } from "../desktop/src/remote-access.js";
import type { WorkFoldRemoteFacade, WorkFoldRemotePrincipal } from "../src/local/remote-management.js";
import type { RemoteAccessSettings } from "../desktop/src/settings.js";

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

function lifecycleClient(): {
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
    promptPairing: async () => false,
    createSocket: () => {
      const socket = new FakeRemoteSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    timers,
  });
  return { client, sockets, timers };
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
