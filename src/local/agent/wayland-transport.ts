import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface WaylandTransport {
  call<T>(method: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
  onClose(listener: () => void): () => void;
}
type Pending = { id: string; resolve(value: unknown): void; reject(error: Error): void };
async function settlesWithin(done: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([done.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One verified binary, private inherited pipes, no listening port or profile
 * credentials. The external process deadline also covers native-library hangs. */
export class NativeWaylandTransport implements WaylandTransport {
  #child: ChildProcessWithoutNullStreams;
  #pending?: Pending;
  #buffer = Buffer.alloc(0);
  #listeners = new Set<() => void>();
  #closed = false;
  #closing?: Promise<void>;
  #exited: Promise<void>;

  static async launch(binary: string): Promise<NativeWaylandTransport> {
    if (process.platform !== "linux") throw new Error("Wayland sharing requires Linux.");
    binary = resolve(binary);
    const source = JSON.parse(await readFile(join(dirname(binary), "source.json"), "utf8"));
    const metadata = await lstat(binary);
    if (source.schema !== "work-fold.wayland-helper-source.v1" || source.protocolVersion !== 1 || source.target !== "x86_64-unknown-linux-gnu"
      || !metadata.isFile() || !(metadata.mode & 0o111)
      || source.binarySha256 !== createHash("sha256").update(await readFile(binary)).digest("hex")) {
      throw new Error("The bundled Wayland helper changed. Rebuild or reinstall work-fold.");
    }
    return new NativeWaylandTransport(spawn(binary, ["--stdio"], { stdio: "pipe", windowsHide: true }));
  }
  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.#exited = new Promise(resolve => {
      child.once("exit", () => { this.#invalidate(); resolve(); });
      child.once("error", () => { this.#invalidate(); resolve(); });
    });
    child.stdout.on("data", (chunk: Buffer) => this.#receive(chunk));
    // Drain diagnostics without retaining them or copying desktop data into
    // app logs. Operation errors come through the bounded protocol response.
    child.stderr.resume();
    child.stdin.on("error", () => { void this.close().catch(() => {}); });
  }
  onClose(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #invalidate() {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#pending?.reject(new Error("Desktop sharing ended. Input may have been delivered; inspect before continuing."));
    this.#pending = undefined;
    for (const listener of this.#listeners) { try { listener(); } catch { /* Every owner must be fenced. */ } }
    this.#listeners.clear();
  }
  #receive(chunk: Buffer) {
    if (this.#closed) return;
    if (this.#buffer.length + chunk.length > 40 * 1024 * 1024) { void this.close().catch(() => {}); return; }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const newline = this.#buffer.indexOf(10);
    if (newline < 0) return;
    try {
      const response = JSON.parse(this.#buffer.subarray(0, newline).toString("utf8"));
      this.#buffer = this.#buffer.subarray(newline + 1);
      const pending = this.#pending;
      if (!pending || response.version !== 1 || response.id !== pending.id || this.#buffer.length) throw new Error("Invalid Wayland helper response");
      this.#pending = undefined;
      if (typeof response.error === "string" && response.error.length <= 4096 && response.retry === false) pending.reject(new Error(response.error));
      else if (response.result && typeof response.result === "object") pending.resolve(response.result);
      else { pending.reject(new Error("Invalid Wayland helper result")); throw new Error("Invalid result"); }
    } catch { void this.close().catch(() => {}); }
  }
  async call<T>(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("Desktop sharing ended. Start sharing again in setup.");
    if (this.#pending) throw new Error("The desktop helper is busy.");
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ id, command: { ...args, method } }) + "\n");
    if (bytes.length > 64 * 1024) throw new Error("Desktop input exceeds the operation limit.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { void this.close().catch(() => {}); };
    try {
      const result = new Promise<T>((resolve, reject) => {
        this.#pending = { id, resolve: value => resolve(value as T), reject };
        const timeout = method === "start" ? 68_000 : method === "act" ? 35_000 : method === "observe" ? 15_000 : 5_000;
        timer = setTimeout(abort, timeout);
        signal?.addEventListener("abort", abort, { once: true });
        this.#child.stdin.write(bytes, error => { if (error) abort(); });
      });
      const value = await result;
      signal?.throwIfAborted();
      return value;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Install the promise before notifying listeners: a listener may close us.
    this.#closing = Promise.resolve().then(async () => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
      this.#child.kill("SIGTERM");
      if (await settlesWithin(this.#exited, 4_000)) return;
      this.#child.kill("SIGKILL");
      if (!await settlesWithin(this.#exited, 2_000)) throw new Error("The desktop helper could not be stopped. Restart work-fold before sharing again.");
    });
    // Synchronous fence comes before process signalling or waiting.
    this.#invalidate();
    return this.#closing;
  }
}
