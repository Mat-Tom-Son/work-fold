import { randomUUID } from "node:crypto";

import type { WorkFoldCheckDeclaration } from "../../shared/checks.js";
import { normalizeWorkFoldCheckTargetPath } from "../../shared/checks.js";
import { workFoldCheckFingerprint } from "./check-integrity.js";
import type {
  WorkFoldCheckCandidateFinding,
  WorkFoldCheckEvidence,
  WorkFoldCheckFinding,
} from "./check-types.js";
import { resolveWorkFoldCheckTargets } from "./target-resolver.js";

export async function admitWorkFoldCheckCandidate(input: {
  root: string;
  declaration: WorkFoldCheckDeclaration;
  declarationDigest: string;
  sensorDigest: string;
  candidate: WorkFoldCheckCandidateFinding;
  now?: Date;
  signal?: AbortSignal;
}): Promise<WorkFoldCheckFinding | null> {
  if (input.signal?.aborted) throw new Error(String(input.signal.reason || "Check admission was aborted."));
  let targetPath: string;
  let title: string;
  let detail: string | undefined;
  let remediation: string | undefined;
  try {
    targetPath = normalizeWorkFoldCheckTargetPath(input.candidate.targetPath, "Finding target path");
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
    if (!await verifyWorkFoldCheckEvidence(input.root, evidence, input.declaration)) return null;
  }
  const evidence = structuredClone(input.candidate.evidence);
  const fingerprint = workFoldCheckFingerprint({
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

export async function reverifyWorkFoldCheckFinding(
  root: string,
  declaration: WorkFoldCheckDeclaration,
  finding: WorkFoldCheckFinding,
): Promise<boolean> {
  if (finding.status !== "active" || finding.checkId !== declaration.id) return false;
  if (finding.sensorId !== declaration.sensor.id || finding.sensorRevision !== declaration.sensor.revision) return false;
  if (!declarationContainsPath(declaration, finding.targetPath)) return false;
  for (const evidence of finding.evidence) {
    if (!await verifyWorkFoldCheckEvidence(root, evidence, declaration)) return false;
  }
  return workFoldCheckFingerprint({
    checkId: declaration.id,
    declarationDigest: finding.declarationDigest,
    sensorId: declaration.sensor.id,
    sensorRevision: declaration.sensor.revision,
    sensorDigest: finding.sensorDigest,
    targetPath: finding.targetPath,
    evidence: finding.evidence.map(semanticEvidenceIdentity),
  }) === finding.fingerprint;
}

export async function verifyWorkFoldCheckEvidence(
  root: string,
  evidence: WorkFoldCheckEvidence,
  declaration: WorkFoldCheckDeclaration,
): Promise<boolean> {
  if (evidence.kind !== "path-state") return false;
  let path: string;
  try {
    path = normalizeWorkFoldCheckTargetPath(evidence.path, "Evidence path");
  } catch {
    return false;
  }
  if (evidence.identity.path !== path || !declarationContainsPath(declaration, path)) return false;
  if (evidence.expected === evidence.observed || evidence.identity.state !== evidence.observed) return false;
  const resolution = await resolveWorkFoldCheckTargets(root, [{ kind: "file", role: "primary", path }]);
  const observed = resolution.files.some((file) => file.path === path) ? "file" : "missing";
  return observed === evidence.observed;
}

function semanticEvidenceIdentity(evidence: WorkFoldCheckEvidence): unknown {
  return {
    kind: evidence.kind,
    path: evidence.path,
    expected: evidence.expected,
    observed: evidence.observed,
  };
}

function declarationContainsPath(declaration: WorkFoldCheckDeclaration, path: string): boolean {
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
