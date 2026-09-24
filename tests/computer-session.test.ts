import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ComputerSessionService, type ComputerTurn, type NativeComputerOwner } from "../src/local/agent/computer-session.js";
import type { WaylandTransport } from "../src/local/agent/wayland-transport.js";

class Transport implements WaylandTransport {
  target = randomUUID(); lease = randomUUID(); closed = false; devices = 3;
  calls: string[] = []; listeners = new Set<() => void>();
  intercept?: (method: string) => Promise<void>;
  async call<T>(method: string): Promise<T> {
    this.calls.push(method); await this.intercept?.(method);
    if (this.closed) throw new Error("closed");
    if (method === "start") return { state: "active", targetId: this.target, devicesGranted: this.devices } as T;
    if (method === "begin") return { lease: this.lease, targetId: this.target } as T;
    if (method === "end") return { released: true } as T;
    throw new Error("Unexpected test command");
  }
  onClose(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() { if (this.closed) return; this.closed = true; for (const listener of this.listeners) listener(); }
}
const owner = (): NativeComputerOwner => ({ scope: "space", spaceId: randomUUID(), conversationId: `chat-${randomUUID()}`, spaceRoot: "/disposable/folder" });
const turn = (): ComputerTurn => ({ taskId: `task-${randomUUID()}`, cancelled: false });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("shared desktop stays assigned to the selected Chat and accepted turn", async () => {
  const transport = new Transport(); const service = new ComputerSessionService({ launch: async () => transport });
  const selected = owner(), accepted = turn();
  assert.deepEqual(await service.forSession(selected, () => accepted).listSharedScreens(), []);
  assert.equal(transport.calls.length, 0, "catalog/setup reads never launch or prompt");
  await service.start(selected);
  assert.deepEqual(await service.forSession(owner(), () => turn()).listSharedScreens(), []);
  await assert.rejects(service.forSession(selected, () => undefined).listSharedScreens(), /accepted turn/);
  const facilities = service.forSession(selected, () => accepted);
  assert.equal((await facilities.listSharedScreens())[0].id, transport.target);
  const competingTurn = turn();
  const competing = service.forSession(selected, () => competingTurn);
  await assert.rejects(competing.listSharedScreens(), /Another accepted turn/);
  assert.equal(transport.calls.filter(method => method === "begin").length, 1);
  accepted.settled = true;
  await service.releaseTurn(accepted.taskId);
  await assert.rejects(facilities.listSharedScreens(), /accepted turn/);
  const next = turn();
  await service.forSession(selected, () => next).listSharedScreens();
  assert.equal(transport.calls.filter(method => method === "begin").length, 2);
  await service.close();
  assert.equal(transport.closed, true);
});

test("Stop during setup fences late results and drains the launched helper", async () => {
  const launch = deferred(), transport = new Transport();
  const service = new ComputerSessionService({ launch: async () => { await launch.promise; return transport; } });
  const pending = service.start(owner());
  await service.stop(); launch.resolve();
  await assert.rejects(pending, /stopped/);
  assert.equal(transport.closed, true);
  assert.equal(service.status().state, "idle");
  assert.deepEqual(transport.calls, []);
});

test("cancelled setup closes even when cancellation precedes storing the helper", async () => {
  const launch = deferred(), transport = new Transport(), signal = new AbortController();
  const service = new ComputerSessionService({ launch: async () => { await launch.promise; return transport; } });
  const pending = service.start(owner(), signal.signal);
  signal.abort(); launch.resolve();
  await assert.rejects(pending, /abort/i);
  assert.equal(transport.closed, true);
});

test("a turn settling during lease acquisition cannot leave an unowned seat", async () => {
  const beginning = deferred(), started = deferred(), transport = new Transport();
  const service = new ComputerSessionService({ launch: async () => transport });
  const selected = owner(), accepted = turn(); await service.start(selected);
  transport.intercept = async method => { if (method === "begin") { started.resolve(); await beginning.promise; } };
  const pending = service.forSession(selected, () => accepted).listSharedScreens();
  await started.promise; accepted.settled = true; beginning.resolve();
  await assert.rejects(pending, /no longer owns/);
  assert.equal(transport.closed, true); assert.equal(service.status().capture, false);
});

test("permission status follows portal bit meanings and transport revocation", async () => {
  const transport = new Transport(); transport.devices = 1;
  const service = new ComputerSessionService({ launch: async () => transport });
  await service.start(owner());
  assert.equal(service.status().keyboard, true); assert.equal(service.status().pointer, false);
  await transport.close();
  assert.equal(service.status().capture, false); assert.equal(service.status().owner, undefined);
});
