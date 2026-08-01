import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkspaceCheckOperationConflictError, WorkspaceCheckService } from "../src/local/checks/check-service.js";
import { WorkspaceCheckStore } from "../src/local/checks/check-store.js";
import { WorkspaceKernel } from "../src/local/workspace-kernel.js";

const proposal = {
  kind: "workspace.check-proposal",
  version: 1,
  name: "Required handoff",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed handoff exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "workspace.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
  },
} as const;

test("optional Checks complete proposal, grant, task, evidence, decision, stale, and clear lifecycle", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-service-"));
  const root = join(sandbox, "Space");
  const machine = join(sandbox, "machine");
  await mkdir(root);
  await mkdir(machine);
  const proposalPath = join(sandbox, "handoff.workspace-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

  const kernel = new WorkspaceKernel({ createTaskId: () => "unexpected-generated-task" });
  let taskCounter = 0;
  let runCounter = 0;
  const service = new WorkspaceCheckService({
    kernel,
    createTaskId: () => `check-task-${++taskCounter}`,
    createRunId: () => `check-run-${++runCounter}`,
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(machine, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-delivery", root)],
  });
  t.after(() => service.close());
  const space = { id: "space-delivery", rootPath: root };

  assert.deepEqual(await service.status(space), {
    kind: "workspace.checks.experimental",
    version: 0,
    workspaceId: space.id,
    state: "not-configured",
    configured: 0,
    proposed: 0,
    enabled: 0,
    current: 0,
    neverRun: 0,
    stale: 0,
    blocked: 0,
    errors: 0,
    needsAttention: 0,
    running: 0,
    lastRunAt: null,
  });

  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const enabledAgain = await service.enable({ space, proposalPath, actor: "human" });
  assert.equal(enabledAgain.declaration.id, enabled.declaration.id, "re-enabling the same proposal is idempotent");
  assert.equal((await readdir(join(root, ".workspace", "checks"))).filter((name) => name.endsWith(".json")).length, 1);
  const neverRun = await service.status(space);
  assert.equal(neverRun.state, "stale", "enabled but never run is not clear");
  assert.equal(neverRun.neverRun, 1, "enabled Checks awaiting their first run remain explicit");
  assert.equal(neverRun.stale, 0, "never-run Checks are not miscounted as changed prior results");
  const declarations = JSON.parse(await readFile(join(root, ".workspace", "checks", `${enabled.declaration.id}.json`), "utf8"));
  assert.equal(declarations.sensor.id, "workspace.file-presence");
  assert.equal("enabled" in declarations, false, "portable data must not carry machine authority");

  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli", workspaceId: space.id } });
  const during = await kernel.getTasks({ kind: "cli" });
  assert.deepEqual(during.tasks, [], "experimental Check tasks stay out of workspace.tasks v1");
  const first = await waitForTerminal(service, space.id, accepted.taskId);
  assert.equal(first.state, "succeeded");
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0]?.evidence[0]?.kind, "path-state");
  assert.equal((await service.status(space)).state, "needs-attention");

  const problems = await service.problems(space);
  assert.equal(problems.findings.length, 1);
  assert.deepEqual(await service.decorations(space), {
    kind: "workspace.checks.decorations",
    version: 0,
    workspaceId: space.id,
    items: [{ path: "Delivery/signed.pdf", count: 1 }],
  });
  const rendererOverview = await service.overview(space);
  assert.equal(rendererOverview.kind, "workspace.checks.renderer");
  assert.equal(rendererOverview.status.state, "needs-attention");
  assert.equal(rendererOverview.checks.length, 1);
  assert.equal(rendererOverview.checks[0]?.authority, "enabled");
  assert.deepEqual(rendererOverview.checks[0]?.targets, proposal.check.targets);
  assert.equal(rendererOverview.findings[0]?.targetPath, "Delivery/signed.pdf");
  await assert.rejects(() => service.decide({
    spaceId: space.id,
    findingId: problems.findings[0]!.id,
    decision: "defer",
    deferUntil: "2000-01-01T00:00:00.000Z",
    actor: "human",
  }), /future deferUntil/);
  await service.decide({
    spaceId: space.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  });
  assert.equal((await service.problems(space)).findings.length, 0);
  assert.equal((await service.status(space)).state, "current-clear");

  await mkdir(join(root, "Delivery"));
  await writeFile(join(root, "Delivery", "signed.pdf"), "%PDF arbitrary bytes");
  assert.equal((await service.status(space)).state, "stale");

  const rerun = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli", workspaceId: space.id } });
  const clear = await waitForTerminal(service, space.id, rerun.taskId);
  assert.equal(clear.state, "succeeded");
  assert.equal(clear.findings.length, 0);
  assert.equal((await service.status(space)).state, "current-clear");
  await assert.rejects(() => service.decide({
    spaceId: space.id,
    findingId: problems.findings[0]!.id,
    decision: "reject",
    actor: "human",
  }), (error: unknown) => error instanceof WorkspaceCheckOperationConflictError
    && /no longer active/.test(error.message));

  await unlink(join(root, "Delivery", "signed.pdf"));
  const recurrence = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli", workspaceId: space.id } });
  const recurred = await waitForTerminal(service, space.id, recurrence.taskId);
  assert.equal(recurred.findings.length, 1);
  assert.equal((await service.problems(space)).findings.length, 1, "a fixed finding that later recurs must not inherit an old resolve decision");
  assert.equal((await service.status(space)).state, "needs-attention");
});

test("accepted and running Check work is pending rather than a content or infrastructure error", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-running-status-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let enteredRun!: () => void;
  const running = new Promise<void>((resolve) => { enteredRun = resolve; });
  let releaseRun!: () => void;
  const release = new Promise<void>((resolve) => { releaseRun = resolve; });
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-running", root)],
    resolveSensor: (id, revision) => id === "workspace.file-presence" && revision === 1 ? {
      id,
      revision,
      implementationDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      execution: "deterministic",
      validate() {},
      async run() {
        enteredRun();
        await release;
        return { candidates: [], skippedCount: 0 };
      },
    } : null,
  });
  t.after(() => service.close());
  const space = { id: "space-running", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await running;
  const status = await service.status(space);
  assert.equal(status.running, 1);
  assert.equal(status.errors, 0);
  assert.notEqual(status.state, "check-error");
  releaseRun();
  await waitForTerminal(service, space.id, accepted.taskId);
});

test("a rejected Check store creation is evicted so a repaired store can be retried", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-store-retry-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  let attempts = 0;
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    listSpaces: async () => [spaceSummary("space-retry", root)],
    storeFactory: async (workspaceId) => {
      attempts += 1;
      if (attempts === 1) throw new Error("damaged state");
      return WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, "repaired.json") });
    },
  });
  t.after(() => service.close());
  const space = { id: "space-retry", rootPath: root };
  await assert.rejects(() => service.status(space), /damaged state/);
  assert.equal((await service.status(space)).state, "not-configured");
  assert.equal(attempts, 2);
});

test("changed portable declarations lose exact machine authority", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-digest-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const kernel = new WorkspaceKernel();
  const service = new WorkspaceCheckService({
    kernel,
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-digest", root)],
  });
  t.after(() => service.close());
  const space = { id: "space-digest", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const declarationPath = join(root, ".workspace", "checks", `${enabled.declaration.id}.json`);
  const changed = JSON.parse(await readFile(declarationPath, "utf8"));
  changed.title = "Changed outside the enable act";
  await writeFile(declarationPath, JSON.stringify(changed));

  const status = await service.status(space);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1);
  await assert.rejects(() => service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } }), /Enabled Check not found/);
});

test("damaged declarations are health errors, never an unconfigured or clear state", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-damaged-declaration-"));
  const root = join(sandbox, "Space");
  await mkdir(join(root, ".workspace", "checks"), { recursive: true });
  await writeFile(join(root, ".workspace", "checks", "damaged.json"), "{nope");
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-damaged", root)],
  });
  t.after(() => service.close());

  const status = await service.status({ id: "space-damaged", rootPath: root });
  assert.equal(status.state, "check-error");
  assert.equal(status.errors, 1);
});

test("the service binds a stable Space id to its registered folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-space-binding-"));
  const root = join(sandbox, "Space");
  const wrongRoot = join(sandbox, "Other");
  await mkdir(root);
  await mkdir(wrongRoot);
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-bound", root)],
  });
  t.after(() => service.close());

  await assert.rejects(
    () => service.status({ id: "space-bound", rootPath: wrongRoot }),
    /does not match the registered Space folder/,
  );

  const releaseRegistryMutation = service.tryReserveSpaceRegistryMutation();
  assert.ok(releaseRegistryMutation);
  await assert.rejects(
    () => service.status({ id: "space-bound", rootPath: root }),
    /current Check operation/,
    "evidence work cannot start while a Space registration may change target ownership",
  );
  releaseRegistryMutation();

  const releaseRemoval = service.tryReserveSpaceRemoval("space-bound");
  assert.ok(releaseRemoval);
  await assert.rejects(
    () => service.status({ id: "space-bound", rootPath: root }),
    /current Check operation/,
    "status cannot start after Check cleanup has been reserved for Space removal",
  );
  releaseRemoval();
});

test("admission failure makes the run and status unhealthy, and status never executes a sensor", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-admission-health-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let executions = 0;
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-health", root)],
    resolveSensor: (id, revision) => id === "workspace.file-presence" && revision === 1 ? {
      id,
      revision,
      implementationDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      execution: "deterministic",
      validate() {},
      async run({ declaration }) {
        executions += 1;
        const path = declaration.targets[0]!.path;
        return {
          skippedCount: 0,
          candidates: [{
            title: "Fabricated observation",
            targetPath: path,
            evidence: [{
              kind: "path-state",
              path,
              expected: "missing",
              observed: "file",
              identity: { checkId: declaration.id, path, state: "file" },
            }],
          }],
        };
      },
    } : null,
  });
  t.after(() => service.close());
  const space = { id: "space-health", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  assert.equal(executions, 0);
  await service.status(space);
  assert.equal(executions, 0, "content-free status cannot execute provider logic");

  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, space.id, accepted.taskId);
  assert.equal(run.state, "failed");
  assert.equal(run.discardedCount, 1);
  assert.equal((await service.status(space)).state, "check-error");
  assert.equal(executions, 1, "status freshness remains runner-owned after the run");
});

test("terminal persistence failure retains the task fence until task polling repairs it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-terminal-recovery-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const store = await WorkspaceCheckStore.create("space-recovery", { path: join(sandbox, "state.json") });
  const finishRun = store.finishRun.bind(store);
  let injectedFailures = 0;
  store.finishRun = async (run) => {
    if (run.state === "succeeded" && injectedFailures++ === 0) throw new Error("injected terminal write failure");
    return finishRun(run);
  };
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: async () => store,
    listSpaces: async () => [spaceSummary("space-recovery", root)],
  });
  t.after(() => service.close());
  const space = { id: "space-recovery", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await waitForCondition(() => injectedFailures > 0);
  assert.equal(service.hasActiveRun(space.id), true, "the capability fence remains while terminal state is not durable");

  const status = await service.taskStatus(space.id, accepted.taskId);
  assert.equal(status.state, "succeeded");
  assert.equal(service.hasActiveRun(space.id), false);
});

test("run admission is synchronously reserved for every adapter", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-run-reservation-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => [spaceSummary("space-reservation", root)],
  });
  t.after(() => service.close());
  const space = { id: "space-reservation", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const first = service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await assert.rejects(
    () => service.run({ space, checkId: enabled.declaration.id, actor: { kind: "renderer" } }),
    (error: unknown) => error instanceof WorkspaceCheckOperationConflictError
      && /current Check run/.test(error.message),
  );
  await assert.rejects(
    () => service.removeSpace(space.id),
    (error: unknown) => error instanceof WorkspaceCheckOperationConflictError
      && /current Check operation/.test(error.message),
    "a direct adapter cannot remove the Space during run admission",
  );
  const accepted = await first;
  await waitForTerminal(service, space.id, accepted.taskId);
});

test("recorded findings cannot cross into a folder that later becomes another Space", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-late-nested-space-"));
  const root = join(sandbox, "Parent");
  const childRoot = join(root, "Child");
  await mkdir(root);
  const proposalPath = join(sandbox, "nested-target.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: {
      ...proposal.check,
      targets: [{ kind: "file", role: "primary", path: "Child/report.pdf" }],
    },
  }));
  const spaces = [spaceSummary("space-parent", root)];
  const service = new WorkspaceCheckService({
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId) => WorkspaceCheckStore.create(workspaceId, { path: join(sandbox, `${workspaceId}.json`) }),
    listSpaces: async () => spaces,
  });
  t.after(() => service.close());
  const space = { id: "space-parent", rootPath: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const accepted = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, space.id, accepted.taskId);
  assert.equal(run.findings.length, 1);

  await mkdir(childRoot);
  spaces.push(spaceSummary("space-child", childRoot));
  const problems = await service.problems(space);
  assert.deepEqual(problems.findings, [], "old evidence must not be read or surfaced across the new Space boundary");
  assert.deepEqual(problems.healthErrors, ["A Check target now overlaps another registered Space."]);
  const status = await service.status(space);
  assert.equal(status.blocked, 1);
  assert.equal(status.needsAttention, 0);
});

test("Space removal purges local Check authority so re-registration cannot revive it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "workspace-check-removal-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const statePath = join(sandbox, "state.json");
  const options = {
    kernel: new WorkspaceKernel(),
    storeFactory: (workspaceId: string) => WorkspaceCheckStore.create(workspaceId, { path: statePath }),
    listSpaces: async () => [spaceSummary("space-removal", root)],
  };
  const service = new WorkspaceCheckService(options);
  t.after(() => service.close());
  const space = { id: "space-removal", rootPath: root };
  const enabling = service.enable({ space, proposalPath, actor: "human" });
  assert.equal(
    service.tryReserveSpaceRegistryMutation(),
    null,
    "Space registration cannot race target validation or declaration enablement",
  );
  await assert.rejects(
    () => service.removeSpace(space.id),
    /current Check operation/,
    "a direct adapter cannot remove the Space while enablement is materializing authority",
  );
  await enabling;
  assert.equal((await service.status(space)).enabled, 1);
  await service.removeSpace(space.id);

  const reRegistered = new WorkspaceCheckService({ ...options, kernel: new WorkspaceKernel() });
  t.after(() => reRegistered.close());
  const status = await reRegistered.status(space);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1, "the portable declaration is discoverable but inert again");
});

async function waitForTerminal(service: WorkspaceCheckService, spaceId: string, taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await service.taskStatus(spaceId, taskId);
    if (status.state !== "accepted" && status.state !== "running") return service.taskResult(spaceId, taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Check task.");
}

function spaceSummary(id: string, rootPath: string) {
  return {
    id,
    name: id,
    rootPath,
    location: { kind: "local" as const, storage: "linked" as const },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
