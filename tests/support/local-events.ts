import type { LocalEventSubscription } from "../../src/shared/local-event-stream.js";

/** Adapt a fixture's logical SSE frames to the renderer's multiplex wire format. */
export function logicalEventController(controller: ReadableStreamDefaultController<Uint8Array>, init?: RequestInit, pathSuffix = "/control-events"): ReadableStreamDefaultController<Uint8Array> {
  const subscriptions = JSON.parse(String(init?.body ?? '{"subscriptions":[]}')).subscriptions as LocalEventSubscription[];
  const selected = subscriptions.filter((item) => item.path.endsWith(pathSuffix));
  return new Proxy(controller, { get(target, key) {
    if (key === "enqueue") return (chunk: Uint8Array) => {
      const frames = new TextDecoder().decode(chunk).split(/\r?\n\r?\n/).filter(Boolean);
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const id = /^id: ?(.*)$/m.exec(frame)?.[1];
        for (const item of selected) target.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ subscriptionId: item.id, event: JSON.parse(data), ...(id ? { eventId: id } : {}) })}\n\n`));
      }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
