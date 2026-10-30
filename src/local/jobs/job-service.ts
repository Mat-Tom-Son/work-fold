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
import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
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
  localServerAddress,
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
  interactive?: boolean;
  service?: boolean;
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
  terminalGroupId?: number;
  jobId: string;
  child: ChildProcess | null;
  writer: JobOutputWriter;
  stopCause: WorkFoldJobStopCause | null;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  skipHistory: boolean;
  /** Set when recording the start failed after the process began; #finish records the job as failed. */
  startFailure: string | null;
  /** The process group has drained; the job stays here through History and host settlement. */
  exited: boolean;
  events: EventEmitter;
  settled: Promise<WorkFoldJobRecord>;
  resolveSettled: (record: WorkFoldJobRecord) => void;
  /** The address the job announced it serves, and the end of the output a split address may continue from. */
  serving: string | null;
  servingTail: string;
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
    for (const live of this.#live.values()) if (!live.exited) { if (live.terminalGroupId) killGroup(live.terminalGroupId, "SIGKILL"); killGroup(live.child?.pid, "SIGKILL"); }
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
    return live && !isWorkFoldJobTerminalState(record.state)
      ? { ...record, output: live.writer.counters, ...(live.serving ? { serving: live.serving } : {}) }
      : record;
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
    if (input.interactive && process.platform === "win32") throw new Error("Interactive terminal jobs are available on macOS and POSIX hosts.");
    if (this.runningCount() >= this.#runningLimit) throw new WorkFoldJobLimitError(workFoldJobRunningLimitMessage(this.#runningLimit));
    const timeoutSeconds = input.timeoutSeconds;
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)) {
      throw new Error("A background job's timeout must be a positive number of seconds.");
    }
    // Reserve before the first await: starts from different Chats share this
    // service and must not both pass the last available slot.
    this.#starting += 1;
    let reserved = true;
    const releaseStarting = () => {
      if (!reserved) return;
      reserved = false;
      this.#starting -= 1;
    };
    let accepted: WorkFoldJobRecord;
    try {
      const folder = await stat(input.cwd).catch(() => null);
      if (!folder?.isDirectory()) throw new Error(`The folder to run in does not exist: ${input.cwd}`);
      const at = this.#now().toISOString();
      const jobId = this.store.newJobId();
      const draft: WorkFoldJobRecord = {
        ...(input.interactive ? { interactive: true } : {}),
        ...(input.service ? { service: true } : {}),
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
      releaseStarting();
      throw error;
    }
    try {
      await this.#ports.beforeSpawn?.(accepted);
      await mkdir(this.store.outputDirectory(accepted.jobId), { recursive: true, mode: 0o700 });
      return await this.#spawn(accepted, input.shell ?? {}, releaseStarting);
    } catch (error) {
      const live = this.#live.get(accepted.jobId);
      if (live) {
        // The process started before the failure, so #finish owns its
        // settlement: stop it and wait, rather than leave it running with its
        // slot and kernel task held.
        live.startFailure ??= boundJobError(errorMessage(error));
        this.#signalStop(live);
        return await live.settled;
      }
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
      releaseStarting();
    }
  }

  async #spawn(accepted: WorkFoldJobRecord, shell: WorkFoldJobShell, releaseStarting: () => void): Promise<WorkFoldJobRecord> {
    const config = getShellConfig(shell.shellPath);
    const resolvedCommand = shell.commandPrefix ? `${shell.commandPrefix}\n${accepted.command}` : accepted.command;
    const fromStdin = (config as { commandTransport?: string }).commandTransport === "stdin";
    if (accepted.interactive && fromStdin) throw new Error("Interactive jobs require a shell that accepts commands as arguments.");
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
      startFailure: null,
      exited: false,
      events: new EventEmitter(),
      settled,
      resolveSettled,
      serving: null,
      servingTail: "",
    };
    live.events.setMaxListeners(0);
    let child: ChildProcess;
    try {
      const pidFile = join(this.store.outputDirectory(accepted.jobId), "terminal.pid");
      const terminalScript = join(this.store.outputDirectory(accepted.jobId), "terminal.exp");
      if (accepted.interactive) await writeFile(terminalScript, terminalRelayScript, { mode: 0o600 });
      child = spawn(accepted.interactive ? "/usr/bin/expect" : config.shell, accepted.interactive ? [terminalScript, pidFile, config.shell, ...config.args, resolvedCommand] : fromStdin ? config.args : [...config.args, resolvedCommand], {
        cwd: accepted.cwd,
        detached: process.platform !== "win32",
        env: jobEnvironment(accepted.jobId, shell.binDir),
        stdio: [accepted.interactive || fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      writer.close();
      throw error;
    }
    live.child = child;
    child.stdin?.on("error", () => undefined);
    if (fromStdin && !accepted.interactive) {
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
    // Transfer the reserved slot to the live group without an asynchronous
    // gap or counting the same job as both starting and live.
    releaseStarting();
    const onData = (chunk: Buffer) => {
      try {
        writer.write(chunk);
      } catch {
        // A full disk stops keeping output; the job keeps running.
      }
      // A server says where it listens early on; look until it has.
      if (!live.serving) {
        const text = live.servingTail + chunk.toString("utf8");
        live.serving = localServerAddress(text);
        live.servingTail = text.slice(-256);
      }
      live.events.emit("data", chunk);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.once("error", () => undefined);
    let terminal: Partial<WorkFoldJobRecord> = {};
    if (accepted.interactive) {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const pid = Number((await readFile(join(this.store.outputDirectory(accepted.jobId), "terminal.pid"), "utf8").catch(() => "")).trim());
        if (Number.isInteger(pid) && pid > 1) {
          // Expect's forkpty child leads its own session/process group. Keep
          // it stoppable even if ps cannot observe a very short-lived shell.
          live.terminalGroupId = pid;
          terminal = { terminalPid: pid, terminalGroupId: pid };
          const identity = await processStartTime(pid);
          const group = Number((await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)]).catch(() => ({ stdout: "" }))).stdout.trim());
          if (identity && group > 1 && group !== process.pid) {
            live.terminalGroupId = group;
            terminal = { terminalPid: pid, terminalGroupId: group, terminalProcessStartedAt: identity };
          }
          break;
        }
        if (child.exitCode !== null) break;
        await new Promise(done => setTimeout(done, 10));
      }
    }
    // Settlement is wired before the journal write below, which can fail: once
    // the process is live, its exit always releases the slot and finishes the
    // kernel task. A terminal record keeps the running write from undoing it.
    void exited.then((exit) => this.#finish(live, exit));
    const startedAt = this.#now().toISOString();
    const processStartedAt = await processStartTime(child.pid);
    const running = await this.store.update(accepted.jobId, (record) => isWorkFoldJobTerminalState(record.state) ? record : {
      ...record,
      state: "running",
      startedAt,
      pid: child.pid ?? null,
      processStartedAt,
      ...terminal,
    });
    if (accepted.timeoutSeconds !== null && !live.exited) {
      live.timeoutTimer = setTimeout(() => { void this.stop(accepted.jobId, "timeout"); }, accepted.timeoutSeconds * 1000);
      live.timeoutTimer.unref();
    }
    if (this.#ports.stopRequested?.(running)) void this.stop(accepted.jobId, "request");
    return { ...running, output: writer.counters };
  }

  async #finish(live: LiveJob, exit: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    const child = live.child!;
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    // A shell can exit successfully while its background children still
    // run. Keep the job live, its slot reserved, and History/deletion fenced
    // until the entire owned process group has stopped.
    if (process.platform !== "win32" && child.pid && (processGroupExists(child.pid) || (live.terminalGroupId && processGroupExists(live.terminalGroupId)))) {
      this.#signalStop(live);
      while (await processGroupRunning(child.pid) || (live.terminalGroupId && await processGroupRunning(live.terminalGroupId))) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    live.exited = true;
    // A timeout armed while this settlement was starting must not fire later.
    if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
    // Output still in the pipes arrives before stdio closes. A descendant that
    // kept a pipe open must not hold the job open, so wait only briefly.
    await Promise.race([
      Promise.all([streamClosed(child.stdout), streamClosed(child.stderr)]),
      new Promise((resolve) => setTimeout(resolve, 500).unref()),
    ]);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (live.killTimer) clearTimeout(live.killTimer);
    live.writer.close();
    const counters = live.writer.counters;
    const endedAt = this.#now().toISOString();
    const signalNumber = exit.signal ? osConstants.signals[exit.signal] ?? 0 : 0;
    const exitCode = exit.code ?? (exit.signal ? 128 + signalNumber : null);
    const cause = live.stopCause;
    const state = live.startFailure ? "failed" : cause === "timeout" ? "timed_out" : cause === "quit" ? "interrupted" : cause ? "stopped" : "exited";
    const isAgentScope = (record: WorkFoldJobRecord) => record.workFolderId === undefined;
    let ended = await this.store.update(live.jobId, (record) => ({
      ...record,
      state,
      endedAt,
      exitCode,
      signal: exit.signal ?? null,
      stoppedBy: cause,
      error: live.startFailure ?? (cause === "quit" ? "work-fold closed before this job finished." : record.error),
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

  #signalStop(live: LiveJob): void {
    if (live.terminalGroupId) killGroup(live.terminalGroupId, "SIGTERM");
    killGroup(live.child?.pid, "SIGTERM");
    live.killTimer ??= setTimeout(() => { if (live.terminalGroupId) killGroup(live.terminalGroupId, "SIGKILL"); killGroup(live.child?.pid, "SIGKILL"); }, this.#stopGraceMs);
    live.killTimer.unref();
  }

  /** Exact input bytes, with no shell interpolation or implicit newline. */
  async input(jobId: string, text: string, eof = false): Promise<WorkFoldJobRecord> {
    const live = this.#live.get(jobId);
    const job = this.require(jobId);
    if (!job.interactive || !live?.child?.stdin || live.exited) throw new Error("Input requires a running interactive terminal job.");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Terminal input is limited to 64 KiB per call.");
    await new Promise<void>((done, reject) => live.child!.stdin!.write(text, error => error ? reject(error) : done()));
    if (eof) live.child.stdin.end();
    return job;
  }

  /** SIGTERM then SIGKILL to all owned groups; resolves only after settlement. */
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
      this.#signalStop(live);
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
      // Node fires a longer delay at once, so a very long wait is capped at the largest one it keeps.
      const timer = setTimeout(() => finish({ outcome: "timed_out", job: this.require(jobId) }), Math.min(2_147_483_647, Math.max(0, options.seconds) * 1000));
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
    for (const live of this.#live.values()) if (!live.exited) { if (live.terminalGroupId) killGroup(live.terminalGroupId, "SIGKILL"); killGroup(live.child?.pid, "SIGKILL"); }
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
    if (record.terminalPid && record.terminalGroupId && record.terminalProcessStartedAt) {
      const terminal = await processIdentity(record.terminalPid);
      if (terminal?.startedAt === record.terminalProcessStartedAt && terminal.pgid === record.terminalGroupId) killGroup(record.terminalGroupId, "SIGKILL");
    }
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

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Adopted zombies cannot write or receive signals; only live group members hold settlement. */
async function processGroupRunning(pgid: number): Promise<boolean> {
  if (!processGroupExists(pgid)) return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pgid=,stat="], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.split("\n").some((line) => {
      const match = /^\s*(\d+)\s+(\S+)/.exec(line);
      return match && Number(match[1]) === pgid && !match[2]!.startsWith("Z");
    });
  } catch {
    // A failed observation never establishes that a group is gone.
    return processGroupExists(pgid);
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

/** macOS ships Expect: it allocates the PTY even when Electron has no controlling terminal. */
const terminalRelayScript = `
log_user 0
set timeout -1
fconfigure stdin -blocking 0 -translation binary -encoding binary
fconfigure stdout -buffering none -translation binary -encoding binary
spawn -noecho {*}[lrange $argv 1 end]
fconfigure $spawn_id -blocking 0 -translation binary -encoding binary -buffering none
if {[catch {set pidfile [open [lindex $argv 0] w]; puts $pidfile [exp_pid]; close $pidfile}]} {
  catch {exec /bin/kill -KILL -- -[exp_pid]}
  exit 1
}
fileevent stdin readable {
  set bytes [read stdin 65536]
  if {[string length $bytes] > 0} { catch {puts -nonewline $spawn_id $bytes; flush $spawn_id} }
  if {[eof stdin]} { fileevent stdin readable {}; catch {puts -nonewline $spawn_id "\\004"; flush $spawn_id} }
}
fileevent $spawn_id readable {
  if {[catch {set bytes [read $spawn_id 65536]}]} { set ended 1 } else {
    if {[string length $bytes] > 0} { puts -nonewline stdout $bytes }
    if {[eof $spawn_id]} { set ended 1 }
  }
}
vwait ended
set status [wait]
exit [lindex $status 3]
`;
