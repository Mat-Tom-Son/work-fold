import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useState } from "react";

import { createDomHarness } from "./support/dom.js";
import { ModelCatalogList, modelCatalogGroups, modelCatalogKey, modelVendor } from "../web-local/src/components/panes/ModelCatalogList.js";
import type { AgentModel } from "../web-local/src/types.js";

const model = (id: string, name: string, provider = "openrouter"): AgentModel => ({ provider, providerName: provider === "openrouter" ? "OpenRouter" : "Anthropic", id, name, authConfigured: true, authSource: "stored", authType: "api_key", oauthSupported: false });
const catalog: AgentModel[] = [
  model("deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash"),
  model("deepseek/deepseek-v4.1", "DeepSeek: DeepSeek V4.1"),
  model("anthropic/claude-sonnet-4.5", "Anthropic: Claude Sonnet 4.5"),
  model("openai/gpt-5", "OpenAI: GPT-5"),
  model("openai/gpt-5-mini", "OpenAI: GPT-5 Mini"),
  model("google/gemini-2.5-pro", "Google: Gemini 2.5 Pro"),
  model("google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"),
  model("meta-llama/llama-4-maverick", "Meta: Llama 4 Maverick"),
  model("qwen/qwen3-coder", "Qwen: Qwen3 Coder"),
];

test("vendors come from the name prefix, then the id prefix, then the provider", () => {
  assert.equal(modelVendor(model("deepseek/deepseek-v4.1-flash", "DeepSeek: DeepSeek V4.1 Flash")), "DeepSeek");
  assert.equal(modelVendor(model("z-ai/glm-4.6", "GLM 4.6")), "Z Ai");
  assert.equal(modelVendor(model("claude-sonnet-4", "Claude Sonnet", "anthropic")), "Anthropic");
  const groups = modelCatalogGroups(catalog, " GEM ");
  assert.deepEqual(groups.map((group) => [group.vendor, group.models.map((item) => item.id)]), [["Google", ["google/gemini-2.5-flash", "google/gemini-2.5-pro"]]]);
  assert.deepEqual(modelCatalogGroups(catalog, "").map((group) => group.vendor), ["Anthropic", "DeepSeek", "Google", "Meta", "OpenAI", "Qwen"]);
});

test("catalog aliases share their vendor heading and keep its spelling during search", () => {
  const aliases = [
    model("~openai/gpt-latest", "OpenAI GPT Latest"),
    model("openai/gpt-5", "OpenAI: GPT-5"),
    model("~moonshotai/kimi-latest", "MoonshotAI Kimi Latest"),
    model("moonshotai/kimi-k2", "MoonshotAI: Kimi K2"),
  ];
  assert.deepEqual(modelCatalogGroups(aliases, "").map(group => [group.vendor, group.models.length]), [["MoonshotAI", 2], ["OpenAI", 2]]);
  assert.deepEqual(modelCatalogGroups(aliases, "latest").map(group => [group.vendor, group.models.length]), [["MoonshotAI", 1], ["OpenAI", 1]]);
});

async function mount(t: Parameters<Parameters<typeof test>[1]>[0], models = catalog, groupByProvider = false) {
  const dom = await createDomHarness();
  t.after(() => dom.cleanup());
  const chosen: string[] = [];
  let submits = 0;
  function Screen() {
    const [value, setValue] = useState(groupByProvider ? modelCatalogKey(models[0]!) : models[0]!.id);
    return createElement("form", { onSubmit: (event: { preventDefault: () => void }) => { event.preventDefault(); submits += 1; } },
      createElement("span", { id: "model-label" }, "Model"),
      createElement(ModelCatalogList, { id: "assistant-model", labelledBy: "model-label", models, value, groupByProvider, onChange: (next: string) => { chosen.push(next); setValue(next); } }),
      createElement("button", { type: "submit" }, "Save"));
  }
  await dom.render(createElement(Screen));
  const trigger = () => document.getElementById("assistant-model") as HTMLButtonElement;
  const options = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  return { dom, chosen, trigger, options, submits: () => submits };
}

test("the closed control shows the chosen model and a click opens the searchable, grouped list", async (t) => {
  const ui = await mount(t);
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "false");
  assert.equal(ui.trigger().dataset.modelId, "deepseek/deepseek-v4.1-flash");
  assert.match(ui.trigger().textContent ?? "", /DeepSeek V4\.1 Flash/);
  assert.equal(ui.options().length, 0);
  await ui.dom.act(() => ui.trigger().click());
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Search models", "the search box takes focus when the list opens");
  assert.deepEqual(Array.from(document.querySelectorAll(".model-catalog-vendor")).map((node) => node.textContent), ["Anthropic", "DeepSeek", "Google", "Meta", "OpenAI", "Qwen"]);
  assert.equal(ui.options().length, catalog.length);
  await ui.dom.act(() => ui.options().find((option) => option.dataset.modelId === "openai/gpt-5-mini")!.click());
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "false");
  assert.deepEqual(ui.chosen, ["openai/gpt-5-mini"]);
  assert.equal(ui.trigger().dataset.modelId, "openai/gpt-5-mini");
  assert.equal(document.activeElement, ui.trigger(), "focus returns to the closed control");
  assert.equal(ui.submits(), 0);
});

test("typing filters the list and Enter picks the first match without saving the form", async (t) => {
  const ui = await mount(t);
  await ui.dom.act(() => ui.trigger().click());
  const search = document.activeElement as HTMLInputElement;
  await ui.dom.act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "gemini");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(ui.options().map((option) => option.dataset.modelId), ["google/gemini-2.5-flash", "google/gemini-2.5-pro"]);
  await ui.dom.press("Enter");
  assert.deepEqual(ui.chosen, ["google/gemini-2.5-flash"]);
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "false");
  assert.equal(ui.submits(), 0, "Enter in the search box never submits the enclosing form");
});

test("arrow keys open onto the options, and Escape closes the list before the window can see it", async (t) => {
  const ui = await mount(t);
  let escapesSeen = 0;
  const windowSaw = () => { escapesSeen += 1; };
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") windowSaw(); }, true);
  ui.trigger().focus();
  await ui.dom.press("ArrowDown");
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "true");
  assert.equal(document.activeElement?.getAttribute("data-model-id"), "anthropic/claude-sonnet-4.5", "ArrowDown opens onto the first option");
  await ui.dom.press("End");
  assert.equal(document.activeElement?.getAttribute("data-model-id"), "qwen/qwen3-coder");
  await ui.dom.press("ArrowDown");
  assert.equal(document.activeElement?.getAttribute("data-model-id"), "anthropic/claude-sonnet-4.5", "the list wraps");
  await ui.dom.act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "false");
  assert.equal(document.activeElement, ui.trigger());
  assert.equal(escapesSeen, 0, "a document listener, such as the Settings window's, never receives the Escape");
  assert.deepEqual(ui.chosen, []);
});

test("a short list opens without a search box and a click outside closes it", async (t) => {
  const ui = await mount(t, catalog.slice(0, 3));
  await ui.dom.act(() => ui.trigger().click());
  assert.equal(document.querySelector('[aria-label="Search models"]'), null);
  assert.equal(document.activeElement?.getAttribute("data-model-id"), "deepseek/deepseek-v4.1-flash", "without a search box the chosen option takes focus");
  await ui.dom.act(() => { document.body.dispatchEvent(new (window as unknown as { PointerEvent: typeof Event }).PointerEvent("pointerdown", { bubbles: true })); });
  assert.equal(ui.trigger().getAttribute("aria-expanded"), "false");
});

test("connected-provider search and selection distinguish identical model ids", async t => {
  const providers = [
    { ...model("gpt-5", "GPT-5"), provider: "openai", providerName: "OpenAI" },
    { ...model("gpt-5", "GPT-5"), provider: "openai-chatgpt", providerName: "ChatGPT" },
    catalog[3]!,
  ];
  assert.deepEqual(modelCatalogGroups(providers, "chatgpt", true).map(group => group.models.map(item => item.provider)), [["openai-chatgpt"]]);
  const ui = await mount(t, providers, true);
  await ui.dom.act(() => ui.trigger().click());
  assert.ok(document.querySelector('[aria-label="Search models"]'), "all-provider mode always starts with search");
  assert.equal(ui.options().filter(option => option.getAttribute("aria-selected") === "true").length, 1);
  await ui.dom.act(() => ui.options().find(option => option.dataset.provider === "openai-chatgpt")!.click());
  assert.deepEqual(ui.chosen, [modelCatalogKey(providers[1]!)]);
  assert.equal(ui.trigger().dataset.provider, "openai-chatgpt");
  assert.match(ui.trigger().textContent!, /GPT-5ChatGPT/);
});
