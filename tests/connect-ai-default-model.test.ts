import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { ensurePiDefaultModel, getPiSetupStatus, type PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";

async function runtimeWith(connected: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "work-fold-default-model-"));
  const credentials = FileCredentialStore.inMemory(Object.fromEntries(Object.entries(connected).map(([provider, key]) => [provider, { type: "api_key" as const, key }])));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  modelRuntime.registerProvider("house", {
    name: "House Provider",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "house-key",
    models: ["house-small", "house-large"].map((id) => ({
      id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
    })),
  });
  const settingsManager = SettingsManager.inMemory();
  const provider: PiRuntimeProvider = {
    async resolveRuntime() { return { agentDir: join(root, "agent"), credentials, modelRuntime, settingsManager }; },
  };
  return { root, provider, settingsManager };
}

test("connecting a provider gives every Worker a model to start on, once", async (t) => {
  const { root, provider, settingsManager } = await runtimeWith({ openrouter: "synthetic-openrouter-key" });
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder");

  assert.deepEqual(await ensurePiDefaultModel(folder, "openrouter", provider), { provider: "openrouter", id: "openai/gpt-6-luna" });
  assert.equal(settingsManager.getDefaultProvider(), "openrouter");
  assert.equal(settingsManager.getDefaultModel(), "openai/gpt-6-luna");
  const status = await getPiSetupStatus(folder, provider);
  assert.equal(status.provider, "openrouter");
  assert.equal(status.model, "openai/gpt-6-luna", "the status, composer, and turns all read this default");

  // A usable default stays: connecting another provider later changes nothing.
  assert.equal(await ensurePiDefaultModel(folder, "house", provider), undefined);
  assert.equal(settingsManager.getDefaultModel(), "openai/gpt-6-luna");
});

test("a default whose provider is gone is replaced, and a provider without a listed pick starts on its first model", async (t) => {
  const { root, provider, settingsManager } = await runtimeWith({});
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder");
  settingsManager.setDefaultModelAndProvider("anthropic", "claude-opus-4-8");

  assert.equal(await ensurePiDefaultModel(folder, "anthropic", provider), undefined, "a provider that is not connected sets nothing");
  assert.equal(settingsManager.getDefaultProvider(), "anthropic");
  assert.deepEqual(await ensurePiDefaultModel(folder, "house", provider), { provider: "house", id: "house-small" });
  assert.equal(settingsManager.getDefaultModel(), "house-small");
});
