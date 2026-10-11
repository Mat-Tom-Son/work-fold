import { correctionId, normalizeCheckCorrection, readCheckCorrectionProposal, writeCheckCorrection, type CheckCorrectionProposal, type CheckCorrectionRecord } from "./check-corrections.js";
import { restrictedAppCheckLimits, type RestrictedAppCheckResult } from "../../shared/restricted-app-checks.js";
import { readCheckTextSnapshot } from "./check-text.js";
import { createWorkFolderMutationCheckpoint } from "../history.js";
import { withWorkFolderHistoryOperation } from "../work-folder.js";
import { normalizeWorkFoldCheckProposal } from "../../shared/checks.js";
import { createModelReviewSensor, type WorkFoldModelCheckReviewer } from "./model-review-sensor.js";
import { loadCheckTextSnapshots, modelCheckLimits, type WorkFoldCheckTextSnapshot } from "./check-text.js";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

import type { WorkFoldCheckDeclaration, WorkFoldCheckProposal } from "../../shared/checks.js";
import type { WorkFoldSettleLineage, WorkFoldSettleSignal } from "../automations/settle-signal.js";
import type { WorkFoldActor, WorkFoldKernel } from "../work-fold-kernel.js";
import { listWorkFolders, type WorkFolderSummary } from "../work-folder.js";
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
  maximumFiles: 100_000,
  maximumFileBytes: 1024 * 1024 * 1024,
  maximumTotalBytes: 16 * 1024 * 1024 * 1024,
  maximumFindings: 100_000,
  timeoutMs: 30 * 60_000,
});

export interface WorkFoldCheckWorkFolderRef {
  id: string;
  workFolderRoot: string;
}

export interface WorkFoldCheckServiceOptions {
  kernel: WorkFoldKernel;
  now?: () => Date;
  createRunId?: () => string;
  createTaskId?: () => string;
  storeFactory?: (workFolderId: string) => Promise<WorkFoldCheckStore>;
  listWorkFolders?: () => Promise<WorkFolderSummary[]>;
  reviewModel?: WorkFoldModelCheckReviewer;
  resolveSensor?: (id: string, revision: number) => WorkFoldCheckSensor | null;
  /** Automation-trigger seam; terminal runs are published only after they are durable. */
  settleSignal?: WorkFoldSettleSignal;
  /**
   * A selected Check's result may have changed, so a host can tell an app view
   * that reads it to re-read (docs/collaboration-contract.md, F30). Deliberately
   * separate from `settleSignal`, which keeps exactly one consumer: the automation
   * service. Carries ids only, and a listener that throws never fails the Check
   * operation that produced it.
   */
  onResultChanged?: (event: { workFolderId: string; checkIds: string[] }) => void;
}

interface ActiveCheckRun {
  workFolderId: string;
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
 * (the overview's check reader). Identifiers, terminal state, timestamps, and
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
  constructor(message = "Wait for the current Check operation in this work-folder to finish.") {
    super(message);
    this.name = "WorkFoldCheckOperationConflictError";
  }
}

export class WorkFoldCheckService {
  readonly #kernel: WorkFoldKernel;
  readonly #now: () => Date;
  readonly #createRunId: () => string;
  readonly #createTaskId: () => string;
  readonly #storeFactory: (workFolderId: string) => Promise<WorkFoldCheckStore>;
  readonly #listWorkFolders: () => Promise<WorkFolderSummary[]>;
  readonly #resolveSensor: (id: string, revision: number) => WorkFoldCheckSensor | null;
  readonly #settleSignal: WorkFoldSettleSignal | null;
  readonly #onResultChanged: WorkFoldCheckServiceOptions["onResultChanged"];
  readonly #stores = new Map<string, Promise<WorkFoldCheckStore>>();
  readonly #active = new Map<string, ActiveCheckRun>();
  readonly #runReservations = new Set<string>();
  readonly #operationReservations = new Set<string>();
  readonly #workFolderRemovalReservations = new Set<string>();
  #workFolderRegistryMutationReserved = false;
  readonly #terminalRecovery = new Map<string, {
    workFolderId: string;
    store: WorkFoldCheckStore;
    run: WorkFoldCheckRunRecord;
    lineage?: WorkFoldSettleLineage;
  }>();

  constructor(options: WorkFoldCheckServiceOptions) {
    this.#kernel = options.kernel;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? (() => `check-run-${randomUUID()}`);
    this.#createTaskId = options.createTaskId ?? (() => `check-task-${randomUUID()}`);
    this.#storeFactory = options.storeFactory ?? ((workFolderId) => WorkFoldCheckStore.create(workFolderId));
    this.#listWorkFolders = options.listWorkFolders ?? listWorkFolders;
    const modelSensor = createModelReviewSensor(options.reviewModel);
    this.#resolveSensor = options.resolveSensor ?? ((id, revision) => id === modelSensor.id && revision === modelSensor.revision ? modelSensor : resolveWorkFoldCheckSensor(id, revision));
    this.#settleSignal = options.settleSignal ?? null;
    this.#onResultChanged = options.onResultChanged;
  }

  enable(input: {
    workFolder: WorkFoldCheckWorkFolderRef;
    proposalPath?: string;
    proposal?: unknown;
    checkId?: string;
    expectedDigest?: string;
    actor: WorkFoldCheckAuthorization["enabledBy"];
    /** Materialize an inert proposal without granting run authority. */
    proposeOnly?: boolean;
  }): Promise<{ declaration: WorkFoldCheckDeclaration; digest: string }> {
    return this.#withOperationReservation(input.workFolder.id, async () => {
      const workFolder = await this.#registeredWorkFolder(input.workFolder);
      if ([input.proposalPath, input.proposal, input.checkId].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one Check proposal or existing Check.");
      let proposal: WorkFoldCheckProposal;
      if (input.checkId !== undefined) {
        const existing = (await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot)).declarations.find((item) => item.declaration.id === input.checkId);
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
      await this.#assertNoNestedWorkFolderTargets(workFolder, preview);
      const limits = sensor.execution === "model" ? modelCheckLimits : defaultRunLimits;
      await resolveWorkFoldCheckTargets(workFolder.workFolderRoot, preview.targets, {
        limits: {
          maxFiles: limits.maximumFiles,
          maxFileBytes: limits.maximumFileBytes,
          maxTotalBytes: limits.maximumTotalBytes,
        },
      });
      const discovery = await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot);
      const identity = proposalDeclarationIdentity(proposal);
      const written = discovery.declarations.find((record) => declarationIdentity(record.declaration) === identity)
        ?? await writeWorkFoldCheckDeclaration(workFolder.workFolderRoot, proposal);
      sensor.validate(written.declaration);
      if (input.proposeOnly) return { declaration: written.declaration, digest: written.digest };
      const store = await this.#store(workFolder.id);
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

  proposeCorrection(input: { workFolder: WorkFoldCheckWorkFolderRef; proposal?: unknown; proposalPath?: string }): Promise<CheckCorrectionRecord> {
    return this.#withOperationReservation(input.workFolder.id, async () => {
      const workFolder = await this.#registeredWorkFolder(input.workFolder);
      const proposal = input.proposalPath !== undefined ? await readCheckCorrectionProposal(input.proposalPath) : normalizeCheckCorrection(input.proposal);
      await this.#reviewCorrection(workFolder, proposal);
      const store = await this.#store(workFolder.id);
      const id = correctionId(proposal);
      const existing = store.snapshot().corrections?.find((item) => item.id === id);
      if (existing) return existing;
      const correction: CheckCorrectionRecord = { id, proposal, createdAt: this.#now().toISOString(), state: "pending" };
      await store.saveCorrection(correction);
      return correction;
    });
  }

  reviewCorrection(workFolder: WorkFoldCheckWorkFolderRef, id: string): Promise<{ correction: CheckCorrectionRecord; before: string }> {
    return this.#withOperationReservation(workFolder.id, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      const correction = (await this.#store(workFolder.id)).snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending.");
      const { before } = await this.#reviewCorrection(registered, correction.proposal);
      return { correction, before };
    });
  }

  dismissCorrection(workFolder: WorkFoldCheckWorkFolderRef, id: string): Promise<void> {
    return this.#withOperationReservation(workFolder.id, async () => {
      await this.#registeredWorkFolder(workFolder);
      const store = await this.#store(workFolder.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending.");
      await store.saveCorrection({ ...correction, state: "dismissed" });
    });
  }

  /** Caller also reserves app/Worker mutation authority. All content writes
   * retain their History checkpoint even after partial failure. No retry occurs. */
  applyCorrection(workFolder: WorkFoldCheckWorkFolderRef, id: string): Promise<{ correction: CheckCorrectionRecord; checkId: string }> {
    return this.#withOperationReservation(workFolder.id, () => withWorkFolderHistoryOperation(workFolder.workFolderRoot, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      if (this.#runReservations.has(workFolder.id) || [...this.#active.values()].some((run) => run.workFolderId === workFolder.id)) throw new WorkFoldCheckOperationConflictError("Wait for the Check run to finish before applying a correction.");
      const store = await this.#store(workFolder.id);
      const correction = store.snapshot().corrections?.find((item) => item.id === id);
      if (!correction || correction.state !== "pending") throw new WorkFoldCheckOperationConflictError("This correction is no longer pending. It was not applied again.");
      const reviewed = await this.#reviewCorrection(registered, correction.proposal);
      const safety = await createWorkFolderMutationCheckpoint(workFolder.workFolderRoot, { paths: [correction.proposal.path], reason: "check_correction", label: `Before Check correction: ${correction.proposal.path}` });
      if (!safety.files.some((file) => file.path === correction.proposal.path && file.hashSha256 === correction.proposal.beforeHash)) throw new Error("History could not preserve the exact file being corrected. Nothing was changed.");
      const applying = { ...correction, state: "applying" as const, checkpointId: safety.checkpointId };
      await store.saveCorrection(applying);
      try {
        await this.#reviewCorrection(registered, correction.proposal);
        await writeCheckCorrection(workFolder.workFolderRoot, correction.proposal);
        const applied = { ...applying, state: "applied" as const };
        await store.saveCorrection(applied);
        // The corrected file is the Check's own evidence, so an app reading
        // that selection is now holding an older answer.
        this.#publishResultChanged(workFolder.id, [reviewed.finding.checkId]);
        return { correction: applied, checkId: reviewed.finding.checkId };
      } catch (error) {
        await store.saveCorrection({ ...applying, state: "failed", error: errorMessage(error).slice(0, 2000) });
        throw new Error(`Correction did not finish. Inspect the file and History checkpoint ${safety.checkpointId}. ${errorMessage(error)}`);
      }
    }));
  }

  async #reviewCorrection(workFolder: WorkFoldCheckWorkFolderRef, proposal: CheckCorrectionProposal): Promise<{ finding: WorkFoldCheckFinding; before: string }> {
    const problems = await this.#problems(workFolder, false);
    const finding = problems.findings.find((item) => item.id === proposal.findingId && item.fingerprint === proposal.fingerprint && item.targetPath === proposal.path);
    if (!finding || !finding.evidence.some((evidence) => evidence.kind === "text-span" && evidence.identity.sha256 === proposal.beforeHash)) throw new WorkFoldCheckOperationConflictError("The finding or its inputs changed. Run the Check and prepare a fresh correction.");
    const snapshot = await readCheckTextSnapshot(workFolder.workFolderRoot, proposal.path, ["primary"]);
    if (snapshot.sha256 !== proposal.beforeHash) throw new WorkFoldCheckOperationConflictError("The file changed since the correction was prepared.");
    if (snapshot.text === proposal.replacement) throw new Error("The proposed correction does not change the file.");
    return { finding, before: snapshot.text };
  }

  disable(workFolder: WorkFoldCheckWorkFolderRef, checkId: string): Promise<boolean> {
    return this.#withOperationReservation(workFolder.id, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      const active = [...this.#active.values()].find((run) => run.workFolderId === registered.id && run.checkIds.includes(checkId));
      if (active) active.controller.abort("Check disabled.");
      const removed = await (await this.#store(registered.id)).disable(checkId);
      // An app holding this selection now reads a Check that is gone; it should
      // learn that from a hint rather than from its next stale render.
      if (removed) this.#publishResultChanged(registered.id, [checkId]);
      return removed;
    });
  }

  tryReserveWorkFolderRemoval(workFolderId: string): (() => void) | null {
    if (this.#workFolderRegistryMutationReserved
      || this.#workFolderRemovalReservations.has(workFolderId)
      || this.#runReservations.has(workFolderId)
      || this.#operationReservations.has(workFolderId)
      || [...this.#active.values()].some((run) => run.workFolderId === workFolderId)) return null;
    this.#workFolderRemovalReservations.add(workFolderId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#workFolderRemovalReservations.delete(workFolderId);
    };
  }

  tryReserveWorkFolderRegistryMutation(): (() => void) | null {
    if (this.#workFolderRegistryMutationReserved || this.hasActiveRun()) return null;
    this.#workFolderRegistryMutationReserved = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#workFolderRegistryMutationReserved = false;
    };
  }

  async removeWorkFolder(workFolderId: string): Promise<void> {
    let releaseOwnReservation: (() => void) | null = null;
    if (!this.#workFolderRemovalReservations.has(workFolderId)) {
      releaseOwnReservation = this.tryReserveWorkFolderRemoval(workFolderId);
      if (!releaseOwnReservation) throw new WorkFoldCheckOperationConflictError("Wait for the current Check operation before removing this work-folder.");
    }
    try {
      const active = [...this.#active.entries()].filter(([, run]) => run.workFolderId === workFolderId);
      for (const [, run] of active) run.controller.abort("work-folder removed.");
      await Promise.allSettled(active.map(([, run]) => run.promise));
      const cachedStore = this.#stores.get(workFolderId);
      if (cachedStore) {
        try {
          await (await cachedStore).purge();
        } catch {
          await purgeWorkFoldCheckState(workFolderId);
        }
      } else {
        await purgeWorkFoldCheckState(workFolderId);
      }
      for (const [taskId] of active) {
        this.#terminalRecovery.delete(taskId);
        this.#finishActiveTask(taskId);
      }
      this.#stores.delete(workFolderId);
    } finally {
      releaseOwnReservation?.();
    }
  }

  status(workFolder: WorkFoldCheckWorkFolderRef): Promise<WorkFoldCheckStatusSnapshot> {
    return this.#withOperationReservation(workFolder.id, async () => this.#status(await this.#registeredWorkFolder(workFolder)));
  }

  /**
   * Content-free summaries of this work-folder's settled Check runs, for the
   * overview (docs/work-fold-agent-overview.md): identifiers, terminal state,
   * timestamps, and the admitted count only — never findings, evidence, paths,
   * or inputs. This is
   * a plain read over the store's persisted run records, deliberately outside
   * the per-work-folder operation reservation so composing the overview never
   * conflicts with (or blocks) running Check work.
   */
  async settledRuns(workFolder: WorkFoldCheckWorkFolderRef): Promise<WorkFoldCheckSettledRunSummary[]> {
    const registered = await this.#registeredWorkFolder(workFolder);
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

  decorations(workFolder: WorkFoldCheckWorkFolderRef): Promise<WorkFoldCheckRendererDecorations> {
    return this.#withOperationReservation(workFolder.id, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      const problems = await this.#problems(registered, false);
      const counts = new Map<string, number>();
      for (const finding of problems.findings) {
        counts.set(finding.targetPath, (counts.get(finding.targetPath) ?? 0) + 1);
      }
      return {
        kind: "work-fold.checks.decorations",
        version: workFoldCheckExperimentalSnapshotVersion,
        workFolderId: registered.id,
        items: [...counts.entries()]
          .sort(([left], [right]) => left.localeCompare(right, "en-US"))
          .map(([path, count]) => ({ path, count })),
      };
    });
  }

  overview(workFolder: WorkFoldCheckWorkFolderRef): Promise<WorkFoldCheckRendererOverview> {
    return this.#withOperationReservation(workFolder.id, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      const discovery = await discoverWorkFoldCheckDeclarations(registered.workFolderRoot);
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
        workFolderId: registered.id,
        status,
        checks,
        corrections: state.corrections ?? [],
        ...problems,
      };
    });
  }

  /** Re-verifies only the selected Check's targets. Never runs a sensor. */
  selectedResult(workFolder: WorkFoldCheckWorkFolderRef, checkId: string, declarationDigest: string): Promise<RestrictedAppCheckResult> {
    return this.#withOperationReservation(workFolder.id, async () => {
      const registered = await this.#registeredWorkFolder(workFolder);
      const discovered = await discoverWorkFoldCheckDeclarations(registered.workFolderRoot);
      const record = discovered.declarations.find((item) => item.declaration.id === checkId && item.digest === declarationDigest);
      if (!record) throw new WorkFoldCheckOperationConflictError("The selected Check changed or is unavailable. Choose it again in Apps.");
      const discovery = { declarations: [record], errors: [] };
      const state = (await this.#store(registered.id)).snapshot();
      const problems = await this.#problems(registered, true, checkId, discovery);
      const status = await this.#status(registered, problems, { discovery, state });
      const running = [...this.#active.values()].some((run) => run.workFolderId === registered.id && run.checkIds.includes(checkId));
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
    registered: WorkFoldCheckWorkFolderRef,
    knownProblems?: WorkFoldCheckProblemsResult,
    knownSnapshot?: { discovery: WorkFoldCheckDeclarationDiscovery; state: WorkFoldCheckMachineState },
  ): Promise<WorkFoldCheckStatusSnapshot> {
    const discovery = knownSnapshot?.discovery ?? await discoverWorkFoldCheckDeclarations(registered.workFolderRoot);
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
        await this.#assertNoNestedWorkFolderTargets(registered, record.declaration);
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
        const inputs = await resolveCurrentInputs(record, authorization, registered.workFolderRoot);
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
    const running = [...this.#active.values()].filter((run) => run.workFolderId === registered.id).length;
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
      workFolderId: registered.id,
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
    workFolder: WorkFoldCheckWorkFolderRef;
    checkId?: string;
    /** One explicitly reviewed run; never a standing grant or a live result. */
    trialDigest?: string;
    actor: WorkFoldActor;
    /** Stamped on the settle record so automation-caused runs never fire triggers. */
    lineage?: WorkFoldSettleLineage;
  }): Promise<{ taskId: string; runId: string; checkIds: string[] }> {
    if (this.#runReservations.has(input.workFolder.id) || this.hasActiveRun(input.workFolder.id)) {
      throw new WorkFoldCheckOperationConflictError("Wait for the current Check run in this work-folder to finish.");
    }
    this.#runReservations.add(input.workFolder.id);
    try {
    const workFolder = await this.#registeredWorkFolder(input.workFolder);
    const trial = input.trialDigest !== undefined;
    const records = trial
      ? (await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot)).declarations.filter((record) => record.declaration.id === input.checkId && record.digest === input.trialDigest)
      : await this.#enabledRecords(workFolder, input.checkId);
    if (trial && records.length !== 1) throw new WorkFoldCheckOperationConflictError("This proposal changed. Refresh and review it before trying it.");
    if (!records.length) throw new Error(input.checkId ? "Enabled Check not found." : "This work-folder has no enabled Checks.");
    const checkIds = records.map((record) => record.declaration.id).sort();
    const state = (await this.#store(workFolder.id)).snapshot();
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
    const store = await this.#store(workFolder.id);
    await store.acceptRun(accepted);
    try {
      this.#kernel.startExperimentalCheckRunTask({ id: taskId, workFolderId: workFolder.id, actor: input.actor });
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
      this.#publishRunSettle(workFolder.id, terminal, input.lineage);
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Check run exceeded its approved duration."), limits.timeoutMs);
    timeout.unref?.();
    const active: ActiveCheckRun = {
      workFolderId: workFolder.id,
      runId,
      checkIds,
      controller,
      promise: Promise.resolve(),
    };
    this.#active.set(taskId, active);
    active.promise = this.#execute(workFolder, records, accepted, controller.signal, input.lineage)
      .finally(() => {
        clearTimeout(timeout);
        if (!this.#terminalRecovery.has(taskId)) this.#finishActiveTask(taskId);
      });
    return { taskId, runId, checkIds };
    } finally {
      this.#runReservations.delete(input.workFolder.id);
    }
  }

  taskStatus(workFolderId: string, taskId: string): Promise<WorkFoldCheckTaskStatus> {
    return this.#withOperationReservation(workFolderId, () => this.#taskStatus(workFolderId, taskId));
  }

  taskResult(workFolderId: string, taskId: string): Promise<WorkFoldCheckRunRecord> {
    return this.#withOperationReservation(workFolderId, () => this.#taskResult(workFolderId, taskId));
  }

  async #taskResult(workFolderId: string, taskId: string): Promise<WorkFoldCheckRunRecord> {
    await this.#registeredWorkFolderId(workFolderId);
    await this.#retryTerminalRecovery(taskId, workFolderId);
    const active = this.#active.get(taskId);
    if (active?.workFolderId === workFolderId) throw new Error("The Check run is still running.");
    const run = (await this.#store(workFolderId)).snapshot().runs.find((item) => item.taskId === taskId);
    if (!run) throw new Error("Check task not found.");
    if (run.state === "accepted" || run.state === "running") throw new Error("The Check run is still running.");
    return run;
  }

  abort(workFolderId: string, taskId: string): Promise<boolean> {
    return this.#withOperationReservation(workFolderId, () => this.#abort(workFolderId, taskId));
  }

  async #abort(workFolderId: string, taskId: string): Promise<boolean> {
    await this.#registeredWorkFolderId(workFolderId);
    const active = this.#active.get(taskId);
    if (!active || active.workFolderId !== workFolderId) return false;
    active.controller.abort("Check run aborted.");
    await active.promise;
    await this.#retryTerminalRecovery(taskId, workFolderId);
    return true;
  }

  problems(workFolder: WorkFoldCheckWorkFolderRef, checkId?: string): Promise<{
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    return this.#withOperationReservation(workFolder.id, async () => this.#problems(await this.#registeredWorkFolder(workFolder), true, checkId));
  }

  decide(input: {
    workFolderId: string;
    findingId: string;
    decision: WorkFoldCheckDecisionKind;
    actor: WorkFoldCheckDecision["actor"];
    deferUntil?: string;
    note?: string;
  }): Promise<WorkFoldCheckDecision> {
    return this.#withOperationReservation(input.workFolderId, async () => {
      const workFolder = await this.#registeredWorkFolderById(input.workFolderId);
      const store = await this.#store(input.workFolderId);
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
      const discovery = await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot);
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
        await this.#assertNoNestedWorkFolderTargets(workFolder, record.declaration);
        if (!await reverifyWorkFoldCheckFinding(workFolder.workFolderRoot, record.declaration, finding)) {
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

  hasActiveRun(workFolderId?: string): boolean {
    return this.#workFolderRegistryMutationReserved
      || [...this.#active.values()].some((run) => workFolderId === undefined || run.workFolderId === workFolderId)
      || [...this.#runReservations].some((id) => workFolderId === undefined || id === workFolderId)
      || [...this.#operationReservations].some((id) => workFolderId === undefined || id === workFolderId)
      || [...this.#workFolderRemovalReservations].some((id) => workFolderId === undefined || id === workFolderId);
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort("work-fold is closing.");
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.#terminalRecovery.keys()].map((taskId) => this.#retryTerminalRecovery(taskId)));
    await Promise.allSettled([...this.#stores.values()].map(async (store) => (await store).flush()));
  }

  async #execute(
    workFolder: WorkFoldCheckWorkFolderRef,
    records: WorkFoldCheckDeclarationRecord[],
    accepted: WorkFoldCheckRunRecord,
    signal: AbortSignal,
    lineage?: WorkFoldSettleLineage,
  ): Promise<void> {
    const store = await this.#store(workFolder.id);
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
        (await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot)).declarations
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
        await this.#assertNoNestedWorkFolderTargets(workFolder, record.declaration);
        const remainingFiles = accepted.limits.maximumFiles - usedFiles;
        const remainingBytes = accepted.limits.maximumTotalBytes - usedBytes;
        if (remainingFiles < 1 || remainingBytes < 0) throw new Error("Check run exhausted its approved input budget.");
        const resolution = await resolveWorkFoldCheckTargets(workFolder.workFolderRoot, record.declaration.targets, {
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
        const snapshots = sensor.execution === "model" ? await loadCheckTextSnapshots(workFolder.workFolderRoot, resolution, signal) : undefined;
        const runnerInputs = runnerOwnedInputs(record.declaration.id, resolution, snapshots);
        inputs.push(...runnerInputs);
        throwIfAborted(signal);
        const result = await withAbort(sensor.run({
          declaration: record.declaration,
          inputs: { ...closedSensorInputs(resolution), ...(snapshots ? { snapshots } : {}) },
          signal,
        }), signal);
        if (result.cost) cost = { model: result.cost.model, inputTokens: (cost?.inputTokens ?? 0) + (result.cost.inputTokens ?? 0), outputTokens: (cost?.outputTokens ?? 0) + (result.cost.outputTokens ?? 0), amountUsd: (cost?.amountUsd ?? 0) + (result.cost.amountUsd ?? 0) };
        if (snapshots && !sameSemanticInputs(runnerInputs, await resolveCurrentInputs(record, { ...authorization, execution: sensor.execution, limits: accepted.limits }, workFolder.workFolderRoot))) throw new Error("Review inputs changed during the model request. Run the Check again.");
        skippedCount += result.skippedCount;
        if (skippedCount > 0) throw new Error("Check sensor skipped designated input; the run is incomplete.");
        const remainingFindings = accepted.limits.maximumFindings - findings.length;
        if (result.candidates.length > remainingFindings) throw new Error("Check sensor exceeded the accepted run finding limit.");
        for (const candidate of result.candidates) {
          throwIfAborted(signal);
          const finding = await admitWorkFoldCheckCandidate({
            root: workFolder.workFolderRoot,
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
        workFolderId: workFolder.id,
        store,
        run: terminal,
        ...(lineage ? { lineage } : {}),
      });
      return;
    }
    this.#publishRunSettle(workFolder.id, terminal, lineage);
  }

  async #enabledRecords(workFolder: WorkFoldCheckWorkFolderRef, checkId?: string): Promise<WorkFoldCheckDeclarationRecord[]> {
    const discovery = await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot);
    const store = await this.#store(workFolder.id);
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
    workFolder: WorkFoldCheckWorkFolderRef,
    persistInvalidation: boolean,
    checkId?: string,
    knownDiscovery?: WorkFoldCheckDeclarationDiscovery,
  ): Promise<{
    findings: WorkFoldCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    const discovery = knownDiscovery ?? await discoverWorkFoldCheckDeclarations(workFolder.workFolderRoot);
    const declarations = new Map(discovery.declarations.map((record) => [record.declaration.id, record]));
    const store = await this.#store(workFolder.id);
    const state = store.snapshot();
    const decisions = state.decisions;
    const seen = new Set<string>();
    const findings: WorkFoldCheckFinding[] = [];
    const healthErrors: string[] = discovery.errors.map(() => "A Check declaration could not be read.");
    const nestedWorkFolderBlocked = new Set<string>();
    for (const record of discovery.declarations) {
      try {
        await this.#assertNoNestedWorkFolderTargets(workFolder, record.declaration);
      } catch {
        nestedWorkFolderBlocked.add(record.declaration.id);
        healthErrors.push("A Check target now overlaps another registered work-folder.");
      }
    }
    let invalidated = 0;
    let truncated = false;
    for (const finding of state.runs.filter((run) => !run.trial).flatMap((run) => run.findings)) {
      if (checkId && finding.checkId !== checkId) continue;
      if (finding.status !== "active" || seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      const record = declarations.get(finding.checkId);
      if (nestedWorkFolderBlocked.has(finding.checkId)) continue;
      if (!record || record.digest !== finding.declarationDigest || !exactAuthorization(state.authorizations[finding.checkId], record)) continue;
      const authorization = state.authorizations[finding.checkId]!;
      const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
      if (!sensor || sensor.implementationDigest !== authorization.sensorDigest || finding.sensorDigest !== authorization.sensorDigest) continue;
      let current = false;
      try {
        current = await reverifyWorkFoldCheckFinding(workFolder.workFolderRoot, record.declaration, finding);
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
      findings.push(finding);
    }
    return { findings, invalidated, healthErrors, truncated };
  }

  async #rendererAuthorityState(
    workFolder: WorkFoldCheckWorkFolderRef,
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
      await this.#assertNoNestedWorkFolderTargets(workFolder, record.declaration);
      return "enabled";
    } catch {
      return "blocked";
    }
  }

  async #taskStatus(workFolderId: string, taskId: string): Promise<WorkFoldCheckTaskStatus> {
    await this.#registeredWorkFolderId(workFolderId);
    await this.#retryTerminalRecovery(taskId, workFolderId);
    const run = (await this.#store(workFolderId)).snapshot().runs.find((item) => item.taskId === taskId);
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

  #store(workFolderId: string): Promise<WorkFoldCheckStore> {
    const existing = this.#stores.get(workFolderId);
    if (existing) return existing;
    const created = this.#storeFactory(workFolderId);
    this.#stores.set(workFolderId, created);
    void created.catch(() => {
      if (this.#stores.get(workFolderId) === created) this.#stores.delete(workFolderId);
    });
    return created;
  }

  async #withOperationReservation<T>(workFolderId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#workFolderRegistryMutationReserved
      || this.#workFolderRemovalReservations.has(workFolderId)
      || this.#operationReservations.has(workFolderId)) {
      throw new WorkFoldCheckOperationConflictError();
    }
    this.#operationReservations.add(workFolderId);
    try {
      return await operation();
    } finally {
      this.#operationReservations.delete(workFolderId);
    }
  }

  async #registeredWorkFolder(input: WorkFoldCheckWorkFolderRef): Promise<WorkFoldCheckWorkFolderRef> {
    const match = (await this.#listWorkFolders()).find((workFolder) => workFolder.id === input.id);
    if (!match) throw new Error("Registered work-folder not found.");
    if (resolve(match.workFolderRoot) !== resolve(input.workFolderRoot)) {
      throw new Error("The Check request does not match the registered work-folder's folder.");
    }
    return { id: match.id, workFolderRoot: match.workFolderRoot };
  }

  async #registeredWorkFolderId(workFolderId: string): Promise<void> {
    await this.#registeredWorkFolderById(workFolderId);
  }

  async #registeredWorkFolderById(workFolderId: string): Promise<WorkFoldCheckWorkFolderRef> {
    const workFolder = (await this.#listWorkFolders()).find((item) => item.id === workFolderId);
    if (!workFolder) throw new Error("Registered work-folder not found.");
    return { id: workFolder.id, workFolderRoot: workFolder.workFolderRoot };
  }

  async #retryTerminalRecovery(taskId: string, workFolderId?: string): Promise<boolean> {
    const recovery = this.#terminalRecovery.get(taskId);
    if (!recovery) return true;
    if (workFolderId && recovery.workFolderId !== workFolderId) return false;
    try {
      await recovery.store.finishRun(recovery.run);
    } catch {
      return false;
    }
    this.#terminalRecovery.delete(taskId);
    this.#finishActiveTask(taskId);
    this.#publishRunSettle(recovery.workFolderId, recovery.run, recovery.lineage);
    return true;
  }

  /**
   * The host notification behind `bridge.checks.onChanged`. Ids only, and the
   * listener's failure is contained here the way the settle signal contains
   * its own: publishing a change can never fail the Check operation that
   * produced it.
   */
  #publishResultChanged(workFolderId: string, checkIds: readonly string[]): void {
    if (!this.#onResultChanged || !checkIds.length) return;
    try { this.#onResultChanged({ workFolderId, checkIds: [...new Set(checkIds)] }); }
    catch { /* a host listener never fails a Check operation */ }
  }

  #finishActiveTask(taskId: string): void {
    if (!this.#active.delete(taskId)) return;
    this.#kernel.finishTask(taskId);
  }

  /**
   * Terminal-persistence funnel exit for the automation-trigger seam: called only
   * after the exact terminal run record is durable, exactly once per run. The
   * signal owns listener failure isolation, so publication can never fail a
   * Check run; a malformed non-terminal record is dropped rather than
   * published.
   */
  #publishRunSettle(workFolderId: string, run: WorkFoldCheckRunRecord, lineage?: WorkFoldSettleLineage): void {
    if (run.trial) return;
    // A settled run is the moment a selected result changes, so the app hint
    // leaves from the same funnel. It is published before the automation seam so
    // a slow automation consumer cannot delay a view's re-read, and independently
    // of whether a settle signal is configured at all.
    if (run.state !== "accepted" && run.state !== "running" && run.endedAt) {
      this.#publishResultChanged(workFolderId, run.checkIds);
    }
    if (!this.#settleSignal) return;
    if (run.state === "accepted" || run.state === "running" || !run.endedAt) return;
    this.#settleSignal.publish({
      kind: "check-run",
      workFolderId,
      runId: run.id,
      taskId: run.taskId,
      checkIds: [...run.checkIds],
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      ...(lineage ? { lineage } : {}),
    });
  }

  async #assertNoNestedWorkFolderTargets(workFolder: WorkFoldCheckWorkFolderRef, declaration: WorkFoldCheckDeclaration): Promise<void> {
    const root = resolve(workFolder.workFolderRoot);
    const nestedRoots = (await this.#listWorkFolders())
      .filter((item) => item.id !== workFolder.id)
      .map((item) => relative(root, resolve(item.workFolderRoot)))
      .filter((path) => path && path !== ".." && !path.startsWith(`..${sep}`))
      .map((path) => path.split(sep).join("/"));
    for (const target of declaration.targets) {
      const overlaps = nestedRoots.some((nested) => target.kind === "file"
        ? target.path === nested || target.path.startsWith(`${nested}/`)
        : target.path === nested || target.path.startsWith(`${nested}/`) || nested.startsWith(`${target.path}/`));
      if (overlaps) throw new Error("A Check target cannot enter another registered work-folder.");
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
