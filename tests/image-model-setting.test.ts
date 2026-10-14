import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileCredentialStore, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { chooseImageModel, type ImageModelSource } from "../src/local/agent/image-generation-tool.js";
import { startLocalApi } from "../src/local/server.js";

test("the saved image model is used while connected, and Automatic otherwise", async () => {
  const model = (provider: string, id: string) => ({ provider, id, name: id, api: "openrouter-images", type: "image", output: ["image"] });
  const source = {
    getAvailableOfType: async () => [model("openrouter", "google/gemini-3.1-flash-image"), model("openrouter", "recraft/recraft-v4")],
    hasConfiguredAuth: () => false,
  } as unknown as ImageModelSource;
  assert.equal((await chooseImageModel(source, undefined, { provider: "openrouter", id: "recraft/recraft-v4" })).id, "recraft/recraft-v4");
  assert.equal((await chooseImageModel(source, undefined, { provider: "openai", id: "gpt-image-2" })).id, "google/gemini-3.1-flash-image", "a disconnected choice falls back to Automatic");
  assert.equal((await chooseImageModel(source, { provider: "openrouter", id: "google/gemini-3.1-flash-image" }, { provider: "openrouter", id: "recraft/recraft-v4" })).id, "google/gemini-3.1-flash-image", "a model the Worker names wins");
});

test("Settings saves one image model for every Worker, refuses one that isn't connected, and returns to Automatic", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-image-model-setting-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const credentials = FileCredentialStore.inMemory();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
  await modelRuntime.setRuntimeApiKey("openrouter", "test-key-not-real");
  const api = await startLocalApi({
    port: 0,
    stateBase: join(sandbox, "state"),
    workFolderBase: join(sandbox, "content"),
    loadEnv: false,
    piRuntimeProvider: { async resolveRuntime() { return { agentDir: join(sandbox, "agent"), credentials, modelRuntime }; } },
  });
  try {
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`${api.origin}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const initial = await request("/api/agent/image-models");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.selected, null, "Automatic until someone chooses");
    assert.ok(initial.body.models.length > 10, "OpenRouter's image models are listed");
    assert.ok(!initial.body.models.some((item: { id: string }) => item.id.startsWith("openrouter/auto")), "routers are never offered");
    assert.equal(initial.body.automatic?.id, "google/gemini-3.1-flash-image");

    const saved = await request("/api/agent/image-model", { model: { provider: "openrouter", id: "openai/gpt-image-2" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.selected, { provider: "openrouter", id: "openai/gpt-image-2" });
    assert.equal(saved.body.selectedAvailable, true);
    assert.deepEqual((await request("/api/agent/image-models")).body.selected, { provider: "openrouter", id: "openai/gpt-image-2" }, "it persists");

    const refused = await request("/api/agent/image-model", { model: { provider: "openai", id: "gpt-image-2" } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? JSON.stringify(refused.body), /not connected/);
    assert.equal((await request("/api/agent/image-model", { model: "nope" })).status, 400);

    const automatic = await request("/api/agent/image-model", { model: null });
    assert.equal(automatic.body.selected, null);
  } finally {
    await api.close();
  }
});

test("the Image model section shows Automatic with its pick, and saves a choice at once", async (t) => {
  const { createDomHarness } = await import("./support/dom.js");
  const { createElement, useState } = await import("react");
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const posts: unknown[] = [];
  const models = [
    { provider: "openrouter", providerName: "OpenRouter", id: "google/gemini-3.1-flash-image", name: "Google: Nano Banana 2" },
    { provider: "openrouter", providerName: "OpenRouter", id: "openai/gpt-image-2", name: "OpenAI: GPT Image 2" },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/api/agent/image-model") || init?.method !== "POST") throw new Error(`unexpected ${url}`);
    const body = JSON.parse(String(init.body)) as { model: { provider: string; id: string } | null };
    posts.push(body.model);
    return new Response(JSON.stringify({ selected: body.model, selectedAvailable: true, automatic: models[0], models }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const { ImageModelSection } = await import("../web-local/src/components/panes/ImageModelSection.js");
  function Host() {
    const [settings, setSettings] = useState({ selected: null, selectedAvailable: true, automatic: models[0]!, models } as never);
    return createElement(ImageModelSection, { settings, onChange: setSettings });
  }
  await dom.render(createElement(Host));
  assert.equal(dom.container.querySelector(".model-catalog-name")?.textContent, "Nano Banana 2", "Automatic shows its current pick without the vendor prefix");
  assert.equal(dom.container.querySelector(".model-catalog-id")?.textContent, "Automatic");
  await dom.act(() => dom.container.querySelector<HTMLButtonElement>(".model-catalog button")!.click());
  const option = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((item) => item.dataset.modelId === "openai/gpt-image-2")!;
  await dom.waitFor(() => Boolean(option()));
  await dom.act(() => option().click());
  await dom.waitFor(() => posts.length === 1);
  assert.deepEqual(posts, [{ provider: "openrouter", id: "openai/gpt-image-2" }], "picking saves at once");
  await dom.waitFor(() => dom.container.querySelector(".model-catalog-name")?.textContent === "GPT Image 2");
});
