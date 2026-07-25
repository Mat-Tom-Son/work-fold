import { apiGetRetryDelaysMs, eventStreamReconnectDelaysMs } from "../constants";
import type { LocalEventStream } from "../types";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const response = await fetchApiWithRetry(
    path,
    async () => ({
      method,
      headers: await apiHeaders(options.body === undefined ? undefined : { "content-type": "application/json" }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    }),
    method === "GET" ? [...apiGetRetryDelaysMs] : [],
  );
  if (!response.ok) throw await readApiError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function fetchApiWithRetry(
  path: string,
  initFactory: () => Promise<RequestInit>,
  retryDelaysMs: readonly number[],
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(apiUrl(path), await initFactory());
    } catch (error) {
      const message = rawErrorMessage(error);
      const retryDelay = retryDelaysMs[attempt];
      if (!isTransientNetworkError(message) || retryDelay === undefined) {
        throw isTransientNetworkError(message)
          ? new Error(userFriendlyErrorText(message))
          : error;
      }
      await delay(retryDelay);
    }
  }
}

export async function apiForm<T>(path: string, body: FormData): Promise<T> {
  const response = await fetch(apiUrl(path), { method: "POST", headers: await apiHeaders(), body });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<T>;
}

export function createEventSource(path: string): LocalEventStream {
  let closed = false;
  let exhausted = false;
  let controller: AbortController | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempts = 0;
  const source: LocalEventStream = {
    onmessage: null,
    onopen: null,
    onerror: null,
    close: () => {
      closed = true;
      removeWakeListeners();
      controller?.abort();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    },
  };

  // A stream can exhaust its finite retry ladder while Windows is asleep or
  // Electron is hidden. Give it a fresh ladder when the user returns instead
  // of leaving a background chat permanently detached.
  const reviveOnWake = () => {
    if (closed || !exhausted || document.visibilityState === "hidden") return;
    exhausted = false;
    reconnectAttempts = 0;
    connect();
  };
  const removeWakeListeners = () => {
    window.removeEventListener("focus", reviveOnWake);
    document.removeEventListener("visibilitychange", reviveOnWake);
  };

  const connect = () => {
    if (closed) return;
    controller = new AbortController();
    const activeController = controller;
    void readEventStream(path, activeController, source, () => {
      reconnectAttempts = 0;
      exhausted = false;
    })
      .then(() => {
        if (!closed && !activeController.signal.aborted) {
          scheduleReconnect(new Error("Local service event stream ended."));
        }
      })
      .catch((streamError) => {
        if (closed || activeController.signal.aborted) return;
        if (shouldReconnectEventStream(streamError, reconnectAttempts)) {
          scheduleReconnect(streamError);
          return;
        }
        if (isTransientNetworkError(rawErrorMessage(streamError))) exhausted = true;
        source.onerror?.(streamError);
      });
  };

  const scheduleReconnect = (streamError: unknown) => {
    if (closed) return;
    const delayMs = eventStreamReconnectDelaysMs[reconnectAttempts];
    if (delayMs === undefined) {
      exhausted = true;
      source.onerror?.(new Error(userFriendlyErrorText(rawErrorMessage(streamError))));
      return;
    }
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  window.addEventListener("focus", reviveOnWake);
  document.addEventListener("visibilitychange", reviveOnWake);
  connect();
  return source;
}

export async function readEventStream(
  path: string,
  controller: AbortController,
  source: LocalEventStream,
  onOpen?: () => void,
): Promise<void> {
  const response = await fetch(apiUrl(path), {
    headers: await apiHeaders({ accept: "text/event-stream" }),
    signal: controller.signal,
  });
  if (!response.ok) throw await readApiError(response);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Event stream is not readable.");
  onOpen?.();
  source.onopen?.();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = nextSseBoundary(buffer);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
      dispatchSseFrame(frame, source);
      boundary = nextSseBoundary(buffer);
    }
  }
}

export function nextSseBoundary(buffer: string): number {
  const unix = buffer.indexOf("\n\n");
  const windows = buffer.indexOf("\r\n\r\n");
  if (unix < 0) return windows;
  if (windows < 0) return unix;
  return Math.min(unix, windows);
}

export function dispatchSseFrame(frame: string, source: LocalEventStream): void {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data) source.onmessage?.({ data });
}

export function apiUrl(path: string): string {
  const baseUrl = window.workspaceDesktop?.api.baseUrl;
  return baseUrl ? new URL(path, baseUrl).toString() : path;
}

async function apiHeaders(extra: HeadersInit = {}): Promise<HeadersInit> {
  const sessionHeaders = await window.workspaceDesktop?.api.getSessionHeaders?.();
  return { ...extra, ...(sessionHeaders ?? {}) };
}

async function readApiError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json() as { error?: string | { message?: string; code?: string }; code?: string };
    const nested = typeof body.error === "object" && body.error ? body.error : null;
    const message = typeof body.error === "string" ? body.error : nested?.message;
    return new ApiError(response.status, message || response.statusText || `Request failed (${response.status}).`, body.code || nested?.code);
  } catch {
    return new ApiError(response.status, response.statusText || `Request failed (${response.status}).`);
  }
}

export function errorText(error: unknown): string {
  return userFriendlyErrorText(rawErrorMessage(error));
}

export function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function userFriendlyErrorText(message: string): string {
  return isTransientNetworkError(message)
    ? "Workspace is still reconnecting. Wait a moment and try again; your local files remain available."
    : message;
}

export function isTransientNetworkError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "err_name_not_resolved",
    "err_internet_disconnected",
    "err_network_changed",
    "err_connection_reset",
    "err_connection_timed_out",
    "err_timed_out",
    "enotfound",
    "eai_again",
    "etimedout",
    "econnreset",
    "socket hang up",
    "network socket disconnected",
    "failed to fetch",
    "fetch failed",
    "load failed",
    "name not resolved",
    "temporary failure in name resolution",
  ].some((needle) => normalized.includes(needle));
}

export function shouldReconnectEventStream(error: unknown, attempts: number): boolean {
  if (eventStreamReconnectDelaysMs[attempts] === undefined) return false;
  const message = rawErrorMessage(error);
  return isTransientNetworkError(message) || message === "Local service event stream ended.";
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => window.setTimeout(resolveDelay, ms));
}

export function safeExternalHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.href);
    if (url.protocol === "https:" || url.protocol === "mailto:") return url.toString();
  } catch {
    return null;
  }
  return null;
}
