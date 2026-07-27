import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRestrictedAppManifest,
  restrictedAppManifestVersion,
} from "../src/local/agent/restricted-app-manifest.js";
import {
  restrictedAppDefaultCornerRadius,
  restrictedAppMaximumCornerRadius,
} from "../src/shared/restricted-app-presentation.js";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search the connected inbox.",
      action: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    permissions: {
      files: [{ id: "exports", target: "directory", access: "read-write" }],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "inbox-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET", "POST"],
        auth: [{
          kind: "oauth2-pkce",
          issuer: "https://identity.example.com",
          clientId: "workspace-connected-inbox",
          scopes: ["mail.read", "mail.send"],
        }],
      }],
    },
    automations: [{
      id: "refresh-inbox",
      title: "Refresh inbox",
      description: "Fetch new messages for this Space.",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: {
        network: ["inbox-api"],
        files: ["exports"],
        notifications: ["new-mail"],
      },
      catchUp: "latest",
      overlap: "skip",
    }],
    ...overrides,
  };
}

test("restricted app manifests normalize a bounded sandbox, tool, and connection contract", () => {
  const parsed = parseRestrictedAppManifest(manifest());
  assert.equal(parsed.runtime.kind, "sandboxed-web");
  assert.equal(parsed.runtime.entry, "index.html");
  assert.equal(parsed.runtime.worker, "worker.js");
  assert.equal(parsed.tools[0]?.inputSchema.additionalProperties, false);
  assert.deepEqual(parsed.permissions.network[0]?.methods, ["GET", "POST"]);
  assert.deepEqual(parsed.permissions.network[0]?.auth, [{
    kind: "oauth2-pkce",
    issuer: "https://identity.example.com",
    clientId: "workspace-connected-inbox",
    scopes: ["mail.read", "mail.send"],
  }]);
  assert.deepEqual(parsed.permissions.files, [{ id: "exports", target: "directory", access: "read-write" }]);
  assert.deepEqual(parsed.permissions.notifications, [{ id: "new-mail", title: "New mail", description: "New messages are ready." }]);
  assert.equal(parsed.automations[0]?.id, "refresh-inbox");
  assert.equal(parsed.ui.cornerRadius, undefined);
});

test("restricted app canvas corners default in the host and accept a bounded manifest override", () => {
  assert.equal(restrictedAppDefaultCornerRadius, 12);
  assert.equal(restrictedAppMaximumCornerRadius, 24);
  for (const cornerRadius of [0, 12, 24]) {
    assert.equal(parseRestrictedAppManifest(manifest({
      ui: { icon: "mail", cornerRadius },
    })).ui.cornerRadius, cornerRadius);
  }
  for (const cornerRadius of [-1, 24.5, 25, "12"]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      ui: { icon: "mail", cornerRadius },
    })), /corner radius must be a whole number between 0 and 24/);
  }
  assert.throws(() => parseRestrictedAppManifest(manifest({
    ui: { icon: "mail", cornerRadius: 12, shadow: "large" },
  })), /Restricted app UI (?:contains an unsupported field|has too many fields)/);
});

test("restricted app manifests normalize named automations with explicit permission subsets", () => {
  assert.equal(restrictedAppManifestVersion, 2);
  const parsed = parseRestrictedAppManifest(manifest());
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.automations, [{
    id: "refresh-inbox",
    title: "Refresh inbox",
    description: "Fetch new messages for this Space.",
    handler: "refresh-inbox",
    trigger: { kind: "interval", intervalMinutes: 30 },
    permissions: {
      network: ["inbox-api"],
      files: ["exports"],
      notifications: ["new-mail"],
    },
    catchUp: "latest",
    overlap: "skip",
  }]);
});

test("manifests require version 2 named automations and reject the legacy background field", () => {
  assert.throws(() => parseRestrictedAppManifest(manifest({ version: 1 })), /version must be 2/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    background: { intervalMinutes: 30 },
  })), /unsupported field: background/);
  const { automations: _automations, ...missingAutomations } = manifest();
  assert.throws(() => parseRestrictedAppManifest(missingAutomations), /automations must contain between 0 and 16 items/);
  assert.throws(() => parseRestrictedAppManifest({ ...manifest(), version: 3 }), /version must be 2/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: Array.from({ length: 17 }, (_, index) => ({
      id: `job-${index}`,
      title: `Job ${index}`,
      handler: `job-${index}`,
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: [], files: [], notifications: [] },
      catchUp: "none",
      overlap: "skip",
    })),
    permissions: { network: [], files: [], notifications: [] },
  })), /between 0 and 16 items/);
});

test("automation declarations are closed, bounded, and uniquely identified", () => {
  const valid = manifest().automations[0] as Record<string, unknown>;
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, arbitraryPower: true }],
  })), /automation 1 (?:contains an unsupported field|has too many fields)/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, trigger: { kind: "daily", intervalMinutes: 30 } }],
  })), /trigger kind must be interval/);
  for (const intervalMinutes of [14, 1_441, 30.5]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      automations: [{ ...valid, trigger: { kind: "interval", intervalMinutes } }],
    })), /between 15 and 1440 minutes/);
  }
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, trigger: { kind: "interval", intervalMinutes: 30, timeZone: "UTC" } }],
  })), /trigger (?:contains an unsupported field|has too many fields)/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, handler: "refresh_inbox" }],
  })), /handler must use lowercase letters, numbers, and hyphens/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, catchUp: "all" }],
  })), /catch-up policy must be none or latest/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{ ...valid, overlap: "queue" }],
  })), /overlap policy must be skip/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [valid, { ...valid, handler: "another-handler" }],
  })), /automation id is duplicated/);
  for (const title of ["Refresh\ninbox", "Refresh\u202einbox"]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      automations: [{ ...valid, title }],
    })), /plain single-line text/);
  }
});

test("automations require a worker and reference only declared permissions once", () => {
  const valid = manifest().automations[0] as Record<string, unknown>;
  assert.throws(() => parseRestrictedAppManifest(manifest({
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    tools: [],
  })), /automations must declare a sandboxed worker/);

  for (const [kind, permissionId] of [
    ["network", "missing-network"],
    ["files", "missing-file"],
    ["notifications", "missing-notification"],
  ] as const) {
    const automationPermissions = valid.permissions as Record<string, string[]>;
    assert.throws(() => parseRestrictedAppManifest(manifest({
      automations: [{
        ...valid,
        permissions: { ...automationPermissions, [kind]: [permissionId] },
      }],
    })), /references undeclared permission id/);
  }

  for (const [kind, permissionId] of [
    ["network", "inbox-api"],
    ["files", "exports"],
    ["notifications", "new-mail"],
  ] as const) {
    const automationPermissions = valid.permissions as Record<string, string[]>;
    assert.throws(() => parseRestrictedAppManifest(manifest({
      automations: [{
        ...valid,
        permissions: { ...automationPermissions, [kind]: [permissionId, permissionId] },
      }],
    })), /permission.*id is duplicated/);
  }
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [{
      ...valid,
      permissions: { network: ["inbox-api"], files: ["exports"], notifications: [], extra: [] },
    }],
  })), /permissions (?:contains an unsupported field|has too many fields)/);
});

test("notification declarations require a worker and an automation reference", () => {
  assert.throws(() => parseRestrictedAppManifest(manifest({
    runtime: { kind: "sandboxed-web", entry: "index.html" },
    tools: [],
    automations: [],
  })), /notifications must declare a sandboxed automation worker/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    automations: [],
  })), /notification permission new-mail must be referenced by an automation/);
  assert.doesNotThrow(() => parseRestrictedAppManifest(manifest()));
});

test("restricted app manifests reject undeclared powers and unsafe package paths", () => {
  assert.throws(() => parseRestrictedAppManifest(manifest({ arbitraryHostAccess: true })), /unsupported field/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    runtime: { kind: "node", entry: "app.js" },
  })), /sandboxed-web/);
  for (const entry of ["../index.html", "C:/index.html", "folder\\index.html", "CON/index.html", "app.ts"]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      runtime: { kind: "sandboxed-web", entry, worker: "worker.js" },
    })), /path|segment|file type/);
  }
});

test("restricted app network grants require exact HTTPS DNS origins and explicit methods", () => {
  for (const origin of [
    "http://mail.example.com",
    "https://*.example.com",
    "https://user:pass@mail.example.com",
    "https://127.0.0.1",
    "https://mail.example.com/messages",
  ]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      permissions: { network: [{ id: "mail", target: { kind: "public-https", origin }, methods: ["GET"], auth: [{ kind: "bearer" }] }] },
    })), /exact (?:HTTPS public DNS )?origin/);
  }
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "mail", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["CONNECT"], auth: [{ kind: "bearer" }] }] },
  })), /method is unsupported/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "mail", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "none" }, { kind: "bearer" }] }] },
  })), /cannot combine/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "local", target: { kind: "loopback-http", host: "localhost", port: 4317 }, methods: ["GET"], auth: [{ kind: "none" }] }] },
  })), /loopback host/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "local", target: { kind: "loopback-http", host: "127.0.0.1", port: 4317 }, methods: ["GET"], auth: [{ kind: "bearer" }] }] },
  })), /cannot receive saved credentials/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "mail", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "oauth2-pkce", issuer: "http://identity.example.com", clientId: "client", scopes: ["mail.read"] }] }] },
  })), /exact public HTTPS issuer URL/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [{ id: "mail", target: { kind: "public-https", origin: "https://mail.example.com" }, methods: ["GET"], auth: [{ kind: "oauth2-pkce", issuer: "https://identity.example.com", clientId: "client", scopes: ["openid"] }] }] },
  })), /scope is invalid or unsupported/);
});

test("restricted app file powers are explicit and bounded", () => {
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [], files: [{ id: "exports", target: "workspace", access: "read-write" }] },
  })), /target must be file or directory/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [], files: [{ id: "exports", target: "directory", access: "execute" }] },
  })), /access must be read or read-write/);
});

test("restricted app notifications require safe static single-line copy", () => {
  for (const title of ["New\nmail", "New\u202email"]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({
      permissions: { network: [], files: [], notifications: [{ id: "new-mail", title, description: "New messages are ready." }] },
    })), /plain single-line text/);
  }
  assert.throws(() => parseRestrictedAppManifest(manifest({
    permissions: { network: [], files: [], notifications: [{ id: "new-mail", title: "New mail", description: "Ready\u0007now" }] },
  })), /plain single-line text/);
  for (const title of ["Connected\ninbox", "Connected\u202einbox"]) {
    assert.throws(() => parseRestrictedAppManifest(manifest({ title })), /plain single-line text/);
  }
});

test("restricted app tool schemas reject executable or open-ended schema features", () => {
  const baseTool = (inputSchema: unknown) => ({
    name: "search",
    description: "Search.",
    action: "search",
    inputSchema,
    resultSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  });
  assert.throws(() => parseRestrictedAppManifest(manifest({
    tools: [baseTool({ type: "object", properties: {}, required: [], additionalProperties: true })],
  })), /additionalProperties to false/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    tools: [baseTool({ type: "string", pattern: ".*" })],
  })), /unsupported field/);
  assert.throws(() => parseRestrictedAppManifest(manifest({
    tools: [baseTool({ type: "object", properties: { query: { type: "string" } }, required: ["missing"], additionalProperties: false })],
  })), /not declared/);
});

function oauthManifest(auth: Record<string, unknown>) {
  const base = manifest();
  const network = structuredClone(base.permissions.network) as Array<Record<string, unknown>>;
  network[0] = { ...network[0], auth: [{ kind: "oauth2-pkce", issuer: "https://identity.example.com", clientId: "workspace-connected-inbox", scopes: ["mail.read"], ...auth }] };
  return { ...base, permissions: { ...base.permissions, network } };
}

test("OAuth discovery mode is optional and omitted when it is the default", () => {
  // Absent must stay absent: the parsed declaration feeds the digest that keys
  // an already-saved credential, so materializing a default here would strand
  // every existing connection behind a needless reconnect.
  const parsed = parseRestrictedAppManifest(oauthManifest({}));
  assert.deepEqual(parsed.permissions.network[0]?.auth[0], {
    kind: "oauth2-pkce",
    issuer: "https://identity.example.com",
    clientId: "workspace-connected-inbox",
    scopes: ["mail.read"],
  });
  const explicit = parseRestrictedAppManifest(oauthManifest({ discovery: "openid-configuration" }));
  assert.equal((explicit.permissions.network[0]?.auth[0] as { discovery?: string }).discovery, "openid-configuration");
  const empty = parseRestrictedAppManifest(oauthManifest({ authorizationParameters: [] }));
  assert.equal("authorizationParameters" in (empty.permissions.network[0]?.auth[0] ?? {}), false);
});

test("pinned OAuth discovery requires exact public HTTPS endpoints the issuer owns", () => {
  const parsed = parseRestrictedAppManifest(oauthManifest({
    discovery: "pinned",
    authorizationEndpoint: "https://identity.example.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://identity.example.com/oauth2/token",
  }));
  const auth = parsed.permissions.network[0]?.auth[0] as { authorizationEndpoint?: string; tokenEndpoint?: string };
  assert.equal(auth.authorizationEndpoint, "https://identity.example.com/o/oauth2/v2/auth");
  assert.equal(auth.tokenEndpoint, "https://identity.example.com/oauth2/token");

  const rejected: Array<[string, Record<string, unknown>]> = [
    // The attack this constraint exists to stop: a genuine issuer and a genuine
    // authorization endpoint, with the token exchange — which carries the
    // authorization code and the PKCE verifier — aimed somewhere else. No
    // Workspace surface renders these endpoints, so nobody would see it.
    ["token endpoint off the issuer host", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://collector.attacker.example/token" }],
    ["authorization endpoint off the issuer host", { discovery: "pinned", authorizationEndpoint: "https://attacker.example/a", tokenEndpoint: "https://identity.example.com/t" }],
    // A suffix match without the dot boundary would wrongly accept this.
    ["issuer host as a bare suffix", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://evil-identity.example.com/t" }],
    // Subdomains are refused: inferring authority from DNS structure grants
    // more the shorter the issuer host is, and shared-tenant platforms
    // (*.us.auth0.com, *.appspot.com) make co-tenants "owned".
    ["subdomain of the issuer host", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://tokens.identity.example.com/t" }],
    ["co-tenant on a shared platform issuer", { issuer: "https://us.auth0.com", discovery: "pinned", authorizationEndpoint: "https://us.auth0.com/authorize", tokenEndpoint: "https://attacker-tenant.us.auth0.com/oauth/token" }],
    ["unrelated registrable domain", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://identity.example.net/t" }],
    ["parent of the issuer host", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://example.com/t" }],
    ["missing token endpoint", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a" }],
    ["missing authorization endpoint", { discovery: "pinned", tokenEndpoint: "https://identity.example.com/t" }],
    ["plaintext", { discovery: "pinned", authorizationEndpoint: "http://identity.example.com/a", tokenEndpoint: "https://identity.example.com/t" }],
    ["ip literal", { discovery: "pinned", authorizationEndpoint: "https://127.0.0.1/a", tokenEndpoint: "https://identity.example.com/t" }],
    ["loopback name", { discovery: "pinned", authorizationEndpoint: "https://localhost/a", tokenEndpoint: "https://identity.example.com/t" }],
    ["query string", { discovery: "pinned", authorizationEndpoint: "https://identity.example.com/a?tenant=x", tokenEndpoint: "https://identity.example.com/t" }],
    ["embedded credentials", { discovery: "pinned", authorizationEndpoint: "https://user:pass@identity.example.com/a", tokenEndpoint: "https://identity.example.com/t" }],
    ["endpoints without pinned discovery", { authorizationEndpoint: "https://identity.example.com/a", tokenEndpoint: "https://identity.example.com/t" }],
    ["unknown discovery mode", { discovery: "device-code" }],
  ];
  for (const [name, auth] of rejected) {
    assert.throws(() => parseRestrictedAppManifest(oauthManifest(auth)), `expected rejection: ${name}`);
  }
});

test("reviewed OAuth authorization parameters exclude protocol-owned names", () => {
  const parsed = parseRestrictedAppManifest(oauthManifest({
    authorizationParameters: [{ name: "access_type", value: "offline" }, { name: "prompt", value: "consent" }],
  }));
  assert.deepEqual((parsed.permissions.network[0]?.auth[0] as { authorizationParameters?: unknown }).authorizationParameters, [
    { name: "access_type", value: "offline" },
    { name: "prompt", value: "consent" },
  ]);

  for (const name of [
    "response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge",
    "code_challenge_method", "client_secret", "code_verifier", "grant_type", "code", "refresh_token",
  ]) {
    assert.throws(
      () => parseRestrictedAppManifest(oauthManifest({ authorizationParameters: [{ name, value: "x" }] })),
      `expected ${name} to be rejected`,
    );
  }
  const malformed: unknown[] = [
    [{ name: "Access_Type", value: "x" }],
    [{ name: "access-type", value: "x" }],
    [{ name: "_leading", value: "x" }],
    [{ name: "access_type", value: "line\nbreak" }],
    [{ name: "access_type", value: "café" }],
    [{ name: "access_type", value: "a", extra: "b" }],
    [{ name: "access_type" }],
    [{ name: "a", value: "1" }, { name: "a", value: "2" }],
    Array.from({ length: 9 }, (_, index) => ({ name: `p${index}`, value: "x" })),
    "access_type=offline",
  ];
  for (const authorizationParameters of malformed) {
    assert.throws(() => parseRestrictedAppManifest(oauthManifest({ authorizationParameters })));
  }
});

test("non-OAuth auth kinds cannot carry OAuth endpoint or parameter fields", () => {
  for (const extra of [
    { discovery: "pinned" },
    { authorizationEndpoint: "https://identity.example.com/a" },
    { tokenEndpoint: "https://identity.example.com/t" },
    { authorizationParameters: [{ name: "access_type", value: "offline" }] },
  ]) {
    const base = manifest();
    const network = structuredClone(base.permissions.network) as Array<Record<string, unknown>>;
    network[0] = { ...network[0], auth: [{ kind: "bearer", ...extra }] };
    assert.throws(() => parseRestrictedAppManifest({ ...base, permissions: { ...base.permissions, network } }));
  }
});

test("no auth kind may silently carry OAuth fields it does not use", () => {
  // api-key returns early, so without an explicit check these were accepted and
  // dropped — a manifest could appear to pin endpoints that nothing honored.
  for (const kind of ["api-key", "bearer", "basic", "none"]) {
    for (const extra of [
      { discovery: "pinned" },
      { authorizationEndpoint: "https://identity.example.com/a" },
      { tokenEndpoint: "https://identity.example.com/t" },
      { authorizationParameters: [{ name: "access_type", value: "offline" }] },
      { issuer: "https://identity.example.com" },
      { clientId: "x" },
      { scopes: ["a"] },
    ]) {
      const base = manifest();
      const network = structuredClone(base.permissions.network) as Array<Record<string, unknown>>;
      const auth: Record<string, unknown> = { kind, ...extra };
      if (kind === "api-key") auth.header = "x-api-key";
      network[0] = { ...network[0], auth: [auth] };
      assert.throws(
        () => parseRestrictedAppManifest({ ...base, permissions: { ...base.permissions, network } }),
        `expected ${kind} + ${Object.keys(extra)[0]} to be rejected`,
      );
    }
  }
});

test("request objects and response mode cannot be reintroduced as reviewed parameters", () => {
  // RFC 9101 `request` / OIDC `request_uri` replace the parameters of the
  // request they appear in, so either would defeat the rest of the denylist.
  for (const name of ["request", "request_uri", "response_mode"]) {
    assert.throws(
      () => parseRestrictedAppManifest(oauthManifest({ authorizationParameters: [{ name, value: "x" }] })),
      `expected ${name} to be rejected`,
    );
  }
});
