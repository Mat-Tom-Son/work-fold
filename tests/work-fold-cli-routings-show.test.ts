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
 * `routings show` is where the two residuals live (docs/fold-routings.md).
 * Neither is a gate: a created-files handoff is a standing, content-dependent
 * channel from one Space into another for as long as the routing is on, and a
 * chat step's turn runs with whatever Assistant authority its Space holds at
 * that moment — not the authority it held at enablement. A person reading a
 * routing has to be told both, so this pins that the renderer says them and
 * says them only when they apply.
 */

const cwd = resolve(tmpdir());
const token = "a".repeat(64);

function routingWith(steps: unknown[]): Record<string, unknown> {
  return {
    routingId: "weekly-roundup",
    title: "Weekly roundup",
    health: "enabled",
    digest: "d".repeat(64),
    trigger: { kind: "interval", intervalMinutes: 60 },
    steps,
    grants: [],
    enabledAt: "2026-09-01T00:00:00.000Z",
  };
}

async function showRouting(steps: unknown[]): Promise<string> {
  const facade = {
    routingsShow: async () => ({ routing: routingWith(steps) }),
  } as unknown as WorkFoldActFacade;
  const outcome = await executeWorkFoldCliActRequest(
    createWorkFoldCliActRequest({ id: randomUUID(), argv: ["routings", "show", "--routing", "weekly-roundup"], cwd, actToken: token }),
    {
      version: "test",
      getActFacade: () => ({ facade, token }),
      receipts: { hasAccepted: async () => false, append: async () => true },
    },
  );
  assert.equal(outcome.exitCode, 0, outcome.stderr);
  return outcome.stdout;
}

const chatStep = { id: "draft", kind: "chat", spaceId: "space-a", spaceName: "Drafts", message: "Write the roundup." };
const handoffStep = {
  id: "deliver",
  kind: "files",
  fromSpaceId: "space-a",
  fromSpaceName: "Drafts",
  toSpaceId: "space-b",
  toSpaceName: "Published",
  to: "incoming",
  source: { kind: "step-created-files", step: "draft", maxFiles: 10, maxTotalBytes: 1024 },
};
const pathsStep = {
  id: "copy",
  kind: "files",
  fromSpaceId: "space-a",
  fromSpaceName: "Drafts",
  toSpaceId: "space-b",
  toSpaceName: "Published",
  to: "incoming",
  source: { kind: "paths", paths: ["notes.md"] },
};
const checkStep = { id: "verify", kind: "check", spaceId: "space-b", spaceName: "Published" };

test("routings show states the standing channel and the run-time authority residuals", async () => {
  const stdout = await showRouting([chatStep, handoffStep]);
  assert.match(stdout, /While this routing is on:/);
  assert.match(
    stdout,
    /- Standing channel: whatever step draft's turn writes is copied into Published \[space-b\] on every run\./,
  );
  assert.match(
    stdout,
    /- Each chat step's turn runs with whatever Assistant authority its Space holds at that moment, not the authority it held when this routing was turned on\./,
  );
});

test("a routing with no chat step and no created-files handoff states no residual", async () => {
  const stdout = await showRouting([pathsStep, checkStep]);
  assert.doesNotMatch(stdout, /While this routing is on:/);
  assert.doesNotMatch(stdout, /Standing channel/);
  assert.doesNotMatch(stdout, /Assistant authority/);
  // The step list itself is unchanged.
  assert.match(stdout, /- copy: files from Drafts \[space-a\]/);
});

test("a chat-only routing states the authority residual without inventing a channel", async () => {
  const stdout = await showRouting([chatStep, checkStep]);
  assert.match(stdout, /While this routing is on:/);
  assert.doesNotMatch(stdout, /Standing channel/);
  assert.match(stdout, /Assistant authority its Space holds at that moment/);
});
