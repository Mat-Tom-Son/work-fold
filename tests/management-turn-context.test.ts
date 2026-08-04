import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";

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
