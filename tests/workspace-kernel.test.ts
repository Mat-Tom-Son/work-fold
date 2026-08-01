import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  WorkspaceContextRequiredError,
  WorkspaceKernel,
} from "../src/local/workspace-kernel.js";
import type { WorkspaceSummary } from "../src/local/workspace.js";

test("WorkspaceKernel resolves explicit and cwd Space context with deepest-root precedence", async () => {
  const root = join(process.cwd(), "kernel-fixtures", "root");
  const nestedRoot = join(root, "nested");
  const spaces = [
    space("ws-root", "Root", root, "2026-01-02T00:00:00.000Z"),
    space("ws-nested", "Nested", nestedRoot, "2026-01-03T00:00:00.000Z"),
  ];
  const kernel = kernelForSpaces(spaces);

  const explicit = await kernel.getContext({
    kind: "cli",
    workspaceId: "ws-root",
    cwd: join(nestedRoot, "documents"),
  });
  assert.equal(explicit.resolution, "workspace_id");
  assert.equal(explicit.workspace?.id, "ws-root", "an explicit id must win over cwd inference");

  const inferred = await kernel.getContext({ kind: "cli", cwd: join(nestedRoot, "documents") });
  assert.equal(inferred.resolution, "cwd");
  assert.equal(inferred.workspace?.id, "ws-nested", "the deepest containing Space must win");

  const outside = await kernel.getContext({ kind: "cli", cwd: join(process.cwd(), "somewhere-else") });
  assert.equal(outside.resolution, "none");
  assert.equal(outside.workspace, null);

  const listed = await kernel.getSpaces({ kind: "renderer" });
  assert.deepEqual(listed.spaces.map((item) => item.id), ["ws-root", "ws-nested"]);
  assert.notEqual(listed.spaces[0].location, spaces[0].location, "snapshots must not expose mutable registry objects");
});

test("WorkspaceKernel tracks and scopes running Assistant tasks", async () => {
  const root = join(process.cwd(), "kernel-tasks", "root");
  const otherRoot = join(process.cwd(), "kernel-tasks", "other");
  const spaces = [
    space("ws-root", "Root", root),
    space("ws-other", "Other", otherRoot),
  ];
  const timestamps = [new Date("2026-07-11T10:00:00.000Z"), new Date("2026-07-11T10:00:01.000Z")];
  const taskIds = ["task-turn", "task-compact"];
  const kernel = new WorkspaceKernel({
    ...spaceDependencies(spaces),
    now: () => timestamps.shift() ?? new Date("2026-07-11T10:00:02.000Z"),
    createTaskId: () => taskIds.shift() ?? "task-extra",
  });

  const turn = kernel.startTask({
    kind: "assistant_turn",
    workspaceId: "ws-root",
    conversationId: "chat-one",
    actor: { kind: "assistant", workspaceId: "ws-root", conversationId: "chat-one", cwd: root },
  });
  kernel.startTask({
    kind: "compaction",
    workspaceId: "ws-other",
    conversationId: "chat-two",
    actor: { kind: "assistant", workspaceId: "ws-other", conversationId: "chat-two", cwd: otherRoot },
  });

  const all = await kernel.getTasks({ kind: "system" });
  assert.equal(all.workspaceId, null);
  assert.deepEqual(all.tasks.map((task) => task.id), ["task-turn", "task-compact"]);
  assert.equal(all.tasks[0].status, "running");

  const scoped = await kernel.getTasks({ kind: "cli", cwd: join(root, "notes") });
  assert.equal(scoped.workspaceId, "ws-root");
  assert.deepEqual(scoped.tasks.map((task) => task.id), ["task-turn"]);

  const unmatched = await kernel.getTasks({ kind: "cli", cwd: join(process.cwd(), "outside-all-spaces") });
  assert.deepEqual(unmatched.tasks, [], "an unmatched scoped actor must not fall back to all tasks");
  assert.equal(kernel.finishTask(turn.id), true);
  assert.equal(kernel.finishTask(turn.id), false);
  assert.deepEqual((await kernel.getTasks({ kind: "cli", workspaceId: "ws-root" })).tasks, []);
});

test("WorkspaceKernel tracks experimental Check runs internally without changing workspace.tasks v1", async () => {
  const root = join(process.cwd(), "kernel-check-tasks", "root");
  const workspace = space("ws-root", "Root", root);
  const kernel = new WorkspaceKernel({
    ...spaceDependencies([workspace]),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    createTaskId: () => "task-generated",
  });
  const actor = { kind: "system" as const, workspaceId: workspace.id };
  const before = JSON.stringify(await kernel.getTasks(actor));

  const task = kernel.startExperimentalCheckRunTask({
    id: "task-check-run",
    workspaceId: workspace.id,
    actor,
  });
  assert.deepEqual(task, {
    id: "task-check-run",
    kind: "check_run",
    status: "running",
    workspaceId: workspace.id,
    actor,
    startedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.equal(
    JSON.stringify(await kernel.getTasks(actor)),
    before,
    "an internal check_run must be byte-invisible to the stable workspace.tasks v1 snapshot",
  );
  assert.throws(
    () => kernel.startTask({
      id: task.id,
      kind: "assistant_turn",
      workspaceId: workspace.id,
      actor: { kind: "assistant", workspaceId: workspace.id },
    }),
    /already running/,
    "experimental and stable tasks must share lifecycle id ownership",
  );
  assert.equal(kernel.finishTask(task.id), true);
  assert.equal(kernel.finishTask(task.id), false);
  assert.equal(JSON.stringify(await kernel.getTasks(actor)), before);
});

test("WorkspaceKernel capability queries expose the shared stable catalog snapshot", async () => {
  const root = join(process.cwd(), "kernel-capabilities", "root");
  const workspace = space("ws-capabilities", "Capabilities", root);
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
  const kernel = new WorkspaceKernel({
    ...spaceDependencies([workspace]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{ source: packageSource, scope: "project", filtered: false, installedPath: join(root, ".pi", "npm", "research") }];
    },
    async isProjectMutationTrusted() { return true; },
  });

  const result = await kernel.getCapabilities({ kind: "cli", workspaceId: workspace.id });
  assert.equal(result.kind, "workspace.capabilities");
  assert.equal(result.workspace.id, workspace.id);
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
    (error: unknown) => error instanceof WorkspaceContextRequiredError && error.code === "WORKSPACE_CONTEXT_REQUIRED",
  );
});

function kernelForSpaces(spaces: WorkspaceSummary[]): WorkspaceKernel {
  return new WorkspaceKernel(spaceDependencies(spaces));
}

function spaceDependencies(spaces: WorkspaceSummary[]) {
  return {
    async listWorkspaces() { return spaces; },
    async getWorkspace(workspaceId: string) {
      const workspace = spaces.find((item) => item.id === workspaceId);
      if (!workspace) throw new Error(`Unknown Space: ${workspaceId}`);
      return workspace;
    },
  };
}

function space(
  id: string,
  name: string,
  rootPath: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
): WorkspaceSummary {
  return {
    id,
    name,
    rootPath,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}
