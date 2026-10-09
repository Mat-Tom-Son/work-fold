import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
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
  const authStorage = FileCredentialStore.create(authPath);
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(agentDir, "models.json") });
  const settingsManager = SettingsManager.inMemory();
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, credentials: authStorage, modelRuntime, settingsManager }; } };
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
  const reopened = FileCredentialStore.create(authPath);
  const credential = await reopened.read(AZURE_OPENAI_PROVIDER);
  assert.equal(credential?.type, "api_key");
  assert.equal(credential?.type === "api_key" && credential.env?.AZURE_OPENAI_BASE_URL, "https://example.openai.azure.com/openai/v1");
  assert.ok(credential?.type === "api_key");
  assert.deepEqual(JSON.parse(credential.env![AZURE_OPENAI_DEPLOYMENTS_ENV]!), azure.deployments);
  const freshRegistry = await ModelRuntime.create({ credentials: reopened, modelsPath: join(agentDir, "models.json") });
  const freshProvider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, credentials: reopened, modelRuntime: freshRegistry, settingsManager }; } };
  const runtime = await resolvePiRuntime(root, freshProvider, { requestProjectTrust: false });
  for (const name of azure.deployments) assert.equal(runtime.modelRuntime.getModel(AZURE_OPENAI_PROVIDER, name)?.id, name);
  assert.deepEqual((await listPiModels(root, freshProvider)).filter((model) => model.provider === AZURE_OPENAI_PROVIDER).map((model) => model.id).sort(), [...azure.deployments].sort());
  const restored = await getPiSetupStatus(root, freshProvider);
  assert.equal(restored.model, "team");
  assert.equal(restored.configured, true);
  assert.ok(freshRegistry.getModel("openai", "gpt-4.1"), "other providers retain their catalogs");
  const client = new PiConversationClient("azure-deployment-test", root, freshProvider);
  try {
    assert.deepEqual((await client.getState()).model, { provider: AZURE_OPENAI_PROVIDER, id: "team", name: "team" });
  } finally { await client.stop(); }
  await authStorage.modify(AZURE_OPENAI_PROVIDER, async () => ({ ...credential, env: { ...credential.env, UNRELATED_SECRET: "private-environment-value" } }));
  const loaded = await fetch(`${api.origin}/api/agent/models?scope=management`);
  const loadedText = await loaded.text();
  assert.doesNotMatch(loadedText, /synthetic-azure-secret|private-environment-value|UNRELATED_SECRET/);
  assert.deepEqual(JSON.parse(loadedText).azure, normalizeAzureOpenAIConnection(azure));

  const changed = { ...azure, baseUrl: "https://other.services.ai.azure.com/openai/v1/responses" };
  const updated = await configure(changed);
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await modelRuntime.getAuth(AZURE_OPENAI_PROVIDER))?.auth.apiKey, "synthetic-azure-secret");
  assert.equal(((await authStorage.read(AZURE_OPENAI_PROVIDER)) as any)?.env?.UNRELATED_SECRET, "private-environment-value");
  const beforeInvalid = await authStorage.read(AZURE_OPENAI_PROVIDER);
  assert.equal((await configure({ ...azure, deployments: ["broken=value"] }, "replacement-secret")).status, 400);
  assert.deepEqual(await authStorage.read(AZURE_OPENAI_PROVIDER), beforeInvalid);
  assert.equal((await configure({ ...azure, deployments: ["unselected"] }, "replacement-secret")).status, 400);
  assert.deepEqual(await authStorage.read(AZURE_OPENAI_PROVIDER), beforeInvalid);
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
      const model = modelRuntime.getModel(AZURE_OPENAI_PROVIDER, id)!;
      const auth = await modelRuntime.getAuth(model);
      assert.ok(auth);
      const result = await modelRuntime.stream(model, { messages: [{ role: "user", content: "Synthetic request", timestamp: 0 }] }, { maxRetries: 0 }).result();
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
    assert.equal(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "fast"), undefined);
    assert.equal((await authStorage.read(AZURE_OPENAI_PROVIDER) as { env?: Record<string, string> })?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP, "team=team,new-deployment=new-deployment");
  } finally {
    if (previousMapping === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    else process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousMapping;
  }
  const removed = await fetch(`${api.origin}/api/agent/auth`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "management", provider: AZURE_OPENAI_PROVIDER }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await authStorage.read(AZURE_OPENAI_PROVIDER), undefined);
  assert.equal(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "team"), undefined);
  assert.ok(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "gpt-4.1"), "removing app settings restores native catalog");
});

test("Chat titles use the active Azure deployment and its stored connection without unsupported minimal reasoning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-azure-title-"));
  const agentDir = join(root, "agent");
  const spaceRoot = join(root, "space");
  await mkdir(spaceRoot, { recursive: true });
  const authStorage = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  const provider: PiRuntimeProvider = { async resolveRuntime() {
    return { agentDir, credentials: authStorage, modelRuntime,
      preferredModel: { provider: AZURE_OPENAI_PROVIDER, id: "gpt-4.1" },
      settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "medium", retry: { enabled: false } }),
    };
  } };
  await saveAzureOpenAIConnection(spaceRoot, {
    baseUrl: "https://title-fixture.openai.azure.com", deployments: ["gpt-4.1", "gpt-5.2", "gpt-5.5-pro", "gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "team-review"],
  }, "synthetic-title-key", provider);
  const client = new PiConversationClient("azure-title-chat", spaceRoot, provider);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; key: string | null; body: any }> = [];
  let incompleteTitle = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(input), key: new Headers(init?.headers).get("api-key"), body });
    // GPT-5.2/5.4 accept low, but not minimal. Pi's catalog currently exposes
    // minimal even for these models and for custom deployments derived from it.
    if (body.reasoning?.effort === "minimal") return new Response(JSON.stringify({ error: {
      message: "Unsupported value: 'minimal'. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.",
    } }), { status: 400, headers: { "content-type": "application/json" } });
    const isTitle = JSON.stringify(body.input).includes("Write a specific 3 to 7 word title");
    const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: isTitle ? "Review the launch checklist" : "The checklist is ready.", annotations: [] }],
    };
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      incompleteTitle && isTitle
        ? { type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [item] } }
        : { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item] } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    assert.equal((await client.getState()).model?.id, "gpt-4.1");
    for (const id of ["gpt-5.2", "gpt-5.5-pro", "gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "team-review", "gpt-4.1"]) {
      await client.setModel(AZURE_OPENAI_PROVIDER, id);
      assert.equal(await client.prompt("Review my launch checklist."), "The checklist is ready.");
      const sessionFile = (await client.getState()).sessionFile!;
      const beforeTitle = await readFile(sessionFile, "utf8");
      assert.equal(await client.generateConversationTitle("Review my launch checklist.", "The checklist is ready."), "Review the launch checklist");
      assert.equal(await readFile(sessionFile, "utf8"), beforeTitle, "naming must not append a turn to the Pi session");
      const turn = requests.at(-2)!;
      const title = requests.at(-1)!;
      assert.equal(turn.body.model, id);
      assert.equal(title.body.model, id, "the current Chat model wins over the saved default");
      assert.equal(title.url, "https://title-fixture.openai.azure.com/openai/v1/responses?api-version=v1");
      assert.equal(title.url, turn.url);
      assert.equal(title.key, "synthetic-title-key");
      assert.equal(title.key, turn.key);
      assert.equal(title.body.tools, undefined);
      assert.equal(title.body.max_output_tokens, 2048);
      assert.equal(title.body.reasoning?.effort, id === "gpt-4.1" ? undefined : id === "gpt-5.5-pro" ? "medium" : "low");
      assert.equal(title.body.input.length, 2, "only the naming prompt and first exchange enter the request");
    }
    assert.equal(requests.length, 14, "one isolated title request per call, without retries or provider fallback");
    incompleteTitle = true;
    await client.setModel(AZURE_OPENAI_PROVIDER, "gpt-6-astra");
    const sessionFile = (await client.getState()).sessionFile!;
    const beforeTitle = await readFile(sessionFile, "utf8");
    await assert.rejects(client.generateConversationTitle("Review my launch checklist.", "The checklist is ready."), /Chat title request length/);
    assert.equal(requests.length, 15, "a truncated response does not trigger a retry");
    assert.equal(await readFile(sessionFile, "utf8"), beforeTitle);
  } finally {
    globalThis.fetch = originalFetch;
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
});
