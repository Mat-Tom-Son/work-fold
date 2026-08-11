import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { PiRuntimeProvider } from "../src/local/agent/pi-runtime-config.js";
import type { RestrictedAppProposalReceipt } from "../src/local/agent/restricted-app-proposals.js";
import {
  restrictedAppAutomationScheduleSummary,
  type RestrictedAppInstalled,
} from "../src/local/agent/restricted-app-service.js";
import type { RestrictedAppAutomationDeclaration } from "../src/local/agent/restricted-app-manifest.js";
import { importPiSkillBundleVerified, piSkillBundleContentDigest } from "../src/local/agent/skill-import.js";
import type { WorkFoldCliActReceiptV2 } from "../src/local/cli/act-receipts.js";
import {
  createManagedSpaceDeletionAdapter,
  createRestrictedAppAutomationEnableAdapter,
  createRestrictedAppGrantAdapter,
  createRestrictedAppReviewApproveAdapter,
  createSkillImportAdapter,
  FoldDecisionError,
  foldDecisionFenceScope,
  foldDecisionRequestId,
  FoldDecisionService,
  foldDecisionSurfaceRestrictions,
  type FoldDecisionAdapters,
  type FoldDecisionExecutionEffect,
  type FoldDecisionFenceScope,
  type FoldStagedActKindAdapter,
  type RestrictedAppGrantAdapterOptions,
} from "../src/local/fold-decisions.js";
import {
  FoldStagedActError,
  FoldStagedActStore,
  type FoldStagedAct,
  type FoldStagedActInput,
  type FoldStagedActProvenance,
} from "../src/local/fold-staged-acts.js";
import { createManagedSpace, managedSpaceDeletionPinIssue, registerLinkedSpace } from "../src/local/space.js";
import { configureWorkFoldStateRoot } from "../src/local/state-paths.js";
import {
  WorkFoldKernel,
  type WorkFoldExperimentalFoldDecisionTask,
  type WorkFoldExperimentalFoldDecisionTaskInput,
} from "../src/local/work-fold-kernel.js";

type ReceiptEntry = Omit<WorkFoldCliActReceiptV2, "v" | "at">;

class FakeReceipts {
  entries: ReceiptEntry[] = [];
  failAppend = false;
  preAccepted = new Set<string>();

  async append(entry: ReceiptEntry): Promise<boolean> {
    if (this.failAppend) return false;
    this.entries.push(structuredClone(entry));
    return true;
  }

  async hasAccepted(requestId: string): Promise<boolean> {
    return this.preAccepted.has(requestId)
      || this.entries.some((entry) => entry.requestId === requestId && entry.outcome === "accepted");
  }
}

class FakeFence {
  probes: FoldDecisionFenceScope[] = [];
  runs: FoldDecisionFenceScope[] = [];
  busyReason: string | null = null;

  probe(scope: FoldDecisionFenceScope): string | null {
    this.probes.push(scope);
    return this.busyReason;
  }

  async run<T>(scope: FoldDecisionFenceScope, operation: () => Promise<T>): Promise<T> {
    this.runs.push(scope);
    return await operation();
  }
}

class FakeKernel {
  started: WorkFoldExperimentalFoldDecisionTask[] = [];
  finished: string[] = [];
  #sequence = 0;

  startExperimentalFoldDecisionTask(input: WorkFoldExperimentalFoldDecisionTaskInput): WorkFoldExperimentalFoldDecisionTask {
    this.#sequence += 1;
    const task: WorkFoldExperimentalFoldDecisionTask = {
      id: `exec-${this.#sequence}`,
      kind: "fold_decision",
      status: "running",
      spaceId: input.spaceId ?? null,
      stagedActId: input.stagedActId,
      actor: input.actor,
      startedAt: "2026-08-10T10:00:00.000Z",
    };
    this.started.push(task);
    return task;
  }

  finishTask(taskId: string): boolean {
    this.finished.push(taskId);
    return true;
  }
}

class FakeAdapter implements FoldStagedActKindAdapter {
  eligibility: string | null = null;
  pinIssue: string | null = null;
  executeError: Error | null = null;
  effect: FoldDecisionExecutionEffect | undefined = { detail: "granted it", checkpointId: "cp-1" };
  executed: FoldStagedAct[] = [];

  eligibilityIssue(): string | null {
    return this.eligibility;
  }

  recheckPins(): string | null {
    return this.pinIssue;
  }

  async execute(act: FoldStagedAct): Promise<FoldDecisionExecutionEffect | void> {
    this.executed.push(act);
    if (this.executeError) throw this.executeError;
    return this.effect;
  }
}

function provenance(requestId: string, remote?: { browserId: string; grantId: string }): FoldStagedActProvenance {
  return {
    stagedVia: "management-conversation",
    conversationId: "manage-chat-1",
    parentTaskId: "task-1",
    requestId,
    ...(remote ?? {}),
  };
}

function grantInput(overrides: {
  spaceId?: string;
  appInstanceId?: string;
  declarationId?: string;
  releaseDigest?: string;
  requestId?: string;
  remote?: { browserId: string; grantId: string };
} = {}): FoldStagedActInput {
  const appInstanceId = overrides.appInstanceId ?? "fi-1";
  const declarationId = overrides.declarationId ?? "net-api.example.com";
  return {
    kind: "app.grant.network",
    parameters: { spaceId: overrides.spaceId ?? "space-alpha", appInstanceId, declarationId },
    pins: { appInstanceId, declarationId, releaseDigest: overrides.releaseDigest ?? "d".repeat(64) },
    provenance: provenance(overrides.requestId ?? `req-${appInstanceId}-${declarationId}`, overrides.remote),
  };
}

function skillImportInput(overrides: {
  source?: string;
  contentDigest?: string;
  requestId?: string;
} = {}): FoldStagedActInput {
  const source = overrides.source ?? "upload:helper.md";
  return {
    kind: "capability.skills.import",
    parameters: { source, scope: "personal" },
    pins: {
      source,
      contentDigest: overrides.contentDigest ?? "a".repeat(64),
      skillNames: ["personal-helper"],
    },
    provenance: provenance(overrides.requestId ?? `req-skill-${source}`),
  };
}

interface Harness {
  sandbox: string;
  store: FoldStagedActStore;
  receipts: FakeReceipts;
  fence: FakeFence;
  kernel: FakeKernel;
  adapter: FakeAdapter;
  service: FoldDecisionService;
  serviceWith(adapters: FoldDecisionAdapters): FoldDecisionService;
}

async function harness(prefix: string): Promise<Harness> {
  const sandbox = await mkdtemp(join(tmpdir(), `work-fold-decisions-${prefix}-`));
  const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json") });
  const receipts = new FakeReceipts();
  const fence = new FakeFence();
  const kernel = new FakeKernel();
  const adapter = new FakeAdapter();
  const serviceWith = (adapters: FoldDecisionAdapters) =>
    new FoldDecisionService({ store, receipts, kernel, fence, adapters });
  return {
    sandbox,
    store,
    receipts,
    fence,
    kernel,
    adapter,
    service: serviceWith({ "app.grant.network": adapter, "capability.skills.import": adapter }),
    serviceWith,
  };
}

function isDecisionRefusal(code: FoldDecisionError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof FoldDecisionError && error.code === code;
}

function isStoreRefusal(code: FoldStagedActError["code"]): (error: unknown) => boolean {
  return (error: unknown) => error instanceof FoldStagedActError && error.code === code;
}

test("approval runs the full decision path: precheck, pin recheck, journal-first consumption, fenced execution, v2 receipts", async () => {
  const h = await harness("approve");
  try {
    const act = (await h.store.stage(grantInput())).act;
    const result = await h.service.decide(act.id, { decision: "approved", surface: "popover" });

    assert.equal(result.act.state, "approved");
    assert.equal(result.act.decision?.surface, "popover");
    assert.equal(result.act.execution?.outcome, "executed");
    assert.equal(result.receipted, true);
    assert.equal(h.adapter.executed.length, 1);
    assert.equal(h.adapter.executed[0].id, act.id, "the adapter executes the exact consumed act");

    assert.deepEqual(h.fence.probes, [{ scope: "space", spaceId: "space-alpha" }], "the eligibility precheck probes the fence without reserving");
    assert.deepEqual(h.fence.runs, [{ scope: "space", spaceId: "space-alpha" }], "the execution reserves the same capability-mutation scope");
    assert.equal(h.kernel.started.length, 1, "each execution is an internal kernel task");
    assert.equal(h.kernel.started[0].spaceId, "space-alpha");
    assert.equal(h.kernel.started[0].stagedActId, act.id);
    assert.deepEqual(h.kernel.finished, [h.kernel.started[0].id], "the kernel task never outlives the execution");

    const requestId = foldDecisionRequestId(act.id);
    assert.equal(h.receipts.entries.length, 2);
    const [accepted, terminal] = h.receipts.entries;
    assert.deepEqual(accepted, {
      requestId,
      command: "decision.approve",
      outcome: "accepted",
      detail: "app.grant.network (widen-power)",
      decisionId: act.id,
      surface: "popover",
      spaceId: "space-alpha",
    }, "the accepted receipt is appended inside the store's critical section with a deterministic decision request id");
    assert.deepEqual(terminal, {
      requestId,
      command: "decision.approve",
      outcome: "ok",
      detail: "granted it",
      checkpointId: "cp-1",
      taskId: h.kernel.started[0].id,
      decisionId: act.id,
      surface: "popover",
      spaceId: "space-alpha",
    }, "the terminal receipt carries the execution effect");
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("the execution's internal kernel task stays out of the stable tasks projection and the glance", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-decisions-kernel-"));
  try {
    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json") });
    const receipts = new FakeReceipts();
    const kernel = new WorkFoldKernel({ listSpaces: async () => [] });
    const startedIds: string[] = [];
    const finishedIds: string[] = [];
    let observedDuringExecution = -1;
    const adapter: FoldStagedActKindAdapter = {
      recheckPins: () => null,
      async execute() {
        const during = await kernel.getTasks({ kind: "system" });
        observedDuringExecution = during.tasks.length;
        const glance = await kernel.getGlance({ kind: "system" });
        assert.equal(glance.kind, "work-fold.glance.experimental", "a running execution never breaks the glance composition");
        return { detail: "done" };
      },
    };
    const service = new FoldDecisionService({
      store,
      receipts,
      kernel: {
        startExperimentalFoldDecisionTask: (input) => {
          const task = kernel.startExperimentalFoldDecisionTask(input);
          startedIds.push(task.id);
          return task;
        },
        finishTask: (taskId) => {
          finishedIds.push(taskId);
          return kernel.finishTask(taskId);
        },
      },
      fence: new FakeFence(),
      adapters: { "app.grant.network": adapter },
    });

    const act = (await store.stage(grantInput())).act;
    const result = await service.decide(act.id, { decision: "approved", surface: "main-window" });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.equal(startedIds.length, 1);
    assert.deepEqual(finishedIds, startedIds, "no ghost task survives the execution");
    assert.equal(observedDuringExecution, 0, "fold_decision never enters the stable space.tasks projection");
    assert.equal((await kernel.getTasks({ kind: "system" })).tasks.length, 0);

    assert.throws(
      () => kernel.startExperimentalFoldDecisionTask({ stagedActId: "  ", actor: { kind: "system" } }),
      /staged-act id is required/,
    );
    assert.throws(
      () => kernel.startExperimentalFoldDecisionTask({ stagedActId: "act-1", spaceId: "  ", actor: { kind: "system" } }),
      /Space id is required/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("denial is journal-first, needs no adapter, no fence, and no kernel task", async () => {
  const h = await harness("deny");
  try {
    const act = (await h.store.stage(grantInput({ remote: { browserId: "browser-1", grantId: "grant-1" } }))).act;
    const bare = h.serviceWith({});
    const result = await bare.decide(act.id, {
      decision: "denied",
      surface: "remote_web",
      browserId: "browser-2",
      grantId: "grant-2",
      note: "not this one",
    });

    assert.equal(result.act.state, "denied");
    assert.equal(result.act.decision?.browserId, "browser-2");
    assert.equal(result.receipted, true);
    assert.equal(h.kernel.started.length, 0);
    assert.equal(h.fence.probes.length, 0);
    assert.equal(h.receipts.entries.length, 2);
    const [accepted, terminal] = h.receipts.entries;
    assert.equal(accepted.command, "decision.deny");
    assert.equal(accepted.outcome, "accepted");
    assert.equal(accepted.browserId, "browser-2");
    assert.equal(accepted.grantId, "grant-2");
    assert.equal(accepted.decisionId, act.id);
    assert.equal(terminal.outcome, "ok");
    assert.match(terminal.detail ?? "", /Denial recorded/);
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("an unwritable journal refuses without consuming; refused eligibility consumes nothing", async () => {
  const h = await harness("eligibility");
  try {
    const act = (await h.store.stage(grantInput())).act;

    h.receipts.failAppend = true;
    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "popover" }),
      isStoreRefusal("JOURNAL_UNAVAILABLE"),
    );
    assert.equal((await h.store.get(act.id))?.state, "staged", "an unwritable journal leaves the act staged");
    assert.equal(h.kernel.started.length, 0, "nothing executes when the journal refuses");
    h.receipts.failAppend = false;

    h.fence.busyReason = "Wait for affected Assistant work to finish before changing capabilities.";
    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "NOT_ELIGIBLE"
        && /affected Assistant work/.test(error.message),
      "a busy capability-mutation fence refuses in the eligibility precheck",
    );
    h.fence.busyReason = null;

    h.adapter.eligibility = "Waiting for the app's runtime host.";
    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "popover" }),
      isDecisionRefusal("NOT_ELIGIBLE"),
    );
    h.adapter.eligibility = null;

    const unbound = h.serviceWith({});
    await assert.rejects(
      unbound.decide(act.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "EXECUTION_UNAVAILABLE"
        && /cannot execute "app\.grant\.network"/.test(error.message),
      "an unbound kind refuses approval honestly before anything is consumed",
    );

    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "cli" as never }),
      isStoreRefusal("INPUT_INVALID"),
      "the act lane's surface never decides",
    );

    assert.equal((await h.store.get(act.id))?.state, "staged", "every refusal above consumed nothing");
    assert.equal(h.receipts.entries.length, 0);

    const denied = await unbound.decide(act.id, { decision: "denied", surface: "popover" });
    assert.equal(denied.act.state, "denied", "denying an unbound kind stays possible");
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("surface rules: no self-approval from the staging grant; Personal-scope make-runnable is desktop-decided; policy is a decision surface", async () => {
  const h = await harness("surfaces");
  try {
    const staged = (await h.store.stage(grantInput({ remote: { browserId: "browser-1", grantId: "grant-1" } }))).act;
    assert.deepEqual(foldDecisionSurfaceRestrictions(staged), { desktopOnly: false, stagedByGrantId: "grant-1" });

    for (const decision of ["approved", "denied"] as const) {
      await assert.rejects(
        h.service.decide(staged.id, { decision, surface: "remote_web", browserId: "browser-1", grantId: "grant-1" }),
        (error: unknown) => error instanceof FoldDecisionError && error.code === "SURFACE_FORBIDDEN"
          && /cannot decide it/.test(error.message),
        `a staged act is never decidable (${decision}) from the grant whose request staged it`,
      );
    }
    assert.equal((await h.store.get(staged.id))?.state, "staged");
    const otherBrowser = await h.service.decide(staged.id, {
      decision: "approved",
      surface: "remote_web",
      browserId: "browser-2",
      grantId: "grant-2",
    });
    assert.equal(otherBrowser.act.state, "approved", "a different approved browser can decide it");
    assert.equal(h.receipts.entries[0]?.browserId, "browser-2");
    assert.equal(h.receipts.entries[0]?.grantId, "grant-2");

    const personal = (await h.store.stage(skillImportInput())).act;
    assert.equal(foldDecisionSurfaceRestrictions(personal).desktopOnly, true);
    await assert.rejects(
      h.service.decide(personal.id, { decision: "approved", surface: "remote_web", browserId: "browser-2", grantId: "grant-2" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "SURFACE_FORBIDDEN"
        && /fold's own runtime/.test(error.message),
      "Personal-scope make-runnable decisions belong to a desktop surface",
    );
    const desktop = await h.service.decide(personal.id, { decision: "approved", surface: "popover" });
    assert.equal(desktop.act.state, "approved");
    assert.deepEqual(h.fence.runs.at(-1), { scope: "global" }, "a Space-less act reserves the global capability scope");

    const policyDecided = (await h.store.stage(skillImportInput({ source: "anthropic-marketplace:writing", requestId: "req-policy" }))).act;
    const byPolicy = await h.service.decide(policyDecided.id, {
      decision: "approved",
      surface: "policy",
      policyId: "policy-marketplace-skills",
    });
    assert.equal(byPolicy.act.decision?.surface, "policy");
    const accepted = h.receipts.entries.find((entry) => entry.decisionId === policyDecided.id && entry.outcome === "accepted");
    assert.equal(accepted?.surface, "policy");
    assert.equal(accepted?.policyId, "policy-marketplace-skills", "exercised policies ride the same receipt fields");
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("a pin mismatch invalidates the act before consumption and nothing executes", async () => {
  const h = await harness("pins");
  try {
    const act = (await h.store.stage(grantInput())).act;
    h.adapter.pinIssue = "The installed digest no longer matches the pinned release digest.";
    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && error.state === "invalidated",
    );
    const settled = await h.store.get(act.id);
    assert.equal(settled?.state, "invalidated");
    assert.match(settled?.invalidationReason ?? "", /no longer matches/);
    assert.equal(h.adapter.executed.length, 0, "nothing executes on a mismatch");
    assert.equal(h.receipts.entries.length, 0, "no decision was consumed, so no decision receipt exists");
    assert.equal(h.kernel.started.length, 0);
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("concurrent decides: desktop plus remote, and two remote browsers — exactly one consumes and executes", async () => {
  const h = await harness("concurrent");
  try {
    const first = (await h.store.stage(grantInput({ declarationId: "net-1.example.com", requestId: "req-1" }))).act;
    const outcomes = await Promise.allSettled([
      h.service.decide(first.id, { decision: "approved", surface: "popover" }),
      h.service.decide(first.id, { decision: "approved", surface: "remote_web", browserId: "browser-1", grantId: "grant-1" }),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one decide consumes the act");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof FoldStagedActError);
    assert.equal(rejected[0].reason.code, "ALREADY_SETTLED");
    assert.equal(rejected[0].reason.state, "approved", "the loser is refused with the settled outcome");
    assert.equal(h.adapter.executed.length, 1, "the mutation ran exactly once");
    assert.equal(h.receipts.entries.filter((entry) => entry.outcome === "accepted").length, 1);

    const second = (await h.store.stage(grantInput({ declarationId: "net-2.example.com", requestId: "req-2" }))).act;
    const remoteOutcomes = await Promise.allSettled([
      h.service.decide(second.id, { decision: "approved", surface: "remote_web", browserId: "browser-1", grantId: "grant-1" }),
      h.service.decide(second.id, { decision: "approved", surface: "remote_web", browserId: "browser-2", grantId: "grant-2" }),
    ]);
    const remoteWinners = remoteOutcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<FoldDecisionService["decide"]>>> =>
        outcome.status === "fulfilled",
    );
    assert.equal(remoteWinners.length, 1, "two remote browsers: exactly one consumes");
    const winnerBrowser = remoteWinners[0].value.act.decision?.browserId;
    assert.ok(winnerBrowser === "browser-1" || winnerBrowser === "browser-2");
    const acceptedForSecond = h.receipts.entries.find(
      (entry) => entry.decisionId === second.id && entry.outcome === "accepted",
    );
    assert.equal(acceptedForSecond?.browserId, winnerBrowser, "the receipt names the browser that consumed the act");
    assert.equal(h.adapter.executed.length, 2, "one execution per consumed act, never per attempt");
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("decision replay is refused; the journal backstop voids an interrupted decision without executing", async () => {
  const h = await harness("replay");
  try {
    const settled = (await h.store.stage(grantInput({ declarationId: "net-a.example.com", requestId: "req-a" }))).act;
    await h.service.decide(settled.id, { decision: "approved", surface: "popover" });
    await assert.rejects(
      h.service.decide(settled.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldStagedActError && error.code === "ALREADY_SETTLED" && error.state === "approved",
      "a settled act refuses a second decision with its outcome",
    );
    assert.equal(h.adapter.executed.length, 1, "replay never re-executes");

    const interrupted = (await h.store.stage(grantInput({ declarationId: "net-b.example.com", requestId: "req-b" }))).act;
    h.receipts.preAccepted.add(foldDecisionRequestId(interrupted.id));
    await assert.rejects(
      h.service.decide(interrupted.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "DECISION_INTERRUPTED" && error.state === "invalidated",
      "an accepted line without a committed transition voids the card",
    );
    const voided = await h.store.get(interrupted.id);
    assert.equal(voided?.state, "invalidated");
    assert.match(voided?.invalidationReason ?? "", /interrupted before it committed/);
    assert.equal(h.adapter.executed.length, 1, "the backstop never executes under a spent request id");

    await assert.rejects(
      h.service.decide("no-such-act", { decision: "approved", surface: "popover" }),
      isStoreRefusal("NOT_FOUND"),
    );
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("interrupted-at-startup recovery reports the honest outcome and never replays the mutation", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-decisions-interrupted-"));
  const path = join(sandbox, "staged-acts.json");
  try {
    const before = await FoldStagedActStore.create({ path });
    const act = (await before.stage(grantInput())).act;
    await before.decide(act.id, { decision: "approved", surface: "popover" });
    // The process dies here: approval was consumed, no execution outcome was
    // ever recorded.

    const reopened = await FoldStagedActStore.create({ path });
    const receipts = new FakeReceipts();
    const adapter = new FakeAdapter();
    const service = new FoldDecisionService({
      store: reopened,
      receipts,
      kernel: new FakeKernel(),
      fence: new FakeFence(),
      adapters: { "app.grant.network": adapter },
    });

    const interrupted = await service.listInterrupted();
    assert.deepEqual(interrupted.map((item) => item.id), [act.id]);
    assert.equal(interrupted[0].execution?.outcome, "interrupted");

    await assert.rejects(
      service.decide(act.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldStagedActError && error.code === "ALREADY_SETTLED" && error.state === "approved",
    );
    assert.equal(adapter.executed.length, 0, "recovery never replays the mutation");
    assert.equal(receipts.entries.length, 0, "the missing terminal line stays the honest interrupted signal");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a failed execution stays approved with outcome failed, receipted as error, and is never auto-retried", async () => {
  const h = await harness("failed");
  try {
    const act = (await h.store.stage(grantInput())).act;
    h.adapter.executeError = new Error("the installer exploded");
    const result = await h.service.decide(act.id, { decision: "approved", surface: "popover" });

    assert.equal(result.act.state, "approved", "approval was consumed at journal time");
    assert.equal(result.act.execution?.outcome, "failed");
    assert.equal(result.act.execution?.errorDetail, "the installer exploded");
    assert.equal(h.receipts.entries.length, 2);
    assert.equal(h.receipts.entries[1].outcome, "error");
    assert.equal(h.receipts.entries[1].errorCode, "failure");
    assert.match(h.receipts.entries[1].detail ?? "", /installer exploded/);
    assert.deepEqual(h.kernel.finished, [h.kernel.started[0].id], "the kernel task finishes on failure too");

    await assert.rejects(
      h.service.decide(act.id, { decision: "approved", surface: "popover" }),
      isStoreRefusal("ALREADY_SETTLED"),
      "getting another attempt means restaging, never auto-retry",
    );
    assert.equal(h.adapter.executed.length, 1);
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

function proposalReceipt(overrides: Partial<RestrictedAppProposalReceipt> = {}): RestrictedAppProposalReceipt {
  return {
    id: "proposal-9",
    spaceId: "space-alpha",
    spaceRoot: "/space/alpha",
    conversationId: "conv-1",
    sourcePath: "apps/tool",
    review: {
      packageName: "tool",
      version: "1.2.3",
      digest: "a".repeat(64),
    },
    status: "pending",
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...overrides,
  } as unknown as RestrictedAppProposalReceipt;
}

function reviewApproveInput(proposalId: string, reviewDigest: string): FoldStagedActInput {
  return {
    kind: "app.review.approve",
    parameters: { spaceId: "space-alpha", proposalId },
    pins: { proposalId, reviewDigest },
    provenance: provenance(`req-review-${proposalId}`),
  };
}

test("review-approve adapter: pins recheck against the live proposal; install runs the digest-checked path", async () => {
  const h = await harness("review");
  try {
    const proposals = new Map<string, RestrictedAppProposalReceipt>([
      ["proposal-drifted", proposalReceipt({ id: "proposal-drifted", review: { packageName: "tool", version: "1.2.3", digest: "f".repeat(64) } as never })],
      ["proposal-ok", proposalReceipt({ id: "proposal-ok" })],
      ["proposal-gone", proposalReceipt({ id: "proposal-gone" })],
    ]);
    const installed: string[] = [];
    const adapter = createRestrictedAppReviewApproveAdapter({
      proposals: {
        get: async (id) => proposals.get(id),
        install: async (id) => {
          installed.push(id);
          if (id === "proposal-gone") return null;
          return { packageName: "tool", version: "1.2.3", digest: "a".repeat(64) } as unknown as RestrictedAppInstalled;
        },
      },
    });
    const service = h.serviceWith({ "app.review.approve": adapter });

    const drifted = (await h.store.stage(reviewApproveInput("proposal-drifted", "a".repeat(64)))).act;
    await assert.rejects(
      service.decide(drifted.id, { decision: "approved", surface: "popover" }),
      isDecisionRefusal("PIN_MISMATCH"),
      "a review digest that no longer matches the pin invalidates instead of installing",
    );
    assert.equal((await h.store.get(drifted.id))?.state, "invalidated");
    assert.deepEqual(installed, [], "nothing installs on a mismatch");

    const missing = (await h.store.stage(reviewApproveInput("proposal-missing", "b".repeat(64)))).act;
    await assert.rejects(
      service.decide(missing.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /no longer exists/.test(error.message),
    );

    const ok = (await h.store.stage(reviewApproveInput("proposal-ok", "a".repeat(64)))).act;
    const result = await service.decide(ok.id, { decision: "approved", surface: "popover" });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.deepEqual(installed, ["proposal-ok"]);
    assert.match(h.receipts.entries.at(-1)?.detail ?? "", /Installed tool@1\.2\.3/);

    const gone = (await h.store.stage(reviewApproveInput("proposal-gone", "a".repeat(64)))).act;
    const failed = await service.decide(gone.id, { decision: "approved", surface: "popover" });
    assert.equal(failed.act.execution?.outcome, "failed", "an install that is no longer available is a failed execution, never a retry");
    assert.match(failed.act.execution?.errorDetail ?? "", /no longer available/);
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

function installedApp(overrides: Record<string, unknown> = {}): RestrictedAppInstalled {
  return {
    spaceId: "space-alpha",
    featureInstallationId: "fi-1",
    digest: "d".repeat(64),
    releaseDigest: null,
    manifest: {
      id: "app-mail",
      permissions: {
        network: [{ id: "net-api.example.com" }],
        files: [{ id: "files-notes", target: "directory", access: "read" }],
        notifications: [{ id: "notify-digest" }],
      },
      automations: [{
        id: "auto-sync",
        title: "Sync",
        handler: "sync.js",
        trigger: { kind: "interval", intervalMinutes: 30 },
        permissions: { network: [], files: [], notifications: [] },
      }],
    },
    ...overrides,
  } as unknown as RestrictedAppInstalled;
}

test("grant adapter: resolves the App Instance, re-verifies digest and declaration, and grants exactly the pinned declaration", async () => {
  const h = await harness("grants");
  try {
    const app = installedApp();
    const calls: Record<string, unknown[]> = { network: [], files: [], notifications: [] };
    const service: RestrictedAppGrantAdapterOptions["service"] = {
      findByFeatureInstallation: async (spaceId, featureInstallationId) =>
        spaceId === "space-alpha" && featureInstallationId === "fi-1" ? app : undefined,
      grantNetwork: async (input) => {
        calls.network.push(input);
        return app;
      },
      grantFiles: async (input) => {
        calls.files.push(input);
        return app;
      },
      grantNotifications: async (input) => {
        calls.notifications.push(input);
        return app;
      },
    } as unknown as RestrictedAppGrantAdapterOptions["service"];
    const getSpace = async (spaceId: string) => ({ id: spaceId, spaceRoot: "/space/alpha" });

    const networkAdapter = createRestrictedAppGrantAdapter("app.grant.network", { service, getSpace });
    const filesAdapterBare = createRestrictedAppGrantAdapter("app.grant.files", { service, getSpace });
    const filesAdapterBound = createRestrictedAppGrantAdapter("app.grant.files", {
      service,
      getSpace,
      resolveFileGrantRoot: () => "notes",
    });

    const decider = h.serviceWith({ "app.grant.network": networkAdapter, "app.grant.files": filesAdapterBare });
    const networkAct = (await h.store.stage(grantInput())).act;
    const granted = await decider.decide(networkAct.id, { decision: "approved", surface: "popover" });
    assert.equal(granted.act.execution?.outcome, "executed");
    assert.deepEqual(calls.network, [{
      spaceId: "space-alpha",
      appId: "app-mail",
      expectedDigest: "d".repeat(64),
      destinationId: "net-api.example.com",
    }], "the grant addresses the resolved app id and installed digest, exactly one declaration");
    assert.deepEqual(h.receipts.entries.at(-1)?.undoRef, { kind: "declaration", value: "net-api.example.com" });

    const drifted = (await h.store.stage(grantInput({ declarationId: "net-drift.example.com", releaseDigest: "e".repeat(64), requestId: "req-drift" }))).act;
    await assert.rejects(
      decider.decide(drifted.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /release digest/.test(error.message),
    );

    const ghost = (await h.store.stage(grantInput({ appInstanceId: "fi-ghost", requestId: "req-ghost" }))).act;
    await assert.rejects(
      decider.decide(ghost.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /no longer installed/.test(error.message),
    );

    const fileAct = (await h.store.stage({
      kind: "app.grant.files",
      parameters: { spaceId: "space-alpha", appInstanceId: "fi-1", declarationId: "files-notes" },
      pins: { appInstanceId: "fi-1", declarationId: "files-notes", releaseDigest: "d".repeat(64) },
      provenance: provenance("req-files"),
    })).act;
    await assert.rejects(
      decider.decide(fileAct.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "NOT_ELIGIBLE" && /person-chosen folder/.test(error.message),
      "a file grant without a person-visible root is honestly ineligible, never silently widened",
    );
    assert.equal((await h.store.get(fileAct.id))?.state, "staged");

    const boundDecider = h.serviceWith({ "app.grant.files": filesAdapterBound });
    const grantedFiles = await boundDecider.decide(fileAct.id, { decision: "approved", surface: "popover" });
    assert.equal(grantedFiles.act.execution?.outcome, "executed");
    assert.deepEqual(calls.files, [{
      spaceId: "space-alpha",
      appId: "app-mail",
      expectedDigest: "d".repeat(64),
      spaceRoot: "/space/alpha",
      permissionId: "files-notes",
      root: "notes",
    }]);
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("automation adapter: the reviewed digest and host-composed schedule summary are pins", async () => {
  assert.equal(
    restrictedAppAutomationScheduleSummary({ trigger: { kind: "interval", intervalMinutes: 30 } } as RestrictedAppAutomationDeclaration),
    "Runs every 30 minutes",
  );
  assert.equal(
    restrictedAppAutomationScheduleSummary({ trigger: { kind: "interval", intervalMinutes: 1 } } as RestrictedAppAutomationDeclaration),
    "Runs every minute",
  );

  const h = await harness("automation");
  try {
    const app = installedApp();
    const enabled: unknown[] = [];
    const service = {
      findByFeatureInstallation: async (spaceId: string, featureInstallationId: string) =>
        spaceId === "space-alpha" && featureInstallationId === "fi-1" ? app : undefined,
      setAutomationEnabled: async (input: unknown) => {
        enabled.push(input);
        return app;
      },
    } as unknown as Parameters<typeof createRestrictedAppAutomationEnableAdapter>[0]["service"];
    const decider = h.serviceWith({
      "app.automation.enable": createRestrictedAppAutomationEnableAdapter({ service }),
    });

    const automationInput = (scheduleSummary: string, requestId: string): FoldStagedActInput => ({
      kind: "app.automation.enable",
      parameters: { spaceId: "space-alpha", appInstanceId: "fi-1", automationId: "auto-sync" },
      pins: { appInstanceId: "fi-1", automationId: "auto-sync", reviewedDigest: "d".repeat(64), scheduleSummary },
      provenance: provenance(requestId),
    });

    const drifted = (await h.store.stage(automationInput("Runs every 5 minutes", "req-drift"))).act;
    await assert.rejects(
      decider.decide(drifted.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /schedule changed/.test(error.message),
    );
    assert.deepEqual(enabled, []);

    const ok = (await h.store.stage(automationInput("Runs every 30 minutes", "req-ok"))).act;
    const result = await decider.decide(ok.id, { decision: "approved", surface: "popover" });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.deepEqual(enabled, [{
      spaceId: "space-alpha",
      appId: "app-mail",
      expectedDigest: "d".repeat(64),
      automationId: "auto-sync",
      enabled: true,
    }]);
    assert.deepEqual(h.receipts.entries.at(-1)?.undoRef, { kind: "automation", value: "auto-sync" });
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("skill-import adapter: the content digest pins the exact reviewed bytes and the import is digest-verified", async () => {
  const h = await harness("skills");
  try {
    const agentDir = join(h.sandbox, "agent");
    const spaceRoot = join(h.sandbox, "root");
    await mkdir(spaceRoot, { recursive: true });
    const provider: PiRuntimeProvider = { async resolveRuntime() { return { agentDir }; } };
    const bytes = new TextEncoder().encode("---\nname: personal-helper\ndescription: Helps\n---\n\nHelp carefully.\n");
    const digest = piSkillBundleContentDigest(bytes);

    await assert.rejects(
      importPiSkillBundleVerified(spaceRoot, { fileName: "SKILL.md", bytes, expectedContentDigest: "0".repeat(64) }, provider),
      /changed after it was reviewed/,
      "the verified import path refuses drifted bytes before any parsing",
    );

    const adapter = createSkillImportAdapter({
      loadBundle: async () => ({ fileName: "SKILL.md", bytes }),
      rootForScope: () => spaceRoot,
      runtimeProvider: provider,
    });
    const decider = h.serviceWith({ "capability.skills.import": adapter });

    const act = (await h.store.stage(skillImportInput({ contentDigest: digest }))).act;
    const result = await decider.decide(act.id, { decision: "approved", surface: "popover" });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.equal(existsSync(join(agentDir, "skills", "personal-helper", "SKILL.md")), true, "the reviewed bundle really imports");
    const terminal = h.receipts.entries.at(-1);
    assert.match(terminal?.detail ?? "", /personal-helper/);
    assert.equal(terminal?.undoRef?.kind, "skill-bundle-path");

    const tampered = createSkillImportAdapter({
      loadBundle: async () => ({ fileName: "SKILL.md", bytes: new TextEncoder().encode("---\nname: evil\n---\nOops.") }),
      rootForScope: () => spaceRoot,
      runtimeProvider: provider,
    });
    const tamperedDecider = h.serviceWith({ "capability.skills.import": tampered });
    const tamperedAct = (await h.store.stage(skillImportInput({ source: "upload:other.md", contentDigest: digest, requestId: "req-tampered" }))).act;
    await assert.rejects(
      tamperedDecider.decide(tamperedAct.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /no longer matches the pinned digest/.test(error.message),
    );
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});

test("managed-space deletion: the pin recheck reads the live registry; the bound orchestration owns its own fencing", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "work-fold-decisions-space-"));
  const stateRoot = join(sandbox, "state");
  const contentRoot = join(sandbox, "content");
  configureWorkFoldStateRoot(stateRoot);
  try {
    const space = await createManagedSpace("Doomed Space", contentRoot);
    assert.equal(await managedSpaceDeletionPinIssue({ spaceId: space.id, spaceRoot: space.spaceRoot }), null);
    assert.match(
      await managedSpaceDeletionPinIssue({ spaceId: space.id, spaceRoot: join(contentRoot, "elsewhere") }) ?? "",
      /no longer matches/,
    );
    assert.match(
      await managedSpaceDeletionPinIssue({ spaceId: "space-ghost", spaceRoot: space.spaceRoot }) ?? "",
      /no longer registered/,
    );
    const linkedRoot = join(sandbox, "linked-root");
    await mkdir(linkedRoot, { recursive: true });
    const linked = await registerLinkedSpace(linkedRoot);
    assert.match(
      await managedSpaceDeletionPinIssue({ spaceId: linked.id, spaceRoot: linked.spaceRoot }) ?? "",
      /not managed/,
    );

    const store = await FoldStagedActStore.create({ path: join(sandbox, "staged-acts.json") });
    const receipts = new FakeReceipts();
    const fence = new FakeFence();
    const deletions: string[] = [];
    const service = new FoldDecisionService({
      store,
      receipts,
      kernel: new FakeKernel(),
      fence,
      adapters: {
        "space.delete-folder": createManagedSpaceDeletionAdapter({
          executeDeletion: async (act) => {
            deletions.push(String(act.pins.spaceId));
            return { detail: "Deleted the managed Space folder." };
          },
        }),
      },
    });
    const act = (await store.stage({
      kind: "space.delete-folder",
      parameters: { spaceId: space.id },
      pins: { spaceId: space.id, spaceRoot: space.spaceRoot },
      provenance: provenance("req-delete"),
    })).act;
    assert.deepEqual(foldDecisionFenceScope(act), { scope: "space", spaceId: space.id });

    const result = await service.decide(act.id, { decision: "approved", surface: "popover" });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.deepEqual(deletions, [space.id]);
    assert.equal(fence.probes.length, 0, "the removal orchestration reserves its own scopes; the adapter opts out of the service fence");
    assert.equal(fence.runs.length, 0);
    assert.equal(receipts.entries.at(-1)?.outcome, "ok");

    const staleAct = (await store.stage({
      kind: "space.delete-folder",
      parameters: { spaceId: "space-ghost" },
      pins: { spaceId: "space-ghost", spaceRoot: join(contentRoot, "ghost") },
      provenance: provenance("req-delete-ghost"),
    })).act;
    await assert.rejects(
      service.decide(staleAct.id, { decision: "approved", surface: "popover" }),
      (error: unknown) => error instanceof FoldDecisionError && error.code === "PIN_MISMATCH" && /no longer registered/.test(error.message),
    );
    assert.deepEqual(deletions, [space.id], "an unregistered pin never reaches the deletion path");
  } finally {
    configureWorkFoldStateRoot(undefined);
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an enablement-shaped adapter receives the consumed approval and binds decisionId = staged act id", async () => {
  // The contract the routing-enable and page-exposure adapters build on
  // (docs/fold-routings.md lifecycle step 3; docs/fold-publishing.md): the
  // adapter executes the exact consumed act, whose decision record carries
  // the approving surface and browser identity, and the enablement it commits
  // names the staged-act id as its single-use decision id.
  const h = await harness("enable-binding");
  try {
    const enables: Array<{ decisionId: string; surface: string; browserGrantId?: string }> = [];
    const adapter: FoldStagedActKindAdapter = {
      fenceScope: () => null,
      recheckPins: () => null,
      async execute(act) {
        const decision = act.decision;
        assert.ok(decision, "execution sees the consumed decision record");
        assert.equal(decision.decision, "approved");
        enables.push({
          decisionId: act.id,
          surface: decision.surface,
          ...(decision.grantId !== undefined ? { browserGrantId: decision.grantId } : {}),
        });
        return { detail: `Enabled at decision ${act.id}.`, undoRef: { kind: "routing-id", value: String(act.pins.routingId) } };
      },
    };
    const service = h.serviceWith({ "routing.enable": adapter });
    const digest = "9".repeat(64);
    const act = (await h.store.stage({
      kind: "routing.enable",
      parameters: { routingId: "routing-weekly-glue" },
      pins: { routingId: "routing-weekly-glue", declarationDigest: digest },
      provenance: provenance("req-routing-stage"),
    })).act;

    const result = await service.decide(act.id, {
      decision: "approved",
      surface: "remote_web",
      browserId: "browser-1",
      grantId: "grant-1",
    });
    assert.equal(result.act.execution?.outcome, "executed");
    assert.deepEqual(enables, [{ decisionId: act.id, surface: "remote_web", browserGrantId: "grant-1" }]);
    assert.equal(h.fence.probes.length, 0, "enablement is a store commit under its own serialization, not a capability mutation");
    assert.equal(h.fence.runs.length, 0);
    const terminal = h.receipts.entries.at(-1)!;
    assert.equal(terminal.outcome, "ok");
    assert.equal(terminal.decisionId, act.id, "the terminal receipt and the enablement grant share one identity");
    assert.equal(terminal.browserId, "browser-1");
    assert.equal(terminal.grantId, "grant-1");
    assert.deepEqual(terminal.undoRef, { kind: "routing-id", value: "routing-weekly-glue" });
  } finally {
    await rm(h.sandbox, { recursive: true, force: true });
  }
});
