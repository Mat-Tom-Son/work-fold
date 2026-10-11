import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  createWorkFoldCliActRequest,
  executeWorkFoldCliActRequest,
  type WorkFoldActFacade,
} from "../src/local/cli/index.js";

const cwd = resolve(tmpdir());
const token = "a".repeat(64);

async function run(argv: string[], facade: Partial<WorkFoldActFacade>) {
  return executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv, cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade: facade as WorkFoldActFacade, token }),
      receipts: { hasAccepted: async () => false, append: async () => true },
    },
  );
}

const models = [
  { provider: "anthropic", providerName: "Anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", seesImages: true },
  { provider: "zai", providerName: "Z.ai", id: "glm-5.3", name: "GLM 5.3", seesImages: false },
];

test("automations models lists the connected models an automation step can name, with whether each sees images", async () => {
  let calls = 0;
  const facade = { automationsModels: async () => { calls += 1; return { models }; } };
  const text = await run(["automations", "models"], facade);
  assert.equal(text.exitCode, 0, text.stderr);
  assert.equal(calls, 1);
  assert.match(text.stdout, /- Claude Sonnet 4\.5 — "model": \{"provider": "anthropic", "id": "claude-sonnet-4-5"\} · sees images/);
  assert.match(text.stdout, /- GLM 5\.3 — "model": \{"provider": "zai", "id": "glm-5\.3"\} · text only/);

  const json = await run(["automations", "models", "--json"], facade);
  assert.equal(json.exitCode, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).data.models, models);

  const none = await run(["automations", "models"], { automationsModels: async () => ({ models: [] }) });
  assert.match(none.stdout, /No connected models\. Connect a provider in Settings → AI Models\./);

  const extra = await run(["automations", "models", "--work-folder", "x"], facade);
  assert.notEqual(extra.exitCode, 0, "models takes no work-folder: automations sit above them");
});

test("automations show says which model a step uses", async () => {
  const facade = {
    automationsShow: async () => ({ automation: {
      automationId: "automation-sort-shots", title: "Sort screenshots", health: "enabled", digest: "d".repeat(64),
      trigger: { kind: "manual" }, grants: [], enabledAt: "2026-10-11T00:00:00.000Z",
      steps: [{ id: "sort", kind: "chat", workFolderId: "space-0000000000000001", workFolderName: "Screenshots", message: "Sort them.", model: { provider: "anthropic", id: "claude-sonnet-4-5" } }],
    } }),
  };
  const outcome = await run(["automations", "show", "--automation", "automation-sort-shots"], facade);
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  assert.match(outcome.stdout, /chat in Screenshots \[space-0000000000000001\] using claude-sonnet-4-5 \(anthropic\) —/);
});
