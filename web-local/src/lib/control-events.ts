import { createEventSource } from "./api";
import type { LocalEventStream } from "../types";

export type ControlHint = "apps" | "spaces" | "reset";
const listeners = new Set<(hint: ControlHint) => void>();
let stream: LocalEventStream | null = null;

function connectWhenVisible(): void {
  if (!listeners.size || document.visibilityState === "hidden") {
    stream?.close();
    stream = null;
    return;
  }
  if (stream) return;
  stream = createEventSource("/api/management/control-events");
  stream.onmessage = ({ data }) => {
    let type: unknown;
    try { type = (JSON.parse(data) as { type?: unknown }).type; } catch { return; }
    if (type !== "apps" && type !== "spaces" && type !== "reset") return;
    for (const listener of listeners) listener(type);
  };
}

/** One visible-window connection; consumers always re-read authoritative state. */
export function subscribeControlEvents(listener: (hint: ControlHint) => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", connectWhenVisible);
    connectWhenVisible();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    document.removeEventListener("visibilitychange", connectWhenVisible);
    stream?.close();
    stream = null;
  };
}
