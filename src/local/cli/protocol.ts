import { isAbsolute, resolve } from "node:path";

/**
 * Protocol v1 is intentionally a read-only, same-user control surface. The
 * platform application-data file exchange is not an authenticated caller boundary. Do not add
 * mutating commands to this version. Mutations live exclusively in the
 * separately versioned act lane (`act-protocol.ts`), which authenticates each
 * request with the per-launch act token the running desktop app mints.
 */
export const WORKFOLD_CLI_PROTOCOL_VERSION = 1 as const;

/** Accepted shape for per-launch act tokens carried by act-lane requests. */
export const WORKFOLD_CLI_ACT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const WORKFOLD_CLI_MAX_ARG_COUNT = 128;
export const WORKFOLD_CLI_MAX_ARG_LENGTH = 8 * 1024;
export const WORKFOLD_CLI_MAX_ARGV_LENGTH = 64 * 1024;

export const WorkFoldCliExitCode = {
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

export type WorkFoldCliExitCode = typeof WorkFoldCliExitCode[keyof typeof WorkFoldCliExitCode];
export type WorkFoldCliErrorCode = Exclude<keyof typeof WorkFoldCliExitCode, "success">;
export type WorkFoldCliOutputMode = "human" | "json";
export type WorkFoldCliCommandName = "help" | "version" | "context" | "spaces.list" | "tasks.list" | "capabilities.list" | "checks.status";

export type WorkFoldCliJson =
  | null
  | boolean
  | number
  | string
  | WorkFoldCliJson[]
  | { [key: string]: WorkFoldCliJson };

/** Stable on-disk request contract shared by platform shims and the desktop broker. */
export interface WorkFoldCliRequestV1 {
  protocolVersion: typeof WORKFOLD_CLI_PROTOCOL_VERSION;
  id: string;
  argv: string[];
  cwd: string;
  createdAt: string;
}

/** Stable on-disk response contract shared by the desktop broker and platform shims. */
export interface WorkFoldCliResponseV1 {
  protocolVersion: typeof WORKFOLD_CLI_PROTOCOL_VERSION;
  id: string;
  exitCode: WorkFoldCliExitCode;
  stdout: string;
  stderr: string;
  result?: WorkFoldCliJson;
  completedAt?: string;
}

export interface WorkFoldCliParsedCommand {
  name: WorkFoldCliCommandName;
  output: WorkFoldCliOutputMode;
  space?: string;
  topic?: string;
}

export interface WorkFoldCliActor {
  kind: "cli";
  cwd: string;
}

export interface WorkFoldCliSpaceSummary {
  id: string;
  name: string;
  spaceRoot?: string;
  active?: boolean;
}

export interface WorkFoldCliContextSnapshot {
  cwd: string;
  space: WorkFoldCliSpaceSummary | null;
  selectedPath?: string | null;
  activeSurface?: string | null;
}

export interface WorkFoldCliTaskSummary {
  id: string;
  label: string;
  status: string;
  spaceId?: string;
  updatedAt?: string;
}

export interface WorkFoldCliCapabilitySummary {
  id: string;
  name: string;
  kind: "skill" | "extension" | "tool" | "package" | "other";
  scope: "personal" | "space" | string;
  status?: string;
  source?: string;
}

export type WorkFoldCliCheckAggregateState =
  | "unavailable"
  | "not-configured"
  | "current-clear"
  | "needs-attention"
  | "stale"
  | "blocked"
  | "check-error";

/** Experimental, aggregate-only Check status. It never carries content. */
export interface WorkFoldCliCheckStatusSummary {
  kind: "work-fold.checks.experimental";
  version: 0;
  available: boolean;
  spaceId: string;
  state: WorkFoldCliCheckAggregateState;
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
 * The deliberately narrow adapter needed by the CLI executor. WorkFoldKernel
 * satisfies this interface through a compact projection without importing
 * desktop code into the reusable control plane.
 */
export interface WorkFoldCliKernel {
  getContext(actor: WorkFoldCliActor, options: { space?: string }): Promise<WorkFoldCliContextSnapshot>;
  listSpaces(actor: WorkFoldCliActor, options: { space?: string }): Promise<WorkFoldCliSpaceSummary[]>;
  listTasks(actor: WorkFoldCliActor, options: { space?: string }): Promise<WorkFoldCliTaskSummary[]>;
  listCapabilities(actor: WorkFoldCliActor, options: { space?: string }): Promise<WorkFoldCliCapabilitySummary[]>;
  getChecksStatus?(actor: WorkFoldCliActor, options: { space?: string }): Promise<WorkFoldCliCheckStatusSummary>;
}

export class WorkFoldCliError extends Error {
  readonly exitCode: WorkFoldCliExitCode;

  constructor(
    readonly code: WorkFoldCliErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "WorkFoldCliError";
    this.exitCode = WorkFoldCliExitCode[code];
  }
}

export function normalizeWorkFoldCliRequestId(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new WorkFoldCliError("protocolError", "CLI request id must be a UUID.");
  }
  return normalized;
}

export function parseWorkFoldCliRequest(value: unknown): WorkFoldCliRequestV1 {
  const record = objectRecord(value, "CLI request must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "argv", "cwd", "createdAt"], "CLI request");
  if (record.protocolVersion !== WORKFOLD_CLI_PROTOCOL_VERSION) {
    throw new WorkFoldCliError(
      "protocolError",
      `Unsupported CLI protocol version: ${String(record.protocolVersion)}. Expected ${WORKFOLD_CLI_PROTOCOL_VERSION}.`,
    );
  }
  if (typeof record.id !== "string") throw new WorkFoldCliError("protocolError", "CLI request id must be a string.");
  const id = normalizeWorkFoldCliRequestId(record.id);
  const argv = parseArgv(record.argv);
  if (typeof record.cwd !== "string" || !record.cwd.trim() || !isAbsolute(record.cwd)) {
    throw new WorkFoldCliError("protocolError", "CLI request cwd must be an absolute path.");
  }
  if (record.cwd.includes("\u0000")) throw new WorkFoldCliError("protocolError", "CLI request cwd contains an invalid character.");
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new WorkFoldCliError("protocolError", "CLI request createdAt must be an ISO timestamp.");
  }
  return {
    protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
    id,
    argv,
    cwd: resolve(record.cwd),
    createdAt: new Date(record.createdAt).toISOString(),
  };
}

export function parseWorkFoldCliResponse(value: unknown): WorkFoldCliResponseV1 {
  const record = objectRecord(value, "CLI response must be a JSON object.");
  assertExactKeys(record, ["protocolVersion", "id", "exitCode", "stdout", "stderr", "result", "completedAt"], "CLI response", true);
  if (record.protocolVersion !== WORKFOLD_CLI_PROTOCOL_VERSION) {
    throw new WorkFoldCliError("protocolError", `Unsupported CLI response protocol version: ${String(record.protocolVersion)}.`);
  }
  if (typeof record.id !== "string") throw new WorkFoldCliError("protocolError", "CLI response id must be a string.");
  const id = normalizeWorkFoldCliRequestId(record.id);
  if (!isWorkFoldCliExitCode(record.exitCode)) throw new WorkFoldCliError("protocolError", "CLI response exitCode is invalid.");
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new WorkFoldCliError("protocolError", "CLI response output must be text.");
  }
  if (record.completedAt !== undefined && (typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt)))) {
    throw new WorkFoldCliError("protocolError", "CLI response completedAt must be an ISO timestamp.");
  }
  if (record.result !== undefined && !isWorkFoldCliJson(record.result)) {
    throw new WorkFoldCliError("protocolError", "CLI response result must be JSON-serializable.");
  }
  return {
    protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
    id,
    exitCode: record.exitCode,
    stdout: record.stdout,
    stderr: record.stderr,
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: new Date(record.completedAt).toISOString() } : {}),
  };
}

export function createWorkFoldCliRequest(input: {
  id: string;
  argv: string[];
  cwd: string;
  createdAt?: string;
}): WorkFoldCliRequestV1 {
  return parseWorkFoldCliRequest({
    protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION,
    id: input.id,
    argv: input.argv,
    cwd: input.cwd,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export function createWorkFoldCliResponse(input: Omit<WorkFoldCliResponseV1, "protocolVersion">): WorkFoldCliResponseV1 {
  return parseWorkFoldCliResponse({ protocolVersion: WORKFOLD_CLI_PROTOCOL_VERSION, ...input });
}

/** Shared bounded argv validation for both protocol lanes. */
export function parseBoundedCliArgv(value: unknown): string[] {
  return parseArgv(value);
}

function parseArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkFoldCliError("protocolError", "CLI request argv must be an array of strings.");
  }
  if (value.length > WORKFOLD_CLI_MAX_ARG_COUNT) {
    throw new WorkFoldCliError("protocolError", `CLI request has more than ${WORKFOLD_CLI_MAX_ARG_COUNT} arguments.`);
  }
  const argv = value as string[];
  let total = 0;
  for (const argument of argv) {
    if (argument.includes("\u0000")) throw new WorkFoldCliError("protocolError", "CLI argument contains an invalid character.");
    if (argument.length > WORKFOLD_CLI_MAX_ARG_LENGTH) {
      throw new WorkFoldCliError("protocolError", `CLI argument exceeds ${WORKFOLD_CLI_MAX_ARG_LENGTH} characters.`);
    }
    total += argument.length;
  }
  if (total > WORKFOLD_CLI_MAX_ARGV_LENGTH) {
    throw new WorkFoldCliError("protocolError", `CLI arguments exceed ${WORKFOLD_CLI_MAX_ARGV_LENGTH} characters in total.`);
  }
  return [...argv];
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkFoldCliError("protocolError", message);
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
  if (unexpected.length) throw new WorkFoldCliError("protocolError", `${label} contains unsupported field: ${unexpected[0]}.`);
  if (optional) return;
  const missing = keys.filter((key) => !(key in record));
  if (missing.length) throw new WorkFoldCliError("protocolError", `${label} is missing required field: ${missing[0]}.`);
}

function isWorkFoldCliExitCode(value: unknown): value is WorkFoldCliExitCode {
  return typeof value === "number" && Object.values(WorkFoldCliExitCode).includes(value as WorkFoldCliExitCode);
}

function isWorkFoldCliJson(value: unknown): value is WorkFoldCliJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkFoldCliJson);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((item) => item !== undefined && isWorkFoldCliJson(item));
}
