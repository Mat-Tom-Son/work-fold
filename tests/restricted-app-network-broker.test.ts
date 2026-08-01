import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAppPlatformArtifactDigest } from "../src/local/agent/app-platform-artifact.js";
import {
  computeDeclarationDigest,
  parseFeatureInstallationId,
  parsePrincipalId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "../src/local/agent/app-platform-contract.js";
import {
  assertRestrictedAppEffectAuthority,
  firstReachableAddress,
  normalizeRestrictedAppCredential,
  RestrictedAppError,
  RestrictedAppNetworkBroker,
  type RestrictedAppConnectionBinding,
  type RestrictedAppConnectionStore,
  type RestrictedAppCredential,
  type RestrictedAppRuntimeOwner,
} from "../src/local/agent/restricted-app-connections.js";
import { EncryptedRestrictedAppConnectionStore } from "../src/local/agent/restricted-app-connection-store.js";
import {
  parseRestrictedAppManifest,
  type RestrictedAppAuthDeclaration,
  type RestrictedAppManifest,
} from "../src/local/agent/restricted-app-manifest.js";

const tenantId = parseTenantId("tenant_local-test");
const runtimeInstanceId = parseRuntimeInstanceId("runtime-instance_mail-test");
const featureInstallationId = parseFeatureInstallationId("feature-installation_mail-test");
const effectivePrincipalId = parsePrincipalId("principal_local-test");
const featureRevisionDigest = parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"a".repeat(64)}`);
const owner: RestrictedAppRuntimeOwner = {
  tenantId,
  runtimeInstanceId,
  featureId: "mail-app",
  featureInstallationId,
  featureRevisionDigest,
  effectivePrincipalId,
  connectionOwner: { kind: "instance", runtimeInstanceId },
  networkGrants: ["mail-api"],
};

test("connection credentials reject fields from a different auth kind", () => {
  assert.throws(
    () => normalizeRestrictedAppCredential({ kind: "bearer", token: "token", value: "extra-secret" }),
    /too many fields|unsupported field value/i,
  );
  assert.throws(
    () => normalizeRestrictedAppCredential({ kind: "api-key", value: "key", password: "extra-secret" }),
    /too many fields|unsupported field password/i,
  );
});

class MemoryConnections implements RestrictedAppConnectionStore {
  readonly gets: RestrictedAppConnectionBinding[] = [];

  constructor(private credential?: RestrictedAppCredential) {}

  async get(binding: RestrictedAppConnectionBinding): Promise<RestrictedAppCredential | undefined> {
    this.gets.push(structuredClone(binding));
    return this.credential ? structuredClone(this.credential) : undefined;
  }

  async set(_binding: RestrictedAppConnectionBinding, credential: RestrictedAppCredential): Promise<void> {
    this.credential = structuredClone(credential);
  }

  async delete(): Promise<boolean> {
    const existed = this.credential !== undefined;
    this.credential = undefined;
    return existed;
  }

  async deleteFeature(): Promise<void> {
    this.credential = undefined;
  }

  async deleteRuntimeInstance(): Promise<void> {
    this.credential = undefined;
  }
}

function manifest(options: {
  auth?: RestrictedAppAuthDeclaration[];
  methods?: string[];
  origin?: string;
  requestHeaders?: string[];
} = {}): RestrictedAppManifest {
  return parseRestrictedAppManifest({
    version: 2,
    id: "mail-app",
    title: "Mail",
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    ui: {},
    tools: [],
    automations: [],
    permissions: {
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: options.origin ?? "https://mail.example.com" },
        methods: options.methods ?? ["GET", "POST"],
        auth: options.auth ?? [{ kind: "none" }],
        ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
      }],
    },
  });
}

function loopbackManifest(port: number): RestrictedAppManifest {
  return parseRestrictedAppManifest({
    version: 2,
    id: "mail-app",
    title: "Mail",
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    ui: {},
    tools: [],
    automations: [],
    permissions: {
      network: [{
        id: "local-api",
        target: { kind: "loopback-http", host: "127.0.0.1", port },
        methods: ["GET"],
        auth: [{ kind: "none" }],
      }],
    },
  });
}

function successfulFetch(inspect?: (url: URL, init: RequestInit) => void): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    inspect?.(new URL(String(input)), init ?? {});
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

function isRestrictedError(code: RestrictedAppError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RestrictedAppError && error.code === code;
}

test("network broker derives an exact App-platform credential binding", async () => {
  const connections = new MemoryConnections({ kind: "bearer", token: "binding-token" });
  const broker = new RestrictedAppNetworkBroker({ credentials: connections, fetch: successfulFetch() });
  const app = manifest({ auth: [{ kind: "bearer" }] });

  await broker.request(owner, app, {
    destinationId: "mail-api",
    method: "GET",
    path: "/messages?unread=true",
  });

  assert.deepEqual(connections.gets, [{
    tenantId,
    runtimeInstanceId,
    featureId: "mail-app",
    featureInstallationId,
    featureRevisionDigest,
    declarationId: "mail-api",
    declarationDigest: computeDeclarationDigest(app.permissions.network[0]),
    targetIdentity: "https://mail.example.com",
    owner: { kind: "instance", runtimeInstanceId },
  }]);
});

test("network broker keeps Principal-owned bindings distinct and tied to the effective Principal", async () => {
  const connections = new MemoryConnections({ kind: "bearer", token: "personal-token" });
  const broker = new RestrictedAppNetworkBroker({ credentials: connections, fetch: successfulFetch() });
  const app = manifest({ auth: [{ kind: "bearer" }] });
  const principalOwner: RestrictedAppRuntimeOwner = {
    ...owner,
    connectionOwner: { kind: "principal", principalId: effectivePrincipalId },
  };

  await broker.request(principalOwner, app, {
    destinationId: "mail-api",
    method: "GET",
    path: "/messages",
  });

  assert.deepEqual(connections.gets[0]?.owner, { kind: "principal", principalId: effectivePrincipalId });
});

test("network broker reauthorizes immediately before every external request", async () => {
  let fetches = 0;
  const authority = {
    hostOpen: true,
    launchGeneration: 4,
    currentGeneration: 4,
    live: true,
    persistentAuthorityCurrent: true,
  };
  let reachedEffect!: () => void;
  let releaseEffect!: () => void;
  const effectReached = new Promise<void>((resolve) => { reachedEffect = resolve; });
  const release = new Promise<void>((resolve) => { releaseEffect = resolve; });
  const broker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: successfulFetch(() => { fetches += 1; }),
  });

  const request = broker.request(
    owner,
    manifest(),
    { destinationId: "mail-api", method: "GET", path: "/messages" },
    undefined,
    async () => {
      reachedEffect();
      await release;
      assertRestrictedAppEffectAuthority(authority);
    },
  );
  await effectReached;
  authority.currentGeneration += 1;
  authority.live = false;
  releaseEffect();

  await assert.rejects(request, isRestrictedError("AUTHORITY_STALE"));
  assert.equal(fetches, 0);
});

test("network broker injects API-key, bearer, and basic credentials in the host", async () => {
  const cases: Array<{
    auth: RestrictedAppAuthDeclaration;
    credential: RestrictedAppCredential;
    header: string;
    expected: string;
  }> = [
    {
      auth: { kind: "api-key", header: "x-service-key" },
      credential: { kind: "api-key", value: "api-secret" },
      header: "x-service-key",
      expected: "api-secret",
    },
    {
      auth: { kind: "bearer" },
      credential: { kind: "bearer", token: "bearer-secret" },
      header: "authorization",
      expected: "Bearer bearer-secret",
    },
    {
      auth: { kind: "basic" },
      credential: { kind: "basic", username: "user", password: "password" },
      header: "authorization",
      expected: `Basic ${Buffer.from("user:password", "utf8").toString("base64")}`,
    },
  ];

  for (const item of cases) {
    let sentHeaders: Headers | undefined;
    const broker = new RestrictedAppNetworkBroker({
      credentials: new MemoryConnections(item.credential),
      fetch: successfulFetch((_url, init) => { sentHeaders = new Headers(init.headers); }),
    });
    await broker.request(owner, manifest({ auth: [item.auth] }), {
      destinationId: "mail-api",
      method: "GET",
      path: "/messages",
      headers: { accept: "application/json" },
    });
    assert.equal(sentHeaders?.get(item.header), item.expected);
    assert.equal(sentHeaders?.get("cookie"), null);
  }
});

test("network broker requires an accepted credential when anonymous access is not declared", async () => {
  const broker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: successfulFetch(() => assert.fail("fetch must not run without credentials")),
  });
  await assert.rejects(
    broker.request(owner, manifest({ auth: [{ kind: "bearer" }] }), {
      destinationId: "mail-api",
      method: "GET",
      path: "/messages",
    }),
    isRestrictedError("AUTH_REQUIRED"),
  );
});

test("network broker enforces owner identity, destination grants, methods, paths, and headers before fetch", async () => {
  let fetches = 0;
  const broker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: successfulFetch(() => { fetches += 1; }),
  });
  const app = manifest({ methods: ["GET"] });
  const denied: Array<[RestrictedAppRuntimeOwner, unknown]> = [
    [{ ...owner, featureId: "other-app" }, { destinationId: "mail-api", method: "GET", path: "/messages" }],
    [{ ...owner, connectionOwner: { kind: "instance", runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_other-test") } }, { destinationId: "mail-api", method: "GET", path: "/messages" }],
    [{ ...owner, connectionOwner: { kind: "principal", principalId: parsePrincipalId("principal_other-test") } }, { destinationId: "mail-api", method: "GET", path: "/messages" }],
    [{ ...owner, networkGrants: [] }, { destinationId: "mail-api", method: "GET", path: "/messages" }],
    [owner, { destinationId: "unknown", method: "GET", path: "/messages" }],
    [owner, { destinationId: "mail-api", method: "POST", path: "/messages" }],
    [owner, { destinationId: "mail-api", method: "GET", path: "//evil.example/messages" }],
    [owner, { destinationId: "mail-api", method: "GET", path: "/messages#secret" }],
    [owner, { destinationId: "mail-api", method: "GET", path: "/messages", headers: { authorization: "Bearer app-secret" } }],
    [owner, { destinationId: "mail-api", method: "GET", path: "/messages", appId: "mail-app" }],
  ];
  for (const [runtimeOwner, request] of denied) {
    await assert.rejects(broker.request(runtimeOwner, app, request), isRestrictedError("NETWORK_DENIED"));
  }
  assert.equal(fetches, 0);
});

test("network broker enforces request byte limits and denies private destination resolution", async () => {
  let fetches = 0;
  const oversized = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    maxRequestBytes: 4,
    fetch: successfulFetch(() => { fetches += 1; }),
  });
  // Distinct from NETWORK_DENIED — an app that asked for too much can retry
  // smaller, whereas a denial means the grant itself does not cover the call.
  await assert.rejects(
    oversized.request(owner, manifest(), { destinationId: "mail-api", method: "POST", path: "/messages", body: "12345" }),
    (error) => error instanceof RestrictedAppError && error.code === "NETWORK_REQUEST_TOO_LARGE" && /4-byte/.test(error.message),
  );

  const privateDestination = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    fetch: successfulFetch(() => { fetches += 1; }),
  });
  await assert.rejects(
    privateDestination.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" }),
    isRestrictedError("NETWORK_DENIED"),
  );
  assert.equal(fetches, 0);
});

test("network broker follows bounded same-origin redirects and rejects cross-origin redirects", async () => {
  const visited: Array<{ url: string; method: string; body: BodyInit | null | undefined }> = [];
  const sameOriginFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    visited.push({ url: String(input), method: init?.method ?? "GET", body: init?.body });
    if (visited.length === 1) return new Response(null, { status: 307, headers: { location: "/v2/messages" } });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof globalThis.fetch;
  const broker = new RestrictedAppNetworkBroker({ credentials: new MemoryConnections(), fetch: sameOriginFetch });
  const response = await broker.request(owner, manifest({ methods: ["POST"] }), {
    destinationId: "mail-api",
    method: "POST",
    path: "/v1/messages",
    body: "payload",
  });
  assert.equal(response.body, "ok");
  assert.deepEqual(visited, [
    { url: "https://mail.example.com/v1/messages", method: "POST", body: "payload" },
    { url: "https://mail.example.com/v2/messages", method: "POST", body: "payload" },
  ]);

  let crossOriginFetches = 0;
  const crossOrigin = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: (async () => {
      crossOriginFetches += 1;
      return new Response(null, { status: 302, headers: { location: "https://evil.example/messages" } });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    crossOrigin.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" }),
    isRestrictedError("NETWORK_DENIED"),
  );
  assert.equal(crossOriginFetches, 1);
});

test("network broker caps redirects, response bytes, and exposed response headers", async () => {
  let redirects = 0;
  const redirectBroker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    maxRedirects: 1,
    fetch: (async () => {
      redirects += 1;
      return new Response(null, { status: 302, headers: { location: `/redirect-${redirects}` } });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    redirectBroker.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" }),
    isRestrictedError("NETWORK_DENIED"),
  );
  assert.equal(redirects, 2);

  const oversized = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    maxResponseBytes: 4,
    fetch: (async () => new Response("12345", { headers: { "content-type": "text/plain" } })) as typeof globalThis.fetch,
  });
  // The overrun names its own bound so an app can page against it instead of
  // guessing which generic network failure it just hit.
  await assert.rejects(
    oversized.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" }),
    (error) => error instanceof RestrictedAppError && error.code === "NETWORK_RESPONSE_TOO_LARGE" && /4-byte/.test(error.message),
  );
  assert.deepEqual(oversized.limits, { maxRequestBytes: 128 * 1024, maxResponseBytes: 4, timeoutMs: 15_000, maxRedirects: 3 });

  const filtered = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: (async () => new Response("ok", {
      headers: {
        "content-type": "text/plain",
        etag: "v1",
        "set-cookie": "session=secret",
        "x-secret": "hidden",
      },
    })) as typeof globalThis.fetch,
  });
  const response = await filtered.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" });
  assert.deepEqual(response.headers, { "content-type": "text/plain", etag: "v1" });
});

test("network broker applies its deadline while streaming the response body", async () => {
  const broker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    timeoutMs: 10,
    fetch: (async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { headers: { "content-type": "text/plain" } })) as typeof globalThis.fetch,
  });

  await assert.rejects(
    broker.request(owner, manifest(), { destinationId: "mail-api", method: "GET", path: "/messages" }),
    isRestrictedError("NETWORK_FAILED"),
  );
});

test("network broker reaches an exact loopback service and denies its redirects", async () => {
  const requests: Array<{ host: string | undefined; url: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ host: request.headers.host, url: request.url });
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "x-private": "hidden" });
    response.end('{"service":"ready"}');
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.ok(address.port >= 1_024);
    const productionConnections = new EncryptedRestrictedAppConnectionStore(
      join(tmpdir(), `work-fold-loopback-composition-${randomUUID()}.bin`),
      {
        isAvailable: () => true,
        encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
        decrypt: (ciphertext) => Buffer.from(ciphertext).toString("utf8"),
      },
    );
    const broker = new RestrictedAppNetworkBroker({ credentials: productionConnections });
    const localOwner = { ...owner, networkGrants: ["local-api"] };
    const app = loopbackManifest(address.port);

    const response = await broker.request(localOwner, app, {
      destinationId: "local-api",
      method: "GET",
      path: "/status?detail=true",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"service":"ready"}');
    assert.deepEqual(response.headers, { "content-type": "application/json" });
    assert.deepEqual(requests, [{
      host: `127.0.0.1:${address.port}`,
      url: "/status?detail=true",
    }]);

    await assert.rejects(
      broker.request(localOwner, app, {
        destinationId: "local-api",
        method: "GET",
        path: "/redirect",
      }),
      isRestrictedError("NETWORK_DENIED"),
    );
    assert.equal(requests.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("network broker fails over to the next approved address and stops on cancellation", async () => {
  const ipv6 = { address: "2001:4860:4860::8888", family: 6 as const };
  const ipv4 = { address: "142.250.72.0", family: 4 as const };

  const tried: string[] = [];
  const reached = await firstReachableAddress([ipv6, ipv4], () => false, async (selected) => {
    tried.push(selected.address);
    if (selected.family === 6) throw new Error("connect ENETUNREACH");
    return "ok";
  });
  assert.equal(reached, "ok");
  assert.deepEqual(tried, [ipv6.address, ipv4.address], "an unreachable family does not strand a dual-stack destination");

  await assert.rejects(
    () => firstReachableAddress([ipv6, ipv4], () => false, async () => { throw new Error("connect ECONNREFUSED"); }),
    /ECONNREFUSED/,
    "exhausting every candidate surfaces the last connection failure",
  );

  // A deadline or an explicit stop must not be spent retrying other addresses.
  const afterCancel: string[] = [];
  await assert.rejects(
    () => firstReachableAddress([ipv6, ipv4], () => true, async (selected) => {
      afterCancel.push(selected.address);
      throw new Error("The network request timed out.");
    }),
    /timed out/,
  );
  assert.deepEqual(afterCancel, [ipv6.address], "cancellation stops the walk instead of consuming candidates");

  const mutatingAttempts: string[] = [];
  await assert.rejects(
    () => firstReachableAddress(
      [ipv6, ipv4],
      () => false,
      async (selected) => {
        mutatingAttempts.push(selected.address);
        throw new Error("socket reset after request dispatch");
      },
      { retryAfterFailure: false },
    ),
    /socket reset/,
  );
  assert.deepEqual(mutatingAttempts, [ipv6.address], "a mutation is never replayed against a second address");

  await assert.rejects(
    () => firstReachableAddress([], () => false, async () => "unreachable"),
    (error: unknown) => error instanceof RestrictedAppError && error.code === "NETWORK_DENIED",
  );
});

test("network broker sends reviewed per-destination headers and still denies undeclared ones", async () => {
  const sent: Headers[] = [];
  const broker = new RestrictedAppNetworkBroker({
    credentials: new MemoryConnections(),
    fetch: successfulFetch((_url, init) => { sent.push(new Headers(init?.headers)); }),
  });
  const app = manifest({ methods: ["GET"], requestHeaders: ["x-api-version"] });

  await broker.request(owner, app, {
    destinationId: "mail-api",
    method: "GET",
    path: "/messages",
    headers: { "x-api-version": "2026-07-01", accept: "application/json" },
  });
  assert.equal(sent[0]?.get("x-api-version"), "2026-07-01", "a reviewed header reaches the destination");
  assert.equal(sent[0]?.get("accept"), "application/json", "the always-allowed set still applies");

  // Declaring one header grants exactly that header, not a header channel.
  await assert.rejects(
    broker.request(owner, app, { destinationId: "mail-api", method: "GET", path: "/messages", headers: { "x-tracing": "1" } }),
    isRestrictedError("NETWORK_DENIED"),
  );
  // A header reviewed for one destination is not granted to another.
  await assert.rejects(
    broker.request(owner, manifest({ methods: ["GET"] }), {
      destinationId: "mail-api",
      method: "GET",
      path: "/messages",
      headers: { "x-api-version": "2026-07-01" },
    }),
    isRestrictedError("NETWORK_DENIED"),
  );
});

test("reviewed request headers cannot carry routing, hop-by-hop, or credential names", async () => {
  for (const header of [
    "authorization", "host", "cookie", "content-length", "transfer-encoding",
    "forwarded", "x-forwarded-for", "x-forwarded-port", "proxy-connection",
  ]) {
    assert.throws(() => manifest({ requestHeaders: [header] }), /request header is not allowed/, header);
  }
  assert.throws(() => manifest({ requestHeaders: ["X Api Version"] }), /request header is not allowed/);
  assert.throws(() => manifest({ requestHeaders: ["x-dup", "X-DUP"] }), /request header/);
  assert.throws(
    () => manifest({ auth: [{ kind: "api-key", header: "x-api-key" }], requestHeaders: ["x-api-key"] }),
    /cannot declare its own credential header/,
    "an app cannot reuse the slot its injected credential occupies",
  );
});
