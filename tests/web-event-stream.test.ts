import assert from "node:assert/strict";
import { test } from "node:test";

import { apiGetRetryDelaysMs, eventStreamReconnectDelaysMs } from "../web-local/src/constants.js";
import {
  api,
  createEventSource,
  dispatchSseFrame,
  nextSseBoundary,
  shouldReconnectEventStream,
} from "../web-local/src/lib/api.js";
import type { LocalEventStream } from "../web-local/src/types.js";

test("SSE frames preserve multiline data and recognize both boundary styles", () => {
  const messages: string[] = [];
  const source: LocalEventStream = {
    onmessage: (event) => messages.push(event.data),
    onopen: null,
    onerror: null,
    close() {},
  };

  assert.equal(nextSseBoundary("data: unix\n\nnext"), 10);
  assert.equal(nextSseBoundary("data: windows\r\n\r\nnext"), 13);
  dispatchSseFrame("id: 42\nevent: update\ndata: first\ndata: second", source);
  assert.deepEqual(messages, ["first\nsecond"]);
  assert.equal(source.lastEventId, "42");
  assert.equal(shouldReconnectEventStream(new Error("Local service event stream ended."), 0), true);
  assert.equal(shouldReconnectEventStream(new Error("Unauthorized"), 0), false);
  assert.equal(shouldReconnectEventStream(new Error("Failed to fetch"), eventStreamReconnectDelaysMs.length), false);
});

test("idempotent GET requests use bounded transient retries while mutations do not retry", async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const retryDelays: number[] = [];
  let getAttempts = 0;
  let mutationAttempts = 0;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setTimeout(callback: () => void, delay: number) {
        retryDelays.push(delay);
        queueMicrotask(callback);
        return retryDelays.length;
      },
    },
  });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "GET") {
      getAttempts += 1;
      if (getAttempts <= apiGetRetryDelaysMs.length) throw new TypeError("Failed to fetch");
      return Response.json({ ok: true });
    }
    mutationAttempts += 1;
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;

  try {
    assert.deepEqual(await api<{ ok: boolean }>("/state"), { ok: true });
    assert.equal(getAttempts, apiGetRetryDelaysMs.length + 1);
    assert.deepEqual(retryDelays, [...apiGetRetryDelaysMs]);

    await assert.rejects(
      api("/state", { method: "POST", body: { change: true } }),
      /still reconnecting/i,
    );
    assert.equal(mutationAttempts, 1);
    assert.deepEqual(retryDelays, [...apiGetRetryDelaysMs]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal("window", originalWindow);
  }
});

test("event streams suppress transient errors, reset after open, and revive after wake", async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const timers: Array<{ id: number; delay: number; callback: () => void; cancelled: boolean }> = [];
  const windowListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const documentListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  let nextTimerId = 1;
  let fetchCount = 0;
  let visibilityState: DocumentVisibilityState = "visible";

  const addListener = (listeners: Map<string, Set<EventListenerOrEventListenerObject>>, type: string, listener: EventListenerOrEventListenerObject) => {
    const entries = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    entries.add(listener);
    listeners.set(type, entries);
  };
  const removeListener = (listeners: Map<string, Set<EventListenerOrEventListenerObject>>, type: string, listener: EventListenerOrEventListenerObject) => {
    listeners.get(type)?.delete(listener);
  };
  const emit = (listeners: Map<string, Set<EventListenerOrEventListenerObject>>, type: string) => {
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(new Event(type));
      else listener.handleEvent(new Event(type));
    }
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      setTimeout(callback: () => void, delay: number) {
        const timer = { id: nextTimerId++, delay, callback, cancelled: false };
        timers.push(timer);
        return timer.id;
      },
      clearTimeout(id: number) {
        const timer = timers.find((entry) => entry.id === id);
        if (timer) timer.cancelled = true;
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        addListener(windowListeners, type, listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        removeListener(windowListeners, type, listener);
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: {
      get visibilityState() { return visibilityState; },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        addListener(documentListeners, type, listener);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        removeListener(documentListeners, type, listener);
      },
    },
  });
  globalThis.fetch = (async () => {
    fetchCount += 1;
    if (fetchCount !== 2) throw new TypeError("Failed to fetch");
    return new Response(new ReadableStream({ start(controller) { controller.close(); } }), { status: 200 });
  }) as typeof fetch;

  const runNextTimer = async () => {
    const timer = timers.find((entry) => !entry.cancelled);
    assert.ok(timer, "expected a pending reconnect timer");
    timer.cancelled = true;
    timer.callback();
    await flushAsyncWork();
    return timer.delay;
  };

  let source: LocalEventStream | null = null;
  try {
    source = createEventSource("/events");
    let openCount = 0;
    let errorCount = 0;
    source.onopen = () => { openCount += 1; };
    source.onerror = () => { errorCount += 1; };
    await flushAsyncWork();

    assert.equal(errorCount, 0, "the first transient failure is not terminal");
    assert.equal(await runNextTimer(), 250);
    assert.equal(openCount, 1);
    assert.equal(errorCount, 0);

    // The successful connection resets the ladder, so an ended healthy stream
    // starts again at 250ms instead of continuing at 750ms.
    assert.equal(await runNextTimer(), 250);
    assert.deepEqual(
      [await runNextTimer(), await runNextTimer(), await runNextTimer(), await runNextTimer()],
      [750, 1_500, 3_000, 5_000],
    );
    assert.equal(errorCount, 1, "only exhaustion is surfaced to the consumer");
    assert.equal(fetchCount, 7);

    visibilityState = "hidden";
    emit(windowListeners, "focus");
    await flushAsyncWork();
    assert.equal(fetchCount, 7, "hidden focus does not revive the stream");

    visibilityState = "visible";
    emit(documentListeners, "visibilitychange");
    await flushAsyncWork();
    assert.equal(fetchCount, 8, "returning to the app starts a fresh retry ladder");
    assert.equal(errorCount, 1, "the revived transient failure is suppressed while retrying");
    assert.equal(timers.find((entry) => !entry.cancelled)?.delay, 250);
  } finally {
    source?.close();
    globalThis.fetch = originalFetch;
    restoreGlobal("window", originalWindow);
    restoreGlobal("document", originalDocument);
  }
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function restoreGlobal(name: "window" | "document", value: Window & typeof globalThis | Document | undefined): void {
  if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
