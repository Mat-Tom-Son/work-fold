/**
 * The page service (docs/pages.md, "Page service"): two listeners over one
 * store. The public port serves visitors; the internal port serves the
 * bridge and requires `x-work-fold-pages-secret`. Without a secret of at
 * least 16 characters the internal routes don't start at all.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { BackupSettings, BackupStatus, Upload } from "./backup.js";
import { PageBackups, backupSettingsFromEnv } from "./backup.js";
import { sendError } from "./http.js";
import type { InternalLimits } from "./internal-routes.js";
import { handleInternalRequest } from "./internal-routes.js";
import type { VisitorLimits } from "./public-routes.js";
import { DocumentCache, handlePublicRequest } from "./public-routes.js";
import { RateLimiter } from "./rate-limit.js";
import { PageStore } from "./store.js";

export type PageServiceLimits = VisitorLimits & InternalLimits;

export const defaultPageServiceLimits: Readonly<PageServiceLimits> = Object.freeze({
  callsPerAddressPerMinute: 120,
  callsPerPagePerMinute: 600,
  documentsPerAddressPerMinute: 120,
  maxCallBytes: 2 * 1024 * 1024,
  maxPublishBytes: 26 * 1024 * 1024,
  maxDataChangeBytes: 8 * 1024 * 1024,
});

/** The bridge refuses shorter secrets too (services/bridge/pages-proxy.mjs). */
export const minimumInternalSecretLength = 16;
const backupIntervalMs = 5 * 60 * 1000;
const maintenanceIntervalMs = 60 * 60 * 1000;

export interface PageServiceOptions {
  /** The volume: registry.sqlite, pages/, tmp/. */
  dataDir: string;
  /** Public port; 0 picks a free one. */
  port: number;
  /** Listen address for both ports; by default every interface (IPv6 and IPv4 where available). */
  host?: string;
  /** Internal port; null or absent leaves the internal routes off. */
  internalPort?: number | null;
  internalSecret?: string | null;
  /** e.g. `https://pages.work-fold.com`; page calls from it are accepted. */
  publicOrigin?: string | null;
  /** Trust `x-real-ip` and `x-forwarded-host` from the platform's proxy. */
  trustProxy?: boolean;
  backup?: BackupSettings | null;
  /** Why backups are off although some settings are present. */
  backupProblem?: string;
  backupIntervalMs?: number;
  /** Tests replace the upload. */
  backupUpload?: Upload;
  limits?: Partial<PageServiceLimits>;
  now?: () => Date;
  log?: (record: Record<string, unknown>) => void;
}

export interface PageServiceHealth {
  ok: true;
  service: "work-fold-pages";
  internal: "on" | "off";
  backups: BackupStatus;
}

export interface PageService {
  publicUrl: string;
  /** Null when the internal routes are off. */
  internalUrl: string | null;
  store: PageStore;
  backups: PageBackups;
  health(): PageServiceHealth;
  close(): Promise<void>;
}

export async function startPageService(options: PageServiceOptions): Promise<PageService> {
  const log = options.log ?? defaultLog;
  const limits: PageServiceLimits = { ...defaultPageServiceLimits, ...options.limits };
  const store = new PageStore({ dataDir: resolve(options.dataDir), ...(options.now ? { now: options.now } : {}) });
  store.open();
  const backups = new PageBackups(store, options.backup ?? null, {
    intervalMs: options.backupIntervalMs ?? backupIntervalMs,
    ...(options.backupProblem ? { problem: options.backupProblem } : {}),
    ...(options.backupUpload ? { upload: options.backupUpload } : {}),
    ...(options.now ? { now: options.now } : {}),
    log,
  });

  const internalProblem = internalRoutesProblem(options);
  if (internalProblem && options.internalPort !== undefined && options.internalPort !== null) log({ event: "internal.off", reason: internalProblem });
  const limiter = new RateLimiter();
  const health = (): PageServiceHealth => ({
    ok: true,
    service: "work-fold-pages",
    internal: internalProblem ? "off" : "on",
    backups: backups.status(),
  });
  const publicContext = {
    store,
    limiter,
    limits,
    trustProxy: options.trustProxy === true,
    publicOrigin: options.publicOrigin ?? null,
    documents: new DocumentCache(),
    health,
  };

  const publicServer = createServer((req, res) => {
    guard(req, res, log, () => handlePublicRequest(req, res, publicContext));
  });
  tuneServer(publicServer, 60_000);
  let internalServer: Server | null = null;
  try {
    await listen(publicServer, options.port, options.host);
    if (!internalProblem) {
      const internalContext = { store, secret: options.internalSecret!, limits };
      internalServer = createServer((req, res) => {
        guard(req, res, log, () => handleInternalRequest(req, res, internalContext));
      });
      tuneServer(internalServer, 300_000);
      await listen(internalServer, options.internalPort!, options.host);
    }
  } catch (error) {
    await Promise.all([closeServer(publicServer), internalServer ? closeServer(internalServer) : undefined]);
    store.close();
    throw error;
  }

  backups.start();
  // Rows deleted more than 30 days ago go away; closed databases purge when they next open.
  const maintenance = setInterval(() => {
    try { store.purgeOpenDatabases(); } catch (error) { log({ event: "maintenance.failed", error: messageOf(error) }); }
  }, maintenanceIntervalMs);
  maintenance.unref();
  const limiterPrune = setInterval(() => limiter.prune(), 60_000);
  limiterPrune.unref();

  const publicUrl = urlOf(publicServer);
  const internalUrl = internalServer ? urlOf(internalServer) : null;
  log({ event: "started", public: portOf(publicServer), internal: internalServer ? portOf(internalServer) : null, backups: backups.enabled ? "on" : "off" });
  let closing: Promise<void> | null = null;
  return {
    publicUrl,
    internalUrl,
    store,
    backups,
    health,
    close() {
      closing ??= (async () => {
        clearInterval(maintenance);
        clearInterval(limiterPrune);
        await backups.stop();
        await Promise.all([closeServer(publicServer), internalServer ? closeServer(internalServer) : undefined]);
        store.close();
      })();
      return closing;
    },
  };
}

/** Why the internal routes can't start, or null when they can. */
function internalRoutesProblem(options: PageServiceOptions): string | null {
  if (options.internalPort === undefined || options.internalPort === null) return "WORKFOLD_PAGES_INTERNAL_PORT isn't set.";
  if (!options.internalSecret || options.internalSecret.length < minimumInternalSecretLength) {
    return `WORKFOLD_PAGES_INTERNAL_SECRET must be at least ${minimumInternalSecretLength} characters.`;
  }
  if (options.internalPort !== 0 && options.internalPort === options.port) return "The internal port must differ from the public port.";
  return null;
}

/**
 * Options from the environment: `PORT`, `WORKFOLD_PAGES_INTERNAL_PORT`,
 * `WORKFOLD_PAGES_INTERNAL_SECRET`, `WORKFOLD_PAGES_DATA_DIR`,
 * `WORKFOLD_PAGES_PUBLIC_ORIGIN`, `WORKFOLD_TRUST_PROXY`, and
 * `WORKFOLD_PAGES_BACKUP_*`.
 */
export function pageServiceOptionsFromEnv(env: NodeJS.ProcessEnv): PageServiceOptions {
  const dataDir = env.WORKFOLD_PAGES_DATA_DIR?.trim();
  if (!dataDir) throw new Error("WORKFOLD_PAGES_DATA_DIR must name the folder (the volume) where pages are kept.");
  const port = parsePort(env.PORT, "PORT") ?? 8080;
  const internalPort = parsePort(env.WORKFOLD_PAGES_INTERNAL_PORT, "WORKFOLD_PAGES_INTERNAL_PORT");
  let publicOrigin: string | null = null;
  const rawOrigin = env.WORKFOLD_PAGES_PUBLIC_ORIGIN?.trim();
  if (rawOrigin) {
    const parsed = new URL(rawOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("WORKFOLD_PAGES_PUBLIC_ORIGIN must be an http(s) origin.");
    publicOrigin = parsed.origin;
  }
  const backup = backupSettingsFromEnv(env);
  return {
    dataDir,
    port,
    internalPort,
    internalSecret: env.WORKFOLD_PAGES_INTERNAL_SECRET ?? null,
    publicOrigin,
    trustProxy: env.WORKFOLD_TRUST_PROXY === "1",
    backup: backup.settings,
    ...(backup.problem ? { backupProblem: backup.problem } : {}),
  };
}

function parsePort(value: string | undefined, name: string): number | null {
  const text = value?.trim();
  if (!text) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`${name} must be a port number.`);
  return port;
}

function guard(req: IncomingMessage, res: ServerResponse, log: (record: Record<string, unknown>) => void, handler: () => Promise<void>): void {
  handler().catch((error: unknown) => {
    log({ event: "request.failed", method: req.method, error: messageOf(error) });
    if (!res.writableEnded) sendError(res, error);
  });
}

function tuneServer(server: Server, requestTimeout: number): void {
  server.requestTimeout = requestTimeout;
  server.headersTimeout = 30_000;
  // Longer than a proxy's idle timeout, so it never reuses a closed connection.
  server.keepAliveTimeout = 65_000;
}

function listen(server: Server, port: number, host: string | undefined): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen({ port, ...(host ? { host } : {}) }, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    if (!server.listening) return resolvePromise();
    server.close(() => resolvePromise());
    server.closeAllConnections();
  });
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function urlOf(server: Server): string {
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? (address.address === "::" ? "[::1]" : `[${address.address}]`) : (address.address === "0.0.0.0" ? "127.0.0.1" : address.address);
  return `http://${host}:${address.port}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultLog(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "work-fold-pages", ...record }));
}
