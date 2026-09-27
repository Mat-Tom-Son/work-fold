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

test("app-wide sharing hands off between Folder Chats and management without another grant", async () => {
  const transport = new Transport(); const service = new ComputerSessionService({ launch: async () => transport });
  const selected = owner(), accepted = turn();
  assert.deepEqual(await service.forSession(selected, () => accepted).listSharedScreens(), []);
  assert.equal(transport.calls.length, 0, "catalog reads never launch or prompt");
  await service.start();
  assert.equal(service.status().owner, undefined, "setup requires no existing Chat");
  await assert.rejects(service.forSession(selected, () => undefined).listSharedScreens(), /accepted turn/);
  const facilities = service.forSession(selected, () => accepted);
  assert.equal((await facilities.listSharedScreens())[0].id, transport.target);
  assert.equal(service.status().owner?.conversationId, selected.conversationId);
  const other = owner(), next = turn();
  const competing = service.forSession(other, () => next);
  await assert.rejects(competing.listSharedScreens(), /Another Chat/);
  await assert.rejects(service.forSession(other, () => accepted).listSharedScreens(), /Another Chat/, "task identity cannot substitute for Chat identity");
  await service.releaseSession(other);
  assert.equal(service.status().state, "active", "unrelated disposal does not stop sharing");
  accepted.settled = true; await service.releaseTurn(accepted.taskId);
  assert.equal(service.status().owner, undefined);
  await assert.rejects(facilities.listSharedScreens(), /accepted turn/);
  assert.equal((await competing.listSharedScreens())[0].id, transport.target);
  next.settled = true; await service.releaseTurn(next.taskId);
  const management = { scope: "management" as const, conversationId: "management-chat", spaceRoot: "/management" };
  const managementTurn = turn();
  await service.forSession(management, () => managementTurn).listSharedScreens();
  assert.equal(service.status().owner?.scope, "management");
  assert.equal(transport.calls.filter(method => method === "start").length, 1);
  assert.equal(transport.calls.filter(method => method === "begin").length, 3);
  await service.releaseSession(management);
  assert.equal(service.status().state, "idle", "disposing the controller revokes sharing");
  assert.equal(transport.closed, true);
  await service.close();
});

test("Stop during setup fences late results and drains the launched helper", async () => {
  const launch = deferred(), transport = new Transport();
  const service = new ComputerSessionService({ launch: async () => { await launch.promise; return transport; } });
  const pending = service.start();
  await service.stop(); launch.resolve();
  await assert.rejects(pending, /stopped/);
  assert.equal(transport.closed, true);
  assert.equal(service.status().state, "idle");
  assert.deepEqual(transport.calls, []);
});

test("cancelled setup closes even when cancellation precedes storing the helper", async () => {
  const launch = deferred(), transport = new Transport(), signal = new AbortController();
  const service = new ComputerSessionService({ launch: async () => { await launch.promise; return transport; } });
  const pending = service.start(signal.signal);
  signal.abort(); launch.resolve();
  await assert.rejects(pending, /abort/i);
  assert.equal(transport.closed, true);
});

test("a turn settling during lease acquisition cannot leave an unowned seat", async () => {
  const beginning = deferred(), started = deferred(), transport = new Transport();
  const service = new ComputerSessionService({ launch: async () => transport });
  const selected = owner(), accepted = turn(); await service.start();
  transport.intercept = async method => { if (method === "begin") { started.resolve(); await beginning.promise; } };
  const pending = service.forSession(selected, () => accepted).listSharedScreens();
  await started.promise; accepted.settled = true; beginning.resolve();
  await assert.rejects(pending, /no longer has access/);
  assert.equal(transport.closed, true); assert.equal(service.status().capture, false);
});

test("permission status follows portal bit meanings and transport revocation", async () => {
  const transport = new Transport(); transport.devices = 1;
  const service = new ComputerSessionService({ launch: async () => transport });
  await service.start();
  assert.equal(service.status().keyboard, true); assert.equal(service.status().pointer, false);
  await transport.close();
  assert.equal(service.status().capture, false); assert.equal(service.status().owner, undefined);
});
