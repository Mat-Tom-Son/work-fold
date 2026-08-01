import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  defaultAgentSdkDir,
  spaceSessionDir,
  spaceStorageKey,
} from "../src/local/agent/agent-data-dir.js";

test("work-fold preserves Pi's native agent override and ignores the old product override", () => {
  assert.equal(defaultAgentSdkDir({
    WORKFOLD_AGENT_DIR: "/tmp/work-fold-agent",
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    WORKSPACE_AGENT_DIR: "/tmp/legacy-agent",
  }), "/tmp/work-fold-agent");
  assert.equal(defaultAgentSdkDir({
    PI_CODING_AGENT_DIR: "/tmp/pi-agent",
    WORKSPACE_AGENT_DIR: "/tmp/legacy-agent",
  }), "/tmp/pi-agent");
});

test("work-fold Pi sessions use a product namespace beneath the shared Pi agent root", () => {
  const root = "/Users/example/Documents/Shared Space";
  const agentRoot = "/Users/example/.pi/agent";
  assert.equal(
    spaceSessionDir(root, agentRoot),
    join(agentRoot, "sessions", "work-fold", spaceStorageKey(root)),
  );
  assert.notEqual(
    spaceSessionDir(root, agentRoot),
    join(agentRoot, "sessions", spaceStorageKey(root)),
  );
});
