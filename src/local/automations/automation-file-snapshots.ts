import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { automationCatchUpReasons } from "../../shared/automation-presentation.js";
import { workFoldStateRoot } from "../state-paths.js";
import type { WorkFoldAutomationFilesChangedTrigger } from "./automation-declarations.js";
import {
  workFoldAutomationFileObserverBounds,
  type WorkFoldAutomationOwedCatchUp,
  type WorkFoldAutomationSavedFileState,
} from "./automation-file-observer.js";

/**
 * Saved folder snapshots for folder-change automations that declare
 * `"ifMissed": "run"` (docs/automations.md, 2026-10-11 amendment).
 *
 * Machine-local application state beside the automation store, never inside a
 * work-folder: one file per automation holding the metadata the observer
 * already reads (relative path → device, inode, size, and modification and
 * change times), the time it last started a run, and any catch-up it still
 * owes. No file contents. A record is bounded by the observer's own scan
 * bounds and is read fail-safe: a missing, damaged, oversized, or
 * differently-scoped record means there is nothing to compare with, so the
 * watch takes a fresh look — it never guesses a catch-up.
 *
 * A small `<id>.running` marker beside a record says an automation run started
 * after the record was saved and its post-run look has not been saved yet. The
 * record may then predate that run's own edits, so it is never compared; that
 * is what keeps a run that was interrupted by quit, sleep, or Turn off from
 * catching up on its own output.
 */
export const workFoldAutomationFileSnapshotKind = "work-fold.automation-folder-snapshot" as const;

/** The largest record a read admits; 50,000 entries of long paths fit with room to spare. */
export const workFoldAutomationFileSnapshotMaxBytes = 256 * 1024 * 1024;

const maxPathLength = 4_096;
const maxIdentityLength = 256;
const automationIdPattern = /^automation-[a-z0-9][a-z0-9-]{7,154}$/;
const forbiddenPathCharacters = /[\u0000-\u001f\u007f]/;

export function workFoldAutomationFileSnapshotsDirectory(stateRoot?: string): string {
  return join(stateRoot ? resolve(stateRoot) : workFoldStateRoot(), "automations", "folder-snapshots");
}

/**
 * The scope a saved snapshot describes: the watched work-folder and selector.
 * A record saved for a different folder, path, recursion, or extension list
 * is never compared — every file would read as new.
 */
export function workFoldAutomationFileWatchKey(trigger: WorkFoldAutomationFilesChangedTrigger): string {
  return createHash("sha256").update(JSON.stringify([
    trigger.workFolder,
    trigger.watch.path,
    trigger.watch.recursive,
    [...trigger.watch.extensions].sort(),
  ])).digest("hex");
}

export interface WorkFoldAutomationFileSnapshotRead {
  state: WorkFoldAutomationSavedFileState | null;
  /** An automation run started after this record was saved. */
  dirty: boolean;
  /** Why an existing record could not be used, in a sentence a person can read. */
  problem?: string;
}

interface SnapshotFileShape {
  kind: typeof workFoldAutomationFileSnapshotKind;
  v: 1;
  automationId: string;
  watchKey: string;
  savedAt: string;
  snapshot: { digest: string; entries: Record<string, string> };
  lastTriggeredAt?: string;
  owed?: WorkFoldAutomationOwedCatchUp;
}

const unreadableProblem =
  "work-fold could not read this automation's saved folder snapshot, so it took a fresh look instead of catching up.";

export class WorkFoldAutomationFileSnapshots {
  readonly directory: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { directory?: string } = {}) {
    this.directory = resolve(options.directory ?? workFoldAutomationFileSnapshotsDirectory());
  }

  read(automationId: string, watchKey: string): Promise<WorkFoldAutomationFileSnapshotRead> {
    return this.#serial(async () => {
      const path = this.#recordPath(automationId);
      const dirty = await exists(this.#markerPath(automationId));
      let text: string;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > workFoldAutomationFileSnapshotMaxBytes) {
          return { state: null, dirty, problem: unreadableProblem };
        }
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, dirty };
        return { state: null, dirty, problem: unreadableProblem };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { state: null, dirty, problem: unreadableProblem };
      }
      const record = snapshotRecord(parsed, automationId);
      if (!record) return { state: null, dirty, problem: unreadableProblem };
      // A changed selector is not damage: there is simply nothing comparable.
      if (record.watchKey !== watchKey) return { state: null, dirty };
      return {
        state: {
          snapshot: { digest: record.snapshot.digest, entries: record.snapshot.entries },
          savedAt: record.savedAt,
          ...(record.lastTriggeredAt !== undefined ? { lastTriggeredAt: record.lastTriggeredAt } : {}),
          ...(record.owed !== undefined ? { owed: record.owed } : {}),
        },
        dirty,
      };
    });
  }

  /** Atomically replaces the record, then clears the running marker it supersedes. */
  save(automationId: string, watchKey: string, state: WorkFoldAutomationSavedFileState): Promise<void> {
    return this.#serial(async () => {
      const record: SnapshotFileShape = {
        kind: workFoldAutomationFileSnapshotKind,
        v: 1,
        automationId: requireAutomationId(automationId),
        watchKey,
        savedAt: state.savedAt,
        snapshot: { digest: state.snapshot.digest, entries: state.snapshot.entries },
        ...(state.lastTriggeredAt !== undefined ? { lastTriggeredAt: state.lastTriggeredAt } : {}),
        ...(state.owed !== undefined ? { owed: state.owed } : {}),
      };
      if (!snapshotRecord(record, automationId)) {
        throw new Error("This folder snapshot is outside the bounds a saved snapshot may hold, so it was not saved.");
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.#recordPath(automationId);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flush: true });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await rm(this.#markerPath(automationId), { force: true });
    });
  }

  /** Marks the record as possibly predating an automation run's own edits. */
  markRunning(automationId: string, at: string): Promise<void> {
    return this.#serial(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.#markerPath(automationId), `${at}\n`, { encoding: "utf8", mode: 0o600, flush: true });
    });
  }

  /** The post-run look matched the record: it describes the folder again. */
  clearRunning(automationId: string): Promise<void> {
    return this.#serial(async () => {
      await rm(this.#markerPath(automationId), { force: true });
    });
  }

  /** Forgets everything saved for an automation. */
  remove(automationId: string): Promise<void> {
    return this.#serial(async () => {
      await rm(this.#recordPath(automationId), { force: true });
      await rm(this.#markerPath(automationId), { force: true });
    });
  }

  #recordPath(automationId: string): string {
    return join(this.directory, `${requireAutomationId(automationId)}.json`);
  }

  #markerPath(automationId: string): string {
    return join(this.directory, `${requireAutomationId(automationId)}.running`);
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

function requireAutomationId(automationId: string): string {
  if (!automationIdPattern.test(automationId)) throw new Error("Automation id is invalid.");
  return automationId;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxPathLength
    && !value.startsWith("/") && !forbiddenPathCharacters.test(value);
}

/** The record if it is exactly the closed, bounded shape; otherwise null. */
function snapshotRecord(value: unknown, automationId: string): SnapshotFileShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["kind", "v", "automationId", "watchKey", "savedAt", "snapshot", "lastTriggeredAt", "owed"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (record.kind !== workFoldAutomationFileSnapshotKind || record.v !== 1 || record.automationId !== automationId) return null;
  if (typeof record.watchKey !== "string" || !/^[a-f0-9]{64}$/.test(record.watchKey)) return null;
  if (!isTimestamp(record.savedAt)) return null;
  if (record.lastTriggeredAt !== undefined && !isTimestamp(record.lastTriggeredAt)) return null;
  const snapshot = record.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const { digest, entries } = snapshot as Record<string, unknown>;
  if (Object.keys(snapshot).some((key) => key !== "digest" && key !== "entries")) return null;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return null;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
  const paths = Object.keys(entries);
  if (paths.length > workFoldAutomationFileObserverBounds.maxFiles) return null;
  const normalizedEntries: Record<string, string> = Object.create(null);
  for (const path of paths) {
    const identity = (entries as Record<string, unknown>)[path];
    if (
      !isRelativePath(path)
      || typeof identity !== "string"
      || !identity
      || identity.length > maxIdentityLength
      || forbiddenPathCharacters.test(identity)
    ) return null;
    normalizedEntries[path] = identity;
  }
  let owed: WorkFoldAutomationOwedCatchUp | undefined;
  if (record.owed !== undefined) {
    const candidate = record.owed;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const { reason, paths: owedPaths, foundAt } = candidate as Record<string, unknown>;
    if (Object.keys(candidate).some((key) => key !== "reason" && key !== "paths" && key !== "foundAt")) return null;
    if (typeof reason !== "string" || !(automationCatchUpReasons as readonly string[]).includes(reason)) return null;
    if (!isTimestamp(foundAt)) return null;
    if (!Array.isArray(owedPaths) || owedPaths.length < 1 || owedPaths.length > workFoldAutomationFileObserverBounds.maxFiles) return null;
    if (!owedPaths.every(isRelativePath)) return null;
    owed = { reason: reason as WorkFoldAutomationOwedCatchUp["reason"], paths: [...owedPaths], foundAt };
  }
  return {
    kind: workFoldAutomationFileSnapshotKind,
    v: 1,
    automationId,
    watchKey: record.watchKey,
    savedAt: record.savedAt,
    snapshot: { digest, entries: normalizedEntries },
    ...(record.lastTriggeredAt !== undefined ? { lastTriggeredAt: record.lastTriggeredAt } : {}),
    ...(owed ? { owed } : {}),
  };
}
