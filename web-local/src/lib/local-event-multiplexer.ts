import type { LocalEventEnvelope, LocalEventSubscription } from "../../../src/shared/local-event-stream";
import type { LocalEventStream } from "../types";

interface Connection {
  close(): Promise<void>;
}
type OpenConnection = (subscriptions: () => LocalEventSubscription[], receive: (event: LocalEventEnvelope) => void, failed: (error: unknown) => void) => Connection;

/** One physical stream, explicit independent subscriptions and cursors. */
export function createLocalEventMultiplexer(openConnection: OpenConnection) {
  const subscriptions = new Map<string, { path: string; stream: LocalEventStream; failed: boolean }>();
  let nextId = 0;
  let connection: Connection | null = null;
  let generation = 0;
  let pending = false;
  let reconciling = false;

  const deliver = (callback: (() => void) | undefined) => {
    try { callback?.(); } catch { /* One renderer consumer cannot break other subscriptions. */ }
  };
  const schedule = () => {
    pending = true;
    if (reconciling) return;
    reconciling = true;
    queueMicrotask(() => { void reconcile(); });
  };
  const reconcile = async () => {
    try {
      while (pending) {
        pending = false;
        const owner = ++generation;
        const previous = connection;
        connection = null;
        await previous?.close().catch(() => undefined);
        if (pending || !subscriptions.size) continue;
        connection = openConnection(
          () => [...subscriptions].map(([id, { path, stream }]) => ({ id, path, ...(stream.lastEventId ? { lastEventId: stream.lastEventId } : {}) })),
          (envelope) => {
            if (owner !== generation) return;
            const subscription = subscriptions.get(envelope.subscriptionId);
            if (!subscription) return;
            const { stream } = subscription;
            if (envelope.error) {
              subscription.failed = true;
              deliver(() => stream.onerror?.(new Error(envelope.error!.message)));
            } else if (envelope.closed) {
              if (!subscription.failed) deliver(() => stream.onerror?.(new Error("This local event stream closed. Refresh to reconnect.")));
              subscription.failed = true;
            } else if (envelope.ready) {
              subscription.failed = false;
              deliver(() => stream.onopen?.());
            } else if ("event" in envelope) {
              if (envelope.eventId !== undefined) stream.lastEventId = envelope.eventId;
              deliver(() => stream.onmessage?.({ data: JSON.stringify(envelope.event), ...(stream.lastEventId ? { lastEventId: stream.lastEventId } : {}) }));
            }
          },
          (error) => {
            if (owner !== generation) return;
            for (const { stream } of [...subscriptions.values()]) deliver(() => stream.onerror?.(error));
          },
        );
      }
    } finally { reconciling = false; if (pending) schedule(); }
  };

  return {
    subscribe(path: string): LocalEventStream {
      // Duplicate paths remain separate logical subscriptions so each new
      // consumer receives its own initial snapshot, never just future deltas.
      const id = `stream-${++nextId}`;
      const stream: LocalEventStream = {
        onmessage: null, onerror: null, onopen: null, lastEventId: "",
        close() { if (subscriptions.delete(id)) schedule(); },
      };
      subscriptions.set(id, { path, stream, failed: false });
      schedule();
      return stream;
    },
  };
}
