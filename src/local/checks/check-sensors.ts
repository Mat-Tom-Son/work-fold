import type { WorkFoldCheckDeclaration } from "../../shared/checks.js";
import type {
  WorkFoldCheckCandidateFinding,
  WorkFoldCheckFileIdentity,
} from "./check-types.js";

export interface WorkFoldCheckSensorInputSet {
  files: Array<{ path: string; sizeBytes: number }>;
  missingExactTargets: Array<{ path: string }>;
}

export interface WorkFoldCheckSensorContext {
  declaration: WorkFoldCheckDeclaration;
  /** Runner-owned closed projection. Sensors never receive filesystem paths. */
  inputs: WorkFoldCheckSensorInputSet;
  signal: AbortSignal;
}

export interface WorkFoldCheckSensorResult {
  candidates: WorkFoldCheckCandidateFinding[];
  skippedCount: number;
}

export interface WorkFoldCheckSensor {
  id: string;
  revision: number;
  /** Digest of the exact trusted implementation behind this revision. */
  implementationDigest: string;
  execution: "deterministic";
  validate(declaration: WorkFoldCheckDeclaration): void;
  run(context: WorkFoldCheckSensorContext): Promise<WorkFoldCheckSensorResult>;
}

export const workFoldFilePresenceSensorDigest = "588ca4bcd9c5526a30cfa38ba27094a23d83b390b01d7390522e0be2309e90a0";

const filePresenceSensor: WorkFoldCheckSensor = {
  id: "work-fold.file-presence",
  revision: 1,
  implementationDigest: workFoldFilePresenceSensorDigest,
  execution: "deterministic",
  validate: validateWorkFoldFilePresence,
  run: runWorkFoldFilePresence,
};

// WORK_FOLD_FILE_PRESENCE_SENSOR_IMPLEMENTATION_START
function validateWorkFoldFilePresence(declaration: WorkFoldCheckDeclaration): void {
  const parameters = declaration.sensor.parameters;
  const keys = Object.keys(parameters);
  if (keys.length !== 1 || keys[0] !== "expect" || (parameters.expect !== "present" && parameters.expect !== "absent")) {
    throw new Error("work-fold.file-presence parameters must contain only expect: present or absent.");
  }
  if (declaration.targets.some((target) => target.kind !== "file" || target.role !== "primary")) {
    throw new Error("work-fold.file-presence accepts only exact primary file targets.");
  }
}

async function runWorkFoldFilePresence({ declaration, inputs: closedInputs, signal }: WorkFoldCheckSensorContext): Promise<WorkFoldCheckSensorResult> {
  const expect = declaration.sensor.parameters.expect as "present" | "absent";
  const files = new Map(closedInputs.files.map((file) => [file.path, file]));
  const missing = new Set(closedInputs.missingExactTargets.map((target) => target.path));
  const candidates: WorkFoldCheckCandidateFinding[] = [];
  for (const target of declaration.targets) {
    if (signal.aborted) throw new Error(String(signal.reason || "Check sensor was aborted."));
    const file = files.get(target.path);
    const observed = file ? "file" : "missing";
    if (!file && !missing.has(target.path)) throw new Error(`Resolved target is missing from the closed input set: ${target.path}`);
    const identity: WorkFoldCheckFileIdentity = {
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
// WORK_FOLD_FILE_PRESENCE_SENSOR_IMPLEMENTATION_END

const builtinSensors = new Map<string, WorkFoldCheckSensor>([
  [filePresenceSensor.id, filePresenceSensor],
]);

export function resolveWorkFoldCheckSensor(id: string, revision: number): WorkFoldCheckSensor | null {
  const sensor = builtinSensors.get(id) ?? null;
  return sensor?.revision === revision ? sensor : null;
}

export function listWorkFoldCheckSensors(): Array<Pick<WorkFoldCheckSensor, "id" | "revision" | "execution" | "implementationDigest">> {
  return [...builtinSensors.values()].map(({ id, revision, execution, implementationDigest }) => ({ id, revision, execution, implementationDigest }));
}
