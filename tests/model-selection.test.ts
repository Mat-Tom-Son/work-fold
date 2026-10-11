import assert from "node:assert/strict";
import test from "node:test";

import { resolveModelSelection } from "../web-local/src/lib/model-selection.js";

const models = [
  { provider: "openrouter", id: "ai21/jamba-large-1.7" },
  { provider: "openrouter", id: "z-ai/glm-5.2" },
  { provider: "anthropic", id: "claude-sonnet-4" },
];

test("agent setup preserves the configured model after the catalog loads", () => {
  assert.equal(resolveModelSelection(models, "openrouter", "z-ai/glm-5.2"), "z-ai/glm-5.2");
});

test("agent setup chooses the first valid model only when the selection is unavailable", () => {
  assert.equal(resolveModelSelection(models, "openrouter", "removed/model"), "ai21/jamba-large-1.7");
  assert.equal(resolveModelSelection(models, "anthropic", "z-ai/glm-5.2"), "claude-sonnet-4");
  assert.equal(resolveModelSelection(models, "missing", "z-ai/glm-5.2"), "");
});
