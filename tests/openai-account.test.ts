import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FileCredentialStore, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { readOpenAiAccount } from "../src/local/agent/openai-account.js";
import { startLocalApi } from "../src/local/server.js";

const userInfo = "https://auth.openai.com/api/accounts/oauth/userinfo";
const jwt = (claims: object) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
const credential = (extra: Partial<OAuthCredential> = {}): OAuthCredential => ({ type: "oauth", access: jwt({ sub: "person" }),
  refresh: "synthetic-refresh", expires: Date.now() + 3_600_000, clientId: "issued-client", ...extra });

async function runtime(t: TestContext, provider = "openai", saved = credential()) {
  const credentials = FileCredentialStore.inMemory({ [provider]: saved });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  return { credentials, modelRuntime };
}

test("the direct grant's live subject-only UserInfo shape uses the identity retained at sign-in", async t => {
  const host = await runtime(t, "openai", credential({ identity: { issuer: "https://auth.openai.com", subject: "person", clientId: "issued-client", email: "person@example.test", emailVerified: true } }));
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), userInfo);
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential().access}`);
    return Response.json({ sub: "person" });
  };
  const account = await readOpenAiAccount(host, "openai");
  assert.equal(calls, 1);
  assert.equal(account.email, "person@example.test");
  assert.equal(account.workspaceName, null);
  assert.equal(account.workspaceId, null);
  assert.equal(account.plan, null);
  assert.equal(account.source, "saved_sign_in");
  assert.equal(account.identityNeedsReconnect, false);
  assert.equal(account.limitsAvailability, "unsupported");
  assert.ok(account.checkedAt);
  assert.doesNotMatch(JSON.stringify(account), /synthetic|must-not-escape|unrelated-data|issued-client/);
  assert.equal((await host.credentials.read("openai"))?.refresh, "synthetic-refresh");
});

test("email, user id, client id and API organizations never stand in for the connected workspace", async t => {
  const host = await runtime(t);
  globalThis.fetch = async () => Response.json({ sub: "person", email: "person@example.test", organization: { id: "api-org", name: "Not a ChatGPT workspace" },
    organizations: [{ id: "first-org", name: "Unselected" }], client_id: "issued-client" });
  const account = await readOpenAiAccount(host, "openai");
  assert.equal(account.email, "person@example.test");
  assert.equal(account.workspaceId, null);
  assert.equal(account.workspaceName, null);
  assert.equal(account.plan, null);
});

test("legacy sign-ins label saved metadata and match the selected workspace instead of the first organization", async t => {
  const saved = credential({ accountId: "selected", access: jwt({ sub: "person", "https://api.openai.com/profile": { email: "legacy@example.test" },
    "https://api.openai.com/auth": { chatgpt_plan_type: "business", organizations: [{ id: "other", title: "Wrong" }, { id: "selected", title: "Selected workspace" }] } }) });
  const host = await runtime(t, "openai-codex", saved);
  globalThis.fetch = async () => new Response("private-upstream-body synthetic-refresh", { status: 403 });
  const account = await readOpenAiAccount(host, "openai-codex");
  assert.equal(account.email, "legacy@example.test");
  assert.equal(account.workspaceName, "Selected workspace");
  assert.equal(account.source, "saved_sign_in");
  assert.equal(account.checkedAt, null);
  assert.match(account.error!, /could not be refreshed/);
  assert.doesNotMatch(JSON.stringify(account), /private-upstream-body|synthetic-refresh|Wrong/);
});

test("Codex reads select the connected workspace and refuse another workspace's usage", async t => {
  const saved = credential({ accountId: "selected", access: jwt({ sub: "person", "https://api.openai.com/auth": {
    chatgpt_plan_type: "business", organizations: [{ id: "selected", title: "Selected workspace" }],
  } }) });
  const host = await runtime(t, "openai-codex", saved);
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "selected");
    return String(url).endsWith("/accounts/check") ? Response.json({ accounts: [
      { id: "default", name: "Wrong workspace", plan_type: "free" }, { id: "selected", name: "Selected workspace", plan_type: "business" },
    ] }) : Response.json({ account_id: "default", plan_type: "free", rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18000, reset_at: 1794449000 } } });
  };
  const account = await readOpenAiAccount(host, "openai-codex");
  assert.equal(account.email, null);
  assert.equal(account.workspaceId, "selected");
  assert.equal(account.workspaceName, "Selected workspace");
  assert.equal(account.plan, "business");
  assert.deepEqual(account.limits, []);
  assert.equal(account.limitsAvailability, "unavailable");
});

for (const change of ["disconnect", "reconnect", "token rotation"] as const) {
  test(`a ${change} during a profile read prevents the old account from returning`, async t => {
    const host = await runtime(t);
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      return Response.json({ sub: "person", email: "old@example.test" });
    };
    const pending = readOpenAiAccount(host, "openai");
    await ready;
    if (change === "disconnect") await host.credentials.delete("openai");
    else if (change === "reconnect") await host.credentials.modify("openai", async () => credential({ clientId: "new-client", access: jwt({ sub: "new-person" }) }));
    else await host.credentials.modify("openai", async () => credential({ access: jwt({ sub: "person", jti: "rotated" }), refresh: "rotated-refresh" }));
    finish();
    const account = await pending;
    assert.equal(account.connected, change !== "disconnect");
    if (change !== "disconnect") assert.match(account.error!, /connection changed.*Refresh Account Details/);
    assert.equal(account.email, null);
    assert.equal(account.workspaceId, null);
  });
}

for (const failure of ["oversized", "malformed", "wrong-subject", "redirect"] as const) {
  test(`a ${failure} profile cannot expose raw response data or change credentials`, async t => {
    const host = await runtime(t);
    let cancelled = false;
    globalThis.fetch = async () => {
      if (failure === "redirect") throw new Error("synthetic-refresh private-upstream-body");
      if (failure === "wrong-subject") return Response.json({ sub: "other-person", email: "wrong@example.test" });
      if (failure === "malformed") return new Response("private-upstream-body");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }));
    };
    const account = await readOpenAiAccount(host, "openai");
    assert.equal(account.email, null);
    assert.equal(account.connected, true);
    assert.ok(account.error);
    assert.doesNotMatch(JSON.stringify(account), /synthetic-refresh|private-upstream-body|wrong@example/);
    if (failure === "oversized") assert.equal(cancelled, true);
    assert.equal((await host.credentials.read("openai"))?.type, "oauth");
  });
}

test("native refresh rotates the token once and profile reads use the resulting credential", async t => {
  const host = await runtime(t, "openai", credential({ expires: 0, idToken: "synthetic-private-id-token", identity: {
    issuer: "https://auth.openai.com", subject: "person", clientId: "issued-client", email: "refreshed@example.test", emailVerified: true,
  } }));
  let refreshes = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
      refreshes++;
      assert.equal(new URLSearchParams(String(init?.body)).get("client_id"), "issued-client");
      return Response.json({ access_token: jwt({ sub: "person", jti: "new" }), refresh_token: "replacement-refresh", expires_in: 3600,
        scope: "openid email offline_access chatgpt.tokens.use.direct" });
    }
    assert.equal(String(input), userInfo);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${jwt({ sub: "person", jti: "new" })}`);
    return Response.json({ sub: "person" });
  };
  const accounts = await Promise.all([readOpenAiAccount(host, "openai"), readOpenAiAccount(host, "openai")]);
  assert.equal(refreshes, 1);
  assert.ok(accounts.every(account => account.email === "refreshed@example.test"));
  assert.equal((await host.credentials.read("openai"))?.refresh, "replacement-refresh");
  assert.equal((await host.credentials.read("openai"))?.idToken, "synthetic-private-id-token");
  assert.doesNotMatch(JSON.stringify(accounts), /synthetic-private-id-token/);
});

test("old direct connections request a reconnect instead of claiming OpenAI did not provide an email", async t => {
  const host = await runtime(t);
  globalThis.fetch = async () => Response.json({ sub: "person" });
  const account = await readOpenAiAccount(host, "openai");
  assert.equal(account.identityNeedsReconnect, true);
  assert.equal(account.email, null);
  assert.equal(account.error, null);
});

for (const identity of [
  { issuer: "https://unrelated.test", subject: "person", clientId: "issued-client" },
  { issuer: "https://auth.openai.com", subject: "other-person", clientId: "issued-client" },
  { issuer: "https://auth.openai.com", subject: "person", clientId: "different-client" },
]) test(`cached identity must match the credential: ${JSON.stringify(identity)}`, async t => {
  const host = await runtime(t, "openai", credential({ identity: { ...identity, email: "wrong@example.test" } }));
  globalThis.fetch = async () => Response.json({ sub: "person" });
  const account = await readOpenAiAccount(host, "openai");
  assert.equal(account.email, null);
  assert.equal(account.identityNeedsReconnect, true);
});

for (const map of [false, true]) test(`Codex workspace and real quota fields are projected from the ${map ? "map" : "list"} account shape`, async t => {
  const saved = credential({ accountId: "selected", access: jwt({ sub: "person", "https://api.openai.com/profile": { email: "person@example.test" }, "https://api.openai.com/auth": { chatgpt_plan_type: "team" } }) });
  const host = await runtime(t, "openai-codex", saved);
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "selected");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${saved.access}`);
    if (String(url).endsWith("/accounts/check")) return Response.json({ accounts: map
      ? { selected: { account: { account_id: "selected", name: "Synthetic workspace", plan_type: "team" } }, other: { account: { account_id: "other", name: "Wrong" } } }
      : [{ id: "other", name: "Wrong" }, { id: "selected", name: "Synthetic workspace", plan_type: "team" }] });
    assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage");
    return Response.json({ account_id: "selected", plan_type: "team", rate_limit: {
      primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1794449000 }, secondary_window: null,
    }, rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 }, access_token: "must-not-escape", additional_rate_limits: [
      { metered_feature: "other-bucket", limit_name: "Other bucket", rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1794440000 } } },
    ] });
  };
  const account = await readOpenAiAccount(host, "openai-codex");
  assert.equal(account.email, "person@example.test");
  assert.equal(account.workspaceName, "Synthetic workspace");
  assert.equal(account.plan, "team");
  assert.equal(account.limitsAvailability, "available");
  assert.deepEqual(account.limits?.[0], { id: "codex", name: "Codex", primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1794449000 }, secondary: null });
  assert.equal(account.limits?.[1]?.primary?.usedPercent, 42);
  assert.equal(account.availableResets, 3);
  assert.equal(account.applicableResets, 0);
  assert.equal(account.error, null);
  assert.doesNotMatch(JSON.stringify(account), /must-not-escape|synthetic-signature|Wrong/);
});

test("a Codex disconnect while both metadata reads are pending returns no account or quota", async t => {
  const host = await runtime(t, "openai-codex", credential({ accountId: "selected" }));
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async () => { if (++calls === 2) started(); await pending; return Response.json({ accounts: [{ id: "selected", name: "Old" }], account_id: "selected", rate_limit: { primary_window: { used_percent: 88 } } }); };
  const read = readOpenAiAccount(host, "openai-codex");
  await ready;
  await host.credentials.delete("openai-codex");
  finish();
  const result = await read;
  assert.equal(result.connected, false);
  assert.equal(result.workspaceName, null);
  assert.deepEqual(result.limits, []);
});

test("API-key connections do not send account-profile requests", async t => {
  const host = await runtime(t);
  await host.credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
  globalThis.fetch = async () => { throw new Error("Must not look up an account for an API key"); };
  assert.equal((await readOpenAiAccount(host, "openai")).connected, false);
});

test("account details are available through Settings only and stay out of model/status projections", async t => {
  const host = await runtime(t);
  const root = await mkdtemp(join(tmpdir(), "work-fold-account-api-"));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input) === userInfo
    ? Response.json({ sub: "person", email: "settings-only@example.test" }) : previousFetch(input, init);
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), workFolderBase: join(root, "content"), loadEnv: false,
    piRuntimeProvider: { resolveRuntime: async () => ({ agentDir: join(root, "pi"), ...host }) } });
  t.after(async () => { await api.close(); await rm(root, { recursive: true, force: true }); });
  const response = await fetch(`${api.origin}/api/agent/provider-account?scope=agent&provider=openai`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).account.email, "settings-only@example.test");
  const models = await (await fetch(`${api.origin}/api/agent/models?scope=agent`)).json();
  assert.doesNotMatch(JSON.stringify(models), /settings-only@example|synthetic-refresh|synthetic-signature/);
  assert.equal((await fetch(`${api.origin}/api/agent/provider-account?scope=agent&provider=other`)).status, 400);
});
