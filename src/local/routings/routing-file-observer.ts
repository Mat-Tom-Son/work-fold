import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { listSpaces, resolveSpacePath } from "../space.js";
import { resolveWorkFoldCheckTargets } from "../checks/target-resolver.js";
import type { WorkFoldRoutingFilesChangedTrigger } from "./routing-declarations.js";

export interface WorkFoldRoutingFileSnapshot { digest: string; entries: Record<string, string>; }
export type WorkFoldRoutingFileObserver = (trigger: WorkFoldRoutingFilesChangedTrigger) => Promise<WorkFoldRoutingFileSnapshot>;

/** Metadata only: no file bytes become conversation or model context. A
 * bounded ordinary-folder scan works on synchronized drives as well as local
 * disks without relying on lossy OS watcher events. */
export const observeWorkFoldRoutingFiles: WorkFoldRoutingFileObserver = async (trigger) => {
  const spaces = await listSpaces();
  const space = spaces.find((item) => item.id === trigger.space);
  if (!space) throw new Error("The watched Space is no longer registered.");
  const watched = resolveSpacePath(space.spaceRoot, trigger.watch.path);
  for (const child of spaces) {
    if (child.id === space.id) continue;
    const contains = (parent: string, childPath: string) => {
      const path = relative(resolve(parent), resolve(childPath));
      return !path || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    };
    if (!contains(space.spaceRoot, child.spaceRoot)) continue;
    if (contains(watched, child.spaceRoot) || contains(child.spaceRoot, watched)) throw new Error("A watched folder cannot overlap another registered Space.");
  }
  const folderBefore = await lstat(watched);
  if (!folderBefore.isDirectory() || folderBefore.isSymbolicLink()) throw new Error("The watched folder must be an ordinary directory.");
  const resolution = await resolveWorkFoldCheckTargets(space.spaceRoot, [{ ...trigger.watch, role: "primary" }], {
    limits: { maxFiles: 512, maxVisitedEntries: 2000, maxDepth: 16 },
  });
  const entries: Record<string, string> = Object.create(null);
  for (const file of resolution.files) {
    const info = await lstat(resolveSpacePath(space.spaceRoot, file.path), { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("A watched file changed type during observation.");
    entries[file.path] = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
  }
  const folderAfter = await lstat(resolveSpacePath(space.spaceRoot, trigger.watch.path));
  if (folderAfter.dev !== folderBefore.dev || folderAfter.ino !== folderBefore.ino) throw new Error("The watched folder moved during observation.");
  const digest = createHash("sha256").update(JSON.stringify({ folder: [folderAfter.dev, folderAfter.ino], entries: Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
  return { digest, entries };
};

export interface WorkFoldRoutingFileWatchStatus {
  state: "starting" | "watching" | "paused" | "error";
  detail?: string;
  lastObservedAt?: string;
  lastTriggeredAt?: string;
}

/** In-memory observations deliberately restart from a baseline: changes
 * while quit, asleep, or while a routing is working never become replayed
 * authority. Cross-Space handoffs belong in one reviewed sequence. */
export class WorkFoldRoutingFileWatch {
  baseline?: WorkFoldRoutingFileSnapshot;
  candidate?: { snapshot: WorkFoldRoutingFileSnapshot; since: number };
  lastFired = -Infinity;
  status: WorkFoldRoutingFileWatchStatus = { state: "starting" };
  reset(paused = false): void {
    this.baseline = undefined;
    this.candidate = undefined;
    this.status = { ...this.status, state: paused ? "paused" : "starting", detail: undefined };
  }
  observe(snapshot: WorkFoldRoutingFileSnapshot, now: number, trigger: WorkFoldRoutingFilesChangedTrigger): number | null {
    this.status = { ...this.status, state: "watching", detail: undefined, lastObservedAt: new Date(now).toISOString() };
    if (!this.baseline) { this.baseline = snapshot; return null; }
    if (snapshot.digest === this.baseline.digest) { this.candidate = undefined; return null; }
    if (this.candidate?.snapshot.digest !== snapshot.digest) { this.candidate = { snapshot, since: now }; return null; }
    if (now - this.candidate.since < trigger.debounceSeconds * 1000 || now - this.lastFired < trigger.cooldownMinutes * 60_000) return null;
    const changed = new Set([...Object.keys(this.baseline.entries), ...Object.keys(snapshot.entries)]);
    const count = [...changed].filter((path) => this.baseline!.entries[path] !== snapshot.entries[path]).length;
    this.baseline = snapshot;
    this.candidate = undefined;
    if (!count) return null;
    this.lastFired = now;
    this.status.lastTriggeredAt = new Date(now).toISOString();
    return count;
  }
  fail(error: unknown): void {
    this.reset();
    this.status = { ...this.status, state: "error", detail: error instanceof Error ? error.message : "Folder observation failed." };
  }
}
