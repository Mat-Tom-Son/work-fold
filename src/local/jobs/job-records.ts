/**
 * Background job records (docs/background-jobs.md, F31–F33): the types, the
 * closed-shape parser, and the pure rules the store and the service share.
 *
 * A job is one shell command a running Worker or work-fold agent turn started
 * to keep running after the tool call returns. Its record is machine-local
 * attribution and recovery: it is journaled before the process starts, it is
 * never re-run, and its output lives beside it under the state root, never in
 * a work-folder.
 *
 * This module is pure: no filesystem, no clock, no process.
 */
import { Buffer } from "node:buffer";

import { workFoldBackgroundJobLimits } from "../../shared/work-fold-limits.js";

export const workFoldJobRecordSchema = "work-fold.job.v1" as const;
export const workFoldJobIdPattern = /^job-\d{14}-[0-9a-f]{8}$/;

/**
 * `accepted` is journaled before the process is spawned; `running` once it
 * has a process id. Every other state is terminal and never moves again.
 */
export type WorkFoldJobState =
  | "accepted"
  | "running"
  | "exited"
  | "stopped"
  | "timed_out"
  | "failed"
  | "interrupted";

export const workFoldJobTerminalStates = ["exited", "stopped", "timed_out", "failed", "interrupted"] as const;

export function isWorkFoldJobTerminalState(state: WorkFoldJobState): boolean {
  return (workFoldJobTerminalStates as readonly string[]).includes(state);
}

/** Who stopped a job: its own agent, the CLI, a request Stop, quitting work-fold, or its timeout. */
export type WorkFoldJobStopCause = "agent" | "cli" | "request" | "quit" | "timeout";

/** Where the job was started from; both write the same record. */
export type WorkFoldJobSurface = "tool" | "cli";

/**
 * What History kept after the job ended. `pending` while the capture runs;
 * `not_applicable` for the work-fold agent, which has no History of its own.
 */
export type WorkFoldJobHistory =
  | { status: "pending" }
  | {
    status: "captured";
    checkpointId: string;
    fileCount: number;
    skippedFileCount: number;
    skippedByReason: Record<string, number>;
  }
  | { status: "unavailable"; reason: string }
  | { status: "not_applicable"; reason: string };

/** How a job's end reached its Chat, exactly once (F32). */
export interface WorkFoldJobDelivery {
  at: string;
  by: "read" | "turn_context" | "follow_up";
  /** The turn that read it, or the turn the follow-up started; null if it could not start. */
  taskId: string | null;
}

export interface WorkFoldJobOutputCounters {
  /** Every byte the command wrote, kept or not. */
  bytes: number;
  /** Newline-terminated lines plus a final unterminated one. */
  lines: number;
  /** Early output dropped when a third segment began. */
  droppedBytes: number;
  droppedLines: number;
}

export interface WorkFoldJobRecord {
  schema: typeof workFoldJobRecordSchema;
  jobId: string;
  /** Absent exactly for the work-fold agent's own jobs. */
  workFolderId?: string;
  workFolderName?: string;
  conversationId: string;
  /** The turn that started it. */
  taskId: string;
  requestId: string;
  name: string;
  command: string;
  cwd: string;
  surface: WorkFoldJobSurface;
  state: WorkFoldJobState;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  /** Set once History and the request have recorded the end. */
  settledAt: string | null;
  pid: number | null;
  /** `ps -o lstart=` at spawn, so a restart never kills a reused process id. */
  processStartedAt: string | null;
  timeoutSeconds: number | null;
  exitCode: number | null;
  signal: string | null;
  stoppedBy: WorkFoldJobStopCause | null;
  error: string | null;
  output: WorkFoldJobOutputCounters;
  history: WorkFoldJobHistory | null;
  delivery: WorkFoldJobDelivery | null;
}

/** A refusal that names its bound, like every request limit (receipts-not-gates principle 6). */
export class WorkFoldJobLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkFoldJobLimitError";
  }
}

export class WorkFoldJobNotFoundError extends Error {
  constructor(message = "That background job is not on record.") {
    super(message);
    this.name = "WorkFoldJobNotFoundError";
  }
}

const forbiddenNamePattern = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const maximumNameBytes = 512;
const maximumErrorLength = 2_048;
const maximumPathBytes = 16 * 1024;
const stableIdPattern = /^[A-Za-z0-9._:-]+$/;

export function assertJobCommand(command: string): string {
  if (typeof command !== "string" || !command.trim()) throw new Error("A background job needs a command.");
  if (command.includes("\u0000")) throw new Error("A background job's command cannot contain a NUL character.");
  const bytes = Buffer.byteLength(command, "utf8");
  if (bytes > workFoldBackgroundJobLimits.maxCommandBytes) {
    throw new WorkFoldJobLimitError(`A background job's command can be at most ${workFoldBackgroundJobLimits.maxCommandBytes / 1024} KiB; this one is ${Math.ceil(bytes / 1024)} KiB. Settings → Automations → Limits shows this number.`);
  }
  return command;
}

/** The label a person sees: the given name, else the command's first line. */
export function jobDisplayName(name: string | undefined, command: string): string {
  const source = name?.trim() || command.trim().split("\n", 1)[0]!.trim();
  const clean = source.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/gu, " ").replace(/\s+/g, " ").trim();
  const cut = Buffer.byteLength(clean, "utf8") <= 200
    ? clean
    : `${Buffer.from(clean, "utf8").subarray(0, 197).toString("utf8").replace(/�+$/u, "")}…`;
  return cut || "Background job";
}

export function workFoldJobRunningLimitMessage(cap: number): string {
  return `${cap} background jobs are already running on this computer, the most work-fold runs at once. Stop one or wait for one to finish. Settings → Automations → Limits shows this number.`;
}

// --- parser ---------------------------------------------------------------

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function assertClosedShape(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(record).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${label} has an unexpected field: ${extra}.`);
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 160 || !stableIdPattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid.`);
  return value;
}

function nullableIsoDate(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : isoDate(value, label);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${label} is invalid.`);
  return value;
}

function nullableText(value: unknown, label: string, maxBytes: number): string | null {
  return value === null || value === undefined ? null : boundedText(value, label, maxBytes);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function nullableInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`${label} is invalid.`);
  return value as T;
}

function parseHistory(value: unknown, label: string): WorkFoldJobHistory | null {
  if (value === null || value === undefined) return null;
  const record = objectValue(value, label);
  const status = enumValue(record.status, ["pending", "captured", "unavailable", "not_applicable"] as const, `${label} status`);
  if (status === "pending") {
    assertClosedShape(record, ["status"], label);
    return { status };
  }
  if (status === "captured") {
    assertClosedShape(record, ["status", "checkpointId", "fileCount", "skippedFileCount", "skippedByReason"], label);
    const reasons = objectValue(record.skippedByReason, `${label} skipped files`);
    const skippedByReason: Record<string, number> = {};
    for (const [reason, count] of Object.entries(reasons)) skippedByReason[stableId(reason, `${label} skip reason`)] = nonNegativeInteger(count, `${label} skip count`);
    return {
      status,
      checkpointId: stableId(record.checkpointId, `${label} checkpoint`),
      fileCount: nonNegativeInteger(record.fileCount, `${label} file count`),
      skippedFileCount: nonNegativeInteger(record.skippedFileCount, `${label} skipped count`),
      skippedByReason,
    };
  }
  assertClosedShape(record, ["status", "reason"], label);
  return { status, reason: boundedText(record.reason, `${label} reason`, maximumErrorLength) };
}

function parseDelivery(value: unknown, label: string): WorkFoldJobDelivery | null {
  if (value === null || value === undefined) return null;
  const record = objectValue(value, label);
  assertClosedShape(record, ["at", "by", "taskId"], label);
  return {
    at: isoDate(record.at, `${label} time`),
    by: enumValue(record.by, ["read", "turn_context", "follow_up"] as const, `${label} kind`),
    taskId: record.taskId === null || record.taskId === undefined ? null : stableId(record.taskId, `${label} task`),
  };
}

function parseOutput(value: unknown, label: string): WorkFoldJobOutputCounters {
  const record = objectValue(value, label);
  assertClosedShape(record, ["bytes", "lines", "droppedBytes", "droppedLines"], label);
  return {
    bytes: nonNegativeInteger(record.bytes, `${label} bytes`),
    lines: nonNegativeInteger(record.lines, `${label} lines`),
    droppedBytes: nonNegativeInteger(record.droppedBytes, `${label} dropped bytes`),
    droppedLines: nonNegativeInteger(record.droppedLines, `${label} dropped lines`),
  };
}

export function parseWorkFoldJobRecord(value: unknown): WorkFoldJobRecord {
  const label = "Background job record";
  const record = objectValue(value, label);
  if (record.schema !== workFoldJobRecordSchema) throw new Error(`${label} schema is unsupported.`);
  assertClosedShape(record, [
    "schema", "jobId", "workFolderId", "workFolderName", "conversationId", "taskId", "requestId", "name", "command", "cwd",
    "surface", "state", "createdAt", "updatedAt", "startedAt", "endedAt", "settledAt", "pid", "processStartedAt",
    "timeoutSeconds", "exitCode", "signal", "stoppedBy", "error", "output", "history", "delivery",
  ], label);
  const jobId = stableId(record.jobId, `${label} id`);
  if (!workFoldJobIdPattern.test(jobId)) throw new Error(`${label} id is invalid.`);
  const name = boundedText(record.name, `${label} name`, maximumNameBytes);
  if (forbiddenNamePattern.test(name)) throw new Error(`${label} name is invalid.`);
  const timeoutSeconds = record.timeoutSeconds === null || record.timeoutSeconds === undefined ? null : record.timeoutSeconds;
  if (timeoutSeconds !== null && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    throw new Error(`${label} timeout is invalid.`);
  }
  const parsed: WorkFoldJobRecord = {
    schema: workFoldJobRecordSchema,
    jobId,
    conversationId: stableId(record.conversationId, `${label} conversation`),
    taskId: stableId(record.taskId, `${label} task`),
    requestId: stableId(record.requestId, `${label} request`),
    name,
    command: assertJobCommand(boundedText(record.command, `${label} command`, workFoldBackgroundJobLimits.maxCommandBytes)),
    cwd: boundedText(record.cwd, `${label} folder`, maximumPathBytes),
    surface: enumValue(record.surface, ["tool", "cli"] as const, `${label} surface`),
    state: enumValue(record.state, ["accepted", "running", ...workFoldJobTerminalStates] as const, `${label} state`),
    createdAt: isoDate(record.createdAt, `${label} creation time`),
    updatedAt: isoDate(record.updatedAt, `${label} update time`),
    startedAt: nullableIsoDate(record.startedAt, `${label} start time`),
    endedAt: nullableIsoDate(record.endedAt, `${label} end time`),
    settledAt: nullableIsoDate(record.settledAt, `${label} settle time`),
    pid: nullableInteger(record.pid, `${label} process id`),
    processStartedAt: nullableText(record.processStartedAt, `${label} process start`, 128),
    timeoutSeconds: timeoutSeconds as number | null,
    exitCode: nullableInteger(record.exitCode, `${label} exit code`),
    signal: nullableText(record.signal, `${label} signal`, 32),
    stoppedBy: record.stoppedBy === null || record.stoppedBy === undefined ? null
      : enumValue(record.stoppedBy, ["agent", "cli", "request", "quit", "timeout"] as const, `${label} stopped by`),
    error: nullableText(record.error, `${label} error`, maximumErrorLength),
    output: parseOutput(record.output, `${label} output`),
    history: parseHistory(record.history, `${label} History`),
    delivery: parseDelivery(record.delivery, `${label} delivery`),
  };
  if (record.workFolderId !== undefined) parsed.workFolderId = stableId(record.workFolderId, `${label} work-folder`);
  if (record.workFolderName !== undefined) parsed.workFolderName = boundedText(record.workFolderName, `${label} work-folder name`, 1_024);
  return parsed;
}

export function boundJobError(message: string): string {
  return message.length <= maximumErrorLength ? message : `${message.slice(0, maximumErrorLength - 1)}…`;
}

// --- presentation -----------------------------------------------------------

/** "6 min 12 s"; whole seconds below a minute, hours above an hour. */
export function formatJobDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/** One plain sentence for a job's state, the same wherever a job is described. */
export function describeJobState(job: Pick<WorkFoldJobRecord, "state" | "exitCode" | "signal" | "stoppedBy" | "error" | "startedAt" | "endedAt" | "createdAt">, now: Date): string {
  const began = Date.parse(job.startedAt ?? job.createdAt);
  const ended = job.endedAt ? Date.parse(job.endedAt) : now.getTime();
  const took = formatJobDuration(ended - began);
  switch (job.state) {
    case "accepted": return "starting";
    case "running": return `running for ${took}`;
    case "exited": return `exited with code ${job.exitCode ?? "unknown"} after ${took}`;
    case "timed_out": return `stopped by its timeout after ${took}`;
    case "stopped": {
      const by = job.stoppedBy === "request" ? " when its request was stopped"
        : job.stoppedBy === "agent" ? " by its agent"
          : job.stoppedBy === "cli" ? " from the work-fold command"
            : "";
      return `stopped${by} after ${took}`;
    }
    case "failed": return `could not start${job.error ? `: ${job.error}` : ""}`;
    case "interrupted": return `interrupted${job.error ? `: ${job.error}` : ""}`;
  }
}

export function describeJobHistory(history: WorkFoldJobHistory | null): string {
  if (!history) return "History: not recorded.";
  switch (history.status) {
    case "pending": return "History: saving a checkpoint now.";
    case "captured": {
      const skipped = history.skippedFileCount
        ? `; ${history.skippedFileCount} skipped (${Object.entries(history.skippedByReason).map(([reason, count]) => `${count} ${reason.replace(/_/g, " ")}`).join(", ")})`
        : "";
      return `History: checkpoint ${history.checkpointId} after it ended (${history.fileCount} files kept${skipped}).`;
    }
    case "unavailable": return `History: no checkpoint after it ended — ${history.reason}`;
    case "not_applicable": return `History: ${history.reason}`;
  }
}
