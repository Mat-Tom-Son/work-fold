import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { FileCredentialStore, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PackagedPiRuntimeProvider } from "../desktop/src/pi-runtime.js";
import { getPiSetupStatus, loginPiProvider, savePiApiKey, type PiOAuthHooks } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";

const hooks: PiOAuthHooks = {
  openUrl() {}, showDeviceCode() {}, prompt: async () => "synthetic", select: async () => undefined,
};

test("native ChatGPT login receives a stable installation UUID, persists the full grant, and ignores project identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-chatgpt-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "pi"), first = join(root, "first"), second = join(root, "second");
  await mkdir(join(first, ".pi"), { recursive: true });
  await mkdir(second);
  await writeFile(join(first, ".pi", "settings.json"), JSON.stringify({ deviceId: "project-must-not-identify-installation" }));
  let saved = {};
  const host = { load: async () => saved, save: async (data: typeof saved) => { saved = structuredClone(data); } };
  const provider = new PackagedPiRuntimeProvider({ agentDir, authStorageHost: host, projectTrust: { override: true } });
  assert.equal((await readFile(join(agentDir, "settings.json"), "utf8").catch(() => "")), "");
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const exchanges: URLSearchParams[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), "https://auth.openai.com/api/accounts/oauth/token");
    exchanges.push(new URLSearchParams(String(init?.body)));
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
      id_token: "synthetic-id", scope: "openid chatgpt.tokens.use.direct" });
  }) as typeof fetch;
  const ids: string[] = [];
  for (const folder of [first, second]) {
    let authorize!: URL;
    await provider.loginOAuth(folder, "openai", {
      ...hooks,
      openUrl({ url }) {
        authorize = new URL(url);
        assert.equal(authorize.searchParams.get("agent_name_hint"), "work-fold");
        ids.push(authorize.searchParams.get("ext_agent_host_id")!);
      },
      async manualCodeInput(_signal, prompt) {
        assert.match(prompt!.placeholder!, /127\.0\.0\.1:1455\/auth\/callback/);
        return `http://127.0.0.1:1455/auth/callback?code=synthetic-code&state=${authorize.searchParams.get("state")}&client_id=issued-client`;
      },
    });
  }
  assert.match(ids[0]!, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(ids[1], ids[0]);
  assert.equal(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")).deviceId, ids[0]!.slice(9));
  const reopened = new PackagedPiRuntimeProvider({ agentDir, authStorageHost: host });
  const credential = await (await reopened.resolveRuntime(second)).credentials!.read("openai");
  assert.equal(credential?.type, "oauth");
  assert.equal(credential?.type === "oauth" && credential.clientId, "issued-client");
  assert.deepEqual(credential?.type === "oauth" && credential.scopes, ["openid", "chatgpt.tokens.use.direct"]);
  assert.equal(exchanges.length, 2);
  assert.ok(exchanges.every(body => body.get("client_id") === "issued-client"));
  assert.ok(!(await getPiSetupStatus(second, reopened)).providers.some(item => JSON.stringify(item).includes("synthetic-access")));
});

test("native API-key setup keeps Cloudflare configuration and key replacement preserves that configuration", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-cloudflare-login-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, authPath: join(root, "auth.json") });
  const provider = { resolveRuntime: async () => ({ agentDir: root, credentials, modelRuntime: runtime }) };
  const answers = ["synthetic-key", "account-id", "gateway-id"];
  const secrets: boolean[] = [];
  await loginPiProvider(root, "cloudflare-ai-gateway", "api_key", {
    ...hooks, prompt: async input => { secrets.push(Boolean(input.secret)); return answers.shift()!; },
  }, provider);
  assert.deepEqual(secrets, [true, false, false]);
  assert.deepEqual(await credentials.read("cloudflare-ai-gateway"), { type: "api_key", key: "synthetic-key",
    env: { CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_GATEWAY_ID: "gateway-id" } });
  await savePiApiKey(root, "cloudflare-ai-gateway", "replacement", { runtimeProvider: provider });
  const auth = await runtime.getAuth("cloudflare-ai-gateway");
  assert.equal(auth?.auth.headers?.["cf-aig-authorization"], "Bearer replacement");
  assert.equal(auth?.env?.CLOUDFLARE_GATEWAY_ID, "gateway-id");
  await assert.rejects(savePiApiKey(root, "unknown-provider", "key", { runtimeProvider: provider }), /does not offer/);
});

test("provider setup API connects a provider with no chat models without changing the Worker default", async t => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-provider-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory({ chat: { type: "api_key", key: "synthetic" } });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, authPath: join(root, "auth.json") });
  const chat = fauxProvider({ provider: "chat", models: [{ id: "chat-model" }] });
  runtime.registerNativeProvider(chat.provider);
  runtime.registerNativeProvider({ ...chat.provider, id: "zero-models", name: "No chat catalog", getModels: () => [], getAllModels: () => [],
    auth: { apiKey: { name: "Provider credentials", login: async () => ({ type: "api_key", key: "synthetic", env: { ACCOUNT: "synthetic-account" } }),
      resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined } },
  });
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false,
    piRuntimeProvider: { resolveRuntime: async () => ({ agentDir: root, credentials, modelRuntime: runtime,
      preferredModel: { provider: "chat", id: "chat-model" } }) }, piOAuthHooks: hooks });
  t.after(() => api.close());
  const request = async (path: string, body?: object) => {
    const response = await fetch(`${api.origin}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const initial = await request("/api/agent/models?scope=management");
  assert.equal(initial.providers.find((item: { id: string }) => item.id === "zero-models").modelCount, 0);
  for (const [path, body] of [["/api/agent/configure", { apiKey: "entered-key" }], ["/api/agent/login", { method: "api_key" }]] as const) {
    const result = await request(path, { scope: "management", provider: "zero-models", ...body });
    assert.equal(result.status.model, "chat-model");
    assert.equal(result.providers.find((item: { id: string }) => item.id === "zero-models").authType, "api_key");
    assert.ok(!JSON.stringify(result).includes("entered-key"));
    assert.ok(!JSON.stringify(result).includes("synthetic-account"));
  }
  assert.deepEqual((await credentials.read("zero-models"))?.type === "api_key" && (await credentials.read("zero-models"))?.env, { ACCOUNT: "synthetic-account" });
});
