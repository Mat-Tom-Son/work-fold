/**
 * job_start, job_output, job_stop: the background job tools every Worker and
 * the work-fold agent carry (docs/background-jobs.md). They sit beside Pi's
 * `bash`, which stays the tool for short commands. The tools know their own
 * turn, work-folder, and Chat, so they take no ids or flags; the host behind
 * them is the same job service the `work-fold jobs` verbs use, so both leave
 * the same record.
 */
import { isAbsolute, join, resolve } from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { workFoldBackgroundJobLimits } from "../../shared/work-fold-limits.js";
import {
  describeJobHistory,
  describeJobState,
  isWorkFoldJobTerminalState,
  type WorkFoldJobRecord,
} from "../jobs/job-records.js";
import { describeJobOutputRead, type JobOutputRead } from "../jobs/job-output.js";
import type { WorkFoldJobShell, WorkFoldJobWaitOutcome } from "../jobs/job-service.js";

/** What the tools need from the host; one instance per Chat client. */
export interface BackgroundJobToolHost {
  start(input: { taskId: string; command: string; name?: string; cwd: string; timeoutSeconds?: number; shell: WorkFoldJobShell; interactive?: boolean; service?: boolean }): Promise<WorkFoldJobRecord>;
  input?(input: { taskId: string; jobId: string; text: string; eof?: boolean }): Promise<WorkFoldJobRecord>;
  /** This Chat's jobs, then running jobs elsewhere in the same scope. */
  list(input: { taskId: string }): { here: WorkFoldJobRecord[]; elsewhere: WorkFoldJobRecord[] };
  read(input: { taskId: string; jobId: string; offset?: number; limit?: number }): Promise<{ job: WorkFoldJobRecord; output: JobOutputRead }>;
  wait(input: { taskId: string; jobId: string; seconds: number; until?: RegExp; fromLine?: number; signal?: AbortSignal }): Promise<WorkFoldJobWaitOutcome>;
  stop(input: { taskId: string; jobId: string }): Promise<WorkFoldJobRecord>;
}

export interface BackgroundJobToolsInput {
  /** The session's folder: the default place a job runs. */
  root: string;
  host: BackgroundJobToolHost;
  /** The running turn's task id; tools refuse outside a turn. */
  taskId: () => string | undefined;
  /** Pi's shell settings, read when a job starts so a settings change applies. */
  shell: () => WorkFoldJobShell;
}

export const backgroundJobToolNames = ["job_start", "job_output", "job_stop", "job_input"] as const;

function requireTask(input: BackgroundJobToolsInput): string {
  const taskId = input.taskId();
  if (!taskId) throw new Error("Background jobs start and read only inside a running turn.");
  return taskId;
}

function optionalSeconds(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a number of seconds, 0 or more.`);
  return value;
}

function optionalLine(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a whole number, 1 or more.`);
  return value;
}

export function parseUntilPattern(value: unknown): RegExp | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("until must be a pattern written as text.");
  try {
    return new RegExp(value);
  } catch (error) {
    throw new Error(`until is not a usable pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function jobHeader(job: WorkFoldJobRecord, now: Date): string {
  const pid = job.state === "running" && job.pid ? `; process ${job.pid}` : "";
  return `Background job ${job.jobId} "${job.name}": ${describeJobState(job, now)}${pid}.`;
}

/** The text a tool returns for one job: its state, History once ended, and its output. */
export function describeJobForModel(job: WorkFoldJobRecord, output: JobOutputRead | null, now: Date, notes: string[] = []): string {
  const lines = [jobHeader(job, now)];
  if (isWorkFoldJobTerminalState(job.state)) lines.push(describeJobHistory(job.history));
  else if (job.serving) lines.push(servingNote(job.serving));
  lines.push(...notes);
  if (output) {
    lines.push(describeJobOutputRead(output) + (output.totalLines ? ` Next offset: ${output.nextOffset}.` : ""));
    if (output.text) lines.push("", output.text);
  }
  return lines.join("\n");
}

/** A running server's address: the Worker can look at it in the built-in browser, and the person can click it in the reply. */
function servingNote(address: string): string {
  return `It is serving ${address}. Look at it with browser_open when that tool is available, and write the address in your reply: the person can click it to open it as a browser tab.`;
}

function describeWait(outcome: WorkFoldJobWaitOutcome | null, seconds: number): string[] {
  if (!outcome) return [];
  switch (outcome.outcome) {
    case "matched": return [`Matched line ${outcome.line}: ${outcome.text}`];
    case "timed_out": return [`Still running after waiting ${seconds} s.`];
    case "aborted": return ["The wait was interrupted."];
    case "ended": return [];
  }
}

function resolveCwd(root: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return root;
  if (typeof value !== "string") throw new Error("cwd must be a folder path.");
  return isAbsolute(value) ? value : resolve(join(root, value));
}

export function createBackgroundJobTools(input: BackgroundJobToolsInput): ToolDefinition<any>[] {
  const defaultWait = workFoldBackgroundJobLimits.defaultStartWaitSeconds;
  const start: ToolDefinition<any> = {
    name: "job_start",
    label: "Start background job",
    description: `Start a shell command as a background job that keeps running after this call returns. Use it instead of bash for anything that may take more than a couple of minutes — exports, conversions, installs, builds, test suites, servers — or whose partial output decides your next step. Returns the job id and its output so far after waiting up to ${defaultWait} seconds (wait), or as soon as it exits or a line matches until. A command that finishes inside the wait returns like bash. If your turn ends first, work-fold brings the job's result back to this Chat once when it ends.`,
    promptSnippet: "Start a long-running shell command in the background",
    promptGuidelines: [
      "Use job_start for anything that may take more than a couple of minutes, or whose partial output decides the next step; use bash for everything else.",
      "After job_start, keep working, or finish your turn and say what is running: work-fold brings a job's result back to this Chat once when it ends. Never poll in a loop or sleep waiting for it. Use job_output's wait or until only when nothing else is left and the result is close, such as a server's ready line.",
      "Stop servers and watchers you started with job_stop when the work no longer needs them.",
      "timeout is the maximum lifetime of the whole command in seconds; wait controls how soon this tool returns. For an immediate return set wait:0 and omit timeout, or give the command enough time for model/tool round trips. Never use a tiny timeout to make job_start return quickly.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "The shell command, run like bash in this Chat's folder." },
        interactive: { type: "boolean", description: "Allocate a real terminal (PTY). Send input with job_input, including newline or Ctrl-C as needed." },
        service: { type: "boolean", description: "Keep a server or watcher alive independently of request completion. It still stops on quit and blocks deletion while running. Stop it explicitly when no longer needed; its exit does not wake a turn." },
        name: { type: "string", maxLength: 200, description: "A short label the person sees, for example \"Export the video\". Defaults to the command." },
        cwd: { type: "string", description: "Folder to run in: relative to this Chat's folder, or absolute. Defaults to this Chat's folder." },
        timeout: { type: "number", exclusiveMinimum: 0, description: "Maximum lifetime of the entire command in seconds, not the call's return delay (use wait for that). No limit by default; interactive jobs need time for model/tool round trips." },
        wait: { type: "number", minimum: 0, description: `Seconds to wait before returning, for early output or an exit. Defaults to ${defaultWait}; 0 returns at once.` },
        until: { type: "string", description: "A pattern (JavaScript regular expression); return as soon as a line of output matches it, for example \"ready|listening on\"." },
      },
      required: ["command"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const taskId = requireTask(input);
      const value = params as { command?: unknown; name?: unknown; cwd?: unknown; timeout?: unknown; wait?: unknown; until?: unknown; interactive?: boolean; service?: boolean };
      if (typeof value.command !== "string" || !value.command.trim()) throw new Error("job_start needs a command.");
      const timeoutSeconds = optionalSeconds(value.timeout, "timeout");
      if (timeoutSeconds === 0) throw new Error("timeout must be more than 0 seconds.");
      const seconds = optionalSeconds(value.wait, "wait") ?? defaultWait;
      const until = parseUntilPattern(value.until);
      const job = await input.host.start({
        taskId,
        command: value.command,
        ...(value.interactive ? { interactive: true } : {}),
        ...(value.service ? { service: true } : {}),
        ...(typeof value.name === "string" && value.name.trim() ? { name: value.name } : {}),
        cwd: resolveCwd(input.root, value.cwd),
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        shell: input.shell(),
      });
      if (job.state === "failed") {
        return { content: [{ type: "text" as const, text: jobHeader(job, new Date()) }], details: { jobId: job.jobId, state: job.state }, isError: true };
      }
      const waited = seconds > 0 || until
        ? await input.host.wait({ taskId, jobId: job.jobId, seconds, ...(until ? { until } : {}), ...(signal ? { signal } : {}) })
        : null;
      const read = await input.host.read({ taskId, jobId: job.jobId });
      const ended = isWorkFoldJobTerminalState(read.job.state);
      // Still running after the default wait is the ordinary case, not news.
      const waitNote = waited?.outcome === "timed_out" && !until ? null : waited;
      const notes = [
        `Command: ${job.command.split("\n", 1)[0]}${job.command.includes("\n") ? " …" : ""}`,
        `Folder: ${job.cwd}`,
        ...describeWait(waitNote, seconds),
        ...(ended ? [] : [job.service
          ? `This service keeps running independently of request completion. Read it with job_output (job "${job.jobId}") and stop it with job_stop when no longer needed. Its exit does not start a follow-up turn.`
          : `It keeps running. Read it with job_output (job "${job.jobId}"; wait or until to wait for it) and stop it with job_stop. If your turn ends first, work-fold brings its result back to this Chat when it ends.`]),
      ];
      const endedBadly = ended && (read.job.state !== "exited" || read.job.exitCode !== 0);
      return {
        content: [{ type: "text" as const, text: describeJobForModel(read.job, read.output, new Date(), notes) }],
        details: { jobId: job.jobId, state: read.job.state },
        ...(endedBadly ? { isError: true } : {}),
      };
    },
  };

  const output: ToolDefinition<any> = {
    name: "job_output",
    label: "Background job output",
    description: `Read a background job's state and output. Without job, lists this Chat's jobs and any running elsewhere in this folder. By default returns the end of the output (at most ${workFoldBackgroundJobLimits.readMaxLines} lines or ${workFoldBackgroundJobLimits.readMaxBytes / 1024} KB); offset and limit page through it from a line, and nextOffset reads only what is new. wait returns early when the job ends; until returns as soon as a line matches.`,
    promptSnippet: "Read a background job's status and output",
    parameters: {
      type: "object",
      properties: {
        job: { type: "string", description: "The job id from job_start. Leave it out to list jobs." },
        offset: { type: "integer", minimum: 1, description: "First line to read, counted from the job's first line of output." },
        limit: { type: "integer", minimum: 1, description: `Lines to read from offset (at most ${workFoldBackgroundJobLimits.readMaxBytes / 1024} KB are returned per call).` },
        wait: { type: "number", minimum: 0, description: "Seconds to wait for the job to end (or for until to match) before reading. Defaults to 0." },
        until: { type: "string", description: "A pattern (JavaScript regular expression) to wait for in the output, tested from offset when given." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, signal) {
      const taskId = requireTask(input);
      const value = params as { job?: unknown; offset?: unknown; limit?: unknown; wait?: unknown; until?: unknown };
      const now = new Date();
      if (value.job === undefined || value.job === null || value.job === "") {
        const { here, elsewhere } = input.host.list({ taskId });
        const lines = here.length
          ? ["Background jobs in this Chat:", ...here.map((job) => `- ${job.jobId} "${job.name}" — ${describeJobState(job, now)}${job.serving && !isWorkFoldJobTerminalState(job.state) ? `; serving ${job.serving}` : ""}`)]
          : ["No background jobs in this Chat."];
        if (elsewhere.length) lines.push("Running elsewhere in this folder:", ...elsewhere.map((job) => `- ${job.jobId} "${job.name}" — ${describeJobState(job, now)}`));
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { jobs: here.length } };
      }
      if (typeof value.job !== "string") throw new Error("job must be a job id.");
      const offset = optionalLine(value.offset, "offset");
      const limit = optionalLine(value.limit, "limit");
      const seconds = optionalSeconds(value.wait, "wait") ?? 0;
      const until = parseUntilPattern(value.until);
      const waited = seconds > 0 || until
        ? await input.host.wait({ taskId, jobId: value.job, seconds, ...(until ? { until } : {}), ...(offset ? { fromLine: offset } : {}), ...(signal ? { signal } : {}) })
        : null;
      const read = await input.host.read({ taskId, jobId: value.job, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) });
      return {
        content: [{ type: "text" as const, text: describeJobForModel(read.job, read.output, new Date(), describeWait(waited, seconds)) }],
        details: { jobId: read.job.jobId, state: read.job.state },
      };
    },
  };

  const stop: ToolDefinition<any> = {
    name: "job_stop",
    label: "Stop background job",
    description: `Stop a background job: SIGTERM to its whole process group, then SIGKILL after ${workFoldBackgroundJobLimits.stopGraceMs / 1000} seconds. Returns its final state and the end of its output.`,
    promptSnippet: "Stop a background job",
    parameters: {
      type: "object",
      properties: { job: { type: "string", minLength: 1, description: "The job id from job_start." } },
      required: ["job"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const taskId = requireTask(input);
      const value = params as { job?: unknown };
      if (typeof value.job !== "string" || !value.job) throw new Error("job_stop needs a job id.");
      await input.host.stop({ taskId, jobId: value.job });
      const read = await input.host.read({ taskId, jobId: value.job });
      return {
        content: [{ type: "text" as const, text: describeJobForModel(read.job, read.output, new Date()) }],
        details: { jobId: read.job.jobId, state: read.job.state },
      };
    },
  };

  const inputTool: ToolDefinition<any> = {
    name: "job_input", label: "Terminal input",
    description: "Send text or control characters to a running interactive terminal job. Include a newline to submit a line; \\u0003 sends Ctrl-C. Input may have effects: inspect output before retrying an uncertain call.",
    parameters: { type: "object", properties: { job: { type: "string" }, text: { type: "string", description: "Exact characters to send, at most 64 KiB." }, eof: { type: "boolean", description: "Close the input stream after this text." } }, required: ["job", "text"], additionalProperties: false } as any,
    async execute(_id, params) {
      if (!input.host.input) throw new Error("This host does not support terminal input.");
      const value = params as { job: string; text: string; eof?: boolean };
      const job = await input.host.input({ taskId: requireTask(input), jobId: value.job, text: value.text, ...(value.eof ? { eof: true } : {}) });
      return { content: [{ type: "text", text: `Input sent to ${job.jobId}. Read its response with job_output.` }], details: { jobId: job.jobId } };
    },
  };
  return [start, output, stop, inputTool];
}
