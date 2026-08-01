import type { WorkspaceCheckSeverity, WorkspaceCheckTarget } from "../../shared/checks.js";

export const workspaceCheckStateVersion = 1 as const;
export const workspaceCheckExperimentalSnapshotVersion = 0 as const;

export type WorkspaceCheckAggregateState =
  | "not-configured"
  | "current-clear"
  | "needs-attention"
  | "stale"
  | "blocked"
  | "check-error";

export type WorkspaceCheckRunState = "accepted" | "running" | "succeeded" | "failed" | "aborted" | "interrupted";
export type WorkspaceCheckDecisionKind = "accept" | "reject" | "resolve" | "defer";

export interface WorkspaceCheckRunLimits {
  maximumFiles: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
  maximumFindings: number;
  timeoutMs: number;
}

export interface WorkspaceCheckFileIdentity {
  checkId: string;
  path: string;
  state: "file" | "missing";
  sha256?: string;
  size?: number;
  modifiedAt?: string;
}

export interface WorkspaceCheckPathStateEvidence {
  kind: "path-state";
  path: string;
  expected: "file" | "missing";
  observed: "file" | "missing";
  identity: WorkspaceCheckFileIdentity;
}

/** Contract 0 admits path-state evidence only. Broader typed evidence requires a later protocol revision. */
export type WorkspaceCheckEvidence = WorkspaceCheckPathStateEvidence;

export interface WorkspaceCheckCandidateFinding {
  title: string;
  detail?: string;
  remediation?: string;
  targetPath: string;
  evidence: WorkspaceCheckEvidence[];
}

export interface WorkspaceCheckFinding extends WorkspaceCheckCandidateFinding {
  id: string;
  fingerprint: string;
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  severity: WorkspaceCheckSeverity;
  observedAt: string;
  status: "active" | "invalidated" | "superseded";
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface WorkspaceCheckDecision {
  fingerprint: string;
  decision: WorkspaceCheckDecisionKind;
  decidedAt: string;
  actor: "human" | "assistant" | "cli" | "renderer";
  deferUntil?: string;
  note?: string;
}

export interface WorkspaceCheckAuthorization {
  checkId: string;
  declarationDigest: string;
  sensorId: string;
  sensorRevision: number;
  sensorDigest: string;
  enabledAt: string;
  enabledBy: "human" | "assistant" | "cli" | "renderer";
  execution: "deterministic" | "model";
  limits: WorkspaceCheckRunLimits;
}

export interface WorkspaceCheckRunRecord {
  id: string;
  taskId: string;
  checkIds: string[];
  startedAt: string;
  endedAt?: string;
  state: WorkspaceCheckRunState;
  authorities: Array<{
    checkId: string;
    declarationDigest: string;
    sensorId: string;
    sensorRevision: number;
    sensorDigest: string;
  }>;
  limits: WorkspaceCheckRunLimits;
  inputs: WorkspaceCheckFileIdentity[];
  findings: WorkspaceCheckFinding[];
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

export interface WorkspaceCheckMachineState {
  version: typeof workspaceCheckStateVersion;
  revision: number;
  authorizations: Record<string, WorkspaceCheckAuthorization>;
  decisions: Record<string, WorkspaceCheckDecision>;
  runs: WorkspaceCheckRunRecord[];
}

/** Experimental, content-free summary. Titles, paths, evidence, and decisions are excluded. */
export interface WorkspaceCheckStatusSnapshot {
  kind: "workspace.checks.experimental";
  version: typeof workspaceCheckExperimentalSnapshotVersion;
  workspaceId: string;
  state: WorkspaceCheckAggregateState;
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

export type WorkspaceCheckRendererAuthorityState = "enabled" | "proposed" | "blocked";

/**
 * Content-bearing projection for the authenticated desktop renderer. This is
 * deliberately separate from the content-free CLI status snapshot: paths,
 * titles, evidence, and decisions must never leak into protocol v1.
 */
export interface WorkspaceCheckRendererOverview {
  kind: "workspace.checks.renderer";
  version: typeof workspaceCheckExperimentalSnapshotVersion;
  workspaceId: string;
  status: WorkspaceCheckStatusSnapshot;
  checks: Array<{
    id: string;
    title: string;
    severity: WorkspaceCheckSeverity;
    trigger: "manual";
    sensor: { id: string; revision: number };
    targets: WorkspaceCheckTarget[];
    authority: WorkspaceCheckRendererAuthorityState;
  }>;
  findings: WorkspaceCheckFinding[];
  invalidated: number;
  healthErrors: string[];
  truncated: boolean;
}

/** Minimal file-path projection used only for quiet Files decorations. */
export interface WorkspaceCheckRendererDecorations {
  kind: "workspace.checks.decorations";
  version: typeof workspaceCheckExperimentalSnapshotVersion;
  workspaceId: string;
  items: Array<{ path: string; count: number }>;
}
