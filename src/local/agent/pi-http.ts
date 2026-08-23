import { EventEmitter } from "node:events";

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as undici from "undici-pi-reviewed";

/**
 * Provider HTTP transport parity with the Pi CLI.
 *
 * Pi's interactive entrypoint installs a global undici dispatcher before the
 * first provider request: it honors `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (and
 * Pi's own `httpProxy` setting), applies the configured HTTP idle timeout to
 * headers and bodies, and attaches an error listener so an undici client
 * error raised while a streamed body is being torn down cannot surface as an
 * unhandled "error" event. The SDK does not export that setup, so work-fold
 * reproduces it here with the same reviewed undici build Pi resolves.
 */

export const DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface PiHttpTransportState {
  proxy: string | null;
  idleTimeoutMs: number;
  reconfigured: boolean;
}

let configuredIdleTimeoutMs: number | null = null;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
const originalGlobalFetch = globalThis.fetch;

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options?: undici.Client.Options): undici.Client {
  return withUndiciErrorListener(new undici.Client(origin, options));
}

function createUndiciOriginDispatcher(origin: string | URL, options?: undici.Pool.Options): undici.Dispatcher {
  const dispatcherOptions = (options ?? {}) as undici.Pool.Options & { connections?: number };
  if (dispatcherOptions.connections === 1) {
    return createUndiciClient(origin, dispatcherOptions as undici.Client.Options);
  }
  return withUndiciErrorListener(new undici.Pool(origin, {
    ...dispatcherOptions,
    factory: createUndiciClient,
  }));
}

/** Mirrors Pi: a configured proxy only fills in proxy variables the environment did not already set. */
export function applyPiHttpProxySettings(httpProxy: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const proxy = httpProxy?.trim();
  if (!proxy) return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? null;
  env.HTTP_PROXY ??= proxy;
  env.HTTPS_PROXY ??= proxy;
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? proxy;
}

export function normalizePiHttpIdleTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) return DEFAULT_PI_HTTP_IDLE_TIMEOUT_MS;
  return Math.floor(timeoutMs);
}

/**
 * Installs (or re-installs when the idle timeout changed) the proxy-aware
 * global dispatcher and keeps global fetch on the same undici implementation.
 * A deliberate fetch override made by someone else after module load is left
 * alone, exactly as Pi does.
 */
export function configurePiHttpDispatcher(idleTimeoutMs: number | undefined): { idleTimeoutMs: number; reconfigured: boolean } {
  const normalized = normalizePiHttpIdleTimeoutMs(idleTimeoutMs);
  if (configuredIdleTimeoutMs === normalized) return { idleTimeoutMs: normalized, reconfigured: false };
  // SDKs treat timeout=0 as an immediate timeout rather than "no timeout".
  const effectiveTimeoutMs = normalized === 0 ? 2_147_483_647 : normalized;
  const dispatcher = withUndiciErrorListener(new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: effectiveTimeoutMs,
    headersTimeout: effectiveTimeoutMs,
    clientFactory: createUndiciClient,
    factory: createUndiciOriginDispatcher,
  }));
  undici.setGlobalDispatcher(dispatcher);
  const shouldInstallGlobals = installedGlobalFetch === undefined
    ? globalThis.fetch === originalGlobalFetch
    : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    (undici as unknown as { install?: () => void }).install?.();
    installedGlobalFetch = globalThis.fetch;
  }
  configuredIdleTimeoutMs = normalized;
  return { idleTimeoutMs: normalized, reconfigured: true };
}

/** Applies Pi's proxy setting and dispatcher timeouts from the resolved settings. */
export function configurePiHttpTransport(settingsManager: SettingsManager, env: NodeJS.ProcessEnv = process.env): PiHttpTransportState {
  const proxy = applyPiHttpProxySettings(settingsManager.getGlobalSettings().httpProxy, env);
  const dispatcher = configurePiHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
  return { proxy, idleTimeoutMs: dispatcher.idleTimeoutMs, reconfigured: dispatcher.reconfigured };
}

export function currentPiHttpDispatcher(): undici.Dispatcher {
  return undici.getGlobalDispatcher();
}

export function isPiHttpDispatcherInstalled(): boolean {
  return configuredIdleTimeoutMs !== null && undici.getGlobalDispatcher() instanceof undici.EnvHttpProxyAgent;
}
