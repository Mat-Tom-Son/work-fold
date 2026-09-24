import { resolve } from "node:path";
import type { ComputerHostFacilities, ComputerSessionOwner, ComputerSessionSummary, SharedScreenAction, SharedScreenObservation } from "../../shared/computer-session.js";
import type { WaylandTransport } from "./wayland-transport.js";

export interface NativeComputerOwner extends ComputerSessionOwner { spaceRoot: string }
export interface ComputerTurn { taskId: string; cancelled: boolean; settled?: boolean }
const ownerKey = (owner: NativeComputerOwner) => JSON.stringify([owner.scope, owner.spaceId, resolve(owner.spaceRoot), owner.conversationId]);
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const conversationId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value);

/** One app-owned grant, explicitly assigned to a Chat before a turn begins.
 * Native full-trust Extensions can use these same optional host facilities. */
export class ComputerSessionService {
  #launch: () => Promise<WaylandTransport>;
  #transport?: WaylandTransport;
  #owner?: NativeComputerOwner;
  #target?: string;
  #generation = 0;
  #state: ComputerSessionSummary["state"] = "idle";
  #detail = "Start sharing a screen for a chosen Chat.";
  #devices = 0;
  #lease?: { taskId: string; id: string };
  #busyTask?: string;
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #closing?: Promise<void>;
  #closed = false;
  #faulted = false;
  constructor(options: { launch(): Promise<WaylandTransport> }) { this.#launch = options.launch; }

  status(): ComputerSessionSummary {
    const owner = this.#owner;
    return { state: this.#state,
      ...(owner ? { owner: { scope: owner.scope, conversationId: owner.conversationId, ...(owner.spaceId ? { spaceId: owner.spaceId } : {}) } } : {}),
      capture: this.#state === "active", pointer: this.#state === "active" && (this.#devices & 2) !== 0,
      keyboard: this.#state === "active" && (this.#devices & 1) !== 0,
      controlInUse: Boolean(this.#lease || this.#busyTask), detail: this.#detail, checkedAt: new Date().toISOString() };
  }

  async start(owner: NativeComputerOwner, signal?: AbortSignal): Promise<ComputerSessionSummary> {
    signal?.throwIfAborted();
    if (this.#closing) await this.#closing;
    if (this.#closed || this.#faulted) throw new Error("Restart work-fold before sharing this desktop again.");
    if (this.#state === "active" || this.#state === "requesting") throw new Error("Stop the existing screen share before choosing another Chat.");
    if (!conversationId(owner.conversationId) || (owner.scope === "space" ? !conversationId(owner.spaceId) : owner.spaceId !== undefined)) throw new Error("Choose an existing Chat for desktop sharing.");
    const generation = ++this.#generation;
    this.#owner = { ...owner, spaceRoot: resolve(owner.spaceRoot) };
    this.#state = "requesting"; this.#detail = "Choose a screen in the desktop sharing dialog.";
    let transport: WaylandTransport | undefined;
    try {
      transport = await this.#launch();
      signal?.throwIfAborted();
      if (generation !== this.#generation) throw new Error("Screen sharing setup was stopped.");
      this.#transport = transport;
      transport.onClose(() => {
        if (this.#transport !== transport || generation !== this.#generation) return;
        ++this.#generation; this.#transport = undefined; this.#lease = undefined; this.#target = undefined;
        this.#devices = 0; this.#owner = undefined; this.#state = "idle";
        this.#detail = "Desktop sharing ended. Start sharing again to continue.";
      });
      const result = await transport.call<{ state: string; targetId: string; devicesGranted: number }>("start", {}, signal);
      if (generation !== this.#generation || this.#transport !== transport) throw new Error("Screen sharing ended during setup.");
      if (result.state !== "active" || !id(result.targetId) || !Number.isInteger(result.devicesGranted) || (result.devicesGranted & ~3) !== 0) throw new Error("Invalid desktop sharing response.");
      this.#target = result.targetId; this.#devices = result.devicesGranted;
      this.#state = "active";
      this.#detail = "This screen is shared with the chosen Chat. Keyboard input affects the focused application on this desktop.";
      return this.status();
    } catch (error) {
      if (generation === this.#generation) {
        await this.stop().catch(() => {});
        // Cancellation may arrive after launch but before ownership is stored.
        await transport?.close();
        if (!this.#faulted) { this.#state = "error"; this.#detail = error instanceof Error ? error.message : "Desktop sharing failed."; }
      } else await transport?.close();
      throw error;
    }
  }

  /** Fence synchronously, before waiting for a tool or native process to stop. */
  stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    ++this.#generation;
    const transport = this.#transport;
    this.#transport = undefined; this.#target = undefined; this.#lease = undefined; this.#devices = 0;
    this.#state = "stopping"; this.#detail = "Stopping screen sharing…";
    const closing = Promise.resolve().then(async () => {
      try { await transport?.close(); this.#state = "idle"; this.#detail = "Screen sharing is stopped."; }
      catch (error) { this.#faulted = true; this.#state = "error"; this.#detail = "The desktop helper did not stop. Restart work-fold before sharing again."; throw error; }
      finally { this.#owner = undefined; this.#busyTask = undefined; if (this.#closing === closing) this.#closing = undefined; }
    });
    this.#closing = closing;
    return closing;
  }
  async close(): Promise<void> { this.#closed = true; await this.stop(); }
  async releaseSession(owner: NativeComputerOwner): Promise<void> { if (this.#matches(owner)) await this.stop(); }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#queued >= 32) return Promise.reject(new Error("Too many pending desktop operations."));
    ++this.#queued;
    const next = this.#tail.then(operation);
    this.#tail = next.catch(() => {}).finally(() => { --this.#queued; });
    return next;
  }
  #matches(owner: NativeComputerOwner): boolean { return Boolean(this.#owner && ownerKey(owner) === ownerKey(this.#owner)); }

  async releaseTurn(taskId: string, cancelled = false): Promise<void> {
    if (this.#lease?.taskId !== taskId && this.#busyTask !== taskId) return;
    if (cancelled) return this.stop();
    await this.#serial(async () => {
      if (this.#lease?.taskId !== taskId) return;
      const transport = this.#transport, lease = this.#lease;
      this.#lease = undefined;
      try { await transport?.call("end", { lease: lease.id }); }
      catch { await this.stop(); }
    });
  }

  forSession(owner: NativeComputerOwner, turn: () => ComputerTurn | undefined): ComputerHostFacilities {
    const run = <T>(signal: AbortSignal | undefined, operation: (transport: WaylandTransport, lease: string, target: string) => Promise<T>): Promise<T> => {
      const accepted = turn();
      if (!accepted || !conversationId(accepted.taskId) || accepted.cancelled || accepted.settled) return Promise.reject(new Error("Desktop control requires this Chat's live accepted turn."));
      const generation = this.#generation;
      return this.#serial(async () => {
        const assertCurrent = () => {
          signal?.throwIfAborted();
          if (turn() !== accepted || accepted.cancelled || accepted.settled || this.#closed || this.#faulted
            || generation !== this.#generation || this.#state !== "active" || !this.#matches(owner) || !this.#transport || !this.#target) {
            throw new Error("This Chat no longer owns the shared screen. Check desktop sharing setup.");
          }
        };
        assertCurrent();
        const transport = this.#transport!, target = this.#target!;
        if (this.#lease && this.#lease.taskId !== accepted.taskId) throw new Error("Another accepted turn is using the desktop seat.");
        this.#busyTask = accepted.taskId;
        try {
          if (!this.#lease) {
            const result = await transport.call<{ lease: string; targetId: string }>("begin", { turn: accepted.taskId }, signal);
            if (!id(result.lease) || result.targetId !== target) { await this.stop(); throw new Error("Invalid desktop lease response."); }
            // A turn can settle while native setup is in flight. Fence and
            // close the grant rather than leaving an unowned physical lease.
            try { assertCurrent(); } catch (error) { await this.stop(); throw error; }
            this.#lease = { taskId: accepted.taskId, id: result.lease };
          }
          const result = await operation(transport, this.#lease.id, target);
          assertCurrent();
          return result;
        } finally { if (this.#busyTask === accepted.taskId) this.#busyTask = undefined; }
      });
    };
    const observation = async (transport: WaylandTransport, method: string, args: Record<string, unknown>, target: string, signal?: AbortSignal) => {
      const result = await transport.call<SharedScreenObservation>(method, args, signal);
      const png = typeof result.image?.data === "string" && result.image.data.length <= 32 * 1024 * 1024 ? Buffer.from(result.image.data, "base64") : Buffer.alloc(0);
      if (result.targetId !== target || result.kind !== "shared_screen" || !id(result.observationId) || typeof result.inputAvailable !== "boolean"
        || !Number.isSafeInteger(result.frame?.width) || !Number.isSafeInteger(result.frame?.height) || result.frame.width < 1 || result.frame.width > 4096
        || result.frame.height < 1 || result.frame.height > 4096 || !Number.isSafeInteger(result.frame.capturedAtMs) || !/^[a-f0-9]{64}$/.test(result.frame.sha256)
        || result.image.mimeType !== "image/png" || png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || png.readUInt32BE(16) !== result.frame.width || png.readUInt32BE(20) !== result.frame.height) {
        await this.stop(); throw new Error("Invalid shared-screen observation. Start sharing again.");
      }
      return result;
    };
    return {
      releaseSharedScreenSession: () => this.releaseSession(owner),
      listSharedScreens: signal => !this.#matches(owner) || this.#state !== "active" ? Promise.resolve([])
        : run(signal, async (_transport, _lease, target) => [{ id: target, kind: "shared_screen", title: "Shared screen" }]),
      observeSharedScreen: (targetId, signal) => run(signal, async (transport, lease, target) => {
        if (targetId !== target) throw new Error("Shared-screen target changed. Find and observe it again.");
        return observation(transport, "observe", { lease }, target, signal);
      }),
      actOnSharedScreen: (targetId, observationId, actions: SharedScreenAction[], signal) => run(signal, async (transport, lease, target) => {
        if (targetId !== target) throw new Error("Shared-screen target changed. Find and observe it again.");
        return observation(transport, "act", { lease, observation: observationId, actions }, target, signal);
      }),
    };
  }
}
