import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { appendAssistantInstructions } from "../src/local/agent/pi-runtime-config.js";
import { appendSpaceOperationsGuide, spaceOperationsGuideForScope } from "../src/local/agent/space-operations-guide.js";
import { workFoldManagementScopeId } from "../src/local/state-paths.js";

test("each management turn supersedes stale Space paths with the current host registry", () => {
  const context = buildTurnContextMessage({
    managementTaskId: "task-current",
    managementSpaces: [{
      id: "space-current",
      name: "Test Workspace",
      spaceRoot: "/current/profile/spaces/test-workspace",
    }],
  });

  assert.match(context, /Current work-fold profile snapshot for this exact request \(authoritative\)/);
  assert.match(context, /"name": "Test Workspace"/);
  assert.match(context, /"spaceRoot": "\/current\/profile\/spaces\/test-workspace"/);
  assert.match(context, /replaces every Space name, id, and path from earlier conversation messages or tool results/);
  assert.match(context, /Never inspect an older Space path from conversation memory/);
  assert.match(context, /work-fold --json spaces list/);
  assert.match(context, /profile-routing error/);
  assert.match(context, /task-current/);
});

test("the management scope never receives a Space turn's identity block or the Space guide", () => {
  // The two scope blocks are mutually exclusive by construction (F26): the
  // fold carries the registry snapshot and its task id, never a Space
  // identity, and its system prompt never gains the Space operations guide.
  const context = buildTurnContextMessage({
    managementTaskId: "task-current",
    managementSpaces: [{ id: "space-a", name: "Alpha", spaceRoot: "/spaces/alpha" }],
  });
  assert.doesNotMatch(context, /This turn's work-fold identity/);
  assert.doesNotMatch(context, /Work only in this Space/);

  assert.equal(spaceOperationsGuideForScope(workFoldManagementScopeId), undefined);
  const base = appendAssistantInstructions(["system"], "Prefer short answers.");
  assert.deepEqual(appendSpaceOperationsGuide(base, spaceOperationsGuideForScope(workFoldManagementScopeId)), base);
});
