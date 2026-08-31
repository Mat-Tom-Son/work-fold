import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStorage, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";

import { AssistantModelPreferenceStore } from "../src/local/agent/model-preferences.js";
import { OpenRouterModelCatalog, parseOpenRouterModels } from "../src/local/agent/openrouter-model-catalog.js";
import type { PiPreferredModel, PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";

test("Assistant model preferences follow portable Space ids and keep the fold separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-model-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstSpaceRoot = join(root, "first-location");
  const movedSpaceRoot = join(root, "moved-location");
  const foldRoot = join(root, "management");
  for (const spaceRoot of [firstSpaceRoot, movedSpaceRoot]) {
    await mkdir(join(spaceRoot, ".work-fold"), { recursive: true });
    await writeFile(join(spaceRoot, ".work-fold", "space.json"), JSON.stringify({ id: "portable-space-id" }));
  }
  await mkdir(foldRoot, { recursive: true });
  const store = new AssistantModelPreferenceStore({
    filePath: join(root, "assistant-model-preferences.json"),
    managementRoot: foldRoot,
  });

  await store.set(firstSpaceRoot, { provider: "openrouter", id: "space-model" });
  await store.set(foldRoot, { provider: "openai-codex", id: "fold-model" });

  assert.deepEqual(await store.get(movedSpaceRoot), { provider: "openrouter", id: "space-model" });
  assert.deepEqual(await store.get(foldRoot), { provider: "openai-codex", id: "fold-model" });
});

test("OpenRouter live catalog normalizes tool-capable text models and persists the last good refresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-openrouter-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = JSON.stringify({
    data: [{
      id: "example/reasoning-model",
      name: "Example: Reasoning Model",
      context_length: 131_072,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      pricing: { prompt: "0.000002", completion: "0.000008" },
      supported_parameters: ["tools", "reasoning"],
      top_provider: { max_completion_tokens: 16_384 },
    }, {
      id: "example/audio-only",
      name: "Audio only",
      context_length: 4096,
      architecture: { input_modalities: ["audio"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    }],
  });
  const parsed = parseOpenRouterModels(payload);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.input, ["text", "image"]);
  assert.deepEqual(parsed[0]?.cost, { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 });
  assert.equal(parsed[0]?.reasoning, true);

  const requests: Array<{ authorization: string | null }> = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ authorization: headers.get("authorization") });
    return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const cachePath = join(root, "model-catalogs", "openrouter.json");
  const catalog = new OpenRouterModelCatalog({ cachePath, fetch: fakeFetch });
  const refreshed = await catalog.refresh("secret-openrouter-key");
  assert.equal(refreshed.modelCount, 1);
  assert.deepEqual(requests, [{ authorization: "Bearer secret-openrouter-key" }]);
  assert.equal((await catalog.status()).source, "live");

  const reopened = new OpenRouterModelCatalog({ cachePath, fetch: fakeFetch });
  const cached = await reopened.load();
  assert.equal(cached?.provider, "openrouter");
  assert.equal(cached?.liveModelCount, 1);
  assert.equal(cached?.config.models?.[0]?.id, "example/reasoning-model");
});

test("Assistant API saves independent Space and fold models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-scoped-model-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const authStorage = AuthStorage.inMemory({ scoped: { type: "api_key", key: "test-key" } });
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider("scoped", {
    name: "Scoped Provider",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "$WORKFOLD_SCOPED_TEST_KEY",
    models: ["space-model", "fold-model"].map((id) => ({
      id,
      name: id === "space-model" ? "Space Model" : "Fold Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    })),
  });
  const preferences = new Map<string, PiPreferredModel>();
  const provider: PiRuntimeProvider = {
    async resolveRuntime(spaceRoot) {
      return {
        agentDir,
        authStorage,
        modelRegistry,
        settingsManager: SettingsManager.inMemory(),
        ...(preferences.get(spaceRoot) ? { preferredModel: preferences.get(spaceRoot) } : {}),
      };
    },
    async setPreferredModel(spaceRoot, model) {
      preferences.set(spaceRoot, model);
    },
  };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(root, "state"),
    spaceBase: join(root, "content"),
    loadEnv: false,
    piRuntimeProvider: provider,
  });
  t.after(() => api.close());
  const created = await requestJson(`${api.origin}/api/spaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scoped Space" }),
  }) as { space: { id: string } };

  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "space", spaceId: created.space.id, provider: "scoped", model: "space-model" }),
  });
  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "management", provider: "scoped", model: "fold-model" }),
  });

  const spaceModels = await requestJson(`${api.origin}/api/agent/models?scope=space&spaceId=${created.space.id}`) as { status: { model: string } };
  const foldModels = await requestJson(`${api.origin}/api/agent/models?scope=management`) as { status: { model: string } };
  assert.equal(spaceModels.status.model, "space-model");
  assert.equal(foldModels.status.model, "fold-model");
});

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return text ? JSON.parse(text) : null;
}
