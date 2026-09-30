import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, normalizeAzureOpenAIConnection, parseAzureDeploymentNames } from "../src/shared/azure-openai.js";
import { getAzureOpenAIConnection, saveAzureOpenAIConnection } from "../src/local/agent/azure-openai-connection.js";
import { resolvePiRuntime, listPiModels, getPiSetupStatus, type PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";

test("Azure accepts deployment names and normalizes portal Responses URLs", () => {
  const valid = { baseUrl: "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview", deployments: ["team", "fast"] };
  assert.deepEqual(normalizeAzureOpenAIConnection(valid), {
    baseUrl: "https://example.cognitiveservices.azure.com/openai/v1", deployments: ["team", "fast"],
  });
  assert.deepEqual(parseAzureDeploymentNames(" team, fast\nthird\r\nteam, "), ["team", "fast", "third"]);
  for (const baseUrl of ["", "not a URL", "http://example.com", "https://user:secret@example.com", "https://example.com?api-key=secret", "https://example.com/openai/deployments/team/responses"]) {
    assert.throws(() => normalizeAzureOpenAIConnection({ ...valid, baseUrl }));
  }
  for (const deployments of [[], [""], ["team=fast"], ["team/fast"], ["two names"], ["x".repeat(257)], Array(101).fill("team"), "team,fast"]) {
    assert.throws(() => normalizeAzureOpenAIConnection({ ...valid, deployments }));
  }
});

test("Azure settings persist through the API, preserve the key, and reach Pi's actual request transport", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-azure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const authPath = join(agentDir, "auth.json");
  const authStorage = AuthStorage.create(authPath);
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const settingsManager = SettingsManager.inMemory();
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, authStorage, modelRegistry, settingsManager }; } };
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), spaceBase: join(root, "content"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  const configure = (azure: unknown, apiKey?: string, providerId = AZURE_OPENAI_PROVIDER) => fetch(`${api.origin}/api/agent/configure`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "management", provider: providerId, model: "team", azure, ...(apiKey ? { apiKey } : {}) }),
  });
  const azure = { baseUrl: "https://example.openai.azure.com", deployments: ["team", "fast", "gpt"] };
  const saved = await configure(azure, "synthetic-azure-secret");
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.doesNotMatch(await saved.text(), /synthetic-azure-secret/);
  // Reopen the persisted store, as on relaunch.
  const reopened = AuthStorage.create(authPath);
  const credential = reopened.get(AZURE_OPENAI_PROVIDER);
  assert.equal(credential?.type, "api_key");
  assert.equal(credential?.type === "api_key" && credential.env?.AZURE_OPENAI_BASE_URL, "https://example.openai.azure.com/openai/v1");
  assert.ok(credential?.type === "api_key");
  assert.deepEqual(JSON.parse(credential.env![AZURE_OPENAI_DEPLOYMENTS_ENV]!), azure.deployments);
  const freshRegistry = ModelRegistry.create(reopened, join(agentDir, "models.json"));
  const freshProvider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, authStorage: reopened, modelRegistry: freshRegistry, settingsManager }; } };
  const runtime = await resolvePiRuntime(root, freshProvider, { requestProjectTrust: false });
  for (const name of azure.deployments) assert.equal(runtime.modelRegistry.find(AZURE_OPENAI_PROVIDER, name)?.id, name);
  assert.deepEqual((await listPiModels(root, freshProvider)).filter((model) => model.provider === AZURE_OPENAI_PROVIDER).map((model) => model.id).sort(), [...azure.deployments].sort());
  const restored = await getPiSetupStatus(root, freshProvider);
  assert.equal(restored.model, "team");
  assert.equal(restored.configured, true);
  assert.ok(freshRegistry.find("openai", "gpt-4.1"), "other providers retain their catalogs");
  const client = new PiConversationClient("azure-deployment-test", root, freshProvider);
  try {
    assert.deepEqual((await client.getState()).model, { provider: AZURE_OPENAI_PROVIDER, id: "team", name: "team" });
  } finally { await client.stop(); }
  authStorage.set(AZURE_OPENAI_PROVIDER, { ...credential, env: { ...credential.env, UNRELATED_SECRET: "private-environment-value" } });
  const loaded = await fetch(`${api.origin}/api/agent/models?scope=management`);
  const loadedText = await loaded.text();
  assert.doesNotMatch(loadedText, /synthetic-azure-secret|private-environment-value|UNRELATED_SECRET/);
  assert.deepEqual(JSON.parse(loadedText).azure, normalizeAzureOpenAIConnection(azure));

  const changed = { ...azure, baseUrl: "https://other.services.ai.azure.com/openai/v1/responses" };
  const updated = await configure(changed);
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal(await authStorage.getApiKey(AZURE_OPENAI_PROVIDER), "synthetic-azure-secret");
  assert.equal(authStorage.getProviderEnv(AZURE_OPENAI_PROVIDER)?.UNRELATED_SECRET, "private-environment-value");
  const beforeInvalid = authStorage.get(AZURE_OPENAI_PROVIDER);
  assert.equal((await configure({ ...azure, deployments: ["broken=value"] }, "replacement-secret")).status, 400);
  assert.deepEqual(authStorage.get(AZURE_OPENAI_PROVIDER), beforeInvalid);
  assert.equal((await configure({ ...azure, deployments: ["unselected"] }, "replacement-secret")).status, 400);
  assert.deepEqual(authStorage.get(AZURE_OPENAI_PROVIDER), beforeInvalid);
  assert.equal((await configure(azure, "replacement-secret", "openai")).status, 400);

  // Exercise the installed Azure adapter without making any network or paid model call.
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; key: string | null; model: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), key: new Headers(init?.headers).get("api-key"), model: JSON.parse(String(init?.body)).model });
    return new Response(JSON.stringify({ error: { message: "Synthetic transport response" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    for (const id of azure.deployments) {
      const model = modelRegistry.find(AZURE_OPENAI_PROVIDER, id)!;
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      assert.equal(auth.ok, true);
      if (!auth.ok) throw new Error(auth.error);
      const result = await stream(model, { messages: [{ role: "user", content: "Synthetic request", timestamp: 0 }] }, { ...auth, maxRetries: 0 }).result();
      assert.equal(result.stopReason, "error");
    }
    assert.deepEqual(requests.map((request) => request.model), ["team", "fast", "gpt"]);
    assert.ok(requests.every((request) => request.url === "https://other.services.ai.azure.com/openai/v1/responses?api-version=v1"));
    assert.ok(requests.every((request) => request.key === "synthetic-azure-secret"));
  } finally { globalThis.fetch = originalFetch; }

  const previousMapping = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "team=wrong-deployment";
  try {
    await saveAzureOpenAIConnection(root, { ...azure, deployments: ["team", "new-deployment"] }, undefined, provider);
    assert.deepEqual((await getAzureOpenAIConnection(root, provider)).deployments, ["team", "new-deployment"]);
    assert.equal(modelRegistry.find(AZURE_OPENAI_PROVIDER, "fast"), undefined);
    assert.equal(authStorage.getProviderEnv(AZURE_OPENAI_PROVIDER)?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP, "team=team,new-deployment=new-deployment");
  } finally {
    if (previousMapping === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    else process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousMapping;
  }
  const removed = await fetch(`${api.origin}/api/agent/auth`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "management", provider: AZURE_OPENAI_PROVIDER }),
  });
  assert.equal(removed.status, 200);
  assert.equal(authStorage.get(AZURE_OPENAI_PROVIDER), undefined);
  assert.equal(modelRegistry.find(AZURE_OPENAI_PROVIDER, "team"), undefined);
  assert.ok(modelRegistry.find(AZURE_OPENAI_PROVIDER, "gpt-4.1"), "removing app settings restores native catalog");
});
