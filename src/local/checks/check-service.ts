import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";

import type { WorkspaceCheckDeclaration, WorkspaceCheckProposal } from "../../shared/checks.js";
import type { WorkspaceActor, WorkspaceKernel } from "../workspace-kernel.js";
import { listWorkspaces, type WorkspaceSummary } from "../workspace.js";
import {
  discoverWorkspaceCheckDeclarations,
  readWorkspaceCheckProposal,
  writeWorkspaceCheckDeclaration,
  type WorkspaceCheckDeclarationRecord,
} from "./check-declarations.js";
import { admitWorkspaceCheckCandidate, reverifyWorkspaceCheckFinding } from "./check-admission.js";
import { workspaceCheckDigest } from "./check-integrity.js";
import { resolveWorkspaceCheckSensor, type WorkspaceCheckSensor } from "./check-sensors.js";
import { WorkspaceCheckStore, purgeWorkspaceCheckState } from "./check-store.js";
import type {
  WorkspaceCheckAggregateState,
  WorkspaceCheckAuthorization,
  WorkspaceCheckDecision,
  WorkspaceCheckDecisionKind,
  WorkspaceCheckFinding,
  WorkspaceCheckRunLimits,
  WorkspaceCheckRunRecord,
  WorkspaceCheckStatusSnapshot,
} from "./check-types.js";
import { workspaceCheckExperimentalSnapshotVersion } from "./check-types.js";
import { resolveWorkspaceCheckTargets, type WorkspaceCheckTargetResolution } from "./target-resolver.js";

const defaultRunLimits: WorkspaceCheckRunLimits = Object.freeze({
  maximumFiles: 512,
  maximumFileBytes: 64 * 1024 * 1024,
  maximumTotalBytes: 256 * 1024 * 1024,
  maximumFindings: 256,
  timeoutMs: 30_000,
});

export interface WorkspaceCheckSpaceRef {
  id: string;
  rootPath: string;
}

export interface WorkspaceCheckServiceOptions {
  kernel: WorkspaceKernel;
  now?: () => Date;
  createRunId?: () => string;
  createTaskId?: () => string;
  storeFactory?: (workspaceId: string) => Promise<WorkspaceCheckStore>;
  listSpaces?: () => Promise<WorkspaceSummary[]>;
  resolveSensor?: (id: string, revision: number) => WorkspaceCheckSensor | null;
}

interface ActiveCheckRun {
  workspaceId: string;
  runId: string;
  checkIds: string[];
  controller: AbortController;
  promise: Promise<void>;
}

export interface WorkspaceCheckTaskStatus {
  taskId: string;
  runId: string | null;
  state: WorkspaceCheckRunRecord["state"] | "unknown";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export class WorkspaceCheckService {
  readonly #kernel: WorkspaceKernel;
  readonly #now: () => Date;
  readonly #createRunId: () => string;
  readonly #createTaskId: () => string;
  readonly #storeFactory: (workspaceId: string) => Promise<WorkspaceCheckStore>;
  readonly #listSpaces: () => Promise<WorkspaceSummary[]>;
  readonly #resolveSensor: (id: string, revision: number) => WorkspaceCheckSensor | null;
  readonly #stores = new Map<string, Promise<WorkspaceCheckStore>>();
  readonly #active = new Map<string, ActiveCheckRun>();
  readonly #runReservations = new Set<string>();
  readonly #operationReservations = new Set<string>();
  readonly #spaceRemovalReservations = new Set<string>();
  #spaceRegistryMutationReserved = false;
  readonly #terminalRecovery = new Map<string, { store: WorkspaceCheckStore; run: WorkspaceCheckRunRecord }>();

  constructor(options: WorkspaceCheckServiceOptions) {
    this.#kernel = options.kernel;
    this.#now = options.now ?? (() => new Date());
    this.#createRunId = options.createRunId ?? (() => `check-run-${randomUUID()}`);
    this.#createTaskId = options.createTaskId ?? (() => `check-task-${randomUUID()}`);
    this.#storeFactory = options.storeFactory ?? ((workspaceId) => WorkspaceCheckStore.create(workspaceId));
    this.#listSpaces = options.listSpaces ?? listWorkspaces;
    this.#resolveSensor = options.resolveSensor ?? resolveWorkspaceCheckSensor;
  }

  enable(input: {
    space: WorkspaceCheckSpaceRef;
    proposalPath: string;
    actor: WorkspaceCheckAuthorization["enabledBy"];
  }): Promise<{ declaration: WorkspaceCheckDeclaration; digest: string }> {
    return this.#withOperationReservation(input.space.id, async () => {
      const space = await this.#registeredSpace(input.space);
      const proposal = await readWorkspaceCheckProposal(input.proposalPath);
      const sensor = this.#resolveSensor(proposal.check.sensor.id, proposal.check.sensor.revision);
      if (!sensor) throw new Error("The proposed Check requires a sensor revision that is not installed.");
      const preview: WorkspaceCheckDeclaration = {
        kind: "workspace.check",
        version: 1,
        id: "check-preview0",
        ...proposal.check,
        createdBy: proposal.createdBy,
        createdAt: proposal.createdAt,
      };
      sensor.validate(preview);
      await this.#assertNoNestedSpaceTargets(space, preview);
      await resolveWorkspaceCheckTargets(space.rootPath, preview.targets, {
        limits: {
          maxFiles: defaultRunLimits.maximumFiles,
          maxFileBytes: defaultRunLimits.maximumFileBytes,
          maxTotalBytes: defaultRunLimits.maximumTotalBytes,
        },
      });
      const discovery = await discoverWorkspaceCheckDeclarations(space.rootPath);
      const identity = proposalDeclarationIdentity(proposal);
      const written = discovery.declarations.find((record) => declarationIdentity(record.declaration) === identity)
        ?? await writeWorkspaceCheckDeclaration(space.rootPath, proposal);
      sensor.validate(written.declaration);
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
        defaultRunLimits,
      );
      return { declaration: written.declaration, digest: written.digest };
    });
  }

  disable(space: WorkspaceCheckSpaceRef, checkId: string): Promise<boolean> {
    return this.#withOperationReservation(space.id, async () => {
      const registered = await this.#registeredSpace(space);
      const active = [...this.#active.values()].find((run) => run.workspaceId === registered.id && run.checkIds.includes(checkId));
      if (active) active.controller.abort("Check disabled.");
      return (await this.#store(registered.id)).disable(checkId);
    });
  }

  tryReserveSpaceRemoval(spaceId: string): (() => void) | null {
    if (this.#spaceRegistryMutationReserved
      || this.#spaceRemovalReservations.has(spaceId)
      || this.#runReservations.has(spaceId)
      || this.#operationReservations.has(spaceId)
      || [...this.#active.values()].some((run) => run.workspaceId === spaceId)) return null;
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
      if (!releaseOwnReservation) throw new Error("Wait for the current Check operation before removing this Space.");
    }
    try {
      const active = [...this.#active.entries()].filter(([, run]) => run.workspaceId === spaceId);
      for (const [, run] of active) run.controller.abort("Space removed.");
      await Promise.allSettled(active.map(([, run]) => run.promise));
      const cachedStore = this.#stores.get(spaceId);
      if (cachedStore) {
        try {
          await (await cachedStore).purge();
        } catch {
          await purgeWorkspaceCheckState(spaceId);
        }
      } else {
        await purgeWorkspaceCheckState(spaceId);
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

  status(space: WorkspaceCheckSpaceRef): Promise<WorkspaceCheckStatusSnapshot> {
    return this.#withOperationReservation(space.id, async () => this.#status(await this.#registeredSpace(space)));
  }

  async #status(registered: WorkspaceCheckSpaceRef): Promise<WorkspaceCheckStatusSnapshot> {
    const discovery = await discoverWorkspaceCheckDeclarations(registered.rootPath);
    const state = (await this.#store(registered.id)).snapshot();
    let proposed = 0;
    let enabled = 0;
    let current = 0;
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
      if (!run) continue;
      lastRunAt = maxTimestamp(lastRunAt, run.endedAt ?? run.startedAt);
      if (run.state === "accepted" || run.state === "running") continue;
      if (run.state !== "succeeded") {
        errors += 1;
        continue;
      }
      try {
        const inputs = await resolveCurrentInputs(record, authorization, registered.rootPath);
        if (sameSemanticInputs(inputs, run.inputs.filter((item) => item.checkId === record.declaration.id))) current += 1;
        else stale += 1;
      } catch {
        blocked += 1;
      }
    }

    try {
      needsAttention = (await this.#problems(registered, false)).findings.length;
    } catch {
      errors += 1;
    }
    const running = [...this.#active.values()].filter((run) => run.workspaceId === registered.id).length;
    const aggregate = aggregateState({
      configured: discovery.declarations.length,
      enabled,
      current,
      stale,
      blocked,
      errors,
      needsAttention,
    });
    return {
      kind: "workspace.checks.experimental",
      version: workspaceCheckExperimentalSnapshotVersion,
      workspaceId: registered.id,
      state: aggregate,
      configured: discovery.declarations.length,
      proposed,
      enabled,
      current,
      stale,
      blocked,
      errors,
      needsAttention,
      running,
      lastRunAt,
    };
  }

  async run(input: {
    space: WorkspaceCheckSpaceRef;
    checkId?: string;
    actor: WorkspaceActor;
  }): Promise<{ taskId: string; runId: string; checkIds: string[] }> {
    if (this.#runReservations.has(input.space.id) || this.hasActiveRun(input.space.id)) {
      throw new Error("Wait for the current Check run in this Space to finish.");
    }
    this.#runReservations.add(input.space.id);
    try {
    const space = await this.#registeredSpace(input.space);
    const records = await this.#enabledRecords(space, input.checkId);
    if (!records.length) throw new Error(input.checkId ? "Enabled Check not found." : "This Space has no enabled Checks.");
    const checkIds = records.map((record) => record.declaration.id).sort();
    const state = (await this.#store(space.id)).snapshot();
    const authorities = records.map((record) => state.authorizations[record.declaration.id]!).map((authorization) => ({
      checkId: authorization.checkId,
      declarationDigest: authorization.declarationDigest,
      sensorId: authorization.sensorId,
      sensorRevision: authorization.sensorRevision,
      sensorDigest: authorization.sensorDigest,
    }));
    const limits = intersectLimits(records.map((record) => state.authorizations[record.declaration.id]!.limits));
    const taskId = this.#createTaskId();
    const runId = this.#createRunId();
    const accepted: WorkspaceCheckRunRecord = {
      id: runId,
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
      this.#kernel.startExperimentalCheckRunTask({ id: taskId, workspaceId: space.id, actor: input.actor });
      await store.markRunRunning(runId);
    } catch (error) {
      this.#kernel.finishTask(taskId);
      await store.finishRun({ ...accepted, state: "failed", endedAt: this.#now().toISOString(), error: errorMessage(error) });
      throw error;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Check run exceeded its approved duration."), limits.timeoutMs);
    timeout.unref?.();
    const active: ActiveCheckRun = {
      workspaceId: space.id,
      runId,
      checkIds,
      controller,
      promise: Promise.resolve(),
    };
    this.#active.set(taskId, active);
    active.promise = this.#execute(space, records, accepted, controller.signal)
      .finally(() => {
        clearTimeout(timeout);
        if (!this.#terminalRecovery.has(taskId)) this.#finishActiveTask(taskId);
      });
    return { taskId, runId, checkIds };
    } finally {
      this.#runReservations.delete(input.space.id);
    }
  }

  taskStatus(spaceId: string, taskId: string): Promise<WorkspaceCheckTaskStatus> {
    return this.#withOperationReservation(spaceId, () => this.#taskStatus(spaceId, taskId));
  }

  taskResult(spaceId: string, taskId: string): Promise<WorkspaceCheckRunRecord> {
    return this.#withOperationReservation(spaceId, () => this.#taskResult(spaceId, taskId));
  }

  async #taskResult(spaceId: string, taskId: string): Promise<WorkspaceCheckRunRecord> {
    await this.#registeredSpaceId(spaceId);
    await this.#retryTerminalRecovery(taskId);
    const active = this.#active.get(taskId);
    if (active?.workspaceId === spaceId) throw new Error("The Check run is still running.");
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
    if (!active || active.workspaceId !== spaceId) return false;
    active.controller.abort("Check run aborted.");
    await active.promise;
    await this.#retryTerminalRecovery(taskId);
    return true;
  }

  problems(space: WorkspaceCheckSpaceRef, checkId?: string): Promise<{
    findings: WorkspaceCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    return this.#withOperationReservation(space.id, async () => this.#problems(await this.#registeredSpace(space), true, checkId));
  }

  decide(input: {
    spaceId: string;
    findingId: string;
    decision: WorkspaceCheckDecisionKind;
    actor: WorkspaceCheckDecision["actor"];
    deferUntil?: string;
    note?: string;
  }): Promise<WorkspaceCheckDecision> {
    return this.#withOperationReservation(input.spaceId, async () => {
      await this.#registeredSpaceId(input.spaceId);
      const store = await this.#store(input.spaceId);
      const finding = store.snapshot().runs.flatMap((run) => run.findings).find((item) => item.id === input.findingId);
      if (!finding) throw new Error("Finding not found.");
      const now = this.#now();
      if (input.decision === "defer") {
        const deferredUntil = input.deferUntil ? Date.parse(input.deferUntil) : Number.NaN;
        if (!Number.isFinite(deferredUntil) || deferredUntil <= now.getTime()) {
          throw new Error("A deferred finding requires a future deferUntil timestamp.");
        }
      }
      return store.decide({
        fingerprint: finding.fingerprint,
        decision: input.decision,
        actor: input.actor,
        ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
        ...(input.note ? { note: input.note } : {}),
        now,
      });
    });
  }

  hasActiveRun(workspaceId?: string): boolean {
    return this.#spaceRegistryMutationReserved
      || [...this.#active.values()].some((run) => workspaceId === undefined || run.workspaceId === workspaceId)
      || [...this.#runReservations].some((id) => workspaceId === undefined || id === workspaceId)
      || [...this.#operationReservations].some((id) => workspaceId === undefined || id === workspaceId)
      || [...this.#spaceRemovalReservations].some((id) => workspaceId === undefined || id === workspaceId);
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort("Workspace is closing.");
    await Promise.allSettled([...this.#active.values()].map((active) => active.promise));
    await Promise.allSettled([...this.#terminalRecovery.keys()].map((taskId) => this.#retryTerminalRecovery(taskId)));
    await Promise.allSettled([...this.#stores.values()].map(async (store) => (await store).flush()));
  }

  async #execute(
    space: WorkspaceCheckSpaceRef,
    records: WorkspaceCheckDeclarationRecord[],
    accepted: WorkspaceCheckRunRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const store = await this.#store(space.id);
    const findings: WorkspaceCheckFinding[] = [];
    const inputs: WorkspaceCheckRunRecord["inputs"] = [];
    let discardedCount = 0;
    let skippedCount = 0;
    let usedFiles = 0;
    let usedBytes = 0;
    let terminal: WorkspaceCheckRunRecord;
    try {
      for (const record of records) {
        throwIfAborted(signal);
        const current = (await this.#enabledRecords(space, record.declaration.id))[0];
        if (!current || current.digest !== record.digest) throw new Error("Check authority changed before the run started.");
        const state = store.snapshot();
        const authorization = exactAuthorization(state.authorizations[record.declaration.id], record);
        if (!authorization) throw new Error("Check authority changed before the run started.");
        const sensor = this.#resolveSensor(record.declaration.sensor.id, record.declaration.sensor.revision);
        if (!sensor || sensor.execution !== authorization.execution || sensor.implementationDigest !== authorization.sensorDigest) {
          throw new Error("The exact enabled sensor implementation is unavailable.");
        }
        sensor.validate(record.declaration);
        await this.#assertNoNestedSpaceTargets(space, record.declaration);
        const remainingFiles = accepted.limits.maximumFiles - usedFiles;
        const remainingBytes = accepted.limits.maximumTotalBytes - usedBytes;
        if (remainingFiles < 1 || remainingBytes < 0) throw new Error("Check run exhausted its approved input budget.");
        const resolution = await resolveWorkspaceCheckTargets(space.rootPath, record.declaration.targets, {
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
        const runnerInputs = runnerOwnedInputs(record.declaration.id, resolution);
        inputs.push(...runnerInputs);
        throwIfAborted(signal);
        const result = await withAbort(sensor.run({
          declaration: record.declaration,
          inputs: closedSensorInputs(resolution),
          signal,
        }), signal);
        skippedCount += result.skippedCount;
        if (skippedCount > 0) throw new Error("Check sensor skipped designated input; the run is incomplete.");
        const remainingFindings = accepted.limits.maximumFindings - findings.length;
        if (result.candidates.length > remainingFindings) throw new Error("Check sensor exceeded the accepted run finding limit.");
        for (const candidate of result.candidates) {
          throwIfAborted(signal);
          const finding = await admitWorkspaceCheckCandidate({
            workspaceRoot: space.rootPath,
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
      // run interrupted. Polling/result calls retry this write.
      this.#terminalRecovery.set(accepted.taskId, { store, run: terminal });
    }
  }

  async #enabledRecords(space: WorkspaceCheckSpaceRef, checkId?: string): Promise<WorkspaceCheckDeclarationRecord[]> {
    const discovery = await discoverWorkspaceCheckDeclarations(space.rootPath);
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

  async #problems(space: WorkspaceCheckSpaceRef, persistInvalidation: boolean, checkId?: string): Promise<{
    findings: WorkspaceCheckFinding[];
    invalidated: number;
    healthErrors: string[];
    truncated: boolean;
  }> {
    const discovery = await discoverWorkspaceCheckDeclarations(space.rootPath);
    const declarations = new Map(discovery.declarations.map((record) => [record.declaration.id, record]));
    const store = await this.#store(space.id);
    const state = store.snapshot();
    const decisions = state.decisions;
    const seen = new Set<string>();
    const findings: WorkspaceCheckFinding[] = [];
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
    for (const finding of state.runs.flatMap((run) => run.findings)) {
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
        current = await reverifyWorkspaceCheckFinding(space.rootPath, record.declaration, finding);
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

  async #taskStatus(spaceId: string, taskId: string): Promise<WorkspaceCheckTaskStatus> {
    await this.#registeredSpaceId(spaceId);
    await this.#retryTerminalRecovery(taskId);
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

  #store(workspaceId: string): Promise<WorkspaceCheckStore> {
    const existing = this.#stores.get(workspaceId);
    if (existing) return existing;
    const created = this.#storeFactory(workspaceId);
    this.#stores.set(workspaceId, created);
    void created.catch(() => {
      if (this.#stores.get(workspaceId) === created) this.#stores.delete(workspaceId);
    });
    return created;
  }

  async #withOperationReservation<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#spaceRegistryMutationReserved
      || this.#spaceRemovalReservations.has(workspaceId)
      || this.#operationReservations.has(workspaceId)) {
      throw new Error("Wait for the current Check operation in this Space to finish.");
    }
    this.#operationReservations.add(workspaceId);
    try {
      return await operation();
    } finally {
      this.#operationReservations.delete(workspaceId);
    }
  }

  async #registeredSpace(input: WorkspaceCheckSpaceRef): Promise<WorkspaceCheckSpaceRef> {
    const match = (await this.#listSpaces()).find((space) => space.id === input.id);
    if (!match) throw new Error("Registered Space not found.");
    if (resolve(match.rootPath) !== resolve(input.rootPath)) {
      throw new Error("The Check request does not match the registered Space folder.");
    }
    return { id: match.id, rootPath: match.rootPath };
  }

  async #registeredSpaceId(workspaceId: string): Promise<void> {
    if (!(await this.#listSpaces()).some((space) => space.id === workspaceId)) {
      throw new Error("Registered Space not found.");
    }
  }

  async #retryTerminalRecovery(taskId: string): Promise<boolean> {
    const recovery = this.#terminalRecovery.get(taskId);
    if (!recovery) return true;
    try {
      await recovery.store.finishRun(recovery.run);
    } catch {
      return false;
    }
    this.#terminalRecovery.delete(taskId);
    this.#finishActiveTask(taskId);
    return true;
  }

  #finishActiveTask(taskId: string): void {
    if (!this.#active.delete(taskId)) return;
    this.#kernel.finishTask(taskId);
  }

  async #assertNoNestedSpaceTargets(space: WorkspaceCheckSpaceRef, declaration: WorkspaceCheckDeclaration): Promise<void> {
    const root = resolve(space.rootPath);
    const nestedRoots = (await this.#listSpaces())
      .filter((item) => item.id !== space.id)
      .map((item) => relative(root, resolve(item.rootPath)))
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
  authorization: WorkspaceCheckAuthorization | undefined,
  record: WorkspaceCheckDeclarationRecord,
): WorkspaceCheckAuthorization | null {
  if (!authorization) return null;
  return authorization.declarationDigest === record.digest
    && authorization.sensorId === record.declaration.sensor.id
    && authorization.sensorRevision === record.declaration.sensor.revision
    ? authorization
    : null;
}

function proposalDeclarationIdentity(proposal: WorkspaceCheckProposal): string {
  return workspaceCheckDigest({
    ...proposal.check,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

function declarationIdentity(declaration: WorkspaceCheckDeclaration): string {
  return workspaceCheckDigest({
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
  record: WorkspaceCheckDeclarationRecord,
  authorization: WorkspaceCheckAuthorization,
  workspaceRoot: string,
): Promise<WorkspaceCheckRunRecord["inputs"]> {
  const resolution = await resolveWorkspaceCheckTargets(workspaceRoot, record.declaration.targets, {
    limits: {
      maxFiles: authorization.limits.maximumFiles,
      maxFileBytes: authorization.limits.maximumFileBytes,
      maxTotalBytes: authorization.limits.maximumTotalBytes,
    },
  });
  return runnerOwnedInputs(record.declaration.id, resolution);
}

function runnerOwnedInputs(checkId: string, resolution: WorkspaceCheckTargetResolution): WorkspaceCheckRunRecord["inputs"] {
  return [
    ...resolution.files.map((file) => ({ checkId, path: file.path, state: "file" as const, size: file.sizeBytes })),
    ...resolution.missingExactTargets.map((target) => ({ checkId, path: target.path, state: "missing" as const })),
  ].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function closedSensorInputs(resolution: WorkspaceCheckTargetResolution) {
  return {
    files: resolution.files.map(({ path, sizeBytes }) => ({ path, sizeBytes })),
    missingExactTargets: resolution.missingExactTargets.map(({ path }) => ({ path })),
  };
}

function sameSemanticInputs(
  left: WorkspaceCheckRunRecord["inputs"],
  right: WorkspaceCheckRunRecord["inputs"],
): boolean {
  const normalize = (values: WorkspaceCheckRunRecord["inputs"]) => values
    .map(({ checkId, path, state, sha256 }) => ({ checkId, path, state, sha256: sha256 ?? null }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId) || a.path.localeCompare(b.path));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function latestRunForCheck(runs: WorkspaceCheckRunRecord[], checkId: string): WorkspaceCheckRunRecord | null {
  return runs.find((run) => run.checkIds.includes(checkId)) ?? null;
}

function intersectLimits(values: WorkspaceCheckRunLimits[]): WorkspaceCheckRunLimits {
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
  stale: number;
  blocked: number;
  errors: number;
  needsAttention: number;
}): WorkspaceCheckAggregateState {
  if (input.errors) return "check-error";
  if (input.blocked) return "blocked";
  if (!input.configured || !input.enabled) return "not-configured";
  if (input.needsAttention) return "needs-attention";
  if (input.stale || input.current < input.enabled) return "stale";
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
