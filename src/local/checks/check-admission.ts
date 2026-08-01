import { randomUUID } from "node:crypto";

import type { WorkspaceCheckDeclaration } from "../../shared/checks.js";
import { normalizeWorkspaceCheckTargetPath } from "../../shared/checks.js";
import { workspaceCheckFingerprint } from "./check-integrity.js";
import type {
  WorkspaceCheckCandidateFinding,
  WorkspaceCheckEvidence,
  WorkspaceCheckFinding,
} from "./check-types.js";
import { resolveWorkspaceCheckTargets } from "./target-resolver.js";

export async function admitWorkspaceCheckCandidate(input: {
  workspaceRoot: string;
  declaration: WorkspaceCheckDeclaration;
  declarationDigest: string;
  sensorDigest: string;
  candidate: WorkspaceCheckCandidateFinding;
  now?: Date;
  signal?: AbortSignal;
}): Promise<WorkspaceCheckFinding | null> {
  if (input.signal?.aborted) throw new Error(String(input.signal.reason || "Check admission was aborted."));
  let targetPath: string;
  let title: string;
  let detail: string | undefined;
  let remediation: string | undefined;
  try {
    targetPath = normalizeWorkspaceCheckTargetPath(input.candidate.targetPath, "Finding target path");
    title = boundedDisplayText(input.candidate.title, "Finding title", 300);
    detail = input.candidate.detail ? boundedDisplayText(input.candidate.detail, "Finding detail", 2_000) : undefined;
    remediation = input.candidate.remediation ? boundedDisplayText(input.candidate.remediation, "Finding remediation", 2_000) : undefined;
  } catch {
    return null;
  }
  if (!declarationContainsPath(input.declaration, targetPath)) return null;
  if (!Array.isArray(input.candidate.evidence) || input.candidate.evidence.length < 1 || input.candidate.evidence.length > 16) return null;
  for (const evidence of input.candidate.evidence) {
    if (input.signal?.aborted) throw new Error(String(input.signal.reason || "Check admission was aborted."));
    if (!await verifyWorkspaceCheckEvidence(input.workspaceRoot, evidence, input.declaration)) return null;
  }
  const evidence = structuredClone(input.candidate.evidence);
  const fingerprint = workspaceCheckFingerprint({
    checkId: input.declaration.id,
    declarationDigest: input.declarationDigest,
    sensorId: input.declaration.sensor.id,
    sensorRevision: input.declaration.sensor.revision,
    sensorDigest: input.sensorDigest,
    targetPath,
    evidence: evidence.map(semanticEvidenceIdentity),
  });
  return {
    id: `finding-record-${randomUUID()}`,
    fingerprint,
    checkId: input.declaration.id,
    declarationDigest: input.declarationDigest,
    sensorId: input.declaration.sensor.id,
    sensorRevision: input.declaration.sensor.revision,
    sensorDigest: input.sensorDigest,
    severity: input.declaration.severity,
    title,
    ...(detail ? { detail } : {}),
    ...(remediation ? { remediation } : {}),
    targetPath,
    evidence,
    observedAt: (input.now ?? new Date()).toISOString(),
    status: "active",
  };
}

export async function reverifyWorkspaceCheckFinding(
  workspaceRoot: string,
  declaration: WorkspaceCheckDeclaration,
  finding: WorkspaceCheckFinding,
): Promise<boolean> {
  if (finding.status !== "active" || finding.checkId !== declaration.id) return false;
  if (finding.sensorId !== declaration.sensor.id || finding.sensorRevision !== declaration.sensor.revision) return false;
  if (!declarationContainsPath(declaration, finding.targetPath)) return false;
  for (const evidence of finding.evidence) {
    if (!await verifyWorkspaceCheckEvidence(workspaceRoot, evidence, declaration)) return false;
  }
  return workspaceCheckFingerprint({
    checkId: declaration.id,
    declarationDigest: finding.declarationDigest,
    sensorId: declaration.sensor.id,
    sensorRevision: declaration.sensor.revision,
    sensorDigest: finding.sensorDigest,
    targetPath: finding.targetPath,
    evidence: finding.evidence.map(semanticEvidenceIdentity),
  }) === finding.fingerprint;
}

export async function verifyWorkspaceCheckEvidence(
  workspaceRoot: string,
  evidence: WorkspaceCheckEvidence,
  declaration: WorkspaceCheckDeclaration,
): Promise<boolean> {
  if (evidence.kind !== "path-state") return false;
  let path: string;
  try {
    path = normalizeWorkspaceCheckTargetPath(evidence.path, "Evidence path");
  } catch {
    return false;
  }
  if (evidence.identity.path !== path || !declarationContainsPath(declaration, path)) return false;
  if (evidence.expected === evidence.observed || evidence.identity.state !== evidence.observed) return false;
  const resolution = await resolveWorkspaceCheckTargets(workspaceRoot, [{ kind: "file", role: "primary", path }]);
  const observed = resolution.files.some((file) => file.path === path) ? "file" : "missing";
  return observed === evidence.observed;
}

function semanticEvidenceIdentity(evidence: WorkspaceCheckEvidence): unknown {
  return {
    kind: evidence.kind,
    path: evidence.path,
    expected: evidence.expected,
    observed: evidence.observed,
  };
}

function declarationContainsPath(declaration: WorkspaceCheckDeclaration, path: string): boolean {
  return declaration.targets.some((target) => {
    if (target.kind === "file") return target.path === path;
    if (!path.startsWith(`${target.path}/`)) return false;
    const relativePath = path.slice(target.path.length + 1);
    if (!target.recursive && relativePath.includes("/")) return false;
    const normalizedPath = path.toLocaleLowerCase("en-US");
    return target.extensions.some((extension) => normalizedPath.endsWith(extension));
  });
}

function boundedDisplayText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}
