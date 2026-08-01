import { randomUUID } from "node:crypto";

export const workspaceCheckProposalKind = "workspace.check-proposal" as const;
export const workspaceCheckDeclarationKind = "workspace.check" as const;
export const workspaceCheckContractVersion = 1 as const;

export type WorkspaceCheckJson =
  | null
  | boolean
  | number
  | string
  | WorkspaceCheckJson[]
  | { [key: string]: WorkspaceCheckJson };

export type WorkspaceCheckSeverity = "info" | "warning" | "error";
export type WorkspaceCheckTargetRole = "primary" | "reference";

export interface WorkspaceCheckFileTarget {
  kind: "file";
  role: WorkspaceCheckTargetRole;
  path: string;
}

export interface WorkspaceCheckTreeTarget {
  kind: "tree";
  role: WorkspaceCheckTargetRole;
  path: string;
  recursive: boolean;
  extensions: string[];
}

export type WorkspaceCheckTarget = WorkspaceCheckFileTarget | WorkspaceCheckTreeTarget;

export interface WorkspaceCheckSensorRef {
  id: string;
  revision: number;
  parameters: { [key: string]: WorkspaceCheckJson };
}

export interface WorkspaceCheckDefinition {
  title: string;
  severity: WorkspaceCheckSeverity;
  trigger: "manual";
  sensor: WorkspaceCheckSensorRef;
  targets: WorkspaceCheckTarget[];
}

export interface WorkspaceCheckProposal {
  kind: typeof workspaceCheckProposalKind;
  version: typeof workspaceCheckContractVersion;
  name: string;
  createdBy: "human" | "assistant" | "codex" | "claude-code" | "other";
  createdAt: string;
  check: WorkspaceCheckDefinition;
}

export interface WorkspaceCheckDeclaration extends WorkspaceCheckDefinition {
  kind: typeof workspaceCheckDeclarationKind;
  version: typeof workspaceCheckContractVersion;
  id: string;
  createdBy: WorkspaceCheckProposal["createdBy"];
  createdAt: string;
}

const forbiddenParameterKeys = new Set([
  "code",
  "command",
  "instructions",
  "message",
  "model",
  "prompt",
  "provider",
  "script",
  "system",
]);

export function normalizeWorkspaceCheckProposal(value: unknown): WorkspaceCheckProposal {
  const record = objectRecord(value, "Check proposal must be a JSON object.");
  assertKeys(record, ["kind", "version", "name", "createdBy", "createdAt", "check"], [], "Check proposal");
  if (record.kind !== workspaceCheckProposalKind) throw new Error(`Check proposal kind must be ${workspaceCheckProposalKind}.`);
  assertVersion(record.version, "Check proposal");
  return {
    kind: workspaceCheckProposalKind,
    version: workspaceCheckContractVersion,
    name: boundedText(record.name, "Check proposal name", 120),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Check proposal createdAt"),
    check: normalizeCheckDefinition(record.check),
  };
}

export function normalizeWorkspaceCheckDeclaration(value: unknown): WorkspaceCheckDeclaration {
  const record = objectRecord(value, "Check declaration must be a JSON object.");
  assertKeys(
    record,
    ["kind", "version", "id", "title", "severity", "trigger", "sensor", "targets", "createdBy", "createdAt"],
    [],
    "Check declaration",
  );
  if (record.kind !== workspaceCheckDeclarationKind) throw new Error(`Check declaration kind must be ${workspaceCheckDeclarationKind}.`);
  assertVersion(record.version, "Check declaration");
  return {
    kind: workspaceCheckDeclarationKind,
    version: workspaceCheckContractVersion,
    id: checkId(record.id),
    ...normalizeCheckDefinition({
      title: record.title,
      severity: record.severity,
      trigger: record.trigger,
      sensor: record.sensor,
      targets: record.targets,
    }),
    createdBy: normalizeCreator(record.createdBy),
    createdAt: isoTimestamp(record.createdAt, "Check declaration createdAt"),
  };
}

export function declarationFromWorkspaceCheckProposal(
  proposal: WorkspaceCheckProposal,
  id = `check-${randomUUID()}`,
): WorkspaceCheckDeclaration {
  return normalizeWorkspaceCheckDeclaration({
    kind: workspaceCheckDeclarationKind,
    version: workspaceCheckContractVersion,
    id,
    ...proposal.check,
    createdBy: proposal.createdBy,
    createdAt: proposal.createdAt,
  });
}

export function normalizeWorkspaceCheckTargetPath(value: unknown, label = "Check target path"): string {
  if (typeof value !== "string" || value !== value.trim()) throw new Error(`${label} cannot have leading or trailing whitespace.`);
  const path = boundedText(value, label, 512).replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) throw new Error(`${label} must be relative to the Space.`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  if (segments.some((segment) => {
    const normalized = segment.toLocaleLowerCase("en-US");
    return normalized === ".workspace" || normalized === ".pi";
  })) {
    throw new Error(`${label} cannot select hidden Workspace or Pi configuration.`);
  }
  if (segments.some(isUnsafeWindowsPathSegment)) {
    throw new Error(`${label} contains a Windows-reserved or ambiguous path segment.`);
  }
  return segments.join("/");
}

function isUnsafeWindowsPathSegment(segment: string): boolean {
  if (segment.includes(":") || /[. ]$/.test(segment)) return true;
  const stem = segment.split(".", 1)[0]!.toLocaleLowerCase("en-US");
  return stem === "con" || stem === "prn" || stem === "aux" || stem === "nul"
    || /^com[1-9]$/.test(stem) || /^lpt[1-9]$/.test(stem);
}

function normalizeCheckDefinition(value: unknown): WorkspaceCheckDefinition {
  const record = objectRecord(value, "Check definition must be a JSON object.");
  assertKeys(record, ["title", "severity", "trigger", "sensor", "targets"], [], "Check definition");
  const severity = record.severity;
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new Error("Check severity must be info, warning, or error.");
  }
  if (record.trigger !== "manual") throw new Error("Check trigger must be manual in contract version 1.");
  if (!Array.isArray(record.targets) || record.targets.length < 1 || record.targets.length > 64) {
    throw new Error("Check targets must contain between 1 and 64 explicit targets.");
  }
  const targets = record.targets.map((target, index) => normalizeTarget(target, index));
  if (!targets.some((target) => target.role === "primary")) throw new Error("A Check requires at least one primary target.");
  return {
    title: boundedText(record.title, "Check title", 160),
    severity,
    trigger: "manual",
    sensor: normalizeSensor(record.sensor),
    targets,
  };
}

function normalizeSensor(value: unknown): WorkspaceCheckSensorRef {
  const record = objectRecord(value, "Check sensor must be a JSON object.");
  assertKeys(record, ["id", "revision", "parameters"], [], "Check sensor");
  const id = boundedText(record.id, "Sensor id", 160).toLocaleLowerCase("en-US");
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(id)) throw new Error("Sensor id is invalid.");
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
    throw new Error("Sensor revision must be a positive integer.");
  }
  const parameters = objectRecord(record.parameters, "Sensor parameters must be a JSON object.");
  validateParameterValue(parameters, "parameters", 0);
  return {
    id,
    revision: record.revision as number,
    parameters: structuredClone(parameters) as { [key: string]: WorkspaceCheckJson },
  };
}

function normalizeTarget(value: unknown, index: number): WorkspaceCheckTarget {
  const label = `Check target ${index + 1}`;
  const record = objectRecord(value, `${label} must be a JSON object.`);
  const role = record.role;
  if (role !== "primary" && role !== "reference") throw new Error(`${label} role must be primary or reference.`);
  if (record.kind === "file") {
    assertKeys(record, ["kind", "role", "path"], [], label);
    return { kind: "file", role, path: normalizeWorkspaceCheckTargetPath(record.path, `${label} path`) };
  }
  if (record.kind === "tree") {
    assertKeys(record, ["kind", "role", "path", "recursive", "extensions"], [], label);
    const path = normalizeWorkspaceCheckTargetPath(record.path, `${label} path`);
    if (record.recursive !== true && record.recursive !== false) throw new Error(`${label} recursive must be a boolean.`);
    if (!Array.isArray(record.extensions) || record.extensions.length < 1 || record.extensions.length > 24) {
      throw new Error(`${label} extensions must contain between 1 and 24 file extensions.`);
    }
    const extensions = [...new Set(record.extensions.map((extension) => normalizeExtension(extension, label)))].sort();
    return { kind: "tree", role, path, recursive: record.recursive, extensions };
  }
  throw new Error(`${label} kind must be file or tree.`);
}

function normalizeExtension(value: unknown, label: string): string {
  const extension = boundedText(value, `${label} extension`, 24).toLocaleLowerCase("en-US");
  if (!/^\.[a-z0-9][a-z0-9._+-]*$/.test(extension)) throw new Error(`${label} contains an invalid extension.`);
  return extension;
}

function validateParameterValue(value: unknown, path: string, depth: number): void {
  if (depth > 8) throw new Error("Sensor parameters are too deeply nested.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers.`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 4_096 || value.includes("\u0000")) throw new Error(`${path} contains invalid or oversized text.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error(`${path} contains too many values.`);
    value.forEach((item, index) => validateParameterValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${path} contains an unsupported value.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error(`${path} contains too many fields.`);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error(`${path} contains an invalid field name.`);
    if (forbiddenParameterKeys.has(key.toLocaleLowerCase("en-US"))) {
      throw new Error(`${path}.${key} is not allowed in an inert Check declaration.`);
    }
    validateParameterValue(item, `${path}.${key}`, depth + 1);
  }
}

function checkId(value: unknown): string {
  const id = boundedText(value, "Check id", 160).toLocaleLowerCase("en-US");
  if (!/^check-[a-z0-9][a-z0-9-]{7,154}$/.test(id)) throw new Error("Check id is invalid.");
  return id;
}

function normalizeCreator(value: unknown): WorkspaceCheckProposal["createdBy"] {
  if (value === "human" || value === "assistant" || value === "codex" || value === "claude-code" || value === "other") return value;
  throw new Error("Check proposal createdBy is invalid.");
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

function assertVersion(value: unknown, label: string): void {
  if (value !== workspaceCheckContractVersion) {
    throw new Error(`${label} uses unsupported version ${String(value)}.`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid or too long.`);
  }
  return normalized;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported field: ${unexpected[0]}.`);
  const missing = required.filter((key) => !(key in record));
  if (missing.length) throw new Error(`${label} is missing required field: ${missing[0]}.`);
}
