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

/**
 * `automations show` is where the two residuals live (docs/automations.md).
 * Neither is a gate: a created-files handoff is a standing, content-dependent
 * channel from one work-folder into another for as long as the automation is on, and a
 * chat step's turn runs with whatever agent authority its work-folder holds at
 * that moment — not the authority it held at enablement. A person reading a
 * automation has to be told both, so this pins that the renderer says them and
 * says them only when they apply.
 */

const cwd = resolve(tmpdir());
const token = "a".repeat(64);

function automationWith(steps: unknown[]): Record<string, unknown> {
  return {
    automationId: "weekly-roundup",
    title: "Weekly roundup",
    health: "enabled",
    digest: "d".repeat(64),
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps,
    grants: [],
    enabledAt: "2026-09-01T00:00:00.000Z",
  };
}

async function showAutomation(steps: unknown[]): Promise<string> {
  const facade = {
    automationsShow: async () => ({ automation: automationWith(steps) }),
  } as unknown as WorkFoldActFacade;
  const outcome = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv: ["automations", "show", "--automation", "weekly-roundup"], cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: { hasAccepted: async () => false, append: async () => true },
    },
  );
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  return outcome.stdout;
}

const chatStep = { id: "draft", kind: "chat", workFolderId: "work-folder-a", workFolderName: "Drafts", message: "Write the roundup." };
const handoffStep = {
  id: "deliver",
  kind: "files",
  fromWorkFolderId: "work-folder-a",
  fromWorkFolderName: "Drafts",
  toWorkFolderId: "work-folder-b",
  toWorkFolderName: "Published",
  to: "incoming",
  source: { kind: "step-created-files", step: "draft", maxFiles: 10, maxTotalBytes: 1024 },
};
const pathsStep = {
  id: "copy",
  kind: "files",
  fromWorkFolderId: "work-folder-a",
  fromWorkFolderName: "Drafts",
  toWorkFolderId: "work-folder-b",
  toWorkFolderName: "Published",
  to: "incoming",
  source: { kind: "paths", paths: ["notes.md"] },
};
const checkStep = { id: "verify", kind: "check", workFolderId: "work-folder-b", workFolderName: "Published" };

test("automations show states the standing channel and the run-time authority residuals", async () => {
  const stdout = await showAutomation([chatStep, handoffStep]);
  assert.match(stdout, /While this automation is on:/);
  assert.match(
    stdout,
    /- Standing channel: whatever step draft's turn writes is copied into Published \[work-folder-b\] on every run\./,
  );
  assert.match(
    stdout,
    /- Each chat step's turn runs with whatever authority its work-folder's Worker holds at that moment, not the authority it held when this automation was turned on\./,
  );
});

test("a automation with no chat step and no created-files handoff states no residual", async () => {
  const stdout = await showAutomation([pathsStep, checkStep]);
  assert.doesNotMatch(stdout, /While this automation is on:/);
  assert.doesNotMatch(stdout, /Standing channel/);
  assert.doesNotMatch(stdout, /agent authority/);
  // The step list itself is unchanged.
  assert.match(stdout, /- copy: files from Drafts \[work-folder-a\]/);
});

test("a chat-only automation states the authority residual without inventing a channel", async () => {
  const stdout = await showAutomation([chatStep, checkStep]);
  assert.match(stdout, /While this automation is on:/);
  assert.doesNotMatch(stdout, /Standing channel/);
  assert.match(stdout, /authority its work-folder's Worker holds at that moment/);
});
