import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { stream } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { AZURE_OPENAI_DEPLOYMENTS_ENV, AZURE_OPENAI_PROVIDER, FOUNDRY_PROVIDERS, normalizeFoundryConnection, parseAzureDeploymentNames } from "../src/shared/foundry.js";
import { getFoundryConnection, saveFoundryConnection } from "../src/local/agent/foundry-connection.js";
import { resolvePiRuntime, listPiModels, getPiSetupStatus, type PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";
import { PiConversationClient } from "../src/local/agent/pi-client.js";
import { HostCredentialStore, type PiAuthStorageData } from "../src/local/agent/auth-storage.js";

test("Azure accepts deployment names and normalizes portal Responses URLs", () => {
  const valid = { baseUrl: "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview", deployments: ["team", "fast"] };
  assert.deepEqual(normalizeFoundryConnection(valid), {
    baseUrl: "https://example.cognitiveservices.azure.com/openai/v1", deployments: ["team", "fast"],
  });
  assert.deepEqual(parseAzureDeploymentNames(" team, fast\nthird\r\nteam, "), ["team", "fast", "third"]);
  for (const baseUrl of ["", "not a URL", "http://example.com", "https://user:secret@example.com", "https://example.com?api-key=secret", "https://example.com/openai/deployments/team/responses"]) {
    assert.throws(() => normalizeFoundryConnection({ ...valid, baseUrl }));
  }
  for (const deployments of [[], [""], ["team=fast"], ["team/fast"], ["two names"], ["x".repeat(257)], Array(101).fill("team"), "team,fast"]) {
    assert.throws(() => normalizeFoundryConnection({ ...valid, deployments }));
  }
});

test("Foundry normalizes both endpoint families and refuses mismatched protocols and invalid metadata", () => {
  const deployments = ["team"];
  for (const baseUrl of ["https://example.services.ai.azure.com", "https://example.services.ai.azure.com/anthropic/", "https://example.services.ai.azure.com/anthropic/v1/", "https://example.services.ai.azure.com/anthropic/v1/messages"]) {
    assert.equal(normalizeFoundryConnection({ baseUrl, deployments }, "azure-anthropic").baseUrl, "https://example.services.ai.azure.com/anthropic");
  }
  assert.equal(normalizeFoundryConnection({ baseUrl: "https://example.openai.azure.com/openai/v1/chat/completions", deployments }, "azure-chat-completions").baseUrl, "https://example.openai.azure.com/openai/v1");
  assert.throws(() => normalizeFoundryConnection({ baseUrl: "https://example.com/openai/v1", deployments }, "azure-anthropic"));
  for (const host of ["example.openai.azure.com", "example.cognitiveservices.azure.com"]) assert.throws(() => normalizeFoundryConnection({ baseUrl: "https://" + host, deployments }, "azure-anthropic"), /services.ai.azure.com/);
  assert.throws(() => normalizeFoundryConnection({ baseUrl: "https://example.com/anthropic", deployments }));
  for (const modelIds of [[], { other: "gpt-4.1" }, { team: "a\nb" }, { team: 42 }]) {
    assert.throws(() => normalizeFoundryConnection({ baseUrl: "https://example.com", deployments, modelIds }));
  }
});

test("existing Azure deployments retain Pi's Chat Completions routing and model overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory({ azure: { type: "api_key", key: "synthetic-key", env: {
    AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1",
    [AZURE_OPENAI_DEPLOYMENTS_ENV]: JSON.stringify(["deepseek-v4-pro", "gpt-4.1"]),
  } } });
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { azure: { modelOverrides: { "gpt-4.1": { contextWindow: 64000 } } } } }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  await resolvePiRuntime(root, provider, { requestProjectTrust: false });
  assert.equal(modelRuntime.getModel("azure", "deepseek-v4-pro")?.api, "openai-completions");
  assert.equal(modelRuntime.getModel("azure", "gpt-4.1")?.api, "azure-openai-responses");
  assert.equal(modelRuntime.getModel("azure", "gpt-4.1")?.contextWindow, 64000);
});

test("desktop credentials use native Pi environment-key resolution without changing stored references", async () => {
  const previous = process.env.WORKFOLD_TEST_FOUNDRY_KEY;
  process.env.WORKFOLD_TEST_FOUNDRY_KEY = "synthetic-first";
  try {
    let persisted: PiAuthStorageData = { azure: { type: "api_key", key: "$WORKFOLD_TEST_FOUNDRY_KEY" } };
    const store = await HostCredentialStore.create({ load: async () => persisted, save: async (data) => { persisted = data; } });
    assert.equal((await store.read("azure"))?.type === "api_key" && (await store.read("azure") as any).key, "synthetic-first");
    process.env.WORKFOLD_TEST_FOUNDRY_KEY = "synthetic-rotated";
    assert.equal((await store.read("azure") as any).key, "synthetic-rotated");
    assert.equal((persisted.azure as any).key, "$WORKFOLD_TEST_FOUNDRY_KEY");
  } finally {
    if (previous === undefined) delete process.env.WORKFOLD_TEST_FOUNDRY_KEY;
    else process.env.WORKFOLD_TEST_FOUNDRY_KEY = previous;
  }
});

test("API-key text in desktop storage cannot become a shell command", async () => {
  const key = "!printf command-must-stay-literal";
  const store = await HostCredentialStore.create({ load: async () => ({ azure: { type: "api_key", key } }), save: async () => {} });
  const credential = await store.read("azure");
  assert.equal(credential?.type === "api_key" && credential.key, key);
});

test("Foundry can save a first deployment using Pi's ambient key and preserve it on later edits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.ANTHROPIC_FOUNDRY_API_KEY;
  process.env.ANTHROPIC_FOUNDRY_API_KEY = "synthetic-environment-key";
  t.after(() => { if (previous === undefined) delete process.env.ANTHROPIC_FOUNDRY_API_KEY; else process.env.ANTHROPIC_FOUNDRY_API_KEY = previous; });
  let persisted: PiAuthStorageData = {};
  const credentials = await HostCredentialStore.create({ load: async () => persisted, save: async (data) => { persisted = data; } });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json") });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  for (const deployment of ["claude-sonnet-4-6", "team-reviewer"]) {
    const response = await fetch(api.origin + "/api/agent/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "agent", provider: "azure-anthropic", foundry: {
      baseUrl: "https://example.services.ai.azure.com/anthropic", deployments: [deployment], modelIds: { [deployment]: "claude-sonnet-4-6" },
    } }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.doesNotMatch(await response.text(), /synthetic-environment-key/);
    assert.equal((await modelRuntime.getAuth("azure-anthropic"))?.auth.apiKey, "synthetic-environment-key");
    assert.equal((persisted["azure-anthropic"] as any).key, "$ANTHROPIC_FOUNDRY_API_KEY");
  }
});

test("a stale saved base model cannot block Settings, other providers, or credential removal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory({
    "azure-anthropic": { type: "api_key", key: "synthetic-key", env: {
      ANTHROPIC_FOUNDRY_BASE_URL: "https://example.services.ai.azure.com/anthropic",
      [AZURE_OPENAI_DEPLOYMENTS_ENV]: JSON.stringify(["team"]), WORKFOLD_FOUNDRY_MODEL_IDS: JSON.stringify({ team: "removed-model" }),
    } },
    azure: { type: "api_key", key: "synthetic-other-key" },
  });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json") });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  const settings = await fetch(api.origin + "/api/agent/models?scope=agent");
  assert.equal(settings.status, 200, await settings.clone().text());
  assert.equal((await settings.json()).foundry["azure-anthropic"].modelIds.team, "removed-model");
  assert.equal(modelRuntime.getModel("azure-anthropic", "team"), undefined, "a deployment with unavailable metadata cannot run");
  assert.ok(modelRuntime.getModel("azure", "gpt-4.1"), "other providers remain usable");
  const removed = await fetch(api.origin + "/api/agent/auth", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "agent", provider: "azure-anthropic" }) });
  assert.equal(removed.status, 200);
});

test("unknown deployment names use conservative metadata until a base model is selected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-generic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json") });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  for (const id of ["azure-chat-completions", "azure-anthropic"]) {
    await saveFoundryConnection(root, { baseUrl: "https://example.services.ai.azure.com", deployments: ["arbitrary-team-alias"] }, "synthetic-key", provider, id);
    const model = modelRuntime.getModel(id, "arbitrary-team-alias")!;
    assert.equal(model.reasoning, false, "unknown names must not acquire another model's reasoning settings");
    assert.deepEqual(model.input, id === "azure-anthropic" ? ["text", "image"] : ["text"]);
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxTokens, 16384);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.thinkingLevelMap, undefined);
  }
});

test("Foundry registration preserves the person's native models.json declarations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-custom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: Object.fromEntries(FOUNDRY_PROVIDERS.map((spec) => [spec.id, {
    api: spec.api, apiKey: "synthetic-config-key", baseUrl: "https://custom.services.ai.azure.com" + spec.path,
    models: [{ id: "custom-from-models-json", api: spec.id === "azure" ? "openai-completions" : spec.api, contextWindow: 64000, maxTokens: 4000, reasoning: false }],
  }])) }));
  const credentials = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  await resolvePiRuntime(root, provider, { requestProjectTrust: false });
  for (const spec of FOUNDRY_PROVIDERS) assert.ok(modelRuntime.getModel(spec.id, "custom-from-models-json"), spec.id + " custom model survives opening Settings");
  for (const spec of FOUNDRY_PROVIDERS) {
    await saveFoundryConnection(root, { baseUrl: "https://example.services.ai.azure.com", deployments: ["team"] }, "synthetic-key", provider, spec.id);
    for (const other of FOUNDRY_PROVIDERS) assert.equal(modelRuntime.getModel(other.id, "custom-from-models-json")?.contextWindow, 64000, other.id + " custom model survives connection changes");
  }
  const originalFetch = globalThis.fetch;
  try {
    for (const spec of FOUNDRY_PROVIDERS) for (const id of ["team", "custom-from-models-json"]) {
      const model = modelRuntime.getModel(spec.id, id)!;
      let requests = 0;
      globalThis.fetch = (async (input: unknown) => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.hostname, "example.services.ai.azure.com", "the stored key stays bound to the endpoint shown in Settings");
        assert.equal(url.pathname, spec.path + (model.api === "anthropic-messages" ? "/v1/messages" : model.api === "openai-completions" ? "/chat/completions" : "/responses"));
        return foundryStream(model.api, false);
      }) as typeof fetch;
      const result = await modelRuntime.stream(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }] }, { maxRetries: 0 }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(requests, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("Foundry Anthropic models omit the unsupported server-side fallback parameter and beta", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-features-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json") });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  await saveFoundryConnection(root, { baseUrl: "https://example.services.ai.azure.com/anthropic", deployments: ["claude-fable-5", "claude-sonnet-4-5"] }, "synthetic-key", provider, "azure-anthropic");
  assert.equal(modelRuntime.getModel("azure-anthropic", "claude-sonnet-4-5")?.contextWindow, 200000, "Foundry's Sonnet 4.5 context limit is narrower than the direct API's catalog entry");
  const model = modelRuntime.getModel("azure-anthropic", "claude-fable-5")!;
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  try {
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestCount++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.fallbacks, undefined);
      assert.doesNotMatch(new Headers(init?.headers).get("anthropic-beta") ?? "", /server-side-fallback/);
      return foundryStream("anthropic-messages", false);
    }) as typeof fetch;
    const result = await modelRuntime.stream(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }] }, { maxRetries: 0 }).result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requestCount, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed saved Foundry metadata is isolated, redacted, and repairable through Settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory(Object.fromEntries(FOUNDRY_PROVIDERS.map((spec) => [spec.id, { type: "api_key", key: "synthetic-key", env: {
    [spec.baseUrlEnv]: "https://example.services.ai.azure.com" + spec.path,
    [AZURE_OPENAI_DEPLOYMENTS_ENV]: "malformed-private-value",
  } }])));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(root, "models.json") });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  const response = await fetch(api.origin + "/api/agent/models?scope=agent");
  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  assert.doesNotMatch(text, /malformed-private-value|synthetic-key/);
  const settings = JSON.parse(text);
  for (const spec of FOUNDRY_PROVIDERS) {
    assert.match(settings.foundryErrors[spec.id], /need correction/);
    assert.equal(modelRuntime.getModels().filter((model) => model.provider === spec.id).length, 0);
  }
  const repaired = await fetch(api.origin + "/api/agent/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "agent", provider: "azure-anthropic", foundry: {
    baseUrl: "https://example.services.ai.azure.com/anthropic", deployments: ["claude-sonnet-4-6"],
  } }) });
  assert.equal(repaired.status, 200, await repaired.clone().text());
  assert.equal((await repaired.json()).foundryErrors["azure-anthropic"], undefined);
  assert.ok(modelRuntime.getModel("azure-anthropic", "claude-sonnet-4-6"));
  for (const id of ["azure", "azure-chat-completions"]) {
    const removed = await fetch(api.origin + "/api/agent/auth", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "agent", provider: id }) });
    assert.equal(removed.status, 200);
    if (id === "azure") assert.ok(modelRuntime.getModel("azure", "gpt-4.1"), "removal restores Pi's native catalog in the same runtime");
  }
});

test("malformed connection settings cannot release their stored key to a models.json endpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-invalid-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "azure-anthropic": {
    baseUrl: "https://other.services.ai.azure.com/anthropic", api: "anthropic-messages", apiKey: "synthetic-config-key", models: [{ id: "custom" }],
  } } }));
  const credentials = FileCredentialStore.inMemory({ "azure-anthropic": { type: "api_key", key: "synthetic-bound-key", env: {
    ANTHROPIC_FOUNDRY_BASE_URL: "https://expected.services.ai.azure.com/anthropic", [AZURE_OPENAI_DEPLOYMENTS_ENV]: "[broken",
  } } });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath });
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir: root, credentials, modelRuntime, settingsManager: SettingsManager.inMemory() }; } };
  await resolvePiRuntime(root, provider, { requestProjectTrust: false });
  const model = modelRuntime.getModel("azure-anthropic", "custom")!;
  assert.ok(model, "the person's metadata remains intact");
  assert.equal(await modelRuntime.getAuth(model), undefined, "the broken connection cannot release a key");
  assert.equal((await modelRuntime.getAvailable()).filter((item) => item.provider === "azure-anthropic").length, 0, "Pi does not offer models from the broken connection");
  assert.ok((await listPiModels(root, provider)).filter((item) => item.provider === "azure-anthropic").every((item) => !item.authConfigured));
  const previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = (async () => { requests++; return foundryStream("anthropic-messages", false); }) as typeof fetch;
    const result = await modelRuntime.stream(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }] }, { maxRetries: 0 }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(requests, 0);
  } finally { globalThis.fetch = previousFetch; }
  await credentials.delete("azure-anthropic");
  await resolvePiRuntime(root, provider, { requestProjectTrust: false });
  assert.equal((await modelRuntime.getAuth(modelRuntime.getModel("azure-anthropic", "custom")!))?.auth.apiKey, "synthetic-config-key", "removing broken app settings restores native user configuration in the same runtime");
});

/** Real SDK streaming envelopes: no substitute inference or parsing implementation. */
function foundryStream(api: string, tool: boolean): Response {
  let events: Array<Record<string, unknown>>;
  if (api === "anthropic-messages") {
    const block = tool ? { type: "tool_use", id: "call_1", name: "lookup", input: {} } : { type: "text", text: "" };
    events = [
      { type: "message_start", message: { id: "message_1", type: "message", role: "assistant", content: [], model: "team", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: '{"query":"test"}' } : { type: "text_delta", text: "Connected" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
  } else if (api === "openai-completions") {
    events = [{ id: "completion_1", object: "chat.completion.chunk", created: 1, model: "team", choices: [{ index: 0,
      delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"test"}' } }] } : { role: "assistant", content: "Connected" },
      finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }];
  } else {
    const item = tool ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"query":"test"}', status: "completed" }
      : { type: "message", id: "message_1", role: "assistant", content: [{ type: "output_text", text: "Connected", annotations: [] }], status: "completed" };
    events = [
      { type: "response.created", response: { id: "response_1", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], arguments: "", status: "in_progress" } },
      tool ? { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"query":"test"}' } : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Connected" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
    ];
  }
  const body = events.map((event) => (event.type ? "event: " + event.type + "\n" : "") + "data: " + JSON.stringify(event) + "\n\n").join("");
  return new Response(body + (api === "openai-completions" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}

test("all Foundry formats coexist, survive restart, and stream text and tool calls through native Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-foundry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const authPath = join(agentDir, "auth.json");
  const credentials = FileCredentialStore.create(authPath);
  const registry = await ModelRuntime.create({ credentials, modelsPath: join(agentDir, "models.json") });
  const settingsManager = SettingsManager.inMemory();
  const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, credentials, modelRuntime: registry, settingsManager }; } };
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  const baseIds = ["gpt-4.1", "deepseek-v4-pro", "claude-sonnet-4-6"];
  for (const [i, spec] of FOUNDRY_PROVIDERS.entries()) {
    const response = await fetch(api.origin + "/api/agent/configure", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "agent", provider: spec.id, apiKey: "synthetic-" + spec.id, foundry: {
        baseUrl: "https://" + spec.id + ".services.ai.azure.com" + spec.path, deployments: ["team"], modelIds: { team: baseIds[i] },
      } }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.doesNotMatch(await response.text(), /synthetic-/);
  }
  const reopened = FileCredentialStore.create(authPath);
  const fresh = await ModelRuntime.create({ credentials: reopened, modelsPath: join(agentDir, "models.json") });
  const freshProvider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir, credentials: reopened, modelRuntime: fresh, settingsManager }; } };
  await resolvePiRuntime(root, freshProvider, { requestProjectTrust: false });
  const originalFetch = globalThis.fetch;
  try {
    for (const [i, spec] of FOUNDRY_PROVIDERS.entries()) {
      const model = fresh.getModel(spec.id, "team")!;
      assert.equal(model.api, spec.api);
      assert.equal(model.id, "team");
      const saved = await getFoundryConnection(root, freshProvider, spec.id);
      assert.equal(saved.modelIds?.team, baseIds[i]);
      for (const tool of [false, true]) {
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          assert.equal(url.hostname, spec.id + ".services.ai.azure.com");
          assert.equal(url.pathname, spec.path + (spec.api === "anthropic-messages" ? "/v1/messages" : spec.api === "openai-completions" ? "/chat/completions" : "/responses"));
          const headers = new Headers(init?.headers);
          assert.equal(spec.api === "anthropic-messages" ? headers.get("x-api-key") : spec.api === "openai-completions" ? headers.get("authorization") : headers.get("api-key"),
            (spec.api === "openai-completions" ? "Bearer " : "") + "synthetic-" + spec.id);
          const payload = JSON.parse(String(init?.body));
          assert.equal(payload.model, "team");
          assert.equal(payload.stream, true);
          assert.match(JSON.stringify(payload.tools), /lookup/);
          return foundryStream(spec.api, tool);
        }) as typeof fetch;
        const result = await fresh.stream(model, { messages: [{ role: "user", content: "Test", timestamp: 0 }], tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }, { maxRetries: 0 }).result();
        assert.equal(result.stopReason, tool ? "toolUse" : "stop", result.errorMessage);
        if (tool) {
          const call = result.content.find((block) => block.type === "toolCall");
          assert.equal(call?.type === "toolCall" && call.name, "lookup");
          assert.deepEqual(call?.type === "toolCall" && call.arguments, { query: "test" });
        } else assert.ok(result.content.some((block) => block.type === "text" && block.text === "Connected"));
        assert.equal(result.usage.input, 10);
      }
    }
  } finally { globalThis.fetch = originalFetch; }
  const before = await credentials.read("azure-anthropic");
  await assert.rejects(saveFoundryConnection(root, { baseUrl: "https://example.com/anthropic", deployments: ["team"], modelIds: { team: "unknown-model" } }, "replacement", provider, "azure-anthropic"), /base model/);
  assert.deepEqual(await credentials.read("azure-anthropic"), before, "invalid model metadata cannot replace credentials");
  const removed = await fetch(api.origin + "/api/agent/auth", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "agent", provider: "azure-anthropic" }) });
  assert.equal(removed.status, 200);
  assert.equal(registry.getModel("azure-anthropic", "team"), undefined);
  assert.ok(registry.getModel("azure", "team"));
  assert.ok(registry.getModel("azure-chat-completions", "team"));
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
  const api = await startLocalApi({ port: 0, stateBase: join(root, "state"), workFolderBase: join(root, "content"), loadEnv: false, piRuntimeProvider: provider });
  t.after(() => api.close());
  const configure = (azure: unknown, apiKey?: string, providerId = AZURE_OPENAI_PROVIDER) => fetch(`${api.origin}/api/agent/configure`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", provider: providerId, model: "team", azure, ...(apiKey ? { apiKey } : {}) }),
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
  const loaded = await fetch(`${api.origin}/api/agent/models?scope=agent`);
  const loadedText = await loaded.text();
  assert.doesNotMatch(loadedText, /synthetic-azure-secret|private-environment-value|UNRELATED_SECRET/);
  assert.deepEqual(JSON.parse(loadedText).azure, normalizeFoundryConnection(azure));

  const changed = { ...azure, baseUrl: "https://other.services.ai.azure.com/openai/v1/responses" };
  const updated = await fetch(`${api.origin}/api/agent/configure`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", provider: AZURE_OPENAI_PROVIDER, azure: changed }),
  });
  assert.equal(updated.status, 200, await updated.clone().text());
  assert.equal((await updated.json()).status.model, "team", "connection updates preserve the saved model without submitting it");
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
    await saveFoundryConnection(root, { ...azure, deployments: ["team", "new-deployment"] }, undefined, provider);
    assert.deepEqual((await getFoundryConnection(root, provider)).deployments, ["team", "new-deployment"]);
    assert.equal(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "fast"), undefined);
    assert.equal((await authStorage.read(AZURE_OPENAI_PROVIDER) as { env?: Record<string, string> })?.env?.AZURE_OPENAI_DEPLOYMENT_NAME_MAP, "team=team,new-deployment=new-deployment");
  } finally {
    if (previousMapping === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    else process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousMapping;
  }
  const removed = await fetch(`${api.origin}/api/agent/auth`, {
    method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", provider: AZURE_OPENAI_PROVIDER }),
  });
  assert.equal(removed.status, 200);
  assert.equal(await authStorage.read(AZURE_OPENAI_PROVIDER), undefined);
  assert.equal(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "team"), undefined);
  assert.ok(modelRuntime.getModel(AZURE_OPENAI_PROVIDER, "gpt-4.1"), "removing app settings restores native catalog");
});

test("Chat titles use the active Azure deployment and its stored connection without unsupported minimal reasoning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-azure-title-"));
  const agentDir = join(root, "agent");
  const workFolderRoot = join(root, "work-folder");
  await mkdir(workFolderRoot, { recursive: true });
  const authStorage = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  const provider: PiRuntimeProvider = { async resolveRuntime() {
    return { agentDir, credentials: authStorage, modelRuntime,
      preferredModel: { provider: AZURE_OPENAI_PROVIDER, id: "gpt-4.1" },
      settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "medium", retry: { enabled: false } }),
    };
  } };
  await saveFoundryConnection(workFolderRoot, {
    baseUrl: "https://title-fixture.openai.azure.com", deployments: ["gpt-4.1", "gpt-5.2", "gpt-5.5-pro", "gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "team-review"],
  }, "synthetic-title-key", provider);
  const client = new PiConversationClient("azure-title-chat", workFolderRoot, provider);
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
