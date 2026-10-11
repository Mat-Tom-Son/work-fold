import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { listWorkFolders, resolveWorkFolderPath } from "../work-folder.js";
import { resolveWorkFoldCheckTargets } from "../checks/target-resolver.js";
import { workFoldAutomationBounds, type WorkFoldAutomationFilesChangedTrigger } from "./automation-declarations.js";

export interface WorkFoldAutomationFileSnapshot { digest: string; entries: Record<string, string>; }
export type WorkFoldAutomationFileObserver = (trigger: WorkFoldAutomationFilesChangedTrigger) => Promise<WorkFoldAutomationFileSnapshot>;

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
    // Metadata only, polled every few seconds: generous counts, no byte ceiling.
    limits: { maxFiles: 50_000, maxVisitedEntries: 200_000, maxDepth: 256 },
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

export interface WorkFoldAutomationFileWatchStatus {
  state: "starting" | "watching" | "paused" | "error";
  detail?: string;
  lastObservedAt?: string;
  lastTriggeredAt?: string;
}

/** In-memory observations deliberately restart from a baseline: changes
 * while quit, asleep, or while an automation is working never become replayed
 * authority. Cross-work-folder handoffs belong in one declared sequence. */
export class WorkFoldAutomationFileWatch {
  baseline?: WorkFoldAutomationFileSnapshot;
  candidate?: { snapshot: WorkFoldAutomationFileSnapshot; since: number };
  lastFired = -Infinity;
  status: WorkFoldAutomationFileWatchStatus = { state: "starting" };
  reset(paused = false): void {
    this.baseline = undefined;
    this.candidate = undefined;
    this.status = { ...this.status, state: paused ? "paused" : "starting", detail: undefined };
  }
  /** The changed paths feed `{{trigger.changedFiles}}`; the count is always the true one. */
  observe(
    snapshot: WorkFoldAutomationFileSnapshot,
    now: number,
    trigger: WorkFoldAutomationFilesChangedTrigger,
  ): { changedCount: number; changedPaths: string[] } | null {
    this.status = { ...this.status, state: "watching", detail: undefined, lastObservedAt: new Date(now).toISOString() };
    if (!this.baseline) { this.baseline = snapshot; return null; }
    if (snapshot.digest === this.baseline.digest) { this.candidate = undefined; return null; }
    if (this.candidate?.snapshot.digest !== snapshot.digest) { this.candidate = { snapshot, since: now }; return null; }
    if (now - this.candidate.since < trigger.debounceSeconds * 1000 || now - this.lastFired < trigger.cooldownMinutes * 60_000) return null;
    const changed = new Set([...Object.keys(this.baseline.entries), ...Object.keys(snapshot.entries)]);
    const changedPaths = [...changed].filter((path) => this.baseline!.entries[path] !== snapshot.entries[path]).sort();
    this.baseline = snapshot;
    this.candidate = undefined;
    if (!changedPaths.length) return null;
    this.lastFired = now;
    this.status.lastTriggeredAt = new Date(now).toISOString();
    return {
      changedCount: changedPaths.length,
      changedPaths: changedPaths.slice(0, workFoldAutomationBounds.maxChangedPathsRecorded),
    };
  }
  fail(error: unknown): void {
    this.reset();
    this.status = { ...this.status, state: "error", detail: error instanceof Error ? error.message : "Folder observation failed." };
  }
}
