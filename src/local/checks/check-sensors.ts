import type { WorkspaceCheckDeclaration } from "../../shared/checks.js";
import type {
  WorkspaceCheckCandidateFinding,
  WorkspaceCheckFileIdentity,
} from "./check-types.js";

export interface WorkspaceCheckSensorInputSet {
  files: Array<{ path: string; sizeBytes: number }>;
  missingExactTargets: Array<{ path: string }>;
}

export interface WorkspaceCheckSensorContext {
  declaration: WorkspaceCheckDeclaration;
  /** Runner-owned closed projection. Sensors never receive filesystem paths. */
  inputs: WorkspaceCheckSensorInputSet;
  signal: AbortSignal;
}

export interface WorkspaceCheckSensorResult {
  candidates: WorkspaceCheckCandidateFinding[];
  skippedCount: number;
}

export interface WorkspaceCheckSensor {
  id: string;
  revision: number;
  /** Digest of the exact trusted implementation behind this revision. */
  implementationDigest: string;
  execution: "deterministic";
  validate(declaration: WorkspaceCheckDeclaration): void;
  run(context: WorkspaceCheckSensorContext): Promise<WorkspaceCheckSensorResult>;
}

export const workspaceFilePresenceSensorDigest = "5add3d0d49502b8239e5e9318d87226166d7153ad7e2fd7004f6d220a61e79df";

const filePresenceSensor: WorkspaceCheckSensor = {
  id: "workspace.file-presence",
  revision: 1,
  implementationDigest: workspaceFilePresenceSensorDigest,
  execution: "deterministic",
  validate: validateWorkspaceFilePresence,
  run: runWorkspaceFilePresence,
};

// WORKSPACE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_START
function validateWorkspaceFilePresence(declaration: WorkspaceCheckDeclaration): void {
  const parameters = declaration.sensor.parameters;
  const keys = Object.keys(parameters);
  if (keys.length !== 1 || keys[0] !== "expect" || (parameters.expect !== "present" && parameters.expect !== "absent")) {
    throw new Error("workspace.file-presence parameters must contain only expect: present or absent.");
  }
  if (declaration.targets.some((target) => target.kind !== "file" || target.role !== "primary")) {
    throw new Error("workspace.file-presence accepts only exact primary file targets.");
  }
}

async function runWorkspaceFilePresence({ declaration, inputs: closedInputs, signal }: WorkspaceCheckSensorContext): Promise<WorkspaceCheckSensorResult> {
  const expect = declaration.sensor.parameters.expect as "present" | "absent";
  const files = new Map(closedInputs.files.map((file) => [file.path, file]));
  const missing = new Set(closedInputs.missingExactTargets.map((target) => target.path));
  const candidates: WorkspaceCheckCandidateFinding[] = [];
  for (const target of declaration.targets) {
    if (signal.aborted) throw new Error(String(signal.reason || "Check sensor was aborted."));
    const file = files.get(target.path);
    const observed = file ? "file" : "missing";
    if (!file && !missing.has(target.path)) throw new Error(`Resolved target is missing from the closed input set: ${target.path}`);
    const identity: WorkspaceCheckFileIdentity = {
      checkId: declaration.id,
      path: target.path,
      state: observed,
      ...(file ? { size: file.sizeBytes } : {}),
    };
    const expected = expect === "present" ? "file" : "missing";
    if (observed === expected) continue;
    candidates.push({
      title: expect === "present" ? "Expected file is missing" : "File exists but should be absent",
      detail: expect === "present"
        ? "The explicitly designated file could not be found."
        : "The explicitly designated path currently contains a file.",
      targetPath: target.path,
      evidence: [{ kind: "path-state", path: target.path, expected, observed, identity }],
    });
  }
  return { candidates, skippedCount: 0 };
}
// WORKSPACE_FILE_PRESENCE_SENSOR_IMPLEMENTATION_END

const builtinSensors = new Map<string, WorkspaceCheckSensor>([
  [filePresenceSensor.id, filePresenceSensor],
]);

export function resolveWorkspaceCheckSensor(id: string, revision: number): WorkspaceCheckSensor | null {
  const sensor = builtinSensors.get(id) ?? null;
  return sensor?.revision === revision ? sensor : null;
}

export function listWorkspaceCheckSensors(): Array<Pick<WorkspaceCheckSensor, "id" | "revision" | "execution" | "implementationDigest">> {
  return [...builtinSensors.values()].map(({ id, revision, execution, implementationDigest }) => ({ id, revision, execution, implementationDigest }));
}
