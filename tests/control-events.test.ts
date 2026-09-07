import assert from "node:assert/strict";
import test from "node:test";
import { subscribeControlEvents } from "../web-local/src/lib/control-events.js";

test("control hints share one visible connection and requery after hiding/reopening", async () => {
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: document });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: window });
  const connections: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }> = [];
  globalThis.fetch = (async (_path, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const signal = init!.signal!;
        signal.addEventListener("abort", () => controller.close(), { once: true });
        connections.push({ controller, signal });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const first: string[] = [];
  const second: string[] = [];
  const unsubscribeFirst = subscribeControlEvents((hint) => first.push(hint));
  const unsubscribeSecond = subscribeControlEvents((hint) => second.push(hint));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await settle();
    assert.equal(connections.length, 1);
    connections[0]!.controller.enqueue(new TextEncoder().encode('data: {"type":"reset"}\n\ndata: {"type":"apps"}\n\ndata: {"type":"unknown"}\n\n'));
    await settle();
    assert.deepEqual(first, ["reset", "apps"]);
    assert.deepEqual(second, first);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(connections[0]!.signal.aborted, true);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    assert.equal(connections.length, 2);
    unsubscribeFirst();
    connections[1]!.controller.enqueue(new TextEncoder().encode('data: {"type":"decisions"}\n\n'));
    await settle();
    assert.deepEqual(first, ["reset", "apps"]);
    assert.deepEqual(second, ["reset", "apps", "decisions"]);
    unsubscribeSecond();
    assert.equal(connections[1]!.signal.aborted, true);
  } finally {
    unsubscribeFirst(); unsubscribeSecond();
    globalThis.fetch = previous.fetch;
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previous.window });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previous.document });
  }
});
