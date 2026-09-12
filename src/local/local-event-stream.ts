import type { ServerResponse } from "node:http";
import { localEventStreamLimits, type LocalEventEnvelope, type LocalEventSubscription } from "../shared/local-event-stream.js";

/** Small structured sink shared by direct SSE and multiplexed subscriptions. */
export interface LocalEventSink {
  readonly closed: boolean;
  readonly queuedBytes: number;
  send(data: unknown, id?: number | string): boolean;
  heartbeat(): void;
  close(): void;
  onClose(listener: () => void): void;
}

export function createLocalEventSink(response: ServerResponse): LocalEventSink {
  let closed = false;
  const listeners = new Set<() => void>();
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) { try { listener(); } catch { /* independent cleanup */ } }
    listeners.clear();
  };
  response.once("close", dispose);
  const sink: LocalEventSink = {
    get closed() { return closed || response.destroyed || response.writableEnded; },
    get queuedBytes() { return response.writableLength; },
    send(data, id) {
      if (sink.closed) return false;
      if (sink.queuedBytes > localEventStreamLimits.queuedBytes) { sink.close(); return false; }
      try {
        const written = response.write(`${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
        if (sink.queuedBytes > localEventStreamLimits.queuedBytes) sink.close();
        return written;
      } catch { sink.close(); return false; }
    },
    heartbeat() {
      if (sink.closed) return;
      if (sink.queuedBytes > localEventStreamLimits.queuedBytes) { sink.close(); return; }
      try { response.write(": keepalive\n\n"); } catch { sink.close(); }
    },
    close() { dispose(); if (!response.writableEnded) response.end(); },
    onClose(listener) { if (sink.closed) listener(); else listeners.add(listener); },
  };
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  return sink;
}

export function createLocalEventChannel(parent: LocalEventSink, subscriptionId: string): LocalEventSink {
  let closed = false;
  const listeners = new Set<() => void>();
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) { try { listener(); } catch { /* independent cleanup */ } }
    listeners.clear();
  };
  parent.onClose(dispose);
  return {
    get closed() { return closed || parent.closed; },
    get queuedBytes() { return parent.queuedBytes; },
    send(event, id) {
      if (closed || parent.closed) return false;
      return parent.send({ subscriptionId, event, ...(id === undefined ? {} : { eventId: String(id) }) } satisfies LocalEventEnvelope);
    },
    heartbeat() { /* one heartbeat belongs to the physical connection */ },
    close() {
      if (!closed && !parent.closed) parent.send({ subscriptionId, closed: true } satisfies LocalEventEnvelope);
      dispose();
    },
    onClose(listener) { if (closed || parent.closed) listener(); else listeners.add(listener); },
  };
}

export type LocalEventTarget =
  | { kind: "control" }
  | { kind: "files"; spaceId: string }
  | { kind: "chat"; spaceId: string; conversationId: string }
  | { kind: "management"; conversationId: string };

export function localEventTarget(path: string): LocalEventTarget | null {
  if (path === "/api/management/control-events") return { kind: "control" };
  const files = /^\/api\/spaces\/([A-Za-z0-9_-]+)\/file-events$/.exec(path);
  if (files) return { kind: "files", spaceId: files[1]! };
  const chat = /^\/api\/spaces\/([A-Za-z0-9_-]+)\/conversations\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/events$/.exec(path);
  if (chat) return { kind: "chat", spaceId: chat[1]!, conversationId: chat[2]! };
  const management = /^\/api\/management\/conversations\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\/events$/.exec(path);
  return management ? { kind: "management", conversationId: management[1]! } : null;
}

export function parseLocalEventSubscriptions(value: unknown): LocalEventSubscription[] {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Array.isArray((value as { subscriptions?: unknown }).subscriptions)) {
    throw new Error("Provide an array of local event subscriptions.");
  }
  const subscriptions = (value as { subscriptions: unknown[] }).subscriptions;
  if (!subscriptions.length || subscriptions.length > localEventStreamLimits.subscriptions) throw new Error("Too many local event subscriptions.");
  const ids = new Set<string>();
  return subscriptions.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid local event subscription.");
    const item = input as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== "id" && key !== "path" && key !== "lastEventId")
      || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.path !== "string" || item.path.length > 512 || !localEventTarget(item.path)
      || (item.lastEventId !== undefined && (typeof item.lastEventId !== "string" || !/^[0-9]{1,16}$/.test(item.lastEventId) || !Number.isSafeInteger(Number(item.lastEventId))))) {
      throw new Error("Invalid local event subscription.");
    }
    ids.add(item.id);
    return { id: item.id, path: item.path, ...(typeof item.lastEventId === "string" ? { lastEventId: item.lastEventId } : {}) };
  });
}
