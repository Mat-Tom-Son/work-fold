import { isAbsolute, resolve } from "node:path";

/**
 * Protocol v1 is intentionally a read-only, same-user control surface. The
 * platform application-data file exchange is not an authenticated caller boundary. Do not add
 * mutating commands to this version. Mutations live exclusively in the
 * separately versioned act lane (`act-protocol.ts`), which authenticates each
 * request with the per-launch act token the running desktop app mints.
 */
export const WORKSPACE_CLI_PROTOCOL_VERSION = 1 as const;

/** Accepted shape for per-launch act tokens carried by act-lane requests. */
export const WORKSPACE_CLI_ACT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const WORKSPACE_CLI_MAX_ARG_COUNT = 128;
export const WORKSPACE_CLI_MAX_ARG_LENGTH = 8 * 1024;
export const WORKSPACE_CLI_MAX_ARGV_LENGTH = 64 * 1024;

export const WorkspaceCliExitCode = {
  success: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  permissionDenied: 4,
  conflict: 5,
  unavailable: 6,
  timeout: 7,
  protocolError: 8,
} as const;

export type WorkspaceCliExitCode = typeof WorkspaceCliExitCode[keyof typeof WorkspaceCliExitCode];
export type WorkspaceCliErrorCode = Exclude<keyof typeof WorkspaceCliExitCode, "success">;
export type WorkspaceCliOutputMode = "human" | "json";
export type WorkspaceCliCommandName = "help" | "version" | "context" | "spaces.list" | "tasks.list" | "capabilities.list" | "checks.status";

export type WorkspaceCliJson =
  | null
  | boolean
  | number
  | string
  | WorkspaceCliJson[]
  | { [key: string]: WorkspaceCliJson };

/** Stable on-disk request contract shared by platform shims and the desktop broker. */
export interface WorkspaceCliRequestV1 {
  protocolVersion: typeof WORKSPACE_CLI_PROTOCOL_VERSION;
  id: string;
  argv: string[];
  cwd: string;
  createdAt: string;
}

/** Stable on-disk response contract shared by the desktop broker and platform shims. */
export interface WorkspaceCliResponseV1 {
  protocolVersion: typeof WORKSPACE_CLI_PROTOCOL_VERSION;
  id: string;
  exitCode: WorkspaceCliExitCode;
  stdout: string;
  stderr: string;
  result?: WorkspaceCliJson;
  completedAt?: string;
}

export interface WorkspaceCliParsedCommand {
  name: WorkspaceCliCommandName;
  output: WorkspaceCliOutputMode;
  space?: string;
  topic?: string;
}

export interface WorkspaceCliActor {
  kind: "cli";
  cwd: string;
}

export interface WorkspaceCliSpaceSummary {
  id: string;
  name: string;
  rootPath?: string;
  active?: boolean;
}

export interface WorkspaceCliContextSnapshot {
  cwd: string;
  space: WorkspaceCliSpaceSummary | null;
  selectedPath?: string | null;
  activeSurface?: string | null;
}

export interface WorkspaceCliTaskSummary {
  id: string;
  label: string;
  status: string;
  workspaceId?: string;
  updatedAt?: string;
}

export interface WorkspaceCliCapabilitySummary {
  id: string;
  name: string;
  kind: "skill" | "extension" | "tool" | "package" | "other";
  scope: "personal" | "space" | string;
  status?: string;
  source?: string;
}

export type WorkspaceCliCheckAggregateState =
  | "unavailable"
  | "not-configured"
  | "current-clear"
  | "needs-attention"
  | "stale"
  | "blocked"
  | "check-error";

/** Experimental, aggregate-only Check status. It never carries content. */
export interface WorkspaceCliCheckStatusSummary {
  kind: "workspace.checks.experimental";
  version: 0;
  available: boolean;
  workspaceId: string;
  state: WorkspaceCliCheckAggregateState;
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

/**
 * The deliberately narrow adapter needed by the CLI executor. WorkspaceKernel
 * satisfies this interface through a compact projection without importing
 * desktop code into the reusable control plane.
 */
export interface WorkspaceCliKernel {
  getContext(actor: WorkspaceCliActor, options: { space?: string }): Promise<WorkspaceCliContextSnapshot>;
  listSpaces(actor: WorkspaceCliActor, options: { space?: string }): Promise<WorkspaceCliSpaceSummary[]>;
  listTasks(actor: WorkspaceCliActor, options: { space?: string }): Promise<WorkspaceCliTaskSummary[]>;
  listCapabilities(actor: WorkspaceCliActor, options: { space?: string }): Promise<WorkspaceCliCapabilitySummary[]>;
  getChecksStatus?(actor: WorkspaceCliActor, options: { space?: string }): Promise<WorkspaceCliCheckStatusSummary>;
}

export class WorkspaceCliError extends Error {
  readonly exitCode: WorkspaceCliExitCode;

  constructor(
    readonly code: WorkspaceCliErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "WorkspaceCliError";
    this.exitCode = WorkspaceCliExitCode[code];
  }
}

export function normalizeWorkspaceCliRequestId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new WorkspaceCliError("protocolError", "CLI request id must be a UUID.");
  }
  return normalized;
}

export function parseWorkspaceCliRequest(value: unknown): WorkspaceCliRequestV1 {
  const record = objectRecord(value, "CLI request must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "argv", "cwd", "createdAt"], "CLI request");
  if (record.protocolVersion !== WORKSPACE_CLI_PROTOCOL_VERSION) {
    throw new WorkspaceCliError(
      "protocolError",
      `Unsupported CLI protocol version: ${String(record.protocolVersion)}. Expected ${WORKSPACE_CLI_PROTOCOL_VERSION}.`,
    );
  }
  if (typeof record.id !== "string") throw new WorkspaceCliError("protocolError", "CLI request id must be a string.");
  const id = normalizeWorkspaceCliRequestId(record.id);
  const argv = parseArgv(record.argv);
  if (typeof record.cwd !== "string" || !record.cwd.trim() || !isAbsolute(record.cwd)) {
    throw new WorkspaceCliError("protocolError", "CLI request cwd must be an absolute path.");
  }
  if (record.cwd.includes("\u0000")) throw new WorkspaceCliError("protocolError", "CLI request cwd contains an invalid character.");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new WorkspaceCliError("protocolError", "CLI request createdAt must be an ISO timestamp.");
  }
  return {
    protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
    id,
    argv,
    cwd: resolve(record.cwd),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

export function parseWorkspaceCliResponse(value: unknown): WorkspaceCliResponseV1 {
  const record = objectRecord(value, "CLI response must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "exitCode", "stdout", "stderr", "result", "completedAt"], "CLI response", true);
  if (record.protocolVersion !== WORKSPACE_CLI_PROTOCOL_VERSION) {
    throw new WorkspaceCliError("protocolError", `Unsupported CLI response protocol version: ${String(record.protocolVersion)}.`);
  }
  if (typeof record.id !== "string") throw new WorkspaceCliError("protocolError", "CLI response id must be a string.");
  const id = normalizeWorkspaceCliRequestId(record.id);
  if (!isWorkspaceCliExitCode(record.exitCode)) throw new WorkspaceCliError("protocolError", "CLI response exitCode is invalid.");
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new WorkspaceCliError("protocolError", "CLI response output must be text.");
  }
  if (record.completedAt !== undefined && (typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt)))) {
    throw new WorkspaceCliError("protocolError", "CLI response completedAt must be an ISO timestamp.");
  }
  if (record.result !== undefined && !isWorkspaceCliJson(record.result)) {
    throw new WorkspaceCliError("protocolError", "CLI response result must be JSON-serializable.");
  }
  return {
    protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
    id,
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: new Date(record.completedAt).toISOString() } : {}),
  };
}

export function createWorkspaceCliRequest(input: {
  id: string;
  argv: string[];
  cwd: string;
  createdAt?: string;
}): WorkspaceCliRequestV1 {
  return parseWorkspaceCliRequest({
    protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION,
    id: input.id,
    argv: input.argv,
    cwd: input.cwd,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function createWorkspaceCliResponse(input: Omit<WorkspaceCliResponseV1, "protocolVersion">): WorkspaceCliResponseV1 {
  return parseWorkspaceCliResponse({ protocolVersion: WORKSPACE_CLI_PROTOCOL_VERSION, ...input });
}

/** Shared bounded argv validation for both protocol lanes. */
export function parseBoundedCliArgv(value: unknown): string[] {
  return parseArgv(value);
}

function parseArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkspaceCliError("protocolError", "CLI request argv must be an array of strings.");
  }
  if (value.length > WORKSPACE_CLI_MAX_ARG_COUNT) {
    throw new WorkspaceCliError("protocolError", `CLI request has more than ${WORKSPACE_CLI_MAX_ARG_COUNT} arguments.`);
  }
  const argv = value as string[];
  let total = 0;
  for (const argument of argv) {
    if (argument.includes("\u0000")) throw new WorkspaceCliError("protocolError", "CLI argument contains an invalid character.");
    if (argument.length > WORKSPACE_CLI_MAX_ARG_LENGTH) {
      throw new WorkspaceCliError("protocolError", `CLI argument exceeds ${WORKSPACE_CLI_MAX_ARG_LENGTH} characters.`);
    }
    total += argument.length;
  }
  if (total > WORKSPACE_CLI_MAX_ARGV_LENGTH) {
    throw new WorkspaceCliError("protocolError", `CLI arguments exceed ${WORKSPACE_CLI_MAX_ARGV_LENGTH} characters in total.`);
  }
  return [...argv];
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceCliError("protocolError", message);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: string[],
  label: string,
  optional = false,
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(record).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new WorkspaceCliError("protocolError", `${label} contains unsupported field: ${unexpected[0]}.`);
  if (optional) return;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length) throw new WorkspaceCliError("protocolError", `${label} is missing required field: ${missing[0]}.`);
}

function isWorkspaceCliExitCode(value: unknown): value is WorkspaceCliExitCode {
  return typeof value === "number" && Object.values(WorkspaceCliExitCode).includes(value as WorkspaceCliExitCode);
}

function isWorkspaceCliJson(value: unknown): value is WorkspaceCliJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkspaceCliJson);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => item !== undefined && isWorkspaceCliJson(item));
}
