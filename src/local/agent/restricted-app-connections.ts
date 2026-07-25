import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { Readable } from "node:stream";

import type { AppPlatformArtifactDigest } from "./app-platform-artifact.js";
import {
  computeDeclarationDigest,
  type DeclarationDigest,
  type FeatureInstallationId,
  type PrincipalId,
  type RuntimeInstanceId,
  type TenantId,
} from "./app-platform-contract.js";
import type {
  RestrictedAppAuthDeclaration,
  RestrictedAppManifest,
} from "./restricted-app-manifest.js";
import { restrictedAppNetworkOrigin } from "./restricted-app-manifest.js";
import {
  normalizeRestrictedAppOAuthConnection,
  RestrictedAppOAuthError,
  type RestrictedAppOAuthConnection,
  type RestrictedAppOAuthPkceConfiguration,
} from "./restricted-app-oauth.js";

export type RestrictedAppCredential =
  | { kind: "api-key"; value: string }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | RestrictedAppOAuthConnection;

export type RestrictedAppConnectionOwner =
  | Readonly<{
      kind: "instance";
      runtimeInstanceId: RuntimeInstanceId;
    }>
  | Readonly<{
      kind: "principal";
      principalId: PrincipalId;
    }>;

export interface RestrictedAppConnectionFeatureScope {
  tenantId: TenantId;
  runtimeInstanceId: RuntimeInstanceId;
  featureId: string;
  featureInstallationId: FeatureInstallationId;
  featureRevisionDigest: AppPlatformArtifactDigest;
}

export interface RestrictedAppConnectionBinding extends RestrictedAppConnectionFeatureScope {
  declarationId: string;
  declarationDigest: DeclarationDigest;
  targetIdentity: string;
  owner: RestrictedAppConnectionOwner;
}

export interface RestrictedAppConnectionInstanceScope {
  tenantId: TenantId;
  runtimeInstanceId: RuntimeInstanceId;
}

export interface RestrictedAppRuntimeOwner extends RestrictedAppConnectionFeatureScope {
  effectivePrincipalId: PrincipalId;
  connectionOwner: RestrictedAppConnectionOwner;
  networkGrants: string[];
}

export interface RestrictedAppConnectionStatus {
  destinationId: string;
  owner: RestrictedAppConnectionOwner["kind"];
  kind: RestrictedAppCredential["kind"] | "none" | null;
  configured: boolean;
}

export interface RestrictedAppConnectionStore {
  get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined>;
  set(binding: RestrictedAppConnectionBinding, credential: RestrictedAppCredential, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<void>;
  delete(binding: RestrictedAppConnectionBinding, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<boolean>;
  deleteFeature(scope: RestrictedAppConnectionFeatureScope): Promise<void>;
  deleteRuntimeInstance(scope: RestrictedAppConnectionInstanceScope): Promise<void>;
}

export type RestrictedAppEffectAuthorizer = () => void | Promise<void>;

export interface RestrictedAppEffectAuthorityState {
  hostOpen: boolean;
  launchGeneration: number;
  currentGeneration: number;
  live: boolean;
  persistentAuthorityCurrent: boolean;
}

export function assertRestrictedAppEffectAuthority(state: RestrictedAppEffectAuthorityState): void {
  if (!state.hostOpen
    || !state.live
    || !state.persistentAuthorityCurrent
    || !Number.isSafeInteger(state.launchGeneration)
    || !Number.isSafeInteger(state.currentGeneration)
    || state.launchGeneration < 0
    || state.currentGeneration < 0
    || state.launchGeneration !== state.currentGeneration) {
    throw new RestrictedAppError("AUTHORITY_STALE", "The restricted app was stopped before the effect could commit.");
  }
}

export interface RestrictedAppNetworkRequest {
  destinationId: string;
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
}

export interface RestrictedAppNetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  encoding: "utf8" | "base64";
}

export type RestrictedAppErrorCode =
  | "ACTION_UNKNOWN"
  | "APP_CRASHED"
  | "APP_ERROR"
  | "APP_TIMEOUT"
  | "APP_UNAVAILABLE"
  | "AUTHORITY_STALE"
  | "AUTH_REQUIRED"
  | "FILE_DENIED"
  | "FILE_FAILED"
  | "INPUT_INVALID"
  | "NETWORK_DENIED"
  | "NETWORK_FAILED"
  | "OUTPUT_INVALID"
  | "REVISION_CHANGED"
  | "STORAGE_FAILED";

export class RestrictedAppError extends Error {
  constructor(readonly code: RestrictedAppErrorCode, message: string) {
    super(message);
    this.name = "RestrictedAppError";
  }
}

export interface RestrictedAppNetworkBrokerOptions {
  credentials: RestrictedAppConnectionStore;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  oauth?: RestrictedAppOAuthAuthorizer;
}

export interface RestrictedAppOAuthAuthorizer {
  authorize(
    binding: RestrictedAppConnectionBinding,
    configuration: RestrictedAppOAuthPkceConfiguration,
    headers: Headers,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<void>;
}

const allowedRequestHeaders = new Set(["accept", "content-type", "if-modified-since", "if-none-match"]);
const exposedResponseHeaders = new Set(["cache-control", "content-language", "content-type", "etag", "expires", "last-modified"]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class RestrictedAppNetworkBroker {
  readonly #credentials: RestrictedAppConnectionStore;
  readonly #fetch?: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxRedirects: number;
  readonly #resolveHost?: RestrictedAppNetworkBrokerOptions["resolveHost"];
  readonly #oauth?: RestrictedAppOAuthAuthorizer;

  constructor(options: RestrictedAppNetworkBrokerOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxRequestBytes = options.maxRequestBytes ?? 128 * 1024;
    this.#maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    this.#maxRedirects = options.maxRedirects ?? 3;
    // Tests may inject a closed fake fetch. Production always performs a DNS
    // policy check before letting the real transport resolve the same host.
    this.#resolveHost = options.resolveHost ?? (options.fetch ? undefined : resolveHost);
    this.#oauth = options.oauth;
  }

  async request(
    owner: RestrictedAppRuntimeOwner,
    manifest: RestrictedAppManifest,
    value: unknown,
    cancellation?: AbortSignal,
    authorizeEffect?: RestrictedAppEffectAuthorizer,
  ): Promise<RestrictedAppNetworkResponse> {
    let request: RestrictedAppNetworkRequest;
    try {
      request = parseNetworkRequest(value, this.#maxRequestBytes);
    } catch (error) {
      if (error instanceof RestrictedAppError) throw error;
      throw new RestrictedAppError("NETWORK_DENIED", safeErrorMessage(error));
    }
    if (manifest.id !== owner.featureId) throw new RestrictedAppError("NETWORK_DENIED", "The feature identity does not match its runtime owner.");
    assertConnectionOwnerMatchesRuntime(owner);
    const destination = manifest.permissions.network.find((item) => item.id === request.destinationId);
    if (!destination || !owner.networkGrants.includes(destination.id)) {
      throw new RestrictedAppError("NETWORK_DENIED", "This network destination is not granted to the app.");
    }
    if (!destination.methods.includes(request.method)) {
      throw new RestrictedAppError("NETWORK_DENIED", "This HTTP method is not granted for the destination.");
    }
    for (const name of Object.keys(request.headers ?? {})) {
      if (allowedRequestHeaders.has(name) || destination.requestHeaders?.includes(name)) continue;
      throw new RestrictedAppError("NETWORK_DENIED", `Network header is not allowed: ${name}`);
    }
    const origin = restrictedAppNetworkOrigin(destination);
    const url = destinationUrl(origin, request.path);
    const headers = new Headers(request.headers);
    const binding = {
      tenantId: owner.tenantId,
      runtimeInstanceId: owner.runtimeInstanceId,
      featureId: owner.featureId,
      featureInstallationId: owner.featureInstallationId,
      featureRevisionDigest: owner.featureRevisionDigest,
      declarationId: destination.id,
      declarationDigest: computeDeclarationDigest(destination),
      targetIdentity: origin,
      owner: owner.connectionOwner,
    };
    // Anonymous destinations never need the encrypted credential namespace.
    // This is also required for loopback destinations: their reviewed binding
    // is intentionally HTTP, while persisted credentials accept HTTPS origins
    // only because secrets must never be sent to loopback services.
    const anonymous = destination.auth.length === 1 && destination.auth[0]?.kind === "none";
    const credential = anonymous ? undefined : await this.#credentials.get(binding);
    if (credential?.kind === "oauth2-pkce") {
      const declaration = destination.auth.find((item) => item.kind === "oauth2-pkce");
      if (!declaration || !this.#oauth) throw new RestrictedAppError("AUTH_REQUIRED", "Renew this app's browser connection before using it.");
      try {
        // OAuth authorization may refresh a provider token, which is itself an
        // external effect. Fence it independently from the destination fetch.
        await authorizeEffect?.();
        await this.#oauth.authorize(binding, declaration, headers, cancellation, authorizeEffect);
      } catch (error) {
        if (error instanceof RestrictedAppOAuthError) {
          throw new RestrictedAppError(
            error.code === "AUTH_REQUIRED" || error.code === "AUTH_DENIED" || error.code === "AUTH_CANCELLED" ? "AUTH_REQUIRED"
              : error.code === "STORAGE_FAILED" ? "STORAGE_FAILED" : "NETWORK_FAILED",
            error.message,
          );
        }
        throw error;
      }
    } else applyCredential(headers, destination.auth, credential);

    const controller = new AbortController();
    const cancel = () => controller.abort();
    cancellation?.addEventListener("abort", cancel, { once: true });
    if (cancellation?.aborted) controller.abort();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let currentUrl = url;
    let method = request.method;
    let body = request.body;
    try {
      for (let redirects = 0; ; redirects += 1) {
        // DNS lookup is observable network activity too. Reauthorize before
        // resolution and again immediately before the HTTP request.
        await authorizeEffect?.();
        const addresses = this.#resolveHost
          ? destination.target.kind === "loopback-http"
            ? [{ address: destination.target.host, family: destination.target.host === "::1" ? 6 as const : 4 as const }]
            : await publicAddresses(currentUrl.hostname, this.#resolveHost)
          : undefined;
        let response: Response;
        try {
          await authorizeEffect?.();
          const requestInit: RequestInit = {
            method,
            headers,
            ...(body !== undefined ? { body } : {}),
            redirect: "manual",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
          };
          response = this.#fetch
            ? await this.#fetch(currentUrl, requestInit)
            : destination.target.kind === "loopback-http"
              ? await pinnedLoopbackFetch(currentUrl, requestInit, addresses ?? [])
              : await pinnedHttpsFetch(currentUrl, requestInit, addresses ?? []);
        } catch (error) {
          if (error instanceof RestrictedAppError) throw error;
          if (controller.signal.aborted) throw new RestrictedAppError("NETWORK_FAILED", "The network request timed out.");
          throw new RestrictedAppError("NETWORK_FAILED", `The network request failed: ${safeErrorMessage(error)}`);
        }
        if (!redirectStatuses.has(response.status)) return await boundedResponse(response, this.#maxResponseBytes, controller);
        await response.body?.cancel().catch(() => undefined);
        if (destination.target.kind === "loopback-http") throw new RestrictedAppError("NETWORK_DENIED", "Loopback services cannot redirect requests.");
        if (redirects >= this.#maxRedirects) throw new RestrictedAppError("NETWORK_DENIED", "The network request exceeded the redirect limit.");
        const location = response.headers.get("location");
        if (!location) throw new RestrictedAppError("NETWORK_FAILED", "The network response declared a redirect without a destination.");
        const next = new URL(location, currentUrl);
        if (next.origin !== origin || next.username || next.password || next.hash) {
          throw new RestrictedAppError("NETWORK_DENIED", "The network destination redirected outside its granted origin.");
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET")) {
          if (!destination.methods.includes("GET")) throw new RestrictedAppError("NETWORK_DENIED", "The redirect requires an HTTP method that was not granted.");
          method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        currentUrl = next;
      }
    } finally {
      clearTimeout(timer);
      cancellation?.removeEventListener("abort", cancel);
    }
  }
}

export function normalizeRestrictedAppCredential(value: unknown): RestrictedAppCredential {
  const candidate = strictObject(value, "Connection credential", [
    "kind", "value", "token", "username", "password", "issuer", "clientId", "requestedScopes", "grantedScopes",
    "tokenType", "accessToken", "refreshToken", "expiresAt", "connectedAt",
  ]);
  const kind = candidate.kind;
  const record = kind === "api-key"
    ? strictObject(value, "API-key credential", ["kind", "value"])
    : kind === "bearer"
      ? strictObject(value, "Bearer credential", ["kind", "token"])
      : kind === "basic"
        ? strictObject(value, "Basic-auth credential", ["kind", "username", "password"])
        : candidate;
  if (record.kind === "api-key") {
    return { kind: "api-key", value: requiredSecret(record.value, "API key") };
  }
  if (record.kind === "bearer") return { kind: "bearer", token: requiredSecret(record.token, "Bearer token") };
  if (record.kind === "basic") {
    const username = requiredString(record.username, "Basic-auth username", 500);
    if (username.includes(":")) throw new Error("Basic-auth username cannot contain a colon.");
    return { kind: "basic", username, password: requiredSecret(record.password, "Basic-auth password") };
  }
  if (candidate.kind === "oauth2-pkce") return normalizeRestrictedAppOAuthConnection(candidate as unknown as RestrictedAppOAuthConnection);
  throw new Error("Connection credential kind is unsupported.");
}

function parseNetworkRequest(value: unknown, maxRequestBytes: number): RestrictedAppNetworkRequest {
  const record = strictObject(value, "Restricted app network request", ["destinationId", "path", "method", "headers", "body"]);
  const destinationId = requiredString(record.destinationId, "Network destination id", 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(destinationId)) throw new RestrictedAppError("NETWORK_DENIED", "Network destination id is invalid.");
  const path = requiredString(record.path, "Network path", 2_048);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0")) {
    throw new RestrictedAppError("NETWORK_DENIED", "Network path must be a relative URL path.");
  }
  if (record.method !== "GET" && record.method !== "POST" && record.method !== "PUT" && record.method !== "PATCH" && record.method !== "DELETE") {
    throw new RestrictedAppError("NETWORK_DENIED", "Network method is unsupported.");
  }
  const headers: Record<string, string> = {};
  if (record.headers !== undefined) {
    const rawHeaders = strictObject(record.headers, "Network headers", undefined, 16);
    for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
      const name = rawName.toLowerCase();
      // Shape only. Which names this destination may actually set depends on
      // its reviewed declaration, so that check runs once the destination and
      // its grant are resolved.
      if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length > 80) {
        throw new RestrictedAppError("NETWORK_DENIED", `Network header is not allowed: ${rawName}`);
      }
      if (typeof rawValue !== "string" || rawValue.length > 1_000 || /[\r\n\0]/.test(rawValue)) {
        throw new RestrictedAppError("NETWORK_DENIED", `Network header is not allowed: ${rawName}`);
      }
      headers[name] = rawValue;
    }
  }
  const body = record.body === undefined ? undefined : requiredString(record.body, "Network request body", maxRequestBytes, true);
  if ((record.method === "GET" || record.method === "DELETE") && body !== undefined) {
    throw new RestrictedAppError("NETWORK_DENIED", `${record.method} requests cannot include a body.`);
  }
  if (body !== undefined && Buffer.byteLength(body) > maxRequestBytes) throw new RestrictedAppError("NETWORK_DENIED", "Network request body is too large.");
  return { destinationId, path, method: record.method, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}) };
}

function destinationUrl(origin: string, path: string): URL {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new RestrictedAppError("NETWORK_DENIED", "Network path escapes the granted origin.");
  }
  return url;
}

function assertConnectionOwnerMatchesRuntime(owner: RestrictedAppRuntimeOwner): void {
  if (owner.connectionOwner.kind === "instance") {
    if (owner.connectionOwner.runtimeInstanceId !== owner.runtimeInstanceId) {
      throw new RestrictedAppError("NETWORK_DENIED", "An instance-owned connection must belong to the active Runtime Instance.");
    }
    return;
  }
  if (owner.connectionOwner.principalId !== owner.effectivePrincipalId) {
    throw new RestrictedAppError("NETWORK_DENIED", "A principal-owned connection must belong to the effective Principal.");
  }
}

function applyCredential(headers: Headers, allowed: RestrictedAppAuthDeclaration[], credential: RestrictedAppCredential | undefined): void {
  if (!credential) {
    if (allowed.some((item) => item.kind === "none")) return;
    throw new RestrictedAppError("AUTH_REQUIRED", "Connect this app before it accesses the destination.");
  }
  const declaration = allowed.find((item) => item.kind === credential.kind);
  if (!declaration) throw new RestrictedAppError("AUTH_REQUIRED", "The saved connection type is not accepted by this app revision.");
  if (credential.kind === "api-key") headers.set((declaration as Extract<RestrictedAppAuthDeclaration, { kind: "api-key" }>).header, credential.value);
  else if (credential.kind === "bearer") headers.set("authorization", `Bearer ${credential.token}`);
  else if (credential.kind === "basic") headers.set("authorization", `Basic ${Buffer.from(`${credential.username}:${credential.password}`, "utf8").toString("base64")}`);
  else throw new RestrictedAppError("AUTH_REQUIRED", "Browser connections must be authorized by the host.");
}

async function boundedResponse(response: Response, maximum: number, controller: AbortController): Promise<RestrictedAppNetworkResponse> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maximum) {
          controller.abort();
          throw new RestrictedAppError("NETWORK_FAILED", "The network response exceeded the size limit.");
        }
        chunks.push(item.value);
      }
    } catch (error) {
      if (error instanceof RestrictedAppError) throw error;
      if (controller.signal.aborted) throw new RestrictedAppError("NETWORK_FAILED", "The network request timed out or was cancelled.");
      throw new RestrictedAppError("NETWORK_FAILED", `The network response could not be read: ${safeErrorMessage(error)}`);
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const textual = contentType.startsWith("text/") || contentType.includes("json") || contentType.includes("xml") || contentType.includes("javascript") || contentType.includes("x-www-form-urlencoded");
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) if (exposedResponseHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  return {
    status: response.status,
    headers,
    body: textual ? bytes.toString("utf8") : bytes.toString("base64"),
    encoding: textual ? "utf8" : "base64",
  };
}

const blockedAddresses = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"], ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"], ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
] as const) blockedAddresses.addSubnet(address, prefix, family);

async function resolveHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  try {
    return (await lookup(hostname, { all: true, verbatim: true }))
      .filter((item) => item.family === 4 || item.family === 6)
      .map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
  } catch (error) {
    throw new RestrictedAppError("NETWORK_FAILED", `The network destination could not be resolved: ${safeErrorMessage(error)}`);
  }
}

async function publicAddresses(
  hostname: string,
  resolver: NonNullable<RestrictedAppNetworkBrokerOptions["resolveHost"]>,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const addresses = await resolver(hostname);
  if (!addresses.length || addresses.some(({ address, family }) => blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6"))) {
    throw new RestrictedAppError("NETWORK_DENIED", "The network destination resolves to a local, private, or reserved address.");
  }
  return addresses;
}

/**
 * Tries each approved address in resolver order until one connects. A
 * dual-stack destination advertises both families, and only one of them may be
 * reachable from the current network, so committing to the first record would
 * strand the app on an otherwise healthy service. Every candidate has already
 * cleared the public-address check, so failing over never widens authority.
 */
export async function firstReachableAddress<T>(
  addresses: Array<{ address: string; family: 4 | 6 }>,
  isCancelled: () => boolean,
  attempt: (selected: { address: string; family: 4 | 6 }) => Promise<T>,
  options: { retryAfterFailure?: boolean } = {},
): Promise<T> {
  if (!addresses.length) throw new RestrictedAppError("NETWORK_DENIED", "The network destination has no approved public address.");
  let lastError: unknown;
  for (const selected of addresses) {
    try {
      return await attempt(selected);
    } catch (error) {
      // A cancelled or timed-out request is the caller's decision, not an
      // unreachable address, so it must not consume the remaining candidates.
      if (isCancelled()) throw error;
      // Once a mutating request has been dispatched, a reset before response
      // headers does not reveal whether the destination applied it. Retrying
      // against another address could duplicate the side effect.
      if (options.retryAfterFailure === false) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new RestrictedAppError("NETWORK_FAILED", "The network destination could not be reached.");
}

function pinnedHttpsFetch(
  url: URL,
  init: RequestInit,
  addresses: Array<{ address: string; family: 4 | 6 }>,
): Promise<Response> {
  return firstReachableAddress(
    addresses,
    () => init.signal?.aborted === true,
    (selected) => httpsRequestToAddress(url, init, selected),
    { retryAfterFailure: (init.method ?? "GET").toUpperCase() === "GET" },
  );
}

function httpsRequestToAddress(
  url: URL,
  init: RequestInit,
  selected: { address: string; family: 4 | 6 },
): Promise<Response> {
  return new Promise<Response>((resolvePromise, reject) => {
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    const request = httpsRequest({
      protocol: "https:",
      hostname: selected.address,
      family: selected.family,
      port: url.port ? Number(url.port) : 443,
      servername: url.hostname,
      method: init.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers),
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolvePromise(new Response(stream, {
        status: incoming.statusCode ?? 502,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    if (typeof init.body === "string") request.end(init.body);
    else request.end();
  });
}

function pinnedLoopbackFetch(
  url: URL,
  init: RequestInit,
  addresses: Array<{ address: string; family: 4 | 6 }>,
): Promise<Response> {
  const selected = addresses[0];
  if (!selected || url.protocol !== "http:" || !url.port) {
    return Promise.reject(new RestrictedAppError("NETWORK_DENIED", "The loopback destination is not an approved local HTTP service."));
  }
  return new Promise<Response>((resolvePromise, reject) => {
    const headers = new Headers(init.headers);
    headers.set("host", url.host);
    const request = httpRequest({
      protocol: "http:",
      hostname: selected.address,
      family: selected.family,
      port: Number(url.port),
      method: init.method,
      path: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(headers),
      signal: init.signal ?? undefined,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else if (value !== undefined) responseHeaders.set(name, value);
      }
      const stream = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      resolvePromise(new Response(stream, {
        status: incoming.statusCode ?? 502,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    if (typeof init.body === "string") request.end(init.body);
    else request.end();
  });
}

function strictObject(value: unknown, label: string, allowedKeys?: string[], maximumKeys = allowedKeys?.length ?? 64): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > maximumKeys) throw new Error(`${label} has too many fields.`);
  if (allowedKeys) {
    const unknown = keys.find((key) => !allowedKeys.includes(key));
    if (unknown) throw new RestrictedAppError("NETWORK_DENIED", `${label} contains unsupported field ${unknown}.`);
  }
  return record;
}

function requiredString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) throw new Error(`${label} is invalid.`);
  return value;
}

function requiredSecret(value: unknown, label: string): string {
  const secret = requiredString(value, label, 16_384);
  if (/[\r\n\0]/.test(secret)) throw new Error(`${label} contains unsupported control characters.`);
  return secret;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return error.message.replace(/https?:\/\/\S+/g, "the destination").slice(0, 300);
}
