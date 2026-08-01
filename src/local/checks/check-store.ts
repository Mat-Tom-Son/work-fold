import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { normalizeWorkspaceCheckTargetPath, type WorkspaceCheckDeclaration } from "../../shared/checks.js";
import { workspaceCheckStateFile } from "../state-paths.js";
import {
  workspaceCheckStateVersion,
  type WorkspaceCheckAuthorization,
  type WorkspaceCheckDecision,
  type WorkspaceCheckDecisionKind,
  type WorkspaceCheckFinding,
  type WorkspaceCheckMachineState,
  type WorkspaceCheckRunLimits,
  type WorkspaceCheckRunRecord,
} from "./check-types.js";

const maximumRunRecords = 200;
const maximumDecisionRecords = 5_000;
const maximumMachineStateBytes = 16 * 1024 * 1024;
const maximumAuthorizationRecords = 256;

export interface WorkspaceCheckStoreOptions {
  path?: string;
}

/** Removal-only cleanup: revoke Check bytes without trusting or parsing them. */
export async function purgeWorkspaceCheckState(workspaceId: string, options: WorkspaceCheckStoreOptions = {}): Promise<void> {
  const path = options.path ?? workspaceCheckStateFile(workspaceId);
  for (const candidate of [path, `${path}.bak`]) {
    await unlink(candidate).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
  const directory = dirname(path);
  const prefix = `${basename(path)}.`;
  const handle = await opendir(directory).catch((error: unknown) => {
    if (isMissingFile(error)) return null;
    throw error;
  });
  if (!handle) return;
  let visited = 0;
  try {
    for await (const entry of handle) {
      visited += 1;
      if (visited > 4_096) throw new Error("Check state cleanup directory is unexpectedly large.");
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
      await unlink(join(directory, entry.name)).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class WorkspaceCheckStore {
  readonly #path: string;
  #state: WorkspaceCheckMachineState;
  #writeQueue: Promise<void> = Promise.resolve();
  #preserveBackupOnNextWrite: boolean;

  private constructor(path: string, state: WorkspaceCheckMachineState, preserveBackupOnNextWrite = false) {
    this.#path = path;
    this.#state = state;
    this.#preserveBackupOnNextWrite = preserveBackupOnNextWrite;
  }

  static async create(workspaceId: string, options: WorkspaceCheckStoreOptions = {}): Promise<WorkspaceCheckStore> {
    const path = options.path ?? workspaceCheckStateFile(workspaceId);
    let firstError: unknown;
    for (const candidate of [path, `${path}.bak`]) {
      const source = await readBoundedStateFile(candidate).catch((error: unknown) => {
        if (isMissingFile(error)) return null;
        throw error;
      });
      if (source === null) continue;
      try {
        const recoveredFromBackup = candidate !== path;
        const recoveredState = normalizeMachineState(JSON.parse(source));
        if (recoveredFromBackup) {
          // A backup necessarily predates at least one committed primary
          // mutation. Never resurrect an enablement that a newer damaged
          // primary may have disabled or revoked.
          recoveredState.authorizations = {};
          recoveredState.revision += 1;
        }
        const store = new WorkspaceCheckStore(path, recoveredState, recoveredFromBackup);
        if (recoveredFromBackup) await store.#persistRecoveredBackup();
        await store.#reconcileInterruptedRuns();
        return store;
      } catch (error) {
        if (isUnsupportedVersionError(error)) throw error;
        firstError ??= error;
      }
    }
    if (firstError) throw new Error(`Workspace could not read Check state: ${errorMessage(firstError)}`);
    return new WorkspaceCheckStore(path, emptyState());
  }

  snapshot(): WorkspaceCheckMachineState {
    return structuredClone(this.#state);
  }

  async authorize(
    declaration: WorkspaceCheckDeclaration,
    declarationDigest: string,
    actor: WorkspaceCheckAuthorization["enabledBy"],
    sensorDigest: string,
    now = new Date(),
    execution: WorkspaceCheckAuthorization["execution"] = "deterministic",
    limits: WorkspaceCheckRunLimits = {
      maximumFiles: 512,
      maximumFileBytes: 64 * 1024 * 1024,
      maximumTotalBytes: 256 * 1024 * 1024,
      maximumFindings: 256,
      timeoutMs: 30_000,
    },
  ): Promise<WorkspaceCheckAuthorization> {
    const authorization: WorkspaceCheckAuthorization = {
      checkId: declaration.id,
      declarationDigest: digest(declarationDigest, "Declaration digest"),
      sensorId: declaration.sensor.id,
      sensorRevision: declaration.sensor.revision,
      sensorDigest: digest(sensorDigest, "Sensor implementation digest"),
      enabledAt: now.toISOString(),
      enabledBy: actor,
      execution,
      limits: structuredClone(limits),
    };
    await this.#update((state) => {
      state.authorizations[declaration.id] = authorization;
    });
    return structuredClone(authorization);
  }

  async disable(checkId: string): Promise<boolean> {
    let removed = false;
    await this.#update((state) => {
      if (!state.authorizations[checkId]) return;
      delete state.authorizations[checkId];
      removed = true;
    });
    return removed;
  }

  async recordRun(run: WorkspaceCheckRunRecord): Promise<void> {
    const normalized = normalizeRun(run);
    await this.#update((state) => {
      state.runs = [normalized, ...state.runs.filter((item) => item.id !== normalized.id)].slice(0, maximumRunRecords);
    });
  }

  async acceptRun(run: WorkspaceCheckRunRecord): Promise<void> {
    if (run.state !== "accepted" || run.endedAt !== undefined) throw new Error("An accepted Check run cannot already be terminal.");
    await this.recordRun(run);
  }

  async markRunRunning(runId: string): Promise<void> {
    let found = false;
    await this.#update((state) => {
      state.runs = state.runs.map((run) => {
        if (run.id !== runId) return run;
        found = true;
        if (run.state !== "accepted") throw new Error("Only an accepted Check run may start.");
        return { ...run, state: "running" as const };
      });
    });
    if (!found) throw new Error("Check run not found.");
  }

  async finishRun(run: WorkspaceCheckRunRecord): Promise<void> {
    if (run.state === "accepted" || run.state === "running" || !run.endedAt) {
      throw new Error("A terminal Check run requires a terminal state and endedAt.");
    }
    const normalized = normalizeRun(run);
    await this.#update((state) => {
      const existing = state.runs.find((item) => item.id === normalized.id);
      if (!existing) throw new Error("Check run not found.");
      if (existing.taskId !== normalized.taskId) throw new Error("Check run task identity changed before completion.");

      if (normalized.state === "succeeded") {
        const ranCheckIds = new Set(normalized.checkIds);
        const reproduced = new Set(normalized.findings.map((finding) => finding.fingerprint));
        const supersededFingerprints = new Set<string>();
        state.runs = state.runs.map((priorRun) => priorRun.id === normalized.id ? priorRun : {
          ...priorRun,
          findings: priorRun.findings.map((finding) => {
            if (finding.status !== "active" || !ranCheckIds.has(finding.checkId) || reproduced.has(finding.fingerprint)) {
              return finding;
            }
            supersededFingerprints.add(finding.fingerprint);
            return {
              ...finding,
              status: "superseded" as const,
              invalidatedAt: normalized.endedAt,
              invalidationReason: "A later successful run no longer reproduced this finding.",
            };
          }),
        });
        clearHidingDecisions(state, supersededFingerprints);
      }

      state.runs = [normalized, ...state.runs.filter((item) => item.id !== normalized.id)].slice(0, maximumRunRecords);
    });
  }

  async decide(input: {
    fingerprint: string;
    findingId?: string;
    decision: WorkspaceCheckDecisionKind;
    actor: WorkspaceCheckDecision["actor"];
    deferUntil?: string;
    note?: string;
    now?: Date;
  }): Promise<WorkspaceCheckDecision> {
    const existingDecision = this.#state.decisions[input.fingerprint];
    if (!input.findingId && existingDecision && existingDecision.decision === input.decision
      && existingDecision.actor === input.actor && existingDecision.deferUntil === input.deferUntil
      && existingDecision.note === input.note) {
      return structuredClone(existingDecision);
    }
    const now = input.now ?? new Date();
    let decision = normalizeDecision({
      fingerprint: input.fingerprint,
      decision: input.decision,
      actor: input.actor,
      decidedAt: now.toISOString(),
      ...(input.deferUntil ? { deferUntil: input.deferUntil } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    await this.#update((state) => {
      if (input.findingId) {
        const finding = state.runs
          .flatMap((run) => run.findings)
          .find((item) => item.id === input.findingId);
        if (!finding || finding.fingerprint !== input.fingerprint || finding.status !== "active") {
          throw new Error("This finding is no longer active. Refresh Checks and try again.");
        }
      }
      const existing = state.decisions[input.fingerprint];
      if (existing && existing.decision === input.decision && existing.actor === input.actor
        && existing.deferUntil === input.deferUntil && existing.note === input.note) {
        decision = existing;
        return false;
      }
      state.decisions[decision.fingerprint] = decision;
      const entries = Object.values(state.decisions).sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
      state.decisions = Object.fromEntries(entries.slice(0, maximumDecisionRecords).map((item) => [item.fingerprint, item]));
      return true;
    });
    return structuredClone(decision);
  }

  async invalidateFinding(fingerprint: string, reason: string, now = new Date()): Promise<boolean> {
    let changed = false;
    const invalidationReason = boundedText(reason, "Invalidation reason", 500);
    await this.#update((state) => {
      state.runs = state.runs.map((run) => ({
        ...run,
        findings: run.findings.map((finding) => {
          if (finding.fingerprint !== fingerprint || finding.status !== "active") return finding;
          changed = true;
          return {
            ...finding,
            status: "invalidated" as const,
            invalidatedAt: now.toISOString(),
            invalidationReason,
          };
        }),
      }));
      if (changed) clearHidingDecisions(state, new Set([fingerprint]));
    });
    return changed;
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  async purge(): Promise<void> {
    const operation = this.#writeQueue.catch(() => undefined).then(async () => {
      await unlink(this.#path).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      await unlink(`${this.#path}.bak`).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
      this.#state = emptyState();
    });
    this.#writeQueue = operation;
    await operation;
  }

  async #update(mutate: (state: WorkspaceCheckMachineState) => void | boolean): Promise<void> {
    const operation = this.#writeQueue.catch(() => undefined).then(async () => {
      const next = this.snapshot();
      if (mutate(next) === false) return;
      next.revision += 1;
      const normalized = normalizeMachineState(next);
      await writeAtomicJson(this.#path, normalized, { preserveBackup: this.#preserveBackupOnNextWrite });
      this.#preserveBackupOnNextWrite = false;
      this.#state = normalized;
    });
    this.#writeQueue = operation;
    await operation;
  }

  async #reconcileInterruptedRuns(): Promise<void> {
    if (!this.#state.runs.some((run) => run.state === "accepted" || run.state === "running")) return;
    const endedAt = new Date().toISOString();
    await this.#update((state) => {
      state.runs = state.runs.map((run) => run.state === "accepted" || run.state === "running"
        ? {
            ...run,
            state: "interrupted" as const,
            endedAt,
            error: "Workspace stopped before this Check run recorded a terminal outcome. It was not retried.",
          }
        : run);
    });
  }

  async #persistRecoveredBackup(): Promise<void> {
    const normalized = normalizeMachineState(this.#state);
    await writeAtomicJson(this.#path, normalized, { preserveBackup: true });
    this.#preserveBackupOnNextWrite = false;
    this.#state = normalized;
  }
}

function emptyState(): WorkspaceCheckMachineState {
  return { version: workspaceCheckStateVersion, revision: 0, authorizations: {}, decisions: {}, runs: [] };
}

function clearHidingDecisions(state: WorkspaceCheckMachineState, fingerprints: Set<string>): void {
  for (const fingerprint of fingerprints) {
    const decision = state.decisions[fingerprint];
    if (decision && decision.decision !== "accept") delete state.decisions[fingerprint];
  }
}

function normalizeMachineState(value: unknown): WorkspaceCheckMachineState {
  const record = objectRecord(value, "Check state must be a JSON object.");
  if (typeof record.version === "number" && record.version > workspaceCheckStateVersion) {
    throw Object.assign(new Error(`Check state uses unsupported version ${record.version}.`), { code: "ERR_WORKSPACE_CHECKS_VERSION" });
  }
  assertExactKeys(record, ["version", "revision", "authorizations", "decisions", "runs"], "Check state");
  if (record.version !== workspaceCheckStateVersion) throw new Error("Check state version is invalid.");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) throw new Error("Check state revision is invalid.");
  const authorizations = objectRecord(record.authorizations, "Check authorizations must be an object.");
  const decisions = objectRecord(record.decisions, "Check decisions must be an object.");
  if (Object.keys(authorizations).length > maximumAuthorizationRecords) throw new Error("Check authorizations are oversized.");
  if (Object.keys(decisions).length > maximumDecisionRecords) throw new Error("Check decisions are oversized.");
  if (!Array.isArray(record.runs) || record.runs.length > maximumRunRecords) throw new Error("Check run records are invalid or oversized.");
  return {
    version: workspaceCheckStateVersion,
    revision: record.revision as number,
    authorizations: Object.fromEntries(Object.entries(authorizations).map(([id, item]) => {
      const authorization = normalizeAuthorization(item);
      if (authorization.checkId !== id) throw new Error("Check authorization id does not match its record key.");
      return [id, authorization];
    })),
    decisions: Object.fromEntries(Object.entries(decisions).map(([fingerprint, item]) => {
      const decision = normalizeDecision(item);
      if (decision.fingerprint !== fingerprint) throw new Error("Check decision fingerprint does not match its record key.");
      return [fingerprint, decision];
    })),
    runs: record.runs.map(normalizeRun),
  };
}

function normalizeAuthorization(value: unknown): WorkspaceCheckAuthorization {
  const record = objectRecord(value, "Check authorization must be an object.");
  assertExactKeys(record, ["checkId", "declarationDigest", "sensorId", "sensorRevision", "sensorDigest", "enabledAt", "enabledBy", "execution", "limits"], "Check authorization");
  const enabledBy = record.enabledBy;
  if (enabledBy !== "human" && enabledBy !== "assistant" && enabledBy !== "cli" && enabledBy !== "renderer") {
    throw new Error("Check authorization actor is invalid.");
  }
  if (!Number.isSafeInteger(record.sensorRevision) || (record.sensorRevision as number) < 1) throw new Error("Sensor revision is invalid.");
  if (record.execution !== "deterministic" && record.execution !== "model") throw new Error("Check execution kind is invalid.");
  return {
    checkId: boundedText(record.checkId, "Check id", 160),
    declarationDigest: digest(record.declarationDigest, "Declaration digest"),
    sensorId: boundedText(record.sensorId, "Sensor id", 160),
    sensorRevision: record.sensorRevision as number,
    sensorDigest: digest(record.sensorDigest, "Sensor implementation digest"),
    enabledAt: timestamp(record.enabledAt, "Check enabledAt"),
    enabledBy,
    execution: record.execution,
    limits: normalizeRunLimits(record.limits),
  };
}

function normalizeDecision(value: unknown): WorkspaceCheckDecision {
  const record = objectRecord(value, "Check decision must be an object.");
  assertAllowedKeys(record, ["fingerprint", "decision", "decidedAt", "actor"], ["deferUntil", "note"], "Check decision");
  const decision = record.decision;
  if (decision !== "accept" && decision !== "reject" && decision !== "resolve" && decision !== "defer") {
    throw new Error("Check decision kind is invalid.");
  }
  const actor = record.actor;
  if (actor !== "human" && actor !== "assistant" && actor !== "cli" && actor !== "renderer") throw new Error("Check decision actor is invalid.");
  if (decision === "defer" && record.deferUntil === undefined) throw new Error("A deferred finding requires deferUntil.");
  if (decision !== "defer" && record.deferUntil !== undefined) throw new Error("Only a deferred finding may include deferUntil.");
  const decidedAt = timestamp(record.decidedAt, "Check decision decidedAt");
  const deferUntil = record.deferUntil !== undefined ? timestamp(record.deferUntil, "Check decision deferUntil") : undefined;
  if (deferUntil && Date.parse(deferUntil) <= Date.parse(decidedAt)) {
    throw new Error("A deferred finding requires a future deferUntil timestamp.");
  }
  return {
    fingerprint: findingFingerprint(record.fingerprint),
    decision,
    decidedAt,
    actor,
    ...(deferUntil ? { deferUntil } : {}),
    ...(record.note !== undefined ? { note: boundedText(record.note, "Check decision note", 1_000) } : {}),
  };
}

function normalizeRun(value: unknown): WorkspaceCheckRunRecord {
  const record = objectRecord(value, "Check run must be an object.");
  assertAllowedKeys(
    record,
    ["id", "taskId", "checkIds", "startedAt", "state", "authorities", "limits", "inputs", "findings", "admittedCount", "discardedCount", "skippedCount"],
    ["endedAt", "error", "cost"],
    "Check run",
  );
  if (!Array.isArray(record.checkIds) || record.checkIds.length > maximumAuthorizationRecords) throw new Error("Check run ids are invalid.");
  if (!Array.isArray(record.inputs) || record.inputs.length > 5_000) throw new Error("Check run inputs are invalid.");
  if (!Array.isArray(record.findings) || record.findings.length > 1_000) throw new Error("Check run findings are invalid.");
  if (record.state !== "accepted" && record.state !== "running" && record.state !== "succeeded" && record.state !== "failed" && record.state !== "aborted" && record.state !== "interrupted") {
    throw new Error("Check run state is invalid.");
  }
  const terminal = record.state !== "accepted" && record.state !== "running";
  if (terminal !== (record.endedAt !== undefined)) throw new Error("Check run terminal state and endedAt do not agree.");
  if (!Array.isArray(record.authorities) || record.authorities.length !== record.checkIds.length) throw new Error("Check run authorities are invalid.");
  const authorities = record.authorities.map((value) => {
    const authority = objectRecord(value, "Check run authority must be an object.");
    assertExactKeys(authority, ["checkId", "declarationDigest", "sensorId", "sensorRevision", "sensorDigest"], "Check run authority");
    if (!Number.isSafeInteger(authority.sensorRevision) || (authority.sensorRevision as number) < 1) throw new Error("Check run sensor revision is invalid.");
    return {
      checkId: boundedText(authority.checkId, "Check id", 160),
      declarationDigest: digest(authority.declarationDigest, "Declaration digest"),
      sensorId: boundedText(authority.sensorId, "Sensor id", 160),
      sensorRevision: authority.sensorRevision as number,
      sensorDigest: digest(authority.sensorDigest, "Sensor implementation digest"),
    };
  });
  const normalizedLimits = normalizeRunLimits(record.limits);
  const counts = [record.admittedCount, record.discardedCount, record.skippedCount];
  if (counts.some((count) => !Number.isSafeInteger(count) || (count as number) < 0)) throw new Error("Check run counts are invalid.");
  return {
    id: boundedText(record.id, "Check run id", 160),
    taskId: boundedText(record.taskId, "Check task id", 160),
    checkIds: record.checkIds.map((id) => boundedText(id, "Check id", 160)),
    startedAt: timestamp(record.startedAt, "Check run startedAt"),
    ...(record.endedAt !== undefined ? { endedAt: timestamp(record.endedAt, "Check run endedAt") } : {}),
    state: record.state,
    authorities,
    limits: normalizedLimits,
    inputs: record.inputs.map(normalizeInput),
    findings: record.findings.map((finding) => normalizeFinding(finding)),
    admittedCount: record.admittedCount as number,
    discardedCount: record.discardedCount as number,
    skippedCount: record.skippedCount as number,
    ...(record.error !== undefined ? { error: boundedText(record.error, "Check run error", 2_000) } : {}),
    ...(record.cost !== undefined ? { cost: normalizeCost(record.cost) } : {}),
  };
}

function normalizeFinding(value: unknown): WorkspaceCheckFinding {
  const record = objectRecord(value, "Check finding must be an object.");
  const required = [
    "id", "fingerprint", "checkId", "declarationDigest", "sensorId", "sensorRevision", "severity",
    "sensorDigest", "observedAt", "status", "title", "targetPath", "evidence",
  ];
  assertAllowedKeys(record, required, ["detail", "remediation", "invalidatedAt", "invalidationReason"], "Check finding");
  if (!Array.isArray(record.evidence) || record.evidence.length < 1 || record.evidence.length > 16) throw new Error("Check finding evidence is invalid.");
  if (record.severity !== "info" && record.severity !== "warning" && record.severity !== "error") throw new Error("Check finding severity is invalid.");
  if (record.status !== "active" && record.status !== "invalidated" && record.status !== "superseded") throw new Error("Check finding status is invalid.");
  if (!Number.isSafeInteger(record.sensorRevision) || (record.sensorRevision as number) < 1) throw new Error("Check finding sensor revision is invalid.");
  const checkId = boundedText(record.checkId, "Check id", 160);
  const targetPath = normalizeWorkspaceCheckTargetPath(record.targetPath, "Check finding target");
  const evidence = record.evidence.map(normalizeEvidence);
  if (evidence.some((item) => item.path !== targetPath || item.identity.checkId !== checkId)) {
    throw new Error("Check finding evidence is not bound to its target and Check.");
  }
  return structuredClone({
    ...record,
    id: boundedText(record.id, "Check finding id", 160),
    fingerprint: findingFingerprint(record.fingerprint),
    checkId,
    declarationDigest: digest(record.declarationDigest, "Declaration digest"),
    sensorId: boundedText(record.sensorId, "Sensor id", 160),
    sensorRevision: record.sensorRevision,
    sensorDigest: digest(record.sensorDigest, "Sensor implementation digest"),
    severity: record.severity,
    observedAt: timestamp(record.observedAt, "Check finding observedAt"),
    status: record.status,
    title: boundedText(record.title, "Check finding title", 300),
    targetPath,
    evidence,
    ...(record.detail !== undefined ? { detail: boundedText(record.detail, "Check finding detail", 2_000) } : {}),
    ...(record.remediation !== undefined ? { remediation: boundedText(record.remediation, "Check finding remediation", 2_000) } : {}),
    ...(record.invalidatedAt !== undefined ? { invalidatedAt: timestamp(record.invalidatedAt, "Check finding invalidatedAt") } : {}),
    ...(record.invalidationReason !== undefined ? { invalidationReason: boundedText(record.invalidationReason, "Check finding invalidation reason", 500) } : {}),
  }) as WorkspaceCheckFinding;
}

function normalizeInput(value: unknown): WorkspaceCheckRunRecord["inputs"][number] {
  const record = objectRecord(value, "Check input identity must be an object.");
  assertAllowedKeys(record, ["checkId", "path", "state"], ["sha256", "size", "modifiedAt"], "Check input identity");
  if (record.state !== "file" && record.state !== "missing") throw new Error("Check input state is invalid.");
  if (record.sha256 !== undefined && (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256))) {
    throw new Error("Check input digest is invalid.");
  }
  if (record.size !== undefined && (!Number.isSafeInteger(record.size) || (record.size as number) < 0)) {
    throw new Error("Check input size is invalid.");
  }
  if (record.state === "missing" && (record.sha256 !== undefined || record.size !== undefined || record.modifiedAt !== undefined)) {
    throw new Error("A missing Check input cannot carry file identity fields.");
  }
  return {
    checkId: boundedText(record.checkId, "Check id", 160),
    path: normalizeWorkspaceCheckTargetPath(record.path, "Check input path"),
    state: record.state,
    ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
    ...(record.size !== undefined ? { size: record.size as number } : {}),
    ...(record.modifiedAt !== undefined ? { modifiedAt: timestamp(record.modifiedAt, "Check input modifiedAt") } : {}),
  };
}

function normalizeEvidence(value: unknown): WorkspaceCheckFinding["evidence"][number] {
  const record = objectRecord(value, "Check evidence must be an object.");
  assertExactKeys(record, ["kind", "path", "expected", "observed", "identity"], "Check path-state evidence");
  if (record.kind !== "path-state") throw new Error("This Check state contains unsupported evidence.");
  if ((record.expected !== "file" && record.expected !== "missing")
    || (record.observed !== "file" && record.observed !== "missing")
    || record.expected === record.observed) {
    throw new Error("Check path-state evidence is invalid.");
  }
  const identity = normalizeInput(record.identity);
  const path = normalizeWorkspaceCheckTargetPath(record.path, "Check evidence path");
  if (identity.path !== path || identity.state !== record.observed) throw new Error("Check evidence identity does not match its observation.");
  return { kind: "path-state", path, expected: record.expected, observed: record.observed, identity };
}

function normalizeCost(value: unknown): NonNullable<WorkspaceCheckRunRecord["cost"]> {
  const record = objectRecord(value, "Check run cost must be an object.");
  assertAllowedKeys(record, [], ["model", "inputTokens", "outputTokens", "amountUsd"], "Check run cost");
  const tokens = [record.inputTokens, record.outputTokens];
  if (tokens.some((item) => item !== undefined && (!Number.isSafeInteger(item) || (item as number) < 0))) {
    throw new Error("Check run token counts are invalid.");
  }
  if (record.amountUsd !== undefined && (typeof record.amountUsd !== "number" || !Number.isFinite(record.amountUsd) || record.amountUsd < 0)) {
    throw new Error("Check run cost amount is invalid.");
  }
  return {
    ...(record.model !== undefined ? { model: boundedText(record.model, "Check run model", 200) } : {}),
    ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens as number } : {}),
    ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens as number } : {}),
    ...(record.amountUsd !== undefined ? { amountUsd: record.amountUsd } : {}),
  };
}

async function writeAtomicJson(path: string, value: unknown, options: { preserveBackup?: boolean } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await readBoundedStateFile(path).catch((error: unknown) => {
      if (isMissingFile(error)) return null;
      throw error;
    });
    if (existing && !options.preserveBackup) await copyFile(path, `${path}.bak`);
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!isReplaceRenameError(error)) throw error;
      await unlink(path);
      await rename(temporary, path);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readBoundedStateFile(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Check state must be an ordinary file.");
  if (before.size > maximumMachineStateBytes) throw new Error("Check state is oversized.");
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("Check state changed while opening.");
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source, "utf8") > maximumMachineStateBytes) throw new Error("Check state is oversized.");
    return source;
  } finally {
    await handle.close();
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function findingFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^finding-[a-f0-9]{32}$/.test(value)) throw new Error("Check finding fingerprint is invalid.");
  return value;
}

function normalizeRunLimits(value: unknown): WorkspaceCheckRunLimits {
  const limits = objectRecord(value, "Check run limits must be an object.");
  assertExactKeys(limits, ["maximumFiles", "maximumFileBytes", "maximumTotalBytes", "maximumFindings", "timeoutMs"], "Check run limits");
  return Object.fromEntries(Object.entries(limits).map(([key, item]) => {
    if (!Number.isSafeInteger(item) || (item as number) < 1) throw new Error(`Check run limit ${key} is invalid.`);
    return [key, item as number];
  })) as unknown as WorkspaceCheckRunLimits;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return new Date(value).toISOString();
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, keys: string[], label: string): void {
  assertAllowedKeys(record, keys, [], label);
}

function assertAllowedKeys(record: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field: ${unexpected[0]}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${label} is missing required field: ${missing[0]}.`);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isReplaceRenameError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "EEXIST" || error.code === "EPERM"));
}

function isUnsupportedVersionError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ERR_WORKSPACE_CHECKS_VERSION");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
