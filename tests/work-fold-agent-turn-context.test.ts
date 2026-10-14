import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnContextMessage } from "../src/local/agent/pi-client.js";
import { appendWorkerInstructions } from "../src/local/agent/pi-runtime-config.js";
import { appendWorkFolderOperationsGuide, workFolderOperationsGuideForScope } from "../src/local/agent/work-folder-operations-guide.js";
import { workFoldAgentScopeId } from "../src/local/state-paths.js";

test("each work-fold agent turn supersedes stale work-folder paths with the current host registry", () => {
  const context = buildTurnContextMessage({
    workFoldAgentTaskId: "task-current",
    workFoldAgentWorkFolders: [{
      id: "work-folder-current",
      name: "Test Workspace",
      workFolderRoot: "/current/profile/work-folders/test-workspace",
    }],
  });

  assert.match(context, /Current work-fold profile snapshot for this exact request \(authoritative\)/);
  assert.match(context, /"name": "Test Workspace"/);
  assert.match(context, /"workFolderRoot": "\/current\/profile\/work-folders\/test-workspace"/);
  assert.match(context, /replaces every work-folder name, id, and path from earlier conversation messages or tool results/);
  assert.match(context, /Never inspect an older work-folder path from conversation memory/);
  assert.match(context, /work-fold --json work-folders list/);
  assert.match(context, /the CLI reached a different work-fold profile/);
  assert.match(context, /task-current/);
});

test("the work-fold agent scope never receives a work-folder turn's identity block or the work-folder guide", () => {
  // The two scope blocks are mutually exclusive by construction (F26): the
  // fold carries the registry snapshot and its task id, never a work-folder
  // identity, and its system prompt never gains the work-folder operations guide.
  const context = buildTurnContextMessage({
    workFoldAgentTaskId: "task-current",
    workFoldAgentWorkFolders: [{ id: "work-folder-a", name: "Alpha", workFolderRoot: "/work-folders/alpha" }],
  });
  assert.doesNotMatch(context, /This turn's work-fold identity/);
  assert.doesNotMatch(context, /Work only in this work-folder/);

  assert.equal(workFolderOperationsGuideForScope(workFoldAgentScopeId), undefined);
  const base = appendWorkerInstructions(["system"], "Prefer short answers.");
  assert.deepEqual(appendWorkFolderOperationsGuide(base, workFolderOperationsGuideForScope(workFoldAgentScopeId)), base);
});
