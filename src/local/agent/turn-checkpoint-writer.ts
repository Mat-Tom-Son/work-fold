export interface TurnCheckpointWriterPorts {
  activeTask(key: string): string | undefined;
  activeTasks(): Iterable<readonly [key: string, taskId: string]>;
  currentText(key: string): string;
  writeCheckpoint(taskId: string, text: string): Promise<unknown>;
  reportFailure(error: unknown, operation: "checkpoint" | "flush"): void;
}

const checkpointDelayMs = 500;

/**
 * Owns only live stream batching. TurnStore owns durable records, serialization,
 * and restart recovery; constructing this writer never dispatches or replays work.
 */
export class TurnCheckpointWriter {
  readonly #ports: TurnCheckpointWriterPorts;
  readonly #timers = new Map<string, { taskId: string; timer: NodeJS.Timeout }>();
  readonly #writes = new Map<string, Set<Promise<void>>>();
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(ports: TurnCheckpointWriterPorts) { this.#ports = ports; }

  schedule(key: string): void {
    if (this.#closed) return;
    const taskId = this.#ports.activeTask(key);
    if (!taskId) return;
    const previous = this.#timers.get(key);
    if (previous?.taskId === taskId) return;
    if (previous) clearTimeout(previous.timer);
    const pending = { taskId, timer: setTimeout(() => {
      if (this.#timers.get(key) !== pending) return;
      this.#timers.delete(key);
      void this.#persist(key, taskId, "checkpoint");
    }, checkpointDelayMs) };
    pending.timer.unref();
    this.#timers.set(key, pending);
  }

  async flush(key: string, taskId: string): Promise<void> {
    const pending = this.#timers.get(key);
    if (pending?.taskId === taskId) {
      clearTimeout(pending.timer);
      this.#timers.delete(key);
    }
    await this.#persist(key, taskId, "flush");
    // A task may have been replaced after its timer fired. Wait for its own
    // outstanding write without reading the replacement task's stream text.
    await Promise.all(this.#writes.get(taskId) ?? []);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const pending of this.#timers.values()) clearTimeout(pending.timer);
    this.#timers.clear();
    const active = [...this.#ports.activeTasks()];
    this.#closing = (async () => {
      await Promise.all(active.map(([key, taskId]) => this.flush(key, taskId)));
      await Promise.all([...this.#writes.values()].flatMap((writes) => [...writes]));
    })();
    return this.#closing;
  }

  #persist(key: string, taskId: string, operation: "checkpoint" | "flush"): Promise<void> {
    if (this.#ports.activeTask(key) !== taskId) return Promise.resolve();
    const writes = this.#writes.get(taskId) ?? new Set<Promise<void>>();
    this.#writes.set(taskId, writes);
    const pending = (async () => {
      try { await this.#ports.writeCheckpoint(taskId, this.#ports.currentText(key)); }
      catch (error) { this.#ports.reportFailure(error, operation); }
    })().finally(() => {
      writes.delete(pending);
      if (!writes.size) this.#writes.delete(taskId);
    });
    writes.add(pending);
    return pending;
  }
}
