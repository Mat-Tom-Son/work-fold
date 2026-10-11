import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AutomationCatchUpReason } from "../../shared/automation-presentation.js";
import { listWorkFolders, resolveWorkFolderPath } from "../work-folder.js";
import { resolveWorkFoldCheckTargets } from "../checks/target-resolver.js";
import { workFoldAutomationBounds, type WorkFoldAutomationFilesChangedTrigger } from "./automation-declarations.js";

export type { AutomationCatchUpReason as WorkFoldAutomationCatchUpReason } from "../../shared/automation-presentation.js";

export interface WorkFoldAutomationFileSnapshot { digest: string; entries: Record<string, string>; }
export type WorkFoldAutomationFileObserver = (trigger: WorkFoldAutomationFilesChangedTrigger) => Promise<WorkFoldAutomationFileSnapshot>;

/**
 * The observer's scan bounds. Metadata only, polled every few seconds:
 * generous counts, no byte ceiling. A saved folder snapshot never holds more
 * files than one scan can see.
 */
export const workFoldAutomationFileObserverBounds = Object.freeze({
  maxFiles: 50_000,
  maxVisitedEntries: 200_000,
  maxDepth: 256,
});

/** Metadata only: no file bytes become conversation or model context. A
 * bounded ordinary-folder scan works on synchronized drives as well as local
 * disks without relying on lossy OS watcher events. */
export const observeWorkFoldAutomationFiles: WorkFoldAutomationFileObserver = async (trigger) => {
  const workFolders = await listWorkFolders();
  const workFolder = workFolders.find((item) => item.id === trigger.workFolder);
  if (!workFolder) throw new Error("The watched work-folder is no longer registered.");
  const watched = resolveWorkFolderPath(workFolder.workFolderRoot, trigger.watch.path);
  for (const child of workFolders) {
    if (child.id === workFolder.id) continue;
    const contains = (parent: string, childPath: string) => {
      const path = relative(resolve(parent), resolve(childPath));
      return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    };
    if (!contains(workFolder.workFolderRoot, child.workFolderRoot)) continue;
    if (contains(watched, child.workFolderRoot) || contains(child.workFolderRoot, watched)) throw new Error("A watched folder cannot overlap another registered work-folder.");
  }
  const folderBefore = await lstat(watched);
  if (!folderBefore.isDirectory() || folderBefore.isSymbolicLink()) throw new Error("The watched folder must be an ordinary directory.");
  const resolution = await resolveWorkFoldCheckTargets(workFolder.workFolderRoot, [{ ...trigger.watch, role: "primary" }], {
    limits: { ...workFoldAutomationFileObserverBounds },
  });
  const entries: Record<string, string> = Object.create(null);
  for (const file of resolution.files) {
    const info = await lstat(resolveWorkFolderPath(workFolder.workFolderRoot, file.path), { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A watched file changed type during observation.");
    entries[file.path] = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }
  const folderAfter = await lstat(resolveWorkFolderPath(workFolder.workFolderRoot, trigger.watch.path));
  if (folderAfter.dev !== folderBefore.dev || folderAfter.ino !== folderBefore.ino) throw new Error("The watched folder moved during observation.");
  const digest = createHash("sha256").update(JSON.stringify({ folder: [folderAfter.dev, folderAfter.ino], entries: Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
  return { digest, entries };
};

/**
 * Files a catch-up owes one run: added or changed while work-fold could not
 * watch the folder. A set, never a queue: every later gap merges into it, and
 * the run it starts lists the paths that still exist.
 */
export interface WorkFoldAutomationOwedCatchUp {
  reason: AutomationCatchUpReason;
  paths: string[];
  foundAt: string;
}

/**
 * What an automation that declares `"ifMissed": "run"` keeps between sessions
 * (src/local/automations/automation-file-snapshots.ts): the snapshot its
 * observer has accounted for, when it last started a run (so cooldown
 * survives a restart), and any catch-up it still owes.
 */
export interface WorkFoldAutomationSavedFileState {
  snapshot: WorkFoldAutomationFileSnapshot;
  savedAt: string;
  lastTriggeredAt?: string;
  owed?: WorkFoldAutomationOwedCatchUp;
}

export interface WorkFoldAutomationFileWatchStatus {
  state: "starting" | "watching" | "paused" | "error";
  detail?: string;
  lastObservedAt?: string;
  lastTriggeredAt?: string;
  /** A catch-up found and waiting for the folder to settle, its cooldown, or other automation work. */
  catchingUp?: { reason: AutomationCatchUpReason; count: number };
  /** When this session's watch last started a catch-up run. */
  lastCatchUpAt?: string;
  /** A plain sentence about the catch-up a person should know, such as why one could not happen. */
  notice?: string;
}

export interface WorkFoldAutomationFileWatchFiring {
  changedCount: number;
  changedPaths: string[];
  /** Present when the run includes files that changed while work-fold could not watch. */
  catchUp?: { reason: AutomationCatchUpReason; count: number };
}

/** Why a saved snapshot cannot be compared: it may already contain an automation run's own edits. */
export const workFoldAutomationDirtySnapshotNotice =
  "An automation was running when work-fold stopped watching, so it took a fresh look instead of catching up; files that changed in that gap were not caught up.";

/**
 * The comparison a catch-up makes: a path is owed when it is new, or when its
 * size or modification time differs from the saved snapshot. Device, inode,
 * and change-time differences alone are not enough — a remount, a sync
 * client, or merely opening a file can change those without changing the
 * file. Removed files are never owed. Entries that are not the observer's
 * `dev:ino:size:mtime:ctime` form compare whole.
 */
export function workFoldAutomationCaughtUpPaths(
  saved: WorkFoldAutomationFileSnapshot,
  current: WorkFoldAutomationFileSnapshot,
): string[] {
  const contentIdentity = (value: string): string => {
    const parts = value.split(":");
    return parts.length === 5 ? `${parts[2]}:${parts[3]}` : value;
  };
  return Object.keys(current.entries)
    .filter((path) => {
      const before = saved.entries[path];
      return before === undefined || contentIdentity(before) !== contentIdentity(current.entries[path]!);
    })
    .sort(comparePaths);
}

/** Live observation's diff: every path whose full identity differs, removals included. */
function liveChangedPaths(baseline: WorkFoldAutomationFileSnapshot, snapshot: WorkFoldAutomationFileSnapshot): string[] {
  const changed = new Set([...Object.keys(baseline.entries), ...Object.keys(snapshot.entries)]);
  return [...changed].filter((path) => baseline.entries[path] !== snapshot.entries[path]).sort();
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * One automation's folder watch. Without catch-up (the default) observations
 * deliberately restart from a baseline: changes while quit, asleep, or while
 * an automation is working never become replayed authority. With
 * `"ifMissed": "run"` the watch also compares its first look after a gap with
 * the saved snapshot and owes one coalesced run for what was added or
 * changed. Either way, changes made while an automation is running are
 * absorbed by the fresh baseline taken afterward, so a run's own edits never
 * start another run. Cross-work-folder handoffs belong in one declared
 * sequence.
 */
export class WorkFoldAutomationFileWatch {
  baseline?: WorkFoldAutomationFileSnapshot;
  candidate?: { snapshot: WorkFoldAutomationFileSnapshot; since: number };
  lastFired = -Infinity;
  status: WorkFoldAutomationFileWatchStatus = { state: "starting" };
  /** Declared `"ifMissed": "run"`: keeps a saved snapshot and catches up after a gap. */
  catchUp: boolean;
  /** The gap the next look should be compared across, when one is due. */
  pendingComparison?: AutomationCatchUpReason;
  /** The saved state: undefined until it has been read, null when there is nothing to compare with. */
  saved?: WorkFoldAutomationSavedFileState | null;
  /** The saved snapshot may predate an automation run's own edits, so it is never compared. */
  dirty = false;
  owed?: WorkFoldAutomationOwedCatchUp;
  lastTriggeredAt?: string;
  #baselineAt = 0;

  constructor(options: { catchUp?: AutomationCatchUpReason } = {}) {
    this.catchUp = options.catchUp !== undefined;
    if (options.catchUp !== undefined) this.pendingComparison = options.catchUp;
  }

  reset(paused = false): void {
    this.baseline = undefined;
    this.candidate = undefined;
    this.status = { ...this.status, state: paused ? "paused" : "starting", detail: undefined };
  }

  /** A gap began (sleep, an observer error): compare the next look with the saved snapshot. */
  expectGap(reason: AutomationCatchUpReason): void {
    if (this.catchUp) this.pendingComparison ??= reason;
  }

  /** Adopts what was saved before this watch existed; a no-op once loaded. */
  load(
    read: { state: WorkFoldAutomationSavedFileState | null; dirty: boolean; problem?: string },
    now: number,
  ): void {
    if (this.saved !== undefined) return;
    this.saved = read.state;
    this.dirty = read.dirty;
    if (!read.state) this.pendingComparison = undefined;
    if (read.problem) this.status = { ...this.status, notice: read.problem };
    const lastTriggeredAt = read.state?.lastTriggeredAt;
    if (lastTriggeredAt !== undefined && Number.isFinite(Date.parse(lastTriggeredAt))) {
      // A clock that moved backwards must not stretch the cooldown.
      this.lastFired = Math.max(this.lastFired, Math.min(Date.parse(lastTriggeredAt), now));
      this.lastTriggeredAt ??= lastTriggeredAt;
      this.status = { ...this.status, lastTriggeredAt: this.status.lastTriggeredAt ?? lastTriggeredAt };
    }
    if (read.state?.owed && !this.owed) this.owed = structuredClone(read.state.owed);
  }

  /** The changed paths feed `{{trigger.changedFiles}}`; the count is always the true one. */
  observe(
    snapshot: WorkFoldAutomationFileSnapshot,
    now: number,
    trigger: WorkFoldAutomationFilesChangedTrigger,
  ): WorkFoldAutomationFileWatchFiring | null {
    this.status = { ...this.status, state: "watching", detail: undefined, lastObservedAt: new Date(now).toISOString() };
    if (!this.baseline) {
      this.#compareWithSaved(snapshot, now);
      this.#rebase(snapshot, now);
      return null;
    }
    if (snapshot.digest === this.baseline.digest) {
      this.candidate = undefined;
      if (!this.owed || !this.#ready(now, this.#baselineAt, trigger)) return null;
      return this.#fire([], snapshot, now);
    }
    if (this.candidate?.snapshot.digest !== snapshot.digest) { this.candidate = { snapshot, since: now }; return null; }
    if (!this.#ready(now, this.candidate.since, trigger)) return null;
    const changed = liveChangedPaths(this.baseline, snapshot);
    this.#rebase(snapshot, now);
    return this.#fire(changed, snapshot, now);
  }

  /**
   * An automation run is about to start before this watch made a due
   * comparison: compare now, before the run can edit anything, and keep what
   * is owed for after the run. The caller saves `snapshot` with the result.
   */
  compareBeforeRun(snapshot: WorkFoldAutomationFileSnapshot, now: number): void {
    this.#compareWithSaved(snapshot, now);
  }

  /** What the saved state should hold for this snapshot. */
  stateToSave(snapshot: WorkFoldAutomationFileSnapshot, now: number): WorkFoldAutomationSavedFileState {
    return {
      snapshot,
      savedAt: new Date(now).toISOString(),
      ...(this.lastTriggeredAt !== undefined ? { lastTriggeredAt: this.lastTriggeredAt } : {}),
      ...(this.owed ? { owed: structuredClone(this.owed) } : {}),
    };
  }

  /** The status a person sees, with any catch-up still waiting. */
  view(): WorkFoldAutomationFileWatchStatus {
    return {
      ...structuredClone(this.status),
      ...(this.owed ? { catchingUp: { reason: this.owed.reason, count: this.owed.paths.length } } : {}),
    };
  }

  fail(error: unknown): void {
    this.reset();
    this.expectGap("unavailable");
    this.status = { ...this.status, state: "error", detail: error instanceof Error ? error.message : "Folder observation failed." };
  }

  #ready(now: number, settledSince: number, trigger: WorkFoldAutomationFilesChangedTrigger): boolean {
    return now - settledSince >= trigger.debounceSeconds * 1000 && now - this.lastFired >= trigger.cooldownMinutes * 60_000;
  }

  #rebase(snapshot: WorkFoldAutomationFileSnapshot, now: number): void {
    this.baseline = snapshot;
    this.#baselineAt = now;
    this.candidate = undefined;
  }

  #compareWithSaved(snapshot: WorkFoldAutomationFileSnapshot, now: number): void {
    const reason = this.pendingComparison;
    this.pendingComparison = undefined;
    if (reason === undefined || !this.catchUp || !this.saved) return;
    if (this.dirty) {
      this.status = { ...this.status, notice: workFoldAutomationDirtySnapshotNotice };
      return;
    }
    const found = workFoldAutomationCaughtUpPaths(this.saved.snapshot, snapshot);
    // What is still owed from an earlier gap stays owed while it exists.
    const stillOwed = (this.owed?.paths ?? []).filter((path) => path in snapshot.entries);
    const paths = [...new Set([...stillOwed, ...found])].sort(comparePaths);
    this.owed = paths.length
      ? { reason: this.owed?.reason ?? reason, paths, foundAt: this.owed?.foundAt ?? new Date(now).toISOString() }
      : undefined;
    const { notice: _notice, ...status } = this.status;
    this.status = status;
  }

  #fire(changed: string[], snapshot: WorkFoldAutomationFileSnapshot, now: number): WorkFoldAutomationFileWatchFiring | null {
    let paths = changed;
    let catchUp: WorkFoldAutomationFileWatchFiring["catchUp"];
    if (this.owed) {
      const present = this.owed.paths.filter((path) => path in snapshot.entries);
      if (present.length) {
        paths = [...new Set([...changed, ...present])].sort(comparePaths);
        catchUp = { reason: this.owed.reason, count: present.length };
      }
      this.owed = undefined;
    }
    if (!paths.length) return null;
    const at = new Date(now).toISOString();
    this.lastFired = now;
    this.lastTriggeredAt = at;
    this.status.lastTriggeredAt = at;
    if (catchUp) {
      this.status.lastCatchUpAt = at;
      delete this.status.notice;
    }
    return {
      changedCount: paths.length,
      changedPaths: paths.slice(0, workFoldAutomationBounds.maxChangedPathsRecorded),
      ...(catchUp ? { catchUp } : {}),
    };
  }
}
