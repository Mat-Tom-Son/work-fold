import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { PiResourceCatalog } from "../src/local/agent/skill-catalog.js";
import {
  WorkFoldContextRequiredError,
  WorkFoldKernel,
} from "../src/local/work-fold-kernel.js";
import type { WorkFolderSummary } from "../src/local/work-folder.js";

test("WorkFoldKernel resolves explicit and cwd work-folder context with deepest-root precedence", async () => {
  const root = join(process.cwd(), "kernel-fixtures", "root");
  const nestedRoot = join(root, "nested");
  const rootId = "space-1111111111111111";
  const nestedId = "space-2222222222222222";
  const workFolders = [
    workFolder(rootId, "Root", root, "2026-01-02T00:00:00.000Z"),
    workFolder(nestedId, "Nested", nestedRoot, "2026-01-03T00:00:00.000Z"),
  ];
  const kernel = kernelForWorkFolders(workFolders);

  const explicit = await kernel.getContext({
    kind: "cli",
    workFolderId: rootId,
    cwd: join(nestedRoot, "documents"),
  });
  assert.equal(explicit.kind, "work-fold.context");
  assert.equal(explicit.version, 1);
  assert.equal(explicit.resolution, "work-folder_id");
  assert.equal(explicit.workFolder?.id, rootId, "an explicit id must win over cwd inference");

  const inferred = await kernel.getContext({ kind: "cli", cwd: join(nestedRoot, "documents") });
  assert.equal(inferred.resolution, "cwd");
  assert.equal(inferred.workFolder?.id, nestedId, "the deepest containing work-folder must win");

  const outside = await kernel.getContext({ kind: "cli", cwd: join(process.cwd(), "somewhere-else") });
  assert.equal(outside.resolution, "none");
  assert.equal(outside.workFolder, null);

  const listed = await kernel.getWorkFolders({ kind: "renderer" });
  assert.equal(listed.kind, "work-fold.work-folders");
  assert.equal(listed.version, 1);
  assert.deepEqual(listed.workFolders.map((item) => item.id), [rootId, nestedId]);
  assert.equal(listed.workFolders[0].parentWorkFolderId, undefined, "a top-level work-folder keeps its v1 shape");
  assert.equal(listed.workFolders[1].parentWorkFolderId, rootId, "a nested work-folder names the work-folder that contains it");
  assert.notEqual(listed.workFolders[0].location, workFolders[0].location, "snapshots must not expose mutable registry objects");
});

test("WorkFoldKernel tracks and scopes running Worker tasks", async () => {
  const root = join(process.cwd(), "kernel-tasks", "root");
  const otherRoot = join(process.cwd(), "kernel-tasks", "other");
  const rootId = "space-3333333333333333";
  const otherId = "space-4444444444444444";
  const workFolders = [
    workFolder(rootId, "Root", root),
    workFolder(otherId, "Other", otherRoot),
  ];
  const timestamps = [new Date("2026-07-11T10:00:00.000Z"), new Date("2026-07-11T10:00:01.000Z")];
  const taskIds = ["task-turn", "task-compact"];
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies(workFolders),
    now: () => timestamps.shift() ?? new Date("2026-07-11T10:00:02.000Z"),
    createTaskId: () => taskIds.shift() ?? "task-extra",
  });

  const turn = kernel.startTask({
    kind: "assistant_turn",
    workFolderId: rootId,
    conversationId: "chat-one",
    actor: { kind: "assistant", workFolderId: rootId, conversationId: "chat-one", cwd: root },
  });
  kernel.startTask({
    kind: "compaction",
    workFolderId: otherId,
    conversationId: "chat-two",
    actor: { kind: "assistant", workFolderId: otherId, conversationId: "chat-two", cwd: otherRoot },
  });

  const all = await kernel.getTasks({ kind: "system" });
  assert.equal(all.kind, "work-fold.tasks");
  assert.equal(all.version, 1);
  assert.equal(all.workFolderId, null);
  assert.deepEqual(all.tasks.map((task) => task.id), ["task-turn", "task-compact"]);
  assert.equal(all.tasks[0].status, "running");

  const scoped = await kernel.getTasks({ kind: "cli", cwd: join(root, "notes") });
  assert.equal(scoped.workFolderId, rootId);
  assert.deepEqual(scoped.tasks.map((task) => task.id), ["task-turn"]);

  const unmatched = await kernel.getTasks({ kind: "cli", cwd: join(process.cwd(), "outside-all-work-folders") });
  assert.deepEqual(unmatched.tasks, [], "an unmatched scoped actor must not fall back to all tasks");
  assert.equal(kernel.finishTask(turn.id), true);
  assert.equal(kernel.finishTask(turn.id), false);
  assert.deepEqual((await kernel.getTasks({ kind: "cli", workFolderId: rootId })).tasks, []);
});

test("WorkFoldKernel tracks experimental Check runs internally without changing work-fold.tasks v1", async () => {
  const root = join(process.cwd(), "kernel-check-tasks", "root");
  const workFolderSummary = workFolder("space-5555555555555555", "Root", root);
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    createTaskId: () => "task-generated",
  });
  const actor = { kind: "system" as const, workFolderId: workFolderSummary.id };
  const before = JSON.stringify(await kernel.getTasks(actor));

  const task = kernel.startExperimentalCheckRunTask({
    id: "task-check-run",
    workFolderId: workFolderSummary.id,
    actor,
  });
  assert.deepEqual(task, {
    id: "task-check-run",
    kind: "check_run",
    status: "running",
    workFolderId: workFolderSummary.id,
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
      workFolderId: workFolderSummary.id,
      actor: { kind: "assistant", workFolderId: workFolderSummary.id },
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
  const workFolderSummary = workFolder("space-6666666666666666", "Capabilities", root);
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
    commands: [{ name: "trust", description: "Show work-folder trust status", source: "builtin" }],
    diagnostics: [{ type: "collision", message: "A lower-precedence Skill was hidden." }],
  };
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    async loadCapabilityCatalog() { return catalog; },
    async listPackages() {
      return [{ source: packageSource, scope: "project", filtered: false, installedPath: join(root, ".pi", "npm", "research") }];
    },
    async isProjectMutationTrusted() { return true; },
  });

  const result = await kernel.getCapabilities({ kind: "cli", workFolderId: workFolderSummary.id });
  assert.equal(result.kind, "work-fold.capabilities");
  assert.equal(result.version, 1);
  assert.equal(result.workFolder.id, workFolderSummary.id);
  assert.deepEqual(result.catalog.projectTrust, { required: true, trusted: true, savedDecision: true, mutationTrusted: true });
  assert.equal(result.catalog.packages[0].loaded, true);
  assert.equal(result.catalog.skills[0].scope, "project");
  assert.equal(result.catalog.skills[0].packageSource, packageSource);
  assert.equal(result.catalog.skills[0].sourceInfo.label, `This work-folder only · ${packageSource}`);
  assert.equal(result.catalog.surfaces[0].scope, "project");
  assert.equal(result.catalog.surfaces[0].views[0].blocks[0].type, "metrics");
  assert.equal(result.catalog.tools[0].scope, "global");
  assert.deepEqual(result.catalog.diagnostics, [{ type: "warning", message: "A lower-precedence Skill was hidden." }]);

  await assert.rejects(
    kernel.getCapabilities({ kind: "cli", cwd: join(process.cwd(), "not-a-work-folder") }),
    (error: unknown) => error instanceof WorkFoldContextRequiredError && error.code === "WORKFOLD_CONTEXT_REQUIRED",
  );
});

test("WorkFoldKernel getGlance composes the actor-independent experimental digest", async () => {
  const root = join(process.cwd(), "kernel-overview", "root");
  const workFolderSummary = workFolder("space-7777777777777777", "Glance", root);
  const taskClock = [new Date("2026-08-10T11:00:00.000Z"), new Date("2026-08-10T11:05:00.000Z")];
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    now: () => taskClock.shift() ?? new Date("2026-08-10T12:00:00.000Z"),
    overviewSources: {
      // The kernel is the running-task registry: an injected reader for that
      // row must not displace it.
      runningTasks: async () => [{
        id: "task-imposter",
        kind: "assistant_turn",
        workFolderId: workFolderSummary.id,
        startedAt: "2026-08-10T11:59:00.000Z",
      }],
      settledTurns: async () => [{
        taskId: "task-old",
        workFolderId: workFolderSummary.id,
        conversationId: "chat-old",
        outcome: "succeeded",
        endedAt: "2026-08-10T09:00:00.000Z",
      }],
      checkpoints: async (workFolderRef) => workFolderRef.id === workFolderSummary.id
        ? [{
          checkpointId: "cp-1",
          createdAt: "2026-08-10T10:00:00.000Z",
          label: "Before cleanup",
          reason: "manual",
          scope: "full" as const,
        }]
        : [],
    },
    readOverviewSeen: async () => ({ popover: "2026-08-10T09:30:00.000Z/settled-turns:task-old" }),
  });
  kernel.startTask({
    id: "task-turn",
    kind: "assistant_turn",
    workFolderId: workFolderSummary.id,
    conversationId: "chat-live",
    actor: { kind: "assistant", workFolderId: workFolderSummary.id, conversationId: "chat-live" },
  });
  kernel.startExperimentalCheckRunTask({
    id: "task-check",
    workFolderId: workFolderSummary.id,
    actor: { kind: "system", workFolderId: workFolderSummary.id },
  });
  const tasksBefore = JSON.stringify(await kernel.getTasks({ kind: "system" }));

  const overview = await kernel.getOverview({ kind: "cli", workFolderId: `  ${workFolderSummary.id}  `, cwd: "  .  " });
  assert.equal(overview.kind, "work-fold.overview.experimental");
  assert.equal(overview.version, 0);
  assert.equal(overview.composedAt, "2026-08-10T12:00:00.000Z");
  assert.deepEqual(
    overview.running.map((item) => [item.id, item.kind]),
    [["kernel-tasks:task-turn", "assistant-turn"], ["kernel-tasks:task-check", "check-run"]],
    "the kernel's own registry feeds Running now, including the experimental check_run kind",
  );
  assert.equal(overview.running[0].workFolderName, "Glance");
  assert.deepEqual(overview.changes.map((item) => item.id), [
    "history-checkpoints:space-7777777777777777:cp-1",
    "settled-turns:task-old",
  ]);
  assert.equal(overview.cursor, "2026-08-10T10:00:00.000Z/history-checkpoints:space-7777777777777777:cp-1");
  assert.deepEqual(overview.seen, { popover: "2026-08-10T09:30:00.000Z/settled-turns:task-old" });
  assert.deepEqual(overview.unavailable, []);

  const unscoped = await kernel.getOverview({ kind: "renderer" });
  assert.equal(
    JSON.stringify(unscoped),
    JSON.stringify(overview),
    "the digest is management-scoped: a normalized work-folder-scoped actor must not change one byte",
  );

  assert.equal(
    JSON.stringify(await kernel.getTasks({ kind: "system" })),
    tasksBefore,
    "composing the experimental overview must be byte-invisible to stable work-fold.tasks v1",
  );

  kernel.finishTask("task-turn");
  kernel.finishTask("task-check");
  const settled = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(settled.running, [], "finished tasks leave Running now");
});

test("WorkFoldKernel tracks experimental automation runs internally, outside v1 tasks and the overview's running section", async () => {
  const root = join(process.cwd(), "kernel-automation-tasks", "root");
  const workFolderSummary = workFolder("space-9999999999999999", "automation", root);
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    createTaskId: () => "task-generated-automation",
  });
  const before = JSON.stringify(await kernel.getTasks({ kind: "system" }));

  const task = kernel.startExperimentalAutomationRunTask({
    automationId: "automation-digest",
    runId: "run-1",
    actor: { kind: "system" },
  });
  assert.deepEqual(task, {
    id: "task-generated-automation",
    kind: "automation_run",
    status: "running",
    automationId: "automation-digest",
    runId: "run-1",
    actor: { kind: "system" },
    startedAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(
    JSON.stringify(await kernel.getTasks({ kind: "system" })),
    before,
    "an internal routing_run must be byte-invisible to the stable work-fold.tasks v1 snapshot",
  );
  const overview = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(
    overview.running,
    [],
    "automation runs reach the overview through their receipts source, never as a kernel task item",
  );
  assert.throws(
    () => kernel.startExperimentalAutomationRunTask({ id: task.id, automationId: "other", runId: "run-2", actor: { kind: "system" } }),
    /already running/,
    "experimental and stable tasks must share lifecycle id ownership",
  );
  assert.throws(
    () => kernel.startExperimentalAutomationRunTask({ id: "task-blank-automation", automationId: "  ", runId: "run-3", actor: { kind: "system" } }),
    /automation id is required/,
  );
  assert.equal(kernel.finishTask(task.id), true);
  assert.equal(kernel.finishTask(task.id), false);
  assert.equal(JSON.stringify(await kernel.getTasks({ kind: "system" })), before);
});

test("WorkFoldKernel configureGlance attaches live readers post-construction without touching the task registry source", async () => {
  const root = join(process.cwd(), "kernel-overview-configure", "root");
  const workFolderSummary = workFolder("space-aaaaaaaaaaaaaaaa", "Late wiring", root);
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
  });
  const bare = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(bare.changes, [], "before wiring, injected kinds are absent");
  assert.deepEqual(bare.seen, {});

  kernel.configureOverview({
    sources: {
      settledTurns: async () => [{
        taskId: "task-late",
        workFolderId: workFolderSummary.id,
        conversationId: "chat-late",
        outcome: "succeeded" as const,
        endedAt: "2026-08-10T11:00:00.000Z",
      }],
      // The kernel's own registry must still win the running-tasks row.
      runningTasks: async () => [{
        id: "task-imposter",
        kind: "assistant_turn" as const,
        workFolderId: workFolderSummary.id,
        startedAt: "2026-08-10T11:59:00.000Z",
      }],
    },
    readSeen: async () => ({ popover: "2026-08-10T10:00:00.000Z/settled-turns:task-late" }),
  });
  const wired = await kernel.getOverview({ kind: "system" });
  assert.deepEqual(wired.changes.map((item) => item.id), ["settled-turns:task-late"]);
  assert.deepEqual(wired.seen, { popover: "2026-08-10T10:00:00.000Z/settled-turns:task-late" });
  assert.deepEqual(wired.running, [], "an injected running-tasks reader never displaces the kernel registry");
});

test("WorkFoldKernel getGlance treats a failed seen read as no markers", async () => {
  const root = join(process.cwd(), "kernel-overview-seen", "root");
  const workFolderSummary = workFolder("space-8888888888888888", "Seenless", root);
  const kernel = new WorkFoldKernel({
    ...workFolderDependencies([workFolderSummary]),
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    readOverviewSeen: async () => { throw new Error("marker store unreadable"); },
  });
  const overview = await kernel.getOverview({ kind: "renderer" });
  assert.deepEqual(overview.seen, {}, "losing markers only over-reports newness");
  assert.deepEqual(overview.unavailable, [], "the seen table is preference, not a digest source");
});

test("the experimental History-restore fence judges automation runs from the task registry and fails closed", async () => {
  const targetId = "space-9999999999999999";
  const otherId = "space-aaaaaaaaaaaaaaaa";
  const root = join(process.cwd(), "kernel-restore-fence", "root");
  const kernel = new WorkFoldKernel(workFolderDependencies([workFolder(targetId, "Target", root)]));
  const blockers = () => kernel.listExperimentalHistoryRestoreBlockers(targetId);

  // A quiet registry restores freely; a blank work-folder id is a caller bug.
  assert.deepEqual(await blockers(), []);
  await assert.rejects(() => kernel.listExperimentalHistoryRestoreBlockers("  "), /work-folder id/);

  // An active automation run with no configured reader fails closed: the
  // registry proves work is running, so unverifiable hops must not race a
  // restore.
  const run = kernel.startExperimentalAutomationRunTask({
    automationId: "automation-glue",
    runId: "run-1",
    actor: { kind: "system" },
  });
  let judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /automation run run-1 \(automation automation-glue\)/);
  assert.match(judged[0]!, /cannot be verified in this build/);

  // A reader that resolves the declared files-hop targets narrows the rule:
  // hops into other work-folders never block, a hop into this work-folder blocks.
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => [otherId] } });
  assert.deepEqual(await blockers(), []);
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => [otherId, targetId] } });
  judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /declares a files hop into this work-folder/);

  // An unknown automation and a failing reader both fail closed.
  kernel.configureHistoryRestoreFence({ sources: { automationRunFilesHopTargets: async () => null } });
  assert.match((await blockers())[0]!, /files-hop targets could not be verified/);
  kernel.configureHistoryRestoreFence({
    sources: { automationRunFilesHopTargets: async () => { throw new Error("store damaged"); } },
  });
  assert.match((await blockers())[0]!, /files-hop targets could not be verified/);

  // A settled run clears its half of the fence, and no ghost blocker survives.
  kernel.finishTask(run.id);
  assert.deepEqual(await blockers(), []);

  // The automation reader blocks on runs whose app holds a file grant into
  // this work-folder, and a configured reader that fails blocks too (fail closed).
  kernel.configureHistoryRestoreFence({
    sources: {
      appAutomationRunsWithFileGrantInto: async (workFolderId) => workFolderId === targetId
        ? [{ appId: "connected-inbox", appAutomationId: "daily-sync", runId: "run-9" }]
        : [],
    },
  });
  judged = await blockers();
  assert.equal(judged.length, 1);
  assert.match(judged[0]!, /app automation daily-sync of connected-inbox \(run run-9\)/);
  assert.match(judged[0]!, /file grant into this work-folder/);
  kernel.configureHistoryRestoreFence({
    sources: { appAutomationRunsWithFileGrantInto: async () => { throw new Error("no machine-wide accessor"); } },
  });
  assert.match((await blockers())[0]!, /could not be verified/);

  // Agent-turn and compaction fencing stays with the act facade's live
  // route state; those task kinds alone never trip the kernel fence.
  kernel.configureHistoryRestoreFence({ sources: {} });
  kernel.startTask({
    kind: "assistant_turn",
    workFolderId: targetId,
    conversationId: "chat-one",
    actor: { kind: "assistant", workFolderId: targetId, conversationId: "chat-one", cwd: root },
  });
  assert.deepEqual(await blockers(), []);
});

function kernelForWorkFolders(workFolders: WorkFolderSummary[]): WorkFoldKernel {
  return new WorkFoldKernel(workFolderDependencies(workFolders));
}

function workFolderDependencies(workFolders: WorkFolderSummary[]) {
  return {
    async listWorkFolders() { return workFolders; },
    async getWorkFolder(workFolderId: string) {
      const workFolderSummary = workFolders.find((item) => item.id === workFolderId);
      if (!workFolderSummary) throw new Error(`Unknown work-folder: ${workFolderId}`);
      return workFolderSummary;
    },
  };
}

function workFolder(
  id: string,
  name: string,
  workFolderRoot: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
): WorkFolderSummary {
  return {
    id,
    name,
    workFolderRoot,
    location: { kind: "local", storage: "linked" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}
