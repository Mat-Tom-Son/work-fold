import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  WorkFoldContextRequiredError,
  WorkFoldKernel,
} from "../src/local/work-fold-kernel.js";
import type { SpaceSummary } from "../src/local/space.js";

test("WorkFoldKernel resolves explicit and cwd Space context with deepest-root precedence", async () => {
  const root = join(process.cwd(), "kernel-fixtures", "root");
  const nestedRoot = join(root, "nested");
  const rootId = "space-1111111111111111";
  const nestedId = "space-2222222222222222";
  const spaces = [
    space(rootId, "Root", root, "2026-01-02T00:00:00.000Z"),
    space(nestedId, "Nested", nestedRoot, "2026-01-03T00:00:00.000Z"),
  ];
  const kernel = kernelForSpaces(spaces);

  const explicit = await kernel.getContext({
    kind: "cli",
    spaceId: rootId,
    cwd: join(nestedRoot, "documents"),
  });
  assert.equal(explicit.kind, "work-fold.context");
  assert.equal(explicit.version, 1);
  assert.equal(explicit.resolution, "space_id");
  assert.equal(explicit.space?.id, rootId, "an explicit id must win over cwd inference");

  const inferred = await kernel.getContext({ kind: "cli", cwd: join(nestedRoot, "documents") });
  assert.equal(inferred.resolution, "cwd");
  assert.equal(inferred.space?.id, nestedId, "the deepest containing Space must win");

  const outside = await kernel.getContext({ kind: "cli", cwd: join(process.cwd(), "somewhere-else") });
  assert.equal(outside.resolution, "none");
  assert.equal(outside.space, null);

  const listed = await kernel.getSpaces({ kind: "renderer" });
  assert.equal(listed.kind, "work-fold.spaces");
  assert.equal(listed.version, 1);
  assert.deepEqual(listed.spaces.map((item) => item.id), [rootId, nestedId]);
  assert.notEqual(listed.spaces[0].location, spaces[0].location, "snapshots must not expose mutable registry objects");
});

test("WorkFoldKernel tracks and scopes running Assistant tasks", async () => {
  const root = join(process.cwd(), "kernel-tasks", "root");
  const otherRoot = join(process.cwd(), "kernel-tasks", "other");
  const rootId = "space-3333333333333333";
  const otherId = "space-4444444444444444";
  const spaces = [
    space(rootId, "Root", root),
    space(otherId, "Other", otherRoot),
  ];
  const timestamps = [new Date("2026-07-11T10:00:00.000Z"), new Date("2026-07-11T10:00:01.000Z")];
  const taskIds = ["task-turn", "task-compact"];
  const kernel = new WorkFoldKernel({
    ...spaceDependencies(spaces),
    now: () => timestamps.shift() ?? new Date("2026-07-11T10:00:02.000Z"),
    createTaskId: () => taskIds.shift() ?? "task-extra",
  });

  const turn = kernel.startTask({
    kind: "assistant_turn",
    spaceId: rootId,
    conversationId: "chat-one",
    actor: { kind: "assistant", spaceId: rootId, conversationId: "chat-one", cwd: root },
  });
  kernel.startTask({
    kind: "compaction",
    spaceId: otherId,
    conversationId: "chat-two",
    actor: { kind: "assistant", spaceId: otherId, conversationId: "chat-two", cwd: otherRoot },
  });

  const all = await kernel.getTasks({ kind: "system" });
  assert.equal(all.kind, "work-fold.tasks");
  assert.equal(all.version, 1);
  assert.equal(all.spaceId, null);
  assert.deepEqual(all.tasks.map((task) => task.id), ["task-turn", "task-compact"]);
  assert.equal(all.tasks[0].status, "running");

  const scoped = await kernel.getTasks({ kind: "cli", cwd: join(root, "notes") });
  assert.equal(scoped.spaceId, rootId);
  assert.deepEqual(scoped.tasks.map((task) => task.id), ["task-turn"]);

  const unmatched = await kernel.getTasks({ kind: "cli", cwd: join(process.cwd(), "outside-all-spaces") });
  assert.deepEqual(unmatched.tasks, [], "an unmatched scoped actor must not fall back to all tasks");
  assert.equal(kernel.finishTask(turn.id), true);
  assert.equal(kernel.finishTask(turn.id), false);
  assert.deepEqual((await kernel.getTasks({ kind: "cli", spaceId: rootId })).tasks, []);
});

test("WorkFoldKernel tracks experimental Check runs internally without changing work-fold.tasks v1", async () => {
  const root = join(process.cwd(), "kernel-check-tasks", "root");
  const spaceSummary = space("space-5555555555555555", "Root", root);
  const kernel = new WorkFoldKernel({
    ...spaceDependencies([spaceSummary]),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    createTaskId: () => "task-generated",
  });
  const actor = { kind: "system" as const, spaceId: spaceSummary.id };
  const before = JSON.stringify(await kernel.getTasks(actor));

  const task = kernel.startExperimentalCheckRunTask({
    id: "task-check-run",
    spaceId: spaceSummary.id,
    actor,
  });
  assert.deepEqual(task, {
    id: "task-check-run",
    kind: "check_run",
    status: "running",
    spaceId: spaceSummary.id,
    actor,
    startedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(
    JSON.stringify(await kernel.getTasks(actor)),
    before,
    "an internal check_run must be byte-invisible to the stable work-fold.tasks v1 snapshot",
  );
  assert.throws(
    () => kernel.startTask({
      id: task.id,
      kind: "assistant_turn",
      spaceId: spaceSummary.id,
      actor: { kind: "assistant", spaceId: spaceSummary.id },
    }),
    /already running/,
    "experimental and stable tasks must share lifecycle id ownership",
  );
  assert.equal(kernel.finishTask(task.id), true);
  assert.equal(kernel.finishTask(task.id), false);
  assert.equal(JSON.stringify(await kernel.getTasks(actor)), before);
});

test("WorkFoldKernel capability queries expose the shared stable catalog snapshot", async () => {
  const root = join(process.cwd(), "kernel-capabilities", "root");
  const spaceSummary = space("space-6666666666666666", "Capabilities", root);
  const packageSource = "npm:@demo/research@1.2.3";
  const catalog: PiResourceCatalog = {
    projectTrust: { required: true, trusted: true, savedDecision: true },
    packages: [],
    toolManagement: {
      mode: "session-only",
      persisted: false,
      mutable: false,
      scope: "chat",
      reason: "Tools belong to the Chat.",
    },
    tools: [{
      name: "read",
      label: "read",
      description: "Read a file",
      active: true,
      kind: "core",
      core: true,
      configurable: false,
      configurationScope: "chat",
      source: { path: "builtin:read", source: "builtin", scope: "user", origin: "top-level" },
    }],
    skills: [{
      name: "research",
      description: "Research carefully",
      path: join(root, ".pi", "npm", "research", "SKILL.md"),
      baseDir: root,
      disableModelInvocation: false,
      content: "# Research",
      source: { path: "skills/research/SKILL.md", source: packageSource, scope: "project", origin: "package", baseDir: root },
    }],
    extensions: [],
    surfaces: [{
      id: "research-pulse",
      title: "Research pulse",
      description: "Connected research status",
      icon: "pulse",
      extensionPath: join(root, ".pi", "npm", "research", "index.ts"),
      manifestPath: join(root, ".pi", "npm", "research", "surface.json"),
      source: { path: "index.ts", source: packageSource, scope: "project", origin: "package", baseDir: root },
      views: [{
        id: "overview",
        title: "Overview",
        blocks: [{ type: "metrics", items: [{ label: "Sources", value: "12" }] }],
      }],
    }],
    prompts: [],
    themes: [],
    contextFiles: [],
    commands: [{ name: "trust", description: "Show Space trust status", source: "builtin" }],
    diagnostics: [{ type: "collision", message: "A lower-precedence Skill was hidden." }],
  };
  const kernel = new WorkFoldKernel({
    ...spaceDependencies([spaceSummary]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{ source: packageSource, scope: "project", filtered: false, installedPath: join(root, ".pi", "npm", "research") }];
    },
    async isProjectMutationTrusted() { return true; },
  });

  const result = await kernel.getCapabilities({ kind: "cli", spaceId: spaceSummary.id });
  assert.equal(result.kind, "work-fold.capabilities");
  assert.equal(result.version, 1);
  assert.equal(result.space.id, spaceSummary.id);
  assert.deepEqual(result.catalog.projectTrust, { required: true, trusted: true, savedDecision: true, mutationTrusted: true });
  assert.equal(result.catalog.packages[0].loaded, true);
  assert.equal(result.catalog.skills[0].scope, "project");
  assert.equal(result.catalog.skills[0].packageSource, packageSource);
  assert.equal(result.catalog.skills[0].sourceInfo.label, `This Space · ${packageSource}`);
  assert.equal(result.catalog.surfaces[0].scope, "project");
  assert.equal(result.catalog.surfaces[0].views[0].blocks[0].type, "metrics");
  assert.equal(result.catalog.tools[0].scope, "global");
  assert.deepEqual(result.catalog.diagnostics, [{ type: "warning", message: "A lower-precedence Skill was hidden." }]);

  await assert.rejects(
    kernel.getCapabilities({ kind: "cli", cwd: join(process.cwd(), "not-a-space") }),
    (error: unknown) => error instanceof WorkFoldContextRequiredError && error.code === "WORKFOLD_CONTEXT_REQUIRED",
  );
});

function kernelForSpaces(spaces: SpaceSummary[]): WorkFoldKernel {
  return new WorkFoldKernel(spaceDependencies(spaces));
}

function spaceDependencies(spaces: SpaceSummary[]) {
  return {
    async listSpaces() { return spaces; },
    async getSpace(spaceId: string) {
      const spaceSummary = spaces.find((item) => item.id === spaceId);
      if (!spaceSummary) throw new Error(`Unknown Space: ${spaceId}`);
      return spaceSummary;
    },
  };
}

function space(
  id: string,
  name: string,
  spaceRoot: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
): SpaceSummary {
  return {
    id,
    name,
    spaceRoot,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}
