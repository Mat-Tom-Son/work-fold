import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RestrictedAppService } from "../src/local/agent/restricted-app-service.js";
import { WorkFoldCheckService } from "../src/local/checks/check-service.js";
import { WorkFoldCheckStore } from "../src/local/checks/check-store.js";
import {
  WorkFoldSettleSignal,
  type WorkFoldAppAutomationRunSettleRecord,
  type WorkFoldCheckRunSettleRecord,
  type WorkFoldRoutingHopLineage,
  type WorkFoldSettleRecord,
} from "../src/local/routings/settle-signal.js";
import { WorkFoldKernel } from "../src/local/work-fold-kernel.js";

const checkRunRecord: WorkFoldCheckRunSettleRecord = {
  kind: "check-run",
  spaceId: "space-shape",
  runId: "check-run-1",
  taskId: "check-task-1",
  checkIds: ["check-1"],
  state: "succeeded",
  startedAt: "2026-08-10T17:00:00.000Z",
  endedAt: "2026-08-10T17:00:01.000Z",
};

const automationRunRecord: WorkFoldAppAutomationRunSettleRecord = {
  kind: "app-automation-run",
  spaceId: "space-shape",
  appId: "connected-inbox",
  automationId: "refresh-mail",
  runId: "automation-run-1",
  outcome: "success",
  reason: "scheduled",
  scheduledAt: "2026-08-10T17:00:00.000Z",
  startedAt: "2026-08-10T17:00:00.100Z",
  finishedAt: "2026-08-10T17:00:00.900Z",
};

const lineage: WorkFoldRoutingHopLineage = {
  kind: "routing-hop",
  routingId: "routing-1",
  routingRunId: "routing-run-1",
  hopId: "verify",
};

test("settle records reach listeners in publication order as isolated copies", () => {
  const signal = new WorkFoldSettleSignal();
  const deliveries: string[] = [];
  signal.subscribe((record) => {
    deliveries.push(`one:${record.runId}`);
    if (record.kind === "check-run") {
      record.checkIds.push("mutant");
      record.state = "failed";
    }
  });
  signal.subscribe((record) => {
    deliveries.push(`two:${record.runId}`);
    if (record.kind === "check-run") {
      assert.deepEqual(record.checkIds, ["check-1"], "one listener's mutation must not reach another");
      assert.equal(record.state, "succeeded");
      assert.deepEqual(record.lineage, lineage);
    }
  });

  const published = structuredClone(checkRunRecord);
  published.lineage = structuredClone(lineage);
  signal.publish(published);
  signal.publish(automationRunRecord);

  assert.deepEqual(deliveries, [
    "one:check-run-1",
    "two:check-run-1",
    "one:automation-run-1",
    "two:automation-run-1",
  ]);
  assert.deepEqual(published.checkIds, ["check-1"], "listeners must not mutate the publisher's record");
  assert.equal("lineage" in automationRunRecord, false, "publication must not decorate the caller's record");
  assert.deepEqual(signal.listListenerErrors(), []);
});

test("listener failures are bounded diagnostics, never a publisher error", async () => {
  const signal = new WorkFoldSettleSignal({
    now: () => new Date("2026-08-10T18:00:00.000Z"),
    maxListenerErrors: 2,
  });
  const received: string[] = [];
  signal.subscribe(() => {
    throw new Error(`sync listener bug ${"x".repeat(400)}`);
  });
  signal.subscribe(async () => {
    throw new Error("async listener bug");
  });
  signal.subscribe((record) => {
    received.push(record.runId);
  });

  signal.publish(checkRunRecord);
  await waitForCondition(() => signal.listListenerErrors().length === 2);
  assert.deepEqual(received, ["check-run-1"], "a failing listener never blocks delivery to the rest");
  const [syncError, asyncError] = signal.listListenerErrors();
  assert.equal(syncError?.recordKind, "check-run");
  assert.equal(syncError?.runId, "check-run-1");
  assert.equal(syncError?.occurredAt, "2026-08-10T18:00:00.000Z");
  assert.equal(syncError?.error.length, 300, "listener error text is bounded");
  assert.equal(syncError?.error.endsWith("…"), true);
  assert.equal(asyncError?.error, "async listener bug");

  signal.publish(automationRunRecord);
  await waitForCondition(() => {
    const errors = signal.listListenerErrors();
    return errors.length === 2 && errors.every((error) => error.runId === "automation-run-1");
  });
  assert.deepEqual(
    signal.listListenerErrors().map((error) => error.runId),
    ["automation-run-1", "automation-run-1"],
    "overflow drops the oldest diagnostics",
  );
});

test("subscription capacity is bounded and unsubscribe is idempotent", () => {
  const signal = new WorkFoldSettleSignal({ maxListeners: 1 });
  const received: string[] = [];
  const listener = (record: WorkFoldSettleRecord) => {
    received.push(record.runId);
  };
  const unsubscribe = signal.subscribe(listener);
  assert.equal(signal.listenerCount, 1);
  assert.throws(() => signal.subscribe(listener), /already subscribed/);
  assert.throws(() => signal.subscribe(() => undefined), /capacity exhausted/);

  unsubscribe();
  unsubscribe();
  assert.equal(signal.listenerCount, 0);
  signal.publish(checkRunRecord);
  assert.deepEqual(received, [], "an unsubscribed listener receives nothing");
  const replacement = signal.subscribe(() => undefined);
  assert.equal(signal.listenerCount, 1, "released capacity is reusable");
  replacement();
});

test("Check settles publish after durable terminal persistence, carry lineage, and survive listener bugs", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-settle-check-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(absenceProposal()));
  const statePath = join(sandbox, "space-settle.json");
  const signal = new WorkFoldSettleSignal();
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: (spaceId) => WorkFoldCheckStore.create(spaceId, { path: statePath }),
    listSpaces: async () => [spaceSummary("space-settle", root)],
    settleSignal: signal,
  });
  t.after(() => service.close());
  const space = { id: "space-settle", spaceRoot: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });

  const received: WorkFoldSettleRecord[] = [];
  const durableAtPublication: boolean[] = [];
  signal.subscribe(() => {
    throw new Error("routing listener bug");
  });
  signal.subscribe((record) => {
    if (record.kind !== "check-run") return;
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { runs: Array<{ id: string; state: string }> };
    durableAtPublication.push(persisted.runs.some((run) => run.id === record.runId && run.state === record.state));
    received.push(record);
  });

  const accepted = await service.run({
    space,
    checkId: enabled.declaration.id,
    actor: { kind: "cli", spaceId: space.id },
    lineage,
  });
  const run = await waitForTerminal(service, space.id, accepted.taskId);
  assert.equal(run.state, "succeeded", "a listener bug must never fail the Check run");
  await waitForCondition(() => received.length === 1);
  assert.deepEqual(received, [{
    kind: "check-run",
    spaceId: space.id,
    runId: accepted.runId,
    taskId: accepted.taskId,
    checkIds: [enabled.declaration.id],
    state: "succeeded",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lineage,
  }]);
  assert.deepEqual(durableAtPublication, [true], "publication happens only after the exact terminal record is durable");
  assert.equal(signal.listListenerErrors().length, 1, "the failing listener is isolated into diagnostics");

  const second = await service.run({ space, checkId: enabled.declaration.id, actor: { kind: "renderer", spaceId: space.id } });
  await waitForTerminal(service, space.id, second.taskId);
  await waitForCondition(() => received.length === 2);
  assert.equal(received[1]?.runId, second.runId);
  assert.equal("lineage" in received[1]!, false, "a person-caused run settles without routing lineage");
});

test("a Check run refused at admission still settles exactly once as durably failed", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-settle-check-admission-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(absenceProposal()));
  const statePath = join(sandbox, "state.json");
  const store = await WorkFoldCheckStore.create("space-admission", { path: statePath });
  store.markRunRunning = async () => {
    throw new Error("injected admission failure");
  };
  const signal = new WorkFoldSettleSignal();
  const received: WorkFoldSettleRecord[] = [];
  const durableAtPublication: boolean[] = [];
  signal.subscribe((record) => {
    if (record.kind !== "check-run") return;
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { runs: Array<{ id: string; state: string }> };
    durableAtPublication.push(persisted.runs.some((run) => run.id === record.runId && run.state === record.state));
    received.push(record);
  });
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: async () => store,
    listSpaces: async () => [spaceSummary("space-admission", root)],
    settleSignal: signal,
  });
  t.after(() => service.close());
  const space = { id: "space-admission", spaceRoot: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });

  await assert.rejects(
    () => service.run({ space, checkId: enabled.declaration.id, actor: { kind: "cli" } }),
    /injected admission failure/,
  );
  assert.equal(received.length, 1);
  assert.equal(received[0]?.kind, "check-run");
  assert.equal(received[0]?.state, "failed");
  assert.equal(received[0]?.spaceId, space.id);
  assert.equal("lineage" in received[0]!, false);
  assert.deepEqual(durableAtPublication, [true]);
});

test("a settle waits out terminal persistence failure and publishes exactly once after recovery", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-settle-check-recovery-"));
  const root = join(sandbox, "Space");
  await mkdir(root);
  const proposalPath = join(sandbox, "proposal.json");
  await writeFile(proposalPath, JSON.stringify(absenceProposal()));
  const store = await WorkFoldCheckStore.create("space-recovery", { path: join(sandbox, "state.json") });
  const finishRun = store.finishRun.bind(store);
  let injectedFailures = 0;
  store.finishRun = async (run) => {
    if (run.state === "succeeded" && injectedFailures++ === 0) throw new Error("injected terminal write failure");
    return finishRun(run);
  };
  const signal = new WorkFoldSettleSignal();
  const received: WorkFoldSettleRecord[] = [];
  signal.subscribe((record) => {
    received.push(record);
  });
  const service = new WorkFoldCheckService({
    kernel: new WorkFoldKernel(),
    storeFactory: async () => store,
    listSpaces: async () => [spaceSummary("space-recovery", root)],
    settleSignal: signal,
  });
  t.after(() => service.close());
  const space = { id: "space-recovery", spaceRoot: root };
  const enabled = await service.enable({ space, proposalPath, actor: "human" });
  const accepted = await service.run({
    space,
    checkId: enabled.declaration.id,
    actor: { kind: "cli" },
    lineage,
  });
  await waitForCondition(() => injectedFailures > 0);
  assert.equal(received.length, 0, "no settle may be published before its terminal record is durable");

  const status = await service.taskStatus(space.id, accepted.taskId);
  assert.equal(status.state, "succeeded");
  assert.equal(received.length, 1, "recovery publishes the deferred settle");
  const recovered = received[0];
  assert.ok(recovered && recovered.kind === "check-run");
  assert.equal(recovered.runId, accepted.runId);
  assert.deepEqual(recovered.lineage, lineage);

  await service.taskStatus(space.id, accepted.taskId);
  await service.taskResult(space.id, accepted.taskId);
  assert.equal(received.length, 1, "repeated polls never republish a settled run");
});

test("automation settles publish once after the durable receipt and never fail the run", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-settle-automation-"));
  const spaceRoot = join(sandbox, "space");
  const rootPath = join(sandbox, "state", "restricted-apps");
  const spaceId = "ws-1111111111111111";
  const signal = new WorkFoldSettleSignal();
  const received: WorkFoldSettleRecord[] = [];
  const durableAtPublication: boolean[] = [];
  signal.subscribe(() => {
    throw new Error("routing listener bug");
  });
  signal.subscribe((record) => {
    if (record.kind !== "app-automation-run") return;
    const registry = JSON.parse(readFileSync(join(rootPath, "registry.json"), "utf8")) as {
      historicalAutomationRuns: Array<{ runId: string }>;
    };
    durableAtPublication.push(registry.historicalAutomationRuns.some((run) => run.runId === record.runId));
    received.push(record);
  });
  try {
    await writeAutomationPackage(join(spaceRoot, "apps", "inbox"));
    const service = await RestrictedAppService.create({
      rootPath,
      runtimeHost: {
        invoke: async () => ({}),
        runAutomation: async () => {},
        stop: async () => {},
        close: async () => {},
      },
      deferAutomationStart: false,
      settleSignal: signal,
    });
    try {
      const review = await service.inspect({ spaceId, spaceRoot, sourcePath: "apps/inbox" });
      await service.install({ spaceId, spaceRoot, sourcePath: "apps/inbox", expectedDigest: review.digest });
      await service.setAutomationEnabled({
        spaceId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        automationId: "refresh-mail",
        enabled: true,
      });
      const persisted = await service.runAutomationNow({
        spaceId,
        appId: "connected-inbox",
        expectedDigest: review.digest,
        automationId: "refresh-mail",
      });
      assert.equal(persisted.run.outcome, "success", "a listener bug must never fail the automation run");
      assert.equal(received.length, 1, "the manual-run duplicate record path never publishes twice");
      assert.deepEqual(received, [{
        kind: "app-automation-run",
        spaceId,
        appId: "connected-inbox",
        automationId: "refresh-mail",
        runId: persisted.run.runId,
        outcome: "success",
        reason: "manual",
        scheduledAt: persisted.run.scheduledAt,
        startedAt: persisted.run.startedAt,
        finishedAt: persisted.run.finishedAt,
      }]);
      assert.equal("lineage" in received[0]!, false, "app automation settles carry no routing lineage today");
      assert.deepEqual(durableAtPublication, [true], "publication happens only after the receipt is durable");
      assert.equal(signal.listListenerErrors().length, 1, "the failing listener is isolated into diagnostics");
      assert.deepEqual(
        await service.listAutomationRuns(spaceId, "connected-inbox", review.digest, "refresh-mail"),
        [persisted.run],
        "the durable receipt is unaffected by listener failures",
      );
    } finally {
      await service.close();
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function absenceProposal() {
  return {
    kind: "work-fold.check-proposal",
    version: 1,
    name: "Stray export",
    createdBy: "human",
    createdAt: "2026-08-01T00:00:00.000Z",
    check: {
      title: "The stray export stays absent",
      severity: "error",
      trigger: "manual",
      sensor: { id: "work-fold.file-presence", revision: 1, parameters: { expect: "absent" } },
      targets: [{ kind: "file", role: "primary", path: "Delivery/stray.tmp" }],
    },
  } as const;
}

async function writeAutomationPackage(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "connected-inbox",
    version: "0.1.0",
    private: true,
    type: "module",
    agentApp: "agent-app.json",
  }), "utf8");
  await writeFile(join(root, "agent-app.json"), JSON.stringify({
    version: 2,
    id: "connected-inbox",
    title: "Connected inbox",
    runtime: { kind: "sandboxed-web", entry: "index.html", worker: "worker.js" },
    ui: { icon: "mail" },
    tools: [{
      name: "inbox_search",
      description: "Search the connected inbox.",
      action: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", maxLength: 500 } },
        required: ["query"],
        additionalProperties: false,
      },
      resultSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 0 } },
        required: ["count"],
        additionalProperties: false,
      },
    }],
    automations: [{
      id: "refresh-mail",
      title: "Refresh inbox",
      description: "Check for newly arrived messages.",
      handler: "refresh-inbox",
      trigger: { kind: "interval", intervalMinutes: 30 },
      permissions: { network: ["mail-api"], files: [], notifications: ["new-mail"] },
      catchUp: "latest",
      overlap: "skip",
    }],
    permissions: {
      files: [],
      notifications: [{ id: "new-mail", title: "New mail", description: "New messages are ready." }],
      network: [{
        id: "mail-api",
        target: { kind: "public-https", origin: "https://mail.example.com" },
        methods: ["GET"],
        auth: [{ kind: "api-key", header: "x-api-key" }],
      }],
    },
  }), "utf8");
  await writeFile(join(root, "index.html"), "<!doctype html><script type=module src=app.js></script>", "utf8");
  await writeFile(join(root, "app.js"), "export {};\n", "utf8");
  await writeFile(
    join(root, "worker.js"),
    "// This code must remain inert during review and installation.\nexport async function handleAction() { return { count: 0 }; }\nexport async function handleAutomation() {}\n",
    "utf8",
  );
}

async function waitForTerminal(service: WorkFoldCheckService, spaceId: string, taskId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await service.taskStatus(spaceId, taskId);
    if (status.state !== "accepted" && status.state !== "running") return service.taskResult(spaceId, taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Check task.");
}

function spaceSummary(id: string, spaceRoot: string) {
  return {
    id,
    name: id,
    spaceRoot,
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
