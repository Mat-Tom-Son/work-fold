/**
 * Runs background jobs (docs/background-jobs.md, F31–F33).
 *
 * One service per local API. It owns the processes; the host owns what a job
 * means for requests, the kernel, History, and the Chat through the ports it
 * passes in. A start journals `accepted`, lets the host attach the job to its
 * request, then spawns the command in its own process group. An end journals
 * the terminal state at once, asks the host for History coverage, journals
 * that, and only then tells the host the job settled — so a waiter, a
 * follow-up turn, and a deletion all see one finished job.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { delimiter } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { getShellConfig } from "@earendil-works/pi-coding-agent";

import { workFoldBackgroundJobLimits } from "../../shared/work-fold-limits.js";
import {
  assertJobCommand,
  boundJobError,
  isWorkFoldJobTerminalState,
  jobDisplayName,
  WorkFoldJobLimitError,
  WorkFoldJobNotFoundError,
  workFoldJobRecordSchema,
  workFoldJobRunningLimitMessage,
  type WorkFoldJobHistory,
  type WorkFoldJobRecord,
  type WorkFoldJobStopCause,
  type WorkFoldJobSurface,
} from "./job-records.js";
import {
  JobOutputWriter,
  readJobOutputPage,
  readJobOutputTail,
  sanitizeJobOutput,
  scanJobOutputLines,
  type JobOutputRead,
} from "./job-output.js";
import type { WorkFoldJobStore } from "./job-store.js";

const execFileAsync = promisify(execFile);

/** Pi's shell settings for the session that starts a job, so it runs the way `bash` would. */
export interface WorkFoldJobShell {
  shellPath?: string;
  commandPrefix?: string;
  /** Pi's tool directory, put first on PATH like Pi's own shell environment. */
  binDir?: string;
}

export interface WorkFoldJobStartInput {
  owner: { workFolderId?: string; workFolderName?: string; conversationId: string };
  taskId: string;
  requestId: string;
  command: string;
  name?: string;
  /** Absolute and existing; resolved by the caller. */
  cwd: string;
  timeoutSeconds?: number;
  surface: WorkFoldJobSurface;
  shell?: WorkFoldJobShell;
}

export interface WorkFoldJobServicePorts {
  /** After `accepted` is journaled and before spawn; throwing records the job `failed`. */
  beforeSpawn?(job: WorkFoldJobRecord): Promise<void>;
  /**
   * Checked once the process is running: a Stop that landed while the job was
   * starting found nothing live to stop, so the job stops itself here.
   */
  stopRequested?(job: WorkFoldJobRecord): boolean;
  /** After the process ended and its terminal state is journaled. */
  captureHistory(job: WorkFoldJobRecord): Promise<WorkFoldJobHistory>;
  /** The job is settled: History coverage and its end are on record. */
  afterSettle(job: WorkFoldJobRecord): Promise<void> | void;
}

export interface WorkFoldJobServiceOptions {
  store: WorkFoldJobStore;
  ports: WorkFoldJobServicePorts;
  now?: () => Date;
  runningLimit?: number;
  stopGraceMs?: number;
  segmentBytes?: number;
}

export type WorkFoldJobWaitOutcome =
  | { outcome: "ended"; job: WorkFoldJobRecord }
  | { outcome: "matched"; job: WorkFoldJobRecord; line: number; text: string }
  | { outcome: "timed_out"; job: WorkFoldJobRecord }
  | { outcome: "aborted"; job: WorkFoldJobRecord };

interface LiveJob {
  jobId: string;
  child: ChildProcess | null;
  writer: JobOutputWriter;
  stopCause: WorkFoldJobStopCause | null;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  skipHistory: boolean;
  /** The process has exited; the job stays here until History and the host have recorded it. */
  exited: boolean;
  events: EventEmitter;
  settled: Promise<WorkFoldJobRecord>;
  resolveSettled: (record: WorkFoldJobRecord) => void;
}

export class WorkFoldJobService {
  readonly store: WorkFoldJobStore;
  readonly #ports: WorkFoldJobServicePorts;
  readonly #now: () => Date;
  readonly #runningLimit: number;
  readonly #stopGraceMs: number;
  readonly #segmentBytes: number | undefined;
  readonly #live = new Map<string, LiveJob>();
  #starting = 0;
  #closing = false;
  readonly #exitHandler = () => {
    // The app is exiting without close(): no process group outlives it.
    for (const live of this.#live.values()) if (!live.exited) killGroup(live.child?.pid, "SIGKILL");
  };

  constructor(options: WorkFoldJobServiceOptions) {
    this.store = options.store;
    this.#ports = options.ports;
    this.#now = options.now ?? (() => new Date());
    this.#runningLimit = options.runningLimit ?? workFoldBackgroundJobLimits.runningMachineWide;
    this.#stopGraceMs = options.stopGraceMs ?? workFoldBackgroundJobLimits.stopGraceMs;
    this.#segmentBytes = options.segmentBytes;
    process.on("exit", this.#exitHandler);
  }

  /** Jobs whose process is live in this run, including ones still starting. */
  runningCount(): number {
    return [...this.#live.values()].filter((live) => !live.exited).length + this.#starting;
  }

  /** Started in this run and not yet settled (its process may already have exited). */
  isLive(jobId: string): boolean {
    return this.#live.has(jobId);
  }

  get(jobId: string): WorkFoldJobRecord | null {
    const record = this.store.get(jobId);
    if (!record) return null;
    const live = this.#live.get(jobId);
    return live && !isWorkFoldJobTerminalState(record.state) ? { ...record, output: live.writer.counters } : record;
  }

  require(jobId: string): WorkFoldJobRecord {
    const record = this.get(jobId);
    if (!record) throw new WorkFoldJobNotFoundError();
    return record;
  }

  list(filter: Parameters<WorkFoldJobStore["list"]>[0] = {}): WorkFoldJobRecord[] {
    return this.store.list(filter).map((record) => this.get(record.jobId) ?? record);
  }

  /**
   * Journals the job, lets the host attach it, spawns it, and returns the
   * record once it is running (or recorded as failed to start).
   */
  async start(input: WorkFoldJobStartInput): Promise<WorkFoldJobRecord> {
    if (this.#closing) throw new Error("work-fold is closing; no new background job can start.");
    const command = assertJobCommand(input.command);
    if (this.runningCount() >= this.#runningLimit) throw new WorkFoldJobLimitError(workFoldJobRunningLimitMessage(this.#runningLimit));
    const timeoutSeconds = input.timeoutSeconds;
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)) {
      throw new Error("A background job's timeout must be a positive number of seconds.");
    }
    const folder = await stat(input.cwd).catch(() => null);
    if (!folder?.isDirectory()) throw new Error(`The folder to run in does not exist: ${input.cwd}`);
    this.#starting += 1;
    let accepted: WorkFoldJobRecord;
    try {
      const at = this.#now().toISOString();
      const jobId = this.store.newJobId();
      const draft: WorkFoldJobRecord = {
        schema: workFoldJobRecordSchema,
        jobId,
        conversationId: input.owner.conversationId,
        taskId: input.taskId,
        requestId: input.requestId,
        name: jobDisplayName(input.name, command),
        command,
        cwd: input.cwd,
        surface: input.surface,
        state: "accepted",
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        endedAt: null,
        settledAt: null,
        pid: null,
        processStartedAt: null,
        timeoutSeconds: timeoutSeconds ?? null,
        exitCode: null,
        signal: null,
        stoppedBy: null,
        error: null,
        output: { bytes: 0, lines: 0, droppedBytes: 0, droppedLines: 0 },
        history: null,
        delivery: null,
      };
      if (input.owner.workFolderId !== undefined) draft.workFolderId = input.owner.workFolderId;
      if (input.owner.workFolderName !== undefined) draft.workFolderName = input.owner.workFolderName;
      accepted = await this.store.create(draft);
    } catch (error) {
      this.#starting -= 1;
      throw error;
    }
    try {
      await this.#ports.beforeSpawn?.(accepted);
      await mkdir(this.store.outputDirectory(accepted.jobId), { recursive: true, mode: 0o700 });
      return await this.#spawn(accepted, input.shell ?? {});
    } catch (error) {
      const failed = await this.store.update(accepted.jobId, (record) => ({
        ...record,
        state: "failed",
        endedAt: this.#now().toISOString(),
        settledAt: this.#now().toISOString(),
        error: boundJobError(errorMessage(error)),
        history: { status: "not_applicable", reason: "nothing ran." },
      }));
      await Promise.resolve(this.#ports.afterSettle(failed)).catch(() => undefined);
      return failed;
    } finally {
      this.#starting -= 1;
    }
  }

  async #spawn(accepted: WorkFoldJobRecord, shell: WorkFoldJobShell): Promise<WorkFoldJobRecord> {
    const config = getShellConfig(shell.shellPath);
    const resolvedCommand = shell.commandPrefix ? `${shell.commandPrefix}\n${accepted.command}` : accepted.command;
    const fromStdin = (config as { commandTransport?: string }).commandTransport === "stdin";
    const writer = new JobOutputWriter(this.store.outputDirectory(accepted.jobId), this.#segmentBytes ? { segmentBytes: this.#segmentBytes } : {});
    let resolveSettled!: (record: WorkFoldJobRecord) => void;
    const settled = new Promise<WorkFoldJobRecord>((resolve) => { resolveSettled = resolve; });
    const live: LiveJob = {
      jobId: accepted.jobId,
      child: null,
      writer,
      stopCause: null,
      timeoutTimer: null,
      killTimer: null,
      skipHistory: false,
      exited: false,
      events: new EventEmitter(),
      settled,
      resolveSettled,
    };
    live.events.setMaxListeners(0);
    let child: ChildProcess;
    try {
      child = spawn(config.shell, fromStdin ? config.args : [...config.args, resolvedCommand], {
        cwd: accepted.cwd,
        detached: process.platform !== "win32",
        env: jobEnvironment(accepted.jobId, shell.binDir),
        stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      writer.close();
      throw error;
    }
    live.child = child;
    if (fromStdin) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(resolvedCommand);
    }
    const spawnError = await new Promise<Error | null>((resolve) => {
      if (child.pid) {
        resolve(null);
        return;
      }
      child.once("error", (error) => resolve(error));
      child.once("spawn", () => resolve(null));
    });
    if (spawnError || !child.pid) {
      writer.close();
      throw spawnError ?? new Error("The command could not start.");
    }
    this.#live.set(accepted.jobId, live);
    const onData = (chunk: Buffer) => {
      try {
        writer.write(chunk);
      } catch {
        // A full disk stops keeping output; the job keeps running.
      }
      live.events.emit("data", chunk);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.once("error", () => undefined);
    const startedAt = this.#now().toISOString();
    const processStartedAt = await processStartTime(child.pid);
    const running = await this.store.update(accepted.jobId, (record) => isWorkFoldJobTerminalState(record.state) ? record : {
      ...record,
      state: "running",
      startedAt,
      pid: child.pid ?? null,
      processStartedAt,
    });
    if (accepted.timeoutSeconds !== null) {
      live.timeoutTimer = setTimeout(() => { void this.stop(accepted.jobId, "timeout"); }, accepted.timeoutSeconds * 1000);
      live.timeoutTimer.unref();
    }
    void exited.then((exit) => this.#finish(live, exit));
    if (this.#ports.stopRequested?.(running)) void this.stop(accepted.jobId, "request");
    return { ...running, output: writer.counters };
  }

  async #finish(live: LiveJob, exit: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    const child = live.child!;
    live.exited = true;
    // Output still in the pipes arrives before stdio closes. A descendant that
    // kept a pipe open must not hold the job open, so wait only briefly.
    await Promise.race([
      Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]),
      new Promise((resolve) => setTimeout(resolve, 500).unref()),
    ]);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    if (live.killTimer) clearTimeout(live.killTimer);
    live.writer.close();
    const counters = live.writer.counters;
    const endedAt = this.#now().toISOString();
    const signalNumber = exit.signal ? osConstants.signals[exit.signal] ?? 0 : 0;
    const exitCode = exit.code ?? (exit.signal ? 128 + signalNumber : null);
    const cause = live.stopCause;
    const state = cause === "timeout" ? "timed_out" : cause === "quit" ? "interrupted" : cause ? "stopped" : "exited";
    const isAgentScope = (record: WorkFoldJobRecord) => record.workFolderId === undefined;
    let ended = await this.store.update(live.jobId, (record) => ({
      ...record,
      state,
      endedAt,
      exitCode,
      signal: exit.signal ?? null,
      stoppedBy: cause,
      error: cause === "quit" ? "work-fold closed before this job finished." : record.error,
      output: counters,
      history: live.skipHistory
        ? { status: "unavailable", reason: "work-fold was closing." }
        : isAgentScope(record)
          ? { status: "not_applicable", reason: "the work-fold agent's working folder has no History; take a checkpoint with history save in a work-folder this job changed." }
          : { status: "pending" },
    })).catch(() => this.store.get(live.jobId)!);
    if (ended.history?.status === "pending") {
      let history: WorkFoldJobHistory;
      try {
        history = await this.#ports.captureHistory(ended);
      } catch (error) {
        history = { status: "unavailable", reason: boundJobError(errorMessage(error)) };
      }
      ended = await this.store.update(live.jobId, (record) => ({ ...record, history })).catch(() => ended);
    }
    ended = await this.store.update(live.jobId, (record) => ({ ...record, settledAt: this.#now().toISOString() })).catch(() => ended);
    try {
      await this.#ports.afterSettle(ended);
    } catch (error) {
      console.error(`A background job's end could not be recorded everywhere: ${errorMessage(error)}`);
    }
    this.#live.delete(live.jobId);
    live.resolveSettled(ended);
    live.events.emit("settled", ended);
  }

  /**
   * SIGTERM to the job's process group, then SIGKILL after the grace period.
   * Resolves once the job has settled. Stopping an ended job returns it as is.
   */
  async stop(jobId: string, cause: WorkFoldJobStopCause, options: { skipHistory?: boolean } = {}): Promise<WorkFoldJobRecord> {
    const live = this.#live.get(jobId);
    if (!live) {
      const record = this.require(jobId);
      if (!isWorkFoldJobTerminalState(record.state) && !this.#starting) {
        // A record with no live process in this run is left from an earlier run.
        return await this.store.update(jobId, (current) => isWorkFoldJobTerminalState(current.state) ? current : {
          ...current, state: "interrupted", endedAt: this.#now().toISOString(), settledAt: this.#now().toISOString(),
          error: "work-fold closed before this job finished.",
        });
      }
      return record;
    }
    if (live.exited) return await live.settled;
    if (live.stopCause === null) {
      live.stopCause = cause;
      if (options.skipHistory) live.skipHistory = true;
      killGroup(live.child?.pid, "SIGTERM");
      live.killTimer = setTimeout(() => killGroup(live.child?.pid, "SIGKILL"), this.#stopGraceMs);
      live.killTimer.unref();
    } else if (options.skipHistory) {
      live.skipHistory = true;
    }
    return await live.settled;
  }

  /** Stops several jobs at once; used by a request Stop. */
  async stopMany(jobIds: readonly string[], cause: WorkFoldJobStopCause): Promise<WorkFoldJobRecord[]> {
    return await Promise.all(jobIds.filter((jobId) => this.#live.has(jobId)).map((jobId) => this.stop(jobId, cause)));
  }

  /**
   * Waits for the job to end, for a line matching `until`, for `seconds`, or
   * for `signal`, whichever comes first. A pattern is tested against each
   * line of output from `fromLine` (default: the first kept line), including
   * a final line still being written.
   */
  async wait(jobId: string, options: { seconds: number; until?: RegExp; fromLine?: number; signal?: AbortSignal }): Promise<WorkFoldJobWaitOutcome> {
    const current = this.require(jobId);
    const live = this.#live.get(jobId);
    const until = options.until;
    const matchIn = (line: string) => {
      if (!until) return false;
      until.lastIndex = 0;
      return until.test(sanitizeJobOutput(line));
    };
    if (!live) {
      if (until) {
        const found = await this.#scanForMatch(jobId, current, matchIn, options.fromLine);
        if (found) return { outcome: "matched", job: this.require(jobId), ...found };
      }
      return { outcome: "ended", job: this.require(jobId) };
    }
    return await new Promise<WorkFoldJobWaitOutcome>((resolve) => {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let buffered: Buffer[] | null = until ? [] : null;
      let lineNumber = 0;
      let done = false;
      const finish = (outcome: WorkFoldJobWaitOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        live.events.off("data", onData);
        live.events.off("settled", onSettled);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const consume = (text: string) => {
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          const line = pending.slice(0, newline);
          if (lineNumber >= (options.fromLine ?? 0) && matchIn(line)) {
            finish({ outcome: "matched", job: this.require(jobId), line: lineNumber, text: sanitizeJobOutput(line) });
            return;
          }
          lineNumber += 1;
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending && lineNumber >= (options.fromLine ?? 0) && matchIn(pending)) {
          finish({ outcome: "matched", job: this.require(jobId), line: lineNumber, text: sanitizeJobOutput(pending) });
        }
      };
      const onData = (chunk: Buffer) => {
        if (!until) return;
        if (buffered) buffered.push(chunk);
        else consume(decoder.write(chunk));
      };
      const onSettled = (record: WorkFoldJobRecord) => {
        if (until && pending && !done) consume(decoder.end());
        finish({ outcome: "ended", job: record });
      };
      const onAbort = () => finish({ outcome: "aborted", job: this.require(jobId) });
      const timer = setTimeout(() => finish({ outcome: "timed_out", job: this.require(jobId) }), Math.max(0, options.seconds) * 1000);
      live.events.on("data", onData);
      live.events.on("settled", onSettled);
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (!until) return;
      // Everything written before this wait began is on disk; scan it, then
      // replay what arrived meanwhile, so no line is skipped or read twice.
      const keptBytes = live.writer.keptBytes;
      const counters = live.writer.counters;
      lineNumber = counters.droppedLines + 1;
      let scanned = "";
      void scanJobOutputLines(this.store.outputDirectory(jobId), { keptBytes, firstLine: lineNumber }, (line, number, terminated) => {
        if (done) return false;
        if (!terminated) {
          scanned = line;
          return true;
        }
        if (number >= (options.fromLine ?? 0) && matchIn(line)) {
          finish({ outcome: "matched", job: this.require(jobId), line: number, text: sanitizeJobOutput(line) });
          return false;
        }
        lineNumber = number + 1;
        return true;
      }).catch(() => undefined).then(() => {
        if (done) return;
        const queued = buffered ?? [];
        buffered = null;
        consume(scanned);
        for (const chunk of queued) {
          if (done) return;
          consume(decoder.write(chunk));
        }
      });
    });
  }

  async #scanForMatch(
    jobId: string,
    record: WorkFoldJobRecord,
    matchIn: (line: string) => boolean,
    fromLine?: number,
  ): Promise<{ line: number; text: string } | null> {
    let found: { line: number; text: string } | null = null;
    await scanJobOutputLines(this.store.outputDirectory(jobId), { firstLine: record.output.droppedLines + 1 }, (line, number) => {
      if (number >= (fromLine ?? 0) && matchIn(line)) {
        found = { line: number, text: sanitizeJobOutput(line) };
        return false;
      }
      return true;
    }).catch(() => undefined);
    return found;
  }

  /** The end of the output, or a page from `offset`, within Pi's `bash` bounds. */
  async read(jobId: string, options: { offset?: number; limit?: number } = {}): Promise<{ job: WorkFoldJobRecord; output: JobOutputRead }> {
    const job = this.require(jobId);
    const live = this.#live.get(jobId);
    const keptBytes = live?.writer.keptBytes;
    const directory = this.store.outputDirectory(jobId);
    const output = options.offset === undefined
      ? await readJobOutputTail(directory, job.output, { ...(keptBytes !== undefined ? { keptBytes } : {}) }).catch(() => emptyRead(job))
      : await readJobOutputPage(directory, job.output, {
        offset: options.offset,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(keptBytes !== undefined ? { keptBytes } : {}),
      }).catch(() => emptyRead(job));
    return { job, output };
  }

  /** Records the job's one delivery; a second delivery is ignored. */
  async markDelivered(jobId: string, by: "read" | "turn_context" | "follow_up", taskId: string | null): Promise<WorkFoldJobRecord | null> {
    const record = this.store.get(jobId);
    if (!record || record.delivery || !isWorkFoldJobTerminalState(record.state)) return record;
    return await this.store.update(jobId, (current) => current.delivery ? current : {
      ...current,
      delivery: { at: this.#now().toISOString(), by, taskId },
    });
  }

  /**
   * Quitting: every running job is stopped and recorded `interrupted`, without
   * a History capture, within the grace period plus a moment.
   */
  async close(): Promise<void> {
    this.#closing = true;
    const pending = [...this.#live.keys()].map((jobId) => this.stop(jobId, "quit", { skipHistory: true }));
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => setTimeout(resolve, this.#stopGraceMs + 2_000).unref()),
    ]);
    for (const live of this.#live.values()) if (!live.exited) killGroup(live.child?.pid, "SIGKILL");
    await this.store.flush();
    process.off("exit", this.#exitHandler);
  }
}

/**
 * Startup: a job a previous run recorded as running is killed only when its
 * process group leader is provably the same process (same id, same start
 * time). A reused process id is left alone.
 */
export async function reapOrphanedJobProcesses(records: readonly WorkFoldJobRecord[]): Promise<number> {
  if (process.platform === "win32") return 0;
  let reaped = 0;
  for (const record of records) {
    if (!record.pid || !record.processStartedAt) continue;
    const observed = await processIdentity(record.pid);
    if (!observed || observed.pgid !== record.pid || observed.startedAt !== record.processStartedAt) continue;
    killGroup(record.pid, "SIGKILL");
    reaped += 1;
  }
  return reaped;
}

function jobEnvironment(jobId: string, binDir: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  if (binDir) {
    const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
    if (!entries.includes(binDir)) env[pathKey] = [binDir, ...entries].join(delimiter);
  }
  // Pi's own session variables describe a turn; a job outlives its turn.
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  env.WORKFOLD_JOB_ID = jobId;
  return env;
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn(`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`, ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore", detached: true, windowsHide: true,
      });
      killer.once("error", () => undefined);
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function processStartTime(pid: number | undefined): Promise<string | null> {
  if (!pid || process.platform === "win32") return null;
  return (await processIdentity(pid))?.startedAt ?? null;
}

async function processIdentity(pid: number): Promise<{ pgid: number; startedAt: string } | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)], { timeout: 5_000 });
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout.trim().split("\n")[0] ?? "");
    if (!match) return null;
    return { pgid: Number(match[1]), startedAt: match[2]!.replace(/\s+/g, " ") };
  } catch {
    return null;
  }
}

function streamClosed(stream: NodeJS.ReadableStream | null | undefined): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    const readable = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
    if (readable.readableEnded || readable.destroyed) {
      resolve();
      return;
    }
    stream.once("close", () => resolve());
    stream.once("end", () => resolve());
  });
}

function emptyRead(job: WorkFoldJobRecord): JobOutputRead {
  return {
    text: "", fromLine: 0, toLine: 0, totalLines: job.output.lines, totalBytes: job.output.bytes,
    droppedLines: job.output.droppedLines, truncated: job.output.lines > 0, nextOffset: job.output.lines + 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
