import assert from "node:assert/strict";
import test from "node:test";

import { composerModelFilterThreshold, composerModelListView } from "../web-local/src/lib/composer-model-list.js";

const models = [
  { provider: "openrouter", providerName: "OpenRouter", id: "ai21/jamba-large", name: "AI21: Jamba Large" },
  { provider: "openrouter", providerName: "OpenRouter", id: "amazon/nova-pro", name: "Amazon: Nova Pro" },
  { provider: "openrouter", providerName: "OpenRouter", id: "anthropic/claude-sonnet-4", name: "Anthropic: Claude Sonnet 4" },
  { provider: "anthropic", providerName: "Anthropic", id: "claude-opus-4", name: "Claude Opus 4" },
];
const saved = { provider: "openrouter", id: "amazon/nova-pro" };
const names = (view: ReturnType<typeof composerModelListView>) => view.groups.map((group) => [group.name, group.models.map((model) => model.id)]);

test("the saved model is pinned first and left out of the provider groups", () => {
  const view = composerModelListView(models, "", saved);
  assert.equal(view.current?.id, "amazon/nova-pro");
  assert.deepEqual(names(view), [
    ["Anthropic", ["claude-opus-4"]],
    ["OpenRouter", ["ai21/jamba-large", "anthropic/claude-sonnet-4"]],
  ]);
  assert.equal(view.providerCount, 2);
});

test("the filter matches model name or provider, ignoring case, and never hides the saved model", () => {
  const byName = composerModelListView(models, "  CLAUDE ", saved);
  assert.equal(byName.current?.id, "amazon/nova-pro");
  assert.deepEqual(names(byName), [
    ["Anthropic", ["claude-opus-4"]],
    ["OpenRouter", ["anthropic/claude-sonnet-4"]],
  ]);
  assert.deepEqual(names(composerModelListView(models, "openrouter", saved)), [["OpenRouter", ["ai21/jamba-large", "anthropic/claude-sonnet-4"]]]);
  const none = composerModelListView(models, "no such model", saved);
  assert.equal(none.current?.id, "amazon/nova-pro");
  assert.deepEqual(none.groups, []);
  assert.equal(none.providerCount, 2, "group headings follow the whole list, not the filtered one");
});

test("a saved model that is not in the list pins nothing", () => {
  const view = composerModelListView(models, "", { provider: "openai", id: "gpt-5" });
  assert.equal(view.current, null);
  assert.equal(view.groups.flatMap((group) => group.models).length, models.length);
  assert.equal(composerModelListView(models, "", null).current, null);
});

test("the filter field appears only past eight models", () => {
  assert.equal(composerModelFilterThreshold, 8);
});
