import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WorkFoldCheckOperationConflictError, WorkFoldCheckService } from "../src/local/checks/check-service.js";
import { WorkFoldCheckStore } from "../src/local/checks/check-store.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";

const proposal = {
  kind: "work-fold.check-proposal",
  version: 1,
  name: "Required handoff",
  createdBy: "human",
  createdAt: "2026-08-01T00:00:00.000Z",
  check: {
    title: "The signed handoff exists",
    severity: "error",
    trigger: "manual",
    sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "present" } },
    targets: [{ kind: "file", role: "primary", path: "Delivery/signed.pdf" }],
  },
} as const;

test("optional Checks complete proposal, grant, task, evidence, decision, stale, and clear lifecycle", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-service-"));
  const root = join(sandbox, "work-folder");
  const machine = join(sandbox, "machine");
  await mkdir(root);
  await mkdir(machine);
  const proposalPath = join(sandbox, "handoff.work-fold-check.json");
  await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`);

  const kernel = new WorkFoldKernel({ createTaskId: () => "unexpected-generated-task" });
  let taskCounter = 0;
  let runCounter = 0;
  const service = new WorkFoldCheckService({
    kernel,
    createTaskId: () => `check-task-${++taskCounter}`,
    createRunId: () => `check-run-${++runCounter}`,
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(machine, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-delivery", root)],
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-delivery", workFolderRoot: root };

  assert.deepEqual(await service.status(workFolder), {
    kind: "work-fold.checks.experimental",
    version: 1,
    workFolderId: workFolder.id,
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

  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const enabledAgain = await service.enable({ workFolder, proposalPath, actor: "human" });
  assert.equal(enabledAgain.declaration.id, enabled.declaration.id, "re-enabling the same proposal is idempotent");
  assert.equal((await readdir(join(root, ".work-fold", "checks"))).filter((name) => name.endsWith(".json")).length, 1);
  const neverRun = await service.status(workFolder);
  assert.equal(neverRun.state, "stale", "enabled but never run is not clear");
  assert.equal(neverRun.neverRun, 1, "enabled Checks awaiting their first run remain explicit");
  assert.equal(neverRun.stale, 0, "never-run Checks are not miscounted as changed prior results");
  const declarations = JSON.parse(await readFile(join(root, ".work-fold", "checks", `${enabled.declaration.id}.json`), "utf8"));
  assert.equal(declarations.sensor.id, "work-fold.file-presence");
  assert.equal("enabled" in declarations, false, "portable data must not carry machine authority");

  const accepted = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli", workFolderId: workFolder.id } });
  const during = await kernel.getTasks({ kind: "cli" });
  assert.deepEqual(during.tasks, [], "experimental Check tasks stay out of work-fold.tasks v1");
  const first = await waitForTerminal(service, workFolder.id, accepted.taskId);
  assert.equal(first.state, "succeeded");
  assert.equal(first.findings.length, 1);
  assert.equal(first.findings[0]?.evidence[0]?.kind, "path-state");
  assert.equal((await service.status(workFolder)).state, "needs-attention");

  const settledSummaries = await service.settledRuns(workFolder);
  assert.deepEqual(settledSummaries.map((run) => [run.runId, run.taskId, run.state, run.admittedCount]), [
    ["check-run-1", "check-task-1", "succeeded", 1],
  ], "settled-run summaries expose identifiers and counts for the overview");
  const summaryKeys = Object.keys(settledSummaries[0]!).sort();
  assert.deepEqual(
    summaryKeys,
    ["admittedCount", "endedAt", "runId", "startedAt", "state", "taskId"],
    "settled-run summaries stay content-free: no findings, evidence, inputs, or paths",
  );

  const problems = await service.problems(workFolder);
  assert.equal(problems.findings.length, 1);
  assert.deepEqual(await service.decorations(workFolder), {
    kind: "work-fold.checks.decorations",
    version: 1,
    workFolderId: workFolder.id,
    items: [{ path: "Delivery/signed.pdf", count: 1 }],
  });
  const rendererOverview = await service.overview(workFolder);
  assert.equal(rendererOverview.kind, "work-fold.checks.renderer");
  assert.equal(rendererOverview.status.state, "needs-attention");
  assert.equal(rendererOverview.checks.length, 1);
  assert.equal(rendererOverview.checks[0]?.authority, "enabled");
  assert.deepEqual(rendererOverview.checks[0]?.targets, proposal.check.targets);
  assert.equal(rendererOverview.findings[0]?.targetPath, "Delivery/signed.pdf");
  await assert.rejects(() => service.decide({
    workFolderId: workFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "defer",
    deferUntil: "2000-01-01T00:00:00.000Z",
    actor: "human",
  }), /future deferUntil/);
  await service.decide({
    workFolderId: workFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  });
  const decisionRevision = JSON.parse(await readFile(join(machine, `${workFolder.id}.json`), "utf8")).revision;
  await service.decide({
    workFolderId: workFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  });
  assert.equal(
    JSON.parse(await readFile(join(machine, `${workFolder.id}.json`), "utf8")).revision,
    decisionRevision,
    "an identical still-current decision does not rewrite machine state",
  );
  assert.equal((await service.problems(workFolder)).findings.length, 0);
  assert.equal((await service.status(workFolder)).state, "current-clear");

  await mkdir(join(root, "Delivery"));
  await writeFile(join(root, "Delivery", "signed.pdf"), "%PDF arbitrary bytes");
  assert.equal((await service.status(workFolder)).state, "stale");
  await assert.rejects(() => service.decide({
    workFolderId: workFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "resolve",
    actor: "human",
  }), (error: unknown) => error instanceof WorkFoldCheckOperationConflictError
    && /no longer current/.test(error.message));

  const rerun = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli", workFolderId: workFolder.id } });
  const clear = await waitForTerminal(service, workFolder.id, rerun.taskId);
  assert.equal(clear.state, "succeeded");
  assert.equal(clear.findings.length, 0);
  assert.equal((await service.status(workFolder)).state, "current-clear");
  await assert.rejects(() => service.decide({
    workFolderId: workFolder.id,
    findingId: problems.findings[0]!.id,
    decision: "reject",
    actor: "human",
  }), (error: unknown) => error instanceof WorkFoldCheckOperationConflictError
    && /no longer active/.test(error.message));

  await unlink(join(root, "Delivery", "signed.pdf"));
  const recurrence = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli", workFolderId: workFolder.id } });
  const recurred = await waitForTerminal(service, workFolder.id, recurrence.taskId);
  assert.equal(recurred.findings.length, 1);
  assert.equal((await service.problems(workFolder)).findings.length, 1, "a fixed finding that later recurs must not inherit an old resolve decision");
  assert.equal((await service.status(workFolder)).state, "needs-attention");
  assert.deepEqual(
    (await service.settledRuns(workFolder)).map((run) => run.runId).sort(),
    ["check-run-1", "check-run-2", "check-run-3"],
    "every terminal run keeps a content-free summary",
  );
});

test("accepted and running Check work is pending rather than a content or infrastructure error", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-running-status-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let enteredRun!: () => void;
  const running = new Promise<void>((resolve) => { enteredRun = resolve; });
  let releaseRun!: () => void;
  const release = new Promise<void>((resolve) => { releaseRun = resolve; });
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-running", root)],
    resolveSensor: (id, revision) => id === "work-fold.file-presence" && revision === 1 ? {
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
  const workFolder = { id: "work-folder-running", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await running;
  const status = await service.status(workFolder);
  assert.equal(status.running, 1);
  assert.equal(status.errors, 0);
  assert.notEqual(status.state, "check-error");
  releaseRun();
  await waitForTerminal(service, workFolder.id, accepted.taskId);
});

test("a rejected Check store creation is evicted so a repaired store can be retried", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-store-retry-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  let attempts = 0;
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    listWorkFolders: async () => [workFolderSummary("work-folder-retry", root)],
    storeFactory: async (workFolderId) => {
      attempts += 1;
      if (attempts === 1) throw new Error("damaged state");
      return WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, "repaired.json") });
    },
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-retry", workFolderRoot: root };
  await assert.rejects(() => service.status(workFolder), /damaged state/);
  assert.equal((await service.status(workFolder)).state, "not-configured");
  assert.equal(attempts, 2);
});

test("changed portable declarations lose exact machine authority", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-digest-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const kernel = new WorkFoldKernel();
  const service = new WorkFoldCheckService({
    kernel,
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-digest", root)],
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-digest", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const declarationPath = join(root, ".work-fold", "checks", `${enabled.declaration.id}.json`);
  const changed = JSON.parse(await readFile(declarationPath, "utf8"));
  changed.title = "Changed outside the enable act";
  await writeFile(declarationPath, JSON.stringify(changed));

  const status = await service.status(workFolder);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1);
  await assert.rejects(() => service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } }), /Enabled Check not found/);
});

test("damaged declarations are health errors, never an unconfigured or clear state", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-damaged-declaration-"));
  const root = join(sandbox, "work-folder");
  await mkdir(join(root, ".work-fold", "checks"), { recursive: true });
  await writeFile(join(root, ".work-fold", "checks", "damaged.json"), "{nope");
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-damaged", root)],
  });
  t.after(() => service.close());

  const status = await service.status({ id: "work-folder-damaged", workFolderRoot: root });
  assert.equal(status.state, "check-error");
  assert.equal(status.errors, 1);
});

test("the service binds a stable work-folder id to its registered folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-work-folder-binding-"));
  const root = join(sandbox, "work-folder");
  const wrongRoot = join(sandbox, "Other");
  await mkdir(root);
  await mkdir(wrongRoot);
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-bound", root)],
  });
  t.after(() => service.close());

  await assert.rejects(
    () => service.status({ id: "work-folder-bound", workFolderRoot: wrongRoot }),
    /does not match the registered work-folder's folder/,
  );

  const releaseRegistryMutation = service.tryReserveWorkFolderRegistryMutation();
  assert.ok(releaseRegistryMutation);
  await assert.rejects(
    () => service.status({ id: "work-folder-bound", workFolderRoot: root }),
    /current Check operation/,
    "evidence work cannot start while a work-folder registration may change target ownership",
  );
  releaseRegistryMutation();

  const releaseRemoval = service.tryReserveWorkFolderRemoval("work-folder-bound");
  assert.ok(releaseRemoval);
  await assert.rejects(
    () => service.status({ id: "work-folder-bound", workFolderRoot: root }),
    /current Check operation/,
    "status cannot start after Check cleanup has been reserved for work-folder removal",
  );
  releaseRemoval();
});

test("admission failure makes the run and status unhealthy, and status never executes a sensor", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-admission-health-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  let executions = 0;
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-health", root)],
    resolveSensor: (id, revision) => id === "work-fold.file-presence" && revision === 1 ? {
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
  const workFolder = { id: "work-folder-health", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  assert.equal(executions, 0);
  await service.status(workFolder);
  assert.equal(executions, 0, "content-free status cannot execute provider logic");

  const accepted = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, workFolder.id, accepted.taskId);
  assert.equal(run.state, "failed");
  assert.equal(run.discardedCount, 1);
  assert.equal((await service.status(workFolder)).state, "check-error");
  assert.equal(executions, 1, "status freshness remains runner-owned after the run");
});

test("terminal persistence failure retains the task fence until task polling repairs it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-terminal-recovery-"));
  const root = join(sandbox, "work-folder");
  const otherRoot = join(sandbox, "Other work-folder");
  await mkdir(root);
  await mkdir(otherRoot);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const store = await WorkFoldCheckStore.create("work-folder-recovery", { path: join(sandbox, "state.json") });
  const otherStore = await WorkFoldCheckStore.create("work-folder-other", { path: join(sandbox, "other-state.json") });
  const finishRun = store.finishRun.bind(store);
  let injectedFailures = 0;
  store.finishRun = async (run) => {
    if (run.state === "succeeded" && injectedFailures++ === 0) throw new Error("injected terminal write failure");
    return finishRun(run);
  };
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: async (workFolderId) => workFolderId === "work-folder-recovery" ? store : otherStore,
    listWorkFolders: async () => [workFolderSummary("work-folder-recovery", root), workFolderSummary("work-folder-other", otherRoot)],
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-recovery", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await waitForCondition(() => injectedFailures > 0);
  assert.equal(service.hasActiveRun(workFolder.id), true, "the capability fence remains while terminal state is not durable");

  const wrongWorkFolderStatus = await service.taskStatus("work-folder-other", accepted.taskId);
  assert.equal(wrongWorkFolderStatus.state, "unknown");
  assert.equal(service.hasActiveRun(workFolder.id), true, "another work-folder cannot terminalize or release this recovery task");

  const status = await service.taskStatus(workFolder.id, accepted.taskId);
  assert.equal(status.state, "succeeded");
  assert.equal(service.hasActiveRun(workFolder.id), false);
});

test("run-all supports the full declaration authority ceiling", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-many-run-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-many", root)],
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-many", workFolderRoot: root };
  for (let index = 0; index < 65; index += 1) {
    const proposalPath = join(sandbox, `proposal-${index}.json`);
    await writeFile(proposalPath, JSON.stringify({
      ...proposal,
      name: `Optional file ${index}`,
      check: {
        ...proposal.check,
        title: `Optional file ${index} stays absent`,
        sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } },
        targets: [{ kind: "file", role: "primary", path: `Files/item-${index}.txt` }],
      },
    }));
    await service.enable({ workFolder, proposalPath, actor: "human" });
  }

  const accepted = await service.run({ workFolder, actor: { kind: "renderer", workFolderId: workFolder.id } });
  assert.equal(accepted.checkIds.length, 65);
  assert.equal((await waitForTerminal(service, workFolder.id, accepted.taskId)).state, "succeeded");
});

test("run admission is synchronously reserved for every adapter", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-run-reservation-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify({
    ...proposal,
    check: { ...proposal.check, sensor: { ...proposal.check.sensor, parameters: { expect: "absent" } } },
  }));
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary("work-folder-reservation", root)],
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-reservation", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const first = service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  await assert.rejects(
    () => service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "renderer" } }),
    (error: unknown) => error instanceof WorkFoldCheckOperationConflictError
      && /current Check run/.test(error.message),
  );
  await assert.rejects(
    () => service.removeWorkFolder(workFolder.id),
    (error: unknown) => error instanceof WorkFoldCheckOperationConflictError
      && /current Check operation/.test(error.message),
    "a direct adapter cannot remove the work-folder during run admission",
  );
  const accepted = await first;
  await waitForTerminal(service, workFolder.id, accepted.taskId);
});

test("recorded findings cannot cross into a folder that later becomes another work-folder", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-late-nested-work-folder-"));
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
  const workFolders = [workFolderSummary("work-folder-parent", root)];
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => workFolders,
  });
  t.after(() => service.close());
  const workFolder = { id: "work-folder-parent", workFolderRoot: root };
  const enabled = await service.enable({ workFolder, proposalPath, actor: "human" });
  const accepted = await service.run({ workFolder, checkId: enabled.declaration.id, actor: { kind: "cli" } });
  const run = await waitForTerminal(service, workFolder.id, accepted.taskId);
  assert.equal(run.findings.length, 1);

  await mkdir(childRoot);
  workFolders.push(workFolderSummary("work-folder-child", childRoot));
  const problems = await service.problems(workFolder);
  assert.deepEqual(problems.findings, [], "old evidence must not be read or surfaced across the new work-folder boundary");
  assert.deepEqual(problems.healthErrors, ["A Check target now overlaps another registered work-folder."]);
  const status = await service.status(workFolder);
  assert.equal(status.blocked, 1);
  assert.equal(status.needsAttention, 0);
});

test("work-folder removal purges local Check authority so re-registration cannot revive it", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-check-removal-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(proposal));
  const statePath = join(sandbox, "state.json");
  const options = {
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId: string) => WorkFoldCheckStore.create(workFolderId, { path: statePath }),
    listWorkFolders: async () => [workFolderSummary("work-folder-removal", root)],
  };
  const service = new WorkFoldCheckService(options);
  t.after(() => service.close());
  const workFolder = { id: "work-folder-removal", workFolderRoot: root };
  const enabling = service.enable({ workFolder, proposalPath, actor: "human" });
  assert.equal(
    service.tryReserveWorkFolderRegistryMutation(),
    null,
    "work-folder registration cannot race target validation or declaration enablement",
  );
  await assert.rejects(
    () => service.removeWorkFolder(workFolder.id),
    /current Check operation/,
    "a direct adapter cannot remove the work-folder while enablement is materializing authority",
  );
  await enabling;
  assert.equal((await service.status(workFolder)).enabled, 1);
  await service.removeWorkFolder(workFolder.id);

  const reRegistered = new WorkFoldCheckService({ ...options, kernel: new WorkFoldKernel() });
  t.after(() => reRegistered.close());
  const status = await reRegistered.status(workFolder);
  assert.equal(status.enabled, 0);
  assert.equal(status.proposed, 1, "the portable declaration is discoverable but inert again");
});

async function waitForTerminal(service: WorkFoldCheckService, workFolderId: string, taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await service.taskStatus(workFolderId, taskId);
    if (status.state !== "accepted" && status.state !== "running") return service.taskResult(workFolderId, taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Check task.");
}

function workFolderSummary(id: string, workFolderRoot: string) {
  return {
    id,
    name: id,
    workFolderRoot,
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

test("selected Check results reverify one pinned declaration without running sensors or disclosing sibling Checks", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-selected-check-"));
  const root = join(sandbox, "work-folder");
  await mkdir(root);
  const workFolder = { id: "work-folder-selected", workFolderRoot: root };
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (workFolderId) => WorkFoldCheckStore.create(workFolderId, { path: join(sandbox, `${workFolderId}.json`) }),
    listWorkFolders: async () => [workFolderSummary(workFolder.id, root)],
  });
  t.after(() => service.close());
  const path = join(sandbox, "proposal.json");
  await writeFile(path, JSON.stringify(proposal));
  const selected = await service.enable({ workFolder, proposalPath: path, actor: "human" });
  await writeFile(path, JSON.stringify({ ...proposal, name: "Private unrelated", check: { ...proposal.check, title: "Secret unrelated title", targets: [{ kind: "file", role: "primary", path: "secret.txt" }] } }));
  const sibling = await service.enable({ workFolder, proposalPath: path, actor: "human" });
  const read = () => service.selectedResult(workFolder, selected.declaration.id, selected.digest);
  assert.equal((await read()).state, "never-run");
  assert.equal((await service.settledRuns(workFolder)).length, 0);
  const run = await service.run({ workFolder, actor: { kind: "cli", workFolderId: workFolder.id } });
  await waitForTerminal(service, workFolder.id, run.taskId);
  const result = await read();
  assert.equal(result.state, "needs-attention");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.path, "Delivery/signed.pdf");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes(sibling.declaration.id), false);
  assert.equal("workFolderRoot" in result, false);
  assert.equal("inputs" in result, false);
  await mkdir(join(root, "Delivery"));
  await writeFile(join(root, "Delivery", "signed.pdf"), "signed");
  const stale = await read();
  assert.equal(stale.state, "stale");
  assert.deepEqual(stale.findings, []);
  const rerun = await service.run({ workFolder, checkId: selected.declaration.id, actor: { kind: "cli", workFolderId: workFolder.id } });
  await waitForTerminal(service, workFolder.id, rerun.taskId);
  assert.equal((await read()).state, "current-clear");
  await service.disable(workFolder, selected.declaration.id);
  assert.equal((await read()).state, "blocked");
  await assert.rejects(service.selectedResult({ ...workFolder, workFolderRoot: sandbox }, selected.declaration.id, selected.digest));
  await assert.rejects(service.selectedResult(workFolder, selected.declaration.id, "0".repeat(64)), /changed or is unavailable/);
  const declarationPath = join(root, ".work-fold", "checks", `${selected.declaration.id}.json`);
  const declaration = JSON.parse(await readFile(declarationPath, "utf8"));
  declaration.title = "Changed rubric identity";
  await writeFile(declarationPath, JSON.stringify(declaration));
  await assert.rejects(read(), /changed or is unavailable/);
  assert.equal((await service.settledRuns(workFolder)).length, 2, "reads never launch runs");
});
