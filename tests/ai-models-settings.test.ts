import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { ModelPreferenceStore } from "../src/local/agent/model-preferences.js";
import { OpenRouterModelCatalog, parseOpenRouterModels } from "../src/local/agent/openrouter-model-catalog.js";
import { appendWorkerInstructions, type PiPreferredModel, type PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import { startLocalApi } from "../src/local/server.js";

test("Model preferences follow portable work-folder ids and keep the work-fold agent separate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-model-preferences-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstWorkFolderRoot = join(root, "first-location");
  const movedWorkFolderRoot = join(root, "moved-location");
  const workFoldAgentTestRoot = join(root, "management");
  for (const workFolderRoot of [firstWorkFolderRoot, movedWorkFolderRoot]) {
    await mkdir(join(workFolderRoot, ".work-fold"), { recursive: true });
    await writeFile(join(workFolderRoot, ".work-fold", "work-folder.json"), JSON.stringify({ id: "portable-work-folder-id" }));
  }
  await mkdir(workFoldAgentTestRoot, { recursive: true });
  const store = new ModelPreferenceStore({
    filePath: join(root, "model-preferences.json"),
    workFoldAgentRootPath: workFoldAgentTestRoot,
  });

  await store.set(firstWorkFolderRoot, { provider: "openrouter", id: "work-folder-model" });
  await store.setInstructions(firstWorkFolderRoot, "Prefer focused tests.\r\nKeep the answer concise.");
  await store.set(workFoldAgentTestRoot, { provider: "openai-codex", id: "agent-model" });

  assert.deepEqual(await store.get(movedWorkFolderRoot), { provider: "openrouter", id: "work-folder-model" });
  assert.equal(await store.getInstructions(movedWorkFolderRoot), "Prefer focused tests.\nKeep the answer concise.");
  assert.deepEqual(await store.get(workFoldAgentTestRoot), { provider: "openai-codex", id: "agent-model" });
  assert.equal(await store.getInstructions(workFoldAgentTestRoot), "");

  await store.setInstructions(movedWorkFolderRoot, "");
  assert.deepEqual(await store.get(firstWorkFolderRoot), { provider: "openrouter", id: "work-folder-model" });
  assert.equal(await store.getInstructions(firstWorkFolderRoot), "");
});

test("agent preference v1 files migrate on the next write without losing the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-model-preferences-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workFolderRoot = join(root, "work-folder");
  const filePath = join(root, "model-preferences.json");
  await mkdir(join(workFolderRoot, ".work-fold"), { recursive: true });
  await writeFile(join(workFolderRoot, ".work-fold", "work-folder.json"), JSON.stringify({ id: "portable-work-folder-id" }));
  await writeFile(filePath, JSON.stringify({
    version: 1,
    scopes: {
      "work-folder:portable-work-folder-id": {
        provider: "openrouter",
        id: "legacy-model",
        updatedAt: "2026-08-31T12:00:00.000Z",
      },
    },
  }));

  const store = new ModelPreferenceStore({ filePath });
  assert.deepEqual(await store.get(workFolderRoot), { provider: "openrouter", id: "legacy-model" });
  await store.setInstructions(workFolderRoot, "Preserve the existing model.");

  const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
    version: number;
    scopes: Record<string, { model?: PiPreferredModel; instructions?: string }>;
  };
  assert.equal(persisted.version, 2);
  assert.deepEqual(persisted.scopes["work-folder:portable-work-folder-id"]?.model, { provider: "openrouter", id: "legacy-model" });
  assert.equal(persisted.scopes["work-folder:portable-work-folder-id"]?.instructions, "Preserve the existing model.");
});

test("work-folder instructions append after the app-owned prompt and leave other scopes untouched", () => {
  assert.deepEqual(appendWorkerInstructions(["Base prompt"], ""), ["Base prompt"]);
  assert.deepEqual(appendWorkerInstructions(["Base prompt"], "Use the work-folder glossary."), [
    "Base prompt",
    "## Worker instructions\n\nUse the work-folder glossary.",
  ]);
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

test("agent API saves independent work-folder and fold models", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "work-fold-scoped-model-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const authStorage = FileCredentialStore.inMemory({ scoped: { type: "api_key", key: "test-key" } });
  const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  modelRuntime.registerProvider("scoped", {
    name: "Scoped Provider",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "$WORKFOLD_SCOPED_TEST_KEY",
    models: ["work-folder-model", "agent-model"].map((id) => ({
      id,
      name: id === "work-folder-model" ? "work-folder Model" : "Fold Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 4096,
      maxTokens: 1024,
    })),
  });
  const preferences = new Map<string, PiPreferredModel>();
  const instructions = new Map<string, string>();
  const provider: PiRuntimeProvider = {
    async resolveRuntime(workFolderRoot) {
      return {
        agentDir,
        credentials: authStorage,
        modelRuntime,
        settingsManager: SettingsManager.inMemory(),
        ...(preferences.get(workFolderRoot) ? { preferredModel: preferences.get(workFolderRoot) } : {}),
        ...(instructions.get(workFolderRoot) ? { workerInstructions: instructions.get(workFolderRoot) } : {}),
      };
    },
    async setPreferredModel(workFolderRoot, model) {
      preferences.set(workFolderRoot, model);
    },
    async getWorkerInstructions(workFolderRoot) {
      return instructions.get(workFolderRoot) ?? "";
    },
    async setWorkerInstructions(workFolderRoot, value) {
      instructions.set(workFolderRoot, value);
    },
  };
  const api = await startLocalApi({
    port: 0,
    stateBase: join(root, "state"),
    workFolderBase: join(root, "content"),
    loadEnv: false,
    piRuntimeProvider: provider,
  });
  t.after(() => api.close());
  const created = await requestJson(`${api.origin}/api/work-folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Scoped work-folder" }),
  }) as { workFolder: { id: string } };

  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "work-folder", workFolderId: created.workFolder.id, provider: "scoped", model: "work-folder-model" }),
  });
  await requestJson(`${api.origin}/api/agent/configure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", provider: "scoped", model: "agent-model" }),
  });

  const saved = await requestJson(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "work-folder", workFolderId: created.workFolder.id, instructions: "Use this work-folder's glossary." }),
  }) as { instructions: string };
  assert.equal(saved.instructions, "Use this work-folder's glossary.");

  const workFolderModels = await requestJson(`${api.origin}/api/agent/models?scope=work-folder&workFolderId=${created.workFolder.id}`) as { status: { model: string }; instructions: string };
  const workFoldAgentModels = await requestJson(`${api.origin}/api/agent/models?scope=agent`) as { status: { model: string }; instructions: null };
  assert.equal(workFolderModels.status.model, "work-folder-model");
  assert.equal(workFolderModels.instructions, "Use this work-folder's glossary.");
  assert.equal(workFoldAgentModels.status.model, "agent-model");
  assert.equal(workFoldAgentModels.instructions, null);

  const streamAbort = new AbortController();
  const streamTimeout = setTimeout(() => streamAbort.abort(), 10_000);
  try {
    const stream = await fetch(`${api.origin}/api/work-fold-agent/control-events`, { signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"reset"}\n\n');
    await api.actFacade.workerSetModel({ workFolder: created.workFolder.id, provider: "scoped", model: "agent-model" });
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"models"}\n\n');
    const composer = await requestJson(`${api.origin}/api/agent/composer?scope=work-folder&workFolderId=${created.workFolder.id}`) as { composer: { model: { id: string } } };
    assert.equal(composer.composer.model.id, "agent-model");
    await requestJson(`${api.origin}/api/agent/configure`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "work-folder", workFolderId: created.workFolder.id, provider: "scoped", model: "work-folder-model" }),
    });
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"models"}\n\n');
  } finally { clearTimeout(streamTimeout); streamAbort.abort(); }

  const invalid = await fetch(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "work-folder", workFolderId: created.workFolder.id, instructions: "bad\u0001control" }),
  });
  assert.equal(invalid.status, 400);

  const management = await fetch(`${api.origin}/api/agent/instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "agent", instructions: "Do not allow this." }),
  });
  assert.equal(management.status, 400);
});

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return text ? JSON.parse(text) : null;
}
