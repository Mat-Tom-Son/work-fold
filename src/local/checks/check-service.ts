import { correctionId, normalizeCheckCorrection, readCheckCorrectionProposal, writeCheckCorrection, type CheckCorrectionProposal, type CheckCorrectionRecord } from "./check-corrections.js";
import { restrictedAppCheckLimits, type RestrictedAppCheckResult } from "../../shared/restricted-app-checks.js";
import { readCheckTextSnapshot } from "./check-text.js";
import { createSpaceMutationCheckpoint } from "../history.js";
import { withSpaceHistoryOperation } from "../space.js";
import { normalizeWorkFoldCheckProposal } from "../../shared/checks.js";
import { createModelReviewSensor, type WorkFoldModelCheckReviewer } from "./model-review-sensor.js";
import { loadCheckTextSnapshots, modelCheckLimits, type WorkFoldCheckTextSnapshot } from "./check-text.js";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

import type { WorkFoldCheckDeclaration, WorkFoldCheckProposal } from "../../shared/checks.js";
import type { WorkFoldSettleLineage, WorkFoldSettleSignal } from "../routings/settle-signal.js";
import type { WorkFoldActor, WorkFoldKernel } from "../work-fold-kernel.js";
import { listSpaces, type SpaceSummary } from "../space.js";
import {
  discoverWorkFoldCheckDeclarations,
  readWorkFoldCheckProposal,
  writeWorkFoldCheckDeclaration,
  type WorkFoldCheckDeclarationDiscovery,
  type WorkFoldCheckDeclarationRecord,
} from "./check-declarations.js";
import { admitWorkFoldCheckCandidate, reverifyWorkFoldCheckFinding } from "./check-admission.js";
import { workFoldCheckDigest } from "./check-integrity.js";
import { resolveWorkFoldCheckSensor, type WorkFoldCheckSensor } from "./check-sensors.js";
import { WorkFoldCheckStore, purgeWorkFoldCheckState } from "./check-store.js";
import type {
  WorkFoldCheckAggregateState,
  WorkFoldCheckAuthorization,
  WorkFoldCheckDecision,
  WorkFoldCheckDecisionKind,
  WorkFoldCheckFinding,
  WorkFoldCheckMachineState,
  WorkFoldCheckRendererAuthorityState,
  WorkFoldCheckRendererDecorations,
  WorkFoldCheckRendererOverview,
  WorkFoldCheckRunLimits,
  WorkFoldCheckRunRecord,
  WorkFoldCheckStatusSnapshot,
} from "./check-types.js";
import { workFoldCheckExperimentalSnapshotVersion } from "./check-types.js";
import { resolveWorkFoldCheckTargets, type WorkFoldCheckTargetResolution } from "./target-resolver.js";

const defaultRunLimits: WorkFoldCheckRunLimits = Object.freeze({
  maximumFiles: 512,
  maximumFileBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 256 * 1024 * 1024,
  maximumFindings: 256,
  timeoutMs: 30_000,
});

export interface WorkFoldCheckSpaceRef {
  id: string;
  spaceRoot: string;
}

export interface WorkFoldCheckServiceOptions {
  kernel: WorkFoldKernel;
  now?: () => Date;
  createRunId?: () => string;
  createTaskId?: () => string;
  storeFactory?: (spaceId: string) => Promise<WorkFoldCheckStore>;
  listSpaces?: () => Promise<SpaceSummary[]>;
  reviewModel?: WorkFoldModelCheckReviewer;
  resolveSensor?: (id: string, revision: number) => WorkFoldCheckSensor | null;
  /** Routing-trigger seam; terminal runs are published only after they are durable. */
  settleSignal?: WorkFoldSettleSignal;
  /**
   * A selected Check's result may have changed, so a host can tell an app view
   * that reads it to re-read (docs/collaboration-contract.md, F30). Deliberately
   * separate from `settleSignal`, which keeps exactly one consumer: the routing
   * service. Carries ids only, and a listener that throws never fails the Check
   * operation that produced it.
   */
  onResultChanged?: (event: { spaceId: string; checkIds: string[] }) => void;
}

interface ActiveCheckRun {
  spaceId: string;
  runId: string;
  checkIds: string[];
  controller: AbortController;
  promise: Promise<void>;
}

export interface WorkFoldCheckTaskStatus {
  taskId: string;
  runId: string | null;
  state: WorkFoldCheckRunRecord["state"] | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

/**
 * Content-free projection of one settled Check run for cross-surface digests
 * (the glance's check reader). Identifiers, terminal state, timestamps, and
 * the admitted count only.
 */
export interface WorkFoldCheckSettledRunSummary {
  runId: string;
  taskId: string;
  state: Exclude<WorkFoldCheckRunRecord["state"], "accepted" | "running">;
  startedAt: string;
  endedAt?: string;
  admittedCount: number;
}

interface WorkFoldCheckProblemsResult {
  findings: WorkFoldCheckFinding[];
  invalidated: number;
  healthErrors: string[];
  truncated: boolean;
}

export class WorkFoldCheckOperationConflictError extends Error {
  constructor(message = "Wait for the current Check operation in this Space to finish.") {
    super(message);
    this.name = "WorkFoldCheckOperationConflictError";
  }
}

export class WorkFoldCheckService {
  readonly #kernel: WorkFoldKernel;
  readonly #now: () => Date;
  readonly #createRunId: () => string;
  readonly #createTaskId: () => string;
  readonly #storeFactory: (spaceId: string) => Promise<WorkFoldCheckStore>;
  readonly #listSpaces: () => Promise<SpaceSummary[]>;
  readonly #resolveSensor: (id: string, revision: number) => WorkFoldCheckSensor | null;
  readonly #settleSignal: WorkFoldSettleSignal | null;
  readonly #onResultChanged: WorkFoldCheckServiceOptions["onResultChanged"];
  readonly #stores = new Map<string, Promise<WorkFoldCheckStore>>();
  readonly #active = new Map<string, ActiveCheckRun>();
  readonly #runReservations = new Set<string>();
  readonly #operationReservations = new Set<string>();
  readonly #spaceRemovalReservations = new Set<string>();
  #spaceRegistryMutationReserved = false;
  readonly #terminalRecovery = new Map<string, {
    spaceId: string;
    store: WorkFoldCheckStore;
    run: WorkFoldCheckRunRecord;
    lineage?: WorkFoldSettleLineage;
  }>();

  constructor(options: WorkFoldCheckServiceOptions) {
    this.#kernel = options.kernel;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? (() => `check-run-${randomUUID()}`);
    this.#createTaskId = options.createTaskId ?? (() => `check-task-${randomUUID()}`);
    this.#storeFactory = options.storeFactory ?? ((spaceId) => WorkFoldCheckStore.create(spaceId));
    this.#listSpaces = options.listSpaces ?? listSpaces;
    const modelSensor = createModelReviewSensor(options.reviewModel);
    this.#resolveSensor = options.resolveSensor ?? ((id, revision) => id === modelSensor.id && revision === modelSensor.revision ? modelSensor : resolveWorkFoldCheckSensor(id, revision));
    this.#settleSignal = options.settleSignal ?? null;
    this.#onResultChanged = options.onResultChanged;
  }

  enable(input: {
    space: WorkFoldCheckSpaceRef;
    proposalPath?: string;
    proposal?: unknown;
    checkId?: string;
    expectedDigest?: string;
    actor: WorkFoldCheckAuthorization["enabledBy"];
    /** Materialize an inert proposal without granting run authority. */
    proposeOnly?: boolean;
  }): Promise<{ declaration: WorkFoldCheckDeclaration; digest: string }> {
    return this.#withOperationReservation(input.space.id, async () => {
      const space = await this.#registeredSpace(input.space);
      if ([input.proposalPath, input.proposal, input.checkId].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one Check proposal or existing Check.");
      let proposal: WorkFoldCheckProposal;
      if (input.checkId !== undefined) {
        const existing = (await discoverWorkFoldCheckDeclarations(space.spaceRoot)).declarations.find((item) => item.declaration.id === input.checkId);
        if (!existing || existing.digest !== input.expectedDigest) throw new WorkFoldCheckOperationConflictError("This Check changed since review. Refresh and inspect it again.");
        const { title, severity, trigger, sensor, targets, createdAt, createdBy } = existing.declaration;
        proposal = normalizeWorkFoldCheckProposal({ kind: "work-fold.check-proposal", version: 1, name: title.slice(0, 120), createdAt, createdBy, check: { title, severity, trigger, sensor, targets } });
      } else proposal = input.proposalPath !== undefined ? await readWorkFoldCheckProposal(input.proposalPath) : normalizeWorkFoldCheckProposal(input.proposal);
      const sensor = this.#resolveSensor(proposal.check.sensor.id, proposal.check.sensor.revision);
      if (!sensor) throw new Error("The proposed Check requires a sensor revision that is not installed.");
      const preview: WorkFoldCheckDeclaration = {
        kind: "work-fold.check",
        version: 1,
        id: "check-preview0",
        ...proposal.check,
        createdBy: proposal.createdBy,
        createdAt: proposal.createdAt,
      };
      sensor.validate(preview);
      await this.#assertNoNestedSpaceTargets(space, preview);
      const limits = sensor.execution === "model" ? modelCheckLimits : defaultRunLimits;
      await resolveWorkFoldCheckTargets(space.spaceRoot, preview.targets, {
        limits: {
          maxFiles: limits.maximumFiles,
          maxFileBytes: limits.maximumFileBytes,
          maxTotalBytes: limits.maximumTotalBytes,
        },
      });
      const discovery = await discoverWorkFoldCheckDeclarations(space.spaceRoot);
      const identity = proposalDeclarationIdentity(proposal);
      const written = discovery.declarations.find((record) => declarationIdentity(record.declaration) === identity)
        ?? await writeWorkFoldCheckDeclaration(space.spaceRoot, proposal);
      sensor.validate(written.declaration);
      if (input.proposeOnly) return { declaration: written.declaration, digest: written.digest };
      const store = await this.#store(space.id);
      const existingAuthorization = exactAuthorization(store.snapshot().authorizations[written.declaration.id], written);
      if (existingAuthorization
        && existingAuthorization.sensorDigest === sensor.implementationDigest
        && existingAuthorization.execution === sensor.execution) {
        return { declaration: written.declaration, digest: written.digest };
      }
      await store.authorize(
        written.declaration,
        written.digest,
        input.actor,
        sensor.implementationDigest,
        this.#now(),
        sensor.execution,
        limits,
      );
      return { declaration: written.declaration, digest: written.digest };
    });
  }

  proposeCorrection(input: { space: WorkFoldCheckSpaceRef; proposal?: unknown; proposalPath?: string }): Promise<CheckCorrectionRecord> {
    return this.#withOperationReservation(input.space.id, async () => {
      const space = await this.#registeredSpace(input.space);
      const proposal = input.proposalPath !== undefined ? await readCheckCorrectionProposal(input.proposalPath) : normalizeCheckCorrection(input.proposal);
      await this.#reviewCorrection(space, proposal);
      const store = await this.#store(space.id);
      const id = correctionId(proposal);
      const existing = store.snapshot().corrections?.find((item) => item.id === id);
      if (existing) return existing;
      const correction: CheckCorrectionRecord = { id, proposal, createdAt: this.#now().toISOString(), state: "pending" };
      await store.saveCorrection(correction);
      return correction;
    });
  }

  reviewCorrection(space: WorkFoldCheckSpaceRef, id: string): Promise<{ correction: CheckCorrectionRecord; before: string }> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const correction = (await this.#store(space.id)).snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending.");
      const { before } = await this.#reviewCorrection(registered, correction.proposal);
      return { correction, before };
    });
  }

  dismissCorrection(space: WorkFoldCheckSpaceRef, id: string): Promise<void> {
    return this.#withOperationReservation(space.id, async () => {
      await this.#registeredSpace(space);
      const store = await this.#store(space.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending.");
      await store.saveCorrection({ ...correction, state: "dismissed" });
    });
  }

  /** Caller also reserves app/Assistant mutation authority. All content writes
   * retain their History checkpoint even after partial failure. No retry occurs. */
  applyCorrection(space: WorkFoldCheckSpaceRef, id: string): Promise<{ correction: CheckCorrectionRecord; checkId: string }> {
    return this.#withOperationReservation(space.id, () => withSpaceHistoryOperation(space.spaceRoot, async () => {
      const registered = await this.#registeredSpace(space);
      if (this.#runReservations.has(space.id) || [...this.#active.values()].some((run) => run.spaceId === space.id)) throw new WorkFoldCheckOperationConflictError("Wait for the Check run to finish before applying a correction.");
      const store = await this.#store(space.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending. It was not applied again.");
      const reviewed = await this.#reviewCorrection(registered, correction.proposal);
      const safety = await createSpaceMutationCheckpoint(space.spaceRoot, { paths: [correction.proposal.path], reason: "check_correction", label: `Before Check correction: ${correction.proposal.path}` });
      if (!safety.files.some((file) => file.path === correction.proposal.path && file.hashSha256 === correction.proposal.beforeHash)) throw new Error("History could not preserve the exact file being corrected. Nothing was changed.");
      const applying = { ...correction, state: "applying" as const, checkpointId: safety.checkpointId };
      await store.saveCorrection(applying);
      try {
        await this.#reviewCorrection(registered, correction.proposal);
        await writeCheckCorrection(space.spaceRoot, correction.proposal);
        const applied = { ...applying, state: "applied" as const };
        await store.saveCorrection(applied);
        // The corrected file is the Check's own evidence, so an app reading
        // that selection is now holding an older answer.
        this.#publishResultChanged(space.id, [reviewed.finding.checkId]);
        return { correction: applied, checkId: reviewed.finding.checkId };
      } catch (error) {
        await store.saveCorrection({ ...applying, state: "failed", error: errorMessage(error).slice(0, 2000) });
        throw new Error(`Correction did not finish. Inspect the file and History checkpoint ${safety.checkpointId}. ${errorMessage(error)}`);
      }
    }));
  }

  async #reviewCorrection(space: WorkFoldCheckSpaceRef, proposal: CheckCorrectionProposal): Promise<{ finding: WorkFoldCheckFinding; before: string }> {
    const problems = await this.#problems(space, false);
    const finding = problems.findings.find((item) => item.id === proposal.findingId && item.fingerprint === proposal.fingerprint && item.targetPath === proposal.path);
    if (!finding || !finding.evidence.some((evidence) => evidence.kind === "text-span" && evidence.identity.sha256 === proposal.beforeHash)) throw new WorkFoldCheckOperationConflictError("The finding or its inputs changed. Run the Check and prepare a fresh correction.");
    const snapshot = await readCheckTextSnapshot(space.spaceRoot, proposal.path, ["primary"]);
    if (snapshot.sha256 !== proposal.beforeHash) throw new WorkFoldCheckOperationConflictError("The file changed since the correction was prepared.");
    if (snapshot.text === proposal.replacement) throw new Error("The proposed correction does not change the file.");
    return { finding, before: snapshot.text };
  }

  disable(space: WorkFoldCheckSpaceRef, checkId: string): Promise<boolean> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const active = [...this.#active.values()].find((run) => run.spaceId === registered.id && run.checkIds.includes(checkId));
      if (active) active.controller.abort("Check disabled.");
      const removed = await (await this.#store(registered.id)).disable(checkId);
      // An app holding this selection now reads a Check that is gone; it should
      // learn that from a hint rather than from its next stale render.
      if (removed) this.#publishResultChanged(registered.id, [checkId]);
      return removed;
    });
  }

  tryReserveSpaceRemoval(spaceId: string): (() => void) | null {
    if (this.#spaceRegistryMutationReserved
      || this.#spaceRemovalReservations.has(spaceId)
      || this.#runReservations.has(spaceId)
      || this.#operationReservations.has(spaceId)
      || [...this.#active.values()].some((run) => run.spaceId === spaceId)) return null;
    this.#spaceRemovalReservations.add(spaceId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#spaceRemovalReservations.delete(spaceId);
    };
  }

  tryReserveSpaceRegistryMutation(): (() => void) | null {
    if (this.#spaceRegistryMutationReserved || this.hasActiveRun()) return null;
    this.#spaceRegistryMutationReserved = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#spaceRegistryMutationReserved = false;
    };
  }

  async removeSpace(spaceId: string): Promise<void> {
    let releaseOwnReservation: (() => void) | null = null;
    if (!this.#spaceRemovalReservations.has(spaceId)) {
      releaseOwnReservation = this.tryReserveSpaceRemoval(spaceId);
      if (!releaseOwnReservation) throw new WorkFoldCheckOperationConflictError("Wait for the current Check operation before removing this Space.");
    }
    try {
      const active = [...this.#active.entries()].filter(([, run]) => run.spaceId === spaceId);
      for (const [, run] of active) run.controller.abort("Space removed.");
      await Promise.allSettled(active.map(([, run]) => run.promise));
      const cachedStore = this.#stores.get(spaceId);
      if (cachedStore) {
        try {
          await (await cachedStore).purge();
        } catch {
          await purgeWorkFoldCheckState(spaceId);
        }
      } else {
        await purgeWorkFoldCheckState(spaceId);
      }
      for (const [taskId] of active) {
        this.#terminalRecovery.delete(taskId);
        this.#finishActiveTask(taskId);
      }
      this.#stores.delete(spaceId);
    } finally {
      releaseOwnReservation?.();
    }
  }

  status(space: WorkFoldCheckSpaceRef): Promise<WorkFoldCheckStatusSnapshot> {
    return this.#withOperationReservation(space.id, async () => this.#status(await this.#registeredSpace(space)));
  }

  /**
   * Content-free summaries of this Space's settled Check runs, for the glance
   * (docs/fold-glance.md): identifiers, terminal state, timestamps, and the
   * admitted count only — never findings, evidence, paths, or inputs. This is
   * a plain read over the store's persisted run records, deliberately outside
   * the per-Space operation reservation so composing the glance never
   * conflicts with (or blocks) running Check work.
   */
  async settledRuns(space: WorkFoldCheckSpaceRef): Promise<WorkFoldCheckSettledRunSummary[]> {
    const registered = await this.#registeredSpace(space);
    const runs = (await this.#store(registered.id)).snapshot().runs;
    return runs
      .filter((run) => !run.trial && run.state !== "accepted" && run.state !== "running")
      .map((run) => ({
        runId: run.id,
        taskId: run.taskId,
        state: run.state as WorkFoldCheckSettledRunSummary["state"],
        startedAt: run.startedAt,
        ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
        admittedCount: run.admittedCount,
      }));
  }

  decorations(space: WorkFoldCheckSpaceRef): Promise<WorkFoldCheckRendererDecorations> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const problems = await this.#problems(registered, false);
      const counts = new Map<string, number>();
      for (const finding of problems.findings) {
        counts.set(finding.targetPath, (counts.get(finding.targetPath) ?? 0) + 1);
      }
      return {
        kind: "work-fold.checks.decorations",
        version: workFoldCheckExperimentalSnapshotVersion,
        spaceId: registered.id,
        items: [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right, "en-US"))
          .map(([path, count]) => ({ path, count })),
      };
    });
  }

  overview(space: WorkFoldCheckSpaceRef): Promise<WorkFoldCheckRendererOverview> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const discovery = await discoverWorkFoldCheckDeclarations(registered.spaceRoot);
      const problems = await this.#problems(registered, true, undefined, discovery);
      const state = (await this.#store(registered.id)).snapshot();
      const status = await this.#status(registered, problems, { discovery, state });
      const checks = [];
      for (const record of discovery.declarations) {
        checks.push({
          id: record.declaration.id,
          digest: record.digest,
          title: record.declaration.title,
          severity: record.declaration.severity,
          trigger: record.declaration.trigger,
          sensor: {
            id: record.declaration.sensor.id,
            revision: record.declaration.sensor.revision,
          },
          targets: structuredClone(record.declaration.targets),
          execution: this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision)?.execution,
          ...(typeof record.declaration.sensor.parameters.criteria === "string" ? { criteria: record.declaration.sensor.parameters.criteria } : {}),
          authority: await this.#rendererAuthorityState(registered, record, state.authorizations[record.declaration.id]),
        });
      }
      return {
        kind: "work-fold.checks.renderer",
        version: workFoldCheckExperimentalSnapshotVersion,
        spaceId: registered.id,
        status,
        checks,
        corrections: state.corrections ?? [],
        ...problems,
      };
    });
  }

  /** Re-verifies only the selected Check's targets. Never runs a sensor. */
  selectedResult(space: WorkFoldCheckSpaceRef, checkId: string, declarationDigest: string): Promise<RestrictedAppCheckResult> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const discovered = await discoverWorkFoldCheckDeclarations(registered.spaceRoot);
      const record = discovered.declarations.find((item) => item.declaration.id === checkId && item.digest === declarationDigest);
      if (!record) throw new WorkFoldCheckOperationConflictError("The selected Check changed or is unavailable. Choose it again in Apps.");
      const discovery = { declarations: [record], errors: [] };
      const state = (await this.#store(registered.id)).snapshot();
      const problems = await this.#problems(registered, true, checkId, discovery);
      const status = await this.#status(registered, problems, { discovery, state });
      const running = [...this.#active.values()].some((run) => run.spaceId === registered.id && run.checkIds.includes(checkId));
      const result: RestrictedAppCheckResult = {
        checkId, declarationDigest, title: record.declaration.title,
        state: !status.enabled || status.blocked ? "blocked"
          : running ? "running"
          : status.errors || problems.healthErrors.length ? "check-error"
          : status.neverRun ? "never-run"
          : status.stale || !status.current ? "stale"
          : status.needsAttention ? "needs-attention" : "current-clear",
        lastRunAt: status.lastRunAt,
        findings: [],
        truncated: problems.truncated,
      };
      // Health failures cannot leave apparently current cached evidence visible.
      if (result.state === "current-clear" || result.state === "needs-attention") {
        for (const finding of problems.findings) {
          if (result.findings.length >= restrictedAppCheckLimits.findings) { result.truncated = true; break; }
          result.findings.push({
            id: finding.id, fingerprint: finding.fingerprint, title: finding.title,
            ...(finding.detail ? { detail: finding.detail } : {}),
            ...(finding.remediation ? { suggestion: finding.remediation } : {}),
            path: finding.targetPath, severity: finding.severity, observedAt: finding.observedAt,
            quotes: finding.evidence.flatMap((evidence) => evidence.kind === "text-span" ? [evidence.quote] : []),
          });
          if (Buffer.byteLength(JSON.stringify(result), "utf8") > restrictedAppCheckLimits.resultBytes - 32) {
            result.findings.pop(); result.truncated = true; break;
          }
        }
      }
      return result;
    });
  }

  async #status(
    registered: WorkFoldCheckSpaceRef,
    knownProblems?: WorkFoldCheckProblemsResult,
    knownSnapshot?: { discovery: WorkFoldCheckDeclarationDiscovery; state: WorkFoldCheckMachineState },
  ): Promise<WorkFoldCheckStatusSnapshot> {
    const discovery = knownSnapshot?.discovery ?? await discoverWorkFoldCheckDeclarations(registered.spaceRoot);
    const state = knownSnapshot?.state ?? (await this.#store(registered.id)).snapshot();
    let proposed = 0;
    let enabled = 0;
    let current = 0;
    let neverRun = 0;
    let stale = 0;
    let blocked = 0;
    let errors = discovery.errors.length;
    let needsAttention = 0;
    let lastRunAt: string | null = null;

    for (const record of discovery.declarations) {
      const authorization = exactAuthorization(state.authorizations[record.declaration.id], record);
      if (!authorization) {
        proposed += 1;
        continue;
      }
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.execution !== authorization.execution) {
        blocked += 1;
        continue;
      }
      if (sensor.implementationDigest !== authorization.sensorDigest) {
        blocked += 1;
        continue;
      }
      try {
        sensor.validate(record.declaration);
        await this.#assertNoNestedSpaceTargets(registered, record.declaration);
      } catch {
        blocked += 1;
        continue;
      }
      enabled += 1;
      const run = latestRunForCheck(state.runs, record.declaration.id);
      if (!run) {
        neverRun += 1;
        continue;
      }
      lastRunAt = maxTimestamp(lastRunAt, run.endedAt ?? run.startedAt);
      if (run.state === "accepted" || run.state === "running") continue;
      if (run.state !== "succeeded") {
        errors += 1;
        continue;
      }
      try {
        const inputs = await resolveCurrentInputs(record, authorization, registered.spaceRoot);
        if (sameSemanticInputs(inputs, run.inputs.filter((item) => item.checkId === record.declaration.id))) current += 1;
        else stale += 1;
      } catch {
        blocked += 1;
      }
    }

    try {
      needsAttention = (knownProblems ?? await this.#problems(registered, false)).findings.length;
    } catch {
      errors += 1;
    }
    const running = [...this.#active.values()].filter((run) => run.spaceId === registered.id).length;
    const aggregate = aggregateState({
      configured: discovery.declarations.length,
      enabled,
      current,
      neverRun,
      stale,
      blocked,
      errors,
      needsAttention,
    });
    return {
      kind: "work-fold.checks.experimental",
      version: workFoldCheckExperimentalSnapshotVersion,
      spaceId: registered.id,
      state: aggregate,
      configured: discovery.declarations.length,
      proposed,
      enabled,
      current,
      neverRun,
      stale,
      blocked,
      errors,
      needsAttention,
      running,
      lastRunAt,
    };
  }

  async run(input: {
    space: WorkFoldCheckSpaceRef;
    checkId?: string;
    /** One explicitly reviewed run; never a standing grant or a live result. */
    trialDigest?: string;
    actor: WorkFoldActor;
    /** Stamped on the settle record so routing-caused runs never fire triggers. */
    lineage?: WorkFoldSettleLineage;
  }): Promise<{ taskId: string; runId: string; checkIds: string[] }> {
    if (this.#runReservations.has(input.space.id) || this.hasActiveRun(input.space.id)) {
      throw new WorkFoldCheckOperationConflictError("Wait for the current Check run in this Space to finish.");
    }
    this.#runReservations.add(input.space.id);
    try {
    const space = await this.#registeredSpace(input.space);
    const trial = input.trialDigest !== undefined;
    const records = trial
      ? (await discoverWorkFoldCheckDeclarations(space.spaceRoot)).declarations.filter((record) => record.declaration.id === input.checkId && record.digest === input.trialDigest)
      : await this.#enabledRecords(space, input.checkId);
    if (trial && records.length !== 1) throw new WorkFoldCheckOperationConflictError("This proposal changed. Refresh and review it before trying it.");
    if (!records.length) throw new Error(input.checkId ? "Enabled Check not found." : "This Space has no enabled Checks.");
    const checkIds = records.map((record) => record.declaration.id).sort();
    const state = (await this.#store(space.id)).snapshot();
    const runGrants = records.map((record): WorkFoldCheckAuthorization => {
      if (!trial) return state.authorizations[record.declaration.id]!;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor) throw new Error("The proposed Check sensor is unavailable.");
      sensor.validate(record.declaration);
      return { checkId: record.declaration.id, declarationDigest: record.digest, sensorId: sensor.id,
        sensorRevision: sensor.revision, sensorDigest: sensor.implementationDigest, execution: sensor.execution,
        limits: sensor.execution === "model" ? modelCheckLimits : defaultRunLimits,
        enabledAt: this.#now().toISOString(), enabledBy: "human" };
    });
    const authorities = runGrants.map((authorization) => ({
      checkId: authorization.checkId,
      declarationDigest: authorization.declarationDigest,
      sensorId: authorization.sensorId,
      sensorRevision: authorization.sensorRevision,
      sensorDigest: authorization.sensorDigest,
    }));
    const limits = intersectLimits(runGrants.map((grant) => grant.limits));
    const taskId = this.#createTaskId();
    const runId = this.#createRunId();
    const accepted: WorkFoldCheckRunRecord = {
      id: runId,
      ...(trial ? { trial: true as const } : {}),
      taskId,
      checkIds,
      authorities,
      limits,
      startedAt: this.#now().toISOString(),
      state: "accepted",
      inputs: [],
      findings: [],
      admittedCount: 0,
      discardedCount: 0,
      skippedCount: 0,
    };
    const store = await this.#store(space.id);
    await store.acceptRun(accepted);
    try {
      this.#kernel.startExperimentalCheckRunTask({ id: taskId, spaceId: space.id, actor: input.actor });
      await store.markRunRunning(runId);
    } catch (error) {
      this.#kernel.finishTask(taskId);
      const terminal: WorkFoldCheckRunRecord = {
        ...accepted,
        state: "failed",
        endedAt: this.#now().toISOString(),
        error: errorMessage(error),
      };
      await store.finishRun(terminal);
      this.#publishRunSettle(space.id, terminal, input.lineage);
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Check run exceeded its approved duration."), limits.timeoutMs);
    timeout.unref?.();
    const active: ActiveCheckRun = {
      spaceId: space.id,
      runId,
      checkIds,
      controller,
      promise: Promise.resolve(),
    };
    this.#active.set(taskId, active);
    active.promise = this.#execute(space, records, accepted, controller.signal, input.lineage)
      .finally(() => {
        clearTimeout(timeout);
        if (!this.#terminalRecovery.has(taskId)) this.#finishActiveTask(taskId);
      });
    return { taskId, runId, checkIds };
    } finally {
      this.#runReservations.delete(input.space.id);
    }
  }

  taskStatus(spaceId: string, taskId: string): Promise<WorkFoldCheckTaskStatus> {
    return this.#withOperationReservation(spaceId, () => this.#taskStatus(spaceId, taskId));
  }

  taskResult(spaceId: string, taskId: string): Promise<WorkFoldCheckRunRecord> {
    return this.#withOperationReservation(spaceId, () => this.#taskResult(spaceId, taskId));
  }

  async #taskResult(spaceId: string, taskId: string): Promise<WorkFoldCheckRunRecord> {
    await this.#registeredSpaceId(spaceId);
    await this.#retryTerminalRecovery(taskId, spaceId);
    const active = this.#active.get(taskId);
    if (active?.spaceId === spaceId) throw new Error("The Check run is still running.");
    const run = (await this.#store(spaceId)).snapshot().runs.find((item) => item.taskId === taskId);
    if (!run) throw new Error("Check task not found.");
    if (run.state === "accepted" || run.state === "running") throw new Error("The Check run is still running.");
    return run;
  }

  abort(spaceId: string, taskId: string): Promise<boolean> {
    return this.#withOperationReservation(spaceId, () => this.#abort(spaceId, taskId));
  }

  async #abort(spaceId: string, taskId: string): Promise<boolean> {
    await this.#registeredSpaceId(spaceId);
    const active = this.#active.get(taskId);
    if (!active || active.spaceId !== spaceId) return false;
    active.controller.abort("Check run aborted.");
    await active.promise;
    await this.#retryTerminalRecovery(taskId, spaceId);
    return true;
  }

  problems(space: WorkFoldCheckSpaceRef, checkId?: string): Promise<{
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    return this.#withOperationReservation(space.id, async () => this.#problems(await this.#registeredSpace(space), true, checkId));
  }

  decide(input: {
    spaceId: string;
    findingId: string;
    decision: WorkFoldCheckDecisionKind;
    actor: WorkFoldCheckDecision["actor"];
    deferUntil?: string;
    note?: string;
  }): Promise<WorkFoldCheckDecision> {
    return this.#withOperationReservation(input.spaceId, async () => {
      const space = await this.#registeredSpaceById(input.spaceId);
      const store = await this.#store(input.spaceId);
      const finding = store.snapshot().runs.filter((run) => !run.trial).flatMap((run) => run.findings).find((item) => item.id === input.findingId);
      if (!finding) throw new Error("Finding not found.");
      if (finding.status !== "active") {
        throw new WorkFoldCheckOperationConflictError("This finding is no longer active. Refresh Checks and try again.");
      }
      const now = this.#now();
      if (input.decision === "defer") {
        const deferredUntil = input.deferUntil ? Date.parse(input.deferUntil) : Number.NaN;
        if (!Number.isFinite(deferredUntil) || deferredUntil <= now.getTime()) {
          throw new Error("A deferred finding requires a future deferUntil timestamp.");
        }
      }
      const discovery = await discoverWorkFoldCheckDeclarations(space.spaceRoot);
      const record = discovery.declarations.find((item) => item.declaration.id === finding.checkId);
      const state = store.snapshot();
      const authorization = record ? exactAuthorization(state.authorizations[finding.checkId], record) : null;
      const sensor = record
        ? this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision)
        : null;
      if (!record || record.digest !== finding.declarationDigest || !authorization
        || !sensor || sensor.execution !== authorization.execution
        || sensor.implementationDigest !== authorization.sensorDigest
        || finding.sensorDigest !== authorization.sensorDigest) {
        throw new WorkFoldCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
      }
      try {
        sensor.validate(record.declaration);
        await this.#assertNoNestedSpaceTargets(space, record.declaration);
        if (!await reverifyWorkFoldCheckFinding(space.spaceRoot, record.declaration, finding)) {
          await store.invalidateFinding(
            finding.fingerprint,
            "The designated evidence changed or no longer proves this finding.",
            now,
          );
          throw new WorkFoldCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
        }
      } catch (error) {
        if (error instanceof WorkFoldCheckOperationConflictError) throw error;
        throw new WorkFoldCheckOperationConflictError("This finding could not be re-verified. Refresh Checks and try again.");
      }
      try {
        return await store.decide({
          fingerprint: finding.fingerprint,
          findingId: finding.id,
          decision: input.decision,
          actor: input.actor,
          ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
          ...(input.note ? { note: input.note } : {}),
          now,
        });
      } catch (error) {
        if (/no longer active/.test(errorMessage(error))) {
          throw new WorkFoldCheckOperationConflictError("This finding is no longer current. Refresh Checks and try again.");
        }
        throw error;
      }
    });
  }

  hasActiveRun(spaceId?: string): boolean {
    return this.#spaceRegistryMutationReserved
      || [...this.#active.values()].some((run) => spaceId === undefined || run.spaceId === spaceId)
      || [...this.#runReservations].some((id) => spaceId === undefined || id === spaceId)
      || [...this.#operationReservations].some((id) => spaceId === undefined || id === spaceId)
      || [...this.#spaceRemovalReservations].some((id) => spaceId === undefined || id === spaceId);
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort("work-fold is closing.");
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.#terminalRecovery.keys()].map((taskId) => this.#retryTerminalRecovery(taskId)));
    await Promise.allSettled([...this.#stores.values()].map(async (store) => (await store).flush()));
  }

  async #execute(
    space: WorkFoldCheckSpaceRef,
    records: WorkFoldCheckDeclarationRecord[],
    accepted: WorkFoldCheckRunRecord,
    signal: AbortSignal,
    lineage?: WorkFoldSettleLineage,
  ): Promise<void> {
    const store = await this.#store(space.id);
    const findings: WorkFoldCheckFinding[] = [];
    const inputs: WorkFoldCheckRunRecord["inputs"] = [];
    let discardedCount = 0;
    let skippedCount = 0;
    let usedFiles = 0;
    let usedBytes = 0;
    let cost: WorkFoldCheckRunRecord["cost"];
    let terminal: WorkFoldCheckRunRecord;
    try {
      const currentRecords = new Map(
        (await discoverWorkFoldCheckDeclarations(space.spaceRoot)).declarations
          .map((record) => [record.declaration.id, record]),
      );
      for (const record of records) {
        throwIfAborted(signal);
        const current = currentRecords.get(record.declaration.id);
        if (!current || current.digest !== record.digest) throw new Error("Check authority changed before the run started.");
        const state = store.snapshot();
        const authorization = accepted.trial
          ? accepted.authorities.find((authority) => authority.checkId === record.declaration.id && authority.declarationDigest === record.digest)
          : exactAuthorization(state.authorizations[record.declaration.id], record);
        if (!authorization) throw new Error("Check authority changed before the run started.");
        const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
        if (!sensor || ("execution" in authorization && sensor.execution !== authorization.execution) || sensor.implementationDigest !== authorization.sensorDigest) {
          throw new Error("The exact enabled sensor implementation is unavailable.");
        }
        sensor.validate(record.declaration);
        await this.#assertNoNestedSpaceTargets(space, record.declaration);
        const remainingFiles = accepted.limits.maximumFiles - usedFiles;
        const remainingBytes = accepted.limits.maximumTotalBytes - usedBytes;
        if (remainingFiles < 1 || remainingBytes < 0) throw new Error("Check run exhausted its approved input budget.");
        const resolution = await resolveWorkFoldCheckTargets(space.spaceRoot, record.declaration.targets, {
          limits: {
            maxFiles: remainingFiles,
            maxFileBytes: accepted.limits.maximumFileBytes,
            maxTotalBytes: Math.max(1, remainingBytes),
          },
          signal,
        });
        const resolvedCount = resolution.files.length + resolution.missingExactTargets.length;
        if (resolvedCount > remainingFiles) throw new Error("Check run exceeded its approved input count.");
        if (resolution.totalBytes > remainingBytes) throw new Error("Check run exceeded its approved total-byte budget.");
        usedFiles += resolvedCount;
        usedBytes += resolution.totalBytes;
        const snapshots = sensor.execution === "model" ? await loadCheckTextSnapshots(space.spaceRoot, resolution, signal) : undefined;
        const runnerInputs = runnerOwnedInputs(record.declaration.id, resolution, snapshots);
        inputs.push(...runnerInputs);
        throwIfAborted(signal);
        const result = await withAbort(sensor.run({
          declaration: record.declaration,
          inputs: { ...closedSensorInputs(resolution), ...(snapshots ? { snapshots } : {}) },
          signal,
        }), signal);
        if (result.cost) cost = { model: result.cost.model, inputTokens: (cost?.inputTokens ?? 0) + (result.cost.inputTokens ?? 0), outputTokens: (cost?.outputTokens ?? 0) + (result.cost.outputTokens ?? 0), amountUsd: (cost?.amountUsd ?? 0) + (result.cost.amountUsd ?? 0) };
        if (snapshots && !sameSemanticInputs(runnerInputs, await resolveCurrentInputs(record, { ...authorization, execution: sensor.execution, limits: accepted.limits }, space.spaceRoot))) throw new Error("Review inputs changed during the model request. Run the Check again.");
        skippedCount += result.skippedCount;
        if (skippedCount > 0) throw new Error("Check sensor skipped designated input; the run is incomplete.");
        const remainingFindings = accepted.limits.maximumFindings - findings.length;
        if (result.candidates.length > remainingFindings) throw new Error("Check sensor exceeded the accepted run finding limit.");
        for (const candidate of result.candidates) {
          throwIfAborted(signal);
          const finding = await admitWorkFoldCheckCandidate({
            root: space.spaceRoot,
            declaration: record.declaration,
            declarationDigest: record.digest,
            sensorDigest: authorization.sensorDigest,
            candidate,
            now: this.#now(),
            signal,
          });
          if (finding) findings.push(finding);
          else {
            discardedCount += 1;
            throw new Error("Check evidence could not be independently re-verified; the run is incomplete.");
          }
        }
      }
      throwIfAborted(signal);
      terminal = {
        ...accepted,
        state: "succeeded",
        endedAt: this.#now().toISOString(),
        inputs,
        ...(cost ? { cost } : {}),
        findings,
        admittedCount: findings.length,
        discardedCount,
        skippedCount,
      };
    } catch (error) {
      const aborted = signal.aborted;
      terminal = {
        ...accepted,
        state: aborted ? "aborted" : "failed",
        endedAt: this.#now().toISOString(),
        inputs,
        ...(cost ? { cost } : {}),
        findings: [],
        admittedCount: 0,
        discardedCount,
        skippedCount,
        error: aborted ? String(signal.reason || "Check run aborted.") : errorMessage(error),
      };
    }
    try {
      await store.finishRun(terminal);
    } catch {
      // Fail closed: retain the internal task and capability lock until the
      // exact terminal record can be made durable or process restart marks the
      // run interrupted. Polling/result calls retry this write, and the settle
      // signal waits with it — a settle is published only once its terminal
      // record is durable.
      this.#terminalRecovery.set(accepted.taskId, {
        spaceId: space.id,
        store,
        run: terminal,
        ...(lineage ? { lineage } : {}),
      });
      return;
    }
    this.#publishRunSettle(space.id, terminal, lineage);
  }

  async #enabledRecords(space: WorkFoldCheckSpaceRef, checkId?: string): Promise<WorkFoldCheckDeclarationRecord[]> {
    const discovery = await discoverWorkFoldCheckDeclarations(space.spaceRoot);
    const store = await this.#store(space.id);
    const state = store.snapshot();
    return discovery.declarations.filter((record) => {
      if (checkId && record.declaration.id !== checkId) return false;
      const authorization = exactAuthorization(state.authorizations[record.declaration.id], record);
      if (!authorization) return false;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.execution !== authorization.execution || sensor.implementationDigest !== authorization.sensorDigest) return false;
      sensor.validate(record.declaration);
      return true;
    });
  }

  async #problems(
    space: WorkFoldCheckSpaceRef,
    persistInvalidation: boolean,
    checkId?: string,
    knownDiscovery?: WorkFoldCheckDeclarationDiscovery,
  ): Promise<{
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    const discovery = knownDiscovery ?? await discoverWorkFoldCheckDeclarations(space.spaceRoot);
    const declarations = new Map(discovery.declarations.map((record) => [record.declaration.id, record]));
    const store = await this.#store(space.id);
    const state = store.snapshot();
    const decisions = state.decisions;
    const seen = new Set<string>();
    const findings: WorkFoldCheckFinding[] = [];
    const healthErrors: string[] = discovery.errors.map(() => "A Check declaration could not be read.");
    const nestedSpaceBlocked = new Set<string>();
    for (const record of discovery.declarations) {
      try {
        await this.#assertNoNestedSpaceTargets(space, record.declaration);
      } catch {
        nestedSpaceBlocked.add(record.declaration.id);
        healthErrors.push("A Check target now overlaps another registered Space.");
      }
    }
    let invalidated = 0;
    let truncated = false;
    for (const finding of state.runs.filter((run) => !run.trial).flatMap((run) => run.findings)) {
      if (checkId && finding.checkId !== checkId) continue;
      if (finding.status !== "active" || seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      const record = declarations.get(finding.checkId);
      if (nestedSpaceBlocked.has(finding.checkId)) continue;
      if (!record || record.digest !== finding.declarationDigest || !exactAuthorization(state.authorizations[finding.checkId], record)) continue;
      const authorization = state.authorizations[finding.checkId]!;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.implementationDigest !== authorization.sensorDigest || finding.sensorDigest !== authorization.sensorDigest) continue;
      let current = false;
      try {
        current = await reverifyWorkFoldCheckFinding(space.spaceRoot, record.declaration, finding);
      } catch {
        healthErrors.push("A finding could not be re-verified against its designated target.");
        continue;
      }
      if (!current) {
        invalidated += 1;
        if (persistInvalidation) await store.invalidateFinding(finding.fingerprint, "The designated evidence changed or no longer proves this finding.", this.#now());
        continue;
      }
      const decision = decisions[finding.fingerprint];
      if (decision?.decision === "reject" || decision?.decision === "resolve") continue;
      if (decision?.decision === "defer" && decision.deferUntil && Date.parse(decision.deferUntil) > this.#now().getTime()) continue;
      if (findings.length >= 250) {
        truncated = true;
        break;
      }
      findings.push(finding);
    }
    return { findings, invalidated, healthErrors, truncated };
  }

  async #rendererAuthorityState(
    space: WorkFoldCheckSpaceRef,
    record: WorkFoldCheckDeclarationRecord,
    savedAuthorization: WorkFoldCheckAuthorization | undefined,
  ): Promise<WorkFoldCheckRendererAuthorityState> {
    if (!savedAuthorization) return "proposed";
    const authorization = exactAuthorization(savedAuthorization, record);
    if (!authorization) return "blocked";
    const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
    if (!sensor
      || sensor.execution !== authorization.execution
      || sensor.implementationDigest !== authorization.sensorDigest) {
      return "blocked";
    }
    try {
      sensor.validate(record.declaration);
      await this.#assertNoNestedSpaceTargets(space, record.declaration);
      return "enabled";
    } catch {
      return "blocked";
    }
  }

  async #taskStatus(spaceId: string, taskId: string): Promise<WorkFoldCheckTaskStatus> {
    await this.#registeredSpaceId(spaceId);
    await this.#retryTerminalRecovery(taskId, spaceId);
    const run = (await this.#store(spaceId)).snapshot().runs.find((item) => item.taskId === taskId);
    if (!run) return { taskId, runId: null, state: "unknown", startedAt: null, endedAt: null, error: null };
    return {
      taskId,
      runId: run.id,
      state: this.#active.has(taskId) ? "running" : run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      error: run.error ?? null,
    };
  }

  #store(spaceId: string): Promise<WorkFoldCheckStore> {
    const existing = this.#stores.get(spaceId);
    if (existing) return existing;
    const created = this.#storeFactory(spaceId);
    this.#stores.set(spaceId, created);
    void created.catch(() => {
      if (this.#stores.get(spaceId) === created) this.#stores.delete(spaceId);
    });
    return created;
  }

  async #withOperationReservation<T>(spaceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#spaceRegistryMutationReserved
      || this.#spaceRemovalReservations.has(spaceId)
      || this.#operationReservations.has(spaceId)) {
      throw new WorkFoldCheckOperationConflictError();
    }
    this.#operationReservations.add(spaceId);
    try {
      return await operation();
    } finally {
      this.#operationReservations.delete(spaceId);
    }
  }

  async #registeredSpace(input: WorkFoldCheckSpaceRef): Promise<WorkFoldCheckSpaceRef> {
    const match = (await this.#listSpaces()).find((space) => space.id === input.id);
    if (!match) throw new Error("Registered Space not found.");
    if (resolve(match.spaceRoot) !== resolve(input.spaceRoot)) {
      throw new Error("The Check request does not match the registered Space folder.");
    }
    return { id: match.id, spaceRoot: match.spaceRoot };
  }

  async #registeredSpaceId(spaceId: string): Promise<void> {
    await this.#registeredSpaceById(spaceId);
  }

  async #registeredSpaceById(spaceId: string): Promise<WorkFoldCheckSpaceRef> {
    const space = (await this.#listSpaces()).find((item) => item.id === spaceId);
    if (!space) throw new Error("Registered Space not found.");
    return { id: space.id, spaceRoot: space.spaceRoot };
  }

  async #retryTerminalRecovery(taskId: string, spaceId?: string): Promise<boolean> {
    const recovery = this.#terminalRecovery.get(taskId);
    if (!recovery) return true;
    if (spaceId && recovery.spaceId !== spaceId) return false;
    try {
      await recovery.store.finishRun(recovery.run);
    } catch {
      return false;
    }
    this.#terminalRecovery.delete(taskId);
    this.#finishActiveTask(taskId);
    this.#publishRunSettle(recovery.spaceId, recovery.run, recovery.lineage);
    return true;
  }

  /**
   * The host notification behind `bridge.checks.onChanged`. Ids only, and the
   * listener's failure is contained here the way the settle signal contains
   * its own: publishing a change can never fail the Check operation that
   * produced it.
   */
  #publishResultChanged(spaceId: string, checkIds: readonly string[]): void {
    if (!this.#onResultChanged || !checkIds.length) return;
    try { this.#onResultChanged({ spaceId, checkIds: [...new Set(checkIds)] }); }
    catch { /* a host listener never fails a Check operation */ }
  }

  #finishActiveTask(taskId: string): void {
    if (!this.#active.delete(taskId)) return;
    this.#kernel.finishTask(taskId);
  }

  /**
   * Terminal-persistence funnel exit for the routing-trigger seam: called only
   * after the exact terminal run record is durable, exactly once per run. The
   * signal owns listener failure isolation, so publication can never fail a
   * Check run; a malformed non-terminal record is dropped rather than
   * published.
   */
  #publishRunSettle(spaceId: string, run: WorkFoldCheckRunRecord, lineage?: WorkFoldSettleLineage): void {
    if (run.trial) return;
    // A settled run is the moment a selected result changes, so the app hint
    // leaves from the same funnel. It is published before the routing seam so
    // a slow routing consumer cannot delay a view's re-read, and independently
    // of whether a settle signal is configured at all.
    if (run.state !== "accepted" && run.state !== "running" && run.endedAt) {
      this.#publishResultChanged(spaceId, run.checkIds);
    }
    if (!this.#settleSignal) return;
    if (run.state === "accepted" || run.state === "running" || !run.endedAt) return;
    this.#settleSignal.publish({
      kind: "check-run",
      spaceId,
      runId: run.id,
      taskId: run.taskId,
      checkIds: [...run.checkIds],
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      ...(lineage ? { lineage } : {}),
    });
  }

  async #assertNoNestedSpaceTargets(space: WorkFoldCheckSpaceRef, declaration: WorkFoldCheckDeclaration): Promise<void> {
    const root = resolve(space.spaceRoot);
    const nestedRoots = (await this.#listSpaces())
      .filter((item) => item.id !== space.id)
      .map((item) => relative(root, resolve(item.spaceRoot)))
      .filter((path) => path && path !== ".." && !path.startsWith(`..${sep}`))
      .map((path) => path.split(sep).join("/"));
    for (const target of declaration.targets) {
      const overlaps = nestedRoots.some((nested) => target.kind === "file"
        ? target.path === nested || target.path.startsWith(`${nested}/`)
        : target.path === nested || target.path.startsWith(`${nested}/`) || nested.startsWith(`${target.path}/`));
      if (overlaps) throw new Error("A Check target cannot enter another registered Space.");
    }
  }
}

function exactAuthorization(
  authorization: WorkFoldCheckAuthorization | undefined,
  record: WorkFoldCheckDeclarationRecord,
): WorkFoldCheckAuthorization | null {
  if (!authorization) return null;
  return authorization.declarationDigest === record.digest
    && authorization.sensorId === record.declaration.sensor.id
    && authorization.sensorRevision === record.declaration.sensor.revision
    ? authorization
    : null;
}

function proposalDeclarationIdentity(proposal: WorkFoldCheckProposal): string {
  return workFoldCheckDigest({
    ...proposal.check,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

function declarationIdentity(declaration: WorkFoldCheckDeclaration): string {
  return workFoldCheckDigest({
    title: declaration.title,
    severity: declaration.severity,
    trigger: declaration.trigger,
    sensor: declaration.sensor,
    targets: declaration.targets,
    createdBy: declaration.createdBy,
    createdAt: declaration.createdAt,
  });
}

async function resolveCurrentInputs(
  record: WorkFoldCheckDeclarationRecord,
  authorization: Pick<WorkFoldCheckAuthorization, "limits" | "execution">,
  root: string,
): Promise<WorkFoldCheckRunRecord["inputs"]> {
  const resolution = await resolveWorkFoldCheckTargets(root, record.declaration.targets, {
    limits: {
      maxFiles: authorization.limits.maximumFiles,
      maxFileBytes: authorization.limits.maximumFileBytes,
      maxTotalBytes: authorization.limits.maximumTotalBytes,
    },
  });
  const snapshots = authorization.execution === "model" ? await loadCheckTextSnapshots(root, resolution) : undefined;
  return runnerOwnedInputs(record.declaration.id, resolution, snapshots);
}

function runnerOwnedInputs(checkId: string, resolution: WorkFoldCheckTargetResolution, snapshots?: WorkFoldCheckTextSnapshot[]): WorkFoldCheckRunRecord["inputs"] {
  return [
    ...resolution.files.map((file) => ({ checkId, path: file.path, state: "file" as const, size: file.sizeBytes, ...(snapshots ? { sha256: snapshots.find((snapshot) => snapshot.path === file.path)!.sha256 } : {}) })),
    ...resolution.missingExactTargets.map((target) => ({ checkId, path: target.path, state: "missing" as const })),
  ].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function closedSensorInputs(resolution: WorkFoldCheckTargetResolution) {
  return {
    files: resolution.files.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
    missingExactTargets: resolution.missingExactTargets.map(({ path }) => ({ path })),
  };
}

function sameSemanticInputs(
  left: WorkFoldCheckRunRecord["inputs"],
  right: WorkFoldCheckRunRecord["inputs"],
): boolean {
  const normalize = (values: WorkFoldCheckRunRecord["inputs"]) => values
    .map(({ checkId, path, state, sha256 }) => ({ checkId, path, state, sha256: sha256 ?? null }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId) || a.path.localeCompare(b.path));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function latestRunForCheck(runs: WorkFoldCheckRunRecord[], checkId: string): WorkFoldCheckRunRecord | null {
  return runs.find((run) => !run.trial && run.checkIds.includes(checkId)) ?? null;
}

function intersectLimits(values: WorkFoldCheckRunLimits[]): WorkFoldCheckRunLimits {
  if (!values.length) return structuredClone(defaultRunLimits);
  return {
    maximumFiles: Math.min(...values.map((item) => item.maximumFiles)),
    maximumFileBytes: Math.min(...values.map((item) => item.maximumFileBytes)),
    maximumTotalBytes: Math.min(...values.map((item) => item.maximumTotalBytes)),
    maximumFindings: Math.min(...values.map((item) => item.maximumFindings)),
    timeoutMs: Math.min(...values.map((item) => item.timeoutMs)),
  };
}

function aggregateState(input: {
  configured: number;
  enabled: number;
  current: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  needsAttention: number;
}): WorkFoldCheckAggregateState {
  if (input.errors) return "check-error";
  if (input.blocked) return "blocked";
  if (!input.configured || !input.enabled) return "not-configured";
  if (input.needsAttention) return "needs-attention";
  if (input.neverRun || input.stale || input.current < input.enabled) return "stale";
  return "current-clear";
}

function maxTimestamp(left: string | null, right: string): string {
  return !left || right > left ? right : left;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(String(signal.reason || "Check run aborted."));
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error(String(signal.reason || "Check run aborted.")));
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Check run failed.");
}
