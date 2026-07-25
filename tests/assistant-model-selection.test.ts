import assert from "node:assert/strict";
import test from "node:test";

import { resolveAssistantModelSelection } from "../web-local/src/lib/assistant-model-selection.js";

const models = [
  { provider: "openrouter", id: "ai21/jamba-large-1.7" },
  { provider: "openrouter", id: "z-ai/glm-5.2" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];

test("Assistant setup preserves the configured model after the catalog loads", () => {
  assert.equal(resolveAssistantModelSelection(models, "openrouter", "z-ai/glm-5.2"), "z-ai/glm-5.2");
});

test("Assistant setup chooses the first valid model only when the selection is unavailable", () => {
  assert.equal(resolveAssistantModelSelection(models, "openrouter", "removed/model"), "ai21/jamba-large-1.7");
  assert.equal(resolveAssistantModelSelection(models, "anthropic", "z-ai/glm-5.2"), "claude-sonnet-4");
  assert.equal(resolveAssistantModelSelection(models, "missing", "z-ai/glm-5.2"), "");
});
