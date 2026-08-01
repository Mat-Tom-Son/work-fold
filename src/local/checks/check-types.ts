import type { WorkFoldCheckSeverity, WorkFoldCheckTarget } from "../../shared/checks.js";

export const workFoldCheckStateVersion = 1 as const;
export const workFoldCheckExperimentalSnapshotVersion = 0 as const;

export type WorkFoldCheckAggregateState =
  | "not-configured"
  | "current-clear"
  | "needs-attention"
  | "stale"
  | "blocked"
  | "check-error";

export type WorkFoldCheckRunState = "accepted" | "running" | "succeeded" | "failed" | "aborted" | "interrupted";
export type WorkFoldCheckDecisionKind = "accept" | "reject" | "resolve" | "defer";

export interface WorkFoldCheckRunLimits {
  maximumFiles: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumFindings: number;
  timeoutMs: number;
}

export interface WorkFoldCheckFileIdentity {
  checkId: string;
  path: string;
  state: "file" | "missing";
  sha256?: string;
  size?: number;
  modifiedAt?: string;
}

export interface WorkFoldCheckPathStateEvidence {
  kind: "path-state";
  path: string;
  expected: "file" | "missing";
  observed: "file" | "missing";
  identity: WorkFoldCheckFileIdentity;
}

/** Contract 0 admits path-state evidence only. Broader typed evidence requires a later protocol revision. */
export type WorkFoldCheckEvidence = WorkFoldCheckPathStateEvidence;

export interface WorkFoldCheckCandidateFinding {
  title: string;
  detail?: string;
  remediation?: string;
  targetPath: string;
  evidence: WorkFoldCheckEvidence[];
}

export interface WorkFoldCheckFinding extends WorkFoldCheckCandidateFinding {
  id: string;
  fingerprint: string;
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  severity: WorkFoldCheckSeverity;
  observedAt: string;
  status: "active" | "invalidated" | "superseded";
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface WorkFoldCheckDecision {
  fingerprint: string;
  decision: WorkFoldCheckDecisionKind;
  decidedAt: string;
  actor: "human" | "assistant" | "cli" | "renderer";
  deferUntil?: string;
  note?: string;
}

export interface WorkFoldCheckAuthorization {
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  enabledAt: string;
  enabledBy: "human" | "assistant" | "cli" | "renderer";
  execution: "deterministic" | "model";
  limits: WorkFoldCheckRunLimits;
}

export interface WorkFoldCheckRunRecord {
  id: string;
  taskId: string;
  checkIds: string[];
  startedAt: string;
  endedAt?: string;
  state: WorkFoldCheckRunState;
  authorities: Array<{
    checkId: string;
    declarationDigest: string;
    sensorId: string;
    sensorRevision: number;
    sensorDigest: string;
  }>;
  limits: WorkFoldCheckRunLimits;
  inputs: WorkFoldCheckFileIdentity[];
  findings: WorkFoldCheckFinding[];
  admittedCount: number;
  discardedCount: number;
  skippedCount: number;
  error?: string;
  cost?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    amountUsd?: number;
  };
}

export interface WorkFoldCheckMachineState {
  version: typeof workFoldCheckStateVersion;
  revision: number;
  authorizations: Record<string, WorkFoldCheckAuthorization>;
  decisions: Record<string, WorkFoldCheckDecision>;
  runs: WorkFoldCheckRunRecord[];
}

/** Experimental, content-free summary. Titles, paths, evidence, and decisions are excluded. */
export interface WorkFoldCheckStatusSnapshot {
  kind: "work-fold.checks.experimental";
  version: typeof workFoldCheckExperimentalSnapshotVersion;
  spaceId: string;
  state: WorkFoldCheckAggregateState;
  configured: number;
  proposed: number;
  enabled: number;
  current: number;
  neverRun: number;
  stale: number;
  blocked: number;
  errors: number;
  needsAttention: number;
  running: number;
  lastRunAt: string | null;
}

export type WorkFoldCheckRendererAuthorityState = "enabled" | "proposed" | "blocked";

/**
 * Content-bearing projection for the authenticated desktop renderer. This is
 * deliberately separate from the content-free CLI status snapshot: paths,
 * titles, evidence, and decisions must never leak into protocol v1.
 */
export interface WorkFoldCheckRendererOverview {
  kind: "work-fold.checks.renderer";
  version: typeof workFoldCheckExperimentalSnapshotVersion;
  spaceId: string;
  status: WorkFoldCheckStatusSnapshot;
  checks: Array<{
    id: string;
    title: string;
    severity: WorkFoldCheckSeverity;
    trigger: "manual";
    sensor: { id: string; revision: number };
    targets: WorkFoldCheckTarget[];
    authority: WorkFoldCheckRendererAuthorityState;
  }>;
  findings: WorkFoldCheckFinding[];
  invalidated: number;
  healthErrors: string[];
  truncated: boolean;
}

/** Minimal file-path projection used only for quiet Files decorations. */
export interface WorkFoldCheckRendererDecorations {
  kind: "work-fold.checks.decorations";
  version: typeof workFoldCheckExperimentalSnapshotVersion;
  spaceId: string;
  items: Array<{ path: string; count: number }>;
}
