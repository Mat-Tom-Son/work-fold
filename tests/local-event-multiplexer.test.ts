import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { createLocalEventMultiplexer } from "../web-local/src/lib/local-event-multiplexer.js";
import { createLocalEventSink, createLocalEventChannel, parseLocalEventSubscriptions } from "../src/local/local-event-stream.js";
import type { LocalEventEnvelope, LocalEventSubscription } from "../src/shared/local-event-stream.js";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("many independent consumers share one connection, retain separate cursors and await old-stream drainage", async () => {
  const connections: Array<{ descriptors: () => LocalEventSubscription[]; receive: (event: LocalEventEnvelope) => void; error: (error: unknown) => void; release: () => void; closing: boolean }> = [];
  const pool = createLocalEventMultiplexer((descriptors, receive, error) => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => { release = resolve; });
    const connection = { descriptors, receive, error, release, closing: false };
    connections.push(connection);
    return { close: () => { connection.closing = true; return drained; } };
  });
  const sources = Array.from({ length: 12 }, (_, index) => pool.subscribe(`/api/spaces/lab/conversations/chat-${index}/events`));
  const duplicate = pool.subscribe("/api/spaces/lab/conversations/chat-0/events");
  const events: string[] = [];
  sources[0]!.onmessage = (event) => { events.push(`first:${event.data}`); };
  duplicate.onmessage = (event) => { events.push(`duplicate:${event.data}`); };
  await settle();
  assert.equal(connections.length, 1);
  const first = connections[0]!;
  const ids = first.descriptors().map((item) => item.id);
  assert.equal(new Set(ids).size, 13);
  first.receive({ subscriptionId: ids[0]!, event: "first snapshot", eventId: "21" });
  first.receive({ subscriptionId: ids[12]!, event: "new snapshot", eventId: "22" });
  assert.deepEqual(events, ['first:"first snapshot"', 'duplicate:"new snapshot"']);
  assert.equal(first.descriptors()[0]!.lastEventId, "21");
  assert.equal(first.descriptors()[12]!.lastEventId, "22");
  sources[1]!.close();
  await settle();
  assert.equal(first.closing, true);
  assert.equal(connections.length, 1, "the replacement cannot compete with a draining physical stream");
  first.receive({ subscriptionId: ids[0]!, event: "late old frame", eventId: "99" });
  first.error(new Error("late old failure"));
  assert.equal(sources[0]!.lastEventId, "21");
  const transient = pool.subscribe("/api/spaces/lab/file-events");
  transient.close();
  first.release();
  await settle();
  assert.equal(connections.length, 2);
  const second = connections[1]!;
  assert.equal(second.descriptors().length, 12);
  assert.equal(second.descriptors()[0]!.lastEventId, "21");
  let errors = 0;
  let opens = 0;
  sources[0]!.onerror = () => { throw new Error("bad consumer"); };
  duplicate.onerror = () => { errors++; };
  duplicate.onopen = () => { opens++; };
  second.receive({ subscriptionId: ids[0]!, error: { status: 404, message: "Space removed" } });
  second.receive({ subscriptionId: ids[12]!, ready: true });
  assert.equal(opens, 1);
  assert.equal(errors, 0, "a removed channel does not fail its sibling");
  second.error(new Error("physical disconnection"));
  assert.equal(errors, 1, "a throwing callback cannot stop delivery to other consumers");
  for (const source of sources) source.close();
  duplicate.close();
  await settle();
  second.release();
  await settle();
  assert.equal(connections.length, 2, "closing the last consumer opens no replacement");
});

test("local stream descriptors are bounded exact routes, never an arbitrary URL proxy", () => {
  assert.equal(parseLocalEventSubscriptions({ subscriptions: [{ id: "one", path: "/api/spaces/lab/conversations/chat/events", lastEventId: "42" }] })[0]!.lastEventId, "42");
  assert.equal(parseLocalEventSubscriptions({ subscriptions: [{ id: "one", path: "/api/spaces/lab/conversations/chat.history-1/events" }] }).length, 1, "existing valid conversation ids may contain dots");
  for (const path of ["https://elsewhere/api/management/control-events", "/api/requests/q/answer", "/api/spaces/../file-events", "/api/spaces/lab/file-events?token=x", "/api/management/glance"]) {
    assert.throws(() => parseLocalEventSubscriptions({ subscriptions: [{ id: "one", path }] }));
  }
  assert.throws(() => parseLocalEventSubscriptions({ subscriptions: [{ id: "one", path: "/api/management/control-events", lastEventId: "9007199254740992" }] }));
  assert.throws(() => parseLocalEventSubscriptions({ subscriptions: Array.from({ length: 129 }, (_, index) => ({ id: String(index), path: "/api/management/control-events" })) }));
  assert.throws(() => parseLocalEventSubscriptions({ subscriptions: [{ id: "same", path: "/api/management/control-events" }, { id: "same", path: "/api/management/control-events" }] }));
});

test("physical close disposes all channels once, including a watcher that finishes initialization after disconnect", async () => {
  const output: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableLength: 0,
    writeHead() {}, write(value: string) { output.push(value); return true; },
    end() { this.writableEnded = true; this.emit("close"); },
  });
  const parent = createLocalEventSink(response as unknown as ServerResponse);
  const channels = Array.from({ length: 10 }, (_, index) => createLocalEventChannel(parent, `channel-${index}`));
  let disposed = 0;
  for (const channel of channels) channel.onClose(() => { disposed++; });
  channels[0]!.send({ type: "turn_state", running: true }, 7);
  assert.match(output[0]!, /"subscriptionId":"channel-0".*"eventId":"7"/);
  let opened = 0;
  const pendingWatcher = Promise.resolve().then(() => { if (!channels[0]!.closed) opened++; });
  response.emit("close");
  await pendingWatcher;
  parent.close();
  assert.equal(disposed, 10);
  assert.equal(opened, 0);
  assert.equal(channels[1]!.send({ private: "late result" }), false);
  let lateCleanup = 0;
  channels[1]!.onClose(() => { lateCleanup++; });
  assert.equal(lateCleanup, 1);
});

test("backpressure is bounded on the physical stream rather than independently per channel", () => {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, writableLength: 600_000,
    writeHead() {}, write() { throw new Error("must not queue more bytes"); }, end() { this.writableEnded = true; },
  });
  const parent = createLocalEventSink(response as unknown as ServerResponse);
  const child = createLocalEventChannel(parent, "chat");
  assert.equal(child.send({ text: "next" }), false);
  assert.equal(parent.closed, true);
  assert.equal(child.closed, true);
});
