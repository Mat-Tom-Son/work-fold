import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseAppPlatformArtifactDigest } from "../src/local/agent/app-platform-artifact.js";
import {
  computeDeclarationDigest,
  parseFeatureInstallationId,
  parseRuntimeInstanceId,
  parseTenantId,
} from "../src/local/agent/app-platform-contract.js";
import type { RestrictedAppEffectAuthorizer } from "../src/local/agent/restricted-app-connections.js";

import {
  RestrictedAppOAuthError,
  RestrictedAppOAuthPkceClient,
  type RestrictedAppOAuthBinding,
  type RestrictedAppOAuthConnection,
  type RestrictedAppOAuthEncryptedConnectionStore,
  type RestrictedAppOAuthJsonResponse,
  type RestrictedAppOAuthPkceConfiguration,
  type RestrictedAppOAuthPublicHttpsTransport,
} from "../src/local/agent/restricted-app-oauth.js";

const binding: RestrictedAppOAuthBinding = {
  tenantId: parseTenantId("tenant_one"),
  runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_one"),
  featureId: "mail-app",
  featureInstallationId: parseFeatureInstallationId("feature-installation_one"),
  featureRevisionDigest: parseAppPlatformArtifactDigest(`work-fold.artifact.v1:sha256:${"a".repeat(64)}`),
  declarationId: "mail-api",
  declarationDigest: computeDeclarationDigest({ id: "mail-api" }),
  targetIdentity: "https://api.example.com",
  owner: { kind: "instance", runtimeInstanceId: parseRuntimeInstanceId("runtime-instance_one") },
};

const configuration: RestrictedAppOAuthPkceConfiguration = {
  issuer: "https://auth.example.com",
  clientId: "work-fold-public-client",
  scopes: ["mail.read", "profile.read"],
};

function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer: configuration.issuer,
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function completeAuthorization(value: string): Promise<void> {
  const authorization = new URL(value);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "authorization-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("iss", configuration.issuer);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
}

class MemoryEncryptedStore implements RestrictedAppOAuthEncryptedConnectionStore {
  readonly encrypted = true as const;
  readonly sets: RestrictedAppOAuthConnection[] = [];
  connection?: RestrictedAppOAuthConnection;
  beforeSetCommit?: () => void | Promise<void>;
  beforeDeleteCommit?: () => void | Promise<void>;

  async get(): Promise<RestrictedAppOAuthConnection | undefined> {
    return this.connection ? structuredClone(this.connection) : undefined;
  }

  async set(
    _binding: RestrictedAppOAuthBinding,
    connection: RestrictedAppOAuthConnection,
    authorizeCommit?: RestrictedAppEffectAuthorizer,
  ): Promise<void> {
    await this.beforeSetCommit?.();
    await authorizeCommit?.();
    this.connection = structuredClone(connection);
    this.sets.push(structuredClone(connection));
  }

  async delete(_binding: RestrictedAppOAuthBinding, authorizeCommit?: RestrictedAppEffectAuthorizer): Promise<boolean> {
    await this.beforeDeleteCommit?.();
    await authorizeCommit?.();
    const removed = this.connection !== undefined;
    this.connection = undefined;
    return removed;
  }
}

interface TransportCall {
  method: "GET" | "POST";
  url: string;
  form?: URLSearchParams;
  maxResponseBytes: number;
}

class ScriptedTransport implements RestrictedAppOAuthPublicHttpsTransport {
  readonly calls: TransportCall[] = [];
  getResponses: RestrictedAppOAuthJsonResponse[] = [{ status: 200, body: metadata() }];
  postResponses: RestrictedAppOAuthJsonResponse[] = [];
  beforeGetEffect?: () => void | Promise<void>;
  beforePostEffect?: () => void | Promise<void>;

  async getJson(
    url: URL,
    options: { signal: AbortSignal; maxResponseBytes: number; authorizeEffect?: RestrictedAppEffectAuthorizer },
  ): Promise<RestrictedAppOAuthJsonResponse> {
    assert.equal(options.signal.aborted, false);
    await this.beforeGetEffect?.();
    await options.authorizeEffect?.();
    this.calls.push({ method: "GET", url: url.href, maxResponseBytes: options.maxResponseBytes });
    const response = this.getResponses.shift();
    if (!response) throw new Error("No scripted GET response.");
    return structuredClone(response);
  }

  async postForm(
    url: URL,
    form: URLSearchParams,
    options: { signal: AbortSignal; maxResponseBytes: number; authorizeEffect?: RestrictedAppEffectAuthorizer },
  ): Promise<RestrictedAppOAuthJsonResponse> {
    assert.equal(options.signal.aborted, false);
    await this.beforePostEffect?.();
    await options.authorizeEffect?.();
    this.calls.push({ method: "POST", url: url.href, form: new URLSearchParams(form), maxResponseBytes: options.maxResponseBytes });
    const response = this.postResponses.shift();
    if (!response) throw new Error("No scripted POST response.");
    return structuredClone(response);
  }
}

test("OAuth PKCE discovers metadata, uses a one-shot loopback callback, and stores tokens without returning secrets", async () => {
  const store = new MemoryEncryptedStore();
  const transport = new ScriptedTransport();
  transport.postResponses.push({
    status: 200,
    body: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "bearer",
      expires_in: 3_600,
      scope: "mail.read profile.read",
    },
  });
  let authorizationUrl: URL | undefined;
  let callbackResponse: Response | undefined;
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    openExternal: async (value) => {
      authorizationUrl = new URL(value);
      const redirect = authorizationUrl.searchParams.get("redirect_uri")!;
      const callback = new URL(redirect);
      assert.equal(callback.protocol, "http:");
      assert.equal(callback.hostname, "127.0.0.1");
      assert.notEqual(callback.port, "");
      assert.match(callback.pathname, /^\/oauth\/callback\/[A-Za-z0-9_-]{32}$/);
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
      callback.searchParams.set("iss", configuration.issuer);
      callbackResponse = await fetch(callback);
    },
  });

  const status = await client.connect(binding, configuration);

  assert.deepEqual(status, {
    kind: "oauth2-pkce",
    configured: true,
    scopes: configuration.scopes,
    expiresAt: "2026-07-13T13:00:00.000Z",
  });
  assert.equal("accessToken" in status, false);
  assert.equal("refreshToken" in status, false);
  assert.equal(callbackResponse?.status, 200);
  assert.doesNotMatch(await callbackResponse!.text(), /authorization-code|access-secret|refresh-secret/);

  assert.ok(authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://auth.example.com");
  assert.equal(authorizationUrl.pathname, "/authorize");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("client_id"), configuration.clientId);
  assert.equal(authorizationUrl.searchParams.get("scope"), configuration.scopes.join(" "));
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const verifier = transport.calls[1]?.form?.get("code_verifier");
  assert.match(verifier ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    authorizationUrl.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier!, "ascii").digest("base64url"),
  );
  assert.deepEqual(transport.calls.map((call) => [call.method, call.url]), [
    ["GET", "https://auth.example.com/.well-known/oauth-authorization-server"],
    ["POST", "https://auth.example.com/token"],
  ]);
  const tokenForm = transport.calls[1]?.form;
  assert.deepEqual(Object.fromEntries(tokenForm!), {
    grant_type: "authorization_code",
    code: "authorization-code",
    client_id: configuration.clientId,
    redirect_uri: authorizationUrl.searchParams.get("redirect_uri")!,
    code_verifier: verifier!,
  });
  assert.equal("client_secret" in Object.fromEntries(tokenForm!), false);
  assert.equal(store.connection?.accessToken, "access-secret");
  assert.equal(store.connection?.refreshToken, "refresh-secret");
});

test("OAuth discovery performs no provider effect when authority is revoked during transport preparation", async () => {
  const store = new MemoryEncryptedStore();
  const transport = new ScriptedTransport();
  const paused = deferred();
  const release = deferred();
  let revoked = false;
  transport.beforeGetEffect = async () => {
    paused.resolve();
    await release.promise;
  };
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    openExternal: async () => assert.fail("Revoked discovery must not open a browser."),
  });

  const operation = client.connect(binding, configuration, undefined, () => {
    if (revoked) throw new Error("authority revoked");
  });
  await paused.promise;
  revoked = true;
  release.resolve();

  await assert.rejects(operation, /authority revoked/);
  assert.equal(transport.calls.length, 0);
  assert.equal(store.sets.length, 0);
});

test("OAuth token exchange performs no provider effect when authority is revoked after callback", async () => {
  const store = new MemoryEncryptedStore();
  const transport = new ScriptedTransport();
  transport.postResponses.push({
    status: 200,
    body: { access_token: "must-not-be-observed", token_type: "Bearer" },
  });
  const paused = deferred();
  const release = deferred();
  let revoked = false;
  transport.beforePostEffect = async () => {
    paused.resolve();
    await release.promise;
  };
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    openExternal: completeAuthorization,
  });

  const operation = client.connect(binding, configuration, undefined, () => {
    if (revoked) throw new Error("authority revoked");
  });
  await paused.promise;
  revoked = true;
  release.resolve();

  await assert.rejects(operation, /authority revoked/);
  assert.equal(transport.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(store.sets.length, 0);
});

test("OAuth token persistence performs no encrypted-store mutation when authority is revoked at commit", async () => {
  const store = new MemoryEncryptedStore();
  const transport = new ScriptedTransport();
  transport.postResponses.push({
    status: 200,
    body: { access_token: "must-not-persist", token_type: "Bearer" },
  });
  const paused = deferred();
  const release = deferred();
  let revoked = false;
  store.beforeSetCommit = async () => {
    paused.resolve();
    await release.promise;
  };
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    openExternal: completeAuthorization,
  });

  const operation = client.connect(binding, configuration, undefined, () => {
    if (revoked) throw new Error("authority revoked");
  });
  await paused.promise;
  revoked = true;
  release.resolve();

  await assert.rejects(operation, /authority revoked/);
  assert.equal(transport.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(store.connection, undefined);
  assert.equal(store.sets.length, 0);
});

test("OAuth PKCE rejects untrusted provider metadata before opening a browser", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["issuer mismatch", { issuer: "https://attacker.example.net" }],
    ["non-public token endpoint", { token_endpoint: "https://127.0.0.1/token" }],
    ["non-public authorization endpoint", { authorization_endpoint: "https://localhost/authorize" }],
    ["malformed pkce advertisement", { code_challenge_methods_supported: "S256" }],
    ["unsupported grant", { grant_types_supported: ["client_credentials"] }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const transport = new ScriptedTransport();
      transport.getResponses = [{ status: 200, body: metadata(override) }];
      let opened = false;
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport,
        openExternal: async () => { opened = true; },
      });
      await assert.rejects(client.connect(binding, configuration), (error) => (
        error instanceof RestrictedAppOAuthError
          && (error.code === "PROVIDER_UNSUPPORTED" || error.code === "CONFIG_INVALID")
      ));
      assert.equal(opened, false);
      assert.equal(transport.calls.some((call) => call.method === "POST"), false);
    });
  }
});

test("under-advertised provider capabilities are reported but still connect", async (t) => {
  // Every case here is drawn from a provider that works in practice. Google
  // omits `none` from token_endpoint_auth_methods_supported; Microsoft omits
  // code_challenge_methods_supported entirely. Gating on these fields rejected
  // both while proving nothing, because work-fold supplies S256 itself and has
  // no client secret to send.
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["secret-only token endpoint (Google)", { token_endpoint_auth_methods_supported: ["client_secret_post"] }, "METADATA_PUBLIC_CLIENT_UNDECLARED"],
    ["absent pkce advertisement (Microsoft)", { code_challenge_methods_supported: undefined }, "METADATA_PKCE_UNDECLARED"],
    ["missing S256", { code_challenge_methods_supported: ["plain"] }, "METADATA_PKCE_UNDECLARED"],
    ["absent response types", { response_types_supported: undefined }, "METADATA_RESPONSE_TYPE_UNDECLARED"],
    ["missing code response", { response_types_supported: ["token"] }, "METADATA_RESPONSE_TYPE_UNDECLARED"],
  ];
  for (const [name, override, expectedCode] of cases) {
    await t.test(name, async () => {
      const document = metadata();
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) delete document[key]; else document[key] = value;
      }
      const transport = new ScriptedTransport();
      transport.getResponses = [{ status: 200, body: document }];
      transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer" } }];
      const diagnostics: string[] = [];
      const store = new MemoryEncryptedStore();
      const client = new RestrictedAppOAuthPkceClient({
        store,
        transport,
        openExternal: completeAuthorization,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      });
      const status = await client.connect(binding, configuration);
      assert.equal(status.configured, true);
      assert.equal(store.connection?.accessToken, "granted");
      assert.ok(diagnostics.includes(expectedCode), `expected ${expectedCode}, saw ${diagnostics.join(",") || "none"}`);
      assert.ok(status.diagnostics?.some((diagnostic) => diagnostic.code === expectedCode));
      assert.deepEqual((await client.status(binding, configuration))?.diagnostics, status.diagnostics);
      // The client's own guarantees are unchanged by what the document claimed.
      const exchange = transport.calls.find((call) => call.method === "POST");
      assert.equal(exchange?.form?.get("client_secret"), null);
      assert.equal(exchange?.form?.get("code_verifier")?.length ? true : false, true);
    });
  }
});

test("a diagnostic sink that throws cannot break an otherwise valid connection", async () => {
  const transport = new ScriptedTransport();
  transport.getResponses = [{ status: 200, body: metadata({ token_endpoint_auth_methods_supported: ["client_secret_post"] }) }];
  transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer" } }];
  const store = new MemoryEncryptedStore();
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    openExternal: completeAuthorization,
    onDiagnostic: () => { throw new Error("host sink failed"); },
  });
  const status = await client.connect(binding, configuration);
  assert.equal(status.configured, true);
  assert.equal(status.diagnostics?.[0]?.code, "METADATA_PUBLIC_CLIENT_UNDECLARED");
  assert.equal(store.connection?.accessToken, "granted");
});

test("discovery mode selects the metadata document without changing its validation", async (t) => {
  const cases: Array<[string, RestrictedAppOAuthPkceConfiguration, string]> = [
    ["rfc 8414 default", configuration, "https://auth.example.com/.well-known/oauth-authorization-server"],
    ["rfc 8414 explicit", { ...configuration, discovery: "oauth-authorization-server" }, "https://auth.example.com/.well-known/oauth-authorization-server"],
    ["openid connect", { ...configuration, discovery: "openid-configuration" }, "https://auth.example.com/.well-known/openid-configuration"],
  ];
  for (const [name, config, expectedUrl] of cases) {
    await t.test(name, async () => {
      const transport = new ScriptedTransport();
      transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer" } }];
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport,
        openExternal: completeAuthorization,
      });
      await client.connect(binding, config);
      assert.equal(transport.calls.find((call) => call.method === "GET")?.url, expectedUrl);
    });
  }
  await t.test("openid connect still enforces the issuer match", async () => {
    const transport = new ScriptedTransport();
    transport.getResponses = [{ status: 200, body: metadata({ issuer: "https://attacker.example.net" }) }];
    const client = new RestrictedAppOAuthPkceClient({
      store: new MemoryEncryptedStore(),
      transport,
      openExternal: async () => assert.fail("must not open a browser"),
    });
    await assert.rejects(
      client.connect(binding, { ...configuration, discovery: "openid-configuration" }),
      isOAuthError("PROVIDER_UNSUPPORTED"),
    );
  });
});

test("pinned discovery skips the metadata fetch and still refuses a non-public endpoint", async (t) => {
  await t.test("uses the reviewed endpoints without a discovery request", async () => {
    const transport = new ScriptedTransport();
    transport.getResponses = [];
    transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer" } }];
    let authorizationUrl = "";
    const store = new MemoryEncryptedStore();
    const client = new RestrictedAppOAuthPkceClient({
      store,
      transport,
      openExternal: async (value) => { authorizationUrl = value; await completeAuthorization(value); },
    });
    await client.connect(binding, {
      ...configuration,
      discovery: "pinned",
      authorizationEndpoint: "https://auth.example.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://auth.example.com/oauth2/token",
    });
    assert.equal(store.connection?.accessToken, "granted");
    assert.equal(transport.calls.some((call) => call.method === "GET"), false);
    assert.ok(authorizationUrl.startsWith("https://auth.example.com/o/oauth2/v2/auth?"));
    // Only a document served from the issuer's own well-known path can vouch
    // for a host other than the issuer's, which is what discovery mode is for.
    assert.equal(transport.calls.find((call) => call.method === "POST")?.url, "https://auth.example.com/oauth2/token");
  });

  await t.test("refuses a token endpoint the issuer does not own even when the client bypasses the manifest parser", async () => {
    // The manifest parser is the first gate; this is the second. A configuration
    // reaching the client by any other path still cannot aim the code-and-verifier
    // exchange at a host the issuer does not control.
    const attacks: Array<[string, string]> = [
      ["https://collector.attacker.example/token", "unrelated origin"],
      ["https://evil-auth.example.com/token", "bare suffix without a dot boundary"],
      ["https://tokens.auth.example.com/token", "subdomain of the issuer host"],
      ["https://com./token", "bare public suffix"],
      ["https://auth.example.net/token", "different registrable domain"],
      ["https://example.com/token", "parent domain"],
    ];
    for (const [tokenEndpoint, why] of attacks) {
      const transport = new ScriptedTransport();
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport,
        openExternal: async () => assert.fail("must not open a browser"),
      });
      await assert.rejects(
        client.connect(binding, {
          ...configuration,
          discovery: "pinned",
          authorizationEndpoint: "https://auth.example.com/o/oauth2/v2/auth",
          tokenEndpoint,
        }),
        (error) => error instanceof RestrictedAppOAuthError && error.code === "CONFIG_INVALID",
        `expected rejection: ${why}`,
      );
      assert.equal(transport.calls.length, 0, `${why} must not reach the network`);
    }
  });
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["loopback token endpoint", { authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://127.0.0.1/token" }],
    ["plaintext authorization endpoint", { authorizationEndpoint: "http://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" }],
    ["authorization endpoint carrying a query", { authorizationEndpoint: "https://auth.example.com/authorize?tenant=evil", tokenEndpoint: "https://auth.example.com/token" }],
    ["missing token endpoint", { authorizationEndpoint: "https://auth.example.com/authorize" }],
    ["endpoints without pinned discovery", { discovery: "oauth-authorization-server", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" }],
  ];
  for (const [name, override] of rejected) {
    await t.test(name, async () => {
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport: new ScriptedTransport(),
        openExternal: async () => assert.fail("must not open a browser"),
      });
      await assert.rejects(
        client.connect(binding, { ...configuration, discovery: "pinned", ...override } as RestrictedAppOAuthPkceConfiguration),
        (error) => error instanceof RestrictedAppOAuthError && error.code === "CONFIG_INVALID",
      );
    });
  }
});

test("reviewed authorization parameters reach the provider and never displace the protocol", async (t) => {
  await t.test("static parameters are merged into the authorization request", async () => {
    const transport = new ScriptedTransport();
    transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer", refresh_token: "renew" } }];
    let authorizationUrl = "";
    const store = new MemoryEncryptedStore();
    const client = new RestrictedAppOAuthPkceClient({
      store,
      transport,
      openExternal: async (value) => { authorizationUrl = value; await completeAuthorization(value); },
    });
    await client.connect(binding, {
      ...configuration,
      authorizationParameters: [
        { name: "access_type", value: "offline" },
        { name: "prompt", value: "consent" },
      ],
    });
    const url = new URL(authorizationUrl);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    // The whole point of the Google dialect: a refresh token actually arrives.
    assert.equal(store.connection?.refreshToken, "renew");
  });

  await t.test("a protocol-owned name is refused before any request", async () => {
    for (const name of ["redirect_uri", "code_challenge", "client_secret", "scope", "state", "response_type", "grant_type"]) {
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport: new ScriptedTransport(),
        openExternal: async () => assert.fail("must not open a browser"),
      });
      await assert.rejects(
        client.connect(binding, { ...configuration, authorizationParameters: [{ name, value: "attacker" }] }),
        (error) => error instanceof RestrictedAppOAuthError && error.code === "CONFIG_INVALID",
        `${name} must be rejected`,
      );
    }
  });

  await t.test("malformed parameters are refused", async () => {
    const invalid: Array<Array<{ name: string; value: string }>> = [
      [{ name: "Access_Type", value: "offline" }],
      [{ name: "access-type", value: "offline" }],
      [{ name: "access_type", value: "off\nline" }],
      [{ name: "access_type", value: "" }],
      [{ name: "access_type", value: "a" }, { name: "access_type", value: "b" }],
      Array.from({ length: 9 }, (_, index) => ({ name: `p${index}`, value: "x" })),
    ];
    for (const authorizationParameters of invalid) {
      const client = new RestrictedAppOAuthPkceClient({
        store: new MemoryEncryptedStore(),
        transport: new ScriptedTransport(),
        openExternal: async () => assert.fail("must not open a browser"),
      });
      await assert.rejects(
        client.connect(binding, { ...configuration, authorizationParameters }),
        (error) => error instanceof RestrictedAppOAuthError && error.code === "CONFIG_INVALID",
      );
    }
  });
});

test("OAuth PKCE consumes an exact callback once and rejects a mismatched state without exchanging a code", async () => {
  const transport = new ScriptedTransport();
  let callbackStatus = 0;
  const client = new RestrictedAppOAuthPkceClient({
    store: new MemoryEncryptedStore(),
    transport,
    openExternal: async (value) => {
      const authorization = new URL(value);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "must-not-be-exchanged");
      callback.searchParams.set("state", "wrong-state");
      callback.searchParams.set("iss", configuration.issuer);
      callbackStatus = (await fetch(callback)).status;
    },
  });
  await assert.rejects(client.connect(binding, configuration), isOAuthError("AUTH_DENIED"));
  assert.equal(callbackStatus, 400);
  assert.equal(transport.calls.some((call) => call.method === "POST"), false);
});

test("OAuth PKCE callback wait is bounded and closes when authorization is abandoned", async () => {
  const transport = new ScriptedTransport();
  const client = new RestrictedAppOAuthPkceClient({
    store: new MemoryEncryptedStore(),
    transport,
    flowTimeoutMs: 25,
    networkTimeoutMs: 25,
    openExternal: async () => undefined,
  });
  await assert.rejects(client.connect(binding, configuration), isOAuthError("AUTH_CANCELLED"));
});

test("OAuth response objects are bounded even when an injected transport violates its contract", async () => {
  const transport = new ScriptedTransport();
  transport.getResponses = [{ status: 200, body: { padding: "x".repeat(70_000) } }];
  const client = new RestrictedAppOAuthPkceClient({
    store: new MemoryEncryptedStore(),
    transport,
    maxResponseBytes: 64 * 1024,
    openExternal: async () => assert.fail("Browser must not open for an oversized metadata response."),
  });
  await assert.rejects(client.connect(binding, configuration), isOAuthError("NETWORK_FAILED"));
  assert.equal(transport.calls[0]?.maxResponseBytes, 64 * 1024);
});

test("OAuth authorization serializes refresh, rotates the refresh token, and persists before injecting it", async () => {
  const store = new MemoryEncryptedStore();
  store.connection = {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: configuration.scopes,
    grantedScopes: configuration.scopes,
    tokenType: "Bearer",
    accessToken: "expiring-access",
    refreshToken: "old-refresh",
    expiresAt: "2026-07-13T12:00:30.000Z",
    connectedAt: "2026-07-12T12:00:00.000Z",
  };
  const transport = new ScriptedTransport();
  transport.getResponses.push({ status: 200, body: metadata() });
  transport.postResponses.push({
    status: 200,
    body: {
      access_token: "fresh-access",
      refresh_token: "new-refresh",
      token_type: "Bearer",
      expires_in: 3_600,
    },
  });
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    openExternal: async () => assert.fail("Refresh must not open a browser."),
  });
  const one = new Headers({ authorization: "app-supplied-value" });
  const two = new Headers();

  await Promise.all([
    client.authorize(binding, configuration, one),
    client.authorize(binding, configuration, two),
  ]);

  assert.equal(one.get("authorization"), "Bearer fresh-access");
  assert.equal(two.get("authorization"), "Bearer fresh-access");
  assert.equal(transport.calls.filter((call) => call.method === "POST").length, 1);
  assert.deepEqual(Object.fromEntries(transport.calls.find((call) => call.method === "POST")!.form!), {
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
    client_id: configuration.clientId,
  });
  assert.equal(store.connection?.refreshToken, "new-refresh");
  assert.equal(store.connection?.accessToken, "fresh-access");
  assert.equal(store.sets.length, 1);
});

test("OAuth authorization requires a new browser flow when an expiring connection has no refresh token", async () => {
  const store = new MemoryEncryptedStore();
  store.connection = {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: configuration.scopes,
    grantedScopes: configuration.scopes,
    tokenType: "Bearer",
    accessToken: "expiring-access",
    expiresAt: "2026-07-13T12:00:30.000Z",
    connectedAt: "2026-07-12T12:00:00.000Z",
  };
  const transport = new ScriptedTransport();
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    openExternal: async () => undefined,
  });
  await assert.rejects(client.authorize(binding, configuration, new Headers()), isOAuthError("AUTH_REQUIRED"));
  assert.equal(transport.calls.length, 0);
});

test("OAuth disconnect invalidates an in-flight refresh before it can recreate the connection", async () => {
  const store = new MemoryEncryptedStore();
  store.connection = {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: configuration.scopes,
    grantedScopes: configuration.scopes,
    tokenType: "Bearer",
    accessToken: "expiring-access",
    refreshToken: "old-refresh",
    expiresAt: "2026-07-13T12:00:30.000Z",
    connectedAt: "2026-07-12T12:00:00.000Z",
  };
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let providerEffects = 0;
  const transport: RestrictedAppOAuthPublicHttpsTransport = {
    async getJson(_url, options) {
      await options.authorizeEffect?.();
      return { status: 200, body: metadata() };
    },
    async postForm(_url, _form, options) {
      refreshStarted();
      await release;
      await options.authorizeEffect?.();
      providerEffects += 1;
      return { status: 200, body: { access_token: "resurrected-access", token_type: "Bearer", expires_in: 3_600 } };
    },
  };
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    openExternal: async () => assert.fail("Refresh must not open a browser."),
  });

  const authorization = client.authorize(binding, configuration, new Headers());
  await started;
  assert.equal(await client.disconnect(binding), true);
  releaseRefresh();
  await assert.rejects(authorization, isOAuthError("AUTH_REQUIRED"));
  assert.equal(store.connection, undefined);
  assert.equal(store.sets.length, 0);
  assert.equal(providerEffects, 0);
});

test("OAuth generation is rechecked at the encrypted-store commit after disconnect", async () => {
  const store = new MemoryEncryptedStore();
  store.connection = {
    kind: "oauth2-pkce",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    requestedScopes: configuration.scopes,
    grantedScopes: configuration.scopes,
    tokenType: "Bearer",
    accessToken: "expiring-access",
    refreshToken: "old-refresh",
    expiresAt: "2026-07-13T12:00:30.000Z",
    connectedAt: "2026-07-12T12:00:00.000Z",
  };
  const transport = new ScriptedTransport();
  transport.getResponses.push({ status: 200, body: metadata() });
  transport.postResponses.push({
    status: 200,
    body: { access_token: "must-not-persist", token_type: "Bearer", expires_in: 3_600 },
  });
  const commitReached = deferred();
  const releaseCommit = deferred();
  store.beforeSetCommit = async () => {
    commitReached.resolve();
    await releaseCommit.promise;
  };
  const client = new RestrictedAppOAuthPkceClient({
    store,
    transport,
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    openExternal: async () => assert.fail("Refresh must not open a browser."),
  });

  const authorization = client.authorize(binding, configuration, new Headers());
  await commitReached.promise;
  assert.equal(await client.disconnect(binding), true);
  releaseCommit.resolve();

  await assert.rejects(authorization, isOAuthError("AUTH_REQUIRED"));
  assert.equal(store.connection, undefined);
  assert.equal(store.sets.length, 0);
});

test("OAuth configuration rejects secrets, arbitrary endpoints, and local issuers", async () => {
  const client = new RestrictedAppOAuthPkceClient({
    store: new MemoryEncryptedStore(),
    transport: new ScriptedTransport(),
    openExternal: async () => undefined,
  });
  await assert.rejects(client.connect(binding, {
    ...configuration,
    clientSecret: "must-not-be-accepted",
  } as RestrictedAppOAuthPkceConfiguration), isOAuthError("CONFIG_INVALID"));
  await assert.rejects(client.connect(binding, {
    ...configuration,
    tokenEndpoint: "https://attacker.example.net/token",
  } as RestrictedAppOAuthPkceConfiguration), isOAuthError("CONFIG_INVALID"));
  await assert.rejects(client.connect(binding, {
    ...configuration,
    issuer: "http://127.0.0.1:4567",
  }), isOAuthError("CONFIG_INVALID"));
  await assert.rejects(client.connect(binding, {
    ...configuration,
    scopes: ["openid", "mail.read"],
  }), isOAuthError("CONFIG_INVALID"));
});

function isOAuthError(code: RestrictedAppOAuthError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof RestrictedAppOAuthError && error.code === code;
}

// Metadata subsets captured from the live providers on 2026-07-26. They are
// fixtures, not live requests: the point is that the exact documents Google and
// Microsoft actually serve reach a working connection. Before this change both
// were rejected — Google omits "none" from token_endpoint_auth_methods_supported
// and Microsoft omits code_challenge_methods_supported entirely, and each was a
// hard failure even though both support PKCE public clients.
const realProviderMetadata = {
  google: {
    issuer: "https://accounts.google.com",
    authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    token_endpoint: "https://oauth2.googleapis.com/token",
    response_types_supported: ["code", "token", "id_token", "code token", "code id_token", "token id_token", "code token id_token", "none"],
    grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  },
  microsoft: {
    issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
    authorization_endpoint: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/authorize",
    token_endpoint: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/token",
    response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt", "client_secret_basic", "self_signed_tls_client_auth"],
  },
} as const;

test("the metadata documents real providers actually serve produce a working connection", async (t) => {
  const cases = [
    {
      name: "Google via RFC 8414",
      document: realProviderMetadata.google,
      config: {
        issuer: "https://accounts.google.com",
        clientId: "work-fold.apps.googleusercontent.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        authorizationParameters: [{ name: "access_type", value: "offline" }],
      },
      expectedMetadataUrl: "https://accounts.google.com/.well-known/oauth-authorization-server",
      expectedDiagnostics: ["METADATA_PUBLIC_CLIENT_UNDECLARED"],
    },
    {
      name: "Microsoft via OpenID Connect discovery",
      document: realProviderMetadata.microsoft,
      config: {
        issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
        clientId: "00000000-0000-0000-0000-000000000000",
        scopes: ["https://graph.microsoft.com/Mail.Read"],
        discovery: "openid-configuration" as const,
      },
      expectedMetadataUrl: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0/.well-known/openid-configuration",
      expectedDiagnostics: ["METADATA_PKCE_UNDECLARED", "METADATA_PUBLIC_CLIENT_UNDECLARED"],
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const transport = new ScriptedTransport();
      transport.getResponses = [{ status: 200, body: structuredClone(item.document) as Record<string, unknown> }];
      transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer", refresh_token: "renew" } }];
      const diagnostics: string[] = [];
      const store = new MemoryEncryptedStore();
      const client = new RestrictedAppOAuthPkceClient({
        store,
        transport,
        openExternal: async (value) => {
          const authorization = new URL(value);
          assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
          assert.equal(authorization.searchParams.get("client_secret"), null);
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.searchParams.set("code", "authorization-code");
          callback.searchParams.set("state", authorization.searchParams.get("state")!);
          callback.searchParams.set("iss", item.config.issuer);
          assert.equal((await fetch(callback)).status, 200);
        },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      });
      await client.connect(binding, item.config as RestrictedAppOAuthPkceConfiguration);
      assert.equal(store.connection?.accessToken, "granted");
      assert.equal(transport.calls.find((call) => call.method === "GET")?.url, item.expectedMetadataUrl);
      assert.deepEqual(diagnostics.sort(), [...item.expectedDiagnostics].sort());
      assert.equal(transport.calls.find((call) => call.method === "POST")?.form?.get("client_secret"), null);
    });
  }
});

test("a manifest declaration reaches the client verbatim, kind field included", async () => {
  // RestrictedAppService.connectOAuth passes the parsed manifest auth
  // declaration straight through, and that object always carries `kind`.
  // Rejecting it here made every real connect fail CONFIG_INVALID while the
  // suite stayed green on kind-less literals.
  const transport = new ScriptedTransport();
  transport.postResponses = [{ status: 200, body: { access_token: "granted", token_type: "Bearer" } }];
  const store = new MemoryEncryptedStore();
  const client = new RestrictedAppOAuthPkceClient({ store, transport, openExternal: completeAuthorization });
  const declaration = {
    kind: "oauth2-pkce" as const,
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    scopes: [...configuration.scopes],
  };
  await client.connect(binding, declaration);
  assert.equal(store.connection?.accessToken, "granted");

  const wrongKind = { ...declaration, kind: "api-key" } as unknown as RestrictedAppOAuthPkceConfiguration;
  await assert.rejects(
    new RestrictedAppOAuthPkceClient({ store: new MemoryEncryptedStore(), transport: new ScriptedTransport(), openExternal: async () => assert.fail("no browser") })
      .connect(binding, wrongKind),
    (error) => error instanceof RestrictedAppOAuthError && error.code === "CONFIG_INVALID",
  );
});
